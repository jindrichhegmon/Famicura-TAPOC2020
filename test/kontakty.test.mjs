import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, proved, kontaktyPro, describeKontakty, rodinaSTelefonem, smsIdsPro, mailIdsPro, upozorneniPro, telefonyPoskytovatele, rozdelMaily, cisloSosPro, popisTelefonuRole, SMS_PRIJEMCI } from '../public/proto/sim-core.js';
import { createUpozorneni } from '../src/upozorneni.mjs';

const T0 = 1_700_000_000_000;
const stavS = () => { const s = seed(T0); s.patients[0].real = true; return s; };

test('kontakty: nový tvar rodina 5× jméno + telefon a dvě sady e-mailů; starší { sms, mail } se čte jako rodina bez jmen a sada 1', () => {
  const s = stavS(); const p = s.patients[0];
  p.kontakty = { sms: ['602520069', '777111222'], mail: ['a@b.cz'] };
  const k = kontaktyPro(p);
  assert.equal(k.rodina.length, 5); assert.deepEqual(k.rodina[0], { jmeno: '', telefon: '602520069' }); assert.deepEqual(k.rodina[2], { jmeno: '', telefon: '' });
  assert.deepEqual(k.maily1, ['a@b.cz']); assert.deepEqual(k.maily2, []);
  const r = proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'dcera Eva', telefon: '+420 602 520 069' }, { jmeno: '', telefon: '' }, { jmeno: 'syn Petr', telefon: '777 111 222' }], maily1: 'dcera@example.cz, Syn@Example.cz; lekar@example.cz', maily2: ['sestra@example.cz'] }, 'Dispečer'], T0);
  assert.deepEqual(r.vysledek.rodina[0], { jmeno: 'dcera Eva', telefon: '602520069' }); assert.deepEqual(r.vysledek.rodina[2], { jmeno: 'syn Petr', telefon: '777111222' }); assert.deepEqual(r.vysledek.rodina[1], { jmeno: '', telefon: '' });
  assert.deepEqual(r.vysledek.maily1, ['dcera@example.cz', 'syn@example.cz', 'lekar@example.cz']); assert.deepEqual(r.vysledek.maily2, ['sestra@example.cz']);
  assert.deepEqual(rodinaSTelefonem(p).map((x) => x.id), ['r1', 'r3']);
  assert.match(describeKontakty(p), /rodina: dcera Eva 602 520 069, syn Petr 777 111 222 · e-maily 1: dcera@example.cz, syn@example.cz, lekar@example.cz · e-maily 2: sestra@example.cz/);
  assert.match(s.events[0].text, /Kontakty pro upozornění: rodina: dcera Eva/);
  assert.throws(() => proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'Eva', telefon: '12' }] }], T0), /není český mobil/);
  assert.throws(() => proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'Eva', telefon: '' }] }], T0), /chybí telefon/);
  assert.throws(() => proved(s, 'setKontakty', [p.id, { maily1: 'neni-mail' }], T0), /není platná adresa/);
  assert.throws(() => proved(s, 'setKontakty', [p.id, { rodina: Array(6).fill({ jmeno: 'x', telefon: '602520069' }) }], T0), /Nejvýš 5/);
  assert.deepEqual(rozdelMaily(' a@b.cz ,c@d.cz;e@f.cz'), ['a@b.cz', 'c@d.cz', 'e@f.cz']);
});

test('příjemci u události: pole ID (rodina, dispečink, služba, administrace / sada 1, sada 2), starší true = celá rodina a obě sady; telefony poskytovatele z Kontaktů', () => {
  const s = stavS(); const p = s.patients[0];
  proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'Eva', telefon: '602520069' }, { jmeno: 'Petr', telefon: '777111222' }], maily1: 'a@b.cz', maily2: 'c@d.cz' }, 'D'], T0);
  proved(s, 'setPoskytovatel', [{ telefon: '312 123 456', sluzbaZdroj: 'vlastni', sluzbaTelefon: '601 000 111', administraceZdroj: 'pecedomaplus', administraceTelefon: '' }], T0);
  assert.deepEqual(telefonyPoskytovatele(s), { dispecink: { zdroj: 'vlastni', telefon: '312123456' }, sluzba: { zdroj: 'vlastni', telefon: '601000111' }, administrace: { zdroj: 'pecedomaplus', telefon: '' } });
  assert.equal(popisTelefonuRole(telefonyPoskytovatele(s), 'dispecink'), '312 123 456'); assert.equal(popisTelefonuRole(telefonyPoskytovatele(s), 'administrace'), 'z Péče doma plus');
  assert.deepEqual(SMS_PRIJEMCI, ['r1', 'r2', 'r3', 'r4', 'r5', 'dispecink', 'sluzba', 'administrace']);
  // starší true → celá rodina / obě sady
  assert.deepEqual(smsIdsPro({ sms: true }, 'sos', p), ['r1', 'r2']); assert.deepEqual(mailIdsPro({ mail: true }, 'sos'), ['s1', 's2']);
  assert.deepEqual(smsIdsPro({}, 'sos', p), ['r1', 'r2'], 'kritická bez nastavení = celá rodina'); assert.deepEqual(smsIdsPro({}, 'motion', p), []);
  // pole ID
  proved(s, 'setWatch', [p.id, 'sos', { sms: ['r2', 'dispecink', 'sluzba', 'administrace'], mail: ['s2'] }], T0);
  assert.deepEqual(p.watch.sos.sms, ['r2', 'dispecink', 'sluzba', 'administrace']); assert.deepEqual(p.watch.sos.mail, ['s2']);
  assert.throws(() => proved(s, 'setWatch', [p.id, 'sos', { sms: ['r9'] }], T0), /Neznámý příjemce/);
  const u = upozorneniPro(s, { id: 'e1', patientId: p.id, kind: 'sos', at: T0 });
  assert.deepEqual(u.sms, ['777111222', '312123456', '601000111']); assert.deepEqual(u.smsZdroje, [{ id: 'administrace', zdroj: 'pecedomaplus' }]); assert.deepEqual(u.mail, ['c@d.cz']); assert.deepEqual(u.komu, ['Petr', 'dispečink', 'služba', 'administrace']);
  // služba ze zdroje Péče doma → dosadí server (smsZdroje)
  proved(s, 'setPoskytovatel', [{ sluzbaZdroj: 'pecedoma', sluzbaTelefon: '', administraceZdroj: 'vlastni' }], T0);
  const u2 = upozorneniPro(s, { id: 'e2', patientId: p.id, kind: 'sos', at: T0 });
  assert.deepEqual(u2.sms, ['777111222', '312123456']); assert.deepEqual(u2.smsZdroje, [{ id: 'sluzba', zdroj: 'pecedoma' }]); assert.deepEqual(u2.komu, ['Petr', 'dispečink', 'služba'], 'administrace bez telefonu se vynechá');
  // nikdo → null
  proved(s, 'setWatch', [p.id, 'sos', { sms: [], mail: [] }], T0);
  assert.equal(upozorneniPro(s, { id: 'e3', patientId: p.id, kind: 'sos', at: T0 }), null);
  assert.throws(() => proved(s, 'setPoskytovatel', [{ sluzbaZdroj: 'neco' }], T0), /Telefon \(služba\): zdroj vlastní/);
  assert.throws(() => proved(s, 'setPoskytovatel', [{ sluzbaZdroj: 'vlastni', sluzbaTelefon: '12' }], T0), /není české číslo/);
  assert.throws(() => proved(s, 'setPoskytovatel', [{ dispecinkZdroj: 'vlastni', telefon: 'abc' }], T0), /Telefon \(dispečink\) „abc“ není české číslo/);
  assert.throws(() => proved(s, 'setPoskytovatel', [{ administraceZdroj: 'x' }], T0), /Telefon \(administrace\): zdroj/);
});

test('slot SOS náramku: ID z Kontaktů → skutečné číslo (+420), telefon poskytovatele podle zdroje, starší zápisy dál', () => {
  const s = stavS(); const p = s.patients[0];
  proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'Eva', telefon: '602520069' }] }, 'D'], T0);
  proved(s, 'setPoskytovatel', [{ telefon: '312 123 456', dispecinkZdroj: 'vlastni', sluzbaZdroj: 'pecedomaplus', administraceZdroj: 'pecedoma' }], T0);
  assert.deepEqual(cisloSosPro(s, p, 'r1'), { telefon: '+420602520069', zdroj: null, role: null, popis: 'Eva 602 520 069' });
  assert.deepEqual(cisloSosPro(s, p, 'r2'), { telefon: '', zdroj: null, role: null, popis: 'rodina 2 (bez telefonu)' });
  assert.deepEqual(cisloSosPro(s, p, 'dispecink'), { telefon: '+420312123456', zdroj: null, role: 'dispecink', popis: 'dispečink 312 123 456' });
  assert.deepEqual(cisloSosPro(s, p, 'sluzba'), { telefon: '', zdroj: 'pecedomaplus', role: 'sluzba', popis: 'služba (Péče doma plus)' });
  assert.deepEqual(cisloSosPro(s, p, 'administrace'), { telefon: '', zdroj: 'pecedoma', role: 'administrace', popis: 'administrace (Péče doma)' });
  assert.deepEqual(cisloSosPro(s, p, 'pecedoma'), { telefon: '', zdroj: 'pecedoma', role: 'sluzba', popis: 'číslo služby (Péče doma)' });
  assert.deepEqual(cisloSosPro(s, p, '+420 777 000 111'), { telefon: '+420777000111', zdroj: null, role: null, popis: '+420777000111' });
  assert.deepEqual(cisloSosPro(s, p, ''), { telefon: '', zdroj: null, role: null, popis: '' });
  proved(s, 'setNaramek', [p.id, '9705357211', 'D'], T0);
  const r = proved(s, 'setNaramekSos', [p.id, ['r1', 'sluzba', 'dispecink'], 'D'], T0);
  assert.deepEqual(r.vysledek, ['r1', 'sluzba', 'dispecink']); assert.match(s.events[0].text, /Čísla SOS náramku: Eva 602 520 069, služba \(Péče doma plus\), dispečink 312 123 456/);
  assert.throws(() => proved(s, 'setNaramekSos', [p.id, ['r2'], 'D'], T0), /rodina 2 nemá v Kontaktech telefon/);
  assert.throws(() => proved(s, 'setNaramekSos', [p.id, ['abc'], 'D'], T0), /vyberte člověka z rodiny/);
  assert.equal(proved(s, 'setNaramekSos', [p.id, ['602520069', 'pecedomaplus', ''], 'D'], T0).vysledek[1], 'pecedomaplus', 'starší zápis se přijme');
});

test('odeslání: číslo služby z Péče doma dosadí server přes sluzba.telefon, bez nastavení je u SMS srozumitelná chyba', async () => {
  const s = stavS(); const p = s.patients[0];
  proved(s, 'setKontakty', [p.id, { rodina: [{ jmeno: 'Eva', telefon: '602520069' }] }, 'D'], T0);
  proved(s, 'setPoskytovatel', [{ sluzbaZdroj: 'pecedomaplus', dispecinkZdroj: 'pecedoma', administraceZdroj: 'pecedomaplus' }], T0);
  proved(s, 'setWatch', [p.id, 'sos', { sms: ['r1', 'sluzba', 'dispecink', 'administrace'], mail: [] }], T0);
  const posl = [];
  const sms = { nastaveno: true, async posli(x) { posl.push([x.telefon, x.text]); return { ok: true }; }, async posliMail() { return { ok: true }; } };
  const sluzba = { nastaveno: true, async telefon(t) { assert.equal(t, '22202480FAMICURA'); return { pecedoma: { telefon: '+420602620069' }, pecedomaplus: { telefon: '+420722972596', sluzba: { telefon: '+420722972596' }, dispecink: { telefon: '' }, administrace: { telefon: '' } } }; } };
  const u = createUpozorneni({ sms, sluzba, log: { log() {} }, odkaz: '' });
  const v = await u.posli(s, { id: 'e1', patientId: p.id, kind: 'sos', at: T0, text: 'SOS' }, { tenant: '22202480FAMICURA' });
  assert.deepEqual(posl.map((x) => x[0]), ['602520069', '722972596', '602620069']); assert.equal(v.sms.odeslano, 3); assert.equal(v.sms.prijemci, 4); assert.match(v.sms.chyba, /administrace: telefon \(Péče doma plus\) není nastavený/); assert.deepEqual(v.sms.komu, ['Eva', 'služba', 'dispečink', 'administrace']);
  assert.match(posl[0][1], /602620069/, 'telefon dispečinku z Péče doma je v textu SMS');
  const u2 = createUpozorneni({ sms, sluzba: null, log: { log() {} }, odkaz: '' });
  const v2 = await u2.posli(s, { id: 'e2', patientId: p.id, kind: 'sos', at: T0 }, { tenant: '22202480FAMICURA' });
  assert.equal(v2.sms.odeslano, 1); assert.match(v2.sms.chyba, /: číslo z Péče doma \(plus\) není na serveru nastavené/);
});
