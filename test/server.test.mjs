/**
 * server.mjs naostro: obraz přes HTTPS musí procházet průběžně (ne až po
 * konci) a skončit, když prohlížeč odejde. Falešný go2rtc posílá kousek dat
 * každých 100 ms; kdyby server odpověď nejdřív celou sbíral, první kousek by
 * nepřišel dřív než poslední.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const volnyPort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let go2rtc, server, port, go2rtcPort;
const zavrene = [];                     // requests the fake go2rtc saw closed by its client
let posilej = true;

before(async () => {
  go2rtcPort = await volnyPort();
  go2rtc = http.createServer((req, res) => {
    if (req.url === '/api/streams') { res.setHeader('content-type', 'application/json'); return res.end('{"tapoc2020":{}}'); }
    if (req.url.startsWith('/api/stream.mp4?src=tapoc2020&video=h264') || req.url.startsWith('/api/hls/')) {
      res.writeHead(200, { 'content-type': req.url.includes('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
      let n = 0;
      const t = setInterval(() => { if (posilej && n < 50) res.write(Buffer.alloc(1024, n++)); }, 100);
      res.on('close', () => { clearInterval(t); zavrene.push(req.url); });
      return;
    }
    if (req.url.startsWith('/api/stream.mp4?src=')) { res.writeHead(500); return res.end('streams: source not found'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => go2rtc.listen(go2rtcPort, '127.0.0.1', r));

  port = await volnyPort();
  server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
    GO2RTC_URL: `http://127.0.0.1:${go2rtcPort}`, FAMICURA_PASSWORD: 'heslo', SESSION_KEY: 'klic', SQL_PASSWORD: '',
    DATA_DIR: mkdtempSync('/tmp/famicura-test-'), CAMERAS_FILE: '/nonexistent/cameras.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r, j) => { server.stdout.on('data', (d) => { if (/běží/.test(String(d))) r(); }); server.on('exit', j); setTimeout(() => j(new Error('server nenaběhl')), 10000); });
});

after(async () => {
  server.kill('SIGINT');
  await new Promise((r) => server.on('exit', r));
  await new Promise((r) => go2rtc.close(r));
});

async function cookie() {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'heslo' }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('obraz přes HTTPS jde průběžně a skončí s klientem', async () => {
  const c = await cookie();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/stream.mp4?deviceId=tapoc2020`)).status, 401, 'jen po přihlášení');

  const ctrl = new AbortController();
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/stream.mp4?deviceId=tapoc2020`, { headers: { cookie: c }, signal: ctrl.signal });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.ok(!first.done && first.value.length > 0);
  assert.ok(Date.now() - t0 < 1500, `první kousek přišel za ${Date.now() - t0} ms, ne až po konci (5 s)`);
  await reader.read();
  ctrl.abort();                                       // the viewer leaves
  const t1 = Date.now();
  while (!zavrene.length && Date.now() - t1 < 3000) await new Promise((res) => setTimeout(res, 50));
  assert.equal(zavrene.length, 1, 'go2rtc dostal konec, když klient odešel');
});

test('HLS: master a díly procházejí, cizí názvy a odkazy ne', async () => {
  const c = await cookie();
  const r = await fetch(`http://127.0.0.1:${port}/api/hls/segment.m4s?id=abc_DEF-1&n=3`, { headers: { cookie: c } });
  assert.equal(r.status, 200);
  await r.body.cancel();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/hls/config.yaml?id=abc`, { headers: { cookie: c } })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/hls/segment.m4s?id=../x`, { headers: { cookie: c } })).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/stream.mp4?deviceId=cizi`, { headers: { cookie: c } })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/stream.mp4?deviceId=../x`, { headers: { cookie: c } })).status, 400);
});
