/**
 * Nahrávka jako drátěný model: z klipu (MP4) server vytáhne snímky přes
 * ffmpeg (5 za sekundu, 320×180), na každém najde postavu modelem MoveNet
 * (TensorFlow.js, 17 klíčových bodů) a uloží jen souřadnice kostry – žádný
 * obraz. Použije se, když rodina povolila jen rozostření nebo drátěný model:
 * plný obraz existuje jen pár sekund v paměti serveru při zpracování.
 *
 * Výstup: { typ: 'kostra', model: 'movenet17', w, h, fps, delkaS, snimky: [{ t, b: [[x, y, s], …17] }] }
 * (x, y v rozsahu 0–1, s = jistota bodu). Aplikace to přehraje jako animaci
 * (public/proto/kostra.js).
 *
 * Model se při prvním použití stáhne do `modelDir` (DATA_DIR/modely) a dál
 * čte z disku. `detektor` jde podstrčit (testy, jiný model).
 */
import { spawn, fork } from 'node:child_process';
import os from 'node:os';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const SIRKA = 320, VYSKA = 180;
export const MODEL_URL = process.env.KOSTRA_MODEL_URL || 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4/model.json?tfjs-format=file';
/** Spoje mezi 17 body MoveNet (COCO): nos, oči, uši, ramena, lokty, zápěstí, boky, kolena, kotníky. */
export const SPOJE = [[0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];

/** Snímky z MP4 přes ffmpeg: rawvideo RGB 320×180, fps za sekundu → [{ t (ms), rgb: Buffer }]. */
export function snimkyZKlipu(data, { ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', fps = 5, maxSnimku = 200, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', `fps=${fps},scale=${SIRKA}:${VYSKA}:force_original_aspect_ratio=decrease,pad=${SIRKA}:${VYSKA}:(ow-iw)/2:(oh-ih)/2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const velikost = SIRKA * VYSKA * 3;
    const out = []; let zbytek = Buffer.alloc(0), err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg nestihl snímky včas')); }, timeoutMs);
    p.stdout.on('data', (c) => {
      zbytek = zbytek.length ? Buffer.concat([zbytek, c]) : c;
      while (zbytek.length >= velikost) {
        if (out.length < maxSnimku) out.push({ t: Math.round(out.length * 1000 / fps), rgb: Buffer.from(zbytek.subarray(0, velikost)) });
        zbytek = zbytek.subarray(velikost);
      }
    });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0 || out.length) resolve(out); else reject(new Error(`ffmpeg skončil s kódem ${code}: ${err.trim().slice(0, 200)}`)); });
    p.stdin.on('error', () => {});
    p.stdin.end(data);
  });
}

/**
 * Nejrychlejší dostupný výpočet TensorFlow: nativní tfjs-node (libtensorflow, snímek za desítky ms),
 * jinak WebAssembly (jednotky set ms), jinak čistý JavaScript (asi sekunda na snímek).
 * KOSTRA_BACKEND=tensorflow|wasm|cpu vynutí jeden z nich. → název backendu
 */
export async function vyberBackend(tf, log = console) {
  const chce = process.env.KOSTRA_BACKEND || '';
  if (!process.env.TF_CPP_MIN_LOG_LEVEL) process.env.TF_CPP_MIN_LOG_LEVEL = '2';   // libtensorflow: jen varování a chyby
  const pokusy = [];
  if (!chce || chce === 'tensorflow') pokusy.push(['tensorflow', () => import('@tensorflow/tfjs-node')]);
  if (!chce || chce === 'wasm') pokusy.push(['wasm', () => import('@tensorflow/tfjs-backend-wasm')]);
  for (const [nazev, nacti] of pokusy) {
    try { await nacti(); if (await tf.setBackend(nazev)) { await tf.ready(); return nazev; } }
    catch (e) { log.log(`[kostra] backend ${nazev} není k dispozici (${String(e.message || e).split('\n')[0].slice(0, 120)})`); }
  }
  await tf.setBackend('cpu'); await tf.ready(); return 'cpu';
}

/** Detektor MoveNet přes TensorFlow.js. Model z disku (modelDir), při prvním použití stažený z MODEL_URL. */
export async function vytvorDetektorMoveNet({ modelDir, log = console, fetchImpl = fetch } = {}) {
  const tf = await import('@tensorflow/tfjs');
  const pd = await import('@tensorflow-models/pose-detection');
  const backend = await vyberBackend(tf, log);
  await mkdir(modelDir, { recursive: true });
  const cesta = path.join(modelDir, 'movenet-lightning.json');
  let model;
  try { model = JSON.parse(await readFile(cesta, 'utf8')); }
  catch {
    log.log('[kostra] stahuji model MoveNet (jednou):', MODEL_URL);
    const r = await fetchImpl(MODEL_URL); if (!r.ok) throw new Error(`model MoveNet se nepodařilo stáhnout (${r.status}); nastavte KOSTRA_MODEL_URL nebo soubor ${cesta}`);
    const json = await r.json();
    // Váhy stejně jako TensorFlow.js: z PŮVODNÍ adresy (složka model.json) + stejný dotaz (?tfjs-format=file u tfhub).
    // Adresa po přesměrování (r.url) bývá podepsaná jen pro model.json, na váhy vrací 403; zkusí se až jako záloha.
    const dotaz = MODEL_URL.includes('?') ? MODEL_URL.slice(MODEL_URL.indexOf('?')) : '';
    const zaklady = [...new Set([MODEL_URL, r.url || MODEL_URL].map((u) => u.replace(/\?.*$/, '').replace(/[^/]*$/, '')))];
    const vahy = [];
    for (const m of json.weightsManifest) for (const pth of m.paths) {
      let rr = null, posledni = '';
      for (const z of zaklady) {
        rr = await fetchImpl(z + pth + dotaz).catch((e) => ({ ok: false, status: e.message }));
        if (rr.ok) break;
        posledni = `${z}${pth}${dotaz} → ${rr.status}`;
      }
      if (!rr || !rr.ok) throw new Error(`váhy modelu ${pth} se nepodařilo stáhnout (${posledni}); nastavte KOSTRA_MODEL_URL, nebo na server nahrajte hotový soubor ${cesta}`);
      vahy.push(Buffer.from(await rr.arrayBuffer()));
    }
    model = { modelTopology: json.modelTopology, weightSpecs: json.weightsManifest.flatMap((m) => m.weights), weightData: Buffer.concat(vahy).toString('base64'), format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy };
    await writeFile(cesta, JSON.stringify(model));
    log.log('[kostra] model uložen do', cesta);
  }
  const vahyBuf = Buffer.from(model.weightData, 'base64');
  const io = { load: async () => ({ modelTopology: model.modelTopology, weightSpecs: model.weightSpecs, weightData: vahyBuf.buffer.slice(vahyBuf.byteOffset, vahyBuf.byteOffset + vahyBuf.byteLength), format: model.format, generatedBy: model.generatedBy, convertedBy: model.convertedBy }) };
  const det = await pd.createDetector(pd.SupportedModels.MoveNet, { modelType: pd.movenet.modelType.SINGLEPOSE_LIGHTNING, modelUrl: io });
  log.log('[kostra] výpočet:', backend);
  return {
    nazev: 'movenet17', backend,
    /** rgb (Buffer 320×180×3) → [[x, y, s] ×17] v 0–1, nebo null bez postavy */
    async body(rgb) {
      const img = tf.tensor3d(new Int32Array(rgb), [VYSKA, SIRKA, 3], 'int32');
      try {
        const poses = await det.estimatePoses(img);
        const p = poses[0]; if (!p || !p.keypoints) return null;
        const b = p.keypoints.map((k) => [Math.round(k.x / SIRKA * 1000) / 1000, Math.round(k.y / VYSKA * 1000) / 1000, Math.round((k.score || 0) * 100) / 100]);
        return b.some((k) => k[2] >= 0.3) ? b : null;
      } finally { img.dispose(); }
    },
  };
}

/**
 * Výpočet v samostatném procesu (src/kostra-proces.mjs): hlavní vlákno serveru zůstává volné pro obraz a API.
 * Proces se spustí při priprav() nebo první nahrávce, model drží načtený; po pádu se spustí znovu při dalším použití.
 */
function createKostraProces({ modelDir, log, timeoutMs = 180000 }) {
  let dite = null, pripraven = false, vypocetNazev = null, nid = 0;
  const cekaji = new Map();
  function start() {
    if (dite) return dite;
    const d = fork(new URL('./kostra-proces.mjs', import.meta.url), [], { env: { ...process.env, KOSTRA_MODEL_DIR: modelDir }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    dite = d; pripraven = false;
    d.on('message', (m) => {
      if (!m) return;
      if (m.log) { log.log(m.log); return; }
      if (m.chybaLog) { log.error(m.chybaLog); return; }
      const c = cekaji.get(m.id); if (c) { cekaji.delete(m.id); c(m); }
    });
    d.on('error', (e) => log.error('[kostra] proces:', e.message));
    d.on('exit', (code, signal) => {
      if (dite === d) { dite = null; pripraven = false; }
      for (const c of cekaji.values()) c({ ok: false, chyba: `proces drátěného modelu skončil (${signal || code})`, status: 503 });
      cekaji.clear();
    });
    try { os.setPriority(d.pid, 10); } catch { /* bez nižší priority */ }
    return d;
  }
  function posli(zprava, ms) {
    return new Promise((resolve) => {
      const id = ++nid; const d = start();
      const t = setTimeout(() => { cekaji.delete(id); resolve({ ok: false, chyba: `drátěný model: vypršel čas (${Math.round(ms / 1000)} s)`, status: 503 }); if (dite === d) d.kill(); }, ms);
      cekaji.set(id, (m) => { clearTimeout(t); resolve(m); });
      try { d.send({ ...zprava, id }); } catch (e) { clearTimeout(t); cekaji.delete(id); resolve({ ok: false, chyba: e.message, status: 503 }); }
    });
  }
  const priprav = async () => {
    if (pripraven) return true;
    const r = await posli({ akce: 'priprav' }, 300000);
    pripraven = !!r.ok; vypocetNazev = r.vypocet || null;
    if (!r.ok) log.error('[kostra] model není k dispozici:', r.chyba || 'proces neodpověděl');
    return pripraven;
  };
  return {
    priprav,
    get pripraveno() { return pripraven; },
    async vypocet() { return vypocetNazev; },
    async zKlipu(data, { delkaS = null } = {}) {
      if (!(await priprav())) throw Object.assign(new Error('Drátěný model není na serveru k dispozici (ffmpeg a model MoveNet).'), { status: 503 });
      const r = await posli({ akce: 'zKlipu', data, delkaS }, timeoutMs);
      if (!r.ok) throw Object.assign(new Error(r.chyba || 'drátěný model se nepodařilo spočítat'), { status: r.status || 502 });
      return Buffer.from(r.out);
    },
    /** Ukončí pomocný proces (testy, vypnutí serveru). */
    stop() { if (dite) { const d = dite; dite = null; pripraven = false; d.kill(); } },
  };
}

export function createKostra({ modelDir = path.join(process.env.DATA_DIR || 'data', 'modely'), detektor = null, ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', fps = 5, log = console, now = Date.now, proces = !detektor } = {}) {
  if (proces) return createKostraProces({ modelDir, log });
  let detPromise = null;
  const det = () => { if (!detPromise) { detPromise = (detektor ? Promise.resolve(detektor) : vytvorDetektorMoveNet({ modelDir, log })).catch((e) => { detPromise = null; throw e; }); } return detPromise; };
  return {
    /** Připraví model dopředu (při startu serveru), aby první nahrávka nečekala na stažení. */
    async priprav() { try { await det(); return true; } catch (e) { log.error('[kostra] model není k dispozici:', e.message); return false; } },
    get pripraveno() { return !!detPromise; },
    /** Název výpočtu (tensorflow | wasm | cpu | fake17…), až je model připravený; jinak null. */
    async vypocet() { try { const d = await det(); return d.backend || d.nazev || null; } catch { return null; } },
    /** MP4 → data kostry (JSON jako Buffer) + statistika. Vyhodí chybu, když model nebo ffmpeg nejsou. */
    async zKlipu(data, { delkaS = null } = {}) {
      const t0 = now();
      const d = await det();
      const snimky = await snimkyZKlipu(data, { ffmpeg, fps });
      if (!snimky.length) throw Object.assign(new Error('Z klipu nešly vytáhnout snímky.'), { status: 502 });
      const out = [];
      let sPostavou = 0;
      for (const s of snimky) { const b = await d.body(s.rgb); if (b) sPostavou++; out.push({ t: s.t, b }); }
      const vysledek = { typ: 'kostra', model: d.nazev, w: SIRKA, h: VYSKA, fps, delkaS: delkaS ?? Math.round(snimky.length / fps), snimku: snimky.length, sPostavou, spoje: SPOJE, snimky: out };
      log.log(`[kostra] ${snimky.length} snímků, postava na ${sPostavou}, ${now() - t0} ms`);
      return Buffer.from(JSON.stringify(vysledek));
    },
    stop() { /* v hlavním vlákně není co ukončit */ },
  };
}
