/** Design §3.2: which OSM ways become drivable roads, and their normalised attributes. */
import type { RoadClassName } from '../../../src/data/q1Schema';
import type { OsmWay, Tags } from './types';

const ROAD_CLASS: Record<string, RoadClassName> = {
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  residential: 'residential',
  unclassified: 'unclassified',
};

/** Ways dropped by exact name even without a `tunnel` tag (ramps of the Saigon River tunnel). */
const EXCLUDE_NAMES: Record<string, true> = { 'Hầm Sông Sài Gòn': true };

/**
 * `motor_vehicle=no` next to a `motor_vehicle:conditional=no @ (…)` is a time restriction (Nguyễn Huệ / Lê Lợi / Lê Thánh Tôn:
 * weekend-evening walking street), not a permanent ban: a "no @" condition only makes sense on a road that is otherwise open, and
 * the sim models a weekday rush hour. Without the condition the plain tag is a permanent ban.
 */
function motorVehicleBanned(tags: Tags): boolean {
  if (tags.access === 'no') return true;
  if (tags.motor_vehicle !== 'no') return false;
  return !/^\s*no\s*@/.test(tags['motor_vehicle:conditional'] ?? '');
}

export interface WayInfo {
  id: number;
  cls: RoadClassName;
  isLink: boolean;
  /** One-way in node order (already reversed for `oneway=-1`). */
  oneway: boolean;
  ring: boolean;
  name: string;
  nameEn: string;
  lanes: number | null;
  lanesFwd: number | null;
  lanesBwd: number | null;
  maxspeed: number | null;
  bridge: boolean;
  nodes: number[];
}

export interface FilterResult {
  ways: WayInfo[];
  /** Count of dropped ways per rule. */
  dropped: Record<string, number>;
}

/** First integer in a tag value such as "2", "2;3" or "2 lanes". */
export function parseLanes(value: string | undefined): number | null {
  const m = value?.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= 12 ? n : null;
}

/** km/h from "50" or "30 mph"; null for symbolic values. */
export function parseMaxspeed(value: string | undefined): number | null {
  const m = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(mph)?$/);
  if (!m) return null;
  const v = Math.round(Number(m[1]) * (m[2] ? 1.609344 : 1));
  return v > 0 ? v : null;
}

export function filterWays(ways: OsmWay[]): FilterResult {
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const out: WayInfo[] = [];
  for (const w of [...ways].sort((a, b) => a.id - b.id)) {
    const tags: Tags = w.tags ?? {};
    const hw = tags.highway ?? '';
    const isLink = hw.endsWith('_link');
    const cls = ROAD_CLASS[isLink ? hw.slice(0, -5) : hw];
    if (!cls) {
      drop('notRoadClass');
      continue;
    }
    const name = (tags.name ?? '').normalize('NFC');
    if (tags.tunnel && tags.tunnel !== 'no') drop('tunnel');
    else if (tags.area === 'yes') drop('area');
    else if (name.toLowerCase().startsWith('hẻm')) drop('alley');
    else if (EXCLUDE_NAMES[name]) drop('excludedName');
    else if (motorVehicleBanned(tags) && tags.motorcycle !== 'yes') drop('noAccess');
    else if (!w.nodes || w.nodes.length < 2) drop('tooFewNodes');
    else {
      const ring = tags.junction === 'roundabout' || tags.junction === 'circular';
      const ow = tags.oneway;
      const reverse = ow === '-1' || ow === 'reverse';
      const oneway = reverse || ow === 'yes' || ow === 'true' || ow === '1' || (ring && ow !== 'no');
      out.push({
        id: w.id,
        cls,
        isLink,
        oneway,
        ring,
        name,
        nameEn: (tags['name:en'] ?? '').normalize('NFC'),
        lanes: parseLanes(tags.lanes),
        lanesFwd: reverse ? parseLanes(tags['lanes:backward']) : parseLanes(tags['lanes:forward']),
        lanesBwd: reverse ? parseLanes(tags['lanes:forward']) : parseLanes(tags['lanes:backward']),
        maxspeed: parseMaxspeed(tags.maxspeed),
        bridge: !!tags.bridge && tags.bridge !== 'no',
        nodes: reverse ? [...w.nodes].reverse() : w.nodes,
      });
    }
  }
  return { ways: out, dropped };
}
