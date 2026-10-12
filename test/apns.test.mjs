import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApns, jwtApns } from '../src/apns.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('APNs: JWT ES256 s kid a iss, podpis ověřitelný veřejným klíčem', () => {
  const jwt = jwtApns({ klic: privateKey, keyId: 'ABC123DEFG', teamId: '433U5VUWE2', cas: 1_760_000_000_000 });
  const [h, t, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(JSON.parse(Buffer.from(t, 'base64url')), { iss: '433U5VUWE2', iat: 1_760_000_000 });
  assert.equal(Buffer.from(s, 'base64url').length, 64, 'podpis r||s');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${t}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('APNs: tichá notifikace – hlavičky, prostředí, obnova JWT, bez klíče nic neposílá', async () => {
  const volani = [];
  let cas = 1_760_000_000_000;
  const prenos = async (host, hl, telo) => { volani.push({ host, hl, telo }); return { status: 200, reason: '' }; };
  const a = createApns({ keyId: 'ABC123DEFG', teamId: '433U5VUWE2', klic: pem, prenos, now: () => cas });
  assert.equal(a.nastaveno, true); assert.equal(a.topic, 'cz.pecedoma.prsten');
  assert.equal((await a.probud('ab'.repeat(32))).ok, true);
  await a.probud('cd'.repeat(32), 'sandbox');
  assert.equal(volani[0].host, 'https://api.push.apple.com'); assert.equal(volani[1].host, 'https://api.sandbox.push.apple.com');
  const hl = volani[0].hl;
  assert.equal(hl[':path'], '/3/device/' + 'ab'.repeat(32));
  assert.equal(hl['apns-push-type'], 'background'); assert.equal(hl['apns-priority'], '5'); assert.equal(hl['apns-topic'], 'cz.pecedoma.prsten');
  assert.deepEqual(JSON.parse(volani[0].telo), { aps: { 'content-available': 1 } });
  assert.equal(volani[1].hl.authorization, hl.authorization, 'JWT se znovu používá');
  cas += 41 * 60_000; await a.probud('ab'.repeat(32));
  assert.notEqual(volani[2].hl.authorization, hl.authorization, 'po 40 min nový JWT');
  const bez = createApns({ keyId: '', teamId: '', prenos });
  assert.equal(bez.nastaveno, false); assert.equal((await bez.probud('ab'.repeat(32))).ok, false);
  assert.equal(volani.length, 3);
});
