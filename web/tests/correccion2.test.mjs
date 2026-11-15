import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportStatus, textRows, sortPasses } from '../js/fire.js';
import { zoomEase } from '../js/live.js';
import { fireVerdict } from '../js/nearby.js';
import { setLanguage } from '../js/i18n.js';

const snapshot = JSON.parse(readFileSync(new URL('../data/live_snapshot.json', import.meta.url)));

test('mensaje sin detecciones: nombra la ventana revisada y no dice "24 h"', () => {
  // Reporte 5.9 h después de la captura, como en el hallazgo: la ventana termina en "generado".
  const now = Date.parse(snapshot.generado) + 5.9 * 3600000;
  const v = fireVerdict({ lat: 23.0, lon: -102.0 }, snapshot, now);
  assert.equal(v.kind, 'none');
  for (const [lang, from, to] of [['es', 'del ', ' al '], ['en', 'from ', ' to ']]) {
    setLanguage(lang);
    const text = reportStatus(v);
    assert.doesNotMatch(text, /24 h/);
    assert.match(text, new RegExp(`${from}.+UTC${to}.+UTC`));
    assert.doesNotMatch(text, /confirm/i);
  }
  setLanguage('es');
  const end = new Date(v.to);
  assert.ok(reportStatus(v).includes(`${end.getUTCHours().toString().padStart(2, '0')}:${end.getUTCMinutes().toString().padStart(2, '0')} UTC`));
});

test('zoom: el avance nunca es negativo ni pasa de 1', () => {
  assert.deepEqual(zoomEase(-12), { p: 0, e: 0 });
  assert.deepEqual(zoomEase(0), { p: 0, e: 0 });
  assert.deepEqual(zoomEase(650), { p: 1, e: 1 });
  assert.deepEqual(zoomEase(9000), { p: 1, e: 1 });
  const mid = zoomEase(325);
  assert.ok(mid.e > 0.5 && mid.e < 1);
  // Del recuadro de zoom a todo México, ningún cuadro da un ancho negativo.
  const from = 87.5, to = 700;
  for (const dt of [-40, -16, -1, 0, 1, 16, 400, 700]) assert.ok(from + (to - from) * zoomEase(dt).e > 0, String(dt));
});

test('mensaje para copiar: renglones según el contenido', () => {
  // 6 renglones de 18.85 px más 20 px de relleno, con el redondeo entero de scrollHeight.
  assert.equal(textRows(133, 20, 18.85), 6);
  assert.equal(textRows(134, 20, 18.85), 6);
  assert.equal(textRows(152, 20, 18.85), 7);
  assert.equal(textRows(39, 20, 18.85), 2);
});

test('próxima cobertura: primero el pase más cercano y al final los omitidos', () => {
  const preds = [{ name: 'B', ok: true, closest: 200 }, { name: 'X', ok: false }, { name: 'A', ok: true, closest: 100 }];
  assert.deepEqual(sortPasses(preds).map(p => p.name), ['A', 'B', 'X']);
  assert.deepEqual(preds.map(p => p.name), ['B', 'X', 'A']);
});
