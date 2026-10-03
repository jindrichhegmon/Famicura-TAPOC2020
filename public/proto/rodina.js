import { createSource } from '/proto/zdroj.js';
import { sim, KINDS, LEVEL_LABEL, CONSENT, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, describeWatch, casy, KLID_NAVZDY } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
let FAMILY = ['tapoc2020', 'p2'];       // v ukázce a pro poskytovatele; rodina dostane své kamery ze serveru
let patientId = FAMILY[0];
let src = null, panel = null, demo = false;
const params = new URLSearchParams(location.search);
// Zobrazení = podklad (normální, rozostření, černé pozadí) + drátěný model přes
// něj. Model jde zapnout k normálnímu i rozostřenému obrazu; na černém pozadí je vždy.
const REZIM = { full: ['full', false], normal: ['full', false], blur: ['blur', false], blurskel: ['blur', true],
  fullskel: ['full', true], model: ['full', true], skeleton: ['skeleton', true], black: ['skeleton', true] };
const SKEL_KEY = 'famicura.proto.skel';
const zRezimu = REZIM[params.get('rezim')];
let baseMode = zRezimu ? zRezimu[0] : 'full';
let skel = zRezimu ? zRezimu[1] : localStorage.getItem(SKEL_KEY) === '1';
const viewMode = () => baseMode === 'skeleton' ? 'skeleton' : skel ? `${baseMode}skel` : baseMode;
let filter = 'all';
const seen = new Set(sim.state.notifications.map((n) => n.id));

/* ---------- brána: přihlášení rodiny, aktivace pozvánky, ukázka ----------
 * Účet zakládá poskytovatel v dispečinku a pošle pozvánku SMS s odkazem
 * (?pozvanka=). Při prvním otevření si rodina zvolí heslo; dál se přihlašuje
 * telefonem a heslem. Stejná cookie pak platí i pro obraz a události
 * z hlavní aplikace, takže se nikam podruhé nepřihlašuje. */
async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch { /* bez těla */ }
  if (!r.ok) throw new Error(data.error || `Chyba serveru (${r.status})`);
  return data;
}
const showErr = (id, text) => { const e = $(id); e.textContent = text; e.classList.toggle('hide', !text); };
function showGate(co) {
  $('gate').classList.remove('hide');
  $('gLogin').classList.toggle('hide', co !== 'login');
  $('gAktivace').classList.toggle('hide', co !== 'aktivace');
  document.body.classList.add('gated');
}
function hideGate() { $('gate').classList.add('hide'); document.body.classList.remove('gated'); document.body.classList.remove('pending'); }

function startSource(deviceId) {
  src = createSource({ deviceId });
  window.__zdroj = src;
  src.register($('cv'), viewMode);
  src.connect();
  src.onChange((s) => {
    $('liveTag').classList.toggle('hide', s.status !== 'live');
    $('srcNote').textContent = s.status === 'live' ? (s.path === 'https' ? 'Obraz z vaší kamery náhradní cestou přes HTTPS (bez zvuku, o pár sekund pozadu).' : 'Obraz z vaší kamery (WebRTC).')
      : s.status === 'connecting' ? 'Připojuji obraz z kamery…'
      : demo ? 'Ukázka bez přihlášení: náhradní scéna místo skutečné kamery.'
      : `Obraz z kamery teď nejde (${s.error || 'kamera nedostupná'}). Ukazuji náhradní scénu; poskytovatel o výpadku ví z diagnostiky.`;
  });
  sim.startRealEvents(deviceId);
}

function setupPatients() {
  patientId = FAMILY[0];
  // Panel Simulace má rodina jen na vyžádání odkazem (?simulace=1) nebo v ukázce (?ukazka=1); skutečná rodina ho nevidí.
  const seSimulaci = demo || params.get('simulace') === '1';
  panel = seSimulaci ? mountPanel({ role: 'rodina', patientIds: FAMILY, onPatient: (id) => { patientId = id; render(); } }) : { select() {}, patient: () => patientId, refresh() {} };
  $('patient').innerHTML = FAMILY.map((id) => `<option value="${id}">${esc(sim.patient(id).name)}</option>`).join('');
  $('patient').classList.toggle('hide', FAMILY.length < 2);
  $('patient').onchange = () => { patientId = $('patient').value; panel.select(patientId); render(); };
  render();
}

/** Přihlášený uživatel rodiny (nebo poskytovatel z hlavní aplikace). */
function boot(ja) {
  hideGate();
  sim.pripojit();   // po přihlášení: stav ze serveru, společný s dispečinkem
  if (ja.role === 'rodina') {
    for (const k of ja.kamery) sim.ensurePatient({ id: k.id, name: k.name });
    FAMILY = ja.kamery.map((k) => k.id);
    $('whoami').textContent = `${ja.jmeno} · rodina`;
    $('ucetInfo').textContent = `Přihlášen(a) jako ${ja.jmeno}, telefon ${ja.telefon}. ${ja.kamery.length ? '' : 'Poskytovatel vám zatím nepřiřadil kameru.'}`;
    if (!FAMILY.length) FAMILY = ['tapoc2020'];
  } else {
    $('whoami').textContent = 'Poskytovatel · přihlášen v hlavní aplikaci';
    $('ucetInfo').textContent = 'Jste přihlášeni heslem Famicura (poskytovatel). Vidíte skutečnou kameru i ukázkového pacienta.';
    $('pwOpen').classList.add('hide');
  }
  setupPatients();
  startSource(FAMILY[0]);
}

function startDemo() {
  demo = true;
  hideGate();
  FAMILY = ['tapoc2020', 'p2'];
  $('whoami').textContent = 'Ukázka · bez přihlášení';
  $('ucetInfo').textContent = 'Ukázka běží jen v tomhle prohlížeči. Skutečný obraz z kamery uvidí jen přihlášená rodina.';
  $('pwOpen').classList.add('hide'); $('logout').classList.add('hide'); $('gotoLogin').classList.remove('hide');
  setupPatients();
  startSource('tapoc2020');
}

$('gLogin').onsubmit = async (e) => {
  e.preventDefault(); showErr('gLoginErr', '');
  const b = e.target.querySelector('button'); b.disabled = true;
  try { await api('/api/rodina/login', { telefon: $('gTel').value, heslo: $('gPw').value }); boot(await api('/api/rodina/ja')); }
  catch (err) { showErr('gLoginErr', err.message); }
  b.disabled = false;
};
$('gAktivace').onsubmit = async (e) => {
  e.preventDefault(); showErr('gAktErr', '');
  if ($('gPw1').value !== $('gPw2').value) { showErr('gAktErr', 'Hesla se neshodují.'); return; }
  const b = e.target.querySelector('button'); b.disabled = true;
  try {
    await api('/api/rodina/aktivace', { token: params.get('pozvanka'), heslo: $('gPw1').value });
    params.delete('pozvanka'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params : ''));
    boot(await api('/api/rodina/ja'));
    toast('Heslo nastaveno, jste přihlášen(a).');
  } catch (err) { showErr('gAktErr', err.message); }
  b.disabled = false;
};
$('gDemo').onclick = startDemo;
$('logout').onclick = async () => { await api('/api/rodina/odhlaseni', {}).catch(() => {}); location.href = '/proto/rodina.html'; };
$('pwOpen').onclick = () => { $('pwForm').classList.toggle('hide'); showErr('pwErr', ''); };
$('pwCancel').onclick = () => $('pwForm').classList.add('hide');
$('pwForm').onsubmit = async (e) => {
  e.preventDefault(); showErr('pwErr', '');
  if ($('pwNew').value !== $('pwNew2').value) { showErr('pwErr', 'Nová hesla se neshodují.'); return; }
  try { await api('/api/rodina/heslo', { stare: $('pwOld').value, nove: $('pwNew').value }); $('pwForm').classList.add('hide'); e.target.reset(); toast('Heslo změněno.'); }
  catch (err) { showErr('pwErr', err.message); }
};

(async () => {
  if (params.get('ukazka') === '1') { startDemo(); return; }
  // Platná pozvánka má přednost před čímkoli přihlášeným v tomhle prohlížeči
  // (jiný člen rodiny, nebo poskytovatel, který odkaz zkouší na svém počítači):
  // nový člen si musí zvolit heslo. Aktivace pak přihlásí jeho.
  const token = params.get('pozvanka');
  const pozvanka = token ? await api('/api/rodina/pozvanka?token=' + encodeURIComponent(token)).catch(() => ({ platna: false })) : null;
  if (pozvanka?.platna) { $('gWelcome').textContent = `Vítejte, ${pozvanka.jmeno}. Heslo není v SMS: zvolte si ho tady, budete se jím přihlašovat spolu s telefonem.`; showGate('aktivace'); return; }
  // Už přihlášený (třeba druhé klepnutí na odkaz z SMS) jde rovnou dovnitř.
  try { boot(await api('/api/rodina/ja')); return; } catch { /* nepřihlášen */ }
  // Použitý nebo propadlý odkaz: heslo už existuje, stačí se přihlásit.
  if (token) showErr('gLoginInfo', 'Tenhle odkaz už byl použitý, heslo máte nastavené. Přihlaste se telefonem a heslem. Když heslo nevíte, požádejte poskytovatele o novou pozvánku.');
  showGate('login');
})();

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
// časy střídání: uloží se po opuštění pole; stejný čas pro den i noc server odmítne
const ulozCas = (k, el) => async () => { if (!el.value) { render(); return; } try { await sim.setConsent(patientId, { [k]: el.value }); } catch { /* run už ukázal chybu */ } render(); };
$('cDenOd').onchange = ulozCas('denOd', $('cDenOd'));
$('cNocOd').onchange = ulozCas('nocOd', $('cNocOd'));
// rychlé přepnutí: platí do další změny nebo do střídání den/noc
$('rychle').querySelectorAll('button').forEach((b) => { b.onclick = () => { const p = sim.patient(patientId); const aktivni = p?.docasne && p.docasne.until > Date.now() && p.docasne.mode === b.dataset.r; sim.rychle(patientId, aktivni ? null : b.dataset.r); }; });
$('rychleZrusit').onclick = () => sim.rychle(patientId, null);
document.querySelectorAll('[data-klid]').forEach((b) => { b.onclick = () => sim.klidDo(patientId, b.dataset.klid); });
$('filters').querySelectorAll('button').forEach((b) => { b.onclick = () => { filter = b.dataset.f; $('filters').querySelectorAll('button').forEach((o) => { o.setAttribute('aria-pressed', String(o === b)); o.classList.toggle('on', o === b); }); render(); }; });
$('ackAll').onclick = () => sim.ackAll(patientId);
$('rec').onclick = () => { sim.emit(patientId, 'state', { text: 'Ruční nahrávka 15 s (uložena do historie).' }); toast('Nahrávám 15 s…'); };
$('sound').onclick = () => { const ic = $('sound').querySelector('.ic'); ic.textContent = ic.textContent === '🔇' ? '🔊' : '🔇'; };

function levelClass(l) { return l === 'crit' ? 'crit' : l === 'warn' ? 'warn' : l === 'tech' ? 'tech' : 'info'; }

/* ---------- žádost o plný obraz přes celou obrazovku ----------
 * Zůstane, dokud ji rodina nevyřídí (povolit/odmítnout) nebo nezavře;
 * do té doby bliká a každých 8 s zazní tón (po prvním dotyku stránky,
 * dřív prohlížeč zvuk nepustí) a telefon zavibruje. */
const zadostZavrene = new Set();
let zadostZobrazena = null, posledniTon = 0, audio = null, dotkl = false;
function odemkniZvuk() { dotkl = true; try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* bez zvuku */ } }
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, odemkniZvuk, { once: true, passive: true }));
function ton() {
  posledniTon = Date.now();
  if (dotkl && navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);   // před prvním dotykem prohlížeč vibrace odmítá
  try {
    if (!audio || audio.state !== 'running') return;
    [0, 0.35, 0.7].forEach((t, i) => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = i === 2 ? 1046 : 784; g.gain.value = 0.2; o.connect(g); g.connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.28); });
  } catch { /* bez zvuku */ }
}
function renderZadost() {
  const el = $('zadost');
  const r = sim.state.requests.find((x) => x.patientId === patientId && !zadostZavrene.has(x.id) && (x.state === 'čeká' || (x.state === 'vypršelo' && zadostZobrazena === x.id)));
  if (!r) { el.classList.add('hide'); zadostZobrazena = null; return; }
  const ceka = r.state === 'čeká';
  if (zadostZobrazena !== r.id) { zadostZobrazena = r.id; posledniTon = 0; }
  el.classList.remove('hide'); el.classList.toggle('vyprselo', !ceka);
  $('zadostT').textContent = ceka ? 'Žádost o plný obraz' : 'Žádost o plný obraz vypršela';
  $('zadostKdo').innerHTML = `<strong>${esc(r.from)}</strong> · ${fmtT(r.at)}`;
  $('zadostProc').textContent = `Důvod: ${r.reason || 'neuveden'}`;
  $('zadostPozn').textContent = ceka ? `Bez odpovědi do ${fmtT(r.until)} zůstane ${CONSENT[sim.effectiveMode(patientId)] || 'nastavený režim'}.` : 'Poskytovatel může požádat znovu.';
  ['zadost15', 'zadostNavzdy', 'zadostNe'].forEach((id) => $(id).classList.toggle('hide', !ceka));
  if (ceka && Date.now() - posledniTon > 8000) ton();
}
$('zadost15').onclick = () => { if (zadostZobrazena) sim.answerRequest(zadostZobrazena, 'minutes', 15); };
$('zadostNavzdy').onclick = () => { if (zadostZobrazena) sim.answerRequest(zadostZobrazena, 'forever'); };
$('zadostNe').onclick = () => { if (zadostZobrazena) sim.answerRequest(zadostZobrazena, 'deny'); };
$('zadostZavrit').onclick = () => { if (zadostZobrazena) zadostZavrene.add(zadostZobrazena); renderZadost(); };
setInterval(renderZadost, 1000);

function render() {
  const s = sim.state;
  const p = sim.patient(patientId); if (!p) return;
  $('pname').textContent = p.name;
  const posk = sim.poskytovatel;
  $('provider').textContent = `${sim.poskytovatelPro(p)}${p.real && posk.telefon ? ' · ' + posk.telefon : ''} · nastavení platí pro dispečink i pečovatele v terénu`;
  $('cDen').value = p.consent.den; $('cNoc').value = p.consent.noc; $('cNouze').checked = p.consent.nouze;
  const { denOd, nocOd } = casy(p);
  if (document.activeElement !== $('cDenOd')) $('cDenOd').value = denOd;
  if (document.activeElement !== $('cNocOd')) $('cNocOd').value = nocOd;
  $('klidRano').textContent = `Do rána (${denOd})`; $('klidVecer').textContent = `Do večera (${nocOd})`;
  const ef = sim.efektivni(patientId);
  const docasne = p.docasne && p.docasne.until > Date.now() ? p.docasne : null;
  $('rychle').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(!!docasne && docasne.mode === b.dataset.r)));
  $('rychleZrusit').classList.toggle('hide', !docasne);
  $('rychleHint').textContent = docasne ? `Platí do ${fmtT(docasne.until)} (střídání den/noc), nebo do další změny.` : `Platí do další změny nebo do střídání den/noc (${sim.isNight(patientId) ? 'ráno v ' + denOd : 'večer v ' + nocOd}).`;
  const open = s.events.filter((e) => e.patientId === patientId && e.state !== 'uzavřen' && KINDS[e.kind]);
  const worst = open.some((e) => KINDS[e.kind].level === 'crit') ? 'crit' : open.some((e) => KINDS[e.kind].level === 'warn') ? 'warn' : null;
  $('pstatus').textContent = p.offline ? 'kamera nedostupná' : worst === 'crit' ? 'kritická událost' : worst === 'warn' ? 'varování' : 'klid';
  $('pstatus').className = 'badge hide ' + (p.offline ? 'tech' : worst || 'ok');
  $('avatar').textContent = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const hero = $('hero');
  const lastEv = s.events.find((e) => e.patientId === patientId && e.kind !== 'consent' && e.kind !== 'poznamka');
  const heroKind = p.offline ? 'off' : worst || 'ok';
  hero.className = 'hero-' + heroKind;
  $('heroIc').textContent = { ok: '✓', warn: '!', crit: '!', off: '⌁' }[heroKind];
  $('heroT').textContent = { ok: 'Vše v pořádku', warn: 'Varování, podívejte se', crit: 'Kritická událost', off: 'Kamera je nedostupná' }[heroKind];
  $('heroS').textContent = lastEv ? `Poslední událost: ${eventText(lastEv)} · ${fmtT(lastEv.at)}` : 'Zatím žádná událost';
  $('modeTag').textContent = { full: 'normální obraz', blur: 'rozostření', fullskel: 'drátěný model přes obraz', blurskel: 'rozostření s drátěným modelem', skeleton: 'jen drátěný model' }[viewMode()];
  const efZdroj = { povoleni: 'povolení na žádost poskytovatele', rychle: 'vaše rychlé přepnutí', offline: 'kamera je nedostupná', den: `denní nastavení (den ${denOd}–${nocOd})`, noc: `noční nastavení (noc ${nocOd}–${denOd})` }[ef.zdroj] || '';
  setHtml($('effective'), `Teď poskytovatel vidí: <strong>${esc(ef.mode === 'offline' ? 'nic, kamera nedostupná' : CONSENT[ef.mode] || ef.mode)}</strong><small>${esc(efZdroj)}${ef.do ? ` · do ${fmtT(ef.do)}` : ''}</small>`);
  $('watchInfo').textContent = describeWatch(p.watch || {});

  // provider watching
  const g = s.grants[patientId], w = s.watching[patientId];
  if (setHtml($('watching'), g && w ? `<div class="watching"><span class="grow">👁 ${esc(w.who)} se dívá na plný obraz od ${fmtT(w.since)} (${esc(g.kind)}, do ${fmtT(g.until)})</span><button class="sm warn" id="endW">Ukončit</button></div>` : '') && g && w) $('endW').onclick = () => sim.endGrant(patientId, 'rodina');

  // klid
  const k = s.klid[patientId];
  const klidAktivni = k && k > Date.now();
  $('klidState').textContent = klidAktivni ? (k >= KLID_NAVZDY ? 'klid do vypnutí' : `klid do ${fmtT(k)}`) : 'klid vypnutý';
  document.querySelectorAll('[data-klid]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.klid === 'vypnout' ? !klidAktivni : false)));

  // notifications (unacked)
  const notifs = s.notifications.filter((n) => n.patientId === patientId && !n.ack && n.kind !== 'request');
  const notifHtml = notifs.slice(0, 4).map((n) => {
    const text = n.kind === 'emergency' ? `${n.who} otevřel nouzový přístup k plnému obrazu (10 min).` : `${KINDS[n.kind]?.label || n.kind} · ${fmtT(n.at)}`;
    return `<div class="banner ${levelClass(n.level)} ${n.level === 'crit' ? 'pulse' : ''}"><span class="badge ${levelClass(n.level)}">${esc(LEVEL_LABEL[n.level] || n.level)}</span><span class="grow">${esc(text)}</span><button class="sm" data-ack="${n.id}">${n.level === 'crit' ? 'Řeším' : 'V pořádku'}</button></div>`;
  }).join('');
  if (setHtml($('notifs'), notifHtml)) $('notifs').querySelectorAll('[data-ack]').forEach((b) => { b.onclick = () => sim.ackNotification(b.dataset.ack); });

  // requests for full picture (přes celou obrazovku + proužek v aplikaci)
  renderZadost();
  const reqs = s.requests.filter((r) => r.patientId === patientId && r.state === 'čeká');
  const reqHtml = reqs.map((r) => `<div class="banner warn"><span class="grow"><strong>${esc(r.from)}</strong> žádá o plný obraz · důvod: ${esc(r.reason)} · ${fmtT(r.at)}<br><span class="small muted">bez odpovědi do ${fmtT(r.until)} zůstane ${esc(CONSENT[sim.patient(patientId).consent[sim.isNight(patientId) ? 'noc' : 'den']])}</span></span>
    <button class="sm" data-req="${r.id}" data-a="15">Povolit 15 min</button><button class="sm sec" data-req="${r.id}" data-a="forever">Do odvolání</button><button class="sm bad" data-req="${r.id}" data-a="deny">Odmítnout</button></div>`).join('');
  if (setHtml($('requests'), reqHtml)) $('requests').querySelectorAll('[data-req]').forEach((b) => { b.onclick = () => sim.answerRequest(b.dataset.req, b.dataset.a === 'deny' ? 'deny' : b.dataset.a === 'forever' ? 'forever' : 'minutes', 15); });

  // history
  // poznámky dispečinku jsou interní pro poskytovatele, rodina je v historii nevidí
  const rows = s.events.filter((e) => e.patientId === patientId && e.kind !== 'poznamka').filter((e) => {
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

sim.subscribe((s, info) => {
  for (const n of s.notifications) {
    if (seen.has(n.id)) continue; seen.add(n.id);
    // celý stav odjinud (první načtení ze serveru): nic z toho není nové
    if (info?.nahrazeno || n.patientId !== patientId || n.ack) continue;
    const text = n.kind === 'request' ? 'Poskytovatel žádá o plný obraz' : n.kind === 'emergency' ? `${n.who}: nouzový přístup k obrazu` : `${sim.patient(n.patientId).name}: ${KINDS[n.kind]?.label || n.kind}`;
    toast(`🔔 ${text}`, n.level === 'crit' ? 'crit' : 'info');
    if (n.level === 'crit' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
  render();
});
setInterval(render, 5000);
