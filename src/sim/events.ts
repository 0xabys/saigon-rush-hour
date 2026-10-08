import type { Network, Segment } from './network';

// City events that disturb traffic: minor crashes, rain flooding and the inner-city truck ban.

export interface Incident {
  id: number;
  linkId: number;
  x: number;
  z: number;
  start: number;
  end: number;
  /** Uids of the crashed vehicles (they resume driving when the incident clears). */
  uids: number[];
  road: string;
  desc: string;
}

export interface FloodZone {
  x: number;
  z: number;
  r: number;
  /** Relative depth: low spots flood first and deepest. */
  depth: number;
  road: string;
}

interface FloodSpec {
  road: string;
  /** Position along the road's longest link, 0–1. */
  at: number;
  r: number;
  depth: number;
}

/** Streets that go under water in a downpour (low spots near the river and canals). */
const FLOOD_SPECS: FloodSpec[] = [
  { road: 'Tôn Đức Thắng', at: 0.5, r: 15, depth: 1 },
  { road: 'Hàm Nghi', at: 0.45, r: 13, depth: 0.85 },
  { road: 'Lê Lai', at: 0.5, r: 13, depth: 0.9 },
  { road: 'Pasteur', at: 0.7, r: 12, depth: 0.75 },
  { road: 'Calmette', at: 0.5, r: 12, depth: 0.8 },
];

/**
 * Places the flood spots on the real streets of `net`. A street missing from the map is dropped
 * and reported in `net.warnings`.
 */
export function floodZonesFor(net: Network): FloodZone[] {
  const out: FloodZone[] = [];
  for (const spec of FLOOD_SPECS) {
    let link: Segment | null = null;
    let best = -1;
    for (const road of net.roads) {
      if (road.name !== spec.road) continue;
      for (const l of road.links) {
        if (l.bridge || l.length <= best) continue;
        best = l.length;
        link = l;
      }
    }
    if (!link) {
      net.warnings.push(`floodZonesFor: street "${spec.road}" is not in the network, flood zone dropped`);
      continue;
    }
    const p = [0, 0, 0, 0];
    link.sample(spec.at * link.length, p);
    // The sample lies on the link's reference line; step back to the road centreline.
    out.push({ x: p[0] + p[3] * link.refOffset, z: p[1] - p[2] * link.refOffset, r: spec.r, depth: spec.depth, road: spec.road });
  }
  return out;
}

/** HCMC bans trucks from the inner city during rush hours. */
export function truckBanActive(hour: number): boolean {
  return (hour >= 6 && hour < 9) || (hour >= 16 && hour < 20);
}

export interface CityEvent {
  key: string;
  kind: 'crash' | 'flood' | 'ban';
  title: string;
  detail: string;
}
