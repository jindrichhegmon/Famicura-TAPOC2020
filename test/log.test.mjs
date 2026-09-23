import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogEntry, logToCsv, eventSource } from '../public/analyzer.js';

/** Just enough of a DOM for createLogEntry: elements with children and text. */
function fakeDoc() {
  const el = (tag) => ({
    tag, className: '', textContent: '', children: [],
    append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? { tag: '#text', textContent: k, children: [] } : k); },
    text() { return this.textContent + this.children.map((c) => c.text ? c.text() : c.textContent).join(''); },
    find(cls) { if (this.className.split(' ').includes(cls)) return this; for (const c of this.children) { const f = c.find?.(cls); if (f) return f; } return null; },
  });
  return { createElement: el };
}

const device = { id: 'tapoc2020', name: 'Pokoj 12' };
const zKamery = { at: new Date(2026, 8, 23, 16, 40, 7), t: 0, kind: 'cam-linecross', level: 'warn', text: 'Kamera hlásí: překročení čáry.', device };
const zAnalyzy = { at: new Date(2026, 8, 23, 16, 40, 16), t: 110, kind: 'missing', level: 'warn', text: 'Ztráta detekce postavy – v obraze není nikdo rozpoznán.', device };

test('zdroj události: co hlásí kamera vs. co našla analýza', () => {
  assert.equal(eventSource(zKamery), 'kamera');
  assert.equal(eventSource(zAnalyzy), 'analýza');
  assert.equal(eventSource({ kind: 'stream' }), 'analýza');
});

test('řádek logu nese štítek zdroje i název kamery', () => {
  const a = createLogEntry(fakeDoc(), zKamery);
  assert.match(a.className, /src-cam/);
  assert.equal(a.find('srcTag').textContent, 'kamera');
  assert.equal(a.find('cam').text(), 'kamera · Pokoj 12');
  const b = createLogEntry(fakeDoc(), zAnalyzy);
  assert.match(b.className, /src-ai/);
  assert.equal(b.find('srcTag').textContent, 'analýza');
});

test('CSV má sloupec Zdroj a čitelný typ i pro události kamery', () => {
  const csv = logToCsv([zKamery, zAnalyzy]).split('\r\n');
  assert.equal(csv[0], 'Datum;Čas;Od začátku analýzy;Kamera;ID kamery;Zdroj;Typ;Závažnost;Popis');
  assert.equal(csv[1], '23.09.2026;16:40:07;00:00;Pokoj 12;tapoc2020;kamera;překročení čáry;varování;Kamera hlásí: překročení čáry.');
  assert.equal(csv[2], '23.09.2026;16:40:16;01:50;Pokoj 12;tapoc2020;analýza;ztráta detekce;varování;Ztráta detekce postavy – v obraze není nikdo rozpoznán.');
});
