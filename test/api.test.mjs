import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler, cameraNames } from '../src/api.mjs';
import { createLimiter } from '../src/limit.mjs';
import { pripravit } from '../src/zaznamy.mjs';
import { mockDbs } from './mock-db.mjs';
import { createUzivatele } from '../src/uzivatele.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';
import { createNajemci } from '../src/najemci.mjs';
import { createNahravky } from '../src/nahravky.mjs';
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
  return { h: createHandler({ dbs: db.dbs, go2rtc, store, limiter: over.limiter, udalosti: over.udalosti || null, uzivatele, sms, asistent: over.asistent || null, pdp, najemci, dispecer, kameryTenanty, disk: over.disk || null, nahravky: over.nahravky || null }),
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
  const { h, tabulky } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha'] }) });
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
  return { nastaveno: true, nahrane, async stav() { return stav; }, async zalozSlozku(t, nazev) { stav.slozka = { id: 's2', nazev: nazev || 'Famicura Kamera – FamiCura', url: 'https://drive/s2' }; return { ...stav, zprava: 'založeno' }; },
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
  const sl = await (await h(req('POST', '/api/nahravky/slozka', { cookies: cookie(), body: { nazev: 'Famicura Kamera – test' } }))).json();
  assert.equal(sl.slozka.id, 's2');
  // rodina povolila jen drátěný model → ruční nahrávka se nepořídí
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'skeleton', noc: 'skeleton', nouze: true }] } }));
  let r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 10 } }));
  assert.equal(r.status, 403, 'ruční nahrávka při drátěném modelu'); assert.match((await r.json()).error, /rodina povolila jen/);
  await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'setConsent', args: ['tapoc2020', { den: 'full', noc: 'full', nouze: true }] } }));
  r = await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020', delkaS: 10 } }));
  assert.equal(r.status, 200); const n1 = (await r.json()).nahravka; assert.equal(n1.url, 'https://drive/f1'); assert.equal(n1.zdroj, 'rucni'); assert.equal(n1.delkaS, 10);
  assert.equal((await h(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'cizi' } }))).status, 404, 'cizí kamera');
  // soubor z hlavní aplikace (správce bez tenanta: tenant podle kamery)
  const up = new Request('http://localhost/api/nahravky?kamera=tapoc2020&zdroj=plan&delkaS=30&text=Pl%C3%A1n', { method: 'POST', headers: { 'content-type': 'video/webm', cookie: cookieServer() }, body: Buffer.alloc(4096, 1) });
  r = await h(up); assert.equal(r.status, 200); const n2 = (await r.json()).nahravka; assert.match(n2.nazev, /\.webm$/); assert.equal(n2.zdroj, 'plan'); assert.equal(disk.nahrane[1].mime, 'video/webm');
  assert.equal((await h(new Request('http://localhost/api/nahravky?kamera=tapoc2020', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: cookie() }, body: 'x'.repeat(2000) }))).status, 415);
  const sez = await (await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: cookie() }))).json();
  assert.equal(sez.nahravky.length, 2); assert.equal(sez.nahravky[0].id, n2.id);
  // událost s Nahrávat → nahrávka u události
  const ev = await (await h(req('POST', '/api/proto/akce', { cookies: cookie(), body: { akce: 'emit', args: ['tapoc2020', 'fall'] } }))).json();
  await (await (await h(req('GET', '/api/health'))).json(), nahravky.hotovo());
  const stav = await (await h(req('GET', '/api/proto/stav', { cookies: cookie() }))).json();
  assert.equal(stav.state.events.find((e) => e.id === ev.vysledek.id).nahravka.url, 'https://drive/f3');
  // rodina nic z toho nesmí
  const u = await uzivatele.vytvor({ jmeno: 'Petr', telefon: '777123456', kamery: ['tapoc2020'] });
  const rod = await vsichni.aktivuj(u.token, 'rodina-heslo-1');
  assert.equal((await h(req('GET', '/api/nahravky?kamera=tapoc2020', { cookies: cookieRodina(T, rod.id).split(';')[0] }))).status, 403, 'rodina nesmí seznam nahrávek');
  // bez nastavení
  const { h: h2 } = handler();
  assert.equal((await (await h2(req('GET', '/api/nahravky/stav', { cookies: cookie() }))).json()).nastaveno, false);
  assert.equal((await h2(req('POST', '/api/nahravky/rucni', { cookies: cookie(), body: { kamera: 'tapoc2020' } }))).status, 503, 'bez nastavení 503');
});
