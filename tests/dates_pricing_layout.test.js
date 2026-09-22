// node --test tests/dates_pricing_layout.test.js
//
// The Dates & Pricing panel's layout. Cheap source assertions for the handful of
// things that were actually WRONG on screen and would silently come back:
//
//   * cards stretched to the tallest sibling, leaving two of the three mostly empty
//   * "+ Add Session" breaking across two lines in a 320px column
//   * four date boxes reading as four unrelated fields instead of two halves
//     (superseded: the half boundaries now come from the two Sessions — see
//     'the dates card owns only the overall start and end' below)
//   * two different-looking disclosure widgets on one panel
//
// It does not try to be a visual test. It guards the decisions, so a later edit that
// reintroduces one of them fails here rather than in a screenshot somebody takes
// six weeks later.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('dashboard.css');
const HTML = read('dashboard.html');
const JS = read('dashboard.js');

/** The Dates & Pricing panel's markup, on its own. */
function panel() {
    const a = HTML.indexOf('<div id="camp-dates-section"');
    assert.ok(a > 0, 'the panel is gone');
    const b = HTML.indexOf('<div id="dash-setup-payment"', a);
    assert.ok(b > a);
    return HTML.slice(a, b);
}

test('cards size to their content instead of stretching to the tallest', () => {
    // A grid stretches its items by default, which left the two short cards with a
    // hand's width of empty white below the Save button while the long one set the
    // height for the row.
    assert.match(CSS, /\.dash-setup-panel \.dashboard-grid \{ align-items: start; \}/);
});

test('a header button group does not break across lines', () => {
    assert.match(CSS, /\.btn-edit \{ white-space: nowrap; \}/);
    assert.match(CSS, /\.card-actions \{ display: flex; gap: 8px; flex-wrap: nowrap; \}/);
    // The header itself wraps instead, so a long title still has somewhere to go.
    assert.match(CSS, /\.card-header \{ flex-wrap: wrap; gap: 10px; \}/);
    const p = panel();
    (p.match(/<div class="card-actions">/g) || []).length >= 2 ||
        assert.fail('the two multi-button headers do not use card-actions');
});

test('the sessions list spans the row rather than sitting in one column', () => {
    assert.match(CSS, /\.dashboard-card--wide \{ grid-column: 1 \/ -1; \}/);
    assert.match(panel(), /class="dashboard-card dashboard-card--wide" id="sessionsCard"/);
});

test('the camp date inputs are GONE — sessions are the source of truth', () => {
    // Superseded twice over. First the half boundaries were removed (the same
    // dates a "1st Half"/"2nd Half" Session already defines, typed twice), then
    // commit 44220ca removed the overall Camp Starts/Ends pair as well:
    // "Sessions ARE the summer schedule, so there is no separate Camp
    // Starts/Ends step to fill in any more."
    //
    // This guards the REMOVAL, so re-adding a date box nobody needs fails here.
    for (const id of ['campStartDate', 'campEndDate']) {
        assert.strictEqual((HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length, 0,
            id + ' is back — sessions already carry these dates');
    }
    assert.strictEqual((HTML.match(/class="dash-range"/g) || []).length, 0,
        'the date-range widget is back');
});

test('the camp range is derived from sessions on every session change', () => {
    // Utils.getCampDates() still reads camp_state_kv.campDates for older code, so
    // removing the inputs without deriving the record would leave that permanently
    // stale — the failure mode the removal has to avoid.
    assert.match(JS, /function _dashDeriveCampDatesFromSessions\(\)/);
    // One funnel: add, edit and delete all go through _dashSaveSessions.
    const save = JS.slice(JS.indexOf('function _dashSaveSessions()'));
    const body = save.slice(0, save.indexOf('\n    }'));
    assert.match(body, /_dashDeriveCampDatesFromSessions\(\);/,
        'saving sessions must re-derive, or the record goes stale silently');
});

test('the derived range is the earliest start and the latest end', () => {
    const fn = JS.slice(JS.indexOf('function _dashDeriveCampDatesFromSessions()'));
    const body = fn.slice(0, fn.indexOf('\n    function '));
    assert.match(body, /starts\.reduce\(function\s*\(a, b\)\s*\{ return b < a \? b : a; \}\)/,
        'earliest start');
    assert.match(body, /ends\.reduce\(function\s*\(a, b\)\s*\{ return b > a \? b : a; \}\)/,
        'latest end');
    assert.match(body, /if \(!starts\.length \|\| !ends\.length\) return;/,
        'a camp whose sessions carry no dates must not overwrite a real range with nothing');
    assert.match(body, /key: 'campDates'/, 'and it is persisted where getCampDates looks');
    assert.match(body, /onConflict: 'camp_id,key'/, 'upsert, not a duplicate row');
});

test('deriving is owner-only and debounced', () => {
    const fn = JS.slice(JS.indexOf('function _dashDeriveCampDatesFromSessions()'));
    const body = fn.slice(0, fn.indexOf('\n    function '));
    assert.match(body, /if \(isTeamMember\) return;/,
        'same guard saveCampDates() used — a team member must not write camp dates');
    assert.match(body, /clearTimeout\(_dashDeriveCampDatesDebounce\)/,
        'editing several sessions in a row must not fire several writes');
});

test('the half-boundary fallback is carried forward, never blanked', () => {
    // half1End/half2Start are what Utils.getCampDates() falls back to for a camp
    // with no "1st Half"/"2nd Half" session named. Deriving must not erase them.
    const fn = JS.slice(JS.indexOf('function _dashDeriveCampDatesFromSessions()'));
    const body = fn.slice(0, fn.indexOf('\n    function '));
    assert.match(body, /half1End: _dashRawCampDatesHalves\.half1End/);
    assert.match(body, /half2Start: _dashRawCampDatesHalves\.half2Start/);
});

test('the removed half inputs are gone from the page AND from the JS together', () => {
    // Half a removal is the dangerous state: markup gone while a saver still does
    // getElementById(...).value would write null over a real boundary on every save.
    ['campHalf1End', 'campHalf2Start'].forEach(id => {
        assert.ok(HTML.indexOf('id="' + id + '"') < 0, id + ' is back on the page');
        assert.ok(JS.indexOf("getElementById('" + id + "')") < 0,
            id + ' is still being read as an input by dashboard.js');
    });
});

test('saving camp dates never erases the stored half boundaries', () => {
    // THE ONE THAT MATTERS. The inputs are gone, so the save has nothing to read —
    // and writing null/absent would silently destroy the documented fallback for
    // every camp that has not named its two Sessions yet. It must carry them
    // forward untouched.
    // window.saveCampDates = async function() — anchor on the assignment, and
    // slice to the next top-level declaration either way.
    const a = JS.indexOf('window.saveCampDates = async function');
    assert.ok(a > 0, 'saveCampDates not found — re-anchor this test');
    const ends = ['\n    function ', '\n    window.'].map(m => JS.indexOf(m, a + 40)).filter(i => i > 0);
    const fn = JS.slice(a, Math.min(...ends));
    assert.ok(fn.length > 200 && fn.length < 12000, `bad slice (${fn.length} chars) — re-anchor`);
    assert.match(fn, /half1End: _dashRawCampDatesHalves\.half1End,/);
    assert.match(fn, /half2Start: _dashRawCampDatesHalves\.half2Start,/);
    assert.ok(!/half1End:\s*(null|''|""|undefined)/.test(fn),
        'the save writes an empty half1End — that erases the fallback');
    assert.ok(!/half2Start:\s*(null|''|""|undefined)/.test(fn),
        'the save writes an empty half2Start — that erases the fallback');
    // and the values it carries forward are the ones read back on load
    assert.match(JS, /_dashRawCampDatesHalves = campDates \? \{ half1End: campDates\.half1End \|\| null, half2Start: campDates\.half2Start \|\| null \}/);
});

test('the halves resolve from Sessions first, stored values second', () => {
    // Both halves of the contract: a named Session wins, and a camp without one
    // keeps working off what Camp Dates already had.
    const a = JS.indexOf('function _dashResolveHalfBoundaries');
    assert.ok(a > 0);
    const fn = JS.slice(a, JS.indexOf('\n    function ', a + 10));
    assert.match(fn, /autoKey === 'half1'/);
    assert.match(fn, /'1st half'/);
    assert.match(fn, /autoKey === 'half2'/);
    assert.match(fn, /'2nd half'/);
    assert.match(fn, /h1End: \(half1 && half1\.endDate\) \|\| _dashRawCampDatesHalves\.half1End \|\| null/,
        'session first, then the stored fallback');
    assert.match(fn, /h2Start: \(half2 && half2\.startDate\) \|\| _dashRawCampDatesHalves\.half2Start \|\| null/);
});

test('every half-boundary consumer reads through the one resolver', () => {
    // Per-Half rotation and the calendar's transition markers are the consumers.
    // Reading the raw campDates blob instead would see null halves for any camp
    // that defines them only as Sessions — silently no halves at all.
    const utils = read('scheduler_core_utils.js');
    assert.match(utils, /Utils\.getCampDates = function\(\)/);
    assert.match(utils, /if \(half1 && half1\.endDate\) resolved\.half1End = half1\.endDate;/);
    assert.match(utils, /if \(half2 && half2\.startDate\) resolved\.half2Start = half2\.startDate;/);
    assert.match(utils, /return cd;/, 'and the raw config is the fallback, not an error');
    for (const f of ['schedule_calendar_views.js', 'scheduler_core_auto.js']) {
        assert.match(read(f), /SchedulerCoreUtils\.getCampDates\(\)/,
            f + ' reads camp dates without the session overlay');
    }
});

test('there is ONE disclosure pattern on the panel', () => {
    // The week breakdown was a hand-rolled chevron with its own click handler and its
    // own open flag, sitting next to a real <details>. Two widgets for one gesture is
    // what makes a page feel assembled rather than designed.
    assert.ok(JS.indexOf('_toggleWeekPreview') < 0, 'the hand-rolled toggle is back');
    assert.ok(JS.indexOf('weekPreviewChevron') < 0, 'the hand-drawn chevron is back');
    assert.match(JS, /'<details class="dash-more"'/);
    assert.match(panel(), /<details class="dash-more">/);
    // The open state survives the re-render a date edit triggers.
    assert.match(JS, /det\.addEventListener\('toggle'/);
});

test('the marker has room after it', () => {
    // `content: '▸ '` collapses its trailing space, so the triangle sat flush
    // against the word.
    assert.match(CSS, /\.dash-more > summary::before \{[^}]*margin-right: 7px;/s);
});

test('a container JS has not filled yet spends no gap', () => {
    assert.match(CSS, /\.dash-card-body > div:empty \{ display: none; \}/);
});

test('the disabled look lives in the stylesheet, not in the role check', () => {
    assert.match(CSS, /\.dash-input:disabled \{/);
    const a = JS.indexOf('async function loadCampDates(');
    const body = JS.slice(a, JS.indexOf('function buildWeekMap(', a));
    assert.ok(!/backgroundColor = 'var\(--slate-50\)'/.test(body),
        'the read-only path is hand-painting what the stylesheet owns');
    assert.match(body, /if \(el\) el\.disabled = true;/);
});

test('the panel no longer carries a wall of repeated inline field styles', () => {
    // Eight copies of the same style string is eight places to change the field
    // rhythm and a diff that shows nothing about intent.
    const p = panel();
    const inlineFields = (p.match(/style="width:100%; padding:8px 10px; border-radius:8px/g) || []).length;
    assert.strictEqual(inlineFields, 0, 'the old inline input style is back ' +
        '(' + inlineFields + ' copies)');
    assert.ok((p.match(/class="dash-input"/g) || []).length >= 5,
        'the inputs should be using the shared class');
});

test('Plan a Session leads with one sentence, not five', () => {
    // Five sentences above the thing they explain are read once and skipped for
    // ever after, and they were setting the height for the whole row.
    const a = panel().indexOf('id="workspacesCard"');
    const card = panel().slice(a, panel().indexOf('id="sessionsCard"', a));
    assert.ok(card.indexOf('A plan is a full copy of your bunks') < 0,
        'the wall of text is back above the list');
    assert.match(card, /<p class="dash-hint">Build next session's bunks/);
    // The detail is kept — folded away, not deleted.
    assert.match(card, /A plan copies your bunks, divisions, periods/);
    assert.match(card, /never copied/);
});

test('the payment-plan toggle moved to Billing, and took its effect with it', () => {
    // It was a checkbox on the Sessions card, which is the wrong home: it is a
    // Billing policy, not a session detail. Moved to Me -> Billing -> "Parent
    // self-serve payment plans". A move is only safe if the control ARRIVES and
    // the key stays the same, so assert both ends and the readers.
    assert.ok(HTML.indexOf('id="allowParentPaymentPlans"') < 0,
        'the toggle is back on the dashboard — now there are two of them');
    const me = read('campistry_me.js');
    // The BUTTON and the FUNCTION must name each other. Anchored on the open
    // paren, or a rename to ...SettingOld still matches as a prefix and the
    // menu item is left calling something that no longer exists.
    assert.match(me, /onclick="CampistryMe\.manageParentPaymentPlanSetting\(\)">Parent self-serve payment plans</,
        'the Billing menu item is gone or no longer points at the handler');
    assert.match(me, /function manageParentPaymentPlanSetting\(/,
        'the handler the menu item calls does not exist');
    // same key, read and written
    assert.match(me, /var on=!!enrollSettings\.allowParentPaymentPlans;/);
    assert.match(me, /enrollSettings\.allowParentPaymentPlans=checked;/);
    // and every consumer of that key is untouched by the move
    assert.match(read('campistry_register.html'), /allowParentPaymentPlans/);
    assert.match(read('migrations/181_new_plans_are_ledger_plans.sql'),
        /enrollSettings,allowParentPaymentPlans/);
});

test('the shared input class out-specifies .form-group input', () => {
    // `.form-group input` is one class plus one element. A bare `.dash-input` is one
    // class, so it LOSES — which is exactly what happened: every field on the panel
    // shrank to the new size except the ones inside the session edit form, and the
    // panel shipped with two input sizes on it. Type-qualifying matches the
    // specificity, and coming later in the file wins the tie.
    assert.match(CSS,
        /input\.dash-input, select\.dash-input, textarea\.dash-input, \.dash-input \{/);
    const base = CSS.indexOf('.form-group input, .form-group select');
    const mine = CSS.indexOf('input.dash-input, select.dash-input, textarea.dash-input');
    assert.ok(base > 0 && mine > base, 'the shared rule must come after .form-group\'s');
    // Focus and disabled too, or a focused field in the edit form jumps size.
    assert.match(CSS, /input\.dash-input:focus, select\.dash-input:focus/);
    assert.match(CSS, /input\.dash-input:disabled, select\.dash-input:disabled/);
});

test('the field wrapper composes with .form-group instead of fighting it', () => {
    // .form-group is already a flex column with a gap. A label margin on top of that
    // double-spaces every row in the edit forms.
    assert.match(CSS, /\.dash-field \{ display: flex; flex-direction: column; gap: 5px;/);
    assert.match(CSS, /\.dash-field > label \{\s*\n\s*margin: 0;/);
    // And the edit forms carry both classes, which is what lets 16 labels drop an
    // identical inline style string rather than being edited one at a time.
    assert.ok((panel().match(/class="form-group dash-field"/g) || []).length >= 10);
});
