// Funciones puras de "tocar la llama" y "Vi un fuego": distancias con las coordenadas de cada
// detección (nunca con el centro dibujado de la llama), ventana de la captura y enlaces.
import { detectionTime, dayNight, clusterDetections } from './replay.js';
import { VIEW, project, unproject } from './geo.js';

export const EARTH_KM = 6371.0088;
export const NEAR_KM = 5;
export const PICK_MAX_KM = 1;
const rad = d => d * Math.PI / 180;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ventana exacta de la captura: de generado − ventana_horas a generado.
export function snapshotWindow(snapshot) {
  const to = Date.parse(snapshot.generado);
  return { from: to - (snapshot.ventana_horas ?? 24) * 3600000, to };
}

// Detecciones a ≤ radio km del punto, dentro de la ventana, de la más cercana a la más lejana.
export function nearbyDetections(point, snapshot, radiusKm = NEAR_KM) {
  const win = snapshotWindow(snapshot);
  const matches = snapshot.detecciones
    .map(d => ({ d, km: haversineKm(point.lat, point.lon, d.lat, d.lon), time: detectionTime(d) }))
    .filter(m => m.km <= radiusKm && m.time >= win.from && m.time <= win.to)
    .sort((a, b) => a.km - b.km || a.time - b.time);
  return { ...win, radiusKm, matches };
}

// Veredicto del flujo: sin veredicto satelital si la captura tiene más de 6 h.
export function fireVerdict(point, snapshot, now, maxAgeH = 6) {
  const result = nearbyDetections(point, snapshot);
  const ageH = (now - result.to) / 3600000;
  if (ageH > maxAgeH) return { ...result, kind: 'stale', ageH };
  return { ...result, kind: result.matches.length ? 'near' : 'none', ageH };
}

// Pista extra de GOES: la celda GOES más cercana a ≤ radio km (solo si la captura la trae).
// Es una detección de calor de píxel ~2 km, nunca una confirmación.
export function nearestGoes(point, goes, radiusKm = NEAR_KM) {
  if (!goes || !Array.isArray(goes.puntos)) return null;
  let best = null;
  for (const g of goes.puntos) {
    const km = haversineKm(point.lat, point.lon, g.lat, g.lon);
    if (km <= radiusKm && (!best || km < best.km || (km === best.km && detectionTime(g) > detectionTime(best.g)))) best = { g, km };
  }
  return best;
}

// Foto contra teléfono: si difieren más de 1 km se muestran ambas y se deja elegir.
export function comparePoints(phone, photo, maxKm = PICK_MAX_KM) {
  if (!phone || !photo) return { conflict: false, km: null };
  const km = haversineKm(phone.lat, phone.lon, photo.lat, photo.lon);
  return { conflict: km > maxKm, km };
}

// Resumen de un grupo de llamas: conteo, última detección (satélite y hora) y FRP máximo.
export function clusterSummary(detections) {
  const last = detections.reduce((a, b) => (detectionTime(b) > detectionTime(a) ? b : a));
  const frp = detections.map(d => d.frp).filter(Number.isFinite);
  return { n: detections.length, last, lastTime: detectionTime(last), frpMax: frp.length ? Math.max(...frp) : null, night: dayNight(last) === 'N' };
}

const WV_LAYERS = { N20: 'NOAA20', N21: 'NOAA21' };
// NASA Worldview con bbox ±1°, capas del satélite de la detección y su fecha y hora UTC.
export function worldviewUrl(d, pad = 1) {
  const sat = WV_LAYERS[d.sat] ?? 'NOAA20';
  const r = v => Number(v.toFixed(4));
  const v = [r(d.lon - pad), r(d.lat - pad), r(d.lon + pad), r(d.lat + pad)].join(',');
  const l = `VIIRS_${sat}_Thermal_Anomalies_375m_All,VIIRS_${sat}_CorrectedReflectance_TrueColor`;
  const [hh, mm] = d.hora_utc.split(':');
  return 'https:' + `//worldview.earthdata.nasa.gov/?v=${v}&l=${l}&t=${d.fecha}-T${hh}%3A${mm}%3A00Z`;
}
export function mapUrl(lat, lon) {
  const a = lat.toFixed(5), b = lon.toFixed(5);
  return 'https:' + `//www.openstreetmap.org/?mlat=${a}&mlon=${b}#map=15/${a}/${b}`;
}

// Encuadre del zoom: caja de los puntos con margen, proporción del mapa y zoom máximo.
export function zoomBox(points, view = { width: 700, height: 440 }, maxZoom = 8) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ratio = view.height / view.width;
  const w = Math.min(view.width, Math.max((x1 - x0) * 1.8, (y1 - y0) * 1.8 / ratio, view.width / maxZoom)), h = w * ratio;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return { x: clamp((x0 + x1) / 2 - w / 2, 0, view.width - w), y: clamp((y0 + y1) / 2 - h * 0.55, 0, view.height - h), w, h };
}
// Zoom al tocar una llama: la caja de sus detecciones y si, al volver a agrupar con la escala
// de esa vista, la llama se parte en varias (entonces el panel la llama "zona").
export function focusView(points, k, view = VIEW) {
  const box = zoomBox(points, view), scale = box.w / view.width;
  return { box, scale, zone: clusterDetections(points, k * scale).length > 1 };
}
// Primer toque al elegir el punto: caja de ±halfDeg de longitud alrededor del toque, con la
// proporción del mapa y dentro de él, para que el segundo toque sea preciso.
export function pickBox(x, y, view = VIEW, halfDeg = 1) {
  const [lon, lat] = unproject(x, y, view);
  const w = Math.min(view.width, project(lon + halfDeg, lat, view)[0] - project(lon - halfDeg, lat, view)[0]), h = w * view.height / view.width;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return { x: clamp(x - w / 2, 0, view.width - w), y: clamp(y - h / 2, 0, view.height - h), w, h };
}
