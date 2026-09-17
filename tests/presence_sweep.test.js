// node --test tests/presence_sweep.test.js
//
// Migration 191 made the PARENT side presence-aware and put a session picker on
// the Roster page. Everything else in the app still enumerated campers on the
// `unenrolled` flag alone, so during the first half the second-half children were
// in the bunk generator, on the printed roster, on the MEDICATION AND ALLERGY
// SHEET, in attendance, on the canteen till, in broadcast audiences, in the head
// count, on the counsellor app's bunk list, in the badge count and on the
// birthday card.
//
// campistry_presence.js is the one adapter that answers "is this camper here
// today" from any page. The property that matters most, and most of what is
// asserted below: WHEN IT CANNOT TELL, EVERYONE IS PRESENT. A missing child on a
// bunk list is a child nobody counts at pickup; a spare name is a name somebody
// crosses off.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = p => read(p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── the adapter, behaviourally ─────────────────────────────────────────────
// Loaded into a throwaway global so the module's window-attachment works.
function loadAdapter() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = { warn() {} };
    const vm = require('node:vm');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(read('campistry_enrollment_window.js'), ctx);
    vm.runInContext(read('campistry_presence.js'), ctx);
    return sandbox;
}

const SESSIONS = [
    { name: '1st Half', startDate: '2026-06-28', endDate: '2026-07-24' },
    { name: '2nd Half', startDate: '2026-07-26', endDate: '2026-08-21' }
];
const ENR = {
    a: { camperName: 'Eli', session: '1st Half', status: 'enrolled' },
    b: { camperName: 'Mia', session: '2nd Half', status: 'enrolled' }
};

test('with no state at all, everybody is present and it says why', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    assert.strictEqual(p.isHere('Anyone'), true);
    assert.strictEqual(p.stateOf('Anyone').reason, 'no_camp_state');
    assert.strictEqual(p.hasDates(), false);
});

test('with no rule module loaded, everybody is present', () => {
    // A page that forgot the script tag must degrade to an un-gated list, never
    // to an empty one.
    const sandbox = {}; sandbox.window = sandbox; sandbox.console = { warn() {} };
    const vm = require('node:vm');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(read('campistry_presence.js'), ctx);
    const p = sandbox.CampistryPresence;
    assert.strictEqual(p.hasRule(), false);
    assert.strictEqual(p.isHere('Anyone'), true);
    assert.strictEqual(p.stateOf('Anyone').reason, 'rule_not_loaded');
});

test('injected state decides who is here, on the right date', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    p.provide({ roster: { Eli: {}, Mia: {} }, enrollments: ENR, sessions: SESSIONS });
    assert.strictEqual(p.hasDates(), true);
    assert.deepStrictEqual(p.filter(['Eli', 'Mia'], '2026-07-05'), ['Eli']);
    assert.deepStrictEqual(p.filter(['Eli', 'Mia'], '2026-08-05'), ['Mia']);
});

test('filter accepts Object.entries pairs, which is what half these lists are', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    p.provide({ roster: {}, enrollments: ENR, sessions: SESSIONS });
    const pairs = [['Eli', { bunk: 'A' }], ['Mia', { bunk: 'B' }]];
    assert.deepStrictEqual(p.filter(pairs, '2026-07-05').map(x => x[0]), ['Eli']);
});

test('an empty injection does NOT gate — it is the cold-cache case', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    p.provide({ roster: {}, enrollments: {}, sessions: [] });
    assert.strictEqual(p.hasDates(), false);
    assert.deepStrictEqual(p.filter(['Eli', 'Mia'], '2026-07-05'), ['Eli', 'Mia']);
});

test('undated sessions gate nobody, even with full state', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    p.provide({
        roster: {}, sessions: [{ name: 'Summer' }],
        enrollments: { x: { camperName: 'Eli', session: 'Summer', status: 'enrolled' } }
    });
    assert.strictEqual(p.hasDates(), false);
    assert.deepStrictEqual(p.filter(['Eli'], '2026-01-01'), ['Eli']);
});

test('absent() and summary() explain the gap rather than leaving it silent', () => {
    const s = loadAdapter();
    const p = s.CampistryPresence;
    p.provide({ roster: {}, enrollments: ENR, sessions: SESSIONS });
    const away = p.absent(['Eli', 'Mia'], '2026-07-05');
    // Joined rather than deep-compared: absent() builds its array inside the vm
    // sandbox, so it is a different realm's Array and deepStrictEqual fails on
    // the prototype rather than on anything that matters.
    assert.strictEqual(Array.from(away).map(a => a.name + ':' + a.presence.state).join(','),
                       'Mia:upcoming');
    assert.match(p.summary(['Eli', 'Mia'], '2026-07-05'), /1 not arrived yet/);
    assert.strictEqual(p.summary(['Eli'], '2026-07-05'), '', 'nothing to say when nobody is away');
});

test('the roster is read from BOTH homes, because pages disagree about where it lives', () => {
    // Me keeps it at campistryMe.roster; every other page reads app1.camperRoster.
    // Only the `unenrolled` flags are wanted, so both are merged.
    const s = loadAdapter();
    s.loadGlobalSettings = function () {
        return {
            app1: { camperRoster: { Eli: { unenrolled: true }, Mia: {} } },
            campistryMe: { enrollments: ENR, sessions: SESSIONS }
        };
    };
    s.CampistryPresence.provide(null);
    assert.strictEqual(s.CampistryPresence.isHere('Eli', '2026-07-05'), false,
        'the unenrolled flag on app1.camperRoster must be honoured');
});

// ── the cold-start index ───────────────────────────────────────────────────

test('the compact index stands in for enrollments on a cold page', () => {
    const s = loadAdapter();
    s.loadGlobalSettings = function () {
        return {
            app1: {},
            campistryMe: {
                // No enrollments: integration_hooks strips them from the snapshot.
                presenceIndex: {
                    Eli: [{ s: '1st Half', f: '2026-06-28', t: '2026-07-24' }],
                    Mia: [{ s: '2nd Half', f: '2026-07-26', t: '2026-08-21' }]
                }
            }
        };
    };
    s.CampistryPresence.provide(null);
    assert.strictEqual(s.CampistryPresence.hasDates(), true);
    assert.deepStrictEqual(s.CampistryPresence.filter(['Eli', 'Mia'], '2026-07-05'), ['Eli']);
    assert.deepStrictEqual(s.CampistryPresence.filter(['Eli', 'Mia'], '2026-08-05'), ['Mia']);
});

test('real enrollments win over the index when both are present', () => {
    const s = loadAdapter();
    s.loadGlobalSettings = function () {
        return {
            app1: {},
            campistryMe: {
                enrollments: ENR, sessions: SESSIONS,
                // Deliberately contradictory: if this were preferred, Eli would
                // read as present in August.
                presenceIndex: { Eli: [{ s: 'X', f: '2026-01-01', t: '2026-12-31' }] }
            }
        };
    };
    s.CampistryPresence.provide(null);
    assert.strictEqual(s.CampistryPresence.isHere('Eli', '2026-08-05'), false);
});

test('integration_hooks builds the index, and builds it BEFORE the strip', () => {
    // Built after the delete and it would always be empty.
    const src = read('integration_hooks.js');
    const buildAt = src.indexOf('lite.campistryMe.presenceIndex = _idx');
    const stripAt = src.indexOf('delete lite.campistryMe.enrollments');
    assert.ok(buildAt > 0, 'no presence index is built');
    assert.ok(stripAt > buildAt, 'the index is built after enrollments are deleted');
    // Only live places, and only spans — no family data, no money, no addresses.
    const block = src.slice(src.indexOf('const _enr ='), stripAt);
    assert.match(block, /e\.status !== 'enrolled' && e\.status !== 'accepted'/);
    assert.match(block, /\{ s: e\.session \|\| '', f: w\.f, t: w\.t \}/);
    assert.match(block, /catch \(e\)/, 'this must never fail a state write');
});

// ── every surface, wired ───────────────────────────────────────────────────

const WIRED = {
    'campistry_live.js': ['_presentOnly', 'getRoster'],
    'campistry_live_locator.js': ['_presentOnly', 'getRoster'],
    'campistry_health.js': ['CampistryPresence', 'getRoster'],
    'campistry_snacks.js': ['_snacksPresenceGate', 'here: _here'],
    'campistry_snacks_pos.js': ['CampistryPresence', 'here: _here'],
    'campistry_lite.js': ['CampistryPresence', 'camp.rosterAll'],
    'badges.js': ['CampistryPresence'],
    'campistry_birthdays.js': ['CampistryPresence'],
};

test('every swept file consults presence', () => {
    Object.entries(WIRED).forEach(([file, needles]) => {
        const src = code(file);
        needles.forEach(n => assert.ok(src.includes(n), file + ' is missing ' + n));
    });
});

test('attendance and the locator filter at their single roster source', () => {
    ['campistry_live.js', 'campistry_live_locator.js'].forEach(f => {
        const src = code(f);
        assert.match(src, /function getRoster\(\) \{ var g = readGlobal\(\); return _presentOnly\(/,
            f + ': the filter must be at the one place the roster is resolved');
        const fn = src.slice(src.indexOf('function _presentOnly'));
        assert.match(fn.slice(0, 400), /if \(!P \|\| !P\.hasDates\(\)\) return all;/,
            f + ': no dates must mean no filtering');
    });
});

test('the health page keeps its unenrolled test AND gains presence', () => {
    // It was the only file of the seven already filtering; neither test may be
    // lost, because they mean different things.
    const src = code('campistry_health.js');
    const fn = src.slice(src.indexOf('function getRoster()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if\(all\[n\]\.unenrolled\) return;/);
    assert.match(body, /if\(gate && !P\.isHere\(n\)\) return;/);
    assert.match(body, /gate = !!\(P && P\.hasDates\(\)\)/);
});

test('the canteen FLAGS presence and does not filter the account list', () => {
    // rosterNames is built from this list to decide which accounts are still on
    // the roster. Filtering it by presence would make a first-half camper's
    // account look orphaned in August, with their money still in it.
    const src = code('campistry_snacks.js');
    assert.match(src, /here: _here/);
    const listFn = src.slice(src.indexOf('function getCamperList('), src.indexOf('function loadSnacksData'));
    // `_here` may be READ as a property value and nothing else. Any use of it as
    // a guard — a filter, an early return, a continue — turns this membership
    // list into a presence list and orphans August's accounts.
    const uses = [...listFn.matchAll(/_here\b/g)].map(m => listFn.slice(Math.max(0, m.index - 30), m.index + 8));
    assert.ok(uses.length >= 2, 'expected _here to be set and used');
    uses.forEach(u => assert.ok(!/(if\s*\(|return|continue|!)\s*$|!_here/.test(u),
        'getCamperList must not drop absent campers — membership is not presence: ' + u.trim()));
    assert.ok(!/\.filter\([^)]*isHere/.test(listFn));
    assert.match(src, /const rosterNames = new Set\(camperList\.map/,
        'the orphan check still reads the whole list');
});

test('the canteen does not open a wallet for a camper who has not arrived', () => {
    const src = code('campistry_snacks.js');
    const gates = src.match(/if \(_snacksPresenceGate\(\) && !window\.CampistryPresence\.isHere\(name\)\) return;/g) || [];
    assert.strictEqual(gates.length, 2, 'both wallet-creation loops must be gated');
});

test('Lite filters the bunk roster but keeps the full one to hand', () => {
    const src = code('campistry_lite.js');
    assert.match(src, /camp\.rosterAll = camp\.roster;/,
        'the unfiltered roster must stay available, not be thrown away');
    assert.match(src, /if \(_P\.hasDates\(\)\)/, 'no dates must mean no filtering');
    assert.match(src, /catch \(e\) \{ console\.warn\('\[Lite\] presence filter skipped:/,
        'a counsellor must never lose their bunk list to a thrown error');
});

test('badges asks for campistryMe, or its filter would be a no-op', () => {
    const src = code('badges.js');
    assert.match(src, /\.in\("key", \["app1", "bunkMetaData", "campistryMe"\]\)/);
    assert.match(src, /if \(P\.hasDates\(\)\) names = names\.filter\(n => P\.isHere\(n\)\)/);
});

test('birthdays gates on presence and still skips campers with no date of birth', () => {
    const src = code('campistry_birthdays.js');
    assert.match(src, /if \(!c\.dob\) return;/);
    assert.match(src, /if \(_gate && !_P\.isHere\(name\)\) return;/);
    assert.match(src, /catch \(e\) \{ _gate = false; \}/, 'a failure must un-gate, not empty the card');
});

// ── the Me page's own lists ───────────────────────────────────────────────

const ME = read('campistry_me.js');

test('the Me page has one presence helper its lists share', () => {
    assert.match(ME, /function _hereToday\(name\)\{/);
    assert.match(ME, /function _presenceMatters\(\)\{/);
    const fn = ME.slice(ME.indexOf('function _hereToday(name){'));
    assert.match(fn.slice(0, 400), /if\(!W\)return true;/,
        'no rule module must mean everybody is here');
});

test('the bunk generator will not put an absent camper in a bunk', () => {
    const i = ME.indexOf('var pool=Object.keys(roster).filter(function(n){');
    assert.ok(i > 0);
    assert.match(ME.slice(i, i + 220), /if\(_gate&&!_hereToday\(n\)\)return false;/);
    assert.match(ME, /var _gate=_presenceMatters\(\);/);
});

test('the fallback pool and the unplaced report agree with it', () => {
    // Otherwise "unplaced" counts every camper the generator was right to skip.
    assert.match(ME, /!ambiguousSkipped\[n\]&&\(!_gateLeft\|\|_hereToday\(n\)\)/);
    assert.match(ME, /report\.unplaced=Object\.keys\(roster\)\.filter\(function\(n\)\{return !roster\[n\]\.bunk&&!roster\[n\]\.unenrolled&&\(!_gateLeft\|\|_hereToday\(n\)\)/);
});

test('the roster export gains BOTH filters — it had neither', () => {
    assert.match(ME, /return !c\.unenrolled&&\(!_gateCsv\|\|_hereToday\(n\)\)/);
});

test('the medication and allergy sheet gains both too', () => {
    // The most safety-critical list this app prints, and it had no roster filter
    // of any kind.
    assert.match(ME, /\(c\.allergies\|\|c\.medications\|\|c\.dietary\)&&!c\.unenrolled&&\(!_gateMed\|\|_hereToday\(n\)\)/);
});

test('both broadcast audiences are scoped to campers who are here', () => {
    assert.match(ME, /entry\[1\]\.division===audience&&\(!_gateB\|\|_hereToday\(entry\[0\]\)\)/);
    assert.match(ME, /c\.division===broadcast\.to&&\(!_gateB2\|\|_hereToday\(n\)\)/);
});

test('the head-count tile counts who is here, and renames itself when it does', () => {
    // A tile labelled "Campers on Roster" showing a presence-filtered number
    // would be a third thing that is neither.
    assert.match(ME, /statTile\(_presenceMatters\(\)\?'Campers in Camp Today':'Campers on Roster'/);
});

test('the Me page hands its live state to the adapter rather than reading a snapshot of itself', () => {
    assert.match(ME, /window\.CampistryPresenceState=function\(\)\{/);
    assert.match(ME, /return \{roster:roster,enrollments:enrollments,sessions:sessions\};/);
});

// ── the script tags ───────────────────────────────────────────────────────

test('every host page loads the rule and the adapter', () => {
    const PAGES = ['campistry_me.html', 'campistry_live.html', 'campistry_health.html',
                   'campistry_snacks.html', 'campistry_snacks_pos.html',
                   'campistry_lite.html', 'dashboard.html', 'flow.html'];
    PAGES.forEach(page => {
        const src = read(page);
        assert.match(src, /campistry_enrollment_window\.js/, page + ' is missing the rule');
        assert.match(src, /campistry_presence\.js/, page + ' is missing the adapter');
    });
});

test('the adapter loads AFTER the rule on every page', () => {
    // The adapter reads window.CampistryEnrollmentWindow lazily, so order is not
    // strictly required — but a page that loads them the other way round is a
    // page somebody will later "fix" by making the dependency eager.
    ['campistry_me.html', 'campistry_live.html', 'campistry_health.html',
     'campistry_snacks.html', 'campistry_snacks_pos.html', 'dashboard.html',
     'flow.html', 'campistry_lite.html'].forEach(page => {
        const src = read(page);
        assert.ok(src.indexOf('campistry_enrollment_window.js') < src.indexOf('campistry_presence.js'),
            page + ' loads the adapter before the rule');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// AS OF WHEN. A plan for 2nd Half shares the one live roster with live, because
// campers are never copied into a plan — so without this it would show whoever
// is at camp TODAY to an office building next half's bunks and bus routes. The
// date moves instead of the data.
// ───────────────────────────────────────────────────────────────────────────

/** The adapter, in a sandbox that is inside a plan. */
function loadInPlan(workspace, session) {
    const s = loadAdapter();
    s.campistryWorkspace = () => workspace;
    s.campistryWorkspaceSession = () => session;
    s.CampistryPresence.refresh();
    return s;
}

test('in live, the as-of date is really today', () => {
    const s = loadInPlan('live', '');
    const p = s.CampistryPresence;
    p.provide({ roster: {}, enrollments: ENR, sessions: SESSIONS });
    const info = p.asOfInfo();
    assert.strictEqual(info.reason, 'live');
    assert.strictEqual(info.session, '');
    assert.strictEqual(info.on, p.today());
});

test('a plan for 2nd Half shows 2nd Half’s campers, not today’s', () => {
    // The whole point. Eli is 1st Half only, Mia is 2nd Half only.
    const s = loadInPlan('second_half', '2nd Half');
    const p = s.CampistryPresence;
    p.provide({ roster: { Eli: {}, Mia: {} }, enrollments: ENR, sessions: SESSIONS });

    const info = p.asOfInfo();
    assert.strictEqual(info.reason, 'sandbox_session');
    assert.strictEqual(info.session, '2nd Half');
    assert.strictEqual(info.on, '2026-07-26', 'it reads as of the session start');

    // And the defaults follow it, with no date passed by the caller.
    assert.strictEqual(p.isHere('Mia'), true);
    assert.strictEqual(p.isHere('Eli'), false, '1st-half-only must not be in a 2nd-half plan');
    assert.strictEqual(p.filter(['Eli', 'Mia']).join(','), 'Mia');
});

test('a plan for 1st Half still shows 1st Half in the middle of the summer', () => {
    // The other direction, which is the "look back at what we did" case.
    const s = loadInPlan('archive_20260726_090000', '1st Half');
    const p = s.CampistryPresence;
    p.provide({ roster: { Eli: {}, Mia: {} }, enrollments: ENR, sessions: SESSIONS });
    assert.strictEqual(p.asOfInfo().on, '2026-06-28');
    assert.strictEqual(p.filter(['Eli', 'Mia']).join(','), 'Eli');
});

test('a camper on BOTH halves is in every plan', () => {
    const s = loadInPlan('second_half', '2nd Half');
    const p = s.CampistryPresence;
    p.provide({
        roster: { Eli: {}, Mia: {}, Both: {} },
        enrollments: Object.assign({}, ENR, {
            c: { camperName: 'Both', session: '1st Half', status: 'enrolled' },
            d: { camperName: 'Both', session: '2nd Half', status: 'enrolled' }
        }),
        sessions: SESSIONS
    });
    assert.strictEqual(p.isHere('Both'), true);
    assert.strictEqual(p.filter(['Eli', 'Mia', 'Both']).join(','), 'Mia,Both');
});

test('an explicit date still wins over the plan', () => {
    // Callers that pass a date mean it — the picker on the Roster page is one.
    const s = loadInPlan('second_half', '2nd Half');
    const p = s.CampistryPresence;
    p.provide({ roster: {}, enrollments: ENR, sessions: SESSIONS });
    assert.deepStrictEqual(p.filter(['Eli', 'Mia'], '2026-07-05'), ['Eli']);
});

test('every way of not knowing falls back to today, never to an empty list', () => {
    // The safety property, restated for the new code path: each of these is a
    // plan we cannot resolve a date for, and each must show a real roster.
    const cases = [
        ['a plan with no session on it', 'second_half', '', 'sandbox_no_session'],
        ['a session that is not in the camp state', 'second_half', 'Ghost', 'session_not_found']
    ];
    cases.forEach(([why, ws, ses, reason]) => {
        const s = loadInPlan(ws, ses);
        const p = s.CampistryPresence;
        p.provide({ roster: { Eli: {}, Mia: {} }, enrollments: ENR, sessions: SESSIONS });
        const info = p.asOfInfo();
        assert.strictEqual(info.reason, reason, why);
        assert.strictEqual(info.on, p.today(), why + ' must read as of today');
    });

    // A session that exists but carries no dates cannot move the date either.
    const s = loadInPlan('third', 'Undated');
    const p = s.CampistryPresence;
    p.provide({
        roster: { Eli: {} }, enrollments: ENR,
        sessions: SESSIONS.concat([{ name: 'Undated', startDate: '', endDate: '' }])
    });
    assert.strictEqual(p.asOfInfo().reason, 'session_undated');
    assert.strictEqual(p.asOfInfo().on, p.today());
});

test('a page with no workspace layer at all behaves exactly as before', () => {
    // Most pages do not load integration_hooks' workspace helpers. Asking for
    // them must not throw, and must not gate.
    const s = loadAdapter();                    // no campistryWorkspace defined
    const p = s.CampistryPresence;
    p.provide({ roster: { Eli: {} }, enrollments: ENR, sessions: SESSIONS });
    assert.strictEqual(p.asOfInfo().reason, 'live');
    assert.strictEqual(p.asOfInfo().on, p.today());
});

test('refresh() drops the as-of date, not just the state', () => {
    // Re-dating a session, or switching plans in the same page, must not keep
    // answering for the old one.
    const s = loadAdapter();
    const p = s.CampistryPresence;
    let ws = 'live', ses = '';
    s.campistryWorkspace = () => ws;
    s.campistryWorkspaceSession = () => ses;
    p.provide({ roster: {}, enrollments: ENR, sessions: SESSIONS });
    assert.strictEqual(p.asOfInfo().on, p.today());

    ws = 'second_half'; ses = '2nd Half';
    p.refresh();
    assert.strictEqual(p.asOfInfo().on, '2026-07-26', 'refresh must recompute the as-of date');
});

test('the summary says which session it is talking about', () => {
    // "3 already finished" invites "finished by when?" — in a plan the answer is
    // the session being planned, not today.
    const s = loadInPlan('second_half', '2nd Half');
    const p = s.CampistryPresence;
    p.provide({ roster: { Eli: {}, Mia: {} }, enrollments: ENR, sessions: SESSIONS });
    const line = p.summary(['Eli', 'Mia']);
    assert.match(line, /already finished/, 'Eli is done before 2nd Half starts');
    assert.match(line, /as of 2nd Half/);
    // Not added when the caller named its own date — it would be a lie.
    assert.doesNotMatch(p.summary(['Eli', 'Mia'], '2026-07-05'), /as of/);
});

test('Go filters its Me-derived roster, and only that one', () => {
    const GO = code('campistry_go.js');
    assert.match(GO, /function _presentOnly\(all\)/, 'Go needs the filter');
    assert.match(GO, /return _presentOnly\(meRoster\)/,
        'the Me-derived roster must be filtered on the way out');
    // Go standalone is deliberately its own world: a CSV import has no
    // enrollments behind it, so there is nothing to be absent from.
    assert.match(GO, /if \(Object\.keys\(_goStandaloneRoster\)\.length > 0\) return _goStandaloneRoster;/,
        'the standalone roster must NOT be presence-filtered');
    // The camperId backfill runs over everyone, filtered or not.
    const fn = GO.slice(GO.indexOf('function getRoster()'));
    const backfill = fn.indexOf('c.camperId = nextId');
    const ret = fn.indexOf('return _presentOnly(meRoster)');
    assert.ok(backfill > 0 && ret > backfill,
        'ids must be backfilled before the roster is narrowed');
});
