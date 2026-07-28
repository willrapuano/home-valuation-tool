import { LatLng } from "./types";

const EARTH_RADIUS_MILES = 3958.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole months between two dates, floored at 0. */
export function monthsBetween(from: string | Date, to: string | Date): number {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return NaN;
  const months =
    (b.getFullYear() - a.getFullYear()) * 12 +
    (b.getMonth() - a.getMonth()) +
    (b.getDate() >= a.getDate() ? 0 : -1);
  return Math.max(0, months);
}
