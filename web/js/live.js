import { VIEW, project, geometryToPath } from './geo.js';
import { number } from './format.js';
import { ensureFlameDefs } from './flame.js';
import { animateLive } from './motion.js';
import { t, formatDate, formatDay, formatClock, regionName } from './i18n.js';
import { FRP_CUTS, frpClass, clusterHeight, clusterDetections, clusterAttrs, detectionTime, satellitePasses, replayTime, passAt, modisProbabilities, modisExpected } from './replay.js';
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
const SAT_NAMES={N20:'NOAA-20',N21:'NOAA-21'};
const REPLAY_MS=24000,HOLD_MS=3000;
const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
let resizeTimer;
let resizeBound=false;
let replay=null;
function legendFlame(height,className) { const icon=svgNode('svg',{viewBox:'0 0 20 28',width:(height*20/28).toFixed(1),height,'aria-hidden':'true'});icon.append(svgNode('use',{href:'#flame',class:`live-flame ${className}`}));return icon; }
function legendGroup(title,items) { const group=node('div','live-legend-group');group.append(node('p','live-legend-title',title));const list=node('ul','live-legend-list');for(const [icon,label] of items){const li=node('li','live-legend-item');li.append(icon,node('span','',label));list.append(li);}group.append(list);return group; }
function clusterTitle(c,dets) {
  const n20=c.members.filter(i=>dets[i].sat==='N20').length;
  return t(c.n===1?'live.clusterTitleOne':'live.clusterTitle',{n:number(c.n),frp:number(c.frpMax),n20:number(n20),n21:number(c.n-n20)});
}
function stopReplay(){ if(!replay)return; cancelAnimationFrame(replay.raf); replay.observer?.disconnect(); replay=null; }
// Reproducción de las últimas 24 h: cada grupo se enciende en el minuto real de su primera
// detección y crece con las siguientes. Solo cambia transform y opacity.
function startReplay(ui,dets,passes) {
  stopReplay();
  const order=dets.map((d,i)=>i).sort((a,b)=>dets[a].time-dets[b].time||a-b);
  const first=dets[order[0]]?.time??0,last=dets[order.at(-1)]?.time??0;
  const r={raf:0,playhead:0,lastNow:null,userPaused:reducedMotion(),hoverPaused:false,inView:false,once:false,pointer:0,modis:false,clusters:[],memberOf:[],k:1};
  replay=r;
  const clock=time=>{const pass=passAt(passes,time);ui.clockTime.textContent=formatClock(new Date(time).toISOString());ui.clockPass.textContent=pass?t('live.pass',{sat:SAT_NAMES[pass.sat]??pass.sat,time:new Date(pass.start).toISOString().slice(11,16)}):'';};
  function paint(c) {
    const s=c.state,a=clusterAttrs(c,clusterHeight(Math.max(1,s.n)),r.k);
    c.flame.setAttribute('transform',a.flame.transform);
    c.flame.setAttribute('class',`live-flame ${s.n21>s.n20?'live-n21':'live-n20'} ${frpClass(s.frpMax)}`);
    c.count.setAttribute('transform',a.count.transform);c.count.textContent=s.n>=3?number(s.n):'';
  }
  function fire(i,animate) {
    const c=r.clusters[r.memberOf[i]],d=dets[i],s=c.state;
    s.n++;if(d.sat==='N21')s.n21++;else s.n20++;s.frpMax=Math.max(s.frpMax,Number.isFinite(d.frp)?d.frp:0);
    paint(c);
    if(!s.shown){s.shown=true;c.ignite.setAttribute('opacity','1');if(animate)c.ignite.animate([{opacity:0,transform:'scale(.2)'},{opacity:1,transform:'scale(1)'}],{duration:450,easing:'cubic-bezier(.22,1,.36,1)'});}
  }
  function reset() { r.pointer=0; for(const c of r.clusters){c.state={n:0,n20:0,n21:0,frpMax:0,shown:false};c.ignite.setAttribute('opacity','0');c.count.textContent='';} }
  function seek(time,animate) { while(r.pointer<order.length&&dets[order[r.pointer]].time<=time)fire(order[r.pointer++],animate); clock(time); }
  function applyModis() {
    for(const c of r.clusters){if(r.modis){const p=c.members.reduce((sum,i)=>sum+dets[i].p,0)/c.members.length;c.group.setAttribute('opacity',p.toFixed(3));}else c.group.removeAttribute('opacity');}
  }
  function build() {
    const width=ui.svg.getBoundingClientRect().width;if(!width)return false;
    r.k=VIEW.width/width;
    ui.svg.querySelector('.live-clusters')?.remove();
    const layer=svgNode('g',{class:'live-clusters'});
    r.clusters=clusterDetections(dets,r.k);r.memberOf=[];
    r.clusters.forEach((c,ci)=>{
      c.members.forEach(i=>{r.memberOf[i]=ci;});
      const a=clusterAttrs(c,clusterHeight(c.n),r.k),label=clusterTitle(c,dets);
      c.group=svgNode('g',{class:'live-cluster',...a.position,tabindex:0,role:'img','aria-label':label});
      const title=svgNode('title',{});title.textContent=label;
      c.ignite=svgNode('g',a.ignite);c.flame=svgNode('use',{href:'#flame',class:'live-flame'});
      c.count=svgNode('text',{class:'live-count','font-size':(13*r.k).toFixed(2),'stroke-width':(3*r.k).toFixed(2),'aria-hidden':'true'});
      c.ignite.append(c.flame,c.count);c.group.append(title,c.ignite);layer.append(c.group);
    });
    ui.svg.append(layer);
    reset();applyModis();
    return true;
  }
  const running=()=>!r.userPaused&&!r.hoverPaused&&r.inView;
  function updateButton(){ui.play.textContent=t(r.userPaused?'live.play':'live.pause');ui.play.setAttribute('aria-pressed',String(!r.userPaused));}
  function frame(now) {
    r.raf=0;if(!running()){r.lastNow=null;return;}
    if(r.lastNow!=null)r.playhead+=Math.min(100,now-r.lastNow);r.lastNow=now;
    if(r.playhead<=REPLAY_MS)seek(replayTime(r.playhead/REPLAY_MS,first,last),true);
    else if(r.playhead<=REPLAY_MS+HOLD_MS)seek(last,true);
    else if(r.once){r.once=false;r.userPaused=true;r.playhead=REPLAY_MS+HOLD_MS;updateButton();return;}
    else{reset();r.playhead=0;seek(first,true);}
    r.raf=requestAnimationFrame(frame);
  }
  function kick(){if(running()&&!r.raf){r.lastNow=null;r.raf=requestAnimationFrame(frame);}}
  r.rebuild=()=>{const at=r.playhead<=REPLAY_MS?replayTime(r.playhead/REPLAY_MS,first,last):last;if(build())seek(at,false);};
  if(!build())return;
  if(r.userPaused){r.playhead=REPLAY_MS+HOLD_MS;seek(last,false);}else seek(first,false);
  updateButton();
  ui.play.addEventListener('click',()=>{
    r.userPaused=!r.userPaused;
    if(!r.userPaused&&r.playhead>=REPLAY_MS+HOLD_MS){reset();r.playhead=0;r.once=reducedMotion();}
    updateButton();kick();
  });
  ui.frame.addEventListener('pointerenter',()=>{r.hoverPaused=true;});
  ui.frame.addEventListener('pointerleave',()=>{r.hoverPaused=false;kick();});
  ui.frame.addEventListener('focusin',()=>{r.hoverPaused=true;});
  ui.frame.addEventListener('focusout',()=>{r.hoverPaused=false;kick();});
  if(ui.modis)ui.modis.addEventListener('click',()=>{r.modis=!r.modis;ui.modis.setAttribute('aria-pressed',String(r.modis));ui.modisResult.hidden=!r.modis;applyModis();});
  r.observer=new IntersectionObserver(entries=>{for(const e of entries)r.inView=e.isIntersecting;kick();},{threshold:.2});
  r.observer.observe(ui.frame);
}
function onLiveResize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>replay?.rebuild(),100);}
function renderLive(snapshot,names,geo,health) {
  const target=document.getElementById('live-content'),s=liveSummary(snapshot,names);
  const status=node('p','live-status',`${t('live.capture',{date:formatUtc(snapshot.generado)})} · ${t('live.last',{date:formatUtc(snapshot.ultima_deteccion_utc)})}`);status.setAttribute('aria-live','polite');
  const stats=node('div','live-stats');[
    [t('live.detected'),number(s.nDetecciones)],
    [t('live.cells',{date:formatDay(snapshot.dia_comparado)}),number(s.nacional.celdas_dia)],
    [t('live.national'),levelBadge(s.nacional.nivel)]
  ].forEach(([label,value],i)=>{const card=node('div',i===0?'live-stat live-stat-lead':'live-stat');card.append(node('strong',i===2?`live-level level-${s.nacional.nivel??'none'}`:'',value),node('span','live-stat-label',label));if(i===1)card.append(node('span','live-median-context',t('live.medianContext',{median:number(s.nacional.base_p50)})));stats.append(card);});
  const top=node('div','live-top');top.append(stats,status);
  if(s.stale)top.append(node('p','live-stale',t('live.stale',{hours:Math.floor(s.ageHours)})));
  const frame=node('div','live-map-frame'),svg=svgNode('svg',{viewBox:`0 0 ${VIEW.width} ${VIEW.height}`,role:'group','aria-labelledby':'live-map-title live-map-desc'});
  const title=svgNode('title',{id:'live-map-title'});title.textContent=t('live.mapTitle');const desc=svgNode('desc',{id:'live-map-desc'});desc.textContent=t('live.mapDesc');svg.append(title,desc);
  ensureFlameDefs();
  geo.features.forEach(f=>svg.append(svgNode('path',{d:geometryToPath(f.geometry),class:'live-outline'})));
  frame.append(svg);
  const overlap=health?.mx?.overlap_probability;
  const probabilities=Array.isArray(overlap)?modisProbabilities(snapshot.detecciones,overlap):[];
  const expected=modisExpected(probabilities);
  const dets=snapshot.detecciones.map((d,i)=>{const [x,y]=project(d.lon,d.lat);return {x,y,frp:d.frp,sat:d.sat,time:detectionTime(d),p:probabilities[i]??1};});
  const bar=node('div','live-map-bar');
  const clockText=node('p','live-clock'),clockTime=node('span','live-clock-time'),clockPass=node('span','live-clock-pass');clockText.append(clockTime,clockPass);
  const controls=node('div','live-controls');
  const play=node('button','live-play');play.type='button';controls.append(play);
  let modis=null,modisResult=null;
  if(expected!=null){
    modis=node('button','live-modis-toggle',t('live.modisToggle'));modis.type='button';modis.setAttribute('aria-pressed','false');controls.append(modis);
    modisResult=node('div','live-modis');modisResult.hidden=true;modisResult.setAttribute('aria-live','polite');
    modisResult.append(node('p','live-modis-figure',t('live.modisResult',{n:number(expected),total:number(snapshot.detecciones.length)})),node('p','live-modis-note',t('live.modisNote')));
  }
  bar.append(clockText,controls);
  if(!resizeBound){window.addEventListener('resize',onLiveResize);resizeBound=true;}
  const legend=node('div','live-legend');
  legend.append(
    legendGroup(t('live.legendShape'),[[legendFlame(21,'live-n20 flame-mid'),'NOAA-20'],[legendFlame(21,'live-n21 flame-mid'),'NOAA-21']]),
    legendGroup(t('live.legendColor'),[[legendFlame(21,'live-n20 flame-low'),t('live.frpLow',{a:FRP_CUTS[0]})],[legendFlame(21,'live-n20 flame-mid'),t('live.frpMid',{a:FRP_CUTS[0],b:FRP_CUTS[1]})],[legendFlame(21,'live-n20 flame-high'),t('live.frpHigh',{b:FRP_CUTS[1]})]]),
    legendGroup(t('live.legendSize'),[1,5,20].map(n=>[legendFlame(clusterHeight(n),'live-n20 flame-mid'),t(n===1?'live.sizeOne':'live.sizeMany',{n:number(n)})])),
    node('p','live-legend-note',t('live.flameNote')));
  const detectionTable=node('div','live-detections');const detectionButton=node('button','secondary',t('live.showDetections',{shown:Math.min(snapshot.detecciones.length,50),total:snapshot.detecciones.length}));detectionButton.type='button';detectionButton.setAttribute('aria-expanded','false');detectionTable.append(detectionButton);const table=node('table');table.hidden=true;table.append(node('caption','',t('live.tableCaption')));const header=table.createTHead().insertRow();for(const key of ['state','sensor','dateUtc','frp'])header.append(node('th','',t(`live.${key}`)));const body=table.createTBody();snapshot.detecciones.slice().sort((a,b)=>(b.frp??0)-(a.frp??0)).slice(0,50).forEach(d=>{const row=body.insertRow();for(const value of [regionName(d.estado,names),d.sat,`${d.fecha} ${d.hora_utc}`,d.frp==null?t('common.noData'):number(d.frp)])row.append(node('td','',value));});detectionTable.append(table);detectionButton.addEventListener('click',()=>{table.hidden=!table.hidden;detectionButton.setAttribute('aria-expanded',String(!table.hidden));});
  const ranking=node('div','live-ranking');ranking.append(node('h3','',t('live.rankTitle')));if(!s.ranking.length)ranking.append(node('p','',t('live.noElevated')));
  else {const list=node('ol','live-rank-list');s.ranking.forEach(item=>{const row=node('li','live-rank-row');row.append(node('strong','',item.name),node('span','',rankingComparison(item)),node('span',`live-level level-${item.nivel}`,levelBadge(item.nivel)));list.append(row);});ranking.append(list);}
  ranking.append(node('p','live-ranking-note',t('live.rankNote')));
  const method=node('details','live-method');method.append(node('summary','',t('live.methodTitle')));for(let i=1;i<=6;i++)method.append(node('p','',t(`live.method.${i}`)));
  const after=node('div','live-after');after.append(ranking,detectionTable,method);
  const mapBlock=node('div','live-map-block');mapBlock.append(bar,frame);if(modisResult)mapBlock.append(modisResult);mapBlock.append(legend);
  const hero=node('div','live-hero');hero.append(top,mapBlock);target.replaceChildren(hero,after);
  startReplay({svg,frame,play,modis,modisResult,clockTime,clockPass},dets,satellitePasses(snapshot.detecciones));
  animateLive();
}
export async function loadLive(names,geo,health) {
  const target=document.getElementById('live-content');
  let staleMessage=null;
  try {const response=await fetch('data/live_snapshot.json');if(!response.ok)throw new Error();const data=await response.json();if(!validLiveSnapshot(data,Object.keys(names).filter(id=>id!=='MX')))throw new Error();if(isStale(data.generado)){staleMessage=t('live.stale',{hours:Math.floor(ageHours(data.generado))});throw new Error();}renderLive(data,names,geo,health);}
  catch {stopReplay();const note=node('p','live-stale',staleMessage??t('live.unavailable'));const mini=node('div','calendar-mini');const source=document.getElementById('calendar-svg');if(source){const clone=source.cloneNode(true);clone.removeAttribute('id');clone.removeAttribute('aria-labelledby');clone.setAttribute('aria-hidden','true');clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));mini.append(clone);}const link=node('a','',t('live.explore'));link.href='#calendario';target.replaceChildren(note,mini,link);}
}
