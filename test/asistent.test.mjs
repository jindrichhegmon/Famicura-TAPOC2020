import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsistent } from '../src/asistent.mjs';
import { odpovez, TEMATA, napovedaText, napovedaHtml, napovedaProsty } from '../public/proto/napoveda.js';

test('nápověda: asistent najde téma podle klíčových slov, i bez diakritiky', () => {
  assert.equal(odpovez('Jak požádat rodinu o plný obraz?').tema, 'zadost');
  assert.equal(odpovez('jak pozadat o plny obraz').tema, 'zadost');
  assert.equal(odpovez('co je nouzový přístup při pádu').tema, 'nouze');
  assert.equal(odpovez('jak založit účet rodině a poslat SMS').tema, 'rodina');
  assert.equal(odpovez('kde upravím záhlaví a jméno dispečera').tema, 'poskytovatel');
  assert.equal(odpovez('nejde obraz, vidím náhradní scénu').tema, 'obraz');
  assert.equal(odpovez('kam zapsat poznámku ke kameře').tema, 'poznamky');
  assert.equal(odpovez('co je nového').tema, 'novinky');
  assert.equal(odpovez('kde je ozubené kolečko s nastavením').tema, 'poskytovatel');
  assert.equal(odpovez('dobrý den').tema, null);
  assert.match(odpovez('xyzzy').text, /Témata:/);
  assert.ok(TEMATA.length >= 10);
  assert.match(napovedaText(), /## Žádost o plný obraz/);
  assert.ok(odpovez('jak pozadat o plny obraz').html.includes('<ol><li>'), 'odpověď má i HTML s kroky');
});

test('nápověda: strukturovaný obsah → HTML (nadpisy, odrážky, kroky, upozornění, tučně) s escapováním; každé téma má strukturu', () => {
  const html = napovedaHtml('Úvod <b>.\n\n### Část\n- **Tučně** odrážka\n- druhá\n1. krok a\n2. krok b\n! Pozor & na to\n\nZávěr');
  assert.equal(html, '<p>Úvod &lt;b&gt;.</p><h4>Část</h4><ul><li><strong>Tučně</strong> odrážka</li><li>druhá</li></ul><ol><li>krok a</li><li>krok b</li></ol><p class="tip">Pozor &amp; na to</p><p>Závěr</p>');
  assert.equal(napovedaProsty('### Část\n- **Tučně** odrážka\n1. krok\n! pozor'), 'Část Tučně odrážka krok pozor');
  for (const t of TEMATA) {
    assert.ok(t.obsah && t.text, t.id);
    assert.ok(/^(###|-|\d+\.|!)\s/m.test(t.obsah), `${t.id}: má nadpis, odrážky nebo kroky`);
    assert.ok(!/<|&lt;script/.test(napovedaHtml(t.obsah).replace(/<\/?(p|h4|ul|ol|li|strong)( class="tip")?>/g, '')), `${t.id}: jen povolené značky`);
  }
  assert.ok(TEMATA.find((t) => t.id === 'novinky').obsah.split('\n').filter(Boolean).every((l) => /^- \*\*Verze /.test(l)), 'Co je nové: každá verze jako odrážka');
});

test('asistent: bez webhooku není nastavený; s webhookem pošle otázku a podklad a vrátí odpověď', async () => {
  assert.equal(createAsistent({ url: '' }).nastaveno, false);
  const volani = [];
  const fetchImpl = async (url, init) => { volani.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => JSON.stringify({ odpoved: 'Klepněte na dlaždici…' }) }; };
  const a = createAsistent({ url: 'https://hook.example/x', klic: 'k1', fetchImpl });
  const r = await a.zeptej({ dotaz: 'Jak požádat?', kontext: 'podklad' });
  assert.deepEqual(r, { ok: true, odpoved: 'Klepněte na dlaždici…' });
  assert.equal(volani[0].body.klic, 'k1'); assert.equal(volani[0].body.dotaz, 'Jak požádat?'); assert.equal(volani[0].body.kontext, 'podklad');
  const prosty = createAsistent({ url: 'https://hook.example/x', fetchImpl: async () => ({ ok: true, text: async () => 'Prostý text' }) });
  assert.equal((await prosty.zeptej({ dotaz: 'a' })).odpoved, 'Prostý text');
  const chyba = createAsistent({ url: 'https://hook.example/x', fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) });
  assert.match((await chyba.zeptej({ dotaz: 'a' })).error, /500/);
  assert.match((await a.zeptej({ dotaz: '' })).error, /1 až 1000/);
  const accepted = createAsistent({ url: 'https://hook.example/x', fetchImpl: async () => ({ ok: true, text: async () => 'Accepted' }) });
  assert.match((await accepted.zeptej({ dotaz: 'a' })).error, /nepřijal/);
});
