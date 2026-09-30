import { createSource } from '/proto/zdroj.js';
import { mountAuthBanner, sim, KINDS, LEVEL_LABEL, CONSENT, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, describeWatch } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
const FAMILY = ['tapoc2020', 'p2'];
let patientId = FAMILY[0];
// Zobrazení = podklad (normální, rozostření, černé pozadí) + drátěný model přes
// něj. Model jde zapnout k normálnímu i rozostřenému obrazu; na černém pozadí je vždy.
const REZIM = { full: ['full', false], normal: ['full', false], blur: ['blur', false], blurskel: ['blur', true],
  fullskel: ['full', true], model: ['full', true], skeleton: ['skeleton', true], black: ['skeleton', true] };
const SKEL_KEY = 'famicura.proto.skel';
const zRezimu = REZIM[new URLSearchParams(location.search).get('rezim')];
let baseMode = zRezimu ? zRezimu[0] : 'full';
let skel = zRezimu ? zRezimu[1] : localStorage.getItem(SKEL_KEY) === '1';
const viewMode = () => baseMode === 'skeleton' ? 'skeleton' : skel ? `${baseMode}skel` : baseMode;
let filter = 'all';
const seen = new Set(sim.state.notifications.map((n) => n.id));

const src = createSource({ deviceId: 'tapoc2020' });
window.__zdroj = src;
src.register($('cv'), viewMode);
src.connect();
mountAuthBanner(src);
src.onChange((s) => {
  $('liveTag').classList.toggle('hide', s.status !== 'live');
  $('srcNote').textContent = s.status === 'live' ? (s.path === 'https' ? 'Obraz z vaší kamery náhradní cestou přes HTTPS (bez zvuku, o pár sekund pozadu).' : 'Obraz z vaší kamery (WebRTC).')
    : s.status === 'connecting' ? 'Připojuji obraz z kamery…'
    : `Náhradní scéna: ${s.error || 'kamera nedostupná'}${s.error?.includes('přihlášeni') ? ' Přihlaste se v hlavní aplikaci a obnovte stránku.' : ''}`;
});
sim.startRealEvents('tapoc2020');

/* ---------- aplikace na ploše telefonu ---------- */
// Servisní skript nic nekešuje (obraz i události jsou živé); je tu kvůli
// instalaci na plochu a stránce „jste offline“.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/proto/sw.js').catch(() => {});
const naPlose = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (!naPlose) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  $('install').classList.remove('hide');
  if (ios) $('installIos').classList.remove('hide');
  else if (android) $('installAndroid').classList.remove('hide');
  else $('installHint').textContent = 'Na telefonu si Famicuru uložte na plochu: otevřete tuhle adresu v Safari (iPhone) nebo Chromu (Android) a zvolte Přidat na plochu.';
  // Chrome/Android nabídne instalaci sám; pak stačí tlačítko místo návodu.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    $('installAndroid').classList.add('hide');
    const b = $('installBtn'); b.classList.remove('hide');
    b.onclick = async () => { b.disabled = true; await e.prompt(); const r = await e.userChoice; if (r.outcome === 'accepted') $('install').classList.add('hide'); b.disabled = false; };
  });
  window.addEventListener('appinstalled', () => $('install').classList.add('hide'));
}

const panel = mountPanel({ role: 'rodina', patientIds: FAMILY, onPatient: (id) => { patientId = id; render(); } });

$('patient').innerHTML = FAMILY.map((id) => `<option value="${id}">${esc(sim.patient(id).name)}</option>`).join('');
$('patient').onchange = () => { patientId = $('patient').value; panel.select(patientId); render(); };

function renderModes() {
  $('modes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === baseMode)));
  const sw = $('skelSw');
  sw.disabled = baseMode === 'skeleton';
  sw.checked = baseMode === 'skeleton' || skel;
  $('skelHint').textContent = baseMode === 'skeleton' ? 'na černém pozadí je drátěný model vždy' : 'kostra postavy přes normální i rozostřený obraz';
}
$('modes').querySelectorAll('button').forEach((b) => { b.onclick = () => { baseMode = b.dataset.mode; renderModes(); render(); }; });
$('skelSw').onchange = () => { skel = $('skelSw').checked; localStorage.setItem(SKEL_KEY, skel ? '1' : '0'); renderModes(); render(); };
renderModes();
$('cDen').onchange = () => sim.setConsent(patientId, { den: $('cDen').value });
$('cNoc').onchange = () => sim.setConsent(patientId, { noc: $('cNoc').value });
$('cNouze').onchange = () => sim.setConsent(patientId, { nouze: $('cNouze').checked });
document.querySelectorAll('[data-klid]').forEach((b) => { b.onclick = () => {
  const v = b.dataset.klid;
  if (v === '0') sim.setKlid(patientId, null);
  else if (v === 'morning') { const d = new Date(); if (d.getHours() >= 7) d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0); sim.setKlid(patientId, d.getTime()); }
  else sim.setKlid(patientId, Date.now() + Number(v) * 60000);
}; });
$('filters').querySelectorAll('button').forEach((b) => { b.onclick = () => { filter = b.dataset.f; $('filters').querySelectorAll('button').forEach((o) => { o.setAttribute('aria-pressed', String(o === b)); o.classList.toggle('on', o === b); }); render(); }; });
$('ackAll').onclick = () => sim.ackAll(patientId);
$('rec').onclick = () => { sim.emit(patientId, 'state', { text: 'Ruční nahrávka 15 s (uložena do historie).' }); toast('Nahrávám 15 s…'); };
$('sound').onclick = () => { const ic = $('sound').querySelector('.ic'); ic.textContent = ic.textContent === '🔇' ? '🔊' : '🔇'; };

function levelClass(l) { return l === 'crit' ? 'crit' : l === 'warn' ? 'warn' : l === 'tech' ? 'tech' : 'info'; }

function render() {
  const s = sim.state;
  const p = sim.patient(patientId); if (!p) return;
  $('pname').textContent = p.name;
  $('provider').textContent = `${p.provider} · nastavení platí pro dispečink i pečovatele v terénu`;
  $('cDen').value = p.consent.den; $('cNoc').value = p.consent.noc; $('cNouze').checked = p.consent.nouze;
  const open = s.events.filter((e) => e.patientId === patientId && e.state !== 'uzavřen' && KINDS[e.kind]);
  const worst = open.some((e) => KINDS[e.kind].level === 'crit') ? 'crit' : open.some((e) => KINDS[e.kind].level === 'warn') ? 'warn' : null;
  $('pstatus').textContent = p.offline ? 'kamera nedostupná' : worst === 'crit' ? 'kritická událost' : worst === 'warn' ? 'varování' : 'klid';
  $('pstatus').className = 'badge hide ' + (p.offline ? 'tech' : worst || 'ok');
  $('avatar').textContent = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const hero = $('hero');
  const lastEv = s.events.find((e) => e.patientId === patientId && e.kind !== 'consent');
  const heroKind = p.offline ? 'off' : worst || 'ok';
  hero.className = 'hero-' + heroKind;
  $('heroIc').textContent = { ok: '✓', warn: '!', crit: '!', off: '⌁' }[heroKind];
  $('heroT').textContent = { ok: 'Vše v pořádku', warn: 'Varování, podívejte se', crit: 'Kritická událost', off: 'Kamera je nedostupná' }[heroKind];
  $('heroS').textContent = lastEv ? `Poslední událost: ${eventText(lastEv)} · ${fmtT(lastEv.at)}` : 'Zatím žádná událost';
  $('modeTag').textContent = { full: 'normální obraz', blur: 'rozostření', fullskel: 'drátěný model přes obraz', blurskel: 'rozostření s drátěným modelem', skeleton: 'jen drátěný model' }[viewMode()];
  $('effective').innerHTML = `Teď poskytovatel vidí: <strong>${esc(sim.modeReason(patientId))}</strong>`;
  $('watchInfo').textContent = describeWatch(p.watch || {});

  // provider watching
  const g = s.grants[patientId], w = s.watching[patientId];
  if (setHtml($('watching'), g && w ? `<div class="watching"><span class="grow">👁 ${esc(w.who)} se dívá na plný obraz od ${fmtT(w.since)} (${esc(g.kind)}, do ${fmtT(g.until)})</span><button class="sm warn" id="endW">Ukončit</button></div>` : '') && g && w) $('endW').onclick = () => sim.endGrant(patientId, 'rodina');

  // klid
  const k = s.klid[patientId];
  $('klidState').textContent = k && k > Date.now() ? `klid do ${fmtT(k)}` : 'klid vypnutý';

  // notifications (unacked)
  const notifs = s.notifications.filter((n) => n.patientId === patientId && !n.ack && n.kind !== 'request');
  const notifHtml = notifs.slice(0, 4).map((n) => {
    const text = n.kind === 'emergency' ? `${n.who} otevřel nouzový přístup k plnému obrazu (10 min).` : `${KINDS[n.kind]?.label || n.kind} · ${fmtT(n.at)}`;
    return `<div class="banner ${levelClass(n.level)} ${n.level === 'crit' ? 'pulse' : ''}"><span class="badge ${levelClass(n.level)}">${esc(LEVEL_LABEL[n.level] || n.level)}</span><span class="grow">${esc(text)}</span><button class="sm" data-ack="${n.id}">${n.level === 'crit' ? 'Řeším' : 'V pořádku'}</button></div>`;
  }).join('');
  if (setHtml($('notifs'), notifHtml)) $('notifs').querySelectorAll('[data-ack]').forEach((b) => { b.onclick = () => sim.ackNotification(b.dataset.ack); });

  // requests for full picture
  const reqs = s.requests.filter((r) => r.patientId === patientId && r.state === 'čeká');
  const reqHtml = reqs.map((r) => `<div class="banner warn"><span class="grow"><strong>${esc(r.from)}</strong> žádá o plný obraz · důvod: ${esc(r.reason)} · ${fmtT(r.at)}<br><span class="small muted">bez odpovědi do ${fmtT(r.until)} zůstane ${esc(CONSENT[sim.patient(patientId).consent[sim.isNight() ? 'noc' : 'den']])}</span></span>
    <button class="sm" data-req="${r.id}" data-a="15">Povolit 15 min</button><button class="sm sec" data-req="${r.id}" data-a="forever">Do odvolání</button><button class="sm bad" data-req="${r.id}" data-a="deny">Odmítnout</button></div>`).join('');
  if (setHtml($('requests'), reqHtml)) $('requests').querySelectorAll('[data-req]').forEach((b) => { b.onclick = () => sim.answerRequest(b.dataset.req, b.dataset.a === 'deny' ? 'deny' : b.dataset.a === 'forever' ? 'forever' : 'minutes', 15); });

  // history
  const rows = s.events.filter((e) => e.patientId === patientId).filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'consent') return e.kind === 'consent';
    if (filter === 'crit') return KINDS[e.kind]?.level === 'crit';
    return KINDS[e.kind]?.source === filter;
  }).slice(0, 40);
  setHtml($('history'), rows.map((e) => {
    const k = KINDS[e.kind];
    const badge = e.kind === 'consent' ? '<span class="badge">souhlas</span>' : `<span class="badge ${levelClass(k.level)}">${esc(k.source)}</span>`;
    const tail = e.state && e.state !== 'uzavřen' && k ? ` · <span class="badge warn">${esc(e.state)}${e.by ? ' – ' + esc(e.by) : ''}</span>` : e.result ? ` · <span class="muted">${esc(e.result)}</span>` : '';
    const rec = k && k.level !== 'info' && k.level !== 'tech' && e.kind !== 'consent' ? ' · <a href="#" class="small">nahrávka 20 s (5 s před)</a>' : '';
    const cls = e.kind === 'consent' ? 'consent' : k.level;
    return `<li class="${cls}"><span class="when">${fmtDT(e.at)}</span><span class="grow">${badge} ${esc(eventText(e))}${e.real ? ' <span class="badge ok">skutečná</span>' : ''}${tail}${rec}</span></li>`;
  }).join('') || '<li class="muted">Zatím nic.</li>');
}

sim.subscribe((s) => {
  for (const n of s.notifications) {
    if (seen.has(n.id)) continue; seen.add(n.id);
    if (n.patientId !== patientId || n.ack) continue;
    const text = n.kind === 'request' ? 'Poskytovatel žádá o plný obraz' : n.kind === 'emergency' ? `${n.who}: nouzový přístup k obrazu` : `${sim.patient(n.patientId).name}: ${KINDS[n.kind]?.label || n.kind}`;
    toast(`🔔 ${text}`, n.level === 'crit' ? 'crit' : 'info');
    if (n.level === 'crit' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
  render();
});
setInterval(render, 5000);
