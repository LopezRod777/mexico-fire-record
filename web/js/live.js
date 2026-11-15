import { VIEW, project, geometryToPath } from './geo.js';
import { number } from './format.js';
import { flameHeight, ensureFlameDefs } from './flame.js';
import { animateLive } from './motion.js';
import { t, formatDate, regionName } from './i18n.js';
export { flameHeight } from './flame.js';

const NS = 'http:' + '//www.w3.org/2000/svg';
const LEVELS = { bajo:1, normal:1, alto:1, extraordinario:1, record:1 };
export function ageHours(generado, now=Date.now()) { return Math.max(0,(new Date(now).getTime()-new Date(generado).getTime())/3600000); }
export function formatUtc(iso) {
  return formatDate(iso);
}
export function isStale(generado, now=Date.now()) { return ageHours(generado,now)>6; }
export function levelBadge(level) { return t(`live.level.${level ?? 'none'}`); }
export function rankingComparison(item) { return t('live.rankingComparison',{cells:number(item.celdas_dia),median:number(item.base_p50),p90:number(item.base_p90)}); }
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
  const ranking=Object.entries(snapshot.estados).filter(([,v])=>['alto','extraordinario','record'].includes(v.nivel)).map(([id,v])=>({id,name:regionName(id,names),...v,ratio:v.celdas_dia/Math.max(v.base_p50,1)})).sort((a,b)=>b.ratio-a.ratio||a.name.localeCompare(b.name,'es-MX')).slice(0,8);
  return {ageHours:ageHours(snapshot.generado,now),stale:isStale(snapshot.generado,now),nDetecciones:snapshot.n_detecciones_24h,nacional:snapshot.nacional,ranking};
}
function node(tag,className,text) { const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e; }
function svgNode(tag,attrs) { const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e; }
let resizeTimer;
let resizeBound=false;
function resizeLiveFlames() {
  const svg=document.querySelector('#live-content .live-map-frame svg');if(!svg)return;
  const width=svg.getBoundingClientRect().width;if(!width)return;
  svg.querySelectorAll('use[data-frp]').forEach(flame=>{
    const h=Math.max(12,flameHeight(Number(flame.dataset.frp))) * VIEW.width / width;
    flame.setAttribute('transform',`translate(${flame.dataset.x} ${flame.dataset.y}) scale(${h/28}) translate(-10 -28)`);
  });
}
function onLiveResize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(resizeLiveFlames,100);}
function renderLive(snapshot,names,geo) {
  const target=document.getElementById('live-content'),s=liveSummary(snapshot,names);
  const status=node('div','live-status');status.setAttribute('aria-live','polite');
  status.append(node('p','',t('live.capture',{date:formatUtc(snapshot.generado)})),node('p','',t('live.last',{date:formatUtc(snapshot.ultima_deteccion_utc)})));
  if(s.stale)status.append(node('p','live-stale',t('live.stale',{hours:Math.floor(s.ageHours)})));
  const stats=node('div','live-stats');[
    [t('live.detected'),number(s.nDetecciones)],
    [t('live.national'),levelBadge(s.nacional.nivel)],
    [t('live.cells',{date:snapshot.dia_comparado}),number(s.nacional.celdas_dia)]
  ].forEach(([label,value],i)=>{const card=node('div','live-stat');const name=node('span','',label),amount=node('strong',i===1?`live-level level-${s.nacional.nivel??'none'}`:'',value);card.append(...(i===0?[amount,name]:[name,amount]));if(i===2)card.append(node('span','live-median-context',t('live.medianContext',{median:number(s.nacional.base_p50)})));stats.append(card);});
  const frame=node('div','live-map-frame'),svg=svgNode('svg',{viewBox:`0 0 ${VIEW.width} ${VIEW.height}`,role:'img','aria-labelledby':'live-map-title live-map-desc'});
  const title=svgNode('title',{id:'live-map-title'});title.textContent=t('live.mapTitle');const desc=svgNode('desc',{id:'live-map-desc'});desc.textContent=t('live.mapDesc');svg.append(title,desc);
  ensureFlameDefs();
  geo.features.forEach(f=>svg.append(svgNode('path',{d:geometryToPath(f.geometry),class:'live-outline'})));
  snapshot.detecciones.slice().sort((a,b)=>(a.frp??0)-(b.frp??0)).forEach(d=>{const [x,y]=project(d.lon,d.lat),use=svgNode('use',{href:'#flame',class:`live-flame ${d.sat==='N20'?'live-n20':'live-n21'} ${d.frp==null||d.frp<5?'flame-low':d.frp<15?'flame-mid':'flame-high'}`});use.dataset.frp=String(d.frp??0);use.dataset.x=String(x);use.dataset.y=String(y);svg.append(use);});frame.append(svg);
  if(!resizeBound){window.addEventListener('resize',onLiveResize);resizeBound=true;}
  const legend=node('div','live-legend');for(const [sat,label] of [['live-n20','NOAA-20'],['live-n21','NOAA-21']]){const item=node('span','');const icon=svgNode('svg',{viewBox:'0 0 20 28','aria-hidden':'true'});icon.append(svgNode('use',{href:'#flame',class:`live-flame ${sat} flame-mid`}));item.append(icon,document.createTextNode(label));legend.append(item);}legend.append(node('p','live-legend-note',t('live.flameNote')));
  const detectionTable=node('div','live-detections');const detectionButton=node('button','secondary',t('live.showDetections',{shown:Math.min(snapshot.detecciones.length,50),total:snapshot.detecciones.length}));detectionButton.type='button';detectionButton.setAttribute('aria-expanded','false');detectionTable.append(detectionButton);const table=node('table');table.hidden=true;table.append(node('caption','',t('live.tableCaption')));const header=table.createTHead().insertRow();for(const key of ['state','sensor','dateUtc','frp'])header.append(node('th','',t(`live.${key}`)));const body=table.createTBody();snapshot.detecciones.slice().sort((a,b)=>(b.frp??0)-(a.frp??0)).slice(0,50).forEach(d=>{const row=body.insertRow();for(const value of [regionName(d.estado,names),d.sat,`${d.fecha} ${d.hora_utc}`,d.frp==null?t('common.noData'):number(d.frp)])row.append(node('td','',value));});detectionTable.append(table);detectionButton.addEventListener('click',()=>{table.hidden=!table.hidden;detectionButton.setAttribute('aria-expanded',String(!table.hidden));});
  const ranking=node('div','live-ranking');if(!s.ranking.length)ranking.append(node('p','',t('live.noElevated')));
  else {const list=node('ol','live-rank-list');s.ranking.forEach(item=>{const row=node('li','live-rank-row');row.append(node('strong','',item.name),node('span','',rankingComparison(item)),node('span',`live-level level-${item.nivel}`,levelBadge(item.nivel)));list.append(row);});ranking.append(list);}
  ranking.append(node('p','live-ranking-note',t('live.rankNote')));
  const method=node('div','live-method');for(let i=1;i<=6;i++)method.append(node('p','',t(`live.method.${i}`)));
  const top=node('div','live-top');top.append(stats,status);const mapBlock=node('div','live-map-block');mapBlock.append(frame,legend);const hero=node('div','live-hero');hero.append(top,mapBlock);target.replaceChildren(hero,detectionTable,node('h3','',t('live.rankTitle')),ranking,method);
  resizeLiveFlames();animateLive();
}
export async function loadLive(names,geo) {
  const target=document.getElementById('live-content');
  let staleMessage=null;
  try {const response=await fetch('data/live_snapshot.json');if(!response.ok)throw new Error();const data=await response.json();if(!validLiveSnapshot(data,Object.keys(names).filter(id=>id!=='MX')))throw new Error();if(isStale(data.generado)){staleMessage=t('live.stale',{hours:Math.floor(ageHours(data.generado))});throw new Error();}renderLive(data,names,geo);}
  catch {const note=node('p','live-stale',staleMessage??t('live.unavailable'));const mini=node('div','calendar-mini');const source=document.getElementById('calendar-svg');if(source){const clone=source.cloneNode(true);clone.removeAttribute('id');clone.removeAttribute('aria-labelledby');clone.setAttribute('aria-hidden','true');clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));mini.append(clone);}const link=node('a','',t('live.explore'));link.href='#calendario';target.replaceChildren(note,mini,link);}
}
