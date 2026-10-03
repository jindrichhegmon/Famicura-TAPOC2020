import test from 'node:test';
import assert from 'node:assert/strict';
import { createSms } from '../src/sms.mjs';

const ticho = { log() {} };
const odpoved = (status, text) => async () => new Response(text, { status });

test('sms: bez adresy webhooku se neposílá a říká proč', async () => {
  const sms = createSms({ url: '', fetchImpl: async () => { throw new Error('nemá se volat'); }, log: ticho });
  assert.equal(sms.nastaveno, false);
  const r = await sms.posli({ telefon: '777123456', text: 'ahoj' });
  assert.equal(r.ok, false); assert.match(r.error, /SMS_WEBHOOK_URL/);
});

test('sms: scénář odpoví { ok: true, sid } → odesláno; webhook dostane klíč, telefon, text, typ, poznámku', async () => {
  const volani = [];
  const sms = createSms({ url: 'https://hook.example/x', klic: 'tajny-klic', log: ticho,
    fetchImpl: async (url, init) => { volani.push({ url, body: JSON.parse(init.body), ct: init.headers['Content-Type'] }); return new Response('{"ok":true,"sid":"SM123","status":"queued"}', { status: 200 }); } });
  assert.equal(sms.nastaveno, true);
  const r = await sms.posli({ telefon: '777123456', text: 'Famicura: test', typ: 'FAMICURA_TEST', poznamka: 'pozn' });
  assert.deepEqual(r, { ok: true, sid: 'SM123', status: 'queued' });
  assert.equal(volani.length, 1);
  assert.equal(volani[0].url, 'https://hook.example/x');
  assert.equal(volani[0].ct, 'application/json');
  assert.deepEqual(volani[0].body, { klic: 'tajny-klic', kanal: 'sms', telefon: '777123456', text: 'Famicura: test', typ: 'FAMICURA_TEST', poznamka: 'pozn' });
});

test('sms: holé „Accepted“ od Make není odeslaná SMS (klíč neprošel filtrem)', async () => {
  const sms = createSms({ url: 'https://hook.example/x', klic: 'spatny', fetchImpl: odpoved(200, 'Accepted'), log: ticho });
  const r = await sms.posli({ telefon: '777123456', text: 'ahoj' });
  assert.equal(r.ok, false); assert.match(r.error, /SMS_WEBHOOK_KLIC/);
});

test('sms: chyba scénáře, chybový stav HTTP a nečekaná odpověď se hlásí dispečinku', async () => {
  const a = await createSms({ url: 'https://h/x', fetchImpl: odpoved(200, '{"ok":false,"error":"Twilio: neplatné číslo"}'), log: ticho }).posli({ telefon: '777123456', text: 'a' });
  assert.equal(a.ok, false); assert.match(a.error, /Twilio: neplatné číslo/);
  const b = await createSms({ url: 'https://h/x', fetchImpl: odpoved(500, 'Internal'), log: ticho }).posli({ telefon: '777123456', text: 'a' });
  assert.equal(b.ok, false); assert.match(b.error, /odpověděl 500/);
  const c = await createSms({ url: 'https://h/x', fetchImpl: odpoved(200, '<html>'), log: ticho }).posli({ telefon: '777123456', text: 'a' });
  assert.equal(c.ok, false); assert.match(c.error, /nečekaně/);
});

test('sms: výpadek sítě a neplatný telefon nebo prázdný text', async () => {
  const sms = createSms({ url: 'https://h/x', fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: ticho });
  const r = await sms.posli({ telefon: '777123456', text: 'a' });
  assert.equal(r.ok, false); assert.match(r.error, /ECONNRESET/);
  assert.match((await sms.posli({ telefon: '+420 777', text: 'a' })).error, /9 číslic/);
  assert.match((await sms.posli({ telefon: '777123456', text: '  ' })).error, /bez textu/);
});

test('mail: stejný webhook s kanal = mail, adresa se ověří, odpověď { ok, id }', async () => {
  const volani = [];
  const sms = createSms({ url: 'https://hook.example/x', klic: 'k', log: ticho,
    fetchImpl: async (url, init) => { volani.push(JSON.parse(init.body)); return new Response('{"ok":true,"kanal":"mail","id":"AAMk123"}', { status: 200 }); } });
  const r = await sms.posliMail({ email: 'rodina@example.cz', predmet: 'Famicura Kamera: Možný pád – Babička', text: 'Událost…', typ: 'FAMICURA_UDALOST' });
  assert.deepEqual(r, { ok: true, sid: 'AAMk123', status: null });
  assert.deepEqual(volani[0], { klic: 'k', kanal: 'mail', email: 'rodina@example.cz', predmet: 'Famicura Kamera: Možný pád – Babička', text: 'Událost…', typ: 'FAMICURA_UDALOST', poznamka: '' });
  assert.match((await sms.posliMail({ email: 'neni-adresa', predmet: 'x', text: 'y' })).error, /platná adresa/);
  assert.match((await createSms({ url: '', log: ticho }).posliMail({ email: 'a@b.cz', predmet: 'x', text: 'y' })).error, /SMS_WEBHOOK_URL/);
});

test('sms: do logu serveru jde jen konec čísla, ne text', async () => {
  const radky = [];
  const sms = createSms({ url: 'https://h/x', fetchImpl: odpoved(200, '{"ok":true}'), log: { log: (s) => radky.push(s) } });
  await sms.posli({ telefon: '777123456', text: 'Tajny odkaz https://x/r/abc', typ: 'FAMICURA_POZVANKA' });
  assert.equal(radky.length, 1);
  assert.match(radky[0], /^\[sms\] …456: odesláno \(FAMICURA_POZVANKA\)$/);
  assert.ok(!radky[0].includes('abc'));
});
