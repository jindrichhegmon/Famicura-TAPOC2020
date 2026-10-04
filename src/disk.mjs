/**
 * Google Disk poskytovatele (tenanta) pro nahrávky kamer – stejný princip jako
 * Export dat v Péče doma plus: poskytovatel si Google účet připojí jednou
 * v portálu Plus (Export dat → Připojit Google účet), tady se nic v Google
 * nenastavuje. Aplikace `pecedomaplus-kamera-disk` na jhn-apps zná jeho token,
 * drží adresář „Famicura Kamera – <poskytovatel>“ a tomuhle serveru dá na
 * hodinu access token jen pro nahrání souboru (rozsah drive.file).
 *
 * Volání: POST <JHN_APPS_URL>/api/apps/pecedomaplus-kamera-disk s hlavičkou
 * x-app-token (JHN_APPS_TOKEN) a v těle `klic` = FAMICURA_KAMERA_KLIC (stejná
 * hodnota v .env obou aplikací; zapisuje ./deploy/vps-env.sh).
 */
const G_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const G_DRIVE = 'https://www.googleapis.com/drive/v3';

export function createDisk({ url = process.env.JHN_APPS_URL || 'https://95-216-201-2.sslip.io', token = process.env.JHN_APPS_TOKEN || '', klic = process.env.FAMICURA_KAMERA_KLIC || '',
  fetchImpl = fetch, now = Date.now, log = console } = {}) {
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const tokeny = new Map();   // tenant → { access, expires, slozka, email }

  async function app(akce, data) {
    if (!token || !klic) throw chyba('Nahrávky na Google Disk nejsou na serveru nastavené (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC, ./deploy/vps-env.sh).', 503);
    let r;
    try {
      r = await fetchImpl(`${url.replace(/\/+$/, '')}/api/apps/pecedomaplus-kamera-disk`, { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'x-app-token': token }, body: JSON.stringify({ akce, klic, ...data }) });
    } catch (e) { throw chyba(`Aplikační server jhn-apps neodpovídá: ${e.name === 'TimeoutError' ? 'do 20 s' : e.message}`, 503); }
    let d = null;
    try { d = JSON.parse(await r.text()); } catch { d = null; }
    if (!d || typeof d !== 'object') throw chyba(`Aplikační server odpověděl nečekaně (${r.status}).`, 502);
    if (d.ok === false || !d.result) throw chyba(String(d.error || `HTTP ${r.status}`), r.status === 404 ? 503 : (r.status >= 400 && r.status < 500 ? r.status : 502));
    return d.result;
  }

  async function tokenPro(tenant) {
    const c = tokeny.get(tenant);
    if (c && c.expires > now() + 2 * 60 * 1000) return c;
    const v = await app('token', { tenant });
    const t = { access: String(v.access || ''), expires: Number(v.expires) || now() + 30 * 60 * 1000, slozka: v.slozka || null, email: String(v.email || '') };
    if (!t.access || !t.slozka) throw chyba('Aplikační server nevrátil token ani adresář pro nahrání.', 502);
    tokeny.set(tenant, t);
    return t;
  }

  /** Jedno volání Google API s krátkým opakováním při 429 / 5xx. */
  async function gapi(access, adresa, init, pokusu = 3) {
    for (let i = 0; ; i++) {
      let r;
      try { r = await fetchImpl(adresa, { ...init, headers: { Authorization: 'Bearer ' + access, ...(init.headers || {}) } }); }
      catch (e) { if (i < pokusu) { await new Promise((res) => setTimeout(res, 1500 * (i + 1))); continue; } throw chyba('Google Disk není dostupný: ' + e.message, 502); }
      if ((r.status === 429 || r.status >= 500) && i < pokusu) { await new Promise((res) => setTimeout(res, 2000 * (i + 1))); continue; }
      return r;
    }
  }

  return {
    get nastaveno() { return !!(token && klic); },
    /** Google účet z Péče doma plus a adresář nahrávek tenanta → { google: { pripojen, email }, slozka }. */
    async stav(tenant) { return app('stav', { tenant }); },
    /** Založí (nebo přeloží) adresář nahrávek na Disku tenanta. */
    async zalozSlozku(tenant, nazev = '') { tokeny.delete(tenant); return app('slozka', { tenant, nazev }); },
    /**
     * Nahraje soubor do adresáře tenanta (Drive resumable upload: hlavička s metadaty, pak celé tělo).
     * data = Buffer; → { id, nazev, url, velikost, email, slozka }.
     */
    async nahraj(tenant, { nazev, mime = 'video/mp4', data, popis = '' }) {
      if (!data || !data.length) throw chyba('Prázdná nahrávka.', 400);
      let t = await tokenPro(tenant);
      const start = async (tok) => gapi(tok.access, `${G_UPLOAD}?uploadType=resumable&fields=id,name,size,webViewLink`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(data.length) },
        body: JSON.stringify({ name: nazev, parents: [tok.slozka.id], description: popis, mimeType: mime }) });
      let r = await start(t);
      if (r.status === 401) { tokeny.delete(tenant); t = await tokenPro(tenant); r = await start(t); }
      if (!r.ok) throw chyba(`Google Disk odmítl začátek nahrání (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`, 502);
      const kam = r.headers.get('location');
      if (!kam) throw chyba('Google Disk nevrátil adresu pro nahrání.', 502);
      const u = await gapi(t.access, kam, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(data.length) }, body: data });
      const j = await u.json().catch(() => ({}));
      if (!u.ok || !j.id) throw chyba(`Google Disk nahrávku nepřijal (${u.status}): ${String(j.error?.message || '').slice(0, 200)}`, 502);
      log.log(`[disk] ${tenant}: ${nazev} (${Math.round(data.length / 1024)} kB) → Google Disk ${t.email}`);
      return { id: j.id, nazev: j.name || nazev, url: j.webViewLink || `https://drive.google.com/file/d/${j.id}/view`, velikost: Number(j.size) || data.length, email: t.email, slozka: t.slozka };
    },
    /** Soubory v adresáři tenanta (nejnovější první), pro kontrolu – zdrojem pravdy je tabulka A_KAM_Nahravka. */
    async seznam(tenant, limit = 50) {
      const t = await tokenPro(tenant);
      const q = `'${t.slozka.id}' in parents and trashed = false`;
      const r = await gapi(t.access, `${G_DRIVE}/files?` + new URLSearchParams({ q, orderBy: 'createdTime desc', pageSize: String(limit), fields: 'files(id,name,size,createdTime,webViewLink)' }), { method: 'GET' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw chyba(`Google Disk: ${String(j.error?.message || r.status)}`, 502);
      return (j.files || []).map((f) => ({ id: f.id, nazev: f.name, velikost: Number(f.size) || 0, cas: Date.parse(f.createdTime) || 0, url: f.webViewLink }));
    },
  };
}
