/**
 * Diagnostika událostí kamery: co kamera nabízí a co doopravdy posílá.
 *
 * Spouštět na VPS jako jhnapps ve složce aplikace (z Macu přes deploy/vps-diag.sh):
 *   node scripts/onvif-diag.mjs [sekund]     výchozí 60
 * Mezitím projděte před kamerou, opusťte zónu, zakryjte objektiv. Vypíše
 * model a firmware, všechna témata ONVIF, jak je kamera pojmenovala, a pak
 * každou zprávu tak, jak přišla (téma, operace, položky), i ty, které
 * aplikace nezařadí. Běží vedle běžného odběru serveru; ten se nemění.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnvif, DETEKCE } from '../src/onvif.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sekund = Math.max(10, Number(process.argv[2]) || 60);
const cas = () => new Date().toLocaleTimeString('cs-CZ');

let kamery;
try { kamery = JSON.parse(readFileSync(process.env.CAMERAS_FILE || path.join(ROOT, 'cameras.json'), 'utf8')); }
catch { console.error('Nenašel jsem cameras.json – kameru nastavuje ./deploy/vps-kamera.sh'); process.exit(1); }

for (const k of kamery) {
  console.log(`\n=== Kamera ${k.id} („${k.name}“) – ONVIF ${k.ip}:${k.onvifPort || 2020}, uživatel ${k.user}`);
  const c = createOnvif({ host: k.ip, port: k.onvifPort || 2020, user: k.user, pass: k.pass });
  let adresa = null;
  try {
    const posun = await c.syncClock();
    console.log(`hodiny kamery proti serveru: ${Math.round(posun / 1000)} s`);
    const info = await c.deviceInfo();
    console.log(`zařízení: ${info.manufacturer} ${info.model}, firmware ${info.firmware}`);
    const temata = await c.topics();
    console.log(`témata (${temata.length}):`);
    for (const t of temata) {
      const zname = t.items.some((it) => DETEKCE.some((d) => t.topic.endsWith(d.topic) && d.item === it));
      console.log(`  ${zname ? '✓' : ' '} ${t.topic}  [${t.items.join(', ')}]`);
    }
    console.log('  (✓ = aplikace zařadí; ostatní se zapisují jen do logu serveru)');

    adresa = await c.subscribe();
    console.log(`odběr založen: ${adresa}`);
    console.log(`čekám ${sekund} s na zprávy – teď se před kamerou hýbejte…`);
    const konec = Date.now() + sekund * 1000;
    let prazdnych = 0, zprav = 0;
    while (Date.now() < konec) {
      const vse = [];
      const ev = await c.pull(adresa, { timeoutS: Math.min(10, Math.ceil((konec - Date.now()) / 1000)), vse });
      if (!vse.length) { prazdnych++; process.stdout.write('.'); continue; }
      if (prazdnych) { console.log(''); prazdnych = 0; }
      for (const m of vse) {
        zprav++;
        console.log(`${cas()}  ${m.topic}  ${m.op || '-'}  ${JSON.stringify(m.data)}  (čas kamery ${m.time || '?'})`);
      }
      for (const e of ev) console.log(`${cas()}    → událost aplikace: ${e.kind}`);
    }
    console.log(`\nhotovo: ${zprav} zpráv za ${sekund} s`);
    if (!zprav) {
      console.log('Kamera neposlala nic. Zkontrolujte v aplikaci Tapo: Nastavení kamery → Detekce → zapnutou detekci pohybu/osob,');
      console.log('a verzi firmwaru (1.3.4 a 1.3.5 z jara 2023 události ONVIF neposílaly – aktualizace je v aplikaci Tapo).');
    }
  } catch (e) {
    console.error(`CHYBA: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
  } finally {
    if (adresa) await c.unsubscribe(adresa).catch(() => {});
  }
}
