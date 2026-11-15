import { colorFor, quantile } from './colors.js';
import { VIEW, project, geometryToPath } from './geo.js';
import { number } from './format.js';
const NS = 'http:' + '//www.w3.org/2000/svg';
function el(tag, attrs) { const node = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); return node; }
export function renderMap(cells, geo, selectedId, sensor, year, onSelect) {
  const svg = document.getElementById('map-svg'); svg.replaceChildren();
  const title = el('title', { id: 'map-title' }); title.textContent = `Actividad ${sensor === 'SNPP' ? 'S-NPP' : sensor}, ${year}`; svg.append(title);
  const desc = el('desc', { id: 'map-desc' }); desc.textContent = 'Celdas coloreadas por conteo anual; selecciona un estado para cambiar la región.'; svg.append(desc);
  const yearIndex = cells.years.indexOf(year), values = cells.cell_days[sensor].map(v => v[yearIndex]);
  const visible = values.map((v,i) => selectedId === 'MX' || cells.state[i] === selectedId ? v : null).filter(Number.isFinite);
  const max = quantile(visible, .98), noData = !visible.length;
  document.getElementById('map-empty').textContent = noData ? 'Sin dato de este sensor en ese año' : '';
  document.getElementById('map-max').textContent = number(max);
  const [x0,y0] = project(-.125, .125), [x1,y1] = project(.125,-.125), cellW = Math.abs(x1-x0), cellH = Math.abs(y1-y0);
  values.forEach((v,i) => { if (v == null || (selectedId !== 'MX' && cells.state[i] !== selectedId)) return; const [x,y] = project(cells.lon[i],cells.lat[i]); const r = el('rect', { x:x-cellW/2,y:y-cellH/2,width:cellW,height:cellH,fill:colorFor(max ? v/max : 0),opacity:'.88','pointer-events':'none' }); svg.append(r); });
  geo.features.forEach(feature => {
    const id = feature.properties.id, path = el('path', { d:geometryToPath(feature.geometry,VIEW),class:id === selectedId ? 'selected' : '',tabindex:0,role:'button','aria-label':`Seleccionar ${feature.properties.name}` });
    path.addEventListener('click',()=>onSelect(id)); path.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(id);}}); svg.append(path);
  });
}
