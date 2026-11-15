// "Take a photo", compartir el reporte con la foto y la descripción del lugar (estado y localidad).
// El bloque se monta sobre un DOM mínimo de prueba: lo justo para tocar botones y leer textos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { setLanguage, dictionaries } from '../js/i18n.js';
import { stateAt, compass, nearestPlace, describePoint, kmToMexico, coversPoint, PLACE_KM, COVER_KM } from '../js/place.js';
import { smokeAt } from '../js/smoke.js';
import { haversineKm } from '../js/nearby.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const geo = read('../data/geo/mx_states.geojson'), snapshot = read('./fixtures/live_snapshot.sample.json');
const localidades = read('../data/localidades_mx.json');
const GDL = { lat: 20.6767, lon: -103.3475 };
const north = (p, km) => ({ lat: p.lat + km / 111.195, lon: p.lon });

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.text = ''; this.hidden = false; }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this.text; }
  set textContent(v) { this.children = []; this.text = String(v); }
  detach() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  place(at, nodes) { for (const n of nodes) n.detach(); this.children.splice(at, 0, ...nodes); for (const n of nodes) n.parent = this; }
  append(...nodes) { this.place(this.children.length, nodes); }
  prepend(...nodes) { this.place(0, nodes); }
  after(...nodes) { this.parent.place(this.parent.children.indexOf(this) + 1, nodes); }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  find(cls) { return this.all().find(e => e.className.split(' ').includes(cls)) ?? null; }
  byId(id) { return this.all().find(e => e.id === id) ?? null; }
  querySelector(sel) { return sel.startsWith('.') ? this.find(sel.slice(1)) : this.all().slice(1).find(e => e.tagName === sel.toUpperCase()) ?? null; }
  scrollIntoView() {} focus() {} select() {}
  get clientWidth() { return 0; }
}
globalThis.document = { createElement: tag => new El(tag), createElementNS: (ns, tag) => new El(tag) };
globalThis.requestAnimationFrame = () => 0;
globalThis.matchMedia = () => ({ matches: true });
const nav = { geolocation: { getCurrentPosition: ok => ok({ coords: { latitude: GDL.lat, longitude: GDL.lon } }) }, clipboard: { writeText: async text => { nav.copied = text; } } };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
const requests = []; let placesReply = { ok: false, status: 404 };
globalThis.fetch = async url => { requests.push(String(url)); return placesReply; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const mapApi = { showPoint() {}, startPick() {}, stopPick() {}, scrollToMap() {} };
const JPEG = new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])], 'fuego.jpg', { type: 'image/jpeg' });
const HEIC = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], 'IMG_0001.HEIC', { type: 'image/heic' });
const { buildFireBlock, placeText } = await import('../js/fire.js');
const build = () => buildFireBlock({ snapshot, tle: null, geo, mapApi });
async function pick(block, id, file) { const input = block.byId(id); input.files = file ? [file] : []; await input.fire('change'); await tick(); }
async function typeCoords(block, lat, lon) { const [a, b] = block.find('fire-manual').children.filter(e => e.className === 'fire-field').map(f => f.querySelector('input')); a.value = lat; b.value = lon; await block.find('fire-manual').fire('submit'); await tick(); }
const manualNote = block => block.find('fire-manual').children.at(-1).textContent;
const notes = block => block.find('fire-panel').children.filter(e => e.className === 'fire-note' && e.textContent).map(e => e.textContent);
const statusOf = block => block.find('fire-report').children.find(e => e.className === 'fire-note').textContent;

// ---------- Lugar: estado, rumbo y distancia ----------
test('lugar: rumbo en ocho direcciones y distancia con casos conocidos', () => {
  const o = { lat: 20, lon: -100 }, d = 0.1;
  const cases = { N: [d, 0], NE: [d, d], E: [0, d], SE: [-d, d], S: [-d, 0], SW: [-d, -d], W: [0, -d], NW: [d, -d] };
  for (const [dir, [dLat, dLon]] of Object.entries(cases)) assert.equal(compass(o, { lat: o.lat + dLat, lon: o.lon + dLon }), dir);
  const places = { estados: { 'MX-JAL': [['Pueblo', 20677, -103347]], 'MX-NAY': [['Lejos', 21500, -104900]], malo: 'x' } };
  const near = nearestPlace(north({ lat: 20.677, lon: -103.347 }, 3), places);
  assert.equal(near.name, 'Pueblo'); assert.equal(near.stateId, 'MX-JAL'); assert.equal(near.dir, 'N');
  assert.ok(Math.abs(near.km - 3) < 0.01, String(near.km));
  assert.equal(nearestPlace(GDL, null), null);
  assert.equal(nearestPlace(GDL, { estados: {} }), null);
});
test('lugar: fuera de México no dice nada, y sin archivo o sin localidad a 5 km solo el estado', () => {
  assert.equal(stateAt(GDL, geo).id, 'MX-JAL');
  for (const p of [{ lat: 31.0, lon: -100.0 }, { lat: 14.6, lon: -90.5 }, { lat: 22.0, lon: -95.0 }]) { assert.equal(stateAt(p, geo), null); assert.equal(describePoint(p, geo, localidades), null); }
  assert.deepEqual(describePoint(GDL, geo, null), { kind: 'state', stateId: 'MX-JAL', stateName: 'Jalisco' });
  const places = { estados: { 'MX-JAL': [['Pueblo', 20677, -103347]] } }, base = { lat: 20.677, lon: -103.347 };
  assert.equal(PLACE_KM, 5);
  assert.equal(describePoint(north(base, 0.15), geo, places).kind, 'in');
  assert.equal(describePoint(north(base, 0.4), geo, places).kind, 'near');
  assert.equal(describePoint(north(base, 4.9), geo, places).kind, 'near');
  // A 10 km no se nombra la localidad: solo el estado del punto.
  assert.deepEqual(describePoint(north(base, 10), geo, places), { kind: 'far', stateId: 'MX-JAL', stateName: 'Jalisco' });
});
test('lugar: la frase da metros bajo 1 km, un decimal hasta 5 km y nunca inventa', () => {
  const d = (kind, km, dir = 'NW') => ({ kind, place: 'Tequila', stateId: 'MX-JAL', stateName: 'Jalisco', km, dir });
  setLanguage('en');
  assert.equal(placeText(null, 'fire.where'), '');
  assert.equal(placeText(d('near', 0.42, 'N'), 'fire.where'), 'About 400 m N of Tequila, Jalisco.');
  assert.equal(placeText(d('near', 0.97), 'fire.where'), 'About 1 km NW of Tequila, Jalisco.');
  assert.equal(placeText(d('near', 2.34), 'fire.where'), 'About 2.3 km NW of Tequila, Jalisco.');
  assert.equal(placeText(d('in', 0.1), 'fire.where'), 'In Tequila, Jalisco.');
  assert.equal(placeText({ kind: 'far', stateId: 'MX-JAL', stateName: 'Jalisco' }, 'fire.where'), 'In Jalisco, with no listed town within 5 km.');
  assert.equal(placeText({ kind: 'state', stateId: 'MX-MEX', stateName: 'México' }, 'fire.where'), 'In State of Mexico.');
  assert.equal(placeText(d('near', 2.34), 'fire.msgWhere'), ', about 2.3 km NW of Tequila, Jalisco');
  setLanguage('es');
  assert.equal(placeText(d('near', 0.42, 'W'), 'fire.where'), 'A unos 400 m al O de Tequila, Jalisco.');
  assert.equal(placeText(d('near', 2.34), 'fire.where'), 'A unos 2.3 km al NO de Tequila, Jalisco.');
  assert.equal(placeText({ kind: 'far', stateId: 'MX-JAL', stateName: 'Jalisco' }, 'fire.where'), 'En Jalisco, sin localidad listada a 5 km o menos.');
  assert.equal(placeText(d('near', 2.34), 'fire.msgWhere'), ', a unos 2.3 km al NO de Tequila, Jalisco');
  setLanguage('en');
});
test('localidades: archivo de GeoNames con la forma esperada, peso acotado y casos reales', () => {
  const ids = geo.features.map(f => f.properties.id).sort();
  assert.deepEqual(Object.keys(localidades.estados).sort(), ids);
  let n = 0;
  for (const list of Object.values(localidades.estados)) for (const row of list) { n++; assert.ok(typeof row[0] === 'string' && row[0] && Number.isInteger(row[1]) && Number.isInteger(row[2]) && row[1] > 14000 && row[1] < 33000 && row[2] > -119000 && row[2] < -86000, JSON.stringify(row)); }
  assert.equal(n, localidades.n);
  assert.equal(localidades.licencia, 'CC BY 4.0');
  assert.ok(statSync(new URL('../data/localidades_mx.json', import.meta.url)).size <= 1.6 * 1024 * 1024);
  const gdl = describePoint(GDL, geo, localidades);
  assert.equal(gdl.place, 'Guadalajara'); assert.equal(gdl.stateId, 'MX-JAL'); assert.ok(gdl.km < 0.2 && gdl.kind === 'in', JSON.stringify(gdl));
  const tequila = localidades.estados['MX-JAL'].find(r => r[0] === 'Tequila'), p = north({ lat: tequila[1] / 1000, lon: tequila[2] / 1000 }, 10);
  assert.ok(haversineKm(p.lat, p.lon, tequila[1] / 1000, tequila[2] / 1000) > 9.9);
  const out = describePoint(p, geo, localidades);
  assert.ok(out.kind === 'far' || out.km <= 5, JSON.stringify(out));
  assert.notEqual(out.place, 'Tequila');
});
test('lugar: ninguna petición a otro dominio, y crédito a GeoNames en el pie y el README', () => {
  for (const name of ['place.js', 'fire.js']) {
    const text = readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, name);
  }
  assert.match(readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8'), /loadData\('localidades_mx\.json'\)/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /data-i18n="footerPlaces">[^<]*GeoNames, CC BY 4\.0/);
  for (const lang of ['es', 'en']) { assert.match(dictionaries[lang].footerPlaces, /GeoNames, CC BY 4\.0/); assert.match(dictionaries[lang]['fire.whereNote'], /GeoNames/); }
  assert.match(readFileSync(new URL('../../README.md', import.meta.url), 'utf8'), /GeoNames[^\n]*CC BY 4\.0/);
});

// ---------- Flujo en la página ----------
let block;
test('cámara: el control "Take a photo" existe con capture y el de elegir sigue igual', () => {
  setLanguage('en');
  block = build();
  const camera = block.byId('fire-camera'), photo = block.byId('fire-photo');
  assert.equal(camera.type, 'file'); assert.equal(camera.accept, 'image/*'); assert.equal(camera.getAttribute('capture'), 'environment');
  assert.equal(photo.type, 'file'); assert.equal(photo.accept, 'image/jpeg'); assert.equal(photo.getAttribute('capture'), null);
  const labels = block.all().filter(e => e.className === 'fire-photo-label');
  assert.deepEqual(labels.map(l => [l.htmlFor, l.textContent]), [['fire-photo', 'Add a photo (optional)'], ['fire-camera', 'Take a photo']]);
  // Cada input va justo antes de su etiqueta (el foco visible depende de eso).
  const kids = block.find('fire-photo-actions').children;
  assert.deepEqual(kids.map(k => k.id || k.htmlFor), ['fire-photo', 'fire-photo', 'fire-camera', 'fire-camera']);
  for (const lang of ['es', 'en']) { assert.match(dictionaries[lang]['fire.photoNote'], /GPS/); assert.doesNotMatch(dictionaries[lang]['fire.photoNote'], /solo leemos|only read/); }
  assert.deepEqual(requests, [], 'las localidades no se piden antes de tocar "I saw a fire"');
});
test('coordenadas a mano: un campo vacío o con solo espacios no se acepta como 0', async () => {
  for (const [lat, lon] of [['23', ''], ['23', '   '], ['', '-100'], [' ', ' '], ['95', '-100'], ['23', 'abc']]) {
    await typeCoords(block, lat, lon);
    assert.equal(manualNote(block), 'Check the coordinates, because latitude runs from −90 to 90 and longitude from −180 to 180.', JSON.stringify([lat, lon]));
    assert.equal(block.find('fire-result').children.length, 0, 'sin resultado');
    assert.equal(block.find('fire-message'), null);
  }
  assert.deepEqual(requests, []);
});
test('cobertura: dentro de un estado o a 5 km o menos; fuera de eso el punto no está cubierto', () => {
  assert.equal(COVER_KM, 5);
  assert.equal(kmToMexico(GDL, geo), 0);
  const km = (lat, lon) => kmToMexico({ lat, lon }, geo);
  assert.ok(km(40, -105) > 800); assert.ok(km(14.6349, -90.5069) > 100);
  assert.ok(Math.abs(km(32.63, -117.08) - 10.6) < 1, 'San Diego, ~10 km al norte de la frontera');
  for (const [lat, lon] of [[40, -105], [14.6349, -90.5069], [32.63, -117.08], [19.2, -95.82]]) assert.equal(coversPoint({ lat, lon }, geo), false);
  // Pegados a la costa o a la frontera (islas sin polígono propio): el radio de búsqueda aún toca México.
  for (const [lat, lon] of [[21.52, -87.38], [18.65, -91.80], [31.76, -106.49]]) { assert.equal(stateAt({ lat, lon }, geo), null); assert.equal(coversPoint({ lat, lon }, geo), true); }
});
test('archivo de localidades ausente: solo el estado, sin error, y una sola petición propia', async () => {
  await block.find('fire-start').fire('click'); await tick();
  assert.deepEqual(requests, ['data/localidades_mx.json']);
  assert.equal(block.find('fire-where').textContent, 'In Jalisco.');
  assert.match(block.find('fire-message').value, /\(https:[^)]+\), in Jalisco\. /);
  assert.equal(block.find('fire-share-photo'), null);
});
test('localidades cargadas: la frase del lugar aparece en la página y en el mensaje', async () => {
  placesReply = { ok: true, json: async () => localidades };
  block = build(); await tick();
  assert.deepEqual(requests, ['data/localidades_mx.json', 'data/localidades_mx.json']);
  assert.equal(block.find('fire-where').textContent, 'In Guadalajara, Jalisco.');
  assert.match(block.find('fire-message').value, /^I want to report a possible fire at 20\.67670, -103\.34750 \(https:[^)]+\), in Guadalajara, Jalisco\. /);
  assert.ok(block.find('fire-more').children.some(e => /reference point in GeoNames, not to its edge/.test(e.textContent)));
});
test('compartir: sin foto no hay botón aunque el navegador pueda', () => {
  nav.canShare = () => true; nav.share = async () => {};
  block = build();
  assert.equal(block.find('fire-share-photo'), null);
  assert.deepEqual(block.find('fire-share').children.map(e => e.textContent), ['Copy message', 'Open map']);
});
test('foto tomada: entra al mismo flujo que la elegida (JPEG sin GPS, HEIC y tope de tamaño)', async () => {
  delete nav.canShare; delete nav.share;
  for (const [file, note] of [[JPEG, 'Your photo has no GPS location, so we use the other location instead.'], [HEIC, 'We only read JPEG photos, so we use the other location instead.']]) {
    await pick(block, 'fire-photo', file); const chosen = notes(block);
    await pick(block, 'fire-camera', file); const taken = notes(block);
    assert.deepEqual(taken, chosen); assert.deepEqual(taken, [note]);
    assert.equal(block.find('fire-point').textContent, 'Your point is 20.67670, -103.34750, from your phone.');
  }
  const big = new File([new Uint8Array(8)], 'grande.jpg', { type: 'image/jpeg' }); Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
  await pick(block, 'fire-camera', big);
  assert.deepEqual(notes(block), ['The photo is larger than 40 MB, so we did not read it.']);
  // Sin soporte de compartir, con foto, el botón tampoco aparece.
  await pick(block, 'fire-camera', JPEG);
  assert.equal(block.find('fire-share-photo'), null);
});
test('compartir: con foto y soporte aparece, y share recibe el archivo y el mismo texto que copiar', async () => {
  const asked = [], shared = [];
  nav.canShare = data => { asked.push(data); return true; };
  nav.share = async data => { shared.push(data); };
  await pick(block, 'fire-camera', JPEG);
  const button = block.find('fire-share-photo');
  assert.equal(button.textContent, 'Share report with photo'); assert.equal(button.type, 'button');
  assert.deepEqual(block.find('fire-report').children.map(e => e.textContent).slice(1, 3), ['Call 911', 'Share report with photoCopy messageOpen map']);
  assert.ok(block.find('fire-more').children.some(e => e.textContent === 'Sharing the report sends your photo and your location to the app and the person you choose.'));
  assert.equal(shared.length, 0, 'nada se comparte sin un toque');
  await button.fire('click');
  await block.find('fire-copy').fire('click');
  assert.equal(shared.length, 1);
  assert.deepEqual(Object.keys(shared[0]).sort(), ['files', 'text']);
  assert.equal(shared[0].files.length, 1); assert.equal(shared[0].files[0], JPEG);
  assert.equal(shared[0].text, nav.copied); assert.equal(shared[0].text, block.find('fire-message').value);
  assert.equal(asked.at(-1).files[0], JPEG);
  // La foto elegida (no tomada) también se puede compartir, y al quitar la foto el botón se va.
  await pick(block, 'fire-photo', HEIC);
  await block.find('fire-share-photo').fire('click');
  assert.equal(shared[1].files[0], HEIC);
  await pick(block, 'fire-photo', null);
  assert.equal(block.find('fire-share-photo'), null);
});
test('compartir: cancelar no muestra error, y otra falla pide copiar el mensaje', async () => {
  nav.share = async () => { throw Object.assign(new Error('cancelado'), { name: 'AbortError' }); };
  await pick(block, 'fire-camera', JPEG);
  await block.find('fire-share-photo').fire('click');
  assert.equal(statusOf(block), '');
  nav.share = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); };
  await block.find('fire-share-photo').fire('click');
  assert.equal(statusOf(block), 'It could not be shared, so copy the message and send it by hand.');
  nav.share = async () => { throw Object.assign(new Error('cancelado'), { name: 'AbortError' }); };
  await block.find('fire-share-photo').fire('click');
  assert.equal(statusOf(block), '', 'el aviso anterior se limpia al reintentar');
});
test('compartir: la foto vive solo en memoria y el idioma se respeta', async () => {
  const fire = readFileSync(new URL('../js/fire.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fire, /localStorage|sessionStorage|indexedDB|createObjectURL|FileReader|FormData|blob:/);
  setLanguage('es');
  block = build(); await tick();
  assert.equal(block.find('fire-share-photo').textContent, 'Compartir reporte con foto');
  assert.equal(block.find('fire-where').textContent, 'En Guadalajara, Jalisco.');
  for (const lang of ['es', 'en']) for (const key of ['fire.cameraLabel', 'fire.sharePhoto', 'fire.shareFailed', 'fire.sharePhotoNote', 'fire.whereNear', 'fire.whereNearM', 'fire.whereIn', 'fire.whereFar', 'fire.whereState', 'fire.whereNote']) assert.ok(dictionaries[lang][key], `${lang} ${key}`);
  setLanguage('es');
});

// ---------- Correcciones: fuera de México y humo que cruza la medianoche UTC ----------
test('punto fuera de México: sin veredicto, humo, pases ni reporte, y queda elegir otro punto', async () => {
  setLanguage('en');
  block = build(); await tick();
  await typeCoords(block, '20,5', '-103.2');
  assert.equal(manualNote(block), '');
  assert.equal(block.find('fire-point').textContent, 'Your point is 20.50000, -103.20000, typed by hand.');
  assert.ok(block.find('fire-call') && block.find('fire-message'));
  await typeCoords(block, '40', '-105');
  const result = block.find('fire-result');
  assert.deepEqual(result.children.map(e => e.textContent), ['What satellites saw near your point', 'Your point is 40.00000, -105.00000, typed by hand.', 'This point is outside Mexico, and this page only covers Mexico.']);
  for (const cls of ['fire-call', 'fire-copy', 'fire-share-photo', 'fire-message', 'fire-smoke', 'fire-passes', 'fire-more', 'fire-where', 'fire-none-why']) assert.equal(block.find(cls), null, cls);
  assert.doesNotMatch(result.textContent, /no heat detections/);
  assert.equal(block.find('fire-again').hidden, false);
  assert.equal(block.find('fire-again').textContent, 'Choose another point on the map');
  setLanguage('es');
  block = build(); await tick();
  assert.equal(block.find('fire-verdict').textContent, 'Este punto está fuera de México, y esta página solo cubre México.');
});
test('humo: una pluma real que cruza la medianoche UTC se lee con sus dos fechas', async () => {
  const humo = read('./fixtures/humo_medianoche.json'), inside = { lat: 25.83, lon: -108.4 };
  assert.deepEqual(smokeAt(inside, humo), { from: '20:10', to: '00:00', date: '2026-11-14', dateTo: '2026-11-15', densidad: 'Light' });
  const realNow = Date.now; Date.now = () => Date.parse(snapshot.generado) + 3600000;
  try {
    for (const [lang, text] of [['en', 'NOAA analysts also outlined a smoke plume over this point between 20:10 UTC on Nov 14, 2026 and 00:00 UTC on Nov 15, 2026.'], ['es', 'Analistas de NOAA también trazaron una pluma de humo sobre este punto entre las 20:10 UTC del 14 nov 2026 y las 00:00 UTC del 15 nov 2026.']]) {
      setLanguage(lang);
      block = buildFireBlock({ snapshot: { ...snapshot, humo }, tle: null, geo, mapApi }); await tick();
      await typeCoords(block, String(inside.lat), String(inside.lon));
      assert.equal(block.find('fire-smoke').textContent, text);
    }
    // Una pluma dentro del mismo día conserva el texto de siempre.
    setLanguage('en');
    const sameDay = { ...humo, ultima_utc: '2026-11-14T23:00:00Z', poligonos: [{ ...humo.poligonos[0], fin: '2026-11-14T23:00:00Z' }] };
    block = buildFireBlock({ snapshot: { ...snapshot, humo: sameDay }, tle: null, geo, mapApi }); await tick();
    assert.equal(block.find('fire-smoke').textContent, 'NOAA analysts also outlined a smoke plume over this point between 20:10 and 23:00 UTC on Nov 14, 2026.');
  } finally { Date.now = realNow; setLanguage('es'); }
});
