/**
 * Odeslání SMS a e-mailu přes webhook Make. Scénář `Famicura_Tapo_SMS_Pozvanka`
 * dostane { klic, kanal, telefon | email, text, predmet, typ, poznamka }:
 * SMS pošle přes Twilio (stejné spojení a odesílatel jako „JARVIS poslání SMS
 * přes Twilio“) a zapíše záznam do Softru, e-mail (kanal = 'mail') pošle ze
 * schránky Centrum LB; odpoví { "ok": true, "sid": "SM…" } nebo { "ok": true, "id": … }.
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
  const zaznam = (komu, zprava) => { if (log && log.log) log.log(`[sms] ${komu}: ${zprava}`); };
  // Jeden webhook pro oba kanály: scénář pozná e-mail podle kanal = 'mail'.
  async function webhook(komu, kanal, data) {
    let r;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ klic, kanal, ...data }) }).finally(() => clearTimeout(t));
    } catch (e) {
      const error = `${kanal === 'mail' ? 'E-mail' : 'SMS'} se nepodařilo odeslat: ${e.name === 'AbortError' ? 'webhook neodpověděl do 15 s' : e.message}`;
      zaznam(komu, error);
      return { ok: false, error };
    }
    const telo = await r.text().catch(() => '');
    if (!r.ok) { const error = `Webhook SMS odpověděl ${r.status}${telo ? ': ' + telo.slice(0, 120) : ''}.`; zaznam(komu, error); return { ok: false, error }; }
    let odpoved = null;
    try { odpoved = JSON.parse(telo); } catch { odpoved = null; }
    if (!odpoved || typeof odpoved !== 'object') {
      // Holé „Accepted“ = webhook data přijal, ale scénář zprávu neposlal (klíč neprošel filtrem, jiný scénář) nebo neodpověděl.
      const error = telo.trim() === 'Accepted'
        ? 'Scénář SMS na Make zprávu neodeslal: zkontrolujte SMS_WEBHOOK_URL a SMS_WEBHOOK_KLIC (scénář Famicura_Tapo_SMS_Pozvanka a jeho filtr) a že scénář běží.'
        : `Webhook SMS odpověděl nečekaně: ${telo.slice(0, 120) || 'prázdná odpověď'}.`;
      zaznam(komu, error);
      return { ok: false, error };
    }
    if (odpoved.ok !== true) { const error = `Scénář SMS hlásí chybu: ${odpoved.error || odpoved.chyba || JSON.stringify(odpoved).slice(0, 120)}`; zaznam(komu, error); return { ok: false, error }; }
    zaznam(komu, `odesláno (${data.typ}${odpoved.sid ? ', ' + odpoved.sid : ''}${odpoved.id ? ', ' + String(odpoved.id).slice(0, 12) : ''}${odpoved.status ? ', ' + odpoved.status : ''})`);
    return { ok: true, sid: odpoved.sid || odpoved.id || null, status: odpoved.status || null };
  }
  return {
    nastaveno: !!url,
    /** telefon: 9 číslic (normalizeTelefon). Vrací { ok, sid, status } nebo { ok: false, error }. */
    async posli({ telefon, text, typ = 'FAMICURA', poznamka = '' }) {
      if (!url) return { ok: false, error: 'Odesílání SMS není na serveru nastavené (SMS_WEBHOOK_URL).' };
      if (!/^\d{9}$/.test(String(telefon || ''))) return { ok: false, error: 'Telefon pro SMS musí mít 9 číslic.' };
      if (!text || !String(text).trim()) return { ok: false, error: 'SMS bez textu neodejde.' };
      return webhook('…' + String(telefon).slice(-3), 'sms', { telefon, text, typ, poznamka });
    },
    /** E-mail stejným webhookem (kanal mail): adresa, předmět, prostý text. */
    async posliMail({ email, predmet, text, typ = 'FAMICURA', poznamka = '' }) {
      if (!url) return { ok: false, error: 'Odesílání e-mailu není na serveru nastavené (SMS_WEBHOOK_URL).' };
      if (!/^[^\s@]{1,64}@[^\s@]{1,100}\.[a-z]{2,24}$/i.test(String(email || ''))) return { ok: false, error: 'E-mail pro upozornění není platná adresa.' };
      if (!text || !String(text).trim()) return { ok: false, error: 'E-mail bez textu neodejde.' };
      const dom = String(email).split('@')[1];
      return webhook('…@' + dom, 'mail', { email, predmet: String(predmet || 'Famicura Kamera').slice(0, 150), text, typ, poznamka });
    },
  };
}
