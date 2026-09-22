// node --test tests/payment_family_writers.test.js
//
// Migration 215: the last seven writers — the ones that touch payments AND
// families — come off the camp-wide lock. After it, nothing in the schema holds
// SELECT ... FOR UPDATE on camp_state_kv(campistryMe).
//
// FIVE BY RULE, TWO BY HAND. The five are diffed against the migration that last
// defined them, as 214's were. The two written out by hand have no diff to vouch
// for them, so their proof is in scripts/pgtests/215_payment_family_writers.sql —
// and that is not a formality: the first pass of record_chargeback missed a read
// and returned family_not_found for EVERY chargeback. A diff could not have
// caught it, because the missed line was unchanged and therefore looked right.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/215_payment_family_writers.sql');
const codeOnly = s => s.replace(/--[^\n]*/g, ' ');
const CODE = codeOnly(SQL);

const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+_.*\.sql$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));

/** The newest definition BEFORE 215 — resolved, never hardcoded. */
function sourceOf(name) {
    let found = null;
    for (const f of MIGRATIONS) {
        if (parseInt(f) >= 215) continue;
        if (read('migrations/' + f).includes('CREATE OR REPLACE FUNCTION public.' + name)) found = f;
    }
    assert.ok(found, name + ' has no definition before 215 to diff against');
    return 'migrations/' + found;
}

function defIn(src, name) {
    const a = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' not found');
    const b = src.indexOf('\n$$;', a);
    return src.slice(a, b + 4);
}

function lineDiff(orig, now) {
    const count = a => { const m = new Map(); for (const l of a) m.set(l, (m.get(l) || 0) + 1); return m; };
    const co = count(orig.split('\n')), cn = count(now.split('\n'));
    const removed = [], added = [];
    for (const [l, c] of co) for (let i = 0; i < c - (cn.get(l) || 0); i++) removed.push(l);
    for (const [l, c] of cn) for (let i = 0; i < c - (co.get(l) || 0); i++) added.push(l);
    return { added, removed };
}

const BY_RULE = ['record_autopay_charge', 'record_autopay_installment',
                 'record_external_refund', 'sync_family_ledger_payments',
                 'convert_family_ledgers'];
const BY_HAND = ['record_chargeback', 'set_my_payment_plan'];
const ALL = [...BY_RULE, ...BY_HAND];

const ALLOWED_REMOVED = [
    /camp_state_kv/, /FOR UPDATE/, /ON CONFLICT \(camp_id, key\) DO NOTHING;/,
    /^\s*SET value = \w+/, /^\s*WHERE camp_id = [\w.]+ AND key = 'campistryMe';?$/,
    /^\s*AND key = 'campistryMe';?$/, /^\s*VALUES \([\w.]+, 'campistryMe'/,
    /families/, /payments/, /'\{finance\}'/, /^\s*\w+ := jsonb_set\(\w+, ARRAY\[rec\.key\], \w+(?:, true)?\);$/,
    // P2 collapses a MULTI-LINE append into one call, so its continuation lines go
    /^\s*v_pays \|\| jsonb_build_array\(p_payment\)(?:, true)?\);$/,
    /^\s*jsonb_build_object\($/,
    // ...and its closing line, where the built object's last field meets the
    // old array-append syntax. The object itself is asserted field-for-field by
    // the diff: every one of its lines is common to both sides.
    /^\s*'timestamp', \(extract\(epoch from now_ts\) \* 1000\)::bigint\)\), true\);$/,
];
const ALLOWED_ADDED = [
    /camp_families_object\(/, /camp_family_for_update\(/, /camp_family_save\(/,
    /camp_payments_array\(/, /camp_payment_add\(/, /camp_payments/,
    /^\s*SELECT value INTO \w+ FROM camp_state_kv WHERE camp_id = [\w.]+ AND key = 'campistryMe';$/,
    /^\s*SELECT value INTO \w+$/, /^\s*FROM camp_state_kv$/,
    /^\s*WHERE camp_id = [\w.]+ AND key = 'campistryMe';?$/,
    /^\s*AND key = 'campistryMe';?$/,
    // P2's folded call closes with fewer parens than the old array append, so the
    // built object's LAST line differs by punctuation only. Every other line of
    // that object is common to both sides, which is what proves it transferred
    // field for field.
    /^\s*'timestamp', \(extract\(epoch from now_ts\) \* 1000\)::bigint\)\);$/,
];

test('the diff helper works and is silent on identity', () => {
    assert.deepStrictEqual(lineDiff('a\nb', 'a\nX'), { added: ['X'], removed: ['b'] });
    assert.deepStrictEqual(lineDiff('a', 'a'), { added: [], removed: [] });
});

for (const fn of BY_RULE) {
    test(`${fn}: only the rules' lines changed`, () => {
        const { added, removed } = lineDiff(defIn(read(sourceOf(fn)), fn), defIn(SQL, fn));
        assert.deepStrictEqual(
            removed.filter(l => l.trim() && !ALLOWED_REMOVED.some(r => r.test(l))), [],
            `${fn}: lines REMOVED from a money function that no rule explains`);
        assert.deepStrictEqual(
            added.filter(l => l.trim() && !l.trim().startsWith('--') && !ALLOWED_ADDED.some(r => r.test(l))), [],
            `${fn}: lines ADDED to a money function that no rule explains`);
    });
}

for (const fn of ALL) {
    test(`${fn}: signature, LANGUAGE and SECURITY untouched`, () => {
        const head = s => s.slice(0, s.indexOf('AS $$'));
        assert.strictEqual(head(defIn(SQL, fn)), head(defIn(read(sourceOf(fn)), fn)),
            `${fn}: changing DEFINER or the arguments is a security change, not a refactor`);
    });

    // A diff cannot catch a function that was never transformed — the body would
    // be identical to the original and the diff empty. So assert positively.
    test(`${fn}: is on the rows, for families AND payments`, () => {
        const body = codeOnly(defIn(SQL, fn));
        assert.doesNotMatch(body, /\w+\s*->\s*'families'/, `${fn} still reads the document's families`);
        assert.doesNotMatch(body, /#>\s*ARRAY\['families'/, `${fn} still reaches into the document`);
        assert.doesNotMatch(body, /->\s*'finance'\s*->\s*'payments'/,
            `${fn} still reads the document's payments array`);
        assert.doesNotMatch(body, /jsonb_set\(\s*\w+\s*,\s*(?:ARRAY\['families'|'\{families\}'|'\{payments\}'|'\{finance\}'|ARRAY\['finance')/,
            `${fn} still writes a document branch`);
        assert.match(body, /camp_famil(ies_object|y_for_update|y_save)\(|camp_payments(_array)?\b|camp_payment_add\(/,
            `${fn} does not touch the rows at all — it was not transformed`);
    });

    test(`${fn}: no longer locks or writes the camp document`, () => {
        const body = codeOnly(defIn(SQL, fn));
        for (const m of body.matchAll(/SELECT value INTO \w+[\s\S]{0,260}?key = 'campistryMe'([\s\S]{0,30}?);/g)) {
            assert.doesNotMatch(m[1], /FOR UPDATE/, `${fn} still locks the camp document`);
        }
        assert.deepStrictEqual(
            [...body.matchAll(/UPDATE camp_state_kv[\s\S]{0,260}?;/g)]
                .filter(m => /campistryMe/.test(m[0])).map(m => m[0].slice(0, 40)), [],
            `${fn} still writes the camp document`);
    });
}

// ── the two by-hand transformations, asserted specifically ─────────────────
test('record_chargeback annotates ONE row via the dedupe index, not a scan', () => {
    const body = codeOnly(defIn(SQL, 'record_chargeback'));
    assert.match(body, /UPDATE public\.camp_payments/);
    assert.match(body, /dedupe_keys && p_refs/,
        'array overlap IS the four-field test the original spelled out');
    assert.match(body, /ORDER BY ordinal\s*\n\s*LIMIT 1/,
        'the same "first match" the original v_hit flag enforced');
    assert.match(body, /'disputed', true/);
    for (const k of ['disputeId', 'disputeStatus', 'disputeReason']) {
        assert.ok(body.includes(`'${k}'`), k + ' was dropped from the annotation');
    }
    assert.match(body, /COALESCE\(p_status, 'open'\)/, "the original's default status");
    assert.doesNotMatch(body, /FOR i IN 0 \.\. GREATEST/, 'the array walk is gone');
});

test('record_chargeback finds the FAMILY from the rows too', () => {
    // The first pass missed this and the function returned family_not_found for
    // every chargeback. The line was unchanged, so it looked right.
    const body = codeOnly(defIn(SQL, 'record_chargeback'));
    const lookup = body.slice(body.indexOf('INTO v_famKey, v_matched'));
    assert.match(lookup.slice(0, 400), /FROM public\.camp_payments/,
        'the family lookup must read the rows, or no chargeback ever finds its family');
    assert.match(lookup.slice(0, 400), /dedupe_keys && p_refs/);
});

test('set_my_payment_plan sets plans AND removes the legacy singular plan', () => {
    const body = codeOnly(defIn(SQL, 'set_my_payment_plan'));
    assert.match(body, /camp_family_save\([\s\S]{0,400}?ARRAY\['plans'\][\s\S]{0,200}?#- ARRAY\['plan'\]\)/,
        'both mutations, on one family, in that order — leaving the legacy key is a '
        + 'second plan the parent can still be charged on');
    assert.doesNotMatch(body, /fams #- ARRAY\[v_famKey, 'plan'\]/, 'the accumulator form is gone');
});

// ── the two new accessors ──────────────────────────────────────────────────
test('the accessors keep order, never return null, and are granted to nobody', () => {
    const arr = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.camp_payments_array'),
                                   SQL.indexOf('REVOKE ALL ON FUNCTION public.camp_payments_array')));
    assert.match(arr, /jsonb_agg\(payload ORDER BY ordinal\)/);
    assert.match(arr, /COALESCE\(/, '[] not null for a camp with no payments');
    assert.match(arr, /deleted_at IS NULL/);
    const add = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.camp_payment_add'),
                                   SQL.indexOf('REVOKE ALL ON FUNCTION public.camp_payment_add')));
    assert.match(add, /ON CONFLICT \(camp_id, payment_id\) DO UPDATE/, 'a repeat must not duplicate');
    assert.match(add, /deleted_at = NULL/, 'and must revive one the office had deleted');
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_payments_array\(uuid\) FROM public, anon, authenticated;/);
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_payment_add\(uuid, jsonb\) FROM public, anon, authenticated;/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_payments_array/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_payment_add/);
});

// ── the confirmation ───────────────────────────────────────────────────────
test('the confirmation scans the WHOLE schema, and survives an aggregate', () => {
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 215 applied'"));
    assert.match(tail, /AS campistryme_locks_left/);
    assert.match(tail, /AS campistryme_writers_left/);
    assert.match(tail, /AS other_blob_locks_kept/, 'the shop/canteen locks are reported, not assumed');
    // pg_get_functiondef THROWS on an aggregate, and this scans every function in
    // the schema rather than a named list. Without prokind the paste dies on
    // whatever aggregate happens to live in public — it did, on "array_agg".
    const scans = (tail.match(/pg_get_functiondef\(p\.oid\)/g) || []).length;
    const guards = (tail.match(/p\.prokind = 'f'/g) || []).length;
    assert.strictEqual(guards, scans,
        'every pg_get_functiondef scan needs prokind = \'f\', or an aggregate aborts the paste');
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'));
});

test('exactly the seven functions plus the two accessors are defined', () => {
    const names = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)/g)].map(m => m[1]);
    assert.deepStrictEqual(names.sort(),
        [...ALL, 'camp_payments_array', 'camp_payment_add'].sort());
});

test('it creates no table, no trigger, and writes no data', () => {
    assert.doesNotMatch(CODE, /CREATE TABLE|DROP TABLE|TRUNCATE|CREATE TRIGGER/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /);
    const pre = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    assert.match(pre, /213_payments_row_truth\.sql/);
    assert.match(pre, /212_families_read_from_rows\.sql/);
});

test('215 is a standalone paste, not a bundle entry', () => {
    assert.ok(!read('scripts/build-migration-bundle.py').includes('215_payment_family_writers'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('215_payment_family_writers'));
});
