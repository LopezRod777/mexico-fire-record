import { median } from './anomaly.js';
import { methodKey } from './confidence.js';
import { t, formatNumber, getLanguage, regionName } from './i18n.js';

// La banda lo–hi de cada mes estimado es valor × (1 ± error validado de su fuente), por eso el
// error que se cita es el de la validación que corresponde a la fuente de ese mes.
const VALIDATION = { 'Terra*k': 'terra->snpp', 'Aqua*k': 'aqua->snpp', 'Terra∪Aqua*k': 'union->snpp' };
const SOURCE = { 'Terra*k': 'cite.srcTerra', 'Aqua*k': 'cite.srcAqua', 'Terra∪Aqua*k': 'cite.srcUnion' };
const HEADLINE = { above: 'cite.above', below: 'cite.below', within: 'cite.within' };
const DIRECT = { above: 'cite.directAbove', below: 'cite.directBelow', within: 'cite.directEqual' };

// Cifras de la cita para una región y un mes ('AAAA-MM') de la serie armonizada; null si no hay valor.
export function citeFacts(id, month, harmonized) {
  const months = harmonized.months, region = harmonized.regions[id], i = months.indexOf(month);
  const value = i < 0 ? null : region.valor[i];
  if (!Number.isFinite(value)) return null;
  const med = median(region.valor.filter((_, j) => months[j].slice(5) === month.slice(5)));
  const source = region.fuente[i], direct = source === 'SNPP';
  const banded = Number.isFinite(region.lo[i]) && Number.isFinite(region.hi[i]);
  const lo = banded ? region.lo[i] : value, hi = banded ? region.hi[i] : value;
  const error = region.validation[VALIDATION[source] ?? methodKey(harmonized)].mape_razon_mensual;
  return { month, value, median: med, ratio: med > 0 ? value / med : null, lo, hi, banded, position: lo > med ? 'above' : hi < med ? 'below' : 'within', source, direct, error, extrapolated: !direct && month < '2012-01' };
}
export function placeName(id, names) {
  return id === 'MX' ? t('cite.regionNational') : id === 'MX-MEX' ? t('cite.regionMex') : id === 'MX-DIF' ? t('cite.regionDif') : regionName(id, names);
}
function longMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-US' : 'es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, m - 1, 1)));
}
const count = value => formatNumber(value, value < 10 ? 1 : 0);
export function citeText(id, month, harmonized, names = {}, today = new Date()) {
  const f = citeFacts(id, month, harmonized);
  if (!f) return t('cite.noData', { month: longMonth(month) });
  const compare = f.ratio == null ? t('cite.medianZero') : t('cite.ratio', { ratio: formatNumber(f.ratio, 2), median: count(f.median) });
  const error = t('cite.percent', { value: formatNumber(f.error * 100) });
  const date = new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-US' : 'es-MX', { dateStyle: 'long' }).format(today);
  return [
    t('cite.lead', { region: placeName(id, names), month: longMonth(month), value: count(f.value), compare }) + t((f.banded ? HEADLINE : DIRECT)[f.position], { lo: count(f.lo), hi: count(f.hi) }),
    f.direct ? t('cite.direct', { error }) : t(f.extrapolated ? 'cite.rescaledOld' : 'cite.rescaled', { source: t(SOURCE[f.source]), error, year: month.slice(0, 4) }),
    t('cite.unit'),
    t('cite.source', { date }),
  ].join(' ');
}
export function renderCite(id, month, harmonized, names) {
  document.getElementById('cite-text').textContent = citeText(id, month, harmonized, names);
  document.getElementById('cite-copy').disabled = !citeFacts(id, month, harmonized);
  document.getElementById('cite-status').textContent = '';
}
export async function copyCite() {
  const node = document.getElementById('cite-text'), status = document.getElementById('cite-status');
  try { await navigator.clipboard.writeText(node.textContent); status.textContent = t('cite.copied'); }
  catch {
    const range = document.createRange(), selection = getSelection();
    range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
    status.textContent = t('cite.copyFailed');
  }
}
