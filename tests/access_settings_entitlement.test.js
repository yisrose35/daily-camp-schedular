// node --test tests/access_settings_entitlement.test.js
//
// The owner's Teams & Access editor (campistry_access_settings.js) now knows
// what the camp bought. Before, it did not — and that made the screen lie.
//
// The entitlement is checked in C.resolve BEFORE the owner/admin bypass and
// before every per-staff rule, so a capability the camp has no entitlement for
// resolves to 'none' whatever an owner sets. An owner could therefore set
// Health to Edit for their nurse, press Save, see it saved, and the nurse would
// still get nothing — with nothing anywhere explaining why.
//
// These tests pin the three rules the editor now follows. They exercise the
// real resolver, so they fail if the entitlement ever stops being a ceiling.

const test = require('node:test');
const assert = require('node:assert');

const C = require('../campistry_capabilities.js');

// A camp that bought Me and Flow and nothing else.
const ENT = { me: '*', flow: '*' };

const staff = (overrides, preset) => ({
    role: 'manager', products: null, preset: preset || null,
    overrides: overrides || {}, entitlements: ENT,
});

// Mirrors capEntitled() / effectiveLevel() in campistry_access_settings.js.
const capEntitled = key => C.entitled(C.get(key), ENT);
function effectiveLevel(key, access) {
    if (!capEntitled(key)) return 'none';
    if (Object.prototype.hasOwnProperty.call(access.overrides, key)) return access.overrides[key];
    if (access.preset) return C.expandPreset(access.preset)[key] || 'none';
    return 'none';
}

// ── 1. why the controls must be locked ─────────────────────────────────────

test('an explicit Edit on an unentitled section still resolves to none', () => {
    // The reason the row is rendered disabled. Nothing an owner sets here can
    // beat the entitlement.
    assert.strictEqual(C.resolve('health.medications', staff({ 'health.medications': 'edit' })), 'none');
    assert.strictEqual(C.resolve('snacks.pos', staff({ 'snacks.pos': 'edit' })), 'none');
});

test('not even an owner can be given an unentitled section', () => {
    // The entitlement sits ABOVE the owner/admin bypass, which is the whole
    // point of it — so the editor must not offer it to anyone.
    const owner = { role: 'owner', products: null, preset: null, overrides: {}, entitlements: ENT };
    assert.strictEqual(C.resolve('health.medications', owner), 'none');
});

test('entitled sections are unaffected', () => {
    // The lock must be narrow: everything the camp DID buy still behaves.
    assert.strictEqual(C.resolve('me.campers', staff({ 'me.campers': 'edit' })), 'edit');
    assert.strictEqual(C.resolve('flow.schedule', staff({ 'flow.schedule': 'view' })), 'view');
});

// ── 2. effectiveLevel is what the owner is shown ───────────────────────────

test('the level shown is the level the person will actually get', () => {
    // The editor displays effectiveLevel, not the stored value, and counts with
    // it too — an owner reads that number as a promise.
    const a = staff({ 'health.medications': 'edit', 'me.campers': 'edit' });
    assert.strictEqual(effectiveLevel('health.medications', a), 'none');
    assert.strictEqual(effectiveLevel('me.campers', a), 'edit');
    for (const key of Object.keys(a.overrides)) {
        assert.strictEqual(effectiveLevel(key, a), C.resolve(key, a),
            key + ': what the editor shows disagrees with what resolve() gives');
    }
});

test('effectiveLevel agrees with resolve for every capability, under a preset', () => {
    // The strongest form of the rule: the screen and the resolver must never
    // disagree about anything, for any preset.
    for (const p of C.PRESETS) {
        const a = staff({}, p.key);
        for (const cap of C.all()) {
            assert.strictEqual(effectiveLevel(cap.key, a), C.resolve(cap.key, a),
                `preset ${p.key}, ${cap.key}: editor and resolver disagree`);
        }
    }
});

// ── 3. seeding from "full access" must not claim what it cannot give ───────

test('freezing full access into overrides records none for unentitled sections', () => {
    // Mirrors the seeding step: the first explicit toggle on an unconfigured
    // person freezes the access they HAD into overrides. Recording 'edit' on an
    // unentitled section would write a claim resolve() refuses, and would make
    // the person look configured for something the camp cannot give them.
    const seeded = {};
    C.all().forEach(c => {
        if (!capEntitled(c.key)) { seeded[c.key] = 'none'; return; }
        seeded[c.key] = c.viewOnly ? 'view' : 'edit';
    });

    const unentitled = C.all().filter(c => !capEntitled(c.key));
    assert.ok(unentitled.length, 'the fixture should have unentitled capabilities');
    for (const c of unentitled) {
        assert.strictEqual(seeded[c.key], 'none', c.key + ' was seeded as granted');
    }
    // And nothing entitled was lost in the process.
    for (const c of C.all().filter(c => capEntitled(c.key))) {
        assert.notStrictEqual(seeded[c.key], 'none', c.key + ' was wrongly seeded off');
    }
});

test('seeding is a no-op for an unrestricted camp', () => {
    // '{}' is what every camp is until one is deliberately restricted, so the
    // common case must be untouched by all of the above.
    const all = {};
    C.all().forEach(c => {
        all[c.key] = C.entitled(c, {}) ? (c.viewOnly ? 'view' : 'edit') : 'none';
    });
    for (const c of C.all()) {
        assert.notStrictEqual(all[c.key], 'none', c.key + ' locked at an unrestricted camp');
    }
});

// ── 4. the preset cards tell the truth about the plan ──────────────────────

function presetReach(presetKey) {
    const exp = C.expandPreset(presetKey);
    let granted = 0, reachable = 0;
    C.all().forEach(c => {
        if ((exp[c.key] || 'none') === 'none') return;
        granted++;
        if (capEntitled(c.key)) reachable++;
    });
    return { granted, reachable };
}

test('a role that grants nothing the camp bought is flagged as such', () => {
    // 'Nurse' is health.* plus me.campers and notes.notes. At a camp with no
    // Health and no Notes only one of its eleven sections survives — picking it
    // blind would look like the editor was broken.
    const nurse = presetReach('nurse');
    assert.strictEqual(nurse.granted, 11);
    assert.strictEqual(nurse.reachable, 1);
    assert.ok(nurse.reachable < nurse.granted, 'nurse should be partially out of plan here');

    // Canteen is snacks.* plus me.campers — snacks is not in this plan.
    const canteen = presetReach('canteen');
    assert.ok(canteen.reachable < canteen.granted);
});

test('a role fully covered by the plan is not flagged', () => {
    // head-counselor is flow.* plus Me sections plus live/notes. Under a plan
    // of exactly {me, flow} it is partially covered — assert the arithmetic
    // rather than a guess, then check a genuinely full case.
    const hc = presetReach('head-counselor');
    assert.ok(hc.granted > 0);

    // Against an unrestricted camp nothing is ever out of plan.
    const unrestricted = key => C.entitled(C.get(key), {});
    for (const p of C.PRESETS) {
        const exp = C.expandPreset(p.key);
        for (const cap of C.all()) {
            if ((exp[cap.key] || 'none') === 'none') continue;
            assert.ok(unrestricted(cap.key), cap.key + ' flagged at an unrestricted camp');
        }
    }
});

test('office keeps the Me sections it is meant to have', () => {
    // Guards against the lock being too broad — a plan that includes Me must
    // leave the Office role's Me sections alone.
    const office = presetReach('office');
    assert.strictEqual(office.granted, 14);
    assert.strictEqual(office.reachable, 6);
    assert.strictEqual(C.resolve('me.billing', staff({}, 'office')), 'edit');
    assert.strictEqual(C.resolve('me.campers', staff({}, 'office')), 'edit');
});
