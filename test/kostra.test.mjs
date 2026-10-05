import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { snimkyZKlipu, createKostra, SIRKA, VYSKA, SPOJE } from '../src/kostra.mjs';
import { fakeDetektor } from '../src/kostra-fake.mjs';
import { createNahravky, smiNahravat } from '../src/nahravky.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';
import { seed, proved } from '../public/proto/sim-core.js';

const maFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ticho = { log() {}, error() {} };
const T = '22202480FAMICURA';
const klip = (s = 2) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${s}:size=320x240:rate=10`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });

test('snímky z klipu: 5 za sekundu, 320×180 RGB s doplněním poměru stran', { skip: !maFfmpeg && 'ffmpeg není' }, async () => {
  const sn = await snimkyZKlipu(klip(2), { fps: 5 });
  assert.ok(sn.length >= 9 && sn.length <= 11, 'asi 10 snímků: ' + sn.length);
  assert.equal(sn[0].rgb.length, SIRKA * VYSKA * 3); assert.equal(sn[1].t, 200);
});

test('kostra z klipu: JSON se souřadnicemi, bez obrazu; falešný detektor', { skip: !maFfmpeg && 'ffmpeg není' }, async () => {
  const k = createKostra({ detektor: fakeDetektor(), log: ticho });
  assert.equal(await k.priprav(), true);
  const out = await k.zKlipu(klip(2), { delkaS: 2 });
  const j = JSON.parse(out.toString());
  assert.equal(j.typ, 'kostra'); assert.equal(j.model, 'fake17'); assert.equal(j.w, 320); assert.equal(j.h, 180); assert.equal(j.fps, 5);
  assert.ok(j.snimky.length >= 9); assert.equal(j.snimky[0].b.length, 17); assert.deepEqual(j.spoje, SPOJE); assert.equal(j.sPostavou, j.snimky.length);
  assert.ok(out.length < 20000, 'jen souřadnice, pár kB: ' + out.length);
  assert.ok(!out.toString().includes('ftyp'), 'žádný obraz');
});

test('soukromí: rozostření a drátěný model → nahrávka jen jako kostra; plný obraz → video; žádný obraz → nic', () => {
  const s = seed(Date.UTC(2026, 9, 5, 8, 0, 0)); const t = Date.UTC(2026, 9, 5, 8, 0, 0);
  const p = s.patients.find((x) => x.real) || s.patients[0];
  proved(s, 'setConsent', [p.id, { den: 'blur', noc: 'skeleton', nouze: true }], t);
  const r1 = smiNahravat(s, p, 'linecross', t); assert.equal(r1.ok, true); assert.equal(r1.rezim, 'kostra'); assert.match(r1.duvod, /rozostření/);
  assert.equal(smiNahravat(s, p, 'fall', t).rezim, 'full', 'kritická událost s nouzovým přístupem = plný obraz');
  proved(s, 'setConsent', [p.id, { den: 'full', noc: 'full', nouze: true }], t);
  assert.equal(smiNahravat(s, p, 'linecross', t).rezim, 'full');
  proved(s, 'setConsent', [p.id, { den: 'none', noc: 'none', nouze: false }], t);
  assert.equal(smiNahravat(s, p, 'linecross', t).ok, false);
});

test('nahrávka v režimu kostra: řádek s JSON, název _kostra.json, bez převodu MP4; bez modulu kostry chyba 503 v řádku', { skip: !maFfmpeg && 'ffmpeg není' }, async () => {
  const tb = createMockTabulky();
  const go2rtc = { async proxy() { return new Response(klip(2), { status: 200 }); } };
  let remuxVolan = 0;
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(t, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const kamery = async () => [{ id: 'tapoc2020', name: 'Byt Novákovi', tenant: T }];
  const n = createNahravky({ go2rtc, uloziste, tabulky: tb, kamery, log: ticho, kostra: createKostra({ detektor: fakeDetektor(), log: ticho }), remux: async (d) => { remuxVolan++; return { data: d, prevedeno: true }; } });
  const v = await n.porid(T, { kameraId: 'tapoc2020', delkaS: 5, predS: 0, druh: 'linecross', rezim: 'kostra', udalostId: 'e1' });
  assert.equal(v.chyba, null); assert.equal(v.typ, 'kostra'); assert.equal(v.mime, 'application/json'); assert.match(v.nazev, /_Prekroceni_cary_kostra\.json$/);
  assert.equal(remuxVolan, 0, 'JSON se nepřevádí přes ffmpeg');
  const radek = (await tb.vyber(T, 'A_KAM_Nahravka'))[0]; assert.equal(radek.Mime, 'application/json'); assert.ok(radek.Velikost < 20000);
  const seznam = await n.seznam(T); assert.equal(seznam[0].typ, 'kostra');
  const n2 = createNahravky({ go2rtc, uloziste, tabulky: tb, kamery, log: ticho });
  const v2 = await n2.porid(T, { kameraId: 'tapoc2020', delkaS: 5, predS: 0, rezim: 'kostra' });
  assert.match(v2.chyba, /Drátěný model není na serveru k dispozici/);
});
