// node --test tests/enrollment_window.test.js
//
// Enrolled is a billing fact. Present is a date fact. Campistry had one flag for
// both — roster.unenrolled, set by hand — so a second-half family opened Link in
// June and got the whole portal for a child who arrives in July, and an office
// running the first half saw the second-half children in the same roster as the
// ones in front of them.
//
// This has been tried once and reverted: migration 035 gated on a stamped
// accessStart/accessEnd pair, nothing kept it in step, and 039 tore it out
// because it locked families out. So the tests that matter most here are the
// ones about what happens when something is NOT known — every unknown has to
// resolve towards access.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = p => read(p).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');

const W = require(path.join(ROOT, 'campistry_enrollment_window.js'));
const SQL = code('migrations/191_presence_gates_link.sql');
const ME = read('campistry_me.js');

// A camp with two halves, the shape dashboard.js auto-creates from campDates.
const SESSIONS = [
    { name: '1st Half', startDate: '2026-06-28', endDate: '2026-07-24' },
    { name: '2nd Half', startDate: '2026-07-26', endDate: '2026-08-21' }
];
const ENR = {
    e1: { camperName: 'Eli', session: '1st Half', status: 'enrolled' },
    e2: { camperName: 'Mia', session: '2nd Half', status: 'enrolled' },
    e3: { camperName: 'Ari', session: '1st Half', status: 'enrolled' },
    e4: { camperName: 'Ari', session: '2nd Half', status: 'enrolled' }
};
const on = (name, day, extra) => W.presenceOf(Object.assign(
    { camperName: name, enrollments: ENR, sessions: SESSIONS, on: day }, extra || {}));

// ── the case the user described ────────────────────────────────────────────

test('a second-half child is not at camp during the first half', () => {
    const p = on('Mia', '2026-07-05');
    assert.strictEqual(p.state, 'upcoming');
    assert.strictEqual(p.from, '2026-07-26');
    assert.match(W.explain(p, { name: 'Mia' }), /has not started yet.*2026-07-26/);
});

test('and is at camp the day the second half starts', () => {
    assert.strictEqual(on('Mia', '2026-07-26').state, 'active');
});

test('a first-half child is at camp in the first half and gone in the second', () => {
    assert.strictEqual(on('Eli', '2026-07-05').state, 'active');
    const gone = on('Eli', '2026-08-01');
    assert.strictEqual(gone.state, 'ended');
    assert.strictEqual(gone.to, '2026-07-24');
});

test('the last day of a session still counts as being there', () => {
    assert.strictEqual(on('Eli', '2026-07-24').state, 'active');
    assert.strictEqual(on('Eli', '2026-07-25').state, 'ended');
});

test('a child on both halves is present across the gap between them', () => {
    // They are a camper for the whole summer; the two-day changeover is not a
    // departure.
    assert.strictEqual(on('Ari', '2026-07-25').state, 'active');
    assert.strictEqual(on('Ari', '2026-06-28').state, 'active');
    assert.strictEqual(on('Ari', '2026-08-21').state, 'active');
});

test('before the summer everyone is upcoming, after it everyone has ended', () => {
    ['Eli', 'Mia', 'Ari'].forEach(n => assert.strictEqual(on(n, '2026-03-01').state, 'upcoming', n));
    ['Eli', 'Mia', 'Ari'].forEach(n => assert.strictEqual(on(n, '2026-12-01').state, 'ended', n));
});

// ── every unknown resolves towards access ──────────────────────────────────

test('a session with no dates never gates anybody', () => {
    // This is the rule that stops 039 happening again. A camp that has not
    // filled in dates must not have its families locked out.
    const p = W.presenceOf({
        camperName: 'Eli', on: '2026-01-01',
        sessions: [{ name: 'Summer' }],
        enrollments: { x: { camperName: 'Eli', session: 'Summer', status: 'enrolled' } }
    });
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.reason, 'session_has_no_dates');
});

test('an enrollment naming a session that does not exist does not gate either', () => {
    const p = W.presenceOf({
        camperName: 'Eli', on: '2026-01-01', sessions: SESSIONS,
        enrollments: { x: { camperName: 'Eli', session: 'Session That Went Away', status: 'enrolled' } }
    });
    assert.strictEqual(p.state, 'active');
});

test('dates that make no sense resolve to active, not to locked out', () => {
    const p = W.presenceOf({
        camperName: 'Eli', on: '2026-07-01',
        sessions: [{ name: 'Broken', startDate: '2026-08-01', endDate: '2026-06-01' }],
        enrollments: { x: { camperName: 'Eli', session: 'Broken', status: 'enrolled' } }
    });
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.reason, 'dates_unusable');
});

test('an undated session wins over a dated one for the same camper', () => {
    // One unconditional place at camp makes them present regardless.
    const p = W.presenceOf({
        camperName: 'Eli', on: '2026-01-01',
        sessions: [SESSIONS[0], { name: 'Year Round' }],
        enrollments: {
            a: { camperName: 'Eli', session: '1st Half', status: 'enrolled' },
            b: { camperName: 'Eli', session: 'Year Round', status: 'enrolled' }
        }
    });
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.reason, 'session_has_no_dates');
});

// ── the statuses ──────────────────────────────────────────────────────────

test('an accepted application counts as a place; a declined one does not', () => {
    const mk = st => W.presenceOf({
        camperName: 'Zed', on: '2026-07-05', sessions: SESSIONS,
        enrollments: { z: { camperName: 'Zed', session: '1st Half', status: st } }
    });
    assert.strictEqual(mk('accepted').state, 'active');
    assert.strictEqual(mk('enrolled').state, 'active');
    ['declined', 'withdrawn', 'waitlisted', 'applied'].forEach(st =>
        assert.strictEqual(mk(st).state, 'none', st));
});

test('unenrolling by hand beats the calendar', () => {
    // That flag is a decision somebody made; a date is only a circumstance.
    const p = on('Eli', '2026-07-05', { roster: { Eli: { unenrolled: true } } });
    assert.strictEqual(p.state, 'none');
    assert.strictEqual(p.reason, 'unenrolled_by_office');
});

test('a camper with no enrollment record at all is "none", not present', () => {
    const p = on('Nobody', '2026-07-05');
    assert.strictEqual(p.state, 'none');
    assert.strictEqual(p.reason, 'no_live_enrollment');
});

// ── what Link does with it ────────────────────────────────────────────────

test('a family with one child at camp gets the full portal', () => {
    const pres = W.presenceFor({ camperNames: ['Eli', 'Mia'], enrollments: ENR, sessions: SESSIONS, on: '2026-07-05' });
    assert.deepStrictEqual(pres.active, ['Eli']);
    assert.deepStrictEqual(pres.upcoming, ['Mia']);
    assert.strictEqual(W.linkAccessFor(pres), 'full');
});

test('a family whose only child starts next month gets payments, not nothing', () => {
    // This is the answer to why 039 reverted the last attempt: locking them out
    // was wrong, but so is showing them today's schedule.
    const pres = W.presenceFor({ camperNames: ['Mia'], enrollments: ENR, sessions: SESSIONS, on: '2026-07-05' });
    assert.strictEqual(W.linkAccessFor(pres), 'payments_only');
});

test('a family whose child has left also gets payments — a final bill is real', () => {
    const pres = W.presenceFor({ camperNames: ['Eli'], enrollments: ENR, sessions: SESSIONS, on: '2026-08-05' });
    assert.strictEqual(W.linkAccessFor(pres), 'payments_only');
});

test('a family with no children at all gets nothing', () => {
    const pres = W.presenceFor({ camperNames: ['Nobody'], enrollments: ENR, sessions: SESSIONS, on: '2026-07-05' });
    assert.strictEqual(W.linkAccessFor(pres), 'none');
});

// ── the roster picker ─────────────────────────────────────────────────────

test('the picker offers today, everyone, and each session in date order', () => {
    const opts = W.pickerOptions(SESSIONS, { on: '2026-07-05' });
    assert.deepStrictEqual(opts.map(o => o.value),
        ['today', 'all', 'session:1st Half', 'session:2nd Half']);
    assert.strictEqual(opts[0].on, '2026-07-05');
});

test('"today" shows who is actually here; "all" shows everyone enrolled', () => {
    const args = { camperNames: ['Eli', 'Mia', 'Ari'], enrollments: ENR, sessions: SESSIONS, on: '2026-07-05' };
    assert.deepStrictEqual(W.filterNames('today', args).sort(), ['Ari', 'Eli']);
    assert.deepStrictEqual(W.filterNames('all', args).sort(), ['Ari', 'Eli', 'Mia']);
});

test('picking a session means WHO IS ON IT, not who is there that day', () => {
    // A different question, and conflating them would put a first-half camper
    // in the second-half list whenever the dates touched.
    const args = { camperNames: ['Eli', 'Mia', 'Ari'], enrollments: ENR, sessions: SESSIONS, on: '2026-07-05' };
    assert.deepStrictEqual(W.filterNames('session:2nd Half', args).sort(), ['Ari', 'Mia']);
    assert.deepStrictEqual(W.filterNames('session:1st Half', args).sort(), ['Ari', 'Eli']);
});

// ── the server agrees with the client ─────────────────────────────────────

test('the SQL recognises the same four states and the same statuses', () => {
    // Two definitions of "at camp" is worse than either one alone.
    ['active', 'upcoming', 'ended', 'none'].forEach(st =>
        assert.ok(SQL.includes("'" + st + "'"), 'SQL has no ' + st + ' state'));
    assert.match(SQL, /IN \('enrolled', 'accepted'\)/);
    assert.match(SQL, /unenrolled_by_office/);
});

test('the SQL resolves every unknown towards access too', () => {
    assert.match(SQL, /IF v_doc IS NULL THEN\s*\n\s*v_state := 'active'; v_reason := 'no_camp_document';/);
    assert.match(SQL, /'session_has_no_dates'/);
    assert.match(SQL, /v_state := 'active'; v_reason := 'no_enrollment_record';/);
    // And the filter hands back everything if presence could not be worked out.
    const f = SQL.slice(SQL.indexOf('link_filter_present_campers'));
    assert.match(f, /Could not work it out|COALESCE\(p_names, '\[\]'::jsonb\),\s*\n\s*'data',\s*COALESCE\(p_data/);
});

test('the SQL uses the SAME span rule, not per-session coverage', () => {
    // This is the one place the two implementations could silently diverge: with
    // per-session coverage, a both-halves camper disappears on the changeover day
    // on the server while the office page still shows them.
    assert.match(SQL, /min\(s_from\)\s+AS first_from/);
    assert.match(SQL, /max\(s_to\)\s+AS last_to/);
    assert.match(SQL, /bool_or\(s_from IS NULL\)\s+AS open_start/);
    assert.match(SQL, /bool_or\(s_to\s+IS NULL\)\s+AS open_end/);
    assert.match(SQL, /'between_sessions'/, 'the gap between halves must be its own reason');
    assert.match(SQL, /IF \(v_from IS NULL OR v_on >= v_from\) AND \(v_to IS NULL OR v_on <= v_to\) THEN/);
});

test('the SQL nullifies a start-after-end pair, exactly as the module does', () => {
    assert.match(SQL, /CASE WHEN a\.a IS NOT NULL AND a\.b IS NOT NULL AND a\.a > a\.b/);
    // And the module: both ends dropped, so it gates nobody.
    const w = W.sessionWindow({ name: 'X', startDate: '2026-08-01', endDate: '2026-06-01' });
    assert.deepStrictEqual({ from: w.from, to: w.to }, { from: null, to: null });
    assert.strictEqual(w.unusable, true);
});

test('an undated session sorts first in the SQL too', () => {
    assert.match(SQL, /ORDER BY \(s_from IS NOT NULL\), s_from/);
});

test('every reason the module can give, the SQL can give too', () => {
    // Divergent vocabularies would make the parent app label one thing and the
    // office page another.
    const MODULE_REASONS = ['unenrolled_by_office', 'no_live_enrollment',
        'session_has_no_dates', 'dates_unusable', 'in_session', 'between_sessions',
        'session_not_started', 'session_finished'];
    const modSrc = read('campistry_enrollment_window.js');
    MODULE_REASONS.forEach(r => assert.ok(modSrc.includes("'" + r + "'"), 'module lost ' + r));
    // dates_unusable is folded into session_has_no_dates server-side, by
    // nullifying the pair before it is ever compared — asserted above.
    MODULE_REASONS.filter(r => r !== 'dates_unusable')
        .forEach(r => assert.ok(SQL.includes("'" + r + "'"), 'SQL has no ' + r));
});

test('presence is derived from the session, never from a stamped window', () => {
    // 035 stamped accessStart/accessEnd onto each camper and nothing kept them
    // in step. Nothing here reads either field.
    assert.ok(!/accessStart|accessEnd/.test(SQL),
        'a stamped window is what migration 039 had to revert');
    assert.match(SQL, /s\.value ->> 'startDate'/);
    assert.match(SQL, /s\.value ->> 'endDate'/);
});

// ── the parent is told, and not locked out ────────────────────────────────

test('all three Link entry points filter by presence', () => {
    ['get_my_camps', 'get_parent_data_by_user', 'claim_parent_invite'].forEach(fn => {
        const at = SQL.indexOf('FUNCTION public.' + fn);
        assert.ok(at > 0, fn + ' is not redefined');
        const body = SQL.slice(at, SQL.indexOf('GRANT EXECUTE ON FUNCTION public.' + fn, at));
        assert.match(body, /link_filter_present_campers/, fn + ' does not filter by presence');
    });
});

test('payments-only is a success, not an error', () => {
    // Returning no_active_session for a second-half family in June is exactly
    // the lockout 039 reverted.
    ['get_parent_data_by_user', 'claim_parent_invite'].forEach(fn => {
        const at = SQL.indexOf('FUNCTION public.' + fn);
        const body = SQL.slice(at, SQL.indexOf('GRANT EXECUTE ON FUNCTION public.' + fn, at));
        assert.match(body, /WHEN jsonb_array_length\(filtered->'absent'\) > 0 THEN 'payments_only'/, fn);
        assert.match(body, /IF v_access = 'none' THEN/,
            fn + ': only a family with NO children may be refused');
    });
});

test('the absent children come back with their reason, so the app can say why', () => {
    assert.match(SQL, /'campers_absent', f\.absent/);
    assert.match(SQL, /'campers_absent', filtered->'absent'/);
    assert.match(SQL, /'absent', v_absent/);
});

test("124's own rules survive the rewrite", () => {
    // 191 replaces all three functions, so everything they already guarded has
    // to still be there.
    const camps = SQL.slice(SQL.indexOf('FUNCTION public.get_my_camps'));
    assert.match(camps, /i\.status = 'active' OR i\.billing_access = true/);
    assert.match(camps, /i\.expires_at IS NULL OR i\.expires_at > now\(\)/);
    assert.match(camps, /'camp_connected', i\.camp_connected/);
    const claim = SQL.slice(SQL.indexOf('FUNCTION public.claim_parent_invite'));
    assert.match(claim, /'already_claimed'/);
    assert.match(claim, /'invalid_or_expired'/);
    assert.match(claim, /UPDATE link_parent_invites SET user_id = caller/);
});

test('the presence RPCs are not reachable from a browser', () => {
    // camper_presence takes a camp id and a list of names and says which of
    // those children are at camp. The entry points call it internally.
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.camper_presence\(uuid, jsonb, date\) FROM public, anon, authenticated;/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.link_filter_present_campers\(uuid, jsonb, jsonb, date\) FROM public, anon, authenticated;/);
});

test('the old pass-through filter is left alone rather than quietly changed', () => {
    // link_filter_active_campers has other callers; redefining what they do
    // without looking at them is how the last attempt went wrong.
    assert.ok(!/CREATE OR REPLACE FUNCTION public\.link_filter_active_campers/.test(SQL));
});

// ── the office side ───────────────────────────────────────────────────────

test('the roster defaults to who is in camp today', () => {
    assert.match(ME, /var _rosterWhen='today';/);
});

test('the roster filters by the picker and says how many it is hiding', () => {
    const fn = ME.slice(ME.indexOf('function renderCampers(filter)'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    // Anchored on the GUARD, not just the call: a call sitting inside a
    // disabled branch is not a filter.
    //
    // The slice is read through _rosterWhenDefault() rather than off the variable
    // directly, so that a plan for 2nd Half opens the roster on 2nd Half. Both the
    // guard and the call must use that SAME resolved value — reading one from the
    // resolver and the other from the raw variable is how a picker ends up naming
    // one session and listing another.
    assert.match(body, /var _whenNow=_rosterWhenDefault\(\);/,
        'the slice must be resolved once, into a local');
    assert.match(body, /if\(_pres&&_W&&_whenNow!=='all'\)\{[\s\S]{0,400}_W\.filterNames\(_whenNow,/);
    assert.doesNotMatch(body, /_W\.filterNames\(_rosterWhen,/,
        'the filter must not read the raw variable past the resolver');
    assert.match(body, /enrolledEntries=enrolledEntries\.filter\(function\(pair\)\{return !!_keep\[pair\[0\]\]\}\)/,
        'the filtered list has to replace the one that gets rendered');
    assert.match(body, /_hiddenByWhen=_before-enrolledEntries\.length/);
    assert.match(body, /not in this slice/,
        'a roster silently N children short is what an office notices in September');
});

test('the picker and the filter use ONE date', () => {
    // Deriving it twice is how a session picker shows a list that does not match
    // the session it names.
    assert.match(ME, /p\.on=on;\s*\/\/ published/);
    const fn = ME.slice(ME.indexOf('function renderCampers(filter)'));
    assert.match(fn.slice(0, 4000), /on:_pres\.on/);
});

test('the picker is not drawn when no session has dates', () => {
    const fn = ME.slice(ME.indexOf('function renderCampers(filter)'));
    assert.match(fn.slice(0, 8000), /_datedCount>0/);
});

test('the module is loaded by the page that uses it', () => {
    assert.match(read('campistry_me.html'), /campistry_enrollment_window\.js/);
    assert.match(ME, /setRosterWhen:setRosterWhen/, 'the picker cannot call its own setter');
});

test('the migration parses as SQL', () => {
    const { execFileSync } = require('node:child_process');
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import pglast,sys;pglast.parse_sql(open(sys.argv[1]).read());print("ok")',
            path.join(ROOT, 'migrations/191_presence_gates_link.sql')], { encoding: 'utf8' });
    } catch (e) {
        if (/ModuleNotFoundError/.test(String(e.stderr || ''))) return;
        throw e;
    }
    assert.match(out, /ok/);
});

test('two campers who share a name: each is present by their own enrollment, by number', () => {
    const W2 = require('../campistry_enrollment_window.js');
    const sessions = [
        { name: 'July', startDate: '2026-07-01', endDate: '2026-07-31' },
        { name: 'August', startDate: '2026-08-01', endDate: '2026-08-31' },
    ];
    // Both enrollments say "Rivka Stern"; the numbers tell them apart.
    const enrollments = {
        a: { camperName: 'Rivka Stern', camperId: 701, session: 'July', status: 'enrolled' },
        b: { camperName: 'Rivka Stern', camperId: 702, session: 'August', status: 'enrolled' },
        old: { camperName: 'Old Timer', session: 'July', status: 'enrolled' },
    };
    const roster = { 'Rivka Stern': { camperId: 701 }, 'Rivka Stern #702': { camperId: 702 }, 'Old Timer': {} };
    const on = '2026-07-15';
    assert.strictEqual(W2.presenceOf({ camperName: 'Rivka Stern', enrollments, sessions, roster, on }).state, 'active');
    assert.strictEqual(W2.presenceOf({ camperName: 'Rivka Stern #702', enrollments, sessions, roster, on }).state, 'upcoming',
        '#702 is on August only — July belongs to #701');
    assert.strictEqual(W2.presenceOf({ camperName: 'Rivka Stern', camperId: 702, enrollments, sessions, roster, on }).state, 'upcoming',
        'a number given decides, whatever the name');
    assert.strictEqual(W2.presenceOf({ camperName: 'Old Timer', enrollments, sessions, roster, on }).state, 'active',
        'an enrollment with no number still matches by name');
});
