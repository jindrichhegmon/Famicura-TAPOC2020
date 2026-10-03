/**
 * Přihlášení dispečera účtem Péče doma plus: tenant + přihlašovací jméno +
 * heslo ověří aplikace `pecedomaplus-auth` na aplikačním serveru jhn-apps
 * (stejná jako portál Plus; uživatelé jsou v A_MSPPP_UzivatelSestra tenanta,
 * včetně nouzového vstupu `admin`, dokud tenant nemá administrátora).
 *
 * Tenhle server si heslo neověřuje sám (hash a nouzový vstup jsou věcí
 * jhn-apps), jen zavolá POST <JHN_APPS_URL>/api/apps/pecedomaplus-auth
 * s hlavičkou x-app-token (JHN_APPS_TOKEN = FAMICURA_REPORTY_TOKEN z .env
 * jhn-apps) a z odpovědi vezme uživatele; pak vydá vlastní cookie (session.mjs).
 */
export function createDispecer({ url = process.env.JHN_APPS_URL || 'https://95-216-201-2.sslip.io', token = process.env.JHN_APPS_TOKEN || '', fetchImpl = fetch } = {}) {
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  return {
    nastaveno: !!token,
    /** → { uzivatel: { id, jmeno, login, role, roleSeznam, nouzovy }, tenant: { id, nazev, ico } } nebo chyba 401/403/503. */
    async login({ tenant, login, heslo }) {
      if (!token) throw chyba('Přihlášení dispečera není na serveru nastavené (JHN_APPS_TOKEN, ./deploy/vps-env.sh).', 503);
      let r;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        r = await fetchImpl(`${url.replace(/\/+$/, '')}/api/apps/pecedomaplus-auth`, { method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-app-token': token }, body: JSON.stringify({ akce: 'login', tenant, login, heslo }) }).finally(() => clearTimeout(t));
      } catch (e) { throw chyba(`Server přihlášení (jhn-apps) neodpovídá: ${e.name === 'AbortError' ? 'do 15 s' : e.message}`, 503); }
      let d = null;
      try { d = JSON.parse(await r.text()); } catch { d = null; }
      if (!d || typeof d !== 'object') throw chyba(`Server přihlášení odpověděl nečekaně (${r.status}).`, 502);
      if (d.ok === false || !d.result) {
        const text = String(d.error || `HTTP ${r.status}`);
        // jhn-apps vrací chybu jako text; špatné heslo i neznámý tenant jsou pro uživatele 401/403
        throw chyba(text, /tenant/i.test(text) ? 403 : /heslo|jméno|login|uživatel/i.test(text) ? 401 : 502);
      }
      const v = d.result;
      const u = v.uzivatel || {};
      return { uzivatel: { id: Number(u.id) || 0, jmeno: String(u.jmeno || login), login: String(u.login || login), role: String(u.role || ''), roleSeznam: Array.isArray(u.roleSeznam) ? u.roleSeznam : [], nouzovy: !!u.nouzovy },
        tenant: { id: String(v.tenant?.id || tenant).toUpperCase(), nazev: String(v.tenant?.nazev || ''), ico: String(v.tenant?.ico || '') } };
    },
  };
}
