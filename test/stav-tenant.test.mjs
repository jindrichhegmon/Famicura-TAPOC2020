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
  const s = createStavTenantu({ tenant, tabulky, kamery: async () => (await kamery()).filter((k) => k.tenant === tenant), now, log: over.log || ticho, nazev: 'FamiCura s.r.o.', udalosti: over.udalosti || null, upozorni: over.upozorni || null, nahravky: over.nahravky || null });
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
  const prijate = [{ prijato: 1_700_000_000_500, kameraId: 'tapoc2020', kind: 'cam-linecross', text: 'Kamera hlásí: překročení čáry.' }, { prijato: 1_700_000_000_600, kameraId: 'kam2', kind: 'cam-person', text: 'Kamera hlásí: osoba.' },
    { prijato: 1_700_000_000_700, kameraId: 'kam2', kind: 'cam-intrusion', text: 'Kamera hlásí: vstup do hlídané oblasti.' }, { prijato: 1_700_000_000_750, kameraId: 'kam2', kind: 'cam-babycry', text: 'Kamera hlásí: pláč.' },
    { prijato: 1_700_000_000_800, kameraId: 'kam2', kind: 'cam-vehicle', text: 'Kamera hlásí: vozidlo.' }, { prijato: 1_700_000_000_850, kameraId: 'kam2', kind: 'cam-visitor', text: 'Kamera hlásí: visitor.' }];
  const udalosti = { nedavne: (od) => prijate.filter((e) => e.prijato > od) };
  const a = stav(tb, { udalosti }), b = stav(tb, { tenant: T2, udalosti });
  await a.s.stav(); await b.s.stav();
  a.posun(1000); b.posun(1000);
  // linecross jen 07:00–20:00 pražského času; 1_700_000_001_000 je 14. 11. 2023 23:13 → do deníku jen jako informační řádek; osoba u kam2 projde
  const sa = await a.s.stav(), sb = await b.s.stav();
  const mimo = sa.state.events.filter((e) => e.kind === 'linecross');
  assert.equal(mimo.length, 1, 'mimo hodiny se zapíše');
  assert.equal(mimo[0].mimoHodiny, true); assert.equal(mimo[0].state, 'uzavřen'); assert.equal(mimo[0].rec, false);
  assert.match(mimo[0].text, /překročení čáry \(mimo hlídané hodiny 07:00–20:00\)/);
  assert.equal(sa.state.notifications.length, 0, 'bez alertu');
  assert.equal(tb.data[T].A_KAM_Udalost.find((u) => u.Id === mimo[0].Id || u.Druh === 'linecross').Uroven, 'info', 'v databázi jako informativní');
  assert.equal((await stav(tb, { t0: 1_700_000_002_000 }).s.stav()).state.events.find((e) => e.kind === 'linecross').mimoHodiny, true, 'po restartu zůstane informační');
  assert.equal(sb.state.events.filter((e) => e.kind === 'person').length, 1);
  assert.equal(sb.state.events[0].patientId, 'kam2');
  // všechny detekce Tapo mají v dispečinku svůj druh; vozidlo je ve výchozím nastavení vypnuté, neznámý druh z kamery do dispečinku nejde
  assert.equal(sb.state.events.filter((e) => e.kind === 'intrusion').length, 1, 'vstup do oblasti');
  assert.equal(sb.state.events.filter((e) => e.kind === 'babycry').length, 1, 'pláč');
  assert.equal(sb.state.events.filter((e) => e.kind === 'vehicle').length, 0, 'vozidlo je výchozí vypnuté');
  assert.equal(sb.state.events.some((e) => /visitor/i.test(e.kind)), false);
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

test('událost mimo hlídané hodiny: jen řádek v deníku – bez alertu, bez SMS a e-mailu, bez nahrávky; simulace a vypnutý druh se zahodí', async () => {
  const { seed, proved, upozorneniPro } = await import('../public/proto/sim-core.js');
  const praha = (h, m = 0) => Date.UTC(2026, 9, 5, h - 2, m);   // letní čas: Praha = UTC+2
  const s = seed(praha(5));
  const p = s.patients.find((x) => x.real) || s.patients[0];
  proved(s, 'setKontakty', [p.id, { sms: ['602520069'], mail: [] }, 'Eva'], praha(5));
  proved(s, 'setWatch', [p.id, 'linecross', { from: '07:00', to: '20:00', rec: true, sms: true }], praha(5));
  const n0 = s.notifications.length, e0 = s.events.length;
  // skutečná událost z kamery ve 03:00 → informační řádek
  const { vysledek: ev } = proved(s, 'emit', [p.id, 'linecross', { real: true, text: 'Kamera hlásí: překročení čáry.' }], praha(3));
  assert.ok(ev); assert.equal(ev.mimoHodiny, true); assert.equal(ev.state, 'uzavřen'); assert.equal(ev.rec, false); assert.equal(ev.real, true);
  assert.equal(ev.text, 'Kamera hlásí: překročení čáry (mimo hlídané hodiny 07:00–20:00)');
  assert.equal(s.events.length, e0 + 1); assert.equal(s.notifications.length, n0, 'bez alertu');
  assert.equal(upozorneniPro(s, ev), null, 'bez SMS a e-mailu');
  // stejná událost v hodinách → normální alert s upozorněním a nahrávkou
  const { vysledek: ev2 } = proved(s, 'emit', [p.id, 'linecross', { real: true, text: 'Kamera hlásí: překročení čáry.' }], praha(9));
  assert.equal(ev2.mimoHodiny, undefined); assert.equal(ev2.state, 'nový'); assert.equal(ev2.rec, true); assert.equal(s.notifications.length, n0 + 1);
  assert.ok(upozorneniPro(s, ev2));
  // simulovaná událost mimo hodiny se dál zahazuje; vypnutý druh se zahodí i z kamery
  assert.equal(proved(s, 'emit', [p.id, 'linecross'], praha(3)).vysledek, null);
  proved(s, 'setWatch', [p.id, 'linecross', { on: false }], praha(5));
  assert.equal(proved(s, 'emit', [p.id, 'linecross', { real: true }], praha(3)).vysledek, null);
  assert.equal(s.lastDropped.reason, 'poskytovatel událost vypnul');
  // stav-tenant: upozornění se neposílá, nahrávka se nepořizuje, log serveru říká proč
  const tb = createMockTabulky();
  const posl = [];
  const sms = { nastaveno: true, async posli(x) { posl.push(x); return { ok: true }; }, async posliMail(x) { posl.push(x); return { ok: true }; } };
  let poridi = 0;
  const nahravky = { async porid() { poridi++; return { id: 'n1' }; }, async zapisOdmitnuti() { return { id: 'o1' }; }, async hotove() { return []; }, async seznam() { return []; } };
  const zpravy = [];
  const prijate = [{ prijato: praha(3), kameraId: 'tapoc2020', kind: 'cam-linecross', text: 'Kamera hlásí: překročení čáry.' }];
  const { s: st, posun } = stav(tb, { t0: praha(2, 59), udalosti: { nedavne: (od) => prijate.filter((e) => e.prijato > od) }, upozorni: createUpozorneni({ sms, log: ticho, odkaz: '' }), nahravky, log: { log: (...a) => zpravy.push(a.join(' ')), error() {} } });
  await st.stav();
  await st.proved('setKontakty', ['tapoc2020', { sms: ['602520069'], mail: [] }, 'Eva']);
  await st.proved('setWatch', ['tapoc2020', 'linecross', { from: '07:00', to: '20:00', rec: true, sms: true }]);
  posun(2000);
  const x = await st.stav(); await st.hotovo();
  const e = x.state.events.find((k) => k.kind === 'linecross');
  assert.ok(e && e.mimoHodiny); assert.equal(posl.length, 0, 'bez SMS'); assert.equal(poridi, 0, 'bez nahrávky'); assert.equal(e.nahravka, undefined);
  assert.ok(zpravy.some((z) => /mimo hlídané hodiny – jen zápis do deníku/.test(z)), 'log serveru');
  // deník (log událostí) ho ukáže jako informativní bez stavu
  const { radekLogu } = await import('../src/log-udalosti.mjs');
  const r = radekLogu(e, 'Byt Novákovi', null);
  assert.equal(r.uroven, 'informativní'); assert.equal(r.stav, ''); assert.match(r.text, /mimo hlídané hodiny/);
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

test('nahrávka po události: odmítnutí i chyba se zapíší jako řádek s důvodem; skutečná událost z kamery se nahrává i u „nedostupné“ kamery; log serveru', async () => {
  const { createNahravky } = await import('../src/nahravky.mjs');
  const tb = createMockTabulky(), volani = [], zpravy = [];
  const go2rtc = { async proxy(cesta) { volani.push(cesta); if (/src=kam2/.test(cesta)) throw new Error('go2rtc: stream kam2 neběží'); return new Response(Buffer.alloc(8192, 1), { status: 200 }); } };
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(t, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const log = { log: (...a) => zpravy.push(a.join(' ')), error: (...a) => zpravy.push(a.join(' ')) };
  const nahravky = createNahravky({ go2rtc, uloziste, tabulky: tb, kamery, log });
  const prijate = [];
  const T0 = Date.UTC(2023, 10, 15, 9, 0, 0);   // 10:00 pražského času: překročení čáry se hlídá 07:00–20:00
  const { s, posun } = stav(tb, { t0: T0, nahravky, log, udalosti: { nedavne: (od) => prijate.filter((e) => e.prijato > od) } });
  await s.stav();
  // 1) rodina nepovolila žádný obraz → překročení čáry (varování) se nenahrává; důvod je v A_KAM_Nahravka i u události
  await s.proved('setConsent', ['tapoc2020', { den: 'none', noc: 'none', nouze: true }]);
  const r1 = await s.proved('emit', ['tapoc2020', 'linecross']);
  await s.hotovo();
  let radky = await tb.vyber(T, 'A_KAM_Nahravka');
  assert.equal(radky.length, 1); assert.equal(radky[0].UdalostId, r1.vysledek.id); assert.match(radky[0].Chyba, /^nenahráno: rodina povolila jen „žádný obraz“/); assert.equal(radky[0].Velikost, 0);
  assert.match((await s.stav()).state.events.find((e) => e.id === r1.vysledek.id).nahravka.chyba, /žádný obraz/);
  assert.ok(zpravy.some((z) => /linecross: nenahráno: rodina povolila/.test(z)), 'důvod je v logu serveru');
  // 1b) rozostření → plný obraz se nahraje, ale uzamčený pro poskytovatele (Zamek = 1); v logu serveru je důvod
  await s.proved('setConsent', ['tapoc2020', { den: 'blur', noc: 'blur', nouze: true }]);
  const r1b = await s.proved('emit', ['tapoc2020', 'linecross']);
  await s.hotovo();
  radky = await tb.vyber(T, 'A_KAM_Nahravka', { kde: { UdalostId: r1b.vysledek.id } });
  assert.equal(radky.length, 1); assert.equal(radky[0].Chyba, null); assert.equal(radky[0].Zamek, 1); assert.equal(radky[0].Mime, 'video/mp4');
  assert.equal((await s.stav()).state.events.find((e) => e.id === r1b.vysledek.id).nahravka.zamek, true, 'zámek u události');
  assert.ok(zpravy.some((z) => /linecross: nahrávám .*uzamčená pro poskytovatele: rodina povolila jen „rozostření“/.test(z)), 'důvod zámku je v logu serveru');
  assert.ok(zpravy.some((z) => /linecross: uloženo \(server.*uzamčená\)/.test(z)));
  // 2) plný obraz → klip se pořídí
  await s.proved('setConsent', ['tapoc2020', { den: 'full', noc: 'full', nouze: true }]);
  const r2 = await s.proved('emit', ['tapoc2020', 'linecross']);
  await s.hotovo();
  radky = await tb.vyber(T, 'A_KAM_Nahravka', { kde: { UdalostId: r2.vysledek.id } });
  assert.equal(radky.length, 1); assert.equal(radky[0].Chyba, null); assert.equal(radky[0].Uloziste, 'server'); assert.equal(volani.length, 2, 'klip z go2rtc: uzamčená + plný obraz');
  assert.ok(zpravy.some((z) => /linecross: nahrávám/.test(z)) && zpravy.some((z) => /linecross: uloženo \(server/.test(z)));
  // 3) událost bez zatrženého Nahrávat se nenahrává a nezapisuje
  await s.proved('setWatch', ['tapoc2020', 'motion', { on: true, rec: false }]);
  await s.proved('emit', ['tapoc2020', 'motion']); await s.hotovo();
  assert.equal((await tb.vyber(T, 'A_KAM_Nahravka')).length, 3);
  // 4) kamera označená jako nedostupná: simulovaná událost se nenahrává, skutečná z kamery ano (kamera ji právě nahlásila)
  (await s.stav()).state.patients.find((x) => x.id === 'tapoc2020').offline = true;
  const r4 = await s.proved('emit', ['tapoc2020', 'linecross']); await s.hotovo();
  assert.match((await tb.vyber(T, 'A_KAM_Nahravka', { kde: { UdalostId: r4.vysledek.id } }))[0].Chyba, /kamera je nedostupná/);
  posun(1000);
  prijate.push({ prijato: T0 + 500, kameraId: 'tapoc2020', kind: 'cam-linecross', text: 'Kamera hlásí: překročení čáry.' });
  const st = await s.stav(); await s.hotovo();
  const real = st.state.events.find((e) => e.real && e.kind === 'linecross');
  assert.ok(real, 'skutečná událost se zapsala');
  assert.equal(volani.length, 3, 'klip se pořídil i u kamery označené jako nedostupná');
  assert.equal((await tb.vyber(T, 'A_KAM_Nahravka', { kde: { UdalostId: real.id } }))[0].Chyba, null);
  // 5) chyba go2rtc u jiné kamery → řádek s chybou (porid ji zachytí) a důvod u události
  const { s: s2 } = stav(tb, { t0: T0, nahravky, log, tenant: T2 });
  await s2.stav(); await s2.proved('setConsent', ['kam2', { den: 'full', noc: 'full', nouze: true }]);
  const r5 = await s2.proved('emit', ['kam2', 'linecross']); await s2.hotovo();
  assert.match((await tb.vyber(T2, 'A_KAM_Nahravka', { kde: { UdalostId: r5.vysledek.id } }))[0].Chyba, /stream kam2 neběží/);
});

test('druhá událost během nahrávky: žádný řádek „právě běží“, událost patří k běžící nahrávce (i po novém načtení)', async () => {
  const { createNahravky } = await import('../src/nahravky.mjs');
  const tb = createMockTabulky();
  let pust; const go2rtc = { async proxy() { await new Promise((r) => { pust = r; }); return new Response(Buffer.alloc(8192, 1), { status: 200 }); } };
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(t, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const T0 = Date.UTC(2023, 10, 15, 9, 0, 0);
  const nahravky = createNahravky({ go2rtc, uloziste, tabulky: tb, kamery, log: ticho, now: () => T0 });
  const { s, posun } = stav(tb, { t0: T0, nahravky });
  await s.stav();
  const r1 = await s.proved('emit', ['tapoc2020', 'linecross']);
  posun(3000);
  const r2 = await s.proved('emit', ['tapoc2020', 'linecross']);
  await new Promise((r) => setTimeout(r, 20)); pust(); await s.hotovo();
  const radky = await tb.vyber(T, 'A_KAM_Nahravka');
  assert.equal(radky.length, 1, 'jen jedna nahrávka, žádný řádek „právě běží“'); assert.equal(radky[0].UdalostId, r1.vysledek.id);
  const st = await s.stav();
  const e2 = st.state.events.find((e) => e.id === r2.vysledek.id);
  assert.equal(e2.nahravka.id, radky[0].Id, 'druhá událost ukazuje na tutéž nahrávku'); assert.equal(e2.nahravka.sdilena, true);
  // po novém načtení ze serveru (restart) vazba drží podle času
  const { s: s2 } = stav(tb, { t0: T0 + 60000, nahravky });
  const st2 = await s2.stav();
  assert.equal(st2.state.events.find((e) => e.id === r2.vysledek.id).nahravka?.id, radky[0].Id);
  assert.equal((await nahravky.seznam(T)).length, 1);
});

test('až tři časová okna na událost: hlídá se v kterémkoli, text oken, nevyplněný konec je chyba', async () => {
  const { seed, proved, withinHours, oknaText, describeWatch } = await import('../public/proto/sim-core.js');
  const s = seed(Date.UTC(2026, 9, 5, 5, 0, 0));
  const p = s.patients.find((x) => x.real) || s.patients[0];
  proved(s, 'setWatch', [p.id, 'linecross', { from: '07:00', to: '08:00', from2: '12:00', to2: '13:00', from3: '19:00', to3: '20:00' }], Date.UTC(2026, 9, 5, 5, 0, 0));
  const w = s.patients.find((x) => x.id === p.id).watch.linecross;
  assert.equal(oknaText(w), '07:00–08:00, 12:00–13:00, 19:00–20:00');
  const praha = (h, m = 0) => Date.UTC(2026, 9, 5, h - 2, m);   // letní čas: Praha = UTC+2
  assert.equal(withinHours(w, new Date(praha(7, 30))), true); assert.equal(withinHours(w, new Date(praha(12, 59))), true); assert.equal(withinHours(w, new Date(praha(19, 0))), true);
  assert.equal(withinHours(w, new Date(praha(9, 0))), false); assert.equal(withinHours(w, new Date(praha(20, 0))), false);
  assert.equal(proved(s, 'emit', [p.id, 'linecross'], praha(9, 0)).vysledek, null, 'mimo okna se zahodí');
  assert.match(s.lastDropped.reason, /mimo hodiny 07:00–08:00, 12:00–13:00, 19:00–20:00/);
  assert.ok(proved(s, 'emit', [p.id, 'linecross'], praha(12, 30)).vysledek, 'v druhém okně projde');
  assert.match(describeWatch(s.patients.find((x) => x.id === p.id).watch), /překročení čáry 07:00–08:00, 12:00–13:00, 19:00–20:00/);
  // druhé okno smazané → hlídá se jen v prvním a třetím; okno přes půlnoc
  proved(s, 'setWatch', [p.id, 'linecross', { from2: '', to2: '', from3: '22:00', to3: '06:00' }], praha(9));
  const w2 = s.patients.find((x) => x.id === p.id).watch.linecross;
  assert.equal(oknaText(w2), '07:00–08:00, 22:00–06:00'); assert.equal(withinHours(w2, new Date(praha(23, 30))), true); assert.equal(withinHours(w2, new Date(praha(12, 30))), false);
  assert.throws(() => proved(s, 'setWatch', [p.id, 'linecross', { from2: '12:00', to2: '' }], praha(9)), /začátek i konec okna/);
  assert.throws(() => proved(s, 'setWatch', [p.id, 'linecross', { from3: '25:00', to3: '26:00' }], praha(9)), /HH:MM/);
});

test('hromadné uzavření alertů: jedné kamery nebo všech, info události a uzavřené se nemění', async () => {
  const { seed, proved } = await import('../public/proto/sim-core.js');
  const t = Date.UTC(2026, 9, 5, 8, 0, 0);
  const s = seed(t);
  const p1 = s.patients[0].id, p2 = s.patients[1].id;
  proved(s, 'emit', [p1, 'fall'], t); proved(s, 'emit', [p1, 'tamper'], t); proved(s, 'emit', [p2, 'fall'], t); proved(s, 'emit', [p2, 'person'], t);
  const pred = s.events.filter((e) => e.state !== 'uzavřen').length;
  assert.ok(pred >= 3);
  const r1 = proved(s, 'closeAll', [p1, 'Dispečerka Jana', 'planý poplach'], t + 1000);
  assert.equal(r1.vysledek.pocet, s.events.filter((e) => e.patientId === p1 && e.closedAt === t + 1000).length, 'uzavřené právě teď');
  assert.ok(r1.vysledek.pocet >= 2);
  assert.ok(s.events.filter((e) => e.patientId === p1 && e.state !== 'uzavřen').length === 0, 'kamera 1 bez otevřených');
  assert.ok(s.events.some((e) => e.patientId === p2 && e.state !== 'uzavřen'), 'kamera 2 nedotčená');
  const zavrene = s.events.find((e) => e.patientId === p1 && e.kind === 'fall');
  assert.equal(zavrene.by, 'Dispečerka Jana'); assert.equal(zavrene.closedAt, t + 1000); assert.equal(zavrene.takenAt, t + 1000);
  const r2 = proved(s, 'closeAll', ['', 'Dispečink', ''], t + 2000);
  assert.ok(r2.vysledek.pocet >= 1); assert.equal(s.events.filter((e) => e.state !== 'uzavřen').length, 0);
  assert.equal(s.events.find((e) => e.patientId === p2 && e.kind === 'fall').result, 'hromadně uzavřeno');
  assert.equal(proved(s, 'closeAll', ['', 'x', 'y'], t + 3000).vysledek.pocet, 0, 'podruhé nic');
});

test('deaktivace kamery: v jádru i po restartu – bez obrazu, událostí a nahrávek; aktivace vrátí hlídání', async () => {
  const { seed, proved, efektivni } = await import('../public/proto/sim-core.js');
  const { smiNahravat } = await import('../src/nahravky.mjs');
  const t0 = Date.UTC(2026, 9, 5, 10, 0, 0);
  const s = seed(t0);
  const p = s.patients.find((x) => x.real) || s.patients[0];
  proved(s, 'emergencyAccess', [p.id, 'Dispečer'], t0);
  assert.ok(s.grants[p.id], 'nouzový přístup dal povolení');
  const e0 = s.events.length;
  const out = proved(s, 'deaktivace', [p.id, true, 'Eva'], t0 + 1000);
  assert.deepEqual(out.vysledek, { patientId: p.id, on: true, zmena: true });
  assert.equal(s.grants[p.id], undefined, 'povolení plného obrazu končí');
  assert.equal(efektivni(s, p, t0 + 2000).mode, 'none'); assert.equal(efektivni(s, p, t0 + 2000).zdroj, 'deaktivace');
  assert.equal(smiNahravat(s, p, 'fall', t0 + 2000).ok, false, 'ani kritická událost s nouzí se nenahrává');
  assert.equal(proved(s, 'emit', [p.id, 'fall', { real: true }], t0 + 3000).vysledek, null);
  assert.equal(s.lastDropped.reason, 'kamera je deaktivovaná rodinou');
  assert.equal(s.events.length, e0 + 1, 'jen řádek o deaktivaci');
  assert.equal(proved(s, 'deaktivace', [p.id, true, 'Eva'], t0 + 4000).vysledek.zmena, false);
  // tenant: uloží se do A_KAM_Kamera a přežije restart
  const tb = createMockTabulky();
  const { s: st } = stav(tb, { t0 });
  await st.stav();
  await st.proved('deaktivace', ['tapoc2020', true, 'Eva']);
  assert.match(tb.data[T].A_KAM_Kamera[0].Deaktivace, /"kdo":"Eva"/);
  await st.otoceniKamery({ kameraId: 'tapoc2020', on: true, ok: true });
  const { s: st2 } = stav(tb, { t0: t0 + 60000 });
  const x = await st2.stav();
  assert.equal(x.state.patients[0].deaktivace.kdo, 'Eva'); assert.equal(x.state.patients[0].deaktivace.otoceni, 'ok');
  const ev = await st2.proved('emit', ['tapoc2020', 'linecross', { real: true }]);
  assert.equal(ev.vysledek, null, 'po restartu dál nic nezapisuje');
  await st2.proved('deaktivace', ['tapoc2020', false, 'Eva']);
  assert.equal(tb.data[T].A_KAM_Kamera[0].Deaktivace, null);
  assert.ok((await st2.proved('emit', ['tapoc2020', 'fall', { real: true }])).vysledek, 'po aktivaci se hlídá');
});
