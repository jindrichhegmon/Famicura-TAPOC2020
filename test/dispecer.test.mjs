import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispecer } from '../src/dispecer.mjs';

const odpoved = (status, telo) => async (url, init) => { odpoved.posledni = { url, init }; return new Response(typeof telo === 'string' ? telo : JSON.stringify(telo), { status }); };

test('dispečer: přihlášení přes jhn-apps pecedomaplus-auth (tenant, login, heslo, token v hlavičce)', async () => {
  const d = createDispecer({ url: 'https://apps.example/', token: 'tajny', fetchImpl: odpoved(200, { ok: true, result: { ok: 1, session: 'x', uzivatel: { id: 17, jmeno: 'Eva Malá', login: 'eva', role: 'sestra', roleSeznam: ['sestra', 'admin'] }, tenant: { id: '22202480FAMICURA', nazev: 'FamiCura s.r.o.', ico: '22202480' } } }) });
  assert.equal(d.nastaveno, true);
  const v = await d.login({ tenant: '22202480FAMICURA', login: 'eva', heslo: 'tajne' });
  assert.deepEqual(v.uzivatel, { id: 17, jmeno: 'Eva Malá', login: 'eva', role: 'sestra', roleSeznam: ['sestra', 'admin'], nouzovy: false });
  assert.deepEqual(v.tenant, { id: '22202480FAMICURA', nazev: 'FamiCura s.r.o.', ico: '22202480' });
  assert.equal(odpoved.posledni.url, 'https://apps.example/api/apps/pecedomaplus-auth');
  assert.equal(odpoved.posledni.init.headers['x-app-token'], 'tajny');
  assert.deepEqual(JSON.parse(odpoved.posledni.init.body), { akce: 'login', tenant: '22202480FAMICURA', login: 'eva', heslo: 'tajne' });
});

test('dispečer: špatné heslo 401, neznámý tenant 403, server mimo 503, bez tokenu 503', async () => {
  await assert.rejects(createDispecer({ token: 't', fetchImpl: odpoved(200, { ok: false, error: 'Nesprávné přihlašovací jméno nebo heslo' }) }).login({ tenant: 'T1234', login: 'a', heslo: 'b' }), (e) => e.status === 401);
  await assert.rejects(createDispecer({ token: 't', fetchImpl: odpoved(200, { ok: false, error: 'Tenant X neexistuje nebo není aktivní' }) }).login({ tenant: 'X1234', login: 'a', heslo: 'b' }), (e) => e.status === 403);
  await assert.rejects(createDispecer({ token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }).login({ tenant: 'T1234', login: 'a', heslo: 'b' }), (e) => e.status === 503 && /neodpovídá/.test(e.message));
  await assert.rejects(createDispecer({ token: 't', fetchImpl: odpoved(502, '<html>') }).login({ tenant: 'T1234', login: 'a', heslo: 'b' }), (e) => e.status === 502);
  const bez = createDispecer({ token: '' });
  assert.equal(bez.nastaveno, false);
  await assert.rejects(bez.login({ tenant: 'T1234', login: 'a', heslo: 'b' }), (e) => e.status === 503 && /JHN_APPS_TOKEN/.test(e.message));
});
