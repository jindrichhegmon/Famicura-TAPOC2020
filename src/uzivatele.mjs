/**
 * Uživatelé rodiny: zakládá je dispečink poskytovatele (tenanta), rodina
 * dostane pozvánku SMS s odkazem, při prvním otevření si zvolí heslo a
 * přihlašuje se telefonem a heslem. Stejný princip jako aplikace pacienta
 * Péče doma (kód z SMS od centrály), navíc s heslem, protože rodina vidí obraz.
 *
 * Role účtu: 'rodina' (své kamery, nastavuje souhlas, klid, deaktivaci) nebo
 * 'dispecer' – mobilní dispečer: stejná aplikace na telefonu, vidí všechny kamery
 * tenanta, nic nenastavuje (jen barevné schéma), ukazuje se u všech kamer.
 * Jeden telefon = jeden účet: dispečer může mít v Kamery i kamery, u kterých je
 * zároveň rodina (tam nastavuje jako rodina); pozvánka dispečera na účet rodiny
 * mu roli dispečera přidá (nastavRoli), kamera jde přidat i dispečerovi.
 * Tenant jich může mít víc. Oba druhy jde deaktivovat (Deaktivovan = kdy):
 * deaktivovaný se nepřihlásí, přihlášený je odhlášen, pozvánka mu neplatí.
 *
 * Uloženo v PeceDomaPlus, tabulka A_KAM_UzivatelRodiny tenanta (src/tabulky.mjs).
 * Heslo jen jako scrypt hash, pozvánka jen jako SHA-256 jejího tokenu: kdo
 * tabulku přečte, nepřihlásí se. Odkaz z SMS a přihlášení telefonem tenanta
 * neznají, hledají se přes všechny tenanty ('*') a vrátí i ten jeho.
 */
import crypto from 'node:crypto';
import { isDeviceId } from './plan-pravidla.mjs';

export const POZVANKA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HESLO_MIN = 8;
export const ROLE_UCTU = ['rodina', 'dispecer'];
const TAB = 'A_KAM_UzivatelRodiny';

/** „+420 777 123 456“, „00420777123456“, „777123456“ → „777123456“; jinak null. */
export function normalizeTelefon(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00420')) d = d.slice(5);
  else if (d.startsWith('420') && d.length === 12) d = d.slice(3);
  return /^[1-9]\d{8}$/.test(d) ? d : null;
}

export function formatTelefon(t) {
  return t ? `${t.slice(0, 3)} ${t.slice(3, 6)} ${t.slice(6)}` : '';
}

function chyba(text, status = 400) { const e = new Error(text); e.status = status; return e; }

export function hashHesla(heslo, sul = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(String(heslo), sul, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sul.toString('base64url')}$${h.toString('base64url')}`;
}

export function hesloOdpovida(heslo, ulozene) {
  const [typ, sul, h] = String(ulozene || '').split('$');
  if (typ !== 'scrypt' || !sul || !h) return false;
  const znovu = crypto.scryptSync(String(heslo), Buffer.from(sul, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
  const puv = Buffer.from(h, 'base64url');
  return puv.length === znovu.length && crypto.timingSafeEqual(puv, znovu);
}

const hashTokenu = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');

export function overHeslo(heslo) {
  const h = String(heslo ?? '');
  if (h.length < HESLO_MIN) return `Heslo musí mít aspoň ${HESLO_MIN} znaků.`;
  if (h.length > 128) return 'Heslo je příliš dlouhé.';
  if (/^\d+$/.test(h)) return 'Heslo nesmí být jen z číslic.';
  return null;
}

const kameryZ = (v) => { try { const k = JSON.parse(v || '[]'); return Array.isArray(k) ? k.map(String) : []; } catch { return []; } };
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** Co o uživateli smí vidět dispečink i on sám (bez hashů). */
function verejne(r) {
  return { id: r.Id, jmeno: r.Jmeno, telefon: r.Telefon, kamery: kameryZ(r.Kamery), aktivni: !!r.HesloHash, role: r.Role === 'dispecer' ? 'dispecer' : 'rodina',
    deaktivovan: r.Deaktivovan ? iso(r.Deaktivovan) : null,
    pozvankaPlatiDo: r.PozvankaHash ? r.PozvankaDo : null, vytvoren: iso(r.Vytvoren), posledniPrihlaseni: iso(r.PosledniPrihlaseni), tenant: r.IDTENANT || undefined };
}

export function createUzivatele(tabulky, { now = Date.now, nahoda = (n) => crypto.randomBytes(n) } = {}) {
  const pozvankaPro = () => { const token = nahoda(16).toString('base64url'); return { token, PozvankaHash: hashTokenu(token), PozvankaDo: now() + POZVANKA_TTL_MS }; };
  const podleTokenu = async (token) => (await tabulky.vyber('*', TAB, { kde: { PozvankaHash: hashTokenu(token || '') }, limit: 1 }))[0] || null;

  /** Účty jednoho tenanta (dispečink, aplikace rodiny po přihlášení). */
  function pro(tenant) {
    const t = String(tenant || '').toUpperCase();
    return {
      async seznam() {
        return (await tabulky.vyber(t, TAB)).map(verejne).sort((a, b) => a.jmeno.localeCompare(b.jmeno, 'cs'));
      },
      async podleId(id) {
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        return r ? verejne(r) : null;
      },
      /** Nový uživatel + token pozvánky (ten se nikam neukládá, jde jen do odkazu). role 'dispecer' = mobilní dispečer: vidí všechny kamery tenanta; kamery v seznamu jsou ty, kde je zároveň rodina (může být prázdný). */
      async vytvor({ jmeno, telefon, kamery, role = 'rodina' }) {
        const j = String(jmeno ?? '').trim();
        if (!j || j.length > 60 || /[\r\n]/.test(j)) throw chyba('Jméno: 1 až 60 znaků.');
        if (!ROLE_UCTU.includes(role)) throw chyba('Typ účtu: rodina, nebo dispecer.');
        const tel = normalizeTelefon(telefon);
        if (!tel) throw chyba('Telefon musí být české mobilní číslo, např. 777 123 456.');
        const k = Array.isArray(kamery) ? kamery.map(String) : [];
        if (role === 'rodina' && !k.length) throw chyba('Vyberte aspoň jednu kameru (nejvýš 10).');
        if (k.length > 10 || !k.every(isDeviceId)) throw chyba('Vyberte aspoň jednu kameru (nejvýš 10).');
        if ((await tabulky.vyber(t, TAB, { kde: { Telefon: tel }, limit: 1 })).length) throw chyba('Uživatel s tímhle telefonem už existuje.', 409);
        const id = nahoda(8).toString('hex');
        const p = pozvankaPro();
        const r = { Id: id, Jmeno: j, Telefon: tel, HesloHash: null, Kamery: [...new Set(k)], PozvankaHash: p.PozvankaHash, PozvankaDo: p.PozvankaDo, Vytvoren: now(), PosledniPrihlaseni: null, Role: role, Deaktivovan: null };
        await tabulky.vloz(t, TAB, r);
        return { uzivatel: verejne({ ...r, Kamery: JSON.stringify(r.Kamery) }), token: p.token };
      },
      /** Nová pozvánka = nové heslo: staré přestane platit, uživatel si zvolí jiné. */
      async novaPozvanka(id) {
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r) throw chyba('Uživatel neexistuje.', 404);
        const p = pozvankaPro();
        await tabulky.uprav(t, TAB, { Id: r.Id }, { HesloHash: null, PozvankaHash: p.PozvankaHash, PozvankaDo: p.PozvankaDo });
        return { uzivatel: verejne({ ...r, HesloHash: null, PozvankaHash: p.PozvankaHash, PozvankaDo: p.PozvankaDo }), token: p.token };
      },
      async zmenHeslo(id, stare, nove) {
        const chybaHesla = overHeslo(nove);
        if (chybaHesla) throw chyba(chybaHesla);
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r || !r.HesloHash || !hesloOdpovida(stare, r.HesloHash)) throw chyba('Současné heslo nesedí.', 401);
        await tabulky.uprav(t, TAB, { Id: r.Id }, { HesloHash: hashHesla(nove) });
        return verejne(r);
      },
      async smaz(id) {
        if (!(await tabulky.smaz(t, TAB, { Id: String(id) }))) throw chyba('Uživatel neexistuje.', 404);
      },
      /** Role účtu: 'dispecer' (všechny kamery tenanta; své kamery dál jako rodina) nebo 'rodina' (jen své kamery; bez kamer nejde). */
      async nastavRoli(id, role) {
        if (!ROLE_UCTU.includes(role)) throw chyba('Typ účtu: rodina, nebo dispecer.');
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r) throw chyba('Uživatel neexistuje.', 404);
        if (role === 'rodina' && !kameryZ(r.Kamery).length) throw chyba('Účet rodiny potřebuje aspoň jednu kameru; dispečera bez kamer raději odeberte.');
        await tabulky.uprav(t, TAB, { Id: r.Id }, { Role: role });
        return verejne({ ...r, Role: role });
      },
      /** Deaktivace (on = true) / aktivace účtu: heslo i kamery zůstávají, jen se nepřihlásí (a přihlášený je odhlášen). */
      async deaktivuj(id, on) {
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r) throw chyba('Uživatel neexistuje.', 404);
        const Deaktivovan = on ? now() : null;
        await tabulky.uprav(t, TAB, { Id: r.Id }, { Deaktivovan });
        return verejne({ ...r, Deaktivovan });
      },
      /** Účet podle telefonu (stejný člověk u další kamery), nebo null. */
      async podleTelefonu(telefon) {
        const tel = normalizeTelefon(telefon); if (!tel) return null;
        const r = (await tabulky.vyber(t, TAB, { kde: { Telefon: tel }, limit: 1 }))[0];
        return r ? verejne(r) : null;
      },
      /** Přidá účtu další kameru (druhá kamera téhož člověka): heslo i pozvánka zůstávají. */
      async pridejKameru(id, kameraId) {
        if (!isDeviceId(kameraId)) throw chyba('Neplatné ID kamery.');
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r) throw chyba('Uživatel neexistuje.', 404);
        const k = [...new Set([...kameryZ(r.Kamery), String(kameraId)])];
        if (k.length > 10) throw chyba('Uživatel může mít nejvýš 10 kamer.');
        await tabulky.uprav(t, TAB, { Id: r.Id }, { Kamery: k });
        return verejne({ ...r, Kamery: JSON.stringify(k) });
      },
      /** Odebere účtu jednu kameru; když to byla poslední, účet smaže. Dispečer: kameru, u které je i rodina, jen odebere (zůstane dispečer); jinak ho smaže. → { smazan, uzivatel } */
      async odeberKameru(id, kameraId) {
        const r = (await tabulky.vyber(t, TAB, { kde: { Id: String(id) }, limit: 1 }))[0];
        if (!r) throw chyba('Uživatel neexistuje.', 404);
        if (r.Role === 'dispecer' && !kameryZ(r.Kamery).includes(String(kameraId))) { await tabulky.smaz(t, TAB, { Id: r.Id }); return { smazan: true, uzivatel: null }; }
        const k = kameryZ(r.Kamery).filter((x) => x !== String(kameraId));
        if (r.Role === 'dispecer') { await tabulky.uprav(t, TAB, { Id: r.Id }, { Kamery: k }); return { smazan: false, uzivatel: verejne({ ...r, Kamery: JSON.stringify(k) }) }; }
        if (!k.length) { await tabulky.smaz(t, TAB, { Id: r.Id }); return { smazan: true, uzivatel: null }; }
        await tabulky.uprav(t, TAB, { Id: r.Id }, { Kamery: k });
        return { smazan: false, uzivatel: verejne({ ...r, Kamery: JSON.stringify(k) }) };
      },
    };
  }

  return {
    pro,
    /** Je pozvánka k tomuto tokenu platná (nepoužitá a nepropadlá)? Pro stránku, bez změny stavu. */
    async pozvanka(token) {
      if (typeof token !== 'string' || !token) return { platna: false };
      const r = await podleTokenu(token);
      return r && r.PozvankaDo >= now() && !r.Deaktivovan ? { platna: true, jmeno: r.Jmeno, tenant: r.IDTENANT, role: r.Role === 'dispecer' ? 'dispecer' : 'rodina' } : { platna: false };
    },
    /** Odkaz z SMS: token → nastavení hesla. Vrací uživatele (s tenantem) k přihlášení. */
    async aktivuj(token, heslo) {
      const chybaHesla = overHeslo(heslo);
      if (chybaHesla) throw chyba(chybaHesla);
      const r = await podleTokenu(token);
      if (!r || r.PozvankaDo < now()) throw chyba('Odkaz z pozvánky neplatí. Požádejte poskytovatele o novou pozvánku.', 410);
      if (r.Deaktivovan) throw chyba('Účet je deaktivovaný. Obraťte se na poskytovatele.', 403);
      const zmeny = { HesloHash: hashHesla(heslo), PozvankaHash: null, PozvankaDo: null, PosledniPrihlaseni: now() };
      await tabulky.uprav(r.IDTENANT, TAB, { Id: r.Id }, zmeny);
      return verejne({ ...r, ...zmeny });
    },
    /** Telefon + heslo → uživatel (s tenantem), nebo null (stejná odpověď pro neznámý telefon i špatné heslo). Deaktivovaný se vrátí s deaktivovan – přihlášení ho odmítne srozumitelně. */
    async prihlas(telefon, heslo) {
      const tel = normalizeTelefon(telefon);
      const kandidati = tel ? await tabulky.vyber('*', TAB, { kde: { Telefon: tel } }) : [];
      // I pro neznámé číslo hash běží, aby čas nic neprozradil; při víc tenantech se stejným číslem vyhraje správné heslo.
      let u = null;
      for (const r of kandidati) if (r.HesloHash && hesloOdpovida(heslo, r.HesloHash)) { u = r; break; }
      if (!u) { hesloOdpovida(heslo, hashHesla('x')); return null; }
      await tabulky.uprav(u.IDTENANT, TAB, { Id: u.Id }, { PosledniPrihlaseni: now() });
      return verejne({ ...u, PosledniPrihlaseni: now() });
    },
  };
}

/**
 * Text SMS s pozvánkou. Bez diakritiky (díl SMS = 153 znaků jen bez ní); i tak
 * jde o 2 díly, odkaz je dlouhý a rada, jak si aplikaci dát na plochu, ušetří
 * telefonát. Použitý odkaz vede na přihlášení, takže ho rodina může
 * klepnout i podruhé.
 */
export function textPozvanky({ jmeno, odkaz, role = 'rodina', poskytovatel = '' }) {
  const bez = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (role === 'dispecer') {
    return `Famicura: ${bez(jmeno)}, pristup DISPECERA k dohledu${poskytovatel ? ' (' + bez(poskytovatel).slice(0, 40) + ')' : ''}: ${odkaz} `
      + 'Otevrete odkaz a zvolte si heslo. Jako dispecer uvidite vsechny kamery poskytovatele, nic v nich nenastavujete. '
      + 'Dejte si aplikaci na plochu: iPhone Safari Sdilet > Pridat na plochu, Android Chrome menu > Pridat na plochu. '
      + 'Priste se jen prihlasite telefonem a heslem.';
  }
  return `Famicura: ${jmeno}, pristup k dohledu: ${odkaz} `
    + 'Otevrete odkaz a zvolte si heslo. '
    + 'Dejte si ji na plochu: iPhone Safari Sdilet > Pridat na plochu, Android Chrome menu > Pridat na plochu. '
    + 'Priste se jen prihlasite telefonem a heslem.';
}

/**
 * SMS rodině, když dispečink požádá o plný obraz: ať otevře aplikaci a žádost
 * povolí nebo odmítne. Jen ASCII a do 160 znaků, aby to byla jedna SMS.
 */
export function textZadosti({ poskytovatel, duvod, odkaz }) {
  const bez = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const kdo = bez(poskytovatel).slice(0, 40) || 'Poskytovatel';
  const proc = bez(duvod).slice(0, 40);
  return `Famicura: ${kdo} zada o plny obraz${proc ? ' (' + proc + ')' : ''}. Otevrete aplikaci a zadost povolte nebo odmitnete: ${odkaz}`;
}
