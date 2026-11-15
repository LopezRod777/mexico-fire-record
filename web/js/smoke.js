// Capa de humo de NOAA HMS: plumas locales que analistas de NOAA trazan sobre imágenes diurnas de
// GOES. La captura ya deja fuera las áreas extensas de bruma regional y dice cuántas fueron.
// No son perímetros de incendio ni prueba de fuego en un punto, y no se suman a ningún conteo.
// La capa se dibuja una sola vez por render (nada por cuadro) y nunca se anima.
import { geometryToPath } from './geo.js';
import { number } from './format.js';
import { t, formatDate, formatDay } from './i18n.js';

const NS = 'http:' + '//www.w3.org/2000/svg';
export const SMOKE_DENSITIES = ['Light', 'Medium', 'Heavy'];
const stampOk = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) && Number.isFinite(Date.parse(v));
const ringOk = ring => Array.isArray(ring) && ring.length >= 4 && ring.every(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

// Campo opcional `humo` de la captura. Si falta o no cumple, se ignora y "Hoy" sigue igual.
export function validSmoke(h) {
  if (!h || typeof h !== 'object' || h.fuente !== 'NOAA_HMS_SMOKE' || !Number.isInteger(h.n) || !Array.isArray(h.poligonos) || h.poligonos.length !== h.n) return false;
  if (!(h.ultima_utc === null && h.n === 0) && !stampOk(h.ultima_utc)) return false;
  return h.poligonos.every(p => p && typeof p === 'object' && stampOk(p.inicio) && stampOk(p.fin) && Date.parse(p.inicio) < Date.parse(p.fin) && SMOKE_DENSITIES.includes(p.densidad) && Array.isArray(p.anillos) && p.anillos.length > 0 && p.anillos.every(ringOk));
}

// Punto en polígono por paridad sobre todos los anillos: un hueco resta y una isla suma.
export function pointInRings(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}

// Trazo de humo más reciente que cubre el punto, o null. Null no significa "sin humo": de noche
// y con nubes no se traza, así que quien llama no dice nada en ese caso.
export function smokeAt(point, humo) {
  if (!point || !validSmoke(humo)) return null;
  let best = null;
  for (const p of humo.poligonos) {
    if (!pointInRings(point.lon, point.lat, p.anillos)) continue;
    if (!best || p.fin > best.fin || (p.fin === best.fin && p.inicio > best.inicio)) best = p;
  }
  return best && { from: best.inicio.slice(11, 16), to: best.fin.slice(11, 16), date: best.inicio.slice(0, 10), densidad: best.densidad };
}

// Áreas extensas de bruma que la captura dejó fuera (0 si la captura no lo dice).
export function omittedCount(humo) { return Number.isInteger(humo?.n_regionales_omitidas) && humo.n_regionales_omitidas > 0 ? humo.n_regionales_omitidas : 0; }
// Umbral de área (km²) por encima del cual un trazo es bruma regional y no se dibuja.
export function regionalLimit(humo) { return Number.isFinite(humo?.umbral_regional_km2) ? humo.umbral_regional_km2 : 50000; }

function svgNode(tag, attrs) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }
function node(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
const densityClass = d => `smoke-${d.toLowerCase()}`;

// Un <path> por área, de la más ligera a la más densa para que la densa quede encima.
export function smokeLayer(humo) {
  const layer = svgNode('g', { class: 'live-smoke-layer', 'aria-hidden': 'true' });
  const order = humo.poligonos.slice().sort((a, b) => SMOKE_DENSITIES.indexOf(a.densidad) - SMOKE_DENSITIES.indexOf(b.densidad));
  for (const p of order) layer.append(svgNode('path', { class: `live-smoke ${densityClass(p.densidad)}`, d: geometryToPath({ type: 'Polygon', coordinates: p.anillos }) }));
  return layer;
}

// El estado del botón sobrevive al redibujo por cambio de idioma.
const state = { off: false };

// Pone la capa bajo las llamas (justo después del contorno de los estados) y su botón en los
// controles. Devuelve los renglones de leyenda para que live.js los agregue.
export function attachSmoke({ humo, svg, controls, capture, legendRow }) {
  const out = { legend: [] };
  if (humo.n) {
    const layer = smokeLayer(humo);
    svg.append(layer);
    const toggle = node('button', 'live-smoke-toggle', t('live.smokeToggle')); toggle.type = 'button';
    const show = on => { layer.setAttribute('display', on ? 'inline' : 'none'); toggle.setAttribute('aria-pressed', String(on)); };
    show(!state.off);
    toggle.addEventListener('click', () => { state.off = !state.off; show(!state.off); });
    controls.append(toggle);
    out.legend.push(legendRow(t('live.legendSmoke'), SMOKE_DENSITIES.map(d => {
      const icon = svgNode('svg', { viewBox: '0 0 22 14', width: 22, height: 14, 'aria-hidden': 'true' });
      icon.append(svgNode('rect', { x: 1, y: 1, width: 20, height: 12, rx: 3, class: `legend-smoke ${densityClass(d)}` }));
      return [icon, t(`live.smoke${d}`)];
    })));
  }
  const note = node('p', 'live-legend-note live-smoke-note');
  const left = omittedCount(humo), omitted = left ? t(left === 1 ? 'live.smokeOmittedOne' : 'live.smokeOmitted', { n: number(left) }) : '';
  const count = humo.n === 0 ? t('live.smokeNone', { omitted }) : t(humo.n === 1 ? 'live.smokeOne' : 'live.smokeMany', { n: number(humo.n), time: humo.ultima_utc.slice(11, 16), date: formatDay(humo.ultima_utc.slice(0, 10)), omitted });
  note.append(node('strong', '', t('live.smokeLead')), ' ', count, ' ', t('live.smokeCapture', { capture: formatDate(capture) }));
  out.legend.push(note);
  return out;
}
