/**
 * Odeslání SMS přes webhook Make, stejně jako aplikace pacienta Péče doma
 * (scénář PeceDoma_SMS_Odeslani: klíč, telefon, text). Adresa webhooku a klíč
 * jsou jen v .env (SMS_WEBHOOK_URL, SMS_WEBHOOK_KLIC); bez nich se SMS neposílá
 * a dispečink dostane odkaz k odeslání z vlastního telefonu.
 */
export function createSms({ url = process.env.SMS_WEBHOOK_URL || '', klic = process.env.SMS_WEBHOOK_KLIC || '', fetchImpl = fetch } = {}) {
  return {
    nastaveno: !!url,
    /** telefon: 9 číslic (normalizeTelefon). Vrací { ok } nebo { ok: false, error }. */
    async posli({ telefon, text, typ = 'FAMICURA', poznamka = '' }) {
      if (!url) return { ok: false, error: 'Odesílání SMS není na serveru nastavené (SMS_WEBHOOK_URL).' };
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ klic, telefon, text, typ, poznamka }) }).finally(() => clearTimeout(t));
        if (!r.ok) return { ok: false, error: `Webhook SMS odpověděl ${r.status}.` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `SMS se nepodařilo odeslat: ${e.name === 'AbortError' ? 'webhook neodpověděl do 15 s' : e.message}` };
      }
    },
  };
}
