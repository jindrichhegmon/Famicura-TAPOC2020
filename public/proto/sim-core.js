/*
 * Jádro simulace prototypu: data i akce bez prohlížeče, aby stejný kód běžel
 * v prohlížeči (sim.js) i na serveru (src/stav-tenant.mjs). Na serveru je stav
 * sdílený: souhlas, který rodina nastaví na telefonu, vidí dispečink na Macu.
 */
export const TZ = 'Europe/Prague';

export const KINDS = {
  fall:       { label: 'Možný pád',                    level: 'crit', source: 'analýza' },
  longlie:    { label: 'Dlouhé ležení mimo postel',    level: 'crit', source: 'analýza' },
  sos:        { label: 'Nouzové tlačítko',             level: 'crit', source: 'náramek' },
  devfall:    { label: 'Pád hlášený náramkem',         level: 'crit', source: 'náramek' },
  inactivity: { label: 'Nečinnost',                    level: 'warn', source: 'analýza' },
  linecross:  { label: 'Překročení čáry',              level: 'warn', source: 'kamera' },
  intrusion:  { label: 'Vstup do hlídané oblasti',     level: 'warn', source: 'kamera' },
  tamper:     { label: 'Zakrytí nebo posunutí kamery', level: 'warn', source: 'kamera' },
  babycry:    { label: 'Pláč',                         level: 'warn', source: 'kamera' },
  sound:      { label: 'Hlasitý nebo neobvyklý zvuk',  level: 'warn', source: 'kamera' },
  glassbreak: { label: 'Rozbití skla',                 level: 'warn', source: 'kamera' },
  missing:    { label: 'Ztráta postavy',               level: 'info', source: 'analýza' },
  state:      { label: 'Změna polohy',                 level: 'info', source: 'analýza' },
  person:     { label: 'Osoba',                        level: 'info', source: 'kamera' },
  motion:     { label: 'Pohyb',                        level: 'info', source: 'kamera' },
  vehicle:    { label: 'Vozidlo',                      level: 'info', source: 'kamera' },
  pet:        { label: 'Zvíře',                        level: 'info', source: 'kamera' },
  nahravka:   { label: 'Ruční nahrávka',               level: 'info', source: 'ručně' },
  offline:    { label: 'Kamera nedostupná',            level: 'tech', source: 'systém' },
  online:     { label: 'Kamera opět dostupná',         level: 'tech', source: 'systém' },
  battery:    { label: 'Slabá baterie náramku',        level: 'tech', source: 'náramek' },
  mereni:     { label: 'Měření náramku',               level: 'info', source: 'náramek' },
};
/** Úroveň události pro zobrazení: řádek „mimo hlídané hodiny“ je vždy informativní. */
export const urovenUdalosti = (e) => e?.mimoHodiny ? 'info' : (KINDS[e?.kind]?.level || null);
/** Meze zdravotních hodnot z náramku: v „ok“ je hodnota v pořádku, mimo „ok“ ale v „varovani“ je oranžová (špatná),
 *  mimo „varovani“ červená (moc špatná). Orientační rozmezí pro dospělé; tlakS/tlakD = horní/dolní tlak (mmHg), spo2 = kyslík (%), teplota (°C). */
export const MEZE_ZDRAVI = {
  tep: { ok: [50, 100], varovani: [40, 120], jednotka: '/min' },
  tlakS: { ok: [90, 139], varovani: [80, 159], jednotka: 'mmHg' },
  tlakD: { ok: [60, 89], varovani: [50, 99], jednotka: 'mmHg' },
  spo2: { ok: [94, 100], varovani: [90, 100], jednotka: '%' },
  teplota: { ok: [35.5, 37.4], varovani: [35.0, 38.4], jednotka: '°C' },
};
/** 'ok' | 'warn' (oranžově) | 'bad' (červeně) | '' (neznámá veličina nebo nečíslo). */
export function urovenHodnoty(k, v) {
  const m = MEZE_ZDRAVI[k]; const n = Number(v);
  if (!m || v === null || v === undefined || !Number.isFinite(n)) return '';
  if (n < m.varovani[0] || n > m.varovani[1]) return 'bad';
  if (n < m.ok[0] || n > m.ok[1]) return 'warn';
  return 'ok';
}
export const LEVEL_LABEL = { crit: 'kritická', warn: 'varování', info: 'informativní', tech: 'technická' };
export const CONSENT = { none: 'žádný obraz (jen události)', skeleton: 'drátěný model', blur: 'rozostření', full: 'plný obraz' };

/** What the provider watches for a patient: on/off, hours, recording. The family only reads it. */
/* Pořadí = pořadí v tabulce Nastavení. Z kamery (Tapo přes ONVIF): překročení čáry,
 * vstup do hlídané oblasti, zakrytí, pláč, zvuk, rozbití skla, osoba, pohyb, vozidlo, zvíře. */
export const WATCH_KINDS = ['fall', 'longlie', 'sos', 'devfall', 'inactivity', 'linecross', 'intrusion', 'tamper', 'babycry', 'sound', 'glassbreak', 'missing', 'state', 'person', 'motion', 'vehicle', 'pet'];
export function defaultWatch() {
  const w = {};
  // sms/mail: upozornění na kontakty kamery (p.kontakty); výchozí jen u kritických, a jen když jsou kontakty vyplněné
  for (const k of WATCH_KINDS) w[k] = { on: true, from: '', to: '', rec: KINDS[k].level === 'crit' || k === 'linecross', sms: KINDS[k].level === 'crit', mail: KINDS[k].level === 'crit' };
  w.linecross = { on: true, from: '07:00', to: '20:00', rec: true, sms: false, mail: false };
  w.intrusion = { on: true, from: '', to: '', rec: true, sms: false, mail: false };
  w.motion = { on: false, from: '', to: '', rec: false, sms: false, mail: false };
  w.state = { on: false, from: '', to: '', rec: false, sms: false, mail: false };
  // vozidlo a zvíře nejsou v péči o klienta důvod k alertu; kdo chce, zapne je
  w.vehicle = { on: false, from: '', to: '', rec: false, sms: false, mail: false };
  w.pet = { on: false, from: '', to: '', rec: false, sms: false, mail: false };
  return w;
}
export function describeWatch(w) {
  const hodiny = (r) => { const t = oknaText(r); return t ? ` ${t}` : ''; };
  const ma = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
  const on = WATCH_KINDS.filter((k) => w[k]?.on).map((k) => KINDS[k].label.toLowerCase() + hodiny(w[k]) + (w[k].rec ? ' 🎞' : '') + (ma(w[k].sms) ? ' 📱' : '') + (ma(w[k].mail) ? ' ✉' : ''));
  return on.length ? on.join(', ') : 'nic';
}

/* ---------- kontakty kamery: rodina (5× jméno + telefon), telefony poskytovatele, dvě sady e-mailů ----------
 * Zadává poskytovatel v dispečinku (Komunikace → Kontakty, sekce Rodina / Poskytovatel /
 * E-maily). Telefony poskytovatele (dispečink, služba, administrace) jsou společné pro
 * všechny kamery (s.poskytovatel) a každý má zdroj: vlastní číslo, Péče doma (kontaktní
 * telefon poskytovatele v databázi Péče doma, bez tenanta) nebo Péče doma plus (telefon
 * v nastavení tenanta; dosadí server, src/sluzba.mjs). Příjemci upozornění se pak u každé
 * události v Nastavení vybírají zvlášť: SMS = jednotliví lidé z rodiny, dispečink, služba,
 * administrace; e-mail = sada 1 / sada 2. Čísla SOS náramku se vybírají ze stejné nabídky.
 * Starší tvar { sms: [tel], mail: [adresa] } se čte dál: čísla jako rodina bez jmen,
 * adresy jako sada 1; starší zatržení sms: true = celá rodina, mail: true = obě sady. */
export const KONTAKTY_MAX = 3;            // starší limit (jen pro čtení starého tvaru)
export const KONTAKTY_RODINA_MAX = 5;
export const MAILY_SADA_MAX = 10;
export const ROLE_POSKYTOVATELE = ['dispecink', 'sluzba', 'administrace'];
export const POPIS_ROLE = { dispecink: 'dispečink', sluzba: 'služba', administrace: 'administrace' };
export const ZDROJE_TELEFONU = ['vlastni', 'pecedoma', 'pecedomaplus'];
export const POPIS_ZDROJE_TELEFONU = { vlastni: 'vlastní číslo', pecedoma: 'Péče doma', pecedomaplus: 'Péče doma plus' };
export const SMS_PRIJEMCI = ['r1', 'r2', 'r3', 'r4', 'r5', ...ROLE_POSKYTOVATELE];
/** Příjemce SMS „účet rodiny“: u:<id účtu z Uživatelů rodiny> – telefon dosadí server z účtu (src/upozorneni.mjs), takže platí vždy ten aktuální. */
export const jeUcetPrijemce = (id) => /^u:[a-z0-9]{1,40}$/.test(String(id || ''));
export const SOS_VOLBY = SMS_PRIJEMCI;    // slot SOS náramku: tytéž ID (člověk z rodiny, nebo telefon poskytovatele)
export const MAIL_SADY = ['s1', 's2'];
export const prazdneKontakty = () => ({ rodina: Array.from({ length: KONTAKTY_RODINA_MAX }, () => ({ jmeno: '', telefon: '' })), maily1: [], maily2: [] });
export function normalizeTelefonCz(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00420')) d = d.slice(5); else if (d.startsWith('420') && d.length === 12) d = d.slice(3);
  return /^[1-9]\d{8}$/.test(d) ? d : null;
}
export const jeEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,100}\.[a-z]{2,24}$/i.test(String(v || ''));
/** Seznam e-mailů z textu odděleného čárkou, středníkem nebo mezerou (nebo z pole). */
export const rozdelMaily = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((m) => String(m || '').trim()).filter(Boolean);
export const formatTelefon = (n) => String(n || '').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
/** Telefon SIM karty v náramku v mezinárodním tvaru ('' = nezadaný): české 9 číslic dostane +420, 00… se převede na +…; nesmysl vyhodí chybu. */
export function telefonNaramku(raw) {
  let t = String(raw ?? '').replace(/[\s\-()./]/g, '');
  if (!t) return '';
  if (/^00\d{6,15}$/.test(t)) t = '+' + t.slice(2);
  if (/^\d{9}$/.test(t)) t = '+420' + t;
  if (!/^\+\d{6,15}$/.test(t)) throw chyba('Telefon náramku: 9 číslic českého čísla (777 123 456), nebo mezinárodní tvar +420…');
  return t;
}
/** +420777123456 → +420 777 123 456 (jiné tvary beze změny). */
export const formatTelefonMez = (t) => String(t || '').replace(/^(\+420)(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
/** Kontakty kamery v novém tvaru (rodina vždy 5 pozic, prázdné povolené). */
export function kontaktyPro(p) {
  const k = p?.kontakty || {};
  const z = prazdneKontakty();
  const rodina = Array.isArray(k.rodina) ? k.rodina : Array.isArray(k.sms) ? k.sms.map((t) => ({ jmeno: '', telefon: t })) : [];
  for (let i = 0; i < KONTAKTY_RODINA_MAX; i++) { const r = rodina[i]; if (r && typeof r === 'object') z.rodina[i] = { jmeno: String(r.jmeno || ''), telefon: String(r.telefon || '') }; }
  z.maily1 = (Array.isArray(k.maily1) ? k.maily1 : Array.isArray(k.mail) ? k.mail : []).filter(Boolean);
  z.maily2 = (Array.isArray(k.maily2) ? k.maily2 : []).filter(Boolean);
  return z;
}
/** Členové rodiny s telefonem: [{ id: 'r1', jmeno, telefon }]. */
export const rodinaSTelefonem = (p) => kontaktyPro(p).rodina.map((r, i) => ({ id: 'r' + (i + 1), ...r })).filter((r) => r.telefon);
export const popisPrijemce = (r) => r.jmeno ? `${r.jmeno} ${formatTelefon(r.telefon)}` : formatTelefon(r.telefon);
export function describeKontakty(p) {
  const k = kontaktyPro(p);
  const casti = [];
  const rod = rodinaSTelefonem(p);
  if (rod.length) casti.push('rodina: ' + rod.map(popisPrijemce).join(', '));
  if (k.maily1.length) casti.push('e-maily 1: ' + k.maily1.join(', '));
  if (k.maily2.length) casti.push('e-maily 2: ' + k.maily2.join(', '));
  return casti.join(' · ');
}
/** Výchozí zatržení: kritické události upozorňují (celá rodina, obě sady), ostatní ne. */
export const upozorneniVychozi = (kind) => KINDS[kind]?.level === 'crit';
/** Seznam ID příjemců SMS z nastavení události: pole ID, nebo starší true = celá rodina. */
export function smsIdsPro(w, kind, p) {
  const v = w?.sms ?? upozorneniVychozi(kind);
  if (Array.isArray(v)) return v.filter((x) => SMS_PRIJEMCI.includes(x) || jeUcetPrijemce(x));
  return v ? rodinaSTelefonem(p).map((r) => r.id) : [];
}
export function mailIdsPro(w, kind) {
  const v = w?.mail ?? upozorneniVychozi(kind);
  if (Array.isArray(v)) return v.filter((x) => MAIL_SADY.includes(x));
  return v ? [...MAIL_SADY] : [];
}
/** Pole poskytovatele pro roli: { telefon: klíč vlastního čísla, zdroj: klíč zdroje }. */
export const POLE_ROLE = { dispecink: { telefon: 'telefon', zdroj: 'dispecinkZdroj' }, sluzba: { telefon: 'sluzbaTelefon', zdroj: 'sluzbaZdroj' }, administrace: { telefon: 'administraceTelefon', zdroj: 'administraceZdroj' } };
/** Telefony poskytovatele (Kontakty → Poskytovatel): { dispecink: { zdroj, telefon }, sluzba: …, administrace: … };
 *  telefon = vlastní číslo (9 číslic) jen u zdroje vlastní, u Péče doma / Péče doma plus '' – dosadí server (src/sluzba.mjs). */
export function telefonyPoskytovatele(s) {
  const posk = poskytovatel(s); const out = {};
  for (const role of ROLE_POSKYTOVATELE) {
    const zdroj = ['pecedoma', 'pecedomaplus'].includes(posk[POLE_ROLE[role].zdroj]) ? posk[POLE_ROLE[role].zdroj] : 'vlastni';
    out[role] = { zdroj, telefon: zdroj === 'vlastni' ? (normalizeTelefonCz(posk[POLE_ROLE[role].telefon]) || '') : '' };
  }
  return out;
}
/** Popis telefonu poskytovatele pro roli do textu: „312 123 456“, „z Péče doma plus“, „není“. */
export function popisTelefonuRole(tp, role) {
  const t = tp[role]; if (!t) return 'není';
  return t.telefon ? formatTelefon(t.telefon) : t.zdroj !== 'vlastni' ? `z ${POPIS_ZDROJE_TELEFONU[t.zdroj]}` : 'není';
}
/** Co znamená hodnota slotu SOS pro tuhle kameru: { telefon: '+420…' | '', zdroj: 'pecedoma' | 'pecedomaplus' | null, role, popis }.
 *  'r1'–'r5' = člověk z rodiny (jeho mobil), 'dispecink' / 'sluzba' / 'administrace' = telefon poskytovatele (vlastní, nebo zdroj → dosadí server),
 *  starší zápisy: číslo napřímo, 'pecedoma' / 'pecedomaplus' = číslo služby z daného zdroje. telefon i zdroj prázdné = slot prázdný. */
export function cisloSosPro(s, p, v) {
  const c = String(v ?? '').replace(/[\s-]/g, '');
  const mezin = (t) => (t ? '+420' + t : '');
  if (!c) return { telefon: '', zdroj: null, role: null, popis: '' };
  if (/^r[1-5]$/.test(c)) { const r = kontaktyPro(p).rodina[Number(c[1]) - 1]; return { telefon: mezin(r?.telefon || ''), zdroj: null, role: null, popis: r?.telefon ? popisPrijemce(r) : 'rodina ' + c[1] + ' (bez telefonu)' }; }
  if (ROLE_POSKYTOVATELE.includes(c)) {
    const t = telefonyPoskytovatele(s)[c];
    if (t.zdroj === 'vlastni') return { telefon: mezin(t.telefon), zdroj: null, role: c, popis: `${POPIS_ROLE[c]} ${t.telefon ? formatTelefon(t.telefon) : '(bez telefonu)'}` };
    return { telefon: '', zdroj: t.zdroj, role: c, popis: `${POPIS_ROLE[c]} (${POPIS_ZDROJE_TELEFONU[t.zdroj]})` };
  }
  if (c === 'pecedoma' || c === 'pecedomaplus') return { telefon: '', zdroj: c, role: 'sluzba', popis: `číslo služby (${POPIS_ZDROJE_TELEFONU[c]})` };
  return { telefon: c, zdroj: null, role: null, popis: c };
}
/** Komu a jak má jít upozornění na tuhle událost; null = nikomu.
 *  sms = telefony (9 číslic), smsZdroje = telefony poskytovatele, které musí dosadit server [{ id: role, zdroj: 'pecedoma' | 'pecedomaplus' }], mail = adresy. */
export function upozorneniPro(s, ev) {
  if (!ev || ev.mimoHodiny) return null;
  const p = najdi(s, ev.patientId); if (!p) return null;
  const w = p.watch?.[ev.kind]; if (!w) return null;
  const k = kontaktyPro(p);
  const ids = smsIdsPro(w, ev.kind, p), mids = mailIdsPro(w, ev.kind);
  const tp = telefonyPoskytovatele(s);
  const sms = []; const komu = []; const smsZdroje = []; const smsUcty = [];
  for (const id of ids) {
    if (/^r[1-5]$/.test(id)) { const r = k.rodina[Number(id[1]) - 1]; if (r?.telefon) { sms.push(r.telefon); komu.push(r.jmeno || formatTelefon(r.telefon)); } }
    else if (jeUcetPrijemce(id)) smsUcty.push(id.slice(2));   // telefon z účtu rodiny dosadí server
    else if (ROLE_POSKYTOVATELE.includes(id)) {
      const t = tp[id];
      if (t.telefon) { sms.push(t.telefon); komu.push(POPIS_ROLE[id]); }
      else if (t.zdroj !== 'vlastni') { smsZdroje.push({ id, zdroj: t.zdroj }); komu.push(POPIS_ROLE[id]); }
    }
  }
  const mail = [...new Set([...(mids.includes('s1') ? k.maily1 : []), ...(mids.includes('s2') ? k.maily2 : [])])];
  if (!sms.length && !smsZdroje.length && !smsUcty.length && !mail.length) return null;
  return { sms: [...new Set(sms)], smsZdroje, smsUcty, mail, komu, kind: ev.kind, label: KINDS[ev.kind]?.label || ev.kind, level: KINDS[ev.kind]?.level || 'info', patient: p };
}

/* Hodiny vždy pražské: server na VPS běží v UTC a „noc 22–6“ nebo „jen 7:00–20:00“
 * musí platit pro byt klienta, ne pro server. */
const fmtCas = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function minutaDne(d = new Date()) {
  let h = 0, m = 0;
  for (const p of fmtCas.formatToParts(d)) { if (p.type === 'hour') h = Number(p.value); if (p.type === 'minute') m = Number(p.value); }
  return (h % 24) * 60 + m;
}
export function jeNoc(d = new Date()) { const h = Math.floor(minutaDne(d) / 60); return h >= 22 || h < 6; }

const casText = (ms) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export { casText };

/* Den a noc si rodina nastaví sama (výchozí den od 06:00, noc od 22:00). */
export const DEN_OD = '06:00', NOC_OD = '22:00';
const minuty = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export function casy(p) { const c = p?.consent || {}; return { denOd: c.denOd || DEN_OD, nocOd: c.nocOd || NOC_OD }; }
export function jeNocPro(p, d = new Date()) {
  const { denOd, nocOd } = casy(p);
  const m = minutaDne(d), n = minuty(nocOd), den = minuty(denOd);
  return n > den ? (m >= n || m < den) : (m >= n && m < den);
}
/** Okamžik (ms), kdy je v Praze příště HH:MM (dnes, pokud ještě nebylo, jinak zítra). */
export function pristeV(hhmm, now = Date.now()) {
  const d = new Date(now);
  const cil = minuty(hhmm), ted = minutaDne(d);
  const zaMin = cil > ted ? cil - ted : cil - ted + 1440;
  const t = new Date(now + zaMin * 60000);
  return t.getTime() - (minutaDne(t) - cil) * 60000;   // dorovnání, kdyby se mezitím měnil letní čas
}
/** Příští střídání den/noc pro pacienta. */
export function dalsiHranice(p, now = Date.now()) { const { denOd, nocOd } = casy(p); return Math.min(pristeV(denOd, now), pristeV(nocOd, now)); }
export const KLID_NAVZDY = 4102444800000;   // „do vypnutí“: rok 2100
export const RYCHLE = ['full', 'blur', 'skeleton'];

/** Co poskytovatel vidí teď: povolení z žádosti > rychlé přepnutí rodiny > výpadek > nastavení podle denní doby. */
export function efektivni(s, p, now = Date.now(), nocSimulovana = false) {
  if (!p) return { mode: 'none', proc: 'neznámý pacient' };
  if (p.deaktivace) return { mode: 'none', proc: `kamera deaktivovaná rodinou od ${casText(p.deaktivace.od)} – bez obrazu, nahrávek a událostí`, zdroj: 'deaktivace', od: p.deaktivace.od };
  const g = s.grants[p.id];
  if (g && g.until > now) return { mode: g.mode, proc: grantText(g), do: g.until, zdroj: 'povoleni' };
  const r = p.docasne;
  if (r && r.until > now) return { mode: r.mode, proc: `${CONSENT[r.mode]} – rychlé přepnutí do ${casText(r.until)}`, do: r.until, zdroj: 'rychle' };
  if (p.offline) return { mode: 'offline', proc: 'kamera nedostupná', zdroj: 'offline' };
  const noc = nocSimulovana || jeNocPro(p, new Date(now));
  const { denOd, nocOd } = casy(p);
  const mode = p.consent[noc ? 'noc' : 'den'];
  return { mode, proc: `${CONSENT[mode]} (${noc ? `noc do ${denOd}` : `den do ${nocOd}`}, nastavila rodina)`, zdroj: noc ? 'noc' : 'den' };
}
/** Časová okna události: až tři dvojice od–do (from/to, from2/to2, from3/to3); jen vyplněné obě strany. */
export function okna(r) {
  const out = [];
  for (const [f, t] of [[r?.from, r?.to], [r?.from2, r?.to2], [r?.from3, r?.to3]]) if (f && t) out.push([f, t]);
  return out;
}
export const oknaText = (r) => okna(r).map(([f, t]) => `${f}–${t}`).join(', ');
/** Platí teď? Bez oken celý den; jinak když padne do kteréhokoli (okno přes půlnoc: 22:00–06:00). */
export function withinHours(r, d = new Date()) {
  const o = okna(r);
  if (!o.length) return true;
  const m = minutaDne(d);
  return o.some(([from, to]) => {
    const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
    const f = fh * 60 + fm, t = th * 60 + tm;
    return f < t ? (m >= f && m < t) : (m >= f || m < t);
  });
}

const FAKE = [
  ['p2', 'Babička Marie', 'Byt 7, Kladno', 'Pečovatelská služba Kladno'],
  ['p3', 'Pan Josef', 'Pokoj 12, DS Slunečnice', 'DS Slunečnice'],
  ['p4', 'Paní Anna', 'Byt 3, Praha 4', 'Pečovatelská služba Kladno'],
  ['p5', 'Pan Karel', 'Pokoj 5, DS Slunečnice', 'DS Slunečnice'],
  ['p6', 'Paní Věra', 'Byt 21, Beroun', 'Pečovatelská služba Kladno'],
  ['p7', 'Pan Miroslav', 'Pokoj 8, DS Slunečnice', 'DS Slunečnice'],
  ['p8', 'Paní Jarmila', 'Byt 2, Praha 6', 'Pečovatelská služba Kladno'],
];

/* Údaje poskytovatele: zadávají se na jednom místě (dispečink → Upravit) a jsou
 * ve sdíleném stavu, takže je stejně vidí všichni dispečeři, detail kamery i rodina. */
export const POSKYTOVATEL_VYCHOZI = { nazev: 'Pečovatelská služba Kladno', telefon: '312 123 456', dispecinkZdroj: 'vlastni', sluzbaTelefon: '', sluzbaZdroj: 'vlastni', administraceTelefon: '', administraceZdroj: 'vlastni', email: 'dispecink@pskladno.cz', dispecer: 'Jana Nováková', smena: 'denní směna', zaloha: 'Petr Dvořák', zalohaTelefon: '777 222 333', vedouci: 'Mgr. Hana Veselá', vedouciTelefon: '777 444 555', eskalaceMin: 2, nahravkaS: 15, nahravkaPredS: 5, nahravkyUloziste: 'server', nahravkyDny: 30, nahravkyDisk: false, nahravkyGB: 2 };
export function poskytovatel(s) { const p = { ...POSKYTOVATEL_VYCHOZI, ...(s?.poskytovatel || {}) }; p.eskalaceMin = Number(p.eskalaceMin) || POSKYTOVATEL_VYCHOZI.eskalaceMin; return p; }
/** Jméno poskytovatele pro pacienta: u skutečné kamery ze sdílených údajů, u ukázkových pacientů jejich vlastní. */
export function poskytovatelPro(s, p) { return p?.real ? poskytovatel(s).nazev : (p?.provider || poskytovatel(s).nazev); }

export function seed(now = Date.now()) {
  const patients = [
    { id: 'tapoc2020', name: 'TAPO Test', place: 'Kancelář Famicura (skutečná kamera)', provider: 'Pečovatelská služba Kladno', real: true,
      consent: { den: 'full', noc: 'full', nouze: true, denOd: DEN_OD, nocOd: NOC_OD }, watch: defaultWatch(), night: false, offline: false, note: '' },
    ...FAKE.map(([id, name, place, provider], i) => ({ id, name, place, provider, real: false,
      consent: { den: ['skeleton', 'blur', 'none', 'full', 'skeleton', 'skeleton', 'blur'][i], noc: ['skeleton', 'skeleton', 'none', 'skeleton', 'none', 'skeleton', 'skeleton'][i], nouze: i % 3 !== 2, denOd: DEN_OD, nocOd: NOC_OD },
      watch: defaultWatch(), night: false, offline: i === 5, note: '' })),
  ];
  const events = [];
  const add = (minsAgo, patientId, kind, state = 'uzavřen', result = 'planý poplach') => events.push({
    id: 'e' + minsAgo + patientId, at: now - minsAgo * 60000, patientId, kind, state, by: state === 'nový' ? null : 'Jana Nováková', result: state === 'uzavřen' ? result : null, note: '' });
  add(38, 'p3', 'linecross', 'uzavřen', 'vyřešeno na dálku');
  add(65, 'p2', 'person');
  add(120, 'tapoc2020', 'motion');
  add(190, 'p5', 'inactivity', 'uzavřen', 'výjezd');
  add(260, 'p8', 'fall', 'uzavřen', 'záchranná služba');
  add(300, 'p7', 'offline', 'uzavřen', 'tunel obnoven');
  return { patients, events, notifications: [], requests: [], grants: {}, klid: {}, watching: {}, night: false, seq: 1, seededAt: now, poskytovatel: { ...POSKYTOVATEL_VYCHOZI } };
}

/* ---------- akce ----------
 * Každá akce mění stav na místě (reset vrací nový) a vrací, co volající
 * potřebuje. Vstupy se kontrolují tady, protože na serveru přicházejí
 * od prohlížeče; chyba vstupu má status 400. */
function chyba(text) { const e = new Error(text); e.status = 400; return e; }
const str = (v, max, nazev) => { if (v == null) return ''; if (typeof v !== 'string' || v.length > max) throw chyba(`Neplatná hodnota: ${nazev}.`); return v; };
const bool = (v) => v === true || v === 1 || v === '1';
const cas = (v, nazev) => { if (v === null || v === undefined) return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 4102444800000) throw chyba(`Neplatný čas: ${nazev}.`); return v; };
const hodina = (v) => { if (v == null || v === '') return ''; if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw chyba('Hodiny musí být HH:MM.'); return v; };
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const pid = (v) => { if (typeof v !== 'string' || !ID.test(v)) throw chyba('Neplatné ID pacienta.'); return v; };
const nid = (s) => 'n' + (s.seq++) + Date.now().toString(36);
const najdi = (s, id) => s.patients.find((p) => p.id === id);

const akce = {
  /** Kamera ze serveru, kterou simulace nezná: založí k ní pacienta (jméno = název kamery). */
  ensurePatient(s, now, p) {
    if (!p || typeof p !== 'object') throw chyba('Chybí kamera.');
    const id = pid(p.id);
    if (najdi(s, id)) return { zmena: false };
    s.patients.push({ id, name: str(p.name, 80, 'name') || id, place: 'skutečná kamera', provider: 'Poskytovatel', real: true,
      consent: { den: 'full', noc: 'full', nouze: true, denOd: DEN_OD, nocOd: NOC_OD }, watch: defaultWatch(), night: false, offline: false, note: '' });
    return {};
  },
  emit(s, now, patientId, kind, extra = {}) {
    patientId = pid(patientId);
    const k = KINDS[kind]; if (!k) throw chyba('Neznámý druh události.');
    if (!extra || typeof extra !== 'object') extra = {};
    const p = najdi(s, patientId);
    // Náramek/přívěsek SOS není kamera: jeho poplach projde i u kamery deaktivované rodinou (nahrávka se přesto nepořídí).
    if (p?.deaktivace && !bool(extra.naramek)) {
      // kamera deaktivovaná rodinou: nic se nezapisuje ani nehlásí (jen stav nedostupnosti se eviduje)
      if (kind === 'offline') p.offline = true;
      if (kind === 'online') p.offline = false;
      s.lastDropped = { at: now, patientId, kind, reason: 'kamera je deaktivovaná rodinou' };
      return { vysledek: null };
    }
    const pw = p?.watch?.[kind];
    const real = bool(extra.real);
    // Mimo hlídané hodiny: skutečná událost z kamery se do deníku zapíše jako informační
    // řádek (uzavřený, bez alertu, bez SMS/e-mailu, bez nahrávky); vypnutý druh a simulace se zahodí.
    const mimoHodiny = !!(pw && pw.on && !withinHours(pw, new Date(now)));
    if (pw && (!pw.on || (mimoHodiny && !real))) {
      // dropped by the provider's settings; the panel says so, the history stays clean
      s.lastDropped = { at: now, patientId, kind, reason: !pw.on ? 'poskytovatel událost vypnul' : `mimo hodiny ${oknaText(pw)}` };
      return { vysledek: null };
    }
    const ev = { id: nid(s), at: now, patientId, kind, state: k.level === 'info' || mimoHodiny ? 'uzavřen' : 'nový', by: null, result: null, note: '', rec: !!pw?.rec && !mimoHodiny };
    let text = str(extra.text, 300, 'text');
    if (mimoHodiny) { ev.mimoHodiny = true; text = `${(text || k.label).replace(/\.$/, '')} (mimo hlídané hodiny ${oknaText(pw)})`.slice(0, 300); }
    if (text) ev.text = text;
    if (real) ev.real = true;
    s.events.unshift(ev);
    if (s.events.length > 400) s.events.length = 400;
    if (kind === 'offline' && p) p.offline = true;
    if (kind === 'online' && p) p.offline = false;
    const quiet = s.klid[patientId] && s.klid[patientId] > now;
    if (!mimoHodiny && (k.level === 'crit' || (!quiet && k.level !== 'info'))) {
      s.notifications.unshift({ id: nid(s), at: ev.at, patientId, eventId: ev.id, kind, level: k.level, ack: false });
      if (s.notifications.length > 100) s.notifications.length = 100;
    }
    return { vysledek: ev };
  },
  setAlert(s, now, eventId, patch) {
    const e = s.events.find((x) => x.id === str(eventId, 60, 'eventId')); if (!e) return { zmena: false };
    if (!patch || typeof patch !== 'object') throw chyba('Chybí změna.');
    const p = {};
    if ('state' in patch) p.state = str(patch.state, 20, 'state');
    if ('by' in patch) p.by = str(patch.by, 80, 'by');
    if ('result' in patch) p.result = str(patch.result, 80, 'result');
    if ('note' in patch) p.note = str(patch.note, 300, 'note');
    if ('takenAt' in patch) p.takenAt = cas(patch.takenAt, 'takenAt');
    if ('closedAt' in patch) p.closedAt = cas(patch.closedAt, 'closedAt');
    Object.assign(e, p);
    return {};
  },
  /** Hromadně uzavře otevřené alerty (varování i kritické): jedné kamery (patientId), nebo všech (''). Vrací { pocet }. */
  closeAll(s, now, patientId, by, result) {
    const jen = patientId ? pid(patientId) : null;
    const kdo = str(by, 80, 'by') || 'dispečink', vysledek = str(result, 80, 'result') || 'hromadně uzavřeno';
    let pocet = 0;
    for (const e of s.events) {
      if (e.state === 'uzavřen' || !KINDS[e.kind] || KINDS[e.kind].level === 'info') continue;
      if (jen && e.patientId !== jen) continue;
      e.state = 'uzavřen'; e.by = kdo; e.result = vysledek; e.closedAt = now; if (!e.takenAt) e.takenAt = now; pocet++;
    }
    return { vysledek: { pocet }, zmena: pocet > 0 };
  },
  ackNotification(s, now, id) { const n = s.notifications.find((x) => x.id === str(id, 60, 'id')); if (!n) return { zmena: false }; n.ack = true; return {}; },
  ackAll(s, now, patientId) { patientId = pid(patientId); for (const n of s.notifications) if (n.patientId === patientId) n.ack = true; return {}; },

  setWatch(s, now, patientId, kind, patch) {
    const p = najdi(s, pid(patientId)); if (!p || !WATCH_KINDS.includes(kind)) return { zmena: false };
    if (!patch || typeof patch !== 'object') throw chyba('Chybí změna.');
    p.watch = p.watch || defaultWatch();
    const w = { ...p.watch[kind] };
    if ('on' in patch) w.on = bool(patch.on);
    if ('rec' in patch) w.rec = bool(patch.rec);
    // příjemci: pole ID (r1–r5 rodina, dispecink, sluzba, administrace / s1, s2), nebo starší true/false (celá rodina / obě sady)
    const prijemci = (v, povolene, nazev) => { if (Array.isArray(v)) { for (const x of v) if (!povolene.includes(x) && !(nazev === 'SMS' && jeUcetPrijemce(x))) throw chyba(`Neznámý příjemce ${nazev}: ${x}.`); return [...new Set(v)]; } return bool(v); };
    if ('sms' in patch) w.sms = prijemci(patch.sms, SMS_PRIJEMCI, 'SMS');
    if ('mail' in patch) w.mail = prijemci(patch.mail, MAIL_SADY, 'e-mailu');
    for (const k of ['from', 'to', 'from2', 'to2', 'from3', 'to3']) if (k in patch) w[k] = hodina(patch[k]);
    for (const [f, t] of [['from', 'to'], ['from2', 'to2'], ['from3', 'to3']]) if (!!w[f] !== !!w[t]) throw chyba('Vyplňte začátek i konec okna, nebo ani jedno.');
    p.watch[kind] = w;
    return {};
  },
  /** Kontakty pro upozornění: { rodina: [{ jmeno, telefon }×5], maily1: 'a@b, c@d' | [], maily2 } (starší { sms, mail } se přijme také); změna jde do logu kamery. */
  setKontakty(s, now, patientId, kontakty, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    if (!kontakty || typeof kontakty !== 'object') throw chyba('Chybí kontakty.');
    const nove = prazdneKontakty();
    const rodina = Array.isArray(kontakty.rodina) ? kontakty.rodina : Array.isArray(kontakty.sms) ? kontakty.sms.map((t) => ({ jmeno: '', telefon: t })) : [];
    if (rodina.length > KONTAKTY_RODINA_MAX) throw chyba(`Nejvýš ${KONTAKTY_RODINA_MAX} lidí z rodiny.`);
    rodina.forEach((r, i) => {
      if (!r || typeof r !== 'object') return;
      const jmeno = str(r.jmeno, 40, 'jméno').trim(), tel = str(r.telefon, 40, 'telefon').trim();
      if (!tel) { if (jmeno) throw chyba(`U jména „${jmeno}“ chybí telefon.`); return; }
      const n = normalizeTelefonCz(tel); if (!n) throw chyba(`Telefon „${tel}“ není český mobil (9 číslic).`);
      nove.rodina[i] = { jmeno, telefon: n };
    });
    const sada = (v, nazev) => { const m = rozdelMaily(v); if (m.length > MAILY_SADA_MAX) throw chyba(`Nejvýš ${MAILY_SADA_MAX} adres: ${nazev}.`); for (const x of m) if (!jeEmail(x)) throw chyba(`E-mail „${x}“ není platná adresa.`); return [...new Set(m.map((x) => x.toLowerCase()))]; };
    nove.maily1 = sada(kontakty.maily1 ?? kontakty.mail, 'e-maily 1');
    nove.maily2 = sada(kontakty.maily2, 'e-maily 2');
    const stare = kontaktyPro(p);
    if (JSON.stringify(stare) === JSON.stringify(nove)) return { zmena: false, vysledek: nove };
    p.kontakty = nove;
    const popis = describeKontakty(p);
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink', text: popis ? `Kontakty pro upozornění: ${popis}` : 'Kontakty pro upozornění smazány.', note: '' });
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: nove };
  },
  /** Náramek / přívěsek SOS ke kameře: ID zařízení (jak ho hlásí v protokolu hodinek), prázdné = odebrat. Ozvání a baterii doplňuje server. */
  /** Přiřazení náramku: ID zařízení a telefon SIM karty v něm (povinný, když se telefon posílá; starší volání bez telefonu ho nechá, jak je).
   *  Telefon je ve Stavu náramku výrazně vidět v dispečinku i v aplikaci na telefonu – dispečer i rodina na náramek volají. */
  setNaramek(s, now, patientId, id, by, telefon) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    const nove = str(id, 40, 'id').trim();
    if (nove && !/^[A-Za-z0-9]{5,20}$/.test(nove)) throw chyba('ID náramku je 5 až 20 písmen a číslic (ID zařízení z aplikace náramku).');
    let tel = p.naramek?.telefon || '';
    if (telefon !== undefined) {
      tel = telefonNaramku(telefon);
      if (nove && !tel) throw chyba('Zadejte telefonní číslo SIM karty v náramku – dispečink i rodina na něj volají.');
    }
    const stare = p.naramek?.id || '', stareTel = p.naramek?.telefon || '';
    if (nove === stare && tel === stareTel) return { zmena: false, vysledek: p.naramek || null };
    if (nove) p.naramek = { ...(nove === stare ? p.naramek : {}), id: nove, telefon: tel }; else delete p.naramek;
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink',
      text: !nove ? `Náramek / přívěsek ${stare} odebrán.` : nove === stare ? `Telefon náramku ${nove}: ${formatTelefonMez(tel)}.` : `Náramek / přívěsek ${nove} (telefon ${formatTelefonMez(tel) || 'nezadán'}) přiřazen ke kameře${stare ? ` (místo ${stare})` : ''}: SOS, pád a slabá baterie půjdou do fronty této kamery.`, note: '' });
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: p.naramek || null };
  },
  /** Čísla SOS náramku (až 3): slot = ID z Kontaktů ('r1'–'r5' člověk z rodiny, 'dispecink' / 'sluzba' / 'administrace' telefon poskytovatele; prázdné = smazat).
   *  Ukládají se ke kameře, server dosadí skutečná čísla (cisloSosPro + src/sluzba.mjs), pošle je do náramku příkazy SOS1–SOS3 (src/naramky.mjs), zapíše sosOdeslano
   *  a sosOdeslaneCisla (skutečně poslaná) a při změně kontaktu nebo čísla v Péče doma (plus) je pošle znovu. Starší zápisy (číslo napřímo, 'pecedoma' / 'pecedomaplus') se přijmou dál. */
  setNaramekSos(s, now, patientId, cisla, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    if (!p.naramek?.id) throw chyba('Nejdřív přiřaďte náramek (ID zařízení).');
    if (!Array.isArray(cisla) || cisla.length > 3) throw chyba('Zadejte nejvýš tři čísla SOS.');
    const nova = [0, 1, 2].map((i) => String(cisla[i] ?? '').replace(/[\s-]/g, ''));
    for (const c of nova) if (c && !SOS_VOLBY.includes(c) && !['pecedoma', 'pecedomaplus'].includes(c) && !/^\+?[0-9]{6,15}$/.test(c)) throw chyba(`Číslo SOS „${c}“: vyberte člověka z rodiny (r1–r5) nebo telefon poskytovatele (dispecink, sluzba, administrace) z Kontaktů.`);
    for (const c of nova) if (/^r[1-5]$/.test(c) && !kontaktyPro(p).rodina[Number(c[1]) - 1]?.telefon) throw chyba(`Číslo SOS: rodina ${c[1]} nemá v Kontaktech telefon.`);
    if (JSON.stringify(p.naramek.sos || ['', '', '']) === JSON.stringify(nova)) return { zmena: false, vysledek: nova };
    p.naramek = { ...p.naramek, sos: nova, sosOdeslano: null, sosOdeslaneCisla: null };
    const seznam = nova.filter(Boolean).map((c) => cisloSosPro(s, p, c).popis);
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink',
      text: seznam.length ? `Čísla SOS náramku: ${seznam.join(', ')} (pošlou se do náramku).` : 'Čísla SOS náramku smazána (pošle se do náramku).', note: '' });
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: nova };
  },
  /** Automatické měření náramku: { min: 0–1440 (0 = vypnuto), tep, tlak, kyslik, teplota: bool }. Příkazy posílá server (src/naramky.mjs). */
  setNaramekAuto(s, now, patientId, auto, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    if (!p.naramek?.id) throw chyba('Nejdřív přiřaďte náramek (ID zařízení).');
    if (!auto || typeof auto !== 'object') throw chyba('Chybí nastavení měření.');
    const min = Number(auto.min);
    if (!Number.isInteger(min) || min < 0 || min > 1440) throw chyba('Interval měření: 0 (vypnuto) až 1440 minut.');
    const nove = { min, zdravi: bool(auto.zdravi), tep: bool(auto.tep), tlak: bool(auto.tlak), kyslik: bool(auto.kyslik), teplota: bool(auto.teplota) };
    if (JSON.stringify(p.naramek.auto || null) === JSON.stringify(nove)) return { zmena: false, vysledek: nove };
    p.naramek = { ...p.naramek, auto: nove };
    const co = ['zdravi', 'tep', 'tlak', 'kyslik', 'teplota'].filter((k) => nove[k]).map((k) => ({ zdravi: 'zdraví (tep, tlak, kyslík, teplota)', tep: 'tep', tlak: 'tlak', kyslik: 'kyslík', teplota: 'teplota' })[k]);
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink',
      text: min > 0 && co.length ? `Automatické měření náramku každých ${min} min: ${co.join(', ')}.` : 'Automatické měření náramku vypnuto.', note: '' });
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: nove };
  },
  setConsent(s, now, patientId, consent) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    if (!consent || typeof consent !== 'object') throw chyba('Chybí souhlas.');
    const c = { ...p.consent };
    for (const k of ['den', 'noc']) if (k in consent) { if (!(consent[k] in CONSENT)) throw chyba('Neznámý režim obrazu.'); c[k] = consent[k]; }
    if ('nouze' in consent) c.nouze = bool(consent.nouze);
    for (const k of ['denOd', 'nocOd']) if (k in consent) { const h = hodina(consent[k]); if (!h) throw chyba('Zadejte čas HH:MM.'); c[k] = h; }
    if (minuty(c.denOd || DEN_OD) === minuty(c.nocOd || NOC_OD)) throw chyba('Den a noc nemohou začínat ve stejnou chvíli.');
    p.consent = c;
    const { denOd, nocOd } = casy(p);
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'rodina',
      text: `Rodina nastavila poskytovateli: den (od ${denOd}) ${CONSENT[c.den]}, noc (od ${nocOd}) ${CONSENT[c.noc]}, nouzový přístup ${c.nouze ? 'povolen' : 'nepovolen'}.` });
    return {};
  },
  /** Rychlé přepnutí obrazu rodinou: platí do další změny nebo do střídání den/noc. null = zrušit. */
  rychle(s, now, patientId, mode) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    if (mode === null || mode === undefined || mode === '') {
      if (!p.docasne) return { zmena: false };
      delete p.docasne;
      s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'rodina', text: 'Rodina zrušila rychlé přepnutí obrazu, platí nastavení podle denní doby.' });
      return {};
    }
    if (!RYCHLE.includes(mode)) throw chyba('Neznámý režim obrazu.');
    const until = dalsiHranice(p, now);
    p.docasne = { mode, until };
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'rodina', text: `Rodina přepnula obraz na ${CONSENT[mode]} do ${casText(until)} (střídání den/noc).` });
    return { vysledek: p.docasne };
  },
  /** Klid: '120' = na 2 hodiny, 'rano' = do začátku dne, 'vecer' = do začátku noci, 'vypnuti' = do vypnutí, null = vypnout. */
  klidDo(s, now, patientId, volba) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    const { denOd, nocOd } = casy(p);
    let until = null;
    if (volba === null || volba === undefined || volba === '' || volba === 'vypnout') until = null;
    else if (/^\d{1,4}$/.test(String(volba))) until = now + Number(volba) * 60000;
    else if (volba === 'rano') until = pristeV(denOd, now);
    else if (volba === 'vecer') until = pristeV(nocOd, now);
    else if (volba === 'vypnuti') until = KLID_NAVZDY;
    else throw chyba('Neznámá volba klidu.');
    if (until) s.klid[p.id] = until; else delete s.klid[p.id];
    return { vysledek: until };
  },
  requestFull(s, now, patientId, from, reason) {
    const r = { id: nid(s), at: now, patientId: pid(patientId), from: str(from, 80, 'from') || 'Dispečink', reason: str(reason, 200, 'reason'), state: 'čeká', until: now + 10 * 60000 };   // 10 min: rodina to na telefonu stihne
    s.requests.unshift(r);
    if (s.requests.length > 100) s.requests.length = 100;
    s.notifications.unshift({ id: nid(s), at: r.at, patientId: r.patientId, requestId: r.id, kind: 'request', level: 'warn', ack: false });
    return { vysledek: r };
  },
  answerRequest(s, now, reqId, answer, minutes = 15) {
    const r = s.requests.find((x) => x.id === str(reqId, 60, 'reqId')); if (!r || r.state !== 'čeká') return { zmena: false };
    if (!['deny', 'forever', 'minutes'].includes(answer)) throw chyba('Neznámá odpověď.');
    minutes = Number(minutes); if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) minutes = 15;
    r.state = answer === 'deny' ? 'odmítnuto' : 'povoleno';
    if (answer !== 'deny') {
      s.grants[r.patientId] = { mode: 'full', until: answer === 'forever' ? now + 365 * 86400000 : now + minutes * 60000, by: r.from, kind: 'souhlas rodiny' };
      s.watching[r.patientId] = { who: r.from, since: now };
    }
    for (const n of s.notifications) if (n.requestId === r.id) n.ack = true;
    s.events.unshift({ id: nid(s), at: now, patientId: r.patientId, kind: 'consent', state: 'uzavřen', by: 'rodina',
      text: answer === 'deny' ? `Rodina odmítla žádost o plný obraz (${r.from}).` : `Rodina povolila plný obraz pro ${r.from}${answer === 'forever' ? ' do odvolání' : ` na ${minutes} min`}.` });
    return {};
  },
  emergencyAccess(s, now, patientId, who) {
    const p = najdi(s, pid(patientId)); who = str(who, 80, 'who') || 'Dispečink';
    if (!p || !p.consent.nouze) return { zmena: false, vysledek: false };
    s.grants[p.id] = { mode: 'full', until: now + 10 * 60000, by: who, kind: 'nouzový přístup' };
    s.watching[p.id] = { who, since: now };
    s.notifications.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'emergency', level: 'crit', ack: false, who });
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: who, text: `${who} otevřel nouzový přístup k plnému obrazu na 10 minut (kritický alert).` });
    return { vysledek: true };
  },
  endGrant(s, now, patientId, by = 'rodina') {
    patientId = pid(patientId); by = str(by, 80, 'by') || 'rodina';
    if (!s.grants[patientId]) return { zmena: false };
    delete s.grants[patientId]; delete s.watching[patientId];
    s.events.unshift({ id: nid(s), at: now, patientId, kind: 'consent', state: 'uzavřen', by, text: `${by === 'rodina' ? 'Rodina ukončila' : by + ' ukončil'} přístup k plnému obrazu.` });
    return {};
  },
  setWatching(s, now, patientId, who, on) { patientId = pid(patientId); if (bool(on)) s.watching[patientId] = { who: str(who, 80, 'who'), since: now }; else delete s.watching[patientId]; return {}; },
  /** Deaktivace kamery rodinou: žádný obraz, nahrávky ani události, kamera se otočí do stropu (server). on=false = aktivovat. */
  deaktivace(s, now, patientId, on, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    on = bool(on); const kdo = str(by, 80, 'by') || 'rodina';
    if (on === !!p.deaktivace) return { zmena: false, vysledek: { patientId: p.id, on, zmena: false } };
    if (on) {
      p.deaktivace = { od: now, kdo };
      delete s.grants[p.id]; delete s.watching[p.id];
      s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'rodina',
        text: `Rodina (${kdo}) deaktivovala kameru: poskytovatel nemá obraz, nepořizují se nahrávky, události se nezapisují; kamera se otáčí do stropu.` });
    } else {
      const od = p.deaktivace.od;
      // poloha před deaktivací (uložil ji server při otáčení do stropu): kamera se vrátí na původní záběr, ne jen do výchozí polohy
      const pl = p.deaktivace.poloha;
      const poloha = pl && Number.isFinite(pl.x) && Number.isFinite(pl.y) ? { x: pl.x, y: pl.y } : null;
      delete p.deaktivace;
      s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'rodina',
        text: `Rodina (${kdo}) aktivovala kameru (deaktivovaná byla od ${casText(od)}): obraz a hlídání opět podle nastavení; kamera se vrací ${poloha ? 'na původní záběr' : 'do výchozí polohy'}.` });
      if (s.events.length > 400) s.events.length = 400;
      return { vysledek: { patientId: p.id, on, zmena: true, poloha } };
    }
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: { patientId: p.id, on, zmena: true } };
  },
  setKlid(s, now, patientId, until) { patientId = pid(patientId); until = cas(until, 'until'); if (until) s.klid[patientId] = until; else delete s.klid[patientId]; return {}; },
  setNight(s, now, on) { s.night = bool(on); return {}; },
  /** Trvalá poznámka ke klientovi (zdravotní stav, co dělat při alertu): pod obrazem v detailu; změna se zapíše do logu. */
  setNote(s, now, patientId, text, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    text = str(text, 300, 'text').trim();
    if ((p.note || '') === text) return { zmena: false };
    p.note = text;
    s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink', text: text ? `Poznámka ke klientovi: ${text}` : 'Poznámka ke klientovi smazána.', note: '' });
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: text };
  },
  /** Poznámka dispečera ke kameře: do logu jako událost (kind 'poznamka') s časem a jménem; rodina ji v historii nevidí. */
  poznamka(s, now, patientId, text, by) {
    const p = najdi(s, pid(patientId)); if (!p) return { zmena: false };
    text = str(text, 1000, 'text').trim(); if (!text) throw chyba('Poznámka je prázdná.');
    const ev = { id: nid(s), at: now, patientId: p.id, kind: 'poznamka', state: 'uzavřen', by: str(by, 80, 'by') || 'dispečink', text, note: '' };
    s.events.unshift(ev);
    if (s.events.length > 400) s.events.length = 400;
    return { vysledek: ev };
  },
  setPoskytovatel(s, now, p) {
    if (!p || typeof p !== 'object') throw chyba('Chybí údaje poskytovatele.');
    const n = { ...poskytovatel(s) };
    for (const k of Object.keys(POSKYTOVATEL_VYCHOZI)) if (k in p && !['eskalaceMin', 'nahravkaS', 'nahravkaPredS', 'nahravkyUloziste', 'nahravkyDny', 'nahravkyDisk', 'nahravkyGB'].includes(k)) n[k] = str(p[k], 80, k).trim();
    if ('nahravkyGB' in p) { const m = Number(p.nahravkyGB); if (!Number.isFinite(m) || m < 0 || m > 500) throw chyba('Limit místa nahrávek: 0 (bez limitu) až 500 GB.'); n.nahravkyGB = Math.round(m * 10) / 10; }
    if ('nahravkyDisk' in p) n.nahravkyDisk = p.nahravkyDisk === true || p.nahravkyDisk === 'true' || p.nahravkyDisk === 1;
    if ('nahravkyUloziste' in p) { if (!['server', 'disk'].includes(p.nahravkyUloziste)) throw chyba('Úložiště nahrávek: server, nebo disk (Google Disk).'); n.nahravkyUloziste = p.nahravkyUloziste; }
    if ('nahravkyDny' in p) { const m = Number(p.nahravkyDny); if (!Number.isInteger(m) || m < 1 || m > 365) throw chyba('Mazání nahrávek: 1 až 365 dnů.'); n.nahravkyDny = m; }
    if ('eskalaceMin' in p) { const m = Number(p.eskalaceMin); if (!Number.isInteger(m) || m < 1 || m > 60) throw chyba('Eskalace: 1 až 60 minut.'); n.eskalaceMin = m; }
    if ('nahravkaS' in p) { const m = Number(p.nahravkaS); if (!Number.isInteger(m) || m < 5 || m > 60) throw chyba('Délka nahrávky: 5 až 60 sekund.'); n.nahravkaS = m; }
    if ('nahravkaPredS' in p) { const m = Number(p.nahravkaPredS); if (!Number.isInteger(m) || m < 0 || m > 10) throw chyba('Obraz před událostí: 0 až 10 sekund.'); n.nahravkaPredS = m; }
    for (const role of ROLE_POSKYTOVATELE) {
      const { telefon, zdroj } = POLE_ROLE[role]; const nazev = `Telefon (${POPIS_ROLE[role]})`;
      if (!ZDROJE_TELEFONU.includes(n[zdroj])) throw chyba(`${nazev}: zdroj vlastní, Péče doma, nebo Péče doma plus.`);
      if (n[zdroj] === 'vlastni' && n[telefon] && !normalizeTelefonCz(n[telefon])) throw chyba(`${nazev} „${n[telefon]}“ není české číslo (9 číslic).`);
    }
    if (!n.nazev) throw chyba('Název poskytovatele nesmí být prázdný.');
    if (!n.dispecer) throw chyba('Jméno dispečera nesmí být prázdné.');
    s.poskytovatel = n;
    return { vysledek: n };
  },
  reset(s, now) { return { stav: seed(now) }; },

  /** Housekeeping every few seconds: expired grants and requests, escalation. */
  tick(s, now) {
    let changed = false;
    for (const [id, g] of Object.entries(s.grants)) if (g.until <= now) { delete s.grants[id]; delete s.watching[id]; changed = true;
      s.events.unshift({ id: nid(s), at: now, patientId: id, kind: 'consent', state: 'uzavřen', by: 'systém', text: 'Povolení plného obrazu vypršelo, obraz se vrátil do nastaveného režimu.' }); }
    for (const r of s.requests) if (r.state === 'čeká' && r.until <= now) { r.state = 'vypršelo'; changed = true; }
    for (const p of s.patients) if (p.docasne && p.docasne.until <= now) { delete p.docasne; changed = true;
      s.events.unshift({ id: nid(s), at: now, patientId: p.id, kind: 'consent', state: 'uzavřen', by: 'systém', text: 'Rychlé přepnutí obrazu skončilo střídáním den/noc, platí nastavení podle denní doby.' }); }
    const eskalace = poskytovatel(s).eskalaceMin * 60000;
    for (const e of s.events) if (e.state === 'nový' && KINDS[e.kind]?.level === 'crit' && now - e.at > eskalace && !e.escalated) { e.escalated = true; changed = true; }
    return { zmena: changed };
  },
};
export const AKCE = Object.keys(akce);

/** Provede akci nad stavem. Vrací { state, vysledek, zmena }; stav je týž objekt, jen reset vrací nový. */
export function proved(state, nazev, args = [], now = Date.now()) {
  const fn = akce[nazev]; if (!fn) throw chyba('Neznámá akce.');
  if (!Array.isArray(args) || args.length > 6) throw chyba('Neplatné argumenty.');
  const out = fn(state, now, ...args) || {};
  return { state: out.stav || state, vysledek: out.vysledek, zmena: out.zmena !== false };
}

/** Slovní popis, co poskytovatel vidí; použitý na obou stranách. */
export function grantText(g) { return `${CONSENT[g.mode]} – ${g.by} do ${casText(g.until)}`; }
