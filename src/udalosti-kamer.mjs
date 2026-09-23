/**
 * Události, které hlásí kamera sama (ONVIF): odběr na serveru.
 *
 * Pro každou kameru z cameras.json běží smyčka: zjistit, co kamera umí, založit
 * odběr, čekat na zprávy, každých ~8 minut odběr obnovit; po chybě chvíli
 * počkat a začít znovu. Odběr běží trvale, tedy i bez otevřeného prohlížeče.
 * Každá událost projde nastavením Sledovaných událostí té kamery (hodiny se
 * počítají v čase pečovatelů, ne serveru) a zapíše se do CLB1; posledních pár
 * set si server drží pro stránku (GET /api/events).
 */
import { normalizeWatch, cameraEventAllowed, cameraEventLabel, cameraEventLevel } from '../public/watch.js';
import { createOnvif } from './onvif.mjs';
import * as zaznamy from './zaznamy.mjs';

const NEDAVNYCH_MAX = 500;
const STEJNA_MS = 5000;           // camera repeating the same detection this soon is one event

/** Wall-clock time of `ms` in the given zone, as a Date whose getHours() reads that clock. */
export function mistniCas(ms, casPasmo) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: casPasmo, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return new Date(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

export function createCameraEvents({ kamery, store, dbs, onvif = createOnvif, log = console, now = Date.now,
                                     sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
                                     casPasmo = process.env.CAS_PASMO || 'Europe/Prague',
                                     renewS = 480, pullS = 60, cekaniMs = 15000 }) {
  const stav = new Map();           // id → { ok, error, events, posledni, clbChyba }
  const smycky = new Map();         // id → { stop, hotovo }
  const nedavne = [];               // newest last
  const naposledy = new Map();      // `${id}:${kind}` → ms

  function zaznam(id, zmena) {
    stav.set(id, { ok: false, error: null, events: [], posledni: null, clbChyba: null, nezarazene: [], ...(stav.get(id) || {}), ...zmena });
  }

  async function zpracuj(kam, ev) {
    const klic = `${kam.id}:${ev.kind}`;
    if (ev.at - (naposledy.get(klic) || 0) < STEJNA_MS) return;
    naposledy.set(klic, ev.at);

    const vsechna = await store.nacti('watch');
    const watch = normalizeWatch(vsechna[kam.id]).watch;
    if (!cameraEventAllowed(watch, ev.kind, mistniCas(ev.at, casPasmo))) return;

    const label = cameraEventLabel(ev.kind, ev.label);
    const level = cameraEventLevel(ev.kind);
    // `at` is the camera's clock (whole seconds); `prijato` is ours, so a
    // page asking "what came after X" never gets the same second twice.
    const r = { at: new Date(ev.at).toISOString(), prijato: now(), kameraId: kam.id, kameraNazev: kam.name || kam.id,
      kind: ev.kind, label, level, text: `Kamera hlásí: ${label.toLowerCase()}.` };
    nedavne.push(r);
    if (nedavne.length > NEDAVNYCH_MAX) nedavne.shift();
    zaznam(kam.id, { posledni: r });

    try {
      await zaznamy.zapsat(dbs, { typ: 'udalost', cas: r.at, kameraId: r.kameraId, kameraNazev: r.kameraNazev,
        druh: r.kind, zavaznost: level === 'warn' ? 'varovani' : 'info', popis: r.text, odZacatkuS: 0 });
      zaznam(kam.id, { clbChyba: null });
    } catch (e) {
      zaznam(kam.id, { clbChyba: e.message });
      log.error('[famicura-tapo] událost kamery se nezapsala do CLB1:', e.message);
    }
  }

  async function smycka(kam, ctl) {
    let cekani = cekaniMs;
    while (!ctl.stop) {
      const klient = onvif({ host: kam.ip, port: kam.onvifPort || 2020, user: kam.user, pass: kam.pass, now });
      let adresa = null;
      try {
        await klient.syncClock();
        const events = await klient.capabilities();
        zaznam(kam.id, { ok: true, error: null, events });
        adresa = await klient.subscribe();
        let obnoveno = now();
        cekani = cekaniMs;
        while (!ctl.stop) {
          const jine = [];
          const zpravy = await klient.pull(adresa, { timeoutS: pullS, nezarazene: jine });
          for (const ev of zpravy) await zpracuj(kam, ev);
          // What the camera reports under a name the catalogue lacks goes to the
          // server log and diagnostics, so a "zone left" that never shows up
          // can be traced to the topic the camera actually used.
          if (jine.length) {
            log.log('[famicura-tapo] kamera', kam.id, 'hlásí mimo katalog:', JSON.stringify(jine));
            zaznam(kam.id, { nezarazene: jine.slice(-5) });
          }
          if (now() - obnoveno >= renewS * 1000) { await klient.renew(adresa); obnoveno = now(); }
        }
      } catch (e) {
        zaznam(kam.id, { ok: false, error: e.message });
        log.error('[famicura-tapo] události kamery', kam.id + ':', e.message, e.detail || '');
      } finally {
        if (adresa) await klient.unsubscribe(adresa).catch(() => {});
      }
      if (!ctl.stop) { await sleep(cekani); cekani = Math.min(cekani * 2, 120000); }
    }
  }

  return {
    /** Starts a loop per camera; safe to call again after cameras change. */
    async start() {
      const seznam = await kamery();
      const ids = new Set(seznam.map((k) => k.id));
      for (const [id, ctl] of smycky) if (!ids.has(id)) { ctl.stop = true; smycky.delete(id); stav.delete(id); }
      for (const kam of seznam) {
        if (smycky.has(kam.id)) continue;
        const ctl = { stop: false };
        ctl.hotovo = smycka(kam, ctl);
        smycky.set(kam.id, ctl);
      }
    },

    /** Ends every loop; running pulls finish on their own timeout. */
    async stop() {
      for (const ctl of smycky.values()) ctl.stop = true;
      smycky.clear();
    },

    /** Per camera: whether the subscription runs, what the camera can report, the last event. */
    stav() { return Object.fromEntries(stav); },

    /** Events received after `sinceMs` (server clock), oldest first. */
    nedavne(sinceMs = 0) {
      return nedavne.filter((r) => r.prijato > sinceMs);
    },
  };
}
