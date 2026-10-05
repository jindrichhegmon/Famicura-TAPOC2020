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
import { spawn } from 'node:child_process';
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

/** Detektor MoveNet přes TensorFlow.js (CPU). Model z disku (modelDir), při prvním použití stažený z MODEL_URL. */
export async function vytvorDetektorMoveNet({ modelDir, log = console, fetchImpl = fetch } = {}) {
  const tf = await import('@tensorflow/tfjs');
  const pd = await import('@tensorflow-models/pose-detection');
  await tf.setBackend('cpu'); await tf.ready();
  await mkdir(modelDir, { recursive: true });
  const cesta = path.join(modelDir, 'movenet-lightning.json');
  let model;
  try { model = JSON.parse(await readFile(cesta, 'utf8')); }
  catch {
    log.log('[kostra] stahuji model MoveNet (jednou):', MODEL_URL);
    const r = await fetchImpl(MODEL_URL); if (!r.ok) throw new Error(`model MoveNet se nepodařilo stáhnout (${r.status}); nastavte KOSTRA_MODEL_URL nebo soubor ${cesta}`);
    const json = await r.json();
    const zaklad = (r.url || MODEL_URL).replace(/\?.*$/, '').replace(/model\.json$/, '');
    const vahy = [];
    for (const m of json.weightsManifest) for (const pth of m.paths) {
      const rr = await fetchImpl(zaklad + pth + (MODEL_URL.includes('tfjs-format=file') ? '?tfjs-format=file' : '')); if (!rr.ok) throw new Error(`váhy modelu ${pth}: ${rr.status}`);
      vahy.push(Buffer.from(await rr.arrayBuffer()));
    }
    model = { modelTopology: json.modelTopology, weightSpecs: json.weightsManifest.flatMap((m) => m.weights), weightData: Buffer.concat(vahy).toString('base64'), format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy };
    await writeFile(cesta, JSON.stringify(model));
    log.log('[kostra] model uložen do', cesta);
  }
  const vahyBuf = Buffer.from(model.weightData, 'base64');
  const io = { load: async () => ({ modelTopology: model.modelTopology, weightSpecs: model.weightSpecs, weightData: vahyBuf.buffer.slice(vahyBuf.byteOffset, vahyBuf.byteOffset + vahyBuf.byteLength), format: model.format, generatedBy: model.generatedBy, convertedBy: model.convertedBy }) };
  const det = await pd.createDetector(pd.SupportedModels.MoveNet, { modelType: pd.movenet.modelType.SINGLEPOSE_LIGHTNING, modelUrl: io });
  return {
    nazev: 'movenet17',
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

export function createKostra({ modelDir = path.join(process.env.DATA_DIR || 'data', 'modely'), detektor = null, ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', fps = 5, log = console, now = Date.now } = {}) {
  let detPromise = null;
  const det = () => { if (!detPromise) { detPromise = (detektor ? Promise.resolve(detektor) : vytvorDetektorMoveNet({ modelDir, log })).catch((e) => { detPromise = null; throw e; }); } return detPromise; };
  return {
    /** Připraví model dopředu (při startu serveru), aby první nahrávka nečekala na stažení. */
    async priprav() { try { await det(); return true; } catch (e) { log.error('[kostra] model není k dispozici:', e.message); return false; } },
    get pripraveno() { return !!detPromise; },
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
  };
}
