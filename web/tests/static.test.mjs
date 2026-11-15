import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root=new URL('../',import.meta.url),html=readFileSync(new URL('index.html',root),'utf8');
function files(dir){return readdirSync(new URL(dir,root),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(`${dir}${entry.name}/`):[`${dir}${entry.name}`]);}
test('static: local resources, external navigation links and CSP',()=>{for(const [,tag,url] of html.matchAll(/<(a|img|script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)){if(url.startsWith('#')||url.startsWith('data:image/svg+xml,'))continue;if(url.startsWith('https:')){assert.equal(tag,'a',`Remote resource: ${tag} ${url}`);continue;}assert.ok(existsSync(new URL(url,root)),url);}assert.match(html,/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'">/);assert.doesNotMatch(html,/\sstyle="/);});
test('static: no unsafe script calls or remote runtime resources',()=>{for(const name of files('js/')){const text=readFileSync(new URL(name,root),'utf8');assert.doesNotMatch(text,/\b(?:innerHTML|eval|document\.write)\b|new Function/);for(const [,path] of text.matchAll(/fetch\(['`]data\/([^'`]+)['`]\)/g)){if(path==='live_snapshot.json'||path.includes('${'))continue;assert.ok(existsSync(new URL(`data/${path}`,root)),path);}}const loader=readFileSync(new URL('js/data.js',root),'utf8');for(const [,path] of loader.matchAll(/'((?:geo\/)?[a-z_]+\.(?:json|geojson))'/g))assert.ok(existsSync(new URL(`data/${path}`,root)),path);for(const name of files('')){if(name.startsWith('data/')||name.startsWith('img/')||name.startsWith('fonts/')||name.startsWith('video/'))continue;const text=readFileSync(new URL(name,root),'utf8');if(name==='index.html'){const stripped=text.replace(/<a\b[^>]*href="https:\/\/[^\"]+"[^>]*>/g,'');assert.doesNotMatch(stripped,/https?:\/\//);}else assert.doesNotMatch(name.startsWith('vendor/')?text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm,''):text,/https?:\/\//,name);}});
// vendor/: satellite.js 7.1.0 copiado tal cual (sus URL viven solo en comentarios, que la línea
// anterior quita). Aquí: imports relativos que existen, sin WASM ni carga remota o dinámica.
test('static: imports locales resolubles y vendor sin WASM, eval ni red',()=>{
  const modules=files('js/').concat(files('vendor/')).filter(name=>name.endsWith('.js'));
  assert.ok(modules.some(name=>name.startsWith('vendor/satellite.js-7.1.0/')));
  for(const name of modules){
    const text=readFileSync(new URL(name,root),'utf8');
    for(const [,spec] of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)){assert.match(spec,/^\.\.?\//,`${name}: ${spec}`);assert.ok(existsSync(new URL(spec,new URL(name,root))),`${name}: ${spec}`);assert.doesNotMatch(spec,/wasm/i,`${name}: ${spec}`);}
    assert.doesNotMatch(text,/\bimport\s*\(|WebAssembly|\beval\s*\(|new Function|XMLHttpRequest|importScripts/,name);
    if(name.startsWith('vendor/'))assert.doesNotMatch(text,/\bfetch\s*\(/,name);
  }
  assert.ok(existsSync(new URL('vendor/satellite.js-7.1.0/LICENSE.md',root)));
});
