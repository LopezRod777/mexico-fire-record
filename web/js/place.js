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

// Localidad más cercana entre todos los estados: { name, stateId, km, dir }, o null si el archivo
// no cargó o no tiene la forma esperada. Cada fila es [nombre, lat, lon] en milésimas de grado, y es el
// punto de referencia de la localidad en GeoNames, no sus límites. `dir` es hacia dónde queda el punto
// visto desde la localidad.
export function nearestPlace(point, places) {
  const states = places?.estados;
  if (!states || typeof states !== 'object') return null;
  let best = null;
  for (const [stateId, list] of Object.entries(states)) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) continue;
      const lat = row[1] / 1000, lon = row[2] / 1000, km = haversineKm(point.lat, point.lon, lat, lon);
      if (!best || km < best.km) best = { name: row[0], stateId, lat, lon, km };
    }
  }
  return best && { name: best.name, stateId: best.stateId, km: best.km, dir: compass(best, point) };
}

// Qué decir del punto: { kind: 'in' | 'near', place, km, dir } con la localidad listada más cercana si
// queda a PLACE_KM o menos, y el estado de ESA localidad ('in' solo a menos de 200 m de su punto de
// referencia). Si no hay ninguna tan cerca no se nombra una más lejana: { kind: 'far' } con el estado
// del punto, o { kind: 'state' } si el archivo de localidades no cargó. Null si tampoco hay estado.
export function describePoint(point, geo, places) {
  const near = nearestPlace(point, places);
  const state = near && near.km <= PLACE_KM ? geo.features.find(f => f.properties.id === near.stateId)?.properties : null;
  if (state) return { kind: near.km < 0.2 ? 'in' : 'near', place: near.name, stateId: state.id, stateName: state.name, km: near.km, dir: near.dir };
  const own = stateAt(point, geo);
  return own ? { kind: near ? 'far' : 'state', stateId: own.id, stateName: own.name } : null;
}
