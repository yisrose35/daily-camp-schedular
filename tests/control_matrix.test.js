// node --test tests/control_matrix.test.js
//
// The entitlement <-> checkbox encoding behind campistry_control.html.
//
// This shipped backwards once, and the failure mode is why it now has a test:
// '{}' means UNRESTRICTED, but draftFrom read it as "bought nothing", so the
// control page showed every camp with every box UNTICKED while in fact every
// camp had full access. Pressing Save on that screen without touching anything
// would have written "bought nothing" and switched the camp off — a
// one-click-to-disable-a-paying-camp bug, in the one tool whose whole job is
// getting this right.
//
// The contract, in one line: A TICK MEANS "THIS CAMP HAS IT".

const test = require('node:test');
const assert = require('node:assert');

const C = require('../campistry_capabilities.js');
const M = require('../campistry_control_matrix.js');

const draft = ent => M.draftFrom(C, ent);
const ent = d => M.entFrom(C, d);
const every = d => M.isEverything(C, d);

const ALL_CAPS = C.all();
const someApp = 'me';
const someSection = C.forApp(someApp)[0].section;

// ── the bug that shipped ───────────────────────────────────────────────────

test("'{}' is unrestricted, so EVERY box is ticked", () => {
    // The regression. Every camp is '{}' until one is deliberately restricted,
    // so if this is wrong the page is wrong for every camp at once.
    const d = draft({});
    assert.ok(every(d), "'{}' rendered as anything other than all-ticked");
    for (const cap of ALL_CAPS) {
        assert.strictEqual(d[cap.app][cap.section], true,
            `${cap.key} should be ticked for an unrestricted camp`);
    }
});

test('an unset entitlement is treated the same as {}', () => {
    for (const v of [undefined, null, '', 0, 'nonsense']) {
        assert.ok(every(draft(v)), 'unset entitlement ' + JSON.stringify(v) + ' was not all-ticked');
    }
});

test('opening an unrestricted camp and saving it unchanged leaves it unrestricted', () => {
    // The actual damage the bug would have done: a no-op visit must be a no-op.
    assert.deepStrictEqual(ent(draft({})), {});
});

// ── round-tripping ─────────────────────────────────────────────────────────

test('everything ticked stores as {} — not a frozen list of today\'s sections', () => {
    // '{}' keeps covering apps and sections added later. An explicit full list
    // would freeze the camp at today's catalogue and silently withhold every
    // new feature from a camp that is paying for everything.
    const d = draft({});
    assert.deepStrictEqual(ent(d), {});
    assert.notDeepStrictEqual(ent(d), { me: '*' });   // i.e. not an explicit list
});

test('a whole app stores as "*" and comes back fully ticked', () => {
    const e = { me: '*' };
    const d = draft(e);
    for (const cap of C.forApp('me')) assert.strictEqual(d.me[cap.section], true);
    // Every other app is absent from a non-empty entitlement => not bought.
    for (const app of C.APPS) {
        if (app.key === 'me') continue;
        for (const cap of C.forApp(app.key)) {
            assert.strictEqual(d[app.key][cap.section], false,
                `${cap.key} should be unticked — ${app.key} is absent from the entitlement`);
        }
    }
    assert.deepStrictEqual(ent(d), e);
});

test('a partial app round-trips as a section list', () => {
    const secs = C.forApp('me').slice(0, 2).map(c => c.section);
    const e = { me: secs };
    const d = draft(e);
    assert.deepStrictEqual(ent(d), e);
});

test('the roster-only camp from the design doc round-trips', () => {
    const e = { me: ['campers', 'structure', 'bunkbuilder'] };
    assert.deepStrictEqual(ent(draft(e)), e);
});

test('every single-app entitlement round-trips', () => {
    // Guards the '*' collapse: an app whose every section is ticked must come
    // back as '*', not as an exhaustive list, or the stored value churns on
    // every save.
    for (const app of C.APPS) {
        if (!C.forApp(app.key).length) continue;
        const e = {};
        e[app.key] = '*';
        assert.deepStrictEqual(ent(draft(e)), e, app.key + ' did not round-trip');
    }
});

// ── the off states ─────────────────────────────────────────────────────────

test('unticking every section of an app drops the app entirely', () => {
    const d = draft({});                      // start from everything
    C.forApp('snacks').forEach(c => { d.snacks[c.section] = false; });
    const out = ent(d);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'snacks'),
        'an app with no sections ticked must be ABSENT, which is what "not bought" means');
    assert.strictEqual(out.me, '*', 'the untouched apps should still be there');
});

test('unticking everything means the camp bought nothing', () => {
    const d = draft({});
    ALL_CAPS.forEach(cap => { d[cap.app][cap.section] = false; });
    assert.strictEqual(every(d), false);
    assert.deepStrictEqual(ent(d), {},
        'all-off and all-on both produce {} — see the note below');
});

// The line above is the one genuinely awkward corner of this encoding, so it is
// pinned deliberately rather than left as a surprise: '{}' is the only value
// that means "unrestricted", and there is no way to express "bought absolutely
// nothing" in the same object. Unticking every box therefore reads back as
// unrestricted. That is safe in the direction that matters — it can only ever
// grant, never silently disable a paying camp — and a camp that should have
// nothing has no reason to exist. If "nothing" ever needs saying, it needs a
// sentinel of its own, not a special case here.
test('all-off is documented as unrestricted, never as a partial restriction', () => {
    const d = draft({});
    ALL_CAPS.forEach(cap => { d[cap.app][cap.section] = false; });
    const out = ent(d);
    assert.strictEqual(Object.keys(out).length, 0);
});

// ── single-section changes ─────────────────────────────────────────────────

test('unticking one section of an otherwise full camp lists the rest explicitly', () => {
    const d = draft({});
    d[someApp][someSection] = false;
    const out = ent(d);
    assert.strictEqual(every(d), false);
    assert.ok(Array.isArray(out[someApp]), someApp + ' should be an explicit list now');
    assert.ok(out[someApp].indexOf(someSection) < 0, 'the unticked section is still listed');
    assert.strictEqual(out[someApp].length, C.forApp(someApp).length - 1);
    // Every other app stays whole.
    for (const app of C.APPS) {
        if (app.key === someApp || !C.forApp(app.key).length) continue;
        assert.strictEqual(out[app.key], '*', app.key + ' lost its "*"');
    }
});

test('re-ticking that section returns the camp to unrestricted', () => {
    const d = draft({});
    d[someApp][someSection] = false;
    d[someApp][someSection] = true;
    assert.deepStrictEqual(ent(d), {});
});

// ── robustness ─────────────────────────────────────────────────────────────

test('a malformed per-app value reads as not bought, never as everything', () => {
    // Fail closed on junk: treating an unparseable value as "*" would hand out
    // an app the camp did not buy.
    for (const bad of [42, 'yes', true, { nested: 1 }]) {
        const d = draft({ me: bad });
        for (const cap of C.forApp('me')) {
            assert.strictEqual(d.me[cap.section], false,
                'malformed value ' + JSON.stringify(bad) + ' granted ' + cap.key);
        }
    }
});

test('isEverything does not throw on a draft missing an app', () => {
    // render() and the SQL generator both call this on drafts built elsewhere.
    assert.strictEqual(every({}), false);
    assert.doesNotThrow(() => ent({}));
});
