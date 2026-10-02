/**
 * Stav prototypu (rodina, dispečink, provoz) na serveru, sdílený mezi
 * zařízeními: souhlas nastavený na telefonu rodiny vidí dispečink jinde.
 *
 * Akce i data jsou v public/proto/sim-core.js (stejný kód běží i v
 * prohlížeči bez přihlášení). Tady se stav drží v paměti, ukládá do
 * DATA_DIR/proto-stav.json a číslo verze říká prohlížeči, jestli se něco
 * změnilo. Skutečné události kamery (ONVIF) sem skládá server sám, jednou
 * pro všechny; prohlížeče je pak nečtou každý zvlášť.
 */
import { seed, proved, AKCE } from '../public/proto/sim-core.js';

const MAPA = { 'cam-linecross': 'linecross', 'cam-tamper': 'tamper', 'cam-person': 'person', 'cam-motion': 'motion', 'cam-pet': 'motion', 'cam-vehicle': 'motion', 'cam-smart': 'motion' };
const SOUBOR = 'proto-stav';

export function createProtoStav({ store, udalosti = null, now = Date.now }) {
  let data = null;                 // { v, state }
  let realSince = now();           // skutečné události až od startu serveru, staré se nepřehrávají
  let fronta = Promise.resolve();  // akce po jedné, aby se dvě zařízení nepřepsala

  async function nacti() {
    if (data) return data;
    const s = await store.nacti(SOUBOR);
    data = s && s.state && Array.isArray(s.state.patients) ? { v: Number(s.v) || 1, state: s.state } : { v: 1, state: seed(now()) };
    return data;
  }
  const uloz = () => store.uloz(SOUBOR, data);

  /** Co se má stát i bez zásahu uživatele: vypršení, eskalace, nové události kamery. */
  function udrzba() {
    let zmena = proved(data.state, 'tick', [], now()).zmena;
    if (udalosti) {
      for (const ev of udalosti.nedavne(realSince)) {
        realSince = Math.max(realSince, ev.prijato);
        const kind = MAPA[ev.kind]; if (!kind) continue;
        try {
          proved(data.state, 'ensurePatient', [{ id: ev.kameraId, name: ev.kameraNazev }], now());
          proved(data.state, 'emit', [ev.kameraId, kind, { real: true, text: ev.text }], now());
          zmena = true;
        } catch { /* kamera s divným id: do simulace nepatří */ }
      }
    }
    if (zmena) data.v++;
    return zmena;
  }

  const serializovane = (fn) => { const p = fronta.then(fn); fronta = p.catch(() => {}); return p; };

  return {
    /** Aktuální stav a verze; verze roste jen se změnou. */
    stav() {
      return serializovane(async () => { await nacti(); if (udrzba()) await uloz(); return { v: data.v, state: data.state }; });
    },
    /** Provede akci (jméno z AKCE, argumenty jako v prohlížeči) a vrátí nový stav. Chybný vstup: status 400. */
    proved(akce, args) {
      return serializovane(async () => {
        await nacti();
        if (typeof akce !== 'string' || !AKCE.includes(akce)) { const e = new Error('Neznámá akce.'); e.status = 400; throw e; }
        udrzba();
        const out = proved(data.state, akce, args, now());
        data.state = out.state;
        if (out.zmena || akce === 'reset') data.v++;
        await uloz();
        return { v: data.v, state: data.state, vysledek: out.vysledek };
      });
    },
    AKCE,
  };
}
