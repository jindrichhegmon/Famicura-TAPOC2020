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
export const GB_VYCHOZI = 2;            // limit místa na poskytovatele (0 = bez limitu)
export const MIN_VOLNE_GB_VYCHOZI = 5;  // pojistka: pod tolik volného místa na disku VPS se mažou nejstarší nahrávky napříč poskytovateli
const GB = 1073741824;
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
export function smiNahravat(state, patient, kind, now = Date.now(), { skutecna = false } = {}) {
  if (!patient) return { ok: false, duvod: 'kamera není v datech poskytovatele' };
  // „nedostupná“ je stav ze simulace; událost, kterou kamera právě sama nahlásila, se o to nezastaví (klip se zkusí)
  if (patient.offline && !skutecna) return { ok: false, duvod: 'kamera je nedostupná' };
  const m = efektivni(state, patient.offline ? { ...patient, offline: false } : patient, now, !!state.night).mode;
  if (m === 'full') return { ok: true };
  const k = KINDS[kind];
  if (k && k.level === 'crit' && patient.consent?.nouze !== false) return { ok: true, nouze: true };
  return { ok: false, duvod: `rodina povolila jen „${m === 'none' ? 'žádný obraz' : m === 'blur' ? 'rozostření' : 'drátěný model'}“ – plný obraz se neukládá` };
}

export function createNahravky({ go2rtc, disk = null, uloziste = null, tabulky, kamery = async () => [], zapisClb = null, now = Date.now, log = console,
                                 minVolneGB = Number(process.env.NAHRAVKY_MIN_VOLNE_GB) || MIN_VOLNE_GB_VYCHOZI, mistoDisku = null } = {}) {
  /** Volné a celkové místo na disku s nahrávkami → { volne, celkem } (null bez údaje). `mistoDisku` jde podstrčit v testech. */
  async function diskInfo() {
    if (mistoDisku) return mistoDisku();
    if (!uloziste || !uloziste.dir) return { volne: null, celkem: null };
    try {
      const { statfs, mkdir } = await import('node:fs/promises');
      const st = await statfs(uloziste.dir).catch(async () => { await mkdir(uloziste.dir, { recursive: true }); return statfs(uloziste.dir); });
      return { volne: Number(st.bavail) * Number(st.bsize), celkem: Number(st.blocks) * Number(st.bsize) };
    } catch { return { volne: null, celkem: null }; }
  }
  const minVolne = Math.max(0, Number(minVolneGB) || 0) * GB;
  const bezi = new Map();   // tenant:kameraId → Promise (jedna nahrávka na kameru najednou)
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const serverOk = () => !!(uloziste && uloziste.nastaveno);
  const diskOk = () => !!(disk && disk.nastaveno);

  /**
   * Kam ukládat: 'server' (když je úložiště na serveru), 'disk' (Google Disk místo serveru, když server není,
   * nebo volba 'disk'), nebo chyba. `disk` = kopie na Google Disk zapnutá v ⚙ (vedle serveru).
   * → { hlavni: 'server'|'disk', kopieDisk: bool }
   */
  function cil(volba, disk = false) {
    const chceDisk = volba === 'disk' || disk === true;
    if (serverOk()) return { hlavni: 'server', kopieDisk: chceDisk && diskOk() };
    if (chceDisk && diskOk()) return { hlavni: 'disk', kopieDisk: false };
    if (diskOk()) return { hlavni: 'disk', kopieDisk: false };
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
  async function uloz(tenant, { kameraId, data, mime = 'video/mp4', cas, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '', uloziste: volba = 'server', disk: kopie = false }) {
    const t = cas || now();
    const info = await kameraInfo(kameraId);
    const label = druh && KINDS[druh] ? KINDS[druh].label : (zdroj === 'rucni' ? 'rucni' : zdroj);
    const nazev = `${bezpecnyNazev(info.name || kameraId)}_${casDoNazvu(t)}_${bezpecnyNazev(label)}.${mime.includes('webm') ? 'webm' : 'mp4'}`;
    const radek = { Id: nid(t), KameraID: kameraId, Cas: t, DelkaS: delkaS || null, Velikost: data.length, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj,
      Nazev: nazev, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: null, Uloziste: null, Soubor: null, Mime: mime, SmazanoCas: null };
    let slozka = '';
    try {
      const kam = cil(volba, kopie);
      radek.Uloziste = kam.hlavni;
      if (kam.hlavni === 'server') {
        const v = await uloziste.uloz(tenant, radek.Id, data);
        radek.Soubor = v.soubor; slozka = 'server:' + tenant;
        if (kam.kopieDisk) {
          // kopie na Google Disk: chyba Disku nahrávku na serveru neruší, jen se zapíše
          try { const v2 = await disk.nahraj(tenant, { nazev, mime, data, popis: text || `Famicura Kamera – ${label}` }); Object.assign(radek, { SouborID: v2.id, Url: v2.url, Email: v2.email }); slozka += ' + Google Disk ' + (v2.email || ''); }
          catch (e) { radek.Chyba = ('Google Disk: ' + String(e.message || e)).slice(0, 300); log.error('[nahravky]', tenant, kameraId, 'kopie na Google Disk se nepodařila:', e.message); }
        }
      } else {
        const v = await disk.nahraj(tenant, { nazev, mime, data, popis: text || `Famicura Kamera – ${label}` });
        Object.assign(radek, { SouborID: v.id, Url: v.url, Email: v.email, Nazev: v.nazev || nazev }); slozka = 'Google Disk ' + (v.email || '');
      }
    } catch (e) {
      radek.Chyba = String(e.message || e).slice(0, 300);
      log.error('[nahravky]', tenant, kameraId, 'uložení se nepodařilo:', radek.Chyba);
    }
    await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek);
    if (radek.Uloziste && (radek.Soubor || radek.SouborID)) await evidenceClb(tenant, radek, info.name || kameraId, slozka);
    return zRadku(radek);
  }

  /** Nahrávka N sekund z kamery (po události nebo ručně). Jedna na kameru najednou. */
  function porid(tenant, { kameraId, delkaS, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', text = '', uloziste: volba = 'server', disk: kopie = false }) {
    const klic = tenant + ':' + kameraId;
    if (bezi.has(klic)) return bezi.get(klic).then(() => ({ preskoceno: true, duvod: 'nahrávka z téhle kamery právě běží' }));
    const d = normDelka(delkaS);
    const p = (async () => {
      const cas = now();
      let data;
      try { cil(volba, kopie); data = await klip(kameraId, d); }
      catch (e) {
        const radek = { Id: nid(cas), KameraID: kameraId, Cas: cas, DelkaS: d, Velikost: 0, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj, Nazev: null, SouborID: null, Url: null, Email: null, Kdo: kdo || null, Chyba: String(e.message || e).slice(0, 300), Uloziste: null, Soubor: null, Mime: null, SmazanoCas: null };
        await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek).catch(() => {});
        log.error('[nahravky]', tenant, kameraId, 'nahrávka se nepořídila:', radek.Chyba);
        return zRadku(radek);
      }
      return uloz(tenant, { kameraId, data, cas, delkaS: d, druh, udalostId, zdroj, kdo, text, uloziste: volba, disk: kopie });
    })().finally(() => bezi.delete(klic));
    bezi.set(klic, p);
    return p;
  }

  /**
   * Nahrávka se nepořídila ještě před klipem (soukromí rodiny, chyba háčku): řádek bez souboru s důvodem,
   * aby to dispečink viděl v Nahrávkách i u události v historii i po restartu serveru.
   */
  async function zapisOdmitnuti(tenant, { kameraId, druh = '', udalostId = '', zdroj = 'udalost', kdo = '', duvod = '' }) {
    const cas = now();
    const radek = { Id: nid(cas), KameraID: kameraId, Cas: cas, DelkaS: 0, Velikost: 0, UdalostId: udalostId || null, Druh: druh || null, Zdroj: zdroj, Nazev: null, SouborID: null, Url: null, Email: null,
      Kdo: kdo || null, Chyba: String(duvod || 'nahrávka neproběhla').slice(0, 300), Uloziste: null, Soubor: null, Mime: null, SmazanoCas: null };
    await tabulky.vloz(tenant, 'A_KAM_Nahravka', radek).catch((e) => log.error('[nahravky]', tenant, 'odmítnutí se nezapsalo:', e.message));
    log.error('[nahravky]', tenant, kameraId, 'nahrávka se nepořídila:', radek.Chyba);
    return zRadku(radek);
  }

  /** Limit místa poskytovatele v GB (poskytovatel.nahravkyGB; 0 = bez limitu). */
  async function gbTenanta(tenant) {
    const r = await tabulky.vyber(tenant, 'A_KAM_Nastaveni', { kde: { Klic: 'poskytovatel.nahravkyGB' }, limit: 1 });
    if (!r.length || r[0].Hodnota === null || r[0].Hodnota === '') return GB_VYCHOZI;
    const n = Number(r[0].Hodnota);
    return Number.isFinite(n) && n >= 0 && n <= 500 ? n : GB_VYCHOZI;
  }

  async function dnyTenanta(tenant) {
    const r = await tabulky.vyber(tenant, 'A_KAM_Nastaveni', { kde: { Klic: 'poskytovatel.nahravkyDny' }, limit: 1 });
    const n = Number(r[0]?.Hodnota);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DNY_VYCHOZI;
  }

  return {
    get nastaveno() { return serverOk() || diskOk(); },
    get uloziste() { return { server: serverOk(), disk: diskOk() }; },
    normDelka, porid, uloz, smiNahravat, cil, zapisOdmitnuti,
    /** Kolik nahrávky tenanta zabírají na serveru a kolik místa VPS má → { soubory, bajty, volne, celkem }. */
    async misto(tenant) {
      const r = await tabulky.vyber(tenant, 'A_KAM_Nahravka', { kde: { Uloziste: 'server', SmazanoCas: null }, limit: 10000 });
      const d = await diskInfo();
      const limitGB = await gbTenanta(tenant).catch(() => GB_VYCHOZI);
      const out = { soubory: r.length, bajty: r.reduce((a, x) => a + (Number(x.Velikost) || 0) + 32, 0), volne: d.volne, celkem: d.celkem, limitGB, minVolneGB: minVolne / GB, varovani: null };
      const fmt = (x) => x >= GB ? (x / GB).toFixed(1).replace('.', ',') + ' GB' : (x / 1048576).toFixed(0) + ' MB';
      if (out.volne !== null && out.volne < minVolne) out.varovani = `Na serveru je málo místa (volné ${fmt(out.volne)}, pojistka ${fmt(minVolne)}): nejstarší nahrávky se mažou dřív než po době uchování. Správce serveru by měl uvolnit disk.`;
      else if (limitGB > 0 && out.bajty >= limitGB * GB) out.varovani = `Nahrávky poskytovatele překročily limit ${fmt(limitGB * GB)}: nejstarší se mažou dřív než po době uchování. Zvyšte limit v Nastavení, nebo zkraťte dobu uchování.`;
      else if (limitGB > 0 && out.bajty >= 0.9 * limitGB * GB) out.varovani = `Nahrávky poskytovatele zabírají ${fmt(out.bajty)} z limitu ${fmt(limitGB * GB)} (přes 90 %); po překročení se nejstarší mažou dřív než po době uchování.`;
      return out;
    },
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
    /**
     * Automatické mazání (každou hodinu, server.mjs), tři kroky:
     *  1. doba uchování: nahrávky starší než nahravkyDny tenanta;
     *  2. limit poskytovatele (nahravkyGB): nad limit se mažou nejstarší nahrávky toho tenanta;
     *  3. pojistka disku: když je na disku VPS volno méně než NAHRAVKY_MIN_VOLNE_GB, mažou se nejstarší
     *     nahrávky napříč poskytovateli, dokud není volno zpět nad hranicí (plný disk by zastavil server).
     * Vrací počet smazaných; podrobnosti do logu serveru.
     */
    async promaz() {
      if (!serverOk()) return 0;
      const vse = await tabulky.vyber('*', 'A_KAM_Nahravka', { kde: { Uloziste: 'server', SmazanoCas: null }, razeni: [['Cas', 'ASC']], limit: 5000 });
      const dny = new Map(), gb = new Map(); let smazano = 0;
      const velikost = (r) => (Number(r.Velikost) || 0) + 32;
      const smazRadek = async (r, proc) => {
        try { await this.smaz(r.IDTENANT, zRadku(r)); smazano++; r.__smazano = true; return true; }
        catch (e) { log.error('[nahravky] mazání', r.IDTENANT, r.Id, `(${proc}):`, e.message); return false; }
      };
      // 1. doba uchování
      let poDobe = 0;
      for (const r of vse) {
        const t = r.IDTENANT;
        if (!dny.has(t)) dny.set(t, await dnyTenanta(t).catch(() => DNY_VYCHOZI));
        if (Number(r.Cas) > now() - dny.get(t) * 86400000) continue;
        if (await smazRadek(r, 'doba uchování')) poDobe++;
      }
      if (poDobe) log.log(`[nahravky] automaticky smazáno ${poDobe} nahrávek po uplynutí doby uchování`);
      // 2. limit poskytovatele (nejstarší první – vse je seřazené vzestupně podle času)
      const soucty = new Map();
      for (const r of vse) if (!r.__smazano) soucty.set(r.IDTENANT, (soucty.get(r.IDTENANT) || 0) + velikost(r));
      for (const [t, suma] of soucty) {
        if (!gb.has(t)) gb.set(t, await gbTenanta(t).catch(() => GB_VYCHOZI));
        const limit = gb.get(t) * GB; if (!limit || suma <= limit) continue;
        let zbyva = suma, n = 0;
        for (const r of vse) { if (zbyva <= limit) break; if (r.__smazano || r.IDTENANT !== t) continue; if (await smazRadek(r, `limit ${gb.get(t)} GB`)) { zbyva -= velikost(r); n++; } }
        log.log(`[nahravky] ${t}: nad limit ${gb.get(t)} GB (${(suma / GB).toFixed(2)} GB) – smazáno ${n} nejstarších nahrávek`);
      }
      // 3. pojistka disku napříč poskytovateli
      if (minVolne > 0) {
        const d = await diskInfo();
        if (d.volne !== null && d.volne < minVolne) {
          let volne = d.volne, n = 0;
          for (const r of vse) { if (volne >= minVolne) break; if (r.__smazano) continue; if (await smazRadek(r, 'málo místa na disku')) { volne += velikost(r); n++; } }
          log.error(`[nahravky] POZOR: na disku je málo místa (volné ${(d.volne / GB).toFixed(2)} GB, pojistka ${(minVolne / GB).toFixed(1)} GB) – smazáno ${n} nejstarších nahrávek napříč poskytovateli${volne < minVolne ? '; nahrávek k mazání už není, uvolněte disk' : ''}`);
        }
      }
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
