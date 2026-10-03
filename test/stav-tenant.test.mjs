import test from 'node:test';
import assert from 'node:assert/strict';
import { createStavTenantu } from '../src/stav-tenant.mjs';
import { createNajemci } from '../src/najemci.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';
import { createTabulky, ddl, SCHEMA } from '../src/tabulky.mjs';
import { createUpozorneni } from '../src/upozorneni.mjs';

const T = '22202480FAMICURA', T2 = '02570459DSIDEQAJ';
const ticho = { log() {}, error() {} };
const kamery = async () => [{ id: 'tapoc2020', name: 'Byt Novákovi', tenant: T }, { id: 'kam2', name: 'Pokoj 5', tenant: T2 }];

function stav(tabulky, over = {}) {
  let t = over.t0 || 1_700_000_000_000;
  const now = () => t;
  const tenant = over.tenant || T;
  const s = createStavTenantu({ tenant, tabulky, kamery: async () => (await kamery()).filter((k) => k.tenant === tenant), now, log: ticho, nazev: 'FamiCura s.r.o.', udalosti: over.udalosti || null, upozorni: over.upozorni || null });
  return { s, posun: (ms) => { t += ms; }, now };
}

test('tenant: kamery ze serveru dostanou řádek, akce zapisují jen změněné řádky, stav přežije restart', async () => {
  const tb = createMockTabulky();
  const { s, posun } = stav(tb);
  const st = await s.stav();
  assert.deepEqual(st.state.patients.map((p) => p.id), ['tapoc2020'], 'jen kamery tenanta');
  assert.equal(st.state.patients[0].provider, 'FamiCura s.r.o.');
  assert.equal(st.state.poskytovatel.nazev, 'FamiCura s.r.o.', 'název poskytovatele z Tenants');
  assert.equal(tb.data[T].A_KAM_Kamera.length, 1);
  const zapisu = () => tb.zaznamy.filter((z) => z[0] !== 'vyber').length;
  const n0 = zapisu();
  await s.stav();
  assert.equal(zapisu(), n0, 'čtení stavu bez změny nic nezapisuje');

  await s.proved('setConsent', ['tapoc2020', { den: 'blur', noc: 'none', nouze: false }]);
  const k = tb.data[T].A_KAM_Kamera[0];
  assert.match(k.Souhlas, /"den":"blur"/); assert.match(k.Souhlas, /"nouze":false/);
  await s.proved('setKontakty', ['tapoc2020', { sms: ['602520069'], mail: [] }, 'Eva']);
  assert.match(tb.data[T].A_KAM_Kamera[0].Kontakty, /602520069/);
  assert.equal(tb.data[T].A_KAM_Udalost.filter((u) => u.Druh === 'poznamka').length, 1, 'změna kontaktů je v logu');

  posun(1000);
  const { vysledek: pad } = await s.proved('emit', ['tapoc2020', 'fall', { real: true, text: 'Kamera hlásí: pád.' }]);
  const u = tb.data[T].A_KAM_Udalost.find((x) => x.Id === pad.id);
  assert.equal(u.Druh, 'fall'); assert.equal(u.Stav, 'nový'); assert.equal(u.Skutecna, true); assert.equal(u.Notifikace, true); assert.equal(u.Potvrzeno, false); assert.equal(u.Uroven, 'crit');
  await s.proved('setAlert', [pad.id, { state: 'převzat', by: 'Jana', takenAt: 1_700_000_005_000 }]);
  assert.equal(tb.data[T].A_KAM_Udalost.find((x) => x.Id === pad.id).Stav, 'převzat');
  assert.equal(tb.data[T].A_KAM_Udalost.find((x) => x.Id === pad.id).PrevzatoCas, 1_700_000_005_000);
  await s.proved('ackAll', ['tapoc2020']);
  assert.equal(tb.data[T].A_KAM_Udalost.find((x) => x.Id === pad.id).Potvrzeno, true, 'potvrzení rodiny je u události');

  const { vysledek: z } = await s.proved('requestFull', ['tapoc2020', 'Dispečerka Jana', 'ověření alertu']);
  assert.equal(tb.data[T].A_KAM_Zadost[0].Id, z.id); assert.equal(tb.data[T].A_KAM_Zadost[0].Stav, 'čeká');
  await s.proved('answerRequest', [z.id, 'minutes', 15]);
  assert.equal(tb.data[T].A_KAM_Zadost[0].Stav, 'povoleno');
  const pov = tb.data[T].A_KAM_Povoleni[0];
  assert.equal(pov.KameraID, 'tapoc2020'); assert.equal(pov.Druh, 'souhlas rodiny'); assert.equal(pov.SledujeKdo, 'Dispečerka Jana');
  await s.proved('setPoskytovatel', [{ nazev: 'FamiCura s.r.o.', telefon: '777 000 111', dispecer: 'Eva Malá', eskalaceMin: 3 }]);
  const nast = Object.fromEntries(tb.data[T].A_KAM_Nastaveni.map((r) => [r.Klic, r.Hodnota]));
  assert.equal(nast['poskytovatel.telefon'], '777 000 111'); assert.equal(nast['poskytovatel.eskalaceMin'], '3');
  await s.proved('klidDo', ['tapoc2020', '120']);
  assert.ok(tb.data[T].A_KAM_Kamera[0].KlidDo > 1_700_000_000_000);
  await s.proved('setNote', ['tapoc2020', 'Chodí s hůlkou.', 'Eva']);
  assert.equal(tb.data[T].A_KAM_Kamera[0].Poznamka, 'Chodí s hůlkou.');

  // restart serveru: nový objekt nad stejnými tabulkami vrátí totéž
  const { s: s2 } = stav(tb, { t0: 1_700_000_010_000 });
  const st2 = await s2.stav();
  const p = st2.state.patients[0];
  assert.deepEqual([p.consent.den, p.consent.noc, p.consent.nouze], ['blur', 'none', false]);
  assert.deepEqual(p.kontakty, { sms: ['602520069'], mail: [] });
  assert.equal(p.note, 'Chodí s hůlkou.');
  assert.equal(st2.state.events.find((e) => e.id === pad.id).state, 'převzat');
  assert.equal(st2.state.events.find((e) => e.id === pad.id).takenAt, 1_700_000_005_000);
  assert.equal(st2.state.events[0].at >= st2.state.events[1].at, true, 'nejnovější první');
  assert.equal(st2.state.grants.tapoc2020.kind, 'souhlas rodiny'); assert.equal(st2.state.watching.tapoc2020.who, 'Dispečerka Jana');
  assert.equal(st2.state.poskytovatel.dispecer, 'Eva Malá'); assert.equal(st2.state.poskytovatel.eskalaceMin, 3);
  assert.ok(st2.state.klid.tapoc2020 > 1_700_000_010_000);
  assert.equal(st2.state.requests[0].state, 'povoleno');
  assert.equal(st2.state.notifications.filter((n) => !n.ack).length, 0, 'potvrzené notifikace');
  await s2.proved('endGrant', ['tapoc2020', 'rodina']);
  assert.equal(tb.data[T].A_KAM_Povoleni.length, 0, 'ukončené povolení se smaže');
});

test('tenant: data jiného tenanta nejsou vidět, reset je zakázaný, skutečné události jdou jen ke svým kamerám', async () => {
  const tb = createMockTabulky();
  const prijate = [{ prijato: 1_700_000_000_500, kameraId: 'tapoc2020', kind: 'cam-linecross', text: 'Kamera hlásí: překročení čáry.' }, { prijato: 1_700_000_000_600, kameraId: 'kam2', kind: 'cam-person', text: 'Kamera hlásí: osoba.' }];
  const udalosti = { nedavne: (od) => prijate.filter((e) => e.prijato > od) };
  const a = stav(tb, { udalosti }), b = stav(tb, { tenant: T2, udalosti });
  await a.s.stav(); await b.s.stav();
  a.posun(1000); b.posun(1000);
  // linecross jen 07:00–20:00 pražského času; 1_700_000_001_000 je 14. 11. 2023 23:13 → zahodí se; osoba u kam2 projde
  const sa = await a.s.stav(), sb = await b.s.stav();
  assert.equal(sa.state.events.filter((e) => e.kind === 'linecross').length, 0, 'mimo hodiny');
  assert.equal(sb.state.events.filter((e) => e.kind === 'person').length, 1);
  assert.equal(sb.state.events[0].patientId, 'kam2');
  assert.deepEqual(sa.state.patients.map((p) => p.id), ['tapoc2020']); assert.deepEqual(sb.state.patients.map((p) => p.id), ['kam2']);
  assert.equal((tb.data[T].A_KAM_Udalost || []).some((u) => u.KameraID === 'kam2'), false, 'událost kam2 není u tenanta A');
  await assert.rejects(() => a.s.proved('reset', []), (e) => e.status === 400);
  await assert.rejects(() => a.s.proved('emit', ['kam2', 'fall']), (e) => e.status === 404);
  await assert.rejects(() => a.s.proved('ensurePatient', [{ id: 'kam2', name: 'cizí' }]), (e) => e.status === 403);
});

test('tenant: upozornění po události odejde a zapíše se k události v databázi', async () => {
  const tb = createMockTabulky();
  const posl = [];
  const sms = { nastaveno: true, async posli(x) { posl.push(x); return { ok: true, sid: 'SM1' }; }, async posliMail(x) { posl.push(x); return { ok: true, sid: 'M1' }; } };
  const { s } = stav(tb, { upozorni: createUpozorneni({ sms, log: ticho, odkaz: '' }) });
  await s.stav();
  await s.proved('setKontakty', ['tapoc2020', { sms: ['602520069'], mail: ['dcera@example.cz'] }, 'Eva']);
  const { vysledek: ev } = await s.proved('emit', ['tapoc2020', 'sos']);
  await s.hotovo();
  assert.equal(posl.length, 2);
  const u = tb.data[T].A_KAM_Udalost.find((x) => x.Id === ev.id);
  assert.match(u.Upozorneni, /"odeslano":1/);
  const { s: s2 } = stav(tb, { t0: 1_700_000_001_000 });
  assert.deepEqual((await s2.stav()).state.events.find((e) => e.id === ev.id).upozorneni.sms, { prijemci: 1, odeslano: 1, chyba: null });
});

test('najemci: ověření tenanta přes Tenants, stav na tenanta, bez databáze chyba 503', async () => {
  const tb = createMockTabulky();
  const pdp = { nastaveno: true, tabulky: tb, async zajistiTabulky() { return true; }, async tenant(id) { return id === T ? { id: T, nazev: 'FamiCura s.r.o.', ico: '22202480' } : null; } };
  const n = createNajemci({ pdp, kamery, log: ticho });
  const a = await n.pro(T);
  assert.equal(a, await n.pro(' ' + T.toLowerCase() + ' '), 'stejný stav pro stejné ID');
  assert.deepEqual((await a.stav()).state.patients.map((p) => p.id), ['tapoc2020']);
  await assert.rejects(() => n.pro('NEEXISTUJE1'), (e) => e.status === 403);
  await assert.rejects(() => n.pro(''), (e) => e.status === 400);
  await assert.rejects(() => n.pro('x y'), (e) => e.status === 400);
  const bez = createNajemci({ pdp: { nastaveno: false }, kamery, log: ticho });
  await assert.rejects(() => bez.pro(T), (e) => e.status === 503);
  assert.deepEqual((await n.kameryTenanta(T2)).map((k) => k.id), ['kam2']);
});

test('tabulky: DDL má tenanta s RLS u každé tabulky, brána skládá SQL jen ze schématu', async () => {
  const d = ddl();
  for (const t of Object.keys(SCHEMA)) { assert.match(d, new RegExp(`CREATE TABLE dbo\\.${t}`)); assert.match(d, new RegExp(`PK_${t} PRIMARY KEY CLUSTERED \\(IDTENANT`)); }
  assert.match(d, /SESSION_CONTEXT\(N'IDTENANT'\)/);
  const volani = [];
  const tb = createTabulky({ async query(text, params) { volani.push({ text, params }); return [{ n: 0 }]; } });
  await tb.vyber(T, 'A_KAM_Udalost', { kde: { KameraID: 'tapoc2020', Druh: ['fall', 'sos'] }, razeni: [['Cas', 'DESC']], limit: 5 });
  assert.match(volani[0].text, new RegExp(`^EXEC sp_set_session_context @key = N'IDTENANT', @value = N'${T}';`), 'kontext tenanta jako literál (sql_variant nebere nvarchar(max) parametr)');
  assert.match(volani[0].text, /SELECT TOP \(5\) .* FROM dbo\.A_KAM_Udalost WHERE KameraID = @p0 AND Druh IN \(@p1, @p2\) ORDER BY Cas DESC;/);
  assert.deepEqual(volani[0].params, { p0: 'tapoc2020', p1: 'fall', p2: 'sos' });
  await tb.ulozit(T, 'A_KAM_Kamera', { KameraID: 'tapoc2020', Souhlas: { den: 'full' }, Offline: false });
  assert.match(volani[1].text, /UPDATE dbo\.A_KAM_Kamera SET Souhlas = @p0, Offline = @p1 WHERE KameraID = @p2/);
  assert.equal(volani[1].params.p0, '{"den":"full"}');
  assert.match(volani[2].text, /INSERT INTO dbo\.A_KAM_Kamera \(KameraID, Souhlas, Offline\) VALUES \(@p0, @p1, @p2\)/, 'nula změněných → vloží');
  await assert.rejects(() => tb.vyber('bad id', 'A_KAM_Kamera'), /tenanta/);
  await assert.rejects(() => tb.vyber(T, 'A_KAM_Kamera', { kde: { "KameraID; DROP": 1 } }), /Neznámý sloupec/);
  await assert.rejects(() => tb.uprav(T, 'A_KAM_Kamera', {}, { Nazev: 'x' }), /bez podmínky/);
  await assert.rejects(() => tb.vyber(T, 'Tenants'), /Neznámá tabulka/);
});
