// node --test tests/dates_pricing_layout.test.js
//
// The Dates & Pricing panel's layout. Cheap source assertions for the handful of
// things that were actually WRONG on screen and would silently come back:
//
//   * cards stretched to the tallest sibling, leaving two of the three mostly empty
//   * "+ Add Session" breaking across two lines in a 320px column
//   * four date boxes reading as four unrelated fields instead of two halves
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

test('the four dates are grouped as two halves', () => {
    // Flat, they read as four unrelated fields — which is how somebody enters the end
    // of the summer as the end of the 1st half.
    const p = panel();
    assert.strictEqual((p.match(/class="dash-range"/g) || []).length, 2);
    assert.match(p, /<span class="dash-range-label">1st Half<\/span>/);
    assert.match(p, /<span class="dash-range-label">2nd Half<\/span>/);
    // And within a range the field label is the quiet one, so the half reads first.
    assert.match(CSS, /\.dash-range-label \{[^}]*font-weight: 700;[^}]*color: var\(--slate-600\)/s);
    assert.match(CSS, /\.dash-field > label \{[^}]*color: var\(--slate-400\)/s);
});

test('every date input is still reachable by the id its JS uses', () => {
    // The restyle moved all four into new wrappers; the savers look them up by id.
    ['campStartDate', 'campHalf1End', 'campHalf2Start', 'campEndDate'].forEach(id => {
        assert.strictEqual((HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1,
            id + ' is missing or duplicated');
        assert.ok(JS.indexOf("getElementById('" + id + "')") > 0,
            id + ' is no longer read by dashboard.js');
    });
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

test('the payment-plan setting is a label with its reason underneath', () => {
    // As one run-on label beside a checkbox it was three lines of text where the
    // tick-box is the only part anybody is looking for.
    const p = panel();
    const a = p.indexOf('id="allowParentPaymentPlans"');
    const near = p.slice(a - 300, a + 600);
    assert.match(near, /Let parents set up their own payment plan in Link\s*\n/);
    assert.match(near, /class="dash-hint"/);
    assert.match(near, /align-items:flex-start/,
        'a two-line label must top-align its checkbox, not centre it');
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
