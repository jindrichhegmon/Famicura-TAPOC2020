import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtoStav } from '../src/proto-stav.mjs';
import { seed, proved, AKCE, withinHours, jeNoc, jeNocPro, pristeV, efektivni, KLID_NAVZDY, poskytovatel, poskytovatelPro } from '../public/proto/sim-core.js';

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
  assert.match(s.events[0].text, /den \(od 06:00\) rozostření/);
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

test('jádro: den a noc podle časů rodiny, rychlé přepnutí do střídání, klid do rána / večera / vypnutí', () => {
  const s = seed(0); const p = s.patients[0];
  const poledne = Date.parse('2026-07-01T10:30:00Z');   // 12:30 v Praze
  assert.equal(jeNocPro(p, new Date(poledne)), false);
  proved(s, 'setConsent', ['tapoc2020', { den: 'blur', noc: 'none', nocOd: '21:00' }], poledne);
  assert.equal(jeNocPro(p, new Date(Date.parse('2026-07-01T19:30:00Z'))), true, '21:30 v Praze je už noc');
  assert.throws(() => proved(s, 'setConsent', ['tapoc2020', { denOd: '21:00' }]), (e) => e.status === 400, 'den a noc ve stejnou chvíli');
  assert.throws(() => proved(s, 'setConsent', ['tapoc2020', { denOd: '7' }]), (e) => e.status === 400);
  // rychlé přepnutí platí do 21:00 (střídání), pak ho tick zruší
  const { vysledek: r } = proved(s, 'rychle', ['tapoc2020', 'skeleton'], poledne);
  assert.equal(r.until, pristeV('21:00', poledne));
  assert.equal(efektivni(s, p, poledne).mode, 'skeleton');
  assert.equal(efektivni(s, p, poledne).zdroj, 'rychle');
  assert.throws(() => proved(s, 'rychle', ['tapoc2020', 'none']), (e) => e.status === 400, 'rychle jen ostrý/rozmazaný/drátěný');
  assert.equal(proved(s, 'tick', [], r.until + 1000).zmena, true);
  assert.equal(p.docasne, undefined);
  assert.equal(efektivni(s, p, r.until + 1000).mode, 'none', 'po 21:00 platí noční nastavení');
  assert.match(s.events[0].text, /skončilo střídáním/);
  // povolení z žádosti má přednost před rychlým přepnutím
  proved(s, 'rychle', ['tapoc2020', 'blur'], poledne);
  const { vysledek: q } = proved(s, 'requestFull', ['tapoc2020', 'Dispečink', 'test'], poledne);
  assert.equal(q.until, poledne + 10 * 60000, 'žádost platí 10 minut');
  proved(s, 'answerRequest', [q.id, 'minutes', 15], poledne);
  assert.equal(efektivni(s, p, poledne).mode, 'full');
  // klid
  assert.equal(proved(s, 'klidDo', ['tapoc2020', '120'], poledne).vysledek, poledne + 120 * 60000);
  assert.equal(proved(s, 'klidDo', ['tapoc2020', 'rano'], poledne).vysledek, pristeV('06:00', poledne));
  assert.equal(proved(s, 'klidDo', ['tapoc2020', 'vecer'], poledne).vysledek, pristeV('21:00', poledne));
  assert.equal(proved(s, 'klidDo', ['tapoc2020', 'vypnuti'], poledne).vysledek, KLID_NAVZDY);
  assert.equal(proved(s, 'klidDo', ['tapoc2020', 'vypnout'], poledne).vysledek, null);
  assert.equal(s.klid.tapoc2020, undefined);
  assert.throws(() => proved(s, 'klidDo', ['tapoc2020', 'nekdy']), (e) => e.status === 400);
});

test('jádro: údaje poskytovatele na jednom místě, s výchozími hodnotami pro starší stav', () => {
  const s = seed(0);
  assert.equal(poskytovatel(s).nazev, 'Pečovatelská služba Kladno');
  const { vysledek } = proved(s, 'setPoskytovatel', [{ nazev: 'DS Slunečnice', telefon: '777 000 111', dispecer: 'Eva Malá', smena: 'noční', zaloha: '' }]);
  assert.equal(vysledek.dispecer, 'Eva Malá');
  assert.equal(poskytovatelPro(s, s.patients[0]), 'DS Slunečnice', 'skutečná kamera: sdílený poskytovatel');
  assert.equal(poskytovatelPro(s, s.patients[1]), 'Pečovatelská služba Kladno', 'ukázkový pacient si nechá svého');
  assert.throws(() => proved(s, 'setPoskytovatel', [{ nazev: '' }]), (e) => e.status === 400);
  assert.throws(() => proved(s, 'setPoskytovatel', [{ dispecer: '   ' }]), (e) => e.status === 400);
  delete s.poskytovatel;
  assert.equal(poskytovatel(s).dispecer, 'Jana Nováková', 'stav uložený před touto verzí dostane výchozí údaje');
});
