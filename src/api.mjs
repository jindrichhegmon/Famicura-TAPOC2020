/**
 * HTTP vrstva (Request → Response), bez vazby na framework kvůli testům.
 *
 *   GET  /api/health            → verze (bez přihlášení)
 *   POST /api/login             { password } → cookie
 *   GET  /api/status            → přihlášen?, co chybí v .env, go2rtc a kamery
 *   GET  /api/devices           → kamery z go2rtc
 *   POST /api/stream            { deviceId, sdpOffer } → { sdpAnswer } (WebRTC přes go2rtc)
 *   GET  /api/stream.mp4?deviceId=  obraz přes HTTPS (fMP4, Chrome/Edge), když síť nepustí WebRTC
 *   GET  /api/stream.m3u8?deviceId= totéž jako HLS (Safari); díly pod /api/hls/…
 *   GET|PUT /api/schedules      plány nahrávání
 *   GET|PUT /api/watch          sledované události analýzy i kamery
 *   GET  /api/events?since=ms   události, které nahlásila kamera (odebírá server)
 *   GET  /api/diag              počty řádků v CLB1
 *   POST /api/clb               { typ: 'udalost' | 'nahravka', ... } → zápis do CLB1
 *
 * Nahrávky na Google Disk poskytovatele (src/nahravky.mjs, src/disk.mjs; dispečer nebo správce s tenantem):
 *   GET  /api/nahravky/stav     Google účet z Péče doma plus a adresář nahrávek tenanta
 *   POST /api/nahravky/slozka   { nazev? } založí adresář na Disku tenanta (jen když žádný není zapojený)
 *   POST /api/nahravky/odpojit  odpojí zapojený adresář (na Disku zůstává), pak jde založit nový
 *   GET  /api/nahravky?kamera=&limit=   seznam nahrávek (tabulka A_KAM_Nahravka); rodina jen své kamery
 *   GET  /api/nahravky/:id/soubor   přehrání nahrávky ze serveru (Range), každé přehrání do auditu A_KAM_Prehrani; z Disku přesměruje;
 *                                   uzamčenou (pořízenou při rozostření rodiny) poskytovatel nedostane (423), dokud ji rodina neodemkne
 *   POST /api/nahravky/:id/odemknout  rodina odemkne uzamčenou nahrávku své kamery poskytovateli (zapíše se kdo a kdy, řádek v historii)
 *                                   ?stahnout=1 = stažení celého souboru (poskytovatel), v auditu jako „stažení“
 *   GET  /api/nahravky/:id/audit    kdo nahrávku přehrál (poskytovatel)
 *   DELETE /api/nahravky/:id        smazání (poskytovatel)
 *   POST /api/ptz               { kamera, smer: left|right|up|down|home|stop } otočení kamery (ONVIF PTZ; rodina jen svou)
 *   GET  /api/svetlo?kamera=ID  stav světla kamery { podporuje, zapnuto, chyba }; POST { kamera, zapnout } rozsvítí / zhasne (rodina jen svou)
 *   POST /api/nahravky/rucni    { kamera, delkaS } server nahraje N s z kamery (dispečink; rodina u své kamery) a uloží podle Nastavení
 *   POST /api/nahravky?kamera=&cas=&delkaS=&zdroj=&text=   tělo = soubor (video/mp4 | video/webm) z hlavní aplikace
 *
 * Tenant (poskytovatel) jako v Péče doma plus: dispečink a rodina pracují
 * vždy s daty jednoho tenanta z databáze PeceDomaPlus (src/najemci.mjs).
 *   GET  /api/tenant?id=        název tenanta pro přihlašovací stránku (bez přihlášení)
 *   POST /api/dispecink/login   { tenant, login, heslo } → cookie dispečera (účet Péče doma plus přes jhn-apps)
 *   POST /api/login             { password [, tenant] } → cookie správce serveru (s tenantem vidí jeho dispečink)
 *
 * Rodina (aplikace rodiny, src/uzivatele.mjs, tabulka tenanta):
 *   GET    /api/rodina/uzivatele                 seznam (poskytovatel)
 *   POST   /api/rodina/uzivatele                 { jmeno, telefon, kamery, poslatSms, role } → pozvánka (poskytovatel); role 'dispecer' = mobilní dispečer (všechny kamery tenanta, nic nenastavuje);
 *                                                telefon s účtem rodiny + role dispecer → účtu se přidá role dispečera a pošle nová pozvánka; telefon dispečera + kamera → kamera se mu přidá jako rodině
 *   POST   /api/rodina/uzivatele/:id/deaktivace  { on } deaktivace / aktivace účtu rodiny nebo dispečera (poskytovatel)
 *                                                telefon, který už účet má → kamery se k němu přidají ({ pridano: true }, bez nové pozvánky)
 *   POST   /api/rodina/uzivatele/:id/pozvanka    { poslatSms } nová pozvánka = nové heslo (poskytovatel)
 *   DELETE /api/rodina/uzivatele/:id[?kamera=ID]  (poskytovatel); s ?kamera= jen odebere tu kameru, účet smaže až bez poslední
 *   GET    /api/rodina/pozvanka?token=  platí ještě pozvánka? { platna, jmeno }
 *   POST   /api/rodina/aktivace   { token, heslo } odkaz z SMS → heslo → přihlášen
 *   POST   /api/rodina/login      { telefon, heslo } → cookie na 30 dní
 *   POST   /api/rodina/odhlaseni
 *   GET    /api/rodina/ja         kdo jsem (role, tenant, jméno) a které kamery vidím
 *   POST   /api/rodina/heslo      { stare, nove }
 *
 * Stránka i API běží na jedné adrese (VPS za Caddy), takže bez CORS.
 * Všechno kromě health, login, aktivace a odhlášení chce přihlášení. Uživatel
 * rodiny smí jen obraz a události svých kamer; nastavení je poskytovatele.
 */
import { kdo, cookie, cookieRodina, cookieDispecer, odhlaseni, hesloSedi } from './session.mjs';
import { createUzivatele, textPozvanky, textZadosti, formatTelefon, normalizeTelefon } from './uzivatele.mjs';
import { createSms } from './sms.mjs';
import { createAsistent } from './asistent.mjs';
import { createUpozorneni } from './upozorneni.mjs';
import { createPdp } from './pdp.mjs';
import { createNajemci } from './najemci.mjs';
import { zacatekDne, konecDne, logXlsx, mereniXlsx, slucMereni } from './log-udalosti.mjs';
import { createDispecer } from './dispecer.mjs';
import { normTenant } from './tabulky.mjs';
import { createLimiter } from './limit.mjs';
import { Go2rtcError } from './go2rtc.mjs';
import { normalizeIntervals, isDeviceId, MAX_INTERVALS } from './plan-pravidla.mjs';
import { normalizeWatch, isDefaultWatch } from '../public/watch.js';
import * as zaznamy from './zaznamy.mjs';

// Když hostname v Caddy spadne na sousední aplikaci, vrátí se její 404 a
// v prohlížeči to vypadá jako naše chyba. Každá odpověď proto říká, kdo ji napsal.
const APLIKACE = 'famicura-tapo';

const POVINNE = ['FAMICURA_PASSWORD', 'SESSION_KEY'];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/** "tapoc2020=Pokoj 12; druha=Chodba" → { tapoc2020: 'Pokoj 12', druha: 'Chodba' } */
export function cameraNames(raw = process.env.CAMERA_NAMES || '') {
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Za Caddy je první adresa v X-Forwarded-For klient; Caddy ji nastavuje sám.
function klientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'mistni';
}

function health() {
  return { ok: true, aplikace: APLIKACE, cas: new Date().toISOString(),
    verze: process.env.APP_VERZE || '', commit: process.env.APP_COMMIT || '',
    vetev: process.env.APP_VETEV || '', nasazeno: process.env.APP_NASAZENO || '',
    spusteno: process.env.APP_SPUSTENO || '' };
}

/** Veřejná adresa aplikace pro odkazy v SMS: PUBLIC_URL, jinak podle hlaviček od Caddy. */
function verejnaAdresa(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export function createHandler({ dbs, go2rtc, store, limiter = createLimiter(), udalosti = null, uzivatele = null, sms = null, asistent = null, disk = null, nahravky = null, ptz = null, svetlo = null, sluzba = null,
                                pdp = null, najemci = null, dispecer = null, kameryTenanty = async () => [], zasobnik = null, naramky = null }) {
  sms = sms || createSms();
  asistent = asistent || createAsistent();
  pdp = pdp || createPdp();
  uzivatele = uzivatele || createUzivatele(pdp.tabulky || { async vyber() { return []; }, async vloz() {}, async uprav() { return 0; }, async smaz() { return 0; } });
  najemci = najemci || createNajemci({ pdp, kamery: kameryTenanty, udalosti, upozorni: createUpozorneni({ sms, uzivatele }) });
  dispecer = dispecer || createDispecer();
  // Each camera carries what it can report itself and which tenant it belongs to (cameras.json).
  async function kamery() {
    const names = cameraNames();
    const st = udalosti ? udalosti.stav() : {};
    const zCameras = await kameryTenanty();
    const tenanty = Object.fromEntries(zCameras.map((k) => [k.id, normTenant(k.tenant)]));
    // Seznam kamer je z go2rtc (go2rtc.yaml se z cameras.json generuje); když go2rtc zrovna neběží,
    // vezme se cameras.json, ať jde přihlášení a dispečink dál – bez obrazu to řekne až /api/stream.
    let ids;
    try { ids = await go2rtc.streams(); }
    catch (e) { if (!zCameras.length) throw e; ids = zCameras.map((k) => k.id); }
    return ids.map((id) => ({ id, name: names[id] || id, tenant: tenanty[id] || '', events: st[id]?.events || [] }));
  }
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };

  async function telo(req) {
    try { return await req.json(); }
    catch { const e = new Error('Tělo požadavku musí být JSON.'); e.status = 400; throw e; }
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const m = req.method.toUpperCase();

    try {
      if (m === 'GET' && (path === '/api/health' || path === '/api/clb-health')) return json({ ...health(), tenanti: najemci.nastaveno, dispecer: dispecer.nastaveno, nahravky: !!(nahravky && nahravky.nastaveno), zasobnik: zasobnik ? zasobnik.stav() : null, uloziste: nahravky ? nahravky.uloziste : { server: false, disk: false }, naramky: naramky ? naramky.stav() : null });

      // Tenant pro přihlašovací stránku: jen název, aby uživatel viděl, že je u správného poskytovatele.
      if (m === 'GET' && path === '/api/tenant') {
        const t = await najemci.tenant(url.searchParams.get('id') || '');
        return json({ ok: true, tenant: { id: t.id, nazev: t.nazev } });
      }

      if (m === 'POST' && path === '/api/login') {
        const ip = klientIp(req);
        const cekat = limiter.blokovano(ip);
        if (cekat) return json({ ok: false, error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(cekat / 60)} min.` }, 429);
        const { password, tenant } = await telo(req);
        if (!hesloSedi(password)) {
          limiter.chyba(ip);
          return json({ ok: false, error: 'Nesprávné heslo Famicura.' }, 401);
        }
        limiter.uspech(ip);
        // Správce se zvoleným tenantem (?tenant= v odkazu) vidí jeho dispečink; neznámý tenant je chyba, ne tiché přihlášení bez něj.
        const t = tenant ? (await najemci.tenant(tenant)).id : '';
        return json({ ok: true, tenant: t }, 200, { 'Set-Cookie': cookie(Date.now(), t) });
      }

      // Dispečer: účet Péče doma plus tenanta (jhn-apps pecedomaplus-auth), cookie vydá tenhle server.
      if (m === 'POST' && path === '/api/dispecink/login') {
        const ip = klientIp(req);
        const cekat = limiter.blokovano(ip);
        if (cekat) return json({ ok: false, error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(cekat / 60)} min.` }, 429);
        const { tenant, login, heslo } = await telo(req);
        const t = await najemci.tenant(tenant);
        if (typeof login !== 'string' || !login.trim() || typeof heslo !== 'string') return json({ ok: false, error: 'Zadejte přihlašovací jméno a heslo.' }, 400);
        let v;
        try { v = await dispecer.login({ tenant: t.id, login: login.trim(), heslo }); }
        catch (e) { if (e.status === 401 || e.status === 403) limiter.chyba(ip); throw e; }
        limiter.uspech(ip);
        return json({ ok: true, uzivatel: v.uzivatel, tenant: { id: t.id, nazev: t.nazev } }, 200, { 'Set-Cookie': cookieDispecer(t.id, v.uzivatel.id, v.uzivatel.jmeno) });
      }

      if (m === 'GET' && path === '/api/status') {
        const missing = POVINNE.filter((k) => !process.env[k]);
        if (kdo(req.headers)?.role !== 'admin') return json({ ok: true, authenticated: false, missing });

        const out = { ok: true, authenticated: true, missing, go2rtc: { ok: false }, cameras: [] };
        try {
          out.go2rtc = { ok: true, version: await go2rtc.version() };
          out.cameras = await kamery();
          // Camera checks run side by side; each gives up after a few seconds.
          const probes = await Promise.all(out.cameras.map((c) => go2rtc.probe(c.id)));
          // Světlo kamery: co si server pamatuje (Diagnostika); poprvé se zeptá kamery, kamera bez světla se pak už neobtěžuje.
          const svetla = svetlo ? await Promise.all(out.cameras.map((c) => svetlo.stav(c.id).catch((e) => ({ podporuje: null, chyba: e.message })))) : [];
          const st = udalosti ? udalosti.stav() : {};
          out.cameras = out.cameras.map((c, i) => ({ ...c, online: probes[i].ok, detail: probes[i].detail,
            ...(svetlo ? { svetlo: { podporuje: svetla[i]?.podporuje ?? null, zapnuto: svetla[i]?.zapnuto ?? null, chyba: svetla[i]?.chyba || null, model: svetla[i]?.model || null, ucet: svetla[i]?.ucet || null } } : {}),
            // null: the server does not subscribe at all (no cameras.json)
            eventsOk: st[c.id] ? st[c.id].ok : null, eventsError: st[c.id]?.error || null,
            eventsLast: st[c.id]?.posledni || null, eventsRejected: st[c.id]?.odmitnuto || null, clbError: st[c.id]?.clbChyba || null,
            eventsOther: st[c.id]?.nezarazene || [] }));
        } catch (e) {
          out.go2rtc = { ok: false, error: e.message };
        }
        return json(out);
      }

      // ---------- rodina bez přihlášení: aktivace pozvánky, přihlášení, odhlášení ----------
      if (m === 'POST' && path === '/api/rodina/aktivace') {
        const { token, heslo } = await telo(req);
        if (typeof token !== 'string' || token.length > 100) return json({ ok: false, error: 'Chybí odkaz z pozvánky.' }, 400);
        const u = await uzivatele.aktivuj(token, heslo);
        return json({ ok: true, uzivatel: u }, 200, { 'Set-Cookie': cookieRodina(u.tenant, u.id) });
      }
      if (m === 'POST' && path === '/api/rodina/login') {
        const ip = klientIp(req);
        const cekat = limiter.blokovano(ip);
        if (cekat) return json({ ok: false, error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(cekat / 60)} min.` }, 429);
        const { telefon, heslo } = await telo(req);
        const u = await uzivatele.prihlas(telefon, heslo);
        if (!u) { limiter.chyba(ip); return json({ ok: false, error: 'Telefon nebo heslo nesedí.' }, 401); }
        limiter.uspech(ip);
        if (u.deaktivovan) return json({ ok: false, error: 'Účet je deaktivovaný. Obraťte se na poskytovatele.' }, 403);
        return json({ ok: true, uzivatel: u }, 200, { 'Set-Cookie': cookieRodina(u.tenant, u.id) });
      }
      if (m === 'POST' && path === '/api/rodina/odhlaseni') return json({ ok: true }, 200, { 'Set-Cookie': odhlaseni() });
      // Odkaz z SMS klepnutý podruhé: stránka se zeptá, zda pozvánka ještě platí, a jinak rovnou nabídne přihlášení.
      if (m === 'GET' && path === '/api/rodina/pozvanka') {
        const token = url.searchParams.get('token') || '';
        if (token.length > 100) return json({ ok: false, error: 'Neplatný odkaz.' }, 400);
        return json({ ok: true, ...(await uzivatele.pozvanka(token)) });
      }

      const ja = kdo(req.headers);
      if (!ja) return json({ ok: false, error: 'Přihlaste se.' }, 401);
      const tenant = ja.tenant || '';
      // A family login outlives the account: a deleted user is logged out at once.
      const rodina = ja.role === 'rodina' ? await uzivatele.pro(tenant).podleId(ja.id) : null;
      if (ja.role === 'rodina' && !rodina) return json({ ok: false, error: 'Účet už neexistuje. Požádejte poskytovatele o novou pozvánku.' }, 401, { 'Set-Cookie': odhlaseni() });
      if (rodina?.deaktivovan) return json({ ok: false, error: 'Účet je deaktivovaný. Obraťte se na poskytovatele.' }, 401, { 'Set-Cookie': odhlaseni() });
      // Mobilní dispečer: účet rodiny s rolí dispecer – vidí všechny kamery tenanta, ale nic nenastavuje (jen sleduje).
      const mobilniDispecer = !!rodina && rodina.role === 'dispecer';
      const jenSleduje = () => json({ ok: false, error: 'Dispečer v mobilní aplikaci jen sleduje, nic nenastavuje.' }, 403);
      // Kamera je vidět: rodině jen její, mobilnímu dispečerovi, dispečinku a správci s tenantem jen kamery tenanta, správci bez tenanta všechny.
      const smiKameru = (c) => {
        const id = typeof c === 'string' ? c : c.id;
        // rodina: jen své kamery, a jen dokud kamera patří tomuto poskytovateli (kamera přiřazená jinému poskytovateli zmizí i rodině,
        // jinak by aplikace rodiny počítala s kamerou, kterou stav poskytovatele nezná, a zamrzla by)
        if (rodina && !mobilniDispecer) return rodina.kamery.includes(id) && (typeof c === 'string' || !tenant || normTenant(c.tenant) === tenant);
        if (!tenant) return true;
        return (typeof c === 'string' ? '' : normTenant(c.tenant)) === tenant;
      };
      const smiKameruId = async (id) => smiKameru((await kamery()).find((c) => c.id === id) || { id, tenant: '' });
      const jenPoskytovatel = () => json({ ok: false, error: 'Tohle nastavuje poskytovatel.' }, 403);
      const uz = () => { if (!tenant) throw chyba('Zadejte ID tenanta (poskytovatele) v odkazu: ?tenant=…', 400); return uzivatele.pro(tenant); };
      const stavTenanta = () => { if (!tenant) throw chyba('Zadejte ID tenanta (poskytovatele) v odkazu: ?tenant=…', 400); return najemci.pro(tenant); };
      // Kamera deaktivovaná rodinou: žádný obraz nikomu (ani rodině), dokud ji rodina zase neaktivuje.
      const deaktivovana = async (id) => { if (!tenant || !najemci) return false; try { return !!(await (await stavTenanta()).stav()).state.patients.find((p) => p.id === id)?.deaktivace; } catch { return false; } };
      const DEAKTIVOVANA = { ok: false, error: 'Kamera je deaktivovaná rodinou – bez obrazu, dokud ji rodina znovu neaktivuje.', deaktivace: true };

      if (m === 'GET' && path === '/api/rodina/ja') {
        const vse = await kamery();
        const t = tenant ? await najemci.tenant(tenant).catch(() => ({ id: tenant, nazev: '' })) : null;
        const moje = vse.filter(smiKameru);
        // rodina má v účtu jen kameru, která už tomuto poskytovateli nepatří: stránka to řekne místo prázdné obrazovky
        const zprava = mobilniDispecer && !moje.length ? 'Poskytovatel zatím nemá žádnou kameru.' : rodina && !moje.length && rodina.kamery.length ? 'Kamera, ke které máte přístup, už u tohoto poskytovatele není (byla přiřazena jinému poskytovateli). Přístup u nového poskytovatele vám zřídí jeho dispečink.' : '';
        return json({ ok: true, role: ja.role, ucet: rodina ? rodina.role : null, rodinaKamery: rodina ? rodina.kamery : [], tenant: t ? { id: t.id, nazev: t.nazev } : null, jmeno: rodina ? rodina.jmeno : ja.role === 'dispecer' ? ja.jmeno : 'Správce',
          telefon: rodina ? formatTelefon(rodina.telefon) : null, kamery: moje.map(({ id, name, events }) => ({ id, name, events })), zprava });
      }
      if (m === 'POST' && path === '/api/rodina/heslo') {
        if (!rodina) return json({ ok: false, error: 'Heslo dispečera mění portál Péče doma plus, heslo správce ./deploy/vps-env.sh.' }, 400);
        const { stare, nove } = await telo(req);
        await uz().zmenHeslo(rodina.id, stare, nove);
        return json({ ok: true });
      }

      // ---------- správa uživatelů rodiny: jen poskytovatel ----------
      const pozvanka = async (vysledek, poslatSms, navic = {}) => {
        const odkaz = `${verejnaAdresa(req)}/r/${vysledek.token}`;   // server.mjs: → /proto/rodina.html?pozvanka=
        const dispecerUcet = vysledek.uzivatel.role === 'dispecer';
        const posk = dispecerUcet ? await najemci.tenant(tenant).then((t) => t?.nazev || '').catch(() => '') : '';
        const text = textPozvanky({ jmeno: vysledek.uzivatel.jmeno, odkaz, role: vysledek.uzivatel.role, poskytovatel: posk });
        let smsStav = { odeslano: false, error: null };
        if (poslatSms) {
          const r = await sms.posli({ telefon: vysledek.uzivatel.telefon, text, typ: 'FAMICURA_POZVANKA', poznamka: dispecerUcet ? 'Pozvánka dispečera do mobilní aplikace Famicura.' : 'Pozvánka do aplikace rodiny Famicura.' });
          smsStav = { odeslano: r.ok, error: r.ok ? null : r.error };
        }
        return json({ ok: true, uzivatel: vysledek.uzivatel, odkaz, text, sms: smsStav, smsNastaveno: sms.nastaveno, ...navic });
      };
      if (path === '/api/rodina/uzivatele') {
        if (rodina) return jenPoskytovatel();
        if (m === 'GET') return json({ ok: true, uzivatele: await uz().seznam(), smsNastaveno: sms.nastaveno });
        if (m !== 'POST') return json({ ok: false, error: 'GET nebo POST' }, 405);
        const { jmeno, telefon, kamery: k, poslatSms, role } = await telo(req);
        if (role !== undefined && !['rodina', 'dispecer'].includes(role)) return json({ ok: false, error: 'Typ účtu: rodina, nebo dispecer.' }, 400);
        if (k && Array.isArray(k) && !k.every((id) => isDeviceId(id))) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400);
        // jen kamery tenanta: účet rodiny u cizí kamery by jí otevřel cizí obraz
        const moje = (await kamery()).filter(smiKameru).map((c) => c.id);
        if (Array.isArray(k) && k.some((id) => !moje.includes(id))) return json({ ok: false, error: 'Kamera nepatří tomuto poskytovateli.' }, 403);
        // stejný člověk u další kamery: telefon už účet má → kamery se k němu přidají, heslo i pozvánka zůstávají;
        // pozvánka dispečera na existující účet → účet dostane roli dispečera (své kamery mu zůstávají jako rodině) a novou pozvánku (nové heslo)
        const stavajici = await uz().podleTelefonu(telefon);
        if (stavajici && role === 'dispecer') {
          if (stavajici.role === 'dispecer' && !(Array.isArray(k) && k.some((id) => !stavajici.kamery.includes(id)))) return json({ ok: false, error: `Telefon už má účet dispečera (${stavajici.jmeno}). Novou pozvánku pošlete tlačítkem u jeho účtu.` }, 409);
          if (stavajici.role === 'dispecer') { let u = stavajici; for (const id of k) u = await uz().pridejKameru(stavajici.id, id); return json({ ok: true, pridano: true, uzivatel: u, smsNastaveno: sms.nastaveno }); }
          await uz().nastavRoli(stavajici.id, 'dispecer');
          if (Array.isArray(k)) for (const id of k) await uz().pridejKameru(stavajici.id, id);
          return pozvanka(await uz().novaPozvanka(stavajici.id), !!poslatSms, { povysen: true });
        }
        if (stavajici && Array.isArray(k) && k.length) {
          let u = stavajici; for (const id of k) u = await uz().pridejKameru(stavajici.id, id);
          return json({ ok: true, pridano: true, uzivatel: u, smsNastaveno: sms.nastaveno });
        }
        return pozvanka(await uz().vytvor({ jmeno, telefon, kamery: k, role: role || 'rodina' }), !!poslatSms);
      }
      const mu = path.match(/^\/api\/rodina\/uzivatele\/([a-z0-9]{1,40})(\/pozvanka|\/deaktivace)?$/);
      if (mu) {
        if (rodina) return jenPoskytovatel();
        if (mu[2] === '/deaktivace' && m === 'POST') { const { on } = await telo(req).catch(() => ({})); return json({ ok: true, uzivatel: await uz().deaktivuj(mu[1], on === true || on === 'true' || on === 1) }); }
        if (mu[2] === '/pozvanka' && m === 'POST') { const { poslatSms } = await telo(req).catch(() => ({})); return pozvanka(await uz().novaPozvanka(mu[1]), !!poslatSms); }
        if (!mu[2] && m === 'DELETE') {
          const kam = url.searchParams.get('kamera') || '';
          if (kam) { if (!isDeviceId(kam)) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400); const r = await uz().odeberKameru(mu[1], kam); return json({ ok: true, smazan: r.smazan, uzivatel: r.uzivatel }); }
          await uz().smaz(mu[1]); return json({ ok: true, smazan: true });
        }
        return json({ ok: false, error: 'Neznámá adresa.' }, 404);
      }

      if (m === 'GET' && path === '/api/devices') {
        return json({ ok: true, devices: (await kamery()).filter(smiKameru) });
      }

      if (path === '/api/stream') {
        if (m === 'DELETE') return json({ ok: true });   // go2rtc ends it when the peer closes
        if (m !== 'POST') return json({ ok: false, error: 'POST nebo DELETE' }, 405);
        const { deviceId, sdpOffer } = await telo(req);
        if (!deviceId || !isDeviceId(deviceId)) return json({ ok: false, error: 'Chybí nebo je neplatné deviceId.' }, 400);
        if (!sdpOffer || typeof sdpOffer !== 'string' || sdpOffer.length > 100_000) {
          return json({ ok: false, error: 'Chybí SDP offer.' }, 400);
        }
        if (await smiKameruId(deviceId) && await deaktivovana(deviceId)) return json(DEAKTIVOVANA, 423);
        // Only a stream go2rtc knows: the id goes into its URL.
        if (!(await go2rtc.streams()).includes(deviceId) || !(await smiKameruId(deviceId))) {
          console.error(`[famicura-tapo] obraz kamery ${deviceId} odmítnut: ${ja.role}${tenant ? ' ' + tenant : ''}${rodina ? ' uživatel ' + rodina.id : ''} – kamera není v go2rtc nebo nepatří tomuhle tenantovi / uživateli`);
          return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        }
        return json({ ok: true, sdpAnswer: await go2rtc.webrtc(deviceId, sdpOffer), sessionUrl: null });
      }

      // The picture over HTTPS for a network that drops WebRTC: go2rtc's MP4
      // (Chrome, Edge) or HLS (Safari), passed through as it comes. Video only:
      // browsers play the camera's G.711 audio in neither container.
      if (m === 'GET' && (path === '/api/stream.mp4' || path === '/api/stream.m3u8')) {
        const id = url.searchParams.get('deviceId') || '';
        if (!isDeviceId(id)) return json({ ok: false, error: 'Chybí nebo je neplatné deviceId.' }, 400);
        if (await smiKameruId(id) && await deaktivovana(id)) return json(DEAKTIVOVANA, 423);
        if (!(await go2rtc.streams()).includes(id) || !(await smiKameruId(id))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        return go2rtc.proxy(`${path}?src=${encodeURIComponent(id)}&video=h264`, { signal: req.signal });
      }
      if (m === 'GET' && path.startsWith('/api/hls/')) {
        // Playlist and segments under the id the master playlist handed out;
        // only those names and only an id and a segment number go through.
        const file = path.slice('/api/hls/'.length);
        const id = url.searchParams.get('id') || '';
        const n = url.searchParams.get('n');
        if (!['playlist.m3u8', 'init.mp4', 'segment.m4s', 'segment.ts'].includes(file)) return json({ ok: false, error: 'Neznámá adresa.' }, 404);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || (n !== null && !/^\d{1,9}$/.test(n))) return json({ ok: false, error: 'Neplatný odkaz.' }, 400);
        return go2rtc.proxy(`${path}?id=${id}${n === null ? '' : `&n=${n}`}`, { signal: req.signal });
      }

      // ---------- prototyp (rodina, dispečink, provoz): stav sdílený mezi zařízeními ----------
      // Rodina i poskytovatel ho vidí celý: jsou to ukázková data plus
      // souhlasy a události k jejich kameře; nastavení serveru v něm není.
      // Log událostí dispečinku za období (dny pražského času), jedna kamera nebo všechny; format=xlsx = sešit Excelu.
      if (m === 'GET' && path === '/api/udalosti') {
        if (rodina) return jenPoskytovatel();
        const od = url.searchParams.get('od') || '', doDne = url.searchParams.get('do') || '', kam = url.searchParams.get('kamera') || '';
        const odMs = od ? zacatekDne(od) : 0, doMs = doDne ? konecDne(doDne) : Number.MAX_SAFE_INTEGER;
        if (odMs === null || doMs === null) return json({ ok: false, error: 'Datum zadejte ve tvaru RRRR-MM-DD.' }, 400);
        if (odMs > doMs) return json({ ok: false, error: 'Začátek období je až po jeho konci.' }, 400);
        if (kam && (!isDeviceId(kam) || !(await smiKameruId(kam)))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        const st = await stavTenanta();
        const radky = await st.vypisUdalosti({ od: odMs, do: doMs, kameraId: kam, limit: Number(url.searchParams.get('limit')) || 5000 });
        if (url.searchParams.get('format') === 'xlsx') {
          const posk = (await st.stav()).state.poskytovatel || {};
          const kamNazev = kam ? ((await st.stav()).state.patients.find((p) => p.id === kam)?.name || (await kamery()).find((c) => c.id === kam)?.name || kam) : '';
          const data = logXlsx(radky, { poskytovatel: posk.nazev || tenant, od: od || 'od začátku', do: doDne || 'dnes', kamera: kamNazev });
          const nazev = `famicura-log_${(kamNazev || 'vsechny-kamery').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-')}_${od || 'zacatek'}_${doDne || 'dnes'}.xlsx`;
          return new Response(data, { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nazev}"`, 'Cache-Control': 'private, no-store', 'Content-Length': String(data.length) } });
        }
        return json({ ok: true, od, do: doDne, kamera: kam, udalosti: radky });
      }
      if (m === 'GET' && path === '/api/proto/stav') {
        const s = await (await stavTenanta()).stav();
        const v = Number(url.searchParams.get('v'));
        if (v && v === s.v) return json({ ok: true, v: s.v, zmena: false });
        return json({ ok: true, v: s.v, zmena: true, state: s.state });
      }
      if (m === 'POST' && path === '/api/proto/akce') {
        const telo_ = await telo(req); const akce = telo_.akce; let args = telo_.args;
        if (typeof akce !== 'string' || !Array.isArray(args) || args.length > 6) return json({ ok: false, error: 'Neplatná akce.' }, 400);
        // Náramek/přívěsek ke kameře přiřazuje poskytovatel (jen on ví ID zařízení a odpovídá za jeho poplachy).
        if ((akce === 'setNaramek' || akce === 'setNaramekAuto' || akce === 'setNaramekSos') && rodina) return jenPoskytovatel();
        // Mobilní dispečer jen sleduje: ze stavu smí jen zapsat, že se dívá (setWatching); u kamer, kde je zároveň rodina, nastavuje jako rodina.
        if (mobilniDispecer && akce !== 'setWatching' && !rodina.kamery.includes(String(args[0]))) return jenSleduje();
        // Deaktivovat a aktivovat kameru smí jen rodina; jméno do historie dosadí server.
        if (akce === 'deaktivace') {
          if (!rodina) return json({ ok: false, error: 'Deaktivovat a aktivovat kameru může jen rodina ve své aplikaci.' }, 403);
          args = [args[0], args[1], rodina.jmeno];
        }
        const vysledek = await (await stavTenanta()).proved(akce, args);
        // (De)aktivace rodinou: kamera se otočí do stropu (deaktivace) nebo zpět do výchozí polohy; výsledek se zapíše ke stavu, ať rodina vidí, že kamera opravdu kouká do stropu.
        if (akce === 'deaktivace' && vysledek.vysledek?.zmena) {
          const { patientId: kam, on, poloha: puvodni } = vysledek.vysledek;
          const st = await stavTenanta();
          const zapis = (ok, chyba, poloha) => st.otoceniKamery({ kameraId: kam, on, ok, chyba, poloha }).catch((e) => console.error('[famicura-tapo] zápis otočení kamery:', e.message));
          if (!ptz) zapis(false, 'otáčení kamery není na serveru k dispozici');
          else if (on) {
            // nejdřív si přečíst, kam kamera kouká (po aktivaci se vrátí na totéž místo), pak do stropu
            (ptz.poloha ? ptz.poloha(kam) : Promise.resolve(null)).catch(() => null)
              .then((poloha) => ptz.pohni(kam, 'strop').then(() => zapis(true, null, poloha), (e) => zapis(false, e.message, poloha)));
          } else ptz.pohni(kam, 'home', { poloha: puvodni || null }).then(() => zapis(true), (e) => zapis(false, e.message));
        }
        // Žádost dispečinku o plný obraz: rodině u té kamery odejde SMS, ať otevře aplikaci a rozhodne.
        if (akce === 'requestFull' && !rodina && vysledek.vysledek && typeof vysledek.vysledek === 'object') {
          const r = vysledek.vysledek;
          const prijemci = (await uz().seznam()).filter((u) => u.aktivni && u.kamery.includes(r.patientId));
          const posk = (vysledek.state.poskytovatel && vysledek.state.poskytovatel.nazev) || 'Poskytovatel';
          const text = textZadosti({ poskytovatel: posk, duvod: r.reason, odkaz: `${verejnaAdresa(req)}/proto/rodina.html` });
          const stav = { prijemci: prijemci.length, odeslano: 0, chyba: null };
          if (!sms.nastaveno) stav.chyba = prijemci.length ? 'SMS není na serveru nastavená (SMS_WEBHOOK_URL).' : null;
          else for (const u of prijemci) {
            const o = await sms.posli({ telefon: u.telefon, text, typ: 'FAMICURA_ZADOST', poznamka: `Žádost o plný obraz, kamera ${r.patientId}.` });
            if (o.ok) stav.odeslano++; else stav.chyba = o.error;
          }
          r.sms = stav;
        }
        return json({ ok: true, ...vysledek });
      }

      // Světlo kamery (reflektor Tapo C320WS/C520WS/C560WS přes místní rozhraní Tapo): kdo kameru smí vidět, smí si posvítit (rodina jen svou).
      if ((m === 'GET' || m === 'POST') && path === '/api/svetlo') {
        const t = m === 'GET' ? { kamera: url.searchParams.get('kamera') } : await telo(req);
        const kamera = String(t.kamera || '');
        if (!isDeviceId(kamera) || !(await smiKameruId(kamera))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        if (!svetlo) return json({ ok: false, error: 'Světlo kamery není na serveru k dispozici.' }, 503);
        if (m === 'GET') { const s = await svetlo.stav(kamera, { znovu: t.znovu === '1' }); return json({ ok: true, podporuje: s.podporuje, zapnuto: s.zapnuto, chyba: s.chyba || null, model: s.model || null }); }
        if (mobilniDispecer) return jenSleduje();
        if (typeof t.zapnout !== 'boolean') return json({ ok: false, error: 'Chybí zapnout: true / false.' }, 400);
        const r = await svetlo.nastav(kamera, t.zapnout);
        // do historie kamery, ať je vidět, kdo a kdy světlo přepnul
        if (tenant && najemci) { const kdo = ja.jmeno || (rodina ? 'rodina' : ja.role === 'dispecer' ? 'Dispečer' : 'Správce'); (await stavTenanta()).proved('poznamka', [kamera, `💡 Světlo kamery ${r.zapnuto ? 'rozsvíceno' : 'zhasnuto'}.`, kdo]).catch(() => {}); }
        return json({ ok: true, zapnuto: r.zapnuto });
      }
      // Otočení kamery (Tapo pan/tilt přes ONVIF): kdo kameru smí vidět, smí ji i otočit (rodina jen svou).
      if (m === 'POST' && path === '/api/ptz') {
        const { kamera, smer, rychlost, ms } = await telo(req);
        if (!isDeviceId(kamera) || !(await smiKameruId(kamera))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        if (!ptz) return json({ ok: false, error: 'Otáčení kamery není na serveru k dispozici.' }, 503);
        if (smer === 'strop') return json({ ok: false, error: 'Směr: left, right, up, down, home nebo stop.' }, 400);
        if (await deaktivovana(kamera)) return json({ ok: false, error: 'Kamera je deaktivovaná rodinou a míří do stropu; otáčet půjde až po aktivaci.', deaktivace: true }, 423);
        await ptz.pohni(kamera, String(smer || ''), { rychlost: Number(rychlost) || 0.5, ms: Number(ms) || 400 });
        return json({ ok: true });
      }
      // Čísla SOS náramku (jen poskytovatel): uloží ke kameře (akce setNaramekSos) a hned pošle do náramku (SOS1–SOS3); když není připojený, pošle je server při jeho příštím ozvání.
      if (m === 'POST' && path === '/api/naramek/sos') {
        if (rodina) return jenPoskytovatel();
        const { kamera, cisla } = await telo(req);
        if (!isDeviceId(kamera) || !(await smiKameruId(kamera))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        const st = await stavTenanta();
        const kdo = ja.jmeno || (ja.role === 'dispecer' ? 'Dispečer' : 'Správce');
        const v = await st.proved('setNaramekSos', [kamera, Array.isArray(cisla) ? cisla : [], kdo]);
        const sv = (await st.stav()).state; const p = sv.patients.find((x) => x.id === kamera);
        let odeslano = false, obsah = '', skutecna = null, chybaOdeslani = '';
        if (naramky && p?.naramek?.id && naramky.pripojen?.(p.naramek.id)) {
          try { const r = await naramky.prikaz(p.naramek.id, 'sos', { cislaSos: p.naramek.sos || [], tenant, state: sv, patient: p }); obsah = r.obsah; skutecna = r.cisla || null; await st.naramek({ kameraId: kamera, sosOdeslano: Date.now(), sosOdeslaneCisla: skutecna }); odeslano = true; }
          // čísla jsou uložená i když se teď do náramku neposlala (není připojený = 409, číslo z Péče doma chybí, jhn-apps neodpovídá…): server je pošle znovu sám (tik, příští ozvání); chyba jde do odpovědi, ne jako neúspěch uložení
          catch (e) { if (e.status !== 409) { chybaOdeslani = e.message; console.error(`[naramky] ${p.naramek.id}: čísla SOS uložena, do náramku se teď neposlala: ${e.message}`); } }
        }
        return json({ ok: true, cisla: v?.vysledek ?? p?.naramek?.sos ?? [], odeslano, obsah, skutecna, ...(chybaOdeslani ? { chyba: chybaOdeslani } : {}) });
      }
      // Telefony poskytovatele z Péče doma (contact_phone poskytovatele, bez tenanta) a Péče doma plus (SLUZBA_TELEFON / DISPECINK_TELEFON / ADMINISTRACE_TELEFON tenanta);
      // POST { telefon, role } zapíše telefon role v Plus (role sluzba = výchozí).
      if ((m === 'GET' || m === 'POST') && path === '/api/naramek/sluzba-telefon') {
        if (rodina) return jenPoskytovatel();
        const prazdne = { poskytovatel: '', pecedoma: { telefon: '', poskytovatel: '', duvod: '' }, pecedomaplus: { telefon: '', sluzba: { telefon: '' }, dispecink: { telefon: '' }, administrace: { telefon: '' } } };
        if (!sluzba || !sluzba.nastaveno) return json({ ok: true, nastaveno: false, ...prazdne, chyba: 'Čísla z Péče doma (plus) nejsou na serveru nastavená (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC, ./deploy/vps-env.sh).' });
        try {
          let v;
          if (m === 'POST') {   // zápis telefonu role do Péče doma plus, do historie každé kamery s náramkem se nepíše – je to nastavení poskytovatele
            const { telefon, role } = await telo(req);
            if (typeof telefon !== 'string') return json({ ok: false, error: 'Zadejte telefon (prázdný = smazat).' }, 400);
            if (role !== undefined && !['sluzba', 'dispecink', 'administrace'].includes(role)) return json({ ok: false, error: 'Role: sluzba, dispecink, nebo administrace.' }, 400);
            v = await sluzba.nastav(tenant, telefon, role || 'sluzba');
          } else v = await sluzba.telefon(tenant, { cerstve: url.searchParams.get('cerstve') === '1' });
          return json({ ok: true, nastaveno: true, poskytovatel: v.poskytovatel, pecedoma: v.pecedoma, pecedomaplus: v.pecedomaplus, zastarale: !!v.zastarale });
        } catch (e) { if (m === 'POST') throw e; return json({ ok: true, nastaveno: true, ...prazdne, chyba: e.message }); }
      }
      // Měření zdraví z náramku jedné kamery, nejnovější první, nejvýš 2000 (stránkuje stránka); format=xlsx = sešit Excelu (až 10000).
      // Kdo kameru smí vidět, vidí i měření: poskytovatel, rodina u své kamery, mobilní dispečer u kamer poskytovatele (karta Náramek v aplikaci na telefonu).
      if (m === 'GET' && path === '/api/naramek/mereni') {
        const kam = url.searchParams.get('kamera') || '';
        if (!isDeviceId(kam) || !(await smiKameruId(kam))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        const st = await stavTenanta();
        const xl = url.searchParams.get('format') === 'xlsx';
        const radky = slucMereni(await st.vypisMereni({ kameraId: kam, limit: xl ? 10000 : 2000 }));   // jedna sada měření = jeden řádek
        if (xl) {
          const sv = (await st.stav()).state; const p = sv.patients.find((x) => x.id === kam);
          const kamNazev = p?.name || (await kamery()).find((c) => c.id === kam)?.name || kam;
          const data = mereniXlsx(radky, { poskytovatel: sv.poskytovatel?.nazev || tenant, kamera: kamNazev, naramek: p?.naramek?.id || '' });
          const nazev = `famicura-mereni_${kamNazev.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-')}.xlsx`;
          return new Response(data, { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nazev}"`, 'Cache-Control': 'private, no-store', 'Content-Length': String(data.length) } });
        }
        return json({ ok: true, kamera: kam, mereni: radky });
      }
      // Příkaz náramku/přívěsku (jen poskytovatel): změřit tep / tlak / kyslík / teplotu, zjistit polohu, vypnout (jen na heslo hlavní aplikace); vlastní text pro ladění modelu.
      if (m === 'POST' && path === '/api/naramek/prikaz') {
        if (rodina) return jenPoskytovatel();
        const { kamera, prikaz, vlastni, heslo } = await telo(req);
        if (!isDeviceId(kamera) || !(await smiKameruId(kamera))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
        if (!naramky) return json({ ok: false, error: 'Příjem náramků není na serveru zapnutý (NARAMKY_PORT).' }, 503);
        if (prikaz === 'vypnout') {   // vypnutí jen na heslo hlavní aplikace (FAMICURA_PASSWORD), se stejnou brzdou pokusů jako přihlášení
          const ip = klientIp(req);
          const cekat = limiter.blokovano(ip);
          if (cekat) return json({ ok: false, error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(cekat / 60)} min.` }, 429);
          if (typeof heslo !== 'string' || !hesloSedi(heslo)) { limiter.chyba(ip); return json({ ok: false, error: 'Vypnutí náramku jde jen na heslo hlavní aplikace Famicura; heslo nesedí.' }, 401); }
          limiter.uspech(ip);
        }
        const st = await stavTenanta();
        const p = (await st.stav()).state.patients.find((x) => x.id === kamera);
        if (!p?.naramek?.id) return json({ ok: false, error: 'Ke kameře není přiřazen náramek.' }, 400);
        const r = await naramky.prikaz(p.naramek.id, String(prikaz || ''), { vlastni: typeof vlastni === 'string' ? vlastni : '' });
        const kdo = ja.jmeno || (ja.role === 'dispecer' ? 'Dispečer' : 'Správce');
        if (prikaz === 'vypnout' || prikaz === 'vlastni') await st.proved('poznamka', [kamera, `Náramek ${p.naramek.id}: poslán příkaz ${r.obsah}.`, kdo]).catch(() => {});
        if (prikaz === 'vypnout') await st.naramek({ kameraId: kamera, vypnuto: Date.now(), vypnulKdo: kdo }).catch(() => {});   // dispečink ukáže „náramek je vypnutý“, dokud se zase neozve
        return json({ ok: true, obsah: r.obsah, ...(r.predtim ? { predtim: r.predtim } : {}) });
      }

      // Nahrávky na Google Disk poskytovatele: účet z Péče doma plus, adresář, seznam, ruční nahrávka, soubor z hlavní aplikace.
      if (path === '/api/nahravky' || path.startsWith('/api/nahravky/')) {
        const nejsou = () => json({ ok: false, nastaveno: false, error: 'Nahrávky nejsou na serveru nastavené (NAHRAVKY_KLIC pro úložiště na serveru, nebo JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC pro Google Disk – ./deploy/vps-env.sh).' }, 503);
        // Správce bez tenanta (hlavní aplikace): tenant podle kamery z cameras.json.
        const tenantKamery = async (id) => { const c = (await kamery()).find((k) => k.id === id); return c ? c.tenant : ''; };
        const mojeKamery = async () => rodina ? rodina.kamery : null;   // rodina: jen své kamery
        // Přehrání: kdokoli, kdo kameru smí vidět (rodina jen své); ze serveru s auditem, z Disku přesměrováním.
        const mSoubor = path.match(/^\/api\/nahravky\/([A-Za-z0-9_-]{4,40})\/(soubor|audit)$/);
        if (m === 'GET' && mSoubor) {
          if (!nahravky) return nejsou();
          const t = tenant;
          if (!t) return json({ ok: false, error: 'Zadejte ID tenanta (poskytovatele) v odkazu: ?tenant=…' }, 400);
          const n = await nahravky.podleId(t, mSoubor[1]);
          if (!n || !(await smiKameruId(n.kameraId))) return json({ ok: false, error: 'Nahrávka neexistuje.' }, 404);
          if (mSoubor[2] === 'audit') { if (rodina) return jenPoskytovatel(); return json({ ok: true, nahravka: n, prehrani: await nahravky.prehraniSeznam(t, n.id) }); }
          // uzamčená nahrávka (rodina měla v tu chvíli rozostření): poskytovatel ani správce ji nedostanou, jen rodina
          if (n.zamek && !rodina) return json({ ok: false, zamek: true, error: 'Nahrávka je uzamčená: rodina měla v tu chvíli nastavený rozostřený obraz. Odemknout ji může rodina ve své aplikaci (karta Nahrávky → Odemknout).' }, 423);
          const adresa = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
          const kdoText = rodina ? rodina.jmeno : ja.role === 'dispecer' ? ja.jmeno : 'Správce';
          if (n.uloziste === 'disk' && n.url) {
            await nahravky.prehrani(t, { nahravkaId: n.id, kameraId: n.kameraId, kdo: kdoText, role: ja.role, adresa });
            return new Response(null, { status: 302, headers: { Location: n.url, 'Cache-Control': 'no-store' } });
          }
          const { data, mime, nazev } = await nahravky.soubor(t, n);
          const souborNazev = nazev.replace(/[^A-Za-z0-9._-]/g, '_');
          // stažení celého souboru (poskytovatel): do auditu jako „stažení“, prohlížeč ho uloží pod názvem nahrávky
          if (url.searchParams.get('stahnout') === '1') {
            if (rodina) return jenPoskytovatel();
            await nahravky.prehrani(t, { nahravkaId: n.id, kameraId: n.kameraId, kdo: `${kdoText} (stažení)`, role: ja.role, adresa });
            return new Response(data, { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${souborNazev}"`, 'Content-Length': String(data.length) } });
          }
          // audit jen jednou na přehrání: prohlížeč si při přehrávání říká o části (Range) opakovaně
          const range = req.headers.get('range');
          if (!range || /^bytes=0-/.test(range)) await nahravky.prehrani(t, { nahravkaId: n.id, kameraId: n.kameraId, kdo: kdoText, role: ja.role, adresa });
          const hl = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="${souborNazev}"` };
          const mr = range && range.match(/^bytes=(\d*)-(\d*)$/);
          if (mr && (mr[1] || mr[2])) {
            let od = mr[1] ? Number(mr[1]) : Math.max(0, data.length - Number(mr[2]));
            let kon = mr[1] && mr[2] ? Math.min(Number(mr[2]), data.length - 1) : data.length - 1;
            if (od >= data.length || od > kon) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${data.length}` } });
            return new Response(data.subarray(od, kon + 1), { status: 206, headers: { ...hl, 'Content-Range': `bytes ${od}-${kon}/${data.length}`, 'Content-Length': String(kon - od + 1) } });
          }
          return new Response(data, { status: 200, headers: { ...hl, 'Content-Length': String(data.length) } });
        }
        // Odemknutí uzamčené nahrávky: jen rodina u své kamery (poskytovatel si ji odemknout nemůže).
        const mOdemkni = path.match(/^\/api\/nahravky\/([A-Za-z0-9_-]{4,40})\/odemknout$/);
        if (m === 'POST' && mOdemkni) {
          if (!nahravky) return nejsou();
          if (!rodina) return json({ ok: false, error: 'Nahrávku může odemknout jen rodina ve své aplikaci.' }, 403);
          const n = await nahravky.podleId(tenant, mOdemkni[1]);
          if (!n || !(await smiKameruId(n.kameraId))) return json({ ok: false, error: 'Nahrávka neexistuje.' }, 404);
          if (mobilniDispecer && !rodina.kamery.includes(n.kameraId)) return json({ ok: false, error: 'Nahrávku může odemknout jen rodina té kamery; dispečer jen sleduje.' }, 403);
          if (!n.zamek) return json({ ok: true, nahravka: n, zmena: false });
          const out = await nahravky.odemkni(tenant, n, { kdo: rodina.jmeno });
          await (await stavTenanta()).odemknutiNahravky({ id: n.id, kameraId: n.kameraId, cas: n.cas, delkaS: n.delkaS, kdo: rodina.jmeno }).catch((e) => console.error('[famicura-tapo] odemknutí nahrávky v historii:', e.message));
          return json({ ok: true, nahravka: out, zmena: true });
        }
        if (m === 'GET' && path === '/api/nahravky') {
          if (!nahravky) return nejsou();
          const k = url.searchParams.get('kamera') || '';
          if (k && !(await smiKameruId(k))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
          const t = tenant || (k ? await tenantKamery(k) : '');
          if (!t) return json({ ok: false, error: 'Zadejte ID tenanta (poskytovatele) v odkazu: ?tenant=…' }, 400);
          return json({ ok: true, nahravky: await nahravky.seznam(t, { kameraId: k, kamery: await mojeKamery(), limit: Number(url.searchParams.get('limit')) || 50 }) });
        }
        // Ruční nahrávka: dispečink, a rodina u své kamery (smiKameruId) – proto ještě před zábranou pro rodinu.
        if (m === 'POST' && path === '/api/nahravky/rucni') {
          if (!nahravky) return nejsou();
          const { kamera, delkaS } = await telo(req);
          if (!isDeviceId(kamera) || !(await smiKameruId(kamera))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
          const st = await stavTenanta();
          const s = await st.stav();
          const p = s.state.patients.find((x) => x.id === kamera);
          const smi = nahravky.smiNahravat(s.state, p, 'state');
          if (!smi.ok) return json({ ok: false, error: `Nahrávka se nepořídí: ${smi.duvod}.` }, 403);
          const n = await nahravky.porid(st.tenant, { kameraId: kamera, zamek: !!smi.zamek, delkaS: delkaS || s.state.poskytovatel?.nahravkaS, predS: s.state.poskytovatel?.nahravkaPredS, uloziste: s.state.poskytovatel?.nahravkyUloziste, disk: !!s.state.poskytovatel?.nahravkyDisk, zdroj: 'rucni', kdo: rodina ? rodina.jmeno : ja.jmeno || 'Správce', text: 'Ruční nahrávka z dispečinku.' });
          if (n.preskoceno) return json({ ok: false, error: n.duvod }, 409);
          if (n.chyba) return json({ ok: false, nahravka: n, error: n.chyba }, 502);
          return json({ ok: true, nahravka: n });
        }
        if (rodina) return jenPoskytovatel();
        if (m === 'GET' && path === '/api/nahravky/stav') {
          if (!nahravky) return json({ ok: true, nastaveno: false, uloziste: { server: false, disk: false }, error: 'Nahrávky nejsou na serveru nastavené (NAHRAVKY_KLIC, nebo JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC – ./deploy/vps-env.sh).' });
          const t = tenant || await tenantKamery(url.searchParams.get('kamera') || '');
          if (!t) return json({ ok: true, nastaveno: nahravky.nastaveno, uloziste: nahravky.uloziste, tenant: null });
          const posk = (await najemci.pro(t).then((x) => x.stav()).catch(() => null))?.state?.poskytovatel || {};
          const out = { ok: true, nastaveno: nahravky.nastaveno, uloziste: nahravky.uloziste, tenant: t, volba: posk.nahravkyUloziste || 'server', kopieDisk: !!posk.nahravkyDisk, dny: posk.nahravkyDny || 30, delkaS: posk.nahravkaS || 15, google: null, slozka: null, misto: await nahravky.misto(t).catch(() => null) };
          if (disk && disk.nastaveno) { try { const s = await disk.stav(t); out.google = s.google; out.slozka = s.slozka; } catch (e) { out.chyba = e.message; } }
          return json(out);
        }
        if (!nahravky) return nejsou();
        const bezDisku = !disk || !disk.nastaveno;
        const mId = path.match(/^\/api\/nahravky\/([A-Za-z0-9_-]{4,40})$/);
        if (m === 'DELETE' && mId) {
          const t = tenant; if (!t) return json({ ok: false, error: 'Zadejte ID tenanta (poskytovatele) v odkazu: ?tenant=…' }, 400);
          const n = await nahravky.podleId(t, mId[1]);
          if (!n || !(await smiKameruId(n.kameraId))) return json({ ok: false, error: 'Nahrávka neexistuje.' }, 404);
          await nahravky.smaz(t, n);
          return json({ ok: true });
        }
        if (m === 'POST' && path === '/api/nahravky/slozka') {
          if (bezDisku) return nejsou();
          const { nazev } = await telo(req);
          const s = await disk.zalozSlozku((await stavTenanta()).tenant, typeof nazev === 'string' ? nazev.slice(0, 200) : '');
          return json({ ok: true, google: s.google, slozka: s.slozka, zprava: s.zprava || '' });
        }
        if (m === 'POST' && path === '/api/nahravky/odpojit') {
          if (bezDisku) return nejsou();
          const s = await disk.odpojSlozku((await stavTenanta()).tenant);
          return json({ ok: true, google: s.google, slozka: s.slozka, zprava: s.zprava || '' });
        }
        if (m === 'POST' && path === '/api/nahravky') {
          const k = url.searchParams.get('kamera') || '';
          if (!isDeviceId(k) || !(await smiKameruId(k))) return json({ ok: false, error: 'Neznámá kamera.' }, 404);
          const t = tenant || await tenantKamery(k);
          if (!t) return json({ ok: false, error: 'Kamera nepatří žádnému poskytovateli (vps-kamera.sh tenant …).' }, 400);
          const mime = (req.headers.get('content-type') || 'video/mp4').split(';')[0].trim();
          if (!/^video\/(mp4|webm)$/.test(mime)) return json({ ok: false, error: 'Tělo musí být video/mp4 nebo video/webm.' }, 415);
          const data = Buffer.from(await req.arrayBuffer());
          if (data.length < 1024) return json({ ok: false, error: 'Prázdná nahrávka.' }, 400);
          const poskU = (await najemci.pro(t).then((x) => x.stav()).catch(() => null))?.state?.poskytovatel || {};
          const n = await nahravky.uloz(t, { kameraId: k, data, mime, cas: Number(url.searchParams.get('cas')) || undefined, delkaS: Number(url.searchParams.get('delkaS')) || null, uloziste: poskU.nahravkyUloziste || 'server', disk: !!poskU.nahravkyDisk,
            zdroj: ['rucni', 'plan', 'udalost'].includes(url.searchParams.get('zdroj')) ? url.searchParams.get('zdroj') : 'rucni', kdo: ja.jmeno || 'Správce', text: (url.searchParams.get('text') || '').slice(0, 300) });
          return n.chyba ? json({ ok: false, nahravka: n, error: n.chyba }, 502) : json({ ok: true, nahravka: n });
        }
        return json({ ok: false, error: 'Neznámá adresa.' }, 404);
      }

      // Zkušební SMS z nastavení dispečinku: ověří webhook Make a Twilio bez zakládání účtu rodině.
      if (path === '/api/sms/test') {
        if (rodina) return jenPoskytovatel();
        if (m === 'GET') {
          // Adresa jen zkráceně, aby šlo poznat, který scénář Make server volá (SMS ≠ asistent).
          const u = process.env.SMS_WEBHOOK_URL || '', a = process.env.ASISTENT_WEBHOOK_URL || '';
          const zkrat = (x) => (x.length > 14 ? x.slice(0, x.indexOf('/', 9) + 1) + '…' + x.slice(-6) : x);
          return json({ ok: true, nastaveno: sms.nastaveno, adresa: u ? zkrat(u) : null, stejnaJakoAsistent: !!u && u === a });
        }
        if (m !== 'POST') return json({ ok: false, error: 'GET nebo POST' }, 405);
        const { telefon, email } = await telo(req);
        if (!sms.nastaveno) return json({ ok: false, nastaveno: false, error: 'SMS není na serveru nastavená (SMS_WEBHOOK_URL, nastaví ./deploy/vps-env.sh).' }, 400);
        if (email !== undefined) {
          const e = String(email || '').trim().toLowerCase();
          const r = await sms.posliMail({ email: e, predmet: 'Famicura Kamera: zkušební e-mail', text: 'Zkušební e-mail ze serveru Famicura Kamera. Pokud ho čtete, upozornění e-mailem (události kamery) fungují.', typ: 'FAMICURA_TEST', poznamka: 'Zkušební e-mail z nastavení dispečinku.' });
          return r.ok ? json({ ok: true, nastaveno: true, email: e, sid: r.sid }) : json({ ok: false, nastaveno: true, email: e, error: r.error }, r.error.includes('platná adresa') ? 400 : 502);
        }
        const t = normalizeTelefon(telefon);
        if (!t) return json({ ok: false, error: 'Zadejte český mobil (9 číslic).' }, 400);
        const r = await sms.posli({ telefon: t, text: 'Famicura Kamera: zkusebni SMS ze serveru. Pokud ji ctete, SMS rodine (pozvanky, zadosti o obraz, upozorneni) funguji.', typ: 'FAMICURA_TEST', poznamka: 'Zkušební SMS z nastavení dispečinku.' });
        return r.ok ? json({ ok: true, nastaveno: true, telefon: t, sid: r.sid }) : json({ ok: false, nastaveno: true, telefon: t, error: r.error }, 502);
      }

      // Asistent dispečinku: AI přes webhook Make, když je nastavený; jinak odpovídá prohlížeč z nápovědy.
      if (m === 'POST' && path === '/api/proto/asistent') {
        if (rodina) return jenPoskytovatel();
        if (!asistent.nastaveno) return json({ ok: true, nastaveno: false });
        const { dotaz, kontext } = await telo(req);
        const r = await asistent.zeptej({ dotaz, kontext: typeof kontext === 'string' ? kontext.slice(0, 20000) : '' });
        return r.ok ? json({ ok: true, nastaveno: true, odpoved: r.odpoved }) : json({ ok: false, nastaveno: true, error: r.error }, 502);
      }

      if (m === 'GET' && path === '/api/events') {
        const since = Number(url.searchParams.get('since')) || 0;
        const cas = Date.now();                 // before the list, so nothing slips between
        const moje = (await kamery()).filter(smiKameru).map((c) => c.id);
        return json({ ok: true, cas, events: (udalosti ? udalosti.nedavne(since) : []).filter((e) => moje.includes(e.kameraId)) });
      }

      if (ja.role !== 'admin') return jenPoskytovatel();   // everything below is the server itself: plans, analysis, CLB1

      if (path === '/api/schedules') {
        if (m === 'GET') return json({ ok: true, max: MAX_INTERVALS, schedules: await store.nacti('schedules') });
        if (m !== 'PUT') return json({ ok: false, error: 'GET nebo PUT' }, 405);
        const { deviceId, intervals } = await telo(req);
        if (!isDeviceId(deviceId)) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400);
        const r = normalizeIntervals(intervals);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        const all = await store.nacti('schedules');
        if (r.intervals.length) all[deviceId] = r.intervals; else delete all[deviceId];
        await store.uloz('schedules', all);
        return json({ ok: true, intervals: r.intervals });
      }

      if (path === '/api/watch') {
        if (m === 'GET') return json({ ok: true, watch: await store.nacti('watch') });
        if (m !== 'PUT') return json({ ok: false, error: 'GET nebo PUT' }, 405);
        const { deviceId, watch } = await telo(req);
        if (!isDeviceId(deviceId)) return json({ ok: false, error: 'Neplatné ID kamery.' }, 400);
        const r = normalizeWatch(watch);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        const all = await store.nacti('watch');
        if (isDefaultWatch(r.watch)) delete all[deviceId]; else all[deviceId] = r.watch;
        await store.uloz('watch', all);
        return json({ ok: true, watch: r.watch });
      }

      if (m === 'GET' && path === '/api/diag') {
        return json({ ok: true, ...(await zaznamy.diagnostika(dbs)) });
      }

      if (m === 'POST' && path === '/api/clb') {
        const row = await telo(req);
        const out = await zaznamy.zapsat(dbs, row);
        if (!out.ok) return json({ ok: false, error: out.chyba }, out.status || 400);
        return json({ ok: true });
      }

      return json({ ok: false, aplikace: APLIKACE, error: 'Neznámá adresa.' }, 404);
    } catch (e) {
      if (e instanceof Go2rtcError) {
        console.error('[famicura-tapo] go2rtc', e.message, e.detail || '');
        return json({ ok: false, error: e.message, detail: e.detail, retry: e.retry }, e.status);
      }
      console.error('[famicura-tapo]', e);
      return json({ ok: false, error: e.message || 'Chyba serveru' }, e.status || 500);
    }
  };
}
