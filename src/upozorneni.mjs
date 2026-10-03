/**
 * Upozornění na událost kamery na kontakty, které poskytovatel zadal
 * v dispečinku (až tři čísla na SMS a tři e-maily, sim-core setKontakty),
 * podle zatržení SMS / E-mail u události v Nastavení (watch[kind].sms/mail).
 *
 * Volá se ze stavu tenanta (src/stav-tenant.mjs) po každé zapsané
 * události, skutečné z kamery i simulované. SMS a e-mail jdou stejným
 * webhookem Make jako pozvánky (src/sms.mjs); výsledek se zapíše k události
 * (ev.upozorneni), aby dispečink viděl, kolik zpráv odešlo a proč ne.
 */
import { upozorneniPro, casText } from '../public/proto/sim-core.js';

const bezDiakritiky = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Text SMS: bez diakritiky, do 160 znaků. */
export function textUpozorneniSms({ jmeno, label, cas, poskytovatel, telefon }) {
  const kdo = bezDiakritiky(poskytovatel).slice(0, 30) || 'Dispecink';
  let t = `Famicura: ${bezDiakritiky(jmeno).slice(0, 30)}: ${bezDiakritiky(label).toLowerCase().slice(0, 40)} (${cas}). ${kdo}${telefon ? ' ' + bezDiakritiky(telefon).slice(0, 16) : ''}.`;
  if (t.length > 160) t = t.slice(0, 157) + '...';
  return t;
}

export function textUpozorneniMail({ jmeno, misto, label, uroven, cas, text, poskytovatel, telefon, odkaz }) {
  return [`Famicura Kamera hlásí událost u klienta ${jmeno}${misto ? ` (${misto})` : ''}.`, '',
    `Událost: ${label}${uroven ? ` (${uroven})` : ''}`, `Čas: ${cas}`, text ? `Kamera: ${text}` : null, '',
    `Dispečink ${poskytovatel || ''}${telefon ? `, tel. ${telefon}` : ''} událost vidí a řeší podle nastavení.`,
    odkaz ? `Aplikace rodiny: ${odkaz}` : null, '', 'Tuto zprávu posílá server Famicura Kamera automaticky podle kontaktů zadaných poskytovatelem.'].filter((r) => r !== null).join('\n');
}

export function createUpozorneni({ sms, log = console, odkaz = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/proto/rodina.html` : '' } = {}) {
  const UROVEN = { crit: 'kritická', warn: 'varování', info: 'informativní', tech: 'technická' };
  return {
    /** Pošle, co událost vyžaduje; vrátí { sms: {prijemci, odeslano, chyba}, mail: {…} } nebo null, když není komu. */
    async posli(state, ev) {
      const u = upozorneniPro(state, ev);
      if (!u) return null;
      const posk = state.poskytovatel || {};
      const spolecne = { jmeno: u.patient.name, misto: u.patient.place, label: u.label, uroven: UROVEN[u.level], cas: casText(ev.at), text: ev.text, poskytovatel: posk.nazev, telefon: posk.telefon, odkaz };
      const vysledek = { sms: { prijemci: u.sms.length, odeslano: 0, chyba: null }, mail: { prijemci: u.mail.length, odeslano: 0, chyba: null } };
      if (!sms || !sms.nastaveno) {
        const chyba = 'SMS a e-mail nejsou na serveru nastavené (SMS_WEBHOOK_URL).';
        if (u.sms.length) vysledek.sms.chyba = chyba; if (u.mail.length) vysledek.mail.chyba = chyba;
        return vysledek;
      }
      const textSms = textUpozorneniSms(spolecne);
      for (const telefon of u.sms) {
        const o = await sms.posli({ telefon, text: textSms, typ: 'FAMICURA_UDALOST', poznamka: `Událost ${u.label}, kamera ${u.patient.id}.` });
        if (o.ok) vysledek.sms.odeslano++; else vysledek.sms.chyba = o.error;
      }
      const predmet = `Famicura Kamera: ${u.label} – ${u.patient.name}`;
      const textMail = textUpozorneniMail(spolecne);
      for (const email of u.mail) {
        const o = await sms.posliMail({ email, predmet, text: textMail, typ: 'FAMICURA_UDALOST', poznamka: `Událost ${u.label}, kamera ${u.patient.id}.` });
        if (o.ok) vysledek.mail.odeslano++; else vysledek.mail.chyba = o.error;
      }
      if (log && log.log) log.log(`[upozorneni] ${u.patient.id} ${u.kind}: SMS ${vysledek.sms.odeslano}/${vysledek.sms.prijemci}, e-mail ${vysledek.mail.odeslano}/${vysledek.mail.prijemci}${vysledek.sms.chyba || vysledek.mail.chyba ? ' – ' + (vysledek.sms.chyba || vysledek.mail.chyba) : ''}`);
      return vysledek;
    },
  };
}
