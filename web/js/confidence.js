import { number, percent } from './format.js';
export function confidenceText(id, harmonized) {
  const v = harmonized.regions[id].validation['aqua->snpp'], summary = harmonized.validation_resumen['aqua->snpp'];
  if (!v || v.insuficiente) return 'No hay suficientes meses para validar esta región.';
  let text = `Si solo hubiéramos tenido Aqua, habríamos estimado S-NPP con un error mediano de ${percent(v.mape_razon_mensual)} por mes (${percent(v.mape_razon_global)} con un factor único). Mediana entre estados: ${percent(summary.mediana_mape_razon_mensual)}. Se evaluaron ${number(v.n_meses)} meses.`;
  if (id === 'MX') text += ` El error nacional es menor porque se promedian 32 estados; por estado el error mediano es ${percent(summary.mediana_mape_razon_mensual)}.`;
  return text;
}
export function renderConfidence(id, harmonized) {
  const root = document.getElementById('confidence-content'), v = harmonized.regions[id].validation['aqua->snpp'], s = harmonized.validation_resumen['aqua->snpp']; root.replaceChildren();
  if (!v || v.insuficiente) { root.textContent = confidenceText(id,harmonized); return; }
  const stats = document.createElement('div'); stats.className='stats';
  for (const [label,value] of [['Error mensual',percent(v.mape_razon_mensual)],['Factor único',percent(v.mape_razon_global)],['Mediana estatal',percent(s.mediana_mape_razon_mensual)],['Meses evaluados',number(v.n_meses)]]) {
    const item=document.createElement('div');item.className='stat';const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;item.append(strong,span);stats.append(item);
  }
  const p=document.createElement('p');p.textContent=confidenceText(id,harmonized);root.append(stats,p);
}
