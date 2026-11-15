import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dictionaries, chooseLanguage, setLanguage, t, formatNumber, formatDate, regionName } from '../js/i18n.js';

test('diccionarios: mismas claves, marcadores y valores utilizables', () => {
  const keys = Object.keys(dictionaries.es).sort();
  assert.deepEqual(keys, Object.keys(dictionaries.en).sort());
  for (const key of keys) {
    for (const lang of ['es', 'en']) {
      const value = dictionaries[lang][key];
      assert.ok(typeof value === 'string' && value.trim() && value !== key, `${lang}: ${key}`);
    }
    const params = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(params(dictionaries.es[key]), params(dictionaries.en[key]), key);
  }
});

test('t: interpolación y clave ausente', () => {
  setLanguage('es');
  assert.equal(t('live.capture', { date: '14 nov 2026' }), 'Captura: 14 nov 2026');
  assert.equal(t('no.existe'), 'no.existe');
  setLanguage('en');
  assert.equal(t('live.capture', { date: 'Nov 14, 2026' }), 'Snapshot: Nov 14, 2026');
  setLanguage('es');
});

test('idioma: URL, almacenamiento, navegador y español', () => {
  const storage = value => ({ getItem: () => value });
  assert.equal(chooseLanguage('?lang=en', storage('es'), 'es-MX'), 'en');
  assert.equal(chooseLanguage('?lang=es', storage('en'), 'en-US'), 'es');
  assert.equal(chooseLanguage('?lang=fr', storage('en'), 'es-MX'), 'en');
  assert.equal(chooseLanguage('', { getItem: () => { throw Error('blocked'); } }, 'en-US'), 'en');
  assert.equal(chooseLanguage('', storage(null), 'es-MX'), 'es');
  assert.equal(chooseLanguage('', storage(null), 'fr-FR'), 'es');
});

test('HTML: cada data-i18n y atributo usa una clave de ambos diccionarios', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
  const attrs = [...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(match => match[1].split('|').map(pair => pair.split(':')[1]));
  assert.ok(keys.length > 80);
  for (const key of [...keys, ...attrs]) {
    assert.ok(Object.hasOwn(dictionaries.es, key), `es: ${key}`);
    assert.ok(Object.hasOwn(dictionaries.en, key), `en: ${key}`);
  }
});

test('números, fechas UTC y nombres seguros', () => {
  setLanguage('es');
  assert.equal(formatNumber(18805.4, 0), '18,805');
  assert.equal(formatDate('2026-11-14T22:50:00Z'), '14 nov 2026, 22:50 UTC');
  assert.equal(regionName('MX-MEX', { 'MX-MEX': 'México' }), 'México');
  assert.equal(regionName('MX-DIF', { 'MX-DIF': 'Distrito Federal' }), 'Ciudad de México');
  assert.equal(regionName('MX-PUE', { 'MX-PUE': 'Puebla' }), 'Puebla');
  setLanguage('en');
  assert.equal(formatNumber(18805.4, 0), '18,805');
  assert.equal(formatDate('2026-11-14T22:50:00Z'), 'Nov 14, 2026, 22:50 UTC');
  assert.equal(regionName('MX-DIF', { 'MX-DIF': 'Distrito Federal' }), 'Mexico City');
  assert.equal(regionName('MX-MEX', { 'MX-MEX': 'México' }), 'State of Mexico');
  assert.equal(regionName('MX-PUE', { 'MX-PUE': 'Puebla' }), 'Puebla');
  setLanguage('es');
});

test('JS: cadenas visibles en español viven solo en i18n.js', () => {
  const root = new URL('../js/', import.meta.url);
  for (const file of readdirSync(root).filter(name => name.endsWith('.js') && name !== 'i18n.js')) {
    const source = readFileSync(new URL(file, root), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm, '');
    for (const match of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      const literal = match[2];
      assert.doesNotMatch(literal, /[áéíóúÁÉÍÓÚñÑ¿¡]|\b(?:Sin dato|México|Estado|Mediana|Año|celdas.día|No disponible)\b/i, `${file}: ${literal}`);
    }
  }
});
