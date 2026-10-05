import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, countLiterals } from '../../tools/check-country-literals.mjs';
import { pendingChanges, rewrite, sqlUp, sqlDown, COLUMN_RENAMES } from '../../tools/codemods/idr-to-minor.mjs';

/**
 * Guards of the multi-country work (docs/MULTI-COUNTRY-DESIGN.md §7, WP1b): no new
 * Indonesian literal outside the places allowed to know Indonesia, and the money
 * rename stays complete (the codemod finds nothing left to rename).
 */

test('no new country literals (IDR, Asia/Jakarta, id-ID, "Rp ", +62) outside domain/ and the Indonesian modules', () => {
  assert.deepEqual(check(), []);
  assert.equal(countLiterals("// Rp 1,000 in a comment\nconst x = 'IDR';\n * Asia/Jakarta in a doc comment"), 1);
});

test('the *_idr → *_minor rename is complete and the codemod is idempotent', () => {
  assert.deepEqual(pendingChanges(), []);
  const r = rewrite('SELECT total_idr, ppn_dpp_idr FROM cdr; const { amountIdr, ppnIdr, taxIdr, estimateQrisMdrIdr } = x;');
  assert.equal(r.text, 'SELECT total_minor, tax_base_minor FROM cdr; const { amountMinor, taxMinor, taxTotalMinor, estimateQrisMdrIdr } = x;');
  assert.equal(rewrite(r.text).changed, false);
});

test('migration 060 renames exactly the 61 *_idr columns and the three rate columns; the rollback inverts it', () => {
  assert.equal(COLUMN_RENAMES.filter(([, a]) => a.endsWith('_idr') || a.includes('_idr_')).length, 61);
  assert.equal(COLUMN_RENAMES.length, 64);
  for (const [t, a, b] of COLUMN_RENAMES) {
    assert.ok(sqlUp().includes(`ARRAY['${t}', '${a}', '${b}']`));
    assert.ok(sqlDown().includes(`ARRAY['${t}', '${b}', '${a}']`));
  }
});
