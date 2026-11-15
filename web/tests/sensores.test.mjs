import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validModis, validGoes, validLiveSnapshot } from '../js/live.js';
import { nearestGoes, haversineKm } from '../js/nearby.js';
import { dictionaries, setLanguage, t } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const snapshot = read('../data/live_snapshot.json');
const fixture = read('fixtures/live_snapshot.sample.json');
const names = read('../data/series_monthly.json').region_names;
const stateIds = Object.keys(names).filter(id => id !== 'MX');
const kmLat = km => km / 111.195;

test('MODIS real: contrato y cifra que muestra la página', { skip: snapshot.modis ? false : 'la captura no trae MODIS' }, () => {
  assert.ok(validModis(snapshot.modis, stateIds));
  const m = snapshot.modis;
  assert.equal(m.detecciones.length, m.n_24h);
  assert.equal(m.detecciones.filter(d => d.sat === 'Terra').length, m.terra);
  assert.equal(m.detecciones.filter(d => d.sat === 'Aqua').length, m.aqua);
  const to = Date.parse(snapshot.generado), from = to - 24 * 3600000;
  assert.ok(m.detecciones.every(d => { const x = Date.parse(`${d.fecha}T${d.hora_utc}:00Z`); return x > from && x <= to; }));
});
test('MODIS: rechaza sumas, satélites o estados que no cuadran', () => {
  const base = { fuente: 'MODIS_NRT', ventana_horas: 24, n_24h: 1, terra: 1, aqua: 0, ultima_utc: '2026-11-15T10:00:00Z', detecciones: [{ lat: 19, lon: -99, fecha: '2026-11-15', hora_utc: '10:00', sat: 'Terra', frp: 3.2, conf: 70, estado: stateIds[0] }] };
  assert.ok(validModis(base, stateIds));
  assert.equal(validModis({ ...base, aqua: 1 }, stateIds), false);
  assert.equal(validModis({ ...base, detecciones: [{ ...base.detecciones[0], sat: 'N20' }] }, stateIds), false);
  assert.equal(validModis({ ...base, detecciones: [{ ...base.detecciones[0], estado: 'OUT' }] }, stateIds), false);
  assert.ok(validModis({ ...base, n_24h: 0, terra: 0, ultima_utc: null, detecciones: [] }, stateIds));
  assert.equal(validModis(null, stateIds), false);
});
test('GOES: contrato, celdas únicas y suma de filas', { skip: snapshot.goes ? false : 'la captura no trae GOES' }, () => {
  const g = snapshot.goes;
  assert.ok(validGoes(g));
  assert.equal(g.ventana_horas, 3);
  assert.equal(g.puntos.reduce((a, p) => a + p.n, 0), g.filas_ventana);
  assert.equal(Object.values(g.por_satelite).reduce((a, b) => a + b, 0), g.filas_ventana);
  const cells = new Set(g.puntos.map(p => `${Math.floor(p.lat / g.celda_grados)}|${Math.floor(p.lon / g.celda_grados)}`));
  assert.equal(cells.size, g.puntos.length);
  const latest = g.puntos.map(p => `${p.fecha}T${p.hora_utc}:00Z`).sort().at(-1);
  assert.equal(latest ? latest : null, g.ultima_utc);
});
test('captura sin campos nuevos sigue siendo válida (compatibilidad)', () => {
  assert.equal('modis' in fixture || 'goes' in fixture, false);
  assert.ok(validLiveSnapshot(fixture, stateIds));
  assert.ok(validLiveSnapshot(snapshot, stateIds));
});
test('nearestGoes: radio de 5 km, la más cercana, nulo sin GOES', () => {
  const goes = { puntos: [{ lat: 19 + kmLat(3), lon: -99, fecha: '2026-11-15', hora_utc: '13:20', n: 2, sats: ['G19'] }, { lat: 19 + kmLat(4.5), lon: -99, fecha: '2026-11-15', hora_utc: '13:30', n: 1, sats: ['G18'] }, { lat: 19 + kmLat(5.2), lon: -99, fecha: '2026-11-15', hora_utc: '13:40', n: 1, sats: ['G19FRP'] }] };
  const hit = nearestGoes({ lat: 19, lon: -99 }, goes);
  assert.equal(hit.g.hora_utc, '13:20');
  assert.ok(Math.abs(hit.km - 3) < 0.01);
  assert.equal(nearestGoes({ lat: 19 - kmLat(5.1), lon: -99 }, { puntos: [goes.puntos[0]] }), null);
  assert.equal(nearestGoes({ lat: 19, lon: -99 }, null), null);
  assert.ok(haversineKm(19, -99, goes.puntos[2].lat, -99) > 5);
});
test('textos de GOES y MODIS: ES/EN, sin "confirmado" y con la hora de la captura', () => {
  const keys = ['live.compareModisReal', 'live.modisReal', 'live.modisRealNote', 'live.goesToggle', 'live.legendGoes', 'live.goesLegendItem', 'live.goesLead', 'live.goesLatest', 'live.goesNone', 'live.goesCapture', 'live.methodModis', 'live.methodGoes', 'fire.goesNear'];
  for (const lang of ['es', 'en']) for (const key of keys) {
    assert.ok(dictionaries[lang][key], `${lang} ${key}`);
    assert.doesNotMatch(dictionaries[lang][key], /confirm/i, `${lang} ${key}`);
  }
  for (const lang of ['es', 'en']) assert.match(dictionaries[lang]['live.goesCapture'], /\{capture\}/);
  setLanguage('en');
  assert.equal(t('live.modisReal', { n: '49', terra: '22', aqua: '27', total: '518' }), 'MODIS (Terra and Aqua) recorded 49 detections in Mexico in the same 24 h, 22 from Terra and 27 from Aqua, while VIIRS recorded 518.');
  assert.equal(t('live.goesLead'), 'Latest from geostationary GOES (every 10 min):');
  setLanguage('es');
});
test('GOES en el mapa: sin animar transform y sin capturar toques (regla Safari)', () => {
  const live = readFileSync(new URL('../js/live.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(live, /goesLayer\.animate|live-goes[^']*'[^)]*transform/);
  assert.match(css, /\.live-goes\{[^}]*pointer-events:none/);
  assert.doesNotMatch(css.match(/\.live-goes\{[^}]*\}/)[0], /animation|transform/);
});
