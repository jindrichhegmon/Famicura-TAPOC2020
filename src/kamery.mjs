/**
 * Kamery Tapo a z nich generovaný go2rtc.yaml.
 *
 * Seznam kamer (s přihlášením ke kameře) je v cameras.json s právy 600;
 * go2rtc.yaml se z něj vždy vygeneruje celý, nikdy se needituje ručně. Tak se
 * nemůže stát, že by se do YAML dostalo heslo s uvozovkou nebo dvojtečkou,
 * které by go2rtc přečetl jinak, než bylo myšleno.
 */

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const STREAMS = ['stream1', 'stream2'];
// Kam go2rtc a odběr událostí chodí: přímo na kameru (554, 2020), nebo na
// port VPS, kam je Windows server přivedl tunelem SSH (127.0.0.1:10554, :12020).
export const RTSP_PORT = 554;
export const ONVIF_PORT = 2020;

function port(raw, vychozi) {
  if (raw === undefined || raw === null || raw === '') return vychozi;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** Ověří kameru z formuláře/stdin; vrací { ok, kamera } nebo { ok: false, error }. */
export function normalizeCamera(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Chybí údaje o kameře.' };
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim() || id;
  const ip = String(raw.ip ?? '').trim();
  const user = String(raw.user ?? '');
  const pass = String(raw.pass ?? '');
  const stream = String(raw.stream ?? 'stream1').trim();
  const rtspPort = port(raw.rtspPort, RTSP_PORT);
  const onvifPort = port(raw.onvifPort, ONVIF_PORT);

  if (!ID.test(id)) return { ok: false, error: 'ID kamery: malá písmena, číslice, - a _, nejvýš 40 znaků.' };
  // CAMERA_NAMES is "id=name; id=name", one line of .env.
  if (/[;\r\n]/.test(name) || name.length > 60) return { ok: false, error: 'Název kamery: nejvýš 60 znaků, bez středníku.' };
  if (!IPV4.test(ip)) return { ok: false, error: 'IP adresa kamery musí být IPv4, např. 192.168.1.50.' };
  if (!user || !pass) return { ok: false, error: 'Vyplňte uživatele i heslo účtu kamery (Tapo → Účet kamery).' };
  if (/[\r\n]/.test(user + pass) || user.length > 64 || pass.length > 128) return { ok: false, error: 'Neplatný uživatel nebo heslo kamery.' };
  // RTSP Basic auth splits "user:password" at the first colon.
  if (user.includes(':')) return { ok: false, error: 'Uživatel kamery nesmí obsahovat dvojtečku.' };
  if (!STREAMS.includes(stream)) return { ok: false, error: 'Stream musí být stream1 (plné rozlišení) nebo stream2 (nízké).' };
  if (!rtspPort || !onvifPort) return { ok: false, error: 'Port RTSP a ONVIF musí být číslo 1–65535 (běžně 554 a 2020).' };

  return { ok: true, kamera: { id, name, ip, user, pass, stream, rtspPort, onvifPort } };
}

/** „192.168.1.50“ pro kameru napřímo, „127.0.0.1:10554“ pro tunel SSH. */
export function cameraAddress(k) {
  return (k.rtspPort || RTSP_PORT) === RTSP_PORT ? k.ip : `${k.ip}:${k.rtspPort}`;
}

export function rtspUrl(k) {
  // Percent-encoding keeps ":", "@", "/" and quotes in a password from ending the
  // credentials early - and removes every character YAML would care about.
  return `rtsp://${encodeURIComponent(k.user)}:${encodeURIComponent(k.pass)}@${k.ip}:${k.rtspPort || RTSP_PORT}/${k.stream}`;
}

/** CAMERA_NAMES pro .env serveru. */
export function cameraNamesLine(kamery) {
  return kamery.map((k) => `${k.id}=${k.name}`).join('; ');
}

export function go2rtcYaml(kamery, { publicIp = '95.216.201.2' } = {}) {
  if (!IPV4.test(publicIp)) throw new Error('PUBLIC_IP musí být IPv4 adresa VPS.');
  const streams = kamery.length
    ? 'streams:\n' + kamery.map((k) => `  ${k.id}:\n    - "${rtspUrl(k)}"`).join('\n')
    : 'streams: {}  # zatím žádná kamera – ./deploy/vps-kamera.sh';
  return `# VYGENEROVÁNO scripts/set-camera.mjs z cameras.json – needitovat ručně.
# Šablona s vysvětlivkami: deploy/go2rtc.yaml.example

api:
  listen: "127.0.0.1:1984"
rtsp:
  listen: ""
rtmp:
  listen: ""
srtp:
  listen: ""
webrtc:
  listen: ":8555"
  candidates:
    - ${publicIp}:8555

${streams}
`;
}
