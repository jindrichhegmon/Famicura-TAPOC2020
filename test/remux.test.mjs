import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRemux } from '../src/remux.mjs';
import { boxy } from '../src/zasobnik.mjs';

const maFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('převod fragmentovaného MP4 na obyčejný (faststart): moov před mdat, délka v hlavičce', { skip: !maFfmpeg && 'ffmpeg není v tomto prostředí' }, () => {
  const frag = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { maxBuffer: 50 * 1024 * 1024 });
  const typyPred = boxy(frag).map((b) => b.type);
  assert.ok(typyPred.includes('moof'), 'vstup je fragmentovaný: ' + typyPred.join(','));
  return createRemux({ log: { error() {} } })(frag).then((r) => {
    assert.equal(r.prevedeno, true);
    const typy = boxy(r.data).map((b) => b.type);
    assert.ok(!typy.includes('moof'), 'výstup bez fragmentů: ' + typy.join(','));
    assert.ok(typy.indexOf('moov') < typy.indexOf('mdat'), 'moov před mdat (faststart): ' + typy.join(','));
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-'], { input: r.data }).toString().trim();
    assert.ok(Number(d) >= 0.9 && Number(d) <= 1.3, 'délka v hlavičce ~1 s: ' + d);
  });
});

test('bez ffmpeg zůstane původní soubor a nic nespadne', async () => {
  const log = { error() {} };
  const r = await createRemux({ ffmpeg: '/neexistuje/ffmpeg', log })(Buffer.alloc(5000, 1));
  assert.equal(r.prevedeno, false); assert.equal(r.data.length, 5000);
  // podruhé se ffmpeg nezkouší (10 minut), ale výsledek je stejný
  const r2 = await createRemux({ ffmpeg: '/neexistuje/ffmpeg', log })(Buffer.alloc(10, 1)); assert.equal(r2.prevedeno, false);
});
