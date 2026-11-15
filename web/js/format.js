export const number = value => value == null ? 'Sin dato' : new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(value);
export const percent = value => value == null ? 'Sin dato' : `${number(value * 100)} %`;
export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, m - 1, 1))).replace('.', '');
}
export const field = value => value == null ? '' : String(value);
