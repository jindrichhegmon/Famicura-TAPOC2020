/**
 * Otáčení kamery (Tapo C200/C210/C220: pan/tilt přes ONVIF PTZ, stejný účet a
 * port 2020 jako události). Krok = krátký ContinuousMove a Stop, tlačítka
 * v detailu dispečinku a v aplikaci rodiny (jen u své kamery). Jeden pohyb
 * na kameru najednou; klient ONVIF se drží, dokud nezačne chybovat.
 */
import { createOnvif } from './onvif.mjs';

export const SMERY = ['left', 'right', 'up', 'down', 'home', 'stop'];
/** Směry jen pro server (deaktivace kamery rodinou): 'strop' = horní doraz. */
export const SMERY_SERVER = [...SMERY, 'strop'];

export function createPtz({ kamery, onvif = createOnvif, now = Date.now, log = console } = {}) {
  const klienti = new Map();   // kameraId → klient ONVIF
  const bezi = new Map();      // kameraId → Promise
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  return {
    /** Pohne kamerou → { ok }. 404 neznámá kamera, 409 když se právě hýbe, 502 když kamera neodpoví nebo PTZ nemá. */
    async pohni(kameraId, smer, { rychlost = 0.5, ms = 400 } = {}) {
      if (!SMERY_SERVER.includes(smer)) throw chyba('Směr: left, right, up, down, home nebo stop.', 400);
      const kam = (await kamery()).find((k) => k.id === kameraId);
      if (!kam) throw chyba('Neznámá kamera.', 404);
      if (bezi.has(kameraId)) throw chyba('Kamera se právě otáčí, chvilku počkejte.', 409);
      let k = klienti.get(kameraId);
      if (!k) { k = onvif({ host: kam.ip, port: kam.onvifPort || 2020, user: kam.user, pass: kam.pass, now }); klienti.set(kameraId, k); }
      const p = (async () => {
        try { await k.syncClock?.().catch(() => {}); return await k.ptz(smer, { rychlost, ms }); }
        catch (e) { klienti.delete(kameraId); log.error('[ptz]', kameraId, smer, e.message, e.detail || ''); throw chyba(`Otočení se nepodařilo: ${e.message}`, 502); }
      })().finally(() => bezi.delete(kameraId));
      bezi.set(kameraId, p);
      return p;
    },
  };
}
