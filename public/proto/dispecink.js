import { createSource } from '/proto/zdroj.js';
import { sim, KINDS, LEVEL_LABEL, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, agoSpan, refreshAgo } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
const ME = 'Jana Nováková';
let selected = null;
let overlay = false;                 // skeleton over a full or blurred picture in the detail
let askOpen = false, emergOpen = false;   // inline forms in the detail
const seen = new Set(sim.state.events.map((e) => e.id));
const tileRegs = new Map();          // patientId → unregister
let detailUnreg = null;

const src = createSource({ deviceId: 'tapoc2020' });
window.__zdroj = src;
src.connect();
src.onChange((s) => { $('srcNote').textContent = s.status === 'live' ? 'obraz: skutečná kamera' : s.status === 'connecting' ? 'obraz: připojuji…' : 'obraz: náhradní scéna'; });
sim.startRealEvents('tapoc2020');
const panel = mountPanel({ role: 'dispecink', onPatient: () => {} });

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
  const list = s.patients.filter((p) => !only || openAlerts(p.id).length || p.offline);
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
    const last = s.events.find((e) => e.patientId === p.id && e.kind !== 'consent');
    t.querySelector('.st').textContent = last ? `${eventText(last)} · před ${ago(last.at)}` : 'bez událostí';
  });
  $('nPat').textContent = s.patients.length;
  const opens = s.events.filter((e) => e.state === 'nový' && KINDS[e.kind] && KINDS[e.kind].level !== 'info');
  $('nNew').textContent = opens.length;
  $('nCrit').textContent = opens.filter((e) => KINDS[e.kind].level === 'crit').length;
  const crit = s.events.filter((e) => e.state !== 'uzavřen' && KINDS[e.kind]?.level === 'crit');
  const critHtml = crit.slice(0, 3).map((e) => `<div class="banner crit pulse"><span class="badge crit">kritické</span><strong>${esc(sim.patient(e.patientId)?.name)}</strong><span class="grow">${esc(eventText(e))} · ${fmtT(e.at)} · ${esc(e.state)}${e.by ? ' – ' + esc(e.by) : ''}${e.escalated ? ' · <span class="esc">ESKALOVÁNO vedoucímu</span>' : ''}</span>
    ${e.state === 'nový' ? `<button class="sm" data-take="${e.id}">Převzít</button>` : ''}<button class="sm sec" data-open="${e.patientId}">Otevřít obraz</button><button class="sm sec" data-call="${e.patientId}">Zavolat rodině</button></div>`).join('');
  if (setHtml($('critBanner'), critHtml)) bindQueueButtons($('critBanner'));
}

function bindQueueButtons(root) {
  root.querySelectorAll('[data-take]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); sim.setAlert(b.dataset.take, { state: 'převzat', by: ME, takenAt: Date.now() }); }; });
  root.querySelectorAll('[data-solve]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); sim.setAlert(b.dataset.solve, { state: 'řešen', by: ME }); }; });
  root.querySelectorAll('[data-close]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const sel = b.parentElement.querySelector('select'); sim.setAlert(b.dataset.close, { state: 'uzavřen', by: ME, result: sel ? sel.value : 'vyřešeno', closedAt: Date.now() }); }; });
  root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); selected = b.dataset.open; panel.select(selected); renderDetail(true); renderTiles(); $('detail').scrollIntoView({ behavior: 'smooth' }); }; });
  root.querySelectorAll('[data-call]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); toast(`Volám rodině: Petr Novák, 777 123 456 (simulace)`); }; });
}

function renderQueue() {
  const s = sim.state;
  const items = s.events.filter((e) => e.state !== 'uzavřen' && KINDS[e.kind] && KINDS[e.kind].level !== 'info');
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
      <div class="kv" style="margin-top:10px"><dt>Poskytovatel</dt><dd>${esc(p.provider)}</dd><dt>Rodina</dt><dd>Petr Novák (syn), 777 123 456</dd><dt>Poznámka</dt><dd>${esc(p.note || '–')}</dd></div>
      <h3 style="margin-top:12px">Historie</h3><ul class="list" id="dhist"></ul>`;
    detailUnreg = src.register(d.querySelector('#dcv'), () => detailMode(selected));
    d.querySelector('#closeD').onclick = () => { selected = null; renderDetail(); renderTiles(); };
    const ovl = d.querySelector('#ovl'); ovl.checked = overlay; ovl.onchange = () => { overlay = ovl.checked; };
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
    d.querySelector('#askSend')?.addEventListener('click', () => { const reason = d.querySelector('#askReason').value; askOpen = false; sim.requestFull(p.id, `Dispečerka ${ME}`, reason); });
    d.querySelector('#emerg')?.addEventListener('click', () => { emergOpen = true; renderDetail(); });
    d.querySelector('#emergNo')?.addEventListener('click', () => { emergOpen = false; renderDetail(); });
    d.querySelector('#emergYes')?.addEventListener('click', () => { emergOpen = false; sim.emergencyAccess(p.id, `Dispečerka ${ME}`); });
    d.querySelector('#endG')?.addEventListener('click', () => sim.endGrant(p.id, `Dispečerka ${ME}`));
  }
  setHtml(d.querySelector('#dhist'), s.events.filter((e) => e.patientId === p.id).slice(0, 12).map((e) => {
    const k = KINDS[e.kind];
    return `<li><span class="when">${fmtDT(e.at)}</span><span class="grow">${k ? `<span class="badge ${k.level}">${esc(k.source)}</span> ` : '<span class="badge">souhlas</span> '}${esc(eventText(e))}${e.result ? ` · <span class="muted">${esc(e.result)}</span>` : e.state && e.state !== 'uzavřen' && k ? ` · <em>${esc(e.state)}</em>` : ''}</span></li>`;
  }).join(''));
}

$('onlyOpen').onchange = renderTiles;
if (selected) { renderDetail(true); panel.select(selected); }
sim.subscribe((s) => {
  for (const e of s.events) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const k = KINDS[e.kind]; if (!k || k.level === 'info') continue;
    if (k.level === 'crit') { beep(); toast(`🚨 ${sim.patient(e.patientId)?.name}: ${k.label}`, 'crit', () => { selected = e.patientId; renderDetail(true); renderTiles(); }); }
    else toast(`${sim.patient(e.patientId)?.name}: ${k.label}`);
  }
  renderTiles(); renderQueue(); renderDetail();
});
setInterval(() => { renderTiles(); renderQueue(); renderDetail(); }, 5000);
