/**
 * Světlo kamery (reflektor / bílý přísvit u Tapo C320WS, C520WS, C560WS…)
 * z dispečinku: zapnout, zhasnout, zjistit stav. Jde přes místní rozhraní
 * Tapo (src/tapo.mjs, HTTPS 443 tunelem), ne přes ONVIF.
 *
 * Účet: nejdřív účet kamery z cameras.json (user/pass), když ho kamera na
 * tohle rozhraní nepustí, „admin“ s heslem účtu TP-Link (tapoPass z
 * ./deploy/vps-kamera.sh svetlo ID). Kamera bez světla se zapamatuje
 * (podporuje: false) a nezkouší se pořád dokola; chyby spojení se zkoušejí znovu.
 */
import { createTapo, TapoError } from './tapo.mjs';

export function createSvetlo({ kamery, tapo = createTapo, now = Date.now, log = console, pametMs = 10 * 60 * 1000 } = {}) {
  const klienti = new Map();   // kameraId → { klient, ucet }
  const odmitnute = new Map(); // kameraId → Set účtů, které kamera po přihlášení odmítla (-40211: bez práv) – zkouší se další
  const pamet = new Map();     // kameraId → { podporuje, zapnuto, chyba, cas, model }
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };

  const ucty = (kam) => {
    const u = []; const o = odmitnute.get(kam.id) || new Set();
    if (kam.user && kam.pass && !o.has('kamera')) u.push({ ucet: 'kamera', user: kam.user, pass: kam.pass });
    if (kam.tapoPass) u.push({ ucet: 'tapo', user: kam.tapoUser || 'admin', pass: kam.tapoPass });
    return u;
  };

  /** Přihlášený klient kamery; zkouší účty po řadě, u chyby přihlášení jde na další. */
  async function klient(kameraId) {
    const kam = (await kamery()).find((k) => k.id === kameraId);
    if (!kam) throw chyba('Neznámá kamera.', 404);
    const drzeny = klienti.get(kameraId);
    if (drzeny) return drzeny;
    const moznosti = ucty(kam);
    if (!moznosti.length) throw chyba(kam.tapoPass ? 'Kamera odmítla účet kamery i účet TP-Link.' : `účet kamery na tohle rozhraní nestačí – uložte heslo účtu TP-Link: ./deploy/vps-kamera.sh svetlo ${kameraId}`, 503);
    let posledni = null;
    for (const m of moznosti) {
      const k = tapo({ host: kam.ip, user: m.user, pass: m.pass, log });
      try { await k.login(); klienti.set(kameraId, { klient: k, ucet: m.ucet }); return klienti.get(kameraId); }
      catch (e) { posledni = e; if (!(e instanceof TapoError) || !e.auth) break; }
    }
    const e = posledni || new Error('přihlášení se nepodařilo');
    throw chyba(e instanceof TapoError && e.auth && moznosti.length === 1 && !kam.tapoPass
      ? `${e.message}; účet kamery na tohle rozhraní nestačí – uložte heslo účtu TP-Link: ./deploy/vps-kamera.sh svetlo ${kameraId}`
      : e.message, e instanceof TapoError && e.status === 0 ? 502 : 502);
  }

  const zapamatuj = (kameraId, v) => { const z = { ...(pamet.get(kameraId) || {}), ...v, cas: now() }; pamet.set(kameraId, z); return z; };

  return {
    /**
     * Stav světla: { podporuje, zapnuto, chyba, model, ucet }. Kamera bez světla → podporuje false (na pametMs se nezkouší znovu).
     * Chyba spojení / přihlášení → podporuje null a text chyby (zkusí se příště znovu).
     */
    async stav(kameraId, { znovu = false, pokus = 0 } = {}) {
      const z = pamet.get(kameraId);
      if (!znovu && z && z.podporuje === false && now() - z.cas < pametMs) return z;
      let ucet = null;
      try {
        const k = (({ klient: kl, ucet: u }) => { ucet = u; return kl; })(await klient(kameraId));
        let model = z?.model || null;
        if (!model) { try { const i = await k.info(); model = i?.device_model || null; } catch { /* model je jen informace */ } }
        const s = await k.svetloStav();
        return zapamatuj(kameraId, { podporuje: true, zapnuto: !!s.zapnuto, intenzita: s.intenzita, chyba: null, model, ucet });
      } catch (e) {
        if (e instanceof TapoError && e.nepodporuje) return zapamatuj(kameraId, { podporuje: false, zapnuto: null, chyba: null });
        klienti.delete(kameraId);
        // přihlášení prošlo, ale kamera účet na funkce nepustila (-40211): zapamatovat a zkusit další účet (TP-Link)
        if (e instanceof TapoError && e.auth && ucet && pokus < 2) { const o = odmitnute.get(kameraId) || new Set(); o.add(ucet); odmitnute.set(kameraId, o); return this.stav(kameraId, { znovu, pokus: pokus + 1 }); }
        if (log?.error) log.error('[svetlo]', kameraId, 'stav:', e.message);
        return zapamatuj(kameraId, { podporuje: null, zapnuto: null, chyba: e.message });
      }
    },
    /** Rozsvítí (true) nebo zhasne (false); vrací { zapnuto }. 404 neznámá kamera, 502 kamera neodpovídá / odmítá, 501 světlo nemá. */
    async nastav(kameraId, zapnout) {
      const z = pamet.get(kameraId);
      if (z && z.podporuje === false && now() - z.cas < pametMs) throw chyba('Tahle kamera světlo nemá.', 501);
      let k;
      try { ({ klient: k } = await klient(kameraId)); } catch (e) { if (e.status === 404 || e.status === 503) throw e; zapamatuj(kameraId, { podporuje: null, chyba: e.message }); throw chyba(`Světlo se nepodařilo přepnout: ${e.message}`, 502); }
      try {
        const s = await k.svetlo(!!zapnout);
        zapamatuj(kameraId, { podporuje: true, zapnuto: !!s.zapnuto, intenzita: s.intenzita, chyba: null });
        return { zapnuto: !!s.zapnuto };
      } catch (e) {
        if (e instanceof TapoError && e.nepodporuje) { zapamatuj(kameraId, { podporuje: false, zapnuto: null, chyba: null }); throw chyba('Tahle kamera světlo nemá.', 501); }
        klienti.delete(kameraId);
        if (log?.error) log.error('[svetlo]', kameraId, 'nastav:', e.message);
        throw chyba(`Světlo se nepodařilo přepnout: ${e.message}`, 502);
      }
    },
    /** Co si server o světlech pamatuje (Diagnostika): kameraId → { podporuje, zapnuto, chyba, cas, model }. */
    pamet() { return Object.fromEntries(pamet); },
    zapomen(kameraId) { klienti.delete(kameraId); pamet.delete(kameraId); odmitnute.delete(kameraId); },
  };
}
