import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hodnota, nastavit, klice } from '../scripts/set-env.mjs';

const SABLONA = '# komentář\nSQL_USER=clb1_app\nSQL_PASSWORD=\nRING_HMAC_KEY=\nPORT=3111\n';

test('vyplní prázdný klíč a ostatní řádky nechá', () => {
  const t = nastavit(SABLONA, 'SQL_PASSWORD', 'a#b=c d');
  assert.equal(hodnota(t, 'SQL_PASSWORD'), 'a#b=c d');
  assert.equal(t, SABLONA.replace('SQL_PASSWORD=\n', 'SQL_PASSWORD=a#b=c d\n'));
});

test('chybějící klíč přidá na konec', () => {
  const t = nastavit('A=1\n', 'B', '2');
  assert.equal(t, 'A=1\nB=2\n');
});

test('zakomentovaný klíč se nepočítá', () => {
  assert.equal(hodnota('# SQL_PASSWORD=stare\n', 'SQL_PASSWORD'), '');
  assert.equal(nastavit('# SQL_PASSWORD=stare\n', 'SQL_PASSWORD', 'x'), '# SQL_PASSWORD=stare\nSQL_PASSWORD=x\n');
});

test('hodnota s koncem řádku neprojde', () => {
  assert.throws(() => nastavit(SABLONA, 'SQL_PASSWORD', 'a\nPORT=1'));
});

test('najdi: názvy vyplněných klíčů podle výrazu, bez hodnot a bez prázdných', () => {
  const t = 'FAMICURA_REPORTY_TOKEN=abc\nPECEDOMAPLUS_SQL_PASSWORD=\nSQL_PECEDOMAPLUS_HESLO="x"\n# PDP_SQL_PASSWORD=zak\n';
  assert.deepEqual(klice(t, 'PECEDOMAPLUS.*(PASSWORD|HESLO)|PDP_SQL_PASSWORD'), ['SQL_PECEDOMAPLUS_HESLO']);
  assert.deepEqual(klice(t, 'REPORTY_TOKEN'), ['FAMICURA_REPORTY_TOKEN']);
  assert.deepEqual(klice(t, 'NIC'), []);
});
