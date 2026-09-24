// node --test tests/session_capacity.test.js
//
// "Sessions get overbooked" is a standard complaint about this category of
// software, and in here it had the plainest possible cause: every session
// carries a `capacity`, the dashboard asks for it and saves it, and NOTHING has
// ever read it. So a camp sets forty places, sixty families register, and since
// migration 185 all sixty are asked for a deposit — which the camp then has to
// refund, some of it past the card networks' refund window.
//
// Three things are asserted: the capacity is counted under a lock (so two
// families cannot both take the last place), a full session queues rather than
// refusing (nobody's twenty minutes of typing is thrown away), and a queued
// application owes nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Whole-line comments are prose. A rule stated only in a comment must not
// satisfy an assertion about the code.
const code = p => read(p).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');

const SQL = code('migrations/190_session_capacity.sql');
const ME = read('campistry_me.js');
const REG = read('campistry_register.html');

// ── counted, and counted safely ────────────────────────────────────────────

test('the count is taken under a row lock, before anything is written', () => {
    // Count-then-write IS the overbooking bug: two families submitting for the
    // last place both count 39 and both get in.
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.submit_public_application'));
    const lockAt = fn.indexOf('FOR UPDATE');
    const countAt = fn.indexOf('_session_taken(v_doc, v_session)');
    const writeAt = fn.indexOf('INSERT INTO camp_state_kv');
    assert.ok(lockAt > 0, 'no FOR UPDATE — the count is not serialized');
    assert.ok(countAt > lockAt, 'the count must happen after the lock is taken');
    assert.ok(writeAt > countAt, 'the write must happen after the count');
});

test('the lock is on the row the submission has to write anyway', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.submit_public_application'));
    assert.match(fn, /FROM camp_state_kv\s*\n\s*WHERE camp_id = p_camp_id AND key = 'campistryMe'\s*\n\s*FOR UPDATE;/);
});

test('a capacity of zero or absent means unlimited, never full', () => {
    // An empty box on the dashboard's session form means no limit. Reading it
    // as zero would close registration on every session that has no limit.
    assert.match(SQL, /IF COALESCE\(v_cap, 0\) > 0 THEN/);
    const state = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.session_capacity_state'));
    assert.match(state, /'full',\s*\(v_cap > 0 AND v_tak >= v_cap\)/);
    assert.match(state, /CASE WHEN v_cap > 0 THEN greatest\(0, v_cap - v_tak\) ELSE NULL END/,
        'remaining must be NULL for unlimited — a client reading 0 shows "no places left"');
});

test('a declined or withdrawn camper frees their place', () => {
    // Otherwise a waitlist can never move, which is the only reason to have one.
    const taken = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public._session_taken'));
    assert.match(taken, /IN \('applied', 'waitlisted', 'accepted', 'enrolled'\)/);
    ['declined', 'withdrawn', 'unenrolled'].forEach(st =>
        assert.ok(!new RegExp("'" + st + "'").test(taken.slice(0, taken.indexOf('$$;'))),
            st + ' must not hold a place'));
});

test('the office counts exactly the statuses the server counts', () => {
    // Two different definitions of "taken" is two different capacities.
    const fn = ME.slice(ME.indexOf('function _sessionCapacityOf('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /LIVE=\{applied:1,waitlisted:1,accepted:1,enrolled:1\}/);
    assert.match(body, /if\(!\(cap>0\)\)return null;/, 'unlimited must be null here too');
});

// ── full means queued, not refused ─────────────────────────────────────────

test('a full session waitlists the application instead of rejecting it', () => {
    assert.match(SQL, /jsonb_build_object\('status', 'waitlisted'\)/);
    const fn = SQL.slice(SQL.indexOf('IF v_taken >= v_cap THEN'));
    assert.ok(!/RETURN jsonb_build_object\('success', false/.test(fn.slice(0, 600)),
        'refusing throws away everything the family typed');
    assert.match(SQL, /'waitlisted', v_waited/, 'the caller has to be told');
});

test('a retry of a queued application is neither refused nor re-queued', () => {
    // The register page submits one call per camper and returns on the first
    // failure, so a partial success followed by a retry legitimately re-sends a
    // camper who already landed — including one already on the waitlist.
    assert.match(SQL, /IF v_status NOT IN \('applied', 'waitlisted'\) THEN/,
        "184's guard must let a waitlisted entry be re-sent");
    assert.match(SQL, /p_kind = 'enrollments' AND v_doc IS NOT NULL AND v_existing IS NULL/,
        'an existing entry is already counted and must not be queued by its own retry');
});

test('a staff application is not a place in a session', () => {
    assert.match(SQL, /IF p_kind = 'enrollments' AND/);
});

test("184's guards all survive", () => {
    // This migration REPLACES submit_public_application, so every rule 184 put
    // there has to still be there — an overwrite from an anonymous page is a
    // worse bug than an overbooked session.
    assert.match(SQL, /IF length\(p_entry_id\) < 32 THEN[\s\S]{0,120}'weak_entry_id'/);
    assert.match(SQL, /'already_processed'/);
    assert.match(SQL, /SET value = jsonb_set\(/, 'a top-level || would clobber concurrent saves');
    assert.match(SQL, /IF p_kind NOT IN \('enrollments', 'staffApplications'\) THEN/);
    assert.match(SQL, /IF NOT EXISTS \(SELECT 1 FROM camps WHERE id = p_camp_id\) THEN/);
});

// ── a queued family owes nothing ───────────────────────────────────────────

test('a waitlisted application is owed nothing, whatever the policy says', () => {
    // This is the actual money bug. Charging to hold a place that does not
    // exist is the overbooking problem turning into a refund.
    const owed = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public._registration_deposit_owed'));
    const guardAt = owed.indexOf("IF v_status = 'waitlisted' THEN");
    const readAt = owed.indexOf("v_req  := COALESCE");
    assert.ok(guardAt > 0, 'no waitlist guard on the deposit');
    assert.ok(guardAt < readAt, 'the guard must come before the amount is worked out');
    assert.match(owed.slice(guardAt, readAt), /'owed', 0/);
});

test('the entry itself carries a zero deposit, not just the RPC', () => {
    // The form reads depositRequired off the application to decide whether to
    // ask at all, so zeroing it only inside the RPC would still show the ask.
    assert.match(SQL, /jsonb_build_object\('depositRequired', 0\)/);
});

test('the deposit RPC stays off-limits to the browser', () => {
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\._registration_deposit_owed\(uuid, text\) FROM public, anon, authenticated;/);
});

test('the capacity read is anon-callable, because the form needs it first', () => {
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.session_capacity_state\(uuid\) TO anon, authenticated;/);
    // Counts only — nothing that identifies a camper.
    const state = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.session_capacity_state'),
                            SQL.indexOf('REVOKE ALL ON FUNCTION public.session_capacity_state'));
    ['camperName', 'parentEmail', 'parentName', 'families'].forEach(f =>
        assert.ok(!state.includes(f), 'session_capacity_state must not return ' + f));
});

// ── the family is told before they type, and after they submit ─────────────

test('the form asks how full each session is', () => {
    assert.match(REG, /rpc\('session_capacity_state',\{p_camp_id:campId\}\)/);
});

test('an unknown capacity reads as no limit, never as full', () => {
    // A slow or failed capacity call must not close registration.
    assert.match(REG, /var _sessCapacity=\{\};/);
    const f = REG.slice(REG.indexOf('function _isFull('));
    assert.match(f.slice(0, 160), /var c=_capOf\(name\); return !!\(c&&c\.full\);/);
});

test('a full session is marked before the family fills anything in', () => {
    assert.match(REG, /Full — you can still apply and join the waitlist/);
    assert.match(REG, /place'\+\(left===1\?'':'s'\)\+' left/);
});

test('a full session is still selectable, because applying joins the queue', () => {
    assert.match(REG, /\.ss-full\{/);
    const sel = REG.slice(REG.indexOf('window._selSess=function(i)'));
    assert.ok(!/ss-full|_isFull|full/.test(sel.slice(0, 400)),
        'blocking selection would leave a family with nothing to do but leave');
});

test('a bundle is full when any session it covers is full', () => {
    assert.match(REG, /sessionNames:names/, 'a bundle must carry the sessions it covers');
    assert.match(REG, /var full=capNames\.some\(_isFull\);/);
});

test('being queued is said on the confirmation screen, not left implied', () => {
    // "Received by the camp" alone reads as a place confirmed.
    assert.match(REG, /on the waitlist — this session filled up/);
    assert.match(REG, /Nothing has been charged/);
});

test('the local copy is corrected to match the server', () => {
    // Otherwise the status link would show `applied` for a camper the server
    // queued, and the deposit step would still ask.
    assert.match(REG, /campistryMe\.enrollments\[id\]\.status='waitlisted';/);
    assert.match(REG, /campistryMe\.enrollments\[id\]\.depositRequired=0;/);
    assert.match(REG, /if\(_wl\.length>=allCampers\.length\) _regDepStamp\.depositRequired=0;/);
});

test('the office is warned, not blocked, when it enrolls past capacity', () => {
    // A camp does squeeze one more in. It just has to be a decision.
    const fn = ME.slice(ME.indexOf('function enrollCamper(id){'));
    // 1500: enrollCamper now first points the application at its own camper
    // (by number — _rosterKeyForApplication) before the capacity check.
    const head = fn.slice(0, 1500);
    assert.match(head, /_sessionCapacityOf\(e\.session\)/);
    assert.match(head, /is full \('\+_cap\.taken\+' of '\+_cap\.capacity/);
    assert.ok(!/return;\s*\}\s*e\.status='enrolled'/.test(head.replace(/\n/g, '')) ||
              /toast\(/.test(head), 'the warning must not become a refusal');
    assert.match(head, /e\.status='enrolled';/, 'the enrollment still goes through');
});

test('the migration parses as SQL', () => {
    const { execFileSync } = require('node:child_process');
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import pglast,sys;pglast.parse_sql(open(sys.argv[1]).read());print("ok")',
            path.join(ROOT, 'migrations/190_session_capacity.sql')], { encoding: 'utf8' });
    } catch (e) {
        if (/ModuleNotFoundError/.test(String(e.stderr || ''))) return;
        throw e;
    }
    assert.match(out, /ok/);
});
