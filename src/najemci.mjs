/**
 * Tenanti (poskytovatelé) za běhu serveru: ke každému ID jeden stav
 * (src/stav-tenant.mjs) a jeho kamery (cameras.json, pole `tenant`).
 *
 * Tenant se ověřuje v dbo.Tenants (src/pdp.mjs); neznámý nebo neaktivní
 * tenant stav nedostane (chyba 403). Bez spojení s PeceDomaPlus server
 * běží dál jen pro ukázku bez přihlášení; dispečink a rodina to dostanou
 * jako chybu 503 s vysvětlením.
 */
import { createStavTenantu } from './stav-tenant.mjs';
import { normTenant } from './tabulky.mjs';

export function createNajemci({ pdp, kamery = async () => [], udalosti = null, upozorni = null, nahravky = null, now = Date.now, log = console }) {
  const stavy = new Map();
  const chyba = (text, status) => { const e = new Error(text); e.status = status; return e; };
  const kameryTenanta = async (id) => (await kamery()).filter((k) => normTenant(k.tenant) === id);
  return {
    get nastaveno() { return !!(pdp && pdp.nastaveno); },
    /** Aktivní tenant, nebo chyba 403 (neznámý) / 503 (databáze nenastavená). */
    async tenant(id) {
      if (!pdp || !pdp.nastaveno) throw chyba('Databáze PeceDomaPlus není na serveru nastavená (PDP_SQL_PASSWORD, ./deploy/vps-env.sh).', 503);
      const t = normTenant(id);
      if (!t) throw chyba('Zadejte ID tenanta (poskytovatele), např. v odkazu ?tenant=…', 400);
      const info = await pdp.tenant(t);
      if (!info) throw chyba(`Tenant ${t} neexistuje nebo není aktivní.`, 403);
      return info;
    },
    /** Stav tenanta (vytvoří se při prvním použití). */
    async pro(id) {
      const info = await this.tenant(id);
      let s = stavy.get(info.id);
      if (!s) {
        await pdp.zajistiTabulky();
        s = createStavTenantu({ tenant: info.id, tabulky: pdp.tabulky, kamery: () => kameryTenanta(info.id), udalosti, upozorni, nahravky, now, log, nazev: info.nazev });
        stavy.set(info.id, s);
      }
      return s;
    },
    kameryTenanta,
    /**
     * Jeden krok serverové smyčky: pro každého tenanta, který má kamery, zpracuje nové události kamer
     * (zápis, upozornění, nahrávka) i bez otevřené stránky. Stav tenanta se založí při prvním kroku.
     * Vrací počet tenantů, u kterých se stav obnovil.
     */
    async krok() {
      if (!pdp || !pdp.nastaveno) return 0;
      const tenanti = new Set((await kamery().catch(() => [])).map((k) => normTenant(k.tenant)).filter(Boolean));
      let n = 0;
      for (const t of tenanti) {
        try {
          const s = await this.pro(t);
          // jen když přišla nová událost některé kamery tenanta (nedavne je levné), nebo jednou za minutu kvůli vypršení/eskalaci
          const moje = new Set((await kameryTenanta(t)).map((k) => k.id));
          const cerstve = udalosti ? udalosti.nedavne(s.posledniUdalost ?? now()).some((e) => moje.has(e.kameraId)) : false;
          const tick = !s.posledniTick || now() - s.posledniTick > 60000;
          if (!cerstve && !tick) continue;
          await s.stav(); s.posledniTick = now(); n++;
        } catch (e) { log.error('[najemci] smyčka', t, e.message); }
      }
      return n;
    },
    /** Spustí smyčku (každé `kazdychMs`, výchozí 2 s); kroky se nepřekrývají. */
    start(kazdychMs = 2000) {
      if (this._smycka) return;
      let bezi = false;
      this._smycka = setInterval(async () => { if (bezi) return; bezi = true; try { await this.krok(); } catch { /* zalogováno v kroku */ } bezi = false; }, kazdychMs);
      if (this._smycka.unref) this._smycka.unref();
    },
    stop() { clearInterval(this._smycka); this._smycka = null; },
    /** Po změně cameras.json: každý načtený tenant si doplní kamery. */
    async obnovKamery() { for (const s of stavy.values()) await s.obnovKamery().catch((e) => log.error('[najemci] kamery', s.tenant, e.message)); },
    async hotovo() { for (const s of stavy.values()) await s.hotovo(); },
  };
}
