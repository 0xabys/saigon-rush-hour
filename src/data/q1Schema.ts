/**
 * Schema of the preprocessed OpenStreetMap extract for central District 1, produced by
 * `npm run osm` (scripts/osm) and consumed by the app (src/sim/osmMap.ts) and the debug page.
 * Coordinates are local metres: x east, z south, origin at `projection.lat0/lon0`.
 * Flat point lists are `[x0, z0, x1, z1, …]`, rounded to 2 decimals.
 */

export const Q1_SCHEMA = 1;

export type RoadClassName = 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'unclassified';

export interface SourceJson {
  provider: 'OpenStreetMap';
  license: 'ODbL';
  attribution: '© OpenStreetMap contributors';
  /** `osm3s.timestamp_osm_base` of the Overpass response. */
  osmBase: string;
  fetchedAt: string;
  queryHash: string;
  /** [south, west, north, east] in degrees. */
  bbox: [number, number, number, number];
  builder: string;
}

export interface NetworkJson {
  schema: 1;
  source: SourceJson;
  projection: { lat0: number; lon0: number; kx: number; kz: number };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  nodes: NodeJson[];
  links: LinkJson[];
  rings: RingJson[];
  busStops: { link: number; dir: 0 | 1; s: number; name: string; osm: number }[];
  /** Pipeline counters: ways kept/dropped per rule, clusters, portals, dead ends, signals matched/ignored, link metres… */
  stats: Record<string, number>;
}

export interface NodeJson {
  id: number;
  kind: 'junction' | 'join' | 'portal' | 'dead' | 'ring';
  x: number;
  z: number;
  /** Max distance from the cluster centre to a member OSM node (0 for single nodes). */
  radius: number;
  /** Member OSM node ids, sorted ascending. */
  osm: number[];
  signal: boolean;
  name: string;
  /** Portals only: which bbox edge they sit on. */
  side?: 'N' | 'S' | 'E' | 'W';
  /** Ring nodes only: index into `rings`. */
  ring?: number;
}

export interface LinkJson {
  id: number;
  a: number;
  b: number;
  /** Centreline a→b after Douglas–Peucker, including both end points. */
  pts: number[];
  /** Lanes a→b and b→a; `lanesB = 0` means one-way a→b. */
  lanesF: number;
  lanesB: number;
  cls: RoadClassName;
  isLink: boolean;
  name: string;
  nameEn: string;
  /** km/h, or null when untagged. */
  maxspeed: number | null;
  bridge: boolean;
  /** Median width in metres (0 for one-way). */
  median: number;
  length: number;
  /** Source OSM way ids, sorted ascending. */
  osm: number[];
  /** Optional trip-end weight override (internal origins / sink destinations, see `Network.tripWeights`); absent = length × road-class factor. */
  tripWeight?: number;
}

export interface RingJson {
  id: number;
  node: number;
  cx: number;
  cz: number;
  r: number;
  /** Closed loop in driving order (first point not repeated at the end). */
  pts: number[];
  lanes: number;
  /** `at` = vertex index in `pts`; dir 0: link leaves the ring (a = ring), 1: link enters the ring (b = ring). */
  arms: { at: number; link: number; dir: 0 | 1 }[];
  name: string;
  osm: number[];
}

export type LandmarkKey = 'benThanh' | 'ubnd' | 'bitexco' | 'cafeApt' | 'notreDame' | 'postOffice' | 'opera' | 'palace';

/** Provenance of the scene-only Overpass extract (construction land, squares); it has its own query, so its hash differs from `source.queryHash`. */
export interface ExtraSourceJson {
  osmBase: string;
  fetchedAt: string;
  queryHash: string;
}

/** Provenance of the Google Open Buildings footprints (cache `data/osm/raw-q1-gob.json`) and of the build-time filter applied to them. */
export interface GobSourceJson {
  provider: 'Google Open Buildings';
  version: 'v3';
  license: 'ODbL';
  attribution: 'Google Open Buildings v3';
  url: string;
  tile: string;
  etag: string;
  fetchedAt: string;
  filterHash: string;
  /** Build-time filter: confidence floor, planar-area floor (m²), shift applied to align with OSM (x east, z south, metres). */
  minConf: number;
  minArea: number;
  shift: [number, number];
}

export type SiteKind = 'construction' | 'brownfield';

export interface SceneJson {
  schema: 1;
  source: SourceJson;
  extraSource: ExtraSourceJson;
  gobSource: GobSourceJson;
  buildings: { osm: number; pts: number[]; holes: number[][]; levels: number | null; height: number | null; name: string; kind: string }[];
  /** Google Open Buildings footprints that OSM does not already cover; `id` = −`row.id` of raw-q1-gob.json (always < 0, OSM ids are positive). No heights: the renderer decides. */
  gobBuildings: { id: number; conf: number; pts: number[] }[];
  water: { osm: number; name: string; pts: number[]; holes: number[][] }[];
  parks: { osm: number; name: string; pts: number[] }[];
  /** landuse=construction|brownfield: no houses grow here; drawn as a dirt lot behind a hoarding fence. */
  sites: { osm: number; name: string; kind: SiteKind; pts: number[]; holes: number[][] }[];
  /** place=square and highway=pedestrian area=yes: open plazas without infill. */
  plazas: { osm: number; name: string; pts: number[]; holes: number[][] }[];
  landmarks: { key: LandmarkKey; osm: number; name: string; cx: number; cz: number; rot: number; pts: number[] }[];
}
