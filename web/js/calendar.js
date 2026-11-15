import { anomalies } from './anomaly.js';
import { colorFor, quantile } from './colors.js';
import { monthLabel, number } from './format.js';
import { legendSteps } from './editorial.js';
import { t, getLanguage } from './i18n.js';
const NS = 'http:' + '//www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }
export function calendarModel(id, view, metric, series, harmonized) {
  const months = series.months, raw = series.regions[id], adjusted = harmonized.regions[id];
  const values = view === 'harmonized' ? adjusted.valor : raw[view];
  const shown = metric === 'anomaly' ? anomalies(months, values) : values;
  const byMonth = new Map(months.map((m, i) => [m, i]));
  return Array.from({ length: 26 }, (_, y) => Array.from({ length: 12 }, (_, m) => {
    const month = `${2000 + y}-${String(m + 1).padStart(2, '0')}`, i = byMonth.get(month);
    const value = i == null ? null : values[i], display = i == null ? null : shown[i];
    return { month, value, display, source: i == null ? null : view === 'harmonized' ? adjusted.fuente[i] : view, lo: view === 'harmonized' && i != null ? adjusted.lo[i] : null, hi: view === 'harmonized' && i != null ? adjusted.hi[i] : null, estimated: view === 'harmonized' && i != null && adjusted.fuente[i] != null && adjusted.fuente[i] !== 'SNPP', drift: (view === 'Terra' || view === 'Aqua') && i != null && Boolean(adjusted.deriva[i]) };
  }));
}
export function describeCell(cell, metric) {
  const parts = [monthLabel(cell.month), t('calendar.value',{value:number(cell.value == null ? null : Math.round(cell.value))})];
  if (metric === 'anomaly') parts.push(t('calendar.anomaly',{value:cell.display == null ? t('common.noData') : number(cell.display)}));
  parts.push(t('calendar.source',{source:cell.source ?? t('common.noData')}));
  if (cell.lo != null && cell.hi != null) parts.push(t('calendar.band',{lo:number(Math.round(cell.lo)),hi:number(Math.round(cell.hi))}));
  if (cell.drift) parts.push(t('calendar.drift'));
  return parts.join(' · ');
}
export function scaleValue(v, max, mode) {
  if (!Number.isFinite(v) || max <= 0) return 0;
  const t = Math.max(0, Math.min(1, v / max));
  return mode === 'count' ? Math.sqrt(t) : t;
}
export function niceTicks(max, n) {
  if (n < 2) return [0];
  if (max <= 0) return Array(n).fill(0);
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return 0;
    if (i === n - 1) return max;
    const raw = max * (i / (n - 1)) ** 2;
    const unit = 10 ** Math.floor(Math.log10(raw));
    const rounded = Math.round(raw / unit) * unit;
    return Math.max(0, Math.min(max, rounded));
  });
}
export function legendMark(value, metric, overflow = false) {
  const label = number(metric === 'count' ? Math.round(value) : value);
  return `${label}${metric === 'anomaly' ? ' %' : ''}${overflow ? t('calendar.orMore') : ''}`;
}
export function renderCalendar(model, metric) {
  const svg = document.getElementById('calendar-svg'), tableWrap = document.getElementById('calendar-table-wrap');
  svg.replaceChildren();
  const title = svgEl('title', { id: 'calendar-svg-title' }); title.textContent = t('calendar.svgTitle'); svg.append(title);
  const desc = svgEl('desc', { id: 'calendar-svg-desc' }); desc.textContent = t('calendar.svgDesc'); svg.append(desc);
  const defs = svgEl('defs');
  for (const [id, angle] of [['dots', 0], ['stripes', 45]]) {
    const p = svgEl('pattern', { id, patternUnits: 'userSpaceOnUse', width: 5, height: 5, patternTransform: `rotate(${angle})` });
    p.append(svgEl('circle', { cx: 1, cy: 1, r: id === 'dots' ? 0.7 : 0, fill: '#ECEAE6' }));
    if (id === 'stripes') p.append(svgEl('path', { d: 'M0 0V5', stroke: '#ECEAE6', 'stroke-width': 1 }));
    defs.append(p);
  }
  svg.append(defs);
  const values = model.flat().map(c => c.display).filter(Number.isFinite), max = quantile(values, .98);
  const width = Math.max(300, Math.floor(svg.parentElement.clientWidth || 390)), left = 38, gap = 2, cellW = (width - left - 2) / 12 - gap;
  svg.setAttribute('viewBox', `0 0 ${width} 632`);
  const detail = document.getElementById('calendar-detail');
  function select(cell) { detail.textContent = describeCell(cell, metric); }
  [...Array(12)].forEach((_, m) => { const label=new Intl.DateTimeFormat(getLanguage()==='en'?'en-US':'es-MX',{month:'narrow',timeZone:'UTC'}).format(new Date(Date.UTC(2000,m,1))); const text = svgEl('text', { x: left + m * (cellW + gap) + cellW / 2, y: 20, 'text-anchor': 'middle' }); text.textContent = label; svg.append(text); });
  model.forEach((row, y) => {
    const yr = svgEl('text', { x: 0, y: 42 + y * 23, class: 'year' }); yr.textContent = 2000 + y; svg.append(yr);
    row.forEach((cell, m) => {
      const x = left + m * (cellW + gap), yy = 27 + y * 23;
      const fill = cell.display == null ? '#4A3B33' : colorFor(scaleValue(cell.display, max, metric));
      const rect = svgEl('rect', { x, y: yy, width: cellW, height: 20, rx: 2, fill, stroke:cell.display != null && scaleValue(cell.display,max,metric)<.34 ? '#D4571A' : '#4A3B33', class: 'cell', tabindex: 0, role: 'button', 'aria-label': describeCell(cell, metric) });
      rect.addEventListener('click', () => select(cell)); rect.addEventListener('focus', () => select(cell)); rect.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(cell); } }); svg.append(rect);
      if (cell.display == null) { const t = svgEl('text', { x: x + cellW / 2, y: yy + 14, 'text-anchor': 'middle', 'aria-hidden': 'true' }); t.textContent = '×'; svg.append(t); }
      if (cell.estimated || cell.drift) svg.append(svgEl('rect', { x, y: yy, width: cellW, height: 20, fill: `url(#${cell.estimated ? 'dots' : 'stripes'})`, 'pointer-events': 'none', 'aria-hidden': 'true' }));
    });
  });
  const ticks = legendSteps(max, metric, values.some(v => v > max)), scale = document.getElementById('calendar-scale');
  scale.replaceChildren();
  ticks.forEach(step => { const mark = document.createElement('span'),swatch=document.createElement('i');swatch.className='scale-step';swatch.style.backgroundColor=step.color;mark.append(swatch,document.createTextNode(legendMark(step.value,metric,step.overflow)));scale.append(mark); });
  const table = document.createElement('table'), caption = document.createElement('caption'); caption.textContent = t('calendar.tableCaption'); table.append(caption);
  const head = table.createTHead().insertRow(); for (const h of [t('calendar.year'),...Array.from({length:12},(_,m)=>new Intl.DateTimeFormat(getLanguage()==='en'?'en-US':'es-MX',{month:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2000,m,1))).replace(/\.$/,''))]) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
  const body = table.createTBody(); model.forEach((row, y) => { const tr = body.insertRow(); const th = document.createElement('th'); th.scope = 'row'; th.textContent = 2000 + y; tr.append(th); row.forEach(cell => { const td = tr.insertCell(), btn = document.createElement('button'); btn.type = 'button'; btn.textContent = cell.display == null ? '×' : number(metric === 'count' ? Math.round(cell.display) : cell.display); btn.setAttribute('aria-label', describeCell(cell, metric)); btn.addEventListener('focus', () => select(cell)); btn.addEventListener('click', () => select(cell)); td.append(btn); }); });
  tableWrap.replaceChildren(table);
  document.getElementById('estimated-legend').hidden = !model.flat().some(c => c.estimated);
  document.getElementById('drift-legend').hidden = !model.flat().some(c => c.drift);
}
