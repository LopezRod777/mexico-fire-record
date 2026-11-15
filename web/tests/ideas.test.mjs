import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readJpegGps, EXIF_READ_BYTES } from '../js/exif.js';
import { haversineKm, nearbyDetections, fireVerdict, comparePoints, clusterSummary, worldviewUrl, mapUrl, zoomBox, snapshotWindow, EARTH_KM, focusView, pickBox } from '../js/nearby.js';
import { tleEpochMs, predictPasses, firstPass, satrecFrom, distanceKm, nextCoverage, CENTER_MX } from '../js/passes.js';
import { VIEW, project, unproject } from '../js/geo.js';
import { detectionTime, clusterDetections } from '../js/replay.js';
import { photoNoteKey } from '../js/fire.js';
import { dictionaries } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const tleFixture = read('fixtures/tle.sample.json');
const snapshot = read('../data/live_snapshot.json');
const tleReal = read('../data/tle.json');

// ---------- Lector EXIF con un JPEG de fixture armado aquí mismo ----------
function jpeg({ le = true, latRef = 'N', lat = [19, 25, 5736], lonRef = 'W', lon = [99, 7, 5952], gps = true, zeroDen = false, gpsOffset = 26 } = {}) {
  const tiff = new DataView(new ArrayBuffer(128));
  const u16 = (o, v) => tiff.setUint16(o, v, le), u32 = (o, v) => tiff.setUint32(o, v, le);
  tiff.setUint8(0, le ? 0x49 : 0x4D); tiff.setUint8(1, le ? 0x49 : 0x4D); u16(2, 42); u32(4, 8);
  u16(8, 1); u16(10, gps ? 0x8825 : 0x010F); u16(12, 4); u32(14, 1); u32(18, gpsOffset); u32(22, 0);
  u16(26, 4);
  const entry = (i, tag, type, count, value) => { const o = 28 + i * 12; u16(o, tag); u16(o + 2, type); u32(o + 4, count); if (type === 2) { tiff.setUint8(o + 8, value.charCodeAt(0)); tiff.setUint8(o + 9, 0); } else u32(o + 8, value); };
  entry(0, 1, 2, 2, latRef); entry(1, 2, 5, 3, 80); entry(2, 3, 2, 2, lonRef); entry(3, 4, 5, 3, 104);
  const rationals = (at, [d, m, s100]) => { u32(at, d); u32(at + 4, 1); u32(at + 8, m); u32(at + 12, 1); u32(at + 16, s100); u32(at + 20, zeroDen ? 0 : 100); };
  rationals(80, lat); rationals(104, lon);
  const tiffBytes = new Uint8Array(tiff.buffer);
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const len = 2 + 6 + tiffBytes.length;
  const app1 = [0xFF, 0xE1, len >> 8, len & 0xFF, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiffBytes];
  return new Uint8Array([0xFF, 0xD8, ...app0, ...app1, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).buffer;
}
const LAT = 19 + 25 / 60 + 57.36 / 3600, LON = 99 + 7 / 60 + 59.52 / 3600;

test('EXIF: JPEG válido con GPS en ambas endianidades y los cuatro hemisferios', () => {
  let r = readJpegGps(jpeg());
  assert.equal(r.status, 'ok'); assert.ok(Math.abs(r.lat - LAT) < 1e-9); assert.ok(Math.abs(r.lon + LON) < 1e-9);
  r = readJpegGps(jpeg({ le: false, latRef: 'S', lonRef: 'E' }));
  assert.equal(r.status, 'ok'); assert.ok(Math.abs(r.lat + LAT) < 1e-9); assert.ok(Math.abs(r.lon - LON) < 1e-9);
  r = readJpegGps(new Uint8Array(jpeg({ le: false })));
  assert.equal(r.status, 'ok'); assert.ok(r.lat > 0 && r.lon < 0);
});
test('EXIF: sin GPS, sin EXIF, no JPEG, vacío', () => {
  assert.deepEqual(readJpegGps(jpeg({ gps: false })), { status: 'no-gps' });
  assert.deepEqual(readJpegGps(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).buffer), { status: 'no-exif' });
  assert.deepEqual(readJpegGps(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]).buffer), { status: 'not-jpeg' });
  assert.deepEqual(readJpegGps(new ArrayBuffer(0)), { status: 'not-jpeg' });
});
test('EXIF: truncado, desplazamiento fuera de rango, denominador cero y hemisferio inválido', () => {
  const full = new Uint8Array(jpeg());
  for (const cut of [30, 60, 100, full.length - 40]) assert.equal(readJpegGps(full.slice(0, cut).buffer).status, 'malformed', `corte ${cut}`);
  assert.equal(readJpegGps(jpeg({ gpsOffset: 5000 })).status, 'malformed');
  assert.equal(readJpegGps(jpeg({ gpsOffset: 0xFFFFFFF0 })).status, 'malformed');
  assert.equal(readJpegGps(jpeg({ zeroDen: true })).status, 'malformed');
  assert.equal(readJpegGps(jpeg({ latRef: 'X' })).status, 'malformed');
  assert.equal(readJpegGps(jpeg({ lat: [95, 0, 0] })).status, 'malformed');
  assert.ok(EXIF_READ_BYTES <= 256 * 1024);
});
test('foto: el flujo la lee solo como ArrayBuffer local y con tope de bytes', () => {
  const fire = readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8');
  assert.match(fire, /file\.slice\(0, EXIF_READ_BYTES\)\.arrayBuffer\(\)/);
  assert.match(fire, /file\.size > PHOTO_MAX_BYTES/);
  assert.doesNotMatch(fire, /createObjectURL|FileReader|FormData|fetch\(|sendBeacon|XMLHttpRequest/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /blob:/);
});

// ---------- Distancia y criterio de 5 km ----------
test('haversine: un grado de latitud, simetría y cero', () => {
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 2 * Math.PI * EARTH_KM / 360) < 1e-9);
  assert.equal(haversineKm(19.4, -99.1, 19.4, -99.1), 0);
  assert.ok(Math.abs(haversineKm(19.43, -99.13, 20.67, -103.35) - haversineKm(20.67, -103.35, 19.43, -99.13)) < 1e-9);
  const cdmxGdl = haversineKm(19.4326, -99.1332, 20.6597, -103.3496);
  assert.ok(cdmxGdl > 455 && cdmxGdl < 465, String(cdmxGdl));
});
const kmLat = km => km / (2 * Math.PI * EARTH_KM / 360);
function fixtureSnapshot() {
  const base = { lat: 18, lon: -95, sat: 'N21', frp: 3, conf: 'n', estado: 'MX-VER' };
  return { generado: '2026-11-15T04:48:11Z', ventana_horas: 24, detecciones: [
    { ...base, lat: 18 + kmLat(4.9), fecha: '2026-11-14', hora_utc: '19:42' },
    { ...base, lat: 18 + kmLat(5.1), fecha: '2026-11-14', hora_utc: '19:43' },
    { ...base, lat: 18 - kmLat(1), fecha: '2026-11-14', hora_utc: '04:30', sat: 'N20' },
    { ...base, lat: 18 + kmLat(2.3), fecha: '2026-11-14', hora_utc: '07:10', sat: 'N20', frp: null }
  ] };
}
test('5 km: incluye 4.9 km, excluye 5.1 km y lo que cae fuera de la ventana de la captura', () => {
  const snap = fixtureSnapshot(), point = { lat: 18, lon: -95 };
  const win = snapshotWindow(snap);
  assert.equal(win.to - win.from, 24 * 3600000);
  assert.equal(new Date(win.from).toISOString(), '2026-11-14T04:48:11.000Z');
  const r = nearbyDetections(point, snap);
  assert.deepEqual(r.matches.map(m => m.d.hora_utc), ['07:10', '19:42']);
  assert.ok(Math.abs(r.matches[0].km - 2.3) < 1e-6);
  const now = Date.parse(snap.generado) + 3600000;
  assert.equal(fireVerdict(point, snap, now).kind, 'near');
  assert.equal(fireVerdict({ lat: 25, lon: -105 }, snap, now).kind, 'none');
  assert.equal(fireVerdict(point, snap, Date.parse(snap.generado) + 6 * 3600000).kind, 'near');
  assert.equal(fireVerdict(point, snap, Date.parse(snap.generado) + 6 * 3600000 + 1000).kind, 'stale');
});
test('foto contra teléfono: más de 1 km pide elegir', () => {
  const phone = { lat: 18, lon: -95 };
  assert.equal(comparePoints(phone, { lat: 18 + kmLat(0.9), lon: -95 }).conflict, false);
  assert.equal(comparePoints(phone, { lat: 18 + kmLat(1.1), lon: -95 }).conflict, true);
  assert.equal(comparePoints(phone, null).conflict, false);
});
test('llama: resumen con coordenadas de cada detección, última por hora y FRP máximo', () => {
  const s = clusterSummary(fixtureSnapshot().detecciones);
  assert.equal(s.n, 4); assert.equal(s.last.hora_utc, '19:43'); assert.equal(s.frpMax, 3);
  assert.equal(clusterSummary([{ ...fixtureSnapshot().detecciones[3] }]).frpMax, null);
  assert.equal(s.night, false);
  assert.equal(clusterSummary([{ ...fixtureSnapshot().detecciones[2] }]).night, true);
});
test('nuevo / sigue activo: no se muestra porque la captura trae una sola ventana de 24 h', () => {
  const win = snapshotWindow(snapshot);
  assert.ok(snapshot.detecciones.every(d => detectionTime(d) >= win.from && detectionTime(d) <= win.to));
  for (const lang of ['es', 'en']) for (const value of Object.values(dictionaries[lang])) assert.doesNotMatch(value, /sigue activ|still active|\bnuev[oa]\b/i);
});

// ---------- Enlaces ----------
test('Worldview: bbox ±1°, capas del satélite de la detección y fecha y hora UTC', () => {
  const d = { lat: 17.75293, lon: -92.91293, fecha: '2026-11-14', hora_utc: '19:42', sat: 'N21' };
  const H = 'https:' + '//';
  assert.equal(worldviewUrl(d), H + 'worldview.earthdata.nasa.gov/?v=-93.9129,16.7529,-91.9129,18.7529&l=VIIRS_NOAA21_Thermal_Anomalies_375m_All,VIIRS_NOAA21_AOD_Dark_Target_Land_Ocean(hidden),VIIRS_NOAA21_CorrectedReflectance_TrueColor&t=2026-11-14-T19%3A42%3A00Z');
  assert.match(worldviewUrl({ ...d, sat: 'N20' }), /l=VIIRS_NOAA20_Thermal_Anomalies_375m_All,VIIRS_NOAA20_AOD_Dark_Target_Land_Ocean\(hidden\),VIIRS_NOAA20_CorrectedReflectance_TrueColor&/);
  assert.equal(mapUrl(19.4326, -99.1332), H + 'www.openstreetmap.org/?mlat=19.43260&mlon=-99.13320#map=15/19.43260/-99.13320');
});

// ---------- Zoom y mapa ----------
test('zoom: caja con la proporción del mapa, dentro del mapa y con zoom máximo 8', () => {
  for (const pts of [[{ x: 300, y: 200 }], [{ x: 2, y: 3 }, { x: 10, y: 6 }], [{ x: 0, y: 0 }, { x: 700, y: 440 }]]) {
    const b = zoomBox(pts, VIEW);
    assert.ok(Math.abs(b.h / b.w - VIEW.height / VIEW.width) < 1e-9);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= VIEW.width + 1e-9 && b.y + b.h <= VIEW.height + 1e-9);
    assert.ok(b.w >= VIEW.width / 8 - 1e-9);
    for (const p of pts) assert.ok(p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
  }
});
test('unproject invierte project', () => {
  for (const [lon, lat] of [[-99.13, 19.43], [-117, 32.5], [-87, 21]]) { const [x, y] = project(lon, lat), [a, b] = unproject(x, y); assert.ok(Math.abs(a - lon) < 1e-9 && Math.abs(b - lat) < 1e-9); }
});

// ---------- Predicción de paso ----------
test('TLE: época leída del campo de la línea 1', () => {
  assert.equal(new Date(tleEpochMs(tleFixture.satelites[0].tle1)).toISOString(), '2026-11-14T21:52:21.872Z');
  assert.ok(Number.isNaN(tleEpochMs('basura')));
});
// Referencia independiente: Python sgp4 2.24 (Satrec.twoline2rv), GMST IAU-82, mismo umbral de
// 1500 km, cruce por bisección a 0.5 s y máxima cercanía con barrido de 1 s. Ver el informe.
const PY = {
  'NOAA-20|centro': ['2026-11-15T08:41:30.937Z', '2026-11-15T08:45:12.937Z'], 'NOAA-21|centro': ['2026-11-15T07:45:30.937Z', '2026-11-15T07:48:08.937Z'],
  'NOAA-20|tabasco': ['2026-11-15T07:04:14.531Z', '2026-11-15T07:06:08.531Z'], 'NOAA-21|tabasco': ['2026-11-15T07:45:32.812Z', '2026-11-15T07:49:16.812Z'],
  'NOAA-20|baja': ['2026-11-15T08:41:37.031Z', '2026-11-15T08:43:48.031Z'], 'NOAA-21|baja': ['2026-11-15T09:23:18.281Z', '2026-11-15T09:27:02.281Z']
};
test('paso: TLE fija y hora fija dan un resultado estable y a menos de 0.05 min de Python sgp4', () => {
  const at = Date.parse('2026-11-15T05:00:00Z');
  const points = { centro: CENTER_MX, tabasco: { lat: 17.75, lon: -92.91 }, baja: { lat: 31.0, lon: -115.5 } };
  for (const [name, point] of Object.entries(points)) {
    const a = predictPasses(tleFixture, point, at), b = predictPasses(tleFixture, point, at);
    assert.deepEqual(a, b);
    for (const p of a) {
      assert.equal(p.ok, true);
      const [enter, closest] = PY[`${p.name}|${name}`].map(Date.parse);
      assert.ok(Math.abs(p.enter - enter) / 60000 < 0.05, `${p.name} ${name} entrada ${new Date(p.enter).toISOString()}`);
      assert.ok(Math.abs(p.closest - closest) / 60000 < 0.05, `${p.name} ${name} cercanía ${new Date(p.closest).toISOString()}`);
      assert.ok(p.enter <= p.closest);
    }
  }
  assert.equal(firstPass(predictPasses(tleFixture, CENTER_MX, at)).name, 'NOAA-21');
});
test('paso: TLE de más de 3 días o inválida se omite con su motivo', () => {
  const epoch = tleEpochMs(tleFixture.satelites[0].tle1);
  const old = predictPasses(tleFixture, CENTER_MX, epoch + 3.2 * 86400000);
  assert.ok(old.every(p => !p.ok && p.reason === 'stale' && p.ageDays > 3));
  const broken = predictPasses({ satelites: [{ nombre: 'X', tle1: '', tle2: '' }] }, CENTER_MX, epoch);
  assert.deepEqual(broken.map(p => [p.ok, p.reason]), [[false, 'failed']]);
  assert.equal(firstPass(old), null);
});
test('paso: validación contra detecciones reales (cada satélite dentro de su barrido a la hora observada)', { skip: (() => { const e = tleEpochMs(tleReal.satelites[0].tle1); return Math.abs(Date.parse(snapshot.generado) - e) > 3 * 86400000 ? 'TLE y captura con más de 3 días de diferencia' : false; })() }, () => {
  const recs = Object.fromEntries(tleReal.satelites.map(s => [s.norad === 43013 ? 'N20' : 'N21', satrecFrom(s)]));
  let inside = 0; const diffs = [];
  for (const d of snapshot.detecciones) {
    const t = detectionTime(d), p = { lat: d.lat, lon: d.lon };
    let min = Infinity; for (let s = 0; s <= 60; s += 5) min = Math.min(min, distanceKm(recs[d.sat], p, t + s * 1000));
    if (min <= 1500) inside++;
    const pass = nextCoverage(recs[d.sat], p, t - 30 * 60000, { horizonMin: 60 });
    if (pass) diffs.push(Math.abs(t - pass.closest) / 60000);
  }
  diffs.sort((a, b) => a - b);
  assert.ok(inside / snapshot.detecciones.length >= 0.95, `${inside} de ${snapshot.detecciones.length}`);
  assert.ok(diffs[diffs.length >> 1] <= 3, `mediana ${diffs[diffs.length >> 1]} min`);
});

// ---------- Redacción ----------
test('textos nuevos: ES y EN, sin "confirmado", sin punto y coma ni dos puntos', () => {
  const keys = Object.keys(dictionaries.es).filter(k => /^(focus|fire|orbit|time)\./.test(k));
  assert.ok(keys.length > 60);
  for (const lang of ['es', 'en']) for (const k of keys) {
    const v = dictionaries[lang][k];
    assert.doesNotMatch(v, /confirm|también lo vio|also saw/i, `${lang} ${k}`);
    assert.doesNotMatch(v, /;|:(?!\/\/)/, `${lang} ${k}`);
  }
  assert.match(dictionaries.es['fire.conafor'], /800 737 0000.*2022/);
  assert.equal(dictionaries.es['focus.worldview'], 'Explorar imágenes, calor y aerosoles de ese día');
  assert.equal(dictionaries.es['fire.passTitle'], 'Próxima cobertura aproximada del barrido');
});

// ---------- Corrección 1 ----------
test('foto sin ubicación: si no queda otra ubicación, el aviso pide elegir el punto', () => {
  for (const key of ['fire.photoNoGps', 'fire.photoBad', 'fire.photoNotJpeg']) {
    assert.equal(photoNoteKey(key, false), key);
    const alone = photoNoteKey(key, true);
    assert.notEqual(alone, key);
    for (const lang of ['es', 'en']) {
      assert.match(dictionaries[lang][key], /otra ubicación|other location/);
      assert.doesNotMatch(dictionaries[lang][alone], /otra ubicación|other location/);
      assert.match(dictionaries[lang][alone], /mapa|map/);
    }
  }
  for (const key of ['fire.photoOk', 'fire.photoTooBig']) assert.equal(photoNoteKey(key, true), key);
});
test('foto sin ubicación: el flujo borra el resultado anterior cuando no queda punto', () => {
  const fire = readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8');
  assert.match(fire, /if \(point\) \{[^\n]*render\(point, reveal\); return; \}\n(?:\s*\/\/[^\n]*\n)?\s*result\.replaceChildren\(\); again\.hidden = true; mapApi\.showPoint\(null\);/);
});
test('resultado: el reporte (911) va antes de la cobertura del satélite', () => {
  const fire = readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8');
  // Los dos renglones tienen que existir (indexOf da -1 si no) y el reporte ir primero.
  const report = fire.indexOf('out.push(report.wrap);'), passes = fire.indexOf('if (tle) out.push(passList(tle, point, now));');
  assert.ok(report > 0 && passes > 0, `reporte ${report}, pases ${passes}`);
  assert.ok(report < passes);
  assert.match(fire, /scrollIntoView\(\{ block: 'start', behavior: matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth' \}\)/);
});
test('cabecera de órbita: habla del barrido que cubre el centro, no de pasar encima', () => {
  for (const key of ['orbit.nextCenter', 'orbit.nowCenter']) {
    assert.match(dictionaries.es[key], /barrido/);
    assert.match(dictionaries.en[key], /swath/);
    assert.doesNotMatch(dictionaries.es[key], /pasa sobre|pasando ahora sobre/);
    assert.doesNotMatch(dictionaries.en[key], /pass over|passing over/);
  }
});
test('elegir en el mapa: el primer toque acerca a ±1° de longitud, dentro del mapa', () => {
  for (const [lon, lat] of [[-100.9, 21.3], [-117.5, 32.4], [-87, 15]]) {
    const [x, y] = project(lon, lat), b = pickBox(x, y, VIEW);
    const twoDeg = project(lon + 1, lat)[0] - project(lon - 1, lat)[0];
    assert.ok(Math.abs(b.w - twoDeg) < 1e-9);
    assert.ok(Math.abs(b.h / b.w - VIEW.height / VIEW.width) < 1e-9);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= VIEW.width + 1e-9 && b.y + b.h <= VIEW.height + 1e-9);
    assert.ok(x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    assert.ok(VIEW.width / b.w > 12, String(VIEW.width / b.w));
  }
});
test('llama grande: al acercar se vuelve a agrupar y el panel la llama zona', () => {
  const k = 700 / 358, line = Array.from({ length: 21 }, (_, i) => ({ x: 300 + 5 * i, y: 200, frp: 1 }));
  assert.equal(clusterDetections(line, k).length, 1);
  const v = focusView(line, k, VIEW);
  assert.ok(Math.abs(v.box.w / VIEW.width - v.scale) < 1e-12 && v.scale < 1);
  assert.ok(clusterDetections(line, k * v.scale).length > 1);
  assert.equal(v.zone, true);
  assert.equal(focusView([{ x: 300, y: 200, frp: 1 }], k, VIEW).zone, false);
});
