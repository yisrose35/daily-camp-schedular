// node --test tests/session_scope.test.js
//
// The master key: which session the whole program is showing, and — the part that
// actually does the work — which DATE the live roster is read at.
//
// The behaviours worth guarding are all about being WRONG SAFELY. A scope that shows
// too many children is a nuisance; one that shows the wrong children is a child
// missed at check-in. So: derivation beats storage, a pin cannot outlive its session,
// and "cannot tell" always means "behave exactly as before".

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'campistry_session_scope.js'));
const W = require(path.join(__dirname, '..', 'campistry_enrollment_window.js'));

S.useWindowRule(W);

const H1 = { name: '1st Half', startDate: '2026-06-28', endDate: '2026-07-19' };
const H2 = { name: '2nd Half', startDate: '2026-07-20', endDate: '2026-08-09' };
const BOTH = [H1, H2];

// ── the calendar, which is the default and is never stored ────────────────

test('the calendar answers with whichever session today falls in', () => {
    assert.strictEqual(S.calendarSession(BOTH, '2026-07-01'), '1st Half');
    assert.strictEqual(S.calendarSession(BOTH, '2026-07-20'), '2nd Half');
    assert.strictEqual(S.calendarSession(BOTH, '2026-08-09'), '2nd Half',
        'the last day of a session is still in it');
});

test('a day between sessions belongs to neither', () => {
    // Changeover day. Saying "1st Half" because it is nearest would hand the front
    // desk a roster of children who went home yesterday.
    assert.strictEqual(S.calendarSession(
        [H1, { name: '2nd Half', startDate: '2026-07-25', endDate: '2026-08-09' }],
        '2026-07-22'), '');
});

test('an UNDATED session is never the calendar’s answer', () => {
    // It covers every day, so treating it as today's session would make a camp that
    // has not entered any dates permanently "in" whichever session was typed first —
    // an answer that looks authoritative and means nothing.
    assert.strictEqual(S.calendarSession([{ name: 'Summer' }], '2026-07-01'), '');
    assert.strictEqual(S.calendarSession([{ name: 'Summer' }, H2], '2026-07-25'), '2nd Half');
});

test('a session whose start is after its end is treated as undated, not as a window', () => {
    const typo = { name: 'Oops', startDate: '2026-08-01', endDate: '2026-06-01' };
    assert.strictEqual(S.calendarSession([typo], '2026-07-01'), '',
        'a typo must not become the camp’s current session');
    const w = S.windowOf(typo);
    assert.strictEqual(w.from, null);
    assert.strictEqual(w.to, null);
});

test('sessions order by start date, undated last', () => {
    const list = [{ name: 'No dates' }, H2, H1];
    assert.strictEqual(S.ordered(list).map(s => s.name).join(','),
        '1st Half,2nd Half,No dates');
});

// ── precedence ───────────────────────────────────────────────────────────

test('with nothing set at all, the calendar decides', () => {
    const r = S.resolve({ sessions: BOTH, today: '2026-07-01' });
    assert.strictEqual(r.session, '1st Half');
    assert.strictEqual(r.source, 'calendar');
});

test('a pin beats the calendar, and the whole camp follows', () => {
    const r = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-07-01' });
    assert.strictEqual(r.session, '2nd Half');
    assert.strictEqual(r.source, 'pin');
});

test('a planning sandbox beats everything', () => {
    // It is the most specific reality there is, and the amber bar has already said
    // so. Letting a pin or a peek quietly override it would make the bar a lie.
    const r = S.resolve({ sessions: BOTH, workspaceSession: '2nd Half',
                          pin: '1st Half', peek: '1st Half', today: '2026-07-01' });
    assert.strictEqual(r.session, '2nd Half');
    assert.strictEqual(r.source, 'workspace');
});

test('one session and nothing set is "only", not "calendar"', () => {
    // Different facts: there was never a choice to make. Worth distinguishing so the
    // UI can decline to offer a picker at all.
    const r = S.resolve({ sessions: [{ name: 'Summer' }], today: '2026-07-01' });
    assert.strictEqual(r.session, 'Summer');
    assert.strictEqual(r.source, 'only');
});

test('a camp with no sessions is not scoped, and that is not an error', () => {
    const r = S.resolve({ sessions: [], today: '2026-07-01' });
    assert.strictEqual(r.session, '');
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.on, '2026-07-01', 'the date must still be today');
    assert.strictEqual(r.coversToday, true);
});

test('a changeover day with two dated sessions is unscoped, not guessed', () => {
    const r = S.resolve({
        sessions: [H1, { name: '2nd Half', startDate: '2026-07-25', endDate: '2026-08-09' }],
        today: '2026-07-22'
    });
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.session, '');
});

// ── a pin is honoured whatever the dates say ─────────────────────────────

test('a pin to a session that has ENDED still applies', () => {
    // THE CASE THE FIRST VERSION BROKE. "We are finished with 1st Half, let us tidy it
    // up" is ordinary work, and refusing it meant a camp in September could not scope
    // to a finished session at all.
    const r = S.resolve({ sessions: BOTH, pin: '1st Half', today: '2026-07-25' });
    assert.strictEqual(r.source, 'pin');
    assert.strictEqual(r.session, '1st Half');
    assert.strictEqual(r.pinDropped, false, 'a deliberate choice must not be overruled');
    assert.strictEqual(r.outOfSeason, true, 'but it must be reported');
    assert.strictEqual(r.ended, true);
});

test('a pin still applies after the whole summer is over', () => {
    const r = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-09-30' });
    assert.strictEqual(r.source, 'pin');
    assert.strictEqual(r.session, '2nd Half');
    assert.strictEqual(r.on, '2026-07-20', 'the roster is read as of that session');
    assert.strictEqual(r.ended, true);
});

test('a pin BEFORE the summer applies too, which is how a camp gets set up', () => {
    // Nothing covers today, so the calendar has no answer and every list would show
    // everyone. This half always worked; it is asserted so it stays working.
    const r = S.resolve({ sessions: BOTH, pin: '1st Half', today: '2026-05-01' });
    assert.strictEqual(r.source, 'pin');
    assert.strictEqual(r.on, '2026-06-28');
    assert.strictEqual(r.outOfSeason, true);
    assert.strictEqual(r.ended, false, 'not started is not the same as over');
});

test('the notice says WHICH WAY ROUND it is', () => {
    // "2nd Half has not started" and "1st Half is over" lead to completely different
    // next actions, and a notice that says only "out of season" helps with neither.
    const ahead = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-07-01' });
    assert.match(S.outOfSeasonNotice(ahead), /^2nd Half starts on 2026-07-20\./);
    const over = S.resolve({ sessions: BOTH, pin: '1st Half', today: '2026-08-01' });
    assert.match(S.outOfSeasonNotice(over), /^1st Half ended on 2026-07-19\./);
    // And both say what it means for the lists.
    [ahead, over].forEach(r => assert.match(S.outOfSeasonNotice(r),
        /not the ones at camp today/));
});

test('a session that IS running gets no out-of-season notice', () => {
    // Otherwise this becomes the banner everybody learns to ignore.
    const r = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-08-01' });
    assert.strictEqual(r.outOfSeason, false);
    assert.strictEqual(r.ended, false);
    assert.strictEqual(S.outOfSeasonNotice(r), '');
    // Nor does the ordinary calendar answer.
    assert.strictEqual(S.outOfSeasonNotice(
        S.resolve({ sessions: BOTH, today: '2026-08-01' })), '');
    assert.strictEqual(S.outOfSeasonNotice(null), '');
});

test('an undated session is never out of season and never ended', () => {
    const und = { name: 'Summer' };
    assert.strictEqual(S.hasEnded(und, '2030-01-01'), false);
    assert.strictEqual(S.isCurrent(und, '2030-01-01'), true);
    const r = S.resolve({ sessions: [und, H1], pin: 'Summer', today: '2030-01-01' });
    assert.strictEqual(r.outOfSeason, false);
    assert.strictEqual(S.outOfSeasonNotice(r), '');
});

test('hasEnded turns over the day AFTER the last day', () => {
    assert.strictEqual(S.hasEnded(H1, '2026-07-19'), false, 'the last day is still in it');
    assert.strictEqual(S.hasEnded(H1, '2026-07-20'), true);
    assert.strictEqual(S.isCurrent(H1, '2026-07-19'), true);
    assert.strictEqual(S.isCurrent(H1, '2026-07-20'), false);
});

test('every session is offered, in date order, with its dates and state', () => {
    // Reported, not discouraged: an option tagged as a mistake is an option nobody
    // picks, and picking a finished session is how you tidy it up.
    const opts = S.optionsFor({ sessions: BOTH, today: '2026-07-25' });
    assert.strictEqual(opts.map(o => o.value).join(','), 'auto,1st Half,2nd Half');
    assert.strictEqual(opts[1].from, '2026-06-28');
    assert.strictEqual(opts[1].to, '2026-07-19');
    assert.strictEqual(opts[1].ended, true);
    assert.strictEqual(opts[1].current, false);
    assert.strictEqual(opts[2].ended, false);
    assert.strictEqual(opts[2].current, true);
    // No option carries anything that reads as a refusal.
    opts.forEach(o => assert.strictEqual('expired' in o, false,
        'nothing may mark an option as expired any more'));
});

// ── the pin dropping, which is now ONE case ──────────────────────────────

test('a pin FORWARD is left alone — that is what the pin is for', () => {
    // An office in early July working on 2nd Half. Pinning forward is the legitimate
    // case, and it retires itself the moment that session ends.
    const r = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-07-01' });
    assert.strictEqual(r.source, 'pin');
    assert.strictEqual(r.pinDropped, false);
});

test('a pin to a session that was deleted or renamed is dropped and reported', () => {
    // The ONLY case left. There is nothing to show, so falling back to the calendar is
    // the only option — unlike an ended session, which still has a roster.
    const r = S.resolve({ sessions: BOTH, pin: 'Third Half', today: '2026-07-01' });
    assert.strictEqual(r.source, 'calendar');
    assert.strictEqual(r.pinDropped, true);
    assert.strictEqual(r.droppedPin, 'Third Half');
    const msg = S.droppedNotice(r);
    assert.match(msg, /pinned to Third Half, which no longer exists/);
    assert.ok(!/has ended/.test(msg), 'an ended session is no longer why a pin drops');
});

test('a dropped pin outside any season leaves the camp unscoped', () => {
    const r = S.resolve({ sessions: BOTH, pin: 'Gone', today: '2026-09-30' });
    assert.strictEqual(r.pinDropped, true);
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.session, '');
});

// ── the date, which is the part that does the work ───────────────────────

test('inside the session, the date is TODAY', () => {
    // You are in it. Today's roster is the right roster, and moving the date to the
    // session's start would show children who have since left.
    const r = S.resolve({ sessions: BOTH, today: '2026-08-01' });
    assert.strictEqual(r.session, '2nd Half');
    assert.strictEqual(r.on, '2026-08-01');
    assert.strictEqual(r.coversToday, true);
});

test('looking FORWARD, the date moves to the session’s first day', () => {
    // This is the whole mechanism: 2nd Half's roster is the live roster as of 2nd
    // Half's first day. Nothing is copied, so nothing can drift.
    const r = S.resolve({ sessions: BOTH, pin: '2nd Half', today: '2026-07-01' });
    assert.strictEqual(r.on, '2026-07-20');
    assert.strictEqual(r.coversToday, false);
    assert.strictEqual(r.from, '2026-07-20');
    assert.strictEqual(r.to, '2026-08-09');
});

test('an undated session falls back to today rather than to no date', () => {
    // A blank date would filter nobody in. Today is a real roster, so the failure
    // shows too many children rather than too few.
    const r = S.resolve({ sessions: [{ name: 'Summer' }], today: '2026-07-01' });
    assert.strictEqual(r.on, '2026-07-01');
    assert.strictEqual(r.coversToday, true);
});

test('a session with only a start date is open-ended, and covers today after it', () => {
    const open = { name: 'Rest of summer', startDate: '2026-07-01' };
    const r = S.resolve({ sessions: [open, H1], pin: 'Rest of summer', today: '2026-09-01' });
    assert.strictEqual(r.source, 'pin', 'no end date means it cannot have ended');
    assert.strictEqual(r.on, '2026-09-01');
});

test('a past session with only an END date still yields a usable date', () => {
    // coversToday is false and there is no start date to move to, so the fallback to
    // today is the only thing standing between this and a blank date — which would
    // filter nobody in and quietly empty every list in the app.
    const upto = { name: 'Early', endDate: '2026-07-10' };
    const r = S.resolve({ sessions: [upto, H1], workspaceSession: 'Early',
                          today: '2026-08-01' });
    assert.strictEqual(r.coversToday, false);
    assert.strictEqual(r.from, null);
    assert.strictEqual(r.on, '2026-08-01', 'a blank date is never acceptable');
});

test('covers() treats "no date asked about" as covered, not as excluded', () => {
    // Callers pass a date through from a page where it may be missing. Answering
    // "not covered" would hide every camper on a page that simply forgot the date.
    assert.strictEqual(S.covers(H1, ''), true);
    assert.strictEqual(S.covers(H1, null), true);
    assert.strictEqual(S.covers(H1, 'not-a-date'), true);
});

test('a session with only an end date covers everything before it', () => {
    const upto = { name: 'Early', endDate: '2026-07-10' };
    assert.strictEqual(S.covers(upto, '2026-06-01'), true);
    assert.strictEqual(S.covers(upto, '2026-07-11'), false);
    assert.strictEqual(S.hasEnded(upto, '2026-07-11'), true);
});

// ── what the UI is told ──────────────────────────────────────────────────

test('the picker names what automatic currently resolves to', () => {
    // "Follow the calendar" alone asks somebody to trust a black box, and the
    // commonest reason to reach for the pin is not believing it.
    const opts = S.optionsFor({ sessions: BOTH, today: '2026-08-01' });
    assert.strictEqual(opts[0].value, 'auto');
    assert.strictEqual(opts[0].label, 'Follow the calendar — 2nd Half now');
    assert.strictEqual(opts[0].resolves, '2nd Half');
});

test('automatic says nothing extra when it resolves to nothing', () => {
    const opts = S.optionsFor({ sessions: BOTH, today: '2026-09-30' });
    assert.strictEqual(opts[0].label, 'Follow the calendar');
    assert.strictEqual(opts[0].resolves, '');
});

test('droppedNotice is empty when no pin was dropped', () => {
    assert.strictEqual(S.droppedNotice(S.resolve({ sessions: BOTH, today: '2026-07-01' })), '');
    assert.strictEqual(S.droppedNotice(null), '');
});

// ── degrading ────────────────────────────────────────────────────────────

test('without the window rule it reads the dates itself and agrees', () => {
    const vm = require('node:vm');
    const fs = require('node:fs');
    const box = { module: { exports: {} }, console };
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', 'campistry_session_scope.js'), 'utf8'),
        vm.createContext(box));
    const fresh = box.module.exports;
    const r = fresh.resolve({ sessions: BOTH, today: '2026-08-01' });
    assert.strictEqual(r.session, '2nd Half');
    assert.strictEqual(r.on, '2026-08-01');
    // The typo case is the one place the two could differ, and it is not enough to
    // check calendarSession: a backwards window covers no day, so that returns ''
    // either way. What gives it away is the window it REPORTS and whether it thinks
    // the session has ended — a typo would otherwise expire a live pin on the spot.
    const typo = { name: 'Oops', startDate: '2026-08-01', endDate: '2026-06-01' };
    const w = fresh.windowOf(typo);
    assert.strictEqual(w.from, null, 'a backwards window must be reported as no window');
    assert.strictEqual(w.to, null);
    assert.strictEqual(fresh.hasEnded(typo, '2026-07-01'), false,
        'a typo must not read as a finished session');
    assert.strictEqual(fresh.calendarSession([typo], '2026-07-01'), '');
});

test('garbage in resolves to unscoped rather than throwing', () => {
    [undefined, {}, { sessions: null }, { sessions: [null, {}, { name: '' }] }]
        .forEach(arg => {
            const r = S.resolve(arg);
            assert.strictEqual(r.source, 'none');
            assert.strictEqual(r.session, '');
            assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.on), 'the date must always be usable');
        });
});

test('names are trimmed, so a stray space cannot break a pin', () => {
    const r = S.resolve({ sessions: [{ name: '2nd Half', startDate: '2026-07-20',
                                       endDate: '2026-08-09' }],
                          pin: '  2nd Half  ', today: '2026-07-25' });
    assert.strictEqual(r.source, 'pin');
    assert.strictEqual(r.session, '2nd Half');
});

// ── the way back out of a peek ────────────────────────────────────────────


test('the notice can be handed the page’s own date format', () => {
    // Otherwise it reads '2026-08-26' beside a dropdown saying 'Aug 26', which is the
    // kind of mismatch that makes a page feel unfinished. The WORDING stays in the
    // rule — only the rule knows whether this is ahead or over.
    const r = S.resolve({ sessions: BOTH, pin: '1st Half', today: '2026-08-01' });
    const short = d => ({ '2026-06-28': 'Jun 28', '2026-07-19': 'Jul 19' }[d] || d);
    assert.strictEqual(S.outOfSeasonNotice(r, short),
        '1st Half ended on Jul 19. Lists show the children on it, as of Jun 28, ' +
        'not the ones at camp today.');
    // No formatter, and it is still readable rather than blank.
    assert.match(S.outOfSeasonNotice(r), /ended on 2026-07-19/);
    // A formatter that is not a function is ignored, not called.
    assert.match(S.outOfSeasonNotice(r, 'nope'), /ended on 2026-07-19/);
});
