// node --test tests/session_scope_wiring.test.js
//
// campistry_session_scope.js is proved by tests/session_scope.test.js. This file
// proves the master key actually turns something — that the pin is read and written,
// that presence follows it (which is what carries the scope to every list in the app
// without touching those pages), that the dashboard is the only place it is set, and
// that the two surfaces which answer for RIGHT NOW are deliberately left alone.
//
// There is no UI beyond the dashboard card. A bar on every page was tried and removed:
// it was noise, and the per-person override it carried went with it rather than
// staying as an API nothing can call.
//
// The runtime helpers run for real in a vm. The rest is asserted against the source,
// anchored so that `if(false)` cannot satisfy it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HOOKS = read('integration_hooks.js');
const PRESENCE = read('campistry_presence.js');
const DASH = read('dashboard.js');
const DASH_HTML = read('dashboard.html');
const ME = read('campistry_me.js');
const S = require(path.join(ROOT, 'campistry_session_scope.js'));
const W = require(path.join(ROOT, 'campistry_enrollment_window.js'));

S.useWindowRule(W);

const H1 = { name: '1st Half', startDate: '2026-06-28', endDate: '2026-07-19' };
const H2 = { name: '2nd Half', startDate: '2026-07-20', endDate: '2026-08-09' };

// ── the runtime resolver, run for real ────────────────────────────────────

/**
 * The block of integration_hooks.js that owns the pin, the peek and the memo,
 * executed against a fake window and a fake sessionStorage.
 */
function loadRuntime(opts) {
    opts = opts || {};
    const from = HOOKS.indexOf('    var _scopeCache = null, _scopeAt = 0');
    const to = HOOKS.indexOf('    window.loadGlobalSettings = function(key) {', from);
    assert.ok(from > 0, 'cannot find the scope runtime — re-anchor this test');
    assert.ok(to > from);

    const store = Object.assign({}, opts.sessionStorage || {});
    const settings = {
        campistryMe: { sessions: opts.sessions || [H1, H2] }
    };
    if (opts.pin !== undefined) settings.campSession = opts.pin;

    const win = {};
    const box = {
        console,
        window: win,
        sessionStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: k => { delete store[k]; }
        },
        getLocalSettings: () => settings,
        log: () => {},
        CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; },
        // A stand-in for the workspace global defined earlier in the same file.
        __ws: opts.workspaceSession || ''
    };
    box.window = box;                    // the file says `window.x = ...` on itself
    box.CampistrySessionScope = opts.noRule ? undefined : S;
    box.campistryWorkspaceSession = () => box.__ws;
    box.campistryWorkspace = () => (box.__ws ? 'ws_plan' : 'live');
    box.dispatchEvent = () => {};
    box.addEventListener = () => {};
    box.CampistryPresence = { refresh: () => { box.__presenceRefreshed = true; } };

    vm.runInContext(HOOKS.slice(from, to), vm.createContext(box));
    box.__store = store;
    return box;
}

test('with nothing stored, the runtime follows the calendar', () => {
    const w = loadRuntime({});
    const sc = w.campistrySessionScope({ today: '2026-08-01' });
    assert.strictEqual(sc.session, '2nd Half');
    assert.strictEqual(sc.source, 'calendar');
});

test('the pin is read from campSession, as an object OR a bare string', () => {
    // It is written as {session}, but a hand-edited row or an older shape should not
    // silently mean "no pin" — that would look exactly like the pin being ignored.
    assert.strictEqual(loadRuntime({ pin: { session: '2nd Half' } })
        .campistrySessionScope({ today: '2026-07-01' }).source, 'pin');
    assert.strictEqual(loadRuntime({ pin: '2nd Half' })
        .campistrySessionScope({ today: '2026-07-01' }).source, 'pin');
    assert.strictEqual(loadRuntime({ pin: { session: '' } })
        .campistrySessionScope({ today: '2026-07-01' }).source, 'calendar');
});

test('a planning sandbox still wins over the pin at runtime', () => {
    const w = loadRuntime({ pin: { session: '1st Half' }, workspaceSession: '2nd Half' });
    const sc = w.campistrySessionScope({ today: '2026-07-01' });
    assert.strictEqual(sc.source, 'workspace');
    assert.strictEqual(sc.session, '2nd Half');
});

test('the answer is memoized, and the refresh throws the memo away', () => {
    // Presence asks this once per camper inside page loops; resolving walks the
    // session list. But a memo nobody can clear is a stale answer forever.
    const w = loadRuntime({});
    const a = w.campistrySessionScope();
    const b = w.campistrySessionScope();
    assert.strictEqual(a, b, 'the same object should come back');
    const c = w.campistrySessionScopeRefresh();
    assert.notStrictEqual(a, c, 'the refresh must recompute');
});

test('passing an explicit today bypasses the memo', () => {
    // Otherwise a caller asking about a specific date would get whatever was cached
    // for a different one.
    const w = loadRuntime({});
    w.campistrySessionScope();
    assert.strictEqual(w.campistrySessionScope({ today: '2026-07-01' }).session, '1st Half');
    assert.strictEqual(w.campistrySessionScope({ today: '2026-08-01' }).session, '2nd Half');
});

test('without the rule module it answers "no session, as of today" and says so', () => {
    // A page that does not load the rule must lose the feature and nothing else.
    const w = loadRuntime({ noRule: true });
    const sc = w.campistrySessionScope();
    assert.strictEqual(sc.session, '');
    assert.strictEqual(sc.source, 'none');
    assert.strictEqual(sc.ruleMissing, true, 'callers need to tell this apart from a real answer');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sc.on), 'the date must still be usable');
});

test('the short helpers agree with the full answer', () => {
    const w = loadRuntime({ pin: { session: '2nd Half' } });
    const sc = w.campistrySessionScope();
    assert.strictEqual(w.campistrySession(), sc.session);
    assert.strictEqual(w.campistrySessionAsOf(), sc.on);
});

test('a broken settings blob resolves to unscoped rather than throwing', () => {
    const from = HOOKS.indexOf('    var _scopeCache = null, _scopeAt = 0');
    const to = HOOKS.indexOf('    window.loadGlobalSettings = function(key) {', from);
    const box = { console, log: () => {}, CampistrySessionScope: S };
    box.window = box;
    box.sessionStorage = { getItem: () => { throw new Error('blocked'); },
                           setItem: () => {}, removeItem: () => {} };
    box.getLocalSettings = () => { throw new Error('not hydrated'); };
    box.campistryWorkspaceSession = () => '';
    vm.runInContext(HOOKS.slice(from, to), vm.createContext(box));
    const sc = box.campistrySessionScope({ today: '2026-08-01' });
    assert.strictEqual(sc.source, 'none');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sc.on));
});

// ── presence follows it, which carries the scope everywhere ───────────────

test('presence asks the master key FIRST, before its own sandbox logic', () => {
    // This is the multiplier. Every list in the app already goes through isHere() /
    // filter() / asOf(), so routing the date here scopes the canteen, Health, Go,
    // Live and the print centre without editing any of them.
    const a = PRESENCE.indexOf('function _asOfCompute()');
    const body = PRESENCE.slice(a, PRESENCE.indexOf('P.asOf =', a));
    const scope = body.indexOf("typeof root.campistrySessionScope === 'function'");
    const sandbox = body.indexOf('root.campistryWorkspace === ');
    assert.ok(scope > 0, 'presence does not consult the master key at all');
    assert.ok(sandbox > scope, 'the sandbox fallback must come AFTER the master key');
    assert.match(body, /out\.on = sc\.on \|\| out\.on;/,
        'the resolved date is not used, so nothing would actually move');
});

test('presence records WHICH source moved the date', () => {
    // A caller logging this wants to know whether the date moved because of a plan, a
    // pin, a peek or the calendar — four different conversations.
    const a = PRESENCE.indexOf('function _asOfCompute()');
    const body = PRESENCE.slice(a, PRESENCE.indexOf('P.asOf =', a));
    assert.match(body, /out\.reason = 'scope_' \+ \(sc\.source \|\| 'none'\)/);
});

test('presence keeps the sandbox path for a page without the scope', () => {
    const a = PRESENCE.indexOf('function _asOfCompute()');
    const body = PRESENCE.slice(a, PRESENCE.indexOf('P.asOf =', a));
    assert.match(body, /out\.reason = 'sandbox_session';/,
        'the old path is gone — a page without the scope would lose sandbox scoping');
    assert.match(body, /if \(sc && !sc\.ruleMissing\)/,
        'a ruleMissing answer must fall through, not be taken as the truth');
});

test('presence still exposes the REAL today, unshifted', () => {
    // A till and a counsellor's phone need "now" whatever the office is planning.
    assert.match(PRESENCE, /P\.today = function \(\) \{/);
    const a = PRESENCE.indexOf('P.today = function ()');
    const body = PRESENCE.slice(a, a + 300);
    assert.ok(!/campistrySessionScope|asOf/.test(body),
        'today() must not be routed through the scope');
});

// ── the dashboard sets it ────────────────────────────────────────────────

test('the dashboard has the master-key card, and it is the first one', () => {
    const card = DASH_HTML.indexOf('id="currentSessionCard"');
    const dates = DASH_HTML.indexOf('id="campDatesForm"');
    assert.ok(card > 0, 'there is no master-key card');
    assert.ok(card < dates, 'it belongs above the dates it is derived from');
    ['currentSessionPick', 'currentSessionExplain', 'currentSessionActions',
     'currentSessionStatus', 'saveCurrentSessionBtn'].forEach(id => {
        assert.ok(DASH_HTML.indexOf('id="' + id + '"') > 0, id + ' is missing');
    });
    assert.match(DASH_HTML, /onclick="saveCurrentSession\(\)"/);
});

test('saving "Follow the calendar" stores NOTHING, not today’s answer', () => {
    // Writing the derived answer into the pin would freeze it, which is the entire
    // failure this design exists to avoid — the same reasoning that deleted
    // migrations 035/039's stamped date windows.
    const a = DASH.indexOf('window.saveCurrentSession = async function');
    const body = DASH.slice(a, DASH.indexOf('window.clearCampDates', a));
    assert.match(body, /var value = \(chosen === 'auto'\) \? \{ session: '' \} : \{ session: chosen \};/,
        'auto must clear the pin, never write a session name into it');
});

test('the pin is owner-only, at the writer and not just in the UI', () => {
    // This moves what every person in the camp sees, including the front desk
    // checking children in. A disabled dropdown is not a permission.
    const a = DASH.indexOf('window.saveCurrentSession = async function');
    const body = DASH.slice(a, DASH.indexOf('window.clearCampDates', a));
    assert.match(body, /if \(isTeamMember\) \{/);
    assert.match(body, /Only camp owners can change the current session/);
    const guard = body.indexOf('if (isTeamMember)');
    const write = body.indexOf('camp_state_kv');
    assert.ok(guard < write, 'the guard must come before the write');
});

test('the pin goes to camp_state_kv AND the local cache', () => {
    // Cloud alone would leave this page and every other tab describing the old
    // answer until the next hydration.
    const a = DASH.indexOf('window.saveCurrentSession = async function');
    const body = DASH.slice(a, DASH.indexOf('window.clearCampDates', a));
    assert.match(body, /key: 'campSession', value: value/);
    assert.match(body, /saveGlobalSettings\('campSession', value\)/);
    assert.match(body, /campistrySessionScopeRefresh\(\)/, 'the memo would keep the old answer');
    assert.match(body, /CampistryPresence\.refresh\(\)/, 'presence memoizes its own date');
});

test('the card is drawn from the dates it derives from', () => {
    const a = DASH.indexOf('async function loadCampDates(');
    const body = DASH.slice(a, DASH.indexOf('function buildWeekMap(', a));
    assert.match(body, /\n        try \{ window\.renderCurrentSession\(\); \} catch \(_e\) \{\}/,
        'the card would keep naming whichever session used to cover today');
});

test('a camp with fewer than two sessions is told in words, not given an empty picker', () => {
    const a = DASH.indexOf('window.renderCurrentSession = function');
    const body = DASH.slice(a, DASH.indexOf('window.saveCurrentSession', a));
    assert.match(body, /if \(named\.length < 2\) \{/);
    assert.match(body, /there is nothing to choose/);
    assert.ok(!/options/.test(body.slice(body.indexOf('if (named.length < 2)'),
        body.indexOf('if (pick) pick.style.display = \'\';'))),
        'no picker is built for a camp with nothing to pick');
});

test('the card hides itself when the rule did not load', () => {
    // Rather than offering a control that would not take effect anywhere.
    const a = DASH.indexOf('window.renderCurrentSession = function');
    const body = DASH.slice(a, DASH.indexOf('window.saveCurrentSession', a));
    assert.match(body, /if \(!R\) \{[\s\S]{0,400}card\.style\.display = 'none';/);
});

// ── the bar makes it visible ──────────────────────────────────────────────

// ── which pages get it ───────────────────────────────────────────────────

const OFFICE = ['campistry_live.html', 'flow.html', 'campistry_snacks.html',
                'campistry_me.html', 'campistry_health.html', 'campistry_go.html',
                'dashboard.html'];
// A till and a counsellor's phone answer "who is in front of me RIGHT NOW". That is
// not the same question as "what session is the office working on", and following a
// planning pin there would gate a real child's snack on a roster for next month.
const NOW_ONLY = ['campistry_snacks_pos.html', 'campistry_lite.html'];

test('every office page loads the rule, cache-busted', () => {
    OFFICE.forEach(p => {
        const h = read(p);
        const rule = h.indexOf('src="campistry_session_scope.js');
        assert.ok(rule > 0, p + ' does not load the rule');
        assert.match(h.slice(rule, rule + 60), /\?v=/, p + ' needs a cache-bust');
    });
});

test('no page loads a session bar \u2014 it was removed, not just hidden', () => {
    // Removed rather than left in and unreferenced: a bar file sitting in the repo is
    // one somebody re-adds in six months wondering why it is not wired up.
    const fs2 = require('node:fs');
    assert.ok(!fs2.existsSync(path.join(ROOT, 'campistry_session_bar.js')),
        'the bar file is back');
    OFFICE.concat(NOW_ONLY).forEach(p => {
        assert.ok(read(p).indexOf('campistry_session_bar') < 0, p + ' still loads a bar');
    });
});

test('nothing refers to the removed per-person peek', () => {
    // It was reachable only from the bar, so keeping it would have left an API with
    // no caller — the exact shape of defect this codebase keeps finding.
    ['campistry_session_scope.js', 'integration_hooks.js', 'campistry_presence.js',
     'dashboard.js'].forEach(f => {
        const src = read(f);
        ['campistrySetPeekSession', 'campistryPeekSession', 'campistry_peek_session',
         'campSession:', 'campSource'].forEach(sym => {
            assert.ok(src.indexOf(sym) < 0, f + ' still refers to ' + sym);
        });
    });
});

test('the rule loads after the window rule it delegates to', () => {
    OFFICE.forEach(p => {
        const h = read(p);
        const win = h.indexOf('src="campistry_enrollment_window.js');
        const rule = h.indexOf('src="campistry_session_scope.js');
        assert.ok(win > 0, p + ' does not load the window rule');
        assert.ok(win < rule, p + ': the window rule must load first');
    });
});

test('the till and the phone are deliberately left on "now"', () => {
    NOW_ONLY.forEach(p => {
        const h = read(p);
        assert.ok(h.indexOf('campistry_session_bar.js') < 0,
            p + ' should not carry the session bar — it answers for right now');
        assert.ok(h.indexOf('campistry_session_scope.js') < 0,
            p + ' should not follow a planning pin');
    });
});

// ── the Me roster defaults from it ────────────────────────────────────────

test('the roster opens on whatever session the program is showing', () => {
    // This was the one place with a session picker, and it used to consult only a
    // sandbox — so a camp pinned to 2nd Half saw next half everywhere and today here.
    const a = ME.indexOf('function _rosterWhenDefault(){');
    const body = ME.slice(a, ME.indexOf('function _paginate(', a));
    assert.match(body, /window\.campistrySessionScope==='function'/);
    assert.match(body, /return 'session:'\+sc\.session;/);
    const scope = body.indexOf('campistrySessionScope');
    const sandbox = body.indexOf('asOfInfo');
    assert.ok(sandbox > scope, 'the sandbox read must be the fallback, not the first answer');
});

test('an unscoped camp keeps the roster default it always had', () => {
    // A camp between halves must not be shown an empty roster.
    const a = ME.indexOf('function _rosterWhenDefault(){');
    const body = ME.slice(a, ME.indexOf('function _paginate(', a));
    assert.match(body, /sc\.source!=='none'/);
});

test('a person who touches the picker is still obeyed', () => {
    const a = ME.indexOf('function _rosterWhenDefault(){');
    const body = ME.slice(a, ME.indexOf('function _paginate(', a));
    assert.match(body, /if\(_rosterWhenTouched\)return _rosterWhen;/,
        'the default must never override an explicit choice');
    assert.ok(body.indexOf('if(_rosterWhenTouched)') < body.indexOf('campistrySessionScope'),
        'the touched check comes first');
});

// ── printed sheets follow it too ──────────────────────────────────────────

test('a print sheet filters campers by session, not just by `unenrolled`', () => {
    // This is the worst place in the app to be wrong: a bunk sign-in sheet is what a
    // counsellor physically carries, and a name on it for a child who is not at camp
    // this half gets called at roll and marked absent.
    const a = ME.indexOf('function psFilteredCampers(sheet){');
    const body = ME.slice(a, ME.indexOf('function psGroupVal(', a));
    assert.match(body, /_W\.filterNames\(psWhoWhen\(sheet\)/,
        'the sheet does not consult presence at all');
    assert.match(body, /camperRows=camperRows\.filter\(function\(r\)\{return !!keep\[r\[0\]\]\}\)/,
        'the filter is computed and then not applied');
    // Staff are NOT session-filtered, and this checks the LINE rather than its
    // position: a counsellor is not enrolled in a session, so putting them through an
    // enrolment filter would empty the staff half of every sheet.
    assert.ok(body.indexOf(
        "if(who!=='campers')rows=rows.concat(hiredStaff().map(_psStaffAsRow));") > 0,
        'the staff rows must reach the sheet unfiltered');
    assert.ok(body.indexOf('_W.filterNames') < body.indexOf("if(who!=='campers')"),
        'the session filter belongs to the camper rows only');
});

test('a print sheet with no stored choice follows the camp', () => {
    // Stored would freeze it: a sheet holding 'session:1st Half' from June would still
    // print 1st Half in August, which is the same failure the pin's expiry prevents.
    const a = ME.indexOf('function psWhoWhen(sheet){');
    const body = ME.slice(a, ME.indexOf('function psFilteredCampers(', a));
    assert.match(body, /if\(v\)return v;/);
    assert.match(body, /return _rosterWhenDefault\(\);/,
        'the default must resolve through the master key, not be stored');
});

test('a sheet that wants everybody can still say so', () => {
    // A family directory or an end-of-summer mailing list is a real use, and it takes
    // the same vocabulary as the roster picker so there is one language for this.
    const a = ME.indexOf("var _sesOpts=");
    const body = ME.slice(a, a + 1400);
    assert.match(body, /value="all"/);
    assert.match(body, /value="today"/);
    assert.match(body, /'session:'\+x\.name/);
    assert.match(body, /Follow the camp/);
    // A substring, not a regex: the handler is emitted inside a JS string literal, so
    // the source carries escaped quotes and a regex for it is all backslashes and no
    // signal.
    assert.ok(body.indexOf("psSetProp(\\''+je(s.id)+'\\',\\'whoWhen\\'") > 0,
        'the control is not wired to the sheet');
});

test('the sheet list says which campers it prints, without opening it', () => {
    const a = ME.indexOf('var _whenLabel=');
    assert.ok(a > 0, 'the summary line does not mention the session scope');
    const body = ME.slice(a, a + 500);
    assert.match(body, /_whenLabel\?' · '\+_whenLabel:''/);
});

test('a page without the presence rule prints what it always printed', () => {
    const a = ME.indexOf('function psFilteredCampers(sheet){');
    const body = ME.slice(a, ME.indexOf('function psGroupVal(', a));
    assert.match(body, /if\(_W&&typeof _W\.filterNames==='function'\)\{/,
        'without the rule the sheet must fall back to the whole roster, not to nobody');
});

// ── a session out of its own dates is choosable, and said out loud ────────

test('the runtime honours a pin to a session that is over', () => {
    // The end-to-end shape of the case the first version broke: a camp in September
    // tidying up 2nd Half. Run for real, through the settings blob, not asserted
    // against the rule in isolation.
    const w = loadRuntime({ pin: { session: '2nd Half' } });
    const sc = w.campistrySessionScope({ today: '2026-09-30' });
    assert.strictEqual(sc.source, 'pin');
    assert.strictEqual(sc.session, '2nd Half');
    assert.strictEqual(sc.pinDropped, false);
    assert.strictEqual(sc.outOfSeason, true);
    assert.strictEqual(sc.ended, true);
    // And the date that every list keys off is that session's, not today's.
    assert.strictEqual(w.campistrySessionAsOf(), sc.on);
    assert.strictEqual(sc.on, '2026-07-20');
});

test('the runtime honours a pin before the summer starts', () => {
    const w = loadRuntime({ pin: { session: '1st Half' } });
    const sc = w.campistrySessionScope({ today: '2026-05-01' });
    assert.strictEqual(sc.source, 'pin');
    assert.strictEqual(sc.on, '2026-06-28');
    assert.strictEqual(sc.ended, false);
});

test('nothing in the dashboard picker marks a session as a mistake', () => {
    // An option tagged "(ended)" is an option nobody picks, and picking a finished
    // session is the whole point of being able to tidy one up.
    const a = DASH.indexOf('window.renderCurrentSession = function');
    const body = DASH.slice(a, DASH.indexOf('window.saveCurrentSession', a));
    assert.ok(!/\(ended\)/.test(body), 'the discouraging tag is back');
    assert.ok(!/o\.expired/.test(body), 'the picker still reads a field the rule dropped');
    // It shows the dates instead, which is information.
    assert.match(body, /_dashFmtShort\(o\.from\)/);
    assert.match(body, /o\.to \? ' to ' \+ _dashFmtShort\(o\.to\)/);
});

test('the dashboard states it when the shown session is not today’s', () => {
    const a = DASH.indexOf('window.renderCurrentSession = function');
    const body = DASH.slice(a, DASH.indexOf('window.saveCurrentSession', a));
    assert.match(body, /R\.outOfSeasonNotice\(sc, _dashFmtShort\)/,
        'nothing tells the office it is looking at another session, or the notice ' +
        'prints raw ISO dates beside a dropdown that does not');
    // Worded by the rule, not re-worded here — only it knows which way round it is.
    assert.ok(!/first day/.test(body),
        'the hand-written version is back, and it only covered the forward case');
});

test('the option dates are formatted from LOCAL parts', () => {
    // toISOString rolls the day back one in every positive-UTC-offset timezone, which
    // is CB-97 in this same file. A dropdown that says "Jun 24 to Jul 24" for a
    // Jun 25–Jul 25 session is a bug report waiting to happen.
    const a = DASH.indexOf('function _dashFmtShort(');
    const body = DASH.slice(a, a + 420);
    assert.match(body, /new Date\(ymd \+ 'T00:00:00'\)/);
    assert.ok(!/toISOString/.test(body));
    assert.match(body, /month: 'short', day: 'numeric'/);
});

test('nothing anywhere still calls the removed expiry', () => {
    ['campistry_session_scope.js', 'integration_hooks.js', 'dashboard.js',
     'campistry_presence.js', 'campistry_me.js'].forEach(f => {
        assert.ok(read(f).indexOf('pinExpired') < 0, f + ' still refers to pinExpired');
    });
});
