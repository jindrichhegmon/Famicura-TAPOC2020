import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { vyrizniRamce, rozeberObsah, slozRamec, createNaramky, popisZdravi } from '../src/naramky.mjs';
import { createStavTenantu } from '../src/stav-tenant.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';

const T = '22202480FAMICURA';
const ticho = { log() {}, error() {} };
const ID = '9705357211';
const POLOHA = '081026,105959,A,50.03760,N,13.87110,E,0.0,0,250,8,80,95,0,0';

test('rámce protokolu hodinek: celé, rozdělené, s indexem, smetí mezi nimi, neúplné zůstanou v bufferu', () => {
  const a = vyrizniRamce(Buffer.from(`[3G*${ID}*0009*LK,50,100][3G*${ID}*0003*TKQ]`, 'latin1'));
  assert.deepEqual(a.ramce.map((r) => [r.vyrobce, r.id, r.index, r.obsah]), [['3G', ID, null, 'LK,50,100'], ['3G', ID, null, 'TKQ']]);
  assert.equal(a.zbytek.length, 0);
  // novější firmware s indexem; smetí před rámcem
  const b = vyrizniRamce(Buffer.from(`xx[SG*${ID}*0012*0002*LK]`, 'latin1'));
  assert.deepEqual(b.ramce.map((r) => [r.vyrobce, r.index, r.obsah]), [['SG', '0012', 'LK']]);
  assert.equal(slozRamec(b.ramce[0], 'LK'), `[SG*${ID}*0012*0002*LK]`);
  // neúplný rámec zůstane, dokud nedojde zbytek
  const cely = `[3G*${ID}*0009*LK,50,100]`;
  const c1 = vyrizniRamce(Buffer.from(cely.slice(0, 10), 'latin1'));
  assert.equal(c1.ramce.length, 0); assert.equal(c1.zbytek.toString('latin1'), cely.slice(0, 10));
  const c2 = vyrizniRamce(Buffer.concat([c1.zbytek, Buffer.from(cely.slice(10), 'latin1')]));
  assert.equal(c2.ramce.length, 1); assert.equal(c2.ramce[0].obsah, 'LK,50,100');
  // špatná délka (chybí „]“ na konci) se zahodí, další rámec projde
  const d = vyrizniRamce(Buffer.from(`[3G*${ID}*0004*LK,50,100][3G*${ID}*0002*LK]`, 'latin1'));
  assert.deepEqual(d.ramce.map((r) => r.obsah), ['LK']);
  assert.equal(slozRamec({ vyrobce: '3G', id: ID, index: null }, 'AL'), `[3G*${ID}*0002*AL]`);
});

test('obsah rámce: LK s baterií, UD s polohou, AL = SOS, stav s bitem pádu a slabé baterie, neplatný fix bez polohy', () => {
  const lk = rozeberObsah('LK,50,0,87'); assert.equal(lk.typ, 'LK'); assert.equal(lk.baterie, 87); assert.deepEqual(lk.poplachy, []);
  const ud = rozeberObsah(`UD,${POLOHA},00000000,7,255,230,1,0,0,0,0`);
  assert.equal(ud.typ, 'UD'); assert.equal(ud.baterie, 95); assert.deepEqual(ud.poplachy, []);
  assert.ok(Math.abs(ud.poloha.lat - 50.0376) < 1e-6 && Math.abs(ud.poloha.lon - 13.8711) < 1e-6);
  assert.equal(new Date(ud.poloha.cas).toISOString(), '2026-10-08T10:59:59.000Z');
  const al = rozeberObsah(`AL,${POLOHA},00010000`); assert.deepEqual(al.poplachy, ['sos']);
  const alBez = rozeberObsah(`AL,${POLOHA},00000000`); assert.deepEqual(alBez.poplachy, ['sos'], 'AL bez bitu je nouzové tlačítko');
  const pad = rozeberObsah(`AL,${POLOHA},00200000`); assert.deepEqual(pad.poplachy, ['pad']);
  const bat = rozeberObsah(`UD,${POLOHA},00020000`); assert.deepEqual(bat.poplachy, ['baterie']);
  const bat2 = rozeberObsah(`UD,${POLOHA},00000001`); assert.deepEqual(bat2.poplachy, ['baterie']);
  const v = rozeberObsah('UD,081026,105959,V,0.0,N,0.0,E,0.0,0,0,0,80,60,0,0,00000000'); assert.equal(v.poloha, null); assert.equal(v.baterie, 60);
  // ReachFar V48: AL_LTE / UD_LTE, bez GPS fixu (V) ale se souřadnicemi z mobilní sítě = přibližná poloha
  const lte = rozeberObsah('AL_LTE,081026,134553,V,49.262834,N,17.7108907,E,0.00,0.0,0.0,0,58,95,0,0,00010000,1,255,230,1,0,0,0,0');
  assert.deepEqual(lte.poplachy, ['sos']); assert.equal(lte.baterie, 95); assert.equal(lte.poloha.priblizna, true); assert.ok(Math.abs(lte.poloha.lat - 49.262834) < 1e-6);
  assert.deepEqual(rozeberObsah('UD_LTE,081026,134553,A,49.262834,N,17.7108907,E,0.00,0.0,0.0,5,58,95,0,0,00000000').poplachy, []);
  const jih = rozeberObsah('UD,081026,105959,A,33.8688,S,151.2093,E,0,0,0,5,80,50,0,0,00000000'); assert.ok(jih.poloha.lat < 0 && jih.poloha.lon > 0);
  assert.deepEqual(rozeberObsah('bphrt,122,75,73,,,,').zdravi, { tlakS: 122, tlakD: 75, tep: 73 });
  assert.deepEqual(rozeberObsah('heart,72').zdravi, { tep: 72 }); assert.deepEqual(rozeberObsah('oxygen,97').zdravi, { spo2: 97 });
  assert.deepEqual(rozeberObsah('btemp2,1,36.6').zdravi, { teplota: 36.6 }); assert.equal(rozeberObsah('bphrt,0,0,0').zdravi, null);
  assert.equal(popisZdravi({ tep: 73, tlakS: 122, tlakD: 75, spo2: 97, teplota: 36.6 }), 'tep 73, tlak 122/75, kyslík 97 %, teplota 36,6 °C');
  assert.equal(rozeberObsah('calllog,602520069,,2,1,1791467169,11').zdravi, null);
});

function tenant(tabulky) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const kamery = async () => [{ id: 'tapoc2020', name: 'Byt Novákovi', tenant: T }];
  const s = createStavTenantu({ tenant: T, tabulky, kamery, now, log: ticho, nazev: 'FamiCura s.r.o.' });
  return { s, kamery, now, posun: (ms) => { t += ms; } };
}

async function spoj(port) {
  const sock = net.connect({ port, host: '127.0.0.1' });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  let prijato = '';
  sock.on('data', (d) => { prijato += d.toString('latin1'); });
  return { sock, posli: (text) => new Promise((res) => sock.write(text, 'latin1', res)), prijato: () => prijato, konec: () => sock.destroy() };
}
const ram = (obsah, id = ID) => slozRamec({ vyrobce: '3G', id, index: null }, obsah);
const cekej = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 15)); } return false; };

test('server náramků: ozvání se zapíše ke kameře, SOS a pád jdou do fronty kamery, opakování do minuty se nezdvojí, neznámé ID jen potvrdí', async () => {
  const tb = createMockTabulky();
  const { s, kamery, now, posun } = tenant(tb);
  await s.proved('setNaramek', ['tapoc2020', ID, 'Dispečer']);
  const najemci = { pro: async () => s };
  const n = createNaramky({ najemci, kamery, port: 0, host: '127.0.0.1', now, log: ticho });
  const port = await n.start();
  try {
    const k = await spoj(port);
    // ozvání s baterií: potvrzení a zápis ke kameře
    await k.posli(ram('LK,50,0,87'));
    assert.ok(await cekej(() => k.prijato().includes(`[3G*${ID}*0002*LK]`)), 'potvrzení LK');
    assert.ok(await cekej(async () => (await s.stav()).state.patients[0].naramek?.baterie === 87), 'baterie u kamery');
    let st = await s.stav();
    assert.equal(st.state.patients[0].naramek.posledni, now());
    assert.match(tb.data[T].A_KAM_Kamera[0].Naramek, /"baterie":87/, 'uloženo v tabulce');
    // SOS s polohou: potvrzení AL, kritická událost s odkazem na mapu
    await k.posli(ram(`AL,${POLOHA},00010000,7,255,230,1,0,0,0,0`));
    assert.ok(await cekej(() => k.prijato().includes(`[3G*${ID}*0002*AL]`)), 'potvrzení AL');
    assert.ok(await cekej(async () => (await s.stav()).state.events.some((e) => e.kind === 'sos')), 'událost SOS');
    st = await s.stav();
    const sos = st.state.events.find((e) => e.kind === 'sos');
    assert.match(sos.text, /nouzové tlačítko/); assert.match(sos.text, /maps\.google\.com\/\?q=50\.03760,13\.87110/); assert.equal(sos.real, true);
    assert.equal(st.state.notifications[0].kind, 'sos', 'alert ve frontě');
    assert.ok(st.state.patients[0].naramek.poloha && Math.abs(st.state.patients[0].naramek.poloha.lat - 50.0376) < 1e-6, 'poslední poloha u kamery');
    // opakovaný SOS (zařízení poplach opakuje) do minuty jen potvrdí, událost nevznikne znovu
    await k.posli(ram(`AL,${POLOHA},00010000,7,255,230,1,0,0,0,0`));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await s.stav()).state.events.filter((e) => e.kind === 'sos').length, 1);
    // po minutě znovu: nová událost; pád v UD (bit 21)
    posun(61 * 1000);
    await k.posli(ram(`UD,${POLOHA},00200000,7,255,230,1,0,0,0,0`));
    assert.ok(await cekej(async () => (await s.stav()).state.events.some((e) => e.kind === 'devfall')), 'pád hlášený náramkem');
    assert.ok(!k.prijato().includes('*UD]'), 'UD se nepotvrzuje');
    // slabá baterie: technická událost
    posun(61 * 1000);
    await k.posli(ram(`UD,${POLOHA},00020000,7,255,230,1,0,0,0,0`));
    assert.ok(await cekej(async () => (await s.stav()).state.events.some((e) => e.kind === 'battery')), 'slabá baterie');
    // AL_LTE (V48) se potvrzuje jako AL a dává SOS
    posun(61 * 1000);
    k.prijato(); await k.posli(ram(`AL_LTE,081026,134553,V,49.262834,N,17.7108907,E,0.00,0.0,0.0,0,58,95,0,0,00010000,1,255,230,1,0,0,0,0`));
    assert.ok(await cekej(async () => (await s.stav()).state.events.filter((e) => e.kind === 'sos').length === 2), 'SOS z AL_LTE');
    assert.equal((k.prijato().match(/\*0002\*AL\]/g) || []).length, 3, 'AL_LTE potvrzeno jako AL (i opakovaný poplach se potvrzuje)');
    assert.match((await s.stav()).state.events.find((e) => e.kind === 'sos').text, /přibližná poloha/);
    // zdravotní měření: hodnoty u kamery, řádek v historii jednou za hodinu
    await k.posli(ram('bphrt,122,75,73,,,,')); await k.posli(ram('oxygen,97')); await k.posli(ram('btemp2,1,36.6'));
    assert.ok(await cekej(async () => (await s.stav()).state.patients[0].naramek.zdravi?.teplota === 36.6), 'teplota u kamery');
    const z = (await s.stav()).state.patients[0].naramek.zdravi;
    assert.equal(z.tlakS, 122); assert.equal(z.tlakD, 75); assert.equal(z.tep, 73); assert.equal(z.spo2, 97);
    assert.equal((await s.stav()).state.events.filter((e) => e.kind === 'mereni').length, 1, 'jen jeden řádek měření za hodinu');
    assert.match((await s.stav()).state.events.find((e) => e.kind === 'mereni').text, /tep 73, tlak 122\/75/);
    await k.posli(ram('heart,71'));
    assert.ok(await cekej(async () => (await s.stav()).state.patients[0].naramek.zdravi?.tep === 71), 'tep se přepíše, ostatní zůstane');
    assert.equal((await s.stav()).state.patients[0].naramek.zdravi.spo2, 97);
    // neznámé zařízení: potvrdí LK, nic nezapíše
    const pocet = (await s.stav()).state.events.length;
    await k.posli(ram(`AL,${POLOHA},00010000,7,255,230,1,0,0,0,0`, '1111122222'));
    assert.ok(await cekej(() => k.prijato().includes('[3G*1111122222*0002*AL]')));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await s.stav()).state.events.length, pocet, 'cizí ID nic nezapsalo');
    assert.equal(n.stav().nezname, 1);
    k.konec();
  } finally { await n.stop(); }
});

test('náramek: SOS projde i u kamery deaktivované rodinou, přiřazení jen platné ID, odebrání', async () => {
  const tb = createMockTabulky();
  const { s, kamery, now } = tenant(tb);
  await assert.rejects(() => s.proved('setNaramek', ['tapoc2020', 'a b', 'x']), /5 až 20/);
  await s.proved('setNaramek', ['tapoc2020', ID, 'Dispečer']);
  assert.match((await s.stav()).state.events[0].text, /přiřazen ke kameře/);
  await s.proved('deaktivace', ['tapoc2020', true, 'Eva']);
  const n = createNaramky({ najemci: { pro: async () => s }, kamery, port: 0, host: '127.0.0.1', now, log: ticho });
  const port = await n.start();
  try {
    const k = await spoj(port);
    await k.posli(ram(`AL,${POLOHA},00010000,7,255,230,1,0,0,0,0`));
    assert.ok(await cekej(async () => (await s.stav()).state.events.some((e) => e.kind === 'sos')), 'SOS i při deaktivaci kamery');
    k.konec();
  } finally { await n.stop(); }
  await s.proved('setNaramek', ['tapoc2020', '', 'Dispečer']);
  const st = await s.stav();
  assert.equal(st.state.patients[0].naramek, undefined); assert.match(st.state.events[0].text, /odebrán/);
  assert.equal(tb.data[T].A_KAM_Kamera[0].Naramek, null);
});

test('příkazy náramku: změřit tep → hrtstart,1 do spojení, vypnout → POWEROFF, nepřipojený 409, vlastní příkaz jen bezpečné znaky; automatické měření podle nastavení', async () => {
  const tb = createMockTabulky();
  const { s, kamery, now, posun } = tenant(tb);
  await s.proved('setNaramek', ['tapoc2020', ID, 'Dispečer']);
  const n = createNaramky({ najemci: { pro: async () => s }, kamery, port: 0, host: '127.0.0.1', now, log: ticho });
  const port = await n.start({ autoMs: 0 });
  try {
    await assert.rejects(() => n.prikaz(ID, 'tep'), /není připojený/);
    const k = await spoj(port);
    await k.posli(ram('LK,0,0,95'));
    assert.ok(await cekej(() => n.pripojen(ID)), 'po prvním rámci je náramek připojený');
    assert.deepEqual(await n.prikaz(ID, 'tep'), { ok: true, obsah: 'hrtstart,1' });
    assert.ok(await cekej(() => k.prijato().includes(`[3G*${ID}*000A*hrtstart,1]`)), 'příkaz dorazil do spojení náramku');
    await n.prikaz(ID, 'vypnout');
    assert.ok(await cekej(() => k.prijato().includes(`[3G*${ID}*0008*POWEROFF]`)));
    await assert.rejects(() => n.prikaz(ID, 'neco'), /Neznámý příkaz/);
    await assert.rejects(() => n.prikaz(ID, 'vlastni', { vlastni: 'x]*[y' }), /Příkaz:/);
    assert.equal((await n.prikaz(ID, 'vlastni', { vlastni: 'hrtstart,300' })).obsah, 'hrtstart,300');
    // automatické měření: každých 10 min tep a tlak; první tik pošle hned, druhý až po intervalu
    await assert.rejects(() => s.proved('setNaramekAuto', ['tapoc2020', { min: 5000 }, 'x']), /0 \(vypnuto\) až 1440/);
    await s.proved('setNaramekAuto', ['tapoc2020', { min: 10, tep: true, tlak: true }, 'Dispečer']);
    assert.match((await s.stav()).state.events[0].text, /každých 10 min: tep, tlak/);
    k.prijato(); const pred = k.prijato().length;
    assert.equal(await n.tik(), 2);
    assert.ok(await cekej(() => k.prijato().slice(pred).includes('hrtstart,1') && k.prijato().slice(pred).includes('*bphrt]')), 'tep i tlak odeslány');
    assert.equal(await n.tik(), 0, 'před uplynutím intervalu nic');
    posun(11 * 60 * 1000);
    assert.equal(await n.tik(), 2, 'po intervalu znovu');
    await s.proved('setNaramekAuto', ['tapoc2020', { min: 0 }, 'Dispečer']);
    posun(11 * 60 * 1000);
    assert.equal(await n.tik(), 0, 'vypnuto');
    k.konec();
    assert.ok(await cekej(() => !n.pripojen(ID)), 'po zavření spojení není připojený');
  } finally { await n.stop(); }
});
