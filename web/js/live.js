import { VIEW, project, unproject, geometryToPath } from './geo.js';
import { number } from './format.js';
import { ensureFlameDefs } from './flame.js';
import { t, formatDate, formatDay, formatClock, formatLocalTime, formatUtcTime, regionName } from './i18n.js';
import { clusterSummary, worldviewUrl, zoomBox } from './nearby.js';
import { predictPasses, firstPass, CENTER_MX } from './passes.js';
import { buildFireBlock } from './fire.js';
import { FRP_CUTS, frpClass, clusterHeight, clusterDetections, clusterAttrs, detectionTime, satellitePasses, modisProbabilities, modisExpected, modisSelection, timelineBins, timelineFraction, timelineSeek, timelineKey, replaySchedule, scheduleTime, scheduleProgress, passNow } from './replay.js';
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
// Antigüedad en horas (menos de 48 h) o en días, para el aviso de captura vieja.
export function ageText(hours) { const h=Math.floor(hours);if(h<48)return t('live.ageHours',{n:number(h)});return t('live.ageDays',{n:number(Math.floor(h/24))}); }
export function staleNotice(generado,now=Date.now()) { return isStale(generado,now)?t('live.stale',{date:formatUtc(generado),age:ageText(ageHours(generado,now))}):null; }
// Qué muestra "Hoy": todo si el archivo es válido (con aviso si tiene más de 6 h); la vista de
// "no disponible" solo cuando falta o no cumple el contrato.
export function liveView(data,stateIds,now=Date.now()) { return validLiveSnapshot(data,stateIds)?{mode:'full',notice:staleNotice(data.generado,now)}:{mode:'unavailable',notice:null}; }
export function liveSummary(snapshot,names,now=Date.now()) {
  const ranking=Object.entries(snapshot.estados).filter(([,v])=>['alto','extraordinario','record'].includes(v.nivel)).map(([id,v])=>({id,name:regionName(id,names),...v,ratio:v.celdas_dia/Math.max(v.base_p50,1)})).sort((a,b)=>b.ratio-a.ratio||a.name.localeCompare(b.name,'es-MX')).slice(0,8);
  return {ageHours:ageHours(snapshot.generado,now),stale:isStale(snapshot.generado,now),nDetecciones:snapshot.n_detecciones_24h,nacional:snapshot.nacional,ranking};
}
function node(tag,className,text) { const e=document.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e; }
function svgNode(tag,attrs) { const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e; }
const SAT_NAMES={N20:'NOAA-20',N21:'NOAA-21'};
const REPLAY_MS=24000,HOLD_MS=3500,FRESH_MS=2200;
const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const hhmm=time=>new Date(time).toISOString().slice(11,16);
let resizeTimer;
let resizeBound=false;
let replay=null;
// Punto y modo "elegir en el mapa" de "Vi un fuego": sobreviven al redibujo por cambio de idioma.
const mapState={you:null,pick:null};
function legendFlame(height,className) { const icon=svgNode('svg',{viewBox:'0 0 20 28',width:(height*20/28).toFixed(1),height,'aria-hidden':'true'});icon.append(svgNode('use',{href:'#flame',class:`live-flame ${className}`}));return icon; }
function legendRing() { const icon=svgNode('svg',{viewBox:'-12 -12 24 24',width:20,height:20,'aria-hidden':'true'});icon.append(svgNode('circle',{r:9,class:'legend-ring'}));return icon; }
// Leyenda compacta: una línea por canal, con iconos y rótulos cortos.
function legendRow(title,items) {
  const row=node('div','live-legend-row');row.append(node('span','live-legend-title',title));
  const list=node('ul','live-legend-list');
  for(const [icon,label,aria] of items){const li=node('li','live-legend-item');if(aria)li.setAttribute('aria-label',aria);const text=node('span','',label);if(aria)text.setAttribute('aria-hidden','true');li.append(icon,text);list.append(li);}
  row.append(list);return row;
}
function satGlyph() { const icon=svgNode('svg',{viewBox:'0 0 26 14',width:26,height:14,class:'sat-glyph','aria-hidden':'true'});icon.append(svgNode('rect',{x:0,y:4,width:8,height:6}),svgNode('rect',{x:10,y:2,width:6,height:10}),svgNode('rect',{x:18,y:4,width:8,height:6}));return icon; }
function clusterTitle(c,points) {
  const n20=c.members.filter(i=>points[i].sat==='N20').length;
  return t(c.n===1?'live.clusterTitleOne':'live.clusterTitle',{n:number(c.n),frp:number(c.frpMax),n20:number(n20),n21:number(c.n-n20)});
}
// Un grupo de llama. La posición vive en el <g> exterior; ignite y ring son hijos sin atributo
// transform, y son lo único que se anima (en Safari, animar transform de un elemento que ya
// tiene transform de posición deja la llama en la esquina del mapa).
function clusterNode(c,points,k,focusable) {
  const a=clusterAttrs(c,clusterHeight(c.n),k),label=clusterTitle(c,points),h=clusterHeight(c.n)*k;
  const group=svgNode('g',{class:'live-cluster',...a.position});
  if(focusable){group.setAttribute('tabindex',0);group.setAttribute('role','button');group.setAttribute('aria-label',`${label}. ${t('focus.open')}`);}
  const title=svgNode('title',{});title.textContent=label;
  // Contraescala del zoom: atributo transform en un <g> intermedio que no se anima.
  const zoom=svgNode('g',{class:'live-zoom',transform:'scale(1)'});
  const ring=svgNode('circle',{class:'live-ring',cx:0,cy:(-h*0.45).toFixed(2),r:(h*0.6).toFixed(2),opacity:0});
  const ignite=svgNode('g',a.ignite),flame=svgNode('use',{href:'#flame',class:'live-flame'});
  const count=svgNode('text',{class:'live-count','font-size':(13*k).toFixed(2),'stroke-width':(3*k).toFixed(2),'aria-hidden':'true'});
  ignite.append(flame,count);zoom.append(ring,ignite);group.append(title,zoom);
  return {group,zoom,ring,ignite,flame,count};
}
function paintCluster(c,parts,s,k) {
  const a=clusterAttrs(c,clusterHeight(Math.max(1,s.n)),k);
  parts.flame.setAttribute('transform',a.flame.transform);
  parts.flame.setAttribute('class',`live-flame ${s.n21>s.n20?'live-n21':'live-n20'} ${frpClass(s.frpMax)}`);
  parts.count.setAttribute('transform',a.count.transform);parts.count.textContent=s.n>=3?number(s.n):'';
}
// Mapa fijo (estado final) para la comparación VIIRS / MODIS.
function drawStaticMap(svg,points) {
  const width=svg.getBoundingClientRect().width;if(!width)return false;
  const k=VIEW.width/width;
  svg.querySelector('.live-clusters')?.remove();
  const layer=svgNode('g',{class:'live-clusters'});
  for(const c of clusterDetections(points,k)){const parts=clusterNode(c,points,k,false);const n20=c.members.filter(i=>points[i].sat==='N20').length;paintCluster(c,parts,{n:c.n,n20,n21:c.n-n20,frpMax:c.frpMax},k);layer.append(parts.group);}
  svg.append(layer);return true;
}
function mapSvg(geo,titleText,descText,idBase) {
  const svg=svgNode('svg',{viewBox:`0 0 ${VIEW.width} ${VIEW.height}`});
  if(idBase){svg.setAttribute('role','group');svg.setAttribute('aria-labelledby',`${idBase}-title ${idBase}-desc`);const title=svgNode('title',{id:`${idBase}-title`});title.textContent=titleText;const desc=svgNode('desc',{id:`${idBase}-desc`});desc.textContent=descText;svg.append(title,desc);}
  else {svg.setAttribute('aria-hidden','true');}
  geo.features.forEach(f=>svg.append(svgNode('path',{d:geometryToPath(f.geometry),class:'live-outline'})));
  return svg;
}
// Línea de tiempo en px reales (se redibuja al cambiar de ancho, así el texto no se deforma).
function buildTimeline(box,tl,passes) {
  const W=box.getBoundingClientRect().width;if(!W)return null;
  const H=116,pad=10,top=40,base=92,x=time=>pad+timelineFraction(time,tl.start,tl.end)*(W-2*pad);
  const svg=svgNode('svg',{viewBox:`0 0 ${W.toFixed(1)} ${H}`,width:W.toFixed(1),height:H,'aria-hidden':'true'});
  const bands=svgNode('g',{class:'tl-bands'}),labels=svgNode('g',{class:'tl-labels'}),bars=svgNode('g',{class:'tl-bars'});
  const lanes=[-Infinity,-Infinity];
  for(const p of passes){
    const x0=x(p.start),x1=x(p.end+60000),w=Math.max(8,x1-x0),cx=(x0+x1)/2;
    const band=svgNode('rect',{class:`tl-band tl-band-${p.sat.toLowerCase()}`,x:(cx-w/2).toFixed(1),y:top-6,width:w.toFixed(1),height:base-top+6});
    const title=svgNode('title',{});title.textContent=t('live.pass',{sat:SAT_NAMES[p.sat],time:hhmm(p.start)});band.append(title);bands.append(band);
    const text=SAT_NAMES[p.sat],tw=text.length*7+6,lx=Math.max(tw/2,Math.min(W-tw/2,cx));
    const lane=lanes.findIndex(end=>lx-tw/2>=end);
    if(lane<0)continue;
    lanes[lane]=lx+tw/2;
    labels.append(Object.assign(svgNode('text',{class:`tl-label tl-label-${p.sat.toLowerCase()}`,x:lx.toFixed(1),y:lane?28:13,'text-anchor':'middle'}),{textContent:text}));
  }
  const binW=(W-2*pad)/tl.bins.length,unit=(base-top)/Math.max(1,tl.max);
  const binEls=tl.bins.map(b=>{
    const g=svgNode('g',{class:'tl-bin'}),bx=x(b.t0)+0.5,bw=Math.max(1,binW-1.5),h20=b.n20*unit,h21=b.n21*unit;
    if(b.n20)g.append(svgNode('rect',{class:'tl-bar tl-n20',x:bx.toFixed(1),y:(base-h20).toFixed(1),width:bw.toFixed(1),height:h20.toFixed(1)}));
    if(b.n21)g.append(svgNode('rect',{class:'tl-bar tl-n21',x:(bx+0.75).toFixed(1),y:(base-h20-h21+0.75).toFixed(1),width:Math.max(0.5,bw-1.5).toFixed(1),height:Math.max(0.5,h21-1.5).toFixed(1)}));
    bars.append(g);return {g,t0:b.t0,future:false};
  });
  const axis=svgNode('g',{class:'tl-axis'});axis.append(svgNode('line',{x1:pad,x2:(W-pad).toFixed(1),y1:base+0.5,y2:base+0.5}));
  const hour=3600000,every=(W<560?6:3)*hour;
  for(let tick=Math.ceil(tl.start/every)*every;tick<=tl.end;tick+=every){const tx=x(tick);axis.append(svgNode('line',{x1:tx.toFixed(1),x2:tx.toFixed(1),y1:base,y2:base+5}));axis.append(Object.assign(svgNode('text',{x:tx.toFixed(1),y:H-4,'text-anchor':tx<40?'start':tx>W-40?'end':'middle'}),{textContent:hhmm(tick)}));}
  axis.append(Object.assign(svgNode('text',{x:pad,y:H-4,class:'tl-utc'}),{textContent:'UTC'}));
  const head=svgNode('g',{class:'tl-head'});head.append(svgNode('line',{x1:0,x2:0,y1:top-10,y2:base+2}),svgNode('circle',{cx:0,cy:base,r:6}));
  svg.append(bands,labels,bars,axis,head);
  box.replaceChildren(svg);
  return {pad,width:W,x,binEls,head};
}
function stopReplay(){ if(!replay)return; cancelAnimationFrame(replay.raf); cancelAnimationFrame(replay.zoomRaf); replay.observer?.disconnect(); replay.abort?.abort(); replay=null; }
// Reproducción de las 24 h: el cabezal recorre la línea de tiempo (lento en cada pase, rápido
// en las horas sin satélite); cada grupo se enciende en el minuto real de su primera detección,
// lanza un anillo con cada detección nueva y pasa de "recién detectada" a "ya vista".
function startReplay(ui,dets,passes,tl) {
  stopReplay();
  const order=dets.map((d,i)=>i).sort((a,b)=>dets[a].time-dets[b].time||a-b);
  const schedule=replaySchedule(passes,tl.start,tl.end);
  dets.forEach(d=>{d.playAt=scheduleProgress(d.time,schedule)*REPLAY_MS;});
  const total=dets.length;
  const r={raf:0,playhead:0,lastNow:null,userPaused:reducedMotion(),hoverPaused:false,inView:false,once:false,pointer:0,shown:0,time:-Infinity,clusters:[],memberOf:[],k:1,timeline:null,pass:undefined,dragging:false};
  replay=r;
  function fire(i,animate) {
    const c=r.clusters[r.memberOf[i]],d=dets[i],s=c.state;
    s.n++;if(d.sat==='N21')s.n21++;else s.n20++;s.frpMax=Math.max(s.frpMax,Number.isFinite(d.frp)?d.frp:0);s.lastPlay=Math.max(s.lastPlay,d.playAt);r.shown++;
    paintCluster(c,c,s,r.k);
    const motion=animate&&!reducedMotion();
    if(!s.shown){s.shown=true;c.ignite.setAttribute('opacity','1');if(motion)c.ignite.animate([{opacity:0,transform:'scale(.2)'},{opacity:1,transform:'scale(1)'}],{duration:450,easing:'cubic-bezier(.22,1,.36,1)'});}
    if(motion){const now=performance.now();if(now-(c.ringAt??0)>300){c.ringAt=now;c.ring.animate([{opacity:.95,transform:'scale(.35)'},{opacity:0,transform:'scale(2.6)'}],{duration:1000,easing:'cubic-bezier(.22,1,.36,1)'});}}
  }
  function reset() { r.pointer=0;r.shown=0;r.time=-Infinity; for(const c of r.clusters){c.state={n:0,n20:0,n21:0,frpMax:0,shown:false,lastPlay:-Infinity,look:''};c.ignite.setAttribute('opacity','0');c.count.textContent='';c.group.setAttribute('class','live-cluster');} }
  function render() {
    const ended=r.time>=tl.end;
    for(const c of r.clusters){const s=c.state,look=!s.shown||ended?'':r.playhead-s.lastPlay<FRESH_MS?'is-fresh':'is-seen';if(look!==s.look){s.look=look;c.group.setAttribute('class',`live-cluster ${look}`.trim());}}
    ui.countNow.textContent=number(ended?total:r.shown);ui.countOf.textContent=ended?'':t('live.countOf',{total:number(total)});
    const clock=formatClock(new Date(Math.min(r.time,tl.end)).toISOString());ui.clockTime.textContent=clock;
    const pass=ended?null:passNow(passes,r.time);
    if(pass!==r.pass){r.pass=pass;ui.passing.classList.toggle('is-on',!!pass);if(pass)ui.passingText.textContent=t('live.passing',{sat:SAT_NAMES[pass.sat]});}
    const tlv=r.timeline;
    if(tlv){tlv.head.setAttribute('transform',`translate(${tlv.x(Math.min(r.time,tl.end)).toFixed(1)} 0)`);for(const b of tlv.binEls){const future=b.t0>r.time;if(future!==b.future){b.future=future;b.g.setAttribute('class',future?'tl-bin is-future':'tl-bin');}}}
    ui.slider.setAttribute('aria-valuenow',String(Math.round((Math.min(r.time,tl.end)-tl.start)/60000)));ui.slider.setAttribute('aria-valuetext',clock);
  }
  function goTo(time,animate) { if(time<r.time)reset(); while(r.pointer<order.length&&dets[order[r.pointer]].time<=time)fire(order[r.pointer++],animate); r.time=time; render(); }
  function build() {
    const width=ui.svg.getBoundingClientRect().width;if(!width)return false;
    r.k=VIEW.width/width;
    ui.svg.querySelector('.live-clusters')?.remove();
    const layer=svgNode('g',{class:'live-clusters'});
    r.clusters=clusterDetections(dets,r.k);r.memberOf=[];
    r.clusters.forEach((c,ci)=>{c.members.forEach(i=>{r.memberOf[i]=ci;});Object.assign(c,clusterNode(c,dets,r.k,true));layer.append(c.group);c.group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(ci);}});});
    ui.svg.append(layer,overlay);
    r.timeline=buildTimeline(ui.timeline,tl,passes);
    reset();
    return true;
  }
  const running=()=>!r.userPaused&&!r.hoverPaused&&r.inView;
  function updateButton(){ui.play.textContent=t(r.userPaused?'live.play':'live.pause');ui.play.setAttribute('aria-pressed',String(!r.userPaused));}
  function frame(now) {
    r.raf=0;if(!running()){r.lastNow=null;return;}
    if(r.lastNow!=null)r.playhead+=Math.min(100,now-r.lastNow);r.lastNow=now;
    if(r.playhead<=REPLAY_MS)goTo(scheduleTime(r.playhead/REPLAY_MS,schedule),true);
    else if(r.playhead<=REPLAY_MS+HOLD_MS)goTo(tl.end,true);
    else if(r.once){r.once=false;r.userPaused=true;r.playhead=REPLAY_MS+HOLD_MS;updateButton();return;}
    else{r.playhead=0;goTo(tl.start,true);}
    r.raf=requestAnimationFrame(frame);
  }
  function kick(){if(running()&&!r.raf){r.lastNow=null;r.raf=requestAnimationFrame(frame);}}
  function seekTo(time) { r.userPaused=true;updateButton();r.playhead=time>=tl.end?REPLAY_MS:scheduleProgress(time,schedule)*REPLAY_MS;goTo(time,false); }
  // Tocar una llama: zoom suave del viewBox a sus detecciones y panel con el detalle.
  const FULL={x:0,y:0,w:VIEW.width,h:VIEW.height};
  r.vb={...FULL};r.focus=null;r.pick=null;r.you=null;r.zoomRaf=0;r.abort=new AbortController();
  const unitsPerPx=()=>r.k*r.vb.w/VIEW.width;
  function paintOverlay() {
    const u=unitsPerPx(),marks=[];
    if(r.focus)for(const i of r.focus.members)marks.push(svgNode('circle',{class:'live-focus-dot',cx:dets[i].x.toFixed(2),cy:dets[i].y.toFixed(2),r:(3.5*u).toFixed(3)}));
    if(r.you){const [x,y]=project(r.you.lon,r.you.lat);marks.push(svgNode('circle',{class:'live-you',cx:x.toFixed(2),cy:y.toFixed(2),r:(8*u).toFixed(3)}),svgNode('circle',{class:'live-you-dot',cx:x.toFixed(2),cy:y.toFixed(2),r:(2.5*u).toFixed(3)}));}
    overlay.replaceChildren(...marks);
  }
  function applyView() {
    const v=r.vb;ui.svg.setAttribute('viewBox',`${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${v.h.toFixed(2)}`);
    const s=`scale(${(v.w/VIEW.width).toFixed(4)})`;for(const c of r.clusters)c.zoom.setAttribute('transform',s);
    ui.svg.classList.toggle('is-zoomed',v.w<VIEW.width-0.01);paintOverlay();
  }
  function animateView(target) {
    cancelAnimationFrame(r.zoomRaf);const from={...r.vb};
    if(reducedMotion()){r.vb={...target};applyView();return;}
    const t0=performance.now();
    const step=now=>{const p=Math.min(1,(now-t0)/650),e=1-(1-p)**3;r.vb={x:from.x+(target.x-from.x)*e,y:from.y+(target.y-from.y)*e,w:from.w+(target.w-from.w)*e,h:from.h+(target.h-from.h)*e};applyView();if(p<1)r.zoomRaf=requestAnimationFrame(step);};
    r.zoomRaf=requestAnimationFrame(step);
  }
  function markSelected() { const first=r.focus?.members[0];for(const c of r.clusters)c.group.classList.toggle('is-selected',first!=null&&c.members.includes(first)); }
  function select(ci) {
    const c=r.clusters[ci];if(!c)return;
    seekTo(tl.end);
    r.focus={members:c.members.slice()};markSelected();
    animateView(zoomBox(c.members.map(i=>dets[i]),VIEW));
    ui.reset.hidden=false;ui.onFocus(r.focus.members);
  }
  function clearFocus() {
    if(!r.focus)return;
    const first=r.focus.members[0];r.focus=null;markSelected();animateView({...FULL});ui.reset.hidden=true;ui.onFocus(null);
    r.clusters.find(c=>c.members.includes(first))?.group.focus({preventScroll:true});
  }
  const overlay=svgNode('g',{class:'live-overlay','aria-hidden':'true'});
  r.rebuild=()=>{const at=r.time;if(build()){goTo(at,false);applyView();markSelected();}};
  if(!build())return;
  applyView();
  ui.reset.addEventListener('click',clearFocus);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&r.focus){e.preventDefault();clearFocus();}},{signal:r.abort.signal});
  // Clic: en modo "elegir punto" fija el punto; si no, abre la llama más cercana (≤ 26 px).
  ui.svg.addEventListener('click',e=>{
    const ctm=ui.svg.getScreenCTM();if(!ctm)return;
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(ctm.inverse());
    if(r.pick){const done=r.pick;r.api.stopPick();mapState.pick=null;const [lon,lat]=unproject(p.x,p.y);done({lat,lon});return;}
    const u=unitsPerPx();let best=-1,bd=Infinity;
    r.clusters.forEach((c,i)=>{if(!c.state.shown)return;const d=Math.hypot(p.x-c.x,p.y-(c.y-clusterHeight(c.n)*u*0.45));if(d<bd){bd=d;best=i;}});
    if(best>=0&&bd<=26*u)select(best);
  });
  r.api={
    startPick(done){r.pick=done;ui.frame.classList.add('is-picking');ui.pickHint.hidden=false;},
    stopPick(){r.pick=null;ui.frame.classList.remove('is-picking');ui.pickHint.hidden=true;},
    showPoint(point){r.you=point;paintOverlay();},
    scrollToMap(){ui.frame.scrollIntoView({block:'center',behavior:reducedMotion()?'auto':'smooth'});}
  };
  if(r.userPaused){r.playhead=REPLAY_MS+HOLD_MS;goTo(tl.end,false);}else goTo(tl.start,false);
  updateButton();
  ui.play.addEventListener('click',()=>{
    r.userPaused=!r.userPaused;
    if(!r.userPaused&&r.playhead>=REPLAY_MS){r.playhead=0;goTo(tl.start,false);r.once=reducedMotion();}
    updateButton();kick();
  });
  const fromPointer=e=>{const box=ui.slider.getBoundingClientRect(),pad=r.timeline?.pad??10;return timelineSeek((e.clientX-box.left-pad)/Math.max(1,box.width-2*pad),tl.start,tl.end);};
  ui.slider.addEventListener('pointerdown',e=>{r.dragging=true;ui.slider.setPointerCapture?.(e.pointerId);seekTo(fromPointer(e));});
  ui.slider.addEventListener('pointermove',e=>{if(r.dragging)seekTo(fromPointer(e));});
  for(const type of ['pointerup','pointercancel'])ui.slider.addEventListener(type,()=>{r.dragging=false;});
  ui.slider.addEventListener('keydown',e=>{const next=timelineKey(e.key,Math.min(r.time,tl.end),tl.start,tl.end);if(next==null)return;e.preventDefault();seekTo(next);});
  ui.frame.addEventListener('pointerenter',()=>{r.hoverPaused=true;});
  ui.frame.addEventListener('pointerleave',()=>{r.hoverPaused=false;kick();});
  ui.frame.addEventListener('focusin',()=>{r.hoverPaused=true;});
  ui.frame.addEventListener('focusout',()=>{r.hoverPaused=false;kick();});
  r.observer=new IntersectionObserver(entries=>{for(const e of entries)r.inView=e.isIntersecting;kick();},{threshold:.2});
  r.observer.observe(ui.frame);
}
// Comparación VIIRS / MODIS: dos mapas fijos. En móvil, pestañas.
function buildCompare(geo,dets,selection,expected) {
  const wrap=node('div','live-compare');wrap.dataset.active='modis';
  wrap.append(node('h3','live-compare-title',t('live.modisToggle')));
  const tabs=node('div','live-compare-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('live.modisToggle'));
  const subset=selection.map(i=>dets[i]);
  const panels=[['viirs',t('live.compareViirs'),number(dets.length),dets],['modis',t('live.compareModis'),t('live.approx',{n:number(expected)}),subset]].map(([id,label,figure,points])=>{
    const tab=node('button','live-compare-tab');tab.type='button';tab.id=`compare-tab-${id}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',`compare-panel-${id}`);
    tab.textContent=id==='viirs'?'VIIRS':'MODIS';tabs.append(tab);
    const panel=node('div',`live-compare-panel compare-${id}`);panel.id=`compare-panel-${id}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`compare-tab-${id}`);
    const head=node('p','live-compare-head');head.append(node('span','live-compare-label',label),node('strong','live-compare-figure',figure));
    const svg=mapSvg(geo);svg.setAttribute('class','live-compare-map');
    panel.append(head,svg);
    return {id,tab,panel,svg,points};
  });
  const select=id=>{wrap.dataset.active=id;for(const p of panels){p.tab.setAttribute('aria-selected',String(p.id===id));p.tab.tabIndex=p.id===id?0:-1;}draw();};
  for(const p of panels){p.tab.addEventListener('click',()=>select(p.id));p.tab.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();const other=panels.find(q=>q!==p);select(other.id);other.tab.focus();});}
  const grid=node('div','live-compare-grid');grid.append(...panels.map(p=>p.panel));
  const note=node('p','live-modis-note',t('live.modisNote'));
  const result=node('p','visually-hidden',t('live.modisResult',{n:number(expected),total:number(dets.length)}));
  wrap.append(tabs,grid,result,note);
  function draw(){for(const p of panels)drawStaticMap(p.svg,p.points);}
  select('modis');
  return {wrap,draw};
}
function onLiveResize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{replay?.rebuild();replay?.compare?.draw();},100);}
function renderLive(snapshot,names,geo,health,notice,tle) {
  const target=document.getElementById('live-content'),s=liveSummary(snapshot,names);
  ensureFlameDefs();
  const status=node('p','live-status',`${t('live.capture',{date:formatUtc(snapshot.generado)})} · ${t('live.last',{date:formatUtc(snapshot.ultima_deteccion_utc)})}`);
  const stats=node('div','live-stats');
  const lead=node('div','live-stat live-stat-lead'),leadValue=node('strong','live-count-value'),countNow=node('span','live-count-now',number(s.nDetecciones)),countOf=node('span','live-count-of');
  leadValue.append(countNow,countOf);lead.append(leadValue,node('span','live-stat-label',t('live.detected')));stats.append(lead);
  [[t('live.cells',{date:formatDay(snapshot.dia_comparado)}),number(s.nacional.celdas_dia)],[t('live.national'),levelBadge(s.nacional.nivel)]].forEach(([label,value],i)=>{const card=node('div','live-stat');card.append(node('strong',i===1?`live-level level-${s.nacional.nivel??'none'}`:'',value),node('span','live-stat-label',label));if(i===0)card.append(node('span','live-median-context',t('live.medianContext',{median:number(s.nacional.base_p50)})));stats.append(card);});
  const top=node('div','live-top');top.append(stats,status);
  const next=tle?firstPass(predictPasses(tle,CENTER_MX,Date.now())):null;
  if(next){const line=node('p','live-next-pass');line.append(satGlyph(),node('span','',next.inNow?t('orbit.nowCenter',{sat:next.name}):t('orbit.nextCenter',{sat:next.name,local:formatLocalTime(next.closest),utc:formatUtcTime(next.closest)})));top.append(line);}
  const mapApi={startPick:done=>{mapState.pick=done;replay?.api?.startPick(done);},stopPick:()=>{mapState.pick=null;replay?.api?.stopPick();},showPoint:point=>{mapState.you=point;replay?.api?.showPoint(point);},scrollToMap:()=>replay?.api?.scrollToMap()};
  top.append(buildFireBlock({snapshot,tle,geo,mapApi}));
  const frame=node('div','live-map-frame'),svg=mapSvg(geo,t('live.mapTitle'),t('live.mapDesc'),'live-map');
  const passing=node('p','live-passing');passing.setAttribute('aria-hidden','true');const passingText=node('span','');passing.append(satGlyph(),passingText);
  const pickHint=node('p','live-pick-hint',t('fire.pickHint'));pickHint.hidden=true;
  frame.append(svg,passing,pickHint);
  const focusPanel=node('div','live-focus');focusPanel.setAttribute('aria-live','polite');
  function showFocus(members) {
    if(!members){focusPanel.replaceChildren();return;}
    const ds=members.map(i=>snapshot.detecciones[i]),f=clusterSummary(ds),n20=ds.filter(d=>d.sat==='N20').length;
    const link=node('a','live-focus-link',t('focus.worldview'));link.href=worldviewUrl(f.last);link.target='_blank';link.rel='noopener noreferrer';
    const parts=[node('h3','live-focus-title',f.n===1?t('focus.titleOne'):t('focus.title',{n:number(f.n)})),node('p','',t('focus.last',{sat:SAT_NAMES[f.last.sat],time:f.last.hora_utc,date:formatDay(f.last.fecha)}))];
    if(f.n>1)parts.push(node('p','',t('focus.sats',{n20:number(n20),n21:number(f.n-n20)})));
    parts.push(node('p','',f.frpMax==null?t('focus.frpNone'):t('focus.frp',{frp:number(f.frpMax)})),node('p','live-focus-note',t('focus.dots')),link,node('p','live-focus-note',t('focus.worldviewNote')),node('p','live-focus-note',t(f.night?'focus.nightNote':'focus.dayNote')));
    focusPanel.replaceChildren(...parts);
  }
  const dets=snapshot.detecciones.map(d=>{const [x,y]=project(d.lon,d.lat);return {x,y,frp:d.frp,sat:d.sat,time:detectionTime(d)};});
  const passes=satellitePasses(snapshot.detecciones),tl=timelineBins(snapshot.detecciones);
  const bar=node('div','live-map-bar');
  const clockText=node('p','live-clock'),clockTime=node('span','live-clock-time');clockText.append(clockTime);
  const controls=node('div','live-controls');
  const play=node('button','live-play');play.type='button';
  const reset=node('button','live-reset',t('focus.reset'));reset.type='button';reset.hidden=true;controls.append(reset,play);
  bar.append(clockText,controls);
  const slider=node('div','live-timeline');slider.tabIndex=0;slider.setAttribute('role','slider');slider.setAttribute('aria-label',t('live.timelineLabel'));slider.setAttribute('aria-valuemin','0');slider.setAttribute('aria-valuemax',String(Math.round((tl.end-tl.start)/60000)));
  const timelineBox=node('div','live-timeline-svg');slider.append(timelineBox);
  if(!resizeBound){window.addEventListener('resize',onLiveResize);resizeBound=true;}
  const legend=node('div','live-legend');
  legend.append(
    legendRow(t('live.legendShape'),[[legendFlame(18,'live-n20 flame-mid'),'NOAA-20'],[legendFlame(18,'live-n21 flame-mid'),'NOAA-21']]),
    legendRow(t('live.legendColor'),[[legendFlame(18,'live-n20 flame-low'),t('live.frpTickLow',{a:FRP_CUTS[0]}),t('live.frpLow',{a:FRP_CUTS[0]})],[legendFlame(18,'live-n20 flame-mid'),t('live.frpTickMid',{a:FRP_CUTS[0],b:FRP_CUTS[1]}),t('live.frpMid',{a:FRP_CUTS[0],b:FRP_CUTS[1]})],[legendFlame(18,'live-n20 flame-high'),t('live.frpTickHigh',{b:FRP_CUTS[1]}),t('live.frpHigh',{b:FRP_CUTS[1]})]]),
    legendRow(t('live.legendSize'),[1,5,20].map(n=>[legendFlame(clusterHeight(n),'live-n20 flame-mid'),number(n),t(n===1?'live.sizeOne':'live.sizeMany',{n:number(n)})])),
    legendRow(t('live.legendTime'),[[legendRing(),t('live.legendFresh')],[legendFlame(18,'live-n20 flame-mid legend-seen'),t('live.legendSeen')]]));
  const overlap=health?.mx?.overlap_probability;
  const probabilities=Array.isArray(overlap)?modisProbabilities(snapshot.detecciones,overlap):[];
  const expected=modisExpected(probabilities);
  const compare=expected!=null?buildCompare(geo,dets,modisSelection(probabilities,expected),expected):null;
  const detectionTable=node('div','live-detections');const detectionButton=node('button','secondary',t('live.showDetections',{shown:Math.min(snapshot.detecciones.length,50),total:snapshot.detecciones.length}));detectionButton.type='button';detectionButton.setAttribute('aria-expanded','false');detectionTable.append(detectionButton);const table=node('table');table.hidden=true;table.append(node('caption','',t('live.tableCaption')));const header=table.createTHead().insertRow();for(const key of ['state','sensor','dateUtc','frp'])header.append(node('th','',t(`live.${key}`)));const body=table.createTBody();snapshot.detecciones.slice().sort((a,b)=>(b.frp??0)-(a.frp??0)).slice(0,50).forEach(d=>{const row=body.insertRow();for(const value of [regionName(d.estado,names),d.sat,`${d.fecha} ${d.hora_utc}`,d.frp==null?t('common.noData'):number(d.frp)])row.append(node('td','',value));});detectionTable.append(table);detectionButton.addEventListener('click',()=>{table.hidden=!table.hidden;detectionButton.setAttribute('aria-expanded',String(!table.hidden));});
  const ranking=node('div','live-ranking');ranking.append(node('h3','',t('live.rankTitle')));if(!s.ranking.length)ranking.append(node('p','',t('live.noElevated')));
  else {const list=node('ol','live-rank-list');s.ranking.forEach(item=>{const row=node('li','live-rank-row');row.append(node('strong','',item.name),node('span','',rankingComparison(item)),node('span',`live-level level-${item.nivel}`,levelBadge(item.nivel)));list.append(row);});ranking.append(list);}
  const method=node('details','live-method');method.append(node('summary','',t('live.methodTitle')),node('p','',t('live.flameNote')));for(let i=1;i<=6;i++)method.append(node('p','',t(`live.method.${i}`)));method.append(node('p','',t('live.rankNote')));
  const after=node('div','live-after');after.append(ranking,detectionTable,method);
  const mapBlock=node('div','live-map-block');if(notice)mapBlock.append(node('p','live-stale',notice));mapBlock.append(bar,frame,focusPanel,slider,legend);
  const hero=node('div','live-hero');hero.append(top,mapBlock);
  target.replaceChildren(...[hero,compare?.wrap,after].filter(Boolean));
  startReplay({svg,frame,play,reset,pickHint,onFocus:showFocus,clockTime,passing,passingText,slider,timeline:timelineBox,countNow,countOf},dets,passes,tl);
  if(replay){replay.compare=compare;if(mapState.you)replay.api?.showPoint(mapState.you);if(mapState.pick)replay.api?.startPick(mapState.pick);}
  compare?.draw();
}
export async function loadLive(names,geo,health) {
  const target=document.getElementById('live-content');
  const tleRequest=fetch('data/tle.json').then(r=>r.ok?r.json():null).catch(()=>null);
  try {const response=await fetch('data/live_snapshot.json');if(!response.ok)throw new Error();const data=await response.json();const view=liveView(data,Object.keys(names).filter(id=>id!=='MX'));if(view.mode!=='full')throw new Error();renderLive(data,names,geo,health,view.notice,await tleRequest);}
  catch {stopReplay();const note=node('p','live-stale',t('live.unavailable'));const mini=node('div','calendar-mini');const source=document.getElementById('calendar-svg');if(source){const clone=source.cloneNode(true);clone.removeAttribute('id');clone.removeAttribute('aria-labelledby');clone.setAttribute('aria-hidden','true');clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));mini.append(clone);}const link=node('a','',t('live.explore'));link.href='#calendario';target.replaceChildren(note,mini,link);}
}
