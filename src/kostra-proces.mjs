/**
 * Samostatný proces pro výpočet drátěného modelu (spouští src/kostra.mjs přes child_process.fork).
 *
 * TensorFlow počítá synchronně a drží hlavní vlákno; v hlavním procesu serveru by po každé
 * události zastavil na sekundy obsluhu požadavků (obraz rodiny přes HTTPS/HLS, API). Tady běží
 * vedle serveru, s nižší prioritou, model se načte jednou. Zprávy: { id, akce: 'priprav' } →
 * { id, ok, vypocet }; { id, akce: 'zKlipu', data, delkaS } → { id, ok, out } nebo { id, ok: false, chyba, status }.
 */
import { createKostra } from './kostra.mjs';

const log = { log: (...a) => process.send?.({ log: a.join(' ') }), error: (...a) => process.send?.({ chybaLog: a.join(' ') }) };
const detektor = process.env.KOSTRA_DETEKTOR === 'fake' ? (await import('./kostra-fake.mjs')).fakeDetektor() : null;
const k = createKostra({ modelDir: process.env.KOSTRA_MODEL_DIR || undefined, detektor, proces: false, log });

process.on('message', async (m) => {
  if (!m || !m.id) return;
  if (m.akce === 'priprav') { const ok = await k.priprav(); process.send({ id: m.id, ok, vypocet: ok ? await k.vypocet() : null }); return; }
  if (m.akce === 'zKlipu') {
    try { const out = await k.zKlipu(Buffer.from(m.data), { delkaS: m.delkaS }); process.send({ id: m.id, ok: true, out }); }
    catch (e) { process.send({ id: m.id, ok: false, chyba: String(e.message || e), status: e.status || 502 }); }
  }
});
process.on('disconnect', () => process.exit(0));   // server skončil → skončit s ním
