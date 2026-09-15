// node --test tests/role_presets.test.js
//
// The preset list is what most camps will ever touch — one click instead of 62
// toggles — so it has to map onto the jobs camps actually have, and each preset
// has to grant something coherent.
//
// Two gaps this pins, both found by listing the registry against the four job
// titles the owner's screen exposes:
//
//   1. There was NO counselor-shaped preset, despite 'counselor' being one of
//      the four roles that can carry a default. Configuring bunk staff meant
//      hand-picking from 62 sections every time.
//   2. NOTHING granted the Guard app. It exists in the registry with a section
//      of its own, and the only presets that reached it were 'full' and
//      'read-only' via their '*' wildcard — so a camp with a gatehouse had no
//      role to start from.
//
// C.ROLE_PRESETS is a RECOMMENDATION, not a restriction: the screen shows the
// suiting ones first and puts the rest behind "show all". A camp whose
// bookkeeper happens to hold the scheduler role should not be argued with.

const test = require('node:test');
const assert = require('node:assert');

const C = require('../campistry_capabilities.js');

const asRole = (role, preset) => ({
    role: role, products: null, preset: preset || null, overrides: {}, entitlements: {},
});
const granted = preset => C.all()
    .filter(c => C.resolve(c.key, asRole('manager', preset)) !== 'none')
    .map(c => c.key);

// ── the two new presets ────────────────────────────────────────────────────

test('Bunk Counselor covers running a bunk and nothing financial', () => {
    const on = granted('bunk-counselor');
    // What the job is: roll call, absences, pickups, the day's schedule.
    for (const k of ['live.roll-call', 'live.absences', 'live.early-pickup',
                     'flow.schedule', 'notes.notes', 'me.campers']) {
        assert.ok(on.includes(k), 'bunk-counselor should reach ' + k);
    }
    // What it must not be: money, medical records, camp configuration.
    for (const k of ['me.billing', 'me.payroll', 'me.finance', 'me.enrollment',
                     'health.medications', 'health.intake', 'flow.setup', 'snacks.accounts']) {
        assert.ok(!on.includes(k), 'bunk-counselor must not reach ' + k);
    }
});

test('Bunk Counselor sees the schedule without being able to rewrite it', () => {
    // A counselor reading the day is the point; a counselor editing the camp's
    // schedule is not.
    assert.strictEqual(C.resolve('flow.schedule', asRole('manager', 'bunk-counselor')), 'view');
    assert.strictEqual(C.resolve('me.campers', asRole('manager', 'bunk-counselor')), 'view');
});

test('Gatehouse reaches the Guard app, which nothing else did', () => {
    const on = granted('gatehouse');
    assert.ok(on.includes('guard.guard'), 'gatehouse should reach the Guard app');
    // The gate needs to know who is leaving and with whom.
    assert.ok(on.includes('live.early-pickup'));
    assert.ok(on.includes('live.camper-locator'));
    // And nothing beyond that.
    for (const k of ['me.billing', 'me.payroll', 'health.medications', 'snacks.pos']) {
        assert.ok(!on.includes(k), 'gatehouse must not reach ' + k);
    }
});

test('every app in the registry is reachable by at least one specific preset', () => {
    // The regression that produced 'gatehouse'. 'full' and 'read-only' grant
    // everything through a wildcard, so they cannot count — an app only they
    // reach has no role to start from.
    const wildcard = ['full', 'read-only'];
    const specific = C.PRESETS.filter(p => wildcard.indexOf(p.key) < 0);
    for (const app of C.APPS) {
        if (!C.forApp(app.key).length) continue;
        const covered = specific.some(p =>
            C.forApp(app.key).some(c => C.resolve(c.key, asRole('manager', p.key)) !== 'none'));
        assert.ok(covered, app.key + ' is reachable only by a wildcard preset — it needs a role of its own');
    }
});

// ── role recommendations ───────────────────────────────────────────────────

test('every job with a default gets at least one suiting preset', () => {
    // The owner's screen shows these first. A job with none would show the full
    // list, which is the cramping this was meant to fix.
    for (const role of ['manager', 'scheduler', 'counselor', 'viewer']) {
        const rec = C.presetsForRole(role).filter(x => x.recommended);
        assert.ok(rec.length, role + ' has no suiting preset');
    }
});

test('presetsForRole never hides a preset — it only reorders', () => {
    // "Recommendation, not restriction". Losing a preset from the list would
    // make it unreachable from the screen entirely.
    const all = C.PRESETS.filter(p => p.key !== 'full').map(p => p.key).sort();
    for (const role of ['manager', 'scheduler', 'counselor', 'viewer', 'nonsense', null]) {
        const got = C.presetsForRole(role).map(x => x.preset.key).sort();
        assert.deepStrictEqual(got, all, 'presetsForRole(' + role + ') changed the set of presets');
    }
});

test("'full' is never offered as a preset", () => {
    // The screen offers "No limits" as its own card ahead of the presets, so
    // listing 'full' too would be the same choice twice under two names.
    for (const role of ['manager', 'scheduler', 'counselor', 'viewer', null]) {
        assert.ok(!C.presetsForRole(role).some(x => x.preset.key === 'full'),
            "'full' leaked into the preset list for " + role);
    }
});

test('the suiting presets come first, in the order declared', () => {
    const rec = C.ROLE_PRESETS.scheduler;
    const got = C.presetsForRole('scheduler');
    rec.forEach((k, i) => {
        assert.strictEqual(got[i].preset.key, k, 'recommendation order changed');
        assert.strictEqual(got[i].recommended, true);
    });
    assert.strictEqual(got[rec.length].recommended, false, 'the rest should not be marked as suiting');
});

test('an unknown role gets a plain list, not a confident wrong guess', () => {
    const got = C.presetsForRole('gardener');
    assert.ok(got.length);
    assert.ok(!got.some(x => x.recommended), 'an unknown role should get no recommendations');
});

test('every recommendation names a preset that exists', () => {
    // A typo here would silently drop a recommendation rather than erroring.
    for (const role of Object.keys(C.ROLE_PRESETS)) {
        for (const k of C.ROLE_PRESETS[role]) {
            assert.ok(C.preset(k), role + ' recommends unknown preset ' + k);
        }
    }
});

test('scheduler recommendations are schedule-shaped, not money-shaped', () => {
    // The point of recommending at all: a camp configuring schedulers should
    // not be weighing 'Bookkeeper'.
    for (const k of C.ROLE_PRESETS.scheduler) {
        const on = granted(k);
        assert.ok(on.some(x => x.indexOf('flow.') === 0), k + ' grants no Flow but is suggested for schedulers');
        for (const money of ['me.billing', 'me.payroll', 'me.finance']) {
            assert.ok(!on.includes(money), k + ' is suggested for schedulers but reaches ' + money);
        }
    }
});

test('the viewer recommendation can never edit anything', () => {
    for (const k of C.ROLE_PRESETS.viewer) {
        for (const cap of C.all()) {
            assert.notStrictEqual(C.resolve(cap.key, asRole('viewer', k)), 'edit',
                k + ' gives a viewer edit on ' + cap.key);
        }
    }
});

// ── the generated SQL has to keep up ───────────────────────────────────────

test('the generated registry migration covers the new presets', () => {
    // 159 is generated from this file. Adding a preset without re-running the
    // generator leaves the DATABASE resolving against the old list, so a role
    // default using a new preset would silently grant nothing.
    const fs = require('node:fs');
    const path = require('node:path');
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '159_access_registry_tables.sql'), 'utf8');
    for (const p of C.PRESETS) {
        assert.ok(sql.includes("('" + p.key + "'"),
            p.key + ' is missing from migration 159 — run: node scripts/build-access-registry-sql.js');
    }
});
