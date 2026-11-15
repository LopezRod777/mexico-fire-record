import { number, percent } from './format.js';
import { quantile } from './colors.js';
import { t, regionName } from './i18n.js';

export function methodKey(harmonized) {
  return Object.hasOwn(harmonized.validation_resumen, 'union->snpp') ? 'union->snpp' : 'aqua->snpp';
}
export function errorStrip(harmonized, names = {}) {
  const key = methodKey(harmonized);
  const rows = Object.entries(harmonized.regions).filter(([id]) => id !== 'MX').map(([id, region]) => ({id, name:regionName(id,names), value:region.validation?.[key]?.mape_razon_mensual})).filter(row => Number.isFinite(row.value)).sort((a,b) => a.value-b.value || a.name.localeCompare(b.name,'es-MX'));
  const values = rows.map(row => row.value);
  return {key, rows, min:rows[0], max:rows.at(-1), p25:quantile(values,.25), median:harmonized.validation_resumen[key].mediana_mape_razon_mensual ?? quantile(values,.5), p75:quantile(values,.75)};
}
export function confidenceText(id, harmonized) {
  const key = methodKey(harmonized), v = harmonized.regions[id].validation[key], summary = harmonized.validation_resumen[key];
  if (!v || v.insuficiente) return t('confidence.insufficient');
  let text = t('confidence.text',{method:key,monthly:percent(v.mape_razon_mensual),global:percent(v.mape_razon_global),median:percent(summary.mediana_mape_razon_mensual),months:number(v.n_meses)});
  if (id === 'MX') text += t('confidence.nationalReason');
  return text;
}
function node(tag, className, value) { const el=document.createElement(tag); if(className)el.className=className; if(value!=null)el.textContent=value; return el; }
export function renderConfidence(id, harmonized, names={}) {
  const root=document.getElementById('confidence-content'), strip=errorStrip(harmonized,names), v=harmonized.regions[id].validation[strip.key];
  root.replaceChildren();
  if(!strip.rows.length || !v) {root.textContent=t('confidence.insufficient');return;}
  const intro=node('div','confidence-intro');
  const lead=node('div','confidence-lead');lead.append(node('strong','confidence-number',percent(strip.median)));
  lead.append(node('p','',t('confidence.lead',{median:number(strip.median*100),min:number(strip.min.value*100),max:number(strip.max.value*100)})));
  intro.append(lead,node('p','confidence-national',t('confidence.national',{value:percent(harmonized.regions.MX.validation[strip.key]?.mape_razon_mensual)})));
  const axis=node('div','error-axis');axis.setAttribute('role','img');axis.setAttribute('aria-label',t('confidence.axis',{median:percent(strip.median),minName:strip.min.name,min:percent(strip.min.value),maxName:strip.max.name,max:percent(strip.max.value)}));
  const band=node('div','error-band');band.style.left=`${strip.p25/.6*100}%`;band.style.width=`${(strip.p75-strip.p25)/.6*100}%`;axis.append(band);
  strip.rows.forEach(row=>{const mark=node('span',`error-mark${row.id===id?' is-selected':''}`);mark.style.left=`${Math.min(row.value/.6,1)*100}%`;mark.title=`${row.name}: ${percent(row.value)}`;axis.append(mark);});
  const median=node('span','error-median','▲');median.style.left=`${strip.median/.6*100}%`;axis.append(median);
  const labels=node('div','error-labels');labels.append(node('span','','0 %'),node('span','',t('confidence.medianLabel',{value:percent(strip.median)})),node('span','','60 %'));
  const extremes=node('p','error-extremes',t('confidence.axis',{median:percent(strip.median),minName:strip.min.name,min:percent(strip.min.value),maxName:strip.max.name,max:percent(strip.max.value)}));
  const tableWrap=node('details','error-table');const summary=node('summary','',t('confidence.tableToggle'));tableWrap.append(summary,extremes);
  const table=node('table'), caption=node('caption','',t('confidence.tableCaption'));table.append(caption);const head=table.createTHead().insertRow();for(const name of [t('confidence.state'),t('confidence.monthlyError')])head.append(node('th','',name));const body=table.createTBody();strip.rows.forEach(row=>{const tr=body.insertRow();tr.append(node('th','',row.name),node('td','',percent(row.value)));if(row.id===id)tr.className='is-selected';});tableWrap.append(table);
  root.append(intro,axis,labels,tableWrap);
}
