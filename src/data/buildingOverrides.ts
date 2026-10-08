/**
 * Curated per-building corrections, keyed by OSM way/relation id and applied by render/buildings.ts before the
 * height / colour heuristics run. OSM either lacks height tags for these landmarks or tags a sub-part wrongly, so the
 * heuristics (tube-house floor guesses, 80-floor cap) put them at the wrong size.
 *
 * Fields:
 *  - height: metres to the roof (wins over levels)
 *  - levels: storeys; height = levels × 3.4 m when `height` is absent
 *  - kind: replaces the OSM kind (e.g. 'roof' = low canopy without windows or shop fronts)
 *  - wall: wall colour (0xRRGGBB)
 *  - glass: draw curtain-wall glazing bands instead of punched windows
 *  - windows: false = plain solid body (monuments, canopies)
 *  - roof: 'pitched' forces a gable on the footprint's oriented box; 'flat' forbids it
 *  - tile: gable tile colour for pitched roofs
 *
 * Sources: Wikipedia infobox values unless the entry says otherwise; "[mem]" = from memory, not verified online.
 */
export interface BuildingOverride {
  height?: number;
  levels?: number;
  kind?: string;
  wall?: number;
  glass?: boolean;
  windows?: boolean;
  roof?: 'pitched' | 'flat';
  tile?: number;
  /** Not drawn: a hand-built prop in render/landmarks.ts replaces it. */
  hidden?: true;
}

export const BUILDING_OVERRIDES: Record<number, BuildingOverride> = {
  // Sunwah Tower, 115 Nguyễn Huệ: 92 m roof, 21 floors (https://en.wikipedia.org/wiki/Sunwah_Tower); OSM tags black granite, levels 2.
  1316463702: { height: 92, levels: 21, wall: 0x2b3238, glass: true },

  // Saigon Centre (https://en.wikipedia.org/wiki/Saigon_Centre, floor count Tower 1: 25, Tower 2: 43): Tower 1 106 m, Tower 2 193.7 m.
  802125676: { height: 106, levels: 25 },
  802125674: { height: 193.7, levels: 43 },
  // Saigon Centre / Takashimaya retail podium (65 Lê Lợi): the Phase 2 mall is seven storeys (Keppel, 2016
  // https://www.keppel.com/realestate/vn/en/Media-Releases/Keppel-Land-opens-Saigon-Centre-retail-mall-anchored-by-Takashimaya-in-Ho-Chi-Minh-City),
  // 7 retail floors ≈ 30 m.
  802125677: { height: 30 },

  // Caravelle Saigon, 19-23 Lam Sơn: 1959 wing 10 fl + 1998 tower 24 fl (https://en.wikipedia.org/wiki/Caravelle_Hotel); one OSM footprint → tower height.
  39598465: { height: 85, levels: 24 },
  // Rex Hotel, 141 Nguyễn Huệ: 6 floors (https://en.wikipedia.org/wiki/Rex_Hotel), cream-white.
  39598474: { height: 21, levels: 6, wall: 0xf0e6cc },
  // Hotel Continental Saigon, 132-134 Đồng Khởi: G+3 = 4 floors, cream colonial (https://en.wikipedia.org/wiki/Hotel_Continental_Saigon).
  2204742: { height: 16, levels: 4, wall: 0xf1e2b8 },
  // Park Hyatt Saigon, 2 Lam Sơn: nine-storey French colonial building (https://www.lightfoottravel.com/asia/vietnam/ho-chi-minh-city/accommodation/park-hyatt-saigon), cream.
  287478465: { levels: 9, wall: 0xeadfc4 },
  // Sheraton Saigon Hotel & Towers (Grand Opera), 88 Đồng Khởi: towers of 22 and 25 floors (https://khachsan.chudu24.com/ks.679.khach-san-sheraton-saigon.html,
  // 25 floors on https://sheraton-saigon-hotel-ho-chi-minh-city.hotelmix.vn/; rooftop bar on floor 23 per https://dantri.com.vn/kinh-doanh/sheraton-saigon-ra-mat-tang-23-diem-nhan-la-bar-tang-thuong-cao-nhat-dong-khoi-20260722175523792.htm).
  // One OSM footprint covers both towers, so the taller one (25 floors, 3.4 m each) sets the height.
  165491081: { height: 85, levels: 25 },

  // Vincom Center Đồng Khởi (https://en.wikipedia.org/wiki/Vincom_Center_%C4%90%E1%BB%93ng_Kh%E1%BB%9Fi): towers 115 m / 28 fl on a 6-7 floor podium.
  1217481835: { height: 28 },
  1217481833: { height: 115, levels: 28 },

  // Bảo tàng TP.HCM (Dinh Gia Long), 65 Lý Tự Trọng: 2 tall colonial floors, cream, tile roof [mem].
  802105071: { height: 13, kind: 'civic', wall: 0xf0e2bf, roof: 'pitched' },
  // Bảo tàng Hồ Chí Minh / Nhà Rồng: OSM building:levels=2, building:colour=#EBC3A7, roof:colour=#E69151.
  808022726: { height: 8, levels: 2, kind: 'civic', wall: 0xebc3a7, roof: 'pitched', tile: 0xe69151 },

  // Hồ Chí Minh statue on Nguyễn Huệ: OSM `building=yes` 4 m² footprint, historic=memorial; stone figure, not a house.
  695895031: { height: 3.5, kind: 'monument', wall: 0xc4bfb2, windows: false, roof: 'flat' },
  // Ben Thanh metro lotus skylight: replaced by the hand-built lotus prop in render/landmarks.ts at the same spot, so the OSM cylinder is not drawn.
  1060129521: { hidden: true },
  // 10 m box at (598,-87) = plinth of the Trần Hưng Đạo statue in Công trường Mê Linh; now a hand prop in render/landmarks.ts.
  1047597846: { hidden: true },
  // 13.7 m² untagged `building=yes` at (-165,-547), between the cathedral façade and the Our Lady lawn (park 801950764): a booth or
  // kiosk, not a house — the area<150 heuristic made it a 3-5 storey needle. Drawn as a 3 m kiosk.
  803279636: { height: 3, kind: 'roof', windows: false, roof: 'flat' },
  // 2 m round untagged `building=yes` at (-153,-523) on the Our Lady lawn: the statue pedestal. The cathedral model in render/landmarks.ts
  // carries its own Our Lady statue on the same lawn, so the footprint was drawn as a second, 3-5 storey windowed column beside it.
  801950760: { hidden: true },
};
