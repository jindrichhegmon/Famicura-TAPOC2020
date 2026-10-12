/**
 * iPhony s aplikací „PéčeDoma Prsten“, které server pravidelně probouzí tichou
 * notifikací (src/apns.mjs). Aplikace se zaregistruje párovacím kódem prstenu
 * (POST /api/prsten/zarizeni) – kód určí tenanta a kameru, jako u měření.
 *
 * Uloženo v data/prsten-zarizeni.json: { TOKEN: { tenant, kamera, klic, prostredi,
 * prstenId, prsten, verze, registrovano, posledniPush, stavPush } }.
 * Zařízení se vyřadí, když jeho párovací kód přestane platit nebo když Apple
 * řekne, že token už neplatí (aplikace smazaná).
 */
import { normKlic } from './prsten-klic.mjs';

export const INTERVAL_MIN = Math.max(5, Math.min(120, Number(process.env.PRSTEN_PROBOUZET_MIN) || 15));
const NA_KAMERU = 5;
export const platnyToken = (t) => typeof t === 'string' && /^[0-9a-f]{64,200}$/i.test(t);

export function createPrstenZarizeni({ store, apns, prstenKlice, now = Date.now, log = console } = {}) {
  if (!store) throw new Error('Zařízení prstenu: chybí úložiště.');
  const nacti = async () => { const v = await store.nacti('prsten-zarizeni'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  const uloz = (v) => store.uloz('prsten-zarizeni', v);
  let fronta = Promise.resolve();   // zápisy po sobě, ať se registrace a probouzení nepřepíšou
  const serializovane = (fn) => { const p = fronta.then(fn, fn); fronta = p.catch(() => {}); return p; };
  const verejne = (t, z) => ({ token: t.slice(0, 8) + '…', prostredi: z.prostredi, prsten: z.prsten || '', verze: z.verze || '', registrovano: z.registrovano,
    posledniPush: z.posledniPush || null, stavPush: z.stavPush || null });
  return {
    get probouzi() { return !!apns?.nastaveno; },
    intervalMin: INTERVAL_MIN,
    /** Registrace iPhonu (opakovaná registrace stejného tokenu jen obnoví údaje). */
    registruj({ tenant, kamera, klic, token, prostredi, prstenId = '', prsten = '', verze = '' }) {
      if (!platnyToken(token)) { const e = new Error('Neplatný token zařízení.'); e.status = 400; throw e; }
      return serializovane(async () => {
        const vse = await nacti(); const t = token.toLowerCase();
        const stare = vse[t];
        vse[t] = { tenant, kamera, klic: normKlic(klic), prostredi: prostredi === 'sandbox' ? 'sandbox' : 'produkce',
          prstenId: String(prstenId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12), prsten: String(prsten || '').slice(0, 40), verze: String(verze || '').slice(0, 20),
          registrovano: stare?.registrovano || now(), obnoveno: now(), posledniPush: stare?.posledniPush || null, stavPush: stare?.stavPush || null };
        // nejvýš NA_KAMERU telefonů u jedné kamery – nejdéle neobnovené pryč
        const kamery = Object.entries(vse).filter(([, z]) => z.tenant === tenant && z.kamera === kamera).sort((a, b) => (b[1].obnoveno || 0) - (a[1].obnoveno || 0));
        for (const [k] of kamery.slice(NA_KAMERU)) delete vse[k];
        await uloz(vse);
        return verejne(t, vse[t]);
      });
    },
    async proKameru(tenant, kamera) {
      return Object.entries(await nacti()).filter(([, z]) => z.tenant === tenant && z.kamera === kamera).map(([t, z]) => verejne(t, z));
    },
    /** Jedno kolo probouzení: tichá notifikace každému zařízení s platným kódem. Vrací { poslano, chyb, vyrazeno }. */
    probudVse() {
      return serializovane(async () => {
        const vysledek = { poslano: 0, chyb: 0, vyrazeno: 0 };
        if (!apns?.nastaveno) return vysledek;
        const vse = await nacti(); let zmena = false;
        for (const [t, z] of Object.entries(vse)) {
          const k = prstenKlice ? await prstenKlice.najdi(z.klic) : { tenant: z.tenant, kamera: z.kamera };
          if (!k || k.tenant !== z.tenant || k.kamera !== z.kamera) { delete vse[t]; vysledek.vyrazeno++; zmena = true; continue; }
          let r;
          try { r = await apns.probud(t, z.prostredi); } catch (e) { r = { ok: false, status: 0, reason: e.message }; }
          z.posledniPush = now(); z.stavPush = r.ok ? 'ok' : `${r.status || 'chyba'} ${r.reason || ''}`.trim(); zmena = true;
          if (r.ok) vysledek.poslano++;
          else {
            vysledek.chyb++;
            // aplikace smazaná / token z jiného prostředí nebo aplikace → pryč
            if (r.status === 410 || /^(BadDeviceToken|Unregistered|DeviceTokenNotForTopic)$/.test(r.reason)) { delete vse[t]; vysledek.vyrazeno++; }
            log.warn?.(`[famicura-tapo] [apns] ${z.tenant} ${z.kamera}: ${z.stavPush}`);
          }
        }
        if (zmena) await uloz(vse);
        return vysledek;
      });
    },
  };
}
