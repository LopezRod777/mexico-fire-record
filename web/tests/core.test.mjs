import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { number, percent, monthLabel } from '../js/format.js';
import { PALETTE, colorFor, luminance, contrast } from '../js/colors.js';
import { VIEW, project, ringToPath, geometryToPath } from '../js/geo.js';
import { anomalies } from '../js/anomaly.js';
import { buildCsv, escapeCsv } from '../js/csv.js';
import { calendarModel, legendMark, scaleValue, niceTicks } from '../js/calendar.js';
import { confidenceText, methodKey, errorStrip } from '../js/confidence.js';
import { versionPeriods } from '../js/version-periods.js';
const load = name => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
test('versionPeriods agrupa años consecutivos por versión dominante',()=>{
  const rows=[
    {satellite:'Terra',year:2020,version:'6.03',n:3},{satellite:'Terra',year:2020,version:'6.2',n:5},
    {satellite:'Terra',year:2021,version:'6.2',n:7},{satellite:'Terra',year:2023,version:'61.03',n:9},
    {satellite:'Aqua',year:2021,version:'6.03',n:2}
  ];
  assert.deepEqual(versionPeriods(rows),[
    {satellite:'Terra',version:'6.2',from:2020,to:2021},
    {satellite:'Terra',version:'61.03',from:2023,to:2023},
    {satellite:'Aqua',version:'6.03',from:2021,to:2021}
  ]);
});
test('health.json: Terra y Aqua en México pasan a 61.03 en 2023',()=>{
  const health=load('health.json');
  for(const satellite of ['Terra','Aqua'])assert.ok(versionPeriods(health.mx.versions_by_year).some(period=>period.satellite===satellite&&period.version==='61.03'&&period.from===2023));
});
const series=load('series_monthly.json'),harmonized=load('harmonized.json');
test('format: es-MX, porcentajes y mes',()=>{assert.equal(number(12345.6),'12,345.6');assert.equal(percent(.248),'24.8 %');assert.equal(monthLabel('2025-04'),'abr 2025');});
test('colors: extremos, luminancia monótona y contraste',()=>{assert.equal(colorFor(0),PALETTE[0]);assert.equal(colorFor(1),PALETTE.at(-1));const ls=Array.from({length:21},(_,i)=>luminance(colorFor(i/20)));for(let i=1;i<ls.length;i++)assert.ok(ls[i]>=ls[i-1],`${i}: ${ls[i]} < ${ls[i-1]}`);for(const fg of ['#e6edf3','#9fb0c3'])assert.ok(contrast(fg,'#0b0f14')>=4.5);assert.ok(contrast('#ff7a1a','#0b0f14')>=3);});
test('geo: encuadre, norte, este y MultiPolygon',()=>{for(const [lon,lat] of [[-118.4,14.5],[-86.7,32.7]]){const [x,y]=project(lon,lat);assert.ok(x>=0&&x<=VIEW.width&&y>=0&&y<=VIEW.height);}assert.ok(project(-89.62,20.97)[0]>project(-103.35,20.67)[0]);assert.ok(project(-100,32)[1]<project(-100,15)[1]);const ring=[[-100,20],[-99,20],[-99,21],[-100,20]];assert.match(ringToPath(ring),/^M.*Z$/);assert.match(geometryToPath({type:'MultiPolygon',coordinates:[[ring],[ring]]}),/^M.*Z M.*Z$/);});
test('anomaly: mediana por mes e ignora null',()=>{const months=['2020-01','2020-02','2021-01','2021-02','2022-01','2022-02'];assert.deepEqual(anomalies(months,[10,null,20,4,30,8]),[50,null,100,66.66666666666666,150,133.33333333333331]);});
for(const id of ['MX','MX-JAL'])test(`csv: ${id}, filas y valores reales`,()=>{const csv=buildCsv(id,series,harmonized),lines=csv.trimEnd().split('\n');assert.equal(lines[0],'mes,terra,aqua,snpp,armonizada,lo,hi,fuente,deriva');assert.equal(lines.length,series.months.length+1);const snpp=lines.slice(1).reduce((sum,line)=>sum+(Number(line.split(',')[3])||0),0);assert.equal(snpp,series.regions[id].SNPP.reduce((sum,v)=>sum+(v||0),0));assert.equal(lines[1].split(',')[3],'');assert.equal(lines[1].split(',')[8],harmonized.regions[id].deriva[0]?'1':'0');assert.equal(escapeCsv('a,"b"\nc'),'"a,""b""\nc"');});
test('calendar: 26 × 12, marcas y deriva',()=>{let m=calendarModel('MX','harmonized','count',series,harmonized);assert.equal(m.length,26);assert.ok(m.every(row=>row.length===12));assert.equal(m[0][0].value,null);assert.equal(m[12][0].estimated,true);assert.equal(m[12][1].estimated,false);for(const view of ['Terra','Aqua']){m=calendarModel('MX',view,'count',series,harmonized);assert.equal(m[22][0].drift,true);}});
test('calendar: escala raíz, recorte y marcas crecientes',()=>{assert.equal(scaleValue(0,100,'count'),0);assert.equal(scaleValue(100,100,'count'),1);assert.equal(scaleValue(200,100,'count'),1);assert.equal(scaleValue(25,100,'count'),.5);assert.equal(scaleValue(25,100,'anomaly'),.25);for(const mode of ['count','anomaly']){const samples=[0,10,20,40,80,100].map(v=>scaleValue(v,100,mode));for(let i=1;i<samples.length;i++)assert.ok(samples[i]>=samples[i-1]);}const ticks=niceTicks(4000,5);assert.equal(ticks.length,5);assert.equal(ticks[0],0);assert.equal(ticks.at(-1),4000);for(let i=1;i<ticks.length;i++)assert.ok(ticks[i]>ticks[i-1]);});
test('calendar: leyenda redondea conteos y conserva precisión de anomalías',()=>{assert.equal(legendMark(1234.6,'count'),'1,235');assert.equal(legendMark(12.34,'anomaly'),'12.3 %');assert.equal(legendMark(12.34,'anomaly',true),'12.3 % o más');});
test('confidence: cifras reales para nacional y estado',()=>{const key=methodKey(harmonized),summary=harmonized.validation_resumen[key];for(const id of ['MX','MX-JAL']){const v=harmonized.regions[id].validation[key],text=confidenceText(id,harmonized);assert.ok(text.includes(percent(v.mape_razon_mensual)));assert.ok(text.includes(percent(v.mape_razon_global)));assert.ok(text.includes(percent(summary.mediana_mape_razon_mensual)));assert.ok(text.includes(number(v.n_meses)));}});

test('confidence: selecciona unión si existe y Aqua si no',()=>{const aqua={validation_resumen:{'aqua->snpp':{}},regions:{}};const union={validation_resumen:{'aqua->snpp':{},'union->snpp':{}},regions:{}};assert.equal(methodKey(aqua),'aqua->snpp');assert.equal(methodKey(union),'union->snpp');});
test('tira de error: ambas claves, 32 estados ordenados y percentiles',()=>{for(const key of ['aqua->snpp','union->snpp']){const fixture={validation_resumen:{[key]:{}},regions:{MX:{validation:{[key]:{mape_razon_mensual:.01}}}}};for(let i=32;i>=1;i--)fixture.regions[`MX-${i}`]={validation:{[key]:{mape_razon_mensual:i/100}}};const strip=errorStrip(fixture);assert.equal(strip.key,key);assert.equal(strip.rows.length,32);assert.equal(strip.min.value,.01);assert.equal(strip.max.value,.32);assert.equal(strip.median,.165);assert.equal(strip.p25,.0875);assert.equal(strip.p75,.2425);assert.ok(strip.rows.every((row,i)=>i===0||strip.rows[i-1].value<=row.value));}});
test('fuente arbitraria diferente de SNPP es estimada',()=>{const fixture={...harmonized,regions:{...harmonized.regions,MX:{...harmonized.regions.MX,fuente:[...harmonized.regions.MX.fuente]}}};fixture.regions.MX.fuente[series.months.indexOf('2012-01')]='Terra∪Aqua*k';assert.equal(calendarModel('MX','harmonized','count',series,fixture)[12][0].estimated,true);});

test('contraste de texto y trazos nuevos',()=>{for(const bg of ['#0E0B0A','#18110F']){for(const fg of ['#F2E9E1','#B9A99C'])assert.ok(contrast(fg,bg)>=4.5,`${fg} sobre ${bg}`);for(const fg of ['#F0B35A','#8FC3D4','#FFC24A','#D4571A'])assert.ok(contrast(fg,bg)>=3,`${fg} sobre ${bg}`);}});
