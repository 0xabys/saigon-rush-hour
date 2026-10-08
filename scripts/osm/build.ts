/**
 * raw Overpass cache → src/data/q1-network.json + q1-scene.json + data/osm/report.json.
 * Pure and deterministic: no clock, no randomness, every iteration order is sorted by id.
 */
import type { ExtraSourceJson, GobSourceJson, NetworkJson, SceneJson, SourceJson } from '../../src/data/q1Schema';
import { Q1_SCHEMA } from '../../src/data/q1Schema';
import { BBOX, extraQueryHash, queryHash } from './fetch';
import { GOB_TILE, GOB_URL, gobFilterHash } from './gob';
import { pruneEdges, shortLinks, solve } from './lib/chains';
import type { Solved } from './lib/chains';
import { clipWays } from './lib/clip';
import { D_HARD, D_MAX, clusterJunctions } from './lib/cluster';
import type { ClusterResult, ForcedMerge } from './lib/cluster';
import { emitNetwork, r2 } from './lib/emit';
import { filterWays } from './lib/filter';
import { MIN_AREA, MIN_CONF, SHIFT_X, SHIFT_Z, buildFootprints } from './lib/footprints';
import { Diag, buildTopo, stuckArms } from './lib/graph';
import type { Anomaly, Graph, Topo } from './lib/graph';
import { BOUNDS, KX, KZ, LAT0, LON0, insideBounds, project } from './lib/project';
import { detectRings } from './lib/rings';
import type { RingDraft } from './lib/rings';
import { buildScene } from './lib/scene';
import { armsOf, assignSignals, signalPairs } from './lib/signals';
import type { GobFile, OsmNode, OsmRelation, OsmWay, P2, RawFile } from './lib/types';
import { flow } from './lib/chains';

export const BUILDER = 'scripts/osm v1';
const MAX_ROUNDS = 24;
const MAX_FORCE_ROUNDS = 8;

export interface BuildOutput {
  network: string;
  scene: string;
  report: string;
  /** Human-readable summary lines. */
  summary: string[];
  fatal: string[];
}

interface Round {
  topo: Topo;
  cl: ClusterResult;
  solved: Solved;
}

function solveRound(g: Graph, rings: RingDraft[], ringNodes: Map<number, number>, forced: ForcedMerge[], diag: Diag): Round {
  const topo = buildTopo(g, ringNodes);
  const cl = clusterJunctions(g, topo, forced, diag);
  return { topo, cl, solved: solve(g, topo, cl, rings, ringNodes, diag) };
}

const serialize = (v: unknown) => `${JSON.stringify(v)}\n`;

/** Path of the first NaN/Infinity inside a JSON-bound value (JSON.stringify would silently emit null). */
function findNonFinite(v: unknown, path: string): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (typeof v !== 'object' || v === null) return null;
  for (const [k, child] of Object.entries(v)) {
    const hit = findNonFinite(child, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

export function buildAll(raw: RawFile, extra: RawFile, gob: GobFile): BuildOutput {
  const diag = new Diag();
  if (!raw.meta || !Array.isArray(raw.osm?.elements)) throw new Error('raw cache is malformed (expected { meta, osm: { elements } })');
  if (!extra.meta || !Array.isArray(extra.osm?.elements)) throw new Error('extra raw cache is malformed (expected { meta, osm: { elements } })');
  if (!gob.meta || !Array.isArray(gob.rows)) throw new Error('gob cache is malformed (expected { meta, rows })');
  if (raw.meta.queryHash !== queryHash()) {
    diag.fatal.push(`raw cache was fetched with query ${raw.meta.queryHash} but the current query is ${queryHash()}; run \`npm run osm -- --refresh\``);
  }
  if (extra.meta.queryHash !== extraQueryHash()) {
    diag.fatal.push(`extra raw cache was fetched with query ${extra.meta.queryHash} but the current extra query is ${extraQueryHash()}; run \`npm run osm -- --refresh-extra\``);
  }
  if (gob.meta.filterHash !== gobFilterHash()) {
    diag.fatal.push(`gob cache was filtered with ${gob.meta.filterHash} but the current filter is ${gobFilterHash()}; run \`npm run osm:refresh-gob\``);
  }
  gob.rows.forEach((r, i) => {
    if (r.id !== i + 1) diag.fatal.push(`gob cache row ${i + 1} has id ${r.id}; ids must be the 1-based rank in the cache (run \`npm run osm:refresh-gob\`)`);
  });

  // Raw elements.
  const nodePos = new Map<number, P2>();
  const rawWays: OsmWay[] = [];
  const signalNodes: number[] = [];
  const busNodes: OsmNode[] = [];
  const shapes: (OsmWay | OsmRelation)[] = [];
  for (const e of raw.osm.elements) {
    if (e.type === 'node') {
      nodePos.set(e.id, project(e));
      if (e.tags?.highway === 'traffic_signals' && insideBounds(project(e))) signalNodes.push(e.id);
      if (e.tags?.highway === 'bus_stop' && insideBounds(project(e))) busNodes.push(e);
    } else {
      shapes.push(e);
      if (e.type === 'way' && e.nodes && e.tags?.highway && !e.geometry) rawWays.push(e);
    }
  }
  diag.count('roadWaysRaw', rawWays.length);
  diag.count('signalsInRaw', signalNodes.length);
  diag.count('busStopsRaw', busNodes.length);

  // §3.2 filter, §3.7 rings, §3.3 clip.
  const filtered = filterWays(rawWays);
  diag.count('waysKept', filtered.ways.length);
  for (const [reason, n] of Object.entries(filtered.dropped)) diag.count(`waysDropped_${reason}`, n);
  const rings = detectRings(filtered.ways, nodePos, diag);
  const ringNodes = new Map<number, number>();
  rings.forEach((r, i) => {
    for (const n of r.nodes) ringNodes.set(n, i);
  });
  const nonRing = filtered.ways.filter(w => !w.ring);
  diag.count('ringWays', filtered.ways.length - nonRing.length);
  const g = clipWays(nonRing, nodePos, diag);
  diag.count('edges', g.edges.length);
  diag.count('portalsClipped', g.portals.size);

  // §3.4–3.6 iterate topology → clusters → chains → pruning until stable.
  const forced: ForcedMerge[] = [];
  let forceRounds = 0;
  let converged = false;
  let deadStubs = 0;
  let portalStubs = 0;
  for (let it = 0; it < MAX_ROUNDS && !converged; it++) {
    const { cl: roundCl, solved } = solveRound(g, rings, ringNodes, forced, new Diag());
    let changed = false;
    if (forceRounds < MAX_FORCE_ROUNDS) {
      // Links the sim would trim away, and links between two signalised clusters (one signal-controlled junction).
      const sigKeys = assignSignals(g, solved, roundCl.rep, signalNodes, new Diag()).keys;
      const wanted: ForcedMerge[] = [
        ...shortLinks(solved).map(sl => ({ a: sl.a, b: sl.b, cap: D_HARD, guard: true })),
        ...signalPairs(solved, sigKeys).map(p => ({ a: p.a, b: p.b, cap: D_MAX, guard: true })),
      ];
      const fresh = wanted.filter(w => !forced.some(f => f.a === w.a && f.b === w.b));
      if (fresh.length) {
        forced.push(...fresh);
        forceRounds++;
        changed = true;
      }
    }
    if (!changed) {
      const p = pruneEdges(solved);
      for (const id of p.edges) g.edges[id].alive = false;
      deadStubs += p.deadStubs;
      portalStubs += p.portalStubs;
      changed = p.edges.length > 0;
    }
    converged = !changed;
  }
  if (!converged) diag.fatal.push(`pruning did not converge in ${MAX_ROUNDS} rounds`);
  const { topo, cl, solved } = solveRound(g, rings, ringNodes, forced, diag);
  diag.count('forcedMerges', forced.length);
  diag.count('deadStubsPruned', deadStubs);
  diag.count('portalStubsPruned', portalStubs);

  // Post-conditions (fail closed): portals have exactly one arm; junction/join nodes can be entered and left.
  let armsNoExit = 0;
  let armsHairpin = 0;
  for (const [key, node] of solved.nodes) {
    const list = solved.arms.get(key) ?? [];
    if (node.kind === 'portal' && list.length !== 1) diag.fatal.push(`portal ${key} has ${list.length} arms`);
    if (node.kind !== 'junction' && node.kind !== 'join') continue;
    if (!list.some(r => flow(solved.links[r.link], r.end).in) || !list.some(r => flow(solved.links[r.link], r.end).out)) {
      diag.fatal.push(`node ${key} (${node.kind}) has no inbound or no outbound arm`);
    }
    for (const r of list) {
      if (!flow(solved.links[r.link], r.end).in) continue;
      if (list.some(o => (o.link !== r.link || o.end !== r.end) && flow(solved.links[o.link], o.end).out)) continue;
      armsNoExit++;
      const l = solved.links[r.link];
      diag.add('arm-no-exit', 'warn', `Inbound arm of link ${l.name || '(không tên)'} has no legal way out; the sim ends it as a dead end`, l.osm, { x: node.x, z: node.z });
    }
    const geoms = armsOf(solved, key);
    for (const a of stuckArms(geoms).filter(st => geoms.some(o => o !== st && o.outbound))) {
      armsHairpin++;
      const l = solved.links[a.link];
      diag.add('arm-hairpin', 'warn', `Inbound arm of link ${l.name || '(không tên)'} can only leave by a turn of more than 150°; the sim ends it as a dead end`, l.osm, { x: node.x, z: node.z });
    }
  }
  diag.count('armsNoExit', armsNoExit);
  diag.count('armsHairpin', armsHairpin);

  // §3.10 signals.
  const sig = assignSignals(g, solved, cl.rep, signalNodes, diag);

  // §3.12 bus stops, §3.11 names, ids, rounding.
  const busInputs = busNodes.sort((a, b) => a.id - b.id).map(node => ({ node, at: project(node) }));
  const source: SourceJson = {
    provider: 'OpenStreetMap',
    license: 'ODbL',
    attribution: '© OpenStreetMap contributors',
    osmBase: raw.osm.osm3s.timestamp_osm_base,
    fetchedAt: raw.meta.fetchedAt,
    queryHash: raw.meta.queryHash,
    bbox: [...BBOX],
    builder: BUILDER,
  };
  const base = {
    schema: Q1_SCHEMA,
    source,
    projection: { lat0: LAT0, lon0: LON0, kx: Math.round(KX * 1e4) / 1e4, kz: Math.round(KZ * 1e4) / 1e4 },
    bounds: { minX: r2(BOUNDS.minX), maxX: r2(BOUNDS.maxX), minZ: r2(BOUNDS.minZ), maxZ: r2(BOUNDS.maxZ) },
  } satisfies Omit<NetworkJson, 'nodes' | 'links' | 'rings' | 'busStops' | 'stats'>;

  const counts = (kind: string) => [...solved.nodes.values()].filter(n => n.kind === kind).length;
  diag.count('junctions', counts('junction'));
  diag.count('joins', counts('join'));
  diag.count('portals', counts('portal'));
  diag.count('deadEnds', counts('dead'));
  diag.count('rings', rings.length);
  diag.count('clusters', [...solved.nodes.values()].filter(n => n.kind === 'junction' && n.osm.length > 1).length);
  diag.count('clusterMembers', [...solved.nodes.values()].filter(n => n.kind === 'junction').reduce((s, n) => s + n.osm.length, 0));
  diag.count('signalNodes', sig.keys.size);
  diag.count('links', solved.links.length);
  diag.count('linksOneway', solved.links.filter(l => l.lanesB === 0).length);
  diag.count('linkMetres', Math.round(solved.links.reduce((s, l) => s + l.length, 0)));
  diag.count('maxClusterDiagM', Math.round(Math.max(0, ...[...cl.clusters.values()].map(c => c.diag))));
  diag.count('orphanEdges', solved.orphanEdges);
  diag.count('streetNames', new Set(solved.links.map(l => l.name).filter(n => n)).size);

  const emitted = emitNetwork({ g, solved, rings, signalKeys: sig.keys, busStops: busInputs, base });
  const net = emitted.network;
  diag.count('busStops', net.busStops.length);
  for (const b of emitted.busUnmatched) diag.add('busstop-unmatched', 'info', `bus_stop "${b.node.tags?.name ?? ''}" is more than 25 m from any link`, [b.node.id], b.at);
  diag.count('busStopsUnmatched', emitted.busUnmatched.length);

  const scene = buildScene(shapes, extra.osm.elements, diag);
  const extraSource: ExtraSourceJson = { osmBase: extra.osm.osm3s.timestamp_osm_base, fetchedAt: extra.meta.fetchedAt, queryHash: extra.meta.queryHash };
  const gobSource: GobSourceJson = {
    provider: 'Google Open Buildings',
    version: 'v3',
    license: 'ODbL',
    attribution: 'Google Open Buildings v3',
    url: GOB_URL,
    tile: GOB_TILE,
    etag: gob.meta.etag,
    fetchedAt: gob.meta.fetchedAt,
    filterHash: gob.meta.filterHash,
    minConf: MIN_CONF,
    minArea: MIN_AREA,
    shift: [SHIFT_X, SHIFT_Z],
  };
  // Must not use `diag.count`: those counters end up in q1-network.json, which stays byte-identical.
  const footprints = buildFootprints(gob, scene, net);
  const sceneJson: SceneJson = { schema: Q1_SCHEMA, source, extraSource, gobSource, buildings: scene.buildings, gobBuildings: footprints.list, water: scene.water, parks: scene.parks, sites: scene.sites, plazas: scene.plazas, landmarks: scene.landmarks };
  net.stats = Object.fromEntries(Object.entries(diag.stats).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  // §3.14 anomalies from the final topology.
  const rad = (d: number) => (d * Math.PI) / 180;
  for (const [key, node] of solved.nodes) {
    const at = { x: node.x, z: node.z };
    if (node.kind === 'junction') {
      const c = cl.clusters.get(key);
      if (c && c.diag > 40) diag.add('cluster-large', 'warn', `Cluster of ${c.members.length} nodes spans ${c.diag.toFixed(0)} m`, c.members, at);
    }
    if (node.kind === 'junction' || node.kind === 'join') {
      const arms = armsOf(solved, key);
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i];
        const b = arms[(i + 1) % arms.length];
        if (arms.length < 2 || (arms.length === 2 && i === 1)) continue;
        const d = Math.abs(Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle)));
        const paired = a.inbound !== a.outbound && b.inbound !== b.outbound && a.inbound !== b.inbound;
        if (d < rad(20)) diag.add('arms-close', paired ? 'info' : 'warn', `Two ${paired ? 'opposite-flow ' : ''}arms leave at ${((d * 180) / Math.PI).toFixed(0)}°`, [...solved.links[a.link].osm, ...solved.links[b.link].osm], at);
      }
    }
    if (node.kind === 'dead' && (solved.arms.get(key) ?? []).length >= 2) diag.add('sink-node', 'warn', 'Node where every inbound link has no exit; treated as dead end', node.osm, at);
    if (node.kind === 'ring') {
      const list = solved.arms.get(key) ?? [];
      const into = list.some(r => flow(solved.links[r.link], r.end).in);
      const out = list.some(r => flow(solved.links[r.link], r.end).out);
      if (!into || !out) diag.add('ring-no-entry-exit', 'warn', `Ring has ${list.length} arm(s) but ${into ? '' : 'no entry'}${into || out ? '' : ' and '}${out ? '' : 'no exit'}`, node.osm.slice(0, 3), at);
    }
    for (const m of node.osm) {
      const p = g.pos.get(m);
      if (p && node.kind !== 'portal' && (Math.abs(p.x - BOUNDS.minX) < 0.05 || Math.abs(p.x - BOUNDS.maxX) < 0.05 || Math.abs(p.z - BOUNDS.minZ) < 0.05 || Math.abs(p.z - BOUNDS.maxZ) < 0.05)) {
        diag.add('boundary-node', 'warn', 'Kept node lies on the bbox boundary without being a portal', [m], p);
      }
    }
  }
  for (const n of topo.flip) {
    const p = g.pos.get(n);
    if (p) diag.add('oneway-flip', 'info', 'Degree-2 node where one-way flow reverses', [n], p);
  }
  solved.links.forEach(l => {
    const mid = l.pts[Math.floor(l.pts.length / 2)];
    if (l.length < 10) diag.add('link-short', 'info', `Link of ${l.length.toFixed(1)} m`, l.osm, mid);
    if (!l.name) diag.add('link-unnamed', 'info', 'Link without a street name', l.osm, mid);
  });
  for (const sl of shortLinks(solved)) {
    const l = solved.links[sl.link];
    diag.add('link-trim-short', 'warn', `Only ${sl.left.toFixed(1)} m left between the stop lines of two junctions`, l.osm, l.pts[Math.floor(l.pts.length / 2)]);
  }
  if (solved.orphanEdges > 0) diag.add('orphan-edges', 'warn', `${solved.orphanEdges} edge(s) on closed chains without a junction`, [], { x: 0, z: 0 });

  const anomalies: Anomaly[] = diag.anomalies
    .map(a => ({ ...a, x: r2(a.x), z: r2(a.z) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.x - b.x || a.z - b.z || (a.osm[0] ?? 0) - (b.osm[0] ?? 0)));
  const anomalyCounts: Record<string, number> = {};
  for (const a of anomalies) anomalyCounts[a.kind] = (anomalyCounts[a.kind] ?? 0) + 1;
  for (const [label, value] of [['network', net], ['scene', sceneJson]] as const) {
    const bad = findNonFinite(value, label);
    if (bad) diag.fatal.push(`non-finite number at ${bad}`);
  }
  const names = [...new Set(net.links.map(l => l.name).filter(n => n))].sort();
  const report = {
    builder: BUILDER,
    source: { osmBase: source.osmBase, fetchedAt: source.fetchedAt, queryHash: source.queryHash, bbox: source.bbox },
    counts: net.stats,
    streets: { count: names.length, names },
    landmarks: sceneJson.landmarks.map(l => ({ key: l.key, osm: l.osm, name: l.name, cx: l.cx, cz: l.cz })),
    footprints: { source: gobSource, ...footprints.counts },
    fatal: diag.fatal,
    anomalyCounts,
    anomalies,
  };

  const s = net.stats;
  const summary = [
    `ways kept ${s.waysKept}/${s.roadWaysRaw}, edges ${s.edges}, portals ${s.portals}, dead ends ${s.deadEnds}`,
    `junctions ${s.junctions} (${s.clusters} multi-node clusters, ${s.signalNodes} signalised), joins ${s.joins}, rings ${s.rings}`,
    `links ${s.links} (${s.linksOneway} one-way, ${(s.linkMetres / 1000).toFixed(1)} km), street names ${s.streetNames}`,
    `signals ${s.signalsMatched ?? 0}/${s.signalsInRaw} matched, bus stops ${s.busStops}/${s.busStopsRaw}`,
    `buildings ${s.buildings}, water ${s.water}, parks ${s.parks}, building sites ${sceneJson.sites.length}, plazas ${sceneJson.plazas.length}, landmarks ${sceneJson.landmarks.length}`,
    `footprints kept ${footprints.counts.kept}/${footprints.counts.rows} (${Object.entries(footprints.counts.dropped).map(([k, v]) => `${k} ${v}`).join(', ')}), ${footprints.counts.areaHa} ha`,
    `anomalies: ${Object.entries(anomalyCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
  ];
  return { network: serialize(net), scene: serialize(sceneJson), report: serialize(report), summary, fatal: diag.fatal };
}
