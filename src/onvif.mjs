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
 * Klíč je konec tématu ONVIF, položka je jméno hodnoty ve zprávě.
 */
export const DETEKCE = [
  { topic: 'CellMotionDetector/Motion',       item: 'IsMotion',    kind: 'cam-motion' },
  { topic: 'VideoSource/MotionAlarm',         item: 'State',       kind: 'cam-motion' },
  { topic: 'PeopleDetector/People',           item: 'IsPeople',    kind: 'cam-person' },
  { topic: 'TPSmartEventDetector/TPSmartEvent', item: 'IsVehicle', kind: 'cam-vehicle' },
  { topic: 'TPSmartEventDetector/TPSmartEvent', item: 'IsPet',     kind: 'cam-pet' },
  { topic: 'LineCrossDetector/LineCross',     item: 'IsLineCross', kind: 'cam-linecross' },
  { topic: 'TamperDetector/Tamper',           item: 'IsTamper',    kind: 'cam-tamper' },
];

/**
 * Druh události pro téma a položku. Mimo katalog: jen detektory z RuleEngine
 * s položkou Is…, aby se z kamery nenabízelo něco jako stav digitálního
 * vstupu. Druh je pak cam-<položka>, popisek zůstane z kamery.
 */
export function druhDetekce(topic, item) {
  const t = topic.replace(/^.*?:/, '');            // bez prefixu tns1:
  const d = DETEKCE.find((x) => t.endsWith(x.topic) && x.item === item);
  if (d) return { kind: d.kind, label: null };
  if (!/RuleEngine\//.test(t) || !/^Is[A-Z]/.test(item)) return null;
  const jmeno = item.slice(2);
  const kind = 'cam-' + jmeno.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  return kind.length > 4 ? { kind, label: `${jmeno} (hlásí kamera)` } : null;
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

/** Zprávy z PullMessages → události [{ kind, label, at }] – jen přechody na „true“. */
export function udalostiZeZprav(doc, now = Date.now) {
  const out = [];
  for (const nm of vsechny(doc, 'NotificationMessage')) {
    const topic = textUzlu(najdi(nm, 'Topic'));
    const msg = najdi(nm, 'Message', 'Message') || najdi(nm, 'Message');
    if (!topic || !msg) continue;
    if (msg.attrs.PropertyOperation === 'Initialized') continue;     // stav při založení odběru, ne událost
    const data = najdi(msg, 'Data');
    if (!data) continue;
    // Některé firmwary mají UtcTime zaseknutý na 1970: pak platí náš čas.
    const t = Date.parse(msg.attrs.UtcTime || '');
    const at = Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t : now();
    for (const it of vsechny(data, 'SimpleItem')) {
      if (String(it.attrs.Value).toLowerCase() !== 'true') continue;
      const d = druhDetekce(topic, it.attrs.Name || '');
      if (d) out.push({ kind: d.kind, label: d.label, at });
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
      `xmlns:tds="${NS.tds}" xmlns:tev="${NS.tev}" xmlns:wsnt="${NS.wsnt}" xmlns:tt="${NS.tt}">` +
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

  return {
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
      return nase(adresa);
    },

    /** Čeká až timeoutS na události; vrací [{ kind, label, at }]. */
    async pull(adresa, { timeoutS = 60, limit = 100 } = {}) {
      const doc = await soap(adresa, { action: AKCE.pull, to: adresa, timeoutMs: (timeoutS + 15) * 1000,
        body: `<tev:PullMessages><tev:Timeout>PT${timeoutS}S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>` });
      return udalostiZeZprav(doc, now);
    },

    async renew(adresa, termS = 600) {
      await soap(adresa, { action: AKCE.renew, to: adresa, body: `<wsnt:Renew><wsnt:TerminationTime>PT${termS}S</wsnt:TerminationTime></wsnt:Renew>` });
    },

    async unsubscribe(adresa) {
      await soap(adresa, { action: AKCE.unsubscribe, to: adresa, body: '<wsnt:Unsubscribe/>', timeoutMs: 5000 });
    },
  };
}
