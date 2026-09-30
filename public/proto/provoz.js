import { mountAuthBanner, sim, KINDS, mountPanel, toast, fmtT, fmtDT, esc, eventText, ago, setHtml, agoSpan, refreshAgo } from '/proto/sim.js';

const $ = (id) => document.getElementById(id);
const GATE = { tapoc2020: 'Windows PC', p2: 'GL.iNet Mango', p3: 'Raspberry Pi 5 + AI HAT', p4: 'GL.iNet Mango', p5: 'Raspberry Pi 5 + AI HAT', p6: 'GL.iNet Mango', p7: 'GL.iNet Mango', p8: 'GL.iNet Beryl AX' };
const FW = { tapoc2020: 'C220 1.0.3', p2: 'C210 1.3.9', p3: 'C220 1.0.3', p4: 'C220 1.0.3', p5: 'C220 1.0.3', p6: 'C210 1.3.9', p7: 'C220 1.0.2 (stará)', p8: 'C225 1.1.0' };
let real = null;           // /api/status of the real site
let selected = null;
mountPanel({ role: 'provoz' });
mountAuthBanner(null);
sim.startRealEvents('tapoc2020');

async function loadReal() {
  try { const r = await fetch('/api/status'); real = await r.json(); } catch (e) { real = { error: e.message }; }
  render();
}
loadReal(); setInterval(loadReal, 15000);

function dot(ok, warn) { return `<span class="dot ${ok ? 'ok' : warn ? 'warn' : 'crit'}"></span>`; }

function realCam() { return real?.cameras?.find((c) => c.id === 'tapoc2020') || null; }

function siteRow(p) {
  const isReal = p.real;
  const cam = isReal ? realCam() : null;
  const authed = real?.authenticated;
  const tunnelOk = isReal ? (authed ? !!real?.go2rtc?.ok : null) : !p.offline;
  const camOk = isReal ? (cam ? cam.online : null) : !p.offline;
  const evOk = isReal ? (cam ? cam.eventsOk : null) : !p.offline;
  const last = isReal ? (cam?.eventsLast ? `${fmtT(new Date(cam.eventsLast.at).getTime())} ${cam.eventsLast.text}` : (authed ? 'bez událostí' : 'nepřihlášeno v aplikaci')) : (p.offline ? `výpadek ${ago(sim.state.events.find((e) => e.patientId === p.id && e.kind === 'offline')?.at || Date.now())}` : `před ${ago(Date.now() - (p.id.charCodeAt(1) % 5) * 60000)}`);
  const na = (v, t) => v === null ? '<span class="muted">–</span>' : dot(v) + t;
  return `<tr data-id="${p.id}" class="${selected === p.id ? 'sel' : ''}"><td>${esc(p.place)}${isReal ? ' <span class="badge ok">skutečné</span>' : ''}</td><td>${esc(p.name)}</td><td>${esc(GATE[p.id])}</td>
    <td>${na(tunnelOk, tunnelOk ? 'navázán' : 'bez odezvy')}</td><td>${na(camOk, camOk ? 'obraz jde' : 'bez obrazu')}</td><td>${na(evOk, evOk ? 'odebírám' : 'neodebírám')}</td>
    <td>${esc(FW[p.id])}${/stará/.test(FW[p.id]) ? ' <span class="badge warn">aktualizovat</span>' : ''}</td><td class="small">${esc(last)}</td><td><button class="sm sec" data-diag="${p.id}">Diagnostika</button></td></tr>`;
}

function render() {
  const s = sim.state;
  $('fleet').innerHTML = s.patients.map(siteRow).join('');
  $('fleet').querySelectorAll('[data-diag]').forEach((b) => { b.onclick = () => { selected = b.dataset.diag; renderDiag(); render(); }; });
  const bad = s.patients.filter((p) => p.offline || (p.real && real?.authenticated && (!real.go2rtc?.ok || realCam()?.online === false)));
  $('nSites').textContent = s.patients.length; $('nBad').textContent = bad.length; $('nOk').textContent = s.patients.length - bad.length;
  const techs = s.events.filter((e) => KINDS[e.kind]?.level === 'tech' && e.state !== 'uzavřen').slice(0, 5);
  const camTamper = s.events.filter((e) => e.kind === 'tamper' && e.state !== 'uzavřen').slice(0, 3);
  const alarmsHtml = [...techs, ...camTamper].map((e) => `<div class="banner ${e.kind === 'offline' ? 'crit' : 'warn'}"><span class="badge tech">provoz</span><strong>${esc(sim.patient(e.patientId)?.place)}</strong><span class="grow">${esc(eventText(e))} · ${fmtT(e.at)} · před ${agoSpan(e.at)}</span><button class="sm sec" data-fix="${e.id}" data-p="${e.patientId}" data-k="${e.kind}">Vyřešeno</button></div>`).join('');
  if (setHtml($('alarms'), alarmsHtml)) $('alarms').querySelectorAll('[data-fix]').forEach((b) => { b.onclick = () => { sim.setAlert(b.dataset.fix, { state: 'uzavřen', by: 'Tomáš Král', result: 'opraveno' }); if (b.dataset.k === 'offline') sim.emit(b.dataset.p, 'online'); }; });
  refreshAgo($('alarms'));
}

function renderDiag() {
  const p = sim.patient(selected); if (!p) return;
  const box = $('diagCard');
  if (p.real) {
    const cam = realCam();
    const rows = [];
    if (!real?.authenticated) rows.push(['Přihlášení', '<span class="bad">nejste přihlášeni v hlavní aplikaci – stav nelze číst</span>']);
    else {
      rows.push(['go2rtc', real.go2rtc?.ok ? `<span class="badge ok">běží</span> ${esc(real.go2rtc.version)}` : `<span class="badge crit">neběží</span> ${esc(real.go2rtc?.error || '')}`]);
      if (cam) {
        rows.push(['Kamera', cam.online ? '<span class="badge ok">posílá obraz</span>' : `<span class="badge crit">bez obrazu</span> ${esc(cam.detail || '')}`]);
        rows.push(['Odběr událostí', cam.eventsOk === null ? '<span class="muted">server neodebírá (kamera není v cameras.json)</span>' : cam.eventsOk ? `<span class="badge ok">odebírám</span> ${esc((cam.events || []).map((e) => e.label || e.kind).join(', '))}` : `<span class="badge crit">neodebírám</span> ${esc(cam.eventsError || '')}`]);
        if (cam.eventsLast) rows.push(['Poslední událost', `${fmtDT(new Date(cam.eventsLast.at).getTime())} – ${esc(cam.eventsLast.text)}`]);
        if (cam.eventsRejected) rows.push(['Naposledy nezapsáno', `${fmtT(new Date(cam.eventsRejected.at).getTime())} – ${esc(cam.eventsRejected.label)}: ${esc(cam.eventsRejected.duvod)}`]);
        if (cam.clbError) rows.push(['CLB1', `<span class="bad">${esc(cam.clbError)}</span>`]);
      }
      rows.push(['Konfigurace', (real.missing || []).length ? `<span class="bad">chybí ${esc(real.missing.join(', '))}</span>` : '<span class="badge ok">kompletní</span>']);
    }
    box.innerHTML = `<h2>Diagnostika · ${esc(p.place)}</h2><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="row" style="margin-top:10px"><button class="sm sec" id="rawDiag">Surové zprávy kamery 60 s</button><button class="sm sec" id="reload">Obnovit</button></div><pre class="small muted hide" id="rawOut"></pre>`;
    box.querySelector('#reload').onclick = loadReal;
    box.querySelector('#rawDiag').onclick = () => { const o = box.querySelector('#rawOut'); o.classList.remove('hide'); o.textContent = 'V ostré aplikaci spustí na serveru scripts/onvif-diag.mjs a vypíše témata ONVIF a každou zprávu kamery 60 s (viz deploy/vps-diag.sh). V prototypu se nespouští.'; };
  } else {
    box.innerHTML = `<h2>Diagnostika · ${esc(p.place)}</h2><dl class="kv"><dt>Brána</dt><dd>${esc(GATE[p.id])} · verze 1.4.${p.offline ? 1 : 2} · poslední hlášení ${p.offline ? 'před 14 min' : 'před 20 s'}</dd>
      <dt>Tunel WireGuard</dt><dd>${p.offline ? '<span class="badge crit">bez odezvy</span> poslední handshake 10:31' : '<span class="badge ok">navázán</span> handshake před 40 s, 10.77.0.' + (2 + Number(p.id.slice(1))) + '</dd>'}
      <dt>Kamera</dt><dd>${p.offline ? '<span class="badge crit">nedostupná</span>' : '<span class="badge ok">RTSP i ONVIF odpovídají</span> hodiny +1 s'}</dd>
      <dt>Analýza</dt><dd>${/Pi 5/.test(GATE[p.id]) ? '<span class="badge ok">na bráně</span> 9 snímků/s, 61 °C' : 'na serveru eu-1'}</dd>
      <dt>Firmware kamery</dt><dd>${esc(FW[p.id])}</dd></dl>
      <div class="row" style="margin-top:10px"><button class="sm sec" id="restart">Restartovat proud</button><button class="sm sec" id="retunnel">Obnovit tunel</button>${p.offline ? '<button class="sm" id="back">Simulovat návrat</button>' : ''}</div>`;
    box.querySelector('#restart').onclick = () => toast('Proud kamery restartován (simulace).');
    box.querySelector('#retunnel').onclick = () => toast('Konfigurace tunelu znovu odeslána bráně (simulace).');
    box.querySelector('#back')?.addEventListener('click', () => sim.emit(p.id, 'online'));
  }
}

$('newSite').onclick = () => { $('wizard').classList.remove('hide'); $('wizard').scrollIntoView({ behavior: 'smooth' }); };
$('closeW').onclick = () => $('wizard').classList.add('hide');
$('genPkg').onclick = () => { $('pkgState').textContent = 'balíček famicura-brana-2026-09-30.zip vygenerován, platí do zítra 10:12 (simulace)'; };
$('runCheck').onclick = async () => {
  const steps = ['Tunel navázán (handshake)', 'RTSP odpovídá, obraz 1280×720 H.264', 'ONVIF odpovídá, témata: pohyb, osoba, čára, zakrytí', 'Hodiny kamery proti serveru: −1 s', 'go2rtc dostává obraz', 'Odběr událostí založen'];
  const ul = $('checks'); ul.innerHTML = '';
  for (const s of steps) { const li = document.createElement('li'); li.innerHTML = `<span class="dot"></span>${esc(s)}…`; ul.append(li); await new Promise((r) => setTimeout(r, 600)); li.innerHTML = `<span class="dot ok"></span>${esc(s)}`; }
  toast('Kontrola po instalaci: vše zelené. Pozvánka rodině odeslána (simulace).');
};

sim.subscribe(() => { render(); if (selected) renderDiag(); });
