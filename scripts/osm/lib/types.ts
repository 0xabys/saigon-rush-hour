/** Raw Overpass JSON types (the subset the pipeline reads) and the cache-file wrapper. */

export interface LatLon {
  lat: number;
  lon: number;
}

export type Tags = Record<string, string>;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes?: number[];
  geometry?: (LatLon | null)[];
  tags?: Tags;
}

export interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: (LatLon | null)[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members?: OsmMember[];
  tags?: Tags;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface RawMeta {
  fetchedAt: string;
  endpoint: string;
  queryHash: string;
}

export interface RawFile {
  meta: RawMeta;
  osm: {
    version: number;
    generator: string;
    osm3s: { timestamp_osm_base: string; copyright: string };
    elements: OsmElement[];
  };
}

export interface GobMeta {
  source: string;
  url: string;
  tile: string;
  etag: string;
  lastModified: string;
  fetchedAt: string;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  filterHash: string;
  rows: number;
}

/** One Google Open Buildings v3 footprint; `id` is the 1-based rank in the sorted cache and never changes while the cache is frozen. */
export interface GobRow {
  id: number;
  lat: number;
  lon: number;
  conf: number;
  /** Planar area in m² as published (2 decimals). */
  area: number;
  /** Full plus code. */
  code: string;
  /** Outer ring [lon, lat, …], 7 decimals, first vertex not repeated. */
  ring: number[];
}

export interface GobFile {
  meta: GobMeta;
  rows: GobRow[];
}

/** Planar point in local metres (x east, z south). */
export interface P2 {
  x: number;
  z: number;
}
