/**
 * Sešit Excelu (.xlsx) bez knihoven: ZIP s několika XML soubory. Stačí na
 * export logu (text, čísla, datum jako text). Zip používá deflate (zlib),
 * CRC-32 je spočítané ručně.
 *
 *   xlsx([{ nazev: 'Události', hlavicka: ['Datum', 'Čas'], radky: [['4. 10. 2026', '09:41'], …] }]) → Buffer
 */
import { deflateRawSync } from 'node:zlib';

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
  // znaky, které XML nesmí obsahovat (řídicí kromě tabulátoru a konců řádků)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Název sloupce: 0 → A, 25 → Z, 26 → AA. */
export const sloupec = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const bunka = (v, r, c) => {
  const ref = `${sloupec(c)}${r}`;
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v).slice(0, 32000))}</t></is></c>`;
};

/** XML jednoho listu: první řádek hlavička (tučná přes styl 1), pak data; sloupce rozumně široké. */
export function listXml({ hlavicka = [], radky = [] }) {
  const vsechny = [hlavicka, ...radky];
  const sirky = hlavicka.map((h, i) => { let w = String(h).length; for (const r of radky.slice(0, 500)) w = Math.max(w, String(r[i] ?? '').length); return Math.min(60, Math.max(8, w + 2)); });
  const cols = sirky.length ? `<cols>${sirky.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const rows = vsechny.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => i === 0 && v !== '' && v != null ? bunka(v, i + 1, c).replace('<c r=', '<c s="1" r=') : bunka(v, i + 1, c)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** Soubory → ZIP (deflate). */
export function zip(soubory) {
  const casti = [], stred = []; let posun = 0;
  const dos = (() => { const d = new Date(); return (((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0; })();
  for (const [jmeno, obsah] of soubory) {
    const nazev = Buffer.from(jmeno, 'utf8'), data = Buffer.isBuffer(obsah) ? obsah : Buffer.from(obsah, 'utf8');
    const zabalene = deflateRawSync(data), crc = crc32(data);
    const hl = Buffer.alloc(30);
    hl.writeUInt32LE(0x04034b50, 0); hl.writeUInt16LE(20, 4); hl.writeUInt16LE(0x0800, 6); hl.writeUInt16LE(8, 8); hl.writeUInt32LE(dos, 10);
    hl.writeUInt32LE(crc, 14); hl.writeUInt32LE(zabalene.length, 18); hl.writeUInt32LE(data.length, 22); hl.writeUInt16LE(nazev.length, 26); hl.writeUInt16LE(0, 28);
    casti.push(hl, nazev, zabalene);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(dos, 12);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(zabalene.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nazev.length, 28); cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(posun, 42);
    stred.push(cd, nazev);
    posun += hl.length + nazev.length + zabalene.length;
  }
  const velikostStredu = stred.reduce((a, b) => a + b.length, 0);
  const konec = Buffer.alloc(22);
  konec.writeUInt32LE(0x06054b50, 0); konec.writeUInt16LE(0, 4); konec.writeUInt16LE(0, 6); konec.writeUInt16LE(soubory.length, 8); konec.writeUInt16LE(soubory.length, 10);
  konec.writeUInt32LE(velikostStredu, 12); konec.writeUInt32LE(posun, 16); konec.writeUInt16LE(0, 20);
  return Buffer.concat([...casti, ...stred, konec]);
}

/** Sešit s jedním nebo více listy → Buffer (.xlsx). */
export function xlsx(listy) {
  if (!Array.isArray(listy) || !listy.length) throw new Error('Sešit bez listů.');
  const jmena = listy.map((l, i) => esc(String(l.nazev || `List${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `List${i + 1}`));
  const soubory = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${listy.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${jmena.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${listy.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${listy.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...listy.map((l, i) => [`xl/worksheets/sheet${i + 1}.xml`, listXml(l)]),
  ];
  return zip(soubory);
}
