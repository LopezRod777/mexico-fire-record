import { VIEW, project, geometryToPath } from './geo.js';
import { number } from './format.js';

const NS = 'http:' + '//www.w3.org/2000/svg';
const LEVELS = { bajo:'▼ bajo', normal:'● normal', alto:'▲ alto', extraordinario:'▲▲ extraordinario', record:'★ récord' };
const METHODS = [
  'Datos casi en tiempo real (NRT) de VIIRS a bordo de NOAA-20 y NOAA-21, bajados de NASA FIRMS. No son de calidad científica y pueden cambiar.',
  "Se comparan contra la línea base de S-NPP 2012–2025 para el mismo día del año (ventana de ±3 días): 'normal' = entre el percentil 10 y el 90; 'alto' = sobre el 90; 'extraordinario' = sobre el 99; 'récord' = sobre el máximo histórico.",
  'Cada sensor se compara por separado y se promedia: NOAA-20 y NOAA-21 contaron casi igual que S-NPP en 20 días de marzo de 2025 (razones 1.02 y 1.00), pero esa comprobación cubre un solo mes.',
  'En esos 20 días, el conteo diario de NOAA-20 y NOAA-21 varió entre 0.80 y 1.23 veces el de S-NPP.',
  'S-NPP dejó de entregar datos el 2 de noviembre de 2026, por eso la comparación es contra su historial y no contra su dato de hoy.',
  'El rectángulo de consulta incluye partes de EE. UU. y del Golfo: aquí solo se muestran detecciones dentro de los 32 estados.'
];
export function ageHours(generado, now=Date.now()) { return Math.max(0,(new Date(now).getTime()-new Date(generado).getTime())/3600000); }
export function formatUtc(iso) {
  const parts=new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).formatToParts(new Date(iso));
  const get=type=>parts.find(part=>part.type===type)?.value??'';
  return `${get('day')} ${get('month').replace(/\.$/,'')} ${get('year')}, ${get('hour')}:${get('minute')} UTC`;
}
export function isStale(generado, now=Date.now()) { return ageHours(generado,now)>6; }
export function levelBadge(level) { return level == null ? 'Sin nivel' : LEVELS[level]; }
export function rankingComparison(item) { return `${number(item.celdas_dia)} celdas-día vs. mediana ${number(item.base_p50)} (p90: ${number(item.base_p90)})`; }
export function livePointRadius(width) { return Math.max(2.5, 3 * VIEW.width / width); }
function validRegion(v) { return v && typeof v==='object' && ['n20','n21','celdas_dia','base_p10','base_p50','base_p90','base_p99','base_max'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])) && Number.isInteger(v.n20)&&Number.isInteger(v.n21)&&[1,2].includes(v.sensores_usados)&&(v.nivel===null||Object.hasOwn(LEVELS,v.nivel)); }
export function validLiveSnapshot(d, stateIds) {
  if(!d||typeof d!=='object'||Array.isArray(d))return false;
  const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)&&Number.isFinite(Date.parse(v));
  if(!stamp(d.generado)||!stamp(d.ultima_deteccion_utc)||!Number.isInteger(d.ventana_horas)||!/^\d{4}-\d\d-\d\d$/.test(d.dia_comparado??'')||!Number.isInteger(d.doy)||!Array.isArray(d.fuentes)||!d.fuentes.every(x=>typeof x==='string')||typeof d.nota!=='string'||!Number.isInteger(d.descartadas_fuera_de_mexico)||!Number.isInteger(d.n_detecciones_24h)||!validRegion(d.nacional)||!d.estados||typeof d.estados!=='object'||!Array.isArray(d.detecciones))return false;
  if(stateIds.length!==32||Object.keys(d.estados).length!==32||!stateIds.every(id=>validRegion(d.estados[id])))return false;
  return d.detecciones.length===d.n_detecciones_24h&&d.detecciones.every(x=>x&&typeof x==='object'&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&/^\d{4}-\d\d-\d\d$/.test(x.fecha??'')&&/^\d\d:\d\d$/.test(x.hora_utc??'')&&['N20','N21'].includes(x.sat)&&(x.frp===null||Number.isFinite(x.frp))&&['l','n','h'].includes(x.conf)&&stateIds.includes(x.estado));
}
export function liveSummary(snapshot,names,now=Date.now()) {
  const ranking=Object.entries(snapshot.estados).filter(([,v])=>['alto','extraordinario','record'].includes(v.nivel)).map(([id,v])=>({id,name:names[id],...v,ratio:v.celdas_dia/Math.max(v.base_p50,1)})).sort((a,b)=>b.ratio-a.ratio||a.name.localeCompare(b.name,'es-MX')).slice(0,8);
  return {ageHours:ageHours(snapshot.generado,now),stale:isStale(snapshot.generado,now),nDetecciones:snapshot.n_detecciones_24h,nacional:snapshot.nacional,ranking};
}
function node(tag,className,text) { const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e; }
function svgNode(tag,attrs) { const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e; }
let resizeTimer;
let resizeBound=false;
function resizeLivePoints() {
  const svg=document.querySelector('#live-content svg');if(!svg)return;
  const width=svg.getBoundingClientRect().width;if(!width)return;
  const radius=livePointRadius(width);
  svg.querySelectorAll('circle').forEach(circle=>circle.setAttribute('r',String(radius)));
}
function onLiveResize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(resizeLivePoints,100);}
function renderLive(snapshot,names,geo) {
  const target=document.getElementById('live-content'),s=liveSummary(snapshot,names);
  const status=node('div','live-status');status.setAttribute('aria-live','polite');
  status.append(node('p','',`Captura: ${formatUtc(snapshot.generado)}`),node('p','',`Última detección: ${formatUtc(snapshot.ultima_deteccion_utc)}`));
  if(s.stale)status.append(node('p','live-stale',`Esta captura tiene ${Math.floor(s.ageHours)} h y no se actualiza sola.`));
  const stats=node('div','live-stats');[
    ['Detecciones en las últimas 24 h dentro de México',number(s.nDetecciones)],
    ['Nivel nacional del día comparado',levelBadge(s.nacional.nivel)],
    [`Celdas-día de ${snapshot.dia_comparado}`,`${number(s.nacional.celdas_dia)} (mediana histórica para esa fecha: ${number(s.nacional.base_p50)})`]
  ].forEach(([label,value],i)=>{const card=node('div','live-stat');card.append(node('span','',label),node('strong',i===1?`live-level level-${s.nacional.nivel??'none'}`:'',value));stats.append(card);});
  const frame=node('div','live-map-frame'),svg=svgNode('svg',{viewBox:`0 0 ${VIEW.width} ${VIEW.height}`,role:'img','aria-labelledby':'live-map-title live-map-desc'});
  const title=svgNode('title',{id:'live-map-title'});title.textContent='Detecciones recientes en México';const desc=svgNode('desc',{id:'live-map-desc'});desc.textContent='Contorno de los estados de México con puntos sólidos para NOAA-20 y anillos para NOAA-21.';svg.append(title,desc);
  geo.features.forEach(f=>svg.append(svgNode('path',{d:geometryToPath(f.geometry),class:'live-outline'})));
  snapshot.detecciones.forEach(d=>{const [cx,cy]=project(d.lon,d.lat);svg.append(svgNode('circle',{cx,cy,r:2.5,class:d.sat==='N20'?'live-n20':'live-n21','vector-effect':'non-scaling-stroke'}));});frame.append(svg);
  if(!resizeBound){window.addEventListener('resize',onLiveResize);resizeBound=true;}
  const legend=node('div','live-legend');legend.append(node('span','','● NOAA-20'),node('span','','○ NOAA-21'));
  const ranking=node('div','live-ranking');if(!s.ranking.length)ranking.append(node('p','','Ningún estado supera lo normal (p90) para esta fecha.'));
  else {const list=node('ol','live-rank-list');s.ranking.forEach(item=>{const row=node('li','live-rank-row');row.append(node('strong','',item.name),node('span','',rankingComparison(item)),node('span',`live-level level-${item.nivel}`,levelBadge(item.nivel)));list.append(row);});ranking.append(list);}
  ranking.append(node('p','live-ranking-note','Con pocas celdas-día (menos de 20) la comparación es ruidosa: un estado puede salir \'alto\' o \'bajo\' por unas cuantas detecciones o por nubes. Sin detección no significa sin fuego.'));
  const method=node('div','live-method');METHODS.forEach(t=>method.append(node('p','',t)));
  target.replaceChildren(status,stats,node('h3','','Detecciones de las últimas 24 h'),frame,legend,node('h3','','Estados por encima de lo normal'),ranking,method);
  resizeLivePoints();
}
export async function loadLive(names,geo) {
  const target=document.getElementById('live-content');
  try {const response=await fetch('data/live_snapshot.json');if(!response.ok)throw new Error('No disponible');const data=await response.json();if(!validLiveSnapshot(data,Object.keys(names).filter(id=>id!=='MX')))throw new Error('Snapshot inválido');renderLive(data,names,geo);}
  catch {target.textContent='La capa casi en vivo no está disponible en esta versión.';}
}
