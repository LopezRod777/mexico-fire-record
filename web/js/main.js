import { loadAll } from './data.js';
import { renderMap } from './mapview.js';
import { calendarModel, renderCalendar } from './calendar.js';
import { renderHealth } from './health.js';
import { renderConfidence } from './confidence.js';
import { loadLive } from './live.js';
import { downloadCsv } from './csv.js';

async function main(){
  const firmsLink=document.querySelector('a[href*="firms.modaps.eosdis.nasa.gov"]');
  if(firmsLink) firmsLink.textContent=firmsLink.href;
  const data=await loadAll(),series=data['series_monthly.json'],harmonized=data['harmonized.json'],cells=data['cells_yearly.json'],geo=data['geo/mx_states.geojson'],health=data['health.json'];
  const state={region:'MX',sensor:'Aqua',year:2024,view:'harmonized',metric:'count'};
  const select=document.getElementById('region-select');
  Object.entries(series.region_names).filter(([id])=>id!=='MX').sort((a,b)=>a[1].localeCompare(b[1],'es-MX')).forEach(([id,name])=>{const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);});
  function drawRegion(){document.getElementById('calendar-region').textContent=state.region==='MX'?'México (nacional)':series.region_names[state.region];renderMap(cells,geo,state.region,state.sensor,state.year,id=>{state.region=id;select.value=id;drawRegion();});renderCalendar(calendarModel(state.region,state.view,state.metric,series,harmonized),state.metric);renderConfidence(state.region,harmonized);}
  select.addEventListener('change',()=>{state.region=select.value;drawRegion();});
  document.querySelectorAll('[name="map-sensor"]').forEach(input=>input.addEventListener('change',()=>{if(input.checked){state.sensor=input.value;drawRegion();}}));
  document.getElementById('map-year').addEventListener('input',e=>{state.year=Number(e.target.value);document.getElementById('map-year-value').textContent=state.year;drawRegion();});
  document.getElementById('calendar-view').addEventListener('change',e=>{state.view=e.target.value;drawRegion();});
  document.getElementById('calendar-metric').addEventListener('change',e=>{state.metric=e.target.value;drawRegion();});
  document.getElementById('table-toggle').addEventListener('click',e=>{const graphic=document.getElementById('calendar-graphic'),table=document.getElementById('calendar-table-wrap'),show=table.hidden;table.hidden=!show;graphic.hidden=show;e.target.textContent=show?'Ver como calendario':'Ver como tabla';e.target.setAttribute('aria-expanded',show);});
  document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',()=>downloadCsv(state.region,series,harmonized)));
  for(const id of ['lst-place','ratio-place','ratio-day','version-place','overlap-day'])document.getElementById(id).addEventListener('change',()=>renderHealth(health));
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderCalendar(calendarModel(state.region,state.view,state.metric,series,harmonized),state.metric);renderHealth(health);},120);});
  drawRegion();renderHealth(health);loadLive(series.region_names,geo);
}
main().catch(error=>{document.getElementById('load-error').textContent=`No se pudo iniciar la página: ${error.message}`;});
