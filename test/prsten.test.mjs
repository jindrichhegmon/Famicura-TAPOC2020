import test from 'node:test';
import assert from 'node:assert/strict';
import { paket, platny, paketCas, paketHistorieTepu, paketStart, skladacHistorieTepu, mereni, baterie, pulnocUtc, CMD, TYP } from '../public/proto/prsten-protokol.js';

test('paket prstenu: 16 bajtů, kontrolní součet', () => {
  const p = paket(CMD.BATERIE);
  assert.equal(p.length, 16); assert.equal(p[0], 3); assert.equal(p[15], 3); assert.ok(platny(p));
  const s = paketStart(TYP.SPO2);
  assert.deepEqual([...s.slice(0, 3)], [0x69, 3, 1]); assert.equal(s[15], (0x69 + 3 + 1) & 0xff);
  const x = paket(0x15, [200, 200]); assert.equal(x[15], (0x15 + 400) & 0xff, 'součet přeteče přes 255');
  assert.equal(platny(Uint8Array.from([...x.slice(0, 15), 0])), false);
});

test('čas a den v UTC (BCD)', () => {
  const c = paketCas(new Date(Date.UTC(2026, 9, 11, 13, 5, 9)));
  assert.deepEqual([...c.slice(0, 8)], [1, 0x26, 0x10, 0x11, 0x13, 0x05, 0x09, 1]);
  const d = Date.UTC(2026, 9, 11);
  assert.equal(pulnocUtc(d + 5 * 3600_000), d);
  const h = paketHistorieTepu(d); const t = d / 1000;
  assert.equal(h[1] | (h[2] << 8) | (h[3] << 16) | (h[4] << 24), t | 0);
});

test('historie tepu: hlavička, první paket s časem, další pakety, nuly se vynechají', () => {
  const t0 = Date.UTC(2026, 9, 11) / 1000;
  const v = skladacHistorieTepu();
  assert.equal(v(paket(0x15, [0, 3, 5])), null);
  assert.equal(v(paket(0x15, [1, t0 & 255, (t0 >>> 8) & 255, (t0 >>> 16) & 255, (t0 >>> 24) & 255, 60, 0, 62, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(v(paket(0x03, [80])), null, 'cizí odpověď se ignoruje');
  const r = v(paket(0x15, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 71]));
  assert.equal(r.hotovo, true);
  assert.deepEqual(r.zaznamy, [{ cas: t0 * 1000, tep: 60 }, { cas: (t0 + 600) * 1000, tep: 62 }, { cas: (t0 + 21 * 300) * 1000, tep: 71 }]);
  assert.deepEqual(skladacHistorieTepu()(paket(0x15, [0xff])), { hotovo: true, zaznamy: [] }, 'prsten za den nic nemá');
});

test('odpověď měření a baterie', () => {
  assert.deepEqual(mereni(paket(0x69, [1, 0, 72])), { typ: 1, chyba: 0, hodnota: 72 });
  assert.equal(mereni(paket(0x03, [50])), null);
  assert.deepEqual(baterie(paket(0x03, [64, 1])), { procenta: 64, nabiji: true });
});
