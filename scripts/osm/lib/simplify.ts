/** Design §3.8: Douglas–Peucker with end points fixed. */
import type { P2 } from './types';

export const DP_EPS = 0.35;

function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function simplify(pts: P2[], eps = DP_EPS): P2[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number];
    let worst = -1;
    let wd = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(pts[i], pts[lo], pts[hi]);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}
