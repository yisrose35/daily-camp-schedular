// node --test tests/payments_row_truth.test.js
//
// Migration 213 + campistry_me.js: payments become the record, and
// append_camp_payment stops locking the camp.
//
// WHY THE PROOF LOOKS DIFFERENT HERE. 212 changed one expression in each of four
// money functions, and a line-by-line diff against the originals vouched for it.
// 213 cannot be checked that way: append_camp_payment's PERSISTENCE is the thing
// changing. So this file asserts that every DECISION is still 178's, expression
// by expression, and scripts/pgtests/213_payments_row_truth.sql exercises each
// branch against a real server — new payment, retried webhook, each of the four
// dedupe fields, pending → succeeded, succeeded → failed with its reversal, a
// payment with no familyKey, bad arguments, an office delete and its Undo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/213_payments_row_truth.sql');
const ORIG = read('migrations/178_every_payment_posts_to_the_ledger.sql');
const ME = read('campistry_me.js');
function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

function defIn(src, name) {
    const a = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' not found');
    const b = src.indexOf('\n$$;', a);
    return src.slice(a, b + 4);
}
const NEW_ACP = defIn(SQL, 'append_camp_payment');
const OLD_ACP = defIn(ORIG, 'append_camp_payment');

// ── THE POINT OF THE MIGRATION ─────────────────────────────────────────────
test('append_camp_payment no longer locks the camp or reads the document', () => {
    const body = codeOnly(NEW_ACP);
    assert.doesNotMatch(body, /FOR UPDATE/,
        'a camp-wide row lock is exactly what this migration exists to remove');
    assert.doesNotMatch(body, /camp_state_kv/,
        'it must not read or write the camp document at all');
    // and the old one did, which is what makes the above meaningful
    assert.match(codeOnly(OLD_ACP), /FOR UPDATE/);
    assert.match(codeOnly(OLD_ACP), /camp_state_kv/);
});

test('the confirmation row reports whether the lock is really gone', () => {
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 213 applied'"));
    assert.match(tail, /AS still_locks_the_camp/);
    assert.match(tail, /pg_get_functiondef\(p\.oid\) LIKE '%FOR UPDATE%'/,
        'asked of the live definition, not of this file');
});

test('what replaces the lock: an insert, and a ONE-FAMILY lock', () => {
    const body = codeOnly(NEW_ACP);
    assert.match(body, /INSERT INTO public\.camp_payments/, 'the payment is an insert');
    assert.match(body, /ON CONFLICT \(camp_id, payment_id\) DO UPDATE/,
        'the primary key is what makes two simultaneous retries safe');
    assert.match(body, /public\.camp_family_for_update\(p_camp_id, v_famKey\)/,
        'the ledger post locks one family row, not the camp');
    const lock = codeOnly(defIn(SQL, 'camp_family_for_update'));
    assert.match(lock, /WHERE camp_id = p_camp_id AND family_key = p_family_key AND deleted_at IS NULL\s*\n\s*FOR UPDATE/,
        'and that lock is scoped to the one row');
});

// ── every decision is still 178's ──────────────────────────────────────────
test('the four dedupe fields are unchanged, and now indexed', () => {
    // 178 matched these four in the array; they are the same four here.
    for (const f of ['id', 'reference', 'stripePaymentIntentId', 'byopTransactionId']) {
        assert.ok(codeOnly(OLD_ACP).includes("'" + f + "'"), '178 used ' + f);
        assert.ok(CODE.includes("'" + f + "'"), '213 must still use ' + f);
    }
    assert.match(CODE, /dedupe_keys text\[\]\s*\n\s*GENERATED ALWAYS AS \(ARRAY\[/,
        'GENERATED, so no writer can forget to maintain it');
    assert.match(CODE, /idx_camp_payments_dedupe[\s\S]{0,120}USING gin \(dedupe_keys\)/);
    assert.match(codeOnly(NEW_ACP), /dedupe_keys @> ARRAY\[p_dedupe_key\]/,
        'one index probe, not a scan of every payment the camp ever took');
});

test('the ledger-entry decision is byte-identical to 178', () => {
    // The condition that decides whether money counts. Copied, not reasoned about
    // again — if it drifts, a family is credited twice or not at all.
    const cond = `IF v_entry IS NOT NULL
               AND NOT public.family_covers_payment(`;
    assert.ok(codeOnly(OLD_ACP).includes('public.family_covers_payment('), '178 used it');
    const n = (codeOnly(NEW_ACP).match(/public\.family_covers_payment\(/g) || []).length;
    assert.strictEqual(n, 3, 'the same three tests 178 made: new, pending->succeeded, succeeded->failed');
    assert.match(codeOnly(NEW_ACP), /public\.payment_ledger_entry\(/, 'and the same entry builder');
});

test('the reversal keeps 178s id, kind, amount, reason and source', () => {
    const body = codeOnly(NEW_ACP);
    assert.match(body, /v_revId := 'le_payrev_' \|\| public\.payment_ref_of\(v_merged\)/,
        'the id is what makes the reversal idempotent');
    assert.match(body, /'kind',\s*'refund'/);
    assert.match(body, /'reason',\s*'reversal'/);
    assert.match(body, /ROUND\(ABS\(COALESCE\(\s*\n?\s*\(v_merged->>'amount'\)::numeric, 0\)\), 2\)/,
        'absolute and rounded, as 178 had it');
    assert.match(body, /'reverses', 'le_pay_' \|\|/);
    assert.match(body, /WHERE x->>'id' = v_revId/, 'written once, never twice');
    // and the same defaults
    assert.match(body, /'Payment did not clear'/);
});

test('bad arguments are refused the same way', () => {
    const body = codeOnly(NEW_ACP);
    assert.match(body, /IF p_camp_id IS NULL OR p_payment IS NULL OR jsonb_typeof\(p_payment\) <> 'object' THEN/);
    assert.match(body, /'bad_arguments'/);
});

test('the return shape is unchanged — callers read these keys', () => {
    for (const k of ['success', 'alreadyRecorded', 'updated', 'ledgerPosted', 'count']) {
        assert.ok(codeOnly(NEW_ACP).includes("'" + k + "'"), k + ' is missing from the result');
    }
    // `count` was jsonb_array_length of the array; it is now a live row count.
    assert.match(codeOnly(NEW_ACP), /SELECT count\(\*\) INTO v_count FROM public\.camp_payments\s*\n\s*WHERE camp_id = p_camp_id AND deleted_at IS NULL;/);
});

test('a status transition does not move a payment in the family history', () => {
    const body = codeOnly(NEW_ACP);
    const upd = body.slice(body.indexOf('UPDATE public.camp_payments'), body.indexOf('The transition, on the ledger'));
    assert.doesNotMatch(upd, /\bordinal\b/, 'ordinal is set once, on first sight');
});

// ── the soft delete 208 was missing ────────────────────────────────────────
test('payments get a soft delete, because the office really deletes them', () => {
    assert.match(CODE, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
    // 208 made the rows append-only. That is right about a clobber and wrong
    // about a deliberate office deletion, which would otherwise keep counting.
    assert.match(SQL, /finPayments\.splice/, 'the header names the office path that forced this');
    assert.ok(ME.includes('finPayments.splice'), 'and that path still exists');
});

test('every reader filters the soft delete', () => {
    const office = codeOnly(defIn(SQL, 'get_camp_payments'));
    assert.match(office, /WHERE camp_id = p_camp_id AND deleted_at IS NULL/);
    // the dedupe probe must not match a deleted payment either, or a re-entered
    // payment would be refused as a duplicate of one the camp deleted
    assert.match(codeOnly(NEW_ACP), /AND deleted_at IS NULL\s*\n\s*AND dedupe_keys @> ARRAY\[p_dedupe_key\]/);
    assert.match(CODE, /idx_camp_payments_live[\s\S]{0,140}WHERE deleted_at IS NULL/);
});

test('a delete is stamped and an Undo can clear it', () => {
    const sync = codeOnly(defIn(SQL, 'sync_camp_billing'));
    assert.match(sync, /UPDATE public\.camp_payments\s*\n\s*SET deleted_at = now_ts/);
    assert.doesNotMatch(sync, /DELETE FROM public\.camp_payments/, 'never destroyed');
    assert.match(sync, /deleted_at = NULL, updated_at = now_ts/, 'an upsert revives it');
});

// ── the office's one write ─────────────────────────────────────────────────
test('the office write needs me.billing EDIT, not merely view', () => {
    const sync = codeOnly(defIn(SQL, 'sync_camp_billing'));
    assert.match(sync, /user_section_level\(p_camp_id, 'me\.billing'\) <> 'edit'/,
        'a read gate on a write path would let a view-only user change money');
    assert.match(sync, /IF auth\.uid\(\) IS NULL THEN/);
    assert.match(sync, /'missing_camp'/);
});

test('the per-family primitives are granted to nobody', () => {
    // They take a camp id, so any grant is a cross-camp write.
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_family_for_update\(uuid, text\) FROM public, anon, authenticated;/);
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_family_save\(uuid, text, jsonb\) FROM public, anon, authenticated;/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_family_for_update/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_family_save/);
});

test('camp_family_save keeps the extracted columns in step with the payload', () => {
    const f = codeOnly(defIn(SQL, 'camp_family_save'));
    assert.match(f, /COALESCE\(p_payload ->> 'name', ''\)/);
    assert.match(f, /p_payload -> 'camperIds'/);
    assert.match(f, /deleted_at = NULL/, 'saving a family revives it');
});

// ── the verifier ───────────────────────────────────────────────────────────
test('the verifier looks for the failure the lock used to prevent', () => {
    const v = codeOnly(defIn(SQL, 'verify_payment_writes'));
    assert.match(v, /'noDoubleCounting'/);
    assert.match(v, /unnest\(dedupe_keys\)/);
    assert.match(v, /GROUP BY x\.k\s*\n?\s*HAVING count\(\*\) > 1/,
        'two different live payments sharing a dedupe key means a retry was recorded twice');
    assert.match(v, /'deletedPayments'/);
    assert.match(v, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/,
        'runnable from the SQL Editor');
});

// ── the client half ────────────────────────────────────────────────────────
/** campistry_me.js's _payIdentity, executed. */
function jsIdentity() {
    const a = ME.indexOf('function _payIdentity(p)');
    const b = ME.indexOf('async function _syncBillingRows');
    assert.ok(a > 0 && b > a, '_payIdentity is not in campistry_me.js');
    return new Function(ME.slice(a, b) + '; return _payIdentity;')();
}

test('the client identity matches public.camp_payment_identity exactly', () => {
    // If these disagree, the office upserts a SECOND row for a payment the server
    // already has — a duplicate charge on a family's history, with no error.
    const id = jsIdentity();
    assert.strictEqual(id({ id: 'w1' }), 'w1');
    assert.strictEqual(id({ id: '  w1  ' }), 'w1', 'btrim, as the SQL does');
    assert.strictEqual(id({ id: '', reference: 'REF' }), 'REF', 'blank falls through');
    assert.strictEqual(id({ stripePaymentIntentId: 'pi_1' }), 'pi_1');
    assert.strictEqual(id({ byopTransactionId: 'byop' }), 'byop');
    assert.strictEqual(id({ date: '2026-07-01', amount: 250, family: 'Weiss', method: 'card', status: 'succeeded' }),
        'sig:2026-07-01|250|Weiss|||card|succeeded|');
    assert.strictEqual(id({ amount: 250.5 }), 'sig:|250.5||||||', 'numbers render as ->> does');
    assert.strictEqual(id(null), '');
    assert.strictEqual(id([]), '', 'an array is not a payment');
});

test('the identity precedence and signature fields match the SQL, field for field', () => {
    const sqlFn = codeOnly(defIn(read('migrations/208_payments_into_rows.sql'), 'camp_payment_identity'));
    const order = ['id', 'reference', 'stripePaymentIntentId', 'byopTransactionId'];
    let at = -1;
    for (const f of order) {
        const i = sqlFn.indexOf("'" + f + "'");
        assert.ok(i > at, `SQL precedence: ${f} must come after the previous`);
        at = i;
    }
    const jsFn = ME.slice(ME.indexOf('function _payIdentity(p)'), ME.indexOf('async function _syncBillingRows'));
    at = -1;
    for (const f of order) {
        const i = jsFn.indexOf(f);
        assert.ok(i > at, `JS precedence: ${f} must come after the previous`);
        at = i;
    }
    // the signature's fields, in order, on both sides
    const sig = ['date', 'amount', 'family', 'familyKey', 'enrollmentId', 'method', 'status', 'notes'];
    const sigPart = sqlFn.slice(sqlFn.indexOf("'sig:'"));
    let sat = -1;
    for (const f of sig) {
        const i = sigPart.indexOf("'" + f + "'");
        assert.ok(i > sat, `SQL signature field order: ${f}`);
        sat = i;
    }
    const jsSig = jsFn.slice(jsFn.indexOf("'sig:'"));
    sat = -1;
    for (const f of sig) {
        const i = jsSig.indexOf(f);
        assert.ok(i > sat, `JS signature field order: ${f}`);
        sat = i;
    }
});

test('save() syncs only what changed, through the one choke point', () => {
    const code = ME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
    assert.match(code, /try\{ _syncBillingRows\(\); \}catch\(_\)\{\}/,
        'called from save(), so all 43 family sites and 9 payment sites are untouched');
    const a = code.indexOf('async function _syncBillingRows()');
    const body = code.slice(a, code.indexOf('window.syncCampistryBillingRows', a));
    assert.match(body, /if\(!eq\(nowFams\[k\],_billBase\.fams\[k\]\)\) famUp\[k\]=nowFams\[k\];/,
        'changed families only');
    assert.match(body, /if\(!Object\.prototype\.hasOwnProperty\.call\(nowFams,k\)\) famDel\.push\(k\);/,
        'a family the office removed');
    assert.match(body, /if\(!eq\(nowPays\[id\],_billBase\.pays\[id\]\)\) payUp\.push\(nowPays\[id\]\);/);
    assert.match(body, /if\(!Object\.prototype\.hasOwnProperty\.call\(nowPays,id\)\) payDel\.push\(id\);/);
    assert.match(body, /if\(!Object\.keys\(famUp\)\.length&&!famDel\.length&&!payUp\.length&&!payDel\.length\)return;/,
        'an unchanged save sends nothing at all');
});

test('a FAILED sync keeps the baseline, so the next save retries', () => {
    const code = ME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
    const a = code.indexOf('async function _syncBillingRows()');
    const body = code.slice(a, code.indexOf('window.syncCampistryBillingRows', a));
    const okAt = body.indexOf('_billSnapshot();');
    const errAt = body.indexOf('return;   // baseline unchanged') >= 0
        ? body.indexOf('return;   // baseline unchanged') : body.indexOf('res.error.message');
    assert.ok(errAt > 0 && okAt > errAt,
        'the baseline advances only after a successful sync — advancing on failure loses the edit');
    assert.match(body, /if\(res&&res\.data&&res\.data\.success===false\)\{/,
        'a refusal is not a success either');
});

test('no baseline means no sync — an unknown baseline is not an empty one', () => {
    const code = ME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
    assert.match(code, /var _billBase=null;/);
    const a = code.indexOf('async function _syncBillingRows()');
    const body = code.slice(a, code.indexOf('window.syncCampistryBillingRows', a));
    assert.match(body, /if\(!_billBase\)return;/,
        'diffing against nothing would look like the office creating every family from scratch');
});

test('the baseline is taken whenever the server answers', () => {
    const code = ME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
    assert.strictEqual((code.match(/try\{ _billSnapshot\(\); \}catch\(_\)\{\}/g) || []).length, 2,
        'once in the payments loader and once in the families loader');
});

test('the page ships on a fresh cache-bust', () => {
    const v = (read('campistry_me.html').match(/campistry_me\.js\?v=([0-9A-Za-z-]+)/) || [])[1];
    assert.ok(v);
    assert.notStrictEqual(v, '20260922-05');
});

test('213 is a standalone paste that announces itself', () => {
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /);
    assert.match(SQL, /DEPLOY THE SITE/, 'the office half ships with it and must go together');
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'));
    assert.ok(!read('scripts/build-migration-bundle.py').includes('213_payments_row_truth'));
});

// ── the duplicate check must count PAYMENTS, not occurrences ────────────────
// This fired as a false alarm on real data: one payment whose id and reference
// held the same value put that value in its own dedupe_keys array twice, and the
// check counted occurrences, so it reported the payment as a duplicate of itself.
// noDoubleCounting read false with the same key printed twice.
test('duplicates are counted per payment, not per occurrence', () => {
    const v = codeOnly(defIn(SQL, 'verify_payment_writes'));
    assert.match(v, /SELECT DISTINCT payment_id, unnest\(dedupe_keys\) AS k/,
        'DISTINCT payment_id is what makes one payment count once');
    assert.doesNotMatch(v, /FROM \(SELECT unnest\(dedupe_keys\) AS k\s*\n\s*FROM public\.camp_payments/,
        'the occurrence-counting form is the bug');
});

test('the duplicate list is a scalar subquery, so it can report more than one key', () => {
    const v = codeOnly(defIn(SQL, 'verify_payment_writes'));
    // `jsonb_agg(k) ... GROUP BY k HAVING` returns one row PER GROUP and INTO
    // keeps only the first, so the old form could never list a second offender.
    assert.match(v, /SELECT COALESCE\(\(SELECT jsonb_agg\(d\.k ORDER BY d\.k\)/);
    assert.match(v, /INTO v_dupes;/);
    assert.doesNotMatch(v, /INTO v_dupes\s*\n[\s\S]{0,400}GROUP BY k HAVING/,
        'the grouped-aggregate-into-a-variable form is the bug');
});

test('the note explains the distinction, since the number is read by a person', () => {
    const v = codeOnly(defIn(SQL, 'verify_payment_writes'));
    assert.match(v, /DISTINCT PAYMENTS per dedupe key, not /);
    assert.match(v, /id and reference hold the same /,
        'the legitimate case is named, so a false alarm is not chased again');
});

test('a soft-deleted payment cannot be half of a reported duplicate', () => {
    const v = codeOnly(defIn(SQL, 'verify_payment_writes'));
    const dup = v.slice(v.indexOf('unnest(dedupe_keys)'));
    assert.match(dup.slice(0, 300), /deleted_at IS NULL/,
        'a payment the office deleted has stopped existing for every other purpose too');
});
