// node --test tests/canteen_archive_only_new.test.js
//
// Migration 206: the archive trigger stops re-archiving the whole history on
// every sale.
//
// THE REGRESSION THIS FILE PINS. 203's trigger inserted EVERY transaction in
// the blob on every write and let ON CONFLICT DO NOTHING discard the duplicates.
// Correct, and O(total transactions) per sale — one signature and one index
// probe per historical row. The archive is append-only, so it only grows, so
// every sale cost more than the one before it. Same 100 purchases, three runs:
// 84 rps → 77 rps → 26 rps, with nothing about the camp changing.
//
// 206 archives only the rows whose signature is absent from OLD's array. The
// assertions below are about the SHAPE that makes that cheap, because the
// number is not reproducible here — there is no database in this suite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/206_canteen_archive_only_new.sql');

/** The SQL with comments stripped — a claim must hold in CODE, not in prose. */
function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

function fnBody(name) {
    const a = SQL.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in the migration');
    const end = SQL.indexOf('\n$$;', a);
    assert.ok(end > a, name + ' body is not terminated');
    return codeOnly(SQL.slice(a, end));
}

// ── the diff itself ─────────────────────────────────────────────────────────
test('the insert is filtered by absence from the OLD array', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /WHERE NOT \(v_oldSigs \? n\.sig\)/,
        'without this predicate every historical row is re-inserted per sale');
    assert.match(body, /INSERT INTO public\.canteen_transactions/);
});

test('OLD sigs are gathered once, into a jsonb object, not per row', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /SELECT COALESCE\(jsonb_object_agg\(public\.canteen_tx_sig\(o\), true\), '\{\}'::jsonb\)\s*\n\s*INTO v_oldSigs/,
        'one pass over OLD, materialised before the insert');
    // A correlated NOT EXISTS over jsonb_array_elements(v_old) would be
    // re-evaluated per new row — the same O(n^2) the fix is removing.
    assert.doesNotMatch(body, /NOT EXISTS\s*\(\s*SELECT[^)]*jsonb_array_elements\(v_old\)/,
        'the old array must not be re-scanned per candidate row');
});

test('membership is a jsonb key probe, not a linear array scan', () => {
    const body = fnBody('archive_canteen_transactions');
    // `= ANY (text[])` is a linear scan per row: O(n^2) overall, which would
    // reproduce the same growth curve one layer down.
    assert.doesNotMatch(body, /=\s*ANY\s*\(\s*v_oldSigs/, 'array membership is linear per row');
    assert.doesNotMatch(body, /v_oldSigs\s+text\[\]/, 'the sig set must not be an array');
    assert.match(body, /v_oldSigs jsonb/, 'a jsonb object: key lookup is a binary search');
});

test('INSERT still archives everything — there is no OLD to diff against', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /v_old := CASE WHEN TG_OP = 'INSERT' THEN '\[\]'::jsonb/,
        "on INSERT the prior set is empty, so every row counts as new");
});

// ── what must NOT have changed ──────────────────────────────────────────────
test('ON CONFLICT DO NOTHING survives — the diff is speed, not correctness', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /ON CONFLICT \(camp_id, sig\) DO NOTHING/,
        'two writers can still race to archive the same row; the PK is what makes that safe');
});

test('the unchanged-transactions early return is intact', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /IF TG_OP <> 'INSERT'\s*\n\s*AND \(NEW\.value -> 'transactions'\) IS NOT DISTINCT FROM \(OLD\.value -> 'transactions'\) THEN\s*\n\s*RETURN NEW;/,
        'an inventory or config save must still cost one comparison');
});

test('still keyed on the fleet signature, and still 203s column list', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /public\.canteen_tx_sig\(t\) AS sig/, 'the signature is the identity');
    for (const col of ['camp_id', 'sig', 'camper', 'camper_id', 'tx_type',
                       'amount', 'tx_date', 'tx_time', 'items', 'payload']) {
        assert.ok(body.includes(col), `${col} is still written`);
    }
    assert.match(body, /COALESCE\(public\._num_or_null\(n\.tx ->> 'amount'\), 0\)/,
        'a malformed amount still costs that field its precision, not the sale');
});

test('APPEND-ONLY: the trigger still never deletes, updates or trims', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.doesNotMatch(body, /\bDELETE\b/, 'a row vanishing from the blob is the loss this table survives');
    assert.doesNotMatch(body, /\bUPDATE\b/);
    assert.doesNotMatch(body, /DO UPDATE/);
    // The cap that would silently rewrite every balance in the camp.
    assert.doesNotMatch(body, /jsonb_set\(NEW\.value/, 'the trigger must not rewrite the blob');
    assert.doesNotMatch(body, /\bLIMIT\b/, 'no truncation of the transactions array');
});

test('it replaces only the trigger function — table and sig are untouched', () => {
    assert.doesNotMatch(CODE, /CREATE TABLE/, '206 must not redefine the archive table');
    assert.doesNotMatch(CODE, /DROP TRIGGER|CREATE TRIGGER/,
        'the trigger binding from 203 still stands; only the body is replaced');
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.canteen_tx_sig/,
        'changing the signature would orphan every archived row');
    const creates = (CODE.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
    assert.strictEqual(creates, 1, 'exactly one function is replaced');
});

test('it stays SECURITY DEFINER with a pinned search_path, and re-revokes', () => {
    const body = fnBody('archive_canteen_transactions');
    assert.match(body, /SECURITY DEFINER/, "the blob's writers have no rights on the archive");
    assert.match(body, /SET search_path = public, pg_catalog/);
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.archive_canteen_transactions\(\) FROM public, anon, authenticated;/,
        'CREATE OR REPLACE does not reset grants, but a fresh install needs the revoke');
});

// ── the paste instructions, since there is no CLI ───────────────────────────
test('it is safe to re-run and says how to apply it without a CLI', () => {
    assert.doesNotMatch(CODE, /\bDROP TABLE\b/);
    assert.doesNotMatch(CODE, /\bTRUNCATE\b/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/, 'the user has no Supabase CLI');
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /,
        'never a CLI command');
});

test('the load-test cleanup is offered with the warning it needs', () => {
    assert.match(SQL, /DELETE FROM public\.canteen_transactions WHERE camper LIKE 'Load Camper %';/);
    assert.match(SQL, /Never run that against a real camp/,
        '`camper` is a display name, so the pattern could match a real child');
});

test('206 is a standalone paste, not added to the bundle', () => {
    const manifest = read('scripts/build-migration-bundle.py');
    assert.ok(!manifest.includes('206_canteen_archive_only_new'),
        'migrations 180+ are standalone files, not bundle entries');
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('206_canteen_archive_only_new'));
});
