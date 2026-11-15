import { loadAll } from './data.js';
import { renderMap } from './mapview.js';
import { calendarModel, renderCalendar } from './calendar.js';
import { renderHealth } from './health.js';
import { renderConfidence } from './confidence.js';
import { loadLive } from './live.js';
import { downloadCsv } from './csv.js';
import { monthStory, daysFigure, harmonizedMethod } from './editorial.js';
import { setupMotion, animateCalendarChange, animateErrorChange, setLanguageRepaint } from './motion.js';
import { t, chooseLanguage, setLanguage, getLanguage, regionName } from './i18n.js';

function paintStatic(){
  document.documentElement.lang=getLanguage();
  document.title=t('meta.title');
  document.querySelector('meta[name="description"]').content=t('meta.description');
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n);});
  document.querySelectorAll('[data-i18n-attr]').forEach(el=>{
    for(const pair of el.dataset.i18nAttr.split('|')){const [attr,key]=pair.split(':');if(attr&&key)el.setAttribute(attr,t(key));}
  });
  document.querySelectorAll('.language-switch button[data-lang]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.lang===getLanguage())));
}

async function main(){
  let storage;try{storage=window.localStorage;}catch{}
  setLanguage(chooseLanguage(location.search,storage,navigator.language));
  paintStatic();
  const firmsLink=document.querySelector('a[href*="firms.modaps.eosdis.nasa.gov"]');
  if(firmsLink) firmsLink.textContent=firmsLink.href;
  const data=await loadAll(),series=data['series_monthly.json'],harmonized=data['harmonized.json'],cells=data['cells_yearly.json'],geo=data['geo/mx_states.geojson'],health=data['health.json'];
  function paintEditorial(){document.getElementById('days-summary').textContent=monthStory(harmonized);document.getElementById('days-figure').textContent=daysFigure(harmonized);const method=harmonizedMethod(harmonized);if(method)document.getElementById('method-harmonized').textContent=method;}
  paintEditorial();
  const state={region:'MX',sensor:'Aqua',year:2024,view:'harmonized',metric:'count'};
  const select=document.getElementById('region-select');
  Object.entries(series.region_names).filter(([id])=>id!=='MX').sort((a,b)=>a[1].localeCompare(b[1],'es-MX')).forEach(([id,name])=>{const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);});
  function paintRegions(){select.querySelectorAll('option').forEach(option=>{option.textContent=regionName(option.value,series.region_names);});}
  function drawRegion(){document.getElementById('calendar-region').textContent=regionName(state.region,series.region_names);renderMap(cells,geo,state.region,state.sensor,state.year,id=>{state.region=id;select.value=id;drawRegion();},series.region_names);renderCalendar(calendarModel(state.region,state.view,state.metric,series,harmonized),state.metric);renderConfidence(state.region,harmonized,series.region_names);animateCalendarChange();animateErrorChange();}
  paintRegions();
  select.addEventListener('change',()=>{state.region=select.value;drawRegion();});
  document.querySelectorAll('[name="map-sensor"]').forEach(input=>input.addEventListener('change',()=>{if(input.checked){state.sensor=input.value;drawRegion();}}));
  document.getElementById('map-year').addEventListener('input',e=>{state.year=Number(e.target.value);document.getElementById('map-year-value').textContent=state.year;drawRegion();});
  document.getElementById('calendar-view').addEventListener('change',e=>{state.view=e.target.value;drawRegion();});
  document.getElementById('calendar-metric').addEventListener('change',e=>{state.metric=e.target.value;drawRegion();});
  document.getElementById('table-toggle').addEventListener('click',e=>{const graphic=document.getElementById('calendar-graphic'),table=document.getElementById('calendar-table-wrap'),show=table.hidden;table.hidden=!show;graphic.hidden=show;e.target.textContent=show?t('main.calendar'):t('main.table');e.target.setAttribute('aria-expanded',show);});
  document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',()=>downloadCsv(state.region,series,harmonized)));
  for(const id of ['lst-place','ratio-place','ratio-day','version-place','overlap-day'])document.getElementById(id).addEventListener('change',()=>renderHealth(health));
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderCalendar(calendarModel(state.region,state.view,state.metric,series,harmonized),state.metric);renderHealth(health);},120);});
  drawRegion();renderHealth(health);setupMotion();await loadLive(series.region_names,geo,health);
  document.querySelectorAll('.language-switch button[data-lang]').forEach(button=>button.addEventListener('click',async()=>{
    const next=button.dataset.lang;if(next===getLanguage())return;
    setLanguageRepaint(true);setLanguage(next);
    try{localStorage.setItem('lang',next);}catch{}
    const url=new URL(location.href);url.searchParams.set('lang',next);history.replaceState(history.state,'',url);
    paintStatic();paintEditorial();paintRegions();drawRegion();renderHealth(health);
    document.getElementById('table-toggle').textContent=t(document.getElementById('calendar-table-wrap').hidden?'main.table':'main.calendar');
    try{await loadLive(series.region_names,geo,health);}finally{setLanguageRepaint(false);}
  }));
}
main().catch(error=>{document.getElementById('load-error').textContent=t('main.loadError',{message:error.message});});
