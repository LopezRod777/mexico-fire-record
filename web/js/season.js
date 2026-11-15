import { quantile } from './colors.js';
import { placeName } from './cite.js';
import { t, getLanguage } from './i18n.js';

const NS = 'http:' + '//www.w3.org/2000/svg';
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const PERIOD_A = [2001, 2012], PERIOD_B = [2013, 2025], CHECK_B = [2013, 2021], MIN_YEARS = 5;
const leap = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// Día del año (0 = inicio del 1 de enero) en que se acumula la mitad de la actividad anual,
// interpolando de forma lineal dentro del mes en que se cruza el 50 %. null si falta un mes.
export function seasonMidpoint(values, year) {
  if (values.length !== 12 || !values.every(Number.isFinite)) return null;
  const half = values.reduce((a, b) => a + b, 0) / 2;
  if (half <= 0) return null;
  let sum = 0, day = 0;
  for (let m = 0; m < 12; m++) {
    const length = DAYS[m] + (m === 1 && leap(year) ? 1 : 0);
    if (values[m] > 0 && sum + values[m] >= half) return day + (half - sum) / values[m] * length;
    sum += values[m]; day += length;
  }
  return null;
}
export function periodStats(months, values, from, to) {
  const index = new Map(months.map((month, i) => [month, i])), days = [];
  for (let year = from; year <= to; year++) {
    const day = seasonMidpoint(Array.from({ length: 12 }, (_, m) => values[index.get(`${year}-${String(m + 1).padStart(2, '0')}`)]), year);
    if (day != null) days.push(day);
  }
  return days.length < MIN_YEARS ? null : { n: days.length, median: quantile(days, .5), q1: quantile(days, .25), q3: quantile(days, .75) };
}
export function seasonShift(months, values, a = PERIOD_A, b = PERIOD_B) {
  const A = periodStats(months, values, ...a), B = periodStats(months, values, ...b);
  return A && B ? { a: A, b: B, diff: B.median - A.median, overlap: A.q1 <= B.q3 && B.q1 <= A.q3 } : null;
}
// Veredicto: solo hay cambio si los rangos intercuartiles no se traslapan, la diferencia llega a
// 5 días (con datos mensuales no se distingue menos) y un sensor solo (check) va en el mismo sentido.
export function seasonVerdict(shift, check) {
  if (!shift) return { kind: 'insufficient' };
  if (shift.overlap) return { kind: 'none' };
  if (Math.abs(shift.diff) < 5) return { kind: 'small' };
  const days = Math.round(Math.abs(shift.diff) / 5) * 5, direction = shift.diff < 0 ? 'earlier' : 'later';
  const confirmed = check && Math.abs(check.diff) >= 5 && Math.sign(check.diff) === Math.sign(shift.diff);
  return { kind: confirmed ? direction : 'unconfirmed', days, direction };
}
export function seasonModel(id, series, harmonized) {
  const shift = seasonShift(harmonized.months, harmonized.regions[id].valor);
  return { shift, verdict: seasonVerdict(shift, seasonShift(series.months, series.regions[id].Terra, PERIOD_A, CHECK_B)) };
}
function dayLabel(day, month) {
  return new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-US' : 'es-MX', { day: 'numeric', month, timeZone: 'UTC' }).format(new Date(Date.UTC(2001, 0, 1 + Math.floor(day)))).replace('.', '');
}
const span = ([from, to]) => `${from}–${to}`;
export function seasonText(id, model, names = {}) {
  const { shift, verdict } = model;
  if (!shift) return t('season.insufficient');
  const lead = t('season.lead', { region: placeName(id, names), a: dayLabel(shift.a.median, 'long'), b: dayLabel(shift.b.median, 'long'), pa: span(PERIOD_A), pb: span(PERIOD_B) });
  return lead + t(`season.${verdict.kind}`, { days: verdict.days, direction: t(verdict.direction === 'earlier' ? 'season.dirEarlier' : 'season.dirLater') });
}
function svgEl(tag, attrs = {}, text) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; }
export function renderSeason(id, series, harmonized, names) {
  const model = seasonModel(id, series, harmonized), svg = document.getElementById('season-svg'), { shift } = model;
  document.getElementById('season-text').textContent = seasonText(id, model, names);
  svg.replaceChildren(); svg.hidden = !shift; document.getElementById('season-legend').hidden = !shift;
  if (!shift) return;
  const width = Math.min(560, Math.max(280, Math.floor(svg.parentElement.clientWidth || 358))), left = 84, right = width - 76;
  svg.setAttribute('viewBox', `0 0 ${width} 104`); svg.setAttribute('width', width); svg.setAttribute('height', 104);
  svg.setAttribute('aria-label', t('season.chartAria', { a1: dayLabel(shift.a.q1, 'long'), a2: dayLabel(shift.a.q3, 'long'), b1: dayLabel(shift.b.q1, 'long'), b2: dayLabel(shift.b.q3, 'long'), pa: span(PERIOD_A), pb: span(PERIOD_B) }));
  let from = Math.min(shift.a.q1, shift.b.q1) - 8, to = Math.max(shift.a.q3, shift.b.q3) + 8;
  if (to - from < 45) { const middle = (from + to) / 2; from = middle - 22.5; to = middle + 22.5; }
  const x = day => left + (day - from) / (to - from) * (right - left);
  const starts = DAYS.map((_, m) => DAYS.slice(0, m).reduce((a, b) => a + b, 0)).filter(day => day >= from && day <= to), step = starts.length > 6 ? 2 : 1;
  starts.forEach((day, i) => {
    svg.append(svgEl('line', { x1: x(day), x2: x(day), y1: 10, y2: 80, class: 'season-grid' }));
    if (i % step === 0) svg.append(svgEl('text', { x: x(day), y: 98, 'text-anchor': 'middle', class: 'season-tick' }, dayLabel(day, 'short')));
  });
  [[shift.a, PERIOD_A, 'season-a', 16], [shift.b, PERIOD_B, 'season-b', 50]].forEach(([stats, period, name, y]) => {
    svg.append(svgEl('text', { x: 0, y: y + 16, class: 'season-label' }, span(period)));
    svg.append(svgEl('rect', { x: x(stats.q1), y: y + 4, width: Math.max(2, x(stats.q3) - x(stats.q1)), height: 16, rx: 2, class: name }));
    svg.append(svgEl('line', { x1: x(stats.median), x2: x(stats.median), y1: y, y2: y + 24, class: 'season-median' }));
    svg.append(svgEl('text', { x: width, y: y + 16, 'text-anchor': 'end', class: 'season-label' }, `≈ ${dayLabel(stats.median, 'short')}`));
  });
}
