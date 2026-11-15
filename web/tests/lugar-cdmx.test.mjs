// La frase del lugar no repite el estado cuando la localidad se llama igual (Ciudad de México).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../js/i18n.js';

test('lugar: Ciudad de México no repite el estado, y los demás lugares lo conservan', async () => {
  const { placeText } = await import('../js/fire.js');
  const cdmx = { kind: 'near', place: 'Ciudad de México', stateId: 'MX-DIF', stateName: 'Distrito Federal', dir: 'NW', km: 0.7 };
  const other = { kind: 'near', place: 'Nuevo Jerusalén', stateId: 'MX-ROO', stateName: 'Quintana Roo', dir: 'SE', km: 0.8 };
  setLanguage('en');
  assert.equal(placeText(cdmx, 'fire.where'), 'About 700 m NW of Ciudad de México.');
  assert.equal(placeText({ ...cdmx, kind: 'in' }, 'fire.where'), 'In Ciudad de México.');
  assert.equal(placeText(other, 'fire.where'), 'About 800 m SE of Nuevo Jerusalén, Quintana Roo.');
  assert.doesNotMatch(placeText(cdmx, 'fire.msgWhere'), /Mexico City/);
  setLanguage('es');
  assert.equal((placeText(cdmx, 'fire.where').match(/Ciudad de México/g) || []).length, 1);
  assert.match(placeText(other, 'fire.where'), /Nuevo Jerusalén, Quintana Roo\.$/);
  setLanguage('es');
});
