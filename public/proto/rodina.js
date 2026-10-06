import { createSource } from '/proto/zdroj.js';
import { sim, KINDS, LEVEL_LABEL, urovenUdalosti, CONSENT, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, describeWatch, describeKontakty, casy, KLID_NAVZDY } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
let FAMILY = ['tapoc2020', 'p2'];       // v ukázce a pro poskytovatele; rodina dostane své kamery ze serveru
let patientId = FAMILY[0];
let src = null, panel = null, demo = false, JA = {};
const params = new URLSearchParams(location.search);
// Zobrazení = podklad (plný obraz, rozostřený obraz, černé pozadí) + drátěný model přes
// něj. Model jde zapnout k plnému i rozostřenému obrazu; na černém pozadí je vždy.
const REZIM = { full: ['full', false], normal: ['full', false], blur: ['blur', false], blurskel: ['blur', true],
  fullskel: ['full', true], model: ['full', true], skeleton: ['skeleton', true], black: ['skeleton', true] };
const SKEL_KEY = 'famicura.proto.skel';
const zRezimu = REZIM[params.get('rezim')];
let baseMode = zRezimu ? zRezimu[0] : 'full';
// Drátěný model je výchozí (rodina si ho může vypnout); k plnému i rozostřenému obrazu jde kdykoli přidat.
let skel = zRezimu ? zRezimu[1] : localStorage.getItem(SKEL_KEY) !== '0';
const viewMode = () => (sim.patient?.(patientId)?.deaktivace ? 'deaktivace' : baseMode === 'skeleton' ? 'skeleton' : skel ? `${baseMode}skel` : baseMode);
let filter = 'all';
let histStrana = 0;   // stránka deníku (po 12), při změně filtru zpět na začátek
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
      : sim.patient(patientId)?.deaktivace ? 'Kamera je deaktivovaná: obraz nejde nikomu, dokud ji neaktivujete.'
      : demo ? 'Ukázka bez přihlášení: náhradní scéna místo skutečné kamery.'
      : `Obraz z kamery teď nejde (${s.error || 'kamera nedostupná'}). Ukazuji náhradní scénu; poskytovatel o výpadku ví z diagnostiky.`;
  });
  if (!sim.naServeru) sim.startRealEvents(deviceId);
}

function setupPatients() {
  patientId = FAMILY[0];
  // Panel Simulace má rodina jen na vyžádání odkazem (?simulace=1) nebo v ukázce (?ukazka=1); skutečná rodina ho nevidí.
  const seSimulaci = demo || params.get('simulace') === '1';
  panel = seSimulaci ? mountPanel({ role: 'rodina', patientIds: FAMILY, onPatient: (id) => { patientId = id; render(); } }) : { select() {}, patient: () => patientId, refresh() {} };
  $('patient').innerHTML = FAMILY.map((id) => `<option value="${id}">${esc(sim.patient(id).name)}</option>`).join('');
  $('patient').onchange = () => { vyberKameru($('patient').value); };
  kresliKamVyber();
  render();
}

/** Přihlášený uživatel rodiny (nebo poskytovatel z hlavní aplikace). */
function boot(ja) {
  JA = ja || {};
  hideGate();
  sim.pripojit().then((ok) => { if (!ok && sim.chybaServeru) toast(`Data poskytovatele se nepodařilo načíst ze serveru: ${sim.chybaServeru}`, 'crit'); });   // po přihlášení: stav ze serveru, společný s dispečinkem
  const posk = ja.tenant ? (ja.tenant.nazev || ja.tenant.id) : '';
  for (const k of ja.kamery || []) sim.ensurePatient({ id: k.id, name: k.name });
  FAMILY = (ja.kamery || []).map((k) => k.id);
  if (ja.role === 'rodina') {
    $('whoami').textContent = `${ja.jmeno} · rodina${posk ? ' · ' + posk : ''}`;
    $('ucetInfo').textContent = `Přihlášen(a) jako ${ja.jmeno}, telefon ${ja.telefon}${posk ? ', poskytovatel ' + posk : ''}. ${ja.kamery.length ? '' : 'Poskytovatel vám zatím nepřiřadil kameru.'}`;
  } else {
    $('whoami').textContent = `${ja.jmeno || 'Poskytovatel'} · ${ja.role === 'dispecer' ? 'dispečink' : 'správce'}${posk ? ' · ' + posk : ''}`;
    $('ucetInfo').textContent = ja.role === 'dispecer' ? `Jste přihlášeni jako dispečer (${ja.jmeno}). Vidíte aplikaci rodiny pro kamery poskytovatele ${posk}.` : 'Jste přihlášeni jako správce serveru. Vidíte aplikaci rodiny pro kamery zvoleného poskytovatele.';
    $('pwOpen').classList.add('hide');
  }
  if (!FAMILY.length) {
    // bez kamery není co kreslit: stránka řekne proč a nabídne ukázku
    $('srcNote').textContent = 'Poskytovatel vám zatím nepřiřadil kameru. Až ji přiřadí, obraz se tu objeví sám.';
    FAMILY = [sim.state.patients[0]?.id || 'tapoc2020'];
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


/* Výběr kamery: dlaždice pod hlavičkou, jen když má rodina víc kamer (jedna kamera = nic navíc). */
function vyberKameru(id) {
  deaktZobrazeno = null;
  if (!FAMILY.includes(id) || id === patientId) return;
  patientId = id; $('patient').value = id; panel.select(patientId);
  nahravkyCache = { cas: 0, pocet: -1, html: '', ver: 0 }; $('nahravkySeznam').innerHTML = '';
  histStrana = 0;   // deník i nahrávky jsou jen vybrané kamery, stránkování od začátku
  // obraz: odpojit kameru, která běžela, a připojit vybranou (texty i obraz patří k téže kameře)
  if (src) { try { src.stop(); src.video?.remove(); } catch { /* nic */ } }
  startSource(id);
  render(); kresliKamVyber();
}
function kresliKamVyber() {
  const box = $('kamVyber');
  box.classList.toggle('hide', FAMILY.length < 2);
  if (FAMILY.length < 2) { box.innerHTML = ''; return; }
  const html = FAMILY.map((id) => { const p = sim.patient(id); if (!p) return '';
    const open = sim.state.events.filter((e) => e.patientId === id && e.state !== 'uzavřen' && KINDS[e.kind] && KINDS[e.kind].level !== 'info');
    const krit = open.some((e) => KINDS[e.kind].level === 'crit');
    const stav = p.offline ? '<span class="st off">nedostupná</span>' : open.length ? `<span class="st ${krit ? 'crit' : 'warn'}">${open.length} ${open.length === 1 ? 'otevřený alert' : open.length < 5 ? 'otevřené alerty' : 'otevřených alertů'}</span>` : '<span class="st ok">v pořádku</span>';
    return `<button type="button" role="tab" data-kam="${esc(id)}" aria-pressed="${id === patientId}"><span class="ic">📷</span><span class="nm">${esc(p.name)}</span>${p.place ? `<span class="pl">${esc(p.place)}</span>` : ''}${stav}</button>`; }).join('');
  if (box.dataset.html === html) return;   // překreslit jen při změně (stav alertů, vybraná kamera)
  box.dataset.html = html; box.innerHTML = html;
  box.querySelectorAll('[data-kam]').forEach((b) => { b.onclick = () => vyberKameru(b.dataset.kam); });
}
function renderModes() {
  $('modes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === baseMode)));
  const sw = $('skelSw');
  sw.disabled = baseMode === 'skeleton';
  sw.checked = baseMode === 'skeleton' || skel;
  $('skelHint').textContent = baseMode === 'skeleton' ? 'na černém pozadí je drátěný model vždy' : 'kostra postavy přes plný i rozostřený obraz';
  const ch = $('skelChip'); ch.disabled = baseMode === 'skeleton'; ch.setAttribute('aria-pressed', String(sw.checked)); ch.textContent = `🦴 Drátěný model: ${sw.checked ? 'zapnuto' : 'vypnuto'}`;
}
/* Test obrazu: rodina vidí vždy plný obraz; velkým tlačítkem si může vyzkoušet,
 * jak vypadá rozostření, černé pozadí a drátěný model. Jen na tomhle telefonu,
 * poskytovateli se nic nemění (to je karta Přístup poskytovatele). */
const testObrazu = (on) => { $('testObrazu').classList.toggle('hide', !on); $('testStart').classList.toggle('hide', on); };
$('testBtn').onclick = () => { testObrazu(true); $('testObrazu').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
$('testZavrit').onclick = () => { baseMode = 'full'; skel = true; localStorage.setItem(SKEL_KEY, '1'); renderModes(); render(); testObrazu(false); };
if (zRezimu && (zRezimu[0] !== 'full' || zRezimu[1])) testObrazu(true);   // ?rezim= otevře test rovnou v tom zobrazení
$('modes').querySelectorAll('button').forEach((b) => { b.onclick = () => { baseMode = b.dataset.mode; renderModes(); render(); }; });
$('skelSw').onchange = () => { skel = $('skelSw').checked; localStorage.setItem(SKEL_KEY, skel ? '1' : '0'); renderModes(); render(); };
$('skelChip').onclick = () => { skel = !skel; localStorage.setItem(SKEL_KEY, skel ? '1' : '0'); renderModes(); render(); };
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
$('filters').querySelectorAll('button').forEach((b) => { b.onclick = () => { filter = b.dataset.f; histStrana = 0; $('filters').querySelectorAll('button').forEach((o) => { o.setAttribute('aria-pressed', String(o === b)); o.classList.toggle('on', o === b); }); render(); }; });
/* Nahrát: server pořídí klip z kamery a uloží ho podle Nastavení poskytovatele (server / Google Disk); do historie jde řádek
 * „Ruční nahrávka“. Bez stavu na serveru (ukázka) jen řádek v historii. */
$('rec').onclick = async () => {
  const b = $('rec');
  if (sim.patient(patientId)?.deaktivace) { toast('Kamera je deaktivovaná – nic se nenahrává. Nejdřív ji aktivujte.', 'crit'); return; }
  if (!sim.naServeru) { sim.emit(patientId, 'nahravka', { text: 'Ruční nahrávka 15 s (ukázka, bez serveru).' }); toast('Nahrávám 15 s…'); return; }
  b.disabled = true; toast('Nahrávám…');
  try {
    const r = await fetch('/api/nahravky/rucni', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kamera: patientId }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'nahrávka se nepodařila');
    await sim.emit(patientId, 'nahravka', { text: `Rodina pořídila ruční nahrávku ${j.nahravka.delkaS} s (${j.nahravka.uloziste === 'disk' ? 'Google Disk' : 'na serveru'}).` });
    toast(j.nahravka.zamek ? `Nahrávka uložena (${j.nahravka.delkaS} s). Máte nastavený rozostřený obraz, takže je pro poskytovatele uzamčená – odemknout ji můžete v kartě Nahrávky.` : `Nahrávka uložena (${j.nahravka.delkaS} s). Najdete ji v kartě Nahrávky.`); nactiNahravky(true);
  } catch (e) { toast(`Nahrávka se nepodařila: ${e.message}`, 'crit'); }
  b.disabled = false;
};
$('sound').onclick = () => { const ic = $('sound').querySelector('.ic'); ic.textContent = ic.textContent === '🔇' ? '🔊' : '🔇'; };

/* Deaktivace kamery rodinou: tlačítko a výrazný stav. Při deaktivaci server nedává obraz nikomu (ani rodině),
 * nenahrává, nezapisuje události a kameru otočí do stropu; vlastní obraz tu proto zastavíme a kreslí se jen nápis. */
let deaktZobrazeno = null;
function kresliDeaktivaci(p) {
  const card = $('deaktCard'); if (!card) return;
  const ja = JA;
  const smi = !sim.naServeru || ja.role === 'rodina';
  const d = p.deaktivace;
  if (d && deaktZobrazeno !== true) { deaktZobrazeno = true; src?.odpoj?.('kamera je deaktivovaná'); }
  if (!d && deaktZobrazeno === true) { deaktZobrazeno = false; if (src) src.connect(); else startSource(patientId); }
  if (!d && deaktZobrazeno === null) deaktZobrazeno = false;
  card.classList.toggle('on', !!d);
  card.classList.toggle('hide', !p.real && !d);
  const otoceni = !d ? '' : d.otoceni === 'ok' ? 'Kamera je otočená do stropu.' : d.otoceni ? `Otočení do stropu se nepodařilo (${d.otoceni.replace(/^chyba: /, '')}) – obraz, nahrávky i události jsou přesto vypnuté.` : 'Kamera se otáčí do stropu…';
  const html = d
    ? `<div class="drow"><div class="dtxt"><strong>⏻ Kamera je deaktivovaná</strong><small>od ${fmtDT(d.od)}${d.kdo ? ' (' + esc(d.kdo) + ')' : ''}</small>
        <ul><li>poskytovatel ani vy nemáte obraz</li><li>nic se nenahrává</li><li>události z kamery se nezapisují, nikdo není upozorněn</li><li>${esc(otoceni)}</li></ul></div>
        ${smi ? `<button type="button" class="dbtn onb" id="deaktBtn" data-on="0">▶ Aktivovat kameru<small>obraz a hlídání podle nastavení</small></button>` : '<span class="small">Aktivovat ji může jen rodina.</span>'}</div>`
    : `<div class="drow"><div class="dtxt"><strong>Kamera je aktivní</strong><small>Deaktivací přestane posílat obraz, nic se nenahrává, události se nezapisují a kamera se otočí do stropu. Kdykoli ji zase aktivujete.</small></div>
        ${smi ? `<button type="button" class="dbtn off" id="deaktBtn" data-on="1">⏻ Deaktivovat kameru<small>bez obrazu, nahrávek a událostí</small></button>` : ''}</div>`;
  if (setHtml(card, html)) {
    const b = $('deaktBtn');
    if (b) b.onclick = async () => {
      const on = b.dataset.on === '1';
      if (on && !confirm('Deaktivovat kameru?\n\nPoskytovatel ani vy neuvidíte obraz, nic se nenahraje, události se nezapíší a nikdo nebude upozorněn. Kamera se otočí do stropu. Aktivovat ji můžete kdykoli.')) return;
      b.disabled = true;
      try { await sim.deaktivace(patientId, on, ja.jmeno || 'rodina'); toast(on ? 'Kamera je deaktivovaná. Otáčí se do stropu.' : 'Kamera je aktivní, vrací se do výchozí polohy.'); }
      catch (e) { toast(`Nepodařilo se: ${e.message}`, 'crit'); b.disabled = false; }
    };
  }
}

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
  $('pstatus').textContent = p.deaktivace ? 'kamera deaktivovaná' : p.offline ? 'kamera nedostupná' : worst === 'crit' ? 'kritická událost' : worst === 'warn' ? 'varování' : 'klid';
  $('pstatus').className = 'badge hide ' + (p.deaktivace || p.offline ? 'tech' : worst || 'ok');
  $('avatar').textContent = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const hero = $('hero');
  const lastEv = s.events.find((e) => e.patientId === patientId && e.kind !== 'consent' && e.kind !== 'poznamka');
  const heroKind = p.deaktivace ? 'deakt' : p.offline ? 'off' : worst || 'ok';
  hero.className = 'hero-' + heroKind;
  $('heroIc').textContent = { ok: '✓', warn: '!', crit: '!', off: '⌁', deakt: '⏻' }[heroKind];
  $('heroT').textContent = { ok: 'Vše v pořádku', warn: 'Varování, podívejte se', crit: 'Kritická událost', off: 'Kamera je nedostupná', deakt: 'Kamera je deaktivovaná' }[heroKind];
  $('heroS').textContent = p.deaktivace ? `Vypnuto od ${fmtDT(p.deaktivace.od)} · bez obrazu, nahrávek a událostí` : lastEv ? `Poslední událost: ${eventText(lastEv)} · ${fmtT(lastEv.at)}` : 'Zatím žádná událost';
  kresliDeaktivaci(p);
  kresliKamVyber();
  $('modeTag').textContent = { full: 'plný obraz', blur: 'rozostřený obraz', fullskel: 'drátěný model přes obraz', blurskel: 'rozostření s drátěným modelem', skeleton: 'jen drátěný model' }[viewMode()];
  const efZdroj = { deaktivace: 'kameru jste deaktivovali', povoleni: 'povolení na žádost poskytovatele', rychle: 'vaše rychlé přepnutí', offline: 'kamera je nedostupná', den: `denní nastavení (den ${denOd}–${nocOd})`, noc: `noční nastavení (noc ${nocOd}–${denOd})` }[ef.zdroj] || '';
  setHtml($('effective'), `Teď poskytovatel vidí: <strong>${esc(ef.zdroj === 'deaktivace' ? 'nic, kamera je deaktivovaná' : ef.mode === 'offline' ? 'nic, kamera nedostupná' : CONSENT[ef.mode] || ef.mode)}</strong><small>${esc(efZdroj)}${ef.do ? ` · do ${fmtT(ef.do)}` : ''}</small>`);
  const kontakty = describeKontakty(p);
  $('watchInfo').textContent = describeWatch(p.watch || {}) + (kontakty ? ` · upozornění poskytovatele jdou na ${kontakty}` : '');

  // provider watching
  const g = s.grants[patientId], w = s.watching[patientId];
  if (setHtml($('watching'), g && w ? `<div class="watching"><span class="grow">👁 ${esc(w.who)} se dívá na plný obraz od ${fmtT(w.since)} (${esc(g.kind)}, do ${fmtT(g.until)})</span><button class="sm warn" id="endW">Ukončit</button></div>` : '') && g && w) $('endW').onclick = () => sim.endGrant(patientId, 'rodina');

  // klid
  const k = s.klid[patientId];
  const klidAktivni = k && k > Date.now();
  $('klidState').textContent = klidAktivni ? (k >= KLID_NAVZDY ? 'klid do vypnutí' : `klid do ${fmtT(k)}`) : 'klid vypnutý';
  document.querySelectorAll('[data-klid]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.klid === 'vypnout' ? !klidAktivni : false)));

  // otevřené alerty: jen počet – řeší a uzavírá je dispečink poskytovatele, podrobnosti má rodina v historii
  const krit = open.filter((e) => KINDS[e.kind].level === 'crit').length, varov = open.filter((e) => KINDS[e.kind].level === 'warn').length;
  const alertu = krit + varov;
  const sklon = (n, j, m, v) => `${n} ${n === 1 ? j : n < 5 ? m : v}`;
  const casti = [krit ? sklon(krit, 'kritický', 'kritické', 'kritických') : '', varov ? sklon(varov, 'varování', 'varování', 'varování') : ''].filter(Boolean).join(', ');
  const notifHtml = alertu ? `<div class="banner ${krit ? 'crit' : 'warn'}"><span class="grow"><strong>${esc(sklon(alertu, 'otevřený alert', 'otevřené alerty', 'otevřených alertů'))}</strong> (${esc(casti)}) · řeší a uzavírá dispečink poskytovatele, podrobnosti jsou v Historii.</span><button type="button" class="sm sec" data-hist>Historie</button></div>` : '';
  if (setHtml($('notifs'), notifHtml)) $('notifs').querySelectorAll('[data-hist]').forEach((b) => { b.onclick = () => { location.hash = '#historie'; $('historie').scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });

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
  });
  // deník po 12: stránka histStrana (0 = nejnovější), tlačítka Starší / Novější pod seznamem
  const STRANA = 12;
  const stran = Math.max(1, Math.ceil(rows.length / STRANA));
  if (histStrana > stran - 1) histStrana = stran - 1;
  const od = histStrana * STRANA;
  const strankaRows = rows.slice(od, od + STRANA);
  setHtml($('historyPaging'), rows.length > STRANA ? `<button class="sm sec" data-hist="novejsi" ${histStrana === 0 ? 'disabled' : ''}>◀ Novějších 12</button><span class="small muted">${od + 1}–${Math.min(od + STRANA, rows.length)} z ${rows.length}</span><button class="sm sec" data-hist="starsi" ${histStrana >= stran - 1 ? 'disabled' : ''}>Starších 12 ▶</button>` : '');
  $('historyPaging').querySelectorAll('[data-hist]').forEach((b) => { b.onclick = () => { histStrana += b.dataset.hist === 'starsi' ? 1 : -1; render(); $('historie').scrollIntoView({ block: 'start', behavior: 'smooth' }); }; });
  setHtml($('history'), strankaRows.map((e) => {
    const k = KINDS[e.kind];
    const badge = e.kind === 'consent' ? '<span class="badge">souhlas</span>' : `<span class="badge ${levelClass(urovenUdalosti(e))}">${esc(k.source)}</span>`;
    const tail = e.state && e.state !== 'uzavřen' && k ? ` · <span class="badge warn">${esc(e.state)}${e.by ? ' – ' + esc(e.by) : ''}</span>` : e.result ? ` · <span class="muted">${esc(e.result)}</span>` : '';
    const rec = e.nahravka && e.nahravka.url ? ` · <a href="${esc(e.nahravka.url)}" target="_blank" rel="noopener" class="small">🎞 nahrávka</a>` : e.nahravka && e.nahravka.id && !e.nahravka.chyba && !e.nahravka.smazano ? ` · <a href="#" class="small" data-prehrat="${esc(e.nahravka.id)}">🎞 nahrávka${e.nahravka.delkaS ? ' ' + e.nahravka.delkaS + ' s' : ''}${e.nahravka.zamek ? ' 🔒' : ''}</a>` : '';
    const cls = e.kind === 'consent' ? 'consent' : urovenUdalosti(e);
    return `<li class="${cls}"><span class="when">${fmtDT(e.at)}</span><span class="grow">${badge} ${esc(eventText(e))}${e.real ? ' <span class="badge ok">skutečná</span>' : ''}${tail}${rec}</span></li>`;
  }).join('') || '<li class="muted">Zatím nic.</li>');
  prehravaniOvladani($('history'));
  nactiNahravky();
  ptzUkaz();
}

/* Otočení kamery (Tapo pan/tilt přes ONVIF): jen u skutečné kamery se stavem na serveru; krátký krok na stisknutí. */
function ptzUkaz() {
  const box = $('ptz'); if (!box) return;
  const p = sim.patient(patientId);
  box.classList.toggle('hide', !(sim.naServeru && p && p.real) || !!p.deaktivace);
}
$('ptz')?.querySelectorAll('[data-ptz]').forEach((b) => { b.onclick = async () => {
  const box = $('ptz'); box.classList.add('busy');
  try { const r = await fetch('/api/ptz', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kamera: patientId, smer: b.dataset.ptz }) }); const j = await r.json(); if (!j.ok) throw new Error(j.error || 'nepodařilo se'); }
  catch (e) { toast(`Otočení kamery: ${e.message}`, 'crit'); }
  box.classList.remove('busy');
}; });

/* Nahrávky kamery rodiny: seznam ze serveru (jen své kamery), přehrání v aplikaci (jde do auditu poskytovatele). */
let nahravkyCache = { cas: 0, pocet: -1, html: '', ver: 0 };
async function nactiNahravky(vynutit = false) {
  const card = $('nahravky'); if (!card || !sim.naServeru) return;
  const sN = sim.state.events.filter((e) => e.patientId === patientId && e.nahravka);
  const odemknuti = sim.state.events.filter((e) => e.patientId === patientId && e.kind === 'consent' && /odemkla poskytovateli nahrávku/.test(e.text || '')).length;
  const pocet = odemknuti * 1000000 + sN.length * 1000 + sN.filter((e) => e.nahravka.zamek).length;   // i uzamčené a odemknutí: po odemknutí se seznam načte znovu
  if (!vynutit && nahravkyCache.pocet === pocet && Date.now() - nahravkyCache.cas < 60000) return;
  nahravkyCache = { cas: Date.now(), pocet, html: nahravkyCache.html };
  let html;
  try {
    const r = await fetch('/api/nahravky?kamera=' + encodeURIComponent(patientId) + '&limit=20', { credentials: 'same-origin' });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    html = j.nahravky.filter((n) => !n.chyba && n.typ !== 'kostra').map((n) => {
      const co = n.druh && KINDS[n.druh] ? KINDS[n.druh].label : n.zdroj === 'rucni' ? 'ruční' : n.zdroj === 'plan' ? 'plán' : 'událost';
      const kde = n.uloziste === 'server' ? `<a href="#" data-prehrat="${esc(n.id)}">▶ přehrát</a>` : n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">🎞 otevřít na Google Disku</a>` : '';
      // uzamčená = pořízená, když jste měli nastavený rozostřený obraz: vy ji vidíte, poskytovatel až po odemknutí
      const zamek = n.zamek ? `<div class="zamek"><span class="badge warn">🔒 nahrávka uzamčena</span><span class="small muted">poskytovatel ji neuvidí, dokud ji neodemknete</span><button type="button" class="sm" data-odemknout="${esc(n.id)}">Odemknout</button></div>` : n.odemklKdo ? `<div class="small muted">odemčeno pro poskytovatele${n.odemklCas ? ' ' + fmtDT(n.odemklCas) : ''}</div>` : '';
      return `<li class="info" data-nahravka="${esc(n.id)}"><span class="when">${fmtDT(n.cas)}</span><span class="grow">${esc(co)}${n.delkaS ? ` · ${n.delkaS} s` : ''} · ${kde}${zamek}</span></li>`;
    }).join('') || '<li class="muted">Zatím žádná nahrávka.</li>';
  } catch (e) { html = `<li class="muted">Nahrávky se nepodařilo načíst: ${esc(e.message)}</li>`; }
  if (html !== nahravkyCache.html) nahravkyCache.ver = Date.now();
  nahravkyCache.html = html;
  card.classList.remove('hide');
  const el = $('nahravkySeznam');
  if (el.dataset.ver !== String(nahravkyCache.ver)) {
    // běžící přehrávač přežije překreslení seznamu (vrátí se do řádku své nahrávky)
    const bezici = el.querySelector('video.prehravac'); const radek = bezici?.closest('li')?.dataset.nahravka;
    el.innerHTML = html; el.dataset.ver = String(nahravkyCache.ver); prehravaniOvladani(el);
    if (bezici && radek) { const li = el.querySelector(`li[data-nahravka="${CSS.escape(radek)}"]`); if (li) li.append(bezici); }
  }
}
function prehravaniOvladani(el) {
  el.querySelectorAll('[data-prehrat]').forEach((a) => { a.onclick = async (ev) => {
    ev.preventDefault();
    const li = a.closest('li'); const stare = li.querySelector('video');
    if (stare) { stare.pause(); stare.remove(); return; }
    document.querySelectorAll('.prehravac').forEach((v) => { v.pause(); v.remove(); });
    // nahrávka je bez zvuku; muted je nutné, aby iPhone spustil přehrávání sám (jinak jen černý obraz)
    const v = document.createElement('video'); v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.className = 'prehravac'; v.src = `/api/nahravky/${encodeURIComponent(a.dataset.prehrat)}/soubor`;
    v.onerror = () => toast('Nahrávku se nepodařilo přehrát (soubor už na serveru není, nebo telefon formát neumí).', 'crit');
    li.append(v);
  }; });
  el.querySelectorAll('[data-odemknout]').forEach((b) => { b.onclick = async () => {
    if (!confirm('Odemknout nahrávku poskytovateli? Dispečink ji pak uvidí v plném obrazu a odemknutí se zapíše do historie.')) return;
    b.disabled = true;
    try {
      const r = await fetch(`/api/nahravky/${encodeURIComponent(b.dataset.odemknout)}/odemknout`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast('Nahrávka je odemčená, poskytovatel ji teď může přehrát.'); nactiNahravky(true);
    } catch (e) { toast(`Odemknutí se nepodařilo: ${e.message}`, 'crit'); b.disabled = false; }
  }; });
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
