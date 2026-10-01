import test from 'node:test';
import assert from 'node:assert/strict';
import { createUzivatele, normalizeTelefon, formatTelefon, hashHesla, hesloOdpovida, overHeslo, textPozvanky, POZVANKA_TTL_MS } from '../src/uzivatele.mjs';
import { cookieRodina, cookie, kdo, prihlasen, odhlaseni } from '../src/session.mjs';

process.env.SESSION_KEY = 'testovaci-klic';

function memStore() {
  const data = {};
  return { data, async nacti(n) { return structuredClone(data[n] || {}); }, async uloz(n, v) { data[n] = structuredClone(v); } };
}

test('telefon: české tvary se sjednotí, cizí a krátké se odmítnou', () => {
  for (const t of ['777 123 456', '+420 777 123 456', '00420777123456', '777123456', '420777123456']) assert.equal(normalizeTelefon(t), '777123456', t);
  for (const t of ['77712345', '0777123456', '+49 170 1234567', '', null, 'abc']) assert.equal(normalizeTelefon(t), null, String(t));
  assert.equal(formatTelefon('777123456'), '777 123 456');
});

test('heslo: scrypt hash, ověření, pravidla', () => {
  const h = hashHesla('tajne-heslo1');
  assert.match(h, /^scrypt\$/);
  assert.equal(hesloOdpovida('tajne-heslo1', h), true);
  assert.equal(hesloOdpovida('tajne-heslo2', h), false);
  assert.equal(hesloOdpovida('x', 'nesmysl'), false);
  assert.equal(overHeslo('kratke'), 'Heslo musí mít aspoň 8 znaků.');
  assert.equal(overHeslo('12345678'), 'Heslo nesmí být jen z číslic.');
  assert.equal(overHeslo('Famicura2026'), null);
});

test('pozvánka → aktivace → přihlášení; nová pozvánka staré heslo zruší', async () => {
  let t = 1_700_000_000_000;
  const u = createUzivatele(memStore(), { now: () => t });
  const { uzivatel, token } = await u.vytvor({ jmeno: 'Petr Novák', telefon: '+420 777 123 456', kamery: ['tapoc2020'] });
  assert.equal(uzivatel.aktivni, false);
  assert.equal(uzivatel.telefon, '777123456');
  assert.ok(token.length >= 20);
  assert.equal(await u.prihlas('777123456', 'cokoli-heslo'), null, 'před aktivací se nepřihlásí');
  assert.deepEqual(await u.pozvanka(token), { platna: true, jmeno: 'Petr Novák' });
  assert.deepEqual(await u.pozvanka('jiny'), { platna: false });
  await assert.rejects(u.aktivuj(token, 'kratke'), /aspoň 8/);
  await assert.rejects(u.aktivuj('jiny-token', 'Famicura2026'), /neplatí/);
  const a = await u.aktivuj(token, 'Famicura2026');
  assert.equal(a.aktivni, true);
  await assert.rejects(u.aktivuj(token, 'Famicura2026'), /neplatí/, 'token je na jedno použití');
  assert.deepEqual(await u.pozvanka(token), { platna: false }, 'použitý odkaz už neplatí');
  assert.equal((await u.prihlas('777 123 456', 'Famicura2026')).id, uzivatel.id);
  assert.equal(await u.prihlas('777 123 456', 'Famicura2027'), null);
  assert.equal(await u.prihlas('777 999 999', 'Famicura2026'), null);
  await u.zmenHeslo(uzivatel.id, 'Famicura2026', 'NoveHeslo99');
  await assert.rejects(u.zmenHeslo(uzivatel.id, 'Famicura2026', 'NoveHeslo99'), /nesedí/);
  assert.equal((await u.prihlas('777123456', 'NoveHeslo99')).jmeno, 'Petr Novák');
  const { token: token2 } = await u.novaPozvanka(uzivatel.id);
  assert.equal(await u.prihlas('777123456', 'NoveHeslo99'), null, 'po nové pozvánce staré heslo neplatí');
  t += POZVANKA_TTL_MS + 1;
  await assert.rejects(u.aktivuj(token2, 'DalsiHeslo1'), /neplatí/, 'po 7 dnech pozvánka propadne');
  assert.equal((await u.seznam())[0].aktivni, false);
  await u.smaz(uzivatel.id);
  assert.deepEqual(await u.seznam(), []);
});

test('kontroly při zakládání a uložený soubor bez tajemství', async () => {
  const store = memStore();
  const u = createUzivatele(store);
  await assert.rejects(u.vytvor({ jmeno: '', telefon: '777123456', kamery: ['a'] }), /Jméno/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '12', kamery: ['a'] }), /Telefon/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: [] }), /kameru/);
  await assert.rejects(u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: ['../x'] }), /kameru/);
  const { token } = await u.vytvor({ jmeno: 'A', telefon: '777123456', kamery: ['tapoc2020'] });
  await assert.rejects(u.vytvor({ jmeno: 'B', telefon: '+420777123456', kamery: ['tapoc2020'] }), /už existuje/);
  const ulozeno = JSON.stringify(store.data.uzivatele);
  assert.ok(!ulozeno.includes(token), 'token pozvánky v souboru není, jen jeho hash');
  await u.aktivuj(token, 'Famicura2026');
  assert.ok(!JSON.stringify(store.data.uzivatele).includes('Famicura2026'));
});

test('cookie rodiny: role a id, admin cookie zůstává admin, stará dvoudílná cookie platí jako admin', () => {
  const h = (c) => new Headers({ cookie: c.split(';')[0] });
  assert.deepEqual(kdo(h(cookieRodina('abc123'))), { role: 'rodina', id: 'abc123' });
  assert.equal(prihlasen(h(cookieRodina('abc123'))), false, 'rodina není admin');
  assert.deepEqual(kdo(h(cookie())), { role: 'admin' });
  assert.equal(prihlasen(h(cookie())), true);
  const [, hodnota] = cookieRodina('abc123').split(';')[0].split('=');
  const [exp, sub, sig] = hodnota.split('.');
  assert.equal(kdo(h(`fam_tapo=${exp}.admin.${sig}`)), null, 'podpis rodiny neudělá admina');
  assert.equal(kdo(h(`fam_tapo=${exp}.r:jiny.${sig}`)), null);
  assert.match(cookieRodina('abc123'), /Max-Age=2592000/);
  assert.match(odhlaseni(), /Max-Age=0/);
  assert.throws(() => cookieRodina('../x'));
});

test('text SMS je krátký a nese odkaz', () => {
  const t = textPozvanky({ jmeno: 'Marie Novakova', odkaz: 'https://famicuratapo.95-216-201-2.sslip.io/r/AbCdEfGhIjKlMnOpQrStUv' });
  assert.ok(t.includes('https://famicuratapo.95-216-201-2.sslip.io/r/AbCdEfGhIjKlMnOpQrStUv'));
  assert.ok(t.length <= 306, `nejvýš 2 díly SMS (${t.length} znaků)`);
  assert.ok(/Pridat na plochu/.test(t), 'rada, jak uložit na plochu');
  assert.ok(/prihlasite telefonem a heslem/.test(t), 'co dělat při dalším klepnutí');
  assert.ok(!/[ěščřžýáíéúůťďňĚŠČŘŽÝÁÍÉÚŮŤĎŇ]/.test(t), 'bez diakritiky (dělení SMS po 153 znacích místo 67)');
});
