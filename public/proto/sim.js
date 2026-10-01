/*
 * Simulovaný stav pro prototyp: pacienti, souhlasy s režimem obrazu, události,
 * alerty, žádosti o plný obraz, notifikace. Sdílí se mezi otevřenými okny
 * (rodina, dispečink, provoz) přes localStorage a BroadcastChannel, takže
 * změna souhlasu v okně rodiny se hned projeví v dispečinku.
 */
const KEY = 'famicura.proto.v1';
const CH = 'famicura-proto';

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
function withinHours(r, d = new Date()) {
  if (!r.from || !r.to) return true;
  const m = d.getHours() * 60 + d.getMinutes();
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

function seed() {
  const now = Date.now();
  const patients = [
    { id: 'tapoc2020', name: 'TAPO Test', place: 'Kancelář Famicura (skutečná kamera)', provider: 'Pečovatelská služba Kladno', real: true,
      consent: { den: 'full', noc: 'full', nouze: true }, watch: defaultWatch(), night: false, offline: false, note: 'Klient chodí s hůlkou, riziko pádu v noci.' },
    ...FAKE.map(([id, name, place, provider], i) => ({ id, name, place, provider, real: false,
      consent: { den: ['skeleton', 'blur', 'none', 'full', 'skeleton', 'skeleton', 'blur'][i], noc: ['skeleton', 'skeleton', 'none', 'skeleton', 'none', 'skeleton', 'skeleton'][i], nouze: i % 3 !== 2 },
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
  return { patients, events, notifications: [], requests: [], grants: {}, klid: {}, watching: {}, night: false, seq: 1, seededAt: now };
}

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.patients) { for (const p of s.patients) p.watch = p.watch || defaultWatch(); return s; } } catch { /* fresh */ }
  const s = seed(); save(s); return s;
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

let state = load();
const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CH) : null;
const subs = new Set();
bc?.addEventListener('message', (m) => { if (m.data?.type === 'state') { state = m.data.state; subs.forEach((f) => f(state)); } });
window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue) { try { state = JSON.parse(e.newValue); subs.forEach((f) => f(state)); } catch { /* ignore */ } } });

function commit() { save(state); bc?.postMessage({ type: 'state', state }); subs.forEach((f) => f(state)); }
const nid = () => 'n' + (state.seq++) + Date.now().toString(36);

export const sim = {
  get state() { return state; },
  subscribe(f) { subs.add(f); f(state); return () => subs.delete(f); },
  patient(id) { return state.patients.find((p) => p.id === id); },
  /** Kamera ze serveru, kterou simulace nezná: založí k ní pacienta (jméno = název kamery). */
  ensurePatient({ id, name }) {
    if (state.patients.some((p) => p.id === id)) return;
    state.patients.push({ id, name: name || id, place: 'skutečná kamera', provider: 'Poskytovatel', real: true,
      consent: { den: 'full', noc: 'full', nouze: true }, watch: defaultWatch(), night: false, offline: false, note: '' });
    commit();
  },
  isNight() { return state.night || (() => { const h = new Date().getHours(); return h >= 22 || h < 6; })(); },

  /** The mode the provider gets right now: a running grant beats the consent; night has its own consent. */
  effectiveMode(patientId) {
    const p = this.patient(patientId); if (!p) return 'none';
    const g = state.grants[patientId];
    if (g && g.until > Date.now()) return g.mode;
    if (p.offline) return 'offline';
    return p.consent[this.isNight() ? 'noc' : 'den'];
  },
  /** Why the provider sees what it sees, in words. */
  modeReason(patientId) {
    const p = this.patient(patientId); if (!p) return '';
    const g = state.grants[patientId];
    if (g && g.until > Date.now()) return `${CONSENT[g.mode]} – ${g.by} do ${new Date(g.until).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`;
    if (p.offline) return 'kamera nedostupná';
    const n = this.isNight();
    return `${CONSENT[p.consent[n ? 'noc' : 'den']]} (${n ? 'noc' : 'den'}, nastavila rodina)`;
  },

  emit(patientId, kind, extra = {}) {
    const k = KINDS[kind]; if (!k) return null;
    const pw = this.patient(patientId)?.watch?.[kind];
    if (pw && (!pw.on || !withinHours(pw))) {
      // dropped by the provider's settings; the panel says so, the history stays clean
      state.lastDropped = { at: Date.now(), patientId, kind, reason: !pw.on ? 'poskytovatel událost vypnul' : `mimo hodiny ${pw.from}–${pw.to}` };
      commit(); return null;
    }
    const ev = { id: nid(), at: Date.now(), patientId, kind, state: k.level === 'info' ? 'uzavřen' : 'nový', by: null, result: null, note: '', rec: !!pw?.rec, ...extra };
    state.events.unshift(ev);
    if (state.events.length > 400) state.events.length = 400;
    const p = this.patient(patientId);
    if (kind === 'offline' && p) p.offline = true;
    if (kind === 'online' && p) p.offline = false;
    const quiet = state.klid[patientId] && state.klid[patientId] > Date.now();
    if (k.level === 'crit' || (!quiet && k.level !== 'info')) {
      state.notifications.unshift({ id: nid(), at: ev.at, patientId, eventId: ev.id, kind, level: k.level, ack: false });
      if (state.notifications.length > 100) state.notifications.length = 100;
    }
    commit(); return ev;
  },
  setAlert(eventId, patch) { const e = state.events.find((x) => x.id === eventId); if (!e) return; Object.assign(e, patch); commit(); },
  ackNotification(id) { const n = state.notifications.find((x) => x.id === id); if (n) { n.ack = true; commit(); } },
  ackAll(patientId) { for (const n of state.notifications) if (n.patientId === patientId) n.ack = true; commit(); },

  setWatch(patientId, kind, patch) {
    const p = this.patient(patientId); if (!p || !WATCH_KINDS.includes(kind)) return;
    p.watch = p.watch || defaultWatch();
    p.watch[kind] = { ...p.watch[kind], ...patch };
    commit();
  },
  setConsent(patientId, consent) {
    const p = this.patient(patientId); if (!p) return;
    p.consent = { ...p.consent, ...consent };
    state.events.unshift({ id: nid(), at: Date.now(), patientId, kind: 'consent', state: 'uzavřen', by: 'rodina',
      text: `Rodina nastavila poskytovateli: den ${CONSENT[p.consent.den]}, noc ${CONSENT[p.consent.noc]}, nouzový přístup ${p.consent.nouze ? 'povolen' : 'nepovolen'}.` });
    // a grant above the new consent is over
    commit();
  },
  requestFull(patientId, from, reason) {
    const r = { id: nid(), at: Date.now(), patientId, from, reason, state: 'čeká', until: Date.now() + 120000 };
    state.requests.unshift(r);
    state.notifications.unshift({ id: nid(), at: r.at, patientId, requestId: r.id, kind: 'request', level: 'warn', ack: false });
    commit(); return r;
  },
  answerRequest(reqId, answer, minutes = 15) {
    const r = state.requests.find((x) => x.id === reqId); if (!r || r.state !== 'čeká') return;
    r.state = answer === 'deny' ? 'odmítnuto' : 'povoleno';
    if (answer !== 'deny') {
      state.grants[r.patientId] = { mode: 'full', until: answer === 'forever' ? Date.now() + 365 * 86400000 : Date.now() + minutes * 60000, by: r.from, kind: 'souhlas rodiny' };
      state.watching[r.patientId] = { who: r.from, since: Date.now() };
    }
    for (const n of state.notifications) if (n.requestId === reqId) n.ack = true;
    state.events.unshift({ id: nid(), at: Date.now(), patientId: r.patientId, kind: 'consent', state: 'uzavřen', by: 'rodina',
      text: answer === 'deny' ? `Rodina odmítla žádost o plný obraz (${r.from}).` : `Rodina povolila plný obraz pro ${r.from}${answer === 'forever' ? ' do odvolání' : ` na ${minutes} min`}.` });
    commit();
  },
  emergencyAccess(patientId, who) {
    const p = this.patient(patientId); if (!p || !p.consent.nouze) return false;
    state.grants[patientId] = { mode: 'full', until: Date.now() + 10 * 60000, by: who, kind: 'nouzový přístup' };
    state.watching[patientId] = { who, since: Date.now() };
    state.notifications.unshift({ id: nid(), at: Date.now(), patientId, kind: 'emergency', level: 'crit', ack: false, who });
    state.events.unshift({ id: nid(), at: Date.now(), patientId, kind: 'consent', state: 'uzavřen', by: who, text: `${who} otevřel nouzový přístup k plnému obrazu na 10 minut (kritický alert).` });
    commit(); return true;
  },
  endGrant(patientId, by = 'rodina') {
    if (!state.grants[patientId]) return;
    delete state.grants[patientId]; delete state.watching[patientId];
    state.events.unshift({ id: nid(), at: Date.now(), patientId, kind: 'consent', state: 'uzavřen', by, text: `${by === 'rodina' ? 'Rodina ukončila' : by + ' ukončil'} přístup k plnému obrazu.` });
    commit();
  },
  setWatching(patientId, who, on) { if (on) state.watching[patientId] = { who, since: Date.now() }; else delete state.watching[patientId]; commit(); },
  setKlid(patientId, until) { if (until) state.klid[patientId] = until; else delete state.klid[patientId]; commit(); },
  setNight(on) { state.night = on; commit(); },
  reset() { state = seed(); commit(); },

  /** Housekeeping every few seconds: expired grants and requests, escalation. */
  tick() {
    let changed = false;
    const now = Date.now();
    for (const [pid, g] of Object.entries(state.grants)) if (g.until <= now) { delete state.grants[pid]; delete state.watching[pid]; changed = true;
      state.events.unshift({ id: nid(), at: now, patientId: pid, kind: 'consent', state: 'uzavřen', by: 'systém', text: 'Povolení plného obrazu vypršelo, obraz se vrátil do nastaveného režimu.' }); }
    for (const r of state.requests) if (r.state === 'čeká' && r.until <= now) { r.state = 'vypršelo'; changed = true; }
    for (const e of state.events) if (e.state === 'nový' && KINDS[e.kind]?.level === 'crit' && now - e.at > 120000 && !e.escalated) { e.escalated = true; changed = true; }
    if (changed) commit();
  },

  /** Real events of the real camera from the server, folded into the simulation as the real patient's events. */
  startRealEvents(patientId = 'tapoc2020') {
    let since = Date.now();
    const map = { 'cam-linecross': 'linecross', 'cam-tamper': 'tamper', 'cam-person': 'person', 'cam-motion': 'motion', 'cam-pet': 'motion', 'cam-vehicle': 'motion', 'cam-smart': 'motion' };
    const poll = async () => {
      try {
        const r = await fetch('/api/events?since=' + since); const b = await r.json();
        if (b.ok) { for (const ev of b.events || []) { since = Math.max(since, ev.prijato); const kind = map[ev.kind]; if (kind) this.emit(patientId, kind, { real: true, text: ev.text }); } }
      } catch { /* server away */ }
    };
    setInterval(poll, 3000);
  },
};
setInterval(() => sim.tick(), 3000);

/* ---------- helpers for the pages ---------- */
export const fmtT = (ms) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
export const fmtDT = (ms) => new Date(ms).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function eventText(e) {
  if (e.kind === 'consent') return e.text;
  const k = KINDS[e.kind];
  return e.text || (k ? k.label : e.kind);
}
export function ago(ms) { const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return `${s} s`; if (s < 3600) return `${Math.round(s / 60)} min`; return `${Math.round(s / 3600)} h`; }

/** Rewrites an element only when its content changed: no flicker, no lost clicks on a page that re-renders often. */
export function setHtml(el, html) { if (el.__html === html) return false; el.innerHTML = html; el.__html = html; return true; }

/** "před 12 s" spans refresh in place, so a list is rebuilt only when its items change. */
export function agoSpan(at) { return `<span class="ago" data-at="${at}"></span>`; }
export function refreshAgo(root) { root.querySelectorAll('.ago[data-at]').forEach((el) => { el.textContent = ago(Number(el.dataset.at)); }); }

let toastEl = null;
export function toast(text, level = 'info', onOpen = null) {
  toastEl?.remove();
  const t = document.createElement('div'); t.className = 'toast ' + level; toastEl = t;
  t.innerHTML = `<span class="grow">${esc(text)}</span>`;
  if (onOpen) { const b = document.createElement('button'); b.textContent = 'Otevřít'; b.onclick = () => { t.remove(); onOpen(); }; t.append(b); }
  const x = document.createElement('button'); x.textContent = '✕'; x.onclick = () => t.remove(); t.append(x);
  document.body.append(t);
  setTimeout(() => { if (toastEl === t) t.remove(); }, 8000);
}

/*
 * The bar at the very top when the real camera cannot show: not logged in
 * (the main app is the only place to log in), or no picture at all. Hidden
 * as soon as the picture is live.
 */
export function mountAuthBanner(src) {
  const el = document.createElement('div'); el.id = 'authBar'; el.className = 'hide';
  el.innerHTML = `<span class="grow" id="authText"></span><a class="sm btnlike" href="/" target="_blank" id="authLogin">Přihlásit se</a><a class="sm btnlike sec2 hide" href="/" target="_blank" id="authApp">Hlavní aplikace a diagnostika</a><button class="sm sec" id="authRetry">Načíst znovu</button>`;
  document.body.prepend(el);
  // Přihlášení vede do hlavní aplikace; ta se po něm vrátí sem (?zpet=). Na
  // ploše telefonu (standalone) se nesmí otevřít nové okno: iPhone by ho
  // poslal do Safari a přihlášení by zůstalo tam, ne v aplikaci.
  const zpet = location.pathname + location.search;
  const login = el.querySelector('#authLogin');
  login.href = '/?zpet=' + encodeURIComponent(zpet);
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) login.removeAttribute('target');
  el.querySelector('#authRetry').onclick = () => location.reload();
  const show = (text, login) => { el.querySelector('#authText').innerHTML = text; el.querySelector('#authLogin').classList.toggle('hide', !login); el.querySelector('#authApp').classList.toggle('hide', login); el.classList.remove('hide'); document.body.classList.add('withAuth'); };
  const hide = () => { el.classList.add('hide'); document.body.classList.remove('withAuth'); };
  const check = async () => {
    try {
      const r = await fetch('/api/devices');
      if (r.status === 401) { show('<b>Demo s reálnou kamerou:</b> přihlaste se v hlavní aplikaci (stejný prohlížeč), jinak vidíte jen náhradní scénu.', true); return false; }
    } catch { /* server away: the source will say */ }
    return true;
  };
  check();
  src?.onChange((s) => {
    if (s.status === 'live') { hide(); return; }
    if (s.status === 'offline' && /přihlášeni/.test(s.error || '')) show('<b>Demo s reálnou kamerou:</b> přihlaste se v hlavní aplikaci (stejný prohlížeč), jinak vidíte jen náhradní scénu.', true);
    else if (s.status === 'offline') show(`<b>Obraz z kamery teď nejde:</b> ${esc(s.error || 'kamera nedostupná')} Přihlášení je v pořádku; podívejte se do Diagnostiky v hlavní aplikaci (kamera, tunel, go2rtc). Ukazuji náhradní scénu.`, false);
    else if (s.status === 'connecting' && s.path === 'https') show(`<b>Zkouším náhradní cestu HTTPS…</b> ${esc(s.error || '')}`, false);
  });
  return { check };
}

/** The floating simulation panel: events, requests, night, reset. `role` decides which controls make sense. */
export function mountPanel({ role, patientIds, onPatient }) {
  const el = document.createElement('div'); el.id = 'simPanel';
  const opts = () => sim.state.patients.filter((p) => !patientIds || patientIds.includes(p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  el.innerHTML = `
    <div class="hd"><strong>Simulace</strong><span class="small">▴ rozbalit / sbalit</span></div>
    <div class="bd">
      <label>Pacient <select class="pat">${opts()}</select></label>
      <div class="small muted">Vyvolat událost:</div>
      <div class="grp">
        <button class="sm bad" data-ev="fall">Možný pád</button>
        <button class="sm bad" data-ev="longlie">Dlouhé ležení</button>
        <button class="sm bad" data-ev="sos">SOS náramek</button>
        <button class="sm warn" data-ev="linecross">Překročení čáry</button>
        <button class="sm warn" data-ev="tamper">Zakrytí kamery</button>
        <button class="sm warn" data-ev="inactivity">Nečinnost</button>
        <button class="sm sec" data-ev="person">Osoba</button>
        <button class="sm sec" data-ev="motion">Pohyb</button>
        <button class="sm sec" data-ev="offline">Kamera výpadek</button>
        <button class="sm sec" data-ev="online">Kamera zpět</button>
        <button class="sm sec" data-ev="battery">Slabá baterie</button>
      </div>
      <div class="small muted">Postava v náhradní scéně (když kamera není):</div>
      <div class="grp">
        <button class="sm sec" data-pose="">sama</button><button class="sm sec" data-pose="standing">stojí</button><button class="sm sec" data-pose="seated">sedí</button><button class="sm sec" data-pose="lying">leží</button>
      </div>
      <div class="grp">
        <button class="sm sec" data-act="request">Dispečer žádá o plný obraz</button>
        <label><input type="checkbox" class="night"> Simulovat noc</label>
      </div>
      <div class="grp">
        <a class="small" href="/proto/rodina.html" target="rodina">Rodina</a> ·
        <a class="small" href="/proto/dispecink.html" target="dispecink">Dispečink</a> ·
        <a class="small" href="/proto/provoz.html" target="provoz">Provoz</a> ·
        <a class="small" href="/" target="app">Aplikace</a>
        <span class="grow"></span>
        <button class="sm sec" data-act="reset">Vynulovat</button>
      </div>
      <div class="small muted" id="simDropped"></div>
      <div class="small muted">Otevřete role v dalších oknech vedle sebe: změna v jednom se hned projeví v ostatních.</div>
    </div>`;
  document.body.append(el);
  el.querySelector('.hd').onclick = () => el.classList.toggle('min');
  const pat = () => el.querySelector('.pat').value;
  el.querySelector('.pat').onchange = () => onPatient?.(pat());
  el.querySelectorAll('[data-ev]').forEach((b) => { b.onclick = () => sim.emit(pat(), b.dataset.ev); });
  el.querySelectorAll('[data-pose]').forEach((b) => { b.onclick = () => window.__zdroj?.setSyntheticPose(b.dataset.pose || null); });
  el.querySelector('[data-act=request]').onclick = () => sim.requestFull(pat(), 'Dispečerka Jana Nováková', 'ověření alertu');
  el.querySelector('[data-act=reset]').onclick = () => { if (confirm('Vynulovat simulaci ve všech oknech?')) sim.reset(); };
  const night = el.querySelector('.night'); night.checked = sim.state.night; night.onchange = () => sim.setNight(night.checked);
  sim.subscribe((s) => { night.checked = s.night; const d = s.lastDropped; el.querySelector('#simDropped').textContent = d && Date.now() - d.at < 20000 ? `Událost „${KINDS[d.kind]?.label}“ se nezapsala: ${d.reason} (nastavení poskytovatele).` : ''; });
  el.classList.add('min');
  return { patient: pat, select: (id) => { el.querySelector('.pat').value = id; } };
}
