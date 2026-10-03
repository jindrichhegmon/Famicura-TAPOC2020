/**
 * Asistent dispečinku přes webhook Make (stejný princip jako SMS): scénář
 * dostane otázku a text nápovědy jako podklad a vrátí { odpoved } z AI.
 * Bez ASISTENT_WEBHOOK_URL v .env odpovídá prohlížeč sám z nápovědy
 * (public/proto/napoveda.js), takže asistent funguje vždy.
 */
export function createAsistent({ url = process.env.ASISTENT_WEBHOOK_URL || '', klic = process.env.ASISTENT_WEBHOOK_KLIC || '', fetchImpl = fetch } = {}) {
  return {
    nastaveno: !!url,
    /** Vrací { ok, odpoved } nebo { ok: false, error }. */
    async zeptej({ dotaz, kontext = '' }) {
      if (!url) return { ok: false, error: 'Asistent AI není na serveru nastavený (ASISTENT_WEBHOOK_URL).' };
      if (typeof dotaz !== 'string' || !dotaz.trim() || dotaz.length > 1000) return { ok: false, error: 'Otázka musí mít 1 až 1000 znaků.' };
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 40000);
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ klic, dotaz, kontext, typ: 'FAMICURA_DISPECINK' }) }).finally(() => clearTimeout(t));
        if (!r.ok) return { ok: false, error: `Webhook asistenta odpověděl ${r.status}.` };
        const text = await r.text();
        let odpoved = text;
        try { const j = JSON.parse(text); odpoved = j.odpoved || j.answer || j.text || text; } catch { /* prostý text */ }
        odpoved = String(odpoved || '').trim().slice(0, 4000);
        // Make bez odpovědi scénáře vrací „Accepted“: požadavek neprošel filtrem (špatný klíč) nebo scénář neběží.
        if (!odpoved || odpoved === 'Accepted') return { ok: false, error: odpoved ? 'Webhook požadavek nepřijal (klíč nebo vypnutý scénář).' : 'Asistent vrátil prázdnou odpověď.' };
        return { ok: true, odpoved };
      } catch (e) {
        return { ok: false, error: `Asistent neodpověděl: ${e.name === 'AbortError' ? 'webhook neodpověděl do 40 s' : e.message}` };
      }
    },
  };
}
