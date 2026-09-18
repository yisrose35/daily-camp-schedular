// node --test tests/applications_table.test.js
//
// Migration 200: a public submission stops rewriting the whole camp.
//
// WHAT WAS WRONG. submit_public_application was correct and did not scale. Every
// submission took SELECT ... FOR UPDATE on the ONE camp_state_kv row keyed
// (camp_id,'campistryMe') and rewrote its entire jsonb value. jsonb has no partial
// update, so a multi-megabyte TOASTed value is rewritten whole, per family. A few
// hundred families registering the hour a camp opens is a fully serialised queue
// that gets slower as it goes, on the same row every payment webhook also rewrites.
//
// There is no database here, so this reads the SQL. That is weaker than running it
// and it is not nothing: the things that would break this are all visible in the
// text — a lock that is still camp-wide, a count that double-counts, a blob write
// that crept back in, a grant that opens the table to anon.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/200_applications_out_of_the_blob.sql');
const ME = read('campistry_me.js');
const MERGE = read('campistry_finance_merge.js');

/**
 * The SQL with its prose removed.
 *
 * Every "must NOT contain" assertion below runs against this, not the raw file.
 * This migration's header explains at length why it does not take a camp-wide
 * FOR UPDATE and why there is no claimed flag — so a test searching the raw text
 * for those very phrases fails on the explanation of why they are absent.
 */
function codeOnly(sql) {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */ and the doc comments
        .replace(/--[^\n]*/g, ' ');            // -- to end of line
}
const CODE = codeOnly(SQL);

/** One CREATE OR REPLACE FUNCTION body out of the file. */
function fn(name) {
    const a = SQL.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in the migration');
    const b = SQL.indexOf('\nREVOKE ALL ON FUNCTION public.' + name, a);
    const end = b > a ? b : SQL.indexOf('\n-- ───', a);
    assert.ok(end > a, 'cannot find the end of ' + name);
    return SQL.slice(a, end);
}

// ── the burst no longer touches the camp's row ─────────────────────────────

test('the submission writes a ROW, not the camp blob', () => {
    const body = fn('submit_public_application');
    assert.match(body, /INSERT INTO public\.camp_applications/);
    // The whole point: no write to camp_state_kv anywhere in it.
    assert.ok(!/INSERT INTO camp_state_kv|UPDATE camp_state_kv/.test(codeOnly(body)),
        'the submission still writes the camp blob — the burst is not fixed');
});

test('the blob is still READ, for capacity and for what the office holds', () => {
    // Removing the read would break both the capacity check and the
    // already-processed guard, so this is a read that has to stay.
    const body = fn('submit_public_application');
    assert.match(body, /SELECT value INTO v_doc\s*\n\s*FROM camp_state_kv/);
    assert.ok(!/FOR UPDATE/.test(codeOnly(body)),
        'the camp-wide row lock is back — every submission would serialise again');
});

test('the lock is per (camp, session), not per camp', () => {
    // 190's guarantee is kept: two families racing for the last place in one
    // session still serialise. What changes is that a family registering for the
    // OTHER half, and every payment webhook in flight, no longer queue behind them.
    const body = fn('submit_public_application');
    assert.match(body, /pg_advisory_xact_lock\(\s*\n?\s*hashtext\(p_camp_id::text \|\| '\|' \|\| v_session\)\)/);
    // Registrations only — a staff application is not a place in a session.
    assert.match(body, /IF p_kind = 'enrollments' AND v_session IS NOT NULL THEN\s*\n\s*PERFORM pg_advisory_xact_lock/);
    // And before anything is counted, or the count is the overbooking bug again.
    assert.ok(body.indexOf('pg_advisory_xact_lock') < body.indexOf('_session_taken_all'),
        'the lock must be taken before the count');
});

test('every guard 083/184/190 added is still there', () => {
    const body = fn('submit_public_application');
    [['invalid_payload', /jsonb_typeof\(p_entry\) <> 'object'/],
     ['invalid_kind', /p_kind NOT IN \('enrollments', 'staffApplications'\)/],
     ['camp_not_found', /NOT EXISTS \(SELECT 1 FROM camps WHERE id = p_camp_id\)/],
     ['weak_entry_id', /length\(p_entry_id\) < 32/],
     ['submission_too_large', /pg_column_size\(p_entry\) > 8388608/],
     ['already_processed', /'already_processed'/]].forEach(([why, re]) => {
        assert.match(body, re, why + ' is no longer guarded');
    });
});

test('the already-processed guard checks BOTH homes, blob winning', () => {
    // The table for anything submitted since 200, the blob for everything before it
    // and anything the office has since absorbed and acted on. The office's decision
    // is the newer fact, so it wins — otherwise a guessed id could re-open an
    // accepted camper's record from an anonymous page.
    const body = fn('submit_public_application');
    const fromTable = body.indexOf('FROM public.camp_applications a');
    const fromBlob = body.indexOf("v_doc -> p_kind -> p_entry_id ->> 'status'");
    assert.ok(fromTable > 0 && fromBlob > fromTable,
        'the blob check must come second so it overrides the table');
    assert.match(body, /v_status NOT IN \('applied', 'waitlisted'\)/);
});

test('a retry can re-send, and cannot reopen a processed application', () => {
    // The row-level repeat of the same guard, so a race cannot slip past the
    // in-function check.
    const body = fn('submit_public_application');
    assert.match(body, /ON CONFLICT \(camp_id, kind, entry_id\) DO UPDATE/);
    assert.match(body,
        /WHERE public\.camp_applications\.status IN \('applied', 'waitlisted'\)/);
});

test('the waitlist behaviour is unchanged', () => {
    // 190's judgement: a full session queues the family rather than throwing away
    // twenty minutes of their evening, and a waitlisted place owes nothing.
    const body = fn('submit_public_application');
    assert.match(body, /'status', 'waitlisted'/);
    assert.match(body, /'waitlistedAt'/);
    assert.match(body, /'depositRequired', 0/);
    assert.match(body, /v_waited := true/);
    // Unlimited stays unlimited.
    assert.match(body, /IF COALESCE\(v_cap, 0\) > 0 THEN/);
});

// ── counting, without double counting ─────────────────────────────────────

test('the count adds the table to the blob and excludes what is in both', () => {
    // The naive version double-counts every absorbed application and under-fills
    // every session.
    const body = fn('_session_taken_all');
    assert.match(body, /public\._session_taken\(p_doc, p_session\)/,
        'the blob half of the count is gone');
    assert.match(body,
        /AND NOT coalesce\(p_doc -> 'enrollments', '\{\}'::jsonb\) \? a\.entry_id/,
        'a row the office already holds would be counted twice');
    // Registrations only, and only the statuses that occupy a place.
    assert.match(body, /a\.kind = 'enrollments'/);
    assert.match(body, /a\.status IN \('applied', 'waitlisted', 'accepted', 'enrolled'\)/);
});

test('absorption is DERIVED, never flagged', () => {
    // A claimed_at column set by a fetch whose save then failed is an application in
    // neither place — the exact failure this migration exists to remove.
    assert.ok(!/claimed/.test(CODE),
        'a claimed flag is back; read the header before adding one');
    // The reasoning is in the header, which is prose and so survives codeOnly.
    assert.match(SQL, /absorption is DERIVED, not recorded/);
});

test('the public form and the submission agree about fullness', () => {
    // Two counts that can disagree is how a family is told there is room and then
    // waitlisted anyway.
    const state = fn('session_capacity_state');
    assert.match(state, /public\._session_taken_all\(p_camp_id, v_doc, v_s ->> 'name'\)/);
    assert.ok(!/public\._session_taken\(v_doc/.test(codeOnly(state)),
        'the capacity screen is still on the blob-only count');
    // Unlimited reports null, not a number a form could render as "0 places left".
    assert.match(state, /CASE WHEN v_cap > 0 THEN greatest\(0, v_cap - v_tak\) ELSE NULL END/);
});

// ── the table itself ──────────────────────────────────────────────────────

test('one row per submission, keyed so a retry updates rather than duplicates', () => {
    assert.match(SQL, /PRIMARY KEY \(camp_id, kind, entry_id\)/);
    assert.match(SQL, /CHECK \(kind IN \('enrollments', 'staffApplications'\)\)/);
    assert.match(SQL, /REFERENCES public\.camps\(id\) ON DELETE CASCADE/);
});

test('the capacity count has an index it can actually use', () => {
    // Without it the count is a sequential scan over every application in the camp,
    // inside a lock, on the hot path.
    assert.match(SQL,
        /CREATE INDEX IF NOT EXISTS camp_applications_capacity_idx[\s\S]{0,160}WHERE kind = 'enrollments'/);
    assert.match(SQL, /\(camp_id, session, status\)/);
});

test('the session is denormalised out of the payload', () => {
    // So the count is an index scan rather than a jsonb walk over every row.
    assert.match(SQL, /\n    session      text,/);
    assert.match(SQL, /NULLIF\(btrim\(COALESCE\(p_entry ->> 'session', ''\)\), ''\)/);
});

test('anon can write only through the function, and read nothing', () => {
    // The lesson of 083 and 184, applied from the start this time.
    assert.match(SQL, /ALTER TABLE public\.camp_applications ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /REVOKE ALL ON TABLE public\.camp_applications FROM anon, authenticated/);
    // Anchored to the end of the statement: `TO authenticated` also matches
    // `TO authenticated, anon`, which is the one grant that must never appear.
    assert.match(CODE, /GRANT SELECT ON TABLE public\.camp_applications TO authenticated;/);
    assert.ok(!/GRANT[^;]*ON TABLE public\.camp_applications[^;]*anon/.test(CODE),
        'the table is granted to anon — a family could read every application');
    // A SELECT policy for staff, and no write policy at all.
    assert.match(SQL, /CREATE POLICY camp_applications_read[\s\S]{0,200}FOR SELECT TO authenticated/);
    assert.ok(!/FOR INSERT|FOR UPDATE TO|FOR DELETE|FOR ALL/.test(CODE),
        'a write policy would let a client bypass the function that holds the guards');
    // The submit RPC stays anon-callable — that is the whole point of a public form.
    assert.match(SQL,
        /GRANT EXECUTE ON FUNCTION public\.submit_public_application\(uuid, text, text, jsonb\) TO anon, authenticated/);
});

test('the office reader is camp-scoped through 183’s own helper', () => {
    const body = fn('get_camp_applications');
    assert.match(body, /public\.camp_staff_member\(p_camp_id\)/,
        'any signed-in user of any camp could read this camp’s applications');
    assert.ok(!/is_camp_member/.test(CODE),
        'that helper does not exist — the check would throw and the reader would fail closed, loudly, but wrongly');
    // Not anon: a family reads their own status through 113, never the table.
    assert.match(SQL,
        /GRANT EXECUTE ON FUNCTION public\.get_camp_applications\(uuid, text, timestamptz, integer\) TO authenticated/);
    assert.ok(!/get_camp_applications\(uuid, text, timestamptz, integer\) TO anon/.test(SQL));
});

test('the reader is bounded, so one camp cannot ask for everything', () => {
    const body = fn('get_camp_applications');
    assert.match(body, /LIMIT greatest\(1, least\(coalesce\(p_limit, 2000\), 5000\)\)/);
    assert.match(body, /STABLE/, 'a read-only function should say so');
});

test('the reader marks nothing — it is a read', () => {
    const body = codeOnly(fn('get_camp_applications'));
    assert.ok(!/UPDATE|INSERT|DELETE/.test(body),
        'the reader writes, which is how a failed save loses applications');
});

// ── the backfill ──────────────────────────────────────────────────────────

test('everything already in a blob becomes a row', () => {
    // So the count is complete from the first minute and no camp has to be
    // migrated by hand.
    assert.match(SQL, /INSERT INTO public\.camp_applications[\s\S]{0,900}FROM camp_state_kv kv/);
    assert.match(SQL, /CROSS JOIN \(VALUES \('enrollments'\), \('staffApplications'\)\)/);
    assert.match(SQL, /ON CONFLICT \(camp_id, kind, entry_id\) DO NOTHING/,
        're-running the file would overwrite a status the office has since set');
});

test('a backfilled application keeps its own age', () => {
    // now() would make every historical application read as submitted the moment
    // the migration ran, which breaks submission order — and a waitlist IS an order.
    assert.match(SQL, /COALESCE\(\(e\.value ->> 'appliedTime'\)::timestamptz,/);
    assert.match(SQL, /\(e\.value ->> 'appliedDate'\)::timestamptz,\s*\n\s*kv\.updated_at,/);
});

test('the file says it is standalone and idempotent', () => {
    // The user has no Supabase CLI: every migration is pasted by hand, and 180+ are
    // deliberately not in APPLY_BUNDLE.
    assert.match(SQL, /Standalone — not in APPLY_BUNDLE\.sql/);
    assert.match(SQL, /Idempotent/);
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS/);
    const bundle = read('migrations/APPLY_BUNDLE.sql');
    assert.ok(bundle.indexOf('200_applications_out_of_the_blob') < 0,
        '200 must not be in the bundle');
});

// ── the client drains it ──────────────────────────────────────────────────

test('the office’s hydration drains the table into enrollments', () => {
    // Without this the rows arrive and nothing on any page can see them — the
    // recurring defect in this project, applied to a whole table.
    assert.match(ME, /\nasync function _drainApplications\(\)\{/);
    assert.match(ME, /client\.rpc\('get_camp_applications',\{p_camp_id:campId,p_kind:kind\}\)/);
    assert.match(ME, /\n        try\{ _drainApplications\(\); \}catch\(_\)\{\}/,
        'the drain is never called');
});

test('the drain reuses the ONE merge, rather than a second opinion', () => {
    // mergePublicSubmissions already answers both questions that matter: local wins
    // on an id we hold, and a tombstoned id stays deleted.
    const a = ME.indexOf('async function _drainApplications(){');
    const body = ME.slice(a, ME.indexOf('/**', a + 10));
    assert.match(body, /M\.mergePublicSubmissions\(local,cloud\)/);
    assert.match(body, /local\.deletedIds=deletedIds;/,
        'without the tombstones the drain resurrects every deleted application');
    // And the rule's own closed list, not a copy of it.
    assert.match(body, /M\.PUBLIC_KINDS/);
    assert.ok(ME.indexOf('_APP_KINDS') < 0, 'a second list of the public kinds is back');
    assert.match(MERGE, /M\.PUBLIC_KINDS = \['enrollments', 'staffApplications'\]/);
});

test('the drain does not save, and does re-render', () => {
    // Saving would push the whole blob back up — the very write this migration
    // exists to stop doing once per application. The next ordinary save carries
    // them anyway; what the office needs now is to SEE them.
    const a = ME.indexOf('async function _drainApplications(){');
    const body = ME.slice(a, ME.indexOf('/**', a + 10));
    assert.ok(!/\bsave\(\)/.test(body), 'the drain saves, undoing the point of 200');
    assert.match(body, /try\{ render\(curPage\); \}catch\(_\)\{\}/);
});

test('a camp that has not pasted 200 behaves exactly as before', () => {
    const a = ME.indexOf('async function _drainApplications(){');
    const body = ME.slice(a, ME.indexOf('/**', a + 10));
    assert.match(body, /if\(res&&res\.error\)\{/);
    assert.match(body, /continue;/);
    // No client, no camp id, no merge module: all no-ops, never a thrown error on
    // a page that is only trying to load.
    assert.match(body, /if\(!M\|\|typeof M\.mergePublicSubmissions!=='function'\)return 0;/);
    assert.match(body, /if\(!client\|\|typeof client\.rpc!=='function'\|\|!campId\)return 0;/);
    assert.match(body, /catch\(e\)\{/);
});

test('the drain is fired, not awaited, during hydration', () => {
    // A page load must not wait on a network call to show anything.
    const a = ME.indexOf('staffApplications=me.staffApplications||{};');
    const body = ME.slice(a, a + 420);
    assert.match(body, /try\{ _drainApplications\(\); \}catch\(_\)\{\}/);
    assert.ok(!/await _drainApplications/.test(ME), 'hydration blocks on the network');
});
