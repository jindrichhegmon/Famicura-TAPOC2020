/**
 * Náramky a přívěsky SOS (ReachFar RF-V48 a další zařízení s „protokolem hodinek“,
 * stejným jako SeTracker): zařízení se připojí mobilními daty přímo na tento server
 * (TCP, port NARAMKY_PORT, výchozí 5093) a posílá textové rámce
 *
 *   [3G*9705357211*0009*LK,50,100]          – ozvání (kroky, převrácení, baterie %)
 *   [3G*9705357211*00B5*UD,081026,125959,A,50.0376,N,13.8711,E,0.0,0,250,8,80,95,0,0,00000000,…]
 *   [3G*9705357211*00B5*AL,…stejná pole…]  – poplach (SOS, pád…) – stav v šestnáctkovém poli „status“
 *   [3G*9705357211*0003*TKQ]                – dotaz na čas
 *
 * Tvar rámce: [VÝROBCE*ID*DÉLKA*OBSAH], novější firmware [VÝROBCE*ID*INDEX*DÉLKA*OBSAH];
 * délka = 4 šestnáctkové číslice, počet bajtů obsahu. Server odpovídá na LK, AL a TKQ
 * stejným rámcem bez dat ([3G*ID*0002*LK]); bez odpovědi zařízení poplach opakuje.
 *
 * Přívěsek se v dispečinku přiřadí ke kameře (Komunikace → Náramek / přívěsek, ID zařízení).
 * SOS → událost „Nouzové tlačítko“, pád → „Pád hlášený náramkem“, slabá baterie → „Slabá
 * baterie náramku“ u té kamery; dál jde vše jako u událostí kamery (fronta, SMS, e-mail,
 * nahrávka kamery). Ozvání a baterie se zapisují ke kameře (naramek.posledni, baterie, poloha).
 *
 * Přijímá se jen od ID, které některý poskytovatel přiřadil; neznámé ID se jen zaloguje
 * (jednou za hodinu), ať se dá přiřadit. Žádná data se neposílají zpět kromě potvrzení.
 */
import net from 'node:net';

const MAX_RAMEC = 4096;          // delší obsah (obrázky, záznamy) nás nezajímá
const MAX_BUFFER = 64 * 1024;    // ochrana proti zahlcení jedním spojením
const DEDUP_MS = 60 * 1000;      // stejný poplach z téhož zařízení do minuty = opakování
const OZVANI_MS = 5 * 60 * 1000; // ozvání bez změny baterie se zapisuje nejvýš po 5 minutách
const CACHE_MS = 60 * 1000;      // přiřazení ID → kamera se hledá znovu po minutě
const MERENI_MS = 60 * 60 * 1000; // řádek s měřením do historie nejvýš jednou za hodinu
/** Příkazy serveru náramku (protokol hodinek / SeTracker; V48 dtto): jedno měření, poloha, vypnutí. */
// teplota: příkaz k okamžitému změření je bodytemp2 (Beesure/SeTracker); btemp2 je jen rámec, kterým náramek teplotu hlásí.
export const PRIKAZY = { tep: 'hrtstart,1', tlak: 'bphrt', kyslik: 'oxygen', teplota: 'bodytemp2', poloha: 'CR', vypnout: 'POWEROFF' };
/** „Změřit zdraví“: celá sada za sebou – hrtstart,1 (zapne snímač), tlak + tep, kyslík, teplota. */
export const MERENI_VSE = ['tlak', 'kyslik', 'teplota'];

/* ---------- rámce ---------- */

/**
 * Z bufferu vyřízne celé rámce. Vrací { ramce: [text bez hranatých závorek], zbytek: Buffer }.
 * Smetí před „[“ zahodí; rámec s délkou nad MAX_RAMEC nebo bez „]“ na konci zahodí také.
 */
export function vyrizniRamce(buf) {
  const ramce = [];
  let i = 0;
  for (;;) {
    const zac = buf.indexOf(0x5b, i);   // [
    if (zac < 0) return { ramce, zbytek: Buffer.alloc(0) };
    // hlavička: VÝROBCE*ID*(INDEX*)?DÉLKA*  – délka je vždy 4 hex číslice
    const hlav = hledejHlavicku(buf, zac);
    if (hlav === null) return { ramce, zbytek: buf.subarray(zac) };   // ještě nedošla celá hlavička
    if (hlav === false) { i = zac + 1; continue; }                      // není to rámec
    const konec = hlav.obsahOd + hlav.delka;
    if (hlav.delka > MAX_RAMEC) { i = zac + 1; continue; }
    if (buf.length < konec + 1) return { ramce, zbytek: buf.subarray(zac) };
    if (buf[konec] !== 0x5d) { i = zac + 1; continue; }                 // ]
    ramce.push({ vyrobce: hlav.vyrobce, id: hlav.id, index: hlav.index, obsah: buf.subarray(hlav.obsahOd, konec).toString('latin1') });
    i = konec + 1;
    if (i >= buf.length) return { ramce, zbytek: Buffer.alloc(0) };
  }
}

function hledejHlavicku(buf, zac) {
  // nejvýš 2 + 1 + 20 + 1 + 4 + 1 + 4 + 1 bajtů
  const kus = buf.subarray(zac + 1, Math.min(buf.length, zac + 48)).toString('latin1');
  const m = /^([A-Za-z0-9]{2})\*([A-Za-z0-9]{1,20})\*(?:([0-9A-Fa-f]{4})\*)?([0-9A-Fa-f]{4})\*/.exec(kus);
  if (!m) {
    // neúplná hlavička (ještě dojde), nebo smetí
    return /^[A-Za-z0-9*]*$/.test(kus) && kus.length < 40 && buf.length - zac < 48 ? null : false;
  }
  return { vyrobce: m[1], id: m[2], index: m[3] || null, delka: parseInt(m[4], 16), obsahOd: zac + 1 + m[0].length };
}

/** Odpověď zařízení ve stejném tvaru: [VÝROBCE*ID*(INDEX*)?DÉLKA*OBSAH]. */
export function slozRamec({ vyrobce, id, index }, obsah) {
  const delka = Buffer.byteLength(obsah, 'latin1').toString(16).toUpperCase().padStart(4, '0');
  return `[${vyrobce}*${id}*${index ? index + '*' : ''}${delka}*${obsah}]`;
}

/* ---------- obsah rámce ---------- */

/** Bity pole „status“ (šestnáctkově) – jako u hodinek SeTracker / Traccar watch. */
const BIT = { bateriePod: [0, 17], oblastVen: [1, 18], oblastDovnitr: [2, 19], rychlost: [3], sejmuti: [4, 20], sos: [16], pad: [21] };
const maBit = (status, bity) => bity.some((b) => (status / 2 ** b) % 2 >= 1);

/**
 * Rozebere obsah rámce → { typ, pole, poloha?, baterie?, status?, poplachy: [] }.
 * Poloha jen u UD/UD2/AL s platným fixem (A); baterie z LK (3. pole) nebo z polohy (13. pole).
 */
export function rozeberObsah(obsah) {
  const pole = obsah.split(',');
  const typ = pole[0].trim().toUpperCase();
  const out = { typ, pole: pole.slice(1), poloha: null, baterie: null, status: null, poplachy: [], zdravi: null };
  if (typ === 'LK') {
    const b = Number(pole[3]); if (Number.isFinite(b) && pole.length >= 4) out.baterie = b;
    return out;
  }
  // některý firmware posílá nouzové tlačítko jako samostatný typ (SOS / sos) bez polohy
  if (typ === 'SOS') { out.poplachy.push('sos'); return out; }
  // zdravotní měření (V48 a hodinky): bphrt = tlak horní, dolní, tep; heart = tep; oxygen = kyslík %; btemp2 = tělesná teplota
  const cisla = pole.slice(1).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (typ === 'BPHRT' && cisla.length >= 2) {
    out.zdravi = { tlakS: cisla[0], tlakD: cisla[1] };
    if (cisla[2] > 0) out.zdravi.tep = cisla[2];
    if (!(out.zdravi.tlakS > 0)) delete out.zdravi.tlakS;
    if (!(out.zdravi.tlakD > 0)) delete out.zdravi.tlakD;
  } else if ((typ === 'HEART' || typ === 'PULSE') && cisla[0] > 0) out.zdravi = { tep: cisla[0] };
  else if ((typ === 'OXYGEN' || typ === 'SPO2' || typ === 'BLOOD') && cisla.find((x) => x >= 50 && x <= 100)) out.zdravi = { spo2: cisla.find((x) => x >= 50 && x <= 100) };
  else if ((typ === 'BTEMP2' || typ === 'BTEMP' || typ === 'TEMP') && cisla.find((x) => x >= 30 && x <= 45)) out.zdravi = { teplota: cisla.find((x) => x >= 30 && x <= 45) };
  if (out.zdravi && !Object.keys(out.zdravi).length) out.zdravi = null;
  // UD, UD2, UD_LTE (poloha), AL, AL_LTE (poplach), WT – V48 (4G) posílá varianty s příponou _LTE
  if (jePolohovy(typ)) {
    // datum, čas, A/V, lat, N/S, lon, E/W, rychlost, kurz, výška, satelity, signál, baterie, kroky, převrácení, status
    const [datum, cas, platne, lat, ns, lon, ew, rychlost, , , , , baterie, , , status] = pole.slice(1);
    const la = Number(lat), lo = Number(lon);
    if (Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0)) {
      // A = GPS fix; V se souřadnicemi = poloha z mobilní sítě nebo poslední známá – přibližná, ale pro dispečink lepší než nic
      out.poloha = { lat: Math.abs(la) * (ns === 'S' ? -1 : 1), lon: Math.abs(lo) * (ew === 'W' ? -1 : 1), cas: casZ(datum, cas), rychlost: Number(rychlost) || 0, priblizna: platne !== 'A' };
    }
    const b = Number(baterie); if (Number.isFinite(b) && baterie !== undefined && baterie !== '') out.baterie = b;
    const st = parseInt(status, 16); out.status = Number.isFinite(st) ? st : null;
    const s = out.status || 0;
    if (maBit(s, BIT.pad)) out.poplachy.push('pad');
    if (maBit(s, BIT.sos) || (typ.startsWith('AL') && !out.poplachy.length && !maBit(s, BIT.bateriePod) && !maBit(s, BIT.sejmuti) && !maBit(s, BIT.oblastVen))) out.poplachy.push('sos');
    if (maBit(s, BIT.bateriePod)) out.poplachy.push('baterie');
    if (maBit(s, BIT.sejmuti)) out.poplachy.push('sejmuti');
    if (maBit(s, BIT.oblastVen)) out.poplachy.push('oblastVen');
  }
  return out;
}

function casZ(datum, cas) {
  // DDMMYY, HHMMSS v UTC
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(datum || ''), t = /^(\d{2})(\d{2})(\d{2})$/.exec(cas || '');
  if (!m || !t) return null;
  const ms = Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(t[1]), Number(t[2]), Number(t[3]));
  return Number.isFinite(ms) ? ms : null;
}

export const mapaOdkaz = (p) => p ? `https://maps.google.com/?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : '';
/** Text měření pro historii a dispečink: tep 72, tlak 122/75, kyslík 97 %, teplota 36,5 °C. */
export function popisZdravi(z) {
  if (!z) return '';
  const c = [];
  if (z.tep) c.push(`tep ${z.tep}`);
  if (z.tlakS && z.tlakD) c.push(`tlak ${z.tlakS}/${z.tlakD}`);
  if (z.spo2) c.push(`kyslík ${z.spo2} %`);
  if (z.teplota) c.push(`teplota ${String(z.teplota).replace('.', ',')} °C`);
  return c.join(', ');
}
/** Typy rámců s polohou: UD, UD2, UD_LTE, AL, AL_LTE, WT… */
export const jePolohovy = (typ) => /^(UD|AL|WT)/.test(typ);

/* ---------- server ---------- */

/**
 * createNaramky({ najemci, kamery, port, now, log })
 *   najemci.pro(tenant) → stav tenanta (stav(), proved(), naramek())
 *   kamery()            → kamery ze serveru (kvůli seznamu tenantů)
 */
export function createNaramky({ najemci, kamery, port = 5093, host = '0.0.0.0', now = Date.now, log = console, prodlevaMs = 1500, sluzba = null, sluzbaMs = 10 * 60 * 1000 } = {}) {
  const spojeni = new Set();
  const aktivni = new Map();       // id přívěsku → { socket, vyrobce, index, cas } – kudy mu poslat příkaz
  const posledniAuto = new Map();  // id → čas posledního automatického měření
  const sosPosilam = new Set();     // id → právě se posílají čísla SOS (ať se nepošlou dvakrát z rámců za sebou)
  const posledniSluzba = new Map(); // id → kdy se naposledy kontrolovalo číslo služby ('sluzba' ve slotu SOS)
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const cache = new Map();         // id přívěsku → { tenant, kameraId, do }
  const nezname = new Map();       // id → kdy naposledy zalogováno
  const posledniPoplach = new Map(); // id|druh → čas
  const posledniOzvani = new Map();  // id → { cas, baterie }
  let server = null;
  const stat = { prijato: 0, poplachy: 0, nezname: 0, posledni: null };

  async function tenanti() {
    const vse = await kamery().catch(() => []);
    return [...new Set(vse.map((k) => String(k.tenant || '').toUpperCase()).filter(Boolean))];
  }

  /** Ke kterému poskytovateli a kameře přívěsek patří (podle Naramek.id u kamery). */
  async function najdi(id) {
    const c = cache.get(id);
    if (c && c.do > now()) return c.hit;
    let hit = null;
    for (const t of await tenanti()) {
      try {
        const s = await najemci.pro(t);
        const st = await s.stav();
        const p = st.state.patients.find((x) => x.naramek && String(x.naramek.id) === id);
        if (p) { hit = { tenant: t, kameraId: p.id, stav: s }; break; }
      } catch (e) { log.error('[naramky]', t, 'stav tenanta:', e.message); }
    }
    cache.set(id, { hit, do: now() + CACHE_MS });
    return hit;
  }

  async function zpracuj(ramec, socket) {
    stat.prijato++; stat.posledni = now();
    aktivni.set(ramec.id, { socket, vyrobce: ramec.vyrobce, index: ramec.index, cas: now() });
    const r = rozeberObsah(ramec.obsah);
    // diagnostika: každý rámec jedním řádkem (u polohových typů bez souřadnic, u ostatních i obsah), ať jde doladit model
    const sPolohou = jePolohovy(r.typ);
    log.log(`[naramky] ${ramec.id} ${r.typ}${ramec.index ? ' #' + ramec.index : ''} stav=${r.status === null ? '-' : r.status.toString(16).padStart(8, '0')} baterie=${r.baterie ?? '-'} poloha=${r.poloha ? (r.poloha.priblizna ? 'přibližná' : 'GPS') : 'ne'} poplachy=${r.poplachy.join(',') || '-'}${r.zdravi ? ' zdravi=' + popisZdravi(r.zdravi) : ''}${sPolohou ? '' : ' obsah=' + ramec.obsah.slice(0, 80)}`);
    // potvrzení: LK, AL, TKQ – jinak zařízení poplach opakuje a ozvání považuje za ztracené
    const odpoved = r.typ === 'LK' || r.typ === 'TKQ' || r.typ === 'TKQ2' ? r.typ : r.typ.startsWith('AL') ? 'AL' : null;
    if (odpoved) { try { socket.write(slozRamec(ramec, odpoved)); } catch { /* spojení už není */ } }
    const kam = await najdi(ramec.id);
    if (!kam) {
      stat.nezname++;
      const kdy = nezname.get(ramec.id) || 0;
      if (now() - kdy > 60 * 60 * 1000) { nezname.set(ramec.id, now()); log.log(`[naramky] neznámý přívěsek ${ramec.id} (${r.typ}) – přiřaďte ho v dispečinku u kamery (Komunikace → Náramek / přívěsek).`); }
      return;
    }
    // čekající čísla SOS (setNaramekSos, když náramek nebyl připojený): poslat při prvním ozvání
    if (!sosPosilam.has(ramec.id)) {
      try {
        const n = (await kam.stav.stav()).state.patients.find((x) => x.id === kam.kameraId)?.naramek;
        if (n && Array.isArray(n.sos) && !n.sosOdeslano) {
          sosPosilam.add(ramec.id);
          try { const r = await prikaz(ramec.id, 'sos', { cislaSos: n.sos, tenant: kam.tenant }); await kam.stav.naramek({ kameraId: kam.kameraId, sosOdeslano: now(), sosOdeslaneCisla: r.cisla }); log.log(`[naramky] ${ramec.id} čísla SOS odeslána při ozvání`); }
          finally { sosPosilam.delete(ramec.id); }
        }
      } catch (e) { log.error('[naramky] čísla SOS:', e.message); }
    }
    // ozvání a baterie ke kameře (nejvýš jednou za 5 minut, při změně baterie nebo poloze hned)
    const oz = posledniOzvani.get(ramec.id);
    const zmena = !oz || now() - oz.cas > OZVANI_MS || (r.baterie !== null && r.baterie !== oz.baterie) || !!r.poloha;
    if (zmena) {
      posledniOzvani.set(ramec.id, { cas: now(), baterie: r.baterie ?? oz?.baterie ?? null });
      await kam.stav.naramek({ kameraId: kam.kameraId, posledni: now(), baterie: r.baterie, poloha: r.poloha }).catch((e) => log.error('[naramky] zápis ozvání:', e.message));
    }
    if (r.zdravi) {
      await kam.stav.naramek({ kameraId: kam.kameraId, posledni: now(), zdravi: r.zdravi }).catch((e) => log.error('[naramky] zápis měření:', e.message));
      // do historie kamery jednou za hodinu (jinak by pravidelné měření vytlačilo ostatní řádky); poslední hodnoty jsou vždy u kamery
      const klic = ramec.id + '|mereni';
      if (now() - (posledniPoplach.get(klic) || 0) >= MERENI_MS) {
        posledniPoplach.set(klic, now());
        try { await kam.stav.proved('emit', [kam.kameraId, 'mereni', { real: true, naramek: true, text: 'Měření náramku: ' + popisZdravi(r.zdravi) + '.' }]); }
        catch (e) { log.error('[naramky] měření se nezapsalo:', e.message); }
      }
    }
    for (const druh of r.poplachy) {
      const kind = { sos: 'sos', pad: 'devfall', baterie: 'battery' }[druh];
      if (!kind) continue;   // sejmutí a oblast jen do logu
      const klic = ramec.id + '|' + kind;
      if (now() - (posledniPoplach.get(klic) || 0) < DEDUP_MS) continue;
      posledniPoplach.set(klic, now());
      stat.poplachy++;
      const text = { sos: 'Přívěsek: stisknuto nouzové tlačítko', devfall: 'Přívěsek hlásí pád', battery: 'Přívěsek hlásí slabou baterii' }[kind]
        + (r.baterie !== null ? ` (baterie ${r.baterie} %)` : '') + (r.poloha ? ` · ${r.poloha.priblizna ? 'přibližná poloha' : 'poloha'} ${mapaOdkaz(r.poloha)}` : '') + '.';
      try {
        await kam.stav.proved('emit', [kam.kameraId, kind, { real: true, naramek: true, text }]);
        log.log(`[naramky] ${ramec.id} → ${kam.tenant} ${kam.kameraId}: ${kind}`);
      } catch (e) { log.error('[naramky] událost se nezapsala:', e.message); }
    }
    if (r.poplachy.includes('sejmuti') || r.poplachy.includes('oblastVen')) log.log(`[naramky] ${ramec.id}: ${r.poplachy.filter((x) => x === 'sejmuti' || x === 'oblastVen').join(', ')} (jen log)`);
  }

  function obsluz(socket) {
    spojeni.add(socket);
    let buf = Buffer.alloc(0);
    let fronta = Promise.resolve();
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.length > MAX_BUFFER) { socket.destroy(); return; }
      const { ramce, zbytek } = vyrizniRamce(buf);
      buf = Buffer.from(zbytek);
      for (const r of ramce) fronta = fronta.then(() => zpracuj(r, socket)).catch((e) => log.error('[naramky]', e.message));
    });
    socket.on('error', () => {});
    socket.on('close', () => { spojeni.delete(socket); for (const [id, a] of aktivni) if (a.socket === socket) aktivni.delete(id); });
  }

  /** Příkaz náramku: nazev z PRIKAZY, nebo 'vlastni' s textem (ladění modelu). Náramek musí být právě připojený. */
  /** Skutečná čísla pro náramek: 'sluzba' → číslo služby tenanta (chyba 400, když není nastavené), ostatní ověřená a bez mezer. */
  async function cislaSkutecna(tenant, cislaSos) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const c = String((cislaSos || [])[i] ?? '').replace(/[\s-]/g, '');
      if (c === 'sluzba') {
        if (!sluzba || !sluzba.nastaveno) throw chyba('Číslo služby není na serveru nastavené (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC).', 503);
        if (!tenant) throw chyba('Číslo služby: chybí tenant.', 400);
        const v = await sluzba.telefon(tenant);
        if (!v.telefon) throw chyba(`Číslo služby není v Péče doma nastavené${v.duvod ? ' (' + v.duvod + ')' : ''}.`, 400);
        out.push(v.telefon);
      } else {
        if (c && !/^\+?[0-9]{6,15}$/.test(c)) throw chyba('Číslo SOS: jen číslice, případně + na začátku.', 400);
        out.push(c);
      }
    }
    return out;
  }

  async function prikaz(id, nazev, { vlastni = '', bezPredtim = false, cislaSos = [], tenant = '' } = {}) {
    const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
    if (nazev === 'sos') {
      // čísla SOS: SOS1,číslo … SOS3,číslo (prázdné = smazat); zapsaná ve stavu kamery (setNaramekSos), sem už přijdou ověřená;
      // 'sluzba' = číslo služby poskytovatele (src/sluzba.mjs) – dosadí se tady, proto je potřeba tenant
      const a0 = aktivni.get(String(id));
      if (!a0 || a0.socket.destroyed) throw chyba('Náramek teď není připojený k serveru (ozývá se v intervalech; zkuste to za chvíli).', 409);
      const cisla = await cislaSkutecna(tenant, cislaSos);
      const poslano = [];
      for (let i = 0; i < 3; i++) {
        if (poslano.length) await new Promise((r) => setTimeout(r, prodlevaMs));
        const r = await prikaz(id, 'vlastni', { vlastni: `SOS${i + 1},${cisla[i]}` });
        poslano.push(r.obsah);
      }
      return { ok: true, obsah: poslano.join(' + '), cisla };
    }
    if (nazev === 'zdravi') {
      const a0 = aktivni.get(String(id));
      if (!a0 || a0.socket.destroyed) throw chyba('Náramek teď není připojený k serveru (ozývá se v intervalech; zkuste to za chvíli).', 409);
      const poslano = [];
      for (const k of MERENI_VSE) {
        if (poslano.length) await new Promise((r) => setTimeout(r, prodlevaMs));
        const r = await prikaz(id, k, { bezPredtim: poslano.length > 0 });
        if (r.predtim) poslano.push(r.predtim);
        poslano.push(r.obsah);
      }
      return { ok: true, obsah: poslano.join(' + ') };
    }
    let obsah = PRIKAZY[nazev];
    if (nazev === 'vlastni') {
      obsah = String(vlastni || '').trim();
      if (!/^[A-Za-z0-9_,.:+\- ]{1,60}$/.test(obsah)) throw chyba('Příkaz: 1 až 60 znaků (písmena, číslice, čárky, tečky), bez hranatých závorek a hvězdiček.', 400);
    }
    if (!obsah) throw chyba('Neznámý příkaz náramku (zdravi, sos, tep, tlak, kyslik, teplota, poloha, vypnout, vlastni).', 400);
    const a = aktivni.get(String(id));
    if (!a || a.socket.destroyed) throw chyba('Náramek teď není připojený k serveru (ozývá se v intervalech; zkuste to za chvíli).', 409);
    const posli = async (co) => {
      await new Promise((res, rej) => a.socket.write(slozRamec({ vyrobce: a.vyrobce, id: String(id), index: a.index }, co), 'latin1', (e) => (e ? rej(e) : res())));
      log.log(`[naramky] ${id} ← příkaz ${co}`);
    };
    // Měření tlaku, kyslíku a teploty vrací ReachFar V48 jen tehdy, když mu těsně předtím přišlo hrtstart,1
    // (zapne snímač); samotné bphrt/oxygen nechá bez odpovědi. Proto se posílá dvojice.
    const predtim = ['tlak', 'kyslik', 'teplota'].includes(nazev) && !bezPredtim ? PRIKAZY.tep : null;
    if (predtim) { await posli(predtim); await new Promise((r) => setTimeout(r, prodlevaMs)); }
    await posli(obsah);
    return { ok: true, obsah, ...(predtim ? { predtim } : {}) };
  }

  /** Automatické měření: u náramků s nastavením auto (min > 0) pošle zvolená měření, když uplynul interval a náramek je připojený. */
  async function tik() {
    let posl = 0;
    for (const t of await tenanti()) {
      let s, st;
      try { s = await najemci.pro(t); st = await s.stav(); } catch { continue; }
      for (const p of st.state.patients) {
        const n = p.naramek;
        // číslo služby ve slotu SOS: každých sluzbaMs porovnat s naposledy poslanými čísly a při změně poslat znovu
        if (n?.id && Array.isArray(n.sos) && n.sos.includes('sluzba') && n.sosOdeslano && sluzba?.nastaveno) {
          const a = aktivni.get(String(n.id));
          if (a && !a.socket.destroyed && now() - (posledniSluzba.get(n.id) || 0) >= sluzbaMs && !sosPosilam.has(String(n.id))) {
            posledniSluzba.set(n.id, now());
            try {
              const skut = await cislaSkutecna(t, n.sos);
              if (JSON.stringify(skut) !== JSON.stringify(n.sosOdeslaneCisla || null)) {
                sosPosilam.add(String(n.id));
                try { const r = await prikaz(n.id, 'sos', { cislaSos: n.sos, tenant: t }); await s.naramek({ kameraId: p.id, sosOdeslano: now(), sosOdeslaneCisla: r.cisla }); posl++; log.log(`[naramky] ${n.id} číslo služby se změnilo – čísla SOS poslána znovu: ${r.cisla.join(', ')}`); }
                finally { sosPosilam.delete(String(n.id)); }
              }
            } catch (e) { log.error('[naramky] číslo služby', n.id, e.message); }
          }
        }
        const auto = n?.auto;
        if (!n?.id || !auto || !(auto.min > 0)) continue;
        const a = aktivni.get(String(n.id)); if (!a || a.socket.destroyed) continue;
        if (now() - (posledniAuto.get(n.id) || 0) < auto.min * 60 * 1000) continue;
        posledniAuto.set(n.id, now());
        for (const k of ['zdravi', 'tep', 'tlak', 'kyslik', 'teplota']) {
          if (!auto[k] || (auto.zdravi && k !== 'zdravi')) continue;   // zdraví = celá sada, jednotlivé volby už nejsou třeba
          try { await prikaz(n.id, k); posl++; } catch (e) { log.error('[naramky] automatické měření', n.id, k, e.message); }
          await new Promise((r) => setTimeout(r, prodlevaMs));   // měření se nemají překrývat
        }
      }
    }
    return posl;
  }
  let autoTimer = null;

  return {
    get port() { return server ? server.address().port : port; },
    stav() { return { port: server ? server.address().port : null, spojeni: spojeni.size, pripojene: [...aktivni.keys()], ...stat }; },
    zapomen() { cache.clear(); },
    pripojen(id) { const a = aktivni.get(String(id)); return !!a && !a.socket.destroyed; },
    prikaz, tik,
    start({ autoMs = 60 * 1000 } = {}) {
      return new Promise((resolve, reject) => {
        server = net.createServer(obsluz);
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          if (autoMs > 0) { autoTimer = setInterval(() => tik().catch((e) => log.error('[naramky] automatické měření:', e.message)), autoMs); autoTimer.unref?.(); }
          resolve(server.address().port);
        });
      });
    },
    stop() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      for (const s of spojeni) s.destroy();
      return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server = null; });
    },
  };
}
