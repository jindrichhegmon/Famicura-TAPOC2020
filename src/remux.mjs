/**
 * Převod klipu z go2rtc (fragmentovaný MP4, bez délky v hlavičce) na obyčejný
 * MP4 s hlavičkou napřed (faststart) přes ffmpeg, bez překódování. Takový
 * soubor přehraje i Safari na iPhonu a po stažení každý přehrávač; ukazuje
 * správnou délku a jde v něm skákat. Bez ffmpeg (nebo při chybě) zůstane
 * původní soubor – jen se to zapíše do logu.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function createRemux({ ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', timeoutMs = 60000, log = console, now = Date.now } = {}) {
  let chybi = 0;   // čas, kdy ffmpeg nebyl k nalezení; zkusí se znovu za 10 minut
  return async function prevedNaMp4(data) {
    if (chybi && now() - chybi < 600000) return { data, prevedeno: false, duvod: 'ffmpeg není k dispozici' };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'famicura-mp4-'));
    const vystup = path.join(dir, 'klip.mp4');
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', vystup], { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg nestihl převod včas')); }, timeoutMs);
        p.stderr.on('data', (c) => { err += c; });
        p.on('error', (e) => { clearTimeout(t); if (e.code === 'ENOENT') chybi = now(); reject(e); });
        p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`ffmpeg skončil s kódem ${code}: ${err.trim().slice(0, 200)}`)); });
        p.stdin.on('error', () => {});   // ffmpeg může zavřít vstup dřív
        p.stdin.end(data);
      });
      const out = await readFile(vystup);
      if (out.length < 1024) throw new Error('převod dal prázdný soubor');
      return { data: out, prevedeno: true };
    } catch (e) {
      if (chybi === 0 || e.code !== 'ENOENT') log.error('[nahravky] převod na MP4 (ffmpeg) se nepodařil, ukládám původní soubor:', e.message);
      return { data, prevedeno: false, duvod: e.message };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
}
