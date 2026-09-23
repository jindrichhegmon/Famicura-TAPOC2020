/**
 * Přihlášení heslem Famicura: podepsaná cookie, platná 12 hodin.
 *
 * SESSION_KEY podepisuje cookie a FAMICURA_PASSWORD je heslo; obojí je jen
 * v .env na VPS. Cookie je HttpOnly a Secure, stránka i API běží na jedné
 * adrese, takže nikam jinam neputuje.
 */
import crypto from 'node:crypto';

const COOKIE = 'fam_tapo';
const TTL_MS = 12 * 60 * 60 * 1000;

function klic() {
  const key = process.env.SESSION_KEY;
  if (!key) throw new Error('Chybí SESSION_KEY.');
  return key;
}

function podpis(expiresAt) {
  return crypto.createHmac('sha256', klic()).update(`famicura-tapo:${expiresAt}`, 'utf8').digest('base64url');
}

export function shodne(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

/** Hodnota pro hlavičku Set-Cookie po úspěšném přihlášení. */
export function cookie(now = Date.now()) {
  const expiresAt = now + TTL_MS;
  return `${COOKIE}=${expiresAt}.${podpis(expiresAt)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_MS / 1000}`;
}

export function prihlasen(headers) {
  const raw = headers.get ? (headers.get('cookie') || '') : (headers.cookie || '');
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;

  const [expiresAt, signature] = decodeURIComponent(m[1]).split('.');
  if (!expiresAt || !signature) return false;
  if (!Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return false;

  try { return shodne(podpis(expiresAt), signature); } catch { return false; }
}

/** Heslo porovnané v konstantním čase; bez nastaveného hesla se nepřihlásí nikdo. */
export function hesloSedi(heslo) {
  const spravne = process.env.FAMICURA_PASSWORD || '';
  return !!spravne && shodne(heslo, spravne);
}
