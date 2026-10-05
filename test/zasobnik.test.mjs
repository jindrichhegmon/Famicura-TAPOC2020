import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZasobnik, createRozdelovac, rozeberMoof, boxy } from '../src/zasobnik.mjs';
import { createNahravky } from '../src/nahravky.mjs';
import { createNajemci } from '../src/najemci.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';

const ticho = { log() {}, error() {} };
const T = '22202480FAMICURA';

/* ---------- falešný fMP4 ---------- */
const box = (type, ...parts) => { const p = Buffer.concat(parts.map((x) => Buffer.isBuffer(x) ? x : Buffer.from(x))); const h = Buffer.alloc(8); h.writeUInt32BE(8 + p.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, p]); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n), 0); return b; };
const init = () => Buffer.concat([box('ftyp', 'isom'), box('moov', box('mvhd', Buffer.alloc(100)))]);
/** fragment: tfdt (verze 1) = čas v tikách (90 kHz), klíčový snímek podle `klic`, mdat s daným obsahem */
function fragment(tiky, klic, obsah = 'x'.repeat(500)) {
  const tfhd = box('tfhd', u32(0x20), u32(1), u32(klic ? 0x02000000 : 0x01010000));            // default_sample_flags
  const tfdt = box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(tiky)]));
  const trun = box('trun', u32(0x1), u32(1), u32(0));                                         // jen data_offset, bez vlajek vzorků
  return { moof: box('moof', box('mfhd', u32(0), u32(1)), box('traf', tfhd, tfdt, trun)), mdat: box('mdat', obsah) };
}
/** go2rtc, který na stream.mp4 bez duration posílá init a pak fragmenty podle hodin testu (každých 100 ms, klíčový každý 10.). */
function fakeGo2rtc(hodiny) {
  const ovladani = { otevreno: 0, zavrit: null, tiky: 0, krok: null };
  return { ovladani, async proxy(cesta, { signal } = {}) {
    if (/duration=/.test(cesta)) return new Response(Buffer.alloc(4096, 1), { status: 200 });
    ovladani.otevreno++;
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(init());
        ovladani.krok = () => { const n = ovladani.tiky++; const f = fragment(n * 9000, n % 10 === 0); ctrl.enqueue(f.moof); ctrl.enqueue(f.mdat); };
        ovladani.zavrit = () => { try { ctrl.close(); } catch { /* už */ } ovladani.krok = null; };
        signal?.addEventListener('abort', () => ovladani.zavrit?.());
      },
    });
    return new Response(body, { status: 200 });
  } };
}
const pockej = (ms) => new Promise((r) => setTimeout(r, ms));

test('rozdělovač a rozbor moof: init, fragmenty, klíčový snímek, tfdt', () => {
  const inits = [], frags = [];
  const r = createRozdelovac({ onInit: (b) => inits.push(b), onFragment: (f) => frags.push(f) });
  const f1 = fragment(0, true), f2 = fragment(9000, false);
  const vse = Buffer.concat([init(), f1.moof, f1.mdat, f2.moof, f2.mdat]);
  for (let i = 0; i < vse.length; i += 7) r.feed(vse.subarray(i, Math.min(vse.length, i + 7)));   // po kouskách
  assert.equal(inits.length, 1); assert.deepEqual(boxy(inits[0]).map((b) => b.type), ['ftyp', 'moov']);
  assert.equal(frags.length, 2);
  assert.deepEqual(rozeberMoof(frags[0].moof).klic, true); assert.equal(rozeberMoof(frags[1].moof).klic, false);
  const t = rozeberMoof(frags[1].moof).tfdt; assert.equal(t.verze, 1); assert.equal(Number(frags[1].moof.readBigUInt64BE(t.pozice)), 9000);
  // trun s first_sample_flags má přednost před tfhd
  const trun = box('trun', u32(0x5), u32(1), u32(0), u32(0x01010000));
  const moof = box('moof', box('traf', box('tfhd', u32(0x20), u32(1), u32(0x02000000)), trun));
  assert.equal(rozeberMoof(moof).klic, false);
});

test('zásobník: drží posledních maxS sekund, klip začíná klíčovým snímkem před náběhem a časy začínají v nule', async () => {
  let t = 1_000_000;
  const hodiny = () => t;
  const g = fakeGo2rtc(hodiny);
  const z = createZasobnik({ go2rtc: g, kamery: async () => [{ id: 'tapoc2020', tenant: T }, { id: 'bezTenanta', tenant: '' }], maxS: 4, now: hodiny, log: ticho });
  await z.start(100000);
  await pockej(30);
  assert.equal(g.ovladani.otevreno, 1, 'čte se jen kamera s tenantem');
  // 6 s obrazu po 100 ms (60 fragmentů): zůstanou jen poslední 4 s
  for (let i = 0; i < 60; i++) { t += 100; g.ovladani.krok(); await pockej(1); }
  assert.equal(z.bezi('tapoc2020'), true);
  const st = z.stav().tapoc2020; assert.ok(st.sekund <= 4.1 && st.sekund >= 3.5, 'zásobník ~4 s: ' + st.sekund); assert.ok(st.fragmentu <= 42);
  // klip: náběh 2 s + 1 s po; klíčové snímky jsou na n % 10 === 0 (každou sekundu)
  const pr = z.klip('tapoc2020', { predS: 2, poS: 1, cekaniMs: 2000 });
  for (let i = 0; i < 12; i++) { t += 100; g.ovladani.krok(); await pockej(1); }
  const k = await pr;
  assert.ok(k.predS >= 2 && k.predS <= 3, 'náběh od klíčového snímku: ' + k.predS);
  const b = boxy(k.data).map((x) => x.type);
  assert.deepEqual(b.slice(0, 3), ['ftyp', 'moov', 'moof']);
  const moofy = boxy(k.data).filter((x) => x.type === 'moof');
  assert.ok(moofy.length >= 38 && moofy.length <= 44, 'náběh od klíčového snímku (2,9 s) + 1 s po = ~41 fragmentů: ' + moofy.length);
  const prvni = k.data.subarray(moofy[0].od, moofy[0].do);
  assert.equal(rozeberMoof(prvni).klic, true, 'klip začíná klíčovým snímkem');
  assert.equal(Number(prvni.readBigUInt64BE(rozeberMoof(prvni).tfdt.pozice)), 0, 'tfdt prvního fragmentu je 0');
  const druhy = k.data.subarray(moofy[1].od, moofy[1].do);
  assert.equal(Number(druhy.readBigUInt64BE(rozeberMoof(druhy).tfdt.pozice)), 9000, 'další fragment navazuje');
  // výpadek proudu: zásobník neběží, po chvíli se čte znovu
  g.ovladani.zavrit(); await pockej(30);
  assert.equal(z.bezi('tapoc2020'), false);
  await assert.rejects(() => z.klip('tapoc2020', { predS: 2, poS: 1 }), /neběží/);
  z.stop();
});

test('nahrávka po události se zásobníkem má náběh; bez zásobníku jde postaru', async () => {
  let t = 2_000_000; const hodiny = () => t;
  const g = fakeGo2rtc(hodiny);
  const z = createZasobnik({ go2rtc: g, kamery: async () => [{ id: 'tapoc2020', tenant: T }], maxS: 12, now: hodiny, log: ticho });
  await z.start(100000); await pockej(30);
  for (let i = 0; i < 70; i++) { t += 100; g.ovladani.krok(); await pockej(1); }
  const tb = createMockTabulky();
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(tn, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const n = createNahravky({ go2rtc: g, uloziste, tabulky: tb, kamery: async () => [{ id: 'tapoc2020', name: 'Byt', tenant: T }], now: hodiny, log: ticho, zasobnik: z });
  const pr = n.porid(T, { kameraId: 'tapoc2020', delkaS: 5, predS: 5, zdroj: 'udalost', druh: 'linecross' });
  for (let i = 0; i < 55; i++) { t += 100; g.ovladani.krok(); await pockej(1); }
  const v = await pr;
  assert.equal(v.chyba, null); assert.ok(v.delkaS === 10 || v.delkaS === 11, '5 s před (od klíčového snímku, až +1 s) + 5 s po: ' + v.delkaS);
  assert.ok(v.cas <= 2_007_000 - 5000 && v.cas >= 2_007_000 - 6100, 'čas nahrávky = začátek náběhu');
  // bez náběhu (predS 0) nebo bez zásobníku: klip z go2rtc s duration
  const v2 = await n.porid(T, { kameraId: 'tapoc2020', delkaS: 5, predS: 0, zdroj: 'rucni' });
  assert.equal(v2.delkaS, 5); assert.equal(v2.velikost, 4096);
  z.stop();
  const n2 = createNahravky({ go2rtc: g, uloziste, tabulky: tb, kamery: async () => [{ id: 'tapoc2020', name: 'Byt', tenant: T }], now: hodiny, log: ticho });
  assert.equal((await n2.porid(T, { kameraId: 'tapoc2020', delkaS: 5, predS: 5, zdroj: 'rucni' })).delkaS, 5);
});

test('serverová smyčka tenantů: událost kamery se zpracuje bez otevřené stránky', async () => {
  const tb = createMockTabulky();
  let t = Date.UTC(2023, 10, 15, 9, 0, 0);
  const prijate = [];
  const udalosti = { nedavne: (od) => prijate.filter((e) => e.prijato > od) };
  const poslane = [];
  const upozorni = { async posli(state, ev) { poslane.push(ev.kind); return null; } };
  const pdp = { nastaveno: true, tabulky: tb, async zajistiTabulky() { return true; }, async tenant(id) { return id === T ? { id: T, nazev: 'FamiCura' } : null; } };
  const najemci = createNajemci({ pdp, kamery: async () => [{ id: 'tapoc2020', name: 'Byt', tenant: T }], udalosti, upozorni, now: () => t, log: ticho });
  assert.equal(await najemci.krok(), 1, 'první krok založí stav a obnoví ho');
  t += 1000; prijate.push({ prijato: t, kameraId: 'tapoc2020', kind: 'cam-linecross', text: 'Kamera hlásí: překročení čáry.' });
  t += 500;
  assert.equal(await najemci.krok(), 1, 'nová událost → krok zpracuje');
  const s = await (await najemci.pro(T)).stav();
  assert.equal(s.state.events.filter((e) => e.kind === 'linecross' && e.real).length, 1, 'událost je ve stavu tenanta bez volání stránky');
  assert.deepEqual(poslane, ['linecross'], 'upozornění odešlo ze smyčky');
  t += 2000;
  assert.equal(await najemci.krok(), 0, 'bez nové události a do minuty se nic nedělá');
  t += 61000;
  assert.equal(await najemci.krok(), 1, 'po minutě tick (vypršení, eskalace)');
  najemci.start(50); await pockej(5); najemci.stop();
});
