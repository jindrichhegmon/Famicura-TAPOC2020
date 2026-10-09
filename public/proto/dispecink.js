import { createSource } from '/proto/zdroj.js';
import { kresliMapu, prekresliMapu, popisStavu, popisVypnuti, pametMereni, nactiMereni as nactiMereniNaramku, kresliStranuMereni, kresliGrafy, poplachyNaramku } from '/proto/naramek-ui.js';
import { mountAuthBanner, sim, KINDS, LEVEL_LABEL, urovenUdalosti, mountPanel, toast, fmtT, fmtDT, esc, escOdkazy, eventText, MEZE_ZDRAVI, urovenHodnoty, ago, setHtml, agoSpan, refreshAgo, WATCH_KINDS, kontaktyPro, describeKontakty, upozorneniVychozi, normalizeTelefonCz, jeEmail, KONTAKTY_RODINA_MAX, rodinaSTelefonem, popisPrijemce, smsIdsPro, mailIdsPro, telefonyPoskytovatele, rozdelMaily, formatTelefon, ROLE_POSKYTOVATELE, POPIS_ROLE, ZDROJE_TELEFONU, POPIS_ZDROJE_TELEFONU, POLE_ROLE, cisloSosPro, popisTelefonuRole } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
/* Údaje poskytovatele (název, telefon, dispečer, směna, záloha) se zadávají
 * jen tady a ukládají do sdíleného stavu na serveru: stejně je vidí všichni
 * dispečeři, detail kamery i aplikace rodiny. Jméno dispečera jde do převzetí
 * alertů a do žádostí o obraz. */
/* Kdo je přihlášen (dispečer tenanta z Péče doma plus, nebo správce serveru se zvoleným tenantem) a jeho kamery; z /api/rodina/ja. */
let JA = null;
const ME = () => (JA && JA.role === 'dispecer' && JA.jmeno) || sim.poskytovatel.dispecer;
const HL_POLE = ['nazev', 'email', 'dispecer', 'smena', 'zaloha', 'zalohaTelefon', 'vedouci', 'vedouciTelefon', 'eskalaceMin', 'nahravkaS', 'nahravkaPredS', 'nahravkyUloziste', 'nahravkyDny', 'nahravkyDisk', 'nahravkyGB'];
const hlPole = (k) => $('hl' + k[0].toUpperCase() + k.slice(1));
function renderHlavicka() {
  const h = sim.poskytovatel;
  $('hlavicka').textContent = [h.nazev, h.telefon, h.dispecer, h.smena, h.zaloha ? `záloha: ${h.zaloha}` : ''].filter(Boolean).join(' · ');
  if (JA) $('jaInfo').textContent = `${JA.tenant ? `${JA.tenant.nazev || JA.tenant.id} (${JA.tenant.id})` : 'bez poskytovatele'} · přihlášen(a): ${JA.jmeno}${JA.role === 'admin' ? ' (správce serveru)' : ''}`;
  renderSmena();
}
/** Karta Směna: text z nastavení a čísla spočítaná z dnešních alertů (ne vymyšlená). */
function renderSmena() {
  const h = sim.poskytovatel, s = sim.state;
  const dnes = new Date(); dnes.setHours(0, 0, 0, 0);
  const dnesni = s.events.filter((e) => e.at >= dnes.getTime() && KINDS[e.kind] && urovenUdalosti(e) !== 'info' && e.kind !== 'consent');
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
  for (const k of HL_POLE) { if (k === 'nahravkyDisk') hlPole(k).checked = !!h[k]; else hlPole(k).value = h[k] ?? ''; }
  $('zdrojNastaveni').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === zdroj)));
  $('hlErr').classList.add('hide');
  $('nastaveni').classList.remove('hide'); $('hlNazev').focus();
  smsStavNacti(); diskStavNacti();
}
/* Seznam nahrávek kamery (tabulka A_KAM_Nahravka): odkazy na Google Disk, krátká cache, obnova po změně stavu. */
const nahravkyCache = new Map();   // pid → { cas, html, pocet }
async function nactiNahravky(pid) {
  const el = document.querySelector('#detail #dnahravky'); if (!el) return;
  // otisk: počet nahrávek u událostí + kolik je uzamčených (po odemknutí rodinou se seznam načte znovu)
  const sN = sim.state.events.filter((e) => e.patientId === pid && e.nahravka);
  const odemknuti = sim.state.events.filter((e) => e.patientId === pid && e.kind === 'consent' && /odemkla poskytovateli nahrávku/.test(e.text || '')).length;
  const pocet = odemknuti * 1000000 + sN.length * 1000 + sN.filter((e) => e.nahravka.zamek).length;
  const c = nahravkyCache.get(pid);
  // seznam se přepíše jen při nové verzi (ne při každém překreslení – běžící přehrávač by zmizel)
  const ukaz = (html, ver) => { if (el.dataset.ver === String(ver)) return; el.innerHTML = html; el.dataset.ver = String(ver); prehravaniOvladani(el, pid); };
  if (c && c.pocet === pocet && Date.now() - c.cas < 60000) { ukaz(c.html, c.ver); return; }
  nahravkyCache.set(pid, { cas: Date.now(), pocet, html: c?.html || el.innerHTML, ver: c?.ver || 0 });
  let html;
  try {
    const r = await fetch('/api/nahravky?kamera=' + encodeURIComponent(pid) + '&limit=20', { credentials: 'same-origin' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    html = j.nahravky.map((n) => {
      const co = n.druh && KINDS[n.druh] ? KINDS[n.druh].label : n.zdroj === 'rucni' ? 'ruční' : n.zdroj === 'plan' ? 'plán' : 'událost';
      const vel = n.velikost ? ` · ${(n.velikost / 1048576).toFixed(1)} MB` : '';
      const stary = n.typ === 'kostra';   // záznam drátěného modelu z verzí 2.8–2.9 (jen ke stažení)
      const odemceno = n.odemklKdo ? ` · <span class="muted" title="rodina nahrávku odemkla${n.odemklCas ? ' ' + fmtDT(n.odemklCas) : ''}">odemkla rodina (${esc(n.odemklKdo)})</span>` : '';
      const kde = n.uloziste === 'server' && n.zamek ? `<span class="badge warn" title="pořízeno v době, kdy rodina měla nastavený rozostřený obraz; přehrát ji půjde, až ji rodina ve své aplikaci odemkne">🔒 nahrávka uzamčena</span> <span class="muted">odemkne rodina</span>`
        : n.uloziste === 'server' ? `${stary ? '' : `<a href="#" data-prehrat="${esc(n.id)}" title="přehrát v aplikaci (přehrání jde do auditu)">▶ přehrát</a> · `}<a href="/api/nahravky/${encodeURIComponent(n.id)}/soubor?stahnout=1" download title="stáhnout soubor ${esc(n.nazev || '')} do počítače (stažení jde do auditu)">⬇ stáhnout</a> · <span class="muted">na serveru${stary ? ', starší záznam drátěného modelu' : ''}</span>${odemceno}` : n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">🎞 otevřít na Google Disku</a>` : `<span class="bad" title="${esc(n.chyba || '')}">neuloženo: ${esc((n.chyba || '').slice(0, 80))}</span>`;
      return `<li data-nahravka="${esc(n.id)}"><span class="when">${fmtDT(n.cas)}</span><span class="grow">${esc(co)}${n.delkaS ? ` · ${n.delkaS} s` : ''}${vel}${n.kdo ? ` · <span class="muted">${esc(n.kdo)}</span>` : ''} · ${kde}${n.chyba ? '' : ` · <a href="#" class="muted" data-smazat="${esc(n.id)}" title="smazat nahrávku">smazat</a>`}</span></li>`;
    }).join('') || '<li class="muted">Zatím žádná nahrávka. Nahrává se po události se zatrženým Nahrávat (sekce Nastavení) nebo tlačítkem Nahrát teď.</li>';
  } catch (e) { html = `<li class="muted">Nahrávky se nepodařilo načíst: ${esc(e.message)}</li>`; }
  const ver = Date.now();
  nahravkyCache.set(pid, { cas: Date.now(), pocet, html, ver });
  const el2 = document.querySelector('#detail #dnahravky'); if (el2 && selected === pid) ukaz(html, ver);
}
/* Otočení kamery (ONVIF PTZ): krátký krok na každé stisknutí; server hlídá, aby šel jeden pohyb najednou. */
function ptzOvladani(box, pid) {
  if (!box) return;
  box.querySelectorAll('[data-ptz]').forEach((b) => { b.onclick = async () => {
    box.classList.add('busy');
    try { const r = await fetch('/api/ptz', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kamera: pid, smer: b.dataset.ptz }) }); const j = await r.json(); if (!j.ok) throw new Error(j.error || 'nepodařilo se'); }
    catch (e) { toast(`Otočení kamery: ${e.message}`, 'crit'); }
    box.classList.remove('busy');
  }; });
}

/* Přehrání nahrávky ze serveru přímo v seznamu (video pod řádkem) a smazání. */
function prehravaniOvladani(el, pid) {
  el.querySelectorAll('[data-prehrat]').forEach((a) => { a.onclick = async (ev) => {
    ev.preventDefault();
    const li = a.closest('li'); const stare = li.querySelector('video');
    if (stare) { stare.pause(); stare.remove(); return; }
    el.querySelectorAll('video').forEach((v) => { v.pause(); v.remove(); });
    const v = document.createElement('video'); v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true; v.className = 'prehravac'; v.src = `/api/nahravky/${encodeURIComponent(a.dataset.prehrat)}/soubor`;
    v.onerror = () => toast('Nahrávku se nepodařilo přehrát (soubor už na serveru není, nebo prohlížeč formát neumí).', 'crit');
    li.append(v);
  }; });
  el.querySelectorAll('[data-smazat]').forEach((a) => { a.onclick = async (ev) => {
    ev.preventDefault();
    if (!confirm('Smazat tuhle nahrávku? Zůstane jen záznam, že existovala.')) return;
    try { const r = await fetch(`/api/nahravky/${encodeURIComponent(a.dataset.smazat)}`, { method: 'DELETE', credentials: 'same-origin' }); const j = await r.json(); if (!j.ok) throw new Error(j.error || 'nepodařilo se'); toast('Nahrávka smazána.'); nahravkyCache.delete(pid); nactiNahravky(pid); }
    catch (e) { toast(`Smazání se nepodařilo: ${e.message}`, 'crit'); }
  }; });
}

/* Nahrávky na Google Disku: účet, který má poskytovatel připojený v Péče doma plus (Export dat); adresář zakládá dispečink. */
let diskInfo = null;
function diskUkaz(b) {
  diskInfo = b;
  const el = $('diskStav'), btn = $('diskSlozkaBtn'), odkaz = $('diskSlozkaOdkaz'), odpojit = $('diskOdpojitBtn');
  btn.disabled = true; btn.classList.remove('hide'); btn.textContent = 'Založit adresář na Google Disku'; odkaz.classList.add('hide'); odpojit.classList.add('hide');
  const u = b?.uloziste || {};
  $('diskUloziste').textContent = u.server ? `Úložiště na serveru je připravené (šifrované soubory, mazání po ${b.dny || 30} dnech). Zvolené úložiště: ${b.volba === 'disk' ? 'Google Disk' : 'server'}; kopie na Google Disk ${b.kopieDisk ? 'zapnutá' : 'vypnutá'}.` : 'Úložiště na serveru není nastavené (správce: ./deploy/vps-env.sh vygeneruje NAHRAVKY_KLIC).';
  const mb = (x) => x == null ? '?' : x >= 1073741824 ? (x / 1073741824).toFixed(1).replace('.', ',') + ' GB' : (x / 1048576).toFixed(1).replace('.', ',') + ' MB';
  const mi = b?.misto;
  $('diskMisto').textContent = mi ? `Nahrávky tohoto poskytovatele zabírají na serveru ${mb(mi.bajty)} (${mi.soubory} ${mi.soubory === 1 ? 'soubor' : mi.soubory >= 2 && mi.soubory <= 4 ? 'soubory' : 'souborů'})${mi.limitGB ? ` z limitu ${mb(mi.limitGB * 1073741824)}` : ', bez limitu'}${mi.celkem ? `; volné místo na serveru ${mb(mi.volne)} z ${mb(mi.celkem)}` : ''}${mi.minVolneGB ? ` (pojistka serveru: pod ${mb(mi.minVolneGB * 1073741824)} volného se mažou nejstarší nahrávky)` : ''}.${mi.varovani ? ' ' + mi.varovani : ''}` : '';
  $('diskMisto').classList.toggle('bad', !!mi?.varovani);
  diskVarovaniUkaz(mi?.varovani || '');
  if (!b || b.nastaveno === false || !u.disk) { el.textContent = 'Nahrávky na Google Disk nejsou na serveru nastavené: správce spustí ./deploy/vps-env.sh (klíč FAMICURA_KAMERA_KLIC) a v portálu Péče doma plus nasadí aplikaci pecedomaplus-kamera-disk.' + (u.server ? ' Nahrávky se ukládají na server.' : ''); return; }
  if (!b.kopieDisk && b.volba !== 'disk') { el.textContent = 'Google Disk je vypnutý (zaškrtávátko „Google Disk“ výše): nahrávky zůstávají jen na serveru' + (b.slozka ? `, adresář „${b.slozka.nazev}“ zůstává zapojený` : '') + '.'; btn.classList.add('hide'); if (b.slozka) { odkaz.href = b.slozka.url; odkaz.classList.remove('hide'); } return; }
  if (b.chyba) { el.textContent = `Stav Google Disku se nepodařilo zjistit: ${b.chyba}`; return; }
  if (!b.google || !b.google.pripojen) { el.textContent = 'Poskytovatel nemá v Péče doma plus připojený Google účet. Připojte ho v portálu Péče doma plus → Export dat → Připojit Google účet (stejný účet pak slouží i nahrávkám kamer).'; return; }
  if (!b.slozka) { el.textContent = `Google účet ${b.google.email} je připojený (z Péče doma plus). Nahrávky zatím nemají kam: založte adresář.`; btn.disabled = false; return; }
  el.textContent = `Nahrávky se ukládají na Google Disk ${b.google.email}, adresář „${b.slozka.nazev}“. Nahrává server po události se zatrženým Nahrávat (plný obraz, nebo kritická událost s nouzovým přístupem) a tlačítkem Nahrát teď v detailu kamery. Jiný adresář: nejdřív tenhle odpojte (na Disku zůstane i s nahrávkami), pak založte nový.`;
  btn.classList.add('hide'); odpojit.classList.remove('hide'); odkaz.href = b.slozka.url; odkaz.classList.remove('hide');
}
/* Proužek nahoře, když je na serveru málo místa nebo poskytovatel u limitu: server to hlásí v /api/nahravky/stav (misto.varovani). */
function diskVarovaniUkaz(text) {
  const el = $('diskVarovani'); if (!el) return;
  el.querySelector('.grow').textContent = text ? `Nahrávky: ${text}` : '';
  el.classList.toggle('hide', !text);
}
$('diskVarovaniNast').onclick = () => $('hlUprav').click();
async function diskVarovaniZkontroluj() {
  if (!sim.naServeru) return;
  try { const r = await fetch('/api/nahravky/stav', { credentials: 'same-origin' }); const b = await r.json(); diskVarovaniUkaz(b?.misto?.varovani || ''); } catch { /* příště */ }
}
async function diskStavNacti() {
  $('diskStav').textContent = 'Zjišťuji…';
  try { const r = await fetch('/api/nahravky/stav', { credentials: 'same-origin' }); diskUkaz(await r.json()); }
  catch { diskUkaz({ nastaveno: true, chyba: 'server neodpovídá' }); }
}
$('diskOdpojitBtn').onclick = async () => {
  const nazev = diskInfo?.slozka?.nazev || 'adresář';
  if (!confirm(`Odpojit adresář „${nazev}“? Na Google Disku zůstane i s nahrávkami, nové nahrávky se nebudou ukládat, dokud nezaložíte nový adresář.`)) return;
  const b = $('diskOdpojitBtn'); b.disabled = true; $('diskStav').textContent = 'Odpojuji adresář…';
  try {
    const r = await fetch('/api/nahravky/odpojit', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'nepodařilo se');
    diskUkaz({ nastaveno: true, google: j.google, slozka: j.slozka }); toast(j.zprava || 'Adresář odpojen.');
  } catch (e) { $('diskStav').textContent = `Adresář se nepodařilo odpojit: ${e.message}`; }
  b.disabled = false;
};
$('diskSlozkaBtn').onclick = async () => {
  const b = $('diskSlozkaBtn'); b.disabled = true; $('diskStav').textContent = 'Zakládám adresář na Google Disku…';
  try {
    const r = await fetch('/api/nahravky/slozka', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'nepodařilo se');
    diskUkaz({ nastaveno: true, google: j.google, slozka: j.slozka }); toast(j.zprava || 'Adresář založen.');
  } catch (e) { $('diskStav').textContent = `Adresář se nepodařilo založit: ${e.message}`; b.disabled = false; }
};
$('hlUprav').onclick = otevriNastaveni;
// Zkušební SMS: stejný webhook Make a Twilio jako pozvánky a žádosti o obraz; výsledek se ukáže pod polem.
let smsNastaveno = null, smsAdresa = '', smsZamena = false;
async function smsStavNacti() {
  if (smsNastaveno !== null) return;
  try { const r = await fetch('/api/sms/test', { credentials: 'same-origin' }); const b = await r.json(); smsNastaveno = !!b.nastaveno; smsAdresa = b.adresa || ''; smsZamena = !!b.stejnaJakoAsistent; }
  catch { smsNastaveno = null; }
  $('smsStav').textContent = smsNastaveno === null ? 'Stav SMS se nepodařilo zjistit.' : smsNastaveno
    ? `SMS a e-mail ze serveru jsou nastavené (webhook Make ${smsAdresa || ''} → Twilio / Centrum LB). Zkušební zpráva ověří celou cestu až na telefon nebo do schránky.`
    : 'SMS ze serveru není nastavená: správce spustí ./deploy/vps-env.sh a zadá adresu webhooku a klíč. Do té doby pozvánky posílejte z telefonu.';
  $('smsVarovani').classList.toggle('hide', !smsZamena);
  $('smsTestBtn').disabled = !smsNastaveno; $('mailTestBtn').disabled = !smsNastaveno;
}
$('mailTestBtn').onclick = async () => {
  const email = $('mailTestAdr').value.trim();
  if (!email) { $('smsStav').textContent = 'Zadejte e-mail, kam zkušební zprávu poslat.'; $('mailTestAdr').focus(); return; }
  $('mailTestBtn').disabled = true; $('smsStav').textContent = 'Posílám e-mail…';
  try {
    const r = await fetch('/api/sms/test', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const b = await r.json();
    $('smsStav').textContent = b.ok ? `Zkušební e-mail odešel na ${b.email}. Měl by dojít do minuty (zkontrolujte i nevyžádanou poštu).` : `E-mail neodešel: ${b.error || 'chyba serveru'}`;
    toast(b.ok ? 'Zkušební e-mail odeslán.' : `Zkušební e-mail neodešel: ${b.error || 'chyba'}`, b.ok ? undefined : 'crit');
  } catch (ex) { $('smsStav').textContent = `E-mail neodešel: ${ex.message}`; }
  $('mailTestBtn').disabled = false;
};
$('smsTestBtn').onclick = async () => {
  const tel = $('smsTestTel').value.trim();
  if (!tel) { $('smsStav').textContent = 'Zadejte číslo, kam zkušební SMS poslat.'; $('smsTestTel').focus(); return; }
  $('smsTestBtn').disabled = true; $('smsStav').textContent = 'Posílám…';
  try {
    const r = await fetch('/api/sms/test', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telefon: tel }) });
    const b = await r.json();
    $('smsStav').textContent = b.ok ? `Zkušební SMS odešla na ${b.telefon}${b.sid ? ' (Twilio ' + b.sid + ')' : ''}. Měla by dojít do minuty.` : `SMS neodešla: ${b.error || 'chyba serveru'}`;
    toast(b.ok ? 'Zkušební SMS odeslána.' : `Zkušební SMS neodešla: ${b.error || 'chyba'}`, b.ok ? undefined : 'crit');
  } catch (ex) { $('smsStav').textContent = `SMS neodešla: ${ex.message}`; }
  $('smsTestBtn').disabled = false;
};
$('hlZrusit').onclick = () => $('nastaveni').classList.add('hide');
$('nastaveniZavrit').onclick = () => $('nastaveni').classList.add('hide');
// Zavírá se jen tlačítky: klepnutí vedle okna ani Enter v poli okno nezavřou, uloží jen tlačítko Uložit.
$('hlForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const pole = [...$('hlForm').querySelectorAll('input')]; const i = pole.indexOf(e.target); (pole[i + 1] || $('hlForm').querySelector('button[type=submit]')).focus(); } });
$('hlForm').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); $('nastaveni').classList.add('hide'); } });
$('zdrojNastaveni').querySelectorAll('button').forEach((b) => { b.onclick = () => nastavZdroj(b.dataset.z); });
$('hlForm').onsubmit = async (e) => {
  e.preventDefault();
  const p = {}; for (const k of HL_POLE) p[k] = k === 'nahravkyDisk' ? hlPole(k).checked : (k === 'eskalaceMin' || k === 'nahravkaS' || k === 'nahravkaPredS' || k === 'nahravkyDny' || k === 'nahravkyGB') ? Number(hlPole(k).value) : hlPole(k).value.trim();
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
  const PRIKLADY = ['Jak požádat rodinu o plný obraz?', 'Kdy můžu použít nouzový přístup?', 'Jak založit účet rodině?', 'Jak založit mobilního dispečera?', 'Jak nastavit čísla SOS náramku?', 'Komu jde SMS a e-mail při události?', 'Proč nevidím obraz z kamery?', 'Co dělá tlačítko Převzít?'];
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
/* Barevné schéma dispečinku: volba jen v tomhle prohlížeči (localStorage), html[data-schema] + proměnné v proto.css;
 * hlavička stránky ho nastaví ještě před načtením CSS, aby neprobliklo výchozí. Rodina schéma nemá (tmavě modrá). */
const SCHEMA_KEY = 'famicura.dispecink.schema';
const SCHEMATA = [
  { id: '', nazev: 'Modrá (výchozí)', s1: '#1f6fc2', s2: '#3a8ee0' },
  { id: 'tyrkys', nazev: 'Tyrkysová', s1: '#0f8a8a', s2: '#2bb3b1' },
  { id: 'zelena', nazev: 'Zelená', s1: '#2e8b57', s2: '#4caf7a' },
  { id: 'fialova', nazev: 'Fialová', s1: '#5b4bd6', s2: '#8a7cf0' },
  { id: 'oranzova', nazev: 'Oranžová', s1: '#c9661a', s2: '#e8873b' },
  { id: 'grafit', nazev: 'Grafitová', s1: '#3a4451', s2: '#5c6b7a' },
  { id: 'tmava', nazev: 'Tmavě modrá (jako rodina)', s1: '#0d4a75', s2: '#1b6bb8' },
];
function schemaAktualni() { try { return localStorage.getItem(SCHEMA_KEY) || ''; } catch { return ''; } }
function nastavSchema(id) {
  if (!SCHEMATA.some((x) => x.id === id)) id = '';
  if (id) document.documentElement.dataset.schema = id; else delete document.documentElement.dataset.schema;
  try { if (id) localStorage.setItem(SCHEMA_KEY, id); else localStorage.removeItem(SCHEMA_KEY); } catch { /* bez paměti prohlížeče */ }
  const sch = SCHEMATA.find((x) => x.id === id); document.querySelector('meta[name=theme-color]')?.setAttribute('content', sch ? sch.s1 : '#1F6FC2');
  kresliSchemata();
}
function kresliSchemata() {
  const box = $('schemata'); if (!box) return;
  const akt = schemaAktualni();
  if (setHtml(box, SCHEMATA.map((x) => `<button type="button" data-s="${x.id}" aria-pressed="${x.id === akt}" title="${esc(x.nazev)}"><i style="--s1:${x.s1};--s2:${x.s2}"></i>${esc(x.nazev)}</button>`).join(''))) {
    box.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => nastavSchema(b.dataset.s); });
  }
}
kresliSchemata();

const OVL_KEY = 'famicura.dispecink.skel';
let overlay = (() => { try { return localStorage.getItem(OVL_KEY) !== '0'; } catch { return true; } })();   // drátěný model přes plný/rozostřený obraz v detailu: výchozí zapnuto, volba se pamatuje v prohlížeči
function ulozOverlay(v) { overlay = v; try { localStorage.setItem(OVL_KEY, v ? '1' : '0'); } catch { /* bez paměti prohlížeče */ } }
let askOpen = false, emergOpen = false;   // inline forms in the detail
let dtab = 'monitoring';            // sekce detailu: monitoring | komunikace | nastaveni (zůstává při přepnutí kamery)
const seen = new Set(sim.state.events.map((e) => e.id));
const tileRegs = new Map();          // patientId → unregister
let detailUnreg = null;

/* Bez přihlášení se přihlašuje rovnou tady (heslo Famicura), ne oklikou přes
 * hlavní aplikaci. Po přihlášení se stránka načte znovu: obraz, stav ze
 * serveru i účty rodiny už jdou s cookie. */
/* Server stránku pošle jen přihlášenému dispečerovi tenanta (jinak přihlašovací
 * stránku); tady se jen zjistí, kdo to je a jaké má kamery. Když mezitím
 * přihlášení vypršelo, brána nabídne nové načtení (server pak dá přihlášení). */
// Dlaždice, fronta a detail se kreslí až se stavem poskytovatele ze serveru (ne z místní ukázky před načtením).
let zobrazuj = false;
const pripraveno = (async () => {
  try { const r = await fetch('/api/rodina/ja', { cache: 'no-store' }); if (r.ok) JA = await r.json(); } catch { /* server away */ }
  if (JA && (JA.role === 'dispecer' || (JA.role === 'admin' && JA.tenant))) {
    // Data poskytovatele drží server; bez nich dispečink neběží (žádná místní ukázka s fiktivními pacienty).
    if (!(await sim.pripojit())) {
      $('gateSub').textContent = `Data poskytovatele se nepodařilo načíst ze serveru: ${sim.chybaServeru || 'server neodpovídá'}. Zkuste obnovit stránku; když to trvá, ozvěte se správci serveru (pm2 logs famicura-tapo).`;
      $('gate').classList.remove('hide');
      return false;
    }
    document.body.classList.remove('pending');
    for (const k of JA.kamery || []) await sim.ensurePatient({ id: k.id, name: k.name });
    zobrazuj = true;
    renderHlavicka(); renderTiles(); renderQueue(); renderDetail();
    return true;
  }
  if (JA && JA.role === 'rodina') $('gateSub').textContent = 'Jste přihlášen(a) jako rodina. Dispečink je jen pro dispečery poskytovatele.';
  $('gate').classList.remove('hide');
  return false;
})();
$('odhlasit').onclick = async () => { await fetch('/api/rodina/odhlaseni', { method: 'POST' }).catch(() => {}); location.reload(); };

/* Obraz: každá kamera svůj zdroj (WebRTC, náhradně HTTPS), založený až když ji
 * stránka poprvé kreslí. Lišta nahoře a poznámka v záhlaví sledují první kameru. */
const zdroje = new Map();
function zdrojPro(deviceId) {
  let z = zdroje.get(deviceId);
  if (!z) { z = createSource({ deviceId }); zdroje.set(deviceId, z); z.connect(); }
  return z;
}
const prvniKamera = () => (JA?.kamery?.[0]?.id) || (sim.naServeru ? null : (sim.state.patients.find((p) => p.real)?.id || 'tapoc2020'));
const bezKamery = () => `Tento poskytovatel zatím nemá přiřazenou žádnou kameru. Správce serveru ji přiřadí příkazem ./deploy/vps-kamera.sh tenant ID_KAMERY ${JA?.tenant?.id || 'ID_TENANTA'} "Místo".`;
let srcHlavni = null;
pripraveno.then((ok) => {
  if (!ok) return;
  if (!prvniKamera()) { $('srcNote').textContent = 'obraz: žádná kamera přiřazená'; mountAuthBanner(null); return; }
  srcHlavni = zdrojPro(prvniKamera());
  window.__zdroj = srcHlavni;
  mountAuthBanner(srcHlavni);
  srcHlavni.onChange((s) => { $('srcNote').textContent = s.status === 'live' ? (s.path === 'https' ? `obraz: skutečná kamera (HTTPS${s.zpozdeni > 1 ? ', ' + s.zpozdeni + ' s pozadu' : ''})` : 'obraz: skutečná kamera (živě)') : s.status === 'connecting' ? 'obraz: připojuji…' : 'obraz: náhradní scéna'; });
  if (!sim.naServeru) sim.startRealEvents(prvniKamera());
});
/* Přepínač zdroje: „Jen skutečné kamery“ ukáže jen kamery připojené k serveru
 * (pacient s real: true), „Demo“ i fiktivní pacienty. Volba je na tomhle
 * zařízení (localStorage), stav simulace zůstává společný; ?zdroj=demo|real ji přepne. */
const ZDROJ_KEY = 'famicura.proto.zdroj';
const zParam = new URLSearchParams(location.search).get('zdroj');
let zdroj = ['real', 'demo'].includes(zParam) ? zParam : (localStorage.getItem(ZDROJ_KEY) === 'demo' ? 'demo' : 'real');
const visible = (p) => zdroj === 'demo' || !!p.real;
// Se stavem na serveru (data tenanta) jsou všechny kamery skutečné: přepínač Demo nemá co ukázat.
pripraveno.then((ok) => { if (ok && sim.naServeru) { $('zdroj').classList.add('hide'); $('zdrojNastaveni').closest('.fld').classList.add('hide'); } });
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
if (rezim && ['full', 'blur', 'skeleton', 'none'].includes(rezim)) pripraveno.then(() => { const id = prvniKamera(); if (!id) return; sim.setConsent(id, { den: rezim, noc: rezim }); selected = id; renderDetail(true); renderTiles(); });

/** What the tile of this patient may draw. */
function tileMode(pid) {
  if (sim.patient(pid)?.deaktivace) return 'deaktivace';
  const m = sim.effectiveMode(pid);
  if (m === 'offline') return 'none';
  return m;
}
const MODE_TAG = { none: 'bez obrazu', skeleton: 'drátěný model', blur: 'rozostření', full: 'plný obraz', deaktivace: '⏻ deaktivovaná rodinou' };
/** Tlačítko drátěného modelu v detailu: stav zapnuto/vypnuto, mimo plný a rozostřený obraz nejde použít. */
function kresliOvl(d, mode = null) {
  const b = d.querySelector('#ovl'); if (!b) return;
  if (mode !== null) b.disabled = !(mode === 'full' || mode === 'blur');
  b.setAttribute('aria-pressed', overlay ? 'true' : 'false'); b.className = overlay ? 'sm' : 'sm sec';
  b.textContent = `🦴 Drátěný model přes obraz: ${overlay ? 'zapnuto' : 'vypnuto'}`;
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
  if (!zobrazuj) return;
  const s = sim.state;
  const only = $('onlyOpen').checked;
  const list = s.patients.filter(visible).filter((p) => !only || openAlerts(p.id).length || p.offline);
  const order = { crit: 0, warn: 1, off: 2, klid: 3 };
  // the real camera first, always; the rest by how urgent they are
  list.sort((a, b) => (b.real ? 1 : 0) - (a.real ? 1 : 0) || order[statusOf(a)] - order[statusOf(b)]);
  const box = $('tiles');
  box.dataset.pocet = String(Math.min(list.length, 5));   // velikost dlaždic podle počtu kamer (proto.css)
  // keep canvases: rebuild only when the set or order changed
  const key = list.map((p) => p.id).join(',');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    for (const u of tileRegs.values()) u();
    tileRegs.clear();
    if (!list.length && sim.naServeru && !s.patients.length) { box.innerHTML = `<p class="muted bezkamery">${esc(bezKamery())}</p>`; return; }
    box.innerHTML = list.map((p) => `<div class="tile" data-id="${p.id}"><div class="stage"><canvas></canvas><span class="tag"></span></div><div class="nm"><span>${esc(p.name)}</span><span class="badge st-badge"></span></div><div class="st"></div></div>`).join('');
    box.querySelectorAll('.tile').forEach((t) => {
      const pid = t.dataset.id;
      tileRegs.set(pid, zdrojPro(pid).register(t.querySelector('canvas'), () => tileMode(pid)));
      t.onclick = () => { selected = pid; askOpen = emergOpen = false; panel.select(pid); renderDetail(true); renderTiles(); };
    });
  }
  box.querySelectorAll('.tile').forEach((t) => {
    const p = sim.patient(t.dataset.id); const st = statusOf(p);
    // kamera deaktivovaná rodinou: obraz se odpojí (server ho stejně nedá), po aktivaci se připojí znovu
    const z = zdroje.get(p.id);
    if (z) { if (p.deaktivace && !z.deakt) { z.deakt = true; z.odpoj('kamera deaktivovaná rodinou'); } else if (!p.deaktivace && z.deakt) { z.deakt = false; z.connect(); } }
    t.className = 'tile ' + st + (selected === p.id ? ' sel' : '') + (p.deaktivace ? ' deakt' : '');
    t.querySelector('.tag').textContent = p.deaktivace ? MODE_TAG.deaktivace : p.offline ? 'kamera nedostupná' : MODE_TAG[tileMode(p.id)] || '';
    const b = t.querySelector('.st-badge'); b.textContent = { crit: 'kritické', warn: 'varování', off: 'offline', klid: 'klid' }[st]; b.className = 'badge st-badge ' + (st === 'klid' ? 'ok' : st === 'off' ? 'tech' : st);
    const last = s.events.find((e) => e.patientId === p.id && e.kind !== 'consent' && e.kind !== 'poznamka');
    t.querySelector('.st').textContent = (p.naramek?.vypnuto ? '⏻ náramek vypnutý · ' : '') + (last ? `${eventText(last)} · před ${ago(last.at)}` : 'bez událostí');
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

async function uzavritVse(patientId, pocet) {
  const kam = patientId ? `u kamery ${esc(sim.patient(patientId)?.name || '')}` : 'u všech kamer';
  const vysledek = prompt(`Uzavřít ${pocet} otevřených alertů ${kam.replace(/<[^>]+>/g, '')}? Napište výsledek (zapíše se ke každému):`, 'planý poplach');
  if (vysledek === null) return;
  const r = await sim.closeAll(patientId || '', ME(), vysledek.trim() || 'hromadně uzavřeno');
  toast(`Uzavřeno ${r?.pocet ?? pocet} alertů.`);
}
$('queueVse')?.addEventListener('click', () => { const n = sim.state.events.filter((e) => e.state !== 'uzavřen' && KINDS[e.kind] && KINDS[e.kind].level !== 'info' && visible(sim.patient(e.patientId) || {})).length; uzavritVse('', n); });
function renderQueue() {
  if (!zobrazuj) return;
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
      <div class="small">${escOdkazy(eventText(e))}${e.real ? ' <span class="badge ok">skutečná</span>' : ''} · <em>${esc(e.state)}</em>${e.by ? ' – ' + esc(e.by) : ''}${e.escalated ? ' · <span class="esc">eskalováno</span>' : ''}</div>
      <div class="row">${btn}<button class="sm sec" data-open="${e.patientId}">Otevřít</button></div></li>`;
  }).join('') || '<li class="muted">Žádný otevřený alert. Klid.</li>';
  // hromadné uzavření: tlačítko v hlavičce fronty (jen když je co uzavřít)
  const hlava = $('queueVse'); if (hlava) { hlava.classList.toggle('hide', !items.length); hlava.textContent = `✓ Uzavřít vše (${items.length})`; }
  if (setHtml($('queue'), queueHtml)) bindQueueButtons($('queue'));
  refreshAgo($('queue'));
}

function renderDetail(rebuild = false) {
  if (!zobrazuj) return;
  const d = $('detail');
  if (!selected) { d.classList.add('hide'); return; }
  const p = sim.patient(selected); if (!p) return;
  d.classList.remove('hide');
  if (rebuild || !d.querySelector('canvas')) {
    detailUnreg?.(); 
    const kon = kontaktyPro(p);
    d.innerHTML = `<div class="row"><h2 class="grow">${esc(p.name)} <span class="muted small">${esc(p.place)}</span></h2><button class="sm sec" id="closeD">Zavřít</button></div>
      <div class="dtabsSk" id="dtabs" role="tablist">
        <div class="skupina zobrazeni"><span class="sklabel">Sledování – co se děje</span><div class="seg dtabs"><button type="button" data-t="monitoring" role="tab">👁 Monitoring</button><button type="button" data-t="naramek" role="tab">⌚ Náramek<span class="badge crit hide" id="dtabVyp" title="náramek je vypnutý">⏻ vypnutý</span></button></div></div>
        <div class="skupina chovani"><span class="sklabel">Nastavení – jak se má chovat</span><div class="seg dtabs"><button type="button" data-t="komunikace" role="tab">💬 Komunikace a kontakty</button><button type="button" data-t="nastaveni" role="tab">⚙ Nastavení alertů</button></div></div>
      </div>
      <section class="dsec" data-sec="monitoring">
        <div class="blok"><h3>Obraz z kamery</h3>
        <div class="stage"><canvas id="dcv"></canvas><span class="tag" id="dtag"></span>${p.real && sim.naServeru ? `<div class="ptz" id="dptz" title="otočení kamery (Tapo pan/tilt)"><button type="button" data-ptz="up" aria-label="nahoru">▲</button><button type="button" data-ptz="left" aria-label="doleva">◀</button><button type="button" data-ptz="home" aria-label="výchozí poloha">⌂</button><button type="button" data-ptz="right" aria-label="doprava">▶</button><button type="button" data-ptz="down" aria-label="dolů">▼</button></div>` : ''}</div>
        <div class="modebar"><span class="small" id="dmode"></span><button type="button" class="sm" id="ovl" aria-pressed="true" title="kostra postavy spočítaná v prohlížeči přes plný nebo rozostřený obraz (model MediaPipe); nezapisuje se, jen zobrazení">🦴 Drátěný model přes obraz: zapnuto</button></div>
        <div class="akce" id="dbtn"></div>
        </div><div class="blok"><h3>Přidat poznámku</h3><p class="small muted">– datum, čas a jméno se doplní samy; jde do logu kamery, rodina ji nevidí</p>
        <div class="notes"><textarea id="dnote" maxlength="1000" placeholder="Např. Volala dcera, klient v pořádku, kontrola zítra ráno."></textarea><div class="akce"><button class="sm" id="dnoteAdd">Přidat poznámku</button><span class="small muted" id="dnoteKdo"></span></div></div>
        </div><div class="blok"><h3>Historie</h3><p class="small muted">– události, souhlasy, poznámky; 📱 ✉ = odeslaná upozornění, 🎞 = nahrávka (na serveru nebo na Google Disku)</p>
        <div class="chips" id="dlogFiltr" role="group" aria-label="typ událostí">${[['all', 'Vše'], ['crit', 'Kritické'], ['warn', 'Varování'], ['kamera', 'Kamera'], ['analýza', 'Analýza'], ['nahravka', '🎞 S nahrávkou'], ['upozorneni', '📱✉ S upozorněním'], ['consent', 'Souhlasy'], ['poznamka', 'Poznámky']].map(([f, t]) => `<button type="button" class="chip" data-f="${f}" aria-pressed="${f === dfiltr}">${t}</button>`).join('')}</div>
        <div class="akce" id="dlogAkce"><label class="small">od <input type="date" id="dlogOd"></label><label class="small">do <input type="date" id="dlogDo"></label><label class="small"><input type="checkbox" id="dlogVse"> všechny kamery</label><button type="button" class="sm sec" id="dlogZobraz">Zobrazit období</button><button type="button" class="sm sec hide" id="dlogZive">Zpět na posledních 12</button><button type="button" class="sm" id="dlogExcel" title="stáhne události za zvolené období (bez období: všechny) jako sešit Excelu">⬇ Stáhnout do Excelu</button><span class="small muted" id="dlogStav"></span></div><ul class="list" id="dhist"></ul>
        </div><div class="blok"><h3>Nahrávky</h3><p class="small muted">– na serveru (▶ přehrát v aplikaci) nebo na Google Disku poskytovatele podle Nastavení; nahrává server po události se zatrženým Nahrávat a tlačítkem Nahrát teď</p><ul class="list" id="dnahravky"><li class="muted">Načítám…</li></ul>
      </div></section>
      <section class="dsec hide" data-sec="komunikace">
        <div class="blok"><h3>Klient a poskytovatel</h3>
        <div class="kv"><dt>Poskytovatel</dt><dd>${esc(sim.poskytovatelPro(p))}${p.real && sim.poskytovatel.telefon ? ' · ' + esc(sim.poskytovatel.telefon) : ''}</dd><dt>Poznámka ke klientovi</dt><dd><span id="dtrvala"></span> <button class="sm sec" id="dtrvalaEdit">Upravit</button>
          <div class="notes hide" id="dtrvalaForm"><textarea id="dtrvalaText" maxlength="300" placeholder="Trvalá informace o klientovi: zdravotní stav, na co dát pozor, co dělat při alertu."></textarea><div class="row"><button class="sm" id="dtrvalaSave">Uložit</button><button class="sm sec" id="dtrvalaCancel">Zrušit</button><span class="small muted">Zapisuje poskytovatel, vidí všichni dispečeři, změna jde do logu kamery. Rodina ji nevidí.</span></div></div></dd></div>
        </div><div class="blok"><h3>Uživatelé rodiny</h3><p class="small muted">– kdo smí otevřít aplikaci rodiny k téhle kameře</p>
        <div id="dusers"></div>
        </div><div class="blok"><h3>Kontakty pro upozornění</h3><p class="small muted">– Rodina: až pět lidí (jméno a mobil na SMS). Poskytovatel: telefon dispečinku, služby a administrace (společné pro všechny kamery) – vlastní číslo, nebo z Péče doma / Péče doma plus. E-maily: dvě sady oddělené čárkou. Kdo dostane kterou událost, se vybírá v Nastavení kamery; čísla SOS náramku se vybírají z těchto kontaktů.</p>
        <form class="kontakty" id="dkontakty">
          <fieldset class="ksekce"><legend>Rodina</legend>
          <div class="kgrid krodina">${Array.from({ length: KONTAKTY_RODINA_MAX }, (_, i) => `<label>Rodina ${i + 1} – jméno<input type="text" class="kjmeno" data-i="${i}" maxlength="40" placeholder="dcera Eva" value="${esc(kon.rodina[i]?.jmeno || '')}"></label><label>telefon<input type="tel" class="ksms" data-i="${i}" maxlength="20" placeholder="777 123 456" value="${esc(kon.rodina[i]?.telefon ? formatTelefon(kon.rodina[i].telefon) : '')}"></label>`).join('')}</div>
          </fieldset>
          <fieldset class="ksekce"><legend>Poskytovatel <span class="muted">(společné pro všechny kamery)</span></legend>
          <div class="kgrid kposk">${ROLE_POSKYTOVATELE.map((r) => { const tp = telefonyPoskytovatele(sim.state)[r]; return `<label>Telefon – ${esc(POPIS_ROLE[r])}<select class="kpzdroj" data-r="${r}">${ZDROJE_TELEFONU.map((z) => `<option value="${z}"${tp.zdroj === z ? ' selected' : ''}>${esc(POPIS_ZDROJE_TELEFONU[z])}</option>`).join('')}</select></label><label class="kptelL${tp.zdroj === 'pecedoma' ? ' kneviditelne' : ''}" data-r="${r}">${tp.zdroj === 'pecedomaplus' ? 'číslo v Péče doma plus' : 'vlastní číslo'}<input type="tel" class="kptel" data-r="${r}" maxlength="20" placeholder="777 123 456" value="${esc(tp.telefon ? formatTelefon(tp.telefon) : '')}"></label><span class="small kpnahled" data-r="${r}"></span>`; }).join('')}</div>
          <p class="small muted" id="dkontaktyPosk">– Péče doma = kontaktní telefon poskytovatele v databázi Péče doma (bez tenanta, jedno číslo pro všechny tři); Péče doma plus = telefon v nastavení tohoto tenanta, zadáte ho tady a uloží se do Péče doma plus. Číslo z Péče doma (plus) dosadí server při každé události i do náramku a při změně ho pošle znovu.</p>
          </fieldset>
          <fieldset class="ksekce"><legend>E-maily</legend>
          <div class="kgrid kmaily"><label>Sada 1 (adresy oddělené čárkou)<input type="text" class="kmaily" data-s="1" maxlength="600" placeholder="dcera@example.cz, syn@example.cz" value="${esc(kon.maily1.join(', '))}"></label><label>Sada 2 (adresy oddělené čárkou)<input type="text" class="kmaily" data-s="2" maxlength="600" placeholder="lekar@example.cz" value="${esc(kon.maily2.join(', '))}"></label></div>
          </fieldset>
          <div class="akce"><button class="sm" type="submit">Uložit kontakty</button><span class="small muted" id="dkontaktyStav"></span></div>
          <p class="small bad hide" id="dkontaktyErr"></p>
        </form>
        </div><div class="blok"><h3>Poznámky dispečinku</h3><p class="small muted">– přehled všech poznámek k této kameře, nejnovější nahoře; novou přidáte v Monitoringu</p>
        <div class="notes"><ul id="dnotes"></ul></div>
      </div></section>
      <section class="dsec hide" data-sec="naramek">
        <div class="blok"><h3>Stav náramku</h3><p class="small muted">– poslední ozvání, baterie a poloha (GPS, nebo přibližná z mobilní sítě)</p>
        <div class="naramekVyp hide" id="dnaramekVyp"></div>
        <p id="dnaramekInfo"></p>
        <div class="mapagraf"><div class="mapa hide" id="dnaramekMapa"></div><div class="grafy" id="dnaramekGraf"></div></div>
        </div><div class="blok"><h3>Měření zdraví</h3><p class="small muted">– tep, krevní tlak, kyslík v krvi a teplota; měření spouští náramek sám nebo jeho aplikace, hodnoty posílá na server</p>
        <div class="akce"><label class="small">na stránku <select id="dnaramekNa">${[10, 20, 50, 100].map((v) => `<option value="${v}">${v}</option>`).join('')}</select></label><button type="button" class="sm sec" id="dnaramekPrev">‹ novější</button><span class="small muted" id="dnaramekStrana"></span><button type="button" class="sm sec" id="dnaramekNext">starší ›</button><button type="button" class="sm sec" id="dnaramekExcel">Stáhnout do Excelu</button></div>
        <div id="dnaramekMereni"></div>
        </div><div class="blok"><h3>Poplachy z náramku</h3><p class="small muted">– nouzové tlačítko, pád a slabá baterie; vyřizují se ve frontě alertů jako ostatní události</p>
        <ul class="list" id="dnaramekPoplachy"></ul>
        </div><div class="blok"><h3>Ovládání a nastavení náramku</h3><p class="small muted">– příkazy do náramku, automatické měření a čísla, která náramek po stisku SOS volá</p>
        <div class="akce"><button type="button" class="sm" data-nprikaz="zdravi">Změřit zdraví (tep, tlak, kyslík, teplotu)</button><button type="button" class="sm sec" data-nprikaz="poloha">Zjistit polohu</button><button type="button" class="sm bad" data-nprikaz="vypnout">Vypnout náramek</button><span class="small muted" id="dnaramekPrikazStav"></span></div>
        <form class="kontakty" id="dnaramekAuto"><div class="akce"><label class="small">automaticky každých <input type="number" id="dnaramekAutoMin" min="0" max="1440" style="width:70px" value="${Number(p.naramek?.auto?.min) || 0}"> min:</label><label class="small"><input type="checkbox" class="nauto" data-k="zdravi" ${p.naramek?.auto?.zdravi || p.naramek?.auto?.tlak || p.naramek?.auto?.tep || p.naramek?.auto?.kyslik || p.naramek?.auto?.teplota ? 'checked' : ''}> měřit zdraví (tep, tlak, kyslík, teplota)</label><button class="sm" type="submit">Uložit</button><span class="small muted" id="dnaramekAutoStav"></span></div></form>
        <form class="kontakty" id="dnaramekSos"><div class="kgrid">${[0, 1, 2].map((i) => `<label>SOS ${i + 1}. číslo<select class="nsos" data-i="${i}">${volbySos(p, p.naramek?.sos?.[i] || '')}</select></label>`).join('')}</div>
          <div class="akce"><button class="sm" type="submit">Uložit čísla SOS a poslat do náramku</button><span class="small muted" id="dnaramekSosStav"></span></div>
          <p class="small" id="dnaramekVola"></p>
          <div class="small muted" id="dnaramekSluzba"></div>
          <p class="small muted">– čísla, která náramek po stisku SOS postupně volá (a posílá jim SMS); pořadí 1 → 2 → 3, prázdná volba číslo smaže. Vybírá se z Kontaktů kamery (Komunikace): lidé z rodiny s mobilem a telefony poskytovatele (dispečink, služba, administrace); číslo z Péče doma (plus) dosadí server sám a při změně kontaktu nebo čísla je do náramku pošle znovu (do 10 minut)</p></form>
        </div><div class="blok"><h3>Přiřazení náramku</h3><p class="small muted">– ID zařízení z aplikace náramku (ReachFar V48: O zařízení → ID zařízení); náramek musí mít nastavenou adresu našeho serveru (Nápověda → Náramek)</p>
        <form class="kontakty" id="dnaramek">
          <div class="kgrid"><label>ID zařízení<input type="text" id="dnaramekId" maxlength="20" placeholder="9705357211" value="${esc(p.naramek?.id || '')}"></label></div>
          <div class="akce"><button class="sm" type="submit">Uložit</button><span class="small muted" id="dnaramekStav"></span></div>
          <p class="small bad hide" id="dnaramekErr"></p>
        </form>
      </div></section>
      <section class="dsec hide" data-sec="nastaveni">
        <div class="blok"><h3>Sledování, nahrávání a upozornění</h3><p class="small muted">– nastavuje poskytovatel, rodina to vidí; ve sloupcích SMS komu a E-mail komu zatrhněte příjemce z Kontaktů (Komunikace) a telefony poskytovatele (⚙ Nastavení)</p>
        <table class="watch"><thead><tr><th>Událost</th><th>Hlídat</th><th>Jen v hodinách</th><th>Nahrávat</th><th>SMS komu</th><th>E-mail komu</th></tr></thead><tbody id="dwatch">${WATCH_KINDS.map((k) => `<tr data-k="${k}"><td>${esc(KINDS[k].label)} <span class="badge ${KINDS[k].level}">${esc(KINDS[k].source)}</span></td><td><input type="checkbox" class="on"></td><td class="hod"><div class="okno"><input type="time" class="from"> – <input type="time" class="to"> <button type="button" class="sm sec okno-dalsi" title="přidat další časové okno (až tři, např. 07:00–08:00, 12:00–13:00, 19:00–20:00)">+</button></div><div class="okno hide"><input type="time" class="from2"> – <input type="time" class="to2"></div><div class="okno hide"><input type="time" class="from3"> – <input type="time" class="to3"></div></td><td><input type="checkbox" class="rec"></td><td class="prij" data-t="sms"></td><td class="prij" data-t="mail"></td></tr>`).join('')}</tbody></table>
        <p class="small muted" id="dwatchPozn"></p>
      </div></section>`;
    detailUnreg = zdrojPro(p.id).register(d.querySelector('#dcv'), () => detailMode(selected));
    const tabs = d.querySelector('#dtabs');
    const ukazTab = (t) => { dtab = t; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t))); d.querySelectorAll('.dsec').forEach((sec) => sec.classList.toggle('hide', sec.dataset.sec !== t)); };
    tabs.querySelectorAll('button').forEach((b) => { b.onclick = () => ukazTab(b.dataset.t); });
    ukazTab(dtab);
    // příjemci upozornění: rodina (Kontakty), dispečink a služba (⚙ Nastavení) pro SMS; sada 1 / sada 2 pro e-mail
    const volbyPrijemcu = (pp) => {
      const kk = kontaktyPro(pp), rod = rodinaSTelefonem(pp), tp = telefonyPoskytovatele(sim.state);
      const sms = [...rod.map((r) => ({ id: r.id, text: r.jmeno || formatTelefon(r.telefon), title: 'SMS ' + popisPrijemce(r) })),
        ...ROLE_POSKYTOVATELE.filter((r) => tp[r].telefon || tp[r].zdroj !== 'vlastni').map((r) => ({ id: r, text: POPIS_ROLE[r], title: tp[r].telefon ? `SMS na telefon (${POPIS_ROLE[r]}) ${formatTelefon(tp[r].telefon)} (Kontakty → Poskytovatel)` : `SMS na telefon (${POPIS_ROLE[r]}) z ${POPIS_ZDROJE_TELEFONU[tp[r].zdroj]} (dosadí server)` }))];
      const mail = [...(kk.maily1.length ? [{ id: 's1', text: 'sada 1', title: kk.maily1.join(', ') }] : []), ...(kk.maily2.length ? [{ id: 's2', text: 'sada 2', title: kk.maily2.join(', ') }] : [])];
      return { sms, mail };
    };
    const naplnWatch = () => {
      const pp = sim.patient(p.id) || p, volby = volbyPrijemcu(pp);
      const chips = (seznam, ids, t) => seznam.length ? seznam.map((v) => `<label class="chip pr" title="${esc(v.title)}"><input type="checkbox" data-t="${t}" data-id="${v.id}"${ids.includes(v.id) ? ' checked' : ''}> ${esc(v.text)}</label>`).join('') : '<span class="muted small">–</span>';
      d.querySelectorAll('#dwatch tr').forEach((tr) => {
        const k = tr.dataset.k, w = pp.watch?.[k] || { on: true, from: '', to: '', rec: false };
        if (document.activeElement && tr.contains(document.activeElement)) return;
        tr.querySelector('.on').checked = w.on; tr.querySelector('.from').value = w.from; tr.querySelector('.to').value = w.to; tr.querySelector('.rec').checked = w.rec;
        for (const n of [2, 3]) { const f = tr.querySelector('.from' + n), t = tr.querySelector('.to' + n); f.value = w['from' + n] || ''; t.value = w['to' + n] || ''; if (f.value || t.value) f.closest('.okno').classList.remove('hide'); }
        setHtml(tr.querySelector('.prij[data-t="sms"]'), chips(volby.sms, smsIdsPro(w, k, pp), 'sms'));
        setHtml(tr.querySelector('.prij[data-t="mail"]'), chips(volby.mail, mailIdsPro(w, k), 'mail'));
      });
      d.querySelector('#dwatchPozn').textContent = volby.sms.length || volby.mail.length
        ? `Příjemci: ${describeKontakty(pp) || 'bez kontaktů rodiny'}${volby.sms.some((v) => ROLE_POSKYTOVATELE.includes(v.id)) ? ' · telefony poskytovatele: ' + volby.sms.filter((v) => ROLE_POSKYTOVATELE.includes(v.id)).map((v) => v.title.replace(/^SMS na /, '').replace(/ \(Kontakty → Poskytovatel\)$/, '')).join(', ') : ''}. Zatržení platí pro události, které projdou sloupcem Hlídat a hodinami.`
        : 'Nejsou zadané žádné kontakty: vyplňte rodinu, telefony poskytovatele a e-maily v Komunikaci → Kontakty.';
    };
    naplnWatch();
    d.querySelectorAll('#dwatch tr').forEach((tr) => {
      const k = tr.dataset.k;
      const push = () => {
        const volby = volbyPrijemcu(sim.patient(p.id) || p);
        const ids = (t) => [...tr.querySelectorAll(`.prij input[data-t="${t}"]:checked`)].map((i) => i.dataset.id);
        const patch = { on: tr.querySelector('.on').checked, from: tr.querySelector('.from').value, to: tr.querySelector('.to').value, from2: tr.querySelector('.from2').value, to2: tr.querySelector('.to2').value, from3: tr.querySelector('.from3').value, to3: tr.querySelector('.to3').value, rec: tr.querySelector('.rec').checked };
        if (volby.sms.length) patch.sms = ids('sms');   // bez nabídky se uložená volba nechává (starší true = celá rodina, až bude vyplněná)
        if (volby.mail.length) patch.mail = ids('mail');
        return sim.setWatch(p.id, k, patch);
      };
      tr.addEventListener('change', push);
      // + odkryje další okno (druhé, pak třetí); okna se zapisují jen vyplněná celá
      tr.querySelector('.okno-dalsi').onclick = () => { const skryta = [...tr.querySelectorAll('.okno.hide')]; if (skryta.length) { skryta[0].classList.remove('hide'); skryta[0].querySelector('input').focus(); } if (skryta.length <= 1) tr.querySelector('.okno-dalsi').disabled = true; };
    });
    d.querySelector('#closeD').onclick = () => { selected = null; renderDetail(); renderTiles(); };
    renderUzivatele(p);
    const kf = d.querySelector('#dkontakty');
    kf.onsubmit = async (e) => {
      e.preventDefault();
      const err = kf.querySelector('#dkontaktyErr'); err.classList.add('hide');
      const rodina = Array.from({ length: KONTAKTY_RODINA_MAX }, (_, i) => ({ jmeno: kf.querySelector(`.kjmeno[data-i="${i}"]`).value.trim(), telefon: kf.querySelector(`.ksms[data-i="${i}"]`).value.trim() }));
      const maily1 = kf.querySelector('.kmaily[data-s="1"]').value, maily2 = kf.querySelector('.kmaily[data-s="2"]').value;
      const spatne = rodina.find((r) => r.telefon && !normalizeTelefonCz(r.telefon)), bezTel = rodina.find((r) => r.jmeno && !r.telefon), spatnyMail = [...rozdelMaily(maily1), ...rozdelMaily(maily2)].find((m) => !jeEmail(m));
      if (spatne || bezTel || spatnyMail) { err.textContent = spatne ? `„${spatne.telefon}“ není český mobil (9 číslic).` : bezTel ? `U jména „${bezTel.jmeno}“ chybí telefon.` : `„${spatnyMail}“ není platná e-mailová adresa.`; err.classList.remove('hide'); return; }
      // telefony poskytovatele: zdroj + vlastní číslo do nastavení poskytovatele, číslo pro Péče doma plus do Plus (POST /api/naramek/sluzba-telefon s rolí)
      const posk = {}; const doPlus = [];
      for (const r of ROLE_POSKYTOVATELE) {
        const zdroj = kf.querySelector(`.kpzdroj[data-r="${r}"]`).value, tel = kf.querySelector(`.kptel[data-r="${r}"]`).value.trim();
        posk[POLE_ROLE[r].zdroj] = zdroj;
        if (zdroj === 'vlastni') { if (tel && !normalizeTelefonCz(tel)) { err.textContent = `Telefon (${POPIS_ROLE[r]}) „${tel}“ není české číslo (9 číslic).`; err.classList.remove('hide'); return; } posk[POLE_ROLE[r].telefon] = tel; }
        else if (zdroj === 'pecedomaplus') { const t = mezinarodni(tel); if (t && !/^\+?\d{6,15}$/.test(t)) { err.textContent = `Telefon (${POPIS_ROLE[r]}) „${tel}“: jen číslice, případně + na začátku.`; err.classList.remove('hide'); return; } if (t !== (d.__sluzba?.pecedomaplus?.[r]?.telefon || '')) doPlus.push([r, t]); }
      }
      try {
        const r = await sim.setKontakty(p.id, { rodina, maily1, maily2 }, ME());
        if (r === undefined && sim.naServeru) { err.textContent = 'Uložení se nepodařilo (zkontrolujte čísla a adresy).'; err.classList.remove('hide'); return; }
        const rp = await sim.setPoskytovatel(posk);
        if (rp === undefined && sim.naServeru) { err.textContent = 'Telefony poskytovatele se nepodařilo uložit.'; err.classList.remove('hide'); return; }
        for (const [role, t] of doPlus) { try { d.__sluzba = await post('/api/naramek/sluzba-telefon', { telefon: t, role }); } catch (ex) { err.textContent = `Telefon (${POPIS_ROLE[role]}) do Péče doma plus: ${ex.message}`; err.classList.remove('hide'); } }
        const neco = rodina.some((x) => x.telefon) || rozdelMaily(maily1).length || rozdelMaily(maily2).length;
        toast(neco ? 'Kontakty uloženy. V Nastavení zatrhněte u událostí, kdo je dostane.' : 'Kontakty uloženy.');
        naplnWatch(); kresliPosk(d); kresliSluzbu(d, p); naplnSos(d, p, true);
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); }
    };
    // změna zdroje telefonu poskytovatele: pole pro číslo jen u vlastního čísla a Péče doma plus (tam se ukládá do Plus), náhled hned
    kf.querySelectorAll('.kpzdroj').forEach((sel) => { sel.onchange = () => { const r = sel.dataset.r; const inp = kf.querySelector(`.kptel[data-r="${r}"]`); const z = sel.value; const lab = kf.querySelector(`.kptelL[data-r="${r}"]`); lab.firstChild.textContent = z === 'pecedomaplus' ? 'číslo v Péče doma plus' : 'vlastní číslo'; lab.classList.toggle('kneviditelne', z === 'pecedoma'); inp.value = z === 'pecedomaplus' ? (d.__sluzba?.pecedomaplus?.[r]?.telefon || '') : z === 'vlastni' ? (sim.poskytovatel[POLE_ROLE[r].telefon] || '') : ''; kresliPosk(d); }; });
    kf.querySelectorAll('.kptel').forEach((i) => { i.oninput = () => kresliPosk(d); });
    const nf = d.querySelector('#dnaramek');
    nf.onsubmit = async (e) => {
      e.preventDefault();
      const err = nf.querySelector('#dnaramekErr'); err.classList.add('hide');
      const id = nf.querySelector('#dnaramekId').value.trim();
      if (id && !/^[A-Za-z0-9]{5,20}$/.test(id)) { err.textContent = 'ID zařízení je 5 až 20 písmen a číslic.'; err.classList.remove('hide'); return; }
      try {
        const r = await sim.setNaramek(p.id, id, ME());
        if (r === undefined && sim.naServeru) { err.textContent = 'Uložení se nepodařilo.'; err.classList.remove('hide'); return; }
        toast(id ? `Náramek ${id} přiřazen. Až se ozve, uvidíte tu čas ozvání a baterii.` : 'Náramek odebrán.');
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); }
    };
    // příkazy náramku (změřit, poloha, vypnout, vlastní) a automatické měření
    const nstav = d.querySelector('#dnaramekPrikazStav');
    const poslatPrikaz = async (prikaz, vlastni, heslo) => {
      nstav.textContent = 'posílám…';
      try {
        const r = await post('/api/naramek/prikaz', { kamera: p.id, prikaz, vlastni, heslo });
        nstav.textContent = `odesláno (${r.predtim ? r.predtim + ' + ' : ''}${r.obsah}); výsledky dorazí do minuty`;
        toast(prikaz === 'vypnout' ? 'Příkaz k vypnutí odeslán.' : 'Příkaz odeslán náramku.');
      } catch (e) { nstav.textContent = ''; toast(`Náramek: ${e.message}`, 'crit'); }
    };
    d.querySelectorAll('[data-nprikaz]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.nprikaz !== 'vypnout') return poslatPrikaz(b.dataset.nprikaz);
        // vypnutí: zapne se zase jen tlačítkem na náramku, proto jen na heslo hlavní aplikace (ověřuje server)
        const heslo = prompt('Vypnout náramek? Zapne se zase jen tlačítkem na náramku.\nZadejte heslo hlavní aplikace Famicura:');
        if (heslo === null) return;
        if (!heslo) { toast('Bez hesla hlavní aplikace se náramek nevypne.', 'crit'); return; }
        poslatPrikaz('vypnout', undefined, heslo);
      };
    });
    // měření zdraví: z A_KAM_Mereni (GET /api/naramek/mereni), stránkování 10/20/50/100 (volba v tomhle prohlížeči), export do Excelu
    const mer = d.__mereni = pametMereni((() => { try { return Number(localStorage.getItem(MERENI_NA_KEY)) || 10; } catch { return 10; } })());
    const selNa = d.querySelector('#dnaramekNa'); selNa.value = String([10, 20, 50, 100].includes(mer.na) ? mer.na : 10);
    selNa.onchange = () => { mer.na = Number(selNa.value) || 10; mer.strana = 0; try { localStorage.setItem(MERENI_NA_KEY, String(mer.na)); } catch { /* bez paměti */ } kresliMereni(d); };
    d.querySelector('#dnaramekPrev').onclick = () => { if (mer.strana > 0) { mer.strana--; kresliMereni(d); } };
    d.querySelector('#dnaramekNext').onclick = () => { if ((mer.strana + 1) * mer.na < (mer.radky?.length || 0)) { mer.strana++; kresliMereni(d); } };
    d.querySelector('#dnaramekExcel').onclick = () => {
      if (!sim.naServeru) { toast('Export jde jen se stavem na serveru.', 'crit'); return; }
      const a = document.createElement('a'); a.href = `/api/naramek/mereni?kamera=${encodeURIComponent(p.id)}&format=xlsx`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      toast('Stahuji sešit Excelu s měřením…');
    };
    // rozpracovaná volba SOS se při obnově detailu (každé 2 s) nepřepisuje uloženými čísly, dokud se neuloží
    d.querySelectorAll('.nsos').forEach((sel) => { sel.onchange = () => { d.querySelector('#dnaramekSos').dataset.zmena = '1'; kresliVola(d, p); }; });
    // telefony poskytovatele z Péče doma / Péče doma plus (jednou za otevření detailu; po uložení v Kontaktech se obnoví)
    const nactiSluzbu = () => apiJson('/api/naramek/sluzba-telefon').then((r) => { d.__sluzba = r; kresliSluzbu(d, p); kresliPosk(d); }).catch(() => {});
    if (!d.__sluzbaDotaz && sim.naServeru) { d.__sluzbaDotaz = true; nactiSluzbu(); } else { kresliSluzbu(d, p); kresliPosk(d); }
    d.querySelector('#dnaramekSos').onsubmit = async (e) => {
      e.preventDefault();
      const cisla = [0, 1, 2].map((i) => d.querySelector(`.nsos[data-i="${i}"]`).value);
      const st = d.querySelector('#dnaramekSosStav'); st.textContent = 'ukládám…';
      try {
        const r = await post('/api/naramek/sos', { kamera: p.id, cisla });
        delete d.querySelector('#dnaramekSos').dataset.zmena;
        st.textContent = r.odeslano ? `odesláno do náramku ${fmtDT(Date.now())}${Array.isArray(r.skutecna) ? ': ' + r.skutecna.map((c) => c || '–').join(', ') : ''}` : 'uloženo; do náramku se pošle, až se ozve';
        toast(r.odeslano ? 'Čísla SOS odeslána do náramku.' : 'Čísla SOS uložena, pošlou se při příštím ozvání náramku.');
      } catch (ex) { st.textContent = ''; toast(`Čísla SOS: ${ex.message}`, 'crit'); }
    };
    d.querySelector('#dnaramekAuto').onsubmit = async (e) => {
      e.preventDefault();
      const auto = { min: Number(d.querySelector('#dnaramekAutoMin').value) || 0 };
      d.querySelectorAll('.nauto').forEach((c) => { auto[c.dataset.k] = c.checked; });
      try { const r = await sim.setNaramekAuto(p.id, auto, ME()); if (r === undefined && sim.naServeru) throw new Error('uložení se nepodařilo'); d.querySelector('#dnaramekAutoStav').textContent = auto.min > 0 ? `uloženo: každých ${auto.min} min` : 'vypnuto'; toast(auto.min > 0 ? `Automatické měření každých ${auto.min} min uloženo.` : 'Automatické měření vypnuto.'); }
      catch (ex) { toast(`Nepodařilo se: ${ex.message}`, 'crit'); }
    };
    const ovl = d.querySelector('#ovl'); ovl.onclick = () => { ulozOverlay(!overlay); kresliOvl(d); };
    const tf = d.querySelector('#dtrvalaForm');
    d.querySelector('#dtrvalaEdit').onclick = () => { d.querySelector('#dtrvalaText').value = sim.patient(p.id)?.note || ''; tf.classList.remove('hide'); d.querySelector('#dtrvalaText').focus(); };
    d.querySelector('#dtrvalaCancel').onclick = () => tf.classList.add('hide');
    d.querySelector('#dtrvalaSave').onclick = async () => { await sim.setNote(p.id, d.querySelector('#dtrvalaText').value, ME()); tf.classList.add('hide'); toast('Poznámka ke klientovi uložena.'); };
    const pridej = async () => { const ta = d.querySelector('#dnote'); const t = ta.value.trim(); if (!t) { ta.focus(); return; } ta.disabled = true; await sim.poznamka(p.id, t, ME()); ta.value = ''; ta.disabled = false; ta.focus(); toast('Poznámka zapsána.'); };
    d.querySelector('#dnoteAdd').onclick = pridej;
    d.querySelector('#dnote').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); pridej(); } });
    d.__naplnWatch = naplnWatch;
    ptzOvladani(d.querySelector('#dptz'), p.id);
    dlog = null; historieOvladani(d, p);
  }
  const s = sim.state;
  const mode = tileMode(p.id);
  d.querySelector('#dtag').textContent = MODE_TAG[mode];
  d.querySelector('#dmode').innerHTML = p.deaktivace ? `<strong>Kamera je deaktivovaná rodinou</strong> od ${fmtDT(p.deaktivace.od)} (${esc(p.deaktivace.kdo || 'rodina')}): bez obrazu, nahrávek a událostí, ${p.deaktivace.otoceni === 'ok' ? 'otočená do stropu' : p.deaktivace.otoceni ? 'otočení do stropu se nepodařilo (' + esc(p.deaktivace.otoceni) + ')' : 'otáčí se do stropu'}. Aktivovat ji může jen rodina ve své aplikaci.` : `Rodina povolila: <strong>${esc(sim.modeReason(p.id))}</strong>`;
  d.querySelector('#dptz')?.classList.toggle('hide', !!p.deaktivace);
  kresliOvl(d, mode);
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
  const otevrene = openAlerts(p.id).length;
  if (otevrene) btns.push(`<button class="sm ok" id="closeAllCam" title="uzavře všechny otevřené alerty této kamery jedním výsledkem">✓ Uzavřít alerty (${otevrene})</button>`);
  if (sim.naServeru && p.real) btns.push(`<button class="sm sec" id="recNow" ${mode === 'full' || mode === 'blur' || mode === 'skeleton' ? '' : 'disabled'} title="${mode === 'deaktivace' ? 'kamera je deaktivovaná rodinou – nenahrává se' : mode === 'full' ? 'server uloží obraz z kamery (na server nebo Google Disk podle Nastavení)' : mode === 'none' ? 'rodina povolila jen „žádný obraz“ – nenahrává se' : 'rodina má ' + ({ skeleton: 'drátěný model', blur: 'rozostřený obraz' }[mode] || mode) + ' – nahrávka bude uzamčená, odemkne ji rodina'}">🎞 Nahrát teď (${s.poskytovatel?.nahravkaS || 15} s)</button>`);
  const changed = setHtml(d.querySelector('#dbtn'), btns.join(' '));
  if (changed) {
    d.querySelector('#askG')?.addEventListener('click', () => { askOpen = true; renderDetail(); });
    d.querySelector('#askCancel')?.addEventListener('click', () => { askOpen = false; renderDetail(); });
    d.querySelector('#askSend')?.addEventListener('click', async () => {
      const reason = d.querySelector('#askReason').value; askOpen = false;
      const r = await sim.requestFull(p.id, `Dispečerka ${ME()}`, reason);
      const sm = r?.sms;
      if (!sm) return;
      if (sm.prijemci === 0) toast('Žádost odeslána. Rodina u téhle kamery nemá účet, SMS nikomu neodešla.');
      else if (sm.odeslano === sm.prijemci) toast(`Žádost odeslána, SMS odešla rodině (${sm.odeslano}).`);
      else toast(`Žádost odeslána; SMS rodině ${sm.odeslano} z ${sm.prijemci}: ${sm.chyba || 'chyba'}`, 'crit');
    });
    d.querySelector('#emerg')?.addEventListener('click', () => { emergOpen = true; renderDetail(); });
    d.querySelector('#emergNo')?.addEventListener('click', () => { emergOpen = false; renderDetail(); });
    d.querySelector('#emergYes')?.addEventListener('click', () => { emergOpen = false; sim.emergencyAccess(p.id, `Dispečerka ${ME()}`); });
    d.querySelector('#endG')?.addEventListener('click', () => sim.endGrant(p.id, `Dispečerka ${ME()}`));
    d.querySelector('#closeAllCam')?.addEventListener('click', () => uzavritVse(p.id, openAlerts(p.id).length));
    d.querySelector('#recNow')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.disabled = true; const puv = b.textContent; b.textContent = 'Nahrávám…';
      try {
        const r = await fetch('/api/nahravky/rucni', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kamera: p.id }) });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'nahrávka se nepodařila');
        toast(j.nahravka.zamek ? `Nahrávka uložena (${j.nahravka.delkaS} s), ale je uzamčená: rodina má nastavený rozostřený obraz. Přehrát ji půjde, až ji rodina odemkne.` : `Nahrávka uložena (${j.nahravka.uloziste === 'disk' ? 'Google Disk' : 'na serveru'}, ${j.nahravka.delkaS} s).`, j.nahravka.zamek ? 'warn' : undefined); nahravkyCache.delete(p.id); nactiNahravky(p.id);
        sim.emit(p.id, 'nahravka', { text: `${ME()} pořídil(a) ruční nahrávku ${j.nahravka.delkaS} s (${j.nahravka.uloziste === 'disk' ? 'Google Disk' : 'na serveru'}).` });
      } catch (e) { toast(`Nahrávka se nepodařila: ${e.message}`, 'crit'); }
      b.textContent = puv; b.disabled = false;
    });
  }
  nactiNahravky(p.id);
  d.querySelector('#dnoteKdo').textContent = `zapíše se jako ${ME()}, ${new Date().toLocaleDateString('cs-CZ')}`;
  d.querySelector('#dkontaktyStav').textContent = describeKontakty(p) ? `Uloženo: ${describeKontakty(p)}` : 'Zatím žádné kontakty rodiny.';
  if (!d.querySelector('#dkontakty').contains(document.activeElement)) {   // telefony poskytovatele mohl změnit jiný dispečer
    const tp = telefonyPoskytovatele(sim.state);
    for (const r of ROLE_POSKYTOVATELE) { const sel = d.querySelector(`.kpzdroj[data-r="${r}"]`), inp = d.querySelector(`.kptel[data-r="${r}"]`); if (!sel) continue; if (sel.value !== tp[r].zdroj) { sel.value = tp[r].zdroj; sel.onchange?.(); } if (tp[r].zdroj === 'vlastni') inp.value = tp[r].telefon ? formatTelefon(tp[r].telefon) : ''; }
    kresliPosk(d);
  }
  {
    const n = p.naramek;
    const stav = d.querySelector('#dnaramekStav'), info = d.querySelector('#dnaramekInfo');
    stav.textContent = n?.id ? `Náramek ${n.id} přiřazen.` : 'Zatím žádný náramek.';
    setHtml(info, popisStavu(n));
    const vyp = d.querySelector('#dnaramekVyp'), tabVyp = d.querySelector('#dtabVyp');
    vyp.classList.toggle('hide', !n?.vypnuto); tabVyp.classList.toggle('hide', !n?.vypnuto);
    if (n?.vypnuto) setHtml(vyp, popisVypnuti(n));
    const mapa = d.querySelector('#dnaramekMapa');
    if (n?.poloha) { mapa.classList.remove('hide'); kresliMapu(mapa, n.poloha.lat, n.poloha.lon); } else mapa.classList.add('hide');
    const sf = d.querySelector('#dnaramekSos');
    if (sf && !sf.contains(document.activeElement) && !sf.dataset.zmena) {
      naplnSos(d, p);
      d.querySelector('#dnaramekSosStav').textContent = !n?.sos ? '' : n.sosOdeslano ? `odesláno do náramku ${fmtDT(n.sosOdeslano)}` : 'uloženo; do náramku se pošle, až se ozve';
    }
    if (sf) kresliVola(d, p);   // náhled čte aktuální volby ve formuláři, může se obnovit i při psaní
    const as = d.querySelector('#dnaramekAutoStav');
    if (as && !d.querySelector('#dnaramekAuto').contains(document.activeElement)) as.textContent = n?.auto?.min > 0 ? `uloženo: každých ${n.auto.min} min` : 'vypnuto';
    nactiMereni(d, p, n);
    const popl = poplachyNaramku(sim.state.events, p.id);
    setHtml(d.querySelector('#dnaramekPoplachy'), popl.length
      ? popl.map((e) => `<li><span class="badge ${esc(urovenUdalosti(e) || 'info')}">${esc(KINDS[e.kind]?.source || 'náramek')}</span><span class="when">${esc(fmtDT(e.at))}</span><span class="grow">${escOdkazy(eventText(e))}${e.state && e.state !== 'uzavřen' ? ` · <span class="badge warn">${esc(e.state)}${e.by ? ' – ' + esc(e.by) : ''}</span>` : e.result ? ` · <span class="muted">${esc(e.result)}</span>` : ''}</span></li>`).join('')
      : '<li class="muted">Zatím žádný poplach z náramku.</li>');
    if (n?.id && !d.querySelector('#dnaramek').contains(document.activeElement)) d.querySelector('#dnaramekId').value = n.id;
  }
  if (!d.querySelector('#dkontakty').contains(document.activeElement)) d.__naplnWatch?.();
  d.querySelector('#dtrvala').textContent = p.note || 'zatím žádná (tlačítko Upravit)';
  setHtml(d.querySelector('#dnotes'), s.events.filter((e) => e.patientId === p.id && e.kind === 'poznamka').slice(0, 30).map((e) => `<li><span class="when">${fmtDT(e.at)} · ${esc(e.by)}</span>${esc(e.text)}</li>`).join('') || '<li class="muted">Zatím žádná poznámka.</li>');
  renderHistorie(d, p, s);
}

/* ---------- historie: posledních 12 ze stavu, nebo zvolené období z databáze (GET /api/udalosti) ---------- */
let dlog = null;   // { od, do, vse, radky } – zobrazené období; null = živě posledních 12
let dfiltr = 'all'; // typ událostí v historii (čipy jako v aplikaci rodiny); zůstává při přepnutí kamery
/** Filtr nad událostí ze stavu (živě). */
function filtrUdalosti(e) {
  const k = KINDS[e.kind];
  switch (dfiltr) {
    case 'all': return true;
    case 'crit': return k?.level === 'crit';
    case 'warn': return k?.level === 'warn';
    case 'consent': return e.kind === 'consent';
    case 'poznamka': return e.kind === 'poznamka';
    case 'nahravka': return !!(e.nahravka && (e.nahravka.id || e.nahravka.url) && !e.nahravka.chyba && !e.nahravka.smazano);
    case 'upozorneni': return !!(e.upozorneni && ((e.upozorneni.sms?.odeslano || 0) + (e.upozorneni.mail?.odeslano || 0) > 0));
    default: return k?.source === dfiltr;
  }
}
/** Filtr nad řádkem logu ze serveru (období). */
function filtrRadku(r) {
  const k = KINDS[r.kind];
  switch (dfiltr) {
    case 'all': return true;
    case 'crit': return k?.level === 'crit';
    case 'warn': return k?.level === 'warn';
    case 'consent': return r.kind === 'consent';
    case 'poznamka': return r.kind === 'poznamka';
    case 'nahravka': return /^ano/.test(r.nahravka || '');
    case 'upozorneni': return /^[1-9]\d*\//.test(r.sms || '') || /^[1-9]\d*\//.test(r.mail || '');
    default: return k?.source === dfiltr;
  }
}
function historieOvladani(d, p) {
  const stav = (t, spatne = false) => { const el = d.querySelector('#dlogStav'); el.textContent = t; el.classList.toggle('bad', spatne); };
  const obdobi = () => { const od = d.querySelector('#dlogOd').value, doD = d.querySelector('#dlogDo').value, vse = d.querySelector('#dlogVse').checked; return { od, do: doD, vse }; };
  const dotaz = (o, format) => `/api/udalosti?od=${encodeURIComponent(o.od)}&do=${encodeURIComponent(o.do)}${o.vse ? '' : '&kamera=' + encodeURIComponent(p.id)}${format ? '&format=' + format : ''}`;
  d.querySelector('#dlogZobraz').onclick = async () => {
    const o = obdobi();
    if (!o.od && !o.do) { stav('Zadejte aspoň datum od, nebo do.', true); return; }
    if (!sim.naServeru) { stav('Období jde vybrat jen se stavem na serveru.', true); return; }
    stav('Načítám…');
    try {
      const r = await fetch(dotaz(o), { cache: 'no-store' }); const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'server odmítl');
      dlog = { ...o, radky: j.udalosti };
      d.querySelector('#dlogZive').classList.remove('hide');
      stav(`${j.udalosti.length} ${j.udalosti.length === 1 ? 'událost' : j.udalosti.length >= 2 && j.udalosti.length <= 4 ? 'události' : 'událostí'} ${o.od ? 'od ' + fmtDatumISO(o.od) : ''} ${o.do ? 'do ' + fmtDatumISO(o.do) : ''}${o.vse ? ', všechny kamery' : ''}`);
      renderHistorie(d, p, sim.state);
    } catch (e) { stav(`Nepodařilo se načíst: ${e.message}`, true); }
  };
  d.querySelectorAll('#dlogFiltr .chip').forEach((b) => { b.onclick = () => { dfiltr = b.dataset.f; d.querySelectorAll('#dlogFiltr .chip').forEach((o) => o.setAttribute('aria-pressed', String(o === b))); renderHistorie(d, p, sim.state); }; });
  d.querySelector('#dlogZive').onclick = () => { dlog = null; d.querySelector('#dlogZive').classList.add('hide'); stav(''); renderHistorie(d, p, sim.state); };
  d.querySelector('#dlogExcel').onclick = () => {
    const o = obdobi();
    if (!sim.naServeru) { stav('Export jde jen se stavem na serveru.', true); return; }
    if (o.od && o.do && o.od > o.do) { stav('Začátek období je až po jeho konci.', true); return; }
    const a = document.createElement('a'); a.href = dotaz(o, 'xlsx'); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    stav(`Stahuji sešit Excelu${o.od || o.do ? '' : ' (celá historie)'}…`);
  };
}
const fmtDatumISO = (iso) => { const [y, m, dd] = iso.split('-'); return `${Number(dd)}. ${Number(m)}. ${y}`; };
function renderHistorie(d, p, s) {
  if (dlog && dlog.radky) {
    setHtml(d.querySelector('#dhist'), dlog.radky.filter(filtrRadku).slice(0, 500).map((r) => {
      const k = KINDS[r.kind];
      const badge = k ? `<span class="badge ${urovenUdalosti(r)}">${esc(k.source)}</span> ` : r.kind === 'poznamka' ? `<span class="badge note">poznámka</span> ` : '<span class="badge">souhlas</span> ';
      const kam = dlog.vse ? ` <span class="muted">· ${esc(r.kamera)}</span>` : '';
      const dalsi = [r.stav && r.stav !== 'uzavřen' ? `<em>${esc(r.stav)}</em>` : '', r.vysledek ? esc(r.vysledek) : '', r.sms ? `📱 ${esc(r.sms)}` : '', r.mail ? `✉ ${esc(r.mail)}` : '', r.nahravka ? `🎞 ${esc(r.nahravka)}` : ''].filter(Boolean).join(' · ');
      return `<li><span class="when">${esc(r.datum)} ${esc(r.casText.slice(0, 5))}</span><span class="grow">${badge}${esc(r.text || r.druh)}${kam}${dalsi ? ` · <span class="muted">${dalsi}</span>` : ''}</span></li>`;
    }).join('') || `<li class="muted">V tomto období není žádná ${dfiltr === 'all' ? 'událost' : 'událost tohoto typu'}.</li>`);
    return;
  }
  // živě: posledních 12; s filtrem posledních 40 vyhovujících (starší jsou v období)
  const zive = s.events.filter((e) => e.patientId === p.id && filtrUdalosti(e)).slice(0, dfiltr === 'all' ? 12 : 40);
  setHtml(d.querySelector('#dhist'), zive.map((e) => {
    const k = KINDS[e.kind];
    const nahr = e.nahravka ? (e.nahravka.url ? ` <a href="${esc(e.nahravka.url)}" target="_blank" rel="noopener" title="nahrávka na Google Disku${e.nahravka.delkaS ? ', ' + e.nahravka.delkaS + ' s' : ''}">🎞 nahrávka</a>` : e.nahravka.id && !e.nahravka.chyba && !e.nahravka.smazano ? (e.nahravka.zamek ? ` <a href="#dnahravky" class="muted" title="pořízeno při rozostřeném obrazu rodiny; přehrát půjde, až ji rodina odemkne">🔒 nahrávka uzamčena</a>` : ` <a href="#dnahravky" title="nahrávka na serveru${e.nahravka.delkaS ? ', ' + e.nahravka.delkaS + ' s' : ''}${e.nahravka.odemklKdo ? ', odemkla rodina' : ''} – přehrát v sekci Nahrávky">🎞 nahrávka</a>`) : ` <span class="muted" title="${esc(e.nahravka.chyba || '')}">🎞 ${esc((e.nahravka.chyba || (e.nahravka.smazano ? 'nahrávka už smazána (doba uchování)' : 'bez nahrávky')).slice(0, 60))}</span>`) : '';
    const badge = k ? `<span class="badge ${urovenUdalosti(e)}">${esc(k.source)}</span> ` : e.kind === 'poznamka' ? `<span class="badge note">poznámka</span> ` : '<span class="badge">souhlas</span> ';
    const u = e.upozorneni;
    const upoz = u ? [u.sms?.prijemci ? `📱 ${u.sms.odeslano}/${u.sms.prijemci}` : '', u.mail?.prijemci ? `✉ ${u.mail.odeslano}/${u.mail.prijemci}` : ''].filter(Boolean).join(' ') : '';
    const chyba = u && (u.sms?.chyba || u.mail?.chyba);
    return `<li><span class="when">${fmtDT(e.at)}</span><span class="grow">${badge}${escOdkazy(eventText(e))}${e.kind === 'poznamka' ? ` · <span class="muted">${esc(e.by)}</span>` : e.result ? ` · <span class="muted">${esc(e.result)}</span>` : e.state && e.state !== 'uzavřen' && k ? ` · <em>${esc(e.state)}</em>` : ''}${upoz ? ` · <span class="${chyba ? 'bad' : 'muted'}" title="${esc(chyba || 'odeslaná upozornění SMS / e-mail')}">${upoz}${chyba ? ' ⚠' : ''}</span>` : ''}${nahr}</span></li>`;
  }).join('') || `<li class="muted">${dfiltr === 'all' ? 'Zatím žádná událost.' : 'Mezi posledními událostmi není žádná tohoto typu – zkuste zvolit období.'}</li>`);
}

/* ---------- uživatelé rodiny: účty na serveru, pozvánka SMS ----------
 * Jen u skutečné kamery (id pacienta = id kamery). Zakládá je poskytovatel
 * přihlášený v hlavní aplikaci; rodina dostane odkaz SMS, zvolí si heslo
 * a přihlašuje se telefonem a heslem (src/uzivatele.mjs). */
let posledniPozvanka = null;   // { uzivatelId, odkaz, text, sms } – ukázat po založení / nové pozvánce
const rodinaUzivatele = new Map();   // id kamery → účty rodiny ze serveru (pro „Zavolat rodině“)

/** Telefon pro Péče doma plus v mezinárodním tvaru (jako jhn-apps): mezery pryč, 9 číslic dostane +420. */
const mezinarodni = (v) => { let t = String(v || '').replace(/[\s\-()]/g, ''); if (/^00\d+$/.test(t)) t = '+' + t.slice(2); if (/^\d{9}$/.test(t)) t = '+420' + t; return t; };
/** Číslo ze zdroje Péče doma / Péče doma plus pro roli podle odpovědi serveru (d.__sluzba); '' když není nebo ještě nedorazila. */
function cisloZeZdroje(d, zdroj, role) {
  const r = d.__sluzba; if (!r || !r.nastaveno) return '';
  if (zdroj === 'pecedoma') return r.pecedoma?.telefon || '';
  if (zdroj === 'pecedomaplus') return r.pecedomaplus?.[role]?.telefon || (role === 'sluzba' ? r.pecedomaplus?.telefon : '') || '';
  return '';
}
/** Náhled vedle každého telefonu poskytovatele v Kontaktech: skutečné číslo podle zvoleného zdroje a odkud je. */
function kresliPosk(d) {
  const kf = d.querySelector('#dkontakty'); if (!kf) return;
  const r = d.__sluzba; const upravuje = kf.contains(document.activeElement);
  for (const role of ROLE_POSKYTOVATELE) {
    const z = kf.querySelector(`.kpzdroj[data-r="${role}"]`)?.value, inp = kf.querySelector(`.kptel[data-r="${role}"]`), el = kf.querySelector(`.kpnahled[data-r="${role}"]`);
    if (!el) continue;
    if (z === 'pecedomaplus' && inp && !upravuje && !inp.value.trim() && cisloZeZdroje(d, 'pecedomaplus', role)) inp.value = cisloZeZdroje(d, 'pecedomaplus', role);   // uložené číslo v Plus do pole, až dorazí ze serveru
    const tel = (inp?.value || '').trim();
    if (z === 'vlastni') setHtml(el, tel ? `→ <b>${esc(formatTelefon(normalizeTelefonCz(tel) || tel))}</b>` : '<span class="muted">→ bez telefonu</span>');
    else if (!sim.naServeru) setHtml(el, `<span class="muted">→ ${esc(POPIS_ZDROJE_TELEFONU[z])}: dosadí server</span>`);
    else if (!r) setHtml(el, '<span class="muted">→ zjišťuji…</span>');
    else if (!r.nastaveno) setHtml(el, `<span class="bad">→ ${esc(r.chyba || 'čísla z Péče doma nejsou na serveru nastavená')}</span>`);
    else if (z === 'pecedoma') setHtml(el, r.pecedoma?.telefon ? `→ <b>${esc(r.pecedoma.telefon)}</b> <span class="muted">(Péče doma${r.pecedoma.poskytovatel ? ', ' + esc(r.pecedoma.poskytovatel) : ''})</span>` : `<span class="bad">→ Péče doma: není vyplněný${r.pecedoma?.duvod ? ' – ' + esc(r.pecedoma.duvod) : ''}</span>`);
    else { const t = mezinarodni(tel); const ulozene = cisloZeZdroje(d, 'pecedomaplus', role); setHtml(el, t ? `→ <b>${esc(t)}</b> <span class="muted">(Péče doma plus${t !== ulozene ? ', uloží se tlačítkem' : ''})</span>` : `<span class="bad">→ Péče doma plus: není vyplněný – zadejte číslo</span>`); }
  }
}
/** Nabídka slotu SOS: prázdné, lidé z rodiny s mobilem, telefony poskytovatele; starší uložená hodnota (číslo napřímo, zdroj) zůstane jako další volba. */
function volbySos(p, vybrane) {
  const k = kontaktyPro(p), tp = telefonyPoskytovatele(sim.state);
  const volby = [['', '– prázdné'], ...k.rodina.map((r, i) => r.telefon ? ['r' + (i + 1), `${r.jmeno || 'rodina ' + (i + 1)} ${formatTelefon(r.telefon)}`] : null).filter(Boolean),
    ...ROLE_POSKYTOVATELE.map((r) => [r, `${POPIS_ROLE[r]} – ${popisTelefonuRole(tp, r)}`])];
  if (vybrane && !volby.some(([v]) => v === vybrane)) volby.push([vybrane, `dřívější: ${cisloSosPro(sim.state, p, vybrane).popis}`]);
  return volby.map(([v, t]) => `<option value="${esc(v)}"${v === vybrane ? ' selected' : ''}>${esc(t)}</option>`).join('');
}
/** Naplní tři výběry SOS podle uložených čísel (nebo po změně Kontaktů s novou nabídkou, zachová volbu). */
function naplnSos(d, p, novaNabidka = false) {
  const pp = sim.patient(p.id) || p;
  d.querySelectorAll('.nsos').forEach((sel) => { const i = Number(sel.dataset.i); const v = novaNabidka ? sel.value : (pp.naramek?.sos?.[i] || ''); setHtml(sel, volbySos(pp, v)); sel.value = v; });
  kresliVola(d, pp);
}
/** Telefony z Péče doma / Péče doma plus pod čísly SOS (odkud server dosazuje). */
function kresliSluzbu(d, p) {
  const el = d.querySelector('#dnaramekSluzba'); if (!el) return;
  const r = d.__sluzba;
  if (!sim.naServeru) { el.textContent = ''; kresliVola(d, p); return; }
  if (!r) { el.textContent = '– zjišťuji čísla z Péče doma…'; return; }
  if (!r.nastaveno) { el.textContent = `– čísla z Péče doma (plus): ${r.chyba || 'nejsou nastavená'}`; kresliVola(d, p); return; }
  const pd = r.pecedoma || {}, pp = r.pecedomaplus || {};
  setHtml(el, `– <b>Péče doma</b> (kontaktní telefon poskytovatele${pd.poskytovatel ? ' ' + esc(pd.poskytovatel) : ''}): ${pd.telefon ? `<b>${esc(pd.telefon)}</b>` : `<span class="bad">není vyplněný</span>${pd.duvod ? ' – ' + esc(pd.duvod) : ''}`}
    · <b>Péče doma plus</b> (tento tenant${r.poskytovatel ? ' ' + esc(r.poskytovatel) : ''}): ${ROLE_POSKYTOVATELE.map((role) => `${POPIS_ROLE[role]} ${pp[role]?.telefon ? `<b>${esc(pp[role].telefon)}</b>` : '<span class="muted">–</span>'}`).join(', ')}${r.zastarale ? ' <span class="muted">(poslední známé, jhn-apps neodpovídá)</span>' : ''}${r.chyba ? ` <span class="bad">${esc(r.chyba)}</span>` : ''}; mění se v Komunikaci → Kontakty → Poskytovatel`);
  kresliVola(d, p);
}
/** „Kam bude náramek volat“: skutečná čísla podle volby ve formuláři (Kontakty + čísla z Péče doma); k tomu naposledy poslaná do náramku. */
function kresliVola(d, p) {
  const el = d.querySelector('#dnaramekVola'); if (!el) return;
  const n = p.naramek;
  const radky = [0, 1, 2].map((i) => {
    const v = d.querySelector(`.nsos[data-i="${i}"]`)?.value || '';
    if (!v) return `${i + 1}. <span class="muted">–</span>`;
    const c = cisloSosPro(sim.state, p, v);
    if (c.telefon) return `${i + 1}. <b>${esc(c.telefon)}</b> <span class="muted">(${esc(c.popis)})</span>`;
    if (!c.zdroj) return `${i + 1}. <span class="bad">${esc(c.popis)}: bez telefonu</span>`;
    const tel = cisloZeZdroje(d, c.zdroj, c.role);
    return tel ? `${i + 1}. <b>${esc(tel)}</b> <span class="muted">(${esc(c.popis)})</span>` : d.__sluzba || !sim.naServeru ? `${i + 1}. <span class="bad">${esc(c.popis)}: číslo není nastavené</span>` : `${i + 1}. <span class="muted">${esc(c.popis)}: zjišťuji…</span>`;
  });
  const posl = Array.isArray(n?.sosOdeslaneCisla) ? ` · v náramku naposledy nastaveno ${n.sosOdeslano ? esc(fmtDT(n.sosOdeslano)) : ''}: ${n.sosOdeslaneCisla.map((c) => esc(c || '–')).join(', ')}` : n?.sos && !n.sosOdeslano ? ' · do náramku zatím neposláno' : '';
  setHtml(el, `Náramek bude volat: ${radky.join(' · ')}${posl}`);
}
const MERENI_NA_KEY = 'famicura.mereniNa';
/** Měření zdraví: načte ze serveru, když přibylo (naramek-ui.nactiMereni), a překreslí tabulku, grafy a mapu. */
function nactiMereni(d, p, n) { nactiMereniNaramku(d.__mereni, p.id, n, { naServeru: sim.naServeru, apiJson, hotovo: () => kresliMereni(d) }); }
function kresliMereni(d) {
  const m = d.__mereni; const el = d.querySelector('#dnaramekMereni'); if (!m || !el) return;
  const radky = kresliStranuMereni(m, { el, strana: d.querySelector('#dnaramekStrana'), prev: d.querySelector('#dnaramekPrev'), next: d.querySelector('#dnaramekNext') });
  kresliGrafy(d.querySelector('#dnaramekGraf'), radky);
  prekresliMapu(d.querySelector('#dnaramekMapa'));   // mapa vedle grafů se natáhne na jejich výšku
}
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
  // u každé kamery: rodina s touhle kamerou + všichni mobilní dispečeři poskytovatele (vidí všechny kamery)
  const users = data.uzivatele.filter((u) => u.role === 'dispecer' || u.kamery.includes(p.id));
  rodinaUzivatele.set(p.id, users);
  const inv = posledniPozvanka;
  box.innerHTML = `<ul class="users">${users.map((u) => `<li data-u="${u.id}"${u.deaktivovan ? ' class="deakt"' : ''}><span class="grow">${u.role === 'dispecer' ? '<span class="badge crit">DISPEČER</span> ' : ''}<strong>${esc(u.jmeno)}</strong> · ${esc(u.telefon.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'))}${u.deaktivovan ? ' <span class="badge tech">deaktivován</span>' : ''}${u.role === 'dispecer' && u.kamery.includes(p.id) ? ' <span class="badge ok">RODINA</span>' : ''}${u.role === 'dispecer' ? ` <span class="small muted">· dispečer: všechny kamery poskytovatele, jen sleduje${u.kamery.includes(p.id) ? '; u této kamery zároveň rodina (v aplikaci se přepíná režim Rodina / Dispečer)' : ''}</span>` : ''}${u.role !== 'dispecer' && u.kamery.length > 1 ? ` <span class="small muted">· také ${esc(u.kamery.filter((k) => k !== p.id).map((k) => sim.patient(k)?.name || k).join(', '))}</span>` : ''}<br><span class="small muted">${u.aktivni ? `přihlašuje se heslem${u.posledniPrihlaseni ? ', naposledy ' + fmtDT(u.posledniPrihlaseni) : ''}` : u.pozvankaPlatiDo ? `čeká na první přihlášení, pozvánka platí do ${fmtDT(u.pozvankaPlatiDo)}` : 'bez přístupu'}</span></span>
      <button class="sm sec" data-a="pozvanka">Nová pozvánka (nové heslo)</button><button class="sm sec" data-a="deakt">${u.deaktivovan ? 'Aktivovat' : 'Deaktivovat'}</button><button class="sm bad" data-a="smaz">Odebrat</button>
      ${inv && inv.uzivatelId === u.id ? `<div class="inv"><strong>${inv.sms?.odeslano ? 'SMS odeslána.' : inv.sms?.error ? `SMS neodešla: ${esc(inv.sms.error)}` : 'Pozvánka připravena.'}</strong> Odkaz platí 7 dní, je na jedno použití:<br><code>${esc(inv.odkaz)}</code>
        <div class="row"><button class="sm" data-a="copy">Kopírovat odkaz</button><a class="sm btnlike" href="${smsLink(u.telefon, inv.text)}">Poslat SMS z tohoto telefonu</a></div></div>` : ''}</li>`).join('') || '<li class="small muted">Zatím nikdo. Založte první účet níže; rodina dostane pozvánku SMS.</li>'}</ul>
    <form class="userform" id="uform">
      <label>Typ účtu<select id="uTyp"><option value="rodina">Rodina – jen tato kamera</option><option value="dispecer">Dispečer – všechny kamery, jen sleduje</option><option value="obe">Rodina i dispečer – tady rodina, jinde jen sleduje</option></select></label>
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
      const volba = box.querySelector('#uTyp').value;
      const typ = volba === 'rodina' ? 'rodina' : 'dispecer';   // „obě“ = dispečer, který má tuhle kameru jako rodina
      // bezpečnostní dotaz: pozvánka dispečera otevírá všechny kamery poskytovatele
      if (typ === 'dispecer' && !confirm(`Opravdu poslat pozvánku DISPEČERA pro ${box.querySelector('#uJmeno').value.trim() || 'tento telefon'} (${box.querySelector('#uTel').value.trim()})?\n\nDispečer uvidí obraz ze VŠECH kamer poskytovatele${volba === 'obe' ? ' a u této kamery bude zároveň rodina' : ''}. Pokud má být jen rodina u této kamery, zvolte Typ účtu „Rodina“.`)) return;
      const r = await post('/api/rodina/uzivatele', { jmeno: box.querySelector('#uJmeno').value, telefon: box.querySelector('#uTel').value, kamery: volba === 'dispecer' ? [] : [p.id], role: typ, poslatSms: box.querySelector('#uSms').checked });
      if (typ === 'dispecer' && !r.pridano) {
        posledniPozvanka = { uzivatelId: r.uzivatel.id, odkaz: r.odkaz, text: r.text, sms: r.sms };
        const obe = volba === 'obe' ? ' a u této kamery je zároveň rodina' : '';
        toast(r.povysen ? `${r.uzivatel.jmeno} má teď i roli dispečera (své kamery mu zůstávají jako rodině); ${r.sms.odeslano ? 'pozvánka odeslána SMS, staré heslo přestalo platit' : 'pozvánka je připravená, staré heslo přestalo platit'}.` : r.sms.odeslano ? `Pozvánka dispečera odeslána SMS na ${r.uzivatel.telefon}. Uvidí všechny kamery poskytovatele${obe}.` : `Účet dispečera založen, pozvánka je připravená. Uvidí všechny kamery poskytovatele${obe}.`);
      } else if (r.pridano) {
        // telefon už účet má: kamera se k němu přidala, rodina ji uvidí pod stejným heslem (v aplikaci přibude přepínač kamer)
        posledniPozvanka = null;
        toast(r.uzivatel.aktivni ? `Telefon už má účet (${r.uzivatel.jmeno}): kamera mu byla přidána, přihlásí se stejným heslem a kameru si vybere v aplikaci.` : `Telefon už má účet (${r.uzivatel.jmeno}), kamera mu byla přidána. Účet ještě není aktivovaný – pošlete mu novou pozvánku.`);
      } else {
        posledniPozvanka = { uzivatelId: r.uzivatel.id, odkaz: r.odkaz, text: r.text, sms: r.sms };
        toast(r.sms.odeslano ? `Pozvánka odeslána SMS na ${r.uzivatel.telefon}.` : 'Účet založen, pozvánka je připravená.');
      }
      renderUzivatele(p);
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); }
  };
  box.querySelectorAll('li[data-u] button').forEach((b) => { b.onclick = async () => {
    const id = b.closest('li').dataset.u;
    try {
      if (b.dataset.a === 'copy') { await navigator.clipboard.writeText(inv.odkaz); toast('Odkaz zkopírován.'); return; }
      if (b.dataset.a === 'smaz') {
        if (b.textContent !== 'Opravdu odebrat?') { b.textContent = 'Opravdu odebrat?'; return; }
        const r = await apiJson(`/api/rodina/uzivatele/${id}?kamera=${encodeURIComponent(p.id)}`, { method: 'DELETE' }); posledniPozvanka = null;
        toast(r.smazan ? 'Účet odebrán.' : r.uzivatel.role === 'dispecer' ? `${r.uzivatel.jmeno} už u této kamery není rodina; dispečerem zůstává (odebrat ho jde u kamery, kde není rodina).` : `Kamera odebrána z účtu; ${r.uzivatel.jmeno} má dál své ostatní kamery.`);
      }
      if (b.dataset.a === 'deakt') {
        const u = (rodinaUzivatele.get(p.id) || []).find((x) => x.id === id);
        const r = await post(`/api/rodina/uzivatele/${id}/deaktivace`, { on: !u?.deaktivovan });
        toast(r.uzivatel.deaktivovan ? `Účet ${r.uzivatel.jmeno} deaktivován: nepřihlásí se a přihlášený je odhlášen. Aktivovat ho jde kdykoli.` : `Účet ${r.uzivatel.jmeno} je zase aktivní.`);
      }
      if (b.dataset.a === 'pozvanka') {
        const u = (rodinaUzivatele.get(p.id) || []).find((x) => x.id === id);
        if (u?.role === 'dispecer' && !confirm(`Opravdu poslat novou pozvánku DISPEČERA pro ${u.jmeno} (${u.telefon})?\n\nDispečer uvidí obraz ze VŠECH kamer poskytovatele. Staré heslo přestane platit.`)) return;
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
    const k = KINDS[e.kind]; if (!k || urovenUdalosti(e) === 'info' || !visible(sim.patient(e.patientId) || {})) continue;
    if (k.level === 'crit') { beep(); toast(`🚨 ${sim.patient(e.patientId)?.name}: ${k.label}`, 'crit', () => { selected = e.patientId; renderDetail(true); renderTiles(); }); }
    else toast(`${sim.patient(e.patientId)?.name}: ${k.label}`);
  }
  renderHlavicka(); renderTiles(); renderQueue(); renderDetail();
});
setInterval(() => { renderTiles(); renderQueue(); renderDetail(); }, 5000);
// Varování o místě na serveru: hned po načtení a pak každých 5 minut (pripraveno je definované výše, proto až tady na konci).
pripraveno.then((ok) => { if (ok) { diskVarovaniZkontroluj(); setInterval(diskVarovaniZkontroluj, 5 * 60 * 1000); } });
