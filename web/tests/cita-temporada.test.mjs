import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { citeFacts, citeText } from '../js/cite.js';
import { seasonMidpoint, seasonShift, seasonVerdict, seasonModel, seasonText } from '../js/season.js';
import { anomalies } from '../js/anomaly.js';
import { setLanguage, dictionaries } from '../js/i18n.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const harmonized = read('../data/harmonized.json'), series = read('../data/series_monthly.json');
const TODAY = new Date(2026, 10, 15);

// ---------- Cita: serie sintética con resultado conocido ----------
// 2010-01 … 2013-12. Todo vale 100 salvo los meses que se prueban, así que la mediana de cada mes es 100.
function fixture() {
  const months = [];
  for (let y = 2010; y <= 2013; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const region = { valor: months.map(() => 100), lo: [], hi: [], fuente: [], validation: { 'terra->snpp': { mape_razon_mensual: .3 }, 'aqua->snpp': { mape_razon_mensual: .1 }, 'union->snpp': { mape_razon_mensual: .2 } } };
  const set = (month, value) => { region.valor[months.indexOf(month)] = value; };
  set('2010-05', 200); set('2011-06', 40); set('2011-07', 110); set('2013-08', 150); set('2013-09', 50); set('2010-03', null);
  months.forEach((month, i) => {
    const source = region.valor[i] == null ? null : month >= '2012-02' ? 'SNPP' : month === '2012-01' ? 'Aqua*k' : month < '2010-07' ? 'Terra*k' : 'Terra∪Aqua*k';
    const error = { 'Terra*k': .3, 'Aqua*k': .1, 'Terra∪Aqua*k': .2 }[source];
    region.fuente.push(source);
    region.lo.push(error ? region.valor[i] * (1 - error) : null);
    region.hi.push(error ? region.valor[i] * (1 + error) : null);
  });
  return { months, regions: { 'MX-JAL': region }, validation_resumen: { 'union->snpp': {} } };
}
const NAMES = { 'MX-JAL': 'Jalisco' };

test('cita: banda entera por encima, entera por debajo y que cruza la mediana', () => {
  const data = fixture();
  const above = citeFacts('MX-JAL', '2010-05', data);
  assert.deepEqual([above.value, above.median, above.ratio, above.lo, above.hi, above.position, above.banded], [200, 100, 2, 140, 260, 'above', true]);
  const below = citeFacts('MX-JAL', '2011-06', data);
  assert.deepEqual([below.value, below.median, below.ratio, below.lo, below.hi, below.position], [40, 100, .4, 32, 48, 'below']);
  const within = citeFacts('MX-JAL', '2011-07', data);
  assert.deepEqual([within.value, within.median, within.lo, within.hi, within.position], [110, 100, 88, 132, 'within']);
  setLanguage('en');
  assert.match(citeText('MX-JAL', '2010-05', data, NAMES, TODAY), /^In Jalisco, May 2010 had 200 cell-days of satellite heat detections in the harmonized series, 2 times the median for that month across all years of the series \(100\), and it stays above the usual level for that month even at the low end of its illustrative uncertainty band \(140–260\)\./);
  assert.match(citeText('MX-JAL', '2011-06', data, NAMES, TODAY), /0\.4 times the median .*\(100\), and it stays below the usual level for that month even at the high end of its illustrative uncertainty band \(32–48\)\./);
  assert.match(citeText('MX-JAL', '2011-07', data, NAMES, TODAY), /1\.1 times the median .*\(100\), and that median falls inside the month’s illustrative uncertainty band \(88–132\), so the month is not clearly unusual\./);
  setLanguage('es');
  assert.match(citeText('MX-JAL', '2010-05', data, NAMES, TODAY), /^En Jalisco, mayo de 2010 tuvo 200 celdas-día con detecciones satelitales de calor en la serie armonizada, 2 veces la mediana de ese mes en todos los años de la serie \(100\), y se mantiene por encima del nivel habitual de ese mes incluso en el extremo bajo de su banda ilustrativa de incertidumbre \(140–260\)\./);
  assert.match(citeText('MX-JAL', '2011-06', data, NAMES, TODAY), /se mantiene por debajo del nivel habitual de ese mes incluso en el extremo alto de su banda ilustrativa de incertidumbre \(32–48\)\./);
  assert.match(citeText('MX-JAL', '2011-07', data, NAMES, TODAY), /esa mediana cae dentro de la banda ilustrativa de incertidumbre del mes \(88–132\), por lo que el mes no es claramente inusual\./);
});

test('cita: mes anterior a 2012 (extrapolación), enero de 2012 y mes posterior (conteo directo)', () => {
  const data = fixture();
  const old = citeFacts('MX-JAL', '2010-05', data), union = citeFacts('MX-JAL', '2011-06', data), january = citeFacts('MX-JAL', '2012-01', data), direct = citeFacts('MX-JAL', '2013-08', data), low = citeFacts('MX-JAL', '2013-09', data), equal = citeFacts('MX-JAL', '2013-05', data);
  assert.deepEqual([old.source, old.error, old.extrapolated, old.direct], ['Terra*k', .3, true, false]);
  assert.deepEqual([union.source, union.error, union.extrapolated], ['Terra∪Aqua*k', .2, true]);
  assert.deepEqual([january.source, january.error, january.extrapolated, january.position], ['Aqua*k', .1, false, 'within']);
  assert.deepEqual([direct.source, direct.error, direct.extrapolated, direct.direct, direct.banded, direct.position, direct.ratio], ['SNPP', .2, false, true, false, 'above', 1.5]);
  assert.deepEqual([low.position, equal.position], ['below', 'within']);
  assert.equal(citeFacts('MX-JAL', '2010-03', data), null);
  assert.equal(citeFacts('MX-JAL', '1999-01', data), null);
  setLanguage('en');
  const textOld = citeText('MX-JAL', '2010-05', data, NAMES, TODAY), textDirect = citeText('MX-JAL', '2013-08', data, NAMES, TODAY);
  assert.match(textOld, /That month is estimated from MODIS on Terra rescaled to the VIIRS S-NPP scale, and the validated monthly error of that rescaling for this region is 30% in years held out of the fit \(2012–2021\), so applying it to 2010 is an extrapolation\./);
  assert.match(citeText('MX-JAL', '2011-06', data, NAMES, TODAY), /MODIS on Terra and Aqua combined .* is 20% in years held out of the fit \(2012–2021\), so applying it to 2011 is an extrapolation\./);
  const textJanuary = citeText('MX-JAL', '2012-01', data, NAMES, TODAY);
  assert.match(textJanuary, /MODIS on Aqua .* is 10% in years held out of the fit \(2012–2021\)\. /);
  assert.doesNotMatch(textJanuary, /extrapolation/);
  assert.match(textDirect, /1\.5 times the median for that month across all years of the series \(100\), so it is above that median\. That month is a direct VIIRS S-NPP count, so it has no rescaling band, whereas the median it is compared with includes months before 2012 estimated from MODIS, whose validated monthly error for this region is 20% in years held out of the fit \(2012–2021\)\./);
  assert.doesNotMatch(textDirect, /extrapolation|uncertainty band|usual level/);
  assert.match(citeText('MX-JAL', '2013-09', data, NAMES, TODAY), /\(100\), so it is below that median\./);
  assert.match(citeText('MX-JAL', '2013-05', data, NAMES, TODAY), /\(100\), so it matches that median\./);
  assert.equal(citeText('MX-JAL', '2010-03', data, NAMES, TODAY), 'The harmonized series has no value for March 2010 in this region, so there is no summary to copy.');
  setLanguage('es');
  assert.match(citeText('MX-JAL', '2010-05', data, NAMES, TODAY), /Ese mes se estima con MODIS de Terra reescalado a la escala de VIIRS S-NPP, y el error mensual validado de ese reescalado para esta región es de 30 % en años que se dejaron fuera del ajuste \(2012–2021\), de modo que aplicarlo a 2010 es una extrapolación\./);
  assert.match(citeText('MX-JAL', '2013-08', data, NAMES, TODAY), /\(100\), por lo que queda por encima de esa mediana\. Ese mes es un conteo directo de VIIRS S-NPP, por lo que no tiene banda de reescalado/);
});

test('cita: unidad, fuente, fecha de consulta y palabras prohibidas, con los datos reales', () => {
  for (const lang of ['en', 'es']) {
    setLanguage(lang);
    for (const [id, month] of [['MX', '2005-05'], ['MX', '2025-12'], ['MX-JAL', '2011-04'], ['MX-YUC', '2019-04'], ['MX-DIF', '2005-07'], ['MX-MEX', '2012-01']]) {
      const text = citeText(id, month, harmonized, series.region_names, TODAY);
      assert.doesNotMatch(text, /statistically|significant|confidence interval|significativ|intervalo de confianza|[;{}]|undefined|NaN|null/i, `${lang} ${id} ${month}`);
      assert.match(text, lang === 'en' ? /cell-days of satellite heat detections, not a count of fires/ : /celdas-día con detecciones satelitales de calor, no un conteo de incendios/);
      assert.match(text, lang === 'en' ? /Source: NASA FIRMS \(MODIS and VIIRS\), harmonized by Mexico Fire Record, mexico-fire-record\.vercel\.app, accessed November 15, 2026\.$/ : /Fuente: NASA FIRMS \(MODIS y VIIRS\), armonizado por Mexico Fire Record, mexico-fire-record\.vercel\.app, consultado el 15 de noviembre de 2026\.$/);
    }
  }
  setLanguage('en');
  assert.match(citeText('MX', '2025-12', harmonized, series.region_names, TODAY), /^In Mexico as a whole, December 2025 had 4,648 cell-days/);
  assert.match(citeText('MX-MEX', '2012-01', harmonized, series.region_names, TODAY), /^In the State of Mexico, January 2012 had/);
  // Mediana 0 (Ciudad de México en julio): sin "veces la mediana".
  assert.equal(citeFacts('MX-DIF', '2005-07', harmonized).ratio, null);
  assert.match(citeText('MX-DIF', '2005-07', harmonized, series.region_names, TODAY), /^In Mexico City, July 2005 had [\d.]+ cell-days of satellite heat detections in the harmonized series, while the median for that month across all years of the series is 0, and /);
  assert.equal(citeFacts('MX-DIF', '2001-06', harmonized), null);
  setLanguage('es');
  assert.match(citeText('MX', '2005-05', harmonized, series.region_names, TODAY), /^En todo México, mayo de 2005 tuvo /);
});

test('cita: la mediana es la misma que usa la anomalía del calendario y la banda sale del error citado', () => {
  for (const [id, month] of [['MX', '2005-05'], ['MX-CHP', '2003-04'], ['MX-SON', '2024-06'], ['MX-TLA', '2001-02']]) {
    const f = citeFacts(id, month, harmonized), i = harmonized.months.indexOf(month), region = harmonized.regions[id];
    assert.ok(Math.abs(f.ratio * 100 - anomalies(harmonized.months, region.valor)[i]) < 1e-9, `${id} ${month}`);
    if (f.banded) { assert.ok(Math.abs(f.lo - f.value * (1 - f.error)) < 1e-6); assert.ok(Math.abs(f.hi - f.value * (1 + f.error)) < 1e-6); }
    else assert.equal(f.source, 'SNPP');
  }
});

// ---------- Punto medio de la temporada ----------
test('temporada: punto medio con series de resultado conocido', () => {
  const only = (m, value = 80) => Array.from({ length: 12 }, (_, i) => i === m ? value : 0);
  assert.equal(seasonMidpoint(only(3), 2001), 105);          // todo en abril: 31+28+31 + 30/2
  assert.equal(seasonMidpoint(only(2), 2004), 75.5);         // marzo de año bisiesto: 31+29 + 31/2
  assert.equal(seasonMidpoint(only(0), 2001), 15.5);
  assert.equal(seasonMidpoint([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], 2001), 182.5); // actividad uniforme
  assert.equal(seasonMidpoint([100, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0], 2001), 31);            // la mitad se cumple al cerrar enero
  assert.equal(seasonMidpoint([0, 0, 10, 30, 40, 20, 0, 0, 0, 0, 0, 0], 2001), 120 + 10 / 40 * 31); // cruza en mayo
  assert.equal(seasonMidpoint(only(3, 0), 2001), null);
  assert.equal(seasonMidpoint([...only(3).slice(0, 11), null], 2001), null);
  assert.equal(seasonMidpoint(only(3).slice(0, 11), 2001), null);
});

function yearly(pick) {
  const months = [], values = [];
  for (let y = 2000; y <= 2025; y++) for (let m = 0; m < 12; m++) { months.push(`${y}-${String(m + 1).padStart(2, '0')}`); values.push(m === pick(y) ? 50 : 0); }
  return { months, values };
}
test('temporada: mediana, rango intercuartil, diferencia y veredicto', () => {
  // Todo en abril hasta 2012 y todo en mayo desde 2013: 105 (106 en bisiesto) contra 135.5 (136.5).
  const moved = yearly(y => y <= 2012 ? 3 : 4), shift = seasonShift(moved.months, moved.values);
  assert.deepEqual([shift.a.n, shift.a.median, shift.a.q1, shift.a.q3], [12, 105, 105, 105.25]);
  assert.deepEqual([shift.b.n, shift.b.median, shift.b.q1, shift.b.q3], [13, 135.5, 135.5, 135.5]); // 10 años en 135.5 y 3 bisiestos en 136.5
  assert.equal(shift.diff, 30.5); assert.equal(shift.overlap, false);
  assert.deepEqual(seasonVerdict(shift, shift), { kind: 'later', days: 30, direction: 'later' });
  assert.deepEqual(seasonVerdict(shift, null), { kind: 'unconfirmed', days: 30, direction: 'later' });
  const back = yearly(y => y <= 2012 ? 4 : 3), shiftBack = seasonShift(back.months, back.values);
  assert.deepEqual(seasonVerdict(shiftBack, shiftBack), { kind: 'earlier', days: 30, direction: 'earlier' });
  assert.equal(seasonVerdict(shift, shiftBack).kind, 'unconfirmed');          // el sensor solo dice lo contrario
  assert.equal(seasonVerdict(shift, { diff: 3, overlap: true }).kind, 'unconfirmed'); // el sensor solo no llega a 5 días
  // Años alternados entre abril y mayo en los dos periodos: los rangos se traslapan.
  const mixed = yearly(y => y % 2 ? 3 : 4);
  assert.equal(seasonVerdict(seasonShift(mixed.months, mixed.values)).kind, 'none');
  assert.equal(seasonVerdict({ diff: -2.5, overlap: false, a: {}, b: {} }, { diff: -2.5 }).kind, 'small');
  assert.equal(seasonVerdict({ diff: -7.4, overlap: false }, { diff: -9 }).days, 5);
  assert.equal(seasonVerdict({ diff: 12.6, overlap: false }, { diff: 9 }).days, 15);
  // Menos de 5 años completos en un periodo: no se compara.
  const few = yearly(() => 3); few.values.forEach((_, i) => { if (few.months[i] >= '2005-01' && few.months[i] <= '2012-12' && few.months[i].endsWith('-06')) few.values[i] = null; });
  assert.equal(seasonShift(few.months, few.values), null);
  assert.deepEqual(seasonVerdict(null), { kind: 'insufficient' });
});

test('temporada: datos reales, texto en los dos idiomas y recuento de veredictos', () => {
  const kinds = {};
  for (const id of Object.keys(harmonized.regions)) { const kind = seasonModel(id, series, harmonized).verdict.kind; kinds[kind] = (kinds[kind] ?? 0) + 1; }
  assert.deepEqual(kinds, { none: 31, small: 1, unconfirmed: 1 });
  assert.equal(seasonModel('MX-OAX', series, harmonized).verdict.kind, 'small');
  assert.equal(seasonModel('MX-GUA', series, harmonized).verdict.kind, 'unconfirmed');
  const mx = seasonModel('MX', series, harmonized);
  assert.deepEqual([mx.shift.a.n, mx.shift.b.n], [12, 13]);
  assert.ok(Math.abs(mx.shift.a.median - 129.4) < .05 && Math.abs(mx.shift.b.median - 127.7) < .05);
  assert.equal(seasonModel('MX-DIF', series, harmonized).shift.a.n, 10); // 2001 y 2002 tienen un mes sin dato
  setLanguage('en');
  assert.equal(seasonText('MX', mx, series.region_names), 'In Mexico as a whole, half of the year’s cell-days were reached around May 10 in 2001–2012 and around May 8 in 2013–2025. No clear shift: the difference is within the year-to-year spread.');
  assert.match(seasonText('MX-GUA', seasonModel('MX-GUA', series, harmonized), series.region_names), /No clear shift: the harmonized series suggests about 45 days earlier, but Terra alone \(a single sensor, 2001–2021\) does not show the same change, so it may come from the rescaling\.$/);
  setLanguage('es');
  assert.equal(seasonText('MX', mx, series.region_names), 'En todo México, la mitad de las celdas-día del año se alcanzó hacia el 10 de mayo en 2001–2012 y hacia el 8 de mayo en 2013–2025. Sin cambio claro: la diferencia cabe dentro de la variación de un año a otro.');
  assert.match(seasonText('MX-OAX', seasonModel('MX-OAX', series, harmonized), series.region_names), /Sin cambio claro: la diferencia es menor de lo que los datos mensuales permiten distinguir\.$/);
});

test('rótulo de anomalía: dice lo que se calcula (mediana de ese mes en todos los años)', () => {
  assert.equal(dictionaries.en.metricAnomaly, 'Anomaly versus that month’s median across all years');
  assert.equal(dictionaries.es.metricAnomaly, 'Anomalía vs. la mediana de ese mes en todos los años');
  for (const lang of ['es', 'en']) for (const value of Object.values(dictionaries[lang])) assert.doesNotMatch(value, /other years|otros años/);
  // La mediana incluye el propio año: con un solo año por mes, la anomalía es 100.
  assert.deepEqual(anomalies(['2001-01', '2001-02'], [7, 9]), [100, 100]);
});
