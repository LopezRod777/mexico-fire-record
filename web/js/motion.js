export function countAt(target,progress,reduced=false){
  if(reduced)return target;
  const t=Math.max(0,Math.min(1,progress));
  return t===1?target:Math.round(target*(1-(1-t)**3));
}
export function flameStagger(detections){
  const sorted=detections.map((d,index)=>({index,frp:Number.isFinite(d.frp)?d.frp:0})).sort((a,b)=>a.frp-b.frp||a.index-b.index);
  const step=sorted.length>1?Math.min(1100/(sorted.length-1),70):0;
  return sorted.map((row,i)=>({...row,delay:Math.round(i*step)}));
}
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function enterParts(root){
  const parts=[...root.querySelectorAll(':scope > h2, :scope > .section-heading, :scope > .days-copy, :scope > .intro, :scope > .live-hero, :scope > .map-frame, :scope > .calendar-graphic, :scope > .confidence-intro, :scope > figure')];
  if(reduced())return;
  parts.forEach((part,i)=>part.animate([{opacity:0,transform:'translateY(24px)'},{opacity:1,transform:'translateY(0)'}],{duration:600,delay:Math.min(i*80,320),easing:'cubic-bezier(.22,1,.36,1)'}));
}
function startCount(root){
  const el=root.querySelector('.live-stat:first-child strong');if(!el||el.dataset.counted)return;
  const target=Number(el.textContent.replace(/[^0-9]/g,''));if(!Number.isFinite(target))return;
  el.dataset.counted='true';if(reduced())return;
  const formatter=new Intl.NumberFormat('es-MX');const start=performance.now();
  function frame(now){const p=Math.min(1,(now-start)/900);el.textContent=formatter.format(countAt(target,p));if(p<1)requestAnimationFrame(frame);}
  requestAnimationFrame(frame);
}
function startCalendar(root){
  if(reduced())return;
  root.querySelectorAll('rect.cell').forEach((cell,i)=>{const row=Math.floor(i/12),col=i%12;cell.animate([{opacity:0,transform:'scale(.9)'},{opacity:1,transform:'scale(1)'}],{duration:320,delay:Math.round((row+col)/36*560),easing:'cubic-bezier(.22,1,.36,1)'});});
}
function startError(root){
  if(reduced())return;
  root.querySelectorAll('.error-mark').forEach((mark,i)=>mark.animate([{opacity:0,transform:'translateY(-12px)'},{opacity:1,transform:'translateY(0)'}],{duration:320,delay:i*18,easing:'cubic-bezier(.22,1,.36,1)'}));
  const median=root.querySelector('.error-median');if(median)median.animate([{opacity:0,transform:'translate(-35px,-12px)'},{opacity:1,transform:'translate(-50%,0)'}],{duration:320,delay:600,easing:'cubic-bezier(.22,1,.36,1)'});
}
let languageRepaint = false;
export function setLanguageRepaint(value) { languageRepaint = value; }
export function animateCalendarChange(){
  if(languageRepaint)return;
  const svg=document.getElementById('calendar-svg');if(svg&&!reduced())svg.animate([{opacity:.2},{opacity:1}],{duration:280,easing:'cubic-bezier(.22,1,.36,1)'});
}
export function animateErrorChange(){if(languageRepaint)return;const root=document.getElementById('confidence-content');if(root)startError(root);}
export function animateLive(){if(languageRepaint)return;const root=document.getElementById('hoy');if(!root)return;startCount(root);}
export function setupMotion(){
  const photo=document.querySelector('.photo-viewport'),image=photo?.querySelector('img');
  if(photo&&image&&!reduced()){photo.animate([{clipPath:'inset(0 0 0 100%)'},{clipPath:'inset(0)'}],{duration:1100,easing:'cubic-bezier(.22,1,.36,1)'});image.animate([{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:1100,easing:'cubic-bezier(.22,1,.36,1)'});}
  const parallax=image&&!reduced()?image.animate([{transform:'translateY(0px)'},{transform:'translateY(60px)'}],{duration:10000,fill:'both'}):null;
  if(parallax)parallax.pause();
  const page=document.querySelector('.photo-page');
  const pageGrow=page&&!reduced()?page.animate([{transform:'scale(.96)'},{transform:'scale(1)'}],{duration:10000,fill:'both'}):null;
  if(pageGrow)pageGrow.pause();
  const sections=[...document.querySelectorAll('main section')];
  const entered=new Set();const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;const section=entry.target;if(!entered.has(section)){entered.add(section);enterParts(section);if(section.id==='hoy')animateLive();if(section.id==='calendario')startCalendar(section);if(section.id==='confianza')startError(section);}observer.unobserve(section);}}, {threshold:.1});sections.forEach(section=>observer.observe(section));
  const nav=new IntersectionObserver(entries=>{entries.filter(e=>e.isIntersecting).forEach(e=>{document.querySelectorAll('.site-header nav a').forEach(a=>a.classList.toggle('active',a.hash===`#${e.target.id}`));});},{rootMargin:'-25% 0px -60% 0px'});sections.filter(s=>s.id).forEach(s=>nav.observe(s));
  const updateHeader=()=>document.querySelector('.site-header')?.classList.toggle('scrolled',window.scrollY>10);
  updateHeader();window.addEventListener('hashchange',updateHeader);
  let ticking=false;window.addEventListener('scroll',()=>{if(ticking)return;ticking=true;requestAnimationFrame(()=>{const y=window.scrollY;updateHeader();if(parallax&&y<window.innerHeight*2)parallax.currentTime=Math.min(10000,y/(window.innerHeight*1.5)*10000);if(pageGrow){const top=page.getBoundingClientRect().top;pageGrow.currentTime=Math.max(0,Math.min(10000,(window.innerHeight-top)/window.innerHeight*10000));}ticking=false;});},{passive:true});
}
