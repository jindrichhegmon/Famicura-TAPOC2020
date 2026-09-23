import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGo2rtc, Go2rtcError } from '../src/go2rtc.mjs';
import { createStore } from '../src/store.mjs';

// Odpovědi go2rtc 1.9.14, jak jsme je naměřili proti skutečnému go2rtc.
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', type: init.headers?.['content-type'], body: init.body });
    for (const [re, handler] of routes) if (re.test(url)) return handler(url, init);
    throw new TypeError('fetch failed');
  };
  f.seen = seen;
  return f;
}
const text = (body, status = 200, type = 'text/plain') => new Response(body, { status, headers: { 'content-type': type } });

test('webrtc: offer jako application/sdp, answer z odpovědi 201', async () => {
  const f = fakeFetch([[/\/api\/webrtc\?src=tapoc2020$/, () => text('v=0 answer', 201, 'application/sdp')]]);
  const g = createGo2rtc({ url: 'http://127.0.0.1:1984/', fetchImpl: f });
  assert.equal(await g.webrtc('tapoc2020', 'v=0 offer'), 'v=0 answer');
  assert.equal(f.seen[0].method, 'POST');
  assert.equal(f.seen[0].type, 'application/sdp');
  assert.equal(f.seen[0].body, 'v=0 offer');
});

test('webrtc: prohlížeč bez H.264 dostane srozumitelnou chybu', async () => {
  const f = fakeFetch([[/webrtc/, () => text('unable to populate media section, RTPSender created with no codecs', 500)]]);
  await assert.rejects(createGo2rtc({ fetchImpl: f }).webrtc('tapoc2020', 'x'),
    (e) => e instanceof Go2rtcError && /H\.264/.test(e.message) && e.status === 502 && e.retry === false);
});

test('webrtc: nedostupná kamera', async () => {
  const f = fakeFetch([[/webrtc/, () => text('dial tcp 192.168.1.50:554: i/o timeout', 500)]]);
  await assert.rejects(createGo2rtc({ fetchImpl: f }).webrtc('tapoc2020', 'x'),
    (e) => /Kamera neodpovídá/.test(e.message) && /i\/o timeout/.test(e.detail) && e.retry === true);
});

test('go2rtc neběží', async () => {
  await assert.rejects(createGo2rtc({ fetchImpl: fakeFetch([]) }).streams(),
    (e) => e instanceof Go2rtcError && /neodpovídá/.test(e.message));
});

test('verze: z /api, bez dalších údajů', async () => {
  const f = fakeFetch([[/\/api$/, () => text(JSON.stringify({ version: '1.9.14', config_path: '/opt/famicura-tapo/go2rtc.yaml' }), 200, 'application/json')]]);
  assert.equal(await createGo2rtc({ fetchImpl: f }).version(), '1.9.14');
});

test('seznam streamů a kontrola kamery', async () => {
  const f = fakeFetch([
    [/\/api\/streams$/, () => text(JSON.stringify({ tapoc2020: { producers: [] }, druha: {} }), 200, 'application/json')],
    [/stream\.mp4\?src=tapoc2020/, () => text('mp4 data', 200, 'video/mp4')],
    [/stream\.mp4\?src=mrtva/, () => text('dial tcp: connection refused', 500)],
  ]);
  const g = createGo2rtc({ fetchImpl: f });
  assert.deepEqual(await g.streams(), ['tapoc2020', 'druha']);
  assert.deepEqual(await g.probe('tapoc2020'), { ok: true, status: 200, detail: null });
  const dead = await g.probe('mrtva');
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /refused/);
  assert.equal((await g.probe('nikde')).ok, false, 'síťová chyba = neodpovídá');
});

test('úložiště: soubor s právy 600, zápis bez rozbitého mezistavu', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'famicura-store-'));
  const s = createStore(path.join(dir, 'data'));
  assert.deepEqual(await s.nacti('schedules'), {}, 'chybějící soubor je prázdno');
  await s.uloz('schedules', { tapoc2020: [{ from: '22:00', to: '06:00' }] });
  assert.deepEqual(await s.nacti('schedules'), { tapoc2020: [{ from: '22:00', to: '06:00' }] });
  assert.deepEqual(await readdir(path.join(dir, 'data')), ['schedules.json'], 'žádný .tmp nezůstal');
  assert.equal((await stat(path.join(dir, 'data', 'schedules.json'))).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await readFile(path.join(dir, 'data', 'schedules.json'), 'utf8')));
});
