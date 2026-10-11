/* Famicura · Prsten – most mezi chytrým prstenem (QRing / Colmi) a Famicurou.
 *
 * Telefon s Androidem (Chrome) leží u klienta na nabíječce s otevřenou touto
 * stránkou. Stránka se přes Web Bluetooth spojí s prstenem, každých 15 minut
 * stáhne historii tepu (prsten si ji měří sám), jednou za hodinu změří kyslík
 * a pošle vše na server (POST /api/prsten/mereni → A_KAM_Mereni u kamery
 * klienta). Přihlášení je stejné jako v aplikaci rodiny (cookie). */
import {
  SLUZBA, RX, TX, TYP, paketCas, paketBaterie, paketNastaveniTepu, paketHistorieTepu, paketStart, paketStop, paketPokracuj,
  pulnocUtc, skladacHistorieTepu, mereni, baterie, platny,
} from './prsten-protokol.js';

const $ = (id) => document.getElementById(id);
const AUTO_MS = 15 * 60_000, SPO2_MS = 60 * 60_000, DEN = 86_400_000;
const pamet = {
  get(k, d = null) { try { const v = localStorage.getItem('prsten.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('prsten.' + k, JSON.stringify(v)); } catch { /* bez úložiště */ } },
};
const cas = (ms) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

function log(text, druh = '') {
  const li = document.createElement('li');
  li.innerHTML = '<span class="when"></span><span></span>';
  li.firstChild.textContent = cas(Date.now());
  li.lastChild.textContent = text;
  if (druh) li.lastChild.className = 'stav ' + druh;
  $('log').prepend(li);
  while ($('log').children.length > 80) $('log').lastChild.remove();
}
function stav(text, druh = '') { $('stav').textContent = text; $('stav').className = 'stav ' + druh; }

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store', credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch { /* bez těla */ }
  if (!r.ok) { const e = new Error(data.error || `Chyba serveru (${r.status})`); e.status = r.status; throw e; }
  return data;
}

/* ---------- spojení s prstenem ---------- */
let zarizeni = null, rx = null, rucneOdpojeno = false, baterieProcent = null;
const cekajici = new Set();   // obsluhy notifikací: fn(paket) → true = vyřízeno
let fronta = Promise.resolve();

function prijato(ev) {
  const b = new Uint8Array(ev.target.value.buffer.slice(ev.target.value.byteOffset, ev.target.value.byteOffset + ev.target.value.byteLength));
  if (!platny(b)) return;
  for (const fn of [...cekajici]) { try { if (fn(b)) cekajici.delete(fn); } catch { cekajici.delete(fn); } }
}
function posli(p) {
  fronta = fronta.then(() => (rx.properties.writeWithoutResponse && rx.writeValueWithoutResponse ? rx.writeValueWithoutResponse(p) : rx.writeValue(p)));
  return fronta;
}
/** Pošle paket a čeká, až zpracuj(b) vrátí něco jiného než null. */
function dotaz(p, zpracuj, ms = 8000) {
  return new Promise((ok, chyba) => {
    const t = setTimeout(() => { cekajici.delete(fn); chyba(new Error('prsten neodpověděl')); }, ms);
    const fn = (b) => { const v = zpracuj(b); if (v === null || v === undefined) return false; clearTimeout(t); ok(v); return true; };
    cekajici.add(fn);
    posli(p).catch((e) => { clearTimeout(t); cekajici.delete(fn); chyba(e); });
  });
}

async function spoj() {
  stav('připojuji…', 'warn');
  const server = await zarizeni.gatt.connect();
  const sl = await server.getPrimaryService(SLUZBA);
  rx = await sl.getCharacteristic(RX);
  const tx = await sl.getCharacteristic(TX);
  tx.removeEventListener('characteristicvaluechanged', prijato);
  tx.addEventListener('characteristicvaluechanged', prijato);
  await tx.startNotifications();
  await posli(paketCas());                 // prsten počítá historii v UTC
  await posli(paketNastaveniTepu(5));      // tep si měří sám každých 5 minut
  try { const b = await dotaz(paketBaterie(), baterie); baterieProcent = b.procenta; } catch { /* starší firmware bez odpovědi */ }
  stav('připojen', 'ok');
  $('info').textContent = `${zarizeni.name || 'prsten'}${baterieProcent !== null ? ` · baterie ${baterieProcent} %` : ''}`;
  for (const id of ['mTep', 'mSpo2', 'mSync']) $(id).disabled = false;
  $('pripojit').classList.add('hide'); $('odpojit').classList.remove('hide');
  log(`Prsten ${zarizeni.name || ''} připojen${baterieProcent !== null ? `, baterie ${baterieProcent} %` : ''}.`, 'ok');
}

let pokusy = 0;
async function znovu() {
  for (const id of ['mTep', 'mSpo2', 'mSync']) $(id).disabled = true;
  if (rucneOdpojeno || !zarizeni) { stav('nepřipojen'); return; }
  stav('spojení přerušeno, zkouším znovu…', 'warn');
  const za = Math.min(60_000, 5_000 * 2 ** Math.min(pokusy++, 4));
  setTimeout(async () => {
    try { await spoj(); pokusy = 0; await synchronizuj(); }
    catch (e) { log('Znovupřipojení se nepovedlo: ' + e.message, 'bad'); znovu(); }
  }, za);
}

async function pripoj() {
  try {
    zarizeni = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'R0' }, { namePrefix: 'R1' }, { namePrefix: 'COLMI' }, { namePrefix: 'Colmi' }, { services: [SLUZBA] }],
      optionalServices: [SLUZBA],
    });
  } catch { return; }   // výběr zrušen
  rucneOdpojeno = false; pokusy = 0;
  zarizeni.addEventListener('gattserverdisconnected', () => { log('Prsten se odpojil.', 'warn'); znovu(); });
  try { await spoj(); await synchronizuj({ prvni: true }); }
  catch (e) { stav('nepřipojen', 'bad'); log('Připojení se nepovedlo: ' + e.message + '. Je prsten nabitý a odpojený od aplikace QRing?', 'bad'); }
}
function odpoj() {
  rucneOdpojeno = true;
  try { zarizeni?.gatt.disconnect(); } catch { /* už odpojený */ }
  $('pripojit').classList.remove('hide'); $('odpojit').classList.add('hide');
  stav('nepřipojen'); $('info').textContent = '—';
}
const pripojen = () => !!zarizeni?.gatt?.connected && !!rx;

/* ---------- měření a odeslání ---------- */
const kamera = () => $('kamera').value;
const klicOdeslano = () => 'odeslano.' + kamera();

async function odesli(zaznamy) {
  if (!kamera()) throw new Error('Vyberte klienta.');
  const prsten = { id: (zarizeni?.id || 'neznamy').replace(/[^A-Za-z0-9]/g, '').slice(0, 12), nazev: zarizeni?.name || '', baterie: baterieProcent };
  return api('/api/prsten/mereni', { kamera: kamera(), prsten, zaznamy });
}
function ukaz(zaznamy) {
  const t = zaznamy.filter((z) => z.tep).sort((a, b) => b.cas - a.cas)[0];
  const s = zaznamy.filter((z) => z.spo2).sort((a, b) => b.cas - a.cas)[0];
  if (t) { $('vTep').textContent = t.tep; $('vTepCas').textContent = '· ' + cas(t.cas); pamet.set('posledniTep', t); }
  if (s) { $('vSpo2').textContent = s.spo2; $('vSpo2Cas').textContent = '· ' + cas(s.cas); pamet.set('posledniSpo2', s); }
}

async function historieDne(pulnoc) {
  const sklad = skladacHistorieTepu();
  return (await dotaz(paketHistorieTepu(pulnoc), sklad, 15_000)).zaznamy;
}

let bezi = false;
/** Stáhne historii tepu za dnešek (a včerejšek, pokud ještě nebyl odeslán) a pošle nové záznamy. */
async function synchronizuj({ prvni = false } = {}) {
  if (!pripojen() || bezi || !kamera()) return;
  bezi = true;
  try {
    try { const b = await dotaz(paketBaterie(), baterie, 4000); baterieProcent = b.procenta; } catch { /* nevadí */ }
    const odeslano = Number(pamet.get(klicOdeslano(), 0)) || 0;
    const dnes = pulnocUtc(Date.now());
    const dny = odeslano < dnes || prvni ? [dnes - DEN, dnes] : [dnes];
    let vse = [];
    for (const d of dny) vse = vse.concat(await historieDne(d));
    const nove = vse.filter((z) => z.cas > odeslano && z.cas <= Date.now() + 60_000);
    if (!nove.length) { log('Historie tepu: nic nového.'); return; }
    const r = await odesli(nove);
    pamet.set(klicOdeslano(), Math.max(...nove.map((z) => z.cas)));
    ukaz(nove);
    log(`Odesláno ${r.ulozeno} měření tepu z historie prstenu.`, 'ok');
  } catch (e) {
    log('Synchronizace se nepovedla: ' + e.message, 'bad');
    if (e.status === 401) ukazPrihlaseni();
  } finally { bezi = false; }
}

/** Měření v reálném čase (prsten musí být na prstu). Vrátí hodnotu, nebo null. */
async function zmer(typ) {
  if (!pripojen()) return null;
  const hodnoty = [];
  const hotovo = await new Promise((ok) => {
    const konec = setTimeout(() => { cekajici.delete(fn); ok(false); }, typ === TYP.SPO2 ? 60_000 : 40_000);
    const fn = (b) => {
      const m = mereni(b); if (!m || m.typ !== typ) return false;
      if (m.chyba) { clearTimeout(konec); ok(false); return true; }
      if (m.hodnota > 0) hodnoty.push(m.hodnota);
      if (typ === TYP.TEP) posli(paketPokracuj()).catch(() => {});
      const dost = typ === TYP.TEP ? hodnoty.length >= 6 : hodnoty.filter((v) => v >= 70).length >= 2;
      if (dost) { clearTimeout(konec); ok(true); return true; }
      return false;
    };
    cekajici.add(fn);
    posli(paketStart(typ)).catch(() => { clearTimeout(konec); cekajici.delete(fn); ok(false); });
  });
  await posli(paketStop(typ)).catch(() => {});
  if (!hotovo) return null;
  if (typ === TYP.TEP) { const s = hodnoty.slice(-5).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
  return hodnoty.filter((v) => v >= 70).at(-1);
}
async function zmerAOdesli(typ) {
  const nazev = typ === TYP.TEP ? 'tep' : 'kyslík';
  if (bezi) return; bezi = true;
  log(`Měřím ${nazev}… (prsten musí být na prstu, klient v klidu)`);
  try {
    const v = await zmer(typ);
    if (v == null) { log(`Měření (${nazev}) se nepovedlo – je prsten nasazený?`, 'warn'); return; }
    const z = typ === TYP.TEP ? { cas: Date.now(), tep: v } : { cas: Date.now(), spo2: v };
    await odesli([z]); ukaz([z]);
    if (typ === TYP.SPO2) pamet.set('spo2Kdy', Date.now());
    log(`Změřeno: ${nazev} ${v}${typ === TYP.SPO2 ? ' %' : ' / min'}, odesláno.`, 'ok');
  } catch (e) { log(`Měření (${nazev}): ${e.message}`, 'bad'); if (e.status === 401) ukazPrihlaseni(); }
  finally { bezi = false; }
}

/* ---------- automatický režim ---------- */
let posledniSync = 0;
async function tik() {
  if (!pripojen()) { $('dalsi').textContent = ''; return; }
  const ted = Date.now();
  if ($('auto').checked && ted - posledniSync >= AUTO_MS) { posledniSync = ted; await synchronizuj(); }
  if ($('autoSpo2').checked && ted - (Number(pamet.get('spo2Kdy', 0)) || 0) >= SPO2_MS) await zmerAOdesli(TYP.SPO2);
  $('dalsi').textContent = $('auto').checked ? `Další odeslání historie kolem ${cas(posledniSync + AUTO_MS)}.` : '';
}
let zamek = null;
async function drzDisplej() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') zamek = await navigator.wakeLock.request('screen'); } catch { /* bez zámku */ }
}

/* ---------- start ---------- */
function ukazPrihlaseni() {
  $('prihlas').classList.remove('hide');
  $('prihlasOdkaz').href = '/proto/rodina.html' + location.search;
}
async function start() {
  if (!navigator.bluetooth) { $('neumi').classList.remove('hide'); $('pripojit').disabled = true; }
  for (const [k, id, jed] of [['posledniTep', 'vTep', 'tep'], ['posledniSpo2', 'vSpo2', 'spo2']]) {
    const z = pamet.get(k); if (z) { $(id).textContent = z[jed]; $(id + 'Cas').textContent = '· ' + cas(z.cas); }
  }
  for (const id of ['auto', 'autoSpo2']) { $(id).checked = pamet.get(id, true); $(id).addEventListener('change', () => pamet.set(id, $(id).checked)); }
  try {
    const ja = await api('/api/rodina/ja');
    const sel = $('kamera'); sel.innerHTML = '';
    for (const k of ja.kamery || []) { const o = document.createElement('option'); o.value = k.id; o.textContent = k.name || k.id; sel.append(o); }
    if (!sel.options.length) { const o = document.createElement('option'); o.textContent = ja.zprava || 'Žádný klient s kamerou'; o.value = ''; sel.append(o); }
    const uloz = pamet.get('kamera'); if (uloz && [...sel.options].some((o) => o.value === uloz)) sel.value = uloz;
    sel.addEventListener('change', () => pamet.set('kamera', sel.value));
  } catch (e) { if (e.status === 401) ukazPrihlaseni(); else log('Server: ' + e.message, 'bad'); }
  $('pripojit').addEventListener('click', pripoj);
  $('odpojit').addEventListener('click', odpoj);
  $('mTep').addEventListener('click', () => zmerAOdesli(TYP.TEP));
  $('mSpo2').addEventListener('click', () => zmerAOdesli(TYP.SPO2));
  $('mSync').addEventListener('click', () => { posledniSync = Date.now(); synchronizuj(); });
  document.addEventListener('visibilitychange', drzDisplej);
  drzDisplej();
  setInterval(tik, 60_000);
}
start();
