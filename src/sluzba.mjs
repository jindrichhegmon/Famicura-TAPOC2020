/**
 * Telefonní čísla poskytovatele (tenanta) z Péče doma a Péče doma plus pro náramky SOS a SMS upozornění.
 * Telefon poskytovatele (dispečink, služba, administrace – Kontakty → Poskytovatel) může místo vlastního
 * čísla mít zdroj 'pecedoma' (kontaktní telefon poskytovatele v Péče doma – databáze Famicura, bez tenanta;
 * tenant na něj ukazuje přes FamicuraProviderID; jedno číslo pro všechny role) nebo 'pecedomaplus'
 * (DISPECINK_TELEFON / SLUZBA_TELEFON / ADMINISTRACE_TELEFON v nastavení tenanta v Péče doma plus, zadává
 * se v dispečinku). Čísla zná aplikace `pecedomaplus-sluzba-telefon` na jhn-apps (tenhle server do Péče doma
 * přímo nevidí); volání je stejné jako u Google Disku: POST <JHN_APPS_URL>/api/apps/pecedomaplus-sluzba-telefon,
 * hlavička x-app-token (JHN_APPS_TOKEN), v těle `klic` = FAMICURA_KAMERA_KLIC. Odpověď se drží 10 minut; při
 * výpadku jhn-apps se vrátí poslední známá čísla (označená `zastarale`), ať se náramek nepřeprogramuje na
 * prázdno. Akce `nastav` zapíše telefon role tenanta (portál Plus takové pole zatím nemá).
 */
export const ROLE_TELEFONU = ['sluzba', 'dispecink', 'administrace'];
export const ZDROJE_SOS = ['pecedoma', 'pecedomaplus', 'sluzba'];   // hodnoty slotu SOS, které server dosazuje ('sluzba' = starší zápis: plus, jinak Péče doma)
export const POPIS_ZDROJE = { pecedoma: 'Péče doma', pecedomaplus: 'Péče doma plus', sluzba: 'číslo služby' };
/** Číslo pro zdroj a roli ze stavu (telefon()), '' když není: Péče doma má jedno číslo pro všechny role, Péče doma plus číslo podle role. */
export function cisloZdroje(v, zdroj, role = 'sluzba') {
  if (!v) return '';
  const r = ROLE_TELEFONU.includes(role) ? role : 'sluzba';
  if (zdroj === 'pecedoma') return v.pecedoma?.telefon || '';
  if (zdroj === 'pecedomaplus') return v.pecedomaplus?.[r]?.telefon || (r === 'sluzba' ? v.pecedomaplus?.telefon : '') || '';
  if (zdroj === 'sluzba') return v.pecedomaplus?.sluzba?.telefon || v.pecedomaplus?.telefon || v.pecedoma?.telefon || '';
  return '';
}

export function createSluzba({ url = process.env.JHN_APPS_URL || 'https://95-216-201-2.sslip.io', token = process.env.JHN_APPS_TOKEN || '', klic = process.env.FAMICURA_KAMERA_KLIC || '',
  fetchImpl = fetch, now = Date.now, log = console, cacheMs = 10 * 60 * 1000 } = {}) {
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const cache = new Map();   // tenant → { cas, telefon, zdroj, poskytovatel }

  async function app(tenant, data = {}) {
    if (!token || !klic) throw chyba('Číslo služby není na serveru nastavené (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC, ./deploy/vps-env.sh).', 503);
    let r;
    try {
      r = await fetchImpl(`${url.replace(/\/+$/, '')}/api/apps/pecedomaplus-sluzba-telefon`, { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'x-app-token': token }, body: JSON.stringify({ klic, tenant, ...data }) });
    } catch (e) { throw chyba(`Aplikační server jhn-apps neodpovídá: ${e.name === 'TimeoutError' ? 'do 15 s' : e.message}`, 503); }
    let d = null;
    try { d = JSON.parse(await r.text()); } catch { d = null; }
    if (!d || typeof d !== 'object') throw chyba(`Aplikační server odpověděl nečekaně (${r.status}).`, 502);
    if (d.ok === false || !d.result) throw chyba(String(d.error || `HTTP ${r.status}`), r.status === 404 ? 503 : (r.status >= 400 && r.status < 500 ? r.status : 502));
    const v = d.result;
    const pd = v.pecedoma || {}, pp = v.pecedomaplus || {};
    // Péče doma plus: číslo pro každou roli (sluzba, dispecink, administrace); telefon = služba (starší tvar odpovědi)
    const plus = { telefon: String(pp.sluzba?.telefon || pp.telefon || ''), zmeneno: pp.sluzba?.zmeneno || pp.zmeneno || null };
    for (const r of ROLE_TELEFONU) plus[r] = { telefon: String(pp[r]?.telefon || (r === 'sluzba' ? pp.telefon : '') || ''), zmeneno: pp[r]?.zmeneno || (r === 'sluzba' ? pp.zmeneno : null) || null };
    return { poskytovatel: String(v.poskytovatel || ''),
      pecedoma: { telefon: String(pd.telefon || ''), poskytovatel: String(pd.poskytovatel || ''), duvod: pd.duvod ? String(pd.duvod) : '', zmeneno: pd.zmeneno || null },
      pecedomaplus: plus };
  }

  return {
    get nastaveno() { return !!(token && klic); },
    /** Čísla tenanta → { poskytovatel, pecedoma: { telefon, poskytovatel, duvod }, pecedomaplus: { telefon, sluzba: { telefon }, dispecink: { telefon }, administrace: { telefon } }, cas, zastarale? }. */
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
    /** Zapíše telefon role tenanta do Péče doma plus (SLUZBA_TELEFON / DISPECINK_TELEFON / ADMINISTRACE_TELEFON; prázdné = smazat) a vrátí čerstvý stav. */
    async nastav(tenant, telefon, role = 'sluzba') {
      const t = String(tenant || '').trim().toUpperCase();
      if (!ROLE_TELEFONU.includes(role)) throw chyba('Telefon v Péče doma plus: role sluzba, dispecink, nebo administrace.', 400);
      const v = { ...(await app(t, { akce: 'nastav', role, telefon: String(telefon || '').replace(/[\s-]/g, '') })), cas: now() };
      cache.set(t, v);
      return v;
    },
    zapomen() { cache.clear(); },
  };
}
