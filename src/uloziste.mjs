/**
 * Úložiště nahrávek na serveru (VPS): soubory v DATA_DIR/nahravky/<tenant>/<id>.enc,
 * šifrované AES-256-GCM klíčem serveru NAHRAVKY_KLIC (.env, generuje
 * ./deploy/vps-env.sh; 32 bajtů base64url nebo hex). Bez klíče se na server
 * neukládá. Formát souboru: „FKN1“ + iv (12 B) + značka (16 B) + šifrovaný obsah.
 *
 * Nahrávka z prohlížeče zůstává v režimu, ve kterém byla pořízena (rozostřená
 * zůstane rozostřená); přehrává ji jen aplikace s kontrolou přístupu
 * (src/api.mjs, GET /api/nahravky/:id/soubor) a každé přehrání jde do auditu.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = Buffer.from('FKN1');
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const TENANT_RE = /^[A-Z0-9]{4,16}$/;

/** Klíč z proměnné prostředí: base64url (43 znaků) nebo hex (64 znaků) → Buffer 32 B, jinak null. */
export function klicZTextu(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try { const b = Buffer.from(s, 'base64url'); return b.length === 32 ? b : null; } catch { return null; }
}

export function zasifruj(klic, data) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', klic, iv);
  const sifr = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), sifr]);
}
export function desifruj(klic, soubor) {
  if (soubor.length < 32 || !soubor.subarray(0, 4).equals(MAGIC)) throw Object.assign(new Error('Soubor nahrávky má neznámý formát.'), { status: 500 });
  const d = createDecipheriv('aes-256-gcm', klic, soubor.subarray(4, 16));
  d.setAuthTag(soubor.subarray(16, 32));
  return Buffer.concat([d.update(soubor.subarray(32)), d.final()]);
}

export function createUloziste({ dir, klic = klicZTextu(process.env.NAHRAVKY_KLIC), log = console } = {}) {
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const over = (tenant, id) => {
    if (!TENANT_RE.test(String(tenant || ''))) throw chyba('Neplatný tenant.', 400);
    if (!ID_RE.test(String(id || ''))) throw chyba('Neplatné id nahrávky.', 400);
  };
  const cesta = (tenant, id) => path.join(dir, tenant, id + '.enc');
  return {
    get nastaveno() { return !!(klic && dir); },
    dir,
    /** Uloží šifrovaně → { soubor: 'TENANT/id.enc', velikost }. */
    async uloz(tenant, id, data) {
      if (!klic) throw chyba('Úložiště na serveru není nastavené (NAHRAVKY_KLIC, ./deploy/vps-env.sh).', 503);
      over(tenant, id);
      await mkdir(path.join(dir, tenant), { recursive: true, mode: 0o700 });
      const s = zasifruj(klic, data);
      await writeFile(cesta(tenant, id), s, { mode: 0o600 });
      return { soubor: `${tenant}/${id}.enc`, velikost: data.length };
    },
    /** Přečte a dešifruje → Buffer; 404 když soubor není. */
    async cti(tenant, id) {
      if (!klic) throw chyba('Úložiště na serveru není nastavené (NAHRAVKY_KLIC).', 503);
      over(tenant, id);
      let s;
      try { s = await readFile(cesta(tenant, id)); }
      catch (e) { if (e.code === 'ENOENT') throw chyba('Soubor nahrávky na serveru už není.', 404); throw e; }
      return desifruj(klic, s);
    },
    /** Smaže soubor (chybějící soubor nevadí). */
    async smaz(tenant, id) {
      over(tenant, id);
      try { await unlink(cesta(tenant, id)); return true; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },
  };
}
