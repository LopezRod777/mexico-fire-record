import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BIN_MS, detectionTime, satellitePasses, timelineBins, timelineFraction, timelineSeek, timelineKey, replaySchedule, scheduleTime, scheduleProgress, passNow, modisProbabilities, modisExpected, modisSelection } from '../js/replay.js';
import { HERO_DOTS, HERO_IMAGE, coverPoint, parseObjectPosition } from '../js/hero.js';
import { liveView, staleNotice, ageText } from '../js/live.js';
import { setLanguage } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const snapshot = read('../data/live_snapshot.json');
const health = read('../data/health.json');
const names = read('../data/series_monthly.json').region_names;
const stateIds = Object.keys(names).filter(id => id !== 'MX');
const det = (hora, sat = 'N20') => ({ fecha: '2026-11-14', hora_utc: hora, sat });

test('línea de tiempo: bloques de 15 min por satélite, sin perder detecciones', () => {
  const tl = timelineBins([det('07:24'), det('07:29'), det('07:30', 'N21'), det('08:44', 'N21')]);
  assert.equal(tl.start, Date.parse('2026-11-14T07:15:00Z'));
  assert.equal(tl.end, Date.parse('2026-11-14T08:45:00Z'));
  assert.equal(tl.bins.length, 6);
  assert.deepEqual(tl.bins.map(b => [b.n20, b.n21]), [[2, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 1]]);
  assert.equal(tl.max, 2);
  const real = timelineBins(snapshot.detecciones);
  assert.equal(real.bins.reduce((sum, b) => sum + b.n20 + b.n21, 0), snapshot.detecciones.length);
  assert.equal(real.bins.reduce((sum, b) => sum + b.n21, 0), snapshot.detecciones.filter(d => d.sat === 'N21').length);
  const times = snapshot.detecciones.map(detectionTime);
  assert.ok(real.start <= Math.min(...times) && real.end > Math.max(...times));
  assert.ok(real.bins.every((b, i) => b.t0 === real.start + i * BIN_MS));
});

test('línea de tiempo: bandas de pase dentro del eje y en ráfagas', () => {
  const tl = timelineBins(snapshot.detecciones), passes = satellitePasses(snapshot.detecciones);
  for (const p of passes) {
    const a = timelineFraction(p.start, tl.start, tl.end), b = timelineFraction(p.end, tl.start, tl.end);
    assert.ok(a >= 0 && b <= 1 && a <= b);
  }
  // Ráfagas: todas las detecciones caen en bloques que coinciden con algún pase.
  const busy = tl.bins.filter(b => b.n20 + b.n21 > 0);
  assert.ok(busy.every(b => passes.some(p => p.start < b.t0 + BIN_MS && p.end >= b.t0)));
  assert.ok(busy.length < tl.bins.length / 2, `${busy.length} de ${tl.bins.length} bloques con detecciones`);
});

test('seek: clic, arrastre y teclado se limitan al eje', () => {
  const start = 1000, end = 1000 + 8 * BIN_MS;
  assert.equal(timelineSeek(0, start, end), start);
  assert.equal(timelineSeek(0.5, start, end), start + 4 * BIN_MS);
  assert.equal(timelineSeek(-2, start, end), start);
  assert.equal(timelineSeek(9, start, end), end);
  assert.equal(timelineFraction(timelineSeek(0.25, start, end), start, end), 0.25);
  assert.equal(timelineKey('ArrowRight', start, start, end), start + BIN_MS);
  assert.equal(timelineKey('ArrowLeft', start, start, end), start);
  assert.equal(timelineKey('PageUp', start, start, end), start + 4 * BIN_MS);
  assert.equal(timelineKey('End', start, start, end), end);
  assert.equal(timelineKey('Home', end, start, end), start);
  assert.equal(timelineKey('a', start, start, end), null);
});

test('ritmo: lento en los pases, rápido entre pases; ida y vuelta exacta', () => {
  const tl = timelineBins(snapshot.detecciones), passes = satellitePasses(snapshot.detecciones);
  const s = replaySchedule(passes, tl.start, tl.end);
  assert.equal(s[0].t0, tl.start); assert.equal(s.at(-1).t1, tl.end); assert.equal(s.at(-1).p1, 1);
  assert.ok(s.every((seg, i) => i === 0 || seg.t0 === s[i - 1].t1));
  const passShare = s.filter(x => x.pass).reduce((sum, x) => sum + x.p1 - x.p0, 0);
  const passTime = s.filter(x => x.pass).reduce((sum, x) => sum + x.t1 - x.t0, 0) / (tl.end - tl.start);
  assert.ok(passShare > 0.6 && passTime < 0.4, `${passShare} del tiempo de reproducción para ${passTime} del eje`);
  for (const p of [0, 0.1, 0.33, 0.5, 0.77, 1]) assert.ok(Math.abs(scheduleProgress(scheduleTime(p, s), s) - p) < 1e-9);
  for (const d of snapshot.detecciones.slice(0, 40)) { const time = detectionTime(d); assert.ok(Math.abs(scheduleTime(scheduleProgress(time, s), s) - time) < 1); }
  assert.equal(passNow(passes, passes[2].start + 60000), passes[2]);
  assert.equal(passNow(passes, (passes[3].end + passes[4].start) / 2), null);
});

test('MODIS: subconjunto determinista de las detecciones más probables', () => {
  const p = modisProbabilities(snapshot.detecciones, health.mx.overlap_probability);
  const n = modisExpected(p), sel = modisSelection(p);
  assert.equal(sel.length, n);
  assert.equal(n, Math.round(p.reduce((a, b) => a + b, 0)));
  assert.deepEqual(modisSelection(p), sel);
  const chosen = new Set(sel), minChosen = Math.min(...sel.map(i => p[i]));
  assert.ok(p.every((v, i) => chosen.has(i) || v <= minChosen));
  assert.deepEqual(modisSelection([0.2, 0.9, 0.2, 0.5], 2), [1, 3]);
  assert.deepEqual(modisSelection([0.3, 0.3, 0.3], 2), [0, 1]);
  assert.deepEqual(modisSelection([0.5, null]), []);
});

test('portada: los puntos rojos marcados caen dentro de la imagen y del recorte visible', () => {
  assert.equal(HERO_DOTS.length, 3);
  for (const [x, y] of HERO_DOTS) assert.ok(x > 0 && x < 1 && y > 0 && y < 1);
  // Píxeles medidos (centroides) de los tres puntos; las constantes deben reproducirlos.
  const measured = [[816.5, 443.5], [1065.7, 576.7], [925.5, 672.5]];
  HERO_DOTS.forEach(([x, y], i) => { assert.ok(Math.abs(x * HERO_IMAGE.width - measured[i][0]) < 0.6); assert.ok(Math.abs(y * HERO_IMAGE.height - measured[i][1]) < 0.6); });
  assert.deepEqual(parseObjectPosition('50% 45%'), [0.5, 0.45]);
  assert.deepEqual(parseObjectPosition('center top'), [0.5, 0]);
  const position = parseObjectPosition('50% 45%');
  for (const box of [{ width: 1440, height: 684 }, { width: 390, height: 464 }, { width: 1920, height: 900 }, { width: 768, height: 600 }]) {
    for (const rel of HERO_DOTS) {
      const p = coverPoint(rel, box, HERO_IMAGE, position);
      assert.ok(p.x > 12 && p.x < box.width - 12 && p.y > 12 && p.y < box.height * 0.6, `${box.width}×${box.height}: ${p.x}, ${p.y}`);
    }
  }
  // Mismo cálculo que object-fit: cover: las esquinas de la imagen tocan o rebasan la caja.
  const tl = coverPoint([0, 0], { width: 390, height: 464 }), br = coverPoint([1, 1], { width: 390, height: 464 });
  assert.ok(tl.x <= 1e-9 && tl.y <= 1e-9 && br.x >= 390 - 1e-9 && br.y >= 464 - 1e-9);
  assert.ok(Math.abs((br.x - tl.x) / (br.y - tl.y) - HERO_IMAGE.width / HERO_IMAGE.height) < 1e-9);
});

test('captura vieja: se muestra todo con aviso; "no disponible" solo si es inválida', () => {
  setLanguage('es');
  const generated = snapshot.generado, at = h => Date.parse(generated) + h * 3600000;
  assert.deepEqual(liveView(snapshot, stateIds, at(1)), { mode: 'full', notice: null });
  const old = liveView(snapshot, stateIds, at(7.5));
  assert.equal(old.mode, 'full');
  assert.match(old.notice, /hace 7 h, y no se actualiza sola/);
  assert.match(staleNotice(generated, at(80)), /hace 3 días/);
  assert.equal(ageText(47.9), '47 h');
  assert.equal(liveView({ ...snapshot, detecciones: [] }, stateIds, at(1)).mode, 'unavailable');
  assert.equal(liveView(null, stateIds).mode, 'unavailable');
  setLanguage('en');
  assert.match(staleNotice(generated, at(80)), /3 days ago, and it does not update automatically/);
  setLanguage('es');
  const live = readFileSync(new URL('../js/live.js', import.meta.url), 'utf8');
  assert.doesNotMatch(live, /isStale\(data\.generado\)\)\{[^}]*throw/);
});
