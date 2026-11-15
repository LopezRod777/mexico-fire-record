import { field } from './format.js';
export function escapeCsv(value) {
  const s = field(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export function buildCsv(id, series, harmonized) {
  const raw = series.regions[id], adjusted = harmonized.regions[id];
  const rows = ['mes,terra,aqua,snpp,armonizada,lo,hi,fuente,deriva'];
  series.months.forEach((month, i) => rows.push([month, raw.Terra[i], raw.Aqua[i], raw.SNPP[i], adjusted.valor[i], adjusted.lo[i], adjusted.hi[i], adjusted.fuente[i], adjusted.deriva[i] ? 1 : 0].map(escapeCsv).join(',')));
  return rows.join('\n') + '\n';
}
export function downloadCsv(id, series, harmonized) {
  const csv = '\ufeff' + buildCsv(id, series, harmonized);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `incendios_${id}_${series.months[0].replace('-', '')}-${series.months.at(-1).replace('-', '')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
