/**
 * Log událostí dispečinku za období: řádky z A_KAM_Udalost (+ nahrávky
 * k událostem z A_KAM_Nahravka) jednoho tenanta, pro stránku (JSON) a pro
 * stažení do Excelu (src/xlsx.mjs). Období se zadává ve dnech pražského
 * času (od 00:00 prvního dne do 23:59:59 posledního).
 */
import { KINDS, LEVEL_LABEL, TZ } from '../public/proto/sim-core.js';
import { xlsx } from './xlsx.mjs';

const fmtDatum = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtCas = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDT = new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const casti = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Okamžik (ms), kdy v Praze začíná den YYYY-MM-DD; null, když to není datum. */
export function zacatekDne(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let t = Date.UTC(y, mo - 1, d);
  for (let i = 0; i < 2; i++) {    // posun pásma (letní/zimní čas) – dvakrát, kdyby půlnoc padla na změnu času
    const p = Object.fromEntries(casti.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const mistni = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    t -= mistni - Date.UTC(y, mo - 1, d);
  }
  return t;
}
/** Konec dne (poslední ms) YYYY-MM-DD v Praze. */
export function konecDne(iso) { const z = zacatekDne(iso); if (z === null) return null; const dalsi = new Date(z + 36 * 3600000); const p = Object.fromEntries(casti.formatToParts(dalsi).map((x) => [x.type, x.value])); return zacatekDne(`${p.year}-${p.month}-${p.day}`) - 1; }

const druh = (e) => e.kind === 'consent' ? 'souhlas / obraz' : e.kind === 'poznamka' ? 'poznámka' : (KINDS[e.kind]?.label || e.kind || '');
const uroven = (e) => e.mimoHodiny ? LEVEL_LABEL.info : KINDS[e.kind] ? (LEVEL_LABEL[KINDS[e.kind].level] || KINDS[e.kind].level) : '';
const zdroj = (e) => e.kind === 'consent' ? (e.by || 'rodina') : e.kind === 'poznamka' ? 'dispečink' : KINDS[e.kind]?.source || '';
const upoz = (u, k) => u?.[k]?.prijemci ? `${u[k].odeslano}/${u[k].prijemci}${u[k].chyba ? ` (${u[k].chyba})` : ''}` : '';

/** Jeden řádek logu (pro stránku i Excel). `nahravka` = záznam z A_KAM_Nahravka k události (nebo null). */
export function radekLogu(e, kameraNazev, nahravka) {
  const n = nahravka;
  const nahr = !e.rec && !n ? '' : n ? (n.chyba ? `ne – ${n.chyba}` : n.smazanoCas ? 'smazána (doba uchování)' : `ano (${n.uloziste === 'disk' ? 'Google Disk' : 'server'}${n.delkaS ? `, ${n.delkaS} s` : ''}${n.typ === 'kostra' ? ', drátěný model' : ''}${n.zamek ? ', uzamčená – odemkne rodina' : n.odemklKdo ? `, odemkla rodina (${n.odemklKdo})` : ''})`) : 'nepořízena';
  return {
    id: e.id, cas: e.at, datum: fmtDatum.format(new Date(e.at)), casText: fmtCas.format(new Date(e.at)), kameraId: e.patientId, kamera: kameraNazev || e.patientId,
    druh: druh(e), kind: e.kind, uroven: uroven(e), zdroj: zdroj(e), text: e.kind === 'consent' || e.kind === 'poznamka' ? (e.text || '') : (e.text || ''),
    stav: KINDS[e.kind] && KINDS[e.kind].level !== 'info' && !e.mimoHodiny ? (e.state || '') : '', kdo: e.by || '', prevzato: e.takenAt ? fmtDT.format(new Date(e.takenAt)) : '',
    uzavreno: e.closedAt ? fmtDT.format(new Date(e.closedAt)) : '', vysledek: e.result || '', poznamka: e.note || '', eskalovano: e.escalated ? 'ano' : '',
    sms: upoz(e.upozorneni, 'sms'), mail: upoz(e.upozorneni, 'mail'), nahravka: nahr, skutecna: e.real ? 'kamera' : 'simulace',
  };
}

export const SLOUPCE = [['datum', 'Datum'], ['casText', 'Čas'], ['kamera', 'Kamera'], ['druh', 'Událost'], ['uroven', 'Závažnost'], ['zdroj', 'Zdroj'], ['text', 'Text'],
  ['stav', 'Stav'], ['kdo', 'Převzal(a) / zapsal(a)'], ['prevzato', 'Převzato'], ['uzavreno', 'Uzavřeno'], ['vysledek', 'Výsledek'], ['poznamka', 'Poznámka'],
  ['eskalovano', 'Eskalováno'], ['sms', 'SMS (odesláno/příjemci)'], ['mail', 'E-mail (odesláno/příjemci)'], ['nahravka', 'Nahrávka'], ['skutecna', 'Původ'], ['kameraId', 'ID kamery'], ['id', 'ID události']];

/** Sešit .xlsx s logem: list Události + list Období (co a kdy se exportovalo). */
export function logXlsx(radky, { poskytovatel = '', od = '', do: doDne = '', kamera = '' } = {}) {
  return xlsx([
    { nazev: 'Události', hlavicka: SLOUPCE.map(([, h]) => h), radky: radky.map((r) => SLOUPCE.map(([k]) => r[k] ?? '')) },
    { nazev: 'Období', hlavicka: ['Poskytovatel', 'Od', 'Do', 'Kamera', 'Událostí', 'Vytvořeno'], radky: [[poskytovatel, od, doDne, kamera || 'všechny kamery', radky.length, fmtDT.format(new Date())]] },
  ]);
}

/** Hodnoty z jedné sady měření (tlak s tepem, kyslík, teplota přicházejí zvlášť během pár desítek sekund) do jednoho řádku:
 *  řádky seřazené od nejnovějšího se slučují, když jsou do 2 minut od prvního ve skupině a žádná veličina se nepřekrývá. Čas = nejnovější. */
export function slucMereni(radky, oknoMs = 120_000) {
  const POLE = ['tep', 'tlakS', 'tlakD', 'spo2', 'teplota'];
  const out = [];
  for (const r of radky) {
    const g = out[out.length - 1];
    if (g && g.cas - r.cas <= oknoMs && r.cas <= g.cas && !POLE.some((k) => r[k] != null && g[k] != null)) {
      for (const k of POLE) if (r[k] != null) g[k] = r[k];
      g.od = r.cas; g.pocet = (g.pocet || 1) + 1;
    } else out.push({ ...r });
  }
  return out;
}

/** Sešit .xlsx s měřením zdraví z náramku: list Měření + list Info. */
export function mereniXlsx(radky, { poskytovatel = '', kamera = '', naramek = '' } = {}) {
  const t = (v) => (v == null ? '' : v);
  return xlsx([
    { nazev: 'Měření', hlavicka: ['Datum', 'Čas', 'Tep (/min)', 'Tlak horní', 'Tlak dolní', 'Kyslík (%)', 'Teplota (°C)'],
      radky: radky.map((r) => [fmtDatum.format(new Date(r.cas)), fmtCas.format(new Date(r.cas)), t(r.tep), t(r.tlakS), t(r.tlakD), t(r.spo2), t(r.teplota)]) },
    { nazev: 'Info', hlavicka: ['Poskytovatel', 'Kamera', 'Náramek', 'Měření', 'Vytvořeno'], radky: [[poskytovatel, kamera, naramek, radky.length, fmtDT.format(new Date())]] },
  ]);
}
