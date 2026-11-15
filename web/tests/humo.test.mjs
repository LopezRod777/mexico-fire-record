import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validSmoke, pointInRings, smokeAt, omittedCount, regionalLimit, SMOKE_DENSITIES } from '../js/smoke.js';
import { validLiveSnapshot } from '../js/live.js';
import { dictionaries, setLanguage, t } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const snapshot = read('../data/live_snapshot.json');
const names = read('../data/series_monthly.json').region_names;
const stateIds = Object.keys(names).filter(id => id !== 'MX');
const box = (w, s, e, n) => [[w, s], [w, n], [e, n], [e, s], [w, s]];
const poly = (anillos, inicio, fin, densidad = 'Light') => ({ inicio, fin, densidad, sat: 'GOES-EAST', anillos });
const humo = poligonos => ({ fuente: 'NOAA_HMS_SMOKE', ventana_horas: 24, n: poligonos.length, ultima_utc: poligonos.map(p => p.fin).sort().at(-1) ?? null, poligonos });

test('punto en polígono: dentro, fuera, hueco, isla y bordes de la caja', () => {
  const square = box(-100, 20, -96, 24), hole = box(-99, 21, -97, 23), island = box(-90, 15, -89, 16);
  assert.equal(pointInRings(-99.5, 20.5, [square]), true);
  assert.equal(pointInRings(-101, 22, [square]), false);
  assert.equal(pointInRings(-98, 25, [square]), false);
  assert.equal(pointInRings(-98, 22, [square]), true);
  assert.equal(pointInRings(-98, 22, [square, hole]), false, 'el hueco resta');
  assert.equal(pointInRings(-99.5, 20.5, [square, hole]), true, 'entre el borde y el hueco');
  assert.equal(pointInRings(-89.5, 15.5, [square, hole, island]), true, 'la isla suma');
  assert.equal(pointInRings(-93, 18, [square, hole, island]), false);
  // Polígono cóncavo (una L): el hueco de la L queda fuera aunque esté dentro de la caja.
  const ele = [[0, 0], [0, 3], [1, 3], [1, 1], [3, 1], [3, 0], [0, 0]];
  assert.equal(pointInRings(0.5, 2.5, [ele]), true);
  assert.equal(pointInRings(2, 2, [ele]), false);
  assert.equal(pointInRings(2.5, 0.5, [ele]), true);
});

test('validSmoke: contrato del campo humo y rechazos', () => {
  const ok = humo([poly([box(-100, 20, -96, 24)], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z')]);
  assert.ok(validSmoke(ok));
  assert.ok(validSmoke(humo([])));
  assert.equal(validSmoke(null), false);
  assert.equal(validSmoke({ ...ok, fuente: 'OTRA' }), false);
  assert.equal(validSmoke({ ...ok, n: 2 }), false);
  assert.equal(validSmoke({ ...ok, ultima_utc: null }), false);
  assert.equal(validSmoke(humo([poly([box(-100, 20, -96, 24)], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z', 'Dense')])), false);
  assert.equal(validSmoke(humo([poly([[[-100, 20], [-99, 21], [-100, 20]]], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z')])), false, 'anillo de menos de 4 puntos');
  assert.equal(validSmoke(humo([poly([], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z')])), false);
  assert.equal(validSmoke(humo([poly([box(-100, 20, -96, 24)], '2026-11-14T16:00:00Z', '2026-11-14T13:00:00Z')])), false, 'fin antes del inicio');
  assert.equal(validSmoke(humo([poly([[[-100, 20], [-99, 'x'], [-98, 20], [-100, 20]]], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z')])), false);
});

test('smokeAt: el trazo más reciente que cubre el punto, o nada', () => {
  const data = humo([
    poly([box(-100, 20, -96, 24)], '2026-11-14T13:00:00Z', '2026-11-14T16:00:00Z'),
    poly([box(-99, 21, -97, 23)], '2026-11-14T20:10:00Z', '2026-11-15T00:00:00Z', 'Medium'),
    poly([box(-110, 28, -109, 29)], '2026-11-14T16:10:00Z', '2026-11-14T18:00:00Z', 'Heavy')]);
  assert.deepEqual(smokeAt({ lat: 22, lon: -98 }, data), { from: '20:10', to: '00:00', date: '2026-11-14', densidad: 'Medium' });
  assert.deepEqual(smokeAt({ lat: 20.5, lon: -99.5 }, data), { from: '13:00', to: '16:00', date: '2026-11-14', densidad: 'Light' });
  assert.equal(smokeAt({ lat: 19, lon: -99 }, data), null);
  assert.equal(smokeAt({ lat: 22, lon: -98 }, null), null);
  assert.equal(smokeAt({ lat: 22, lon: -98 }, { ...data, n: 99 }), null, 'campo inválido: se ignora');
  assert.equal(smokeAt(null, data), null);
});

test('humo real de la captura: contrato, ventana, cifras y un punto dentro de un trazo', { skip: snapshot.humo ? false : 'la captura no trae humo' }, () => {
  const h = snapshot.humo;
  assert.ok(validLiveSnapshot(snapshot, stateIds));
  assert.ok(validSmoke(h));
  assert.equal(h.n, h.poligonos.length);
  assert.equal(Object.values(h.por_densidad).reduce((a, b) => a + b, 0), h.n);
  for (const d of SMOKE_DENSITIES) assert.equal(h.poligonos.filter(p => p.densidad === d).length, h.por_densidad[d]);
  const to = Date.parse(snapshot.generado), from = to - 24 * 3600000;
  assert.ok(h.poligonos.every(p => Date.parse(p.fin) > from && Date.parse(p.inicio) <= to));
  assert.ok(JSON.stringify(h).length < 60000);
  // Solo plumas locales: ninguna pasa del umbral y la captura dice cuántas áreas regionales omitió.
  assert.equal(h.umbral_regional_km2, 50000);
  assert.ok(Number.isInteger(h.n_regionales_omitidas) && h.n_regionales_omitidas >= 0);
  assert.ok(h.poligonos.every(p => Number.isFinite(p.area_km2) && p.area_km2 > 0 && p.area_km2 <= h.umbral_regional_km2));
  assert.equal(omittedCount(h), h.n_regionales_omitidas);
  for (const p of h.poligonos) {
    // El centro de la caja del anillo más chico no siempre cae dentro; un vértice movido hacia el
    // centroide de sus vecinos sí permite comprobar que el trazo se reconoce a sí mismo.
    const ring = p.anillos[0], cx = ring.slice(0, -1).reduce((a, q) => a + q[0], 0) / (ring.length - 1), cy = ring.slice(0, -1).reduce((a, q) => a + q[1], 0) / (ring.length - 1);
    const inside = ring.some(([x, y]) => pointInRings(x + (cx - x) * 0.02, y + (cy - y) * 0.02, p.anillos));
    assert.ok(inside, p.inicio);
  }
});

test('áreas regionales omitidas: cuenta y umbral, con valores por defecto si la captura no los trae', () => {
  assert.equal(omittedCount({ n_regionales_omitidas: 3 }), 3);
  assert.equal(omittedCount({ n_regionales_omitidas: 0 }), 0);
  assert.equal(omittedCount({}), 0);
  assert.equal(omittedCount({ n_regionales_omitidas: -1 }), 0);
  assert.equal(omittedCount(null), 0);
  assert.equal(regionalLimit({ umbral_regional_km2: 50000 }), 50000);
  assert.equal(regionalLimit({}), 50000);
});

test('textos del humo: ES/EN, sin "confirmado", sin "ahora" y con la hora de la captura', () => {
  const keys = ['live.smokeToggle', 'live.legendSmoke', 'live.smokeLight', 'live.smokeMedium', 'live.smokeHeavy', 'live.smokeLead', 'live.smokeMany', 'live.smokeOne', 'live.smokeNone', 'live.smokeOmitted', 'live.smokeOmittedOne', 'live.smokeCapture', 'live.methodSmoke', 'fire.smokeOver', 'fire.smokeNote', 'footerSmoke'];
  for (const lang of ['es', 'en']) for (const key of keys) {
    assert.ok(dictionaries[lang][key], `${lang} ${key}`);
    assert.doesNotMatch(dictionaries[lang][key], /confirm|\bnow\b|\bahora\b|\bright now\b|µg|concentration of|incendio confirmado/i, `${lang} ${key}`);
  }
  for (const lang of ['es', 'en']) assert.match(dictionaries[lang]['live.smokeCapture'], /\{capture\}/);
  setLanguage('en');
  assert.equal(t('fire.smokeOver', { from: '13:00', to: '16:00', date: 'Nov 14, 2026' }), 'NOAA analysts also outlined a smoke plume over this point between 13:00 and 16:00 UTC on Nov 14, 2026.');
  assert.equal(t('fire.smokeNote'), 'The smoke outline shows where smoke was seen from space, not where the fire is.');
  assert.equal(t('live.smokeMany', { n: '8', time: '00:00', date: 'Nov 15, 2026', omitted: t('live.smokeOmitted', { n: '3' }) }), '8 touch Mexico in these 24 h, the latest until 00:00 UTC on Nov 15, 2026, and 3 wide haze areas are left out.');
  assert.equal(t('live.smokeNone', { omitted: '' }), 'none over Mexico in these 24 h yet.');
  setLanguage('es');
  assert.equal(t('fire.smokeOver', { from: '13:00', to: '16:00', date: '14 nov 2026' }), 'Analistas de NOAA también trazaron una pluma de humo sobre este punto entre las 13:00 y las 16:00 UTC del 14 nov 2026.');
  assert.equal(t('live.smokeOne', { time: '18:00', date: '14 nov 2026', omitted: t('live.smokeOmittedOne') }), '1 toca México en estas 24 h, hasta las 18:00 UTC del 14 nov 2026, y se deja fuera 1 área extensa de bruma.');
});

test('capa de humo: se dibuja una vez, sin animación, sin capturar toques y sin entrar al conteo', () => {
  const smoke = readFileSync(new URL('../js/smoke.js', import.meta.url), 'utf8');
  const live = readFileSync(new URL('../js/live.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(smoke, /\.animate\(|requestAnimationFrame|setInterval|setTimeout/);
  // En live.js el humo solo aparece al armar la vista (renderLive), nunca dentro de la reproducción.
  const replayBody = live.slice(live.indexOf('function startReplay('), live.indexOf('function buildCompare('));
  assert.doesNotMatch(replayBody, /smoke|humo/i);
  assert.equal((live.match(/attachSmoke\(/g) ?? []).length, 1);
  const rule = css.match(/\.live-smoke\{[^}]*\}/)[0];
  assert.match(rule, /pointer-events:none/);
  assert.match(rule, /fill-rule:evenodd/);
  assert.doesNotMatch(rule, /animation|transition|transform/);
  assert.doesNotMatch(live, /n_detecciones_24h[^;]*humo|humo[^;]*n_detecciones_24h/);
  // "Vi un fuego": la frase corta queda a la vista (out) y la aclaración dentro de "Más detalles" (details).
  const fire = readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8');
  assert.match(fire, /out\.push\(node\('p', 'fire-smoke', t\('fire\.smokeOver'/);
  assert.match(fire, /details\.push\(node\('p', '', t\('fire\.smokeNote'\)\)\)/);
});
