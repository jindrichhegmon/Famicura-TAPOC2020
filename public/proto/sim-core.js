/*
 * Jádro simulace prototypu: data i akce bez prohlížeče, aby stejný kód běžel
 * v prohlížeči (sim.js) i na serveru (src/proto-stav.mjs). Na serveru je stav
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
  tamper:     { label: 'Zakrytí nebo posunutí kamery', level: 'warn', source: 'kamera' },
  missing:    { label: 'Ztráta postavy',               level: 'info', source: 'analýza' },
  state:      { label: 'Změna polohy',                 level: 'info', source: 'analýza' },
  person:     { label: 'Osoba',                        level: 'info', source: 'kamera' },
  motion:     { label: 'Pohyb',                        level: 'info', source: 'kamera' },
  offline:    { label: 'Kamera nedostupná',            level: 'tech', source: 'systém' },
  online:     { label: 'Kamera opět dostupná',         level: 'tech', source: 'systém' },
  battery:    { label: 'Slabá baterie náramku',        level: 'tech', source: 'náramek' },
};
export const LEVEL_LABEL = { crit: 'kritická', warn: 'varování', info: 'informativní', tech: 'technická' };
export const CONSENT = { none: 'žádný obraz (jen události)', skeleton: 'drátěný model', blur: 'rozostření', full: 'plný obraz' };

/** What the provider watches for a patient: on/off, hours, recording. The family only reads it. */
export const WATCH_KINDS = ['fall', 'longlie', 'sos', 'devfall', 'inactivity', 'linecross', 'tamper', 'missing', 'state', 'person', 'motion'];
export function defaultWatch() {
  const w = {};
  for (const k of WATCH_KINDS) w[k] = { on: true, from: '', to: '', rec: KINDS[k].level === 'crit' || k === 'linecross' };
  w.linecross = { on: true, from: '07:00', to: '20:00', rec: true };
  w.motion = { on: false, from: '', to: '', rec: false };
  w.state = { on: false, from: '', to: '', rec: false };
  return w;
}
export function describeWatch(w) {
  const hodiny = (r) => (r.from ? ` ${r.from}–${r.to}` : '');
  const on = WATCH_KINDS.filter((k) => w[k]?.on).map((k) => KINDS[k].label.toLowerCase() + hodiny(w[k]) + (w[k].rec ? ' 🎞' : ''));
  return on.length ? on.join(', ') : 'nic';
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
export function withinHours(r, d = new Date()) {
  if (!r.from || !r.to) return true;
  const m = minutaDne(d);
  const [fh, fm] = r.from.split(':').map(Number), [th, tm] = r.to.split(':').map(Number);
  const f = fh * 60 + fm, t = th * 60 + tm;
  return f < t ? (m >= f && m < t) : (m >= f || m < t);
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
export const POSKYTOVATEL_VYCHOZI = { nazev: 'Pečovatelská služba Kladno', telefon: '312 123 456', email: 'dispecink@pskladno.cz', dispecer: 'Jana Nováková', smena: 'denní směna', zaloha: 'Petr Dvořák', zalohaTelefon: '777 222 333', vedouci: 'Mgr. Hana Veselá', vedouciTelefon: '777 444 555', eskalaceMin: 2 };
export function poskytovatel(s) { const p = { ...POSKYTOVATEL_VYCHOZI, ...(s?.poskytovatel || {}) }; p.eskalaceMin = Number(p.eskalaceMin) || POSKYTOVATEL_VYCHOZI.eskalaceMin; return p; }
/** Jméno poskytovatele pro pacienta: u skutečné kamery ze sdílených údajů, u ukázkových pacientů jejich vlastní. */
export function poskytovatelPro(s, p) { return p?.real ? poskytovatel(s).nazev : (p?.provider || poskytovatel(s).nazev); }

export function seed(now = Date.now()) {
  const patients = [
    { id: 'tapoc2020', name: 'TAPO Test', place: 'Kancelář Famicura (skutečná kamera)', provider: 'Pečovatelská služba Kladno', real: true,
      consent: { den: 'full', noc: 'full', nouze: true, denOd: DEN_OD, nocOd: NOC_OD }, watch: defaultWatch(), night: false, offline: false, note: 'Klient chodí s hůlkou, riziko pádu v noci.' },
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
    const pw = p?.watch?.[kind];
    if (pw && (!pw.on || !withinHours(pw, new Date(now)))) {
      // dropped by the provider's settings; the panel says so, the history stays clean
      s.lastDropped = { at: now, patientId, kind, reason: !pw.on ? 'poskytovatel událost vypnul' : `mimo hodiny ${pw.from}–${pw.to}` };
      return { vysledek: null };
    }
    const ev = { id: nid(s), at: now, patientId, kind, state: k.level === 'info' ? 'uzavřen' : 'nový', by: null, result: null, note: '', rec: !!pw?.rec };
    const text = str(extra.text, 300, 'text'); if (text) ev.text = text;
    if (bool(extra.real)) ev.real = true;
    s.events.unshift(ev);
    if (s.events.length > 400) s.events.length = 400;
    if (kind === 'offline' && p) p.offline = true;
    if (kind === 'online' && p) p.offline = false;
    const quiet = s.klid[patientId] && s.klid[patientId] > now;
    if (k.level === 'crit' || (!quiet && k.level !== 'info')) {
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
  ackNotification(s, now, id) { const n = s.notifications.find((x) => x.id === str(id, 60, 'id')); if (!n) return { zmena: false }; n.ack = true; return {}; },
  ackAll(s, now, patientId) { patientId = pid(patientId); for (const n of s.notifications) if (n.patientId === patientId) n.ack = true; return {}; },

  setWatch(s, now, patientId, kind, patch) {
    const p = najdi(s, pid(patientId)); if (!p || !WATCH_KINDS.includes(kind)) return { zmena: false };
    if (!patch || typeof patch !== 'object') throw chyba('Chybí změna.');
    p.watch = p.watch || defaultWatch();
    const w = { ...p.watch[kind] };
    if ('on' in patch) w.on = bool(patch.on);
    if ('rec' in patch) w.rec = bool(patch.rec);
    if ('from' in patch) w.from = hodina(patch.from);
    if ('to' in patch) w.to = hodina(patch.to);
    p.watch[kind] = w;
    return {};
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
  setKlid(s, now, patientId, until) { patientId = pid(patientId); until = cas(until, 'until'); if (until) s.klid[patientId] = until; else delete s.klid[patientId]; return {}; },
  setNight(s, now, on) { s.night = bool(on); return {}; },
  setPoskytovatel(s, now, p) {
    if (!p || typeof p !== 'object') throw chyba('Chybí údaje poskytovatele.');
    const n = { ...poskytovatel(s) };
    for (const k of Object.keys(POSKYTOVATEL_VYCHOZI)) if (k in p && k !== 'eskalaceMin') n[k] = str(p[k], 80, k).trim();
    if ('eskalaceMin' in p) { const m = Number(p.eskalaceMin); if (!Number.isInteger(m) || m < 1 || m > 60) throw chyba('Eskalace: 1 až 60 minut.'); n.eskalaceMin = m; }
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
