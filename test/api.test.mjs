import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler, cameraNames } from '../src/api.mjs';
import { createLimiter } from '../src/limit.mjs';
import { pripravit } from '../src/zaznamy.mjs';
import { mockDbs } from './mock-db.mjs';
import { createUzivatele } from '../src/uzivatele.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';
import { slucMereni } from '../src/log-udalosti.mjs';
import { createNajemci } from '../src/najemci.mjs';
import { createNahravky } from '../src/nahravky.mjs';
import { createUloziste } from '../src/uloziste.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpozorneni } from '../src/upozorneni.mjs';
import { cookieRodina, cookieDispecer } from '../src/session.mjs';

/* Tenanti jako v Péče doma plus: testy běží u tenanta T; T2 je cizí poskytovatel. */
const T = '22202480FAMICURA', T2 = '02570459DSIDEQAJ';
const TENANTI = { [T]: { id: T, nazev: 'FamiCura s.r.o.', ico: '22202480' }, [T2]: { id: T2, nazev: 'Centrum LB', ico: '02570459' } };

process.env.SESSION_KEY = 'testovaci-klic';
process.env.FAMICURA_PASSWORD = 'spravne-heslo';

/** Cookie správce serveru; s tenantem (výchozí T) vidí jeho dispečink, bez tenanta jen server. */
function cookie(expiresAt = Date.now() + 3600_000, key = process.env.SESSION_KEY, tenant = T) {
  const subjekt = tenant ? `a:${tenant}` : 'admin';
  const sig = crypto.createHmac('sha256', key).update(`famicura-tapo:${expiresAt}:${subjekt}`, 'utf8').digest('base64url');
  return `fam_tapo=${expiresAt}.${subjekt}.${sig}`;
}
const cookieServer = () => cookie(Date.now() + 3600_000, process.env.SESSION_KEY, '');

const req = (method, path, { body, cookies, ip } = {}) =>
  new Request('http://localhost' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookies ? { cookie: cookies } : {}),
               ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** go2rtc, jak ho vidí server: jedna kamera, odpovídá. */
function fakeGo2rtc({ streams = ['tapoc2020'], online = true, webrtc } = {}) {
  const calls = [];
  return {
    calls,
    async streams() { return streams; },
    async version() { return '1.9.14'; },
    async webrtc(src, offer) { calls.push({ src, offer }); return webrtc ? webrtc(src, offer) : 'v=0\r\nanswer-for-' + src; },
    async probe(src) { return { ok: online, status: online ? 200 : 500, detail: online ? null : 'dial tcp: i/o timeout' }; },
  };
}

function memStore() {
  const data = {};
  return { data, async nacti(n) { return structuredClone(data[n] || {}); }, async uloz(n, v) { data[n] = structuredClone(v); } };
}

function handler(over = {}) {
  const db = mockDbs(over.radky);
  const go2rtc = over.go2rtc || fakeGo2rtc();
  const store = over.store || memStore();
  const tabulky = over.tabulky || createMockTabulky();
  const uzivatele = createUzivatele(tabulky);
  const sms = over.sms || { nastaveno: false, async posli() { return { ok: false, error: 'SMS není nastavená.' }; }, async posliMail() { return { ok: false, error: 'SMS není nastavená.' }; } };
  // kamery ze serveru (cameras.json): tapoc2020 patří T, cizi T2; go2rtc streamuje obě
  const kameryTenanty = over.kameryTenanty || (async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T, place: 'Kancelář Famicura' }, { id: 'cizi', name: 'Cizí kamera', tenant: T2, place: '' }]);
  const pdp = over.pdp || { nastaveno: true, tabulky, async zajistiTabulky() { return true; }, async tenant(id) { return TENANTI[String(id || '').toUpperCase()] || null; } };
  const najemci = createNajemci({ pdp, kamery: kameryTenanty, udalosti: over.udalosti || null, upozorni: createUpozorneni({ sms, log: { log() {} } }), nahravky: over.nahravky || null, log: { log() {}, error() {} } });
  const dispecer = over.dispecer || { nastaveno: false, async login() { const e = new Error('Přihlášení dispečera není na serveru nastavené.'); e.status = 503; throw e; } };
  return { h: createHandler({ dbs: db.dbs, go2rtc, store, limiter: over.limiter, udalosti: over.udalosti || null, uzivatele, sms, asistent: over.asistent || null, pdp, najemci, dispecer, kameryTenanty, disk: over.disk || null, nahravky: over.nahravky || null, ptz: over.ptz || null , naramky: over.naramky || null }),
    ...db, go2rtc, store, uzivatele: uzivatele.pro(T), vsichni: uzivatele, tabulky, najemci };
}

test('health nepotřebuje přihlášení a vrací verzi', async () => {
  const { h } = handler();
  const r = await h(req('GET', '/api/health'));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.ok(b.cas);
  // Stránka podle toho pozná, že na adrese VPS neodpovídá sousední aplikace.
  assert.equal(b.aplikace, 'famicura-tapo');
});

test('zápis bez přihlášení je odmítnut', async () => {
  const { h, provedene } = handler();
  const r = await h(req('POST', '/api/clb', { body: { typ: 'udalost', cas: new Date().toISOString() } }));
  assert.equal(r.status, 401);
  assert.equal(provedene.length, 0, 'nic se nesmí zapsat');
});

test('zápis s cizím podpisem je odmítnut', async () => {
  const { h, provedene } = handler();
  const r = await h(req('POST', '/api/clb',
    { body: { typ: 'udalost', cas: new Date().toISOString() }, cookies: cookie(Date.now() + 3600_000, 'jiny-klic') }));
  assert.equal(r.status, 401);
  assert.equal(provedene.length, 0);
});

test('zápis s prošlou cookie je odmítnut', async () => {
  const { h } = handler();
  const r = await h(req('POST', '/api/clb',
    { body: { typ: 'udalost', cas: new Date().toISOString() }, cookies: cookie(Date.now() - 1000) }));
  assert.equal(r.status, 401);
});

test('událost se zapíše parametrizovaně', async () => {
  const { h, provedene } = handler();
  const r = await h(req('POST', '/api/clb', {
    cookies: cookie(),
    body: { typ: 'udalost', cas: '2026-09-22T09:04:07.000Z', kameraId: 'tapoc2020',
            kameraNazev: "Vchod 'hlavní'", druh: 'fall', zavaznost: 'varovani',
            popis: 'MOŽNÝ PÁD', odZacatkuS: 95 },
  }));
  assert.equal(r.status, 200);
  assert.equal(provedene.length, 1);
  const { text, params } = provedene[0];
  assert.match(text, /INSERT INTO dbo\.FamicuraRingLog/);
  assert.equal(params.kameraNazev, "Vchod 'hlavní'", 'hodnota jde beze změny, escapovat není co');
  assert.ok(params.cas instanceof Date);
  assert.equal(params.odZacatkuS, 95);
});

test('nahrávka se zapíše do své tabulky i s odkazem na soubor', async () => {
  const { h, provedene } = handler();
  const r = await h(req('POST', '/api/clb', {
    cookies: cookie(),
    body: { typ: 'nahravka', od: '2026-09-22T09:04:07.000Z', do: '2026-09-22T09:14:07.000Z',
            kameraNazev: 'Zahrada', velikostB: 26214400, soubor: 'famicura-Zahrada.mp4',
            slozka: 'Famicura-Camera', zdroj: 'plan' },
  }));
  assert.equal(r.status, 200);
  const { text, params } = provedene[0];
  assert.match(text, /INSERT INTO dbo\.FamicuraRingNahravky/);
  assert.equal(params.slozka, 'Famicura-Camera');
  assert.equal(params.velikostB, 26214400);
});

test('pokus o injekci je jen hodnota, dotaz se nemění', async () => {
  const { h, provedene } = handler();
  const utok = "x'); DROP TABLE dbo.FamicuraRingLog; --";
  await h(req('POST', '/api/clb', {
    cookies: cookie(),
    body: { typ: 'udalost', cas: new Date().toISOString(), popis: utok },
  }));
  const { text, params } = provedene[0];
  assert.equal(params.popis, utok, 'text se ukládá tak, jak přišel');
  assert.ok(!text.includes('DROP'), 'do dotazu se nedostane');
  assert.equal((text.match(/INSERT INTO/g) || []).length, 1);
});

test('neznámý typ a nesmyslné tělo se odmítnou bez zápisu', async () => {
  const { h, provedene } = handler();
  assert.equal((await h(req('POST', '/api/clb', { cookies: cookie(), body: { typ: 'neco' } }))).status, 400);
  assert.equal((await h(req('POST', '/api/clb', { cookies: cookie(), body: { typ: 'udalost' } }))).status, 400);
  assert.equal((await h(req('POST', '/api/clb', { cookies: cookie(), body: { typ: 'nahravka' } }))).status, 400);
  assert.equal(provedene.length, 0);
});

test('diagnostika vrací počty řádků', async () => {
  const { h } = handler({ radky: { log: 12, nahravky: 4 } });
  const r = await h(req('GET', '/api/diag', { cookies: cookie() }));
  const b = await r.json();
  assert.equal(b.log, 12);
  assert.equal(b.nahravky, 4);
});

test('neznámá adresa je 404 a řekne, kdo odpověděl; bez přihlášení jen 401', async () => {
  const { h } = handler();
  assert.equal((await h(req('GET', '/api/neco'))).status, 401);
  const r = await h(req('GET', '/api/neco', { cookies: cookie() }));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).aplikace, 'famicura-tapo');
});

/* ---------- přihlášení ---------- */

test('správné heslo vydá cookie, se kterou API pustí dál', async () => {
  const { h } = handler();
  const r = await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' } }));
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /^fam_tapo=\d+\.admin\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const c = set.split(';')[0];
  assert.equal((await h(req('GET', '/api/devices', { cookies: c }))).status, 200);
});

test('špatné heslo cookie nevydá', async () => {
  const { h } = handler();
  const r = await h(req('POST', '/api/login', { body: { password: 'spatne' } }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('bez nastaveného hesla se nepřihlásí nikdo, ani prázdným heslem', async () => {
  const saved = process.env.FAMICURA_PASSWORD;
  process.env.FAMICURA_PASSWORD = '';
  try {
    const { h } = handler();
    assert.equal((await h(req('POST', '/api/login', { body: { password: '' } }))).status, 401);
    const s = await (await h(req('GET', '/api/status'))).json();
    assert.deepEqual(s.missing, ['FAMICURA_PASSWORD']);
  } finally { process.env.FAMICURA_PASSWORD = saved; }
});

test('po deseti chybách z jedné adresy se na chvíli nedá zkoušet, jiná adresa může', async () => {
  let t = 1_000_000;
  const { h } = handler({ limiter: createLimiter({ now: () => t }) });
  for (let i = 0; i < 10; i++) await h(req('POST', '/api/login', { body: { password: 'x' }, ip: '1.2.3.4' }));
  const blocked = await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' }, ip: '1.2.3.4' }));
  assert.equal(blocked.status, 429, 'ani správné heslo během blokace');
  assert.equal((await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' }, ip: '5.6.7.8' }))).status, 200);
  t += 15 * 60 * 1000;
  assert.equal((await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' }, ip: '1.2.3.4' }))).status, 200);
});

test('celkový strop: ani zkoušení z mnoha adres najednou neobejde limit', async () => {
  let t = 1_000_000;
  const { h } = handler({ limiter: createLimiter({ now: () => t }) });
  for (let i = 0; i < 50; i++) {
    const r = await h(req('POST', '/api/login', { body: { password: 'x' }, ip: `10.0.0.${i}` }));
    assert.equal(r.status, 401, `pokus ${i}`);
  }
  const r = await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' }, ip: '9.9.9.9' }));
  assert.equal(r.status, 429, 'po 50 chybách celkem se zavře i pro ostatní');
  t += 15 * 60 * 1000;
  assert.equal((await h(req('POST', '/api/login', { body: { password: 'spravne-heslo' }, ip: '9.9.9.9' }))).status, 200);
});

/* ---------- kamery a stream ---------- */

test('stav bez přihlášení neprozradí kamery', async () => {
  const { h } = handler();
  const b = await (await h(req('GET', '/api/status'))).json();
  assert.equal(b.authenticated, false);
  assert.equal(b.cameras, undefined);
});

test('stav po přihlášení: go2rtc, kamery a zda odpovídají', async () => {
  process.env.CAMERA_NAMES = 'tapoc2020=Pokoj 12';
  try {
    const { h } = handler({ go2rtc: fakeGo2rtc({ online: false }) });
    const b = await (await h(req('GET', '/api/status', { cookies: cookieServer() }))).json();
    assert.equal(b.go2rtc.ok, true);
    assert.equal(b.go2rtc.version, '1.9.14');
    assert.deepEqual(b.cameras, [{ id: 'tapoc2020', name: 'Pokoj 12', tenant: T, events: [], online: false, detail: 'dial tcp: i/o timeout',
      eventsOk: null, eventsError: null, eventsLast: null, eventsRejected: null, clbError: null, eventsOther: [] }]);
  } finally { delete process.env.CAMERA_NAMES; }
});

test('seznam kamer bere názvy z CAMERA_NAMES, jinak ID', async () => {
  process.env.CAMERA_NAMES = 'tapoc2020=Pokoj 12 – okno; x=y';
  try {
    const { h } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha', 'cizi'] }) });
    const vse = await (await h(req('GET', '/api/devices', { cookies: cookieServer() }))).json();
    assert.deepEqual(vse.devices, [{ id: 'tapoc2020', name: 'Pokoj 12 – okno', tenant: T, events: [] }, { id: 'druha', name: 'druha', tenant: '', events: [] }, { id: 'cizi', name: 'cizi', tenant: T2, events: [] }], 'správce serveru vidí všechny kamery');
    const b = await (await h(req('GET', '/api/devices', { cookies: cookie() }))).json();
    assert.deepEqual(b.devices.map((d) => d.id), ['tapoc2020'], 'dispečink tenanta jen své kamery (bez poskytovatele a cizí ne)');
    assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'cizi', sdpOffer: 'v=0' } }))).status, 404, 'cizí kamera jako by nebyla');
  } finally { delete process.env.CAMERA_NAMES; }
  assert.deepEqual(cameraNames('a=Jméno = s rovnítkem;;  b = B '), { a: 'Jméno = s rovnítkem', b: 'B' });
});

test('stream: offer jde do go2rtc, answer zpět ve tvaru, který čeká přehrávač', async () => {
  const { h, go2rtc } = handler();
  const r = await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020', sdpOffer: 'v=0 offer' } }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.sdpAnswer, 'v=0\r\nanswer-for-tapoc2020');
  assert.equal(b.sessionUrl, null);
  assert.deepEqual(go2rtc.calls, [{ src: 'tapoc2020', offer: 'v=0 offer' }]);
});

test('stream jen pro kameru, kterou go2rtc zná, a jen po přihlášení', async () => {
  const { h, go2rtc } = handler();
  assert.equal((await h(req('POST', '/api/stream', { body: { deviceId: 'tapoc2020', sdpOffer: 'x' } }))).status, 401);
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'cizi', sdpOffer: 'x' } }))).status, 404);
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: '../api/config', sdpOffer: 'x' } }))).status, 400);
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020' } }))).status, 400);
  assert.equal(go2rtc.calls.length, 0);
});

test('stream: chyba go2rtc se vrátí čitelně, i s tím, zda má smysl zkoušet znovu', async () => {
  const { Go2rtcError } = await import('../src/go2rtc.mjs');
  const { h } = handler({ go2rtc: fakeGo2rtc({ webrtc: () => { throw new Go2rtcError('Tento prohlížeč neumí obraz H.264 z kamery.', 502, 'no codecs', { retry: false }); } }) });
  const r = await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020', sdpOffer: 'x' } }));
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { ok: false, error: 'Tento prohlížeč neumí obraz H.264 z kamery.', detail: 'no codecs', retry: false });
});

/* ---------- plány a sledované události ---------- */

test('plán se uloží, přečte a prázdný smaže', async () => {
  const { h, store } = handler();
  const put = (intervals) => h(req('PUT', '/api/schedules', { cookies: cookie(), body: { deviceId: 'tapoc2020', intervals } }));
  assert.equal((await put([{ from: '22:00', to: '06:00' }])).status, 200);
  const b = await (await h(req('GET', '/api/schedules', { cookies: cookie() }))).json();
  assert.deepEqual(b.schedules, { tapoc2020: [{ from: '22:00', to: '06:00', enabled: true }] });
  assert.equal(b.max, 5);
  assert.equal((await put([{ from: '08:00', to: '' }])).status, 400);
  await put([]);
  assert.deepEqual(store.data.schedules, {});
});

test('sledované události: uloží se, výchozí nastavení se nedrží', async () => {
  const { h, store } = handler();
  const put = (watch) => h(req('PUT', '/api/watch', { cookies: cookie(), body: { deviceId: 'tapoc2020', watch } }));
  assert.equal((await put({ state: { enabled: false }, longlie: { after: 300 } })).status, 200);
  assert.equal(store.data.watch.tapoc2020.longlie.after, 300);
  assert.equal((await put({ longlie: { after: 7 } })).status, 400);
  await put(null);
  assert.deepEqual(store.data.watch, {});
});

test('příprava ořízne délky a řídicí znaky', () => {
  const p = pripravit({ typ: 'udalost', cas: new Date(), popis: 'a\u0000b'.padEnd(3000, 'x'), kameraNazev: 'y'.repeat(500) });
  assert.equal(p.params.popis.includes('\u0000'), false);
  assert.ok(p.params.popis.length <= 1000);
  assert.ok(p.params.kameraNazev.length <= 200);
});

test('prázdné hodnoty jsou NULL, ne prázdné řetězce', () => {
  const p = pripravit({ typ: 'udalost', cas: new Date(), kameraId: '', velikostB: '' });
  assert.equal(p.params.kameraId, null);
  assert.equal(p.params.odZacatkuS, null);
});

test('neplatné číslo neprojde jako text', () => {
  const p = pripravit({ typ: 'nahravka', od: new Date(), velikostB: '1; DROP TABLE x' });
  assert.equal(p.params.velikostB, null);
});

/* ---------- události, které hlásí kamera ---------- */

function fakeUdalosti() {
  const list = [
    { at: '2026-09-23T10:00:00.000Z', prijato: 1000, kameraId: 'tapoc2020', kameraNazev: 'Pokoj', kind: 'cam-motion', label: 'Pohyb', level: 'info', text: 'Kamera hlásí: pohyb.' },
    { at: '2026-09-23T10:00:05.000Z', prijato: 6000, kameraId: 'tapoc2020', kameraNazev: 'Pokoj', kind: 'cam-person', label: 'Osoba', level: 'info', text: 'Kamera hlásí: osoba.' },
  ];
  return {
    stav: () => ({ tapoc2020: { ok: true, error: null, events: [{ kind: 'cam-motion', label: null }, { kind: 'cam-person', label: null }], posledni: list[1], clbChyba: null } }),
    nedavne: (since) => list.filter((r) => r.prijato > since),
  };
}

test('kamery nesou, co umí hlásit; stav říká, zda odběr běží', async () => {
  const { h } = handler({ udalosti: fakeUdalosti() });
  const d = await (await h(req('GET', '/api/devices', { cookies: cookie() }))).json();
  assert.deepEqual(d.devices[0].events.map((e) => e.kind), ['cam-motion', 'cam-person']);
  const s = await (await h(req('GET', '/api/status', { cookies: cookie() }))).json();
  assert.equal(s.cameras[0].eventsOk, true);
  assert.equal(s.cameras[0].eventsLast.kind, 'cam-person');
  // Without a subscriber (no cameras.json) the page must not claim anything.
  const { h: h2 } = handler();
  const s2 = await (await h2(req('GET', '/api/status', { cookies: cookie() }))).json();
  assert.equal(s2.cameras[0].eventsOk, null);
  assert.deepEqual(s2.cameras[0].events, []);
});

test('události kamery: od daného času, jen po přihlášení', async () => {
  const { h } = handler({ udalosti: fakeUdalosti() });
  assert.equal((await h(req('GET', '/api/events'))).status, 401);
  const all = await (await h(req('GET', '/api/events', { cookies: cookie() }))).json();
  assert.equal(all.events.length, 2);
  assert.ok(all.cas > 0);
  const some = await (await h(req('GET', '/api/events?since=1000', { cookies: cookie() }))).json();
  assert.deepEqual(some.events.map((e) => e.kind), ['cam-person']);
  const none = await (await h(req('GET', '/api/events', { cookies: cookie() }))).json;
  assert.ok(none);
});

test('nastavení událostí kamery se ukládá spolu s analýzou', async () => {
  const { h, store } = handler();
  const put = (watch) => h(req('PUT', '/api/watch', { cookies: cookie(), body: { deviceId: 'tapoc2020', watch } }));
  assert.equal((await put({ 'cam-motion': { enabled: false }, fall: { enabled: true } })).status, 200);
  assert.deepEqual(store.data.watch.tapoc2020['cam-motion'], { enabled: false, from: '', to: '', record: false });
  assert.equal((await put({ 'cam-motion': { from: '22:00', to: '' } })).status, 400);
});

/* ---------- obraz přes HTTPS ---------- */

test('obraz přes HTTPS: jen známá kamera, jen obraz, díly HLS jen podle id', async () => {
  const proxied = [];
  const go2rtc = { ...fakeGo2rtc(), async proxy(p, { signal } = {}) { proxied.push({ p, signal: !!signal }); return new Response('x', { headers: { 'Content-Type': 'video/mp4' } }); } };
  const { h } = handler({ go2rtc });
  assert.equal((await h(req('GET', '/api/stream.mp4?deviceId=tapoc2020'))).status, 401);
  assert.equal((await h(req('GET', '/api/stream.mp4?deviceId=cizi', { cookies: cookie() }))).status, 404);
  assert.equal((await h(req('GET', '/api/stream.mp4?deviceId=../x', { cookies: cookie() }))).status, 400);
  const r = await h(req('GET', '/api/stream.mp4?deviceId=tapoc2020', { cookies: cookie() }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await h(req('GET', '/api/stream.m3u8?deviceId=tapoc2020', { cookies: cookie() }))).status, 200);
  assert.equal((await h(req('GET', '/api/hls/playlist.m3u8?id=Ab-9_x', { cookies: cookie() }))).status, 200);
  assert.equal((await h(req('GET', '/api/hls/segment.m4s?id=Ab-9_x&n=12', { cookies: cookie() }))).status, 200);
  assert.equal((await h(req('GET', '/api/hls/segment.m4s?id=Ab-9_x&n=x', { cookies: cookie() }))).status, 400);
  assert.equal((await h(req('GET', '/api/hls/../config?id=a', { cookies: cookie() }))).status, 404);
  assert.deepEqual(proxied.map((x) => x.p), [
    '/api/stream.mp4?src=tapoc2020&video=h264', '/api/stream.m3u8?src=tapoc2020&video=h264',
    '/api/hls/playlist.m3u8?id=Ab-9_x', '/api/hls/segment.m4s?id=Ab-9_x&n=12']);
});

/* ---------- rodina: pozvánka, aktivace, přihlášení, co smí ---------- */

const setCookie = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('rodina: poskytovatel založí uživatele, dostane odkaz a text SMS; bez SMS webhooku se SMS neodešle', async () => {
  const { h, tabulky } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha'] }), kameryTenanty: async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T, place: '' }, { id: 'druha', name: 'Druhá', tenant: T, place: '' }, { id: 'cizi', name: 'Cizí kamera', tenant: T2, place: '' }] });
  const r = await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'Petr Novák', telefon: '777 123 456', kamery: ['tapoc2020'], poslatSms: true } }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.odkaz, /^http:\/\/localhost\/r\/[A-Za-z0-9_-]{20,}$/, 'krátký odkaz pro SMS');
  assert.ok(b.text.includes(b.odkaz));
  assert.equal(b.sms.odeslano, false);
  assert.equal(b.smsNastaveno, false);
  assert.equal(b.uzivatel.aktivni, false);
  assert.ok(!JSON.stringify(tabulky.data).includes(b.odkaz.split('/r/')[1]), 'token v tabulce není, jen hash');
  assert.equal((await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'X', telefon: '777000999', kamery: ['cizi'] } }))).status, 403, 'účet k cizí kameře založit nejde');
  const list = await (await h(req('GET', '/api/rodina/uzivatele', { cookies: cookie() }))).json();
  assert.equal(list.uzivatele.length, 1);
  assert.equal(list.uzivatele[0].telefon, '777123456');
  // stejný telefon u druhé kamery: žádný nový účet ani pozvánka, kamera se přidá; DELETE s ?kamera= odebere jen ji
  const r2 = await (await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'Petr', telefon: '+420 777 123 456', kamery: ['druha'], poslatSms: true } }))).json();
  assert.equal(r2.pridano, true); assert.equal(r2.uzivatel.id, b.uzivatel.id); assert.deepEqual(r2.uzivatel.kamery, ['tapoc2020', 'druha']); assert.equal(r2.odkaz, undefined);
  assert.equal((await (await h(req('GET', '/api/rodina/uzivatele', { cookies: cookie() }))).json()).uzivatele.length, 1, 'pořád jeden účet');
  assert.equal((await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'Petr', telefon: '777123456', kamery: ['cizi'] } }))).status, 403, 'ani stávajícímu účtu nejde přidat cizí kamera');
  const d1 = await (await h(req('DELETE', `/api/rodina/uzivatele/${b.uzivatel.id}?kamera=druha`, { cookies: cookie() }))).json();
  assert.equal(d1.smazan, false); assert.deepEqual(d1.uzivatel.kamery, ['tapoc2020']);
  assert.equal((await h(req('DELETE', `/api/rodina/uzivatele/${b.uzivatel.id}?kamera=../x`, { cookies: cookie() }))).status, 400);
  // bez přihlášení ani s cookie rodiny tam nikdo nesmí
  assert.equal((await h(req('GET', '/api/rodina/uzivatele'))).status, 401);
});

test('rodina: SMS jde webhookem, když je nastavený; odkaz podle X-Forwarded-Host', async () => {
  const posl = [];
  const sms = { nastaveno: true, async posli(x) { posl.push(x); return { ok: true }; } };
  const { h } = handler({ sms });
  const r = new Request('http://localhost/api/rodina/uzivatele', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(),
    'x-forwarded-host': 'famicuratapo.example', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ jmeno: 'Jana', telefon: '+420 606 111 222', kamery: ['tapoc2020'], poslatSms: true }) });
  const b = await (await h(r)).json();
  assert.equal(b.sms.odeslano, true);
  assert.equal(posl.length, 1);
  assert.equal(posl[0].telefon, '606111222');
  assert.ok(posl[0].text.includes('https://famicuratapo.example/r/'), posl[0].text);
});

test('rodina: aktivace odkazem nastaví heslo a přihlásí; pak přihlášení telefonem a heslem; vidí jen své kamery', async () => {
  const { h, go2rtc } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha'] }) });
  const b = await (await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] } }))).json();
  const token = b.odkaz.split('/r/')[1];
  assert.deepEqual(await (await h(req('GET', `/api/rodina/pozvanka?token=${token}`))).json(), { ok: true, platna: true, jmeno: 'Petr', tenant: T });
  assert.equal((await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'kratke' } }))).status, 400);
  const a = await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'Famicura2026' } }));
  assert.equal(a.status, 200);
  const c = setCookie(a);
  assert.match(c, new RegExp(`^fam_tapo=\\d+\\.r:${T}:[a-f0-9]+\\.`), 'cookie rodiny nese tenanta');
  assert.equal((await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'Famicura2026' } }))).status, 410, 'odkaz je na jedno použití');
  assert.equal((await (await h(req('GET', `/api/rodina/pozvanka?token=${token}`))).json()).platna, false, 'stránka pozná použitý odkaz');

  const ja = await (await h(req('GET', '/api/rodina/ja', { cookies: c }))).json();
  assert.equal(ja.role, 'rodina');
  assert.equal(ja.jmeno, 'Petr');
  assert.deepEqual(ja.tenant, { id: T, nazev: 'FamiCura s.r.o.' });
  assert.deepEqual(ja.kamery.map((k) => k.id), ['tapoc2020']);
  const dev = await (await h(req('GET', '/api/devices', { cookies: c }))).json();
  assert.deepEqual(dev.devices.map((d) => d.id), ['tapoc2020'], 'cizí kamera v seznamu není');
  assert.equal((await h(req('POST', '/api/stream', { cookies: c, body: { deviceId: 'tapoc2020', sdpOffer: 'v=0' } }))).status, 200);
  assert.equal((await h(req('POST', '/api/stream', { cookies: c, body: { deviceId: 'druha', sdpOffer: 'v=0' } }))).status, 404, 'cizí kamera jako by nebyla');
  assert.equal(go2rtc.calls.length, 1);
  // nastavení je poskytovatele
  for (const [m, p] of [['GET', '/api/schedules'], ['GET', '/api/watch'], ['GET', '/api/diag'], ['GET', '/api/rodina/uzivatele'], ['POST', '/api/clb']]) {
    assert.equal((await h(req(m, p, { cookies: c, body: m === 'POST' ? {} : undefined }))).status, 403, `${m} ${p}`);
  }
  const st = await (await h(req('GET', '/api/status', { cookies: c }))).json();
  assert.equal(st.authenticated, false, 'hlavní aplikace rodinu nepustí do nastavení');

  // přihlášení telefonem
  assert.equal((await h(req('POST', '/api/rodina/login', { body: { telefon: '777 123 456', heslo: 'spatne-heslo' } }))).status, 401);
  const l = await h(req('POST', '/api/rodina/login', { body: { telefon: '+420 777 123 456', heslo: 'Famicura2026' } }));
  assert.equal(l.status, 200);
  const c2 = setCookie(l);
  // změna hesla
  assert.equal((await h(req('POST', '/api/rodina/heslo', { cookies: c2, body: { stare: 'spatne', nove: 'NoveHeslo99' } }))).status, 401);
  assert.equal((await h(req('POST', '/api/rodina/heslo', { cookies: c2, body: { stare: 'Famicura2026', nove: 'NoveHeslo99' } }))).status, 200);
  assert.equal((await h(req('POST', '/api/rodina/login', { body: { telefon: '777123456', heslo: 'NoveHeslo99' } }))).status, 200);
  // odhlášení
  assert.match(setCookie(await h(req('POST', '/api/rodina/odhlaseni'))), /^fam_tapo=$/);
});

test('rodina: události jen vlastní kamery; smazaný uživatel je hned odhlášen; nová pozvánka zruší heslo', async () => {
  const udalosti = { stav: () => ({}), nedavne: () => [{ kameraId: 'tapoc2020', kind: 'cam-motion' }, { kameraId: 'druha', kind: 'cam-motion' }] };
  const { h } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha'] }), udalosti });
  const b = await (await h(req('POST', '/api/rodina/uzivatele', { cookies: cookie(), body: { jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] } }))).json();
  const token = b.odkaz.split('/r/')[1];
  const c = setCookie(await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'Famicura2026' } })));
  const ev = await (await h(req('GET', '/api/events', { cookies: c }))).json();
  assert.deepEqual(ev.events.map((e) => e.kameraId), ['tapoc2020']);
  const adminEv = await (await h(req('GET', '/api/events', { cookies: cookie() }))).json();
  assert.deepEqual(adminEv.events.map((e) => e.kameraId), ['tapoc2020'], 'dispečink tenanta vidí jen události svých kamer');
  assert.equal((await (await h(req('GET', '/api/events', { cookies: cookieServer() }))).json()).events.length, 2, 'správce serveru všechny');

  const p = await (await h(req('POST', `/api/rodina/uzivatele/${b.uzivatel.id}/pozvanka`, { cookies: cookie(), body: {} }))).json();
  assert.ok(p.odkaz);
  assert.equal((await h(req('POST', '/api/rodina/login', { body: { telefon: '777123456', heslo: 'Famicura2026' } }))).status, 401, 'po nové pozvánce staré heslo neplatí');

  assert.equal((await h(req('DELETE', `/api/rodina/uzivatele/${b.uzivatel.id}`, { cookies: cookie() }))).status, 200);
  const po = await h(req('GET', '/api/rodina/ja', { cookies: c }));
  assert.equal(po.status, 401);
  assert.match(setCookie(po), /^fam_tapo=$/);
});

test('rodina: po deseti chybných přihlášeních z jedné adresy se čeká', async () => {
  const { h } = handler();
  for (let i = 0; i < 10; i++) await h(req('POST', '/api/rodina/login', { ip: '1.2.3.4', body: { telefon: '777123456', heslo: 'x' } }));
  assert.equal((await h(req('POST', '/api/rodina/login', { ip: '1.2.3.4', body: { telefon: '777123456', heslo: 'x' } }))).status, 429);
});

test('prototyp: stav na serveru vidí poskytovatel i rodina, bez přihlášení ne', async () => {
  const { h, uzivatele } = handler();
  assert.equal((await h(req('GET', '/api/proto/stav'))).status, 401);
  const r1 = await h(req('GET', '/api/proto/stav', { cookies: cookie() }));
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.zmena, true); assert.equal(b1.state.patients[0].id, 'tapoc2020');
  const same = await (await h(req('GET', `/api/proto/stav?v=${b1.v}`, { cookies: cookie() }))).json();
  assert.equal(same.zmena, false); assert.equal(same.state, undefined);

  // rodina na telefonu nastaví rozostření…
  const { token } = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const akt = await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'tajne-heslo-1' } }));
  const fam = akt.headers.get('set-cookie').split(';')[0];
  const r2 = await h(req('POST', '/api/proto/akce', { cookies: fam, body: { akce: 'setConsent', args: ['tapoc2020', { den: 'blur' }] } }));
  assert.equal(r2.status, 200);
  const b2 = await r2.json();
  assert.equal(b2.state.patients[0].consent.den, 'blur');
  assert.ok(b2.v > b1.v);
  // …a dispečink na jiném počítači to při dalším dotazu dostane
  const b3 = await (await h(req('GET', `/api/proto/stav?v=${b1.v}`, { cookies: cookie() }))).json();
  assert.equal(b3.zmena, true); assert.equal(b3.state.patients[0].consent.den, 'blur');
  assert.match(b3.state.events[0].text, /rozostření/);

  const bad = await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'emit', args: ['tapoc2020', 'neznámý'] } }));
  assert.equal(bad.status, 400);
  const bad2 = await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'reset' } }));
  assert.equal(bad2.status, 400);
});

test('asistent dispečinku: bez webhooku server řekne, že odpovídá prohlížeč; s webhookem vrátí odpověď AI; rodina nemá přístup', async () => {
  const { h, uzivatele } = handler();
  const r1 = await (await h(req('POST', '/api/proto/asistent', { cookies: cookie(), body: { dotaz: 'jak' } }))).json();
  assert.deepEqual(r1, { ok: true, nastaveno: false });
  const { h: h2 } = handler({ asistent: { nastaveno: true, async zeptej({ dotaz }) { return { ok: true, odpoved: 'AI: ' + dotaz }; } } });
  const r2 = await (await h2(req('POST', '/api/proto/asistent', { cookies: cookie(), body: { dotaz: 'jak', kontext: 'x' } }))).json();
  assert.equal(r2.odpoved, 'AI: jak');
  assert.equal((await h(req('POST', '/api/proto/asistent', { body: { dotaz: 'jak' } }))).status, 401);
  const { token } = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const akt = await h(req('POST', '/api/rodina/aktivace', { body: { token, heslo: 'tajne-heslo-1' } }));
  const fam = akt.headers.get('set-cookie').split(';')[0];
  assert.equal((await h(req('POST', '/api/proto/asistent', { cookies: fam, body: { dotaz: 'jak' } }))).status, 403);
});

test('žádost o plný obraz: rodině u kamery odejde SMS s výzvou k rozhodnutí; rodina sama SMS nespouští', async () => {
  const sms = { nastaveno: true, calls: [], async posli(x) { this.calls.push(x); return { ok: true }; } };
  const { h, uzivatele, vsichni } = handler({ sms });
  const a = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  await vsichni.aktivuj(a.token, 'tajne-heslo-1');
  const b = await uzivatele.vytvor({ jmeno: 'Jana', telefon: '777000111', kamery: ['tapoc2020'] });   // neaktivní: bez hesla, SMS nedostane
  await uzivatele.vytvor({ jmeno: 'Cizí', telefon: '777999888', kamery: ['jina'] });
  const cizi = await vsichni.pro(T2).vytvor({ jmeno: 'U jiného poskytovatele', telefon: '777555666', kamery: ['tapoc2020'] });
  await vsichni.aktivuj(cizi.token, 'tajne-heslo-2');
  const r = await (await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'requestFull', args: ['tapoc2020', 'Dispečerka Jana', 'ověření alertu'] } }))).json();
  assert.equal(r.vysledek.sms.prijemci, 1); assert.equal(r.vysledek.sms.odeslano, 1); assert.equal(r.vysledek.sms.chyba, null);
  assert.equal(sms.calls.length, 1); assert.equal(sms.calls[0].telefon, '777123456'); assert.equal(sms.calls[0].typ, 'FAMICURA_ZADOST');
  assert.match(sms.calls[0].text, /^Famicura: FamiCura s.r.o. zada o plny obraz \(overeni alertu\)\. Otevrete aplikaci a zadost povolte nebo odmitnete: http:\/\/localhost\/proto\/rodina\.html$/);
  assert.ok(sms.calls[0].text.length <= 160, 'jedna SMS');
  // bez nastavené SMS: žádost projde, dispečink se dozví proč SMS neodešla
  const { h: h2 } = handler({ tabulky: (await (async () => { const tb = createMockTabulky(); const u = createUzivatele(tb); const t = await u.pro(T).vytvor({ jmeno: 'P', telefon: '777123456', kamery: ['tapoc2020'] }); await u.aktivuj(t.token, 'tajne-heslo-1'); return tb; })()) });
  const r2 = await (await h2(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'requestFull', args: ['tapoc2020', 'D', 'x'] } }))).json();
  assert.equal(r2.vysledek.sms.odeslano, 0); assert.match(r2.vysledek.sms.chyba, /SMS_WEBHOOK_URL/);
  void b;
});

test('zkušební SMS z nastavení: jen poskytovatel, normalizuje telefon, hlásí nenastavený webhook i chybu scénáře', async () => {
  const sms = { nastaveno: true, calls: [], async posli(x) { this.calls.push(x); return x.telefon === '777000000' ? { ok: false, error: 'Scénář SMS hlásí chybu: Twilio' } : { ok: true, sid: 'SM1', status: 'queued' }; } };
  const { h, uzivatele } = handler({ sms });
  assert.equal((await h(req('GET', '/api/sms/test'))).status, 401);
  const st = await (await h(req('GET', '/api/sms/test', { cookies: cookie() }))).json();
  assert.equal(st.ok, true); assert.equal(st.nastaveno, true); assert.equal(st.stejnaJakoAsistent, false);
  // záměna adres při vps-env.sh: server to pozná a dispečink to ukáže
  process.env.SMS_WEBHOOK_URL = 'https://hook.eu2.make.com/stejna-adresa-xyz'; process.env.ASISTENT_WEBHOOK_URL = process.env.SMS_WEBHOOK_URL;
  const st2 = await (await h(req('GET', '/api/sms/test', { cookies: cookie() }))).json();
  assert.equal(st2.stejnaJakoAsistent, true); assert.equal(st2.adresa, 'https://hook.eu2.make.com/…sa-xyz');
  delete process.env.SMS_WEBHOOK_URL; delete process.env.ASISTENT_WEBHOOK_URL;
  const r = await h(req('POST', '/api/sms/test', { cookies: cookie(), body: { telefon: '+420 777 123 456' } }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.telefon, '777123456'); assert.equal(b.sid, 'SM1');
  assert.equal(sms.calls.length, 1); assert.equal(sms.calls[0].typ, 'FAMICURA_TEST'); assert.match(sms.calls[0].text, /^Famicura Kamera: zkusebni SMS/);
  const ch = await h(req('POST', '/api/sms/test', { cookies: cookie(), body: { telefon: '777000000' } }));
  assert.equal(ch.status, 502); assert.match((await ch.json()).error, /Twilio/);
  assert.equal((await h(req('POST', '/api/sms/test', { cookies: cookie(), body: { telefon: '12' } }))).status, 400);
  // zkušební e-mail stejnou cestou
  sms.posliMail = async (x) => { sms.calls.push(x); return { ok: true, sid: 'AAMk1' }; };
  const em = await (await h(req('POST', '/api/sms/test', { cookies: cookie(), body: { email: 'Rodina@Example.cz' } }))).json();
  assert.equal(em.ok, true); assert.equal(em.email, 'rodina@example.cz'); assert.equal(sms.calls.at(-1).typ, 'FAMICURA_TEST'); assert.match(sms.calls.at(-1).predmet, /zkušební e-mail/);
  // rodina na to nesmí
  const a = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const akt = await h(req('POST', '/api/rodina/aktivace', { body: { token: a.token, heslo: 'tajne-heslo-1' } }));
  const fam = akt.headers.get('set-cookie').split(';')[0];
  assert.equal((await h(req('POST', '/api/sms/test', { cookies: fam, body: { telefon: '777123456' } }))).status, 403);
  // bez webhooku: 400 a jasná hláška
  const { h: h2 } = handler();
  const n = await h2(req('POST', '/api/sms/test', { cookies: cookie(), body: { telefon: '777123456' } }));
  assert.equal(n.status, 400); assert.match((await n.json()).error, /vps-env\.sh/);
});

/** Nahrávky: falešný Disk (jhn-apps + Google) a go2rtc, který na stream.mp4 vrátí klip. */
function fakeDisk(stav = { google: { pripojen: true, email: 'posk@x.cz' }, slozka: { id: 's1', nazev: 'Famicura Kamera – FamiCura', url: 'https://drive/s1' } }) {
  const nahrane = [];
  return { nastaveno: true, nahrane, async stav() { return stav; },
    async zalozSlozku(t, nazev) { if (stav.slozka) { const e = new Error('Adresář už je zapojený – nejdřív ho odpojte'); e.status = 409; throw e; } stav.slozka = { id: 's2', nazev: nazev || 'Famicura Kamera – FamiCura', url: 'https://drive/s2' }; return { ...stav, zprava: 'založeno' }; },
    async odpojSlozku() { stav.slozka = null; return { ...stav, zprava: 'odpojeno' }; },
    async nahraj(tenant, { nazev, mime, data }) { nahrane.push({ tenant, nazev, mime, velikost: data.length }); return { id: 'f' + nahrane.length, nazev, url: 'https://drive/f' + nahrane.length, velikost: data.length, email: 'posk@x.cz', slozka: stav.slozka }; } };
}
test('nahrávky: stav účtu a adresář, ruční nahrávka ze serveru (jen při plném obrazu), soubor z hlavní aplikace, seznam; rodina 403, bez nastavení 503', async () => {
  const go2rtc = { ...fakeGo2rtc(), async proxy() { return new Response(Buffer.alloc(50 * 1024, 3), { status: 200 }); } };
  const disk = fakeDisk();
  const tabulky = createMockTabulky();
  const nahravky = createNahravky({ go2rtc, disk, tabulky, kamery: async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T }], log: { log() {}, error() {} } });
  const { h, uzivatele, vsichni } = handler({ go2rtc, disk, nahravky, tabulky });
  const st = await (await h(req('GET', '/api/nahravky/stav', { cookies: cookie() }))).json();
  assert.equal(st.nastaveno, true); assert.equal(st.google.email, 'posk@x.cz'); assert.equal(st.slozka.id, 's1'); assert.equal(st.delkaS, 15);
  // nový adresář jde založit až po odpojení zapojeného
  let r0 = await h(req('POST', '/api/nahravky/slozka', { cookies: cookie(), body: { nazev: 'Famicura Kamera – test' } }));
  assert.equal(r0.status, 409); assert.match((await r0.json()).error, /odpojte/);
  const od = await (await h(req('POST', '/api/nahravky/odpojit', { cookies: cookie(), body: {} }))).json();
  assert.equal(od.ok, true); assert.equal(od.slozka, null);
  const sl = await (await h(req('POST', '/api/nahravky/slozka', { cookies: cookie(), body: { nazev: 'Famicura Kamera – test' } }))).json();
  assert.equal(sl.slozka.id, 's2');
  // rodina povolila jen drátěný model → ruční nahrávka se pořídí v plném obrazu, ale uzamčená (poskytovatel ji nedostane, dokud ji rodina neodemkne)
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'skeleton', noc: 'skeleton', nouze: true }] } }));
  let r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 10 } }));
  assert.equal(r.status, 200, 'ruční nahrávka při drátěném modelu'); const nZ = (await r.json()).nahravka; assert.equal(nZ.zamek, true, 'uzamčená'); assert.equal(nZ.mime, 'video/mp4');
  assert.equal((await tabulky.vyber(T, 'A_KAM_Nahravka', { kde: { Id: nZ.id } }))[0].Zamek, 1);
  // žádný obraz → odmítnuto rovnou (403)
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'none', noc: 'none', nouze: false }] } }));
  r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 10 } }));
  assert.equal(r.status, 403, 'ruční nahrávka bez obrazu'); assert.match((await r.json()).error, /rodina povolila jen/);
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'full', noc: 'full', nouze: true }] } }));
  r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 10 } }));
  assert.equal(r.status, 200); const n1 = (await r.json()).nahravka; assert.equal(n1.url, 'https://drive/f2'); assert.equal(n1.zdroj, 'rucni'); assert.equal(n1.delkaS, 10);
  assert.equal((await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'cizi' } }))).status, 404, 'cizí kamera');
  // soubor z hlavní aplikace (správce bez tenanta: tenant podle kamery)
  const up = new Request('http://localhost/api/nahravky?kamera=tapoc2020&zdroj=plan&delkaS=30&text=Pl%C3%A1n', { method: 'POST', headers: { 'content-type': 'video/webm', cookie: cookieServer() }, body: Buffer.alloc(4096, 1) });
  r = await h(up); assert.equal(r.status, 200); const n2 = (await r.json()).nahravka; assert.match(n2.nazev, /\.webm$/); assert.equal(n2.zdroj, 'plan'); assert.equal(disk.nahrane[2].mime, 'video/webm');
  assert.equal((await h(new Request('http://localhost/api/nahravky?kamera=tapoc2020', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: cookie() }, body: 'x'.repeat(2000) }))).status, 415);
  const sez = await (await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: cookie() }))).json();
  assert.equal(sez.nahravky.length, 3, 'uzamčená + ruční + z hlavní aplikace'); assert.equal(sez.nahravky[0].id, n2.id);
  // událost s Nahrávat → nahrávka u události
  const ev = await (await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'emit', args: ['tapoc2020', 'fall'] } }))).json();
  await (await (await h(req('GET', '/api/health'))).json(), nahravky.hotovo());
  const stav = await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json();
  assert.equal(stav.state.events.find((e) => e.id === ev.vysledek.id).nahravka.url, 'https://drive/f4');
  // rodina: seznam jen svých kamer, nastavení a ruční nahrávka ne
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  const rs = await (await h(req('GET', '/api/nahravky', { cookies: rc }))).json();
  assert.equal(rs.ok, true); assert.ok(rs.nahravky.length >= 3 && rs.nahravky.every((x) => x.kameraId === 'tapoc2020'), 'rodina vidí nahrávky své kamery');
  // uzamčená nahrávka: poskytovatel i správce dostanou 423 (přehrání i stažení), rodina ji přehraje; odemknout smí jen rodina
  assert.equal((await h(req('GET', `/api/nahravky/${nZ.id}/soubor`, { cookies: cookie() }))).status, 423, 'poskytovatel: uzamčeno');
  assert.equal((await h(req('GET', `/api/nahravky/${nZ.id}/soubor?stahnout=1`, { cookies: cookie() }))).status, 423, 'poskytovatel: ani stažení');
  assert.equal((await h(req('GET', `/api/nahravky/${nZ.id}/soubor`, { cookies: rc }))).status, 302, 'rodina uzamčenou nahrávku přehraje (z Disku přesměrováním)');
  assert.equal((await h(req('POST', `/api/nahravky/${nZ.id}/odemknout`, { cookies: cookie(), body: {} }))).status, 403, 'poskytovatel si ji neodemkne');
  const odem = await (await h(req('POST', `/api/nahravky/${nZ.id}/odemknout`, { cookies: rc, body: {} }))).json();
  assert.equal(odem.ok, true); assert.equal(odem.zmena, true); assert.equal(odem.nahravka.zamek, false); assert.equal(odem.nahravka.odemklKdo, 'Petr');
  assert.equal((await h(req('GET', `/api/nahravky/${nZ.id}/soubor`, { cookies: cookie() }))).status, 302, 'po odemknutí poskytovatel přehraje');
  const sez2 = await (await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: cookie() }))).json();
  const nZ2 = sez2.nahravky.find((x) => x.id === nZ.id); assert.equal(nZ2.zamek, false); assert.equal(nZ2.odemklKdo, 'Petr'); assert.ok(nZ2.odemklCas > 0);
  const hist = (await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json()).state.events;
  assert.ok(hist.some((e) => e.kind === 'consent' && /Rodina \(Petr\) odemkla poskytovateli nahrávku/.test(e.text)), 'odemknutí je v historii');
  assert.equal((await (await h(req('POST', `/api/nahravky/${nZ.id}/odemknout`, { cookies: rc, body: {} }))).json()).zmena, false, 'podruhé beze změny');
  assert.equal((await h(req('GET', '/api/nahravky?kamera=cizi', { cookies: rc }))).status, 404);
  assert.equal((await h(req('GET', '/api/nahravky/stav', { cookies: rc }))).status, 403, 'nastavení nahrávek jen poskytovatel');
  assert.equal((await h(req('POST', '/api/nahravky/slozka', { cookies: rc, body: {} }))).status, 403, 'rodina adresář nezakládá (ruční nahrávku u své kamery smí – test níže)');
  // bez nastavení
  const { h: h2 } = handler();
  assert.equal((await (await h2(req('GET', '/api/nahravky/stav', { cookies: cookie() }))).json()).nastaveno, false);
  assert.equal((await h2(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020' } }))).status, 503, 'bez nastavení 503');
});

test('úložiště na serveru: nahrávka z prohlížeče zůstane šifrovaně na VPS, přehrání s auditem a Range, rodina jen své kamery, smazání, bez Disku', async () => {
  const go2rtc = { ...fakeGo2rtc(), async proxy() { return new Response(Buffer.alloc(30 * 1024, 5), { status: 200 }); } };
  const tabulky = createMockTabulky();
  const uloziste = createUloziste({ dir: mkdtempSync(path.join(os.tmpdir(), 'fkn-')), klic: Buffer.alloc(32, 9) });
  const clb = [];
  const nahravky = createNahravky({ go2rtc, disk: null, uloziste, tabulky, kamery: async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T }], zapisClb: async (r) => { clb.push(r); return { ok: true }; }, log: { log() {}, error() {} } });
  const { h, uzivatele, vsichni } = handler({ go2rtc, disk: null, nahravky, tabulky });
  const st = await (await h(req('GET', '/api/nahravky/stav', { cookies: cookie() }))).json();
  assert.equal(st.nastaveno, true); assert.deepEqual(st.uloziste, { server: true, disk: false }); assert.equal(st.volba, 'server'); assert.equal(st.dny, 30);
  // soubor z hlavní aplikace (rozostřený zůstane rozostřený – server ho jen uloží)
  const obsah = Buffer.from('x'.repeat(5000));
  const up = new Request('http://localhost/api/nahravky?kamera=tapoc2020&zdroj=udalost&delkaS=15&text=Pad', { method: 'POST', headers: { 'content-type': 'video/webm', cookie: cookie() }, body: obsah });
  let r = await h(up); assert.equal(r.status, 200); const n1 = (await r.json()).nahravka;
  assert.equal(n1.uloziste, 'server'); assert.equal(n1.url, null); assert.match(n1.soubor, new RegExp('^' + T + '/n[a-z0-9]+\\.enc$'));
  assert.equal(clb.length, 1); assert.equal(clb[0].typ, 'nahravka'); assert.equal(clb[0].slozka, 'server:' + T); assert.equal(clb[0].zdroj, 'udalost');
  // přehrání celé i po částech (Range), audit jen jednou na začátek
  r = await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor', { headers: { cookie: cookie() } }));
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'video/webm'); assert.equal(Buffer.from(await r.arrayBuffer()).equals(obsah), true, 'dešifrovaný obsah sedí');
  r = await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor', { headers: { cookie: cookie(), range: 'bytes=100-199' } }));
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 100-199/5000'); assert.equal((await r.arrayBuffer()).byteLength, 100);
  r = await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor', { headers: { cookie: cookie(), range: 'bytes=0-' } }));
  assert.equal(r.status, 206);
  const au = await (await h(req('GET', '/api/nahravky/' + n1.id + '/audit', { cookies: cookie() }))).json();
  assert.equal(au.prehrani.length, 2, 'audit: dvě přehrání (celé a od začátku), Range uprostřed se nepočítá'); assert.equal(au.prehrani[0].kdo, 'Správce');
  // rodina: své přehraje (do auditu jménem), cizí ne; audit nevidí
  const u = await uzivatele.vytvor({ jmeno: 'Petr Novák', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  // stažení celého souboru: příloha s názvem nahrávky, v auditu jako stažení; rodina nesmí
  r = await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor?stahnout=1', { headers: { cookie: cookie() } }));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /^attachment; filename="[A-Za-z0-9._-]+\.(mp4|webm)"$/); assert.equal((await r.arrayBuffer()).byteLength, 5000, 'celý soubor z prohlížeče');
  assert.equal((await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor?stahnout=1', { headers: { cookie: rc } }))).status, 403, 'rodina nestahuje');
  const auS = await (await h(req('GET', '/api/nahravky/' + n1.id + '/audit', { cookies: cookie() }))).json();
  assert.equal(auS.prehrani.filter((p) => /\(stažení\)$/.test(p.kdo)).length, 1, 'stažení v auditu');
  r = await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor', { headers: { cookie: rc } }));
  assert.equal(r.status, 200);
  assert.equal((await h(req('GET', '/api/nahravky/' + n1.id + '/audit', { cookies: rc }))).status, 403);
  const au2 = await (await h(req('GET', '/api/nahravky/' + n1.id + '/audit', { cookies: cookie() }))).json();
  assert.equal(au2.prehrani[0].kdo, 'Petr Novák'); assert.equal(au2.prehrani[0].role, 'rodina');
  // ruční nahrávka ze serveru jde také na server (go2rtc klip)
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'full', noc: 'full', nouze: true }] } }));
  r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 5 } }));
  assert.equal(r.status, 200); const n2 = (await r.json()).nahravka; assert.equal(n2.uloziste, 'server'); assert.equal(n2.velikost, 30 * 1024);
  // smazání poskytovatelem: soubor pryč, řádek označený, přehrání 410, v seznamu už není
  assert.equal((await h(req('DELETE', '/api/nahravky/' + n2.id, { cookies: cookie() }))).status, 200);
  assert.equal((await h(new Request('http://localhost/api/nahravky/' + n2.id + '/soubor', { headers: { cookie: cookie() } }))).status, 410);
  const sez = await (await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: cookie() }))).json();
  assert.deepEqual(sez.nahravky.map((x) => x.id), [n1.id]);
  assert.equal((await h(req('DELETE', '/api/nahravky/' + n1.id, { cookies: rc }))).status, 403, 'rodina nemaže');
  // automatické mazání po době uchování
  await tabulky.ulozit(T, 'A_KAM_Nastaveni', { Klic: 'poskytovatel.nahravkyDny', Hodnota: '1' });
  assert.equal(await nahravky.promaz(), 0, 'čerstvá nahrávka zůstává');
  await tabulky.uprav(T, 'A_KAM_Nahravka', { Id: n1.id }, { Cas: Date.now() - 2 * 86400000 });
  assert.equal(await nahravky.promaz(), 1, 'starší než 1 den se smaže');
  assert.equal((await h(new Request('http://localhost/api/nahravky/' + n1.id + '/soubor', { headers: { cookie: cookie() } }))).status, 410);
});

test('otočení kamery: kdo kameru smí vidět, smí ji otočit (rodina jen svou); směry; bez PTZ 503', async () => {
  const pohyby = [];
  const ptz = { async pohni(id, smer, o) { pohyby.push({ id, smer, o }); if (smer === 'zoom') { const e = new Error('Směr: left…'); e.status = 400; throw e; } return { ok: true }; } };
  const { h, uzivatele, vsichni } = handler({ ptz });
  assert.equal((await h(req('POST', '/api/ptz', { cookies: cookie(), body: { kamera: 'tapoc2020', smer: 'left' } }))).status, 200);
  assert.deepEqual(pohyby[0], { id: 'tapoc2020', smer: 'left', o: { rychlost: 0.5, ms: 400 } });
  assert.equal((await h(req('POST', '/api/ptz', { cookies: cookie(), body: { kamera: 'cizi', smer: 'left' } }))).status, 404, 'kamera jiného tenanta');
  assert.equal((await h(req('POST', '/api/ptz', { cookies: cookie(), body: { kamera: 'tapoc2020', smer: 'zoom' } }))).status, 400);
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  assert.equal((await h(req('POST', '/api/ptz', { cookies: rc, body: { kamera: 'tapoc2020', smer: 'home' } }))).status, 200, 'rodina svou kameru otočí');
  assert.equal(pohyby.length, 3);
  assert.equal((await h(req('POST', '/api/ptz', { cookies: rc, body: { kamera: 'cizi', smer: 'home' } }))).status, 404);
  const { h: h2 } = handler();
  assert.equal((await h2(req('POST', '/api/ptz', { cookies: cookie(), body: { kamera: 'tapoc2020', smer: 'up' } }))).status, 503);
});

test('log událostí za období: JSON pro stránku a sešit Excelu; rodina nemá; špatné datum 400', async () => {
  const { h, uzivatele, vsichni } = handler();
  // pád místo překročení čáry: čára se hlídá jen 07:00–20:00, test musí projít v kteroukoli hodinu
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'emit', args: ['tapoc2020', 'fall'] } }));
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'poznamka', args: ['tapoc2020', 'Volala dcera.', 'Dispečerka Jana'] } }));
  const dnes = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
  let r = await h(req('GET', `/api/udalosti?od=${dnes}&do=${dnes}&kamera=tapoc2020`, { cookies: cookie() }));
  assert.equal(r.status, 200); const j = await r.json();
  assert.ok(j.udalosti.length >= 2); assert.equal(j.udalosti[0].kamera, 'TAPO Test'); assert.ok(j.udalosti.some((u) => u.druh === 'Možný pád') && j.udalosti.some((u) => u.druh === 'poznámka' && u.text === 'Volala dcera.'));
  assert.equal(j.udalosti[0].datum, new Date().toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric' }));
  // mimo období nic; bez období vše
  assert.equal((await (await h(req('GET', '/api/udalosti?od=2000-01-01&do=2000-01-02', { cookies: cookie() }))).json()).udalosti.length, 0);
  assert.ok((await (await h(req('GET', '/api/udalosti', { cookies: cookie() }))).json()).udalosti.length >= 2, 'všechny kamery, celá historie');
  // Excel
  r = await h(req('GET', `/api/udalosti?od=${dnes}&format=xlsx&kamera=tapoc2020`, { cookies: cookie() }));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /spreadsheetml/); assert.match(r.headers.get('content-disposition'), /attachment; filename="famicura-log_TAPO-Test_\d{4}-\d{2}-\d{2}_dnes\.xlsx"/);
  const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.slice(0, 2).toString(), 'PK'); assert.ok(b.length > 1500);
  assert.equal((await h(req('GET', '/api/udalosti?od=4.10.2026', { cookies: cookie() }))).status, 400);
  assert.equal((await h(req('GET', '/api/udalosti?od=2026-10-05&do=2026-10-04', { cookies: cookie() }))).status, 400);
  assert.equal((await h(req('GET', '/api/udalosti?kamera=cizi', { cookies: cookie() }))).status, 404, 'kamera jiného tenanta');
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  assert.equal((await h(req('GET', '/api/udalosti', { cookies: cookieRodina(T, rod.id).split(';')[0] }))).status, 403, 'rodina log nestahuje');
});

test('ruční nahrávka z aplikace rodiny: jen svá kamera, jméno rodiny u řádku', async () => {
  const go2rtc = { async proxy() { return new Response(Buffer.alloc(20 * 1024, 2), { status: 200 }); } };
  const tabulky = createMockTabulky();
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(t, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const { createNahravky } = await import('../src/nahravky.mjs');
  const nahravky = createNahravky({ go2rtc, uloziste, tabulky, kamery: async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T }, { id: 'cizi', name: 'Cizí', tenant: T2 }], log: { log() {}, error() {} } });
  const { h, uzivatele, vsichni } = handler({ nahravky, tabulky, go2rtc });
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'full', noc: 'full', nouze: true }] } }));
  const u = await uzivatele.vytvor({ jmeno: 'Petr Novák', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  let r = await h(req('POST', '/api/nahravky/rucni', { cookies: rc, body: { kamera: 'tapoc2020' } }));
  assert.equal(r.status, 200); const n = (await r.json()).nahravka; assert.equal(n.zdroj, 'rucni'); assert.equal(n.kdo, 'Petr Novák'); assert.equal(n.uloziste, 'server');
  assert.equal((await h(req('POST', '/api/nahravky/rucni', { cookies: rc, body: { kamera: 'cizi' } }))).status, 404, 'cizí kamera');
  const sez = await (await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: rc }))).json();
  assert.equal(sez.nahravky[0].id, n.id, 'rodina ji vidí ve svém seznamu');
  // řádek v historii (druh „nahravka“ z KINDS) jde zapsat akcí emit
  r = await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'emit', args: ['tapoc2020', 'nahravka', { text: 'Rodina pořídila ruční nahrávku 15 s (na serveru).' }] } }));
  assert.equal(r.status, 200); const st = (await r.json()).state; assert.equal(st.events[0].kind, 'nahravka'); assert.equal(st.events[0].state, 'uzavřen');
});

test('deaktivace kamery rodinou: jen rodina, obraz 423 všem, otáčení 423, ruční nahrávka 403, kamera do stropu a zpět, výsledek otočení u stavu', async () => {
  const pohyby = [];
  // kamera hlásí polohu (0.1, 0.2): server si ji před otočením do stropu uloží a po aktivaci kameru vrátí na ni
  const ptz = { async poloha() { return { x: 0.1, y: 0.2 }; }, async pohni(kamera, smer, o = {}) { pohyby.push([kamera, smer, o.poloha || null]); if (smer === 'strop' && pohyby.length > 2) throw Object.assign(new Error('Otočení se nepodařilo: kamera neodpověděla'), { status: 502 }); return { ok: true }; } };
  const go2rtc = { ...fakeGo2rtc(), async proxy() { return new Response(Buffer.alloc(20 * 1024, 2), { status: 200 }); } };
  const tabulky = createMockTabulky();
  const uloziste = { nastaveno: true, dir: '/tmp', async uloz(t, id, data) { return { soubor: id + '.enc', velikost: data.length }; }, async nacti() { return Buffer.alloc(0); }, async smaz() {} };
  const { createNahravky } = await import('../src/nahravky.mjs');
  const nahravky = createNahravky({ go2rtc, uloziste, tabulky, kamery: async () => [{ id: 'tapoc2020', name: 'TAPO Test', tenant: T }], log: { log() {}, error() {} } });
  const { h, uzivatele, vsichni } = handler({ nahravky, tabulky, go2rtc, ptz });
  const u = await uzivatele.vytvor({ jmeno: 'Petr Novák', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  const cekej = async () => { for (let i = 0; i < 20 && !pohyby.length; i++) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 20)); };
  // dispečink deaktivovat nesmí
  assert.equal((await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'deaktivace', args: ['tapoc2020', true, 'Dispečer'] } }))).status, 403);
  // rodina ano; jméno dosadí server; kamera jede do stropu a výsledek je u stavu
  let r = await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'deaktivace', args: ['tapoc2020', true, 'Podvrh'] } }));
  assert.equal(r.status, 200); let st = (await r.json()).state;
  assert.ok(st.patients[0].deaktivace); assert.equal(st.patients[0].deaktivace.kdo, 'Petr Novák');
  assert.match(st.events[0].text, /Rodina \(Petr Novák\) deaktivovala kameru/);
  await cekej();
  assert.deepEqual(pohyby, [['tapoc2020', 'strop', null]]);
  st = (await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json()).state;
  assert.equal(st.patients[0].deaktivace.otoceni, 'ok');
  assert.deepEqual(st.patients[0].deaktivace.poloha, { x: 0.1, y: 0.2 }, 'poloha před otočením do stropu je u stavu');
  // obraz nedostane nikdo – dispečink ani rodina, WebRTC ani HTTPS; otáčení nejde; ruční nahrávka ne
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020', sdpOffer: 'v=0' } }))).status, 423);
  assert.equal((await h(req('POST', '/api/stream', { cookies: rc, body: { deviceId: 'tapoc2020', sdpOffer: 'v=0' } }))).status, 423);
  assert.equal((await h(req('GET', '/api/stream.mp4?deviceId=tapoc2020', { cookies: cookie() }))).status, 423);
  assert.equal((await h(req('POST', '/api/ptz', { cookies: cookie(), body: { kamera: 'tapoc2020', smer: 'left' } }))).status, 423);
  assert.equal((await h(req('POST', '/api/ptz', { cookies: rc, body: { kamera: 'tapoc2020', smer: 'strop' } }))).status, 400, 'strop jen server');
  r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020' } }));
  assert.equal(r.status, 403); assert.match((await r.json()).error, /deaktivovaná rodinou/);
  // událost z kamery se nezapíše
  r = await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'emit', args: ['tapoc2020', 'fall', { real: true }] } }));
  assert.equal((await r.json()).vysledek, null);
  // podruhé deaktivovat = beze změny, kamera se znovu neotáčí
  await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'deaktivace', args: ['tapoc2020', true] } }));
  await new Promise((res) => setTimeout(res, 30)); assert.equal(pohyby.length, 1);
  // aktivace: zpět do výchozí polohy, obraz zase jde
  pohyby.length = 0;
  r = await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'deaktivace', args: ['tapoc2020', false] } }));
  st = (await r.json()).state; assert.equal(st.patients[0].deaktivace, undefined); assert.match(st.events[0].text, /aktivovala kameru.*vrací na původní záběr/);
  await cekej(); assert.deepEqual(pohyby, [['tapoc2020', 'home', { x: 0.1, y: 0.2 }]], 'zpět na uloženou polohu');
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020', sdpOffer: 'v=0' } }))).status, 200);
  // otočení selže: deaktivace platí dál, u stavu je chyba a v historii řádek
  pohyby.length = 0; pohyby.push(null, null);
  await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'deaktivace', args: ['tapoc2020', true] } }));
  await new Promise((res) => setTimeout(res, 60));
  st = (await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json()).state;
  assert.match(st.patients[0].deaktivace.otoceni, /^chyba: .*kamera neodpověděla/);
  assert.match(st.events[0].text, /nepodařilo otočit do stropu/);
  assert.equal((await h(req('POST', '/api/stream', { cookies: cookie(), body: { deviceId: 'tapoc2020', sdpOffer: 'v=0' } }))).status, 423);
});

test('rodina vidí jen kamery svého poskytovatele: kamera přiřazená jinému poskytovateli zmizí i z účtu rodiny a stránka dostane zprávu místo zamrznutí', async () => {
  const { h, uzivatele, vsichni } = handler();
  // účet s kamerou tenanta i s kamerou, která už patří jinému tenantovi (po vps-kamera.sh tenant …)
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777000111', kamery: ['cizi', 'tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  let ja = await (await h(req('GET', '/api/rodina/ja', { cookies: rc }))).json();
  assert.deepEqual(ja.kamery.map((k) => k.id), ['tapoc2020'], 'cizí kamera v účtu rodiny není vidět');
  assert.equal(ja.zprava, '');
  assert.equal((await h(req('POST', '/api/stream', { cookies: rc, body: { deviceId: 'cizi', sdpOffer: 'v=0' } }))).status, 404);
  // účet jen s kamerou, která se přesunula jinam: prázdný seznam a srozumitelná zpráva
  const u2 = await uzivatele.vytvor({ jmeno: 'Eva', telefon: '777000222', kamery: ['cizi'] });
  const rod2 = await vsichni.aktivuj(u2.token, 'rodina-heslo-2');
  const rc2 = cookieRodina(T, rod2.id).split(';')[0];
  ja = await (await h(req('GET', '/api/rodina/ja', { cookies: rc2 }))).json();
  assert.deepEqual(ja.kamery, []);
  assert.match(ja.zprava, /už u tohoto poskytovatele není/);
  // akce na tu kameru server odmítne jako neznámou kameru (stránka ukáže chybu, nepřepne se do simulace)
  assert.equal((await h(req('POST', '/api/proto/akce', { cookies: rc2, body: { akce: 'deaktivace', args: ['cizi', true] } }))).status, 404);
});

test('náramek přes API: příkaz posílá jen poskytovatel, nepřiřazený náramek 400, vypnutí jde do historie, rodina 403', async () => {
  const posl = [];
  const naramky = { stav() { return { port: 5093 }; }, async prikaz(id, nazev, { vlastni } = {}) { posl.push([id, nazev, vlastni || '']); if (nazev === 'tep') return { ok: true, obsah: 'hrtstart,1' }; if (nazev === 'vypnout') return { ok: true, obsah: 'POWEROFF' }; const e = new Error('Neznámý příkaz náramku'); e.status = 400; throw e; } };
  const { h, uzivatele, vsichni } = handler({ naramky });
  let r = await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'tapoc2020', prikaz: 'tep' } }));
  assert.equal(r.status, 400); assert.match((await r.json()).error, /není přiřazen náramek/);
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setNaramek', args: ['tapoc2020', '9705357211', 'Dispečer'] } }));
  r = await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'tapoc2020', prikaz: 'tep' } }));
  assert.equal(r.status, 200); assert.equal((await r.json()).obsah, 'hrtstart,1');
  assert.deepEqual(posl[0], ['9705357211', 'tep', '']);
  // vypnutí jen na heslo hlavní aplikace: bez hesla a se špatným 401 (nic se neposlalo), se správným 200
  r = await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'tapoc2020', prikaz: 'vypnout' } }));
  assert.equal(r.status, 401); assert.match((await r.json()).error, /heslo hlavní aplikace/);
  r = await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'tapoc2020', prikaz: 'vypnout', heslo: 'spatne' } }));
  assert.equal(r.status, 401); assert.ok(!posl.some(([, n]) => n === 'vypnout'), 'bez správného hesla se POWEROFF neposílá');
  r = await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'tapoc2020', prikaz: 'vypnout', heslo: 'spravne-heslo' } }));
  assert.equal(r.status, 200);
  const st = (await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json()).state;
  assert.match(st.events[0].text, /poslán příkaz POWEROFF/);
  assert.equal((await h(req('POST', '/api/naramek/prikaz', { cookies: cookie(), body: { kamera: 'cizi', prikaz: 'tep' } }))).status, 404);
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777000333', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  const rc = cookieRodina(T, rod.id).split(';')[0];
  assert.equal((await h(req('POST', '/api/naramek/prikaz', { cookies: rc, body: { kamera: 'tapoc2020', prikaz: 'tep' } }))).status, 403);
  assert.equal((await h(req('POST', '/api/proto/akce', { cookies: rc, body: { akce: 'setNaramekAuto', args: ['tapoc2020', { min: 10, tep: true }] } }))).status, 403);
});

test('měření náramku přes API: seznam z A_KAM_Mereni nejnovější první, export do Excelu, rodina 403, cizí kamera 404', async () => {
  const tabulky = createMockTabulky();
  for (const [i, r] of [[1, { Tep: 70, TlakS: 120, TlakD: 80 }], [2, { Spo2: 97 }], [3, { Teplota: '36.6' }]].entries()) {
    await tabulky.vloz(T, 'A_KAM_Mereni', { Id: 'm' + i, KameraID: 'tapoc2020', NaramekId: '9705357211', Cas: 1_700_000_000_000 + r[0] * 300_000, ...r[1] });
  }
  await tabulky.vloz(T, 'A_KAM_Mereni', { Id: 'mx', KameraID: 'jina', NaramekId: '1', Cas: 1_700_000_000_000, Tep: 1 });
  const { h, uzivatele, vsichni } = handler({ tabulky });
  let r = await h(req('GET', '/api/naramek/mereni?kamera=tapoc2020', { cookies: cookie() }));
  assert.equal(r.status, 200); const m = (await r.json()).mereni;
  assert.equal(m.length, 3); assert.equal(m[0].teplota, 36.6); assert.equal(m[2].tep, 70); assert.equal(m[1].spo2, 97); assert.ok(m[0].cas > m[1].cas, 'nejnovější první');
  r = await h(req('GET', '/api/naramek/mereni?kamera=tapoc2020&format=xlsx', { cookies: cookie() }));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /spreadsheetml/); assert.match(r.headers.get('content-disposition'), /famicura-mereni_.*\.xlsx/);
  const buf = Buffer.from(await r.arrayBuffer()); assert.equal(buf.subarray(0, 2).toString(), 'PK', 'sešit je zip');
  assert.equal((await h(req('GET', '/api/naramek/mereni?kamera=cizi', { cookies: cookie() }))).status, 404);
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777000444', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  assert.equal((await h(req('GET', '/api/naramek/mereni?kamera=tapoc2020', { cookies: cookieRodina(T, rod.id).split(';')[0] }))).status, 403);
});

test('slucMereni: hodnoty jedné sady (do 2 minut, bez překryvu) v jednom řádku, další sada zvlášť', () => {
  const t = 1_700_000_000_000;
  const r = slucMereni([
    { cas: t + 900_000 + 40_000, teplota: 36.6 }, { cas: t + 900_000 + 20_000, spo2: 96 }, { cas: t + 900_000, tep: 66, tlakS: 111, tlakD: 69 },   // druhá sada
    { cas: t + 30_000, spo2: 95 }, { cas: t, tep: 65, tlakS: 108, tlakD: 67 },                                                                  // první sada
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].tep, r[0].tlakS, r[0].tlakD, r[0].spo2, r[0].teplota, r[0].cas, r[0].od, r[0].pocet], [66, 111, 69, 96, 36.6, t + 940_000, t + 900_000, 3]);
  assert.deepEqual([r[1].tep, r[1].tlakS, r[1].spo2, r[1].teplota ?? null], [65, 108, 95, null]);
  // dvě měření tepu po 30 s = dvě sady (překryv), nic se neztratí
  assert.equal(slucMereni([{ cas: t + 30_000, tep: 70 }, { cas: t, tep: 65 }]).length, 2);
});
