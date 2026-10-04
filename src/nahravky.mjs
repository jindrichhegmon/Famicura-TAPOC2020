/**
 * Nahrávky kamer poskytovatele: server vezme po události (nebo na tlačítko)
 * několik sekund obrazu z go2rtc jako MP4 a uloží je na Google Disk
 * poskytovatele (src/disk.mjs); řádek je v tabulce A_KAM_Nahravka tenanta
 * a odkaz u události v historii. Nahrává server, ne prohlížeč: funguje, i když
 * nikdo nemá kameru otevřenou. Obraz před událostí server nemá (žádná
 * vyrovnávací paměť); nahrávka začíná událostí.
 *
 * Soukromí: nahrává se jen to, co rodina poskytovateli povolila – plný obraz,
 * nebo kritická událost s povoleným nouzovým přístupem. Jinak se nahrávka
 * nepořídí a u události je důvod.
 */
import { randomBytes } from 'node:crypto';
import { KINDS, efektivni } from '../public/proto/sim-core.js';

export const DELKA_VYCHOZI = 15, DELKA_MIN = 5, DELKA_MAX = 60;
const MAX_BYTES = 64 * 1024 * 1024;
const TZ = 'Europe/Prague';

const nid = (now) => 'n' + now.toString(36) + randomBytes(3).toString('hex');
const casDoNazvu = (t) => {
  const f = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
};
const bezpecnyNazev = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'kamera';

/** Smí se obraz téhle kamery teď uložit? → { ok } nebo { ok: false, duvod }. */
export function smiNahravat(state, patient, kind, now = Date.now()) {
  if (!patient) return { ok: false, duvod: 'kamera není v datech poskytovatele' };
  if (patient.offline) return { ok: false, duvod: 'kamera je nedostupná' };
  const m = efektivni(state, patient, now, !!state.night).mode;
  if (m === 'full') return { ok: true };
  const k = KINDS[kind];
  if (k && k.level === 'crit' && patient.consent?.nouze !== false) return { ok: true, nouze: true };
  return { ok: false, duvod: `rodina povolila jen „${m === 'none' ? 'žádný obraz' : m === 'blur' ? 'rozostření' : 'drátěný model'}“ – plný obraz se neukládá` };
}

export function createNahravky({ go2rtc, disk, tabulky, kamery = async () => [], now = Date.now, log = console } = {}) {
  const bezi = new Map();   // kameraId → Promise (jedna nahrávka na kameru najednou)
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };

  /** N sekund obrazu z go2rtc jako jeden MP4 (jen video, H.264 beze změny). */
  async function klip(kameraId, delkaS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (delkaS + 20) * 1000);
    try {
      const r = await go2rtc.proxy(`/api/stream.mp4?src=${encodeURIComponent(kameraId)}&video=h264&duration=${delkaS}`, { signal: ctrl.signal });
      const casti = []; let velikost = 0;
      for await (const c of r.body) {
        velikost += c.length;
        if (velikost > MAX_BYTES) { ctrl.abort(); throw chyba('Nahrávka je příliš velká (přes 64 MB).', 413); }
        casti.push(Buffer.from(c));
      }
      const data = Buffer.concat(casti);
      if (data.length < 1024) throw chyba('Kamera za tu dobu neposlala obraz.', 502);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw chyba('Kamera neposlala obraz včas.', 504);
      throw e;
    } finally { clearTimeout(t); }
  }

  const nazevKamery = async (kameraId) => ((await kamery()).find((k) => k.id === kameraId) || {}).name || kameraId;
  const normDelka = (d) => Math.min(DELKA_MAX, Math.max(DELKA_MIN, Math.round(Number(d) || DELKA_VYCHOZI)));

  /** Uloží hotový soubor (ze serveru i z prohlížeče) na Disk a zapíše řádek. Při chybě řádek s chybou. */
  async function uloz(tenant, { kameraId, data, mime = 'video/mp4', cas, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '' }) {
    const t = cas || now();
    const label = druh && KINDS[druh] ? KINDS[druh].label : (zdroj === 'rucni' ? 'rucni' : zdroj);
    const nazev = `${bezpecnyNazev(await nazevKamery(kameraId))}_${casDoNazvu(t)}_${bezpecnyNazev(label)}.${mime.includes('webm') ? 'webm' : 'mp4'}`;
    const radek = { Id: nid(t), KameraID: kameraId, Cas: t, DelkaS: delkaS || null, Velikost: data.length, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj,
      Nazev: nazev, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: null };
    try {
      const v = await disk.nahraj(tenant, { nazev, mime, data, popis: text || `Famicura Kamera – ${label}` });
      Object.assign(radek, { SouborID: v.id, Url: v.url, Email: v.email, Nazev: v.nazev || nazev });
    } catch (e) {
      radek.Chyba = String(e.message || e).slice(0, 300);
      log.error('[nahravky]', tenant, kameraId, 'nahrání na Google Disk se nepodařilo:', radek.Chyba);
    }
    await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek);
    return zRadku(radek);
  }

  /** Nahrávka N sekund z kamery (po události nebo ručně) → { id, url, nazev, chyba… }. Jedna na kameru najednou. */
  function porid(tenant, { kameraId, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '' }) {
    const klic = tenant + ':' + kameraId;
    if (bezi.has(klic)) return bezi.get(klic).then(() => ({ preskoceno: true, duvod: 'nahrávka z téhle kamery právě běží' }));
    const d = normDelka(delkaS);
    const p = (async () => {
      const cas = now();
      let data;
      try { data = await klip(kameraId, d); }
      catch (e) {
        const radek = { Id: nid(cas), KameraID: kameraId, Cas: cas, DelkaS: d, Velikost: 0, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj, Nazev: null, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: String(e.message || e).slice(0, 300) };
        await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek).catch(() => {});
        log.error('[nahravky]', tenant, kameraId, 'obraz z go2rtc se nepodařil:', radek.Chyba);
        return zRadku(radek);
      }
      return uloz(tenant, { kameraId, data, cas, delkaS: d, druh, udalostId, zdroj, kdo, text });
    })().finally(() => bezi.delete(klic));
    bezi.set(klic, p);
    return p;
  }

  return {
    get nastaveno() { return !!(disk && disk.nastaveno); },
    normDelka, porid, uloz, smiNahravat,
    /** Nahrávky tenanta (nejnovější první), případně jedné kamery. */
    async seznam(tenant, { kameraId = '', limit = 50 } = {}) {
      const r = await tabulky.vyber(tenant, 'A_KAM_Nahravka', { kde: kameraId ? { KameraID: kameraId } : {}, razeni: [['Cas', 'DESC']], limit: Math.min(500, Math.max(1, limit)) });
      return r.map(zRadku);
    },
    async hotovo() { await Promise.allSettled([...bezi.values()]); },
  };
}

export function zRadku(r) {
  return { id: r.Id, kameraId: r.KameraID, cas: Number(r.Cas) || 0, delkaS: r.DelkaS == null ? null : Number(r.DelkaS), velikost: Number(r.Velikost) || 0, udalostId: r.UdalostId || null,
    druh: r.Druh || null, zdroj: r.Zdroj || 'udalost', nazev: r.Nazev || null, souborId: r.SouborID || null, url: r.Url || null, email: r.Email || null, kdo: r.Kdo || null, chyba: r.Chyba || null };
}
