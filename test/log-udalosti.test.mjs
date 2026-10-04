import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { xlsx, zip, crc32, sloupec, listXml } from '../src/xlsx.mjs';
import { zacatekDne, konecDne, radekLogu, logXlsx, SLOUPCE } from '../src/log-udalosti.mjs';
import { createMockTabulky } from './mock-tabulky.mjs';

/** Rozbalí ZIP (jen to, co náš zip umí: deflate, bez šifrování) → { název: text }. */
function rozbal(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const metoda = buf.readUInt16LE(i + 8), zab = buf.readUInt32LE(i + 18), delkaN = buf.readUInt16LE(i + 26), delkaE = buf.readUInt16LE(i + 28);
    const nazev = buf.slice(i + 30, i + 30 + delkaN).toString('utf8');
    const data = buf.slice(i + 30 + delkaN + delkaE, i + 30 + delkaN + delkaE + zab);
    out[nazev] = (metoda === 8 ? inflateRawSync(data) : data).toString('utf8');
    i += 30 + delkaN + delkaE + zab;
  }
  assert.equal(buf.readUInt32LE(i), 0x02014b50, 'po položkách následuje centrální adresář');
  return out;
}

test('xlsx: platný ZIP s listy, hlavička tučně, text se escapuje, čísla jako čísla', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC-32 podle normy');
  assert.equal(sloupec(0), 'A'); assert.equal(sloupec(25), 'Z'); assert.equal(sloupec(26), 'AA'); assert.equal(sloupec(27), 'AB');
  const b = xlsx([{ nazev: 'Události', hlavicka: ['Datum', 'Počet'], radky: [['4. 10. 2026', 3], ['a<b&"c"', null]] }, { nazev: 'Období', hlavicka: ['Od'], radky: [['x']] }]);
  assert.equal(b.slice(0, 2).toString(), 'PK');
  const f = rozbal(b);
  assert.deepEqual(Object.keys(f).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  assert.match(f['xl/workbook.xml'], /<sheet name="Události" sheetId="1" r:id="rId1"\/><sheet name="Období" sheetId="2"/);
  const l = f['xl/worksheets/sheet1.xml'];
  assert.match(l, /<c s="1" r="A1" t="inlineStr"><is><t xml:space="preserve">Datum<\/t>/, 'hlavička se stylem 1 (tučně)');
  assert.match(l, /<c r="B2"><v>3<\/v><\/c>/, 'číslo jako číslo');
  assert.match(l, /a&lt;b&amp;&quot;c&quot;/, 'escapované znaky');
  assert.doesNotMatch(l, /r="B3"/, 'prázdná buňka se nevypisuje');
  assert.match(l, /state="frozen"/, 'zmrazená hlavička');
  // název listu bez zakázaných znaků, nejvýš 31 znaků
  const n = zip([['a.txt', 'ahoj']]); assert.equal(rozbal(n)['a.txt'], 'ahoj');
  assert.match(listXml({ hlavicka: ['x'], radky: [['\u0001řídicí']] }), /<t xml:space="preserve">řídicí<\/t>/, 'řídicí znaky pryč');
});

test('období: hranice dnů v pražském čase, i přes změnu času', () => {
  assert.equal(new Date(zacatekDne('2026-10-04')).toISOString(), '2026-10-03T22:00:00.000Z', 'letní čas: 00:00 = 22:00 UTC');
  assert.equal(new Date(konecDne('2026-10-04')).toISOString(), '2026-10-04T21:59:59.999Z');
  assert.equal(new Date(zacatekDne('2026-01-15')).toISOString(), '2026-01-14T23:00:00.000Z', 'zimní čas');
  assert.equal(new Date(konecDne('2026-10-25')).toISOString(), '2026-10-25T22:59:59.999Z', 'den změny času končí už v zimním čase');
  assert.equal(konecDne('2026-10-25') - zacatekDne('2026-10-25') + 1, 25 * 3600000, 'den změny času má 25 hodin');
  assert.equal(zacatekDne('2026-13-01'), null); assert.equal(zacatekDne('4. 10. 2026'), null); assert.equal(zacatekDne(''), null);
});

test('řádek logu: popisky, upozornění, nahrávka; sešit má list Události a Období', () => {
  const at = Date.UTC(2026, 9, 4, 7, 41, 5);
  const e = { id: 'e1', at, patientId: 'tapoc2020', kind: 'linecross', state: 'převzat', by: 'Dispečerka Jana', takenAt: at + 60000, rec: true, real: true, text: 'Kamera hlásí: překročení čáry.',
    upozorneni: { sms: { prijemci: 2, odeslano: 2, chyba: null }, mail: { prijemci: 1, odeslano: 0, chyba: 'SMTP odmítl' } } };
  const r = radekLogu(e, 'Byt Novákovi', { chyba: null, uloziste: 'server', delkaS: 15, smazanoCas: null });
  assert.equal(r.datum, '4. 10. 2026'); assert.equal(r.casText, '09:41:05'); assert.equal(r.kamera, 'Byt Novákovi');
  assert.equal(r.druh, 'Překročení čáry'); assert.equal(r.uroven, 'varování'); assert.equal(r.zdroj, 'kamera'); assert.equal(r.stav, 'převzat');
  assert.equal(r.kdo, 'Dispečerka Jana'); assert.equal(r.prevzato, '4. 10. 2026 09:42'); assert.equal(r.sms, '2/2'); assert.equal(r.mail, '0/1 (SMTP odmítl)');
  assert.equal(r.nahravka, 'ano (server, 15 s)'); assert.equal(r.skutecna, 'kamera');
  assert.equal(radekLogu({ ...e, rec: true }, 'X', { chyba: 'nenahráno: rodina povolila jen „rozostření“ – plný obraz se neukládá' }).nahravka, 'ne – nenahráno: rodina povolila jen „rozostření“ – plný obraz se neukládá');
  assert.equal(radekLogu({ ...e, rec: true }, 'X', null).nahravka, 'nepořízena');
  assert.equal(radekLogu({ ...e, rec: false, upozorneni: undefined }, 'X', null).nahravka, ''); 
  assert.equal(radekLogu({ id: 'e2', at, patientId: 'tapoc2020', kind: 'poznamka', by: 'Dispečink', text: 'Volala dcera.' }, 'X', null).druh, 'poznámka');
  assert.equal(radekLogu({ id: 'e3', at, patientId: 'tapoc2020', kind: 'consent', by: 'rodina', text: 'Rodina povolila plný obraz.' }, 'X', null).zdroj, 'rodina');
  const b = logXlsx([r], { poskytovatel: 'FamiCura', od: '2026-10-01', do: '2026-10-04', kamera: 'Byt Novákovi' });
  const f = rozbal(b);
  assert.match(f['xl/worksheets/sheet1.xml'], /Překročení čáry/); assert.match(f['xl/worksheets/sheet2.xml'], /FamiCura.*2026-10-01.*2026-10-04.*Byt Novákovi/);
  assert.equal(SLOUPCE.length, 20);
});

test('paměťové tabulky: rozsah {od, do} na sloupci', async () => {
  const tb = createMockTabulky(); const T = '22202480FAMICURA';
  for (const c of [100, 200, 300]) await tb.vloz(T, 'A_KAM_Udalost', { Id: 'e' + c, KameraID: 'k', Cas: c, Druh: 'motion', Stav: 'uzavřen' });
  assert.deepEqual((await tb.vyber(T, 'A_KAM_Udalost', { kde: { Cas: { od: 150, do: 300 } }, razeni: [['Cas', 'ASC']] })).map((r) => r.Id), ['e200', 'e300']);
  assert.deepEqual((await tb.vyber(T, 'A_KAM_Udalost', { kde: { Cas: { do: 199 } } })).map((r) => r.Id), ['e100']);
  assert.deepEqual((await tb.vyber(T, 'A_KAM_Udalost', { kde: { Cas: { od: 300 } } })).map((r) => r.Id), ['e300']);
});
