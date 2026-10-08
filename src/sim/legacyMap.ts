// The hand-built stylised District 1 (17 nodes, 20 roads, 6 signalised junctions, one roundabout)
// expressed as a `NetGraph`, so it goes through the same generic builder as the OpenStreetMap
// map. Only the harness (`npm run harness:legacy`) uses it; the 3D app renders OpenStreetMap.

import { buildNetwork, RoadClass, type GraphLink, type GraphNode, type GraphRing, type Network, type NetGraph } from './network';

const MEDIAN = 0.8;
/** Width of one direction's carriageway. */
const CARRIAGE = 7;
/** Centreline to curb. */
const ROAD_HALF = MEDIAN / 2 + CARRIAGE;
/** Half size of a signalised junction box. */
const BOX_HALF = ROAD_HALF + 1;
/** Distance from junction centre to the stop line. */
const STOP_TRIM = BOX_HALF + 4;
const RING_CENTER = { x: -120, z: 0 };
const RING_REF_R = 18;
const RING_ARM_TRIM = 31;

const WORLD = { minX: -215, maxX: 290, minZ: -170, maxZ: 170 };

type LegacyNodeKind = 'signal' | 'portal' | 'ring';

interface NodeSpec {
  key: string;
  name: string;
  x: number;
  z: number;
  kind: LegacyNodeKind;
}

const NODES: NodeSpec[] = [
  { key: 'RB', name: 'Vòng xoay Bến Thành', x: RING_CENTER.x, z: RING_CENTER.z, kind: 'ring' },
  { key: 'BN', name: 'Giao lộ Pasteur – Lý Tự Trọng', x: -40, z: -70, kind: 'signal' },
  { key: 'BM', name: 'Giao lộ Lê Lợi – Pasteur', x: -40, z: 0, kind: 'signal' },
  { key: 'BS', name: 'Giao lộ Pasteur – Hàm Nghi', x: -40, z: 70, kind: 'signal' },
  { key: 'CN', name: 'Giao lộ Đồng Khởi – Lý Tự Trọng', x: 40, z: -70, kind: 'signal' },
  { key: 'CS', name: 'Giao lộ Đồng Khởi – Hàm Nghi', x: 40, z: 70, kind: 'signal' },
  { key: 'DN', name: 'Chân cầu Ba Son', x: 115, z: -70, kind: 'signal' },
  { key: 'pW', name: '', x: WORLD.minX, z: 0, kind: 'portal' },
  { key: 'pRN', name: '', x: -120, z: WORLD.minZ, kind: 'portal' },
  { key: 'pRS', name: '', x: -120, z: WORLD.maxZ, kind: 'portal' },
  { key: 'pBN', name: '', x: -40, z: WORLD.minZ, kind: 'portal' },
  { key: 'pBS', name: '', x: -40, z: WORLD.maxZ, kind: 'portal' },
  { key: 'pCN', name: '', x: 40, z: WORLD.minZ, kind: 'portal' },
  { key: 'pCS', name: '', x: 40, z: WORLD.maxZ, kind: 'portal' },
  { key: 'pDN', name: '', x: 115, z: WORLD.minZ, kind: 'portal' },
  { key: 'pDS', name: '', x: 115, z: WORLD.maxZ, kind: 'portal' },
  { key: 'pE', name: '', x: WORLD.maxX, z: -70, kind: 'portal' },
];

/** Signal timing: green seconds per group (north–south, east–west) and the offset into the cycle. */
const GREENS: Record<string, [number, number]> = {
  BN: [20, 24],
  BM: [22, 18],
  BS: [20, 24],
  CN: [20, 22],
  CS: [22, 18],
  DN: [26, 22],
};
const OFFSETS: Record<string, number> = { BN: 0, BM: 9, BS: 17, CN: 6, CS: 21, DN: 13 };
/** Approaches (named by the node they come from) where right on red is forbidden. */
const NO_RIGHT_ON_RED: Record<string, string[]> = { BM: ['RB'], CN: ['pCN'], DN: ['pE'] };

const ROADS: [string, string, string, boolean?][] = [
  ['Lê Lai', 'RB', 'pW'],
  ['Cách Mạng Tháng Tám', 'RB', 'pRN'],
  ['Trần Hưng Đạo', 'RB', 'pRS'],
  ['Lê Lợi', 'RB', 'BM'],
  ['Lê Thánh Tôn', 'RB', 'BN'],
  ['Hàm Nghi', 'RB', 'BS'],
  ['Pasteur', 'pBN', 'BN'],
  ['Pasteur', 'BN', 'BM'],
  ['Pasteur', 'BM', 'BS'],
  ['Pasteur', 'BS', 'pBS'],
  ['Lý Tự Trọng', 'BN', 'CN'],
  ['Lý Tự Trọng', 'CN', 'DN'],
  ['Cầu Ba Son', 'DN', 'pE', true],
  ['Hàm Nghi', 'BS', 'CS'],
  ['Đồng Khởi', 'pCN', 'CN'],
  ['Đồng Khởi', 'CN', 'CS'],
  ['Đồng Khởi', 'CS', 'pCS'],
  ['Tôn Đức Thắng', 'pDN', 'DN'],
  ['Tôn Đức Thắng', 'DN', 'pDS'],
];

/** Bus stops on the right side of a few links: [from, to, fraction of the trimmed link]. */
const BUS_STOPS: [string, string, number][] = [
  ['RB', 'BM', 0.55],
  ['DN', 'pDS', 0.45],
  ['pRS', 'RB', 0.5],
  ['CS', 'CN', 0.5],
  ['BS', 'RB', 0.5],
];

const RING_STEPS = 72;

function legacyGraph(): NetGraph {
  const index: Record<string, number> = {};
  NODES.forEach((n, i) => (index[n.key] = i));
  const spec = (key: string): NodeSpec => NODES[index[key]];

  const trimFor = (n: NodeSpec, other: NodeSpec): number => {
    if (n.kind === 'portal') return 0;
    if (n.kind === 'ring') return RING_ARM_TRIM;
    const dx = Math.abs(other.x - n.x);
    const dz = Math.abs(other.z - n.z);
    // Diagonal approaches need extra room so they don't overlap the orthogonal arms.
    return Math.min(dx, dz) > 1 ? STOP_TRIM + 4 : STOP_TRIM;
  };

  const nodes: GraphNode[] = NODES.map((n) => ({
    key: n.key,
    kind: n.kind === 'signal' ? 'junction' : n.kind === 'ring' ? 'ring' : 'portal',
    x: n.x,
    z: n.z,
    radius: 0,
    name: n.name,
    signal: n.kind === 'signal' ? { green: GREENS[n.key], offset: OFFSETS[n.key], axis: Math.PI / 2 } : null,
    ring: n.kind === 'ring' ? 0 : undefined,
    noRightOnRedFrom: NO_RIGHT_ON_RED[n.key],
  }));

  const links: GraphLink[] = ROADS.map(([name, a, b, bridge], i) => {
    const na = spec(a);
    const nb = spec(b);
    const L = Math.hypot(nb.x - na.x, nb.z - na.z);
    const trimA = trimFor(na, nb);
    const trimB = trimFor(nb, na);
    const busStops: { dir: 0 | 1; s: number }[] = [];
    for (const [from, to, frac] of BUS_STOPS) {
      const fwd = from === a && to === b;
      if (!fwd && !(from === b && to === a)) continue;
      // `s` runs along the directed link's own pts: the trimmed length scaled by the fraction.
      const t0 = fwd ? trimA : trimB;
      busStops.push({ dir: fwd ? 0 : 1, s: t0 + (L - trimA - trimB) * frac });
    }
    return {
      key: `${a}-${b}`,
      a: index[a],
      b: index[b],
      pts: [na.x, na.z, nb.x, nb.z],
      lanesF: 2,
      lanesB: 2,
      cls: RoadClass.Primary,
      isLink: false,
      name,
      maxspeed: null,
      bridge: bridge ?? false,
      median: MEDIAN,
      trimA,
      trimB,
      busStops,
      // Arms feeding straight into the roundabout get less inflow so Bến Thành stays busy, not locked.
      portalWeight: nb.kind === 'ring' || na.kind === 'ring' ? 0.4 : 1,
      // One Road per link pair, as on the hand-built map.
      roadKey: `${i}`,
    };
  });

  // Roundabout: counter-clockwise on the map (x right, z down → φ increasing), arms on exact vertices.
  const ringPhi: number[] = [];
  for (let k = 0; k < RING_STEPS; k++) ringPhi.push((k / RING_STEPS) * Math.PI * 2);
  const ringArms: GraphRing['arms'] = [];
  links.forEach((l, li) => {
    if (l.a !== 0) return;
    const nb = NODES[l.b];
    const phi = (((-Math.atan2(nb.z - RING_CENTER.z, nb.x - RING_CENTER.x)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const at = Math.round(phi / ((Math.PI * 2) / RING_STEPS)) % RING_STEPS;
    ringPhi[at] = phi;
    ringArms.push({ at, link: li, dir: 0 });
  });
  const ringPts: number[] = [];
  for (const phi of ringPhi) ringPts.push(RING_CENTER.x + Math.cos(phi) * RING_REF_R, RING_CENTER.z - Math.sin(phi) * RING_REF_R);
  const rings: GraphRing[] = [{ pts: ringPts, halfW: 5.5, speed: 8, name: NODES[0].name, arms: ringArms }];

  // Destination routing degrades the small legacy map (10 portals around the Bến Thành ring): keep the random walk.
  return { bounds: { ...WORLD }, nodes, links, rings, attribution: '', routeByDest: false, safetyNets: false, saigonRules: false };
}

export function buildLegacyNetwork(): Network {
  return buildNetwork(legacyGraph());
}
