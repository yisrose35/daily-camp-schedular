// node --test tests/payments_into_rows.test.js
//
// Migration 208, phase 1 of taking payments off the whole-camp document.
//
// WHAT IS BEING MOVED AND WHY. A camp's payments live in one jsonb array inside
// one row. Sixteen functions take SELECT ... FOR UPDATE on that row, read the
// whole document, edit it and write it all back. So every payment in a camp
// serializes behind every other payment, and each one costs in proportion to
// the whole camp rather than to the payment. Measured precedent: reading that
// document took 3575ms per parent at 32 concurrent parents before 205 narrowed
// it. Writing is more expensive and serializes on top.
//
// PHASE 1 CHANGES NO BEHAVIOUR ON PURPOSE. It adds the new home and a trigger
// that keeps it true, and a verifier to prove on live data that the rows say
// what the array says. Nothing reads the rows yet, no writer is touched, and
// the lock is still there. That is what makes the paste safe mid-season and
// what earns the right to cut over in phase 2.
//
// THE THREE MISTAKES THIS FILE EXISTS TO PREVENT, each already made once here:
//
//   1. Rebuilding the projection from the array on every write. That is what
//      203's archive trigger did; it cost O(history) per sale on a table that
//      only grows, and canteen throughput decayed 84 → 77 → 26 per second
//      across three identical runs. 206 fixed it. This trigger diffs from day
//      one — and must keep diffing.
//   2. DELETE-then-INSERT. Phase 2 puts rows here the array will not have, so a
//      rebuild would erase real money.
//   3. Gating a verifier on camp_reader() alone. 202's verifier did, and
//      returned not_authorized to the legitimate owner, because the SQL Editor
//      carries no JWT.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/208_payments_into_rows.sql');

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

// ── the identity ───────────────────────────────────────────────────────────
test('identity prefers the four ids the app already dedupes on, in order', () => {
    const body = fnBody('camp_payment_identity');
    const order = ['id', 'reference', 'stripePaymentIntentId', 'byopTransactionId']
        .map(k => body.indexOf(`'${k}'`));
    for (const i of order) assert.ok(i > 0, 'every dedupe field is consulted');
    for (let i = 1; i < order.length; i++) {
        assert.ok(order[i] > order[i - 1], 'and in append_camp_payment\'s own precedence');
    }
    assert.match(body, /COALESCE\(\s*NULLIF\(btrim\(COALESCE\(p_pay ->> 'id', ''\)\), ''\)/,
        'blank and whitespace ids must not become the identity');
});

test('identity falls back to a deterministic signature, never a random id', () => {
    const body = fnBody('camp_payment_identity');
    assert.match(body, /'sig:' \|\| concat_ws\('\|'/,
        'legacy rows carry none of the four ids');
    assert.doesNotMatch(body, /gen_random_uuid|random\(\)|now\(\)|clock_timestamp/,
        'a non-deterministic fallback would insert a NEW row every backfill');
    assert.match(body, /IMMUTABLE/, 'must be usable in an index and trusted by three callers');
});

test('identity covers enough fields that two real payments cannot collide', () => {
    const body = fnBody('camp_payment_identity');
    for (const f of ['date', 'amount', 'family', 'familyKey', 'enrollmentId',
                     'method', 'status', 'notes']) {
        assert.ok(body.includes(`'${f}'`), `${f} is part of the signature`);
    }
});

// ── the table ──────────────────────────────────────────────────────────────
test('one row per payment, keyed on the identity', () => {
    assert.match(CODE, /CREATE TABLE IF NOT EXISTS public\.camp_payments/);
    assert.match(CODE, /PRIMARY KEY \(camp_id, payment_id\)/,
        'the identity is the key, so a retried webhook cannot double-count');
});

test('the four match columns the balance loop needs are indexed', () => {
    for (const [col, idx] of [['family_key', 'idx_camp_payments_famkey'],
                              ['family_name', 'idx_camp_payments_famname'],
                              ['enrollment_id', 'idx_camp_payments_enr']]) {
        assert.ok(CODE.includes(col), `${col} is extracted`);
        assert.match(CODE, new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}[\\s\\S]{0,120}camp_id, ${col}`),
            `${col} is indexed with camp_id leading`);
    }
    assert.match(CODE, /idx_camp_payments_order[\s\S]{0,120}\(camp_id, ordinal\)/,
        'history order per camp');
});

test('the table is deny-all, like every other money projection here', () => {
    assert.match(CODE, /ALTER TABLE public\.camp_payments ENABLE ROW LEVEL SECURITY;/);
    assert.match(CODE, /REVOKE ALL ON public\.camp_payments FROM anon, authenticated;/);
    assert.doesNotMatch(CODE, /CREATE POLICY[\s\S]{0,80}camp_payments/,
        'reads go through the gated definer functions, not a policy');
});

test('no foreign key to camps — a trigger must not abort the original save', () => {
    const t = CODE.slice(CODE.indexOf('CREATE TABLE IF NOT EXISTS public.camp_payments'));
    const decl = t.slice(0, t.indexOf(');'));
    assert.doesNotMatch(decl, /REFERENCES/,
        'migration 200 lost a whole paste to exactly this (ERROR 23503)');
});

// ── the trigger ────────────────────────────────────────────────────────────
test('the trigger upserts only what this write changed', () => {
    const body = fnBody('project_camp_payments');
    assert.match(body, /WHERE \(v_oldMap -> n\.key\) IS DISTINCT FROM n\.value/,
        'new rows AND in-place status patches, and nothing else');
    assert.match(body, /FROM jsonb_each\(v_newMap\) AS n/,
        'the candidates are the reduced map, not the raw array');
});

// The bug this test exists for was found by running the migration on a real
// Postgres, not by reading it. With p1 present twice (100, then 120), filtering
// BEFORE reducing dropped the current 120 as unchanged and let the superseded
// 100 survive to win — the row went back to 100 and the two sides disagreed by
// exactly 20. Reducing first makes the whole class impossible.
test('the trigger REDUCES both sides before it diffs them', () => {
    const body = fnBody('project_camp_payments');
    const newAt = body.indexOf('INTO v_newMap');
    const oldAt = body.indexOf('INTO v_oldMap');
    const diffAt = body.indexOf('IS DISTINCT FROM n.value');
    assert.ok(newAt > 0 && oldAt > 0 && diffAt > 0, 'all three steps are present');
    assert.ok(newAt < diffAt && oldAt < diffAt,
        'both maps must be built BEFORE the comparison, never filtered first');
    assert.doesNotMatch(body, /DISTINCT ON/,
        'reducing by key removes the need for it, and with it the ordering question');
});

test('last array position wins, by an explicit ORDER BY in the aggregate', () => {
    const body = fnBody('project_camp_payments');
    const aggs = body.match(/jsonb_object_agg\(public\.camp_payment_identity\(e\.v\), e\.v\s*\n?\s*ORDER BY e\.ord\)/g) || [];
    assert.strictEqual(aggs.length, 2,
        'both NEW and OLD reduce with an explicit order; without it "last" is whatever the scan produced');
    assert.match(body, /WITH ORDINALITY AS e\(v, ord\)/);
});

test('membership is a jsonb key probe, not a per-row array scan', () => {
    const body = fnBody('project_camp_payments');
    assert.match(body, /v_oldMap jsonb/);
    assert.match(body, /v_newMap jsonb/);
    assert.doesNotMatch(body, /=\s*ANY\s*\(\s*v_old/, 'O(n^2) rebuilds 203s growth curve');
    assert.doesNotMatch(body, /NOT EXISTS\s*\(\s*SELECT[^)]*jsonb_array_elements/,
        'neither array may be re-scanned per candidate');
});

test('the trigger MERGES and never deletes — phase 2 depends on it', () => {
    const body = fnBody('project_camp_payments');
    assert.match(body, /ON CONFLICT \(camp_id, payment_id\) DO UPDATE/,
        'a status transition must patch, not duplicate');
    assert.doesNotMatch(body, /\bDELETE\b/,
        'phase 2 writes rows the array will not have; a rebuild would erase money');
    assert.doesNotMatch(body, /TRUNCATE/);
});

test('ordinal is never updated, so a status change cannot reorder history', () => {
    const body = fnBody('project_camp_payments');
    const doUpdate = body.slice(body.indexOf('DO UPDATE'));
    assert.doesNotMatch(doUpdate, /\bordinal\b/, 'position is set once, on first sight');
    for (const col of ['family_name', 'family_key', 'enrollment_id', 'status',
                       'amount', 'pay_date', 'payload']) {
        assert.ok(doUpdate.includes(col), `${col} does follow a patch`);
    }
});

test('a save that did not touch payments costs one comparison', () => {
    const body = fnBody('project_camp_payments');
    assert.match(body, /IF TG_OP <> 'INSERT'\s*\n\s*AND \(NEW\.value -> 'finance' -> 'payments'\)\s*\n\s*IS NOT DISTINCT FROM \(OLD\.value -> 'finance' -> 'payments'\) THEN\s*\n\s*RETURN NEW;/,
        'the camp document is saved constantly for reasons unrelated to money');
});

test('the trigger fires only for campistryMe, on insert and update', () => {
    assert.match(CODE, /CREATE TRIGGER trg_project_camp_payments\s*\nAFTER INSERT OR UPDATE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(NEW\.key = 'campistryMe'\)/);
    assert.doesNotMatch(CODE, /AFTER DELETE[\s\S]{0,200}project_camp_payments/,
        'a deleted camp row does not make its payment history untrue');
});

test('duplicate identities resolve the same way in the trigger and the backfill', () => {
    const body = fnBody('project_camp_payments');
    assert.match(body, /ORDER BY e\.ord\)/, 'the trigger takes the last occurrence');
    // The backfill takes position from the first occurrence, payload from the
    // last. If it disagreed with the trigger, the verifier would report
    // staleRows on data nobody had touched.
    assert.match(CODE, /min\(p\.ord\)\s*AS first_ord/, 'position from the first');
    assert.match(CODE, /\(array_agg\(p\.value ORDER BY p\.ord DESC\)\)\[1\]\s*AS pay/,
        'payload from the last, same as the trigger');
});

// ── the backfill ───────────────────────────────────────────────────────────
test('the backfill is scoped to camps that still exist', () => {
    assert.match(CODE, /AND EXISTS \(SELECT 1 FROM camps c WHERE c\.id = kv\.camp_id\)/,
        'camp_state_kv has no FK; an orphan row killed migration 200s first paste');
});

test('the backfill preserves array order as ordinal, and is idempotent', () => {
    assert.match(CODE, /ORDER BY d\.camp_id, d\.first_ord/,
        'insertion order sets ordinal, so it must be the array order');
    assert.match(CODE, /ON CONFLICT \(camp_id, payment_id\) DO NOTHING;/,
        're-running must converge, not duplicate or clobber');
});

test('the backfill tolerates a malformed amount instead of aborting', () => {
    assert.match(CODE, /COALESCE\(public\._num_or_null\(d\.pay ->> 'amount'\), 0\)/,
        'one bad value costs that field its precision, never the paste');
});

// ── the verifier ───────────────────────────────────────────────────────────
test('the verifier works from the SQL Editor, which carries no JWT', () => {
    const body = fnBody('verify_camp_payments');
    assert.match(body, /v_claims\s+text := NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/);
    assert.match(body, /IF v_claims IS NOT NULL/,
        'no claims at all means the SQL Editor, not an intruder');
    assert.match(body, /<> 'service_role'/);
    assert.match(body, /NOT public\.camp_reader\(p_camp_id\)/, 'a real JWT is still scoped');
    assert.doesNotMatch(body, /current_user|session_user/,
        'inside SECURITY DEFINER those are the owner for everyone alike');
});

test('inSync means all three: nothing missing, nothing stale, money equal', () => {
    const body = fnBody('verify_camp_payments');
    assert.match(body, /'inSync', \(jsonb_array_length\(v_missing\) = 0\s*\n\s*AND jsonb_array_length\(v_differs\) = 0\s*\n\s*AND v_blobSum = v_rowSum\)/,
        'a count match alone would miss a wrong amount');
});

test('the verifier compares COLLECTED money, on the balance loops own rule', () => {
    const body = fnBody('verify_camp_payments');
    const matches = body.match(/NOT IN \('pending', 'failed'\)/g) || [];
    assert.strictEqual(matches.length, 2,
        'the same exclusion on both sides, or the sums cannot be compared');
});

test('the verifier reports WHICH payments are wrong, not just how many', () => {
    const body = fnBody('verify_camp_payments');
    for (const k of ['missingFromRows', 'missingIds', 'staleRows', 'staleIds',
                     'blobPayments', 'rowPayments', 'collectedInBlob', 'collectedInRows']) {
        assert.ok(body.includes(`'${k}'`), `${k} is reported`);
    }
    assert.match(body, /'repair'/, 'and says what to do about it');
});

test('the verifier reduces the array ONCE and checks against that', () => {
    const body = fnBody('verify_camp_payments');
    assert.match(body, /INTO v_dedup/, 'one reduction, shared by every check');
    assert.match(body, /jsonb_object_agg\(public\.camp_payment_identity\(e\.v\), e\.v\s*\n?\s*ORDER BY e\.ord\)/,
        'last array position wins, same rule as the trigger');
    // Comparing the RAW array against the rows reported a superseded duplicate
    // as stale: the array held p1 at 100 and again at 120, the row correctly
    // held 120, and the 100 looked wrong. Found on a real server.
    for (const m of ['v_missing', 'v_differs', 'v_blobSum']) {
        assert.ok(body.includes(m), `${m} is computed`);
    }
    assert.match(body, /WHERE r\.payload IS DISTINCT FROM \(v_dedup -> k\)/,
        'stale is measured against the reduced value, never a superseded duplicate');
    assert.match(body, /FROM jsonb_each\(v_dedup\) AS v/, 'and so is the money total');
});

test('rowPayments exceeding blobPayments is documented as expected, not a fault', () => {
    const body = fnBody('verify_camp_payments');
    assert.match(body, /rowPayments may EXCEED blobPayments/,
        'phase 2, and any stale client save that shortened the array');
    assert.match(body, /missingFromRows and staleRows are the failures/);
});

// ── phase 1 must not change behaviour ──────────────────────────────────────
test('no reader and no writer is touched — that is what makes this safe', () => {
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(append_camp_payment|record_autopay_charge|record_autopay_installment|record_external_refund|record_chargeback|settle_shop_order|sync_family_ledger_payments)\b/,
        'the writers are phase 2');
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(get_my_balance_derived|get_my_balance|parent_billing_slice)\b/,
        'the readers are phase 2');
    assert.doesNotMatch(CODE, /FOR UPDATE/, 'phase 1 adds no new lock');
    assert.doesNotMatch(CODE, /UPDATE camp_state_kv/, 'and writes nothing back to the document');
});

test('205s projection is left in place, so phase 2 has somewhere to roll back to', () => {
    assert.doesNotMatch(CODE, /DROP (TABLE|TRIGGER)[\s\S]{0,60}camp_billing_payments/);
    assert.doesNotMatch(CODE, /DROP TRIGGER IF EXISTS trg_project_camp_billing\b/);
});

test('the four functions replaced are exactly the three new ones', () => {
    const names = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)/g)].map(m => m[1]);
    assert.deepStrictEqual(names.sort(),
        ['camp_payment_identity', 'project_camp_payments', 'verify_camp_payments'],
        'nothing else in the database is redefined');
});

// ── the paste, since there is no CLI ───────────────────────────────────────
test('safe to re-run, and applied through the Dashboard', () => {
    assert.doesNotMatch(CODE, /\bDROP TABLE\b/);
    assert.doesNotMatch(CODE, /\bTRUNCATE\b/);
    assert.doesNotMatch(CODE, /\bDELETE FROM\b/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /, 'the user has no CLI');
});

test('the verify instruction passes the camp id it actually needs', () => {
    assert.match(SQL, /public\.verify_camp_payments\(c\.id\)/);
    assert.doesNotMatch(SQL, /verify_camp_payments\(\s*\)/, 'ERROR 42883, twice bitten');
});

test('207 is a standalone paste, not a bundle entry', () => {
    assert.ok(!read('scripts/build-migration-bundle.py').includes('208_payments_into_rows'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('208_payments_into_rows'));
});

// ── a paste must announce itself ───────────────────────────────────────────
// Twice, a rolled-back paste of this file was reported to me as "the verify
// function does not exist". That is the correct error for the NEXT query, and it
// points at the wrong file. A migration that ends on a comment prints nothing on
// success, so there is no way to tell "applied" from "rolled back" by looking.
test('the file ends on a statement that proves the paste committed', () => {
    const lines = SQL.trimEnd().split('\n');
    const last = lines[lines.length - 1].trim();
    assert.ok(!last.startsWith('--'), 'the last line is a comment: a successful paste prints nothing');
    assert.ok(last.endsWith(';'), 'the last statement is not terminated');
    assert.match(SQL, /SELECT 'migration 208 applied'\s+AS status/);
});

test('the confirmation reports each thing the migration was supposed to create', () => {
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 208 applied'"));
    assert.match(tail, /to_regprocedure\('public\.verify_camp_payments\(uuid\)'\) IS NOT NULL/,
        'the exact signature the next query calls');
    assert.match(tail, /to_regprocedure\('public\.camp_payment_identity\(jsonb\)'\) IS NOT NULL/);
    assert.match(tail, /tgname = 'trg_project_camp_payments' AND NOT tgisinternal/,
        'a table and functions without the trigger would keep nothing true');
    assert.match(tail, /FROM public\.camp_payments\)\s+AS payment_rows/,
        'and how much the backfill actually moved');
});

test('the preflight names the file to apply, and uses no escape-string literal', () => {
    const body = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    assert.match(body, /203_canteen_archive\.sql/, 'says which migration supplies _num_or_null');
    assert.match(body, /183_lock_down_camp_scoped_readers\.sql/, 'and which supplies camp_reader');
    assert.doesNotMatch(body, /RAISE EXCEPTION E'/,
        "a backslash-escaped literal is what a failed paste PRINTS — keep it plain");
    // text[] || 'literal' makes Postgres parse the string AS AN ARRAY. Found by
    // running the migration, not by reading it.
    const appends = body.match(/v_missing := v_missing \|\| '(?:[^']|'')*'::text;/g) || [];
    assert.strictEqual(appends.length, 5, 'every append is explicitly cast to text');
});
