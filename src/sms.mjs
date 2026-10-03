/**
 * Odeslání SMS přes webhook Make. Scénář `Famicura_Tapo_SMS_Pozvanka` dostane
 * { klic, telefon, text, typ, poznamka }, pošle SMS přes Twilio (stejné spojení
 * a odesílatel jako „JARVIS poslání SMS přes Twilio“), zapíše záznam do Softru
 * a odpoví { "ok": true, "sid": "SM…", "status": "queued" }.
 *
 * Adresa webhooku a klíč jsou jen v .env (SMS_WEBHOOK_URL, SMS_WEBHOOK_KLIC);
 * bez nich se SMS neposílá a dispečink dostane odkaz k odeslání z vlastního telefonu.
 *
 * Odeslaná je jen SMS, na kterou scénář odpověděl { "ok": true } (jako portál
 * Péče doma plus od verze 1.21). Make vrací holé „Accepted“, když požadavek
 * neprošel filtrem scénáře (jiný klíč, chybí telefon nebo text) nebo když
 * scénář neodpovídá: dřív se to tvářilo jako odeslaná SMS, která nikdy nedošla.
 */
export function createSms({ url = process.env.SMS_WEBHOOK_URL || '', klic = process.env.SMS_WEBHOOK_KLIC || '', fetchImpl = fetch, log = console } = {}) {
  const zaznam = (telefon, zprava) => { if (log && log.log) log.log(`[sms] ${telefon ? '…' + String(telefon).slice(-3) : '?'}: ${zprava}`); };
  return {
    nastaveno: !!url,
    /** telefon: 9 číslic (normalizeTelefon). Vrací { ok, sid, status } nebo { ok: false, error }. */
    async posli({ telefon, text, typ = 'FAMICURA', poznamka = '' }) {
      if (!url) return { ok: false, error: 'Odesílání SMS není na serveru nastavené (SMS_WEBHOOK_URL).' };
      if (!/^\d{9}$/.test(String(telefon || ''))) return { ok: false, error: 'Telefon pro SMS musí mít 9 číslic.' };
      if (!text || !String(text).trim()) return { ok: false, error: 'SMS bez textu neodejde.' };
      let r;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ klic, telefon, text, typ, poznamka }) }).finally(() => clearTimeout(t));
      } catch (e) {
        const error = `SMS se nepodařilo odeslat: ${e.name === 'AbortError' ? 'webhook neodpověděl do 15 s' : e.message}`;
        zaznam(telefon, error);
        return { ok: false, error };
      }
      const telo = await r.text().catch(() => '');
      if (!r.ok) { const error = `Webhook SMS odpověděl ${r.status}${telo ? ': ' + telo.slice(0, 120) : ''}.`; zaznam(telefon, error); return { ok: false, error }; }
      let data = null;
      try { data = JSON.parse(telo); } catch { data = null; }
      if (!data || typeof data !== 'object') {
        // Holé „Accepted“ = webhook data přijal, ale scénář SMS neposlal (klíč neprošel filtrem) nebo neodpověděl.
        const error = telo.trim() === 'Accepted'
          ? 'Scénář SMS na Make zprávu neodeslal: zkontrolujte SMS_WEBHOOK_KLIC (filtr scénáře Famicura_Tapo_SMS_Pozvanka) a že scénář běží.'
          : `Webhook SMS odpověděl nečekaně: ${telo.slice(0, 120) || 'prázdná odpověď'}.`;
        zaznam(telefon, error);
        return { ok: false, error };
      }
      if (data.ok !== true) { const error = `Scénář SMS hlásí chybu: ${data.error || data.chyba || JSON.stringify(data).slice(0, 120)}`; zaznam(telefon, error); return { ok: false, error }; }
      zaznam(telefon, `odesláno (${typ}${data.sid ? ', ' + data.sid : ''}${data.status ? ', ' + data.status : ''})`);
      return { ok: true, sid: data.sid || null, status: data.status || null };
    },
  };
}
