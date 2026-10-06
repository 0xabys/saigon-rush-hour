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

/** Streets that go under water in a downpour (positioned on road segments). */
export const FLOOD_ZONES: FloodZone[] = [
  { x: 115, z: 62, r: 15, depth: 1, road: 'Tôn Đức Thắng' },
  { x: 2, z: 70, r: 13, depth: 0.85, road: 'Hàm Nghi' },
  { x: -176, z: 0, r: 13, depth: 0.9, road: 'Lê Lai' },
  { x: -40, z: 122, r: 12, depth: 0.75, road: 'Pasteur' },
  { x: -120, z: -104, r: 12, depth: 0.8, road: 'Cách Mạng Tháng Tám' },
];

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
