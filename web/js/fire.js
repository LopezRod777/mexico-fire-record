// "Vi un fuego": ubicación del teléfono (solo al tocar el botón), foto opcional con GPS leída
// en el navegador, búsqueda de detecciones a ≤ 5 km, próxima cobertura del barrido y mensaje
// para reportar. Nada se envía solo.
import { project, geometryToPath } from './geo.js';
import { t, formatNumber, formatDate, formatDay, formatLocalTime, formatUtcTime } from './i18n.js';
import { readJpegGps, PHOTO_MAX_BYTES, EXIF_READ_BYTES } from './exif.js';
import { fireVerdict, comparePoints, mapUrl, NEAR_KM } from './nearby.js';
import { predictPasses } from './passes.js';
import { ageText } from './live.js';

const NS = 'http:' + '//www.w3.org/2000/svg';
const SAT_NAMES = { N20: 'NOAA-20', N21: 'NOAA-21' };
function node(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
function svgNode(tag, attrs) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }
const coords = p => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
const km = v => formatNumber(v, 1);
const detClock = d => ({ sat: SAT_NAMES[d.sat], time: d.hora_utc, date: formatDay(d.fecha) });

// Estado que sobrevive al cambio de idioma (la sección "Hoy" se vuelve a dibujar).
const state = { open: false, geo: 'idle', phone: null, photo: null, photoMsg: null, manual: null, choice: null };

function miniMap(geo, point, matches) {
  const [px, py] = project(point.lon, point.lat);
  const r5 = Math.abs(project(point.lon, point.lat + NEAR_KM / 111.195)[1] - py);
  const w = r5 * 4.6, h = w * 0.6;
  const svg = svgNode('svg', { viewBox: `${(px - w / 2).toFixed(3)} ${(py - h / 2).toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`, class: 'fire-minimap', role: 'img', 'aria-labelledby': 'fire-mini-title' });
  const title = svgNode('title', { id: 'fire-mini-title' }); title.textContent = t('fire.miniMapTitle');
  svg.append(title);
  geo.features.forEach(f => svg.append(svgNode('path', { d: geometryToPath(f.geometry), class: 'fire-mini-outline' })));
  svg.append(svgNode('circle', { cx: px, cy: py, r: r5, class: 'fire-mini-radius' }));
  for (const m of matches) { const [x, y] = project(m.d.lon, m.d.lat); svg.append(svgNode('circle', { cx: x, cy: y, r: w * 0.018, class: 'fire-mini-det' })); }
  svg.append(svgNode('circle', { cx: px, cy: py, r: w * 0.022, class: 'fire-mini-you' }));
  const label = svgNode('text', { x: px + w * 0.035, y: py - w * 0.03, class: 'fire-mini-label', 'font-size': (w * 0.06).toFixed(3) }); label.textContent = t('fire.you');
  svg.append(label);
  return svg;
}

function passList(tle, point, now) {
  const wrap = node('div', 'fire-passes');
  wrap.append(node('h4', '', t('fire.passTitle')));
  const list = node('ul', 'fire-pass-list');
  for (const p of predictPasses(tle, point, now)) {
    let text;
    if (!p.ok) text = t(p.reason === 'stale' ? 'fire.passStale' : 'fire.passFailed', { sat: p.name, days: formatNumber(p.ageDays, 1) });
    else {
      const v = { sat: p.name, enterLocal: formatLocalTime(p.enter, now), enterUtc: formatUtcTime(p.enter), closestLocal: formatLocalTime(p.closest, now), closestUtc: formatUtcTime(p.closest) };
      text = t(p.inNow ? 'fire.passNow' : 'fire.passRow', v);
    }
    list.append(node('li', '', text));
  }
  wrap.append(list, node('p', 'fire-note', t('fire.passNote')), node('p', 'fire-note', t('fire.tzNote')));
  return wrap;
}

function reportBlock(point, verdict) {
  const wrap = node('div', 'fire-report');
  wrap.append(node('h4', '', t('fire.reportTitle')));
  const call = node('a', 'fire-call', t('fire.call911')); call.href = 'tel:911';
  const conafor = node('a', 'fire-conafor', t('fire.conafor')); conafor.href = 'tel:8007370000';
  const url = mapUrl(point.lat, point.lon);
  let status;
  if (verdict.kind === 'near') { const m = verdict.matches[0]; status = t('fire.msgNear', { km: km(m.km), ...detClock(m.d) }); }
  else status = t(verdict.kind === 'none' ? 'fire.msgNone' : 'fire.msgStale');
  const message = t('fire.msg', { coords: coords(point), url, status });
  const copy = node('button', 'fire-copy', t('fire.copy')); copy.type = 'button';
  const openMap = node('a', 'fire-open-map', t('fire.openMap')); openMap.href = url; openMap.target = '_blank'; openMap.rel = 'noopener noreferrer';
  const actions = node('div', 'fire-share'); actions.append(copy, openMap);
  const share = node('p', 'fire-note fire-share-note', t('fire.shareNote'));
  const label = node('label', 'fire-message-label', t('fire.messageLabel')); label.htmlFor = 'fire-message';
  const text = node('textarea', 'fire-message'); text.id = 'fire-message'; text.readOnly = true; text.rows = 4; text.value = message;
  const copied = node('p', 'fire-note'); copied.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(message); copied.textContent = t('fire.copied'); }
    catch { copied.textContent = t('fire.copyFailed'); text.focus(); text.select(); }
  });
  wrap.append(call, conafor, actions, share, copied, label, text);
  return wrap;
}

export function buildFireBlock({ snapshot, tle, geo, mapApi }) {
  const block = node('div', 'fire');
  block.append(node('h3', 'fire-title', t('fire.title')), node('p', 'fire-intro', t('fire.intro')));
  const start = node('button', 'primary fire-start', t('fire.button')); start.type = 'button';
  const panel = node('div', 'fire-panel'); panel.hidden = true;
  const status = node('p', 'fire-status'); status.setAttribute('role', 'status');
  const photoLabel = node('label', 'fire-photo-label', t('fire.photoLabel')); photoLabel.htmlFor = 'fire-photo';
  const photo = node('input', 'fire-photo'); photo.type = 'file'; photo.id = 'fire-photo'; photo.accept = 'image/jpeg';
  const photoBox = node('div', 'fire-photo-box'); photoBox.append(photo, photoLabel, node('p', 'fire-note', t('fire.photoNote')));
  const photoMsg = node('p', 'fire-note'); photoMsg.setAttribute('role', 'status');
  const choose = node('div', 'fire-choose'); choose.hidden = true;
  const manual = node('form', 'fire-manual'); manual.hidden = true; manual.noValidate = true;
  const fields = [['lat', 'fire.latLabel'], ['lon', 'fire.lonLabel']].map(([id, key]) => { const l = node('label', '', t(key)); l.htmlFor = `fire-${id}`; const input = node('input'); input.id = `fire-${id}`; input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; const f = node('div', 'fire-field'); f.append(l, input); return f; });
  const use = node('button', 'fire-use', t('fire.useCoords')); use.type = 'submit';
  const manualMsg = node('p', 'fire-note'); manualMsg.setAttribute('role', 'alert');
  manual.append(...fields, use, manualMsg);
  const again = node('button', 'secondary fire-again', t('fire.again')); again.type = 'button'; again.hidden = true;
  const result = node('div', 'fire-result'); result.setAttribute('aria-live', 'polite');
  panel.append(status, photoBox, photoMsg, choose, manual, again, result);
  block.append(start, panel);

  function pickOnMap(message) {
    mapApi.startPick(point => { state.manual = { ...point, source: 'map' }; state.choice = 'manual'; decide(); });
    status.textContent = message;
  }
  function render(point) {
    mapApi.showPoint(point);
    const now = Date.now(), verdict = fireVerdict(point, snapshot, now);
    const out = [node('h4', 'fire-result-title', t('fire.resultTitle')), node('p', 'fire-point', t('fire.point', { coords: coords(point), source: t(`fire.source.${point.source}`) }))];
    if (verdict.kind === 'stale') out.push(node('p', 'fire-verdict', t('fire.stale', { age: ageText(verdict.ageH) })));
    else {
      out.push(node('p', 'fire-window', t('fire.window', { km: NEAR_KM, from: formatDate(new Date(verdict.from).toISOString()), to: formatDate(new Date(verdict.to).toISOString()) })));
      if (verdict.kind === 'near') {
        const m = verdict.matches[0], n = verdict.matches.length;
        out.push(node('p', 'fire-verdict', t(n === 1 ? 'fire.nearOne' : 'fire.nearMany', { n, radius: NEAR_KM, km: km(m.km), ...detClock(m.d) })), miniMap(geo, point, verdict.matches), node('p', 'fire-note', t('fire.miniMapDesc')));
      } else out.push(node('p', 'fire-verdict', t('fire.none')), node('p', '', t('fire.noneWhy')));
      out.push(node('p', 'fire-note', t('fire.heatNote')));
    }
    if (tle) out.push(passList(tle, point, now));
    out.push(reportBlock(point, verdict));
    result.replaceChildren(...out);
    again.hidden = false;
  }
  function decide() {
    status.textContent = state.geo === 'asking' ? t('fire.locating') : '';
    photoMsg.textContent = state.photoMsg ?? '';
    const cmp = comparePoints(state.phone, state.photo);
    choose.hidden = true; choose.replaceChildren();
    if (cmp.conflict && !state.choice) {
      choose.append(node('p', '', t('fire.conflict', { km: km(cmp.km) })));
      for (const [key, which, p] of [['fire.usePhone', 'phone', state.phone], ['fire.usePhoto', 'photo', state.photo]]) {
        const b = node('button', 'fire-choice', t(key, { coords: coords(p) })); b.type = 'button';
        b.addEventListener('click', () => { state.choice = which; decide(); });
        choose.append(b);
      }
      choose.hidden = false; result.replaceChildren(); return;
    }
    const point = state.choice === 'manual' ? state.manual
      : state.choice === 'photo' ? { ...state.photo, source: 'photo' }
      : state.phone ? { ...state.phone, source: 'phone' }
      : state.photo ? { ...state.photo, source: 'photo' }
      : state.manual;
    const fallback = state.geo === 'denied' || state.geo === 'unsupported';
    manual.hidden = !fallback;
    if (point) { manualMsg.textContent = ''; mapApi.stopPick(); render(point); return; }
    if (fallback) pickOnMap(t(state.geo === 'denied' ? 'fire.denied' : 'fire.unsupported'));
  }
  function locate() {
    if (!('geolocation' in navigator)) { state.geo = 'unsupported'; decide(); return; }
    state.geo = 'asking'; decide();
    navigator.geolocation.getCurrentPosition(
      pos => { state.geo = 'ok'; state.phone = { lat: pos.coords.latitude, lon: pos.coords.longitude }; decide(); },
      () => { state.geo = 'denied'; decide(); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  start.addEventListener('click', () => { state.open = true; panel.hidden = false; start.hidden = true; locate(); });
  again.addEventListener('click', () => { state.choice = null; state.manual = null; result.replaceChildren(); again.hidden = true; manual.hidden = false; pickOnMap(t('fire.pickHint')); mapApi.scrollToMap(); });
  manual.addEventListener('submit', e => {
    e.preventDefault();
    const lat = Number(fields[0].querySelector('input').value.replace(',', '.')), lon = Number(fields[1].querySelector('input').value.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !fields[0].querySelector('input').value.trim()) { manualMsg.textContent = t('fire.coordsInvalid'); return; }
    state.manual = { lat, lon, source: 'typed' }; state.choice = 'manual'; decide();
  });
  photo.addEventListener('change', async () => {
    const file = photo.files?.[0];
    state.photo = null; state.photoMsg = null; if (state.choice === 'photo') state.choice = null;
    if (file) {
      if (file.size > PHOTO_MAX_BYTES) state.photoMsg = t('fire.photoTooBig', { mb: PHOTO_MAX_BYTES / 1048576 });
      else {
        const gps = readJpegGps(await file.slice(0, EXIF_READ_BYTES).arrayBuffer());
        if (gps.status === 'ok') { state.photo = { lat: gps.lat, lon: gps.lon }; state.photoMsg = t('fire.photoOk', { coords: coords(state.photo) }); }
        else state.photoMsg = t({ 'not-jpeg': 'fire.photoNotJpeg', 'no-exif': 'fire.photoNoGps', 'no-gps': 'fire.photoNoGps' }[gps.status] ?? 'fire.photoBad');
      }
    }
    decide();
  });
  if (state.open) { panel.hidden = false; start.hidden = true; decide(); }
  return block;
}
