import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jePostava, Vyhlazovac, VIDITELNOST_MIN } from '../public/analyzer.js';

/* 33 bodů MediaPipe; `vis` nastaví viditelnost vybraným bodům, ostatní zůstanou skryté. */
function postava(vis = {}, vychozi = 0.1) {
  return Array.from({ length: 33 }, (_, i) => ({ x: 0.4 + i / 100, y: 0.2 + i / 60, visibility: vis[i] ?? vychozi }));
}
const trupAKoncetiny = { 0: .9, 11: .9, 12: .9, 13: .8, 14: .8, 23: .9, 24: .9, 25: .7, 26: .7, 27: .6, 28: .6 };

test('postava: vidět trup a dost bodů', () => {
  assert.equal(jePostava(postava(trupAKoncetiny)), true);
  assert.equal(jePostava(postava({ 11: .9, 12: .9, 13: .9, 15: .9, 0: .9, 1: .9, 2: .9, 3: .9 })), true, 'jen horní polovina těla (sedí v posteli) stačí');
  assert.equal(jePostava(postava({ 23: .9, 24: .9, 25: .9, 26: .9, 27: .9, 28: .9, 29: .9, 30: .9 })), true, 'jen nohy a boky stačí');
});

test('přelud: nízká viditelnost, trup není vidět, málo bodů, žádné body', () => {
  assert.equal(jePostava(null), false);
  assert.equal(jePostava([]), false);
  assert.equal(jePostava(postava({}, 0.3)), false, 'všechno pod prahem');
  assert.equal(jePostava(postava({ 0: .9, 1: .9, 2: .9, 13: .9, 15: .9, 16: .9, 25: .9, 27: .9, 29: .9 })), false, 'hlava a končetiny bez trupu');
  assert.equal(jePostava(postava({ 11: .9, 12: .9, 23: .9, 24: .9 })), false, 'jen čtyři body trupu je málo');
  assert.equal(jePostava(postava({ 11: VIDITELNOST_MIN - .01, 12: .9, 23: .9, 24: VIDITELNOST_MIN - .01, 13: .9, 14: .9, 25: .9, 26: .9, 0: .9 })), false, 'z každého páru trupu jeden bod pod prahem');
  const mimo = postava(trupAKoncetiny).map((q) => ({ ...q, x: 3, y: -2 }));
  assert.equal(jePostava(mimo), false, 'body daleko mimo obraz se nepočítají');
});

test('vyhlazení: první bod beze změny, třes v klidu se tlumí, rychlý pohyb se neztrácí, ztráta nuluje', () => {
  const f = new Vyhlazovac();
  const lm = (x) => [{ x, y: 0.5, visibility: 1 }];
  assert.equal(f.push(lm(0.5), 0)[0].x, 0.5);
  // třes ±2 % obrazu, 12 snímků/s: výstup se hýbe výrazně méně než vstup
  let maxOdchylka = 0;
  for (let i = 1; i <= 40; i++) { const o = f.push(lm(0.5 + (i % 2 ? .02 : -.02)), i * 80); maxOdchylka = Math.max(maxOdchylka, Math.abs(o[0].x - 0.5)); }
  assert.ok(maxOdchylka < 0.012, `třes ${maxOdchylka}`);
  // skok o 30 % obrazu během jednoho snímku: po třech snímcích je model skoro u nové polohy
  let o;
  for (let i = 41; i <= 43; i++) o = f.push(lm(0.8), i * 80);
  assert.ok(o[0].x > 0.76, `po pohybu ${o[0].x}`);
  assert.equal(f.push(null, 44 * 80), null);
  assert.equal(f.push(lm(0.1), 45 * 80)[0].x, 0.1, 'po ztrátě postavy začíná od nové polohy');
  assert.equal(f.push(lm(0.1), 45 * 80 + 1)[0].visibility, 1, 'ostatní vlastnosti bodu zůstávají');
});
