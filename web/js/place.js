// Descripción legible de un punto, calculada en el navegador: estado (punto en polígono sobre el
// contorno de los estados) y localidad más cercana de data/localidades_mx.json (GeoNames, CC BY 4.0).
// Es una referencia aproximada, no una dirección postal. Nada sale del dispositivo.
import { haversineKm, NEAR_KM } from './nearby.js';
import { pointInRings } from './smoke.js';

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Estado cuyo polígono contiene el punto ({ id, name }), o null si cae fuera de México o en el mar.
export function stateAt(point, geo) {
  for (const f of geo?.features ?? []) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polygons.some(rings => pointInRings(point.lon, point.lat, rings))) return f.properties;
  }
  return null;
}

// Distancia (km) del punto al estado más cercano: 0 si cae dentro de alguno. Se mide a cada tramo
// del contorno en un plano local, suficiente para decidir si el punto queda dentro de la cobertura.
export function kmToMexico(point, geo) {
  if (stateAt(point, geo)) return 0;
  const ky = 111.195, kx = ky * Math.cos(point.lat * Math.PI / 180);
  let best = Infinity;
  for (const f of geo?.features ?? []) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polygons) for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - point.lon) * kx, ay = (ring[i - 1][1] - point.lat) * ky, dx = (ring[i][0] - point.lon) * kx - ax, dy = (ring[i][1] - point.lat) * ky - ay;
      const len = dx * dx + dy * dy, s = len ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + s * dx, ay + s * dy));
    }
  }
  return best;
}
// La captura solo trae detecciones dentro de los 32 estados: un punto cuenta como cubierto si cae en
// un estado o tan cerca que su radio de búsqueda todavía toca México (costa, islas pegadas, frontera).
export const COVER_KM = NEAR_KM;
export function coversPoint(point, geo) { return kmToMexico(point, geo) <= COVER_KM; }

// Rumbo de `from` hacia `to` en ocho direcciones (rumbo inicial sobre la esfera).
export function compass(from, to) {
  const r = Math.PI / 180, lat1 = from.lat * r, lat2 = to.lat * r, dLon = (to.lon - from.lon) * r;
  const deg = Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)) / r;
  return DIRS[Math.round(((deg + 360) % 360) / 45) % 8];
}

// Radio (km) dentro del cual se nombra una localidad: el mismo de la búsqueda de detecciones.
export const PLACE_KM = NEAR_KM;

// Prepara data/localidades_mx.json para buscar: nombres, lat y lon paralelos (milésimas de grado, lat
// en diferencias) ordenados por estado, con `cuenta` localidades por cada clave de `estados`.
// Devuelve null si el archivo no tiene esa forma.
export function decodePlaces(raw) {
  const { estados, cuenta, nombres, lat, lon } = raw ?? {};
  if (![estados, cuenta, nombres, lat, lon].every(Array.isArray) || estados.length !== cuenta.length || nombres.length !== lat.length || lat.length !== lon.length) return null;
  const lats = new Int32Array(lat.length), starts = [];
  let sum = 0, at = 0;
  for (let i = 0; i < lat.length; i++) { sum += lat[i]; lats[i] = sum; }
  for (const count of cuenta) { starts.push(at); at += count; }
  if (at !== nombres.length) return null;
  return { names: nombres, lat: lats, lon: Int32Array.from(lon), states: estados, starts };
}

// Localidad listada más cercana a PLACE_KM o menos: { name, stateId, km, dir }, o null si no hay
// ninguna tan cerca o no hay localidades. Cada una es el punto de referencia de la localidad en
// GeoNames, no sus límites. `dir` es hacia dónde queda el punto visto desde la localidad. Recorre
// todas, pero solo mide la distancia de las que caen en el recuadro de PLACE_KM alrededor del punto.
export function nearestPlace(point, places) {
  if (!places) return null;
  const { lat, lon } = places, pLat = point.lat * 1000, pLon = point.lon * 1000;
  const dLat = PLACE_KM / 111.195 * 1000 + 1, dLon = dLat / Math.cos(point.lat * Math.PI / 180) + 1;
  let best = -1, bestKm = Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (Math.abs(lat[i] - pLat) > dLat || Math.abs(lon[i] - pLon) > dLon) continue;
    const km = haversineKm(point.lat, point.lon, lat[i] / 1000, lon[i] / 1000);
    if (km < bestKm) { bestKm = km; best = i; }
  }
  if (best < 0 || bestKm > PLACE_KM) return null;
  let s = places.starts.length - 1;
  while (places.starts[s] > best) s--;
  return { name: places.names[best], stateId: places.states[s], km: bestKm, dir: compass({ lat: lat[best] / 1000, lon: lon[best] / 1000 }, point) };
}

// Qué decir del punto: { kind: 'in' | 'near', place, km, dir } con la localidad listada más cercana si
// queda a PLACE_KM o menos, y el estado de ESA localidad ('in' solo a menos de 200 m de su punto de
// referencia). Si no hay ninguna tan cerca no se nombra una más lejana: { kind: 'far' } con el estado
// del punto, o { kind: 'state' } si las localidades no han cargado. Null si tampoco hay estado.
export function describePoint(point, geo, places) {
  const near = nearestPlace(point, places);
  const state = near ? geo.features.find(f => f.properties.id === near.stateId)?.properties : null;
  if (state) return { kind: near.km < 0.2 ? 'in' : 'near', place: near.name, stateId: state.id, stateName: state.name, km: near.km, dir: near.dir };
  const own = stateAt(point, geo);
  return own ? { kind: places ? 'far' : 'state', stateId: own.id, stateName: own.name } : null;
}
