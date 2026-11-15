import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const handler = createRequire(import.meta.url)('../api/refresh.js');

function fakeResponse() {
  const r = { code: 0, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}
async function call(headers, env, fetchImpl) {
  const saved = { s: process.env.CRON_SECRET, t: process.env.GH_DISPATCH_TOKEN, f: globalThis.fetch };
  for (const k of ['CRON_SECRET', 'GH_DISPATCH_TOKEN']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  globalThis.fetch = fetchImpl ?? (() => { throw new Error('no debía llamar a GitHub'); });
  const res = fakeResponse();
  try { await handler({ headers }, res); } finally {
    if (saved.s === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.s;
    if (saved.t === undefined) delete process.env.GH_DISPATCH_TOKEN; else process.env.GH_DISPATCH_TOKEN = saved.t;
    globalThis.fetch = saved.f;
  }
  return res;
}

test('disparador: sin secreto configurado o con cabecera equivocada responde 401 y no llama a GitHub', async () => {
  assert.equal((await call({}, {})).code, 401);
  assert.equal((await call({ authorization: 'Bearer otro' }, { CRON_SECRET: 'abc', GH_DISPATCH_TOKEN: 't' })).code, 401);
  assert.equal((await call({}, { CRON_SECRET: 'abc', GH_DISPATCH_TOKEN: 't' })).code, 401);
});

test('disparador: con secreto correcto y sin token responde 503 y no llama a GitHub', async () => {
  assert.equal((await call({ authorization: 'Bearer abc' }, { CRON_SECRET: 'abc' })).code, 503);
});

test('disparador: con todo en orden pide el workflow en main y no devuelve secretos', async () => {
  let seen = null;
  const res = await call({ authorization: 'Bearer abc' }, { CRON_SECRET: 'abc', GH_DISPATCH_TOKEN: 'tok' }, async (url, init) => { seen = { url, init }; return { status: 204 }; });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, github: 204 });
  assert.equal(seen.url, 'https:' + '//api.github.com/repos/LopezRod777/mexico-fire-record/actions/workflows/live.yml/dispatches');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.init.body), { ref: 'main' });
  assert.ok(!JSON.stringify(res.body).includes('tok') && !JSON.stringify(res.body).includes('abc'));
});

test('disparador: si GitHub rechaza o no responde, contesta 502', async () => {
  assert.equal((await call({ authorization: 'Bearer abc' }, { CRON_SECRET: 'abc', GH_DISPATCH_TOKEN: 'tok' }, async () => ({ status: 403 }))).code, 502);
  assert.equal((await call({ authorization: 'Bearer abc' }, { CRON_SECRET: 'abc', GH_DISPATCH_TOKEN: 'tok' }, async () => { throw new Error('red'); })).code, 502);
});
