/*
 * Stav prototypu: pacienti, souhlasy s režimem obrazu, události, alerty,
 * žádosti o plný obraz, notifikace. Přihlášeným (poskytovatel i rodina) ho
 * drží server (/api/proto/stav), takže souhlas nastavený na telefonu rodiny
 * vidí dispečink na jiném počítači do 2 s. Bez přihlášení (ukázka) zůstává
 * stav v tomhle prohlížeči: localStorage + BroadcastChannel mezi okny.
 * Data i akce jsou v sim-core.js, stejné pro prohlížeč i server.
 */
import { KINDS, LEVEL_LABEL, CONSENT, WATCH_KINDS, defaultWatch, describeWatch, seed, proved, jeNocPro, efektivni, casy, KLID_NAVZDY, RYCHLE, poskytovatel, poskytovatelPro, kontaktyPro, describeKontakty, KONTAKTY_MAX, upozorneniVychozi, normalizeTelefonCz, jeEmail } from '/proto/sim-core.js';
export { KINDS, LEVEL_LABEL, CONSENT, WATCH_KINDS, defaultWatch, describeWatch, casy, KLID_NAVZDY, RYCHLE, kontaktyPro, describeKontakty, KONTAKTY_MAX, upozorneniVychozi, normalizeTelefonCz, jeEmail };

const KEY = 'famicura.proto.v1';
const CH = 'famicura-proto';
const POLL_MS = 2000;

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.patients) { for (const p of s.patients) p.watch = p.watch || defaultWatch(); return s; } } catch { /* fresh */ }
  const s = seed(); save(s); return s;
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

let state = load();
let server = null;              // { v } když stav drží server
const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CH) : null;
const subs = new Set();
const notify = (info) => subs.forEach((f) => f(state, info));
bc?.addEventListener('message', (m) => { if (!server && m.data?.type === 'state') { state = m.data.state; notify(); } });
window.addEventListener('storage', (e) => { if (!server && e.key === KEY && e.newValue) { try { state = JSON.parse(e.newValue); notify(); } catch { /* ignore */ } } });

function commit() { save(state); bc?.postMessage({ type: 'state', state }); notify(); }

/* ---------- server ---------- */
async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch { /* bez těla */ }
  if (!r.ok) { const e = new Error(data.error || `Chyba serveru (${r.status})`); e.status = r.status; throw e; }
  return data;
}
function adopt(b, info) {
  if (!server) return;
  if (b.v === server.v && !info) return;
  server.v = b.v; state = b.state;
  for (const p of state.patients) p.watch = p.watch || defaultWatch();
  notify(info);
}
let pripojovani = null, pollTimer = null, polluji = false;
let chybaServeru = '';             // proč se stav ze serveru nenačetl (jiná chyba než nepřihlášení)
async function poll() {
  if (!server || polluji) return;
  polluji = true;
  try { const b = await api(`/api/proto/stav?v=${server.v}`); if (b.zmena) adopt(b); }
  catch (e) { if (e.status === 401 || e.status === 403) odpojit(); }
  polluji = false;
}
function odpojit() { server = null; clearInterval(pollTimer); pollTimer = null; state = load(); notify({ nahrazeno: true }); }

/** Zkusí vzít stav ze serveru (po přihlášení znovu). Vrací true, když stav drží server. */
async function pripojit() {
  if (server) return true;
  if (pripojovani) return pripojovani;
  pripojovani = (async () => {
    try {
      const b = await api('/api/proto/stav');
      server = { v: 0 }; adopt(b, { nahrazeno: true });
      if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
      chybaServeru = '';
      return true;
    } catch (e) { chybaServeru = e.status === 401 || e.status === 403 ? '' : (e.message || 'server neodpovídá'); return false; }
    finally { pripojovani = null; }
  })();
  return pripojovani;
}

/** Jedna akce: na serveru ji provede server a vrátí nový stav, jinak běží tady. */
async function run(nazev, args) {
  if (pripojovani) await pripojovani;   // stránka může volat akci dřív, než je jasné, kdo stav drží
  if (server) {
    try { const b = await api('/api/proto/akce', { akce: nazev, args }); adopt(b); return b.vysledek; }
    catch (e) { if (e.status === 401 || e.status === 403) { odpojit(); return runLocal(nazev, args); } toast(e.message, 'crit'); return undefined; }
  }
  return runLocal(nazev, args);
}
function runLocal(nazev, args) {
  const out = proved(state, nazev, args);
  state = out.state;
  if (out.zmena) commit();
  return out.vysledek;
}

export const sim = {
  get state() { return state; },
  get naServeru() { return !!server; },
  /** Text chyby, když přihlášený uživatel stav ze serveru nedostal (např. databáze); prázdné = v pořádku nebo nepřihlášen. */
  get chybaServeru() { return chybaServeru; },
  /** Údaje poskytovatele ze sdíleného stavu (dispečink je zadává na jednom místě). */
  get poskytovatel() { return poskytovatel(state); },
  poskytovatelPro(p) { return poskytovatelPro(state, p); },
  setPoskytovatel(p) { return run('setPoskytovatel', [p]); },
  poznamka(patientId, text, by) { return run('poznamka', [patientId, text, by]); },
  setNote(patientId, text, by) { return run('setNote', [patientId, text, by]); },
  pripojit,
  /** f(state, info): info.nahrazeno = celý stav přišel odjinud (první načtení ze serveru), ne nová událost. */
  subscribe(f) { subs.add(f); f(state); return () => subs.delete(f); },
  patient(id) { return state.patients.find((p) => p.id === id); },
  /** Kamera ze serveru, kterou simulace nezná: založí k ní pacienta hned tady (stránka s ním počítá) i na serveru. */
  async ensurePatient(p) {
    if (!state.patients.some((x) => x.id === p.id)) { proved(state, 'ensurePatient', [p]); notify(); }
    if (pripojovani) await pripojovani;
    if (server) { if (!state.patients.some((x) => x.id === p.id)) run('ensurePatient', [p]); }
    else commit();
  },
  /** Noc podle časů pacienta (rodina si je nastaví), nebo simulovaná noc z panelu. */
  isNight(patientId) { return state.night || jeNocPro(this.patient(patientId)); },

  /** Co poskytovatel vidí teď: povolení z žádosti > rychlé přepnutí > výpadek > nastavení podle denní doby. */
  efektivni(patientId) { return efektivni(state, this.patient(patientId), Date.now(), state.night); },
  effectiveMode(patientId) { return this.efektivni(patientId).mode; },
  /** Why the provider sees what it sees, in words. */
  modeReason(patientId) { return this.efektivni(patientId).proc; },

  emit(patientId, kind, extra = {}) { return run('emit', [patientId, kind, extra]); },
  setAlert(eventId, patch) { return run('setAlert', [eventId, patch]); },
  ackNotification(id) { return run('ackNotification', [id]); },
  ackAll(patientId) { return run('ackAll', [patientId]); },
  setWatch(patientId, kind, patch) { return run('setWatch', [patientId, kind, patch]); },
  setKontakty(patientId, kontakty, by) { return run('setKontakty', [patientId, kontakty, by]); },
  setConsent(patientId, consent) { return run('setConsent', [patientId, consent]); },
  requestFull(patientId, from, reason) { return run('requestFull', [patientId, from, reason]); },
  answerRequest(reqId, answer, minutes = 15) { return run('answerRequest', [reqId, answer, minutes]); },
  emergencyAccess(patientId, who) { return run('emergencyAccess', [patientId, who]); },
  endGrant(patientId, by = 'rodina') { return run('endGrant', [patientId, by]); },
  setWatching(patientId, who, on) { return run('setWatching', [patientId, who, on]); },
  setKlid(patientId, until) { return run('setKlid', [patientId, until]); },
  klidDo(patientId, volba) { return run('klidDo', [patientId, volba]); },
  rychle(patientId, mode) { return run('rychle', [patientId, mode]); },
  setNight(on) { return run('setNight', [on]); },
  reset() { return run('reset', []); },

  /** Housekeeping every few seconds; na serveru to dělá server při každém dotazu. */
  tick() { if (!server) runLocal('tick', []); },

  /** Real events of the real camera from the server, folded into the simulation as the real patient's events.
   *  Se stavem na serveru je skládá server sám (jednou pro všechny), tady jen bez přihlášení. */
  startRealEvents(patientId = 'tapoc2020') {
    let since = Date.now();
    const map = { 'cam-linecross': 'linecross', 'cam-tamper': 'tamper', 'cam-person': 'person', 'cam-motion': 'motion', 'cam-pet': 'motion', 'cam-vehicle': 'motion', 'cam-smart': 'motion' };
    const poll = async () => {
      if (server) { since = Date.now(); return; }
      try {
        const r = await fetch('/api/events?since=' + since); const b = await r.json();
        if (b.ok) { for (const ev of b.events || []) { since = Math.max(since, ev.prijato); const kind = map[ev.kind]; if (kind) this.emit(patientId, kind, { real: true, text: ev.text }); } }
      } catch { /* server away */ }
    };
    setInterval(poll, 3000);
  },
};
setInterval(() => sim.tick(), 3000);
pripojit();

/* ---------- helpers for the pages ---------- */
export const fmtT = (ms) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
export const fmtDT = (ms) => new Date(ms).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function eventText(e) {
  if (e.kind === 'consent' || e.kind === 'poznamka') return e.text;
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
  // patientIds: pole, nebo funkce (dispečink podle přepínače skutečné/demo); seznam se obnovuje sám
  const ids = () => (typeof patientIds === 'function' ? patientIds() : patientIds);
  const opts = () => sim.state.patients.filter((p) => { const i = ids(); return !i || i.includes(p.id); }).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
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
        <a class="small" href="/proto/rodina.html?simulace=1" target="rodina">Rodina</a> ·
        <a class="small" href="/proto/dispecink.html" target="dispecink">Dispečink</a> ·
        <a class="small" href="/proto/provoz.html" target="provoz">Provoz</a> ·
        <a class="small" href="/" target="app">Aplikace</a>
        <span class="grow"></span>
        <button class="sm sec" data-act="reset">Vynulovat</button>
      </div>
      <div class="small muted" id="simDropped"></div>
      <div class="small muted" id="simKde"></div>
    </div>`;
  document.body.append(el);
  el.querySelector('.hd').onclick = () => el.classList.toggle('min');
  const pat = () => el.querySelector('.pat').value;
  el.querySelector('.pat').onchange = () => onPatient?.(pat());
  el.querySelectorAll('[data-ev]').forEach((b) => { b.onclick = () => sim.emit(pat(), b.dataset.ev); });
  el.querySelectorAll('[data-pose]').forEach((b) => { b.onclick = () => window.__zdroj?.setSyntheticPose(b.dataset.pose || null); });
  el.querySelector('[data-act=request]').onclick = () => sim.requestFull(pat(), 'Dispečerka Jana Nováková', 'ověření alertu');
  el.querySelector('[data-act=reset]').onclick = () => { if (confirm(sim.naServeru ? 'Vynulovat simulaci pro všechny (dispečink, rodina i provoz na všech zařízeních)?' : 'Vynulovat simulaci ve všech oknech?')) sim.reset(); };
  const night = el.querySelector('.night'); night.checked = sim.state.night; night.onchange = () => sim.setNight(night.checked);
  const refresh = () => { const sel = el.querySelector('.pat'); const html = opts(); if (sel.__html === html) return; const v = sel.value; sel.innerHTML = html; sel.__html = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; else onPatient?.(sel.value); };
  sim.subscribe((s) => { night.checked = s.night; refresh();
    el.querySelector('#simKde').textContent = sim.naServeru ? 'Stav drží server: změna na jednom zařízení se u ostatních přihlášených projeví do 2 s.' : 'Bez přihlášení běží simulace jen v tomhle prohlížeči (okna vedle sebe se vidí).';
    // data poskytovatele na serveru se nenulují (jen ukázka v prohlížeči)
    el.querySelector('[data-act=reset]').classList.toggle('hide', sim.naServeru);
    const d = s.lastDropped; el.querySelector('#simDropped').textContent = d && Date.now() - d.at < 20000 ? `Událost „${KINDS[d.kind]?.label}“ se nezapsala: ${d.reason} (nastavení poskytovatele).` : ''; });
  el.classList.add('min');
  return { patient: pat, select: (id) => { el.querySelector('.pat').value = id; }, refresh };
}
