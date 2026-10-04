/**
 * Databáze PeceDomaPlus (SQL Server, společná s portálem Péče doma plus):
 * tenanti (dbo.Tenants) a tabulky Famicura Kamera A_KAM_* (src/tabulky.mjs).
 *
 * Spojení: PDP_SQL_SERVER / PDP_SQL_PORT (výchozí jako SQL_SERVER / SQL_PORT
 * pro CLB1), PDP_SQL_DATABASE (výchozí PeceDomaPlus), PDP_SQL_USER (výchozí
 * pecedomaplus_app) a PDP_SQL_PASSWORD; vyplňuje ./deploy/vps-env.sh.
 * Bez hesla server běží dál bez tenantů (jen ukázka v prohlížeči) a hlásí to.
 *
 * Každá dávka nastaví SESSION_CONTEXT('IDTENANT'), takže Row-Level Security
 * databáze pustí jen řádky tenanta; dotazy navíc filtrují IDTENANT i samy
 * (brána createTabulky), kdyby politika pro novou tabulku ještě nebyla.
 */
import sql from 'mssql';
import { ddl, rlsSql, TABULKY, createTabulky, normTenant } from './tabulky.mjs';
import { createTabulkyPamet } from './tabulky-pamet.mjs';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const bool = (k, d) => { const v = env(k); return v === '' ? d : /^(1|true|yes|ano)$/i.test(v); };

export function pdpConfig() {
  const cfg = {
    server: env('PDP_SQL_SERVER') || env('SQL_SERVER'), port: Number(env('PDP_SQL_PORT') || env('SQL_PORT', '1433')),
    database: env('PDP_SQL_DATABASE', 'PeceDomaPlus'), user: env('PDP_SQL_USER', 'pecedomaplus_app'), password: env('PDP_SQL_PASSWORD'),
    connectionTimeout: 15000, requestTimeout: Number(env('SQL_TIMEOUT_MS', '30000')),
    pool: { max: 6, min: 0, idleTimeoutMillis: 60000 },
    options: { encrypt: bool('SQL_ENCRYPT', true), trustServerCertificate: bool('SQL_TRUST_CERT', true), enableArithAbort: true, useUTC: false },
  };
  return cfg;
}
export const pdpNastaveno = () => !!(pdpConfig().server && pdpConfig().password);

function bind(request, params) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v instanceof Date) request.input(k, sql.DateTime2, v);
    else if (typeof v === 'number' && Number.isInteger(v)) request.input(k, sql.BigInt, v);
    else if (typeof v === 'number') request.input(k, sql.Float, v);
    else if (typeof v === 'boolean') request.input(k, sql.Bit, v);
    else { const s = v === undefined ? null : v; request.input(k, sql.NVarChar(s !== null && String(s).length > 4000 ? sql.MAX : 4000), s); }
  }
  return request;
}

/** Spojení s { query(text, params) } jako src/db.mjs; vlastní pool pro PeceDomaPlus. */
export function createPdpDb(cfg = pdpConfig()) {
  let pool = null;
  const connect = () => { if (!pool) { pool = new sql.ConnectionPool(cfg).connect(); pool.catch(() => { pool = null; }); } return pool; };
  return {
    name: 'pecedomaplus',
    async query(text, params) { const p = await connect(); return (await bind(p.request(), params).query(text)).recordset || []; },
  };
}

/**
 * Tenanti a tabulky nad spojením. `db` jde podstrčit (testy), výchozí je
 * skutečné spojení z prostředí. `tenant(id)` čte dbo.Tenants s krátkou cache.
 */
export function createPdp({ db = null, log = console, cacheMs = 60000, now = Date.now, fakeTenanti = process.env.PDP_FAKE_TENANTS || '' } = {}) {
  // Vývoj a ukázka bez SQL Serveru: PDP_FAKE_TENANTS="ID=Název;ID2=Název2" dá tenanty a tabulky jen v paměti procesu.
  if (!db && fakeTenanti) {
    const tenanti = Object.fromEntries(fakeTenanti.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [id, ...n] = x.split('='); const t = normTenant(id); return [t, { id: t, nazev: n.join('=').trim() || t, ico: '', famicuraProviderId: '' }]; }).filter(([t]) => t));
    log.error('[pdp] POZOR: tenanti a tabulky jen v paměti (PDP_FAKE_TENANTS) – jen pro vývoj a ukázku, data po restartu zmizí.');
    return { nastaveno: true, pamet: true, db: null, tabulky: createTabulkyPamet(), async tenant(id) { return tenanti[normTenant(id)] || null; }, async zajistiTabulky() { return true; } };
  }
  const spojeni = db || (pdpNastaveno() ? createPdpDb() : null);
  const tabulky = spojeni ? createTabulky(spojeni) : null;
  const cache = new Map();
  let tabulkyOk = false;
  return {
    nastaveno: !!spojeni,
    pamet: false,
    db: spojeni,
    tabulky,
    /** Aktivní tenant podle ID → { id, nazev, ico, famicuraProviderId } nebo null. */
    async tenant(id) {
      const t = normTenant(id);
      if (!t || !spojeni) return null;
      const c = cache.get(t);
      if (c && c.cas > now() - cacheMs) return c.tenant;
      const rows = await spojeni.query(`SELECT TOP 1 RTRIM(IDTENANT) AS id, ICO, JmenoPoskytovatele, FamicuraProviderID FROM dbo.Tenants WHERE Aktivni = 1 AND RTRIM(IDTENANT) = @t`, { t });
      const tenant = rows[0] ? { id: String(rows[0].id).trim(), nazev: String(rows[0].JmenoPoskytovatele || '').trim(), ico: String(rows[0].ICO || '').trim(), famicuraProviderId: rows[0].FamicuraProviderID ? String(rows[0].FamicuraProviderID).toLowerCase() : '' } : null;
      cache.set(t, { cas: now(), tenant });
      return tenant;
    },
    /** Tabulky A_KAM_* a jejich zařazení do RLS; jednou po startu, další volání jen vrátí. */
    async zajistiTabulky() {
      if (tabulkyOk || !spojeni) return tabulkyOk;
      await spojeni.query(ddl());
      for (const tab of TABULKY) {
        try { await spojeni.query(rlsSql(tab)); }
        catch (e) {
          // „already been defined“ = politika tabulku už má (např. z druhého startu serveru těsně po sobě): v pořádku.
          if (/already been defined/i.test(String(e && e.message || ''))) continue;
          log.error(`[pdp] RLS pro ${tab} se nepodařilo nastavit (dotazy filtrují IDTENANT i samy):`, String(e && e.message || e).slice(0, 160));
        }
      }
      tabulkyOk = true;
      log.log('[pdp] tabulky A_KAM_* v PeceDomaPlus připravené');
      return true;
    },
  };
}
