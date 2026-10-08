/**
 * `npm run osm`                   rebuild JSON from the cached Overpass responses (fetches only caches that are missing)
 * `npm run osm -- --refresh`       call Overpass once, replace the road/building cache, rebuild
 * `npm run osm -- --refresh-extra` call Overpass once for the scene-only extras (construction lots, plazas) and rebuild;
 *                                  raw-q1.json and therefore q1-network.json are left untouched
 * `npm run osm -- --refresh-gob`   download Google Open Buildings v3 tile 317 (1.9 GB; or read $GOB_TILE_PATH), rewrite raw-q1-gob.json, rebuild;
 *                                  never implied by --refresh, never touches q1-network.json
 * `npm run osm -- --check`         rebuild in memory and fail unless the committed outputs are byte-identical
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildAll } from './build';
import { RAW_EXTRA_PATH, RAW_PATH, ROOT, fetchExtra, fetchRaw } from './fetch';
import { RAW_GOB_PATH, fetchGob } from './gob';
import type { GobFile, RawFile } from './lib/types';

const OUTPUTS = {
  network: resolve(ROOT, 'src/data/q1-network.json'),
  scene: resolve(ROOT, 'src/data/q1-scene.json'),
  report: resolve(ROOT, 'data/osm/report.json'),
};

// `npm run osm --check` never reaches the script as an argument: npm swallows unknown flags into
// `npm_config_*` env vars, so honour those too (`npm run osm -- --check` works as well).
const args = process.argv.slice(2);
for (const flag of ['refresh', 'refresh-extra', 'refresh-gob', 'check']) if (process.env[`npm_config_${flag.replace('-', '_')}`] === 'true') args.push(`--${flag}`);
const known = ['--refresh', '--refresh-extra', '--refresh-gob', '--check'];
const unknown = args.filter(a => !known.includes(a));
if (unknown.length || (args.includes('--check') && args.some(a => a.startsWith('--refresh')))) {
  console.error(`usage: bun scripts/osm/index.ts [--refresh] [--refresh-extra] [--refresh-gob] | [--check]  (got: ${args.join(' ') || 'nothing'})`);
  process.exitCode = 2;
} else {
  const refresh = args.includes('--refresh');
  const refreshExtra = args.includes('--refresh-extra') || refresh;
  const check = args.includes('--check');
  if (check) {
    if (!existsSync(RAW_PATH) || !existsSync(RAW_EXTRA_PATH)) {
      console.error('--check needs the cached raw files; run `npm run osm` first');
      process.exitCode = 1;
    }
  } else {
    if (refresh || !existsSync(RAW_PATH)) await fetchRaw();
    if (refreshExtra || !existsSync(RAW_EXTRA_PATH)) await fetchExtra();
    if (args.includes('--refresh-gob')) await fetchGob();
  }
  if (!existsSync(RAW_GOB_PATH) && process.exitCode === undefined) {
    console.error('Open Buildings cache data/osm/raw-q1-gob.json is missing; run `npm run osm:refresh-gob` (downloads a 1.9 GB tile, or set GOB_TILE_PATH to a local copy)');
    process.exitCode = 1;
  }
  if (existsSync(RAW_PATH) && existsSync(RAW_EXTRA_PATH) && process.exitCode === undefined) {
    const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8')) as RawFile;
    const extra = JSON.parse(readFileSync(RAW_EXTRA_PATH, 'utf8')) as RawFile;
    const gob = JSON.parse(readFileSync(RAW_GOB_PATH, 'utf8')) as GobFile;
    const out = buildAll(raw, extra, gob);
    for (const line of out.summary) console.log(line);
    if (out.fatal.length) {
      console.error(`\nBuild FAILED (${out.fatal.length} fatal):`);
      for (const f of out.fatal) console.error(`  - ${f}`);
      process.exitCode = 1;
    } else if (check) {
      const mismatched = (Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]).filter(
        k => !existsSync(OUTPUTS[k]) || readFileSync(OUTPUTS[k], 'utf8') !== out[k],
      );
      if (mismatched.length) {
        console.error(`--check FAILED: not byte-identical: ${mismatched.join(', ')}`);
        process.exitCode = 1;
      } else console.log('--check OK: q1-network.json, q1-scene.json, report.json are byte-identical to a fresh build');
    } else {
      for (const k of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
        mkdirSync(dirname(OUTPUTS[k]), { recursive: true });
        writeFileSync(OUTPUTS[k], out[k]);
      }
      console.log(`wrote ${Object.values(OUTPUTS).map(p => p.slice(ROOT.length + 1)).join(', ')}`);
    }
  }
}
