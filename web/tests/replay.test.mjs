import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frpClass, FRP_CUTS, clusterHeight, clusterDetections, clusterAttrs, detectionTime, satellitePasses, replayTime, passAt, dayNight, frpBin, modisProbabilities, modisExpected } from '../js/replay.js';
import { VIEW, project } from '../js/geo.js';
import { dictionaries, setLanguage, formatDay, formatClock } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const snapshot = read('../data/live_snapshot.json');
const health = read('../data/health.json');

test('color por FRP: cortes 5 y 15 MW', () => {
  assert.deepEqual(FRP_CUTS, [5, 15]);
  assert.equal(frpClass(null), 'flame-low');
  assert.equal(frpClass(4.99), 'flame-low');
  assert.equal(frpClass(5), 'flame-mid');
  assert.equal(frpClass(14.9), 'flame-mid');
  assert.equal(frpClass(15), 'flame-high');
});

test('tamaño por número de detecciones: raíz, creciente y con tope', () => {
  assert.equal(clusterHeight(1), 14);
  assert.equal(clusterHeight(4), 21);
  const sizes = [1, 2, 3, 5, 9, 16, 25, 100].map(clusterHeight);
  assert.ok(sizes.every((v, i) => i === 0 || v >= sizes[i - 1]));
  assert.equal(clusterHeight(1000), 40);
});

test('agrupamiento: conserva todas las detecciones y no deja llamas encimadas', () => {
  for (const width of [390, 835]) {
    const k = VIEW.width / width;
    const points = snapshot.detecciones.map(d => { const [x, y] = project(d.lon, d.lat); return { x, y, frp: d.frp }; });
    const clusters = clusterDetections(points, k);
    assert.equal(clusters.reduce((sum, c) => sum + c.n, 0), snapshot.detecciones.length);
    assert.deepEqual(clusters.flatMap(c => c.members).sort((a, b) => a - b), points.map((p, i) => i));
    assert.ok(clusters.length < points.length, `${width}: ${clusters.length} grupos`);
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 0.55 * (clusterHeight(a.n) + clusterHeight(b.n)) * k - 1e-9);
    }
    for (const c of clusters) assert.equal(c.frpMax, Math.max(...c.members.map(i => points[i].frp ?? 0)));
  }
});

test('posición en el <g> padre; el grupo animado no lleva transform (arreglo de la llama en la esquina)', () => {
  const a = clusterAttrs({ x: 321.5, y: 210.25 }, 21, 0.8);
  assert.equal(a.position.transform, 'translate(321.5 210.25)');
  assert.equal(a.ignite.class, 'live-ignite');
  assert.ok(!('transform' in a.ignite));
  assert.doesNotMatch(a.flame.transform, /321\.5|210\.25/);
  assert.match(a.flame.transform, /^scale\([\d.]+\) translate\(-10 -28\)$/);
  const live = readFileSync(new URL('../js/live.js', import.meta.url), 'utf8');
  const motion = readFileSync(new URL('../js/motion.js', import.meta.url), 'utf8');
  assert.match(live, /c\.ignite\.animate\(/);
  assert.doesNotMatch(live, /c\.(group|flame)\.animate\(/);
  assert.doesNotMatch(motion, /use\[data-frp\]|live-flame/);
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.match(/\.live-flame\{[^}]*\}/)[0], /transform-box|transform-origin/);
});

test('pases y reloj: datos reales del snapshot', () => {
  const passes = satellitePasses(snapshot.detecciones);
  assert.equal(passes.reduce((sum, p) => sum + p.n, 0), snapshot.detecciones.length);
  assert.ok(passes.every(p => ['N20', 'N21'].includes(p.sat) && p.start <= p.end));
  assert.ok(passes.every((p, i) => i === 0 || passes[i - 1].start <= p.start));
  const times = snapshot.detecciones.map(detectionTime);
  const first = Math.min(...times), last = Math.max(...times);
  assert.equal(replayTime(0, first, last), first);
  assert.equal(replayTime(1, first, last), last);
  assert.equal(replayTime(2, first, last), last);
  assert.equal(passAt(passes, first - 1), null);
  assert.equal(passAt(passes, last), passes.at(-1));
  assert.equal(detectionTime({ fecha: '2026-11-14', hora_utc: '07:24' }), Date.parse('2026-11-14T07:24:00Z'));
});

test('ojos de MODIS: usa health.json real, día/noche solar y FRP sumado por celda', () => {
  const rows = health.mx.overlap_probability;
  assert.equal(rows.length, 8);
  assert.equal(dayNight({ hora_utc: '19:17', lon: -100 }), 'D');
  assert.equal(dayNight({ hora_utc: '07:24', lon: -100 }), 'N');
  assert.deepEqual([2.9, 3, 9.9, 10, 29.9, 30].map(frpBin), ['<3', '3-10', '3-10', '10-30', '10-30', '30+']);
  const two = [
    { sat: 'N20', fecha: '2026-11-14', hora_utc: '19:17', lat: 20.001, lon: -100.001, frp: 2 },
    { sat: 'N20', fecha: '2026-11-14', hora_utc: '19:17', lat: 20.002, lon: -100.002, frp: 2 }
  ];
  const day3to10 = rows.find(r => r.daynight === 'D' && r.bin === '3-10').p_mismo_dia;
  assert.deepEqual(modisProbabilities(two, rows), [day3to10, day3to10]);
  const p = modisProbabilities(snapshot.detecciones, rows);
  assert.equal(p.length, snapshot.detecciones.length);
  assert.ok(p.every(v => v > 0 && v < 1));
  const n = modisExpected(p);
  assert.ok(Number.isInteger(n) && n >= 0 && n <= snapshot.detecciones.length);
  assert.equal(modisExpected([]), null);
  assert.equal(modisExpected([0.5, null]), null);
});

test('textos nuevos de Hoy en ES y EN', () => {
  for (const key of ['live.legendShape', 'live.legendColor', 'live.legendSize', 'live.frpLow', 'live.frpMid', 'live.frpHigh', 'live.play', 'live.pause', 'live.pass', 'live.modisToggle', 'live.modisResult', 'live.modisNote', 'live.clusterTitle', 'live.clusterTitleOne', 'heroThesis', 'daysFigureLabel']) {
    assert.ok(dictionaries.es[key] && dictionaries.en[key], key);
  }
  assert.ok(!('kingCaption' in dictionaries.es) && !('kingCaption' in dictionaries.en));
  setLanguage('es');
  assert.equal(formatDay('2026-11-13'), '13 nov 2026');
  assert.equal(formatClock('2026-11-14T07:24:00Z'), '14 nov · 07:24 UTC');
  setLanguage('en');
  assert.equal(formatDay('2026-11-13'), 'Nov 13, 2026');
  assert.equal(formatClock('2026-11-14T07:24:00Z'), 'Nov 14 · 07:24 UTC');
  setLanguage('es');
});

test('reproducción: el mapa que pasa bajo el cursor al hacer scroll no la pausa', () => {
  const live = readFileSync(new URL('../js/live.js', import.meta.url), 'utf8');
  // Safari y Chrome mandan pointerenter sin movimiento real al hacer scroll: no debe pausar.
  assert.doesNotMatch(live, /pointerenter[^\n]*hoverPaused\s*=\s*true/);
  assert.match(live, /if\(e\.pointerType==='touch'\|\|!moved\)return;/);
});
