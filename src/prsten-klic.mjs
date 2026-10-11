/**
 * Párovací kód prstenu: aplikace klienta (PéčeDoma mobil, Netlify) posílá měření
 * z prstenu bez přihlášení k Famicuře – prokáže se kódem, který dispečink vytvoří
 * ke kameře klienta (záložka Prsten) a pošle klientovi SMS s odkazem. Kód umí jen
 * posílat měření ke své kameře, nic číst.
 *
 * Uloženo v data/prsten-klice.json: { KLIC: { tenant, kamera, vytvoreno } };
 * ke kameře je vždy nejvýš jeden platný kód (nový starý nahradí).
 */
import { randomInt } from 'node:crypto';

const ABECEDA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bez 0/O, 1/I – kód jde přečíst i po telefonu
export const normKlic = (k) => String(k || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12);
export const formatKlic = (k) => normKlic(k).replace(/(.{4})(?=.)/g, '$1-');
export function novyKlic(rand = randomInt) {
  let k = ''; for (let i = 0; i < 12; i++) k += ABECEDA[rand(ABECEDA.length)];
  return k;
}
/** Odkaz do aplikace klienta s kódem; adresa aplikace z PRSTEN_APLIKACE_URL. */
export function odkazAplikace(klic, aplikace = process.env.PRSTEN_APLIKACE_URL || 'https://pecedomamobil.netlify.app/', tenant = '') {
  const u = new URL(aplikace); u.searchParams.set('prsten', formatKlic(klic)); if (tenant) u.searchParams.set('tenant', tenant); return u.toString();
}
/** SMS klientovi bez diakritiky (odkaz s kódem má ~55 znaků, zpráva se vejde do dvou dílů SMS). */
export function textSmsKlic({ odkaz, poskytovatel = '' }) {
  const p = String(poskytovatel || '').normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 30);
  return `PeceDoma${p ? ' (' + p + ')' : ''}: prsten - otevrete odkaz v telefonu a stisknete Pripojit prsten: ${odkaz}`;
}

export function createPrstenKlice({ store, now = Date.now, rand } = {}) {
  if (!store) throw new Error('Párovací kódy prstenu: chybí úložiště.');
  const nacti = async () => { const v = await store.nacti('prsten-klice'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  return {
    /** Platný kód kamery (nebo null). */
    async pro(tenant, kamera) {
      const vse = await nacti();
      const k = Object.keys(vse).find((x) => vse[x].tenant === tenant && vse[x].kamera === kamera);
      return k ? { klic: k, vytvoreno: vse[k].vytvoreno } : null;
    },
    /** Nový kód ke kameře; dosavadní kód kamery přestane platit. */
    async vytvor(tenant, kamera) {
      const vse = await nacti();
      for (const k of Object.keys(vse)) if (vse[k].tenant === tenant && vse[k].kamera === kamera) delete vse[k];
      let klic; do { klic = novyKlic(rand); } while (vse[klic]);
      vse[klic] = { tenant, kamera, vytvoreno: now() };
      await store.uloz('prsten-klice', vse);
      return { klic, vytvoreno: vse[klic].vytvoreno };
    },
    async zrus(tenant, kamera) {
      const vse = await nacti(); let n = 0;
      for (const k of Object.keys(vse)) if (vse[k].tenant === tenant && vse[k].kamera === kamera) { delete vse[k]; n++; }
      if (n) await store.uloz('prsten-klice', vse);
      return n;
    },
    /** Kód → { tenant, kamera }, nebo null. */
    async najdi(klic) {
      const k = normKlic(klic); if (k.length !== 12) return null;
      const z = (await nacti())[k];
      return z ? { tenant: z.tenant, kamera: z.kamera } : null;
    },
  };
}
