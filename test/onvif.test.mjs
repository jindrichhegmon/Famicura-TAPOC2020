import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, najdi, vsechny, textUzlu } from '../src/xml.mjs';
import { createOnvif, OnvifError, druhDetekce, detekceZTopicSet, udalostiZeZprav } from '../src/onvif.mjs';
import { startFakeOnvif } from './fake-onvif.mjs';

/* ---------- XML ---------- */

test('parser XML: prefixy pryč, entity, CDATA, samouzavírací značky, atributy', () => {
  const doc = parseXml(`<?xml version="1.0"?><!-- pozn. --><s:Envelope xmlns:s="x"><s:Body>
    <tt:Item Name="A&amp;B" wstop:topic="true"/><tt:Text>&lt;1&gt; &#x41;&#66;</tt:Text><c><![CDATA[<raw>]]></c>
  </s:Body></s:Envelope>`);
  assert.equal(najdi(doc, 'Envelope', 'Body').name, 'Body');
  assert.equal(najdi(doc, 'Item').attrs.Name, 'A&B');
  assert.equal(najdi(doc, 'Item').attrs.topic, 'true');
  assert.equal(textUzlu(najdi(doc, 'Text')), '<1> AB');
  assert.equal(textUzlu(najdi(doc, 'c')), '<raw>');
  assert.equal(vsechny(doc, 'Item').length, 1);
  assert.equal(najdi(doc, 'Neni'), null);
});

test('parser XML: rozbité XML se pozná, nespadne tiše', () => {
  assert.throws(() => parseXml('<a><b></a>'), /neočekávané/);
  assert.throws(() => parseXml('<a><b>'), /neuzavřený/);
});

/* ---------- co kamera umí ---------- */

test('témata Tapo → druhy událostí; mimo RuleEngine a bez Is… se nenabízí', () => {
  assert.deepEqual(druhDetekce('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion'), { kind: 'cam-motion', label: null });
  assert.deepEqual(druhDetekce('tns1:VideoSource/MotionAlarm', 'State'), { kind: 'cam-motion', label: null });
  assert.equal(druhDetekce('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', 'IsPet').kind, 'cam-pet');
  assert.equal(druhDetekce('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', 'IsVehicle').kind, 'cam-vehicle');
  // Something the catalogue does not know, but the camera declares as a detector.
  assert.deepEqual(druhDetekce('tns1:RuleEngine/BabyCryDetector/BabyCry', 'IsBabyCry'), { kind: 'cam-babycry', label: 'BabyCry (hlásí kamera)' });
  assert.equal(druhDetekce('tns1:VideoSource/ImageTooDark', 'State'), null);
  assert.equal(druhDetekce('tns1:Device/Trigger/DigitalInput', 'IsOpen'), null);
  assert.equal(druhDetekce('tns1:RuleEngine/X/Y', 'Token'), null);
});

test('GetEventProperties: C210 nabídne pohyb, osobu, vozidlo, zvíře, zakrytí a pláč; C200 jen pohyb', async () => {
  const c210 = await startFakeOnvif({ model: 'c210' });
  const c200 = await startFakeOnvif({ model: 'c200' });
  try {
    const a = createOnvif({ host: '127.0.0.1', port: c210.port, user: c210.user, pass: c210.pass });
    await a.syncClock();
    assert.deepEqual((await a.capabilities()).map((e) => e.kind),
      ['cam-motion', 'cam-person', 'cam-vehicle', 'cam-pet', 'cam-tamper', 'cam-babycry']);
    const b = createOnvif({ host: '127.0.0.1', port: c200.port, user: c200.user, pass: c200.pass });
    await b.syncClock();
    assert.deepEqual(await b.capabilities(), [{ kind: 'cam-motion', label: null }]);
    // The camera named its LAN address for the events service; we asked our own.
    assert.ok(c210.calls.some((c) => c.op === 'GetEventProperties' && c.url === '/onvif/service'));
  } finally { await c210.close(); await c200.close(); }
});

/* ---------- přihlášení a odběr ---------- */

test('digest WS-Security kamera přijme i s hodinami o 3 minuty jinak; špatné heslo se pozná', async () => {
  const cam = await startFakeOnvif({ clockSkewS: 180 });
  try {
    const ok = createOnvif({ host: '127.0.0.1', port: cam.port, user: cam.user, pass: cam.pass });
    const posun = await ok.syncClock();
    assert.ok(Math.abs(posun - 180_000) < 5000, `posun hodin ${posun}`);
    await ok.capabilities();
    assert.ok(cam.calls.filter((c) => c.auth).every((c) => c.auth.ok), JSON.stringify(cam.calls.map((c) => c.auth)));

    const bad = createOnvif({ host: '127.0.0.1', port: cam.port, user: cam.user, pass: 'jine' });
    await bad.syncClock();
    await assert.rejects(bad.capabilities(), (e) => e instanceof OnvifError && /účet kamery nebo heslo/.test(e.message));
  } finally { await cam.close(); }
});

test('odběr: adresa odběru vede na náš host, zprávy chodí, obnova a zrušení projdou', async () => {
  const cam = await startFakeOnvif();
  try {
    const c = createOnvif({ host: '127.0.0.1', port: cam.port, user: cam.user, pass: cam.pass });
    await c.syncClock();
    const adresa = await c.subscribe();
    assert.equal(new URL(adresa).host, `127.0.0.1:${cam.port}`);
    assert.match(adresa, /\/onvif\/Subscription\?Idx=1$/);

    assert.deepEqual(await c.pull(adresa, { timeoutS: 1 }), []);        // nothing happened
    cam.initialized();                                                   // "Initialized" true counts as on (Tapo marks everything so)
    cam.motion();                                                        // still on: nothing new
    cam.motion(false);
    cam.vehicle();
    cam.tooDark();                                                       // not a detection
    const ev = await c.pull(adresa, { timeoutS: 1 });
    assert.deepEqual(ev.map((e) => e.kind), ['cam-motion', 'cam-vehicle']);
    cam.motion();                                                        // off → on again: a new event
    assert.deepEqual((await c.pull(adresa, { timeoutS: 1 })).map((e) => e.kind), ['cam-motion']);
    assert.ok(Date.now() - ev[0].at < 5000);

    cam.motion(false);
    cam.motion1970();                                                    // firmware with a stuck clock
    const [stuck] = await c.pull(adresa, { timeoutS: 1 });
    assert.ok(Date.now() - stuck.at < 5000, 'čas 1970 nahradí čas serveru');

    await c.renew(adresa);
    await c.unsubscribe(adresa);
    assert.equal(cam.subs.size, 0);
    const pullCall = cam.calls.find((x) => x.op === 'PullMessages');
    assert.equal(pullCall.to, adresa, 'wsa:To nese adresu odběru');
    await assert.rejects(c.pull(adresa, { timeoutS: 1 }), OnvifError);   // gone
  } finally { await cam.close(); }
});

test('kamera, která neodpovídá, dá srozumitelnou chybu', async () => {
  const c = createOnvif({ host: '127.0.0.1', port: 1, user: 'u', pass: 'p' });
  await assert.rejects(c.syncClock(), (e) => e instanceof OnvifError && /neodpovídá/.test(e.message));
});

test('zprávy: jen přechody na true, každá položka zvlášť', () => {
  const doc = parseXml(`<r><wsnt:NotificationMessage><wsnt:Topic>tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="2026-09-23T10:00:00Z" PropertyOperation="Changed"><tt:Data>
    <tt:SimpleItem Name="IsVehicle" Value="false"/><tt:SimpleItem Name="IsPet" Value="true"/></tt:Data></tt:Message></wsnt:Message>
    </wsnt:NotificationMessage></r>`);
  assert.deepEqual(udalostiZeZprav(doc), [{ kind: 'cam-pet', label: null, at: Date.parse('2026-09-23T10:00:00Z') }]);
});

test('co kamera hlásí mimo katalog, se neztratí (pro log serveru)', () => {
  const doc = parseXml(`<r><wsnt:NotificationMessage><wsnt:Topic>tns1:RuleEngine/AreaDetector/AreaLeave</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="2026-09-23T10:00:00Z" PropertyOperation="Changed"><tt:Data>
    <tt:SimpleItem Name="Token" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>
    <wsnt:NotificationMessage><wsnt:Topic>tns1:VideoSource/ImageTooDark</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="2026-09-23T10:00:00Z" PropertyOperation="Changed"><tt:Data>
    <tt:SimpleItem Name="State" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage></r>`);
  const jine = [];
  assert.deepEqual(udalostiZeZprav(doc, Date.now, jine), []);
  assert.deepEqual(jine, [{ topic: 'RuleEngine/AreaDetector/AreaLeave', item: 'Token' }, { topic: 'VideoSource/ImageTooDark', item: 'State' }]);
});

test('diagnostika: model a firmware, všechna témata kamery, zprávy tak, jak přišly', async () => {
  const cam = await startFakeOnvif();
  try {
    const c = createOnvif({ host: '127.0.0.1', port: cam.port, user: cam.user, pass: cam.pass });
    await c.syncClock();
    const info = await c.deviceInfo();
    assert.equal(info.model, 'C210');
    assert.match(info.firmware, /^1\.3\.11/);
    const temata = await c.topics();
    assert.ok(temata.some((t) => t.topic === 'RuleEngine/CellMotionDetector/Motion' && t.items.includes('IsMotion')));
    assert.ok(temata.some((t) => t.topic === 'VideoSource/ImageTooDark'), 'i mimo katalog');
    const adresa = await c.subscribe();
    cam.initialized(); cam.motion(false); cam.tooDark();
    const vse = [];
    const ev = await c.pull(adresa, { timeoutS: 1, vse });
    assert.deepEqual(ev.map((e) => e.kind), ['cam-motion']);
    assert.deepEqual(vse.map((m) => [m.topic, m.op, m.data]), [
      ['RuleEngine/CellMotionDetector/Motion', 'Initialized', { IsMotion: 'true' }],
      ['RuleEngine/CellMotionDetector/Motion', 'Changed', { IsMotion: 'false' }],
      ['VideoSource/ImageTooDark', 'Changed', { State: 'true' }]]);
    await c.unsubscribe(adresa);
  } finally { await cam.close(); }
});

test('Tapo C220: každá zpráva „Initialized“, true každých 100 ms, false na konci → jedna událost na detekci', () => {
  const zprava = (v, t) => `<wsnt:NotificationMessage><wsnt:Topic>tns1:RuleEngine/PeopleDetector/People</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="${t}" PropertyOperation="Initialized"><tt:Data><tt:SimpleItem Name="IsPeople" Value="${v}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
  const stavy = new Map();
  const a = parseXml(`<r>${zprava(true, '2026-09-23T14:28:44Z')}${zprava(true, '2026-09-23T14:28:44Z')}${zprava(true, '2026-09-23T14:28:45Z')}</r>`);
  assert.deepEqual(udalostiZeZprav(a, Date.now, [], null, stavy).map((e) => e.kind), ['cam-person']);
  const b = parseXml(`<r>${zprava(true, '2026-09-23T14:28:46Z')}${zprava(false, '2026-09-23T14:28:51Z')}</r>`);
  assert.deepEqual(udalostiZeZprav(b, Date.now, [], null, stavy), [], 'pokračování a konec nejsou nová událost');
  const c = parseXml(`<r>${zprava(true, '2026-09-23T14:30:00Z')}</r>`);
  assert.deepEqual(udalostiZeZprav(c, Date.now, [], null, stavy).map((e) => e.kind), ['cam-person'], 'další příchod je nová událost');
});
