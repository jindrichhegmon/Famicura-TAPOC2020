/**
 * Telefonní číslo služby poskytovatele (tenanta) pro náramky SOS: místo pevného čísla může mít
 * slot SOS hodnotu 'sluzba' a server za ni dosadí číslo z Péče doma plus (SLUZBA_TELEFON) nebo
 * z Péče doma (contact_phone poskytovatele). Číslo zná aplikace `pecedomaplus-sluzba-telefon`
 * na jhn-apps (tenhle server do Péče doma přímo nevidí); volání je stejné jako u Google Disku:
 * POST <JHN_APPS_URL>/api/apps/pecedomaplus-sluzba-telefon, hlavička x-app-token (JHN_APPS_TOKEN),
 * v těle `klic` = FAMICURA_KAMERA_KLIC. Odpověď se drží 10 minut; při výpadku jhn-apps se vrátí
 * poslední známé číslo (označené `zastarale`), ať se náramek nepřeprogramuje na prázdno.
 */
export const SLUZBA = 'sluzba';   // hodnota slotu SOS = „číslo služby“

export function createSluzba({ url = process.env.JHN_APPS_URL || 'https://95-216-201-2.sslip.io', token = process.env.JHN_APPS_TOKEN || '', klic = process.env.FAMICURA_KAMERA_KLIC || '',
  fetchImpl = fetch, now = Date.now, log = console, cacheMs = 10 * 60 * 1000 } = {}) {
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const cache = new Map();   // tenant → { cas, telefon, zdroj, poskytovatel }

  async function app(tenant) {
    if (!token || !klic) throw chyba('Číslo služby není na serveru nastavené (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC, ./deploy/vps-env.sh).', 503);
    let r;
    try {
      r = await fetchImpl(`${url.replace(/\/+$/, '')}/api/apps/pecedomaplus-sluzba-telefon`, { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'x-app-token': token }, body: JSON.stringify({ klic, tenant }) });
    } catch (e) { throw chyba(`Aplikační server jhn-apps neodpovídá: ${e.name === 'TimeoutError' ? 'do 15 s' : e.message}`, 503); }
    let d = null;
    try { d = JSON.parse(await r.text()); } catch { d = null; }
    if (!d || typeof d !== 'object') throw chyba(`Aplikační server odpověděl nečekaně (${r.status}).`, 502);
    if (d.ok === false || !d.result) throw chyba(String(d.error || `HTTP ${r.status}`), r.status === 404 ? 503 : (r.status >= 400 && r.status < 500 ? r.status : 502));
    const v = d.result;
    return { telefon: String(v.telefon || ''), zdroj: String(v.zdroj || ''), poskytovatel: String(v.poskytovatel || ''), duvod: v.duvod ? String(v.duvod) : '' };
  }

  return {
    get nastaveno() { return !!(token && klic); },
    /** Číslo služby tenanta → { telefon, zdroj: 'pecedomaplus' | 'pecedoma' | '', poskytovatel, duvod, cas, zastarale? }. */
    async telefon(tenant, { cerstve = false } = {}) {
      const t = String(tenant || '').trim().toUpperCase();
      const c = cache.get(t);
      if (c && !cerstve && now() - c.cas < cacheMs) return c;
      try {
        const v = { ...(await app(t)), cas: now() };
        cache.set(t, v);
        return v;
      } catch (e) {
        if (c) { log.error('[sluzba]', t, 'číslo služby se nepodařilo obnovit, platí poslední známé:', e.message); return { ...c, zastarale: true }; }
        throw e;
      }
    },
    zapomen() { cache.clear(); },
  };
}
