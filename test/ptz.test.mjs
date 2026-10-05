import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnvif } from '../src/onvif.mjs';
import { createPtz } from '../src/ptz.mjs';

const OBAL = (telo) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${telo}</s:Body></s:Envelope>`;
/** Kamera Tapo tak, jak odpovídá na ONVIF: capabilities s PTZ, jeden profil s PTZ konfigurací, ContinuousMove / Stop / GotoHome. */
function fakeKamera(zaznam, { ptz = true } = {}) {
  return async (url, init) => {
    const b = init.body;
    zaznam.push({ url: String(url), body: b });
    if (/GetSystemDateAndTime/.test(b)) return new Response(OBAL('<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>10</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>4</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'), { headers: { 'content-type': 'application/soap+xml' } });
    if (/GetCapabilities/.test(b)) return new Response(OBAL(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://192.168.8.211:2020/onvif/media_service</tt:XAddr></tt:Media>${ptz ? '<tt:PTZ><tt:XAddr>http://192.168.8.211:2020/onvif/ptz_service</tt:XAddr></tt:PTZ>' : ''}</tds:Capabilities></tds:GetCapabilitiesResponse>`));
    if (/GetProfiles/.test(b)) return new Response(OBAL('<trt:GetProfilesResponse><trt:Profiles token="profile_1" fixed="true"><tt:Name>mainStream</tt:Name><tt:PTZConfiguration token="ptz_1"/></trt:Profiles><trt:Profiles token="profile_2"><tt:Name>minorStream</tt:Name></trt:Profiles></trt:GetProfilesResponse>'));
    if (/ContinuousMove|Stop|GotoHomePosition/.test(b)) return new Response(OBAL('<tptz:ContinuousMoveResponse/>'));
    return new Response(OBAL('<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text>neznámý požadavek</s:Text></s:Reason></s:Fault>'), { status: 500 });
  };
}

test('ONVIF PTZ: najde službu a profil s PTZ, krok = ContinuousMove + Stop na naší adrese (tunel), home a stop', async () => {
  const zaznam = [];
  const k = createOnvif({ host: '10.77.0.9', port: 2020, user: 'Kamera', pass: 'tajne', fetchImpl: fakeKamera(zaznam) });
  await k.ptz('left', { rychlost: 0.7, ms: 120 });
  const ptzVolani = zaznam.filter((z) => /ptz_service/.test(z.url));
  assert.equal(ptzVolani.length, 2, 'ContinuousMove a Stop');
  assert.match(ptzVolani[0].url, /^http:\/\/10\.77\.0\.9:2020\/onvif\/ptz_service$/, 'adresa kamery z capabilities přepsaná na tunel');
  assert.match(ptzVolani[0].body, /ContinuousMove.*ProfileToken>profile_1<.*PanTilt x="-0\.7" y="0"/s);
  assert.match(ptzVolani[1].body, /tptz:Stop.*PanTilt>true/s);
  assert.match(ptzVolani[0].body, /UsernameToken/, 'přihlášení kamerou');
  await k.ptz('up', { ms: 100 }); await k.ptz('home');
  const vse = zaznam.filter((z) => /ptz_service/.test(z.url)).map((z) => z.body);
  assert.match(vse[2], /PanTilt x="0" y="0\.5"/); assert.match(vse[4], /GotoHomePosition/);
  assert.equal(zaznam.filter((z) => /GetProfiles/.test(z.body)).length, 1, 'profil se zjistí jednou');
  await assert.rejects(() => createOnvif({ host: 'h', user: 'u', pass: 'p', fetchImpl: fakeKamera([], { ptz: false }) }).ptz('left'), /otáčení \(PTZ\) nenabízí/);
});

test('createPtz: kamera z cameras.json, jeden pohyb najednou, neznámá kamera 404, chyba kamery 502', async () => {
  const zaznam = [];
  const kamery = async () => [{ id: 'tapoc2020', ip: '192.168.8.211', onvifPort: 2020, user: 'Kamera', pass: 'x' }];
  const p = createPtz({ kamery, onvif: (o) => createOnvif({ ...o, fetchImpl: fakeKamera(zaznam) }), log: { log() {}, error() {} } });
  const a = p.pohni('tapoc2020', 'right', { ms: 150 });
  await assert.rejects(() => p.pohni('tapoc2020', 'left'), /právě otáčí/);
  assert.deepEqual(await a, { ok: true });
  await assert.rejects(() => p.pohni('neni', 'left'), /Neznámá kamera/);
  await assert.rejects(() => p.pohni('tapoc2020', 'sem'), /Směr/);
  const rozbity = createPtz({ kamery, onvif: () => ({ async ptz() { throw new Error('kamera mlčí'); } }), log: { log() {}, error() {} } });
  await assert.rejects(() => rozbity.pohni('tapoc2020', 'left'), /Otočení se nepodařilo: kamera mlčí/);
});

test('domeček: bez GotoHomePosition zkusí předvolbu, bez předvolby střed; když nejde nic, srozumitelná chyba', async () => {
  const kamera = (varianta) => async (url, init) => {
    const b = init.body;
    if (/GetSystemDateAndTime/.test(b)) return new Response(OBAL('<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>10</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>5</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'));
    if (/GetCapabilities/.test(b)) return new Response(OBAL('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://192.168.8.211:2020/onvif/media_service</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>http://192.168.8.211:2020/onvif/ptz_service</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>'));
    if (/GetProfiles/.test(b)) return new Response(OBAL('<trt:GetProfilesResponse><trt:Profiles token="profile_1" fixed="true"><tt:Name>mainStream</tt:Name><tt:PTZConfiguration token="ptz_1"/></trt:Profiles></trt:GetProfilesResponse>'));
    const fault = () => new Response(OBAL('<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text>Action Not Implemented</s:Text></s:Reason></s:Fault>'), { status: 500 });
    if (/GotoHomePosition/.test(b)) return fault();
    if (/GetPresets/.test(b)) return varianta === 'preset' ? new Response(OBAL('<tptz:GetPresetsResponse><tptz:Preset token="p1"><tt:Name>Home</tt:Name></tptz:Preset></tptz:GetPresetsResponse>')) : new Response(OBAL('<tptz:GetPresetsResponse/>'));
    if (/GotoPreset/.test(b)) return varianta === 'preset' ? new Response(OBAL('<tptz:GotoPresetResponse/>')) : fault();
    if (/AbsoluteMove/.test(b)) return varianta === 'stred' ? new Response(OBAL('<tptz:AbsoluteMoveResponse/>')) : fault();
    return fault();
  };
  const k1 = createOnvif({ host: '127.0.0.1', port: 12020, user: 'u', pass: 'p', fetchImpl: kamera('preset') });
  assert.deepEqual(await k1.ptz('home'), { ok: true }, 'předvolba');
  const k2 = createOnvif({ host: '127.0.0.1', port: 12020, user: 'u', pass: 'p', fetchImpl: kamera('stred') });
  assert.deepEqual(await k2.ptz('home'), { ok: true }, 'střed');
  const k3 = createOnvif({ host: '127.0.0.1', port: 12020, user: 'u', pass: 'p', fetchImpl: kamera('nic') });
  await assert.rejects(() => k3.ptz('home'), /výchozí polohu nenabízí/);
});
