/**
 * Upozornění na událost kamery na kontakty, které poskytovatel zadal
 * v dispečinku (rodina 5× jméno + telefon, dvě sady e-mailů, sim-core setKontakty)
 * a telefony poskytovatele (dispečink, služba, administrace – Kontakty → Poskytovatel), podle příjemců
 * zvolených u události v Nastavení (watch[kind].sms = ID příjemců, mail = sady).
 * Číslo služby ze zdroje Péče doma / Péče doma plus dosadí src/sluzba.mjs.
 *
 * Volá se ze stavu tenanta (src/stav-tenant.mjs) po každé zapsané
 * události, skutečné z kamery i simulované. SMS a e-mail jdou stejným
 * webhookem Make jako pozvánky (src/sms.mjs); výsledek se zapíše k události
 * (ev.upozorneni), aby dispečink viděl, kolik zpráv odešlo a proč ne.
 */
import { upozorneniPro, casText, normalizeTelefonCz, POPIS_ROLE } from '../public/proto/sim-core.js';
import { cisloZdroje } from './sluzba.mjs';

const bezDiakritiky = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Text SMS: bez diakritiky, do 160 znaků; podstatné je kdo, kde (místo) a kdy – telefon dispečinku se neposílá (od 3.40). */
export function textUpozorneniSms({ jmeno, misto, label, cas, poskytovatel }) {
  // zkrácení na celá slova, ať v SMS nezůstane useknuté slovo nebo neuzavřená závorka
  const zkrat = (s, n) => { s = bezDiakritiky(s || ''); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s(,;:-]+$/, ''); };
  const kdo = zkrat(poskytovatel, 30) || 'Dispecink';
  const kde = misto ? ` (${zkrat(misto, 40)})` : '';
  let t = `Famicura: ${zkrat(jmeno, 30)}${kde}: ${zkrat(label, 40).toLowerCase()}, ${cas}. ${kdo}.`;
  if (t.length > 160) t = t.slice(0, 157) + '...';
  return t;
}

export function textUpozorneniMail({ jmeno, misto, label, uroven, cas, text, poskytovatel, odkaz }) {
  return [`Famicura Kamera hlásí událost u klienta ${jmeno}.`, '',
    `Událost: ${label}${uroven ? ` (${uroven})` : ''}`, `Místo: ${misto || '–'}`, `Čas: ${cas}`, text ? `Kamera: ${text}` : null, '',
    `Dispečink ${poskytovatel || ''} událost vidí a řeší podle nastavení.`,
    odkaz ? `Aplikace rodiny: ${odkaz}` : null, '', 'Tuto zprávu posílá server Famicura Kamera automaticky podle kontaktů zadaných poskytovatelem.'].filter((r) => r !== null).join('\n');
}

export function createUpozorneni({ sms, sluzba = null, uzivatele = null, log = console, odkaz = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/proto/rodina.html` : '' } = {}) {
  const UROVEN = { crit: 'kritická', warn: 'varování', info: 'informativní', tech: 'technická' };
  return {
    /** Pošle, co událost vyžaduje; vrátí { sms: {prijemci, odeslano, chyba}, mail: {…} } nebo null, když není komu. */
    async posli(state, ev, { tenant = '' } = {}) {
      const u = upozorneniPro(state, ev);
      if (!u) return null;
      const posk = state.poskytovatel || {};
      // do textu zpráv jde jméno, místo a čas; telefon dispečinku ne (rodina ho má v aplikaci a v Kontaktech)
      const spolecne = { jmeno: u.patient.name, misto: u.patient.place, label: u.label, uroven: UROVEN[u.level], cas: casText(ev.at), text: ev.text, poskytovatel: posk.nazev, odkaz };
      const vysledek = { sms: { prijemci: u.sms.length + u.smsZdroje.length + u.smsUcty.length, odeslano: 0, chyba: null, komu: u.komu }, mail: { prijemci: u.mail.length, odeslano: 0, chyba: null } };
      // účty rodiny (Uživatelé rodiny, příjemce u:<id>): telefon z účtu na serveru – platí vždy ten aktuální; deaktivovaný účet se vynechá
      for (const id of u.smsUcty) {
        try {
          if (!uzivatele) throw new Error('účty rodiny nejsou na serveru k dispozici');
          const a = await uzivatele.pro(tenant).podleId(id);
          if (!a) throw new Error('účet rodiny už neexistuje – upravte příjemce v Nastavení alertů');
          if (a.deaktivovan) { vysledek.sms.prijemci--; continue; }
          const tel = normalizeTelefonCz(a.telefon);
          if (!tel) throw new Error(`účet ${a.jmeno} nemá platný telefon`);
          if (!u.sms.includes(tel)) { u.sms.push(tel); u.komu.push(a.jmeno); } else vysledek.sms.prijemci--;
        } catch (e) { vysledek.sms.chyba = `účet rodiny: ${e.message}`; }
      }
      // telefony poskytovatele ze zdroje Péče doma / Péče doma plus (Kontakty → Poskytovatel): dosadí se tady, ať platí vždy to aktuální
      for (const z of u.smsZdroje) {
        try {
          if (!sluzba || !sluzba.nastaveno) throw new Error('číslo z Péče doma (plus) není na serveru nastavené (JHN_APPS_TOKEN a FAMICURA_KAMERA_KLIC)');
          const tel = normalizeTelefonCz(cisloZdroje(await sluzba.telefon(tenant), z.zdroj, z.id));
          if (!tel) throw new Error(`telefon (${z.zdroj === 'pecedoma' ? 'Péče doma' : 'Péče doma plus'}) není nastavený`);
          if (!u.sms.includes(tel)) u.sms.push(tel);
        } catch (e) { vysledek.sms.chyba = `${POPIS_ROLE[z.id] || z.id}: ${e.message}`; }
      }
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
