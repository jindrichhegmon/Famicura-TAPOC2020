/**
 * ONVIF klient pro události kamery Tapo (port 2020).
 *
 * Kamera sama hlásí, co rozpoznala (pohyb, osobu, vozidlo, zvíře, překročení
 * čáry, zakrytí) a v GetEventProperties řekne, které z toho umí. Odběr je
 * PullPoint: server si založí odběr a pak se opakovaně ptá PullMessages
 * (dlouhý dotaz, kamera odpoví hned, jak něco má). Odběr platí ~10 minut,
 * proto se obnovuje Renew; při ukončení se ruší, aby jich na kameře
 * nepřibývalo (mají omezený počet).
 *
 * Přihlášení je WS-Security UsernameToken s digestem (SHA-1 z nonce, času a
 * hesla). Čas musí být blízko času kamery, proto se nejdřív zjistí její
 * hodiny (GetSystemDateAndTime jde bez přihlášení) a počítá se s posunem.
 *
 * Kamera ve svých odpovědích uvádí vlastní adresu v místní síti (XAddr,
 * adresa odběru). Přes tunel funguje jen adresa, na kterou se ptáme, takže
 * se host i port v každé takové adrese nahradí.
 */
import crypto from 'node:crypto';
import { parseXml, najdi, vsechny, textUzlu } from './xml.mjs';

export class OnvifError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  tt: 'http://www.onvif.org/ver10/schema',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
};
const DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
const AKCE = {
  subscribe: `${NS.tev}/EventPortType/CreatePullPointSubscriptionRequest`,
  pull: `${NS.tev}/PullPointSubscription/PullMessagesRequest`,
  renew: `${NS.wsnt}/SubscriptionManager/RenewRequest`,
  unsubscribe: `${NS.wsnt}/SubscriptionManager/UnsubscribeRequest`,
};

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/*
 * Detekce, které kamery Tapo hlásí, a pod jakým druhem je zná aplikace.
 * Tapo pojmenovává témata podle modelu a firmwaru různě (PeopleDetector/People
 * i CellMotionDetector/People, TPSmartEventDetector/TPSmartEvent s IsVehicle
 * i VehicleDetector/Vehicle …), ale jméno položky (IsPeople, IsVehicle, …)
 * drží. Proto rozhoduje položka; téma jen říká, že jde o detektor
 * (RuleEngine) nebo o zvuk (AudioAnalytics), případně o alarm pohybu
 * (VideoSource/MotionAlarm se stavem State).
 */
export const POLOZKY = {
  IsMotion: 'cam-motion',                               // pohyb (CellMotionDetector/Motion, MotionRegionDetector)
  IsPeople: 'cam-person', IsPerson: 'cam-person',       // osoba (PeopleDetector/People, CellMotionDetector/People)
  IsVehicle: 'cam-vehicle',                             // vozidlo (TPSmartEvent i VehicleDetector/Vehicle)
  IsPet: 'cam-pet',                                     // zvíře (TPSmartEvent i PetDetector/Pet)
  IsTPSmartEvent: 'cam-smart', IsTpSmartEvent: 'cam-smart', // chytrá detekce bez rozlišení (starší firmware)
  IsLineCross: 'cam-linecross',                         // překročení čáry (LineCrossDetector, CellMotionDetector/LineCross)
  IsIntrusion: 'cam-intrusion', IsInside: 'cam-intrusion', // vstup do hlídané oblasti (IntrusionDetector, CellMotionDetector/Intrusion, FieldDetector/ObjectsInside)
  IsTamper: 'cam-tamper',                               // zakrytí nebo posunutí kamery
  IsBabyCry: 'cam-babycry',                             // pláč dítěte (BabyCryDetector/BabyCry)
  IsSoundDetected: 'cam-sound', IsAbnormalSound: 'cam-sound', IsSound: 'cam-sound', // hlasitý/neobvyklý zvuk (AudioAnalytics/Audio/DetectedSound, SoundDetector)
  IsGlassBreak: 'cam-glassbreak', IsGlassBreaking: 'cam-glassbreak', // rozbití skla
  IsBark: 'cam-bark', IsDogBark: 'cam-bark',            // štěkot psa
  IsMeow: 'cam-meow', IsCatMeow: 'cam-meow',            // mňoukání kočky
};

/** Témata mimo RuleEngine, která aplikace také zařadí: [konec tématu, položka, druh]. */
export const DETEKCE = [
  { topic: 'VideoSource/MotionAlarm',          item: 'State',           kind: 'cam-motion' },
  { topic: 'AudioAnalytics/Audio/DetectedSound', item: 'IsSoundDetected', kind: 'cam-sound' },
  ...Object.entries(POLOZKY).map(([item, kind]) => ({ topic: 'RuleEngine/', item, kind })),
];

/**
 * Druh události pro téma a položku. Mimo katalog: jen detektory z RuleEngine
 * s položkou Is…, aby se z kamery nenabízelo něco jako stav digitálního
 * vstupu nebo „obraz příliš tmavý“ (VideoSource/ImageTooDark). Druh je pak
 * cam-<položka>, popisek zůstane z kamery.
 */
export function druhDetekce(topic, item) {
  const t = topic.replace(/^.*?:/, '');            // bez prefixu tns1:
  const d = DETEKCE.find((x) => !x.topic.endsWith('/') && t.endsWith(x.topic) && x.item === item);
  if (d) return { kind: d.kind, label: null };
  if (!/RuleEngine\//.test(t) || !/^Is[A-Z]/.test(item)) return null;
  if (POLOZKY[item]) return { kind: POLOZKY[item], label: null };
  const jmeno = item.slice(2);
  const kind = 'cam-' + jmeno.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  return kind.length > 4 ? { kind, label: `${jmeno} (hlásí kamera)` } : null;
}

/** Všechna témata z TopicSet tak, jak je kamera pojmenovala: [{ topic, items }] – pro diagnostiku. */
export function temataZTopicSet(topicSet) {
  const out = [];
  const projdi = (node, cesta) => {
    for (const c of node.children) {
      const p = cesta ? `${cesta}/${c.name}` : c.name;
      if (c.attrs.topic === 'true') out.push({ topic: p, items: vsechny(c, 'SimpleItemDescription').map((it) => it.attrs.Name || '') });
      projdi(c, p);
    }
  };
  projdi(topicSet, '');
  return out;
}

/** Témata z TopicSet (GetEventProperties) → [{ kind, label }] bez duplicit. */
export function detekceZTopicSet(topicSet) {
  const out = new Map();
  const projdi = (node, cesta) => {
    for (const c of node.children) {
      const p = cesta ? `${cesta}/${c.name}` : c.name;
      if (c.attrs.topic === 'true') {
        for (const it of vsechny(c, 'SimpleItemDescription')) {
          const d = druhDetekce(p, it.attrs.Name || '');
          if (d && !out.has(d.kind)) out.set(d.kind, { kind: d.kind, label: d.label });
        }
      }
      projdi(c, p);
    }
  };
  projdi(topicSet, '');
  return [...out.values()];
}

/**
 * Zprávy z PullMessages → události [{ kind, label, at }].
 *
 * Událost je přechod hodnoty na „true“; `stavy` (téma|položka → poslední
 * hodnota) drží stav mezi voláními. Podle ONVIF má „Initialized“ znamenat jen
 * stav při založení odběru, ale Tapo C220 (firmware 1.0.3) tak označuje
 * všechno a hlásí „true“ každých ~100 ms po celou dobu detekce, „false“ na
 * jejím konci. Proto rozhoduje jen změna hodnoty, ne PropertyOperation: jedna
 * detekce je jedna událost, ať přišla v jedné nebo ve sto zprávách. Co se do
 * katalogu nevešlo, přijde do `nezarazene`, aby šlo z logu serveru zjistit, co
 * kamera vlastně posílá.
 */
const ZNOVU_MS = 10_000;     // "true" this long after the previous "true", with no "false" between, is a new detection

export function udalostiZeZprav(doc, now = Date.now, nezarazene = [], vse = null, stavy = new Map()) {
  const out = [];
  for (const nm of vsechny(doc, 'NotificationMessage')) {
    const topic = textUzlu(najdi(nm, 'Topic'));
    const msg = najdi(nm, 'Message', 'Message') || najdi(nm, 'Message');
    if (!topic || !msg) continue;
    const data = najdi(msg, 'Data');
    // Every message as it came, for the diagnostic script.
    if (vse) {
      vse.push({ topic: topic.replace(/^.*?:/, ''), op: msg.attrs.PropertyOperation || '', time: msg.attrs.UtcTime || '',
        data: Object.fromEntries(vsechny(data, 'SimpleItem').map((it) => [it.attrs.Name, it.attrs.Value])) });
    }
    if (!data) continue;
    // Některé firmwary mají UtcTime zaseknutý na 1970: pak platí náš čas.
    const t = Date.parse(msg.attrs.UtcTime || '');
    const at = Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t : now();
    for (const it of vsechny(data, 'SimpleItem')) {
      const name = it.attrs.Name || '';
      const val = String(it.attrs.Value).toLowerCase();
      if (val !== 'true' && val !== 'false') continue;          // tokens and the like carry no state
      const klic = `${topic}|${name}`;
      const drive = stavy.get(klic);
      stavy.set(klic, { val, at });
      if (val !== 'true') continue;                              // switched off
      // Still on: the camera repeats "true" every ~100 ms while it detects. A
      // "true" long after the last one is a new detection whose "false" was
      // missed - otherwise one lost message would silence that kind for good.
      if (drive?.val === 'true' && at - drive.at < ZNOVU_MS) continue;
      const d = druhDetekce(topic, name);
      if (d) out.push({ kind: d.kind, label: d.label, at });
      else nezarazene.push({ topic: topic.replace(/^.*?:/, ''), item: name });
    }
  }
  return out;
}

export function createOnvif({ host, port = 2020, user, pass, fetchImpl = fetch, now = Date.now,
                              nonce = () => crypto.randomBytes(16) }) {
  const base = `http://${host}:${port}`;
  let posunMs = 0;                      // hodiny kamery − naše

  function security() {
    const n = nonce();
    const created = new Date(now() + posunMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = crypto.createHash('sha1').update(Buffer.concat([n, Buffer.from(created), Buffer.from(pass, 'utf8')])).digest('base64');
    return `<wsse:Security s:mustUnderstand="1"><wsse:UsernameToken>` +
      `<wsse:Username>${esc(user)}</wsse:Username>` +
      `<wsse:Password Type="${DIGEST}">${digest}</wsse:Password>` +
      `<wsse:Nonce EncodingType="${BASE64}">${n.toString('base64')}</wsse:Nonce>` +
      `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
  }

  async function soap(url, { action, to, body, auth = true, timeoutMs = 10000 }) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<s:Envelope xmlns:s="${NS.s}" xmlns:wsa="${NS.wsa}" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" ` +
      `xmlns:tds="${NS.tds}" xmlns:tev="${NS.tev}" xmlns:wsnt="${NS.wsnt}" xmlns:tt="${NS.tt}" xmlns:trt="${NS.trt}" xmlns:tptz="${NS.tptz}">` +
      `<s:Header>${action ? `<wsa:Action s:mustUnderstand="1">${action}</wsa:Action>` : ''}` +
      `${to ? `<wsa:To s:mustUnderstand="1">${esc(to)}</wsa:To>` : ''}${auth ? security() : ''}</s:Header>` +
      `<s:Body>${body}</s:Body></s:Envelope>`;
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
        body: xml, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new OnvifError(`Kamera na ${host}:${port} neodpovídá (ONVIF).`, e.message);
    }
    const text = await res.text();
    let doc;
    try { doc = parseXml(text); }
    catch (e) { throw new OnvifError('Kamera vrátila nesrozumitelnou odpověď ONVIF.', text.slice(0, 200)); }
    const fault = najdi(doc, 'Fault');
    if (fault || !res.ok) {
      const duvod = [textUzlu(najdi(fault, 'Subcode', 'Value')), textUzlu(najdi(fault, 'Reason'))].filter(Boolean).join(' – ');
      if (res.status === 401 || /NotAuthorized|Unauthorized|FailedAuthentication|InvalidSecurity/i.test(duvod)) {
        throw new OnvifError('Kamera odmítla přihlášení k ONVIF: účet kamery nebo heslo nesedí.', duvod);
      }
      throw new OnvifError(`Kamera odpověděla chybou ONVIF (${res.status}).`, duvod || text.slice(0, 200));
    }
    return doc;
  }

  // Kamera hlásí svou adresu v místní síti; přes tunel platí jen ta naše.
  function nase(adresa) {
    try { const u = new URL(adresa); u.hostname = host; u.port = String(port); return u.toString(); }
    catch { return adresa; }
  }

  let eventsUrl = null;
  let stavy = new Map();                // last value per topic|item, for one subscription
  let ptzInfo = null;                   // { url, profil } – otáčení kamery (Tapo C200/C210/C220)

  /* ---------- otáčení kamery (PTZ) ---------- */
  async function ptzPriprav() {
    if (ptzInfo) return ptzInfo;
    const cap = await soap(`${base}/onvif/device_service`, { body: '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>' });
    const ptzX = textUzlu(najdi(cap, 'PTZ', 'XAddr')), mediaX = textUzlu(najdi(cap, 'Media', 'XAddr'));
    if (!ptzX) throw new OnvifError('Kamera otáčení (PTZ) nenabízí.', 'GetCapabilities bez PTZ');
    const prof = await soap(nase(mediaX || `${base}/onvif/media_service`), { body: '<trt:GetProfiles/>' });
    const profily = vsechny(prof, 'Profiles');
    const p = profily.find((x) => najdi(x, 'PTZConfiguration')) || profily[0];
    const token = p && p.attrs && p.attrs.token;
    if (!token) throw new OnvifError('Kamera nevrátila profil pro otáčení.', 'GetProfiles bez token');
    ptzInfo = { url: nase(ptzX), profil: token };
    return ptzInfo;
  }

  return {
    /** Otáčení kamery: směr left|right|up|down (ContinuousMove rychlostí 0–1, po ms Stop), home (GotoHomePosition), stop. */
    async ptz(smer, { rychlost = 0.5, ms = 400 } = {}) {
      const { url, profil } = await ptzPriprav();
      const r = Math.max(0.1, Math.min(1, Number(rychlost) || 0.5));
      const v = { left: [-r, 0], right: [r, 0], up: [0, r], down: [0, -r] }[smer];
      if (smer === 'home') { await soap(url, { body: `<tptz:GotoHomePosition><tptz:ProfileToken>${esc(profil)}</tptz:ProfileToken></tptz:GotoHomePosition>` }); return { ok: true }; }
      if (smer === 'stop' || !v) { await soap(url, { body: `<tptz:Stop><tptz:ProfileToken>${esc(profil)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>` }); return { ok: true }; }
      await soap(url, { body: `<tptz:ContinuousMove><tptz:ProfileToken>${esc(profil)}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${v[0]}" y="${v[1]}"/></tptz:Velocity></tptz:ContinuousMove>` });
      await new Promise((res) => setTimeout(res, Math.max(100, Math.min(3000, Number(ms) || 400))));
      await soap(url, { body: `<tptz:Stop><tptz:ProfileToken>${esc(profil)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop>` });
      return { ok: true };
    },
    /** Posun hodin kamery; bez něj by kamera digest s naším časem odmítla. */
    async syncClock() {
      const doc = await soap(`${base}/onvif/device_service`, { auth: false, body: '<tds:GetSystemDateAndTime/>' });
      const utc = najdi(doc, 'UTCDateTime');
      if (!utc) return 0;
      const n = (a, b) => Number(textUzlu(najdi(utc, a, b)));
      const kamera = Date.UTC(n('Date', 'Year'), n('Date', 'Month') - 1, n('Date', 'Day'), n('Time', 'Hour'), n('Time', 'Minute'), n('Time', 'Second'));
      posunMs = Number.isFinite(kamera) ? kamera - now() : 0;
      return posunMs;
    },

    /** Co kamera umí hlásit: [{ kind, label }]. */
    async capabilities() {
      const cap = await soap(`${base}/onvif/device_service`, { body: '<tds:GetCapabilities><tds:Category>Events</tds:Category></tds:GetCapabilities>' });
      const xaddr = textUzlu(najdi(cap, 'Events', 'XAddr'));
      if (!xaddr) throw new OnvifError('Kamera neumí události ONVIF (v GetCapabilities chybí Events).');
      eventsUrl = nase(xaddr);
      const props = await soap(eventsUrl, { body: '<tev:GetEventProperties/>' });
      const topicSet = najdi(props, 'TopicSet');
      if (!topicSet) throw new OnvifError('Kamera nevrátila seznam událostí (TopicSet).');
      return detekceZTopicSet(topicSet);
    },

    /** Založí odběr; vrací jeho adresu (na našem hostu). */
    async subscribe(termS = 600) {
      if (!eventsUrl) await this.capabilities();
      const doc = await soap(eventsUrl, { action: AKCE.subscribe,
        body: `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT${termS}S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>` });
      const adresa = textUzlu(najdi(doc, 'SubscriptionReference', 'Address'));
      if (!adresa) throw new OnvifError('Kamera nevrátila adresu odběru událostí.');
      stavy = new Map();
      return nase(adresa);
    },

    /** Čeká až timeoutS na události; vrací [{ kind, label, at }]. */
    async pull(adresa, { timeoutS = 60, limit = 100, nezarazene, vse } = {}) {
      const doc = await soap(adresa, { action: AKCE.pull, to: adresa, timeoutMs: (timeoutS + 15) * 1000,
        body: `<tev:PullMessages><tev:Timeout>PT${timeoutS}S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>` });
      return udalostiZeZprav(doc, now, nezarazene, vse, stavy);
    },

    /** Výrobce, model a firmware – pro diagnostiku (některé firmwary události neposílají). */
    async deviceInfo() {
      const doc = await soap(`${base}/onvif/device_service`, { body: '<tds:GetDeviceInformation/>' });
      const t = (n) => textUzlu(najdi(doc, n));
      return { manufacturer: t('Manufacturer'), model: t('Model'), firmware: t('FirmwareVersion'), serial: t('SerialNumber') };
    },

    /** Všechna témata, jak je kamera pojmenovala (i mimo katalog). */
    async topics() {
      if (!eventsUrl) await this.capabilities();
      const props = await soap(eventsUrl, { body: '<tev:GetEventProperties/>' });
      return temataZTopicSet(najdi(props, 'TopicSet') || { children: [] });
    },

    async renew(adresa, termS = 600) {
      await soap(adresa, { action: AKCE.renew, to: adresa, body: `<wsnt:Renew><wsnt:TerminationTime>PT${termS}S</wsnt:TerminationTime></wsnt:Renew>` });
    },

    async unsubscribe(adresa) {
      await soap(adresa, { action: AKCE.unsubscribe, to: adresa, body: '<wsnt:Unsubscribe/>', timeoutMs: 5000 });
    },
  };
}
