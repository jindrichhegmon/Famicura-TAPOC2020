/**
 * Samostatný server (bez Netlify): obsluhuje /api a servíruje public/.
 * Určeno pro VPS s pevnou IP adresou, kterou firewall SQL Serveru pouští.
 *   node server.mjs            (čte .env ve složce aplikace; PORT, HOST viz .env.example)
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* .env bez závislosti na knihovně: KEY=value, řádky s # se přeskakují, proměnné z prostředí mají přednost */
try {
  const env = await readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch { /* .env není – použijí se proměnné prostředí */ }

/* verze serveru: package.json + verze.json (zapisuje deploy/vps-deploy.sh: commit, větev, čas nasazení) */
try {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  process.env.APP_VERZE = pkg.version || '';
  try {
    const v = JSON.parse(await readFile(path.join(ROOT, 'verze.json'), 'utf8'));
    process.env.APP_COMMIT = v.commit || ''; process.env.APP_VETEV = v.vetev || ''; process.env.APP_NASAZENO = v.nasazeno || '';
  } catch { /* bez verze.json (lokální běh) */ }
} catch { /* bez package.json */ }
process.env.APP_SPUSTENO = new Date().toISOString();

const { createHandler } = await import('./src/api.mjs');
const { dbs } = await import('./src/db.mjs');
const { createGo2rtc } = await import('./src/go2rtc.mjs');
const { createStore } = await import('./src/store.mjs');
const { BEZPECNOSTNI_HLAVICKY } = await import('./src/csp.mjs');
const { createCameraEvents } = await import('./src/udalosti-kamer.mjs');
const { kdo } = await import('./src/session.mjs');
const store = createStore(process.env.DATA_DIR || path.join(ROOT, 'data'));

// The camera's own detections: the server subscribes to each camera in
// cameras.json (the same account go2rtc uses) and writes them to CLB1 itself.
const KAMERY = process.env.CAMERAS_FILE || path.join(ROOT, 'cameras.json');
const udalosti = createCameraEvents({ store, dbs, kamery: async () => {
  try { return JSON.parse(await readFile(KAMERY, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
} });
udalosti.start().catch((e) => console.error('[famicura-tapo] události kamer:', e.message));
// pm2 stops with SIGINT: cancel the subscriptions, the camera keeps only a few.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { udalosti.stop().finally(() => process.exit(0)); });

// Častá záměna při vps-env.sh: adresa asistenta v SMS_WEBHOOK_URL → SMS mlčky nedojdou. Řekni to hned při startu.
if (process.env.SMS_WEBHOOK_URL && process.env.SMS_WEBHOOK_URL === process.env.ASISTENT_WEBHOOK_URL) {
  console.error('[famicura-tapo] POZOR: SMS_WEBHOOK_URL je stejná jako ASISTENT_WEBHOOK_URL – SMS jdou do scénáře asistenta a nedojdou. Opravte ./deploy/vps-env.sh (scénář Famicura_Tapo_SMS_Pozvanka).');
}
const handle = createHandler({ dbs, go2rtc: createGo2rtc(), store, udalosti });

// An SDP offer or a CLB1 row is a few kB; anything far bigger is not ours.
const MAX_BODY = 256 * 1024;

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Příliš velký požadavek'); return; }
        chunks.push(c);
      }
      // A live picture over HTTPS is one long answer: it is passed on as it
      // comes and cut off when the viewer leaves, never gathered in memory.
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, signal: ctrl.signal,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) { res.end(); return; }
      await pipeline(Readable.fromWeb(r.body), res).catch(() => res.destroy());
      return;
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    // Krátký odkaz z SMS s pozvánkou (/r/<token>): aplikace rodiny, o 30 znaků kratší SMS.
    const mr = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{10,100})$/);
    if (mr) { res.writeHead(302, { Location: `/proto/rodina.html?pozvanka=${mr[1]}`, 'Cache-Control': 'no-store' }); res.end(); return; }
    let file = path.join(PUBLIC, rel === '' ? 'index.html' : rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    // Dispečink a provoz jen po přihlášení poskytovatele: bez něj jde místo
    // stránky přihlášení (stejná adresa, po přihlášení se načte znovu).
    if (/^proto[/\\](dispecink|provoz)\.html$/.test(rel) && kdo(req.headers)?.role !== 'admin') file = path.join(PUBLIC, 'proto', 'prihlaseni.html');
    // A folder (/proto/) serves its index.html, like any web server.
    if (await stat(file).then((st) => st.isDirectory(), () => false)) file = path.join(file, 'index.html');
    const data = await readFile(file);
    // The login page is on the open internet: no framing, no sniffing, and a
    // CSP that keeps the browser from talking to anyone but us (src/csp.mjs).
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      ...BEZPECNOSTNI_HLAVICKY });
    res.end(data);
  } catch (e) {
    if (e && e.code === 'ENOENT') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nenalezeno'); }
    else { console.error('[famicura-ring]', e); res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Chyba serveru'); }
  }
});

const port = Number(process.env.PORT || 3112);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Famicura Tapo běží na http://${host}:${port}  (go2rtc ${process.env.GO2RTC_URL || 'http://127.0.0.1:1984'}, CLB1 ${process.env.SQL_SERVER || '?'})`));
