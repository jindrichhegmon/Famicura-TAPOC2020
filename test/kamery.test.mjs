import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCamera, rtspUrl, go2rtcYaml, cameraNamesLine, cameraAddress } from '../src/kamery.mjs';

const ok = { id: 'tapoc2020', name: 'Pokoj 12', ip: '192.168.1.50', user: 'famicura', pass: 'tajne', stream: 'stream1' };

test('platná kamera projde, název bez zadání = ID, výchozí stream1', () => {
  const r = normalizeCamera({ ...ok, name: '', stream: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.kamera.name, 'tapoc2020');
  assert.equal(r.kamera.stream, 'stream1');
  assert.equal(r.kamera.rtspPort, 554, 'bez zadání jde go2rtc na kameru napřímo');
  assert.equal(r.kamera.onvifPort, 2020);
  assert.equal(cameraAddress(r.kamera), '192.168.1.50');
});

test('kamera za tunelem SSH: porty VPS místo portů kamery', () => {
  const r = normalizeCamera({ ...ok, ip: '127.0.0.1', rtspPort: '10554', onvifPort: 12020 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.kamera.rtspPort, r.kamera.onvifPort], [10554, 12020]);
  assert.equal(rtspUrl(r.kamera), 'rtsp://famicura:tajne@127.0.0.1:10554/stream1');
  assert.equal(cameraAddress(r.kamera), '127.0.0.1:10554');
  for (const p of [0, 65536, 'abc', 1.5, -1]) {
    assert.equal(normalizeCamera({ ...ok, rtspPort: p }).ok, false, `rtspPort = ${p}`);
    assert.equal(normalizeCamera({ ...ok, onvifPort: p }).ok, false, `onvifPort = ${p}`);
  }
  assert.equal(normalizeCamera({ ...ok, rtspPort: '' }).kamera.rtspPort, 554, 'prázdné = výchozí');
});

test('nesmyslné údaje se odmítnou', () => {
  for (const [pole, hodnota] of [['id', 'Tapo C200'], ['id', '../x'], ['ip', '192.168.1'], ['ip', '300.1.1.1'],
    ['ip', 'kamera.local'], ['user', ''], ['pass', ''], ['user', 'a:b'], ['stream', 'stream3'],
    ['name', 'a;b'], ['pass', 'a\nb'], ['name', 'x'.repeat(61)]]) {
    assert.equal(normalizeCamera({ ...ok, [pole]: hodnota }).ok, false, `${pole} = ${JSON.stringify(hodnota)}`);
  }
});

test('heslo se zvláštními znaky se v adrese zakóduje a nic nerozbije', () => {
  const url = rtspUrl({ ...ok, pass: 'h"es@lo/#:1 %20x' });
  assert.equal(url, 'rtsp://famicura:h%22es%40lo%2F%23%3A1%20%2520x@192.168.1.50:554/stream1');
  assert.equal(decodeURIComponent(new URL(url).password), 'h"es@lo/#:1 %20x', 'zpět vyjde totéž heslo');
});

test('go2rtc.yaml: API jen na localhostu, vlastní servery vypnuté, kandidát je IP VPS', () => {
  const y = go2rtcYaml([normalizeCamera(ok).kamera]);
  assert.match(y, /api:\n  listen: "127\.0\.0\.1:1984"/);
  for (const s of ['rtsp', 'rtmp', 'srtp']) assert.match(y, new RegExp(`${s}:\\n  listen: ""`));
  assert.match(y, /webrtc:\n  listen: ":8555"\n  candidates:\n    - 95\.216\.201\.2:8555/);
  assert.match(y, /streams:\n  tapoc2020:\n    - "rtsp:\/\/famicura:tajne@192\.168\.1\.50:554\/stream1"/);
});

test('go2rtc.yaml bez kamer je platný a řekne, co dál', () => {
  assert.match(go2rtcYaml([]), /streams: \{\}  # zatím žádná kamera/);
  assert.throws(() => go2rtcYaml([], { publicIp: 'evil"\n' }));
});

test('CAMERA_NAMES pro server', () => {
  assert.equal(cameraNamesLine([{ id: 'a', name: 'Pokoj 1' }, { id: 'b', name: 'Chodba' }]), 'a=Pokoj 1; b=Chodba');
});
