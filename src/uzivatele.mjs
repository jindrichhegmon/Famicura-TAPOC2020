/**
 * Uživatelé rodiny: zakládá je poskytovatel (dispečink), rodina dostane
 * pozvánku SMS s odkazem, při prvním otevření si zvolí heslo a přihlašuje se
 * telefonem a heslem. Stejný princip jako aplikace pacienta Péče doma (kód
 * z SMS od centrály), navíc s heslem, protože rodina vidí obraz.
 *
 * Uloženo v DATA_DIR/uzivatele.json (store.mjs). Heslo jen jako scrypt hash,
 * pozvánka jen jako SHA-256 jejího tokenu: kdo soubor přečte, nepřihlásí se.
 */
import crypto from 'node:crypto';
import { isDeviceId } from './plan-pravidla.mjs';

export const POZVANKA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HESLO_MIN = 8;
const SOUBOR = 'uzivatele';

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

/** Co o uživateli smí vidět dispečink i on sám (bez hashů). */
function verejne(u) {
  return { id: u.id, jmeno: u.jmeno, telefon: u.telefon, kamery: [...u.kamery], aktivni: !!u.heslo,
    pozvankaPlatiDo: u.pozvanka ? u.pozvanka.platiDo : null, vytvoren: u.vytvoren, posledniPrihlaseni: u.posledniPrihlaseni || null };
}

export function createUzivatele(store, { now = Date.now, nahoda = (n) => crypto.randomBytes(n) } = {}) {
  const nacti = async () => (await store.nacti(SOUBOR)) || {};
  const uloz = (vsichni) => store.uloz(SOUBOR, vsichni);

  function pozvankaPro(u) {
    const token = nahoda(16).toString('base64url');   // 22 znaků: v SMS každý znak hraje roli
    u.pozvanka = { hash: hashTokenu(token), platiDo: now() + POZVANKA_TTL_MS };
    return token;
  }

  return {
    async seznam() {
      return Object.values(await nacti()).sort((a, b) => a.jmeno.localeCompare(b.jmeno, 'cs')).map(verejne);
    },

    async podleId(id) {
      const u = (await nacti())[id];
      return u ? verejne(u) : null;
    },

    async pozvanka(token) { return pozvankaPlati(await nacti(), token, now()); },

    /** Nový uživatel + token pozvánky (ten se nikam neukládá, jde jen do odkazu). */
    async vytvor({ jmeno, telefon, kamery }) {
      const j = String(jmeno ?? '').trim();
      if (!j || j.length > 60 || /[\r\n]/.test(j)) throw chyba('Jméno: 1 až 60 znaků.');
      const t = normalizeTelefon(telefon);
      if (!t) throw chyba('Telefon musí být české mobilní číslo, např. 777 123 456.');
      const k = Array.isArray(kamery) ? kamery.map(String) : [];
      if (!k.length || k.length > 10 || !k.every(isDeviceId)) throw chyba('Vyberte aspoň jednu kameru (nejvýš 10).');
      const vsichni = await nacti();
      if (Object.values(vsichni).some((u) => u.telefon === t)) throw chyba('Uživatel s tímhle telefonem už existuje.', 409);
      const id = nahoda(8).toString('hex');
      const u = { id, jmeno: j, telefon: t, kamery: [...new Set(k)], heslo: null, vytvoren: new Date(now()).toISOString() };
      const token = pozvankaPro(u);
      vsichni[id] = u;
      await uloz(vsichni);
      return { uzivatel: verejne(u), token };
    },

    /** Nová pozvánka = nové heslo: staré přestane platit, uživatel si zvolí jiné. */
    async novaPozvanka(id) {
      const vsichni = await nacti();
      const u = vsichni[id];
      if (!u) throw chyba('Uživatel neexistuje.', 404);
      u.heslo = null;
      const token = pozvankaPro(u);
      await uloz(vsichni);
      return { uzivatel: verejne(u), token };
    },

    /** Odkaz z SMS: token → nastavení hesla. Vrací uživatele k přihlášení. */
    async aktivuj(token, heslo) {
      const chybaHesla = overHeslo(heslo);
      if (chybaHesla) throw chyba(chybaHesla);
      const vsichni = await nacti();
      const h = hashTokenu(token || '');
      const u = Object.values(vsichni).find((x) => x.pozvanka && x.pozvanka.hash === h);
      if (!u || u.pozvanka.platiDo < now()) throw chyba('Odkaz z pozvánky neplatí. Požádejte poskytovatele o novou pozvánku.', 410);
      u.heslo = hashHesla(heslo);
      delete u.pozvanka;
      u.posledniPrihlaseni = new Date(now()).toISOString();
      await uloz(vsichni);
      return verejne(u);
    },

    /** Telefon + heslo → uživatel, nebo null (stejná odpověď pro neznámý telefon i špatné heslo). */
    async prihlas(telefon, heslo) {
      const t = normalizeTelefon(telefon);
      const vsichni = await nacti();
      const u = t ? Object.values(vsichni).find((x) => x.telefon === t) : null;
      // Even for an unknown number the hash runs, so timing tells nothing apart.
      const ok = hesloOdpovida(heslo, u?.heslo || hashHesla('x'));
      if (!u || !u.heslo || !ok) return null;
      u.posledniPrihlaseni = new Date(now()).toISOString();
      await uloz(vsichni);
      return verejne(u);
    },

    async zmenHeslo(id, stare, nove) {
      const chybaHesla = overHeslo(nove);
      if (chybaHesla) throw chyba(chybaHesla);
      const vsichni = await nacti();
      const u = vsichni[id];
      if (!u || !u.heslo || !hesloOdpovida(stare, u.heslo)) throw chyba('Současné heslo nesedí.', 401);
      u.heslo = hashHesla(nove);
      await uloz(vsichni);
      return verejne(u);
    },

    async smaz(id) {
      const vsichni = await nacti();
      if (!vsichni[id]) throw chyba('Uživatel neexistuje.', 404);
      delete vsichni[id];
      await uloz(vsichni);
    },
  };
}

/**
 * Text SMS s pozvánkou. Bez diakritiky (díl SMS = 153 znaků jen bez ní); i tak
 * jde o 2 díly, odkaz je dlouhý a rada, jak si aplikaci dát na plochu, ušetří
 * telefonát. Použitý odkaz vede na přihlášení, takže ho rodina může
 * klepnout i podruhé.
 */
export function textPozvanky({ jmeno, odkaz }) {
  return `Famicura: ${jmeno}, pristup k dohledu: ${odkaz} `
    + 'Otevrete odkaz a zvolte si heslo. '
    + 'Dejte si ji na plochu: iPhone Safari Sdilet > Pridat na plochu, Android Chrome menu > Pridat na plochu. '
    + 'Priste se jen prihlasite telefonem a heslem.';
}

/** Je pozvánka k tomuto tokenu platná (nepoužitá a nepropadlá)? Pro stránku, bez změny stavu. */
export function pozvankaPlati(vsichni, token, now = Date.now()) {
  const h = hashTokenu(token || '');
  const u = Object.values(vsichni).find((x) => x.pozvanka && x.pozvanka.hash === h);
  return u && u.pozvanka.platiDo >= now ? { platna: true, jmeno: u.jmeno } : { platna: false };
}

/**
 * SMS rodině, když dispečink požádá o plný obraz: ať otevře aplikaci a žádost
 * povolí nebo odmítne. Jen ASCII a do 160 znaků, aby to byla jedna SMS.
 */
export function textZadosti({ poskytovatel, duvod, odkaz }) {
  const bez = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const kdo = bez(poskytovatel).slice(0, 40) || 'Poskytovatel';
  const proc = bez(duvod).slice(0, 40);
  return `Famicura: ${kdo} zada o plny obraz${proc ? ' (' + proc + ')' : ''}. Otevrete aplikaci a zadost povolte nebo odmitnete: ${odkaz}`;
}
