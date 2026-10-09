/**
 * Místní rozhraní kamer Tapo (HTTPS na kameře, port 443) – to, čím s kamerou
 * mluví aplikace Tapo v místní síti. Umí věci, které ONVIF nemá: světlo
 * (reflektor / přísvit) kamer C320WS, C520WS, C560WS…, informace o modelu.
 *
 * Postup podle knihovny pytapo (Home Assistant Tapo Control):
 *   1. POST https://KAMERA/ {"method":"login","params":{"encrypt_type":"3","username":…}}
 *      – novější firmware odpoví -40413 s encrypt_type "3" = zabezpečené přihlášení;
 *      starší bere {"hashed":true,"password":MD5(heslo)} a vrátí stok rovnou.
 *   2. Zabezpečené: cnonce (16 hex) → kamera pošle nonce a device_confirm
 *      (= SHA256(cnonce + H + nonce) + nonce + cnonce, H = SHA256 nebo MD5 hesla,
 *      velkými písmeny) → my pošleme digest_passwd = SHA256(H + cnonce + nonce) +
 *      cnonce + nonce → stok a start_seq. Klíč lsk a vektor ivb pro AES-128-CBC
 *      = SHA256("lsk"|"ivb" + cnonce + nonce + SHA256(cnonce + H + nonce))[0..16].
 *   3. Požadavky: POST https://KAMERA/stok=STOK/ds {"method":"multipleRequest",…};
 *      zabezpečeně zabalené do {"method":"securePassthrough","params":{"request":base64(AES)}}
 *      s hlavičkami Seq a Tapo_tag = SHA256(SHA256(H + cnonce) + tělo + seq).
 *
 * Účet: u většiny kamer stačí účet kamery (Tapo → Pokročilá nastavení → Účet
 * kamery), u některých jen "admin" s heslem účtu TP-Link (cloud). Volající to
 * zkouší v tomhle pořadí (src/svetlo.mjs). Heslo se nikam neloguje.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import https from 'node:https';

export class TapoError extends Error {
  constructor(message, { code = null, status = 0, auth = false, nepodporuje = false } = {}) { super(message); this.code = code; this.status = status; this.auth = auth; this.nepodporuje = nepodporuje; }
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
const md5hex = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

/** Kódy chyb kamery, které stojí za srozumitelný text (ostatní se vypíšou číslem). */
export const KODY = {
  '-40401': 'přihlášení vypršelo',
  '-40404': 'kamera dočasně blokuje přihlášení (příliš mnoho pokusů)',
  '-40411': 'nesprávné jméno nebo heslo',
  '-40413': 'kamera chce zabezpečené přihlášení',
  '-40211': 'účet nemá na tohle rozhraní práva (kamera chce účet TP-Link)',
  '-40210': 'kamera tuhle funkci nemá',
  '-40209': 'kamera tuhle funkci nemá',
  '-64303': 'kamera tuhle funkci nemá',
  '-40106': 'neplatný parametr',
};
export const NEPODPORUJE = new Set([-40210, -40209, -64303, -40106]);
export const popisKodu = (code) => KODY[String(code)] || `kamera vrátila chybu ${code}`;

/** HTTPS POST na kameru (vlastní certifikát kamery se neověřuje – je samopodepsaný, spojení jde tunelem). */
export function httpsPost(url, { headers = {}, body = '', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', rejectUnauthorized: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text: async () => text }); });
    });
    req.on('timeout', () => { req.destroy(new Error('kamera neodpověděla včas')); });
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

/**
 * Klient jedné kamery: { info(), call(method, params), svetloStav(), svetlo(zapnout), login() }.
 * fetchImpl(url, { headers, body, timeoutMs }) → { status, text() } jde podstrčit v testech.
 */
export function createTapo({ host, port = 443, user = 'admin', pass = '', fetchImpl = httpsPost, timeoutMs = 8000, random = () => randomBytes(8).toString('hex').toUpperCase(), log = null } = {}) {
  if (!host) throw new Error('Tapo: chybí adresa kamery.');
  const base = `https://${host}${port === 443 ? '' : ':' + port}`;
  const hlavicky = () => ({ Host: host, Referer: base, Accept: 'application/json', 'User-Agent': 'Tapo CameraClient Android', Connection: 'close', requestByApp: 'true', 'Content-Type': 'application/json; charset=UTF-8' });
  const hashe = { md5: md5hex(pass), sha256: sha256hex(pass) };
  let secure = null;        // null = nezjištěno
  let stok = null, seq = 0, lsk = null, ivb = null, cnonce = '', metoda = 'sha256';
  // Pořadové číslo Seq: 'pre' = první požadavek nese start_seq + 1 (pytapo), 'post' = start_seq. Když kamera první
  // požadavek po přihlášení odmítne (-40401), zkusí se druhá varianta; co kameře sedlo, se drží.
  let seqRezim = 'pre', cerstve = false, prepnuto = false;
  const H = () => hashe[metoda];

  const post = async (path, data, extra = {}) => {
    const body = JSON.stringify(data);
    let res;
    try { res = await fetchImpl(base + path, { method: 'POST', headers: { ...hlavicky(), ...extra }, body, timeoutMs }); }
    catch (e) { throw new TapoError(`kamera neodpovídá (${e.message})`, { status: 0 }); }
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new TapoError(`kamera odpověděla nesrozumitelně (HTTP ${res.status})`, { status: res.status }); }
    return { status: res.status, j, body };
  };

  const zjistiZabezpeceni = async () => {
    if (secure !== null) return secure;
    const { j } = await post('/', { method: 'login', params: { encrypt_type: '3', username: user } });
    secure = j?.error_code === -40413 && Array.isArray(j?.result?.data?.encrypt_type) && j.result.data.encrypt_type.includes('3');
    return secure;
  };

  const chybaPrihlaseni = (j, krok) => {
    const code = j?.result?.data?.code ?? j?.error_code ?? null;
    const sec = j?.result?.data?.sec_left;
    if (sec) return new TapoError(`kamera dočasně blokuje přihlášení, zkuste za ${sec} s`, { code, auth: true });
    const text = code === -40401 ? `kamera odmítla přihlášení (${krok}, kód -40401)` : popisKodu(code);
    return new TapoError(text, { code, auth: code === -40411 || code === -40401 || code === -40404 || code === 401 });
  };

  async function login() {
    stok = null; lsk = null; ivb = null; seq = 0;
    if (await zjistiZabezpeceni()) {
      cnonce = random();
      const prvni = await post('/', { method: 'login', params: { cnonce, encrypt_type: '3', username: user } });
      const d = prvni.j?.result?.data;
      if (!d?.nonce || !d?.device_confirm) throw chybaPrihlaseni(prvni.j, 'krok 1');
      const nonce = String(d.nonce);
      // Kamera dokazuje, že zná heslo: device_confirm z cnonce, hashe hesla (SHA256 nebo MD5) a nonce.
      metoda = null;
      for (const m of ['sha256', 'md5']) if (d.device_confirm === sha256hex(cnonce + hashe[m] + nonce) + nonce + cnonce) metoda = m;
      if (!metoda) throw new TapoError('nesprávné jméno nebo heslo (kamera nepotvrdila heslo)', { code: -40411, auth: true });
      const digest = sha256hex(H() + cnonce + nonce) + cnonce + nonce;
      const druha = await post('/', { method: 'login', params: { cnonce, encrypt_type: '3', digest_passwd: digest, username: user } });
      const r = druha.j?.result;
      if (!r?.stok || r.start_seq === undefined) throw chybaPrihlaseni(druha.j, 'krok 2, digest');
      if (r.user_group && r.user_group !== 'root') throw new TapoError('účet nemá práva správce kamery (user_group ' + r.user_group + ')', { auth: true });
      const hashedKey = sha256hex(cnonce + H() + nonce);
      lsk = createHash('sha256').update('lsk' + cnonce + nonce + hashedKey, 'utf8').digest().subarray(0, 16);
      ivb = createHash('sha256').update('ivb' + cnonce + nonce + hashedKey, 'utf8').digest().subarray(0, 16);
      seq = Number(r.start_seq) || 0; stok = String(r.stok); cerstve = true;
    } else {
      metoda = 'md5';
      const { j } = await post('/', { method: 'login', params: { hashed: true, password: hashe.md5, username: user } });
      if (!j?.result?.stok) throw chybaPrihlaseni(j, 'starší přihlášení');
      stok = String(j.result.stok);
    }
    return stok;
  }

  const zasifruj = (text) => { const c = createCipheriv('aes-128-cbc', lsk, ivb); return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64'); };
  const desifruj = (b64) => { const d = createDecipheriv('aes-128-cbc', lsk, ivb); return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8'); };

  async function raw(data, { znovu = true } = {}) {
    if (!stok) await login();
    let odpoved;
    if (secure) {
      const full = { method: 'securePassthrough', params: { request: zasifruj(JSON.stringify(data)) } };
      const body = JSON.stringify(full);
      if (seqRezim === 'pre') seq++;
      const pouzity = seq;
      if (seqRezim === 'post') seq++;
      const tag = sha256hex(sha256hex(H() + cnonce) + body + String(pouzity));
      const extra = { Seq: String(pouzity), Tapo_tag: tag };
      const { j } = await post(`/stok=${stok}/ds`, full, extra);
      const byloCerstve = cerstve; cerstve = false;
      if (j?.error_code === -40401) {
        // hned po přihlášení = nejspíš jiné počítání Seq: přepnout a přihlásit znovu (jen jednou)
        if (byloCerstve && !prepnuto) { prepnuto = true; seqRezim = seqRezim === 'pre' ? 'post' : 'pre'; if (log?.log) log.log('[tapo]', host, 'první požadavek odmítnut (-40401), zkouším Seq', seqRezim); stok = null; return raw(data, { znovu }); }
        if (znovu) { stok = null; return raw(data, { znovu: false }); }
        throw new TapoError(`kamera odmítla zašifrovaný požadavek (kód -40401, Seq ${seqRezim})`, { code: -40401, auth: true });
      }
      if (j?.error_code && j.error_code !== 0) throw new TapoError(popisKodu(j.error_code), { code: j.error_code });
      if (!j?.result?.response) throw new TapoError('kamera neposlala zašifrovanou odpověď', {});
      try { odpoved = JSON.parse(desifruj(j.result.response)); } catch { throw new TapoError('odpověď kamery nejde rozšifrovat (jiné heslo?)', { auth: true }); }
    } else {
      const { j } = await post(`/stok=${stok}/ds`, data);
      if (j?.error_code === -40401 && znovu) { stok = null; return raw(data, { znovu: false }); }
      odpoved = j;
    }
    if (odpoved?.error_code && odpoved.error_code !== 0) throw new TapoError(popisKodu(odpoved.error_code), { code: odpoved.error_code });
    return odpoved;
  }

  /** Jedna funkce kamery (multipleRequest s jedním požadavkem) → její result; chyba kamery = TapoError. */
  async function call(method, params) {
    const o = await raw({ method: 'multipleRequest', params: { requests: [{ method, params }] } });
    const r = o?.result?.responses?.[0];
    if (!r) throw new TapoError('kamera neodpověděla na ' + method, {});
    if (r.error_code && r.error_code !== 0) throw new TapoError(popisKodu(r.error_code), { code: r.error_code, nepodporuje: NEPODPORUJE.has(r.error_code), auth: r.error_code === -40211 || r.error_code === -40401 });
    return r.result ?? {};
  }

  return {
    login, call,
    get prihlasen() { return !!stok; },
    get seqRezim() { return seqRezim; },
    /** Model a jméno kamery: { device_model, device_alias, sw_version, … }. */
    async info() { const r = await call('getDeviceInfo', { device_info: { name: ['basic_info'] } }); return r?.device_info?.basic_info || r?.basic_info || r; },
    /** Světlo (přísvit): { zapnuto, vynuceno, intenzita } – kamera bez světla = TapoError.nepodporuje. */
    async svetloStav() {
      const cfg = await call('getWhitelampConfig', { image: { name: 'switch' } });
      const sw = cfg?.image?.switch || {};
      let stav = null;
      try { const s = await call('getWhitelampStatus', { image: { get_wtl_status: ['null'] } }); stav = s?.status ?? s?.image?.status ?? null; } catch { /* starší firmware: stačí nastavení */ }
      const vynuceno = sw.force_wtl_state === 'on';
      return { zapnuto: stav !== null ? Number(stav) === 1 : vynuceno, vynuceno, intenzita: sw.wtl_intensity_level != null ? Number(sw.wtl_intensity_level) : null };
    },
    /** Rozsvítí / zhasne světlo natrvalo (force_wtl_state); vrací nový stav. */
    async svetlo(zapnout) {
      await call('setWhitelampConfig', { image: { switch: { force_wtl_state: zapnout ? 'on' : 'off' } } });
      return this.svetloStav();
    },
  };
}
