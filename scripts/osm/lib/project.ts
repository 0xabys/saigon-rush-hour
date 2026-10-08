/** Equirectangular projection around the bbox centre (WGS84 degree lengths at φ0). x east, z south, metres. */
import { BBOX } from '../fetch';
import type { LatLon, P2 } from './types';

export const LAT0 = 10.7745;
export const LON0 = 106.701;

const phi = (LAT0 * Math.PI) / 180;
/** Metres per degree of longitude / latitude at φ0. */
export const KX = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
export const KZ = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);

export function project(p: LatLon): P2 {
  return { x: (p.lon - LON0) * KX, z: -(p.lat - LAT0) * KZ };
}

const [south, west, north, east] = BBOX;
export const BOUNDS = {
  minX: (west - LON0) * KX,
  maxX: (east - LON0) * KX,
  minZ: -(north - LAT0) * KZ,
  maxZ: -(south - LAT0) * KZ,
};

export function insideBounds(p: P2): boolean {
  return p.x >= BOUNDS.minX && p.x <= BOUNDS.maxX && p.z >= BOUNDS.minZ && p.z <= BOUNDS.maxZ;
}
