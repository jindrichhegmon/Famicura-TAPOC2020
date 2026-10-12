import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrstenKlice, novyKlic, normKlic, formatKlic, odkazAplikace, textSmsKlic } from '../src/prsten-klic.mjs';

function memStore() { const data = {}; return { data, async nacti(n) { return structuredClone(data[n] || {}); }, async uloz(n, v) { data[n] = structuredClone(v); } }; }

test('párovací kód prstenu: tvar, normalizace, odkaz do aplikace klienta a SMS bez diakritiky do 160 znaků', () => {
  const k = novyKlic();
  assert.match(k, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/, 'bez 0/O a 1/I');
  assert.equal(formatKlic('abcd efgh-jkl2'), 'ABCD-EFGH-JKL2');
  assert.equal(normKlic('ABCD-EFGH-JKL2'), 'ABCDEFGHJKL2');
  assert.equal(odkazAplikace('ABCDEFGHJKL2', 'https://pecedomamobil.netlify.app/'), 'https://pecedomamobil.netlify.app/?prsten=ABCD-EFGH-JKL2');
  const sms = textSmsKlic({ odkaz: odkazAplikace('ABCDEFGHJKL2'), poskytovatel: 'Péče doma Liberec' });
  assert.ok(sms.length <= 200, `délka ${sms.length}`); assert.match(sms, /^PeceDoma \(Pece doma Liberec\): /); assert.doesNotMatch(sms, /[^\x00-\x7F]/);
  assert.match(sms, /kod prstenu ABCD-EFGH-JKL2 pro aplikaci PeceDoma Prsten/);
  const smsT = textSmsKlic({ odkaz: odkazAplikace('ABCDEFGHJKL2', undefined, '22202480FAMICURA'), poskytovatel: 'x'.repeat(40) }); assert.ok(smsT.length <= 200, `s tenantem ${smsT.length}`);
});

test('párovací kódy: jeden platný na kameru, nový starý nahradí, zrušení, hledání podle kódu i s pomlčkami a malými písmeny', async () => {
  const store = memStore(); let n = 0;
  const pk = createPrstenKlice({ store, now: () => 1000 + n++, rand: (max) => (n * 7) % max });
  assert.equal(await pk.pro('T1', 'k1'), null);
  const a = await pk.vytvor('T1', 'k1');
  assert.equal((await pk.pro('T1', 'k1')).klic, a.klic);
  assert.deepEqual(await pk.najdi(formatKlic(a.klic).toLowerCase()), { tenant: 'T1', kamera: 'k1' });
  const b = await pk.vytvor('T1', 'k1');
  assert.notEqual(a.klic, b.klic);
  assert.equal(await pk.najdi(a.klic), null, 'starý kód neplatí');
  assert.deepEqual(await pk.najdi(b.klic), { tenant: 'T1', kamera: 'k1' });
  const c = await pk.vytvor('T2', 'k9');
  assert.equal(Object.keys(store.data['prsten-klice']).length, 2);
  assert.equal(await pk.zrus('T1', 'k1'), 1);
  assert.equal(await pk.najdi(b.klic), null); assert.deepEqual(await pk.najdi(c.klic), { tenant: 'T2', kamera: 'k9' });
  assert.equal(await pk.najdi('kratky'), null); assert.equal(await pk.najdi(''), null);
});
