/**
 * Falešná kamera Tapo pro testy: ONVIF na vlastním portu, tak jak odpovídá
 * skutečná kamera (podle zachycených odpovědí C210/C220). Ověřuje digest
 * WS-Security, hlásí svou adresu v „místní síti“ (192.168.10.109), aby se
 * ověřilo přepsání na adresu tunelu, a události posílá z fronty.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const LAN = 'http://192.168.10.109:2020';

const TOPICS_C210 = `
<tns1:RuleEngine>
  <CellMotionDetector><Motion wstop:topic="true">
    <tt:MessageDescription IsProperty="true">
      <tt:Source><tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/></tt:Source>
      <tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data>
    </tt:MessageDescription></Motion></CellMotionDetector>
  <PeopleDetector><People wstop:topic="true">
    <tt:MessageDescription IsProperty="true">
      <tt:Data><tt:SimpleItemDescription Name="IsPeople" Type="xs:boolean"/></tt:Data>
    </tt:MessageDescription></People></PeopleDetector>
  <TPSmartEventDetector><TPSmartEvent wstop:topic="true">
    <tt:MessageDescription IsProperty="true">
      <tt:Data><tt:SimpleItemDescription Name="IsVehicle" Type="xs:boolean"/><tt:SimpleItemDescription Name="IsPet" Type="xs:boolean"/></tt:Data>
    </tt:MessageDescription></TPSmartEvent></TPSmartEventDetector>
  <TamperDetector><Tamper wstop:topic="true">
    <tt:MessageDescription IsProperty="true">
      <tt:Data><tt:SimpleItemDescription Name="IsTamper" Type="xs:boolean"/></tt:Data>
    </tt:MessageDescription></Tamper></TamperDetector>
  <BabyCryDetector><BabyCry wstop:topic="true">
    <tt:MessageDescription IsProperty="true">
      <tt:Data><tt:SimpleItemDescription Name="IsBabyCry" Type="xs:boolean"/></tt:Data>
    </tt:MessageDescription></BabyCry></BabyCryDetector>
</tns1:RuleEngine>
<tns1:VideoSource>
  <MotionAlarm wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="State" Type="xs:boolean"/></tt:Data></tt:MessageDescription></MotionAlarm>
  <ImageTooDark wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="State" Type="xs:boolean"/></tt:Data></tt:MessageDescription></ImageTooDark>
</tns1:VideoSource>
<tns1:Device><tns1:Trigger><DigitalInput wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="IsOpen" Type="xs:boolean"/></tt:Data></tt:MessageDescription></DigitalInput></tns1:Trigger></tns1:Device>`;

const TOPICS_C200 = `
<tns1:RuleEngine>
  <CellMotionDetector><Motion wstop:topic="true">
    <tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data></tt:MessageDescription>
  </Motion></CellMotionDetector>
</tns1:RuleEngine>`;

const env = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
 xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
 xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:wstop="http://docs.oasis-open.org/wsn/t-1">
<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const fault = (code, reason, status = 400) => ({ status, body: env(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value>
<SOAP-ENV:Subcode><SOAP-ENV:Value>${code}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code>
<SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`) });

/**
 * @param model  'c210' (osoba, vozidlo, zvíře, zakrytí, pláč) nebo 'c200' (jen pohyb)
 */
export async function startFakeOnvif({ user = 'famicura', pass = 'Tajne:heslo/1', model = 'c210', clockSkewS = 0, now = Date.now } = {}) {
  const calls = [];                 // { op, auth, to }
  const queue = [];                 // pending notification XML fragments
  const waiters = [];
  const subs = new Map();           // idx → expires (ms)
  let nextIdx = 1;

  const zprava = (topic, items, { op = 'Changed', time } = {}) =>
    `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>
     <wsnt:Message><tt:Message UtcTime="${time || new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')}" PropertyOperation="${op}">
       <tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/></tt:Source>
       <tt:Data>${Object.entries(items).map(([n, v]) => `<tt:SimpleItem Name="${n}" Value="${v}"/>`).join('')}</tt:Data>
     </tt:Message></wsnt:Message></wsnt:NotificationMessage>`;

  function overDigest(xml) {
    const g = (re) => (xml.match(re) || [])[1];
    const u = g(/<[^>]*Username>([^<]*)</), d = g(/<[^>]*Password[^>]*>([^<]*)</), n = g(/<[^>]*Nonce[^>]*>([^<]*)</), c = g(/<[^>]*Created>([^<]*)</);
    if (!u || !d || !n || !c) return { ok: false, why: 'chybí token' };
    if (u !== user) return { ok: false, why: 'jiný uživatel' };
    const created = Date.parse(c);
    if (!Number.isFinite(created) || Math.abs(created - (Date.now() + clockSkewS * 1000)) > 5 * 60_000) return { ok: false, why: 'čas mimo okno' };
    const expect = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(n, 'base64'), Buffer.from(c), Buffer.from(pass, 'utf8')])).digest('base64');
    return expect === d ? { ok: true } : { ok: false, why: 'digest nesedí' };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const xml = Buffer.concat(chunks).toString('utf8');
      const op = (xml.match(/<(?:\w+:)?(GetSystemDateAndTime|GetDeviceInformation|GetCapabilities|GetEventProperties|CreatePullPointSubscription|PullMessages|Renew|Unsubscribe)\b/) || [])[1] || '?';
      const to = (xml.match(/<[^>]*:To[^>]*>([^<]*)</) || [])[1] || null;
      const auth = /UsernameToken/.test(xml) ? overDigest(xml) : null;
      calls.push({ op, auth, to, url: req.url });
      const send = ({ status, body }) => { res.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8' }); res.end(body); };

      if (op === 'GetSystemDateAndTime') {
        const d = new Date(Date.now() + clockSkewS * 1000);
        return send({ status: 200, body: env(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType>
          <tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>
          <tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime>
          </tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`) });
      }
      if (!auth || !auth.ok) return send(fault('ter:NotAuthorized', 'Sender not authorized', 400));

      if (op === 'GetDeviceInformation') {
        return send({ status: 200, body: env(`<tds:GetDeviceInformationResponse><tds:Manufacturer>tp-link</tds:Manufacturer><tds:Model>${model.toUpperCase()}</tds:Model>
          <tds:FirmwareVersion>1.3.11 Build 240521 Rel.65442n</tds:FirmwareVersion><tds:SerialNumber>0000</tds:SerialNumber><tds:HardwareId>1.0</tds:HardwareId></tds:GetDeviceInformationResponse>`) });
      }
      if (op === 'GetCapabilities') {
        return send({ status: 200, body: env(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events><tt:XAddr>${LAN}/onvif/service</tt:XAddr>
          <tt:WSSubscriptionPolicySupport>false</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`) });
      }
      if (op === 'GetEventProperties') {
        if (!/\/onvif\/service$/.test(req.url)) return send(fault('ter:ActionNotSupported', 'wrong service', 400));
        return send({ status: 200, body: env(`<tev:GetEventPropertiesResponse><wstop:TopicSet>${model === 'c200' ? TOPICS_C200 : TOPICS_C210}</wstop:TopicSet></tev:GetEventPropertiesResponse>`) });
      }
      if (op === 'CreatePullPointSubscription') {
        const idx = nextIdx++;
        subs.set(idx, Date.now() + 600_000);
        return send({ status: 200, body: env(`<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference>
          <wsa5:Address>${LAN}/onvif/Subscription?Idx=${idx}</wsa5:Address></tev:SubscriptionReference>
          <wsnt:CurrentTime>${new Date().toISOString()}</wsnt:CurrentTime><wsnt:TerminationTime>${new Date(Date.now() + 600_000).toISOString()}</wsnt:TerminationTime>
          </tev:CreatePullPointSubscriptionResponse>`) });
      }
      const idx = Number((req.url.match(/Idx=(\d+)/) || [])[1]);
      if (!subs.has(idx) || subs.get(idx) < Date.now()) return send(fault('ter:InvalidArgVal', 'no such subscription', 400));
      if (op === 'PullMessages') {
        if (!queue.length) await new Promise((r) => { waiters.push(r); setTimeout(r, 150); });
        const msgs = queue.splice(0);
        return send({ status: 200, body: env(`<tev:PullMessagesResponse><tev:CurrentTime>${new Date().toISOString()}</tev:CurrentTime>
          <tev:TerminationTime>${new Date(subs.get(idx)).toISOString()}</tev:TerminationTime>${msgs.join('')}</tev:PullMessagesResponse>`) });
      }
      if (op === 'Renew') { subs.set(idx, Date.now() + 600_000); return send({ status: 200, body: env('<wsnt:RenewResponse/>') }); }
      if (op === 'Unsubscribe') { subs.delete(idx); return send({ status: 200, body: env('<wsnt:UnsubscribeResponse/>') }); }
      send(fault('ter:ActionNotSupported', op, 400));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const push = (topic, items, opts) => { queue.push(zprava(topic, items, opts)); waiters.splice(0).forEach((w) => w()); };
  return {
    port: server.address().port, calls, subs, user, pass,
    /** Kamera něco rozpoznala: pohyb, osoba, … */
    motion: (on = true) => push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: on }),
    person: (on = true) => push('tns1:RuleEngine/PeopleDetector/People', { IsPeople: on }),
    vehicle: () => push('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', { IsVehicle: true, IsPet: false }),
    pet: () => push('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', { IsVehicle: false, IsPet: true }),
    tamper: () => push('tns1:RuleEngine/TamperDetector/Tamper', { IsTamper: true }),
    babycry: () => push('tns1:RuleEngine/BabyCryDetector/BabyCry', { IsBabyCry: true }),
    tooDark: () => push('tns1:VideoSource/ImageTooDark', { State: true }),
    initialized: () => push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: true }, { op: 'Initialized' }),
    motion1970: () => push('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: true }, { time: '1970-01-01T00:00:00Z' }),
    close: () => new Promise((r) => server.close(r)),
  };
}
