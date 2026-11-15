import { t, formatNumber, getLanguage } from './i18n.js';
export const number = value => value == null ? t('common.noData') : formatNumber(value);
export const integer = value => value == null ? t('common.noData') : formatNumber(Math.round(value), 0);
export const percent = value => value == null ? t('common.noData') : `${number(value * 100)} %`;
export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-US' : 'es-MX', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, m - 1, 1))).replace('.', '');
}
export const field = value => value == null ? '' : String(value);
