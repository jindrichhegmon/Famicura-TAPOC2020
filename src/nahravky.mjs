/**
 * Nahrávky kamer poskytovatele. Dvě úložiště, volí poskytovatel v ⚙ dispečinku
 * (nahravkyUloziste):
 *   server  (doporučené) šifrované soubory na VPS (src/uloziste.mjs); přehrává
 *           jen aplikace s kontrolou přístupu, každé přehrání je v auditu
 *           (A_KAM_Prehrani), automatické mazání po nahravkyDny dnech.
 *   disk    Google Disk poskytovatele (src/disk.mjs, účet z Péče doma plus).
 *
 * Odkud nahrávka je: server po události (nebo na tlačítko) vezme několik
 * sekund obrazu z go2rtc jako MP4; hlavní aplikace pošle nahrávku pořízenou
 * v prohlížeči (ta zůstává v režimu, ve kterém byla pořízena: rozostřená
 * zůstane rozostřená). Řádek je vždy v tabulce A_KAM_Nahravka tenanta, odkaz
 * u události v historii, evidence i v CLB1 (FamicuraRingNahravky).
 *
 * Soukromí: ze serveru se nahrává jen to, co rodina poskytovateli povolila –
 * plný obraz, nebo kritická událost s povoleným nouzovým přístupem. Jinak se
 * nahrávka nepořídí a u události je důvod.
 */
import { randomBytes } from 'node:crypto';
import { KINDS, efektivni } from '../public/proto/sim-core.js';

export const DELKA_VYCHOZI = 15, DELKA_MIN = 5, DELKA_MAX = 60;
export const DNY_VYCHOZI = 30;
const MAX_BYTES = 64 * 1024 * 1024;
const TZ = 'Europe/Prague';

const nid = (now) => 'n' + now.toString(36) + randomBytes(3).toString('hex');
const casDoNazvu = (t) => {
  const f = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
};
const bezpecnyNazev = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'kamera';

/** Smí se obraz téhle kamery teď uložit ze serveru? → { ok } nebo { ok: false, duvod }. */
export function smiNahravat(state, patient, kind, now = Date.now()) {
  if (!patient) return { ok: false, duvod: 'kamera není v datech poskytovatele' };
  if (patient.offline) return { ok: false, duvod: 'kamera je nedostupná' };
  const m = efektivni(state, patient, now, !!state.night).mode;
  if (m === 'full') return { ok: true };
  const k = KINDS[kind];
  if (k && k.level === 'crit' && patient.consent?.nouze !== false) return { ok: true, nouze: true };
  return { ok: false, duvod: `rodina povolila jen „${m === 'none' ? 'žádný obraz' : m === 'blur' ? 'rozostření' : 'drátěný model'}“ – plný obraz se neukládá` };
}

export function createNahravky({ go2rtc, disk = null, uloziste = null, tabulky, kamery = async () => [], zapisClb = null, now = Date.now, log = console } = {}) {
  const bezi = new Map();   // tenant:kameraId → Promise (jedna nahrávka na kameru najednou)
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const serverOk = () => !!(uloziste && uloziste.nastaveno);
  const diskOk = () => !!(disk && disk.nastaveno);

  /** Kam ukládat podle volby poskytovatele a toho, co je na serveru nastavené: 'server' | 'disk', nebo chyba. */
  function cil(volba) {
    if (volba === 'disk') { if (diskOk()) return 'disk'; if (serverOk()) return 'server'; }
    if (serverOk()) return 'server';
    if (diskOk()) return 'disk';
    throw chyba('Nahrávky nemají kam: na serveru není nastavené úložiště (NAHRAVKY_KLIC) ani Google Disk (JHN_APPS_TOKEN, FAMICURA_KAMERA_KLIC) – ./deploy/vps-env.sh.', 503);
  }

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

  const kameraInfo = async (kameraId) => (await kamery()).find((k) => k.id === kameraId) || {};
  const normDelka = (d) => Math.min(DELKA_MAX, Math.max(DELKA_MIN, Math.round(Number(d) || DELKA_VYCHOZI)));

  async function evidenceClb(tenant, radek, kameraNazev, slozka) {
    if (!zapisClb) return;
    try {
      await zapisClb({ typ: 'nahravka', od: new Date(radek.Cas).toISOString(), do: new Date(radek.Cas + (radek.DelkaS || 0) * 1000).toISOString(), kameraId: radek.KameraID, kameraNazev,
        velikostB: radek.Velikost, soubor: radek.Nazev, slozka, zdroj: radek.Zdroj });
    } catch (e) { log.error('[nahravky] evidence v CLB1 se nezapsala:', e.message); }
  }

  /** Uloží hotový soubor (ze serveru i z prohlížeče) a zapíše řádek; při chybě řádek s chybou. */
  async function uloz(tenant, { kameraId, data, mime = 'video/mp4', cas, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '', uloziste: volba = 'server' }) {
    const t = cas || now();
    const info = await kameraInfo(kameraId);
    const label = druh && KINDS[druh] ? KINDS[druh].label : (zdroj === 'rucni' ? 'rucni' : zdroj);
    const nazev = `${bezpecnyNazev(info.name || kameraId)}_${casDoNazvu(t)}_${bezpecnyNazev(label)}.${mime.includes('webm') ? 'webm' : 'mp4'}`;
    const radek = { Id: nid(t), KameraID: kameraId, Cas: t, DelkaS: delkaS || null, Velikost: data.length, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj,
      Nazev: nazev, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: null, Uloziste: null, Soubor: null, Mime: mime, SmazanoCas: null };
    let slozka = '';
    try {
      const kam = cil(volba);
      radek.Uloziste = kam;
      if (kam === 'server') {
        const v = await uloziste.uloz(tenant, radek.Id, data);
        radek.Soubor = v.soubor; slozka = 'server:' + tenant;
      } else {
        const v = await disk.nahraj(tenant, { nazev, mime, data, popis: text || `Famicura Kamera – ${label}` });
        Object.assign(radek, { SouborID: v.id, Url: v.url, Email: v.email, Nazev: v.nazev || nazev }); slozka = 'Google Disk ' + (v.email || '');
      }
    } catch (e) {
      radek.Chyba = String(e.message || e).slice(0, 300);
      log.error('[nahravky]', tenant, kameraId, 'uložení se nepodařilo:', radek.Chyba);
    }
    await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek);
    if (!radek.Chyba) await evidenceClb(tenant, radek, info.name || kameraId, slozka);
    return zRadku(radek);
  }

  /** Nahrávka N sekund z kamery (po události nebo ručně). Jedna na kameru najednou. */
  function porid(tenant, { kameraId, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '', uloziste: volba = 'server' }) {
    const klic = tenant + ':' + kameraId;
    if (bezi.has(klic)) return bezi.get(klic).then(() => ({ preskoceno: true, duvod: 'nahrávka z téhle kamery právě běží' }));
    const d = normDelka(delkaS);
    const p = (async () => {
      const cas = now();
      let data;
      try { cil(volba); data = await klip(kameraId, d); }
      catch (e) {
        const radek = { Id: nid(cas), KameraID: kameraId, Cas: cas, DelkaS: d, Velikost: 0, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj, Nazev: null, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: String(e.message || e).slice(0, 300), Uloziste: null, Soubor: null, Mime: null, SmazanoCas: null };
        await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek).catch(() => {});
        log.error('[nahravky]', tenant, kameraId, 'nahrávka se nepořídila:', radek.Chyba);
        return zRadku(radek);
      }
      return uloz(tenant, { kameraId, data, cas, delkaS: d, druh, udalostId, zdroj, kdo, text, uloziste: volba });
    })().finally(() => bezi.delete(klic));
    bezi.set(klic, p);
    return p;
  }

  async function dnyTenanta(tenant) {
    const r = await tabulky.vyber(tenant, 'A_KAM_Nastaveni', { kde: { Klic: 'poskytovatel.nahravkyDny' }, limit: 1 });
    const n = Number(r[0]?.Hodnota);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DNY_VYCHOZI;
  }

  return {
    get nastaveno() { return serverOk() || diskOk(); },
    get uloziste() { return { server: serverOk(), disk: diskOk() }; },
    normDelka, porid, uloz, smiNahravat, cil,
    /** Nahrávky tenanta (nejnovější první): jedné kamery, nebo jen daných kamer (rodina). */
    async seznam(tenant, { kameraId = '', kamery: jen = null, limit = 50, iSmazane = false } = {}) {
      const kde = {};
      if (kameraId) kde.KameraID = kameraId; else if (Array.isArray(jen)) kde.KameraID = jen;
      if (!iSmazane) kde.SmazanoCas = null;
      const r = await tabulky.vyber(tenant, 'A_KAM_Nahravka', { kde, razeni: [['Cas', 'DESC']], limit: Math.min(500, Math.max(1, limit)) });
      return r.map(zRadku);
    },
    async podleId(tenant, id) {
      const r = await tabulky.vyber(tenant, 'A_KAM_Nahravka', { kde: { Id: String(id || '') }, limit: 1 });
      return r[0] ? zRadku(r[0]) : null;
    },
    /** Obsah nahrávky uložené na serveru → { data, mime, nazev }. */
    async soubor(tenant, n) {
      if (!n || n.uloziste !== 'server' || !n.soubor) throw chyba('Nahrávka není uložená na serveru.', 404);
      if (n.smazanoCas) throw chyba('Nahrávka už byla smazána (po uplynutí doby uchování).', 410);
      return { data: await uloziste.cti(tenant, n.id), mime: n.mime || 'video/mp4', nazev: n.nazev || (n.id + '.mp4') };
    },
    /** Audit přehrání. */
    async prehrani(tenant, { nahravkaId, kameraId, kdo, role, adresa }) {
      const t = now();
      await tabulky.vloz(tenant, 'A_KAM_Prehrani', { Id: 'p' + t.toString(36) + randomBytes(3).toString('hex'), NahravkaId: nahravkaId, KameraID: kameraId, Cas: t, Kdo: String(kdo || '').slice(0, 80), Role: String(role || '').slice(0, 12), Adresa: String(adresa || '').slice(0, 60) });
    },
    async prehraniSeznam(tenant, nahravkaId, limit = 50) {
      return (await tabulky.vyber(tenant, 'A_KAM_Prehrani', { kde: { NahravkaId: nahravkaId }, razeni: [['Cas', 'DESC']], limit })).map((r) => ({ id: r.Id, cas: Number(r.Cas), kdo: r.Kdo, role: r.Role, adresa: r.Adresa }));
    },
    /** Smaže soubor na serveru a řádek označí (zůstane v evidenci). Nahrávku na Disku jen označí. */
    async smaz(tenant, n) {
      if (!n) return false;
      if (n.uloziste === 'server' && uloziste) await uloziste.smaz(tenant, n.id);
      await tabulky.uprav(tenant, 'A_KAM_Nahravka', { Id: n.id }, { SmazanoCas: now() });
      return true;
    },
    /** Automatické mazání: nahrávky na serveru starší než nahravkyDny tenanta. Vrací počet smazaných. */
    async promaz() {
      if (!serverOk()) return 0;
      const vse = await tabulky.vyber('*', 'A_KAM_Nahravka', { kde: { Uloziste: 'server', SmazanoCas: null }, razeni: [['Cas', 'ASC']], limit: 5000 });
      const dny = new Map(); let smazano = 0;
      for (const r of vse) {
        const tenant = r.IDTENANT;
        if (!dny.has(tenant)) dny.set(tenant, await dnyTenanta(tenant).catch(() => DNY_VYCHOZI));
        if (Number(r.Cas) > now() - dny.get(tenant) * 86400000) continue;
        try { await this.smaz(tenant, zRadku(r)); smazano++; }
        catch (e) { log.error('[nahravky] mazání', tenant, r.Id, e.message); }
      }
      if (smazano) log.log(`[nahravky] automaticky smazáno ${smazano} nahrávek po uplynutí doby uchování`);
      return smazano;
    },
    async hotovo() { await Promise.allSettled([...bezi.values()]); },
  };
}

export function zRadku(r) {
  return { id: r.Id, kameraId: r.KameraID, cas: Number(r.Cas) || 0, delkaS: r.DelkaS == null ? null : Number(r.DelkaS), velikost: Number(r.Velikost) || 0, udalostId: r.UdalostId || null,
    druh: r.Druh || null, zdroj: r.Zdroj || 'udalost', nazev: r.Nazev || null, souborId: r.SouborID || null, url: r.Url || null, email: r.Email || null, kdo: r.Kdo || null, chyba: r.Chyba || null,
    uloziste: r.Uloziste || (r.Url ? 'disk' : null), soubor: r.Soubor || null, mime: r.Mime || null, smazanoCas: r.SmazanoCas == null ? null : Number(r.SmazanoCas) };
}
