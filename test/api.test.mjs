import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler, cameraNames } from '../src/api.mjs';
import { createLimiter } from '../src/limit.mjs';
import { pripravit } from '../src/zaznamy.mjs';
import { mockDbs } from './mock-db.mjs';

process.env.SESSION_KEY = 'testovaci-klic';
process.env.FAMICURA_PASSWORD = 'spravne-heslo';

/** Stejná cookie, jakou vydává /api/login. */
function cookie(expiresAt = Date.now() + 3600_000, key = process.env.SESSION_KEY) {
  const sig = crypto.createHmac('sha256', key).update(`famicura-tapo:${expiresAt}`, 'utf8').digest('base64url');
  return `fam_tapo=${expiresAt}.${sig}`;
}

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
  return { h: createHandler({ dbs: db.dbs, go2rtc, store, limiter: over.limiter, udalosti: over.udalosti || null }), ...db, go2rtc, store };
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
  assert.match(set, /^fam_tapo=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
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
    const b = await (await h(req('GET', '/api/status', { cookies: cookie() }))).json();
    assert.equal(b.go2rtc.ok, true);
    assert.equal(b.go2rtc.version, '1.9.14');
    assert.deepEqual(b.cameras, [{ id: 'tapoc2020', name: 'Pokoj 12', events: [], online: false, detail: 'dial tcp: i/o timeout',
      eventsOk: null, eventsError: null, eventsLast: null, clbError: null }]);
  } finally { delete process.env.CAMERA_NAMES; }
});

test('seznam kamer bere názvy z CAMERA_NAMES, jinak ID', async () => {
  process.env.CAMERA_NAMES = 'tapoc2020=Pokoj 12 – okno; x=y';
  try {
    const { h } = handler({ go2rtc: fakeGo2rtc({ streams: ['tapoc2020', 'druha'] }) });
    const b = await (await h(req('GET', '/api/devices', { cookies: cookie() }))).json();
    assert.deepEqual(b.devices, [{ id: 'tapoc2020', name: 'Pokoj 12 – okno', events: [] }, { id: 'druha', name: 'druha', events: [] }]);
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
  assert.deepEqual(store.data.watch.tapoc2020['cam-motion'], { enabled: false, from: '', to: '' });
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
