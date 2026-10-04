/**
 * Tabulky Famicura Kamera v databázi PeceDomaPlus (SQL Server), oddělené
 * podle tenanta (poskytovatele) stejně jako Péče doma plus: každá má sloupec
 * IDTENANT char(16) s výchozí hodnotou SESSION_CONTEXT('IDTENANT') a je
 * zařazená do politiky Row-Level Security sec.TenantPolicy, takže spojení
 * vidí a zapisuje jen řádky tenanta nastaveného v kontextu dávky.
 *
 * Tenhle modul je jediné místo, které zná názvy tabulek a sloupců. Brána
 * (createTabulky) nad nimi dělá čtyři věci: vyber, vloz, uprav, smaz, vždy
 * pro jednoho tenanta a jen se sloupci ze schématu, takže ze stránky nikdy
 * nepřijde název sloupce ani kus SQL. Hodnoty jdou přes parametry @p0…
 *
 * Časy jsou v milisekundách (bigint) jako v jádru prototypu (sim-core.js),
 * strukturované věci (souhlas, sledování, kontakty) jako JSON v nvarchar(max).
 */

export const TENANT_RE = /^[A-Z0-9]{4,16}$/;
export const normTenant = (v) => { const t = String(v || '').trim().toUpperCase(); return TENANT_RE.test(t) ? t : ''; };

/* typ: s = nvarchar(n) / nvarchar(max) při n = 0, c = varchar(n) (ASCII id), i = bigint, b = bit, d = datetime2 */
export const SCHEMA = {
  A_KAM_Kamera: {
    klic: ['KameraID'],
    sloupce: { KameraID: ['c', 40], Nazev: ['s', 80], Misto: ['s', 120], Poznamka: ['s', 300], Souhlas: ['s', 0], Sledovani: ['s', 0], Kontakty: ['s', 0],
      Docasne: ['s', 0], KlidDo: ['i'], Offline: ['b'], Aktivni: ['b'], Zmeneno: ['i'] },
  },
  A_KAM_Udalost: {
    klic: ['Id'],
    sloupce: { Id: ['c', 40], KameraID: ['c', 40], Cas: ['i'], Druh: ['c', 20], Stav: ['s', 20], Kdo: ['s', 80], Vysledek: ['s', 80], Poznamka: ['s', 300],
      Text: ['s', 1000], Skutecna: ['b'], Nahravat: ['b'], PrevzatoCas: ['i'], UzavrenoCas: ['i'], Eskalovano: ['b'], Upozorneni: ['s', 0],
      Notifikace: ['b'], Uroven: ['c', 10], Potvrzeno: ['b'] },
    indexy: [['Cas'], ['KameraID', 'Cas']],
  },
  A_KAM_Zadost: {
    klic: ['Id'],
    sloupce: { Id: ['c', 40], KameraID: ['c', 40], Kdo: ['s', 80], Duvod: ['s', 80], Cas: ['i'], PlatiDo: ['i'], Stav: ['s', 20], Odpoved: ['s', 20], OdpovedCas: ['i'] },
    indexy: [['Cas']],
  },
  A_KAM_Povoleni: {
    klic: ['KameraID'],
    sloupce: { KameraID: ['c', 40], Druh: ['s', 40], Kdo: ['s', 80], Od: ['i'], DoCas: ['i'], SledujeKdo: ['s', 80], SledujeOd: ['i'] },
  },
  A_KAM_Nastaveni: {
    klic: ['Klic'],
    sloupce: { Klic: ['c', 64], Hodnota: ['s', 0] },
  },
  A_KAM_Nahravka: {
    klic: ['Id'],
    sloupce: { Id: ['c', 40], KameraID: ['c', 40], Cas: ['i'], DelkaS: ['i'], Velikost: ['i'], UdalostId: ['c', 40], Druh: ['c', 20], Zdroj: ['c', 20],
      Nazev: ['s', 200], SouborID: ['s', 120], Url: ['s', 400], Email: ['s', 120], Kdo: ['s', 80], Chyba: ['s', 300],
      Uloziste: ['c', 10], Soubor: ['s', 200], Mime: ['c', 40], SmazanoCas: ['i'] },
    indexy: [['Cas'], ['KameraID', 'Cas']],
  },
  A_KAM_Prehrani: {
    klic: ['Id'],
    sloupce: { Id: ['c', 40], NahravkaId: ['c', 40], KameraID: ['c', 40], Cas: ['i'], Kdo: ['s', 80], Role: ['c', 12], Adresa: ['s', 60] },
    indexy: [['Cas'], ['NahravkaId']],
  },
  A_KAM_UzivatelRodiny: {
    klic: ['Id'],
    sloupce: { Id: ['c', 16], Jmeno: ['s', 60], Telefon: ['c', 9], HesloHash: ['s', 200], Kamery: ['s', 0], PozvankaHash: ['s', 100], PozvankaDo: ['i'],
      Vytvoren: ['i'], PosledniPrihlaseni: ['i'] },
    indexy: [['Telefon'], ['PozvankaHash']],
  },
};
export const TABULKY = Object.keys(SCHEMA);

const typSql = ([t, n]) => t === 's' ? (n ? `nvarchar(${n})` : 'nvarchar(max)') : t === 'c' ? `varchar(${n})` : t === 'i' ? 'bigint' : t === 'b' ? 'bit' : 'datetime2';

/** DDL: tabulky, indexy (jen když chybí) a zařazení do politiky tenantů. Spouští server při startu; idempotentní. */
export function ddl() {
  const out = [];
  for (const [tab, def] of Object.entries(SCHEMA)) {
    const sl = Object.entries(def.sloupce).map(([n, t]) => `  ${n} ${typSql(t)} ${def.klic.includes(n) ? 'NOT NULL' : 'NULL'}`).join(',\n');
    out.push(`IF OBJECT_ID(N'dbo.${tab}', N'U') IS NULL
CREATE TABLE dbo.${tab} (
  IDTENANT char(16) NOT NULL DEFAULT CONVERT(char(16), SESSION_CONTEXT(N'IDTENANT')),
${sl},
  Zapsano datetime2 NOT NULL DEFAULT SYSDATETIME(),
  CONSTRAINT PK_${tab} PRIMARY KEY CLUSTERED (IDTENANT, ${def.klic.join(', ')})
);`);
    // sloupce doplněné později (tabulka už na serveru je): přidat, když chybí
    for (const [n, t] of Object.entries(def.sloupce)) if (!def.klic.includes(n)) out.push(`IF COL_LENGTH(N'dbo.${tab}', N'${n}') IS NULL ALTER TABLE dbo.${tab} ADD ${n} ${typSql(t)} NULL;`);
    for (const ix of def.indexy || []) {
      const nazev = `IX_${tab}_${ix.join('_')}`;
      out.push(`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${nazev}' AND object_id = OBJECT_ID(N'dbo.${tab}'))
  CREATE INDEX ${nazev} ON dbo.${tab} (IDTENANT, ${ix.join(', ')});`);
    }
  }
  return out.join('\n');
}

/** Zařazení tabulky do politiky RLS – zvlášť, protože politika nemusí existovat (pak filtrují dotazy samy přes IDTENANT). */
export const rlsSql = (tab) => `IF OBJECT_ID(N'sec.TenantPolicy', N'SP') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.security_predicates sp WHERE sp.target_object_id = OBJECT_ID(N'dbo.${tab}'))
  ALTER SECURITY POLICY sec.TenantPolicy
    ADD FILTER PREDICATE sec.fn_TenantPredicate(IDTENANT) ON dbo.${tab},
    ADD BLOCK PREDICATE sec.fn_TenantPredicate(IDTENANT) ON dbo.${tab};`;

function chyba(text, status = 400) { const e = new Error(text); e.status = status; return e; }

function overTabulku(tab) { if (!SCHEMA[tab]) throw chyba(`Neznámá tabulka ${tab}.`, 500); return SCHEMA[tab]; }
function overSloupce(tab, obj) {
  const def = overTabulku(tab);
  for (const k of Object.keys(obj || {})) if (!def.sloupce[k]) throw chyba(`Neznámý sloupec ${tab}.${k}.`, 500);
}
/** Hodnota do parametru podle typu sloupce: JSON, čísla, bity; undefined = NULL. */
function hodnota(def, k, v) {
  const [t] = def.sloupce[k];
  if (v === undefined || v === null) return null;
  if (t === 'b') return v ? true : false;
  if (t === 'i') return Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
/** Hodnota z databáze zpět: bit → boolean, bigint → number (mssql je vrací jako string), NULL → null. */
function zpet(def, k, v) {
  const [t] = def.sloupce[k];
  if (v === null || v === undefined) return null;
  if (t === 'b') return v === true || v === 1 || v === '1';
  if (t === 'i') return Number(v);
  return String(v);
}

/**
 * Brána nad tabulkami pro jednoho tenanta. `db` je { query(text, params) } nad
 * PeceDomaPlus (src/pdp.mjs); každá dávka začíná nastavením kontextu tenanta.
 * Tenant '*' = všichni tenanti (jen interní: hledání pozvánky, přihlášení
 * rodiny telefonem); vrácené řádky pak nesou i IDTENANT.
 */
export function createTabulky(db) {
  const kontext = (tenant) => {
    if (tenant === '*') return { sql: `EXEC sp_set_session_context @key = N'IDTENANT', @value = N'*';\n`, p: {} };
    const t = normTenant(tenant); if (!t) throw chyba('Neplatné ID tenanta.', 400);
    // Literál jako v portálu Plus: sp_set_session_context bere sql_variant a parametr nvarchar(max) odmítne; t je jen 4–16 písmen a číslic.
    return { sql: `EXEC sp_set_session_context @key = N'IDTENANT', @value = N'${t}';\n`, p: {} };
  };
  const kde = (def, podminky, p, od = 0) => {
    const casti = []; let i = od;
    for (const [k, v] of Object.entries(podminky || {})) {
      if (!def.sloupce[k]) throw chyba(`Neznámý sloupec ${k}.`, 500);
      if (Array.isArray(v)) { if (!v.length) { casti.push('1 = 0'); continue; } const n = v.map((x) => { p['p' + i] = hodnota(def, k, x); return '@p' + (i++); }); casti.push(`${k} IN (${n.join(', ')})`); }
      else if (v === null) casti.push(`${k} IS NULL`);
      else { p['p' + i] = hodnota(def, k, v); casti.push(`${k} = @p${i++}`); }
    }
    return { text: casti.length ? ' WHERE ' + casti.join(' AND ') : '', i };
  };
  return {
    /** Řádky: { kde: {sloupec: hodnota | [hodnoty] | null}, razeni: [['Cas','DESC']], limit } */
    async vyber(tenant, tab, { kde: podminky = {}, razeni = [], limit = 0 } = {}) {
      const def = overTabulku(tab);
      const { sql, p } = kontext(tenant);
      const w = kde(def, podminky, p);
      const ord = razeni.length ? ' ORDER BY ' + razeni.map(([k, s]) => { if (!def.sloupce[k]) throw chyba(`Neznámý sloupec ${k}.`, 500); return `${k} ${s === 'DESC' ? 'DESC' : 'ASC'}`; }).join(', ') : '';
      const top = limit ? `TOP (${Math.max(1, Math.min(10000, Math.trunc(limit)))}) ` : '';
      const sloupce = Object.keys(def.sloupce);
      const rows = await db.query(`${sql}SELECT ${top}${tenant === '*' ? 'RTRIM(IDTENANT) AS IDTENANT, ' : ''}${sloupce.join(', ')} FROM dbo.${tab}${w.text}${ord};`, p);
      return rows.map((r) => { const o = {}; if (tenant === '*') o.IDTENANT = String(r.IDTENANT || '').trim(); for (const k of sloupce) o[k] = zpet(def, k, r[k]); return o; });
    },
    async vloz(tenant, tab, radek) {
      const def = overTabulku(tab); overSloupce(tab, radek);
      const { sql, p } = kontext(tenant);
      const ks = Object.keys(radek); let i = 0;
      const vals = ks.map((k) => { p['p' + i] = hodnota(def, k, radek[k]); return '@p' + (i++); });
      await db.query(`${sql}INSERT INTO dbo.${tab} (${ks.join(', ')}) VALUES (${vals.join(', ')});`, p);
    },
    /** Vrací počet změněných řádků. */
    async uprav(tenant, tab, podminky, zmeny) {
      const def = overTabulku(tab); overSloupce(tab, zmeny);
      const ks = Object.keys(zmeny); if (!ks.length) return 0;
      const { sql, p } = kontext(tenant);
      let i = 0;
      const set = ks.map((k) => { p['p' + i] = hodnota(def, k, zmeny[k]); return `${k} = @p${i++}`; });
      const w = kde(def, podminky, p, i);
      if (!w.text) throw chyba('Úprava bez podmínky.', 500);
      const r = await db.query(`${sql}UPDATE dbo.${tab} SET ${set.join(', ')}${w.text}; SELECT @@ROWCOUNT AS n;`, p);
      return Number(r?.[0]?.n ?? 0);
    },
    /** Vloží, nebo upraví podle klíče tabulky. */
    async ulozit(tenant, tab, radek) {
      const def = overTabulku(tab);
      const podminky = Object.fromEntries(def.klic.map((k) => [k, radek[k]]));
      const zmeny = Object.fromEntries(Object.entries(radek).filter(([k]) => !def.klic.includes(k)));
      const n = Object.keys(zmeny).length ? await this.uprav(tenant, tab, podminky, zmeny) : (await this.vyber(tenant, tab, { kde: podminky, limit: 1 })).length;
      if (!n) await this.vloz(tenant, tab, radek);
    },
    async smaz(tenant, tab, podminky) {
      const def = overTabulku(tab);
      const { sql, p } = kontext(tenant);
      const w = kde(def, podminky, p);
      if (!w.text) throw chyba('Mazání bez podmínky.', 500);
      const r = await db.query(`${sql}DELETE FROM dbo.${tab}${w.text}; SELECT @@ROWCOUNT AS n;`, p);
      return Number(r?.[0]?.n ?? 0);
    },
  };
}
