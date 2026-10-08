import type { SceneJson } from './q1Schema';

/**
 * Curated corrections to the OSM land use in `q1-scene.json` (the network is untouched): lots that OSM tags as
 * `landuse=construction` but are not active building sites, the Nguyễn Huệ walking-street surface, plaza paving
 * colours and what the unfinished One Central frame looks like. Consumed by zones.ts, terrain.ts, vegetation.ts and
 * construction.ts through `resolveGround`.
 */

type Site = SceneJson['sites'][number];
type Plaza = SceneJson['plazas'][number];

/** Sites that are drawn as open paved ground instead of a hoarded dirt lot, with the reason. */
export const INACTIVE_SITES: Record<number, string> = {
  // Khu Di tích Bến Nhà Rồng: OSM tags the 12 000 m² historic wharf forecourt landuse=construction + barrier=fence; it is the
  // open forecourt of the Nhà Rồng museum (https://en.wikipedia.org/wiki/Nh%C3%A0_R%E1%BB%93ng_Wharf), not a building site.
  808033616: 'Nhà Rồng wharf forecourt',
  // Construction=cathedral, 250-280 m² each, on the Công xã Paris forecourt: the cathedral restoration hoarding, not an excavation.
  803199397: 'Notre-Dame forecourt works',
  803199398: 'Notre-Dame forecourt works',
  // construction=public, 6 700 m² on the Bến Bạch Đằng riverside park between the Grand Hotel and the river. No active build found
  // (press reports only mention planned footbridges over Tôn Đức Thắng), so the riverside park stays open ground.
  1056530140: 'Bến Bạch Đằng riverside',
};

/**
 * Nguyễn Huệ is mapped as two carriageways about 36 m apart (OSM ways 377881079 / 1122280206 on one side, 341504312 /
 * 1122280205 on the other). The strip between them is the walking street; the polygon is bounded by the two centrelines,
 * under the asphalt and the pavements, so only the pedestrian surface shows.
 */
const NGUYEN_HUE_A: number[] = [24, -229, 112, -148, 123, -137, 148, -112, 215, -49, 297, 28, 443, 164, 556, 269, 581, 292];
const NGUYEN_HUE_B: number[] = [-2, -198, 95, -108, 122, -84, 128, -79, 188, -23, 255, 39, 292, 73, 418, 191, 481, 251, 530, 296, 577, 339];

function reversed(flat: number[]): number[] {
  const out: number[] = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

/** Synthetic plaza id of the walking street. */
export const NGUYEN_HUE_PROMENADE = -1;

/** Light granite of the Nguyễn Huệ promenade. */
const PROMENADE_STONE = 0xeee6d2;
/** Công trường Quách Thị Trang: cool grey granite slabs, not sandstone. */
const QUACH_THI_TRANG_STONE = 0xc5ced0;

/** Paving colour per plaza id (default: sandstone). */
export const PLAZA_TINT: Record<number, number> = {
  [NGUYEN_HUE_PROMENADE]: PROMENADE_STONE,
  1475190937: QUACH_THI_TRANG_STONE,
};

/** Synthetic plaza id of the Dinh Độc Lập compound paving. */
const PALACE_GROUNDS = -3;

/**
 * Plazas that are paved paths and stairs between lawns, not shade-tree squares: render/vegetation.ts plants no plaza trees on them, so
 * the only trees in the Dinh Độc Lập grounds stand on its lawns (the OSM park polygons).
 */
export const PAVED_NO_TREES: Record<number, true> = { [PALACE_GROUNDS]: true };

/**
 * Open ground that OSM leaves as unmapped gaps between its polygons; without a polygon the procedural infill packs houses
 * into it. Ids are synthetic (negative, below `NGUYEN_HUE_PROMENADE`).
 */
const EXTRA_PLAZAS: Plaza[] = [
  // Bưu điện forecourt: the paved strip between Công xã Paris' east pavement and the lawn (OSM park 801950747) in front of the
  // Central Post Office; OSM has no polygon there and a 7-storey tube house was being planted in it.
  { osm: -2, name: 'Sân Bưu điện Trung tâm', pts: [-170, -613, -152, -613, -152, -586, -170, -586], holes: [] },
  // Dinh Độc Lập compound (135 Nam Kỳ Khởi Nghĩa, https://en.wikipedia.org/wiki/Independence_Palace): fenced grounds with only
  // the palace and 1-2 storey annexes. Bounded by the centrelines of Nguyễn Thị Minh Khai / Nam Kỳ Khởi Nghĩa (NE side), Nguyễn Du
  // (SE), Huyền Trân Công Chúa (SW) and the bbox edge (W). OSM maps only the lawns, so the paths between them were filled with
  // houses and mid-rises.
  { osm: PALACE_GROUNDS, name: 'Khuôn viên Dinh Độc Lập', pts: [-766, -444, -659, -560, -331, -253, -532, -33, -766, -232], holes: [] },
];

/** Scene land use with the overrides applied: active building sites and every open paved area. */
export interface Ground {
  sites: Site[];
  plazas: Plaza[];
}

const cache = new WeakMap<SceneJson, Ground>();

export function resolveGround(scene: SceneJson): Ground {
  const hit = cache.get(scene);
  if (hit) return hit;
  const sites: Site[] = [];
  const plazas: Plaza[] = [
    ...scene.plazas,
    { osm: NGUYEN_HUE_PROMENADE, name: 'Phố đi bộ Nguyễn Huệ', pts: [...NGUYEN_HUE_A, ...reversed(NGUYEN_HUE_B)], holes: [] },
    ...EXTRA_PLAZAS,
  ];
  for (const s of scene.sites) {
    if (INACTIVE_SITES[s.osm] !== undefined) plazas.push({ osm: s.osm, name: s.name, pts: s.pts, holes: s.holes });
    else sites.push(s);
  }
  const ground = { sites, plazas };
  cache.set(scene, ground);
  return ground;
}

/** Shape of an unfinished frame: podium storeys and the towers rising from it. */
export interface FrameShape {
  /** Storeys of the podium slabs. */
  storeys: number;
  /** Lift-core levels above the podium, one entry per tower. */
  towers: number[];
  /** Half side (m) of the floor plates poured around each core. */
  plate: number;
}

/**
 * building=construction footprints that get a hand-set frame. The One Central Saigon / Tứ giác Bến Thành site (OSM 165518960,
 * footprint 1154697174; OSM tags only `building=construction`): the concrete podium is 10 floors (Coteccons "building the 10 podium floors",
 * 14/10/2019, https://futuresoutheastasia.com/one-central-saigon; the finished design is 7 above-ground retail levels, 6 basements,
 * https://vir.com.vn/masterise-group-launches-one-central-saigon-152635.html) under the two towers of 48 and 55 floors (218 / 240 m,
 * https://vi.wikipedia.org/wiki/One_Central_Saigon). Work restarted in Jan-Mar 2026, completion in ~30 months
 * (https://vnexpress.net/sieu-du-an-tai-khu-dat-vang-tu-giac-ben-thanh-tai-khoi-dong-5051022.html), so the site is an active frame, not a
 * dead one. The stub heights of the two towers (`towers`) are NOT sourced: no article gives how high the cores stood before the stall.
 */
export const FRAME_SHAPES: Record<number, FrameShape> = {
  1154697174: { storeys: 10, towers: [26, 20], plate: 14 },
};
