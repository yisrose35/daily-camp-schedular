// node --test tests/families_read_from_rows.test.js
//
// Migration 212: everything that READS families reads the rows.
//
// THE POINT OF THIS FILE. 212 does not rewrite four money functions — it
// extracts each one's body VERBATIM from the migration that last defined it and
// substitutes exactly one thing: where families come from. The tests below prove
// that, LINE BY LINE, against those source files. A silent transcription slip in
// get_my_saved_payment_methods or receipt_recipient would not show up as a
// syntax error, would not show up in a behaviour test that happens not to reach
// that branch, and would be a wrong answer about somebody's money. So the diff
// itself is the thing under test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/212_families_read_from_rows.sql');
function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

/** A function's whole definition, verbatim, from a given file. */
function defIn(file, name) {
    const s = read(file);
    const a = s.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in ' + file);
    const b = s.indexOf('\n$$;', a);
    assert.ok(b > a, name + ' body is not terminated in ' + file);
    return s.slice(a, b + 4);
}

/**
 * Line-by-line diff of two definitions, ignoring nothing.
 * Returns {added, removed} — lines present in one and not the other.
 */
function lineDiff(orig, now) {
    const o = orig.split('\n'), n = now.split('\n');
    const count = arr => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
    const co = count(o), cn = count(n);
    const removed = [], added = [];
    for (const [l, c] of co) { const d = c - (cn.get(l) || 0); for (let i = 0; i < d; i++) removed.push(l); }
    for (const [l, c] of cn) { const d = c - (co.get(l) || 0); for (let i = 0; i < d; i++) added.push(l); }
    return { added, removed };
}

test('the diff helper actually detects a change', () => {
    const d = lineDiff('a\nb\nc', 'a\nX\nc');
    assert.deepStrictEqual(d.removed, ['b']);
    assert.deepStrictEqual(d.added, ['X']);
    assert.deepStrictEqual(lineDiff('a\nb', 'a\nb'), { added: [], removed: [] },
        'identical input must produce an empty diff, or every test below is vacuous');
});

// ── the four extracted readers, each diffed against its source ─────────────
const READERS = [
    { fn: 'get_my_saved_payment_methods', src: 'migrations/139_saved_payment_methods.sql',
      removed: ["    fams := COALESCE(me->'families', '{}'::jsonb);"],
      added: ["    fams := public.camp_families_object(inv.camp_id);"] },
    { fn: 'plan_due_for', src: 'migrations/172_autopay_posts_to_ledger.sql',
      removed: ["    v_fam := v_me #> ARRAY['families', p_family_key];"],
      added: ["    v_fam := public.camp_family(p_camp_id, p_family_key);"] },
    { fn: 'report_plan_undercollection', src: 'migrations/171_posted_ledger.sql',
      removed: ["    FOR famRec IN SELECT key, value FROM jsonb_each(COALESCE(v_me->'families', '{}'::jsonb)) LOOP"],
      added: ["    FOR famRec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP"] },
    { fn: 'receipt_recipient', src: 'migrations/188_payment_receipts.sql',
      removed: ["            v_fam := v_doc #> ARRAY['families', v_famkey];",
                "            FOR v_k IN SELECT jsonb_object_keys(COALESCE(v_doc->'families', '{}'::jsonb)) LOOP",
                "                IF (v_doc #> ARRAY['families', v_k, 'camperIds']) @> to_jsonb(v_camper) THEN",
                "                    v_fam := v_doc #> ARRAY['families', v_k];"],
      added: ["            v_fam := public.camp_family(p_camp_id, v_famkey);",
              "            FOR v_k IN SELECT jsonb_object_keys(public.camp_families_object(p_camp_id)) LOOP",
              "                IF (public.camp_family(p_camp_id, v_k) -> 'camperIds') @> to_jsonb(v_camper) THEN",
              "                    v_fam := public.camp_family(p_camp_id, v_k);"] },
];

for (const r of READERS) {
    test(`${r.fn}: ONLY the families source changed, nothing else`, () => {
        const orig = defIn(r.src, r.fn);
        const now = defIn('migrations/212_families_read_from_rows.sql', r.fn);
        const d = lineDiff(orig, now);
        // Comment lines the substitution introduced are allowed; code lines are not.
        const addedCode = d.added.filter(l => !l.trim().startsWith('--'));
        assert.deepStrictEqual(d.removed.sort(), [...r.removed].sort(),
            `${r.fn}: unexpected lines were REMOVED from a money function`);
        assert.deepStrictEqual(addedCode.sort(), [...r.added].sort(),
            `${r.fn}: unexpected CODE was added to a money function`);
    });

    test(`${r.fn}: the substitution is present and the old read is gone`, () => {
        const now = codeOnly(defIn('migrations/212_families_read_from_rows.sql', r.fn));
        assert.match(now, /camp_famil(ies_object|y)\(/, 'it must read the rows');
        assert.doesNotMatch(now, /#> ARRAY\['families'/, "no #> into the document's branch");
        assert.doesNotMatch(now, /->\s*'families'/, "no -> into the document's branch");
    });
}

test('every reader keeps its own signature, volatility and security', () => {
    for (const r of READERS) {
        const orig = defIn(r.src, r.fn), now = defIn('migrations/212_families_read_from_rows.sql', r.fn);
        const head = s => s.slice(0, s.indexOf('AS $$'));
        assert.strictEqual(head(now), head(orig),
            `${r.fn}: the signature/LANGUAGE/SECURITY block must be untouched — ` +
            'changing DEFINER or the argument list here is a security change, not a refactor');
    }
});

// ── parent_billing_slice, diffed against 210 ───────────────────────────────
test('parent_billing_slice: only the families query moved', () => {
    const orig = defIn('migrations/210_payments_read_from_rows.sql', 'parent_billing_slice');
    const now = defIn('migrations/212_families_read_from_rows.sql', 'parent_billing_slice');
    const d = lineDiff(orig, now);
    assert.deepStrictEqual(d.removed, ['      FROM public.camp_billing_families'],
        'the only line that should leave is the old table');
    const addedCode = d.added.filter(l => !l.trim().startsWith('--'));
    assert.deepStrictEqual(addedCode.sort(),
        ['      FROM public.camp_families', '       AND deleted_at IS NULL'].sort(),
        'the new table plus the soft-delete filter, and nothing else');
});

test('the slice still reads payments from camp_payments (210s change survives)', () => {
    const now = codeOnly(defIn('migrations/212_families_read_from_rows.sql', 'parent_billing_slice'));
    assert.match(now, /FROM public\.camp_payments/);
    assert.match(now, /jsonb_agg\(payload ORDER BY ordinal\)/);
    // and all four payment match predicates
    assert.match(now, /family_name = ANY \(v_names\)/);
    assert.match(now, /enrollment_id <> '' AND enrollment_id = ANY \(v_enrIds\)/);
    assert.match(now, /family_key <> '' AND family_key = ANY \(v_famKeys\)/);
    assert.match(now, /family_name <> '' AND family_name = ANY \(v_famNames\)/);
});

test('the slice excludes soft-deleted families from a parent balance', () => {
    const now = codeOnly(defIn('migrations/212_families_read_from_rows.sql', 'parent_billing_slice'));
    const fams = now.slice(now.indexOf('FROM public.camp_families'));
    assert.match(fams.slice(0, 200), /AND deleted_at IS NULL/,
        'a family the office removed must stop counting towards what a parent owes');
});

// ── the accessors ──────────────────────────────────────────────────────────
test('the accessors return live families only, in the branchs shape', () => {
    const obj = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.camp_families_object')));
    assert.match(obj.slice(0, 500), /jsonb_object_agg\(family_key, payload\)/, '{key: payload}');
    assert.match(obj.slice(0, 500), /COALESCE\(.*'\{\}'::jsonb\)/s, '{} not null for an empty camp');
    assert.match(obj.slice(0, 500), /deleted_at IS NULL/);
    const one = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.camp_family(')));
    assert.match(one.slice(0, 400), /deleted_at IS NULL/);
    assert.doesNotMatch(one.slice(0, 400), /COALESCE/,
        "NULL for an absent family is what #> ARRAY['families', key] returned");
});

test('THE ACCESSORS ARE GRANTED TO NOBODY — that is the whole protection', () => {
    // They take a camp id and return that camp's families. A grant to
    // `authenticated` is a cross-camp read of every family in the database.
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_families_object\(uuid\) FROM public, anon, authenticated;/);
    assert.match(CODE, /REVOKE ALL ON FUNCTION public\.camp_family\(uuid, text\) FROM public, anon, authenticated;/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_families_object/);
    assert.doesNotMatch(CODE, /GRANT EXECUTE ON FUNCTION public\.camp_family\(/);
    assert.match(SQL, /has_function_privilege\('authenticated', 'public\.camp_families_object\(uuid\)', 'EXECUTE'\)/,
        'and the confirmation row reports it, so a future grant is visible on paste');
});

// ── the office read ────────────────────────────────────────────────────────
test('the office families read is gated on me.billing', () => {
    const body = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.get_camp_families'),
                                   SQL.indexOf('$$;', SQL.indexOf('FUNCTION public.get_camp_families'))));
    assert.match(body, /user_section_level\(p_camp_id, 'me\.billing'\) = 'none'/);
    assert.doesNotMatch(body, /'me\.finance'/);
    assert.match(body, /IF auth\.uid\(\) IS NULL THEN/);
    assert.match(body, /'missing_camp'/);
    assert.match(body, /COALESCE\(v_fams, '\{\}'::jsonb\)/, 'never null');
});

// ── the swap verifier ──────────────────────────────────────────────────────
test('the swap verifier compares families AND charges, and explains its future', () => {
    const body = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.verify_families_read_swap')));
    assert.match(body, /'sameFamilies', v_docFams = v_rowFams/);
    assert.match(body, /'chargedOld'/);
    assert.match(body, /'chargedNew'/);
    assert.match(body, /this goes false by/,
        'once the writers move, the rows are ahead of the document by design');
    assert.match(body, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/,
        'runnable from the SQL Editor, which carries no JWT');
    assert.doesNotMatch(body, /current_user|session_user/);
});

test('the verifier compares only OBJECT entries, as the trigger projects only those', () => {
    const body = codeOnly(SQL.slice(SQL.indexOf('FUNCTION public.verify_families_read_swap')));
    assert.match(body, /WHERE jsonb_typeof\(f\.value\) = 'object'/,
        'a non-object entry is never projected, so counting it would be a false mismatch');
});

// ── nothing else moves ─────────────────────────────────────────────────────
test('212 touches no writer and removes no lock', () => {
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(append_camp_payment|record_autopay_charge|record_autopay_installment|record_external_refund|record_chargeback|resolve_chargeback|settle_shop_order|sync_family_ledger_payments|set_my_payment_plan|merge_camp_family_fields|append_family_payment_method|remove_payment_method|set_default_payment_method|convert_family_ledgers|flag_expiring_cards|flag_plan_collection)\b/,
        'the writers are the next phase');
    assert.doesNotMatch(CODE, /FOR UPDATE/);
    assert.doesNotMatch(CODE, /UPDATE camp_state_kv|INSERT INTO camp_state_kv/,
        'this file writes nothing');
});

test('205s projection stays, so a rollback has somewhere to land', () => {
    assert.doesNotMatch(CODE, /DROP TABLE[\s\S]{0,60}camp_billing_families/);
    assert.doesNotMatch(CODE, /DROP TRIGGER IF EXISTS trg_project_camp_billing\b/);
});

test('the file announces itself and proves each reader really moved', () => {
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'),
        'a migration ending on a comment prints nothing on success');
    assert.match(SQL, /SELECT 'migration 212 applied'\s+AS status/);
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 212 applied'"));
    assert.match(tail, /AS readers_on_rows/,
        'counts the readers whose definition now mentions camp_famil*, so a partial paste shows');
    for (const r of READERS) assert.ok(tail.includes(r.fn), r.fn + ' is not counted');
    assert.match(tail, /'parent_billing_slice'/);
    assert.match(tail, /AS accessor_leaks/);
});

test('safe to re-run, Dashboard-applied, and the preflight names its prerequisites', () => {
    assert.doesNotMatch(CODE, /\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM\b/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /, 'the user has no CLI');
    const pre = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    for (const f of ['211_families_into_rows.sql', '208_payments_into_rows.sql',
                     '188_payment_receipts.sql', '183_lock_down_camp_scoped_readers.sql']) {
        assert.ok(pre.includes(f), pre.includes(f) || f + ' is not named as a prerequisite');
    }
    const appends = pre.match(/v_missing := v_missing \|\| '(?:[^']|'')*'::text;/g) || [];
    assert.strictEqual(appends.length, 4, 'every append cast to text');
});

test('212 is a standalone paste, not a bundle entry', () => {
    assert.ok(!read('scripts/build-migration-bundle.py').includes('212_families_read_from_rows'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('212_families_read_from_rows'));
});

// ── the client half ────────────────────────────────────────────────────────
const ME = read('campistry_me.js');
function jsCode(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
}
const MECODE = jsCode(ME);

test('the JS stripper strips comments and keeps code', () => {
    assert.strictEqual(jsCode('// gone\nkept();').trim(), 'kept();');
    assert.match(jsCode('/* gone */ kept();'), /kept\(\);/);
});

test('loadData prefers the family rows over the document branch', () => {
    assert.match(MECODE, /families=_familiesFromRows\|\|me\.families\|\|\{\}/,
        'the rows must come first, or the writer phase freezes the family list silently');
});

test('the families loader is fired from hydration, beside the payments one', () => {
    assert.match(MECODE, /try\{ _loadFamiliesFromRows\(\); \}catch\(_\)\{\}/);
    const pay = MECODE.indexOf('_loadPaymentsFromRows();');
    const fam = MECODE.indexOf('_loadFamiliesFromRows();');
    assert.ok(pay > 0 && fam > pay, 'they sit together, and neither is awaited');
});

test('null means "not heard from", so a failed call cannot empty Billing', () => {
    assert.match(MECODE, /var _familiesFromRows=null;/);
    const a = MECODE.indexOf('async function _loadFamiliesFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryFamilies', a));
    assert.match(body, /if\(res&&res\.error\)\{[\s\S]*?return;/, 'unavailable RPC: cache untouched');
    assert.match(body, /if\(!d\|\|d\.success===false\|\|!d\.families\|\|typeof d\.families!=='object'\|\|Array\.isArray\(d\.families\)\)return;/,
        'an array or a non-object answer must be refused — families is an OBJECT');
    assert.ok(body.indexOf('_familiesFromRows=d.families') > body.indexOf('Array.isArray(d.families)'),
        'the cache is only set after the answer is known to be an object');
    assert.doesNotMatch(body, /_familiesFromRows=\{\}/,
        'an empty object from a failure would blank a real family list');
});

test('it re-renders only when the family list actually changed', () => {
    const a = MECODE.indexOf('async function _loadFamiliesFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryFamilies', a));
    assert.match(body, /var before=JSON\.stringify\(families\|\|\{\}\);/);
    assert.match(body, /if\(JSON\.stringify\(families\|\|\{\}\)!==before\)\{/);
    assert.match(body, /if\(typeof loadData==='function'\)loadData\(\);/,
        'consumers pick the rows up through the one hydration path');
});

test('a camp without 212 or a user without me.billing degrades quietly', () => {
    const a = MECODE.indexOf('async function _loadFamiliesFromRows()');
    const body = MECODE.slice(a, MECODE.indexOf('window.reloadCampistryFamilies', a));
    assert.match(body, /console\.log\('\[Me\] family rows unavailable:'/);
    assert.match(body, /catch\(e\)\{/, 'a thrown error must not break hydration');
});

test('a writer can pull the family list forward without a reload', () => {
    assert.match(MECODE, /window\.reloadCampistryFamilies=_loadFamiliesFromRows;/);
});

test('the page ships on a fresh cache-bust', () => {
    const html = read('campistry_me.html');
    const v = (html.match(/campistry_me\.js\?v=([0-9A-Za-z-]+)/) || [])[1];
    assert.ok(v, 'campistry_me.js is not versioned');
    assert.notStrictEqual(v, '20260922-04', 'a new reader behind an old ?v= is a reader nobody runs');
});
