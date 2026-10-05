/**
 * Zásobník obrazu před událostí: pro každou skutečnou kameru drží server
 * posledních pár sekund proudu z go2rtc (fMP4, jen obraz H.264, bez
 * překódování) v paměti. Nahrávka po události pak začíná PŘED ní (o
 * nastavený náběh), ne až ve chvíli, kdy ji server spustí.
 *
 * Proud `stream.mp4?src=X&video=h264` je posloupnost boxů: ftyp + moov
 * (inicializace) a pak moof + mdat (fragmenty, zhruba po snímku). Zásobník
 * fragmenty rozdělí, u každého pozná čas příchodu a jestli začíná klíčovým
 * snímkem, a drží jen posledních `maxS` sekund. Klip = inicializace +
 * fragmenty od posledního klíčového snímku před (teď − náběh) + fragmenty
 * dalších `poS` sekund; časy (tfdt) se přepíší, aby soubor začínal v nule a
 * přehrávač ho bral jako obyčejný krátký záznam (stejně jako klip s
 * duration= přímo z go2rtc).
 *
 * Kamera, která zrovna nejede, zásobník nemá: nahrávka pak jde postaru
 * (bez náběhu). Čtení běží trvale – kamera posílá obraz na server i bez
 * otevřeného prohlížeče (asi 1–2 Mbit/s na kameru přes tunel).
 */

const MIN_FRAG_S = 0.5;      // kratší zásobník nemá smysl

/** Projde boxy v bufferu [od, do) → [{ type, od, do, hl }] (hl = délka hlavičky 8 nebo 16). */
export function boxy(buf, od = 0, konec = buf.length) {
  const out = [];
  let i = od;
  while (i + 8 <= konec) {
    let size = buf.readUInt32BE(i), hl = 8;
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size === 1) { if (i + 16 > konec) break; size = Number(buf.readBigUInt64BE(i + 8)); hl = 16; }
    else if (size === 0) size = konec - i;
    if (size < hl || i + size > konec) break;
    out.push({ type, od: i, do: i + size, hl });
    i += size;
  }
  return out;
}

/** Z moof: pozice tfdt (verze, offset hodnoty) a jestli první vzorek je klíčový snímek. */
export function rozeberMoof(moof) {
  let tfdt = null, klic = true;
  for (const traf of boxy(moof, 8).filter((b) => b.type === 'traf')) {
    let defFlags = null, prvni = null;
    for (const b of boxy(moof, traf.od + traf.hl, traf.do)) {
      if (b.type === 'tfhd') {
        const flags = moof.readUInt32BE(b.od + 8) & 0xFFFFFF;
        let p = b.od + 16;            // po verzi/flags a track_ID
        if (flags & 0x1) p += 8;      // base_data_offset
        if (flags & 0x2) p += 4;      // sample_description_index
        if (flags & 0x8) p += 4;      // default_sample_duration
        if (flags & 0x10) p += 4;     // default_sample_size
        if (flags & 0x20) defFlags = moof.readUInt32BE(p);
      } else if (b.type === 'tfdt') {
        tfdt = { verze: moof[b.od + 8], pozice: b.od + 12 };
      } else if (b.type === 'trun' && prvni === null) {
        const flags = moof.readUInt32BE(b.od + 8) & 0xFFFFFF;
        let p = b.od + 16;            // po verzi/flags a sample_count
        if (flags & 0x1) p += 4;      // data_offset
        if (flags & 0x4) prvni = moof.readUInt32BE(p);               // first_sample_flags
        else if (flags & 0x400) { if (flags & 0x100) p += 4; if (flags & 0x200) p += 4; prvni = moof.readUInt32BE(p); } // flags prvního vzorku
      }
    }
    const f = prvni !== null ? prvni : defFlags;
    if (f !== null && f !== undefined) klic = (f & 0x10000) === 0;   // sample_is_non_sync_sample
    break;   // jeden track (video=h264)
  }
  return { tfdt, klic };
}

const ctiTfdt = (moof, t) => t.verze === 1 ? Number(moof.readBigUInt64BE(t.pozice)) : moof.readUInt32BE(t.pozice);
const pisTfdt = (moof, t, v) => { if (t.verze === 1) moof.writeBigUInt64BE(BigInt(Math.max(0, v)), t.pozice); else moof.writeUInt32BE(Math.max(0, v) >>> 0, t.pozice); };

/**
 * Rozdělovač proudu na boxy: krmí se kusy (feed), volá onInit(buffer) po ftyp+moov a
 * onFragment({ moof, mdat }) po každé dvojici moof+mdat.
 */
export function createRozdelovac({ onInit, onFragment }) {
  let zbytek = Buffer.alloc(0), init = [], moof = null, hotovoInit = false;
  return {
    feed(chunk) {
      zbytek = zbytek.length ? Buffer.concat([zbytek, chunk]) : Buffer.from(chunk);
      let i = 0;
      while (i + 8 <= zbytek.length) {
        let size = zbytek.readUInt32BE(i), hl = 8;
        if (size === 1) { if (i + 16 > zbytek.length) break; size = Number(zbytek.readBigUInt64BE(i + 8)); hl = 16; }
        if (size < hl) throw new Error('poškozený proud MP4');
        if (i + size > zbytek.length) break;
        const type = zbytek.toString('latin1', i + 4, i + 8);
        const box = Buffer.from(zbytek.subarray(i, i + size));   // kopie: zbytek se znovu alokuje
        if (!hotovoInit) {
          init.push(box);
          if (type === 'moov') { hotovoInit = true; onInit(Buffer.concat(init)); init = []; }
        } else if (type === 'moof') moof = box;
        else if (type === 'mdat' && moof) { onFragment({ moof, mdat: box }); moof = null; }
        i += size;
      }
      zbytek = i ? Buffer.from(zbytek.subarray(i)) : zbytek;
    },
  };
}

export function createZasobnik({ go2rtc, kamery = async () => [], maxS = 12, now = Date.now, log = console, fetchImpl = null } = {}) {
  const ctecky = new Map();   // id → { init, frag: [{ t, moof, mdat, klic, tfdt }], ctrl, bezi, chyba, posluchaci:Set, od }
  const vsechny = (id) => ctecky.get(id);

  function orez(c) {
    const hranice = now() - Math.max(MIN_FRAG_S, maxS) * 1000;
    while (c.frag.length > 1 && c.frag[0].t < hranice) c.frag.shift();
  }

  async function cti(id) {
    const c = ctecky.get(id); if (!c || c.stop) return;
    const ctrl = new AbortController(); c.ctrl = ctrl;
    try {
      const r = await go2rtc.proxy(`/api/stream.mp4?src=${encodeURIComponent(id)}&video=h264`, { signal: ctrl.signal });
      const roz = createRozdelovac({
        onInit(buf) { c.init = buf; c.frag = []; c.bezi = true; c.od = now(); c.chyba = null; c.pokus = 0; log.log(`[zasobnik] ${id}: obraz jede, držím posledních ${maxS} s`); },
        onFragment({ moof, mdat }) {
          const { tfdt, klic } = rozeberMoof(moof);
          const f = { t: now(), moof, mdat, klic, tfdt };
          c.frag.push(f); orez(c);
          for (const p of c.posluchaci) p(f);
        },
      });
      for await (const chunk of r.body) { if (c.stop) break; roz.feed(chunk); }
      if (!c.stop) throw new Error('proud skončil');
    } catch (e) {
      if (c.stop) return;
      c.bezi = false; c.chyba = e.message; c.pokus = (c.pokus || 0) + 1;
      const za = Math.min(30000, 2000 * c.pokus);
      if (c.pokus <= 2 || c.pokus % 10 === 0) log.error(`[zasobnik] ${id}: ${e.message} – znovu za ${Math.round(za / 1000)} s`);
      c.timer = setTimeout(() => cti(id), za);
      return;
    }
    if (!c.stop) { c.bezi = false; c.timer = setTimeout(() => cti(id), 2000); }
  }

  function zacni(id) {
    if (ctecky.has(id)) return;
    ctecky.set(id, { init: null, frag: [], bezi: false, chyba: null, posluchaci: new Set(), pokus: 0, stop: false });
    cti(id);
  }
  function skonci(id) {
    const c = ctecky.get(id); if (!c) return;
    c.stop = true; clearTimeout(c.timer); c.ctrl?.abort(); ctecky.delete(id);
  }

  let smycka = null;
  async function srovnej() {
    const chci = new Set((await kamery().catch(() => [])).filter((k) => k.tenant).map((k) => k.id));
    for (const id of chci) zacni(id);
    for (const id of [...ctecky.keys()]) if (!chci.has(id)) skonci(id);
  }

  return {
    /** Začne číst všechny kamery s tenantem; každých `kazdychMs` srovná seznam podle cameras.json. */
    async start(kazdychMs = 15000) { await srovnej(); if (!smycka) smycka = setInterval(() => srovnej().catch(() => {}), kazdychMs); },
    stop() { clearInterval(smycka); smycka = null; for (const id of [...ctecky.keys()]) skonci(id); },
    bezi(id) { const c = vsechny(id); return !!(c && c.bezi && c.init && c.frag.length); },
    /** Stav pro diagnostiku: { id: { bezi, sekund, fragmentu, chyba } } */
    stav() {
      const out = {};
      for (const [id, c] of ctecky) out[id] = { bezi: !!c.bezi, sekund: c.frag.length ? Math.round((c.frag[c.frag.length - 1].t - c.frag[0].t) / 100) / 10 : 0, fragmentu: c.frag.length, chyba: c.chyba };
      return out;
    },
    /**
     * Klip: náběh `predS` sekund ze zásobníku (od posledního klíčového snímku před tím okamžikem)
     * a dalších `poS` sekund, jak přicházejí. → { data, zacatek (ms), predS (skutečný náběh v s) }
     */
    klip(id, { predS = 5, poS = 15, cekaniMs = 20000 } = {}) {
      const c = vsechny(id);
      if (!c || !c.bezi || !c.init) return Promise.reject(Object.assign(new Error('Zásobník obrazu kamery neběží.'), { status: 503 }));
      const ted = now();
      const hranice = ted - Math.max(0, predS) * 1000;
      let od = c.frag.findIndex((f) => f.t >= hranice);
      if (od < 0) od = c.frag.length - 1;
      while (od > 0 && !c.frag[od].klic) od--;                      // zpět ke klíčovému snímku
      if (!c.frag[od].klic) { const dal = c.frag.findIndex((f, i) => i >= od && f.klic); if (dal >= 0) od = dal; }
      const vybrane = c.frag.slice(od);
      const konec = ted + Math.max(1, poS) * 1000;
      return new Promise((resolve, reject) => {
        let hotovo = false, hlidac = null, limit = null;
        const uklid = () => { c.posluchaci.delete(posl); clearTimeout(limit); clearTimeout(hlidac); };
        const sestav = () => {
          if (hotovo) return; hotovo = true; uklid();
          if (!vybrane.length) { reject(Object.assign(new Error('Kamera za tu dobu neposlala obraz.'), { status: 502 })); return; }
          const zaklad = vybrane[0].tfdt ? ctiTfdt(vybrane[0].moof, vybrane[0].tfdt) : 0;
          const casti = [c.init];
          for (const f of vybrane) {
            const moof = Buffer.from(f.moof);
            if (f.tfdt) pisTfdt(moof, f.tfdt, ctiTfdt(f.moof, f.tfdt) - zaklad);
            casti.push(moof, f.mdat);
          }
          resolve({ data: Buffer.concat(casti), zacatek: vybrane[0].t, predS: Math.round((ted - vybrane[0].t) / 100) / 10 });
        };
        const selhani = (e) => { if (hotovo) return; hotovo = true; uklid(); reject(e); };
        // nic nepřišlo cekaniMs: když už máme aspoň pár sekund po události, uzavřít, co je; jinak chyba
        const obnovHlidac = () => { clearTimeout(hlidac); hlidac = setTimeout(() => { if (now() >= ted + 2000) sestav(); else selhani(Object.assign(new Error('Kamera neposlala obraz včas.'), { status: 504 })); }, cekaniMs); };
        const posl = (f) => { vybrane.push(f); obnovHlidac(); if (now() >= konec) sestav(); };
        c.posluchaci.add(posl);
        limit = setTimeout(sestav, konec - ted + 500);
        obnovHlidac();
      });
    },
  };
}
