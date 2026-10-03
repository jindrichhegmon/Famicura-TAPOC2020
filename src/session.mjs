/**
 * Přihlášení: podepsaná cookie. Kdo je přihlášen a u kterého tenanta
 * (poskytovatele) se pozná z jejího subjektu:
 *
 *   admin              správce serveru heslem Famicura (hlavní aplikace: kamery, tunel, diagnostika)
 *   a:<TENANT>         správce serveru, který si v odkazu zvolil tenanta (?tenant=…): vidí jeho dispečink
 *   d:<TENANT>:<uid>:<jméno base64url>   dispečer – uživatel tenanta z Péče doma plus (A_MSPPP_UzivatelSestra, přes jhn-apps)
 *   r:<TENANT>:<id>    uživatel rodiny (telefon + heslo, src/uzivatele.mjs)
 *
 * SESSION_KEY podepisuje cookie a FAMICURA_PASSWORD je heslo správce; obojí
 * je jen v .env na VPS. Cookie je HttpOnly a Secure, stránka i API běží na
 * jedné adrese, takže nikam jinam neputuje. Správce a dispečer platí 12 hodin,
 * rodina na telefonu 30 dní.
 */
import crypto from 'node:crypto';
import { normTenant } from './tabulky.mjs';

const COOKIE = 'fam_tapo';
const TTL_MS = 12 * 60 * 60 * 1000;
const TTL_RODINA_MS = 30 * 24 * 60 * 60 * 1000;   // telefon: přihlášení jednou za měsíc
const ID_RE = /^[a-z0-9]{1,40}$/;

function klic() {
  const key = process.env.SESSION_KEY;
  if (!key) throw new Error('Chybí SESSION_KEY.');
  return key;
}

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

/** Správce serveru heslem Famicura; s tenantem, když si ho zvolil (dispečink toho tenanta). */
export function cookie(now = Date.now(), tenant = '') {
  const t = normTenant(tenant);
  return setCookie(now + TTL_MS, t ? `a:${t}` : 'admin', TTL_MS / 1000);
}

/** Dispečer tenanta (uživatel Péče doma plus). Jméno jde do cookie (base64url), aby se zapisovalo k alertům a poznámkám. */
export function cookieDispecer(tenant, uid, jmeno, now = Date.now()) {
  const t = normTenant(tenant); if (!t) throw new Error('Neplatný tenant.');
  const u = String(uid ?? '0'); if (!/^[0-9a-z]{1,20}$/i.test(u)) throw new Error('Neplatné id uživatele.');
  const j = Buffer.from(String(jmeno || '').slice(0, 80), 'utf8').toString('base64url');
  return setCookie(now + TTL_MS, `d:${t}:${u}:${j}`, TTL_MS / 1000);
}

/** Uživatel rodiny (id z uzivatele.mjs) u svého tenanta. */
export function cookieRodina(tenant, id, now = Date.now()) {
  const t = normTenant(tenant); if (!t) throw new Error('Neplatný tenant.');
  if (!ID_RE.test(id)) throw new Error('Neplatné id uživatele.');
  return setCookie(now + TTL_RODINA_MS, `r:${t}:${id}`, TTL_RODINA_MS / 1000);
}

/** Odhlášení: cookie se smaže. */
export function odhlaseni() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Kdo je přihlášen: { role: 'admin', tenant: '' | ID } | { role: 'dispecer', tenant, id, jmeno }
 * | { role: 'rodina', tenant, id } | null.
 */
export function kdo(headers) {
  const raw = headers.get ? (headers.get('cookie') || '') : (headers.cookie || '');
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;

  const hodnota = decodeURIComponent(m[1]);
  const prvni = hodnota.indexOf('.'), posledni = hodnota.lastIndexOf('.');
  if (prvni < 0 || posledni <= prvni) {
    // starší dvoudílná cookie ("<expiresAt>.<podpis>") platí jako správce
    const [expiresAt, signature] = hodnota.split('.');
    if (!expiresAt || !Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
    try { return shodne(podpis(expiresAt), signature) ? { role: 'admin', tenant: '' } : null; } catch { return null; }
  }
  const expiresAt = hodnota.slice(0, prvni), subjekt = hodnota.slice(prvni + 1, posledni), signature = hodnota.slice(posledni + 1);
  if (!expiresAt || !Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
  try {
    if (!shodne(podpis(expiresAt, subjekt), signature)) return null;
    if (subjekt === 'admin') return { role: 'admin', tenant: '' };
    const c = subjekt.split(':');
    if (c[0] === 'a' && c.length === 2 && normTenant(c[1])) return { role: 'admin', tenant: normTenant(c[1]) };
    if (c[0] === 'd' && c.length === 4 && normTenant(c[1]) && /^[0-9a-z]{1,20}$/i.test(c[2])) return { role: 'dispecer', tenant: normTenant(c[1]), id: c[2], jmeno: Buffer.from(c[3], 'base64url').toString('utf8') };
    if (c[0] === 'r' && c.length === 3 && normTenant(c[1]) && ID_RE.test(c[2])) return { role: 'rodina', tenant: normTenant(c[1]), id: c[2] };
    return null;
  } catch { return null; }
}

/** Přihlášen heslem Famicura (hlavní aplikace: nastavení serveru). */
export function prihlasen(headers) {
  return kdo(headers)?.role === 'admin';
}

/** Smí do dispečinku tenanta: dispečer tenanta, nebo správce serveru se zvoleným tenantem. */
export function dispecinkTenanta(headers) {
  const k = kdo(headers);
  if (!k) return null;
  if (k.role === 'dispecer') return k;
  if (k.role === 'admin' && k.tenant) return { ...k, jmeno: 'Správce' };
  return null;
}

/** Heslo porovnané v konstantním čase; bez nastaveného hesla se nepřihlásí nikdo. */
export function hesloSedi(heslo) {
  const spravne = process.env.FAMICURA_PASSWORD || '';
  return !!spravne && shodne(heslo, spravne);
}
