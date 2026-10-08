/**
 * Google Open Buildings v3 fetch: one S2 level-4 tile (317) covers the bbox. Footprints whose centroid lies inside the bbox are
 * cached verbatim (every confidence) at data/osm/raw-q1-gob.json. Only `npm run osm:refresh-gob` ever writes it; `npm run osm`
 * and `osm:check` read it. v3 is a frozen release, so the cache is an immutable id space: row id = rank in the sorted file.
 *
 * `GOB_TILE_PATH=/path/317_buildings.csv.gz npm run osm:refresh-gob` reads an already downloaded tile instead of the 1.9 GB download.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { BBOX, ROOT } from './fetch';
import type { GobFile, GobMeta, GobRow } from './lib/types';

export const RAW_GOB_PATH = resolve(ROOT, 'data/osm/raw-q1-gob.json');

export const GOB_URL = 'https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/317_buildings.csv.gz';
export const GOB_TILE = '317';
const GOB_SOURCE = 'google-open-buildings-v3';
/** Size, ETag and Last-Modified of the v3 tile when this pipeline was designed; a different ETag means Google changed the file and every id would re-key. */
const GOB_BYTES = 1913443273;
const GOB_ETAG = '1874f911338889cef65ff15282c7f040';
const GOB_LAST_MODIFIED = 'Fri, 23 Jun 2023 10:00:06 GMT';
const PARTS = 24;

/** Fingerprint of everything that decides which rows land in the cache; build.ts refuses a cache made with another filter. */
export function gobFilterHash(): string {
  return createHash('sha1').update(`gob-v3|${GOB_TILE}|${BBOX.join(',')}|centroid-in-bbox|7dec|v1`).digest('hex').slice(0, 12);
}

const r7 = (v: number): number => Math.round(v * 1e7) / 1e7;

interface Remote {
  etag: string;
  lastModified: string;
  bytes: number;
}

/** HEAD of the public tile: size, ETag, Last-Modified. */
async function head(): Promise<Remote> {
  const res = await fetch(GOB_URL, { method: 'HEAD' });
  if (!res.ok) throw new Error(`HEAD ${GOB_URL} failed: HTTP ${res.status}`);
  return {
    etag: (res.headers.get('etag') ?? '').replaceAll('"', ''),
    lastModified: res.headers.get('last-modified') ?? '',
    bytes: Number(res.headers.get('content-length') ?? 0),
  };
}

/** One byte range of the tile into `path`; retried because a 1.9 GB transfer over 24 connections will see resets. */
async function fetchPart(path: string, from: number, to: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      writeFileSync(path, '');
      const res = await fetch(GOB_URL, { headers: { Range: `bytes=${from}-${to}` } });
      if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status} for bytes ${from}-${to}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        appendFileSync(path, value);
      }
      if (statSync(path).size !== to - from + 1) throw new Error(`short read for bytes ${from}-${to}`);
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn(`  part ${from}-${to}: ${err instanceof Error ? err.message : String(err)}; retry ${attempt}/4`);
    }
  }
}

/** Downloads the tile as 24 parallel `Range` requests into `dir`; returns the part paths in order. */
async function download(dir: string, bytes: number): Promise<string[]> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const chunk = Math.ceil(bytes / PARTS);
  const parts: string[] = [];
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < PARTS; i++) {
    const from = i * chunk;
    const to = Math.min(bytes - 1, from + chunk - 1);
    const path = resolve(dir, `part-${String(i).padStart(2, '0')}`);
    parts.push(path);
    jobs.push(fetchPart(path, from, to));
  }
  await Promise.all(jobs);
  const total = parts.reduce((s, p) => s + statSync(p).size, 0);
  if (total !== bytes) throw new Error(`downloaded ${total} bytes, expected ${bytes}; cache left untouched`);
  return parts;
}

async function* chunksOf(paths: string[]): AsyncGenerator<Uint8Array> {
  for (const p of paths) yield* createReadStream(p);
}

/** Outer ring of the largest polygon in a POLYGON / MULTIPOLYGON WKT, as flat [lon, lat, …] rounded to 7 decimals without the closing vertex; null when unusable. */
export function outerRing(wkt: string): number[] | null {
  // A ring opens with `((` (outer) or `,(` (hole); only outer rings are kept.
  const outers: number[][] = [];
  for (const m of wkt.matchAll(/([(,])\s*\(([^()]*)\)/g)) {
    if (m[1] !== '(') continue;
    const flat: number[] = [];
    for (const pair of m[2].split(',')) {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const x = r7(lon);
      const y = r7(lat);
      const n = flat.length;
      if (n >= 2 && flat[n - 2] === x && flat[n - 1] === y) continue;
      flat.push(x, y);
    }
    const n = flat.length;
    if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) flat.length = n - 2;
    if (flat.length >= 6) outers.push(flat);
  }
  const area = (r: number[]): number => {
    let a = 0;
    for (let i = 0; i < r.length; i += 2) {
      const j = (i + 2) % r.length;
      a += r[i] * r[j + 1] - r[j] * r[i + 1];
    }
    return Math.abs(a);
  };
  let best: number[] | null = null;
  for (const r of outers) if (!best || area(r) > area(best)) best = r;
  return best;
}

/** Streams the gzip CSV and keeps rows whose centroid lies inside the bbox (inclusive). Throws on any row it cannot parse. */
async function filterTile(source: Readable): Promise<Omit<GobRow, 'id'>[]> {
  const [south, west, north, east] = BBOX;
  const gunzip = createGunzip();
  source.on('error', e => gunzip.destroy(e));
  source.pipe(gunzip);
  const rows: Omit<GobRow, 'id'>[] = [];
  let seen = 0;
  for await (const line of createInterface({ input: gunzip, crlfDelay: Infinity })) {
    if (line.startsWith('latitude')) continue;
    seen++;
    const c1 = line.indexOf(',');
    const lat = Number(line.slice(0, c1));
    if (!(lat >= south && lat <= north)) continue;
    const c2 = line.indexOf(',', c1 + 1);
    const lon = Number(line.slice(c1 + 1, c2));
    if (!(lon >= west && lon <= east)) continue;
    const c3 = line.indexOf(',', c2 + 1);
    const c4 = line.indexOf(',', c3 + 1);
    const q = line.lastIndexOf('",');
    const ring = c4 > 0 && q > c4 ? outerRing(line.slice(c4 + 1, q + 1)) : null;
    if (!ring) throw new Error(`unparseable Open Buildings row inside the bbox (line ${seen}): ${line.slice(0, 200)}`);
    rows.push({
      lat: r7(lat),
      lon: r7(lon),
      conf: Number(line.slice(c3 + 1, c4)),
      area: Math.round(Number(line.slice(c2 + 1, c3)) * 100) / 100,
      code: line.slice(q + 2),
      ring,
    });
  }
  console.log(`  scanned ${seen} rows, ${rows.length} inside the bbox`);
  return rows;
}

/** Fetches (or reads `GOB_TILE_PATH`), filters, sorts by (lat, lon, plus code), numbers 1…n and writes the cache. */
export async function fetchGob(): Promise<GobFile> {
  const local = process.env.GOB_TILE_PATH;
  let remote: Remote = { etag: GOB_ETAG, lastModified: GOB_LAST_MODIFIED, bytes: GOB_BYTES };
  try {
    remote = await head();
    if (remote.etag !== GOB_ETAG) console.warn(`  WARNING: tile ETag is ${remote.etag}, designed against ${GOB_ETAG}; Google changed the file, review before committing (ids re-key)`);
  } catch (err) {
    if (!local) throw err;
    console.warn(`  HEAD failed (${err instanceof Error ? err.message : String(err)}); recording the pinned ETag/Last-Modified of the designed tile`);
  }

  let rows: Omit<GobRow, 'id'>[];
  if (local) {
    if (!existsSync(local)) throw new Error(`GOB_TILE_PATH ${local} does not exist`);
    console.log(`Open Buildings tile ${GOB_TILE} from ${local}`);
    rows = await filterTile(createReadStream(local));
  } else {
    const dir = resolve(process.env.TMPDIR ?? '/tmp', `gob-${GOB_TILE}`);
    console.log(`Open Buildings tile ${GOB_TILE}: ${(remote.bytes / 1e9).toFixed(2)} GB in ${PARTS} ranges → ${dir}`);
    const parts = await download(dir, remote.bytes);
    try {
      rows = await filterTile(Readable.from(chunksOf(parts)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  rows.sort((a, b) => Math.round(a.lat * 1e7) - Math.round(b.lat * 1e7) || Math.round(a.lon * 1e7) - Math.round(b.lon * 1e7) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const numbered: GobRow[] = rows.map((r, i) => ({ id: i + 1, lat: r.lat, lon: r.lon, conf: r.conf, area: r.area, code: r.code, ring: r.ring }));
  const meta: GobMeta = {
    source: GOB_SOURCE,
    url: GOB_URL,
    tile: GOB_TILE,
    etag: remote.etag,
    lastModified: remote.lastModified,
    fetchedAt: new Date().toISOString(),
    bbox: BBOX,
    filterHash: gobFilterHash(),
    rows: numbered.length,
  };
  const file: GobFile = { meta, rows: numbered };
  mkdirSync(dirname(RAW_GOB_PATH), { recursive: true });
  // One row per line keeps the committed cache diffable.
  writeFileSync(RAW_GOB_PATH, `{"meta":${JSON.stringify(meta)},"rows":[\n${numbered.map(r => JSON.stringify(r)).join(',\n')}\n]}\n`);
  console.log(`  ${numbered.length} footprints → ${RAW_GOB_PATH}`);
  return file;
}
