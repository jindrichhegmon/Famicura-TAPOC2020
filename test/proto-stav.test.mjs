import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtoStav } from '../src/proto-stav.mjs';
import { seed, proved, AKCE, withinHours, jeNoc } from '../public/proto/sim-core.js';

function memStore() {
  const data = {};
  return { data, async nacti(n) { return structuredClone(data[n] || {}); }, async uloz(n, v) { data[n] = structuredClone(v); } };
}

test('jádro: emit zapíše událost i notifikaci, info události jsou rovnou uzavřené', () => {
  const s = seed(1000);
  const { vysledek: ev } = proved(s, 'emit', ['p2', 'fall'], 2000);
  assert.equal(ev.state, 'nový');
  assert.equal(s.events[0].id, ev.id);
  assert.equal(s.notifications[0].eventId, ev.id);
  const { vysledek: info } = proved(s, 'emit', ['p2', 'person'], 3000);
  assert.equal(info.state, 'uzavřen');
  assert.equal(s.notifications.length, 1, 'informativní událost nenotifikuje');
});

test('jádro: nastavení poskytovatele událost zahodí a řekne proč', () => {
  const s = seed(1000);
  proved(s, 'setWatch', ['p2', 'motion', { on: false }]);
  const { vysledek } = proved(s, 'emit', ['p2', 'motion']);
  assert.equal(vysledek, null);
  assert.equal(s.lastDropped.reason, 'poskytovatel událost vypnul');
});

test('jádro: souhlas rodiny, žádost dispečinku a odpověď, vypršení v ticku', () => {
  const s = seed(1000);
  proved(s, 'setConsent', ['tapoc2020', { den: 'blur' }], 2000);
  assert.equal(s.patients[0].consent.den, 'blur');
  assert.match(s.events[0].text, /den rozostření/);
  const { vysledek: r } = proved(s, 'requestFull', ['tapoc2020', 'Dispečerka Jana', 'ověření'], 3000);
  assert.equal(s.notifications[0].kind, 'request');
  proved(s, 'answerRequest', [r.id, 'minutes', 15], 4000);
  assert.equal(s.grants.tapoc2020.until, 4000 + 15 * 60000);
  assert.equal(s.notifications[0].ack, true);
  assert.equal(proved(s, 'tick', [], 5000).zmena, false);
  assert.equal(proved(s, 'tick', [], 4000 + 16 * 60000).zmena, true);
  assert.equal(s.grants.tapoc2020, undefined);
  assert.match(s.events[0].text, /vypršelo/);
});

test('jádro: špatný vstup je chyba 400, ne poškozený stav', () => {
  const s = seed(1000);
  for (const [a, args] of [['emit', ['p2', 'neznámý']], ['setConsent', ['p2', { den: 'xxx' }]], ['setWatch', ['p2', 'fall', { from: '25:00' }]], ['ensurePatient', [{ id: '../x' }]], ['nic', []]]) {
    assert.throws(() => proved(s, a, args), (e) => e.status === 400, a);
  }
  assert.equal(s.patients.length, 8);
  // extra v emit: jen text a real, nic dalšího
  const { vysledek } = proved(s, 'emit', ['p2', 'fall', { text: 'x', real: true, state: 'uzavřen', id: 'hack' }]);
  assert.equal(vysledek.state, 'nový'); assert.notEqual(vysledek.id, 'hack'); assert.equal(vysledek.real, true);
});

test('jádro: hodiny jsou pražské i na serveru v UTC', () => {
  // 1. 7. 10:30 UTC = 12:30 v Praze
  const d = new Date('2026-07-01T10:30:00Z');
  assert.equal(withinHours({ from: '12:00', to: '13:00' }, d), true);
  assert.equal(withinHours({ from: '10:00', to: '11:00' }, d), false);
  assert.equal(jeNoc(new Date('2026-07-01T21:00:00Z')), true);   // 23:00 v Praze
  assert.equal(jeNoc(new Date('2026-07-01T04:30:00Z')), false);  // 6:30 v Praze
});

test('server: stav se založí, akce zvedne verzi, uloží se a přežije restart', async () => {
  const store = memStore();
  let t = 1000;
  const p = createProtoStav({ store, now: () => t });
  const s1 = await p.stav();
  assert.equal(s1.v, 1); assert.equal(s1.state.patients.length, 8);
  assert.deepEqual(await p.stav(), s1, 'bez změny stejná verze');
  const r = await p.proved('setConsent', ['tapoc2020', { den: 'skeleton', noc: 'none' }]);
  assert.equal(r.v, 2);
  assert.equal(store.data['proto-stav'].state.patients[0].consent.den, 'skeleton');
  const p2 = createProtoStav({ store, now: () => t });
  const s2 = await p2.stav();
  assert.equal(s2.v, 2); assert.equal(s2.state.patients[0].consent.noc, 'none');
  await assert.rejects(p.proved('smazatVse', []), (e) => e.status === 400);
  assert.ok(AKCE.includes('reset'));
  const r2 = await p.proved('reset', []);
  assert.equal(r2.v, 3); assert.equal(r2.state.patients[0].consent.den, 'full');
});

test('server: skutečné události kamery skládá do stavu server, jen nové a jen známé druhy', async () => {
  const store = memStore();
  let t = 1000;
  const nedavne = [];
  const udalosti = { nedavne: (since) => nedavne.filter((e) => e.prijato > since) };
  const p = createProtoStav({ store, udalosti, now: () => t });
  nedavne.push({ prijato: 500, kameraId: 'tapoc2020', kameraNazev: 'Tapo', kind: 'cam-person', text: 'stará' });   // před startem
  nedavne.push({ prijato: 1500, kameraId: 'tapoc2020', kameraNazev: 'Tapo', kind: 'cam-tamper', text: 'Zakrytí' });
  nedavne.push({ prijato: 1550, kameraId: 'tapoc2020', kameraNazev: 'Tapo', kind: 'cam-motion', text: 'Pohyb' });   // pohyb má poskytovatel vypnutý
  nedavne.push({ prijato: 1600, kameraId: 'nova', kameraNazev: 'Nová kamera', kind: 'cam-person', text: 'Osoba' });
  nedavne.push({ prijato: 1700, kameraId: 'tapoc2020', kameraNazev: 'Tapo', kind: 'cam-neco', text: '?' });
  const s = await p.stav();
  const real = s.state.events.filter((e) => e.real);
  assert.deepEqual(real.map((e) => [e.patientId, e.kind, e.text]).sort(), [['nova', 'person', 'Osoba'], ['tapoc2020', 'tamper', 'Zakrytí']]);
  assert.ok(s.state.patients.some((x) => x.id === 'nova' && x.name === 'Nová kamera'), 'neznámá kamera dostane pacienta');
  const s2 = await p.stav();
  assert.equal(s2.v, s.v, 'podruhé se nic nepřidá');
});
