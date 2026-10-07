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
  const klient = async (kameraId) => {
    const kam = (await kamery()).find((k) => k.id === kameraId);
    if (!kam) throw chyba('Neznámá kamera.', 404);
    let k = klienti.get(kameraId);
    if (!k) { k = onvif({ host: kam.ip, port: kam.onvifPort || 2020, user: kam.user, pass: kam.pass, now }); klienti.set(kameraId, k); }
    return k;
  };
  return {
    /**
     * Pohne kamerou → { ok }. 404 neznámá kamera, 409 když se právě hýbe (krok šipkou), 502 když kamera neodpoví nebo PTZ nemá.
     * Otočení do stropu (deaktivace) a zpět (home, případně na uloženou polohu) na dokončení předchozího pohybu počká,
     * aby deaktivace stisknutá hned po šipce neskončila chybou „právě se otáčí“.
     */
    async pohni(kameraId, smer, { rychlost = 0.5, ms = 400, poloha = null } = {}) {
      if (!SMERY_SERVER.includes(smer)) throw chyba('Směr: left, right, up, down, home nebo stop.', 400);
      const k = await klient(kameraId);
      if (bezi.has(kameraId)) {
        if (smer !== 'strop' && smer !== 'home') throw chyba('Kamera se právě otáčí, chvilku počkejte.', 409);
        await bezi.get(kameraId).catch(() => {});
      }
      const p = (async () => {
        try { await k.syncClock?.().catch(() => {}); return await k.ptz(smer, { rychlost, ms, poloha }); }
        catch (e) { klienti.delete(kameraId); log.error('[ptz]', kameraId, smer, e.message, e.detail || ''); throw chyba(`Otočení se nepodařilo: ${e.message}`, 502); }
      })().finally(() => { if (bezi.get(kameraId) === p) bezi.delete(kameraId); });
      bezi.set(kameraId, p);
      return p;
    },
    /** Kam kamera právě kouká (ONVIF GetStatus) → { x, y } v rozsahu −1…1, nebo null, když to kamera neumí. Počká na běžící pohyb. */
    async poloha(kameraId) {
      const k = await klient(kameraId);
      if (bezi.has(kameraId)) await bezi.get(kameraId).catch(() => {});
      try { await k.syncClock?.().catch(() => {}); return await k.poloha(); }
      catch (e) { log.error('[ptz]', kameraId, 'poloha', e.message, e.detail || ''); return null; }
    },
  };
}
