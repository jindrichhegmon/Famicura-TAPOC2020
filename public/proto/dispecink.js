import { createSource } from '/proto/zdroj.js';
import { mountAuthBanner, sim, KINDS, LEVEL_LABEL, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, agoSpan, refreshAgo, WATCH_KINDS } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
/* Údaje poskytovatele (název, telefon, dispečer, směna, záloha) se zadávají
 * jen tady a ukládají do sdíleného stavu na serveru: stejně je vidí všichni
 * dispečeři, detail kamery i aplikace rodiny. Jméno dispečera jde do převzetí
 * alertů a do žádostí o obraz. */
const ME = () => sim.poskytovatel.dispecer;
const HL_POLE = ['nazev', 'telefon', 'email', 'dispecer', 'smena', 'zaloha', 'zalohaTelefon', 'vedouci', 'vedouciTelefon', 'eskalaceMin'];
const hlPole = (k) => $('hl' + k[0].toUpperCase() + k.slice(1));
function renderHlavicka() {
  const h = sim.poskytovatel;
  $('hlavicka').textContent = [h.nazev, h.telefon, h.dispecer, h.smena, h.zaloha ? `záloha: ${h.zaloha}` : ''].filter(Boolean).join(' · ');
  renderSmena();
}
/** Karta Směna: text z nastavení a čísla spočítaná z dnešních alertů (ne vymyšlená). */
function renderSmena() {
  const h = sim.poskytovatel, s = sim.state;
  const dnes = new Date(); dnes.setHours(0, 0, 0, 0);
  const dnesni = s.events.filter((e) => e.at >= dnes.getTime() && KINDS[e.kind] && KINDS[e.kind].level !== 'info' && e.kind !== 'consent');
  const prevzate = dnesni.filter((e) => e.takenAt);
  const prum = prevzate.length ? Math.round(prevzate.reduce((a, e) => a + (e.takenAt - e.at), 0) / prevzate.length / 1000) : null;
  const uzavrene = dnesni.filter((e) => e.state === 'uzavřen' && e.result);
  const plane = uzavrene.length ? Math.round(100 * uzavrene.filter((e) => e.result === 'planý poplach').length / uzavrene.length) : null;
  const kam = [h.zaloha ? `zálohu ${h.zaloha}${h.zalohaTelefon ? ' (' + h.zalohaTelefon + ')' : ''}` : 'zálohu', h.vedouci ? `vedoucí ${h.vedouci}${h.vedouciTelefon ? ' (' + h.vedouciTelefon + ')' : ''}` : 'vedoucího'].join(' a ');
  $('smenaInfo').innerHTML = `${esc(h.dispecer)}${h.smena ? ', ' + esc(h.smena) : ''}. Nepřevzatý kritický alert po <strong>${h.eskalaceMin} min</strong> eskaluje na ${esc(kam)}. `
    + `Dnes: alertů <strong>${dnesni.length}</strong>, doba převzetí <strong>${prum === null ? '–' : Math.floor(prum / 60) + ':' + String(prum % 60).padStart(2, '0') + ' min'}</strong>, plané poplachy <strong>${plane === null ? '–' : plane + ' %'}</strong>.`;
}
function otevriNastaveni() {
  const h = sim.poskytovatel;
  for (const k of HL_POLE) hlPole(k).value = h[k] ?? '';
  $('zdrojNastaveni').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === zdroj)));
  $('hlErr').classList.add('hide');
  $('nastaveni').classList.remove('hide'); $('hlNazev').focus();
}
$('hlUprav').onclick = otevriNastaveni;
$('hlZrusit').onclick = () => $('nastaveni').classList.add('hide');
$('nastaveniZavrit').onclick = () => $('nastaveni').classList.add('hide');
// Zavírá se jen tlačítky: klepnutí vedle okna ani Enter v poli okno nezavřou, uloží jen tlačítko Uložit.
$('hlForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const pole = [...$('hlForm').querySelectorAll('input')]; const i = pole.indexOf(e.target); (pole[i + 1] || $('hlForm').querySelector('button[type=submit]')).focus(); } });
$('hlForm').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); $('nastaveni').classList.add('hide'); } });
$('zdrojNastaveni').querySelectorAll('button').forEach((b) => { b.onclick = () => nastavZdroj(b.dataset.z); });
$('hlForm').onsubmit = async (e) => {
  e.preventDefault();
  const p = {}; for (const k of HL_POLE) p[k] = k === 'eskalaceMin' ? Number(hlPole(k).value) : hlPole(k).value.trim();
  try {
    const r = await sim.setPoskytovatel(p);
    if (r === undefined && sim.naServeru) { $('hlErr').textContent = 'Uložení se nepodařilo, zkuste to znovu.'; $('hlErr').classList.remove('hide'); return; }
  } catch (ex) { $('hlErr').textContent = ex.message; $('hlErr').classList.remove('hide'); return; }
  $('nastaveni').classList.add('hide'); renderHlavicka(); toast('Nastavení uloženo.');
};
renderHlavicka();

/* ---------- nápověda a asistent (grafika Case manageru) ---------- */
import('/proto/napoveda.js').then(({ TEMATA, odpovez, napovedaText }) => {
  const nap = $('napoveda');
  $('napTemata').innerHTML = TEMATA.map((t) => `<details class="naptema" id="nap-${t.id}"><summary>${esc(t.nazev)}</summary><p class="tx">${esc(t.text)}</p>${(t.obrazky || []).map((o) => `<figure><img src="${esc(o.src)}" alt="${esc(o.popis)}" loading="lazy" onerror="this.parentElement.remove()"><figcaption>${esc(o.popis)}</figcaption></figure>`).join('')}</details>`).join('');
  const tab = (name) => { nap.querySelectorAll('.naptabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name))); $('napTemata').classList.toggle('hide', name !== 'temata'); $('napChat').classList.toggle('hide', name !== 'chat'); if (name === 'chat') $('chatIn').focus(); };
  nap.querySelectorAll('.naptabs button').forEach((b) => { b.onclick = () => tab(b.dataset.tab); });
  $('napovedaBtn').onclick = () => { nap.classList.remove('hide'); tab('temata'); };
  $('napZavrit').onclick = () => nap.classList.add('hide');
  nap.addEventListener('click', (e) => { if (e.target === nap) nap.classList.add('hide'); });
  const log = $('chatLog');
  const zprava = (text, kdo, tema) => { const d = document.createElement('div'); d.className = 'msg ' + kdo; d.innerHTML = (tema ? `<span class="tema">${esc(tema)}</span>` : '') + esc(text); log.append(d); log.scrollTop = log.scrollHeight; return d; };
  zprava('Dobrý den, jsem asistent dispečinku. Zeptejte se, nebo klepněte na jednu z otázek níže.', 'bot');
  const PRIKLADY = ['Jak požádat rodinu o plný obraz?', 'Kdy můžu použít nouzový přístup?', 'Jak založit účet rodině?', 'Proč nevidím obraz z kamery?', 'Co dělá tlačítko Převzít?'];
  $('chatOtazky').innerHTML = PRIKLADY.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  $('chatOtazky').querySelectorAll('button').forEach((b) => { b.onclick = () => { $('chatIn').value = b.textContent; $('chatForm').requestSubmit(); }; });
  let aiNaServeru = null;   // null = ještě nevíme, false = neodpovídá AI, true = odpovídá AI přes webhook
  $('chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('chatIn').value.trim(); if (!q) return;
    $('chatIn').value = ''; zprava(q, 'ja');
    const lokalni = odpovez(q);
    if (aiNaServeru === false) { zprava(lokalni.text, 'bot', lokalni.nazev); return; }
    const cekam = zprava('…', 'bot');
    try {
      const r = await fetch('/api/proto/asistent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dotaz: q, kontext: napovedaText() }) });
      const b = await r.json().catch(() => ({}));
      if (b.nastaveno === false) { aiNaServeru = false; cekam.remove(); zprava(lokalni.text, 'bot', lokalni.nazev); return; }
      aiNaServeru = true; $('chatPozn').textContent = 'Asistent odpovídá přes AI (webhook Make) s nápovědou dispečinku jako podkladem.';
      cekam.remove();
      if (r.ok && b.odpoved) zprava(b.odpoved, 'bot', 'AI');
      else { zprava(lokalni.text, 'bot', lokalni.nazev); zprava(`AI teď neodpovídá (${b.error || r.status}), odpověděl jsem z nápovědy.`, 'bot'); }
    } catch { cekam.remove(); zprava(lokalni.text, 'bot', lokalni.nazev); }
  };
  // klepnutí na název tématu v odpovědi otevře téma v záložce Témata
  log.addEventListener('click', (e) => { const t = e.target.closest('.msg.bot .tema'); if (!t || t.textContent === 'AI') return; const d = [...document.querySelectorAll('.naptema')].find((x) => x.querySelector('summary').textContent === t.textContent); if (d) { tab('temata'); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); } });
});
let selected = null;
let overlay = false;                 // skeleton over a full or blurred picture in the detail
let askOpen = false, emergOpen = false;   // inline forms in the detail
const seen = new Set(sim.state.events.map((e) => e.id));
const tileRegs = new Map();          // patientId → unregister
let detailUnreg = null;

/* Bez přihlášení se přihlašuje rovnou tady (heslo Famicura), ne oklikou přes
 * hlavní aplikaci. Po přihlášení se stránka načte znovu: obraz, stav ze
 * serveru i účty rodiny už jdou s cookie. */
(async () => {
  let role = null;
  try { const r = await fetch('/api/rodina/ja', { cache: 'no-store' }); if (r.ok) role = (await r.json()).role; } catch { /* server away: stránka zůstane schovaná a gate ukáže chybu při pokusu o přihlášení */ }
  if (role === 'admin') { document.body.classList.remove('pending'); return; }
  if (role === 'rodina') $('gateSub').textContent = 'Jste přihlášen(a) jako rodina. Dispečink je jen pro poskytovatele: přihlaste se heslem Famicura.';
  $('gate').classList.remove('hide');
  setTimeout(() => $('gPw').focus(), 50);
  $('gLogin').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('gLoginErr'); err.classList.add('hide');
    const b = e.target.querySelector('button'); b.disabled = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('gPw').value }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = body.error || `Chyba (${r.status})`; err.classList.remove('hide'); b.disabled = false; return; }
      location.reload();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); b.disabled = false; }
  };
})();

const src = createSource({ deviceId: 'tapoc2020' });
window.__zdroj = src;
src.connect();
mountAuthBanner(src);
src.onChange((s) => { $('srcNote').textContent = s.status === 'live' ? (s.path === 'https' ? 'obraz: skutečná kamera (HTTPS)' : 'obraz: skutečná kamera') : s.status === 'connecting' ? 'obraz: připojuji…' : 'obraz: náhradní scéna'; });
sim.startRealEvents('tapoc2020');
/* Přepínač zdroje: „Jen skutečné kamery“ ukáže jen kamery připojené k serveru
 * (pacient s real: true), „Demo“ i fiktivní pacienty. Volba je na tomhle
 * zařízení (localStorage), stav simulace zůstává společný; ?zdroj=demo|real ji přepne. */
const ZDROJ_KEY = 'famicura.proto.zdroj';
const zParam = new URLSearchParams(location.search).get('zdroj');
let zdroj = ['real', 'demo'].includes(zParam) ? zParam : (localStorage.getItem(ZDROJ_KEY) === 'demo' ? 'demo' : 'real');
const visible = (p) => zdroj === 'demo' || !!p.real;
function renderZdroj() { $('zdroj').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === zdroj))); }
function nastavZdroj(z) {
  zdroj = z; localStorage.setItem(ZDROJ_KEY, zdroj); renderZdroj();
  $('zdrojNastaveni').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === zdroj)));
  if (selected && !visible(sim.patient(selected))) { selected = null; renderDetail(); }
  panel.refresh(); renderTiles(); renderQueue();
}
$('zdroj').querySelectorAll('button').forEach((b) => { b.onclick = () => nastavZdroj(b.dataset.z); });
renderZdroj();
const panel = mountPanel({ role: 'dispecink', patientIds: () => sim.state.patients.filter(visible).map((p) => p.id), onPatient: () => {} });

// ?rezim=full|blur|skeleton|none opens the real camera in that mode (as if the
// family had set it for day and night) and straight in the detail.
const rezim = new URLSearchParams(location.search).get('rezim');
if (rezim && ['full', 'blur', 'skeleton', 'none'].includes(rezim)) {
  sim.setConsent('tapoc2020', { den: rezim, noc: rezim });
  selected = 'tapoc2020';
}

/** What the tile of this patient may draw. */
function tileMode(pid) {
  const m = sim.effectiveMode(pid);
  if (m === 'offline') return 'none';
  return m;
}
function detailMode(pid) {
  const m = tileMode(pid);
  if (overlay && (m === 'full' || m === 'blur')) return m === 'full' ? 'fullskel' : 'blurskel';
  return m;
}
function openAlerts(pid) { return sim.state.events.filter((e) => e.patientId === pid && e.state !== 'uzavřen' && KINDS[e.kind] && KINDS[e.kind].level !== 'info'); }
function statusOf(p) {
  if (p.offline) return 'off';
  const o = openAlerts(p.id);
  if (o.some((e) => KINDS[e.kind].level === 'crit')) return 'crit';
  if (o.length) return 'warn';
  return 'klid';
}

let beepCtx = null;
function beep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = beepCtx.createOscillator(), g = beepCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(beepCtx.destination);
    o.start(); o.stop(beepCtx.currentTime + 0.35);
  } catch { /* no audio */ }
}

function renderTiles() {
  const s = sim.state;
  const only = $('onlyOpen').checked;
  const list = s.patients.filter(visible).filter((p) => !only || openAlerts(p.id).length || p.offline);
  const order = { crit: 0, warn: 1, off: 2, klid: 3 };
  // the real camera first, always; the rest by how urgent they are
  list.sort((a, b) => (b.real ? 1 : 0) - (a.real ? 1 : 0) || order[statusOf(a)] - order[statusOf(b)]);
  const box = $('tiles');
  // keep canvases: rebuild only when the set or order changed
  const key = list.map((p) => p.id).join(',');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    for (const u of tileRegs.values()) u();
    tileRegs.clear();
    box.innerHTML = list.map((p) => `<div class="tile" data-id="${p.id}"><div class="stage"><canvas></canvas><span class="tag"></span></div><div class="nm"><span>${esc(p.name)}</span><span class="badge st-badge"></span></div><div class="st"></div></div>`).join('');
    box.querySelectorAll('.tile').forEach((t) => {
      const pid = t.dataset.id;
      tileRegs.set(pid, src.register(t.querySelector('canvas'), () => tileMode(pid)));
      t.onclick = () => { selected = pid; askOpen = emergOpen = false; panel.select(pid); renderDetail(true); renderTiles(); };
    });
  }
  box.querySelectorAll('.tile').forEach((t) => {
    const p = sim.patient(t.dataset.id); const st = statusOf(p);
    t.className = 'tile ' + st + (selected === p.id ? ' sel' : '');
    t.querySelector('.tag').textContent = p.offline ? 'kamera nedostupná' : { none: 'bez obrazu', skeleton: 'drátěný model', blur: 'rozostření', full: 'plný obraz' }[tileMode(p.id)] || '';
    const b = t.querySelector('.st-badge'); b.textContent = { crit: 'kritické', warn: 'varování', off: 'offline', klid: 'klid' }[st]; b.className = 'badge st-badge ' + (st === 'klid' ? 'ok' : st === 'off' ? 'tech' : st);
    const last = s.events.find((e) => e.patientId === p.id && e.kind !== 'consent' && e.kind !== 'poznamka');
    t.querySelector('.st').textContent = last ? `${eventText(last)} · před ${ago(last.at)}` : 'bez událostí';
  });
  $('nPat').textContent = s.patients.filter(visible).length;
  const vis = (e) => visible(sim.patient(e.patientId) || {});
  const opens = s.events.filter((e) => e.state === 'nový' && KINDS[e.kind] && KINDS[e.kind].level !== 'info' && vis(e));
  $('nNew').textContent = opens.length;
  $('nCrit').textContent = opens.filter((e) => KINDS[e.kind].level === 'crit').length;
  const crit = s.events.filter((e) => e.state !== 'uzavřen' && KINDS[e.kind]?.level === 'crit' && vis(e));
  const critHtml = crit.slice(0, 3).map((e) => `<div class="banner crit pulse"><span class="badge crit">kritické</span><strong>${esc(sim.patient(e.patientId)?.name)}</strong><span class="grow">${esc(eventText(e))} · ${fmtT(e.at)} · ${esc(e.state)}${e.by ? ' – ' + esc(e.by) : ''}${e.escalated ? ' · <span class="esc">ESKALOVÁNO vedoucímu</span>' : ''}</span>
    ${e.state === 'nový' ? `<button class="sm" data-take="${e.id}">Převzít</button>` : ''}<button class="sm sec" data-open="${e.patientId}">Otevřít obraz</button><button class="sm sec" data-call="${e.patientId}">Zavolat rodině</button></div>`).join('');
  if (setHtml($('critBanner'), critHtml)) bindQueueButtons($('critBanner'));
}

function bindQueueButtons(root) {
  root.querySelectorAll('[data-take]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); sim.setAlert(b.dataset.take, { state: 'převzat', by: ME(), takenAt: Date.now() }); }; });
  root.querySelectorAll('[data-solve]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); sim.setAlert(b.dataset.solve, { state: 'řešen', by: ME() }); }; });
  root.querySelectorAll('[data-close]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const sel = b.parentElement.querySelector('select'); sim.setAlert(b.dataset.close, { state: 'uzavřen', by: ME(), result: sel ? sel.value : 'vyřešeno', closedAt: Date.now() }); }; });
  root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); selected = b.dataset.open; panel.select(selected); renderDetail(true); renderTiles(); $('detail').scrollIntoView({ behavior: 'smooth' }); }; });
  root.querySelectorAll('[data-call]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const u = (rodinaUzivatele.get(b.dataset.call) || [])[0]; toast(u ? `Volám rodině: ${u.jmeno}, ${u.telefon.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')} (simulace hovoru)` : 'Volám rodině: Petr Novák, 777 123 456 (simulace, účet rodiny ještě není založený)'); }; });
}

function renderQueue() {
  const s = sim.state;
  const items = s.events.filter((e) => e.state !== 'uzavřen' && KINDS[e.kind] && KINDS[e.kind].level !== 'info' && visible(sim.patient(e.patientId) || {}));
  const order = { crit: 0, warn: 1, tech: 2 };
  items.sort((a, b) => order[KINDS[a.kind].level] - order[KINDS[b.kind].level] || a.at - b.at);
  const queueHtml = items.map((e) => {
    const k = KINDS[e.kind]; const p = sim.patient(e.patientId);
    const btn = e.state === 'nový' ? `<button class="sm" data-take="${e.id}">Převzít</button>`
      : e.state === 'převzat' ? `<button class="sm" data-solve="${e.id}">Řeším</button>`
      : `<select class="sm"><option>planý poplach</option><option>vyřešeno na dálku</option><option>výjezd pečovatele</option><option>záchranná služba</option><option>předáno rodině</option></select><button class="sm ok" data-close="${e.id}">Uzavřít</button>`;
    return `<li><div class="head"><span><span class="badge ${k.level}">${esc(LEVEL_LABEL[k.level])}</span> <strong>${esc(p?.name)}</strong></span><span class="small muted">${fmtT(e.at)} · ${agoSpan(e.at)}</span></div>
      <div class="small">${esc(eventText(e))}${e.real ? ' <span class="badge ok">skutečná</span>' : ''} · <em>${esc(e.state)}</em>${e.by ? ' – ' + esc(e.by) : ''}${e.escalated ? ' · <span class="esc">eskalováno</span>' : ''}</div>
      <div class="row">${btn}<button class="sm sec" data-open="${e.patientId}">Otevřít</button></div></li>`;
  }).join('') || '<li class="muted">Žádný otevřený alert. Klid.</li>';
  if (setHtml($('queue'), queueHtml)) bindQueueButtons($('queue'));
  refreshAgo($('queue'));
}

function renderDetail(rebuild = false) {
  const d = $('detail');
  if (!selected) { d.classList.add('hide'); return; }
  const p = sim.patient(selected); if (!p) return;
  d.classList.remove('hide');
  if (rebuild || !d.querySelector('canvas')) {
    detailUnreg?.(); 
    d.innerHTML = `<div class="row"><h2 class="grow">${esc(p.name)} <span class="muted small">${esc(p.place)}</span></h2><button class="sm sec" id="closeD">Zavřít</button></div>
      <div class="stage"><canvas id="dcv"></canvas><span class="tag" id="dtag"></span></div>
      <div class="modebar"><span class="small" id="dmode"></span><label class="small"><input type="checkbox" id="ovl"> drátěný model přes obraz</label></div>
      <div class="row" id="dbtn"></div>
      <div class="kv" style="margin-top:10px"><dt>Poskytovatel</dt><dd>${esc(sim.poskytovatelPro(p))}${p.real && sim.poskytovatel.telefon ? ' · ' + esc(sim.poskytovatel.telefon) : ''}</dd><dt>Poznámka</dt><dd>${esc(p.note || '–')}</dd></div>
      <h3 style="margin-top:12px">Uživatelé rodiny <span class="small muted" style="text-transform:none;font-weight:400">– kdo smí otevřít aplikaci rodiny k téhle kameře</span></h3>
      <div id="dusers"></div>
      <h3 style="margin-top:12px">Poznámky dispečinku <span class="small muted" style="text-transform:none;font-weight:400">– datum, čas a jméno se doplní samy; zapisují se do logu kamery, rodina je nevidí</span></h3>
      <div class="notes"><textarea id="dnote" maxlength="1000" placeholder="Např. Volala dcera, klient v pořádku, kontrola zítra ráno."></textarea><div class="row"><button class="sm" id="dnoteAdd">Přidat poznámku</button><span class="small muted" id="dnoteKdo"></span></div><ul id="dnotes"></ul></div>
      <h3 style="margin-top:12px">Sledování a nahrávání <span class="small muted" style="text-transform:none;font-weight:400">– nastavuje poskytovatel, rodina to vidí</span></h3>
      <table class="watch"><thead><tr><th>Událost</th><th>Hlídat</th><th>Jen v hodinách</th><th>Nahrávat</th></tr></thead><tbody id="dwatch">${WATCH_KINDS.map((k) => `<tr data-k="${k}"><td>${esc(KINDS[k].label)} <span class="badge ${KINDS[k].level}">${esc(KINDS[k].source)}</span></td><td><input type="checkbox" class="on"></td><td><input type="time" class="from"> – <input type="time" class="to"></td><td><input type="checkbox" class="rec"></td></tr>`).join('')}</tbody></table>
      <h3 style="margin-top:12px">Historie</h3><ul class="list" id="dhist"></ul>`;
    detailUnreg = src.register(d.querySelector('#dcv'), () => detailMode(selected));
    d.querySelectorAll('#dwatch tr').forEach((tr) => {
      const k = tr.dataset.k, w = p.watch?.[k] || { on: true, from: '', to: '', rec: false };
      tr.querySelector('.on').checked = w.on; tr.querySelector('.from').value = w.from; tr.querySelector('.to').value = w.to; tr.querySelector('.rec').checked = w.rec;
      const push = () => sim.setWatch(p.id, k, { on: tr.querySelector('.on').checked, from: tr.querySelector('.from').value, to: tr.querySelector('.to').value, rec: tr.querySelector('.rec').checked });
      tr.querySelectorAll('input').forEach((i) => { i.onchange = push; });
    });
    d.querySelector('#closeD').onclick = () => { selected = null; renderDetail(); renderTiles(); };
    renderUzivatele(p);
    const ovl = d.querySelector('#ovl'); ovl.checked = overlay; ovl.onchange = () => { overlay = ovl.checked; };
    const pridej = async () => { const ta = d.querySelector('#dnote'); const t = ta.value.trim(); if (!t) { ta.focus(); return; } ta.disabled = true; await sim.poznamka(p.id, t, ME()); ta.value = ''; ta.disabled = false; ta.focus(); toast('Poznámka zapsána.'); };
    d.querySelector('#dnoteAdd').onclick = pridej;
    d.querySelector('#dnote').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); pridej(); } });
  }
  const s = sim.state;
  const mode = tileMode(p.id);
  d.querySelector('#dtag').textContent = { none: 'bez obrazu', skeleton: 'drátěný model', blur: 'rozostření', full: 'plný obraz' }[mode];
  d.querySelector('#dmode').innerHTML = `Rodina povolila: <strong>${esc(sim.modeReason(p.id))}</strong>`;
  d.querySelector('#ovl').disabled = !(mode === 'full' || mode === 'blur');
  const g = s.grants[p.id], pending = s.requests.find((r) => r.patientId === p.id && r.state === 'čeká');
  const crit = openAlerts(p.id).some((e) => KINDS[e.kind].level === 'crit');
  const btns = [];
  if (g) btns.push(`<span class="badge warn">plný obraz do ${fmtT(g.until)} (${esc(g.kind)})</span><button class="sm sec" id="endG">Ukončit plný obraz</button>`);
  else if (askOpen) {
    btns.push(`<span class="small">Důvod (rodina ho uvidí):</span><select id="askReason"><option>ověření alertu</option><option>na žádost rodiny</option><option>kontrola stavu před návštěvou</option><option>jiný důvod</option></select><button class="sm" id="askSend">Odeslat žádost</button><button class="sm sec" id="askCancel">Zrušit</button>`);
  } else if (emergOpen) {
    btns.push(`<span class="small">Otevřít plný obraz na 10 minut bez souhlasu? Rodina dostane okamžitě zprávu, zásah je v auditu.</span><button class="sm bad" id="emergYes">Ano, otevřít</button><button class="sm sec" id="emergNo">Ne</button>`);
  } else {
    btns.push(pending ? `<span class="badge warn">žádost čeká na rodinu (do ${fmtT(pending.until)})</span>` : `<button class="sm" id="askG">Požádat rodinu o plný obraz</button>`);
    btns.push(`<button class="sm bad" id="emerg" ${p.consent.nouze && crit ? '' : 'disabled'} title="${p.consent.nouze ? 'jen při otevřeném kritickém alertu' : 'rodina nouzový přístup nepovolila'}">Nouzový přístup 10 min</button>`);
  }
  const changed = setHtml(d.querySelector('#dbtn'), btns.join(' '));
  if (changed) {
    d.querySelector('#askG')?.addEventListener('click', () => { askOpen = true; renderDetail(); });
    d.querySelector('#askCancel')?.addEventListener('click', () => { askOpen = false; renderDetail(); });
    d.querySelector('#askSend')?.addEventListener('click', () => { const reason = d.querySelector('#askReason').value; askOpen = false; sim.requestFull(p.id, `Dispečerka ${ME()}`, reason); });
    d.querySelector('#emerg')?.addEventListener('click', () => { emergOpen = true; renderDetail(); });
    d.querySelector('#emergNo')?.addEventListener('click', () => { emergOpen = false; renderDetail(); });
    d.querySelector('#emergYes')?.addEventListener('click', () => { emergOpen = false; sim.emergencyAccess(p.id, `Dispečerka ${ME()}`); });
    d.querySelector('#endG')?.addEventListener('click', () => sim.endGrant(p.id, `Dispečerka ${ME()}`));
  }
  d.querySelector('#dnoteKdo').textContent = `zapíše se jako ${ME()}, ${new Date().toLocaleDateString('cs-CZ')}`;
  setHtml(d.querySelector('#dnotes'), s.events.filter((e) => e.patientId === p.id && e.kind === 'poznamka').slice(0, 30).map((e) => `<li><span class="when">${fmtDT(e.at)} · ${esc(e.by)}</span>${esc(e.text)}</li>`).join('') || '<li class="muted">Zatím žádná poznámka.</li>');
  setHtml(d.querySelector('#dhist'), s.events.filter((e) => e.patientId === p.id).slice(0, 12).map((e) => {
    const k = KINDS[e.kind];
    const badge = k ? `<span class="badge ${k.level}">${esc(k.source)}</span> ` : e.kind === 'poznamka' ? `<span class="badge note">poznámka</span> ` : '<span class="badge">souhlas</span> ';
    return `<li><span class="when">${fmtDT(e.at)}</span><span class="grow">${badge}${esc(eventText(e))}${e.kind === 'poznamka' ? ` · <span class="muted">${esc(e.by)}</span>` : e.result ? ` · <span class="muted">${esc(e.result)}</span>` : e.state && e.state !== 'uzavřen' && k ? ` · <em>${esc(e.state)}</em>` : ''}</span></li>`;
  }).join(''));
}

/* ---------- uživatelé rodiny: účty na serveru, pozvánka SMS ----------
 * Jen u skutečné kamery (id pacienta = id kamery). Zakládá je poskytovatel
 * přihlášený v hlavní aplikaci; rodina dostane odkaz SMS, zvolí si heslo
 * a přihlašuje se telefonem a heslem (src/uzivatele.mjs). */
let posledniPozvanka = null;   // { uzivatelId, odkaz, text, sms } – ukázat po založení / nové pozvánce
const rodinaUzivatele = new Map();   // id kamery → účty rodiny ze serveru (pro „Zavolat rodině“)
async function apiJson(path, init) {
  const r = await fetch(path, init);
  let data = {}; try { data = await r.json(); } catch { /* bez těla */ }
  if (!r.ok) { const e = new Error(data.error || `Chyba (${r.status})`); e.status = r.status; throw e; }
  return data;
}
const post = (path, body) => apiJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const smsLink = (tel, text) => `sms:+420${tel}?&body=${encodeURIComponent(text)}`;

async function renderUzivatele(p) {
  const box = $('detail').querySelector('#dusers'); if (!box) return;
  if (!p.real) { box.innerHTML = '<p class="small muted">Simulovaný pacient: účty rodiny se zakládají jen u skutečné kamery.</p>'; return; }
  let data;
  try { data = await apiJson('/api/rodina/uzivatele'); }
  catch (e) {
    box.innerHTML = e.status === 401
      ? `<p class="small">Účty rodiny spravuje přihlášený poskytovatel. <a class="sm btnlike" href="/?zpet=${encodeURIComponent('/proto/dispecink.html')}">Přihlásit se v hlavní aplikaci</a></p>`
      : `<p class="small bad">${esc(e.message)}</p>`;
    return;
  }
  const users = data.uzivatele.filter((u) => u.kamery.includes(p.id));
  rodinaUzivatele.set(p.id, users);
  const inv = posledniPozvanka;
  box.innerHTML = `<ul class="users">${users.map((u) => `<li data-u="${u.id}"><span class="grow"><strong>${esc(u.jmeno)}</strong> · ${esc(u.telefon.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'))}<br><span class="small muted">${u.aktivni ? `přihlašuje se heslem${u.posledniPrihlaseni ? ', naposledy ' + fmtDT(u.posledniPrihlaseni) : ''}` : u.pozvankaPlatiDo ? `čeká na první přihlášení, pozvánka platí do ${fmtDT(u.pozvankaPlatiDo)}` : 'bez přístupu'}</span></span>
      <button class="sm sec" data-a="pozvanka">Nová pozvánka (nové heslo)</button><button class="sm bad" data-a="smaz">Odebrat</button>
      ${inv && inv.uzivatelId === u.id ? `<div class="inv"><strong>${inv.sms?.odeslano ? 'SMS odeslána.' : inv.sms?.error ? `SMS neodešla: ${esc(inv.sms.error)}` : 'Pozvánka připravena.'}</strong> Odkaz platí 7 dní, je na jedno použití:<br><code>${esc(inv.odkaz)}</code>
        <div class="row"><button class="sm" data-a="copy">Kopírovat odkaz</button><a class="sm btnlike" href="${smsLink(u.telefon, inv.text)}">Poslat SMS z tohoto telefonu</a></div></div>` : ''}</li>`).join('') || '<li class="small muted">Zatím nikdo. Založte první účet níže; rodina dostane pozvánku SMS.</li>'}</ul>
    <form class="userform" id="uform">
      <label>Jméno<input type="text" id="uJmeno" maxlength="60" required placeholder="Petr Novák"></label>
      <label>Telefon<input type="tel" id="uTel" required placeholder="777 123 456"></label>
      <label class="small"><input type="checkbox" id="uSms" ${data.smsNastaveno ? 'checked' : 'disabled'}> poslat SMS ze serveru${data.smsNastaveno ? '' : ' (není nastaveno; pošlete ji z telefonu)'}</label>
      <button class="sm" type="submit">Založit účet a připravit pozvánku</button>
    </form>
    <p class="small bad hide" id="uErr"></p>`;
  box.querySelector('#uform').onsubmit = async (e) => {
    e.preventDefault();
    const err = box.querySelector('#uErr'); err.classList.add('hide');
    try {
      const r = await post('/api/rodina/uzivatele', { jmeno: box.querySelector('#uJmeno').value, telefon: box.querySelector('#uTel').value, kamery: [p.id], poslatSms: box.querySelector('#uSms').checked });
      posledniPozvanka = { uzivatelId: r.uzivatel.id, odkaz: r.odkaz, text: r.text, sms: r.sms };
      toast(r.sms.odeslano ? `Pozvánka odeslána SMS na ${r.uzivatel.telefon}.` : 'Účet založen, pozvánka je připravená.');
      renderUzivatele(p);
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); }
  };
  box.querySelectorAll('li[data-u] button').forEach((b) => { b.onclick = async () => {
    const id = b.closest('li').dataset.u;
    try {
      if (b.dataset.a === 'copy') { await navigator.clipboard.writeText(inv.odkaz); toast('Odkaz zkopírován.'); return; }
      if (b.dataset.a === 'smaz') {
        if (b.textContent !== 'Opravdu odebrat?') { b.textContent = 'Opravdu odebrat?'; return; }
        await apiJson(`/api/rodina/uzivatele/${id}`, { method: 'DELETE' }); posledniPozvanka = null; toast('Účet odebrán.');
      }
      if (b.dataset.a === 'pozvanka') {
        const r = await post(`/api/rodina/uzivatele/${id}/pozvanka`, { poslatSms: data.smsNastaveno });
        posledniPozvanka = { uzivatelId: id, odkaz: r.odkaz, text: r.text, sms: r.sms };
        toast('Nová pozvánka připravena; staré heslo přestalo platit.');
      }
      renderUzivatele(p);
    } catch (ex) { toast(ex.message, 'crit'); }
  }; });
}

$('onlyOpen').onchange = renderTiles;
if (selected) { renderDetail(true); panel.select(selected); }
sim.subscribe((s, info) => {
  for (const e of s.events) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    // celý stav odjinud (první načtení ze serveru): staré události nehlásit
    if (info?.nahrazeno) continue;
    const k = KINDS[e.kind]; if (!k || k.level === 'info' || !visible(sim.patient(e.patientId) || {})) continue;
    if (k.level === 'crit') { beep(); toast(`🚨 ${sim.patient(e.patientId)?.name}: ${k.label}`, 'crit', () => { selected = e.patientId; renderDetail(true); renderTiles(); }); }
    else toast(`${sim.patient(e.patientId)?.name}: ${k.label}`);
  }
  renderHlavicka(); renderTiles(); renderQueue(); renderDetail();
});
setInterval(() => { renderTiles(); renderQueue(); renderDetail(); }, 5000);
