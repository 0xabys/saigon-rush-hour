/** Design §3.9: lanes per direction with class defaults. */
import type { RoadClassName } from '../../../src/data/q1Schema';
import type { WayInfo } from './filter';

const DEFAULT_LANES: Record<RoadClassName, number> = {
  trunk: 3,
  primary: 2,
  secondary: 2,
  tertiary: 1,
  residential: 1,
  unclassified: 1,
};

/** Lanes along the way's node order (`lF`) and against it (`lB`, 0 for one-way). */
export function wayLanes(w: WayInfo): { lF: number; lB: number } {
  const def = w.isLink ? 1 : DEFAULT_LANES[w.cls];
  if (w.oneway) return { lF: w.lanes ?? def, lB: 0 };
  if (w.lanesFwd !== null || w.lanesBwd !== null) {
    const total = w.lanes ?? 2 * def;
    const lF = w.lanesFwd ?? Math.max(1, total - (w.lanesBwd ?? 0));
    const lB = w.lanesBwd ?? Math.max(1, total - lF);
    return { lF, lB };
  }
  if (w.lanes !== null) return { lF: Math.max(1, Math.ceil(w.lanes / 2)), lB: Math.max(1, Math.floor(w.lanes / 2)) };
  return { lF: def, lB: def };
}
