import test from 'node:test';
import assert from 'node:assert/strict';
import { createNahravky, smiNahravat, DELKA_VYCHOZI } from '../src/nahravky.mjs';
import { createDisk } from '../src/disk.mjs';
import { createUloziste, zasifruj, desifruj, klicZTextu } from '../src/uloziste.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStavTenantu } from '../src/stav-tenant.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';
import { seed, proved } from '../public/proto/sim-core.js';

const T = '22202480FAMICURA';
const ticho = { log() {}, error() {} };
const kamery = async () => [{ id: 'tapoc2020', name: 'Byt Novákovi', tenant: T }];

/** go2rtc, který na stream.mp4 s duration vrátí „MP4“ dané velikosti. */
function fakeGo2rtc(volani = []) {
  return { async proxy(cesta) { volani.push(cesta); const data = Buffer.alloc(200 * 1024, 7); return new Response(data, { status: 200 }); } };
}
function fakeDisk(nahrane = []) {
  return { nastaveno: true, async nahraj(tenant, { nazev, mime, data }) { nahrane.push({ tenant, nazev, mime, velikost: data.length }); return { id: 'f' + nahrane.length, nazev, url: 'https://drive.google.com/file/d/f' + nahrane.length + '/view', velikost: data.length, email: 'posk@example.cz', slozka: { id: 's1' } }; } };
}

test('nahrávka po události: klip z go2rtc jde na Disk, řádek v A_KAM_Nahravka, název s kamerou, časem a druhem', async () => {
  const tb = createMockTabulky(), volani = [], nahrane = [];
  const n = createNahravky({ go2rtc: fakeGo2rtc(volani), disk: fakeDisk(nahrane), tabulky: tb, kamery, now: () => Date.UTC(2026, 9, 4, 8, 5, 9), log: ticho });
  const v = await n.porid(T, { kameraId: 'tapoc2020', delkaS: 20, druh: 'fall', udalostId: 'e1', zdroj: 'udalost', kdo: 'Dispečink' });
  assert.match(volani[0], /^\/api\/stream\.mp4\?src=tapoc2020&video=h264&duration=20$/);
  assert.equal(nahrane[0].mime, 'video/mp4');
  assert.equal(v.nazev, 'Byt_Novakovi_2026-10-04_10-05-09_Mozny_pad.mp4', 'čas v názvu je pražský, bez diakritiky');
  assert.equal(v.url, 'https://drive.google.com/file/d/f1/view');
  assert.equal(v.chyba, null);
  const radky = await tb.vyber(T, 'A_KAM_Nahravka');
  assert.equal(radky.length, 1); assert.equal(radky[0].UdalostId, 'e1'); assert.equal(radky[0].Druh, 'fall'); assert.equal(radky[0].Velikost, 200 * 1024);
  const sez = await n.seznam(T, { kameraId: 'tapoc2020' });
  assert.equal(sez[0].id, v.id);
});

test('délka 5–60 s, jedna nahrávka na kameru najednou, chyba Disku se zapíše k řádku', async () => {
  const tb = createMockTabulky(), volani = [];
  let pust; const pomaly = { async proxy(cesta) { volani.push(cesta); await new Promise((r) => { pust = r; }); return new Response(Buffer.alloc(4096, 1), { status: 200 }); } };
  const disk = { nastaveno: true, async nahraj() { throw new Error('Google Disk odmítl'); } };
  const n = createNahravky({ go2rtc: pomaly, disk, tabulky: tb, kamery, log: ticho });
  const p1 = n.porid(T, { kameraId: 'tapoc2020', delkaS: 999, zdroj: 'rucni' });
  const p2 = n.porid(T, { kameraId: 'tapoc2020', delkaS: 1, zdroj: 'rucni' });
  pust();
  const [a, b] = await Promise.all([p1, p2]);
  assert.match(volani[0], /duration=60$/);
  assert.equal(volani.length, 1, 'druhá nahrávka se nepouští, dokud první běží');
  assert.equal(b.preskoceno, true);
  assert.equal(a.url, null); assert.match(a.chyba, /Google Disk odmítl/);
  assert.equal((await tb.vyber(T, 'A_KAM_Nahravka'))[0].Chyba, 'Google Disk odmítl');
  assert.equal(n.normDelka(undefined), DELKA_VYCHOZI);
});

test('soukromí: nahrává se jen při plném obrazu, nebo kritická událost s nouzovým přístupem', () => {
  const s = seed(Date.UTC(2026, 9, 4, 8, 0, 0));
  const p = s.patients.find((x) => x.real) || s.patients[0];
  proved(s, 'setConsent', [p.id, { den: 'blur', noc: 'none', nouze: true }], Date.UTC(2026, 9, 4, 8, 0, 0));
  assert.equal(smiNahravat(s, p, 'motion', Date.UTC(2026, 9, 4, 8, 0, 0)).ok, false, 'rozostření → běžná událost se nenahrává');
  assert.equal(smiNahravat(s, p, 'fall', Date.UTC(2026, 9, 4, 8, 0, 0)).ok, true, 'pád s nouzovým přístupem ano');
  proved(s, 'setConsent', [p.id, { den: 'full', noc: 'full', nouze: false }], Date.UTC(2026, 9, 4, 8, 0, 0));
  assert.equal(smiNahravat(s, p, 'motion', Date.UTC(2026, 9, 4, 8, 0, 0)).ok, true);
  proved(s, 'setConsent', [p.id, { den: 'none', noc: 'none', nouze: false }], Date.UTC(2026, 9, 4, 8, 0, 0));
  assert.equal(smiNahravat(s, p, 'fall', Date.UTC(2026, 9, 4, 8, 0, 0)).ok, false, 'bez nouzového přístupu ani pád');
  assert.equal(smiNahravat(s, null, 'fall').ok, false);
});

test('stav tenanta: událost s Nahrávat dostane odkaz na nahrávku; po restartu je odkaz z tabulky', async () => {
  const tb = createMockTabulky(), nahrane = [];
  const n = createNahravky({ go2rtc: fakeGo2rtc(), disk: fakeDisk(nahrane), tabulky: tb, kamery, log: ticho });
  let t = 1_700_000_000_000;
  const mk = () => createStavTenantu({ tenant: T, tabulky: tb, kamery, now: () => t, log: ticho, nazev: 'FamiCura', nahravky: n });
  const s = mk();
  await s.proved('setConsent', ['tapoc2020', { den: 'full', noc: 'full', nouze: true }]);
  await s.proved('setWatch', ['tapoc2020', 'fall', { rec: true }]);
  const r = await s.proved('emit', ['tapoc2020', 'fall']);
  await s.hotovo();
  const st = await s.stav();
  const e = st.state.events.find((x) => x.id === r.vysledek.id);
  assert.ok(e.nahravka && e.nahravka.url, 'u události je odkaz na nahrávku');
  assert.equal(nahrane.length, 1);
  await s.proved('setWatch', ['tapoc2020', 'motion', { on: true, rec: false }]);
  const r2 = await s.proved('emit', ['tapoc2020', 'motion']);
  await s.hotovo();
  assert.equal((await s.stav()).state.events.find((x) => x.id === r2.vysledek.id).nahravka, undefined, 'bez Nahrávat se nenahrává');
  await s.proved('setConsent', ['tapoc2020', { den: 'skeleton', noc: 'skeleton', nouze: false }]);
  const r3 = await s.proved('emit', ['tapoc2020', 'fall']);
  await s.hotovo();
  assert.match((await s.stav()).state.events.find((x) => x.id === r3.vysledek.id).nahravka.chyba, /nenahráno: rodina povolila jen/);
  assert.equal(nahrane.length, 1);
  const s2 = mk();
  const e2 = (await s2.stav()).state.events.find((x) => x.id === r.vysledek.id);
  assert.equal(e2.nahravka.url, e.nahravka.url, 'po restartu serveru je odkaz z A_KAM_Nahravka');
});

test('disk: token z jhn-apps (s klíčem), resumable upload na Google Disk, token v cache', async () => {
  const volani = [];
  const fetchImpl = async (url, init) => {
    volani.push({ url: String(url), init });
    if (String(url).endsWith('/api/apps/pecedomaplus-kamera-disk')) {
      const b = JSON.parse(init.body);
      assert.equal(init.headers['x-app-token'], 'tok'); assert.equal(b.klic, 'tajny-klic-123456'); assert.equal(b.tenant, T);
      if (b.akce === 'stav') return new Response(JSON.stringify({ ok: 1, result: { ok: 1, google: { pripojen: true, email: 'p@x.cz' }, slozka: { id: 's1', nazev: 'Famicura Kamera – X', url: 'u' } } }));
      if (b.akce === 'token') return new Response(JSON.stringify({ ok: 1, result: { ok: 1, access: 'acc1', expires: Date.now() + 3e6, slozka: { id: 's1', nazev: 'Famicura Kamera – X', url: 'u' }, email: 'p@x.cz' } }));
    }
    if (String(url).startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
      assert.equal(init.headers.Authorization, 'Bearer acc1');
      assert.equal(JSON.parse(init.body).parents[0], 's1');
      return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/session/1' } });
    }
    if (String(url) === 'https://www.googleapis.com/upload/session/1') { assert.equal(init.method, 'PUT'); assert.equal(init.body.length, 3000); return new Response(JSON.stringify({ id: 'f9', name: 'x.mp4', size: '3000', webViewLink: 'https://drive/f9' })); }
    throw new Error('nečekané ' + url);
  };
  const d = createDisk({ url: 'https://jhn', token: 'tok', klic: 'tajny-klic-123456', fetchImpl, log: ticho });
  assert.equal(d.nastaveno, true);
  assert.equal((await d.stav(T)).google.email, 'p@x.cz');
  const v = await d.nahraj(T, { nazev: 'x.mp4', data: Buffer.alloc(3000, 1) });
  assert.equal(v.id, 'f9'); assert.equal(v.url, 'https://drive/f9'); assert.equal(v.email, 'p@x.cz');
  await d.nahraj(T, { nazev: 'y.mp4', data: Buffer.alloc(3000, 2) });
  assert.equal(volani.filter((x) => x.url.endsWith('pecedomaplus-kamera-disk') && JSON.parse(x.init.body).akce === 'token').length, 1, 'token se bere jednou a drží v cache');
  const bez = createDisk({ url: 'https://jhn', token: '', klic: '', fetchImpl, log: ticho });
  assert.equal(bez.nastaveno, false);
  await assert.rejects(() => bez.stav(T), /nejsou na serveru nastavené/);
});

test('uloziste: AES-256-GCM, soubor na disku není čitelný bez klíče, klíč z base64url i hex, cizí tenant/id odmítne', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fkn-'));
  const klic = klicZTextu(Buffer.alloc(32, 3).toString('base64url'));
  assert.equal(klic.length, 32); assert.equal(klicZTextu('ab'.repeat(32)).length, 32); assert.equal(klicZTextu('kratke'), null); assert.equal(klicZTextu(''), null);
  const u = createUloziste({ dir, klic });
  assert.equal(u.nastaveno, true);
  const data = Buffer.from('tajna nahravka '.repeat(100));
  const v = await u.uloz(T, 'n123abc', data);
  assert.equal(v.soubor, T + '/n123abc.enc'); assert.equal(v.velikost, data.length);
  const raw = readFileSync(path.join(dir, T, 'n123abc.enc'));
  assert.equal(raw.includes('tajna nahravka'), false, 'na disku je šifrovaný');
  assert.equal(raw.subarray(0, 4).toString(), 'FKN1');
  assert.equal((await u.cti(T, 'n123abc')).equals(data), true);
  assert.throws(() => desifruj(Buffer.alloc(32, 4), raw), /Unsupported state|unable to authenticate|auth/i, 'jiný klíč nedešifruje');
  assert.equal(zasifruj(klic, data).equals(zasifruj(klic, data)), false, 'každé uložení má jiný iv');
  await assert.rejects(() => u.cti(T, 'neni'), /už není/);
  await assert.rejects(() => u.uloz('../x', 'n1', data), /tenant/);
  await assert.rejects(() => u.uloz(T, '../../etc', data), /id nahrávky/);
  assert.equal(await u.smaz(T, 'n123abc'), true); assert.equal(await u.smaz(T, 'n123abc'), false);
  const bez = createUloziste({ dir, klic: null });
  assert.equal(bez.nastaveno, false); await assert.rejects(() => bez.uloz(T, 'n1', data), /NAHRAVKY_KLIC/);
});

test('cíl nahrávky: volba poskytovatele, náhrada podle toho, co je nastavené', () => {
  const tb = createMockTabulky();
  const jen = (server, disk) => createNahravky({ go2rtc: fakeGo2rtc(), disk: disk ? fakeDisk() : null, uloziste: server ? { nastaveno: true } : null, tabulky: tb, kamery, log: ticho });
  assert.deepEqual(jen(true, true).cil('server'), { hlavni: 'server', kopieDisk: false });
  assert.deepEqual(jen(true, true).cil('server', true), { hlavni: 'server', kopieDisk: true }, 'Google Disk zapnutý = kopie vedle serveru');
  assert.deepEqual(jen(true, true).cil('disk'), { hlavni: 'server', kopieDisk: true }, 'starší volba disk = server + kopie');
  assert.deepEqual(jen(true, false).cil('server', true), { hlavni: 'server', kopieDisk: false }, 'bez Disku na serveru žádná kopie');
  assert.deepEqual(jen(false, true).cil('server', false), { hlavni: 'disk', kopieDisk: false }, 'bez klíče serveru jde na Disk');
  assert.throws(() => jen(false, false).cil('server'), /nemají kam/);
  assert.deepEqual(jen(true, false).uloziste, { server: true, disk: false });
});

test('kopie na Google Disk vedle serveru: řádek má soubor na serveru i odkaz na Disk; chyba Disku nahrávku na serveru neruší; misto()', async () => {
  const tb = createMockTabulky(), nahrane = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fkn-'));
  const u = createUloziste({ dir, klic: Buffer.alloc(32, 7) });
  const clb = [];
  const n = createNahravky({ go2rtc: fakeGo2rtc(), disk: fakeDisk(nahrane), uloziste: u, tabulky: tb, kamery, zapisClb: async (r) => { clb.push(r); return { ok: true }; }, log: ticho });
  const v = await n.uloz(T, { kameraId: 'tapoc2020', data: Buffer.alloc(2048, 1), delkaS: 10, zdroj: 'rucni', disk: true });
  assert.equal(v.uloziste, 'server'); assert.match(v.soubor, /\.enc$/); assert.equal(v.url, 'https://drive.google.com/file/d/f1/view'); assert.equal(v.chyba, null);
  assert.equal(nahrane.length, 1); assert.match(clb[0].slozka, /^server:22202480FAMICURA \+ Google Disk/);
  const v2 = await n.uloz(T, { kameraId: 'tapoc2020', data: Buffer.alloc(2048, 2), delkaS: 10, zdroj: 'rucni', disk: false });
  assert.equal(v2.url, null); assert.equal(nahrane.length, 1, 'vypnutý Disk = nic se tam neposílá');
  const rozbity = { nastaveno: true, async nahraj() { throw new Error('Disk odmítl'); } };
  const n2 = createNahravky({ go2rtc: fakeGo2rtc(), disk: rozbity, uloziste: u, tabulky: tb, kamery, log: ticho });
  const v3 = await n2.uloz(T, { kameraId: 'tapoc2020', data: Buffer.alloc(2048, 3), delkaS: 10, zdroj: 'rucni', disk: true });
  assert.equal(v3.uloziste, 'server'); assert.ok(v3.soubor); assert.match(v3.chyba, /Google Disk: Disk odmítl/);
  const m = await n.misto(T);
  assert.equal(m.soubory, 3); assert.equal(m.bajty, 3 * (2048 + 32)); assert.ok(m.celkem === null || m.celkem > 0);
});
