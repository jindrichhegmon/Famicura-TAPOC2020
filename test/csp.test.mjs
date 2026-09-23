import test from 'node:test';
import assert from 'node:assert/strict';
import { CSP } from '../src/csp.mjs';

const smernice = Object.fromEntries(CSP.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test('prohlížeč smí mluvit jen s aplikací, jsdelivr a úložištěm modelu', () => {
  assert.deepEqual(smernice['connect-src'], ["'self'", 'https://cdn.jsdelivr.net', 'https://storage.googleapis.com']);
  // telemetrie MediaPipe – jiná doména než model, nesmí projít
  assert.ok(!CSP.includes('odml.pa.googleapis.com') && !CSP.includes('*.googleapis.com'));
});

test('to, co stránka opravdu používá, CSP dovoluje', () => {
  assert.ok(smernice['script-src'].includes("'wasm-unsafe-eval'"), 'MediaPipe je WASM');
  assert.ok(smernice['script-src'].includes("'unsafe-inline'"), 'stránka má vlastní inline modul');
  assert.ok(smernice['img-src'].includes('data:'), 'favicon je data:');
  assert.ok(smernice['media-src'].includes('blob:'), 'nahrávky jsou blob:');
  assert.equal(smernice['frame-ancestors'][0], "'none'");
});
