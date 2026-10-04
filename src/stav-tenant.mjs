/**
 * Stav jednoho tenanta (poskytovatele) v databázi PeceDomaPlus: kamery se
 * souhlasy, sledováním a kontakty, události a poznámky, žádosti o plný
 * obraz, povolení, notifikace rodiny a nastavení poskytovatele.
 *
 * Akce jsou tytéž jako v prototypu (public/proto/sim-core.js, `proved`):
 * stránky rodiny i dispečinku volají stejná jména se stejnými argumenty.
 * Rozdíl je v uložení: po každé akci se porovná nový stav s tím, co je
 * v databázi (otisk každého řádku), a zapíší se jen změněné řádky
 * (brána src/tabulky.mjs). V paměti se drží posledních 400 událostí, v
 * databázi zůstávají všechny.
 *
 * Fiktivní pacienti prototypu tu nejsou: pacient = kamera tenanta
 * (cameras.json na serveru s polem tenant, řádek A_KAM_Kamera). Skutečné
 * události kamery (ONVIF) sem skládá server při každém dotazu, jako dřív.
 */
import { smiNahravat } from './nahravky.mjs';
import { radekLogu } from './log-udalosti.mjs';
import { proved, AKCE, KINDS, defaultWatch, POSKYTOVATEL_VYCHOZI, DEN_OD, NOC_OD } from '../public/proto/sim-core.js';

// Druh z kamery (cam-…, public/watch.js) → druh v dispečinku (KINDS v sim-core). Co tu není, do dispečinku nejde (jen do logu hlavní aplikace a CLB1).
const MAPA = { 'cam-linecross': 'linecross', 'cam-intrusion': 'intrusion', 'cam-tamper': 'tamper', 'cam-person': 'person', 'cam-motion': 'motion',
  'cam-vehicle': 'vehicle', 'cam-pet': 'pet', 'cam-smart': 'motion', 'cam-babycry': 'babycry', 'cam-sound': 'sound', 'cam-glassbreak': 'glassbreak',
  'cam-bark': 'pet', 'cam-meow': 'pet' };
const UDALOSTI_MAX = 400, ZADOSTI_MAX = 100;
const ZAKAZANE = new Set(['reset']);   // ostrá data tenanta nikdo nevynuluje z prohlížeče
// akce, jejichž první argument je kamera: musí patřit tenantovi (jinak by šlo zapsat událost cizí kameře)
const S_KAMEROU = new Set(['emit', 'setWatch', 'setKontakty', 'setConsent', 'rychle', 'klidDo', 'requestFull', 'emergencyAccess', 'endGrant', 'setWatching', 'setKlid', 'setNote', 'poznamka', 'ackAll']);
const json = (v) => { if (v === null || v === undefined || v === '') return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const otisk = (o) => JSON.stringify(o);

/* ---------- řádky ↔ objekty stavu ---------- */
function radekKamery(p, s) {
  return { KameraID: p.id, Nazev: p.name, Misto: p.place || '', Poznamka: p.note || '', Souhlas: p.consent, Sledovani: p.watch, Kontakty: p.kontakty || null,
    Docasne: p.docasne || null, KlidDo: s.klid[p.id] || null, Offline: !!p.offline, Aktivni: true };
}
function pacientZRadku(r, nazevPoskytovatele) {
  const consent = { den: 'skeleton', noc: 'skeleton', nouze: true, denOd: DEN_OD, nocOd: NOC_OD, ...(json(r.Souhlas) || {}) };
  const p = { id: r.KameraID, name: r.Nazev || r.KameraID, place: r.Misto || '', provider: nazevPoskytovatele, real: true, consent,
    watch: { ...defaultWatch(), ...(json(r.Sledovani) || {}) }, night: false, offline: !!r.Offline, note: r.Poznamka || '' };
  const k = json(r.Kontakty); if (k) p.kontakty = k;
  const d = json(r.Docasne); if (d) p.docasne = d;
  return p;
}
function radekUdalosti(e, notif) {
  return { Id: e.id, KameraID: e.patientId, Cas: e.at, Druh: e.kind, Stav: e.state || null, Kdo: e.by || null, Vysledek: e.result || null, Poznamka: e.note || null,
    Text: e.text || null, Skutecna: !!e.real, Nahravat: !!e.rec, PrevzatoCas: e.takenAt || null, UzavrenoCas: e.closedAt || null, Eskalovano: !!e.escalated,
    Upozorneni: e.upozorneni || null, Notifikace: !!notif, Uroven: KINDS[e.kind]?.level || null, Potvrzeno: notif ? !!notif.ack : false };
}
function udalostZRadku(r) {
  const e = { id: r.Id, at: r.Cas, patientId: r.KameraID, kind: r.Druh, state: r.Stav || 'uzavřen', by: r.Kdo, result: r.Vysledek, note: r.Poznamka || '' };
  if (r.Text) e.text = r.Text;
  if (r.Skutecna) e.real = true;
  if (r.Nahravat) e.rec = true;
  if (r.PrevzatoCas) e.takenAt = r.PrevzatoCas;
  if (r.UzavrenoCas) e.closedAt = r.UzavrenoCas;
  if (r.Eskalovano) e.escalated = true;
  const u = json(r.Upozorneni); if (u) e.upozorneni = u;
  return e;
}
const radekZadosti = (r) => ({ Id: r.id, KameraID: r.patientId, Kdo: r.from, Duvod: r.reason || '', Cas: r.at, PlatiDo: r.until, Stav: r.state, Odpoved: null, OdpovedCas: null });
const zadostZRadku = (r) => ({ id: r.Id, at: r.Cas, patientId: r.KameraID, from: r.Kdo, reason: r.Duvod || '', state: r.Stav, until: r.PlatiDo });
function radekPovoleni(id, g, w) {
  return { KameraID: id, Druh: g ? g.kind : null, Kdo: g ? g.by : null, Od: g ? (g.since || null) : null, DoCas: g ? g.until : null, SledujeKdo: w ? w.who : null, SledujeOd: w ? w.since : null };
}

export function createStavTenantu({ tenant, tabulky, kamery = async () => [], udalosti = null, upozorni = null, nahravky = null, now = Date.now, log = console, nazev = '' }) {
  if (!tenant) throw new Error('Chybí tenant.');
  let data = null;                   // { v, state }
  let otisky = new Map();            // 'tab:klíč' → otisk uloženého řádku
  let realSince = now();
  let fronta = Promise.resolve();
  const serializovane = (fn) => { const p = fronta.then(fn); fronta = p.catch(() => {}); return p; };
  const cekajici = new Set();

  /* ---------- načtení ---------- */
  async function nacti() {
    if (data) return data;
    const t = now();
    const nastaveni = Object.fromEntries((await tabulky.vyber(tenant, 'A_KAM_Nastaveni')).map((r) => [r.Klic, r.Hodnota]));
    const poskytovatel = { ...POSKYTOVATEL_VYCHOZI, nazev: nazev || POSKYTOVATEL_VYCHOZI.nazev, telefon: '', email: '', dispecer: 'Dispečink', smena: '', zaloha: '', zalohaTelefon: '', vedouci: '', vedouciTelefon: '' };
    for (const k of Object.keys(POSKYTOVATEL_VYCHOZI)) if (nastaveni['poskytovatel.' + k] !== undefined && nastaveni['poskytovatel.' + k] !== null) poskytovatel[k] = (k === 'eskalaceMin' || k === 'nahravkaS' || k === 'nahravkyDny') ? Number(nastaveni['poskytovatel.' + k]) || POSKYTOVATEL_VYCHOZI[k] : k === 'nahravkyGB' ? (Number.isFinite(Number(nastaveni['poskytovatel.' + k])) ? Number(nastaveni['poskytovatel.' + k]) : POSKYTOVATEL_VYCHOZI[k]) : k === 'nahravkyDisk' ? String(nastaveni['poskytovatel.' + k]) === 'true' : nastaveni['poskytovatel.' + k];
    const kam = (await tabulky.vyber(tenant, 'A_KAM_Kamera', { razeni: [['Nazev', 'ASC']] })).filter((r) => r.Aktivni !== false);
    const patients = kam.map((r) => pacientZRadku(r, poskytovatel.nazev));
    const klid = {}; for (const r of kam) if (r.KlidDo && r.KlidDo > t) klid[r.KameraID] = r.KlidDo;
    const ud = await tabulky.vyber(tenant, 'A_KAM_Udalost', { razeni: [['Cas', 'DESC']], limit: UDALOSTI_MAX });
    const events = ud.map(udalostZRadku);
    // odkazy na nahrávky k událostem (tabulka A_KAM_Nahravka; do řádku události se nepíší)
    if (nahravky) {
      const podleUdalosti = new Map();
      for (const n of await nahravky.seznam(tenant, { limit: 300 }).catch(() => [])) if (n.udalostId && !podleUdalosti.has(n.udalostId)) podleUdalosti.set(n.udalostId, n);
      for (const e of events) { const n = podleUdalosti.get(e.id); if (n) e.nahravka = { id: n.id, url: n.url, nazev: n.nazev, delkaS: n.delkaS, chyba: n.chyba, uloziste: n.uloziste, smazano: !!n.smazanoCas }; }
    }
    const zad = await tabulky.vyber(tenant, 'A_KAM_Zadost', { razeni: [['Cas', 'DESC']], limit: ZADOSTI_MAX });
    const requests = zad.map(zadostZRadku);
    const pov = await tabulky.vyber(tenant, 'A_KAM_Povoleni');
    const grants = {}, watching = {};
    for (const r of pov) {
      if (r.DoCas && r.DoCas > t) grants[r.KameraID] = { mode: 'full', until: r.DoCas, by: r.Kdo || '', kind: r.Druh || 'souhlas rodiny', since: r.Od || undefined };
      if (r.SledujeKdo && grants[r.KameraID]) watching[r.KameraID] = { who: r.SledujeKdo, since: r.SledujeOd || t };
    }
    let notifications = json(nastaveni.notifikace) || [];
    if (!Array.isArray(notifications)) notifications = [];
    const state = { patients, events, notifications, requests, grants, klid, watching, night: false, seq: 1 + ud.length + zad.length, seededAt: t, poskytovatel };
    data = { v: Math.floor(t / 1000), state };
    // otisky toho, co v databázi je
    otisky = new Map();
    for (const r of kam) { const p = patients.find((x) => x.id === r.KameraID); otisky.set('k:' + r.KameraID, otisk(radekKamery(p, state))); }
    for (const e of events) otisky.set('u:' + e.id, otisk(radekUdalosti(e, notifications.find((n) => n.eventId === e.id))));
    for (const r of requests) otisky.set('z:' + r.id, otisk(radekZadosti(r)));
    for (const r of pov) otisky.set('p:' + r.KameraID, otisk(radekPovoleni(r.KameraID, grants[r.KameraID], watching[r.KameraID])));
    for (const k of Object.keys(POSKYTOVATEL_VYCHOZI)) otisky.set('n:poskytovatel.' + k, otisk(String(poskytovatel[k])));
    otisky.set('n:notifikace', otisk(notifications));
    await doplnKamery();
    return data;
  }

  /** Kamery tenanta ze serveru (cameras.json), které v databázi ještě nejsou, dostanou řádek s výchozím nastavením. */
  async function doplnKamery() {
    let zmena = false;
    for (const k of await kamery()) {
      if (data.state.patients.some((p) => p.id === k.id)) continue;
      proved(data.state, 'ensurePatient', [{ id: k.id, name: k.name }], now());
      const p = data.state.patients.find((x) => x.id === k.id);
      if (p) { p.provider = data.state.poskytovatel.nazev; p.place = k.place || p.place; zmena = true; }
    }
    if (zmena) { data.v++; await uloz(); }
  }

  /* ---------- rozdílový zápis ---------- */
  async function uloz() {
    const s = data.state;
    for (const p of s.patients) {
      const r = radekKamery(p, s), o = otisk(r), k = 'k:' + p.id;
      if (otisky.get(k) !== o) { await tabulky.ulozit(tenant, 'A_KAM_Kamera', { ...r, Zmeneno: now() }); otisky.set(k, o); }
    }
    for (const e of s.events) {
      const r = radekUdalosti(e, s.notifications.find((n) => n.eventId === e.id)), o = otisk(r), k = 'u:' + e.id;
      if (!otisky.has(k)) await tabulky.vloz(tenant, 'A_KAM_Udalost', r);
      else if (otisky.get(k) !== o) { const { Id, ...zmeny } = r; await tabulky.uprav(tenant, 'A_KAM_Udalost', { Id }, zmeny); }
      otisky.set(k, o);
    }
    for (const z of s.requests) {
      const r = radekZadosti(z), o = otisk(r), k = 'z:' + z.id;
      if (otisky.get(k) !== o) { await tabulky.ulozit(tenant, 'A_KAM_Zadost', r); otisky.set(k, o); }
    }
    const ids = new Set([...Object.keys(s.grants), ...Object.keys(s.watching)]);
    for (const id of ids) {
      const r = radekPovoleni(id, s.grants[id], s.watching[id]), o = otisk(r), k = 'p:' + id;
      if (otisky.get(k) !== o) { await tabulky.ulozit(tenant, 'A_KAM_Povoleni', r); otisky.set(k, o); }
    }
    for (const k of [...otisky.keys()]) if (k.startsWith('p:') && !ids.has(k.slice(2))) { await tabulky.smaz(tenant, 'A_KAM_Povoleni', { KameraID: k.slice(2) }); otisky.delete(k); }
    for (const k of Object.keys(POSKYTOVATEL_VYCHOZI)) {
      const o = otisk(String(s.poskytovatel?.[k] ?? ''));
      if (otisky.get('n:poskytovatel.' + k) !== o) { await tabulky.ulozit(tenant, 'A_KAM_Nastaveni', { Klic: 'poskytovatel.' + k, Hodnota: String(s.poskytovatel?.[k] ?? '') }); otisky.set('n:poskytovatel.' + k, o); }
    }
    const on = otisk(s.notifications);
    if (otisky.get('n:notifikace') !== on) { await tabulky.ulozit(tenant, 'A_KAM_Nastaveni', { Klic: 'notifikace', Hodnota: s.notifications }); otisky.set('n:notifikace', on); }
  }

  /* ---------- upozornění SMS / e-mailem (mimo frontu, výsledek k události) ---------- */
  function upozorneni(ev) {
    if (!upozorni || !ev || !ev.id) return;
    const p = Promise.resolve().then(() => upozorni.posli(data.state, ev)).then((vysledek) => {
      if (!vysledek) return;
      return serializovane(async () => {
        const e = data.state.events.find((x) => x.id === ev.id);
        if (!e) return;
        e.upozorneni = vysledek; data.v++;
        await uloz();
      });
    }).catch((e) => { if (log && log.error) log.error('[upozorneni]', tenant, e.message); }).finally(() => cekajici.delete(p));
    cekajici.add(p);
  }

  /* ---------- nahrávka po události (mimo frontu, odkaz k události) ---------- */
  function nahravani(ev, kdo = '') {
    if (!ev || !ev.id) return;
    const s = data.state;
    const p = s.patients.find((x) => x.id === ev.patientId);
    const zapis = (n) => serializovane(async () => {
      const e = data.state.events.find((x) => x.id === ev.id);
      if (!e) return;
      e.nahravka = n; data.v++;
    });
    // Každý krok do logu serveru (pm2 logs): proč se po události nahrávalo, nebo ne.
    const hlas = (text) => { if (log && log.log) log.log('[nahravky]', tenant, ev.patientId, `${ev.kind}:`, text); };
    if (!ev.rec) { hlas('nenahrává se (u události není zatržené Nahrávat)'); return; }
    if (!nahravky) { hlas('nenahrává se (nahrávky nejsou na serveru nastavené)'); zapis({ chyba: 'nenahráno: nahrávky nejsou na serveru nastavené' }); return; }
    // Odmítnutí i chyba se zapíší jako řádek bez souboru (A_KAM_Nahravka), aby důvod byl vidět i po restartu serveru.
    const odmitni = (duvod) => { hlas(duvod); return Promise.resolve().then(() => nahravky.zapisOdmitnuti(tenant, { kameraId: ev.patientId, druh: ev.kind, udalostId: ev.id, kdo, duvod }))
      .then((n) => zapis({ id: n?.id, chyba: n?.chyba || duvod }), () => zapis({ chyba: duvod })); };
    const smi = smiNahravat(s, p, ev.kind, now(), { skutecna: !!ev.real });
    if (!smi.ok) { const pr = odmitni(`nenahráno: ${smi.duvod}`).finally(() => cekajici.delete(pr)); cekajici.add(pr); return; }
    hlas(`nahrávám ${s.poskytovatel?.nahravkaS || ''} s (${smi.nouze ? 'kritická událost s nouzovým přístupem' : 'plný obraz'})`);
    const pr = Promise.resolve().then(() => nahravky.porid(tenant, { kameraId: ev.patientId, delkaS: s.poskytovatel?.nahravkaS, uloziste: s.poskytovatel?.nahravkyUloziste, disk: !!s.poskytovatel?.nahravkyDisk, druh: ev.kind, udalostId: ev.id, zdroj: 'udalost', kdo, text: ev.text || '' }))
      .then((n) => {
        if (!n || n.preskoceno) return odmitni(`nenahráno: ${n?.duvod || 'nahrávka neproběhla'}`);
        hlas(n.chyba ? `chyba: ${n.chyba}` : `uloženo (${n.uloziste || 'disk'}, ${n.delkaS} s, ${Math.round((n.velikost || 0) / 1024)} kB)`);
        return zapis({ id: n.id, url: n.url, nazev: n.nazev, delkaS: n.delkaS, chyba: n.chyba, uloziste: n.uloziste });
      })
      .catch((e) => { if (log && log.error) log.error('[nahravky]', tenant, ev.patientId, 'nahrávka po události selhala:', e.message); return odmitni(`nenahráno: ${e.message}`); })
      .finally(() => cekajici.delete(pr));
    cekajici.add(pr);
  }

  /** Vypršení, eskalace, nové skutečné události kamer tenanta. */
  async function udrzba() {
    let zmena = proved(data.state, 'tick', [], now()).zmena;
    if (udalosti) {
      const moje = new Set(data.state.patients.map((p) => p.id));
      for (const ev of udalosti.nedavne(realSince)) {
        realSince = Math.max(realSince, ev.prijato);
        const kind = MAPA[ev.kind]; if (!kind || !moje.has(ev.kameraId)) continue;
        try {
          const out = proved(data.state, 'emit', [ev.kameraId, kind, { real: true, text: ev.text }], now());
          upozorneni(out.vysledek);
          nahravani(out.vysledek);
          zmena = true;
        } catch (e) { log.error('[stav-tenant]', tenant, 'událost kamery se nezapsala:', e.message); }
      }
    }
    if (zmena) { data.v++; await uloz(); }
    return zmena;
  }

  return {
    tenant,
    stav() {
      return serializovane(async () => { await nacti(); await udrzba(); return { v: data.v, state: data.state }; });
    },
    proved(akce, args) {
      return serializovane(async () => {
        await nacti();
        if (typeof akce !== 'string' || !AKCE.includes(akce) || ZAKAZANE.has(akce)) { const e = new Error('Neznámá akce.'); e.status = 400; throw e; }
        await udrzba();
        if (S_KAMEROU.has(akce) && !data.state.patients.some((p) => p.id === args?.[0])) { const e = new Error('Neznámá kamera.'); e.status = 404; throw e; }
        if (akce === 'ensurePatient') {
          const id = args?.[0]?.id;
          if (!(await kamery()).some((k) => k.id === id)) { const e = new Error('Kamera nepatří tomuto poskytovateli.'); e.status = 403; throw e; }
        }
        const out = proved(data.state, akce, args, now());
        data.state = out.state;
        if (out.zmena) { data.v++; await uloz(); }
        if (akce === 'emit') { upozorneni(out.vysledek); nahravani(out.vysledek); }
        return { v: data.v, state: data.state, vysledek: out.vysledek };
      });
    },
    /**
     * Log událostí za období (ms od–do včetně) přímo z databáze, ne jen posledních pár set v paměti:
     * jedna kamera nebo všechny; nejnovější první. Řádky jsou hotové pro stránku i Excel (radekLogu).
     */
    vypisUdalosti({ od = 0, do: doMs = Number.MAX_SAFE_INTEGER, kameraId = '', limit = 5000 } = {}) {
      return serializovane(async () => {
        await nacti();
        const kde = { Cas: { od: Math.max(0, Number(od) || 0), do: Number.isFinite(doMs) ? doMs : Number.MAX_SAFE_INTEGER } };
        if (kameraId) kde.KameraID = kameraId;
        const ud = await tabulky.vyber(tenant, 'A_KAM_Udalost', { kde, razeni: [['Cas', 'DESC']], limit: Math.min(10000, Math.max(1, limit)) });
        const nahr = new Map();
        if (nahravky && ud.length) {
          const n = await tabulky.vyber(tenant, 'A_KAM_Nahravka', { kde: { Cas: { od: kde.Cas.od, do: Math.min(kde.Cas.do + 3600000, Number.MAX_SAFE_INTEGER) }, ...(kameraId ? { KameraID: kameraId } : {}) }, razeni: [['Cas', 'ASC']], limit: 10000 }).catch(() => []);
          for (const r of n) if (r.UdalostId && !nahr.has(r.UdalostId)) nahr.set(r.UdalostId, { chyba: r.Chyba || null, uloziste: r.Uloziste || (r.Url ? 'disk' : null), delkaS: r.DelkaS, smazanoCas: r.SmazanoCas || null, url: r.Url || null, id: r.Id });
        }
        const jmena = new Map(data.state.patients.map((p) => [p.id, p.name]));
        return ud.map((r) => { const e = udalostZRadku(r); return radekLogu(e, jmena.get(e.patientId), nahr.get(e.id) || null); });
      });
    },
    /** Kamery tenanta přibyly nebo ubyly (cameras.json): doplní řádky. */
    obnovKamery() { return serializovane(async () => { await nacti(); await doplnKamery(); }); },
    async hotovo() { await Promise.all([...cekajici]); await fronta; },
    AKCE,
  };
}
