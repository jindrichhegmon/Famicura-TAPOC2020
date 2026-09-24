import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCameraEvents, mistniCas } from '../src/udalosti-kamer.mjs';
import { startFakeOnvif } from './fake-onvif.mjs';
import { mockDbs } from './mock-db.mjs';

function memStore(data = {}) {
  return { data, async nacti(n) { return structuredClone(data[n] || {}); }, async uloz(n, v) { data[n] = structuredClone(v); } };
}

const ticho = { error() {}, log() {} };
const chvilku = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const az = async (co, ms = 3000) => { const t = Date.now(); while (!co()) { if (Date.now() - t > ms) throw new Error('nedočkal se'); await chvilku(50); } };

function sestav(cam, { watch = {}, casPasmo = 'Europe/Prague', now } = {}) {
  const db = mockDbs();
  const store = memStore({ watch });
  const kamery = async () => [{ id: 'tapoc2020', name: 'Pokoj 12', ip: '127.0.0.1', onvifPort: cam.port, user: cam.user, pass: cam.pass }];
  const u = createCameraEvents({ kamery, store, dbs: db.dbs, log: ticho, casPasmo, now, pullS: 1, sleep: (ms) => chvilku(Math.min(ms, 100)) });
  return { u, db, store };
}

test('místní čas: hodiny pečovatelů, ne serveru (UTC)', () => {
  assert.equal(mistniCas(Date.parse('2026-07-01T00:30:00Z'), 'Europe/Prague').getHours(), 2);   // letní čas
  assert.equal(mistniCas(Date.parse('2026-12-01T23:30:00Z'), 'Europe/Prague').getHours(), 0);
  assert.equal(mistniCas(Date.parse('2026-12-01T23:30:00Z'), 'Europe/Prague').getMinutes(), 30);
});

test('server odebírá: zjistí, co kamera umí, událost projde do CLB1 i do seznamu pro stránku', async () => {
  const cam = await startFakeOnvif();
  const { u, db } = sestav(cam);
  try {
    await u.start();
    await az(() => u.stav().tapoc2020?.ok);
    assert.deepEqual(u.stav().tapoc2020.events.map((e) => e.kind), ['cam-motion', 'cam-person', 'cam-vehicle', 'cam-pet', 'cam-tamper', 'cam-babycry']);

    cam.person();
    await az(() => u.nedavne().length === 1);
    const [ev] = u.nedavne();
    assert.equal(ev.kind, 'cam-person');
    assert.equal(ev.label, 'Osoba');
    assert.equal(ev.text, 'Kamera hlásí: osoba.');
    assert.equal(ev.kameraNazev, 'Pokoj 12');
    const row = db.provedene.find((p) => /FamicuraRingLog/.test(p.text));
    assert.ok(row, 'zapsáno do CLB1');
    assert.equal(row.params.druh, 'cam-person');
    assert.equal(row.params.kameraId, 'tapoc2020');
    assert.equal(row.params.zavaznost, 'info');
    assert.equal(row.params.popis, 'Kamera hlásí: osoba.');

    cam.tamper();
    await az(() => u.nedavne().length === 2);
    assert.equal(u.nedavne()[1].level, 'warn');
    assert.equal(u.nedavne(ev.prijato).length, 1, 'since vrací jen novější');
  } finally { await u.stop(); await chvilku(300); await cam.close(); }
});

test('stejná detekce těsně po sobě je jedna událost', async () => {
  const cam = await startFakeOnvif();
  const { u } = sestav(cam);
  try {
    await u.start();
    await az(() => u.stav().tapoc2020?.ok);
    cam.motion(); cam.motion(false); cam.motion();
    await az(() => u.nedavne().length >= 1);
    await chvilku(500);
    assert.equal(u.nedavne().length, 1);
  } finally { await u.stop(); await chvilku(300); await cam.close(); }
});

test('sledované události platí i pro kameru: vypnutý druh a hodiny mimo se nezapíšou', async () => {
  // Now: 03:00 in Prague (02:00 UTC in winter). Person is wanted 08:00–20:00 only.
  const now = () => Date.parse('2026-12-01T02:00:00Z');
  const cam = await startFakeOnvif({ now });
  const { u, db } = sestav(cam, { now, watch: { tapoc2020: { 'cam-motion': { enabled: false }, 'cam-person': { from: '08:00', to: '20:00' } } } });
  try {
    await u.start();
    await az(() => u.stav().tapoc2020?.ok);
    cam.motion(); cam.person(); cam.vehicle();
    await az(() => u.nedavne().length === 1);
    await chvilku(300);
    assert.deepEqual(u.nedavne().map((e) => e.kind), ['cam-vehicle']);
    // What was dropped, and why, is visible: the last one was the person outside its hours.
    const o = u.stav().tapoc2020.odmitnuto;
    assert.equal(o.kind, 'cam-person');
    assert.equal(o.duvod, 'mimo hodiny 08:00–20:00 (čas události 03:00)');
    assert.equal(db.provedene.filter((p) => /FamicuraRingLog/.test(p.text)).length, 1);
  } finally { await u.stop(); await chvilku(300); await cam.close(); }
});

test('výpadek CLB1 událost nezahodí a hlásí se ve stavu', async () => {
  const cam = await startFakeOnvif();
  const { u, db } = sestav(cam);
  db.dbs.clb1.exec = async () => { throw new Error('Login failed for user'); };
  try {
    await u.start();
    await az(() => u.stav().tapoc2020?.ok);
    cam.motion();
    await az(() => u.nedavne().length === 1);
    await az(() => /Login failed/.test(u.stav().tapoc2020.clbChyba || ''));
  } finally { await u.stop(); await chvilku(300); await cam.close(); }
});

test('kamera nedostupná: stav to řekne, po chvíli se zkouší znovu; zastavení zruší odběr', async () => {
  const cam = await startFakeOnvif();
  const { u } = sestav(cam);
  const spatne = createCameraEvents({ kamery: async () => [{ id: 'x', name: 'x', ip: '127.0.0.1', onvifPort: 1, user: 'u', pass: 'p' }],
    store: memStore(), dbs: mockDbs().dbs, log: ticho, sleep: (ms) => chvilku(Math.min(ms, 50)) });
  try {
    await spatne.start();
    await az(() => spatne.stav().x?.error);
    assert.match(spatne.stav().x.error, /neodpovídá/);
    assert.equal(spatne.stav().x.ok, false);

    await u.start();
    await az(() => u.stav().tapoc2020?.ok);
    assert.equal(cam.subs.size, 1);
    await u.stop();
    await az(() => cam.calls.some((c) => c.op === 'Unsubscribe'));
    assert.equal(cam.subs.size, 0, 'odběr na kameře zrušen');
  } finally { await spatne.stop(); await u.stop(); await chvilku(300); await cam.close(); }
});
