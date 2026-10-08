/**
 * Overpass fetch: one POST for everything the pipeline needs, cached verbatim (plus a small meta block)
 * at data/osm/raw-q1.json. Only `--refresh` (or a missing cache) ever reaches the network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OsmElement, RawFile } from './lib/types';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RAW_PATH = resolve(ROOT, 'data/osm/raw-q1.json');
/**
 * Second cache for features that only shape the scene (construction lots, plazas). It has its own query hash, so
 * adding or refreshing it never touches `raw-q1.json` and therefore never changes `q1-network.json`.
 */
export const RAW_EXTRA_PATH = resolve(ROOT, 'data/osm/raw-q1-extra.json');

/** [south, west, north, east] */
export const BBOX: [number, number, number, number] = [10.768, 106.694, 10.781, 106.708];

const ENDPOINT = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'saigon-traffic-osm/1.0 (local hobby traffic simulator; one-off extract of central District 1)';
const BACKOFF_S = [2, 6, 18];

/** Names matched case-insensitively on any `name*` tag; the pipeline picks the landmark ids from this candidate set. */
const LANDMARK_RE = 'Bến Thành|Ben Thanh|Bitexco|Ủy ban Nhân dân|Uỷ ban Nhân dân|UBND|People.s Committee|Hôtel de Ville|Hotel de Ville|42 Nguyễn Huệ|Cafe Apartment|Café Apartment|Cafe Apartments';

export function buildQuery(): string {
  const b = BBOX.join(',');
  return [
    '[out:json][timeout:240];',
    `(way["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified)(_link)?$"](${b});)->.roads;`,
    '.roads out body;',
    'node(w.roads);',
    'out body;',
    `node["highway"="traffic_signals"](${b});`,
    'out body;',
    `node["highway"="bus_stop"](${b});`,
    'out body;',
    `(way["building"](${b});relation["building"](${b}););`,
    'out geom;',
    `(way["natural"="water"](${b});relation["natural"="water"](${b});way["waterway"="riverbank"](${b});relation["waterway"="riverbank"](${b}););`,
    'out geom;',
    `(way["leisure"~"^(park|garden|playground|recreation_ground|pitch|common)$"](${b});relation["leisure"~"^(park|garden|playground|recreation_ground|pitch|common)$"](${b});way["landuse"~"^(grass|recreation_ground|village_green)$"](${b});relation["landuse"~"^(grass|recreation_ground|village_green)$"](${b}););`,
    'out geom;',
    `(nwr[~"^name"~"${LANDMARK_RE}",i](${b}););`,
    'out geom;',
  ].join('\n');
}

export function queryHash(): string {
  return createHash('sha1').update(buildQuery()).digest('hex').slice(0, 12);
}

/** Scene-only land use: building sites and brownfield (no houses, dirt + hoarding), squares and pedestrian areas (open plaza). */
export function buildExtraQuery(): string {
  const b = BBOX.join(',');
  return [
    '[out:json][timeout:120];',
    `(way["landuse"~"^(construction|brownfield)$"](${b});relation["landuse"~"^(construction|brownfield)$"](${b});way["place"="square"](${b});relation["place"="square"](${b});way["highway"="pedestrian"]["area"="yes"](${b});relation["highway"="pedestrian"]["area"="yes"](${b}););`,
    'out geom;',
  ].join('\n');
}

export function extraQueryHash(): string {
  return createHash('sha1').update(buildExtraQuery()).digest('hex').slice(0, 12);
}


class QueryRejected extends Error {}

interface OverpassResponse {
  version: number;
  generator: string;
  osm3s: { timestamp_osm_base: string; copyright: string };
  elements: OsmElement[];
}

async function post(query: string): Promise<OverpassResponse> {
  let last = '';
  for (let attempt = 0; attempt <= BACKOFF_S.length; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_S[attempt - 1];
      console.log(`  retry ${attempt}/${BACKOFF_S.length} in ${wait}s (${last})`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait * 1000);
      await promise;
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        // 429/5xx are transient; other 4xx mean the query itself is wrong.
        if (res.status !== 429 && res.status < 500) throw new QueryRejected(`Overpass rejected the query (HTTP ${res.status}): ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400)}`);
        continue;
      }
      // Overpass reports runtime errors / busy dispatchers as HTTP 200 + HTML/XML.
      if (!text.trimStart().startsWith('{')) {
        last = text.includes('timeout') ? 'server busy/timeout' : 'non-JSON response';
        continue;
      }
      const json = JSON.parse(text) as OverpassResponse & { remark?: string };
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
        last = `remark: ${json.remark.slice(0, 120)}`;
        continue;
      }
      if (!Array.isArray(json.elements) || json.elements.length === 0) {
        last = 'empty element list';
        continue;
      }
      return json;
    } catch (err) {
      if (err instanceof QueryRejected) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`Overpass failed after ${BACKOFF_S.length + 1} attempts (${last}); cache left untouched`);
}

/** Dedupe by type+id (statements overlap), sort by type then id so the cache file is stable. */
function normalise(elements: OsmElement[]): OsmElement[] {
  const byKey = new Map<string, OsmElement>();
  for (const e of elements) {
    const key = `${e.type}/${e.id}`;
    const prev = byKey.get(key);
    if (!prev || JSON.stringify(e).length > JSON.stringify(prev).length) byKey.set(key, e);
  }
  const rank: Record<OsmElement['type'], number> = { node: 0, way: 1, relation: 2 };
  return [...byKey.values()].sort((a, b) => rank[a.type] - rank[b.type] || a.id - b.id);
}

async function fetchTo(path: string, query: string, hash: string): Promise<RawFile> {
  console.log(`Overpass POST ${ENDPOINT}`);
  const resp = await post(query);
  const raw: RawFile = {
    meta: { fetchedAt: new Date().toISOString(), endpoint: ENDPOINT, queryHash: hash },
    osm: { version: resp.version, generator: resp.generator, osm3s: resp.osm3s, elements: normalise(resp.elements) },
  };
  mkdirSync(dirname(path), { recursive: true });
  const head = JSON.stringify({ meta: raw.meta, osm: { version: raw.osm.version, generator: raw.osm.generator, osm3s: raw.osm.osm3s } });
  // One element per line keeps the committed cache diffable.
  const body = raw.osm.elements.map(e => JSON.stringify(e)).join(',\n');
  writeFileSync(path, `${head.slice(0, -2)},"elements":[\n${body}\n]}}\n`);
  console.log(`  ${raw.osm.elements.length} elements → ${path}`);
  return raw;
}

export const fetchRaw = (): Promise<RawFile> => fetchTo(RAW_PATH, buildQuery(), queryHash());

/** Scene-only extras; leaves `raw-q1.json` (and so the network output) untouched. */
export const fetchExtra = (): Promise<RawFile> => fetchTo(RAW_EXTRA_PATH, buildExtraQuery(), extraQueryHash());
