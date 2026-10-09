/* Kreslení údajů z náramku / přívěsku SOS společné pro dispečink (záložka
 * Náramek) a aplikaci na telefonu (karta Náramek u rodiny i mobilního
 * dispečera): stav a poslední měření, mapa polohy, grafy za 24 hodin,
 * tabulka měření zdraví, poplachy a načítání měření ze serveru. Ovládání
 * náramku (příkazy, čísla SOS, přiřazení) zůstává jen v dispečinku. */
import { MEZE_ZDRAVI, urovenHodnoty, fmtDT, esc, ago, setHtml } from '/proto/sim.js';

/** Mapa polohy náramku: dlaždice OpenStreetMap (zoom 16) kolem bodu, značka uprostřed; kreslí se znovu jen při změně souřadnic. */
export function kresliMapu(el, lat, lon) {
  const klic = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (el.dataset.k === klic) return;
  el.dataset.k = klic;
  const z = 16, n = 2 ** z, W = el.clientWidth || 600, H = el.clientHeight || 320;
  el.dataset.wh = `${W}x${H}`;
  const la = lat * Math.PI / 180;
  const px = (lon + 180) / 360 * n * 256, py = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n * 256;
  const x0 = px - W / 2, y0 = py - H / 2;
  const casti = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      casti.push(`<img alt="" src="https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png" style="left:${Math.round(tx * 256 - x0)}px;top:${Math.round(ty * 256 - y0)}px">`);
    }
  }
  el.innerHTML = casti.join('') + '<div class="znacka" title="poslední poloha náramku"></div><span class="osm">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></span>';
}
/** Mapa vedle grafů se natáhne na jejich výšku; dlaždice jsou spočítané pro původní rozměr, proto po změně rozměru překreslit. */
export function prekresliMapu(mapa) {
  if (!mapa || !mapa.dataset.k || mapa.classList.contains('hide') || mapa.dataset.wh === `${mapa.clientWidth}x${mapa.clientHeight}`) return;
  const [la, lo] = mapa.dataset.k.split(','); mapa.dataset.k = ''; kresliMapu(mapa, Number(la), Number(lo));
}

/** Poslední měření jednou větou: „tep 73, tlak 122/75, kyslík 97 %, teplota 36,6 °C“. */
export function popisMereni(z) {
  const c = [];
  if (z?.tep) c.push(`tep ${z.tep}`); if (z?.tlakS && z?.tlakD) c.push(`tlak ${z.tlakS}/${z.tlakD}`); if (z?.spo2) c.push(`kyslík ${z.spo2} %`); if (z?.teplota) c.push(`teplota ${String(z.teplota).replace('.', ',')} °C`);
  return c.join(', ');
}
/** Náramek se neozval přes 2 hodiny: vybitý, bez signálu, nebo vypnutý tlačítkem. */
export const TICHO_MS = 2 * 60 * 60 * 1000;
export const jeTicho = (n, now = Date.now()) => !!(n?.posledni && now - n.posledni > TICHO_MS);
/** Stav náramku (HTML): poslední ozvání, baterie, odkaz na polohu, poslední měření; bez přiřazení / před prvním ozváním srozumitelný text. */
export function popisStavu(n, { now = Date.now(), proRodinu = false } = {}) {
  if (!n?.id) return 'Náramek není přiřazen.';
  if (!n.posledni) return proRodinu ? `Náramek ${esc(n.id)} je přiřazený, zatím se neozval.` : 'Zatím se neozval. Zařízení musí mít nastavenou adresu serveru (SMS příkaz je v nápovědě → Náramek); po nastavení se ozve do minuty.';
  const ticho = jeTicho(n, now);
  return `Naposledy se ozval <strong${ticho ? ' class="bad"' : ''}>${esc(ago(n.posledni))}</strong>${ticho && !n.vypnuto ? ' <span class="bad">(neozývá se přes 2 hodiny – vybitý, bez signálu, nebo vypnutý tlačítkem)</span>' : ''}${Number.isFinite(n.baterie) ? `, baterie <strong>${n.baterie} %</strong>` : ''}${n.poloha ? ` · <a href="https://maps.google.com/?q=${n.poloha.lat.toFixed(5)},${n.poloha.lon.toFixed(5)}" target="_blank" rel="noopener">poslední poloha${n.poloha.priblizna ? ' (přibližná, z mobilní sítě)' : ' (GPS)'}</a> ${esc(ago(n.poloha.cas || n.posledni))}` : ' · poloha zatím není'}`
    + (n.zdravi ? `<br>Poslední měření (${esc(ago(n.zdravi.cas))}): <strong>${esc(popisMereni(n.zdravi))}</strong>` : '');
}
/** Červené hlášení o vypnutém náramku (HTML), nebo '' když vypnutý není. */
export function popisVypnuti(n) {
  if (!n?.vypnuto) return '';
  return `⏻ NÁRAMEK JE VYPNUTÝ – příkaz k vypnutí poslal(a) ${esc(n.vypnulKdo || 'dispečink')} ${esc(fmtDT(n.vypnuto))}. Nehlásí SOS, pád ani polohu. Zapne se jen tlačítkem na náramku; jakmile se ozve, tohle hlášení zmizí.`;
}

/** Jako slucMereni na serveru (src/log-udalosti.mjs): hodnoty jedné sady (do 2 minut, bez překryvu) v jednom řádku. */
export function slucMereni(radky, oknoMs = 120_000) {
  const POLE = ['tep', 'tlakS', 'tlakD', 'spo2', 'teplota']; const out = [];
  for (const r of radky) {
    const g = out[out.length - 1];
    if (g && g.cas - r.cas <= oknoMs && r.cas <= g.cas && !POLE.some((k) => r[k] != null && g[k] != null)) { for (const k of POLE) if (r[k] != null) g[k] = r[k]; }
    else out.push({ ...r });
  }
  return out;
}
/** Paměť měření jedné stránky: řádky ze serveru, čas posledního měření (kdy se načítalo), stránkování. */
export function pametMereni(na = 10) { return { radky: null, cas: null, kamera: null, strana: 0, na, nacitam: false }; }
/** Načte měření ze serveru, když přibylo (čas posledního měření ve stavu se změnil), kamera se změnila, nebo ještě nebylo načteno;
 * bez serveru vezme n.mereni ze stavu. Zavolá `hotovo()` po každém načtení (i náhradním). */
export function nactiMereni(m, kameraId, n, { naServeru, apiJson, hotovo }) {
  if (!m) return;
  const cas = n?.zdravi?.cas || null;
  if (m.radky && m.cas === cas && m.kamera === kameraId) return;
  if (m.kamera !== kameraId) m.strana = 0;
  m.kamera = kameraId; m.cas = cas;
  if (!naServeru) { m.radky = slucMereni(Array.isArray(n?.mereni) ? n.mereni : []); m.strana = 0; hotovo(); return; }
  if (m.nacitam) return; m.nacitam = true;
  apiJson(`/api/naramek/mereni?kamera=${encodeURIComponent(kameraId)}`).then((r) => { m.radky = r.mereni || []; if (m.strana * m.na >= m.radky.length) m.strana = 0; hotovo(); })
    .catch(() => { m.radky = slucMereni(Array.isArray(n?.mereni) ? n.mereni : []); hotovo(); })
    .finally(() => { m.nacitam = false; });
}
/** Tabulka měření (HTML): hodnota mimo běžné rozmezí oranžově (warn), mimo varovné rozmezí červeně (bad); meze v sim-core MEZE_ZDRAVI. */
export function tabulkaMereni(radky) {
  if (!radky.length) return '<p class="small muted">Zatím žádné měření.</p>';
  const bunka = (k, v, text) => { const u = urovenHodnoty(k, v); const m = MEZE_ZDRAVI[k]; return `<td class="hod ${u}"${u === 'warn' || u === 'bad' ? ` title="mimo běžné rozmezí ${m.ok[0]}–${m.ok[1]} ${m.jednotka}"` : ''}>${text}</td>`; };
  const bunkaTlak = (z) => { if (!(z.tlakS && z.tlakD)) return '<td></td>'; const u = ['bad', 'warn', 'ok'].find((x) => [urovenHodnoty('tlakS', z.tlakS), urovenHodnoty('tlakD', z.tlakD)].includes(x)) || ''; return `<td class="hod ${u}"${u === 'warn' || u === 'bad' ? ' title="mimo běžné rozmezí 90–139 / 60–89 mmHg"' : ''}>${z.tlakS}/${z.tlakD}</td>`; };
  return `<table class="mereni"><thead><tr><th>Čas</th><th>Tep</th><th>Tlak</th><th>Kyslík</th><th>Teplota</th></tr></thead><tbody>${radky.map((z) => `<tr><td>${esc(fmtDT(z.cas))}</td>${bunka('tep', z.tep, z.tep ?? '')}${bunkaTlak(z)}${bunka('spo2', z.spo2, z.spo2 ? z.spo2 + ' %' : '')}${bunka('teplota', z.teplota, z.teplota ? String(z.teplota).replace('.', ',') + ' °C' : '')}</tr>`).join('')}</tbody></table>`;
}
/** Stránka měření do `el` a text stránkování (vrátí ho); tlačítka novější/starší zapne či vypne podle stránky. */
export function kresliStranuMereni(m, { el, strana, prev, next }) {
  const radky = m.radky || []; const stran = Math.max(1, Math.ceil(radky.length / m.na)); if (m.strana >= stran) m.strana = stran - 1;
  const vyrez = radky.slice(m.strana * m.na, (m.strana + 1) * m.na);
  if (strana) strana.textContent = radky.length ? `${m.strana + 1} / ${stran} · ${radky.length}${radky.length >= 2000 ? '+' : ''} měření` : '';
  if (prev) prev.disabled = m.strana === 0; if (next) next.disabled = m.strana >= stran - 1;
  setHtml(el, tabulkaMereni(vyrez));
  return radky;
}

/* Grafy posledních 10 měření: čtyři malé grafy (tep, tlak, kyslík, teplota), měření rovnoměrně vedle sebe (ne podle času – měření
   bývají nahloučená, na časové ose se slila do chumlu), pod každým bodem jeho čas, jedna osa hodnot na graf, světlé pásmo = běžné
   rozmezí, body mimo rozmezí oranžově/červeně, popisek bodu (datum, čas, hodnota) po najetí myší. */
export const GRAF_MERENI = 10;
const GRAFY = [
  { k: 'tep', nazev: 'Tep', jednotka: '/min', serie: [['tep', 'tep', 's1']] },
  { k: 'tlak', nazev: 'Krevní tlak', jednotka: 'mmHg', serie: [['tlakS', 'horní', 's1'], ['tlakD', 'dolní', 's2']] },
  { k: 'spo2', nazev: 'Kyslík v krvi', jednotka: '%', serie: [['spo2', 'kyslík', 's1']] },
  { k: 'teplota', nazev: 'Teplota', jednotka: '°C', serie: [['teplota', 'teplota', 's1']] },
];
export function kresliGrafy(el, radky, pocet = GRAF_MERENI) {
  if (!el) return;
  const W = 320, H = 104, L = 38, R = 10, T = 8, B = 24, OKRAJ = 16;   // OKRAJ: body odsazené od krajů, ať se popisky časů vejdou pod ně
  const fmtCas = (t) => new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const fmtDen = (t) => new Date(t).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
  const fmtV = (v) => String(v).replace('.', ',');
  setHtml(el, GRAFY.map((g) => {
    // posledních N měření, ve kterých je některá veličina grafu (sada jen s teplotou se v grafu tepu nepočítá)
    const vsechna = (radky || []).filter((r) => g.serie.some(([k]) => r[k] != null)).sort((a, b) => b.cas - a.cas).slice(0, pocet).sort((a, b) => a.cas - b.cas);
    const serie = g.serie.filter(([k]) => vsechna.some((r) => r[k] != null));
    if (!serie.length) return `<figure class="graf prazdny"><figcaption>${esc(g.nazev)} <span class="muted">(${esc(g.jednotka)})</span></figcaption><p class="small muted">zatím bez měření</p></figure>`;
    const n = vsechna.length;
    const x = (i) => n === 1 ? (L + W - R) / 2 : L + OKRAJ + (i / (n - 1)) * (W - L - R - 2 * OKRAJ);
    const hodnoty = []; for (const [k] of serie) for (const r of vsechna) if (r[k] != null) hodnoty.push(Number(r[k]));
    const meze = serie.length === 1 ? MEZE_ZDRAVI[serie[0][0]] : null;
    let min = Math.min(...hodnoty, ...(meze ? [meze.ok[0]] : [])), max = Math.max(...hodnoty, ...(meze ? [meze.ok[1]] : []));
    if (max - min < 4) { const s = (4 - (max - min)) / 2; min -= s; max += s; }
    const krok = (max - min) / 2; min -= krok * 0.08; max += krok * 0.08;
    const y = (v) => T + ((max - v) / (max - min)) * (H - T - B);
    const osaY = [min, (min + max) / 2, max].map((v) => `<line class="osa" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmtV(Math.round(v * 10) / 10)}</text>`).join('');
    // čas pod každým měřením; když měření nejsou z jednoho dne, u prvního měření každého dne je nad časem i datum
    const osaX = vsechna.map((r, i) => { const novyDen = i === 0 ? false : fmtDen(r.cas) !== fmtDen(vsechna[i - 1].cas); const anchor = 'middle'; return `<line class="osa" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${x(i).toFixed(1)}" y="${H - 11}" text-anchor="${anchor}">${fmtCas(r.cas)}</text>${novyDen ? `<text class="tick den" x="${x(i).toFixed(1)}" y="${H - 2}" text-anchor="${anchor}">${esc(fmtDen(r.cas))}</text>` : ''}`; }).join('');
    const pasmo = meze ? `<rect class="pasmo" x="${L}" y="${y(Math.min(meze.ok[1], max)).toFixed(1)}" width="${W - L - R}" height="${Math.max(0, y(Math.max(meze.ok[0], min)) - y(Math.min(meze.ok[1], max))).toFixed(1)}"><title>běžné rozmezí ${fmtV(meze.ok[0])}–${fmtV(meze.ok[1])} ${esc(meze.jednotka)}</title></rect>` : '';
    const cary = serie.map(([k, nazev, cls]) => {
      const body = vsechna.map((r, i) => [r, i]).filter(([r]) => r[k] != null);
      const cara = body.length > 1 ? `<path class="cara ${cls}" d="${body.map(([r, i], j) => `${j ? 'L' : 'M'}${x(i).toFixed(1)} ${y(Number(r[k])).toFixed(1)}`).join(' ')}"/>` : '';
      const tecky = body.map(([r, i]) => { const u = urovenHodnoty(k, r[k]); return `<circle class="bod ${cls} ${u}" cx="${x(i).toFixed(1)}" cy="${y(Number(r[k])).toFixed(1)}" r="4"><title>${esc(fmtDT(r.cas))} · ${esc(nazev)} ${fmtV(r[k])} ${esc(g.jednotka)}${u === 'warn' ? ' · mimo běžné rozmezí' : u === 'bad' ? ' · výrazně mimo rozmezí' : ''}</title></circle>`; }).join('');
      const [posl, poslI] = body[body.length - 1];
      const vpravo = x(poslI) + 40 > W - R;   // u pravého okraje popisek vlevo od bodu, jinak vpravo
      const popis = serie.length > 1 ? `<text class="popis" x="${(vpravo ? x(poslI) - 7 : x(poslI) + 7).toFixed(1)}" y="${(y(Number(posl[k])) + 3).toFixed(1)}" text-anchor="${vpravo ? 'end' : 'start'}">${esc(nazev)}</text>` : '';
      return cara + tecky + popis;
    }).join('');
    const legenda = serie.length > 1 ? `<span class="legenda">${serie.map(([, nazev, cls]) => `<i class="lg ${cls}"></i>${esc(nazev)}`).join(' ')}</span>` : '';
    const prvni = vsechna[0].cas, posledni = vsechna[n - 1].cas;
    const obdobi = fmtDen(prvni) === fmtDen(posledni) ? fmtDen(posledni) : `${fmtDen(prvni)} – ${fmtDen(posledni)}`;
    return `<figure class="graf"><figcaption>${esc(g.nazev)} <span class="muted">(${esc(g.jednotka)})</span>${legenda}<span class="legenda obdobi">${n === 1 ? '1 měření' : `posledních ${n} měření`} · ${esc(obdobi)}</span></figcaption><svg class="g" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g.nazev)}, posledních ${n} měření">${pasmo}${osaY}${osaX}${cary}</svg></figure>`;
  }).join(''));
}

/** Druhy událostí, které hlásí náramek (poplachy): nouzové tlačítko, pád, slabá baterie. */
export const DRUHY_NARAMKU = ['sos', 'devfall', 'battery'];
export const poplachyNaramku = (events, kameraId, max = 20) => events.filter((e) => e.patientId === kameraId && DRUHY_NARAMKU.includes(e.kind)).slice(0, max);
