import test from 'node:test';
import assert from 'node:assert/strict';
import { createUzivatele, normalizeTelefon, formatTelefon, hashHesla, hesloOdpovida, overHeslo, textPozvanky, POZVANKA_TTL_MS } from '../src/uzivatele.mjs';
import { cookieRodina, cookieDispecer, cookie, kdo, prihlasen, odhlaseni, dispecinkTenanta } from '../src/session.mjs';

process.env.SESSION_KEY = 'testovaci-klic';

import { createMockTabulky } from './mock-tabulky.mjs';
const T = '22202480FAMICURA', T2 = '02570459DSIDEQAJ';

test('pozvánka → aktivace → přihlášení; nová pozvánka staré heslo zruší; vše u tenanta', async () => {
  let t = 1_700_000_000_000;
  const tb = createMockTabulky();
  const vsichni = createUzivatele(tb, { now: () => t });
  const u = vsichni.pro(T);
  const { uzivatel, token } = await u.vytvor({ jmeno: 'Petr Novák', telefon: '+420 777 123 456', kamery: ['tapoc2020'] });
  assert.equal(uzivatel.aktivni, false);
  assert.equal(uzivatel.telefon, '777123456');
  assert.ok(token.length >= 20);
  assert.equal(await vsichni.prihlas('777123456', 'cokoli-heslo'), null, 'před aktivací se nepřihlásí');
  assert.deepEqual(await vsichni.pozvanka(token), { platna: true, jmeno: 'Petr Novák', tenant: T, role: 'rodina' });
  assert.deepEqual(await vsichni.pozvanka('jiny'), { platna: false });
  await assert.rejects(vsichni.aktivuj(token, 'kratke'), /aspoň 8/);
  await assert.rejects(vsichni.aktivuj('jiny-token', 'Famicura2026'), /neplatí/);
  const a = await vsichni.aktivuj(token, 'Famicura2026');
  assert.equal(a.aktivni, true); assert.equal(a.tenant, T, 'aktivace řekne, u kterého tenanta účet je');
  await assert.rejects(vsichni.aktivuj(token, 'Famicura2026'), /neplatí/, 'token je na jedno použití');
  assert.deepEqual(await vsichni.pozvanka(token), { platna: false }, 'použitý odkaz už neplatí');
  const p = await vsichni.prihlas('777 123 456', 'Famicura2026');
  assert.equal(p.id, uzivatel.id); assert.equal(p.tenant, T);
  assert.equal(await vsichni.prihlas('777 123 456', 'Famicura2027'), null);
  assert.equal(await vsichni.prihlas('777 999 999', 'Famicura2026'), null);
  await u.zmenHeslo(uzivatel.id, 'Famicura2026', 'NoveHeslo99');
  await assert.rejects(u.zmenHeslo(uzivatel.id, 'Famicura2026', 'NoveHeslo99'), /nesedí/);
  assert.equal((await vsichni.prihlas('777123456', 'NoveHeslo99')).jmeno, 'Petr Novák');
  const { token: token2 } = await u.novaPozvanka(uzivatel.id);
  assert.equal(await vsichni.prihlas('777123456', 'NoveHeslo99'), null, 'po nové pozvánce staré heslo neplatí');
  t += POZVANKA_TTL_MS + 1;
  await assert.rejects(vsichni.aktivuj(token2, 'DalsiHeslo1'), /neplatí/, 'po 7 dnech pozvánka propadne');
  assert.equal((await u.seznam())[0].aktivni, false);
  assert.deepEqual(await vsichni.pro(T2).seznam(), [], 'jiný tenant účet nevidí');
  assert.equal(await vsichni.pro(T2).podleId(uzivatel.id), null);
  await assert.rejects(vsichni.pro(T2).smaz(uzivatel.id), /neexistuje/);
  await u.smaz(uzivatel.id);
  assert.deepEqual(await u.seznam(), []);
});

test('stejný telefon u dvou tenantů: přihlášení vybere účet, ke kterému heslo sedí', async () => {
  const vsichni = createUzivatele(createMockTabulky());
  const a = await vsichni.pro(T).vytvor({ jmeno: 'Dcera', telefon: '777123456', kamery: ['k1'] });
  const b = await vsichni.pro(T2).vytvor({ jmeno: 'Syn', telefon: '777123456', kamery: ['k2'] });
  await vsichni.aktivuj(a.token, 'HesloProA-1'); await vsichni.aktivuj(b.token, 'HesloProB-2');
  assert.equal((await vsichni.prihlas('777123456', 'HesloProA-1')).tenant, T);
  assert.equal((await vsichni.prihlas('777123456', 'HesloProB-2')).tenant, T2);
  assert.equal(await vsichni.prihlas('777123456', 'HesloProC-3'), null);
});

test('kontroly při zakládání a uložené řádky bez tajemství', async () => {
  const tb = createMockTabulky();
  const vsichni = createUzivatele(tb); const u = vsichni.pro(T);
  await assert.rejects(u.vytvor({ jmeno: '', telefon: '777123456', kamery: ['a'] }), /Jméno/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '12', kamery: ['a'] }), /Telefon/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: [] }), /kameru/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: ['../x'] }), /kameru/);
  const { token } = await u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: ['tapoc2020'] });
  await assert.rejects(u.vytvor({ jmeno: 'B', telefon: '+420777123456', kamery: ['tapoc2020'] }), /už existuje/);
  const ulozeno = JSON.stringify(tb.data[T].A_KAM_UzivatelRodiny);
  assert.ok(!ulozeno.includes(token), 'token pozvánky v tabulce není, jen jeho hash');
  await vsichni.aktivuj(token, 'Famicura2026');
  assert.ok(!JSON.stringify(tb.data[T].A_KAM_UzivatelRodiny).includes('Famicura2026'));
});

test('cookie: rodina a dispečer nesou tenanta, správce bez tenanta i s tenantem, stará dvoudílná cookie platí jako správce', () => {
  const h = (c) => new Headers({ cookie: c.split(';')[0] });
  assert.deepEqual(kdo(h(cookieRodina(T, 'abc123'))), { role: 'rodina', tenant: T, id: 'abc123' });
  assert.equal(prihlasen(h(cookieRodina(T, 'abc123'))), false, 'rodina není správce');
  assert.deepEqual(kdo(h(cookie())), { role: 'admin', tenant: '' });
  assert.deepEqual(kdo(h(cookie(Date.now(), 'x'))), { role: 'admin', tenant: '' }, 'neplatný tenant se do cookie nedostane');
  assert.deepEqual(kdo(h(cookie(Date.now(), T))), { role: 'admin', tenant: T });
  assert.equal(prihlasen(h(cookie())), true);
  assert.deepEqual(dispecinkTenanta(h(cookie())), null, 'správce bez tenanta do dispečinku nesmí');
  assert.equal(dispecinkTenanta(h(cookie(Date.now(), T))).jmeno, 'Správce');
  const d = kdo(h(cookieDispecer(T, 17, 'Eva Malá')));
  assert.deepEqual(d, { role: 'dispecer', tenant: T, id: '17', jmeno: 'Eva Malá' });
  assert.equal(dispecinkTenanta(h(cookieDispecer(T, 17, 'Eva Malá'))).jmeno, 'Eva Malá');
  assert.equal(prihlasen(h(cookieDispecer(T, 17, 'Eva'))), false, 'dispečer nespravuje server');
  const [, hodnota] = cookieRodina(T, 'abc123').split(';')[0].split('=');
  const exp = hodnota.split('.')[0], sig = hodnota.split('.').at(-1);
  assert.equal(kdo(h(`fam_tapo=${exp}.admin.${sig}`)), null, 'podpis rodiny neudělá správce');
  assert.equal(kdo(h(`fam_tapo=${exp}.r:${T2}:abc123.${sig}`)), null, 'podpis nepřenese účet k jinému tenantovi');
  assert.match(cookieRodina(T, 'abc123'), /Max-Age=2592000/);
  assert.match(odhlaseni(), /Max-Age=0/);
  assert.throws(() => cookieRodina(T, '../x'));
  assert.throws(() => cookieRodina('', 'abc'));
});

test('text SMS je krátký a nese odkaz', () => {
  const t = textPozvanky({ jmeno: 'Marie Novakova', odkaz: 'https://famicuratapo.95-216-201-2.sslip.io/r/AbCdEfGhIjKlMnOpQrStUv' });
  assert.ok(t.includes('https://famicuratapo.95-216-201-2.sslip.io/r/AbCdEfGhIjKlMnOpQrStUv'));
  assert.ok(t.length <= 306, `nejvýš 2 díly SMS (${t.length} znaků)`);
  assert.ok(/Pridat na plochu/.test(t), 'rada, jak uložit na plochu');
  assert.ok(/prihlasite telefonem a heslem/.test(t), 'co dělat při dalším klepnutí');
  assert.ok(!/[ěščřžýáíéúůťďňĚŠČŘŽÝÁÍÉÚŮŤĎŇ]/.test(t), 'bez diakritiky (dělení SMS po 153 znacích místo 67)');
});

test('druhá kamera téhož člověka: podle telefonu se účtu kamera přidá, odebrání jedné kamery účet nechá, poslední ho smaže', async () => {
  const tb = createMockTabulky();
  const u = createUzivatele(tb).pro(T);
  const { uzivatel } = await u.vytvor({ jmeno: 'Eva', telefon: '777 123 456', kamery: ['tapoc2020'] });
  assert.equal((await u.podleTelefonu('+420777123456')).id, uzivatel.id);
  assert.equal(await u.podleTelefonu('777999999'), null);
  const p = await u.pridejKameru(uzivatel.id, 'famicura001');
  assert.deepEqual(p.kamery, ['tapoc2020', 'famicura001']);
  assert.deepEqual((await u.pridejKameru(uzivatel.id, 'famicura001')).kamery, ['tapoc2020', 'famicura001'], 'podruhé se nezdvojí');
  await assert.rejects(u.pridejKameru(uzivatel.id, '../x'), /Neplatné ID/);
  const o1 = await u.odeberKameru(uzivatel.id, 'tapoc2020');
  assert.equal(o1.smazan, false); assert.deepEqual(o1.uzivatel.kamery, ['famicura001']);
  const o2 = await u.odeberKameru(uzivatel.id, 'famicura001');
  assert.equal(o2.smazan, true); assert.equal(await u.podleTelefonu('777123456'), null, 'bez poslední kamery účet zmizí');
});

test('mobilní dispečer: role dispecer bez kamer, pozvánka s jasným textem, deaktivace účtu rodiny i dispečera', async () => {
  let t = 1_700_000_000_000;
  const vsichni = createUzivatele(createMockTabulky(), { now: () => t }); const u = vsichni.pro(T);
  const d = await u.vytvor({ jmeno: 'Jana Dispečerka', telefon: '777 000 111', role: 'dispecer' });
  assert.equal(d.uzivatel.role, 'dispecer'); assert.deepEqual(d.uzivatel.kamery, []); assert.equal(d.uzivatel.deaktivovan, null);
  const d2 = await u.vytvor({ jmeno: 'Druhý', telefon: '777 000 222', role: 'dispecer', kamery: ['k1'] });
  assert.deepEqual(d2.uzivatel.kamery, [], 'dispečer kamery nemá, seznam se ignoruje'); assert.equal((await u.seznam()).filter((x) => x.role === 'dispecer').length, 2, 'tenant může mít víc dispečerů');
  await assert.rejects(u.vytvor({ jmeno: 'X', telefon: '777000333', role: 'neco' }), /Typ účtu/);
  await assert.rejects(u.vytvor({ jmeno: 'X', telefon: '777000333', role: 'rodina' }), /aspoň jednu kameru/);
  const r = await u.vytvor({ jmeno: 'Petr', telefon: '777000444', kamery: ['k1'] });
  assert.equal(r.uzivatel.role, 'rodina', 'výchozí role je rodina');
  assert.deepEqual(await vsichni.pozvanka(d.token), { platna: true, jmeno: 'Jana Dispečerka', tenant: T, role: 'dispecer' });
  const text = textPozvanky({ jmeno: 'Jana Dispečerka', odkaz: 'https://x/r/abc', role: 'dispecer', poskytovatel: 'FamiCura s.r.o.' });
  assert.match(text, /pristup DISPECERA k dohledu \(FamiCura s.r.o.\): https:\/\/x\/r\/abc/); assert.match(text, /vsechny kamery poskytovatele, nic v nich nenastavujete/); assert.ok(!/[^\x00-\x7f]/.test(text), 'bez diakritiky');
  await vsichni.aktivuj(d.token, 'DispecerHeslo1');
  assert.equal((await vsichni.prihlas('777000111', 'DispecerHeslo1')).role, 'dispecer');
  // deaktivace: heslo zůstává, ale přihlášení vrátí účet s deaktivovan (API ho odmítne), pozvánka neplatí, aktivace odkazem také ne
  const dd = await u.deaktivuj(d.uzivatel.id, true); assert.ok(dd.deaktivovan);
  assert.ok((await vsichni.prihlas('777000111', 'DispecerHeslo1')).deaktivovan);
  await u.deaktivuj(r.uzivatel.id, true);
  assert.deepEqual(await vsichni.pozvanka(r.token), { platna: false }, 'deaktivovaný účet: pozvánka neplatí');
  await assert.rejects(vsichni.aktivuj(r.token, 'RodinaHeslo1'), /deaktivovaný/);
  await u.deaktivuj(r.uzivatel.id, false);
  assert.equal((await vsichni.pozvanka(r.token)).platna, true, 'po aktivaci pozvánka zase platí');
  assert.equal((await u.deaktivuj(d.uzivatel.id, false)).deaktivovan, null);
  await assert.rejects(u.deaktivuj('neni', true), /neexistuje/);
  // odebrání dispečera u kamery = smazání účtu (kamery nemá)
  assert.deepEqual(await u.odeberKameru(d.uzivatel.id, 'k1'), { smazan: true, uzivatel: null });
  assert.equal(await u.podleId(d.uzivatel.id), null);
});
