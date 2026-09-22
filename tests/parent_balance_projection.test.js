// node --test tests/parent_balance_projection.test.js
//
// Migration 205: the parent's balance stops reading the whole camp.
//
// A load test against a real project measured get_my_balance at 828ms with 5
// concurrent parents and 3575ms with 32 — five to ten times every other portal
// read, and the only one that degraded with concurrency. The cause was not the
// loops: it was that touching ANY field of campistryMe detoasts and parses the
// whole multi-megabyte value, so the floor was the camp's size per parent per
// call. 202 took the WRAPPER off the blob; this takes the derived half off it.
//
// THIS IS PARENT-FACING MONEY, and derived is the fallback the ledger path falls
// back TO — so it has no fallback of its own. Hence the change is one line:
// `me` is assembled from indexed projections into the same shape, and every
// other line is byte-identical to migration 166. The first test below asserts
// that identity against 166 directly, so no amount of confident prose in the
// migration can substitute for it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/205_parent_balance_off_the_blob.sql');
const M166 = read('migrations/166_balance_parity.sql');

const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+[a-z]?_.*\.sql$/.test(f) && !/^APPLY/i.test(f))
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b));

/** The effective (last-wins) definition of each function across all migrations. */
function catalogue() {
    const out = {};
    for (const f of MIGRATIONS) {
        const sql = read('migrations/' + f);
        const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql))) {
            const end = sql.indexOf('\n$$;', m.index);
            out[m[1]] = { file: f, args: m[2], body: sql.slice(m.index, end > 0 ? end : m.index + 16000) };
        }
    }
    return out;
}
const CAT = catalogue();
const codeOnly = s => s.replace(/--[^\n]*/g, ' ');

/** One function's full text out of a migration. */
function fnIn(sql, name) {
    const a = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
    assert.ok(a > 0, name + ' not found');
    const end = sql.indexOf('\n$$;', a);
    assert.ok(end > a);
    return sql.slice(a, end + 4);
}

// ── THE assertion: the money math is 166's, character for character ─────────

test('everything after the slice is byte-identical to migration 166', () => {
    const now = fnIn(SQL, 'get_my_balance_derived');
    const then = fnIn(M166, 'get_my_balance');
    // 166's text after its blob read
    const marker166 = "    IF me IS NULL THEN me := '{}'::jsonb; END IF;\n";
    const a166 = then.indexOf(marker166);
    assert.ok(a166 > 0, "could not find 166's blob-read block — re-anchor this test");
    const tail166 = then.slice(a166 + marker166.length);
    // 205's text after ITS (last) occurrence of the same line
    const a205 = now.lastIndexOf(marker166);
    assert.ok(a205 > 0);
    const tail205 = now.slice(a205 + marker166.length);
    assert.strictEqual(tail205, tail166,
        'the balance math diverged from 166 — this function is the fallback for every '
        + 'other balance path and must not be rewritten, only re-sourced');
    assert.ok(tail166.length > 8000, `expected the whole calculation (~10k chars), got ${tail166.length}`);
});

test('the declarations are 166 plus exactly the two freshness vars', () => {
    const decl = s => s.slice(s.indexOf('DECLARE'), s.indexOf('BEGIN'));
    const added = decl(fnIn(SQL, 'get_my_balance_derived'))
        .split('\n').filter(l => !decl(fnIn(M166, 'get_my_balance')).includes(l.trim()) && l.trim());
    assert.strictEqual(added.length, 2, `expected 2 new DECLARE lines, got:\n${added.join('\n')}`);
    assert.ok(added.every(l => /v_blobStamp|v_projStamp/.test(l)), added.join('\n'));
});

test('205 owns the derived function and leaves the wrapper to 202', () => {
    assert.match(CAT.get_my_balance_derived.file, /^205_/);
    assert.match(CAT.get_my_balance.file, /^202_/,
        '205 must not touch get_my_balance — 202 owns the wrapper');
    assert.ok(!SQL.includes('FUNCTION public.get_my_balance('), '205 redefines the wrapper');
    assert.match(CAT.get_my_balance_derived.args, /p_camp_id\s+uuid\s+DEFAULT\s+NULL/i,
        'the wrapper calls this by that signature');
});

// ── the fallback, which is what makes this safe at all ─────────────────────

test('a stale or unstamped projection reads the blob, exactly as before', () => {
    const fn = fnIn(SQL, 'get_my_balance_derived');
    assert.match(fn, /IF v_blobStamp IS NOT NULL AND v_projStamp IS NOT NULL AND v_projStamp = v_blobStamp THEN\s*\n\s*me := public\.parent_billing_slice\(inv\.camp_id, v_names\);\s*\n\s*ELSE\s*\n\s*SELECT value INTO me FROM camp_state_kv/,
        'the fast path must be conditional and the else-branch must be the old read');
    // equality, not "newer than" — a restored backup can move the stamp backwards
    assert.ok(!/v_projStamp >= v_blobStamp|v_projStamp > v_blobStamp/.test(fn),
        'an ordering test would trust a projection built from a different blob');
});

test('the freshness probe never touches the TOASTed value', () => {
    // SELECT updated_at does not fetch the jsonb; SELECT value does. Probing with
    // the wrong column would reintroduce the entire cost this migration removes.
    const fn = fnIn(SQL, 'get_my_balance_derived');
    assert.match(fn, /SELECT updated_at INTO v_blobStamp FROM camp_state_kv/);
    const probe = fn.slice(fn.indexOf('SELECT updated_at INTO v_blobStamp'),
                           fn.indexOf('IF v_blobStamp IS NOT NULL'));
    assert.ok(!/SELECT value/.test(probe), 'the probe reads the blob');
});

// ── the slice: shape, completeness, and the loops' own predicates ──────────

test('the slice supplies every field the calculation reads from the blob', () => {
    // Enumerated from 166's body: five reads, no more. A missing one silently
    // zeroes part of a parent's bill.
    const reads = [...fnIn(M166, 'get_my_balance').matchAll(/me\s*(?:->>?|#>>?)\s*'([A-Za-z]+)'|me\s*#>>\s*'\{([A-Za-z]+),/g)]
        .map(m => m[1] || m[2]);
    assert.deepStrictEqual([...new Set(reads)].sort(),
        ['enrollSettings', 'enrollments', 'families', 'finance', 'sessions'],
        "166 reads a field this test does not know about — check the slice covers it");
    const slice = fnIn(SQL, 'parent_billing_slice');
    assert.match(slice, /'enrollments',\s+v_enr/);
    assert.match(slice, /'families',\s+v_fams/);
    assert.match(slice, /'finance',\s+jsonb_build_object\('payments', v_pays\)/);
    assert.match(slice, /'sessions',\s+COALESCE\(v_sessions, '\[\]'::jsonb\)/);
    assert.match(slice, /'enrollSettings', COALESCE\(v_settings, '\{\}'::jsonb\)/);
});

test('the slice picks enrollments and families by the loops own tests', () => {
    const slice = fnIn(SQL, 'parent_billing_slice');
    // loop 1: v_names ? (e->>'camperName')
    assert.match(slice, /FROM public\.camp_billing_enrollments\s*\n\s*WHERE camp_id = p_camp_id AND camper_name = ANY \(v_names\)/);
    // loop 2: EXISTS over fam->'camperIds' intersecting v_names
    assert.match(slice, /EXISTS \(SELECT 1 FROM jsonb_array_elements_text\(camper_ids\) ci\s*\n\s*WHERE ci = ANY \(v_names\)\)/);
});

test('the slice keeps ALL four ways a payment can belong to this parent', () => {
    // The loop matches on camper name, enrollmentId, familyKey, or family NAME.
    // Dropping any one under-reports what a family has paid — the parent is then
    // shown money they already sent.
    const slice = fnIn(SQL, 'parent_billing_slice');
    assert.match(slice, /AND \(family_name = ANY \(v_names\)/);
    assert.match(slice, /OR \(enrollment_id <> '' AND enrollment_id = ANY \(v_enrIds\)\)/);
    assert.match(slice, /OR \(family_key <> '' AND family_key = ANY \(v_famKeys\)\)/);
    assert.match(slice, /OR \(family_name <> '' AND family_name = ANY \(v_famNames\)\)\)/);
    // order preserved, or the returned history reads differently than before
    assert.match(slice, /jsonb_agg\(payload ORDER BY seq\)/);
});

test('every slice query is scoped to the camp', () => {
    // Without camp_id on any one of the three, a parent would be handed another
    // camp's enrollments, families or payments — and the loops, which filter on
    // camper NAME, would happily count a same-named camper from a different camp.
    const slice = fnIn(SQL, 'parent_billing_slice');
    const scopes = [...slice.matchAll(/WHERE camp_id = p_camp_id/g)];
    assert.strictEqual(scopes.length, 4,
        'enrollments, families, payments and the config read each need the camp scope');
    // named individually, so losing one and gaining another elsewhere still fails
    assert.match(slice, /FROM public\.camp_billing_enrollments\s*\n\s*WHERE camp_id = p_camp_id/);
    assert.match(slice, /FROM public\.camp_billing_families\s*\n\s*WHERE camp_id = p_camp_id/);
    assert.match(slice, /FROM public\.camp_billing_payments\s*\n\s*WHERE camp_id = p_camp_id/);
    assert.match(slice, /FROM public\.camp_billing_config WHERE camp_id = p_camp_id/);
});

test('the primary family still resolves deterministically', () => {
    // v_famKey (card on file, plans) is the FIRST family by key. The loop does
    // jsonb_each(...) ORDER BY key over whatever the slice hands it, so the slice
    // may return them in any order — but the loop's ORDER BY must survive.
    assert.match(fnIn(SQL, 'get_my_balance_derived'),
        /FOR famRec IN SELECT key, value FROM jsonb_each\(fams\) ORDER BY key LOOP/);
});

test('the slice is a definer scoped to the names it is given, granted no wider', () => {
    assert.match(fnIn(SQL, 'parent_billing_slice'), /SECURITY DEFINER/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.parent_billing_slice\(uuid, jsonb\) FROM public, anon;/);
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.parent_billing_slice\(uuid, jsonb\) TO authenticated, service_role;/);
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.parent_billing_slice\(uuid, jsonb\)[^;]*\banon\b/.test(SQL));
});

// ── the trigger ────────────────────────────────────────────────────────────

test('the trigger fires on every campistryMe write and only that key', () => {
    assert.match(SQL, /CREATE TRIGGER trg_project_camp_billing\s*\nAFTER INSERT OR UPDATE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(NEW\.key = 'campistryMe'\)/);
    assert.match(SQL, /CREATE TRIGGER trg_project_camp_billing_del\s*\nAFTER DELETE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(OLD\.key = 'campistryMe'\)/);
    assert.match(SQL, /DROP TRIGGER IF EXISTS trg_project_camp_billing ON public\.camp_state_kv;/);
    assert.match(fnIn(SQL, 'project_camp_billing'), /SECURITY DEFINER/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.project_camp_billing\(\) FROM public, anon, authenticated;/);
});

test('the stamp is written on EVERY save, or the fast path never engages', () => {
    const fn = fnIn(SQL, 'project_camp_billing');
    const cfg = fn.slice(fn.indexOf('INSERT INTO public.camp_billing_config'));
    assert.match(cfg, /blob_updated_at = EXCLUDED\.blob_updated_at/);
    assert.match(cfg, /NEW\.updated_at, now\(\)/, 'the stamp IS the blob row\'s updated_at');
    // it must NOT be inside one of the IS DISTINCT FROM branches
    const branches = fn.slice(fn.indexOf("IF TG_OP = 'INSERT'"), fn.indexOf('INSERT INTO public.camp_billing_config'));
    assert.strictEqual((branches.match(/IS DISTINCT FROM/g) || []).length, 3,
        'three guarded branches: enrollments, families, payments');
    assert.ok(!/camp_billing_config/.test(branches), 'the config write must be unconditional');
});

test('each branch re-projects only when its own source changed', () => {
    const fn = fnIn(SQL, 'project_camp_billing');
    assert.match(fn, /\(NEW\.value -> 'enrollments'\) IS DISTINCT FROM \(OLD\.value -> 'enrollments'\)/);
    assert.match(fn, /\(NEW\.value -> 'families'\) IS DISTINCT FROM \(OLD\.value -> 'families'\)/);
    assert.match(fn, /\(NEW\.value -> 'finance' -> 'payments'\)\s*\n\s*IS DISTINCT FROM \(OLD\.value -> 'finance' -> 'payments'\)/);
    // and every branch handles a first INSERT, where there is no OLD
    assert.strictEqual((fn.match(/TG_OP = 'INSERT'\s*\n\s*OR/g) || []).length, 3);
});

test('payments carry the three match keys as columns, in array order', () => {
    const fn = fnIn(SQL, 'project_camp_billing');
    assert.match(fn, /COALESCE\(p\.value ->> 'family', ''\),\s*\n\s*COALESCE\(p\.value ->> 'familyKey', ''\),\s*\n\s*COALESCE\(p\.value ->> 'enrollmentId', ''\)/);
    assert.match(fn, /WITH ORDINALITY AS p\(value, ord\)/, 'seq must be the original position');
    // 202's payments projection buckets by familyKey ONLY, which is why this one
    // exists: a payment carrying another family's key but this parent's camper
    // name would have been missed, and the old code counted it.
    assert.match(SQL, /payments projection buckets only by familyKey/,
        'the header must keep explaining why this projection exists beside 202\'s');
});

test('a deleted blob row clears every projection including the stamp', () => {
    const fn = fnIn(SQL, 'project_camp_billing');
    const del = fn.slice(fn.indexOf("IF TG_OP = 'DELETE'"), fn.indexOf('RETURN OLD;'));
    for (const t of ['camp_billing_enrollments', 'camp_billing_families',
                     'camp_billing_payments', 'camp_billing_config']) {
        assert.match(del, new RegExp('DELETE FROM public\\.' + t + '\\s+WHERE camp_id = OLD\\.camp_id;'), t);
    }
});

test('a malformed entry is skipped, never thrown on', () => {
    // A trigger throw aborts the ORIGINAL office save. A stray string in any of
    // the three collections must cost itself, not the save.
    const fn = fnIn(SQL, 'project_camp_billing');
    assert.strictEqual((fn.match(/WHERE jsonb_typeof\((?:e|f|p)\.value\) = 'object'/g) || []).length, 3);
});

// ── the tables ─────────────────────────────────────────────────────────────

test('no foreign key to camps on a trigger-written table', () => {
    const tables = SQL.slice(SQL.indexOf('CREATE TABLE IF NOT EXISTS public.camp_billing_config'),
                             SQL.indexOf('-- Deny-all'));
    assert.ok(!/REFERENCES/.test(codeOnly(tables)),
        'an FK violation in a trigger aborts the blob save — 200 and 202 both say so');
});

test('the projections are deny-all: RLS on, no policies, no direct grant', () => {
    for (const t of ['camp_billing_config', 'camp_billing_enrollments',
                     'camp_billing_families', 'camp_billing_payments']) {
        assert.match(SQL, new RegExp('ALTER TABLE public\\.' + t + '\\s+ENABLE ROW LEVEL SECURITY;'), t);
        assert.match(SQL, new RegExp('REVOKE ALL ON public\\.' + t + '\\s+FROM anon, authenticated;'), t);
    }
    assert.ok(!/CREATE POLICY/.test(SQL), 'a policy would expose one camp\'s billing to another');
    assert.ok(!/GRANT SELECT ON public\.camp_billing/.test(SQL),
        'reads go through the definer functions, not the tables');
});

test('the lookups every query needs are indexed', () => {
    assert.match(SQL, /ON public\.camp_billing_enrollments \(camp_id, camper_name\)/);
    assert.match(SQL, /ON public\.camp_billing_families USING gin \(camper_ids jsonb_path_ops\)/,
        'membership in a jsonb array needs GIN, or it is a scan of every family');
    assert.match(SQL, /ON public\.camp_billing_payments \(camp_id, family_key\)/);
    assert.match(SQL, /ON public\.camp_billing_payments \(camp_id, family_name\)/);
    assert.match(SQL, /ON public\.camp_billing_payments \(camp_id, enrollment_id\)/);
});

// ── the backfill ───────────────────────────────────────────────────────────

test('the backfill is scoped to camps that still exist', () => {
    // 200's first paste died on an orphaned campistryMe row whose camp was gone.
    assert.strictEqual((SQL.match(/EXISTS \(SELECT 1 FROM camps c WHERE c\.id = kv\.camp_id\)/g) || []).length, 7,
        'three deletes, three inserts and the stamp all need the scope');
});

test('the backfill stamps LAST, so an interrupted run leaves the blob path', () => {
    const bf = SQL.slice(SQL.indexOf('-- ─── 5. backfill'), SQL.indexOf('-- ─── 6. the verifier'));
    const stamp = bf.indexOf('INSERT INTO public.camp_billing_config');
    for (const t of ['camp_billing_enrollments', 'camp_billing_families', 'camp_billing_payments']) {
        assert.ok(bf.indexOf('INSERT INTO public.' + t) < stamp,
            t + ' is projected after the stamp — a half-projected camp would be trusted');
    }
    assert.match(bf, /interrupted part way leaves the camp\s*\n-- unstamped/);
});

test('the backfill converges rather than duplicating', () => {
    const bf = SQL.slice(SQL.indexOf('-- ─── 5. backfill'), SQL.indexOf('-- ─── 6. the verifier'));
    assert.match(bf, /ON CONFLICT \(camp_id, entry_id\) DO UPDATE/);
    assert.match(bf, /ON CONFLICT \(camp_id, family_key\) DO UPDATE/);
    assert.match(bf, /ON CONFLICT \(camp_id, seq\) DO UPDATE/);
    assert.match(bf, /ON CONFLICT \(camp_id\) DO UPDATE/);
    // stale rows from a previous shape are cleared first
    assert.strictEqual((bf.match(/DELETE FROM public\.camp_billing_/g) || []).length, 3);
});

// ── the verifier ───────────────────────────────────────────────────────────

test('the verifier reports counts and the stamp, never anybody money', () => {
    const fn = fnIn(SQL, 'verify_camp_billing_projection');
    assert.match(fn, /'onFastPath', \(v_stamp IS NOT NULL AND v_proj IS NOT NULL AND v_proj = v_stamp\)/);
    assert.match(fn, /'inSync',/);
    assert.match(fn, /onFastPath false is SAFE/, 'the reader must know a false is not a bug');
    // Checked as the exact key set, not by scanning for words: the note itself
    // contains "balance" (explaining the fallback), which is prose, not money.
    const ret = fn.slice(fn.lastIndexOf('RETURN jsonb_build_object'));
    const keys = [...ret.matchAll(/'([A-Za-z]+)',/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(keys)].sort(),
        ['blob', 'enrollments', 'families', 'inSync', 'note', 'onFastPath', 'payments',
         'projected', 'repair', 'sessionsMatch', 'success'].sort(),
        'the report gained or lost a key — it must stay counts and flags only');
    // and no jsonb value in the report may come from the blob's money fields
    assert.ok(!/v_me -> '(finance|families)'/.test(ret), 'the report must not echo blob money');
});

test('the verifier runs from the SQL Editor, like 202 and 203', () => {
    const fn = fnIn(SQL, 'verify_camp_billing_projection');
    assert.match(fn, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/);
    assert.match(fn, /IF v_claims IS NOT NULL\s*\n\s*AND COALESCE\(v_claims::jsonb ->> 'role', ''\) <> 'service_role'\s*\n\s*AND NOT public\.camp_reader\(p_camp_id\) THEN/);
    assert.ok(!/current_user|session_user/.test(codeOnly(fn)));
});

// ── the file's own rules ───────────────────────────────────────────────────

test('205 writes no blob and touches no writer', () => {
    const code = codeOnly(SQL);
    assert.ok(!/UPDATE\s+camp_state_kv|INSERT INTO\s+camp_state_kv|DELETE FROM\s+camp_state_kv/i.test(code),
        'the projection follows the blob, never the reverse');
    for (const fn of ['append_camp_payment', 'record_autopay_charge', 'submit_public_application',
                      'sync_family_ledger_payments']) {
        assert.ok(!SQL.includes('FUNCTION public.' + fn), '205 must not touch ' + fn);
    }
});

test('205 is standalone, not in the apply bundle', () => {
    assert.match(SQL, /Standalone — not in APPLY_BUNDLE\.sql/);
    assert.ok(!read('scripts/build-migration-bundle.py').includes('205_parent_balance'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('205_parent_balance'));
});

test('the marker 173 looks for survives, or a re-paste of 173 breaks the wrapper', () => {
    // 173 renames get_my_balance to get_my_balance_derived UNLESS the wrapper
    // carries this marker. 205 replaces derived, so the marker must still be in
    // the WRAPPER (202's), and 205 must not have introduced one of its own that
    // would make 173 skip a rename it should do.
    assert.match(CAT.get_my_balance.body, /LEDGER_WRAPPER_V173/);
    assert.ok(!fnIn(SQL, 'get_my_balance_derived').includes('LEDGER_WRAPPER_V173'),
        'the derived function must not carry the wrapper marker');
});
