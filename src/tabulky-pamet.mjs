/**
 * Paměťová brána nad tabulkami se stejným rozhraním jako createTabulky
 * (src/tabulky.mjs): řádky podle tenanta, klíče, podmínky rovnosti / IN /
 * IS NULL, řazení a limit. Bez SQL Serveru: pro testy a pro vývoj či ukázku
 * na notebooku (PDP_FAKE_TENANTS v .env, src/pdp.mjs). Data žijí jen v paměti
 * procesu; po restartu serveru jsou pryč.
 */
import { SCHEMA, normTenant } from "./tabulky.mjs";

export function createTabulkyPamet() {
  const data = {};   // tenant → tab → [radky]
  const zaznamy = [];
  const seznam = (t, tab) => { data[t] = data[t] || {}; data[t][tab] = data[t][tab] || []; return data[t][tab]; };
  const sedi = (r, podminky) => Object.entries(podminky || {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : v === null ? r[k] == null : r[k] === v);
  const norm = (tab, r) => { const o = {}; for (const k of Object.keys(SCHEMA[tab].sloupce)) { const v = r[k]; o[k] = v === undefined ? null : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v); } return o; };
  const over = (tab) => { if (!SCHEMA[tab]) throw new Error('Neznámá tabulka ' + tab); };
  const tenantNebo = (t) => { if (t === '*') return '*'; const n = normTenant(t); if (!n) { const e = new Error('Neplatné ID tenanta.'); e.status = 400; throw e; } return n; };
  return {
    data, zaznamy,
    async vyber(tenant, tab, { kde = {}, razeni = [], limit = 0 } = {}) {
      over(tab); const t = tenantNebo(tenant);
      zaznamy.push(['vyber', t, tab]);
      let rows = t === '*' ? Object.entries(data).flatMap(([tn, tabs]) => (tabs[tab] || []).map((r) => ({ IDTENANT: tn, ...r }))) : seznam(t, tab).map((r) => ({ ...r }));
      rows = rows.filter((r) => sedi(r, kde));
      for (const [k, s] of [...razeni].reverse()) rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (s === 'DESC' ? -1 : 1));
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },
    async vloz(tenant, tab, radek) {
      over(tab); const t = tenantNebo(tenant); if (t === '*') throw new Error('Vkládání bez tenanta.');
      zaznamy.push(['vloz', t, tab, radek]);
      const rows = seznam(t, tab); const klic = SCHEMA[tab].klic;
      if (rows.some((r) => klic.every((k) => r[k] === radek[k]))) { const e = new Error('Duplicitní klíč ' + tab); e.status = 500; throw e; }
      rows.push(norm(tab, radek));
    },
    async uprav(tenant, tab, podminky, zmeny) {
      over(tab); const t = tenantNebo(tenant); if (t === '*') throw new Error('Úprava bez tenanta.');
      zaznamy.push(['uprav', t, tab, podminky, zmeny]);
      let n = 0;
      for (const r of seznam(t, tab)) if (sedi(r, podminky)) { Object.assign(r, norm(tab, { ...r, ...zmeny })); n++; }
      return n;
    },
    async ulozit(tenant, tab, radek) {
      over(tab); const klic = SCHEMA[tab].klic;
      const podminky = Object.fromEntries(klic.map((k) => [k, radek[k]]));
      const zmeny = Object.fromEntries(Object.entries(radek).filter(([k]) => !klic.includes(k)));
      const n = Object.keys(zmeny).length ? await this.uprav(tenant, tab, podminky, zmeny) : (await this.vyber(tenant, tab, { kde: podminky, limit: 1 })).length;
      if (!n) await this.vloz(tenant, tab, radek);
    },
    async smaz(tenant, tab, podminky) {
      over(tab); const t = tenantNebo(tenant); if (t === '*') throw new Error('Mazání bez tenanta.');
      zaznamy.push(['smaz', t, tab, podminky]);
      const rows = seznam(t, tab); const pred = rows.length;
      data[t][tab] = rows.filter((r) => !sedi(r, podminky));
      return pred - data[t][tab].length;
    },
  };
}
