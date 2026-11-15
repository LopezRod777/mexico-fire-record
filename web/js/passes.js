// Próxima cobertura aproximada del barrido de VIIRS sobre un punto, con las TLE de tle.json y
// satellite.js 7.1.0 (copia local en vendor/, sin WASM). Un punto cuenta como cubierto si su
// distancia al punto subsatelital es ≤ 1500 km (la mitad de un barrido de unos 3000 km).
import { twoline2satrec } from '../vendor/satellite.js-7.1.0/io.js';
import { propagate } from '../vendor/satellite.js-7.1.0/propagation/propagate.js';
import { gstime } from '../vendor/satellite.js-7.1.0/propagation/gstime.js';
import { eciToGeodetic } from '../vendor/satellite.js-7.1.0/transforms.js';
import { haversineKm } from './nearby.js';

export const SWATH_HALF_KM = 1500;
export const TLE_MAX_AGE_DAYS = 3;
export const CENTER_MX = { lat: 23.63, lon: -102.55 };
const MIN = 60000;

// Época de la TLE leída del campo de la línea 1 (columnas 19–32: año de 2 cifras y día del año).
export function tleEpochMs(tle1) {
  const yy = Number(tle1.slice(18, 20)), doy = Number(tle1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(doy) || doy < 1 || doy >= 367) return NaN;
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (doy - 1) * 86400000;
}

export function satrecFrom(sat) {
  try { const rec = twoline2satrec(sat.tle1, sat.tle2); return rec && !rec.error ? rec : null; } catch { return null; }
}
export function subpoint(rec, time) {
  let pv;
  try { pv = propagate(rec, new Date(time)); } catch { return null; }
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const g = eciToGeodetic(pv.position, gstime(new Date(time)));
  const lat = g.latitude * 180 / Math.PI, lon = g.longitude * 180 / Math.PI;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
export function distanceKm(rec, point, time) {
  const s = subpoint(rec, time);
  return s ? haversineKm(point.lat, point.lon, s.lat, s.lon) : NaN;
}

// Siguiente entrada al barrido después de `from`: muestreo minuto a minuto, cruce del umbral
// refinado por bisección (1 s) y hora de máxima cercanía refinada por sección áurea.
export function nextCoverage(rec, point, from, { horizonMin = 36 * 60, thresholdKm = SWATH_HALF_KM } = {}) {
  const d = time => distanceKm(rec, point, time);
  let prevT = from, prev = d(from);
  if (!Number.isFinite(prev)) return null;
  let enter = prev <= thresholdKm ? from : null, inNow = enter != null;
  for (let i = 1; i <= horizonMin && enter == null; i++) {
    const time = from + i * MIN, cur = d(time);
    if (!Number.isFinite(cur)) return null;
    if (cur <= thresholdKm) {
      let lo = prevT, hi = time;
      while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (d(mid) <= thresholdKm) hi = mid; else lo = mid; }
      enter = hi;
    }
    prevT = time; prev = cur;
  }
  if (enter == null) return null;
  let bestT = enter, best = d(enter);
  for (let time = enter + MIN; time <= enter + 20 * MIN; time += MIN) { const cur = d(time); if (!(cur < best)) break; bestT = time; best = cur; }
  let lo = bestT - MIN, hi = bestT + MIN;
  const g = (Math.sqrt(5) - 1) / 2;
  while (hi - lo > 1000) { const a = hi - g * (hi - lo), b = lo + g * (hi - lo); if (d(a) < d(b)) hi = b; else lo = a; }
  const closest = Math.round((lo + hi) / 2);
  return { enter: Math.round(enter), closest: Math.max(closest, Math.round(enter)), closestKm: d(closest), inNow };
}

// Para cada satélite de tle.json: hora de entrada y de máxima cercanía, u omisión con motivo
// si la época de su TLE se aleja más de 3 días de la hora del cálculo o la propagación falla.
export function predictPasses(tle, point, now) {
  return (tle?.satelites ?? []).map(sat => {
    const epoch = tleEpochMs(sat.tle1 ?? ''), ageDays = Math.abs(now - epoch) / 86400000;
    const base = { name: sat.nombre, norad: sat.norad, epoch, ageDays };
    if (!Number.isFinite(epoch)) return { ...base, ok: false, reason: 'failed' };
    if (ageDays > TLE_MAX_AGE_DAYS) return { ...base, ok: false, reason: 'stale' };
    const rec = satrecFrom(sat), pass = rec ? nextCoverage(rec, point, now) : null;
    return pass ? { ...base, ok: true, ...pass } : { ...base, ok: false, reason: 'failed' };
  });
}
export function firstPass(predictions) {
  return predictions.filter(p => p.ok).sort((a, b) => a.closest - b.closest)[0] ?? null;
}
