// node --test tests/families_into_rows.test.js
//
// Migration 211: families get their own rows.
//
// WHY THIS CAME BEFORE FLIPPING THE WRITERS, contrary to the plan I first wrote
// down. ALL SIXTEEN functions that lock campistryMe touch `families`; nine touch
// finance.payments as well, but every one touches families. The lock exists to
// serialise read-modify-write of the WHOLE document, so while families live in
// it, every writer serialises camp-wide regardless of what else changed — and
// taking only the payments array out of them buys nothing.
//
// Nor can the lock be narrowed to a per-family advisory lock while families stay
// in the document: two families would then UPDATE the same camp_state_kv row
// concurrently, and read-modify-write of one jsonb value needs serialisation on
// the ROW. Migration 200 could narrow its lock to (camp, session) only because it
// moved the protected data out to camp_applications first. Same order here.
//
// THE DESIGN DECISION THIS FILE MOSTLY GUARDS. A payment is an event, so 208's
// rows are append-only. A family is a RECORD and can legitimately be deleted —
// but the office saves this document wholesale from possibly-stale local storage,
// and a save that has lost a family is indistinguishable from deleting it. So
// absence is STAMPED, never obeyed: nothing is destroyed, a real deletion
// disappears from readers at once, and a stale save is undone by the next good
// one. Tests below hold that line from both directions.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/211_families_into_rows.sql');
function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

function fnBody(name) {
    const a = SQL.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in the migration');
    const end = SQL.indexOf('\n$$;', a);
    assert.ok(end > a, name + ' body is not terminated');
    return codeOnly(SQL.slice(a, end));
}

// ── the table ──────────────────────────────────────────────────────────────
test('one row per family, keyed on the documents own key', () => {
    assert.match(CODE, /CREATE TABLE IF NOT EXISTS public\.camp_families/);
    assert.match(CODE, /PRIMARY KEY \(camp_id, family_key\)/,
        'family_key is already stable and unique per camp — no identity to derive');
    assert.match(CODE, /deleted_at timestamptz/, 'absence is recorded, not obeyed');
});

test('the columns the readers query on are extracted and indexed', () => {
    assert.match(CODE, /idx_camp_families_campers[\s\S]{0,140}USING gin \(camper_ids jsonb_path_ops\)/,
        'the membership test must be an index probe, not a scan of every family');
    assert.match(CODE, /idx_camp_families_name[\s\S]{0,120}\(camp_id, name\)/,
        'the balance matches payments to families by name as well as by key');
    assert.match(CODE, /idx_camp_families_live[\s\S]{0,120}WHERE deleted_at IS NULL/,
        'every read the app makes is of live families');
});

test('deny-all, and no foreign key to camps', () => {
    assert.match(CODE, /ALTER TABLE public\.camp_families ENABLE ROW LEVEL SECURITY;/);
    assert.match(CODE, /REVOKE ALL ON public\.camp_families FROM anon, authenticated;/);
    const t = CODE.slice(CODE.indexOf('CREATE TABLE IF NOT EXISTS public.camp_families'));
    assert.doesNotMatch(t.slice(0, t.indexOf(');')), /REFERENCES/,
        'a trigger must not be able to abort the original save — migration 200 lost a paste to that');
});

// ── the soft delete, from both directions ──────────────────────────────────
test('a family missing from a save is STAMPED, never deleted', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /UPDATE public\.camp_families f\s*\n\s*SET deleted_at = now\(\), updated_at = now\(\)/,
        'stamped');
    assert.match(body, /AND NOT \(v_new \? f\.family_key\)/, 'the ones absent from this save');
    assert.doesNotMatch(body, /DELETE FROM public\.camp_families/,
        'a stale whole-object save would destroy a real family with its charges');
});

test('an existing stamp is not rewritten by later saves', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /AND f\.deleted_at IS NULL\s*\n\s*AND NOT \(v_new \? f\.family_key\)/,
        'only live rows are stamped, so the original deletion time survives');
});

test('a family that comes back has its stamp CLEARED', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /deleted_at = NULL,\s*\n?\s*--? ?a family that is back is not deleted|deleted_at = NULL,/,
        'the upsert must clear the stamp, or a resurrected family stays invisible');
    // And the diff must not skip it: unchanged payload + stamped row still needs
    // the upsert to run, or the family never comes back.
    assert.match(body, /OR EXISTS \(SELECT 1 FROM public\.camp_families f\s*\n\s*WHERE f\.camp_id = NEW\.camp_id AND f\.family_key = n\.key\s*\n\s*AND f\.deleted_at IS NOT NULL\)/,
        'an unchanged family that is soft-deleted must still be revived by the diff');
});

test('the backfill does not resurrect what the document dropped', () => {
    const bf = CODE.slice(CODE.indexOf('INSERT INTO public.camp_families\n    (camp_id, family_key, name, camper_ids, payload)'));
    const upsert = bf.slice(bf.indexOf('ON CONFLICT'), bf.indexOf(';', bf.indexOf('ON CONFLICT')));
    assert.ok(!/deleted_at/.test(upsert),
        're-pasting the file must not clear a delete stamp');
    assert.match(upsert, /payload    = EXCLUDED\.payload/, 'but it does refresh the record');
});

// ── the trigger's cost ─────────────────────────────────────────────────────
test('a save that did not touch families costs one comparison', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /IF TG_OP <> 'INSERT'\s*\n\s*AND \(NEW\.value -> 'families'\) IS NOT DISTINCT FROM \(OLD\.value -> 'families'\) THEN\s*\n\s*RETURN NEW;/,
        'this document is saved constantly for reasons unrelated to money');
});

test('it diffs key by key rather than rebuilding, and probes by key', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /\(v_old -> n\.key\) IS DISTINCT FROM n\.value/,
        '203 rebuilt everything per write and decayed throughput 84 to 26 per second');
    assert.match(body, /FROM jsonb_each\(v_new\) AS n/);
    assert.doesNotMatch(body, /=\s*ANY\s*\(/, 'array membership is a linear scan per row');
});

test('a non-object families entry is skipped, not projected', () => {
    const body = fnBody('project_camp_families');
    assert.match(body, /WHERE jsonb_typeof\(n\.value\) = 'object'/);
    assert.match(CODE, /AND jsonb_typeof\(f\.value\) = 'object'/, 'the backfill too');
});

test('the trigger fires only for campistryMe, and not on delete', () => {
    assert.match(CODE, /CREATE TRIGGER trg_project_camp_families\s*\nAFTER INSERT OR UPDATE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(NEW\.key = 'campistryMe'\)/);
    assert.doesNotMatch(CODE, /AFTER DELETE[\s\S]{0,200}project_camp_families/,
        'a camp row going away does not make its families untrue');
});

// ── the verifier ───────────────────────────────────────────────────────────
test('inSync means all four: nothing missing, nothing stale, no live orphan, money equal', () => {
    const body = fnBody('verify_camp_families');
    assert.match(body, /'inSync', \(jsonb_array_length\(v_missing\) = 0\s*\n\s*AND jsonb_array_length\(v_differs\) = 0\s*\n\s*AND jsonb_array_length\(v_zombies\) = 0\s*\n\s*AND v_blobCharges = v_rowCharges\)/,
        'a count match alone would miss a wrong charge');
});

test('the verifier counts live and soft-deleted separately', () => {
    const body = fnBody('verify_camp_families');
    assert.match(body, /count\(\*\) FILTER \(WHERE deleted_at IS NULL\),\s*\n\s*count\(\*\) FILTER \(WHERE deleted_at IS NOT NULL\)/,
        'lumping them together would hide a family that vanished from readers');
    for (const k of ['blobFamilies', 'liveRows', 'softDeletedRows', 'missingFromRows',
                     'missingKeys', 'staleRows', 'staleKeys', 'liveRowsNotInDocument',
                     'notInDocumentKeys', 'chargedInBlob', 'chargedInRows']) {
        assert.ok(body.includes("'" + k + "'"), k + ' is not reported');
    }
});

test('missing and stale are measured against LIVE rows only', () => {
    const body = fnBody('verify_camp_families');
    // A soft-deleted row must not satisfy "present in the rows", or a family
    // invisible to every reader would verify as fine.
    assert.match(body, /WHERE r\.camp_id = p_camp_id AND r\.family_key = f\.key\s*\n\s*AND r\.deleted_at IS NULL/,
        'missing');
    assert.match(body, /ON r\.camp_id = p_camp_id AND r\.family_key = f\.key AND r\.deleted_at IS NULL/,
        'stale');
});

test('charges are summed from live rows on both sides', () => {
    const body = fnBody('verify_camp_families');
    const sums = body.match(/sum\(COALESCE\(\(ch ->> 'amount'\)::numeric, 0\)\)/g) || [];
    assert.strictEqual(sums.length, 2, 'both sides, same expression');
    assert.match(body, /WHERE r\.camp_id = p_camp_id AND r\.deleted_at IS NULL;/,
        'the row side counts live families only, matching what the document has');
});

test('the verifier works from the SQL Editor, which carries no JWT', () => {
    const body = fnBody('verify_camp_families');
    assert.match(body, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/);
    assert.match(body, /IF v_claims IS NOT NULL/);
    assert.match(body, /<> 'service_role'/);
    assert.match(body, /NOT public\.camp_reader\(p_camp_id\)/);
    assert.doesNotMatch(body, /current_user|session_user/,
        'inside SECURITY DEFINER those are the owner for every caller alike');
});

test('soft-deletes and live-orphans are explained, not left to be guessed', () => {
    const body = fnBody('verify_camp_families');
    assert.match(body, /softDeletedRows > 0 is normal/);
    assert.match(body, /liveRowsNotInDocument should be 0/,
        'before the writer phase it means the stamp did not fire');
});

// ── nothing else moves in this phase ───────────────────────────────────────
test('211 touches no reader, no writer, and takes no lock', () => {
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(append_camp_payment|record_autopay_charge|settle_shop_order|set_my_payment_plan|merge_camp_family_fields|convert_family_ledgers)\b/);
    assert.doesNotMatch(CODE, /CREATE OR REPLACE FUNCTION public\.(parent_billing_slice|get_my_balance_derived|get_camp_payments)\b/);
    assert.doesNotMatch(CODE, /FOR UPDATE/);
    assert.doesNotMatch(CODE, /UPDATE camp_state_kv|INSERT INTO camp_state_kv/,
        'this file writes nothing back to the document');
});

test('205s camp_billing_families is left alive for a rollback', () => {
    assert.doesNotMatch(CODE, /DROP TABLE[\s\S]{0,60}camp_billing_families/);
    assert.doesNotMatch(CODE, /DROP TRIGGER IF EXISTS trg_project_camp_billing\b/);
});

test('exactly two functions, and the file announces itself', () => {
    const names = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)/g)].map(m => m[1]);
    assert.deepStrictEqual(names.sort(), ['project_camp_families', 'verify_camp_families']);
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'),
        'a migration ending on a comment prints nothing on success');
    assert.match(SQL, /SELECT 'migration 211 applied'\s+AS status/);
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 211 applied'"));
    assert.match(tail, /live_family_rows/);
    assert.match(tail, /soft_deleted_rows/);
    assert.match(tail, /tgname = 'trg_project_camp_families' AND NOT tgisinternal/);
});

test('safe to re-run, pasted through the Dashboard, and the preflight speaks', () => {
    assert.doesNotMatch(CODE, /\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM\b/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /, 'the user has no CLI');
    const pre = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    assert.match(pre, /183_lock_down_camp_scoped_readers\.sql/);
    assert.match(pre, /a DIFFERENT public\.camp_families already exists/);
    const appends = pre.match(/v_missing := v_missing \|\| '(?:[^']|'')*'::text;/g) || [];
    assert.strictEqual(appends.length, 4, 'every append cast to text — text[] || literal parses as an array');
});

test('211 is a standalone paste, not a bundle entry', () => {
    assert.ok(!read('scripts/build-migration-bundle.py').includes('211_families_into_rows'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('211_families_into_rows'));
});
