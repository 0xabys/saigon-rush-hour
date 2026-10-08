// OpenStreetMap network (src/data/q1-network.json, produced by `npm run osm`) → `NetGraph` →
// `Network`. Signal timing is derived here rather than in the pipeline so it can be tuned
// without regenerating the data.

import { hash32 } from '../core/rng';
import { Q1_SCHEMA, type NetworkJson, type RoadClassName } from '../data/q1Schema';
import {
  ALL_RED,
  AMBER,
  buildNetwork,
  LANE_W,
  RoadClass,
  type GraphLink,
  type GraphNode,
  type GraphRing,
  type NetGraph,
  type Network,
} from './network';

const ROAD_CLASS: Record<RoadClassName, RoadClass> = {
  trunk: RoadClass.Trunk,
  primary: RoadClass.Primary,
  secondary: RoadClass.Secondary,
  tertiary: RoadClass.Tertiary,
  residential: RoadClass.Residential,
  unclassified: RoadClass.Unclassified,
};

/** Seconds of green shared by the two phases of a signalised junction. */
export const SIGNAL_GREEN_TOTAL = 44;
const GREEN_MIN = 16;
const GREEN_MAX = SIGNAL_GREEN_TOTAL - GREEN_MIN;
const SIGNAL_CYCLE = SIGNAL_GREEN_TOTAL + 2 * (AMBER + ALL_RED);
/** Circulating speed on OSM roundabouts (they are small: ≈ 7–8 m radius). */
const RING_SPEED = 6;

/** Throws unless `json` is a usable network of the schema this build understands. */
export function assertNetworkJson(json: Omit<NetworkJson, 'schema'> & { schema: number }): void {
  if (json.schema !== Q1_SCHEMA) throw new Error(`q1-network.json: schema ${json.schema}, expected ${Q1_SCHEMA}`);
  const b = json.bounds;
  if (!(Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minZ) && Number.isFinite(b.maxZ) && b.maxX > b.minX && b.maxZ > b.minZ)) {
    throw new Error('q1-network.json: bounds are not finite');
  }
  json.nodes.forEach((n, i) => {
    if (n.id !== i) throw new Error(`q1-network.json: node ${i} has id ${n.id}`);
  });
  json.links.forEach((l, i) => {
    if (l.id !== i) throw new Error(`q1-network.json: link ${i} has id ${l.id}`);
  });
}

/**
 * Junctions that carry a traffic signal in reality but not in the OSM data: node `name` (as emitted by the pipeline, unique per entry)
 * → `true`. They are timed like every mapped signal (greens by inbound lanes, offset hashed from the first OSM id, cluster sharing).
 * - `Giao lộ Nam Kỳ Khởi Nghĩa – Lê Duẩn` (in front of the Independence Palace): unsignalised in OSM, so the Lê Duẩn approach is a give-way
 * left turn across the three-lane Nam Kỳ Khởi Nghĩa flow and starves at under 1 km/h.
 * A name that matches no node is a build error (data drift must not silently drop the override).
 *
 * Data notes (OSM base 2026-10-06, see data/osm/raw-q1.json): Lê Lợi east of Pasteur, Nguyễn Huệ (both carriageways) and the short Lê
 * Thánh Tôn pieces carry `motor_vehicle=no` + `motor_vehicle:conditional=no @ (Sa-Su 18:30-23:00)` (the weekend walking street); the
 * pipeline keeps them (scripts/osm/lib/filter.ts, `motorVehicleBanned`). Nguyễn Thị Minh Khai is only a 350 m one-way diagonal in the
 * north-west corner of the bbox [10.768, 106.694, 10.781, 106.708] (ways 1267006215, 747226800, 326849845): it enters on the west edge, crosses
 * Pasteur and leaves on the north edge, so it cannot back up inside this map.
 */
export const SIGNAL_OVERRIDES: Record<string, true> = {
  'Giao lộ Nam Kỳ Khởi Nghĩa – Lê Duẩn': true,
};

export function osmGraph(json: NetworkJson): NetGraph {
  assertNetworkJson(json);
  const overridden = new Set(Object.keys(SIGNAL_OVERRIDES));
  const nodes: GraphNode[] = json.nodes.map((n) => {
    overridden.delete(n.name);
    return {
      key: `n${n.id}`,
      kind: n.kind,
      x: n.x,
      z: n.z,
      radius: n.radius,
      name: n.name,
      // Greens are set from the inbound lanes once the junction's approach groups are known.
      signal:
        n.signal || SIGNAL_OVERRIDES[n.name]
          ? { green: [SIGNAL_GREEN_TOTAL / 2, SIGNAL_GREEN_TOTAL / 2], offset: hash32(n.osm[0] ?? n.id, 7) % SIGNAL_CYCLE }
          : null,
      ring: n.kind === 'ring' ? n.ring : undefined,
    };
  });
  if (overridden.size > 0) throw new Error(`SIGNAL_OVERRIDES: no node named ${[...overridden].join(', ')}`);
  const stopsByLink = new Map<number, { dir: 0 | 1; s: number }[]>();
  for (const st of json.busStops) {
    const list = stopsByLink.get(st.link) ?? [];
    list.push({ dir: st.dir, s: st.s });
    stopsByLink.set(st.link, list);
  }
  const links: GraphLink[] = json.links.map((l) => ({
    key: `l${l.id}`,
    a: l.a,
    b: l.b,
    pts: l.pts,
    lanesF: l.lanesF,
    lanesB: l.lanesB,
    cls: ROAD_CLASS[l.cls],
    isLink: l.isLink,
    name: l.name,
    maxspeed: l.maxspeed,
    bridge: l.bridge,
    median: l.median,
    busStops: stopsByLink.get(l.id),
    tripWeight: l.tripWeight,
  }));
  const rings: GraphRing[] = json.rings.map((r) => ({
    pts: r.pts,
    halfW: (Math.max(1, r.lanes) * LANE_W) / 2,
    speed: RING_SPEED,
    name: r.name || json.nodes[r.node].name,
    arms: r.arms,
  }));
  return { bounds: { ...json.bounds }, nodes, links, rings, attribution: json.source.attribution };
}

/** Signalised nodes closer than this (m) are one physical junction (dual carriageways, staggered crossings). */
const SIGNAL_CLUSTER_DIST = 30;

/**
 * Calibration multipliers on the spawn weight of inbound portals (class × lanes, see `PORTAL_CLASS_WEIGHT` in network.ts), keyed
 * `${name}|${side}`. `side` is the map edge the portal start lies on — `N`/`S`/`E`/`W` (z grows southwards, so `N` is the
 * negative-z edge): the dominant axis of the portal start relative to the centre of `Network.bounds`. Every portal that shares a key
 * gets the multiplier (the two "Cầu Ba Son|E" arms would move together). Absent key = 1. Dead-end portals (weight 0.03–0.06) are never
 * overridden: the empty streets they would feed are filled by internal trip origins instead.
 *
 * INITIAL HYPOTHESES (not measured); they only reallocate inflow between portals and are tuned by the calibration sweeps:
 * - `Hai Bà Trưng|N` 0.6 (weight 1.0 → 0.6): the portal feeds the Hai Bà Trưng arterial that sits below 6 km/h in the baseline.
 * - `Cầu Khánh Hội|S` 1.3 (weight 2.0 → 2.6): feeds Hàm Nghi, which runs above 20 km/h at under 10 vehicles/100 m/lane in the baseline.
 * Tune in ≈ 25 % steps per sweep round.
 */
export const PORTAL_OVERRIDES: Record<string, number> = {
  'Hai Bà Trưng|N': 0.6,
  'Cầu Khánh Hội|S': 1.3,
};

/**
 * Multipliers on `Network.tripWeights` (internal trip origins/destinations, default length × road-class factor) keyed by
 * `Segment.name`; every link of the street, both directions, gets the multiplier. Commercial core streets attract more trips per
 * metre than length × class says, and the OSM data leaves them short and 2-lane, so without this the core stays emptier than the
 * calibration targets. Multipliers must be finite and > 0: the set of sink links (`Network.dests`) and so all routing tables stay
 * as built. A name that matches no link with a trip weight > 0 throws. Empty table = unmodified weights.
 *
 * INITIAL HYPOTHESES (not measured); tuned in ≈ 25 % steps by the 17:30 / 8000-vehicle calibration run:
 * - Nguyễn Huệ 4, Đồng Khởi 4, Lê Lợi 3, Lê Thánh Tôn 2.5, Pasteur 2, Mạc Thị Bưởi 2, Lý Tự Trọng 1.5.
 */
export const TRIP_OVERRIDES: Record<string, number> = {
  'Nguyễn Huệ': 4,
  'Lê Lợi': 3,
  'Đồng Khởi': 4,
  'Lê Thánh Tôn': 2.5,
  'Pasteur': 2,
  'Mạc Thị Bưởi': 2,
  'Lý Tự Trọng': 1.5,
};

/**
 * Green share of phase group 0 at a signalised junction (`Junction.name`, cluster-aware), replacing the inbound-lane split of
 * `greenFor`; the result is clamped like `greenFor` (`GREEN_MIN`…`GREEN_MAX` of `SIGNAL_GREEN_TOTAL`). Group 0 is the group of the
 * named node's own phase numbering; if the node is a non-reference member of a cluster whose axes are swapped, the share is
 * applied to that node and the cluster reference gets the complement. A name that matches no signalised junction throws; two
 * nodes of one cluster overriding with different shares throw. Empty table = lane-proportional split everywhere.
 *
 * Bến Thành (`Giao lộ Công trường Quách Thị Trang – Trần Hưng Đạo`, group 0 = Trần Hưng Đạo 3 lanes + Quách Thị Trang #406 2 lanes)
 * gets 18 s of the 44 s from the lane split. Raising it to 0.6 (26 s) was MEASURED to hurt, so the table ships empty: 17:30, 8000
 * vehicles, seed 1, minutes 2–5, Trần Hưng Đạo #404 departures/min — no overrides 67, split 0.6 only 25, trip overrides only 41,
 * both 24 (single seed/window; traffic.ts as of 2026-10-07 mid-remediation). The box (n168 is an 8-arm node: 107–133 two-wheelers
 * in the connectors, mostly `Follow` on each other) is the limit, not the green length; revisit after the traffic.ts slices land.
 * Example entry: `'Giao lộ Công trường Quách Thị Trang – Trần Hưng Đạo': 0.6`.
 */
export const SIGNAL_SPLIT_OVERRIDES: Record<string, number> = {};

const clampGreen = (g: number): number => Math.min(GREEN_MAX, Math.max(GREEN_MIN, Math.round(g)));

function applyTripOverrides(net: Network): void {
  const unmatched = new Set(Object.keys(TRIP_OVERRIDES));
  net.links.forEach((l, k) => {
    const mult = TRIP_OVERRIDES[l.name];
    if (mult === undefined) return;
    if (!(mult > 0) || !Number.isFinite(mult)) throw new Error(`TRIP_OVERRIDES: "${l.name}" multiplier must be finite and > 0, got ${mult}`);
    if (net.tripWeights[k] <= 0) return;
    net.tripWeights[k] *= mult;
    unmatched.delete(l.name);
  });
  if (unmatched.size > 0) throw new Error(`TRIP_OVERRIDES: no link with a trip weight named ${[...unmatched].join(', ')}`);
}

/** Map edge (`N`/`S`/`E`/`W`) a point lies on: dominant axis relative to the centre of `bounds`. */
function portalSide(x: number, z: number, b: Network['bounds']): 'N' | 'S' | 'E' | 'W' {
  const dx = x - (b.minX + b.maxX) / 2;
  const dz = z - (b.minZ + b.maxZ) / 2;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'E' : 'W';
  return dz > 0 ? 'S' : 'N';
}

export function buildOsmNetwork(json: NetworkJson): Network {
  const net = buildNetwork(osmGraph(json));
  net.portalsIn.forEach((p, k) => {
    const mult = PORTAL_OVERRIDES[`${p.name}|${portalSide(p.px[0], p.pz[0], net.bounds)}`];
    if (mult !== undefined) net.portalWeights[k] *= mult;
  });
  applyTripOverrides(net);
  // Split the green by the number of inbound lanes in each phase group.
  const sigs = net.signalJunctions;
  const lanesOf = (j: (typeof sigs)[number]): [number, number] => {
    const lanes: [number, number] = [0, 0];
    for (const arm of j.arms) if (arm.inLink?.signal) lanes[arm.inLink.signal.group] += arm.inLink.lanes;
    return lanes;
  };
  const greenFor = (l0: number, l1: number): number =>
    Math.min(GREEN_MAX, Math.max(GREEN_MIN, Math.round((SIGNAL_GREEN_TOTAL * l0) / (l0 + l1))));
  // Signalised nodes a few metres apart (the two halves of one crossing) must share one timing:
  // independent offsets leave cars released by one node standing in the box of the next. The lowest
  // node id of each cluster is the reference; a member whose phase axis is perpendicular to it has
  // its two groups swapped so the same street gets green at the same time.
  const unmatchedSplits = new Set(Object.keys(SIGNAL_SPLIT_OVERRIDES));
  const done = new Set<number>();
  for (const root of sigs) {
    if (done.has(root.id) || !root.signal) continue;
    const members = [root];
    done.add(root.id);
    for (let k = 0; k < members.length; k++) {
      for (const o of sigs) {
        if (done.has(o.id) || !o.signal) continue;
        if (Math.hypot(o.x - members[k].x, o.z - members[k].z) > SIGNAL_CLUSTER_DIST) continue;
        done.add(o.id);
        members.push(o);
      }
    }
    let overridden = false;
    const rootPlan = root.signal;
    if (!rootPlan) continue;
    const swapped = members.map((m) => (m.signal ? Math.abs(Math.cos(m.signal.axis - rootPlan.axis)) < Math.SQRT1_2 : false));
    let l0 = 0;
    let l1 = 0;
    members.forEach((m, k) => {
      const l = lanesOf(m);
      l0 += swapped[k] ? l[1] : l[0];
      l1 += swapped[k] ? l[0] : l[1];
    });
    let g0 = greenFor(l0, l1);
    members.forEach((m, k) => {
      const share = SIGNAL_SPLIT_OVERRIDES[m.name];
      if (share === undefined) return;
      unmatchedSplits.delete(m.name);
      if (!(share > 0 && share < 1)) throw new Error(`SIGNAL_SPLIT_OVERRIDES: "${m.name}" share must be in (0, 1), got ${share}`);
      const own = clampGreen(SIGNAL_GREEN_TOTAL * share);
      const wanted = swapped[k] ? SIGNAL_GREEN_TOTAL - own : own;
      if (overridden && wanted !== g0) throw new Error(`SIGNAL_SPLIT_OVERRIDES: conflicting shares inside the cluster of "${m.name}"`);
      g0 = wanted;
      overridden = true;
    });
    const rootOffset = rootPlan.offset;
    members.forEach((m, k) => {
      const plan = m.signal;
      if (!plan) return;
      plan.cycle = SIGNAL_CYCLE;
      if (swapped[k]) {
        plan.green = [SIGNAL_GREEN_TOTAL - g0, g0];
        plan.offset = (((rootOffset - (g0 + AMBER + ALL_RED)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
      } else {
        plan.green = [g0, SIGNAL_GREEN_TOTAL - g0];
        plan.offset = rootOffset;
      }
    });
  }
  if (unmatchedSplits.size > 0) throw new Error(`SIGNAL_SPLIT_OVERRIDES: no signalised junction named ${[...unmatchedSplits].join(', ')}`);
  return net;
}
