import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ageHours, formatUtc, isStale, levelBadge, livePointRadius, flameHeight, liveSummary, rankingComparison, validLiveSnapshot, validModis, validGoes } from '../js/live.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const names = read('../data/series_monthly.json').region_names;
const stateIds = Object.keys(names).filter(id => id !== 'MX');
const fixture = read('fixtures/live_snapshot.sample.json');

test('ageHours e isStale: borde de seis horas', () => {
  const generated = '2026-11-14T12:00:00Z';
  assert.equal(ageHours(generated, '2026-11-14T18:00:00Z'), 6);
  assert.equal(isStale(generated, '2026-11-14T18:00:00Z'), false);
  assert.equal(isStale(generated, '2026-11-14T18:00:01Z'), true);
  assert.equal(ageHours(generated, '2026-11-14T11:00:00Z'), 0);
});
test('formatUtc: conserva el día UTC cerca de medianoche, sin depender de la zona local', () => {
  assert.equal(formatUtc('2026-11-14T22:50:00Z'), '14 nov 2026, 22:50 UTC');
  assert.equal(formatUtc('2026-11-15T00:10:00Z'), '15 nov 2026, 00:10 UTC');
});
test('insignias: símbolo y texto de los cinco niveles y null', () => {
  for (const [level, expected] of Object.entries({ bajo:'▼ bajo', normal:'● normal', alto:'▲ alto', extraordinario:'▲▲ extraordinario', record:'★ récord de detecciones' })) assert.equal(levelBadge(level), expected);
  assert.equal(levelBadge(null), 'Sin nivel');
});
test('liveSummary: ranking, niveles, límite y nombres del catálogo', () => {
  const result = liveSummary(fixture, names, '2026-11-15T05:50:50Z');
  assert.equal(result.ageHours, 7);
  assert.equal(result.stale, true);
  assert.equal(result.nDetecciones, fixture.n_detecciones_24h);
  assert.deepEqual(result.nacional, fixture.nacional);
  assert.equal(result.ranking.length, 8);
  assert.ok(result.ranking.every(row => ['alto','extraordinario','record'].includes(row.nivel) && row.name === names[row.id]));
  assert.ok(result.ranking.every((row,i) => i === 0 || result.ranking[i-1].ratio >= row.ratio));
  assert.equal(result.ranking[0].id, stateIds[0]);
  assert.equal(result.ranking.at(-1).id, stateIds[7]);
});
test('fila del ranking presenta p90 en texto', () => {
  assert.equal(rankingComparison({ celdas_dia: 25, base_p50: 12, base_p90: 20 }), '25 celdas-día vs. mediana 12 (p90: 20)');
});
test('radio de puntos: mínimo efectivo de 3 px en móvil y escritorio', () => {
  const mobile = livePointRadius(390), desktop = livePointRadius(1200);
  assert.ok(mobile * 390 / 700 >= 3);
  assert.ok(desktop * 1200 / 700 >= 3);
  assert.equal(livePointRadius(1200), 2.5);
});
function checkContract(snapshot) {
  assert.ok(validLiveSnapshot(snapshot, stateIds));
  // Campos base obligatorios; modis, goes y fuentes_extra_error son opcionales (capturas viejas no los traen).
  const optional = ['modis','goes','fuentes_extra_error'];
  assert.deepEqual(Object.keys(snapshot).filter(k => !optional.includes(k)).sort(), ['generado','ultima_deteccion_utc','ventana_horas','dia_comparado','doy','fuentes','nota','descartadas_fuera_de_mexico','n_detecciones_24h','nacional','estados','detecciones'].sort());
  if (snapshot.modis != null) assert.ok(validModis(snapshot.modis, stateIds), 'modis');
  if (snapshot.goes != null) assert.ok(validGoes(snapshot.goes), 'goes');
  const regionKeys = ['n20','n21','celdas_dia','sensores_usados','base_p10','base_p50','base_p90','base_p99','base_max','nivel'];
  assert.deepEqual(Object.keys(snapshot.nacional).sort(), regionKeys.sort());
  for (const id of stateIds) assert.deepEqual(Object.keys(snapshot.estados[id]).sort(), regionKeys);
  for (const d of snapshot.detecciones) assert.deepEqual(Object.keys(d).sort(), ['lat','lon','fecha','hora_utc','sat','frp','conf','estado'].sort());
}
test('fixture cumple el contrato completo', () => checkContract(fixture));
const real = new URL('../data/live_snapshot.json', import.meta.url);
test('snapshot real cumple el mismo contrato', { skip: existsSync(real) ? false : 'Todavía no existe web/data/live_snapshot.json' }, () => checkContract(read('../data/live_snapshot.json')));

test('escala de llama: null, monotonía y tope',()=>{assert.equal(flameHeight(null),10);assert.equal(flameHeight(0),10);assert.equal(flameHeight(15),28);assert.equal(flameHeight(150),28);const samples=[0,1,3,5,10,15,50].map(flameHeight);assert.ok(samples.every((v,i)=>i===0||v>=samples[i-1]));});
