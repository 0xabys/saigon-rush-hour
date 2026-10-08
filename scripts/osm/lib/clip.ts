/** Design §3.3: raw edge graph + Liang–Barsky clipping at the bbox into portal nodes. */
import type { WayInfo } from './filter';
import type { Diag, Graph, Side } from './graph';
import { wayLanes } from './lanes';
import { BOUNDS, insideBounds } from './project';
import type { P2 } from './types';

/** Boundary snap tolerance and minimum kept length (m). */
const EPS = 0.05;

function clipParams(a: P2, b: P2): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const p = [-dx, dx, -dz, dz];
  const q = [a.x - BOUNDS.minX, BOUNDS.maxX - a.x, a.z - BOUNDS.minZ, BOUNDS.maxZ - a.z];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** Which bbox side a boundary point lies on (null when strictly inside). */
function sideOf(p: P2): Side | null {
  if (Math.abs(p.z - BOUNDS.minZ) < 1e-6) return 'N';
  if (Math.abs(p.z - BOUNDS.maxZ) < 1e-6) return 'S';
  if (Math.abs(p.x - BOUNDS.maxX) < 1e-6) return 'E';
  if (Math.abs(p.x - BOUNDS.minX) < 1e-6) return 'W';
  return null;
}

/** `ways` must exclude ring ways. `nodePos` holds every projected OSM node (inside or outside the bbox). */
export function clipWays(ways: WayInfo[], nodePos: Map<number, P2>, diag: Diag): Graph {
  const g: Graph = { pos: new Map(), portals: new Map(), edges: [] };
  let nextPortal = -1;
  for (const way of ways) {
    const { lF, lB } = wayLanes(way);
    for (let i = 0; i + 1 < way.nodes.length; i++) {
      const u = way.nodes[i];
      const v = way.nodes[i + 1];
      const pu = nodePos.get(u);
      const pv = nodePos.get(v);
      if (!pu || !pv) {
        diag.count('edgesMissingNode');
        continue;
      }
      if (u === v) continue;
      const t = clipParams(pu, pv);
      if (!t) {
        diag.count('edgesOutside');
        continue;
      }
      let a = pu;
      let b = pv;
      let eu = u;
      let ev = v;
      const dx = pv.x - pu.x;
      const dz = pv.z - pu.z;
      if (t[0] > 0) {
        a = { x: pu.x + dx * t[0], z: pu.z + dz * t[0] };
        eu = nextPortal--;
      }
      if (t[1] < 1) {
        b = { x: pu.x + dx * t[1], z: pu.z + dz * t[1] };
        ev = nextPortal--;
      }
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const sa = eu < 0 ? snap(a) : sideOf(a);
      const sb = ev < 0 ? snap(b) : sideOf(b);
      if (len < EPS || (sa !== null && sa === sb)) {
        // Touching or running along the boundary counts as outside; release the portal ids.
        // A real node within EPS of the boundary whose continuation is outside becomes a portal itself.
        const edgeLen = Math.hypot(dx, dz);
        if (len < EPS && insideBounds(pu) && t[1] * edgeLen < EPS) g.portals.set(u, snap(pu));
        if (len < EPS && insideBounds(pv) && (1 - t[0]) * edgeLen < EPS) g.portals.set(v, snap(pv));
        if (eu < 0) nextPortal++;
        if (ev < 0) nextPortal++;
        diag.count('edgesOutside');
        continue;
      }
      if (eu < 0) {
        g.portals.set(eu, sa as Side);
        g.pos.set(eu, a);
      } else g.pos.set(eu, a);
      if (ev < 0) {
        g.portals.set(ev, sb as Side);
        g.pos.set(ev, b);
      } else g.pos.set(ev, b);
      g.edges.push({ id: g.edges.length, u: eu, v: ev, way, len, lF, lB, alive: true });
    }
  }
  return g;
}

/** Snap a clipped point exactly onto its boundary line and return the side. */
function snap(p: P2): Side {
  const d: [number, Side][] = [
    [Math.abs(p.z - BOUNDS.minZ), 'N'],
    [Math.abs(p.z - BOUNDS.maxZ), 'S'],
    [Math.abs(p.x - BOUNDS.maxX), 'E'],
    [Math.abs(p.x - BOUNDS.minX), 'W'],
  ];
  const [, side] = d.reduce((m, c) => (c[0] < m[0] ? c : m));
  if (side === 'N') p.z = BOUNDS.minZ;
  else if (side === 'S') p.z = BOUNDS.maxZ;
  else if (side === 'E') p.x = BOUNDS.maxX;
  else p.x = BOUNDS.minX;
  return side;
}
