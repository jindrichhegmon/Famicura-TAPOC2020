import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCamera, rtspUrl, go2rtcYaml, cameraNamesLine } from '../src/kamery.mjs';

const ok = { id: 'tapoc2020', name: 'Pokoj 12', ip: '192.168.1.50', user: 'famicura', pass: 'tajne', stream: 'stream1' };

test('platná kamera projde, název bez zadání = ID, výchozí stream1', () => {
  const r = normalizeCamera({ ...ok, name: '', stream: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.kamera.name, 'tapoc2020');
  assert.equal(r.kamera.stream, 'stream1');
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
