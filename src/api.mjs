/**
 * HTTP vrstva (Request → Response), bez vazby na framework kvůli testům.
 *
 *   GET  /api/health            → verze (bez přihlášení)
 *   POST /api/login             { password } → cookie
 *   GET  /api/status            → přihlášen?, co chybí v .env, go2rtc a kamery
 *   GET  /api/devices           → kamery z go2rtc
 *   POST /api/stream            { deviceId, sdpOffer } → { sdpAnswer } (WebRTC přes go2rtc)
 *   GET  /api/stream.mp4?deviceId=  obraz přes HTTPS (fMP4, Chrome/Edge), když síť nepustí WebRTC
 *   GET  /api/stream.m3u8?deviceId= totéž jako HLS (Safari); díly pod /api/hls/…
 *   GET|PUT /api/schedules      plány nahrávání
 *   GET|PUT /api/watch          sledované události analýzy i kamery
 *   GET  /api/events?since=ms   události, které nahlásila kamera (odebírá server)
 *   GET  /api/diag              počty řádků v CLB1
 *   POST /api/clb               { typ: 'udalost' | 'nahravka', ... } → zápis do CLB1
 *
 * Stránka i API běží na jedné adrese (VPS za Caddy), takže bez CORS.
 * Všechno kromě health a login chce přihlášení.
 */
import { prihlasen, cookie, hesloSedi } from './session.mjs';
import { createLimiter } from './limit.mjs';
import { Go2rtcError } from './go2rtc.mjs';
import { normalizeIntervals, isDeviceId, MAX_INTERVALS } from './plan-pravidla.mjs';
import { normalizeWatch, isDefaultWatch } from '../public/watch.js';
import * as zaznamy from './zaznamy.mjs';

// Když hostname v Caddy spadne na sousední aplikaci, vrátí se její 404 a
// v prohlížeči to vypadá jako naše chyba. Každá odpověď proto říká, kdo ji napsal.
const APLIKACE = 'famicura-tapo';

const POVINNE = ['FAMICURA_PASSWORD', 'SESSION_KEY'];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/** "tapoc2020=Pokoj 12; druha=Chodba" → { tapoc2020: 'Pokoj 12', druha: 'Chodba' } */
export function cameraNames(raw = process.env.CAMERA_NAMES || '') {
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Za Caddy je první adresa v X-Forwarded-For klient; Caddy ji nastavuje sám.
function klientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'mistni';
}

function health() {
  return { ok: true, aplikace: APLIKACE, cas: new Date().toISOString(),
    verze: process.env.APP_VERZE || '', commit: process.env.APP_COMMIT || '',
    vetev: process.env.APP_VETEV || '', nasazeno: process.env.APP_NASAZENO || '',
    spusteno: process.env.APP_SPUSTENO || '' };
}

export function createHandler({ dbs, go2rtc, store, limiter = createLimiter(), udalosti = null }) {
  // Each camera carries what it can report itself, so the page offers only that.
  async function kamery() {
    const names = cameraNames();
    const st = udalosti ? udalosti.stav() : {};
    return (await go2rtc.streams()).map((id) => ({ id, name: names[id] || id, events: st[id]?.events || [] }));
  }

  async function telo(req) {
    try { return await req.json(); }
    catch { const e = new Error('Tělo požadavku musí být JSON.'); e.status = 400; throw e; }
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const m = req.method.toUpperCase();

    try {
      if (m === 'GET' && (path === '/api/health' || path === '/api/clb-health')) return json(health());

      if (m === 'POST' && path === '/api/login') {
        const ip = klientIp(req);
        const cekat = limiter.blokovano(ip);
        if (cekat) return json({ ok: false, error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(cekat / 60)} min.` }, 429);
        const { password } = await telo(req);
        if (!hesloSedi(password)) {
          limiter.chyba(ip);
          return json({ ok: false, error: 'Nesprávné heslo Famicura.' }, 401);
        }
        limiter.uspech(ip);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie() });
      }

      if (m === 'GET' && path === '/api/status') {
        const missing = POVINNE.filter((k) => !process.env[k]);
        if (!prihlasen(req.headers)) return json({ ok: true, authenticated: false, missing });

        const out = { ok: true, authenticated: true, missing, go2rtc: { ok: false }, cameras: [] };
        try {
          out.go2rtc = { ok: true, version: await go2rtc.version() };
          out.cameras = await kamery();
          // Camera checks run side by side; each gives up after a few seconds.
          const probes = await Promise.all(out.cameras.map((c) => go2rtc.probe(c.id)));
          const st = udalosti ? udalosti.stav() : {};
          out.cameras = out.cameras.map((c, i) => ({ ...c, online: probes[i].ok, detail: probes[i].detail,
            // null: the server does not subscribe at all (no cameras.json)
            eventsOk: st[c.id] ? st[c.id].ok : null, eventsError: st[c.id]?.error || null,
            eventsLast: st[c.id]?.posledni || null, eventsRejected: st[c.id]?.odmitnuto || null, clbError: st[c.id]?.clbChyba || null,
            eventsOther: st[c.id]?.nezarazene || [] }));
        } catch (e) {
          out.go2rtc = { ok: false, error: e.message };
        }
        return json(out);
      }

      if (!prihlasen(req.headers)) return json({ ok: false, error: 'Přihlaste se heslem Famicura.' }, 401);

      if (m === 'GET' && path === '/api/devices') {
        return json({ ok: true, devices: await kamery() });
      }

      if (path === '/api/stream') {
        if (m === 'DELETE') return json({ ok: true });   // go2rtc ends it when the peer closes
        if (m !== 'POST') return json({ ok: false, error: 'POST nebo DELETE' }, 405);
        const { deviceId, sdpOffer } = await telo(req);
        if (!deviceId || !isDeviceId(deviceId)) return json({ ok: false, error: 'Chybí nebo je neplatné deviceId.' }, 400);
        if (!sdpOffer || typeof sdpOffer !== 'string' || sdpOffer.length > 100_000) {
          return json({ ok: false, error: 'Chybí SDP offer.' }, 400);
        }
        // Only a stream go2rtc knows: the id goes into its URL.
        if (!(await go2rtc.streams()).includes(deviceId)) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        return json({ ok: true, sdpAnswer: await go2rtc.webrtc(deviceId, sdpOffer), sessionUrl: null });
      }

      // The picture over HTTPS for a network that drops WebRTC: go2rtc's MP4
      // (Chrome, Edge) or HLS (Safari), passed through as it comes. Video only:
      // browsers play the camera's G.711 audio in neither container.
      if (m === 'GET' && (path === '/api/stream.mp4' || path === '/api/stream.m3u8')) {
        const id = url.searchParams.get('deviceId') || '';
        if (!isDeviceId(id)) return json({ ok: false, error: 'Chybí nebo je neplatné deviceId.' }, 400);
        if (!(await go2rtc.streams()).includes(id)) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        return go2rtc.proxy(`${path}?src=${encodeURIComponent(id)}&video=h264`, { signal: req.signal });
      }
      if (m === 'GET' && path.startsWith('/api/hls/')) {
        // Playlist and segments under the id the master playlist handed out;
        // only those names and only an id and a segment number go through.
        const file = path.slice('/api/hls/'.length);
        const id = url.searchParams.get('id') || '';
        const n = url.searchParams.get('n');
        if (!['playlist.m3u8', 'init.mp4', 'segment.m4s', 'segment.ts'].includes(file)) return json({ ok: false, error: 'Neznámá adresa.' }, 404);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || (n !== null && !/^\d{1,9}$/.test(n))) return json({ ok: false, error: 'Neplatný odkaz.' }, 400);
        return go2rtc.proxy(`${path}?id=${id}${n === null ? '' : `&n=${n}`}`, { signal: req.signal });
      }

      if (path === '/api/schedules') {
        if (m === 'GET') return json({ ok: true, max: MAX_INTERVALS, schedules: await store.nacti('schedules') });
        if (m !== 'PUT') return json({ ok: false, error: 'GET nebo PUT' }, 405);
        const { deviceId, intervals } = await telo(req);
        if (!isDeviceId(deviceId)) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400);
        const r = normalizeIntervals(intervals);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        const all = await store.nacti('schedules');
        if (r.intervals.length) all[deviceId] = r.intervals; else delete all[deviceId];
        await store.uloz('schedules', all);
        return json({ ok: true, intervals: r.intervals });
      }

      if (path === '/api/watch') {
        if (m === 'GET') return json({ ok: true, watch: await store.nacti('watch') });
        if (m !== 'PUT') return json({ ok: false, error: 'GET nebo PUT' }, 405);
        const { deviceId, watch } = await telo(req);
        if (!isDeviceId(deviceId)) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400);
        const r = normalizeWatch(watch);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        const all = await store.nacti('watch');
        if (isDefaultWatch(r.watch)) delete all[deviceId]; else all[deviceId] = r.watch;
        await store.uloz('watch', all);
        return json({ ok: true, watch: r.watch });
      }

      if (m === 'GET' && path === '/api/events') {
        const since = Number(url.searchParams.get('since')) || 0;
        const cas = Date.now();                 // before the list, so nothing slips between
        return json({ ok: true, cas, events: udalosti ? udalosti.nedavne(since) : [] });
      }

      if (m === 'GET' && path === '/api/diag') {
        return json({ ok: true, ...(await zaznamy.diagnostika(dbs)) });
      }

      if (m === 'POST' && path === '/api/clb') {
        const row = await telo(req);
        const out = await zaznamy.zapsat(dbs, row);
        if (!out.ok) return json({ ok: false, error: out.chyba }, out.status || 400);
        return json({ ok: true });
      }

      return json({ ok: false, aplikace: APLIKACE, error: 'Neznámá adresa.' }, 404);
    } catch (e) {
      if (e instanceof Go2rtcError) {
        console.error('[famicura-tapo] go2rtc', e.message, e.detail || '');
        return json({ ok: false, error: e.message, detail: e.detail, retry: e.retry }, e.status);
      }
      console.error('[famicura-tapo]', e);
      return json({ ok: false, error: e.message || 'Chyba serveru' }, e.status || 500);
    }
  };
}
