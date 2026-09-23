/**
 * Úprava .env na VPS bez toho, aby tajná hodnota prošla příkazovou řádkou.
 * Volá ho deploy/vps-env.sh z Macu; běží na VPS jako jhnapps:
 *
 *   node scripts/set-env.mjs stav                 → které klíče jsou vyplněné (bez hodnot)
 *   node scripts/set-env.mjs nastav KLIC  < hodnota
 *   node scripts/set-env.mjs prevezmi KLIC /opt/jina-aplikace/.env
 *   node scripts/set-env.mjs generuj KLIC          → náhodná hodnota, jen když je prázdný
 *
 * "prevezmi" kopíruje jen tehdy, když druhá aplikace míří na stejný SQL
 * server a stejného uživatele – jinak by heslo patřilo někomu jinému.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOUBOR = path.join(ROOT, '.env');
const POVINNE = ['SQL_SERVER', 'SQL_USER', 'SQL_PASSWORD', 'FAMICURA_PASSWORD', 'SESSION_KEY'];

const RADEK = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

/** Hodnota klíče tak, jak ji přečte server.mjs (bez uvozovek kolem). */
export function hodnota(text, klic) {
  for (const line of text.split(/\r?\n/)) {
    const m = RADEK.exec(line);
    if (m && !line.trim().startsWith('#') && m[1] === klic) return m[2].replace(/^"(.*)"$/, '$1');
  }
  return '';
}

/** Přepíše první výskyt klíče, nebo ho přidá na konec. Ostatní řádky nechá být. */
export function nastavit(text, klic, val) {
  if (!/^[A-Z0-9_]+$/.test(klic)) throw new Error('Neplatný název klíče.');
  if (/[\r\n]/.test(val)) throw new Error('Hodnota nesmí obsahovat konec řádku.');
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => { const m = RADEK.exec(l); return m && !l.trim().startsWith('#') && m[1] === klic; });
  if (i >= 0) lines[i] = `${klic}=${val}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${klic}=${val}`, '');
  }
  return lines.join('\n');
}

function precti(f) {
  if (!existsSync(f)) throw new Error(`Soubor ${f} neexistuje.`);
  return readFileSync(f, 'utf8');
}

// writeFileSync do existujícího souboru zachová vlastníka i práva 600.
function zapis(text) { writeFileSync(SOUBOR, text, { mode: 0o600 }); }

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main([akce, klic, zdroj]) {
  if (akce === 'stav') {
    const text = precti(SOUBOR);
    for (const k of POVINNE) console.log(`${k.padEnd(18)} ${hodnota(text, k) ? 'vyplněno' : 'PRÁZDNÉ'}`);
    return;
  }

  if (akce === 'nastav') {
    const val = await stdin();
    if (!val) throw new Error(`Prázdná hodnota – ${klic} nechávám beze změny.`);
    zapis(nastavit(precti(SOUBOR), klic, val));
    console.log(`${klic}: nastaveno.`);
    return;
  }

  if (akce === 'prevezmi') {
    const nas = precti(SOUBOR);
    const cizi = precti(zdroj);
    for (const k of ['SQL_SERVER', 'SQL_USER']) {
      if (hodnota(nas, k) !== hodnota(cizi, k)) {
        throw new Error(`${zdroj} má jiné ${k} (${hodnota(cizi, k) || 'prázdné'} ≠ ${hodnota(nas, k) || 'prázdné'}) – nekopíruji.`);
      }
    }
    const val = hodnota(cizi, klic);
    if (!val) throw new Error(`${klic} je prázdné i v ${zdroj}.`);
    zapis(nastavit(nas, klic, val));
    console.log(`${klic}: převzato z ${zdroj}.`);
    return;
  }

  if (akce === 'generuj') {
    // A signing key nobody has to know: made here, never leaves the server.
    // An existing one is kept, or everybody would be logged out on every run.
    const text = precti(SOUBOR);
    if (hodnota(text, klic)) { console.log(`${klic}: už je nastaven, ponechávám.`); return; }
    zapis(nastavit(text, klic, crypto.randomBytes(32).toString('base64url')));
    console.log(`${klic}: vygenerován.`);
    return;
  }

  throw new Error('Použití: stav | nastav KLIC | prevezmi KLIC /cesta/.env | generuj KLIC');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
