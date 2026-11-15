import { integer, percent } from './format.js';
import { t, getLanguage } from './i18n.js';
import { PALETTE } from './colors.js';

export function daysOf2005(harmonized) {
  const months=harmonized.months, values=harmonized.regions.MX.valor;
  const rows=months.map((month,i)=>({month,value:values[i]})).filter(row=>row.month.startsWith('2005-')&&Number.isFinite(row.value));
  const byMonth=new Map(rows.map(row=>[row.month,row.value]));
  return {march:byMonth.get('2005-03'),may:byMonth.get('2005-05'),highest:rows.reduce((a,b)=>!a||b.value>a.value?b:a,null)};
}
export function monthStory(harmonized) {
  const d=daysOf2005(harmonized);
  if(!Number.isFinite(d.march)||!Number.isFinite(d.may)||!d.highest)return t('days.unavailable');
  const month=new Intl.DateTimeFormat(getLanguage()==='en'?'en-US':'es-MX',{month:'long',timeZone:'UTC'}).format(new Date(`${d.highest.month}-01T00:00:00Z`));
  return t(['2005-03','2005-05'].includes(d.highest.month)?'days.storyCompared':'days.story',{march:integer(d.march),may:integer(d.may),month,highest:integer(d.highest.value)});
}
export function daysFigure(harmonized) {
  const may=daysOf2005(harmonized).may;
  return Number.isFinite(may)?integer(may):t('common.noData');
}
export function harmonizedMethod(harmonized) {
  if(!Object.hasOwn(harmonized.validation_resumen,'union->snpp'))return null;
  const error=harmonized.validation_resumen['terra->snpp']?.mediana_mape_razon_mensual;
  return t('method.harmonized',{error:Number.isFinite(error)?t('method.harmonizedError',{value:percent(error)}):''});
}
export function legendSteps(max,metric,overflow=false){
  return PALETTE.map((color,i)=>({color,value:metric==='count'?Math.round(max*(i/(PALETTE.length-1))**2):max*i/(PALETTE.length-1),overflow:overflow&&i===PALETTE.length-1}));
}
