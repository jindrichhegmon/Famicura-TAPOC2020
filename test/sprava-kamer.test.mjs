import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSpravaKamer, bezHesla, overTcp } from '../src/sprava-kamer.mjs';
import net from 'node:net';

const ticho = { log() {}, error() {} };

async function priprav({ env = 'PUBLIC_IP=95.216.201.2\nCAMERA_NAMES=\n', kamery = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sprava-'));
  await writeFile(path.join(root, '.env'), env);
  if (kamery) await writeFile(path.join(root, 'cameras.json'), JSON.stringify(kamery));
  const volani = [];
  const go2rtc = {
    async nastavStream(name, src) { volani.push({ nastav: name, src }); if (name === 'padne') throw new Error('go2rtc rtsp://u:tajne@1.2.3.4 odmítl'); },
    async smazStream(name) { volani.push({ smaz: name }); },
    async probe(id) { return id === 'ok' ? { ok: true } : { ok: false, detail: 'rtsp://Famicura:tajne@192.168.8.211:554 401 Unauthorized' }; },
  };
  const udalosti = { starty: 0, async start() { this.starty++; } };
  const svetlo = { zapomenuto: [], zapomen(id) { this.zapomenuto.push(id); } };
  const tcp = async (host, port) => (port === 554 ? { ok: true, ms: 3 } : { ok: false, chyba: 'neodpovídá (timeout)' });
  const s = createSpravaKamer({ root, go2rtc, udalosti, svetlo, log: ticho, tcp });
  return { root, s, volani, udalosti, svetlo };
}

test('správa kamer: zavedení zapíše cameras.json (600), go2rtc.yaml, CAMERA_NAMES; go2rtc dostane stream hned; hesla ven nejdou', async () => {
  const { root, s, volani, udalosti, svetlo } = await priprav();
  assert.deepEqual(await s.seznam(), []);
  const r = await s.uloz({ id: 'sbhmijas', name: 'SBH Mijas', ip: '192.168.8.211', user: 'Famicura001', pass: 'tajne', stream: 'stream1', tenant: '22202480famicura', place: 'Apartmán' });
  assert.equal(r.nova, true); assert.equal(r.varovani, '');
  assert.deepEqual(r.kamera, { id: 'sbhmijas', name: 'SBH Mijas', ip: '192.168.8.211', stream: 'stream1', user: 'Famicura001', rtspPort: 554, onvifPort: 2020, tenant: '22202480FAMICURA', place: 'Apartmán', svetloUcet: '' });
  assert.ok(!('pass' in r.kamera));
  const ulozene = JSON.parse(await readFile(path.join(root, 'cameras.json'), 'utf8'));
  assert.equal(ulozene[0].pass, 'tajne');
  assert.equal((await stat(path.join(root, 'cameras.json'))).mode & 0o777, 0o600);
  const yaml = await readFile(path.join(root, 'go2rtc.yaml'), 'utf8');
  assert.match(yaml, /sbhmijas:/); assert.match(yaml, /192\.168\.8\.211/); assert.match(yaml, /95\.216\.201\.2:8555/);
  assert.match(await readFile(path.join(root, '.env'), 'utf8'), /CAMERA_NAMES=sbhmijas=SBH Mijas/);
  assert.equal(process.env.CAMERA_NAMES, 'sbhmijas=SBH Mijas');
  assert.equal(volani[0].nastav, 'sbhmijas');
  assert.match(volani[0].src[0], /^rtsp:\/\/Famicura001:tajne@192\.168\.8\.211:554\/stream1$/);
  assert.match(volani[0].src[1], /^ffmpeg:rtsp:.*#video=copy#audio=copy$/);
  assert.equal(udalosti.starty, 1); assert.deepEqual(svetlo.zapomenuto, ['sbhmijas']);
});

test('správa kamer: úprava bez hesla ponechá heslo, tenant i účet TP-Link; neplatné údaje = 400 a nic se nezapíše', async () => {
  const { root, s } = await priprav({ kamery: [{ id: 'k1', name: 'Jedna', ip: '10.0.0.1', user: 'u', pass: 'p', stream: 'stream1', rtspPort: 554, onvifPort: 2020, tenant: 'ABCD', place: 'Chodba', tapoUser: 'admin', tapoPass: 'cloud' }] });
  const r = await s.uloz({ id: 'k1', name: 'Jedna nově', ip: '10.0.0.2', stream: 'stream2' });
  assert.equal(r.nova, false);
  const k = JSON.parse(await readFile(path.join(root, 'cameras.json'), 'utf8'))[0];
  assert.equal(k.pass, 'p'); assert.equal(k.user, 'u'); assert.equal(k.tenant, 'ABCD'); assert.equal(k.place, 'Chodba'); assert.equal(k.tapoPass, 'cloud');
  assert.equal(k.ip, '10.0.0.2'); assert.equal(k.stream, 'stream2'); assert.equal(k.name, 'Jedna nově');
  assert.equal(r.kamera.svetloUcet, 'admin');
  await assert.rejects(s.uloz({ id: 'Velke ID', ip: '1.1.1.1', user: 'u', pass: 'p' }), (e) => e.status === 400 && /ID kamery/.test(e.message));
  await assert.rejects(s.uloz({ id: 'k2', ip: 'neni-ip', user: 'u', pass: 'p' }), (e) => e.status === 400);
  await assert.rejects(s.uloz({ id: 'k2', ip: '1.1.1.1', user: '', pass: '' }), (e) => e.status === 400 && /uživatele i heslo/.test(e.message));
  assert.equal(JSON.parse(await readFile(path.join(root, 'cameras.json'), 'utf8')).length, 1);
});

test('správa kamer: poskytovatel a místo; heslo TP-Link nastavit i odebrat; smazání včetně go2rtc; neznámá kamera 404', async () => {
  const { root, s, volani, svetlo } = await priprav({ kamery: [{ id: 'k1', name: 'Jedna', ip: '10.0.0.1', user: 'u', pass: 'p', stream: 'stream1', rtspPort: 554, onvifPort: 2020, tenant: '', place: '' }, { id: 'k2', name: 'Dvě', ip: '10.0.0.2', user: 'u', pass: 'p', stream: 'stream1', rtspPort: 554, onvifPort: 2020, tenant: '', place: '' }] });
  let r = await s.tenant('k1', '22202480famicura', 'Chodba CLB');
  assert.equal(r.kamera.tenant, '22202480FAMICURA'); assert.equal(r.kamera.place, 'Chodba CLB');
  r = await s.tenant('k1', '');
  assert.equal(r.kamera.tenant, ''); assert.equal(r.kamera.place, 'Chodba CLB', 'bez místa se místo nechá');
  await assert.rejects(s.tenant('k1', 'x'), (e) => e.status === 400);
  await assert.rejects(s.tenant('neni', 'ABCD'), (e) => e.status === 404);
  r = await s.svetlo('k1', 'cloud');
  assert.equal(r.kamera.svetloUcet, 'admin');
  assert.equal(JSON.parse(await readFile(path.join(root, 'cameras.json'), 'utf8'))[0].tapoPass, 'cloud');
  assert.ok(svetlo.zapomenuto.includes('k1'));
  r = await s.svetlo('k1', '');
  assert.equal(r.kamera.svetloUcet, '');
  assert.ok(!('tapoPass' in JSON.parse(await readFile(path.join(root, 'cameras.json'), 'utf8'))[0]));
  r = await s.smaz('k2');
  assert.equal(r.ok, true);
  assert.deepEqual(volani.at(-1), { smaz: 'k2' });
  assert.deepEqual((await s.seznam()).map((k) => k.id), ['k1']);
  assert.doesNotMatch(await readFile(path.join(root, 'go2rtc.yaml'), 'utf8'), /k2:/);
  assert.equal(process.env.CAMERA_NAMES, 'k1=Jedna');
  await assert.rejects(s.smaz('k2'), (e) => e.status === 404);
});

test('správa kamer: go2rtc nepřevzal = uloženo s varováním bez hesla; bez go2rtc varování o restartu; ověření spojení; zkouška obrazu bez hesla', async () => {
  const { s } = await priprav();
  const r = await s.uloz({ id: 'padne', ip: '1.2.3.4', user: 'u', pass: 'tajne' });
  assert.match(r.varovani, /go2rtc změnu nepřevzal/); assert.doesNotMatch(r.varovani, /tajne/); assert.match(r.varovani, /rtsp:\/\/\*\*\*@/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sprava-'));
  const bez = createSpravaKamer({ root, log: ticho, publicIp: () => '1.1.1.1' });
  const r2 = await bez.uloz({ id: 'k', ip: '1.2.3.4', user: 'u', pass: 'p' });
  assert.match(r2.varovani, /restartu/);
  assert.match(await readFile(path.join(root, 'go2rtc.yaml'), 'utf8'), /1\.1\.1\.1:8555/, 'PUBLIC_IP z prostředí, když .env není');
  const o = await s.over('192.168.8.211');
  assert.equal(o.rtsp.ok, true); assert.equal(o.rtsp.port, 554); assert.equal(o.onvif.ok, false); assert.equal(o.onvif.port, 2020);
  await assert.rejects(s.over('neni'), (e) => e.status === 400);
  await s.uloz({ id: 'ok', ip: '1.2.3.4', user: 'u', pass: 'p' });
  assert.deepEqual(await s.zkouska('ok'), { ok: true, detail: null, h265: false });
  const z = await s.zkouska('padne');
  assert.equal(z.ok, false); assert.match(z.detail, /rtsp:\/\/\*\*\*@192/); assert.doesNotMatch(z.detail, /tajne/);
  await assert.rejects(s.zkouska('neni'), (e) => e.status === 404);
  assert.equal(bezHesla('x rtsp://a:b@1.1.1.1/s y'), 'x rtsp://***@1.1.1.1/s y');
});

test('overTcp: otevřený port odpoví, zavřený hlásí odmítnutí', async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ok = await overTcp('127.0.0.1', port, 2000);
  assert.equal(ok.ok, true); assert.ok(ok.ms >= 0);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const ne = await overTcp('127.0.0.1', port, 2000);
  assert.equal(ne.ok, false); assert.match(ne.chyba, /odmítnut/);
});
