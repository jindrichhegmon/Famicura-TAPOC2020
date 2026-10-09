import test from 'node:test';
import assert from 'node:assert/strict';
import { createTapo, TapoError } from '../src/tapo.mjs';
import { createSvetlo } from '../src/svetlo.mjs';
import { fakeTapo } from './fake-tapo.mjs';

test('Tapo: zabezpečené přihlášení (encrypt_type 3), šifrované požadavky, světlo zapnout a zhasnout', async () => {
  const kam = fakeTapo({ password: 'tajne' });
  const k = createTapo({ host: '192.168.8.211', user: 'admin', pass: 'tajne', fetchImpl: kam.fetchImpl });
  const info = await k.info();
  assert.equal(info.device_model, 'C560WS');
  assert.equal(kam.st.prihlaseni, 1, 'jedno přihlášení');
  let s = await k.svetloStav();
  assert.deepEqual(s, { zapnuto: false, vynuceno: false, intenzita: 3 });
  s = await k.svetlo(true);
  assert.equal(s.zapnuto, true); assert.equal(kam.st.zapnuto, true, 'kamera opravdu rozsvítila');
  s = await k.svetlo(false);
  assert.equal(s.zapnuto, false); assert.equal(kam.st.zapnuto, false);
  assert.ok(kam.st.volani.some((v) => v.method === 'setWhitelampConfig' && v.params.image.switch.force_wtl_state === 'on'), 'force_wtl_state on');
  assert.ok(kam.st.seq > 100, 'Seq roste s každým požadavkem');
});

test('Tapo: heslo s MD5 hashem (starší kamera v zabezpečeném režimu) i starší přihlášení bez šifrování', async () => {
  const md5 = fakeTapo({ password: 'heslo1', hashMetoda: 'md5' });
  const k1 = createTapo({ host: 'k', pass: 'heslo1', fetchImpl: md5.fetchImpl });
  assert.equal((await k1.svetloStav()).zapnuto, false);
  const stary = fakeTapo({ password: 'heslo2', secure: false });
  const k2 = createTapo({ host: 'k', pass: 'heslo2', fetchImpl: stary.fetchImpl });
  assert.equal((await k2.svetlo(true)).zapnuto, true);
  assert.equal(stary.st.zapnuto, true);
});

test('Tapo: špatné heslo = chyba přihlášení (auth), po opakování blokace se sec_left; kamera bez světla = nepodporuje', async () => {
  const kam = fakeTapo({ password: 'spravne', blokovatPo: 2 });
  const k = createTapo({ host: 'k', pass: 'spatne', fetchImpl: kam.fetchImpl });
  await assert.rejects(k.login(), (e) => e instanceof TapoError && e.auth && /heslo/.test(e.message));
  // kamera nepotvrdila heslo (device_confirm nesedí) – klient se ani nepokusil o digest, kamera nic nepočítá; zkusíme znovu správným klientem
  const ok = createTapo({ host: 'k', pass: 'spravne', fetchImpl: kam.fetchImpl });
  await ok.login();
  // blokace: kamera po dvou špatných digestech odmítá i správné heslo
  kam.st.spatne = 2;
  const dalsi = createTapo({ host: 'k', pass: 'spravne', fetchImpl: kam.fetchImpl });
  await assert.rejects(dalsi.login(), (e) => e instanceof TapoError && e.auth && /blokuje/.test(e.message) && /600/.test(e.message));
  const bez = fakeTapo({ password: 'x', svetlo: false, model: 'C220' });
  const kb = createTapo({ host: 'k', pass: 'x', fetchImpl: bez.fetchImpl });
  await assert.rejects(kb.svetloStav(), (e) => e instanceof TapoError && e.nepodporuje);
});

test('Tapo: počítání Seq – výchozí start_seq+1 (pytapo); kamera, která chce start_seq, se pozná po prvním odmítnutí a drží se', async () => {
  const post = fakeTapo({ password: 'tajne', seqRezim: 'post' });
  const k = createTapo({ host: 'k', pass: 'tajne', fetchImpl: post.fetchImpl, log: { log() {} } });
  assert.equal((await k.info()).device_model, 'C560WS');
  assert.equal(k.seqRezim, 'post'); assert.equal(post.st.prihlaseni, 2, 'po odmítnutí nové přihlášení');
  assert.equal((await k.svetloStav()).zapnuto, false); assert.equal(post.st.prihlaseni, 2, 'dál už bez přihlašování');
  const pre = fakeTapo({ password: 'tajne', seqRezim: 'pre' });
  const k2 = createTapo({ host: 'k', pass: 'tajne', fetchImpl: pre.fetchImpl });
  await k2.info(); assert.equal(k2.seqRezim, 'pre'); assert.equal(pre.st.prihlaseni, 1);
});

test('Tapo: vypršelý stok (-40401) = přihlásí se znovu a požadavek zopakuje', async () => {
  const kam = fakeTapo({ password: 'tajne' });
  const k = createTapo({ host: 'k', pass: 'tajne', fetchImpl: kam.fetchImpl });
  await k.info();
  kam.st.neplatnyStok = 1;
  assert.equal((await k.svetloStav()).zapnuto, false);
  assert.equal(kam.st.prihlaseni, 2, 'druhé přihlášení po vypršení');
});

test('světlo: stav a přepnutí přes účet kamery; kamera bez světla se zapamatuje; model v odpovědi', async () => {
  const kam = fakeTapo({ password: 'ucet-kamery', user: 'Kamera' });
  const bez = fakeTapo({ password: 'ucet-kamery', svetlo: false, model: 'C220', user: 'Kamera' });
  const kamery = async () => [{ id: 'c560', ip: '10.0.0.1', user: 'Kamera', pass: 'ucet-kamery' }, { id: 'c220', ip: '10.0.0.2', user: 'Kamera', pass: 'ucet-kamery' }];
  const tapo = ({ host, user, pass }) => createTapo({ host, user, pass, fetchImpl: host === '10.0.0.1' ? kam.fetchImpl : bez.fetchImpl });
  const sv = createSvetlo({ kamery, tapo, log: { error() {} } });
  let s = await sv.stav('c560');
  assert.equal(s.podporuje, true); assert.equal(s.zapnuto, false); assert.equal(s.model, 'C560WS'); assert.equal(s.ucet, 'kamera');
  assert.deepEqual(await sv.nastav('c560', true), { zapnuto: true });
  assert.equal((await sv.stav('c560')).zapnuto, true);
  s = await sv.stav('c220');
  assert.equal(s.podporuje, false);
  const volani = bez.st.volani.length;
  await sv.stav('c220');
  assert.equal(bez.st.volani.length, volani, 'kamera bez světla se podruhé neobtěžuje');
  await assert.rejects(sv.nastav('c220', true), (e) => e.status === 501);
  await assert.rejects(sv.nastav('neni', true), (e) => e.status === 404);
  assert.equal(Object.keys(sv.pamet()).length, 2);
});

test('světlo: po blokaci kamery se jí server nedotýká do sec_left + 30 s; po špatném hesle 10 min; účet se špatným heslem se už nezkouší', async () => {
  let t = 1_000_000; const now = () => t;
  const kam = fakeTapo({ password: 'cloud', blokovatPo: 3 });
  kam.st.spatne = 3;   // kamera už blokuje
  const kamery = async () => [{ id: 'k', ip: '10.0.0.1', user: 'Kamera', pass: 'x', tapoPass: 'cloud' }];
  const pokusy = [];
  const tapo = ({ host, user, pass }) => { pokusy.push(user); return createTapo({ host, user, pass, fetchImpl: kam.fetchImpl, log: { log() {} } }); };
  const sv = createSvetlo({ kamery, tapo, now, log: { error() {} } });
  let s = await sv.stav('k');
  assert.match(s.chyba, /blokuje přihlášení/); assert.match(s.chyba, /600 s/);
  assert.deepEqual(pokusy, ['Kamera'], 'při blokaci se další účet nezkouší');
  await sv.stav('k'); await sv.stav('k');
  assert.equal(pokusy.length, 1, 'v klidu se kamera nekontaktuje');
  await assert.rejects(sv.nastav('k', true), (e) => e.status === 423 && /Světlo teď nejde/.test(e.message));
  t += 631 * 1000; kam.st.spatne = 0;
  s = await sv.stav('k');
  assert.equal(s.podporuje, true, 'po uplynutí blokace to jde');
  // špatné heslo účtu kamery: zapamatovat a příště rovnou účet TP-Link
  assert.deepEqual(pokusy.slice(1), ['Kamera', 'admin']);
  sv.zapomen('k'); t += 1000;
  await sv.stav('k'); assert.deepEqual(pokusy.slice(3), ['Kamera', 'admin'], 'po zapomen() znovu od účtu kamery');
});

test('světlo: účet kamery se přihlásí, ale kamera vrací -40211 (bez práv) → server sám přejde na účet TP-Link', async () => {
  const kamUcet = fakeTapo({ password: 'ucet-kamery', user: 'Kamera', bezPrav: true });
  const cloud = fakeTapo({ password: 'cloud-heslo' });
  const kamery = async () => [{ id: 'k1', ip: '10.0.0.1', user: 'Kamera', pass: 'ucet-kamery', tapoPass: 'cloud-heslo' }, { id: 'k2', ip: '10.0.0.2', user: 'Kamera', pass: 'ucet-kamery' }];
  const tapo = ({ host, user, pass }) => createTapo({ host, user, pass, fetchImpl: user === 'admin' ? cloud.fetchImpl : kamUcet.fetchImpl });
  const sv = createSvetlo({ kamery, tapo, log: { error() {} } });
  const s = await sv.stav('k1');
  assert.equal(s.podporuje, true); assert.equal(s.ucet, 'tapo');
  const s2 = await sv.stav('k2');
  assert.equal(s2.podporuje, null); assert.match(s2.chyba, /TP-Link/);
});

test('světlo: účet kamery nestačí → účet TP-Link (tapoPass); bez něj srozumitelná rada', async () => {
  const kam = fakeTapo({ password: 'cloud-heslo' });
  const kamery = async () => [{ id: 'k1', ip: '10.0.0.1', user: 'Kamera', pass: 'jine', tapoPass: 'cloud-heslo' }, { id: 'k2', ip: '10.0.0.1', user: 'Kamera', pass: 'jine' }];
  const ucty = [];
  const tapo = ({ host, user, pass }) => { ucty.push(user + ':' + pass); return createTapo({ host, user, pass, fetchImpl: kam.fetchImpl }); };
  const sv = createSvetlo({ kamery, tapo, log: { error() {} } });
  const s = await sv.stav('k1');
  assert.equal(s.podporuje, true); assert.equal(s.ucet, 'tapo');
  assert.deepEqual(ucty, ['Kamera:jine', 'admin:cloud-heslo'], 'nejdřív účet kamery, pak TP-Link');
  const s2 = await sv.stav('k2');
  assert.equal(s2.podporuje, null); assert.match(s2.chyba, /vps-kamera\.sh svetlo k2/);
  await assert.rejects(sv.nastav('k2', true), (e) => e.status === 423 && /TP-Link/.test(e.message), 'v klidu po špatném hesle: 423 s radou');
});
