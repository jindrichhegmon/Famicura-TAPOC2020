/**
 * Správa kamer z hlavní aplikace (za heslem správce serveru) – totéž, co dělá
 * ./deploy/vps-kamera.sh z Terminálu, ale bez restartu serveru:
 *
 *   uloz(raw)                zavedení nebo úprava kamery (cameras.json, go2rtc.yaml, CAMERA_NAMES v .env)
 *   smaz(id)                 odebrání kamery
 *   tenant(id, tenant, místo) přiřazení poskytovateli (tenantovi z Péče doma plus)
 *   svetlo(id, tapoPass)     heslo účtu TP-Link pro světlo kamery (prázdné = odebrat)
 *   over(ip, porty)          zkouška, že na kameru jde tunelem spojení (TCP 554 a 2020)
 *   zkouska(id)              zkouška, že go2rtc z kamery dostane obraz
 *
 * go2rtc dostane změnu hned přes své API (PUT/DELETE /api/streams), odběr
 * událostí kamer se obnoví (udalosti.start()) a paměť světla se zapomene.
 * Soubory se zapisují atomicky (tmp + rename) s právy 600, hesla se ven
 * nevracejí. Hesla se nelogují.
 */
import { readFile, writeFile, rename, access, chmod } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { normalizeCamera, go2rtcYaml, cameraNamesLine, rtspUrl } from './kamery.mjs';
import { hodnota, nastavit } from '../scripts/set-env.mjs';

const chyba = (text, status = 400) => { const e = new Error(text); e.status = status; return e; };
const existuje = (f) => access(f).then(() => true, () => false);
/** Heslo z adresy streamu v hlášce go2rtc nesmí ven ani do logu. */
export const bezHesla = (text) => String(text || '').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');

/** TCP spojení na adresu a port (přes tunel z VPS) do timeoutu → { ok, ms } nebo { ok: false, chyba }. */
export function overTcp(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout: timeoutMs });
    const konec = (v) => { try { s.destroy(); } catch { /* nic */ } resolve(v); };
    s.once('connect', () => konec({ ok: true, ms: Date.now() - t0 }));
    s.once('timeout', () => konec({ ok: false, chyba: 'neodpovídá (timeout)' }));
    s.once('error', (e) => konec({ ok: false, chyba: e.code === 'ECONNREFUSED' ? 'port odmítnut (kamera na adrese je, port neběží)' : e.code === 'EHOSTUNREACH' ? 'adresa nedostupná (tunel nebo kamera)' : e.message }));
  });
}

export function createSpravaKamer({ root, soubor = path.join(root, 'cameras.json'), yaml = path.join(root, 'go2rtc.yaml'), env = path.join(root, '.env'),
                                    go2rtc = null, udalosti = null, svetlo = null, log = console, publicIp = () => process.env.PUBLIC_IP, tcp = overTcp } = {}) {
  if (!root) throw new Error('Správa kamer: chybí složka serveru.');

  async function nacti() {
    try { return JSON.parse(await readFile(soubor, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async function zapis(file, text) {
    const tmp = file + '.tmp';
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }
  /** cameras.json → go2rtc.yaml a CAMERA_NAMES (v .env i v běžícím procesu, ať názvy platí hned). */
  async function obnov(kamery) {
    await zapis(soubor, JSON.stringify(kamery, null, 2));
    const envText = (await existuje(env)) ? await readFile(env, 'utf8') : '';
    await zapis(yaml, go2rtcYaml(kamery, { publicIp: hodnota(envText, 'PUBLIC_IP') || publicIp() || undefined }));
    const names = cameraNamesLine(kamery);
    if (envText) await zapis(env, nastavit(envText, 'CAMERA_NAMES', names));
    process.env.CAMERA_NAMES = names;
  }
  /** go2rtc hned: nový / změněný stream, nebo smazaný. Chyba není chyba uložení – vrátí se jako varování. */
  async function go2rtcSync(kam, smazatId = null) {
    if (!go2rtc) return 'go2rtc není připojený, změna se projeví po jeho restartu.';
    try {
      if (smazatId) { if (go2rtc.smazStream) await go2rtc.smazStream(smazatId); }
      else if (go2rtc.nastavStream) { const u = rtspUrl(kam); await go2rtc.nastavStream(kam.id, [u, `ffmpeg:${u}#video=copy#audio=copy`]); }
      return '';
    } catch (e) {
      if (log?.error) log.error('[sprava-kamer] go2rtc:', bezHesla(e.message));
      return `go2rtc změnu nepřevzal (${bezHesla(e.message)}); projeví se po restartu go2rtc.`;
    } finally {
      // go2rtc si po PUT/DELETE přepíše go2rtc.yaml sám (s hesly kamer) – práva musí zůstat 600.
      try { await chmod(yaml, 0o600); } catch { /* soubor zatím není */ }
    }
  }
  const poZmene = async (id) => {
    try { await udalosti?.start?.(); } catch (e) { if (log?.error) log.error('[sprava-kamer] odběr událostí:', e.message); }
    try { svetlo?.zapomen?.(id); } catch { /* nic */ }
  };
  const verejne = (k) => ({ id: k.id, name: k.name, ip: k.ip, stream: k.stream, user: k.user, rtspPort: k.rtspPort, onvifPort: k.onvifPort, tenant: k.tenant || '', place: k.place || '', svetloUcet: k.tapoPass ? (k.tapoUser || 'admin') : '' });

  return {
    /** Kamery bez hesel. */
    async seznam() { return (await nacti()).map(verejne); },

    /** Zavedení nebo úprava: prázdné heslo u existující kamery = ponechat; tenant, místo a účet TP-Link se bez zadání také nechají. */
    async uloz(raw) {
      if (!raw || typeof raw !== 'object') throw chyba('Chybí údaje o kameře.');
      const kamery = await nacti();
      const stara = kamery.find((k) => k.id === String(raw.id ?? '').trim());
      const vstup = { ...raw };
      if (stara) {
        if (!vstup.pass) vstup.pass = stara.pass;
        if (!vstup.user) vstup.user = stara.user;
        if (vstup.tenant === undefined || vstup.tenant === null) vstup.tenant = stara.tenant;
        if (vstup.place === undefined || vstup.place === null) vstup.place = stara.place;
        if (!vstup.tapoPass && stara.tapoPass) { vstup.tapoPass = stara.tapoPass; vstup.tapoUser = stara.tapoUser; }
      }
      const r = normalizeCamera(vstup);
      if (!r.ok) throw chyba(r.error);
      const nove = kamery.filter((k) => k.id !== r.kamera.id).concat(r.kamera);
      await obnov(nove);
      const varovani = await go2rtcSync(r.kamera);
      await poZmene(r.kamera.id);
      if (log?.log) log.log('[sprava-kamer]', stara ? 'upravena' : 'zavedena', r.kamera.id, r.kamera.ip, r.kamera.stream, r.kamera.tenant || '(bez poskytovatele)');
      return { kamera: verejne(r.kamera), nova: !stara, varovani };
    },

    async smaz(id) {
      const kamery = await nacti();
      const kam = kamery.find((k) => k.id === id);
      if (!kam) throw chyba('Kamera není na serveru.', 404);
      await obnov(kamery.filter((k) => k.id !== id));
      const varovani = await go2rtcSync(null, id);
      await poZmene(id);
      if (log?.log) log.log('[sprava-kamer] odebrána', id);
      return { ok: true, varovani };
    },

    /** Přiřazení poskytovateli (prázdný tenant = bez poskytovatele); místo kamery volitelně. */
    async tenant(id, tenant, place) {
      const kamery = await nacti();
      const kam = kamery.find((k) => k.id === id);
      if (!kam) throw chyba('Kamera není na serveru.', 404);
      const r = normalizeCamera({ ...kam, tenant: tenant ?? '', place: place === undefined || place === null ? kam.place : place });
      if (!r.ok) throw chyba(r.error);
      Object.assign(kam, { tenant: r.kamera.tenant, place: r.kamera.place });
      await obnov(kamery);
      if (log?.log) log.log('[sprava-kamer] poskytovatel', id, '→', kam.tenant || '(bez poskytovatele)');
      return { kamera: verejne(kam) };
    },

    /** Heslo účtu TP-Link pro světlo kamery; prázdné = odebrat. */
    async svetlo(id, tapoPass, tapoUser = 'admin') {
      const kamery = await nacti();
      const kam = kamery.find((k) => k.id === id);
      if (!kam) throw chyba('Kamera není na serveru.', 404);
      const r = normalizeCamera({ ...kam, tapoUser: tapoUser || 'admin', tapoPass: tapoPass || '' });
      if (!r.ok) throw chyba(r.error);
      delete kam.tapoUser; delete kam.tapoPass;
      if (r.kamera.tapoPass) { kam.tapoUser = r.kamera.tapoUser; kam.tapoPass = r.kamera.tapoPass; }
      await obnov(kamery);
      svetlo?.zapomen?.(id);
      return { kamera: verejne(kam) };
    },

    /** Spojení tunelem: TCP na RTSP a ONVIF port kamery. */
    async over(ip, rtspPort = 554, onvifPort = 2020) {
      const r = normalizeCamera({ id: 'zkouska', ip, user: 'x', pass: 'x', rtspPort, onvifPort });
      if (!r.ok) throw chyba(r.error);
      const [rtsp, onvif] = await Promise.all([tcp(r.kamera.ip, r.kamera.rtspPort), tcp(r.kamera.ip, r.kamera.onvifPort)]);
      return { ip: r.kamera.ip, rtsp: { port: r.kamera.rtspPort, ...rtsp }, onvif: { port: r.kamera.onvifPort, ...onvif } };
    },

    /** Obraz z kamery přes go2rtc (jako kontrola na konci vps-kamera.sh); hláška bez hesla. */
    async zkouska(id) {
      if (!(await nacti()).some((k) => k.id === id)) throw chyba('Kamera není na serveru.', 404);
      if (!go2rtc?.probe) return { ok: false, detail: 'go2rtc není připojený' };
      const p = await go2rtc.probe(id);
      return { ok: !!p.ok, detail: p.ok ? null : bezHesla(p.detail || 'kamera neodpovídá'), h265: !!p.h265 };
    },
  };
}
