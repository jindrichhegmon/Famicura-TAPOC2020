#!/usr/bin/env node
/**
 * Ověření drátěného modelu na serveru: stáhne (poprvé) model MoveNet, z daného MP4 vytáhne
 * snímky přes ffmpeg a vypíše, na kolika snímcích našel postavu a jak dlouho to trvalo.
 *
 *   node scripts/kostra-test.mjs cesta/ke/klipu.mp4 [vystup.json]
 *
 * Bez souboru si vyrobí zkušební klip přes ffmpeg (testsrc, bez postavy) – ověří jen model a ffmpeg.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createKostra } from '../src/kostra.mjs';

const [vstup, vystup] = process.argv.slice(2);
const data = vstup ? await readFile(vstup) : execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
const k = createKostra({ modelDir: path.join(process.env.DATA_DIR || 'data', 'modely') });
const t0 = Date.now();
console.log('připravuji model…'); if (!(await k.priprav())) process.exit(1);
console.log(`model připraven za ${Date.now() - t0} ms; zpracovávám ${vstup || 'zkušební klip'} (${Math.round(data.length / 1024)} kB)…`);
const t1 = Date.now();
const out = await k.zKlipu(data);
const j = JSON.parse(out.toString());
console.log(`hotovo za ${Date.now() - t1} ms: ${j.snimku} snímků, postava na ${j.sPostavou}, ${Math.round(out.length / 1024)} kB JSON`);
if (vystup) { await writeFile(vystup, out); console.log('uloženo', vystup); }
