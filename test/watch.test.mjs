import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCH_EVENTS, defaultWatch, normalizeWatch, isDefaultWatch, describeWatch, WatchFilter, cameraEventAllowed, cameraEventLabel, recordSeconds }
  from '../public/watch.js';
import { LiveAnalyzer } from '../public/analyzer.js';

const at = (h, m = 0) => new Date(2026, 8, 22, h, m, 0);

/* ---------- validation ---------- */

test('bez nastavení platí výchozí: vše zapnuté, celý den, původní délky', () => {
  const w = normalizeWatch(undefined).watch;
  assert.deepEqual(w, defaultWatch());
  assert.equal(w.longlie.after, 6);
  assert.equal(w.missing.after, 2);
  assert.ok(WATCH_EVENTS.every((e) => w[e.kind].enabled && !w[e.kind].from));
});

test('chybějící událost dostane výchozí, neznámá se zahodí', () => {
  const r = normalizeWatch({ fall: { enabled: false }, neco: { enabled: true } });
  assert.equal(r.ok, true);
  assert.equal(r.watch.fall.enabled, false);
  assert.equal(r.watch.abrupt.enabled, true);
  assert.equal('neco' in r.watch, false);
});

test('hodiny: oboje nebo nic, HH:MM, začátek ≠ konec', () => {
  assert.equal(normalizeWatch({ fall: { from: '08:00', to: '' } }).ok, false);
  assert.equal(normalizeWatch({ fall: { from: '8:00', to: '12:00' } }).ok, false);
  assert.equal(normalizeWatch({ fall: { from: '08:00', to: '08:00' } }).ok, false);
  assert.equal(normalizeWatch({ fall: { from: '22:00', to: '06:00' } }).ok, true);
});

test('délka jen z nabídky a jen u událostí, které ji mají', () => {
  assert.equal(normalizeWatch({ longlie: { after: 300 } }).watch.longlie.after, 300);
  assert.equal(normalizeWatch({ longlie: { after: '300' } }).watch.longlie.after, 300);
  assert.equal(normalizeWatch({ longlie: { after: 7 } }).ok, false);
  assert.equal('after' in normalizeWatch({ fall: { after: 300 } }).watch.fall, false);
});

test('nesmyslný vstup se odmítne', () => {
  assert.equal(normalizeWatch('text').ok, false);
  assert.equal(normalizeWatch([]).ok, false);
  assert.equal(normalizeWatch({ fall: 'ano' }).ok, false);
});

test('výchozí nastavení se pozná i po úpravě zpět', () => {
  assert.equal(isDefaultWatch(defaultWatch()), true);
  assert.equal(isDefaultWatch({ state: { enabled: false } }), false);
});

test('popis pro kartu kamery', () => {
  const w = normalizeWatch({ state: { enabled: false }, abrupt: { enabled: false },
    longlie: { after: 300, from: '08:00', to: '20:00' } }).watch;
  assert.equal(describeWatch(w), 'Pád · Dlouhé ležení déle než 5 min (08:00–20:00) · Odchod ze záběru');
  const none = Object.fromEntries(WATCH_EVENTS.map((e) => [e.kind, { enabled: false }]));
  assert.match(describeWatch(normalizeWatch(none).watch), /nic/);
});

/* ---------- filtering ---------- */

test('vypnutá událost neprojde, zapnutá ano', () => {
  const f = new WatchFilter({ state: { enabled: false } });
  assert.equal(f.accept({ kind: 'state' }, at(10)), false);
  assert.equal(f.accept({ kind: 'fall' }, at(10)), true);
});

test('hodiny platí i přes půlnoc', () => {
  // ležení hlásit jen přes den; pád pořád
  const f = new WatchFilter({ longlie: { from: '07:00', to: '21:00' } });
  assert.equal(f.accept({ kind: 'longlie' }, at(12)), true);
  assert.equal(f.accept({ kind: 'longlie' }, at(23)), false);
  assert.equal(f.accept({ kind: 'fall' }, at(23)), true);
  const night = new WatchFilter({ missing: { from: '22:00', to: '06:00' } });
  assert.equal(night.accept({ kind: 'missing' }, at(23)), true);
  assert.equal(night.accept({ kind: 'missing' }, at(3)), true);
  assert.equal(night.accept({ kind: 'missing' }, at(12)), false);
});

test('návrat do záběru jen po nahlášeném odchodu', () => {
  const f = new WatchFilter({ missing: { from: '22:00', to: '06:00' } });
  f.accept({ kind: 'missing' }, at(12));                  // not reported
  assert.equal(f.accept({ kind: 'found' }, at(12)), false);
  f.accept({ kind: 'missing' }, at(23));                  // reported
  assert.equal(f.accept({ kind: 'found' }, at(23)), true);
  assert.equal(f.accept({ kind: 'found' }, at(23)), false, 'jen jednou');
});

test('události mimo katalog (výpadek spojení) projdou vždy', () => {
  const none = Object.fromEntries(WATCH_EVENTS.map((e) => [e.kind, { enabled: false }]));
  assert.equal(new WatchFilter(none).accept({ level: 'warn', text: 'Obraz se zastavil' }), true);
});

/* ---------- the detector honours the durations ---------- */

// A person lying low and flat across the frame.
function lying() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.8, visibility: 0.9 }));
  lm[11] = lm[12] = { x: 0.3, y: 0.8, visibility: 0.9 };   // shoulders
  lm[23] = lm[24] = { x: 0.55, y: 0.8, visibility: 0.9 };  // hips
  lm[27] = lm[28] = { x: 0.8, y: 0.82, visibility: 0.9 };  // ankles
  return lm;
}

function run(options, frames) {
  const events = [];
  const a = new LiveAnalyzer((e) => events.push(e), options);
  for (const [t, lm] of frames) a.push(t, lm);
  return events;
}

const seconds = (n, lm) => Array.from({ length: n * 10 + 1 }, (_, i) => [i / 10, lm]);

test('dlouhé ležení až po nastavené době', () => {
  const at6 = run(undefined, seconds(40, lying())).find((e) => e.kind === 'longlie');
  assert.ok(at6 && at6.t >= 6 && at6.t < 7, `výchozích 6 s (${at6?.t})`);
  const at30 = run({ longLieS: 30 }, seconds(40, lying())).find((e) => e.kind === 'longlie');
  assert.ok(at30 && at30.t >= 30 && at30.t < 31, `nastavených 30 s (${at30?.t})`);
  assert.equal(run({ longLieS: 60 }, seconds(40, lying())).some((e) => e.kind === 'longlie'), false);
});

test('odchod ze záběru až po nastavené době', () => {
  const t2 = run(undefined, seconds(20, null)).find((e) => e.kind === 'missing');
  assert.ok(t2 && t2.t >= 2 && t2.t < 3);
  const t10 = run({ missingS: 10 }, seconds(20, null)).find((e) => e.kind === 'missing');
  assert.ok(t10 && t10.t >= 10 && t10.t < 11);
});

test('delší ležení se hlásí v minutách', () => {
  const e = run({ longLieS: 120 }, seconds(130, lying())).find((x) => x.kind === 'longlie');
  assert.match(e.text, /přibližně 2 min\./);
});

/* ---------- co hlásí kamera sama ---------- */

test('události kamery: bez nastavení jsou zapnuté; výchozí se neukládá, změna ano', () => {
  const r = normalizeWatch({ 'cam-motion': { enabled: true }, 'cam-person': { enabled: false }, 'cam-pet': { from: '22:00', to: '06:00' } });
  assert.equal(r.ok, true);
  assert.equal('cam-motion' in r.watch, false, 'zapnuté bez hodin je výchozí');
  assert.deepEqual(r.watch['cam-person'], { enabled: false, from: '', to: '', record: false });
  assert.deepEqual(r.watch['cam-pet'], { enabled: true, from: '22:00', to: '06:00', record: false });
  assert.equal(isDefaultWatch({ 'cam-motion': { enabled: true } }), true);
  assert.equal(isDefaultWatch({ 'cam-motion': { enabled: false } }), false);
  // A camera-declared kind outside the catalogue is kept too; junk is not.
  assert.equal('cam-babycry' in normalizeWatch({ 'cam-babycry': { enabled: false } }).watch, true);
  assert.equal('cam-Špatně' in normalizeWatch({ 'cam-Špatně': { enabled: false } }).watch, false);
  assert.equal(normalizeWatch({ 'cam-motion': { from: '22:00', to: '' } }).ok, false);
  assert.match(normalizeWatch({ 'cam-motion': { from: '22:00', to: '' } }).error, /^Pohyb:/);
});

test('události kamery: filtr podle nastavení a hodin', () => {
  const w = normalizeWatch({ 'cam-person': { enabled: false }, 'cam-motion': { from: '22:00', to: '06:00' } }).watch;
  assert.equal(cameraEventAllowed(w, 'cam-person', at(12)), false);
  assert.equal(cameraEventAllowed(w, 'cam-motion', at(12)), false);
  assert.equal(cameraEventAllowed(w, 'cam-motion', at(23)), true);
  assert.equal(cameraEventAllowed(w, 'cam-motion', at(5, 59)), true);
  assert.equal(cameraEventAllowed(w, 'cam-tamper', at(12)), true, 'bez nastavení ano');
  assert.equal(cameraEventAllowed(undefined, 'cam-tamper', at(12)), true);
});

test('popis karty jmenuje i to, co hlásí kamera', () => {
  const umi = [{ kind: 'cam-motion' }, { kind: 'cam-person' }, { kind: 'cam-babycry', label: 'BabyCry (hlásí kamera)' }];
  const w = normalizeWatch({ 'cam-person': { enabled: false }, 'cam-motion': { from: '22:00', to: '06:00' } }).watch;
  const d = describeWatch(w, umi);
  assert.match(d, /kamera hlásí: pohyb \(22:00–06:00\), babycry \(hlásí kamera\)$/);
  assert.doesNotMatch(d, /osoba/);
  assert.doesNotMatch(describeWatch(w, []), /kamera hlásí/);
  assert.equal(cameraEventLabel('cam-tamper'), 'Zakrytí nebo posunutí kamery');
  assert.equal(cameraEventLabel('cam-babycry', 'BabyCry (hlásí kamera)'), 'BabyCry (hlásí kamera)');
  assert.equal(cameraEventLabel('cam-neco'), 'neco');
});

/* ---------- nahrávání po události ---------- */

test('nahrávat po události: zatržítko u každé události, délka 5–30 s pro kameru', () => {
  const d = defaultWatch();
  assert.equal(d.recordS, 15);
  assert.equal(d.fall.record, false);
  const r = normalizeWatch({ fall: { record: true }, 'cam-linecross': { record: true }, recordS: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.watch.fall.record, true);
  assert.equal(r.watch.recordS, 20);
  assert.deepEqual(r.watch['cam-linecross'], { enabled: true, from: '', to: '', record: true }, 'kamera: nahrávat se uloží i bez hodin');
  assert.equal(recordSeconds(r.watch, 'fall'), 20);
  assert.equal(recordSeconds(r.watch, 'cam-linecross'), 20);
  assert.equal(recordSeconds(r.watch, 'abrupt'), 0);
  assert.equal(recordSeconds(undefined, 'fall'), 0);
  assert.equal(normalizeWatch({ recordS: 31 }).ok, false);
  assert.equal(normalizeWatch({ recordS: 4 }).ok, false);
  assert.equal(normalizeWatch({ recordS: 7.5 }).ok, false);
  assert.equal(normalizeWatch({ recordS: '10' }).watch.recordS, 10);
  assert.equal(isDefaultWatch({ recordS: 15 }), true);
  assert.equal(isDefaultWatch({ fall: { record: true } }), false);
  assert.match(describeWatch(r.watch, [{ kind: 'cam-linecross' }]), /nahrává 20 s při: pád, překročení čáry$/);
  assert.doesNotMatch(describeWatch(defaultWatch()), /nahrává/);
});
