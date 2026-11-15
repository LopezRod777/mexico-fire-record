import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countAt, flameStagger } from '../js/motion.js';
import { daysOf2005, monthStory, daysFigure, legendSteps, harmonizedMethod } from '../js/editorial.js';
import { PALETTE, contrast } from '../js/colors.js';
import { setLanguage, t } from '../js/i18n.js';

test('cuenta: termina exactamente y reduce muestra el valor directo',()=>{
  assert.equal(countAt(1234,0),0);
  assert.equal(countAt(1234,1),1234);
  assert.equal(countAt(1234,.2,true),1234);
  assert.ok(countAt(1234,.5)>countAt(1234,.25));
});
test('llamas: FRP ascendente y escalonado dentro de 1.1 s',()=>{
  const plan=flameStagger([{frp:8},{frp:null},{frp:20},{frp:3}]);
  assert.deepEqual(plan.map(p=>p.index),[1,3,0,2]);
  assert.equal(plan[0].delay,0);
  assert.ok(plan.at(-1).delay<=1100);
  assert.ok(flameStagger(Array.from({length:200},(_,i)=>({frp:i}))).at(-1).delay<=1100);
});
test('dos días: compara marzo y mayo y halla el mayor mes del fixture',()=>{
  const fixture={months:['2005-03','2005-04','2005-05','2005-06'],regions:{MX:{valor:[10,30,20,5]}}};
  assert.deepEqual(daysOf2005(fixture),{march:10,may:20,highest:{month:'2005-04',value:30}});
  assert.match(monthStory(fixture),/Abril fue el mes con mayor valor de 2005: 30/);
});
test('dos días: la cifra de mayo va junto a la foto y no se repite en el texto',()=>{
  const fixture={months:['2005-03','2005-05'],regions:{MX:{valor:[18805.4,58832.8]}}};
  const story=monthStory(fixture);
  assert.equal(daysFigure(fixture),'58,833');
  assert.equal((story.match(/58,833/g)??[]).length,0);
  assert.match(story,/18,805/);
  assert.doesNotMatch(story,/\.\d celdas-día/);
});
test('leyenda: siete pasos discretos sin interpolación de color',()=>{
  const steps=legendSteps(100,'count',true);
  assert.deepEqual(steps.map(s=>s.color),PALETTE);
  assert.equal(steps[0].value,0);
  assert.equal(steps.at(-1).value,100);
  assert.equal(steps.at(-1).overflow,true);
});
test('método: unión usa error Terra desde JSON; sin unión conserva el texto previo',()=>{
  const fixture={validation_resumen:{'union->snpp':{},'terra->snpp':{mediana_mape_razon_mensual:.275}}};
  assert.match(harmonizedMethod(fixture),/27.5 %/);
  assert.equal(harmonizedMethod({validation_resumen:{'aqua->snpp':{}}}),null);
});
test('contrastes editoriales: texto y marcas sobre campos sólidos',()=>{
  for(const [fg,bg,min] of [['#000000','#FF6831',4.5],['#000000','#C5C5C5',4.5],['#ECEAE6','#0E0B0A',4.5],['#000000','#FF6831',3]])assert.ok(contrast(fg,bg)>=min,`${fg} en ${bg}: ${contrast(fg,bg)}`);
  const css=readFileSync(new URL('../css/styles.css',import.meta.url),'utf8');
  assert.doesNotMatch(css,/linear-gradient|radial-gradient|Plex Mono|box-shadow/);
});
test('statements: tres reglas limitadas a 24 px y 20 px en móvil',()=>{
  const css=readFileSync(new URL('../css/styles.css',import.meta.url),'utf8');
  for(const selector of ['.days-copy p','.confidence-lead p','.live-stat strong']){
    assert.match(css,new RegExp(`${selector.replaceAll('.','\\.')}\\{[^}]*font-size:clamp\\(20px, 1\\.2rem \\+ 0\\.6vw, 24px\\)`));
  }
  assert.match(css,/@media\(max-width:768px\)\{[^}]*\.days-copy p,\.confidence-lead p,\.live-stat:not\(:first-child\) strong\{font-size:20px\}/);
});
test('Hoy: cifra y contexto en span separado, traducido en ambos idiomas',()=>{
  const source=readFileSync(new URL('../js/live.js',import.meta.url),'utf8');
  assert.match(source,/card\.append\(node\('span','live-median-context',t\('live\.medianContext'/);
  setLanguage('es');assert.equal(t('live.medianContext',{median:'97.5'}),'(mediana histórica para esa fecha: 97.5)');
  setLanguage('en');assert.equal(t('live.medianContext',{median:'97.5'}),'(historical median for this date: 97.5)');
  setLanguage('es');
});
