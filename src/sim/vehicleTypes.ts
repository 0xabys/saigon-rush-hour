import { rand01 } from '../core/rng';

export const enum VType {
  Moto = 0,
  Grab = 1,
  Car = 2,
  TaxiVinasun = 3,
  TaxiMaiLinh = 4,
  Bus = 5,
  Truck = 6,
  Cyclo = 7,
  /** Ride-hailing car (Xanh SM / Grab Car / Be Car). */
  RideCar = 8,
}

export const VTYPE_COUNT = 9;

export interface VehicleSpec {
  label: string;
  length: number;
  width: number;
  /** Free-flow desired speed (m/s). */
  speed: number;
  accel: number;
  brake: number;
  /** IDM jam distance and time headway. */
  s0: number;
  headway: number;
  /** Free lateral movement (swarming) instead of lane keeping. */
  swarm: boolean;
  /** Spawn weight in the base mix. */
  weight: number;
  /** Shift of the drivers' average aggressiveness (bus and app-bike drivers push harder, cyclo pedallers don't). */
  temper: number;
}

export const SPECS: VehicleSpec[] = [
  { label: 'Xe máy', length: 1.9, width: 0.75, speed: 10.5, accel: 3.4, brake: 4.5, s0: 0.55, headway: 0.65, swarm: true, weight: 0.42, temper: 0 },
  { label: 'Xe ôm công nghệ', length: 1.9, width: 0.8, speed: 10, accel: 3.2, brake: 4.5, s0: 0.6, headway: 0.7, swarm: true, weight: 0.06, temper: 0.08 },
  { label: 'Ô tô', length: 4.4, width: 1.8, speed: 11.5, accel: 2.2, brake: 3.5, s0: 1.0, headway: 0.8, swarm: false, weight: 0.65, temper: -0.05 },
  { label: 'Taxi Vinasun', length: 4.5, width: 1.8, speed: 11.5, accel: 2.3, brake: 3.5, s0: 1.0, headway: 0.8, swarm: false, weight: 0.08, temper: 0.03 },
  { label: 'Taxi Mai Linh', length: 4.5, width: 1.8, speed: 11.5, accel: 2.3, brake: 3.5, s0: 1.0, headway: 0.8, swarm: false, weight: 0.07, temper: 0.03 },
  { label: 'Xe buýt', length: 10.5, width: 2.5, speed: 9, accel: 1.2, brake: 2.8, s0: 2.4, headway: 1.6, swarm: false, weight: 0.03, temper: 0.1 },
  { label: 'Xe tải giao hàng', length: 6.2, width: 2.1, speed: 9.5, accel: 1.5, brake: 3, s0: 2.2, headway: 1.5, swarm: false, weight: 0.045, temper: 0 },
  { label: 'Xích lô', length: 2.6, width: 1.05, speed: 3.6, accel: 0.8, brake: 2.5, s0: 0.7, headway: 1, swarm: true, weight: 0.03, temper: -0.25 },
  { label: 'Ô tô công nghệ', length: 4.3, width: 1.8, speed: 11.5, accel: 2.2, brake: 3.5, s0: 1.0, headway: 0.8, swarm: false, weight: 0, temper: 0.02 },
];

/**
 * Spawn weights for the OSM map (`Network.routeByDest`), indexed by `VType` (moto, grab bike, car, taxiV, taxiML, bus, truck, cyclo, ride-hailing car; Σ = 1).
 * Fleet source, latest 2025 data for HCMC (post-merger):
 *   - stock 2025-08: ≈ 1.4 M cars, ≈ 11.3 M motorcycles under management (Sở Xây dựng via Lao Động,
 *     https://laodong.vn/xa-hoi/tphcm-tang-len-gan-113-trieu-xe-may-trinh-de-an-kiem-soat-khi-thai-trong-thang-8-1550695.ldo);
 *   - new registrations 15/12/2024–14/12/2025 (Cục CSGT via VietnamNet 2025-12-26,
 *     https://vietnamnet.vn/tphcm-dan-dau-ca-nuoc-ve-dang-ky-moi-o-to-xe-may-trong-nam-2025-2476299.html): 102,354 cars, 290,570 motorbikes.
 *   Rolling the August stock forward by the Aug–Dec share of 2025 registrations gives an end-2025 fleet of ≈ 1.44 M cars / 11.41 M
 *   motorcycles → cars ≈ 11.2 % of motor vehicles (new-car share of 2025 registrations is 26 %, so it keeps rising).
 * No on-road count for District 1 is published, so the totals use that fleet ratio for cars plus taxis (Vinasun/Mai Linh) 3.5 %:
 * cars + taxis + ride-hailing cars 14.7 %, two-wheelers (moto + ride-hailing bikes) 80.5 %, bus/truck/cyclo 4.8 % (density share).
 * The ride-hailing split inside those totals is an ASSUMPTION, not a published count (nobody counts it on the road in D1): per field
 * observation most cars on D1 streets are ride-hailing (Xanh SM VinFast EVs, Grab Car, Be Car) and many motorbikes are ride-hailing bikes
 * (Grab/Be/Xanh SM Bike), so ≈ 30 % of two-wheelers (0.24 / 0.805) and ≈ 45 % of cars (0.065 / 0.147) are ride-hailing; private cars 7 %.
 * `Traffic.chooseType` steers the spawn odds so the on-map shares converge on these weights regardless of dwell time.
 * The legacy map keeps `VehicleSpec.weight` (a car-heavy 58 % mix, no ride-hailing cars).
 */
export const OSM_MIX_WEIGHTS: readonly number[] = [0.565, 0.24, 0.07, 0.007, 0.005, 0.006, 0.022, 0.02, 0.065];

/** Ride-hailing brands, indexed by `hailBrand`. `paint`/`rain` = jacket/livery colour dry and in a poncho. */
export const HAIL_BRANDS = [
  { bike: 'Grab Bike', car: 'Grab Car', paint: 0x00a651, rain: 0x2fbf6a },
  { bike: 'Be Bike', car: 'Be Car', paint: 0xf7c61b, rain: 0xffdf55 },
  { bike: 'Xanh SM Bike', car: 'Xanh SM', paint: 0x16b8c4, rain: 0x4fd6e0 },
] as const;

/** Brand mix by vehicle (cumulative draw on `rand01(uid, 17)`): bikes Grab-led, cars Xanh SM-led (VinFast EV fleet). */
const BIKE_BRAND_SHARE = [0.5, 0.3, 0.2] as const;
const CAR_BRAND_SHARE = [0.25, 0.15, 0.6] as const;

/** Deterministic ride-hailing brand (index into `HAIL_BRANDS`) of the vehicle with this uid. */
export function hailBrand(uid: number, type: VType): number {
  const share = type === VType.RideCar ? CAR_BRAND_SHARE : BIKE_BRAND_SHARE;
  const u = rand01(uid, 17);
  let acc = 0;
  for (let k = 0; k < share.length - 1; k++) {
    acc += share[k];
    if (u < acc) return k;
  }
  return share.length - 1;
}

/** Grouping used by the KPI mix chart. */
export const MIX_GROUPS = [
  { label: 'Xe máy', color: '#d9412b', types: [VType.Moto] },
  { label: 'Xe ôm công nghệ', color: '#2e9e5b', types: [VType.Grab] },
  { label: 'Ô tô', color: '#e9a23b', types: [VType.Car] },
  { label: 'Ô tô công nghệ', color: '#16b8c4', types: [VType.RideCar] },
  { label: 'Taxi', color: '#c7c27a', types: [VType.TaxiVinasun, VType.TaxiMaiLinh] },
  { label: 'Xe buýt', color: '#3f8f8a', types: [VType.Bus] },
  { label: 'Xe tải', color: '#7a5a3a', types: [VType.Truck] },
  { label: 'Xích lô', color: '#b98b5e', types: [VType.Cyclo] },
] as const;

export const SHIRT_COLORS = [0xf4f1e8, 0x9cc3e0, 0x2f3d5c, 0xc8463a, 0xd9a43b, 0xe8a3b5, 0x6f7d4a, 0x8c8c86, 0x2b2b2b, 0xf0d9a8, 0x4d8c8a, 0xb7553b];
export const PONCHO_COLORS = [0x3d7fd6, 0xf2c230, 0xe86a92, 0x5cb85c, 0xf08a3c, 0xdfe7ea, 0x8ad1e6];
export const BIKE_COLORS = [0xc0392b, 0xf2efe6, 0x26282c, 0x2f5fa8, 0xb7bcc2, 0xe0b23a, 0xd9708f, 0x2f8c84, 0x8a2c24];
export const CAR_COLORS = [0xeeeeea, 0xb2b6bb, 0x2a2c30, 0xb8322a, 0x2c4a7a, 0xcbb89a, 0x6d7278, 0xe6e1d3];
export const TRUCK_CAB = [0x3a6fb0, 0xeeeeea, 0x2f7d58];
export const TRUCK_BOX = [0xf1ece0, 0xe98a2e, 0x6b8aa6, 0xd8c08c];
export const CYCLO_HOOD = [0xc8463a, 0x2f6b9a, 0x3f7d4f, 0xd9a43b];

export const BIKE_MODELS = ['Honda Wave Alpha', 'Honda Vision', 'Yamaha Sirius', 'Honda Air Blade', 'Honda SH', 'Yamaha Exciter', 'Vespa Primavera', 'Honda Dream', 'VinFast Evo'];
export const CAR_MODELS = ['Toyota Vios', 'Kia Morning', 'Hyundai Accent', 'VinFast VF 5', 'Mazda 3', 'Honda City', 'VinFast VF 8'];
/** Xanh SM fleet (all VinFast EVs). */
export const XANH_SM_MODELS = ['VinFast VF e34', 'VinFast VF 5', 'VinFast VF 6', 'VinFast VF 7', 'VinFast VF 3'];
export const BUS_ROUTES = ['Tuyến 01 · Bến Thành – Chợ Lớn', 'Tuyến 03 · Bến Thành – Thạnh Lộc', 'Tuyến 18 · Bến Thành – Chợ Hiệp Thành', 'Tuyến 56 · Chợ Lớn – ĐH GTVT', 'Tuyến 152 · Khu dân cư Trung Sơn – Sân bay'];
export const SURNAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Huỳnh', 'Hoàng', 'Võ', 'Phan', 'Đặng', 'Bùi', 'Đỗ', 'Ngô'];
export const GIVEN = ['Văn Hùng', 'Thị Lan', 'Minh Tuấn', 'Thị Hồng', 'Quốc Bảo', 'Thanh Tâm', 'Hoàng Phúc', 'Ngọc Ánh', 'Đức Thắng', 'Thị Mai', 'Gia Huy', 'Bảo Ngọc', 'Văn Tài', 'Thu Trang'];
