/**
 * Tiché notifikace Apple (APNs) pro aplikaci „PéčeDoma Prsten“ na iPhonu.
 *
 * iOS nepustí aplikaci, aby si sama běžela každých 15 minut. Server ji proto
 * v pravidelném intervalu „ťukne“ tichou notifikací (content-available, bez
 * textu a zvuku – uživatel nic nevidí). iOS aplikaci na ~30 s probudí, ta si
 * z prstenu stáhne historii tepu a kroky a pošle je sem.
 *
 * Přihlášení k APNs klíčem .p8 (token-based auth): JWT ES256 podepsané klíčem
 * z developer.apple.com → Keys. Klíč leží jen na VPS (APNS_KEY_FILE, výchozí
 * data/apns-klic.p8, práva 600) – nahrává ho deploy/vps-apns.sh, do gitu nikdy.
 *
 *   APNS_KEY_ID   ID klíče (10 znaků, je i v názvu souboru AuthKey_XXXXXXXXXX.p8)
 *   APNS_TEAM_ID  Team ID účtu Apple Developer (10 znaků)
 *   APNS_TOPIC    Bundle ID aplikace (výchozí cz.pecedoma.prsten)
 */
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HOSTY = { produkce: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const b64u = (b) => Buffer.from(b).toString('base64url');

/** JWT pro APNs (ES256, podpis ve formátu r||s). */
export function jwtApns({ klic, keyId, teamId, cas = Date.now() }) {
  const hlavicka = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const telo = b64u(JSON.stringify({ iss: teamId, iat: Math.floor(cas / 1000) }));
  const podpis = crypto.sign('sha256', Buffer.from(`${hlavicka}.${telo}`), { key: klic, dsaEncoding: 'ieee-p1363' });
  return `${hlavicka}.${telo}.${b64u(podpis)}`;
}

/** Výchozí přenos: HTTP/2 spojení na APNs (jedno na prostředí, při chybě se založí znovu). */
function createHttp2() {
  const spojeni = new Map();
  const sezeni = (host) => {
    let s = spojeni.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(host);
    s.on('error', () => spojeni.delete(host));
    s.on('close', () => spojeni.delete(host));
    s.on('goaway', () => spojeni.delete(host));
    s.setTimeout(10 * 60_000, () => s.close());    // nečinné spojení po 10 minutách zavřít
    spojeni.set(host, s);
    return s;
  };
  return function posli(host, hlavicky, telo) {
    return new Promise((ok) => {
      let req;
      try { req = sezeni(host).request(hlavicky); }
      catch (e) { ok({ status: 0, reason: e.message }); return; }
      let status = 0, data = '';
      const limit = setTimeout(() => { req.close(); ok({ status: 0, reason: 'vypršel čas' }); }, 15_000);
      req.setEncoding('utf8');
      req.on('response', (h) => { status = Number(h[':status']) || 0; });
      req.on('data', (c) => { data += c; });
      req.on('end', () => { clearTimeout(limit); let reason = ''; try { reason = JSON.parse(data).reason || ''; } catch { /* prázdné tělo = úspěch */ } ok({ status, reason }); });
      req.on('error', (e) => { clearTimeout(limit); ok({ status: 0, reason: e.message }); });
      req.end(telo);
    });
  };
}

export function createApns({ keyId = process.env.APNS_KEY_ID || '', teamId = process.env.APNS_TEAM_ID || '', topic = process.env.APNS_TOPIC || 'cz.pecedoma.prsten',
  klic = null, souborKlice = process.env.APNS_KEY_FILE || '', root = process.cwd(), prenos = null, now = Date.now, log = console } = {}) {
  if (!klic && keyId && teamId) {
    const soubor = path.resolve(root, souborKlice || 'data/apns-klic.p8');
    try { klic = crypto.createPrivateKey(readFileSync(soubor, 'utf8')); }
    catch (e) { log.warn?.(`[famicura-tapo] [apns] klíč ${soubor} nejde načíst (${e.code || e.message}) – probouzení aplikace Prsten je vypnuté`); }
  } else if (klic && typeof klic === 'string') klic = crypto.createPrivateKey(klic);
  const nastaveno = !!(klic && keyId && teamId && topic);
  let jwt = '', jwtCas = 0;
  const token = () => {   // Apple chce nový JWT nejdřív po 20 a nejpozději po 60 minutách
    if (!jwt || now() - jwtCas > 40 * 60_000) { jwtCas = now(); jwt = jwtApns({ klic, keyId, teamId, cas: jwtCas }); }
    return jwt;
  };
  const posliHttp = prenos || (nastaveno ? createHttp2() : null);
  return {
    nastaveno, topic,
    /** Tichá notifikace na zařízení; vrací { ok, status, reason }. prostredi: 'produkce' (ad hoc) | 'sandbox' (spuštění z Xcode). */
    async probud(deviceToken, prostredi = 'produkce') {
      if (!nastaveno) return { ok: false, status: 0, reason: 'APNs není nastavené' };
      const host = HOSTY[prostredi] || HOSTY.produkce;
      const r = await posliHttp(host, {
        ':method': 'POST', ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token()}`, 'apns-topic': topic, 'apns-push-type': 'background', 'apns-priority': '5',
        'apns-expiration': String(Math.floor(now() / 1000) + 15 * 60), 'content-type': 'application/json',
      }, JSON.stringify({ aps: { 'content-available': 1 } }));
      if (r.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(r.reason)) jwt = '';
      return { ok: r.status === 200, status: r.status, reason: r.reason || '' };
    },
  };
}
