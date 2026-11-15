import { number, percent } from './format.js';
import { versionPeriods } from './version-periods.js';
const NS='http:' + '//www.w3.org/2000/svg';
const COLORS={Aqua:'#75c9db',Terra:'#d9bc75',SNPP:'#a7b7ed'};
function el(tag,attrs={}){const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);return n;}
function label(svg,x,y,text,attrs={}){const n=el('text',{x,y,...attrs});n.textContent=text;svg.append(n);}
function start(svg,title,desc){svg.replaceChildren();const t=el('title');t.textContent=title;const d=el('desc');d.textContent=desc;svg.append(t,d);}
function chartWidth(svg){const width=Math.max(300,Math.floor(svg.clientWidth||520));svg.setAttribute('viewBox',`0 0 ${width} 270`);return width;}
function niceCeiling(value){const magnitude=10**Math.floor(Math.log10(value||1));for(const step of [1,2,2.5,5,10])if(step*magnitude>=value)return step*magnitude;return 10*magnitude;}
function lineChart(svg,rows,keys,yMin,yMax,title,desc,formatY){
  start(svg,title,desc);const width=chartWidth(svg),years=[...new Set(rows.map(r=>r.year))].sort((a,b)=>a-b);if(!years.length)return;
  const left=55,right=width-12,x=yr=>left+(yr-years[0])/(years.at(-1)-years[0]||1)*(right-left),y=v=>210-(v-yMin)/(yMax-yMin)*165;
  for(let i=0;i<4;i++){const v=yMin+(yMax-yMin)*i/3;svg.append(el('line',{x1:left,y1:y(v),x2:right,y2:y(v),stroke:'#233041'}));label(svg,5,y(v)+4,formatY(v));}
  for(const yr of [years[0],years[Math.floor(years.length/2)],years.at(-1)])label(svg,x(yr),236,String(yr),{'text-anchor':'middle'});
  keys.forEach(({field,name,color})=>{const data=rows.filter(r=>r[field]!=null).sort((a,b)=>a.year-b.year);if(!data.length)return;const path=el('path',{d:data.map((r,i)=>`${i?'L':'M'}${x(r.year).toFixed(1)},${y(r[field]).toFixed(1)}`).join(' '),fill:'none',stroke:color,'stroke-width':2.5});svg.append(path);});
  keys.forEach(({name,color},i)=>{const base=left+i*(width-left-8)/keys.length;svg.append(el('line',{x1:base,y1:254,x2:base+14,y2:254,stroke:color,'stroke-width':3}));label(svg,base+18,258,name);});
}
export function renderHealth(health){
  const lstPlace=document.getElementById('lst-place').value, ratioPlace=document.getElementById('ratio-place').value, ratioDay=document.getElementById('ratio-day').value, versionPlace=document.getElementById('version-place').value, overlapDay=document.getElementById('overlap-day').value;
  const lst=health[lstPlace].lst_by_year;
  const lstRows=[...new Set(lst.map(r=>r.year))].sort((a,b)=>a-b).map(year=>{const out={year};for(const r of lst.filter(r=>r.year===year))out[r.satellite==='N'?'SNPP':r.satellite]=r.lst_median;return out;});
  lineChart(document.getElementById('lst-chart'),lstRows,[{field:'Terra',name:'Terra',color:COLORS.Terra},{field:'Aqua',name:'Aqua',color:COLORS.Aqua},{field:'SNPP',name:'S-NPP',color:COLORS.SNPP}],9,15,`Hora de paso en ${lstPlace==='mx'?'México':'EE. UU.'}`,'Horas solares locales medianas por año; eje de 9 a 15 horas.',v=>`${number(v)} h`);
  const ratios=health[ratioPlace].ratio_by_year.filter(r=>r.daynight===ratioDay),max=niceCeiling(Math.max(...ratios.flatMap(r=>[r.terra_snpp,r.aqua_snpp]).filter(Number.isFinite),0)*1.15);
  lineChart(document.getElementById('ratio-chart'),ratios,[{field:'terra_snpp',name:'Terra/S-NPP',color:COLORS.Terra},{field:'aqua_snpp',name:'Aqua/S-NPP',color:COLORS.Aqua}],0,max,`Cociente frente a S-NPP, ${ratioPlace==='mx'?'México':'EE. UU.'}, ${ratioDay==='D'?'día':'noche'}`,'Cocientes anuales de conteos de celdas-día.',v=>number(v));
  renderVersions(health[versionPlace].versions_by_year);
  renderOverlap(health.mx.overlap_probability.filter(r=>r.daynight===overlapDay),overlapDay);
}
function renderVersions(rows){
  const root=document.getElementById('version-table');root.replaceChildren();const periods=versionPeriods(rows);
  for(const satellite of ['Terra','Aqua']){
    const group=document.createElement('section');group.className='version-group';
    const heading=document.createElement('h4');heading.textContent=satellite;group.append(heading);
    const list=document.createElement('ul');list.className='version-periods';
    const current=periods.filter(period=>period.satellite===satellite);
    current.forEach((period,index)=>{const item=document.createElement('li');item.className='version-chip';if(index===current.length-1&&index>0)item.classList.add('version-changed');item.textContent=`${period.version} · ${period.from}${period.to===period.from?'':`–${period.to}`}`;list.append(item);});
    group.append(list);root.append(group);
  }
}
function renderOverlap(rows,day){
  const svg=document.getElementById('overlap-chart');start(svg,`Acuerdo MODIS y VIIRS, ${day==='D'?'día':'noche'}`,'Barras por potencia VIIRS, mismo día y día siguiente como control.');
  const width=chartWidth(svg),bins=['<3','3-10','10-30','30+'],max=Math.max(.1,...rows.flatMap(r=>[r.p_mismo_dia,r.p_dia_siguiente]).filter(Number.isFinite)),y=v=>205-v/max*160,left=55,right=width-12;
  for(let i=0;i<3;i++){const v=max*i/2;svg.append(el('line',{x1:left,y1:y(v),x2:right,y2:y(v),stroke:'#233041'}));label(svg,3,y(v)+4,percent(v));}
  bins.forEach((bin,i)=>{const row=rows.find(r=>r.bin===bin),base=left+(i+.5)*(right-left)/4-23;if(!row)return;for(const [j,key,color] of [[0,'p_mismo_dia',COLORS.Aqua],[1,'p_dia_siguiente',COLORS.Terra]]){const val=row[key]??0;svg.append(el('rect',{x:base+j*23,y:y(val),width:19,height:205-y(val),fill:color}));}label(svg,base+22,226,bin,{'text-anchor':'middle'});});
  svg.append(el('rect',{x:left,y:245,width:12,height:10,fill:COLORS.Aqua}));label(svg,left+17,254,'Mismo día');svg.append(el('rect',{x:left+110,y:245,width:12,height:10,fill:COLORS.Terra}));label(svg,left+127,254,'Día siguiente (control)');
}
