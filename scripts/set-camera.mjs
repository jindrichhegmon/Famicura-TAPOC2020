/**
 * Kamery Tapo na VPS: cameras.json → go2rtc.yaml a CAMERA_NAMES v .env.
 * Volá ho deploy/vps-kamera.sh a deploy/vps-deploy.sh; běží na VPS jako jhnapps:
 *
 *   node scripts/set-camera.mjs nastav  < {"id","name","ip","user","pass","stream"[,"rtspPort","onvifPort"]}
 *   node scripts/set-camera.mjs seznam           → kamery bez hesel
 *   node scripts/set-camera.mjs smaz ID
 *   node scripts/set-camera.mjs obnov            → jen znovu vygeneruje go2rtc.yaml
 *   node scripts/set-camera.mjs tenant ID TENANT [místo]  → přiřadí kameru poskytovateli (tenantovi z PeceDomaPlus)
 *
 * Přihlášení ke kameře jde přes stdin, ne na příkazovou řádku, a leží jen
 * v cameras.json a go2rtc.yaml, oba s právy 600.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCamera, go2rtcYaml, cameraNamesLine, cameraAddress } from '../src/kamery.mjs';
import { hodnota, nastavit } from './set-env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAMERY = path.join(ROOT, 'cameras.json');
const YAML = path.join(ROOT, 'go2rtc.yaml');
const ENV = path.join(ROOT, '.env');

function zapis(file, text) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

const nacti = () => (existsSync(KAMERY) ? JSON.parse(readFileSync(KAMERY, 'utf8')) : []);

function obnov(kamery) {
  const env = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
  zapis(YAML, go2rtcYaml(kamery, { publicIp: hodnota(env, 'PUBLIC_IP') || undefined }));
  if (existsSync(ENV)) zapis(ENV, nastavit(env, 'CAMERA_NAMES', cameraNamesLine(kamery)));
}

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main([akce, id]) {
  if (akce === 'seznam') {
    const k = nacti();
    if (!k.length) console.log('Zatím žádná kamera.');
    for (const x of k) console.log(`${x.id.padEnd(16)} ${x.name}  (${cameraAddress(x)}, ${x.stream}, uživatel ${x.user}, tenant ${x.tenant || '– bez poskytovatele'}${x.place ? ', ' + x.place : ''})`);
    return;
  }
  if (akce === 'tenant') {
    const [, , , , tenant, ...misto] = process.argv;   // node skript tenant ID TENANT [místo…]
    const t = String(tenant || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(t)) throw new Error('ID tenanta: 4 až 16 písmen a číslic (dbo.Tenants v PeceDomaPlus).');
    const k = nacti(); const kam = k.find((x) => x.id === id);
    if (!kam) throw new Error(`Kamera ${id} není v cameras.json.`);
    kam.tenant = t; if (misto.length) kam.place = misto.join(' ').slice(0, 120);
    zapis(KAMERY, JSON.stringify(k, null, 2));
    console.log(`Kamera ${id} patří tenantovi ${t}${kam.place ? ' (' + kam.place + ')' : ''}.`);
    return;
  }
  if (akce === 'obnov') { obnov(nacti()); console.log('go2rtc.yaml vygenerován.'); return; }
  if (akce === 'smaz') {
    const k = nacti().filter((x) => x.id !== id);
    zapis(KAMERY, JSON.stringify(k, null, 2));
    obnov(k);
    console.log(`Kamera ${id} odebrána.`);
    return;
  }
  if (akce === 'nastav') {
    let raw;
    try { raw = JSON.parse(await stdin()); } catch { throw new Error('Na vstupu čekám JSON s údaji kamery.'); }
    const r = normalizeCamera(raw);
    if (!r.ok) throw new Error(r.error);
    const stara = nacti().find((x) => x.id === r.kamera.id);
    if (stara && !r.kamera.tenant && stara.tenant) r.kamera.tenant = stara.tenant;   // nové heslo kamery nemaže poskytovatele
    if (stara && !r.kamera.place && stara.place) r.kamera.place = stara.place;
    const k = nacti().filter((x) => x.id !== r.kamera.id).concat(r.kamera);
    zapis(KAMERY, JSON.stringify(k, null, 2));
    obnov(k);
    console.log(`Kamera ${r.kamera.id} („${r.kamera.name}“, ${cameraAddress(r.kamera)}, ${r.kamera.stream}${r.kamera.tenant ? ', tenant ' + r.kamera.tenant : ', zatím bez poskytovatele'}) uložena.`);
    return;
  }
  throw new Error('Použití: nastav | seznam | smaz ID | obnov | tenant ID TENANT [místo]');
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
