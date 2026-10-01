/**
 * Přihlášení: podepsaná cookie. Heslo Famicura (poskytovatel) platí 12 hodin,
 * uživatel rodiny (telefon + vlastní heslo, src/uzivatele.mjs) 30 dní.
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

// Cookie: "<expiresAt>.<subjekt>.<podpis>". Subjekt je "admin" (heslo Famicura,
// hlavní aplikace a dispečink) nebo "r:<id>" (uživatel rodiny, aplikace rodiny).
// Starší cookie bez subjektu ("<expiresAt>.<podpis>") platí jako admin, aby
// nasazení nikoho neodhlásilo.
const TTL_RODINA_MS = 30 * 24 * 60 * 60 * 1000;   // telefon: přihlášení jednou za měsíc

function podpis(expiresAt, subjekt = null) {
  const zprava = subjekt === null ? `famicura-tapo:${expiresAt}` : `famicura-tapo:${expiresAt}:${subjekt}`;
  return crypto.createHmac('sha256', klic()).update(zprava, 'utf8').digest('base64url');
}

export function shodne(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function setCookie(expiresAt, subjekt, maxAgeS) {
  return `${COOKIE}=${expiresAt}.${subjekt}.${podpis(expiresAt, subjekt)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/** Hodnota pro hlavičku Set-Cookie po úspěšném přihlášení heslem Famicura. */
export function cookie(now = Date.now()) {
  return setCookie(now + TTL_MS, 'admin', TTL_MS / 1000);
}

/** Totéž pro uživatele rodiny (id z uzivatele.mjs). */
export function cookieRodina(id, now = Date.now()) {
  if (!/^[a-z0-9]{1,40}$/.test(id)) throw new Error('Neplatné id uživatele.');
  return setCookie(now + TTL_RODINA_MS, `r:${id}`, TTL_RODINA_MS / 1000);
}

/** Odhlášení: cookie se smaže. */
export function odhlaseni() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Kdo je přihlášen: { role: 'admin' } | { role: 'rodina', id } | null. */
export function kdo(headers) {
  const raw = headers.get ? (headers.get('cookie') || '') : (headers.cookie || '');
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;

  const casti = decodeURIComponent(m[1]).split('.');
  const expiresAt = casti[0];
  if (!expiresAt || !Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
  try {
    if (casti.length === 2) return shodne(podpis(expiresAt), casti[1]) ? { role: 'admin' } : null;
    if (casti.length !== 3) return null;
    const [, subjekt, signature] = casti;
    if (!shodne(podpis(expiresAt, subjekt), signature)) return null;
    if (subjekt === 'admin') return { role: 'admin' };
    if (subjekt.startsWith('r:') && /^[a-z0-9]{1,40}$/.test(subjekt.slice(2))) return { role: 'rodina', id: subjekt.slice(2) };
    return null;
  } catch { return null; }
}

/** Přihlášen heslem Famicura (hlavní aplikace, dispečink). */
export function prihlasen(headers) {
  return kdo(headers)?.role === 'admin';
}

/** Heslo porovnané v konstantním čase; bez nastaveného hesla se nepřihlásí nikdo. */
export function hesloSedi(heslo) {
  const spravne = process.env.FAMICURA_PASSWORD || '';
  return !!spravne && shodne(heslo, spravne);
}
