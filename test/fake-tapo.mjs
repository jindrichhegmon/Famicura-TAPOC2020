/**
 * Kamera Tapo tak, jak odpovídá na místním rozhraní (HTTPS 443) – pro testy src/tapo.mjs
 * a src/svetlo.mjs. Umí zabezpečené přihlášení (encrypt_type 3, securePassthrough s AES)
 * i starší (hashed MD5), světlo (getWhitelampConfig / getWhitelampStatus / setWhitelampConfig)
 * a základní informace. fetchImpl má tvar, který createTapo({ fetchImpl }) čeká.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

export function fakeTapo({ password = 'tajne', secure = true, svetlo = true, model = 'C560WS', user = 'admin', hashMetoda = 'sha256', blokovatPo = 3 } = {}) {
  const H = hashMetoda === 'md5' ? md5(password) : sha(password);
  const st = { zapnuto: false, intenzita: 3, stok: null, seq: 0, nonce: '', cnonce: '', lsk: null, ivb: null, spatne: 0, volani: [], prihlaseni: 0, neplatnyStok: 0 };
  const odp = (status, j) => ({ status, text: async () => JSON.stringify(j) });

  const funkce = (method, params) => {
    st.volani.push({ method, params });
    if (method === 'getDeviceInfo') return { device_info: { basic_info: { device_model: model, device_alias: 'Kamera test', sw_version: '1.3.9' } } };
    if (!svetlo && /Whitelamp/.test(method)) return { error_code: -40210 };
    if (method === 'getWhitelampConfig') return { image: { switch: { force_wtl_state: st.zapnuto ? 'on' : 'off', wtl_intensity_level: String(st.intenzita), wtl_force_time: '300' } } };
    if (method === 'getWhitelampStatus') return { status: st.zapnuto ? 1 : 0 };
    if (method === 'setWhitelampConfig') { const sw = params?.image?.switch || {}; if (sw.force_wtl_state) st.zapnuto = sw.force_wtl_state === 'on'; if (sw.wtl_intensity_level) st.intenzita = Number(sw.wtl_intensity_level); return {}; }
    return { error_code: -40210 };
  };
  const multiple = (data) => {
    if (data?.method !== 'multipleRequest') return { error_code: -40210 };
    const responses = (data.params?.requests || []).map((r) => { const out = funkce(r.method, r.params); return out.error_code ? { method: r.method, error_code: out.error_code } : { method: r.method, result: out, error_code: 0 }; });
    return { error_code: 0, result: { responses } };
  };

  async function fetchImpl(url, { headers = {}, body = '' } = {}) {
    const u = new URL(url); let j; try { j = JSON.parse(body); } catch { return odp(400, { error_code: -40100 }); }
    if (u.pathname === '/') {
      if (j.method !== 'login') return odp(200, { error_code: -40100 });
      const p = j.params || {};
      if (p.username !== user) return odp(401, { error_code: -40401, result: { data: { code: -40411 } } });
      if (st.spatne >= blokovatPo) return odp(401, { error_code: -40404, result: { data: { code: -40404, sec_left: 600 } } });
      if (secure) {
        if (p.encrypt_type !== '3') return odp(200, { error_code: -40413, result: { data: { encrypt_type: ['3'] } } });
        if (!p.cnonce) return odp(200, { error_code: -40413, result: { data: { encrypt_type: ['3'] } } });
        if (!p.digest_passwd) {
          st.cnonce = String(p.cnonce); st.nonce = randomBytes(8).toString('hex').toUpperCase();
          return odp(200, { error_code: -40413, result: { data: { nonce: st.nonce, device_confirm: sha(st.cnonce + H + st.nonce) + st.nonce + st.cnonce, encrypt_type: ['3'] } } });
        }
        if (p.cnonce !== st.cnonce || p.digest_passwd !== sha(H + st.cnonce + st.nonce) + st.cnonce + st.nonce) { st.spatne++; return odp(401, { error_code: -40401, result: { data: { code: -40411 } } }); }
        const key = sha(st.cnonce + H + st.nonce);
        st.lsk = createHash('sha256').update('lsk' + st.cnonce + st.nonce + key, 'utf8').digest().subarray(0, 16);
        st.ivb = createHash('sha256').update('ivb' + st.cnonce + st.nonce + key, 'utf8').digest().subarray(0, 16);
        st.stok = 'stok' + (++st.prihlaseni); st.seq = 100; st.spatne = 0;
        return odp(200, { error_code: 0, result: { stok: st.stok, start_seq: st.seq, user_group: 'root' } });
      }
      if (p.hashed !== true || p.password !== md5(password)) { st.spatne++; return odp(401, { error_code: -40401, result: { data: { code: -40411 } } }); }
      st.stok = 'stok' + (++st.prihlaseni); st.spatne = 0;
      return odp(200, { error_code: 0, result: { stok: st.stok, user_group: 'root' } });
    }
    const m = u.pathname.match(/^\/stok=([^/]+)\/ds$/);
    if (!m) return odp(404, { error_code: -40100 });
    if (m[1] !== st.stok || st.neplatnyStok > 0) { if (st.neplatnyStok > 0) st.neplatnyStok--; return odp(200, { error_code: -40401 }); }
    if (!secure) return odp(200, multiple(j));
    if (j.method !== 'securePassthrough') return odp(200, { error_code: -40210 });
    const tag = sha(sha(H + st.cnonce) + body + String(st.seq));
    if (headers.Seq !== String(st.seq) || headers.Tapo_tag !== tag) return odp(200, { error_code: -40401, result: { data: { code: -40413 } } });
    st.seq++;
    const d = createDecipheriv('aes-128-cbc', st.lsk, st.ivb);
    const vnitrni = JSON.parse(Buffer.concat([d.update(Buffer.from(j.params.request, 'base64')), d.final()]).toString('utf8'));
    const out = JSON.stringify(multiple(vnitrni));
    const c = createCipheriv('aes-128-cbc', st.lsk, st.ivb);
    return odp(200, { error_code: 0, result: { response: Buffer.concat([c.update(out, 'utf8'), c.final()]).toString('base64') } });
  }
  return { fetchImpl, st };
}
