// node --test tests/payments_read_from_rows.test.js
//
// Migration 210 + campistry_me.js: phase 2a of taking payments off the camp
// document. Everything that READS payments reads the rows.
//
// WHY THIS IS A SEPARATE PHASE, AND WHY IT SHIPS FIRST. The goal is 2b — the
// writers stop rewriting the whole document and the camp-wide FOR UPDATE lock
// goes. The moment a writer stops appending to finance.payments, that array is
// stale. campistry_me.js reads it, and every Billing screen reads what that
// produced. So readers must move while the array is still correct; the other
// order shows the office a ledger frozen at the deploy, with no error at all.
//
// Behaviour is unchanged by this phase — 208's verifier proved the two homes
// hold the same payments (22 camps inSync, collected money equal to the cent).
// What changes is which one is load-bearing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/210_payments_read_from_rows.sql');
const ME = read('campistry_me.js');

function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

function fnBody(name) {
    const a = SQL.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in the migration');
    const end = SQL.indexOf('\n$$;', a);
    assert.ok(end > a, name + ' body is not terminated');
    return codeOnly(SQL.slice(a, end));
}

/** campistry_me.js with // and /* *​/ comments stripped. */
function jsCode(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
}
const MECODE = jsCode(ME);

test('the JS comment stripper actually strips, and keeps code', () => {
    assert.strictEqual(jsCode('// gone\nkept();').trim(), 'kept();');
    assert.match(jsCode('/* gone */ kept();'), /kept\(\);/);
    assert.match(jsCode('  // gone\n  kept();'), /kept\(\);/);
});

// ── the parent's slice ─────────────────────────────────────────────────────
test('the slice reads camp_payments, not 205s projection', () => {
    const body = fnBody('parent_billing_slice');
    assert.match(body, /FROM public\.camp_payments/, 'the new home');
    assert.doesNotMatch(body, /FROM public\.camp_billing_payments/,
        'the projection of the array is what this phase stops reading');
    assert.match(body, /jsonb_agg\(payload ORDER BY ordinal\)/,
        'ordinal is the array order; seq was the projection column');
});

test('the slice keeps all four match predicates, unchanged', () => {
    const body = fnBody('parent_billing_slice');
    // These decide WHOSE payment a row is. Dropping one silently under-credits a
    // family; loosening one shows them somebody else's money.
    assert.match(body, /family_name = ANY \(v_names\)/);
    assert.match(body, /enrollment_id <> '' AND enrollment_id = ANY \(v_enrIds\)/);
    assert.match(body, /family_key <> '' AND family_key = ANY \(v_famKeys\)/);
    assert.match(body, /family_name <> '' AND family_name = ANY \(v_famNames\)/);
});

test('the slice still returns the same five keys, in the blobs shape', () => {
    const body = fnBody('parent_billing_slice');
    for (const k of ['enrollments', 'families', 'finance', 'sessions', 'enrollSettings']) {
        assert.ok(body.includes("'" + k + "'"), k + ' is missing from the returned shape');
    }
    assert.match(body, /'finance',\s*jsonb_build_object\('payments', v_pays\)/,
        'payments stay nested under finance, or every consumer breaks');
});

test('enrollments and families are untouched by this phase', () => {
    const body = fnBody('parent_billing_slice');
    assert.match(body, /FROM public\.camp_billing_enrollments/, 'still 205s projection');
    assert.match(body, /FROM public\.camp_billing_families/, 'still 205s projection');
});

// ── the office's read ──────────────────────────────────────────────────────
test('the office read is gated on me.billing, not me.finance', () => {
    const body = fnBody('get_camp_payments');
    assert.match(body, /user_section_level\(p_camp_id, 'me\.billing'\) = 'none'/,
        'the ledger was deliberately left in campistryMe so billing:edit + finance:none can see it');
    assert.doesNotMatch(body, /'me\.finance'/,
        'gating on finance would take the ledger from the bookkeeper role that works on it');
});

test('the office read refuses an unauthenticated or camp-less call', () => {
    const body = fnBody('get_camp_payments');
    assert.match(body, /IF auth\.uid\(\) IS NULL THEN/);
    assert.match(body, /'not_authenticated'/);
    assert.match(body, /IF p_camp_id IS NULL THEN/);
    assert.match(body, /'missing_camp'/);
});

test('the office read returns array order and an empty array, never null', () => {
    const body = fnBody('get_camp_payments');
    assert.match(body, /jsonb_agg\(payload ORDER BY ordinal\)/);
    assert.match(body, /COALESCE\(v_pays, '\[\]'::jsonb\)/,
        'null would blank a ledger; [] is a camp with no payments');
    assert.match(body, /'count'/, 'so a caller can tell empty from unavailable');
});

test('the office read is STABLE and definer-scoped to one camp', () => {
    const body = fnBody('get_camp_payments');
    assert.match(body, /STABLE/);
    assert.match(body, /SECURITY DEFINER/, 'the table is deny-all');
    assert.match(body, /SET search_path = public, pg_catalog/);
    assert.match(body, /WHERE camp_id = p_camp_id/, 'never more than the one camp');
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.get_camp_payments\(uuid\) FROM public, anon;/);
    assert.match(CODE, /GRANT EXECUTE ON FUNCTION public\.get_camp_payments\(uuid\) TO authenticated, service_role;/);
});

// ── the swap's own verifier ────────────────────────────────────────────────
test('the swap verifier compares the two homes content AND money', () => {
    const body = fnBody('verify_payments_read_swap');
    assert.match(body, /'sameOrderAndContent'/);
    assert.match(body, /'collectedOld'/);
    assert.match(body, /'collectedNew'/);
    const excl = body.match(/NOT IN \('pending', 'failed'\)/g) || [];
    assert.strictEqual(excl.length, 2, 'the same exclusion on both sides, or the sums mean nothing');
});

test('the swap verifier survives 205s projection being dropped later', () => {
    const body = fnBody('verify_payments_read_swap');
    assert.match(body, /to_regclass\('public\.camp_billing_payments'\) IS NOT NULL/,
        'phase 2b retires it; a hard reference would make this verifier throw afterwards');
    assert.match(body, /'comparable'/, 'and says so rather than reporting a false mismatch');
    assert.match(body, /EXECUTE 'SELECT/,
        'the old table is read dynamically, so this function compiles once it is gone');
});

test('the swap verifier works from the SQL Editor, which carries no JWT', () => {
    const body = fnBody('verify_payments_read_swap');
    assert.match(body, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/);
    assert.match(body, /IF v_claims IS NOT NULL/);
    assert.doesNotMatch(body, /current_user|session_user/,
        'inside SECURITY DEFINER those are the owner for every caller alike');
});

// ── no writer moves in this phase ──────────────────────────────────────────
test('210 touches no writer and removes no lock', () => {
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(append_camp_payment|record_autopay_charge|record_autopay_installment|record_external_refund|record_chargeback|settle_shop_order|sync_family_ledger_payments)\b/,
        'the writers are phase 2b');
    assert.doesNotMatch(CODE, /FOR UPDATE/);
    assert.doesNotMatch(CODE, /UPDATE camp_state_kv|INSERT INTO camp_state_kv/,
        'this phase writes nothing at all');
});

test('205s projection and trigger are left alive for a rollback', () => {
    assert.doesNotMatch(CODE, /DROP TABLE[\s\S]{0,60}camp_billing_payments/);
    assert.doesNotMatch(CODE, /DROP TRIGGER[\s\S]{0,60}trg_project_camp_billing/);
});

test('exactly three functions are defined, and the file announces itself', () => {
    const names = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)/g)].map(m => m[1]);
    assert.deepStrictEqual(names.sort(),
        ['get_camp_payments', 'parent_billing_slice', 'verify_payments_read_swap']);
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'),
        'a migration that ends on a comment prints nothing on success');
    assert.match(SQL, /SELECT 'migration 210 applied'\s+AS status/);
    assert.match(SQL, /AS slice_reads_rows/,
        'the confirmation proves the slice was really replaced, not merely re-created');
});

test('the preflight names the files that must come first', () => {
    const body = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    assert.match(body, /208_payments_into_rows\.sql/);
    assert.match(body, /205_parent_balance_off_the_blob\.sql/);
    assert.match(body, /159_access_registry_tables\.sql/, 'user_section_level comes from there');
});

// ── the client half ────────────────────────────────────────────────────────
test('loadData prefers the rows over the array', () => {
    assert.match(MECODE, /finPayments=_paymentsFromRows\|\|\(me\.finance&&me\.finance\.payments\)\|\|fin\.payments\|\|\[\]/,
        'the rows must come first, or 2b freezes the ledger silently');
});

test('the loader is fired from hydration, not awaited', () => {
    // Hydration must not block on a network call — the same rule _drainApplications
    // follows, immediately above it.
    assert.match(MECODE, /try\{ _loadPaymentsFromRows\(\); \}catch\(_\)\{\}/);
    const drain = MECODE.indexOf('_drainApplications();');
    const pay = MECODE.indexOf('_loadPaymentsFromRows();');
    assert.ok(drain > 0 && pay > drain, 'it sits with the other row-backed load');
});

test('null means "not heard from", so a failed call cannot blank the ledger', () => {
    assert.match(MECODE, /var _paymentsFromRows=null;/);
    const a = MECODE.indexOf('async function _loadPaymentsFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryPayments', a));
    // Every early return must leave the cache alone.
    assert.match(body, /if\(res&&res\.error\)\{[\s\S]*?return;/,
        'an unavailable RPC returns without touching the cache');
    assert.match(body, /if\(!d\|\|d\.success===false\|\|!Array\.isArray\(d\.payments\)\)return;/,
        'a malformed answer returns without touching the cache');
    assert.ok(body.indexOf('_paymentsFromRows=d.payments') >
              body.indexOf('!Array.isArray(d.payments)'),
        'the cache is only set AFTER the answer is known to be an array');
    assert.doesNotMatch(body, /_paymentsFromRows=\[\]/,
        'an empty array from a failure would blank a real ledger');
});

test('a camp without 210, or a user without me.billing, degrades quietly', () => {
    const a = MECODE.indexOf('async function _loadPaymentsFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryPayments', a));
    assert.match(body, /console\.log\('\[Me\] payment rows unavailable:'/,
        'not an alert: the array still has everything it had before');
    assert.match(body, /catch\(e\)\{/, 'and a thrown error cannot break hydration');
});

test('it re-renders only when the ledger actually changed', () => {
    const a = MECODE.indexOf('async function _loadPaymentsFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryPayments', a));
    assert.match(body, /var before=JSON\.stringify\(finPayments\|\|\[\]\);/);
    assert.match(body, /if\(JSON\.stringify\(finPayments\|\|\[\]\)!==before\)\{/,
        'before 2b the two homes agree, so Billing must not flicker on every load');
    assert.match(body, /if\(typeof loadData==='function'\)loadData\(\);/,
        'consumers pick the rows up through the one hydration path');
});

test('a writer can pull the ledger forward without a page reload', () => {
    assert.match(MECODE, /window\.reloadCampistryPayments=_loadPaymentsFromRows;/);
});

test('the page ships on a fresh cache-bust', () => {
    const html = read('campistry_me.html');
    const v = (html.match(/campistry_me\.js\?v=([0-9A-Za-z-]+)/) || [])[1];
    assert.ok(v, 'campistry_me.js is not versioned');
    assert.notStrictEqual(v, '20260918-15',
        'a new reader behind an old ?v= is a reader nobody runs');
});
