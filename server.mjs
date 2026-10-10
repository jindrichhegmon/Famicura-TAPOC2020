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
const { kdo, dispecinkTenanta } = await import('./src/session.mjs');
const { normTenant } = await import('./src/tabulky.mjs');
const { createPdp } = await import('./src/pdp.mjs');
const { createNajemci } = await import('./src/najemci.mjs');
const { createUzivatele } = await import('./src/uzivatele.mjs');
const { createSms } = await import('./src/sms.mjs');
const { createUpozorneni } = await import('./src/upozorneni.mjs');
const { createDisk } = await import('./src/disk.mjs');
const { createSluzba } = await import('./src/sluzba.mjs');
const { createNahravky } = await import('./src/nahravky.mjs');
const { createUloziste } = await import('./src/uloziste.mjs');
const { createPtz } = await import('./src/ptz.mjs');
const zaznamy = await import('./src/zaznamy.mjs');
const store = createStore(process.env.DATA_DIR || path.join(ROOT, 'data'));

// The camera's own detections: the server subscribes to each camera in
// cameras.json (the same account go2rtc uses) and writes them to CLB1 itself.
const KAMERY = process.env.CAMERAS_FILE || path.join(ROOT, 'cameras.json');
const nactiKamery = async () => {
  try { return JSON.parse(await readFile(KAMERY, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const udalosti = createCameraEvents({ store, dbs, kamery: nactiKamery });
udalosti.start().catch((e) => console.error('[famicura-tapo] události kamer:', e.message));
// pm2 stops with SIGINT: cancel the subscriptions, the camera keeps only a few.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { globalThis.__zasobnik?.stop(); } catch { /* nic */ } udalosti.stop().finally(() => process.exit(0)); });

// Častá záměna při vps-env.sh: adresa asistenta v SMS_WEBHOOK_URL → SMS mlčky nedojdou. Řekni to hned při startu.
if (process.env.SMS_WEBHOOK_URL && process.env.SMS_WEBHOOK_URL === process.env.ASISTENT_WEBHOOK_URL) {
  console.error('[famicura-tapo] POZOR: SMS_WEBHOOK_URL je stejná jako ASISTENT_WEBHOOK_URL – SMS jdou do scénáře asistenta a nedojdou. Opravte ./deploy/vps-env.sh (scénář Famicura_Tapo_SMS_Pozvanka).');
}
// Data poskytovatelů: databáze PeceDomaPlus (tenanti jako v Péče doma plus). Bez ní
// jede jen hlavní aplikace a ukázka v prohlížeči; dispečink a rodina dostanou 503.
const pdp = createPdp();
if (!pdp.nastaveno) console.error('[famicura-tapo] POZOR: PeceDomaPlus není nastavená (PDP_SQL_PASSWORD) – dispečink a aplikace rodiny nepoběží, jen ukázka. Spusťte ./deploy/vps-env.sh.');
else pdp.zajistiTabulky().catch((e) => console.error('[famicura-tapo] tabulky PeceDomaPlus:', e.message));
const kameryTenanty = async () => (await nactiKamery()).map((k) => ({ id: k.id, name: k.name || k.id, tenant: k.tenant || '', place: k.place || '' }));
const sms = createSms();
const go2rtc = createGo2rtc();
// Nahrávky na Google Disk poskytovatele (účet z Péče doma plus přes jhn-apps); bez klíče jen hlásí, že nejsou nastavené.
const disk = createDisk();
const sluzba = createSluzba();   // číslo služby poskytovatele pro náramky SOS (jhn-apps)
if (!disk.nastaveno) console.error('[famicura-tapo] Nahrávky na Google Disk nejsou nastavené (JHN_APPS_TOKEN, FAMICURA_KAMERA_KLIC) – spusťte ./deploy/vps-env.sh.');
// Úložiště nahrávek na serveru: šifrované soubory v DATA_DIR/nahravky (klíč NAHRAVKY_KLIC). Pojistka disku: NAHRAVKY_MIN_VOLNE_GB (výchozí 5).
const uloziste = createUloziste({ dir: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'nahravky') });
if (!uloziste.nastaveno) console.error('[famicura-tapo] Úložiště nahrávek na serveru není nastavené (NAHRAVKY_KLIC) – spusťte ./deploy/vps-env.sh.');
// Zásobník obrazu před událostí: server čte proud každé kamery s tenantem a drží posledních NAHRAVKY_NABEH_S sekund (0 = vypnuto).
const { createZasobnik } = await import('./src/zasobnik.mjs');
const NABEH_S = process.env.NAHRAVKY_NABEH_S === undefined ? 12 : Number(process.env.NAHRAVKY_NABEH_S) || 0;
const zasobnik = pdp.nastaveno && NABEH_S > 0 ? createZasobnik({ go2rtc, kamery: kameryTenanty, maxS: NABEH_S }) : null;
globalThis.__zasobnik = zasobnik;
if (zasobnik) setTimeout(() => zasobnik.start().catch((e) => console.error('[famicura-tapo] zásobník obrazu:', e.message)), 5000);
const { createRemux } = await import('./src/remux.mjs');
const nahravky = pdp.nastaveno ? createNahravky({ go2rtc, disk, uloziste, tabulky: pdp.tabulky, kamery: kameryTenanty, zapisClb: (row) => zaznamy.zapsat(dbs, row), zasobnik, remux: createRemux() }) : null;
// Automatické mazání nahrávek na serveru po době uchování (⚙ dispečinku): každou hodinu, poprvé po startu.
if (nahravky) { const promaz = () => nahravky.promaz().catch((e) => console.error('[famicura-tapo] mazání nahrávek:', e.message)); setTimeout(promaz, 60 * 1000); setInterval(promaz, 60 * 60 * 1000); }
const uzivatele = pdp.nastaveno ? createUzivatele(pdp.tabulky) : null;
const najemci = createNajemci({ pdp, kamery: kameryTenanty, udalosti, upozorni: createUpozorneni({ sms, sluzba, uzivatele }), nahravky });
// Události kamer zpracovává server sám každé 2 s (zápis, SMS, e-mail, nahrávka), i když nikdo nemá otevřený dispečink.
if (pdp.nastaveno) najemci.start(2000);
const ptz = createPtz({ kamery: nactiKamery });
// Světlo kamery (Tapo C320WS/C520WS/C560WS…) přes místní rozhraní Tapo, HTTPS 443 tunelem – stejné účty z cameras.json.
const { createSvetlo } = await import('./src/svetlo.mjs');
const svetlo = createSvetlo({ kamery: nactiKamery });
// Náramky a přívěsky SOS (ReachFar V48 a další s protokolem hodinek) se připojují mobilními daty přímo sem: TCP port NARAMKY_PORT (výchozí 5093, 0 = vypnuto).
const { createNaramky } = await import('./src/naramky.mjs');
const NARAMKY_PORT = process.env.NARAMKY_PORT === undefined ? 5093 : Number(process.env.NARAMKY_PORT) || 0;
const naramky = pdp.nastaveno && NARAMKY_PORT > 0 ? createNaramky({ najemci, kamery: kameryTenanty, port: NARAMKY_PORT, sluzba }) : null;
if (naramky) naramky.start().then((p) => console.log(`[famicura-tapo] náramky a přívěsky: poslouchám na TCP ${p}`)).catch((e) => console.error('[famicura-tapo] náramky:', e.message));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { naramky?.stop().catch(() => {}); });
// Správa kamer z hlavní aplikace (zavedení, poskytovatel, světlo, smazání) – zapisuje cameras.json, go2rtc.yaml a CAMERA_NAMES bez restartu.
const { createSpravaKamer } = await import('./src/sprava-kamer.mjs');
const sprava = createSpravaKamer({ root: ROOT, soubor: KAMERY, go2rtc, udalosti, svetlo });
const handle = createHandler({ dbs, go2rtc, store, udalosti, pdp, najemci, uzivatele: uzivatele || undefined, sms, kameryTenanty, disk, nahravky, ptz, svetlo, zasobnik, naramky, sluzba, sprava });

// An SDP offer or a CLB1 row is a few kB; anything far bigger is not ours.
// A recording from the browser (POST /api/nahravky) is the one big body: up to 64 MB.
const MAX_BODY = 256 * 1024;
const MAX_BODY_NAHRAVKA = 64 * 1024 * 1024;

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      const limit = req.method === 'POST' && url.pathname === '/api/nahravky' ? MAX_BODY_NAHRAVKA : MAX_BODY;
      for await (const c of req) {
        size += c.length;
        if (size > limit) { res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Příliš velký požadavek'); return; }
        chunks.push(c);
      }
      // A live picture over HTTPS is one long answer: it is passed on as it
      // comes and cut off when the viewer leaves, never gathered in memory.
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, signal: ctrl.signal,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      // Set-Cookie může být víc (odhlášení maže cookie tenanta i základní): jako pole, ne spojené čárkou
      const hl = Object.fromEntries(r.headers); const sc = r.headers.getSetCookie?.() || []; if (sc.length > 1) hl['set-cookie'] = sc;
      res.writeHead(r.status, hl);
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
    // Dispečink a provoz jen pro dispečera tenanta (účet Péče doma plus) nebo správce se zvoleným tenantem.
    // Odkaz s jiným tenantem (?tenant=…) než má přihlášení má přednost: místo dispečinku jde přihlášení k tomu tenantovi (od 3.6).
    if (/^proto[/\\](dispecink|provoz)\.html$/.test(rel)) {
      const chce = normTenant(url.searchParams.get('tenant') || '');
      const prihlasen = dispecinkTenanta(req.headers, chce);
      if (!prihlasen || (chce && prihlasen.tenant !== chce)) file = path.join(PUBLIC, 'proto', 'prihlaseni.html');
    }
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
