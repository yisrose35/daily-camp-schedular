// node --test tests/entitlements.test.js
//
// Camp entitlements — what the camp BOUGHT, as opposed to what a staff member
// is allowed. The rules that matter most, in order:
//
//   • an unset entitlement ('{}') restricts nothing, or shipping this switches
//     off every existing camp
//   • an entitlement caps OWNERS too — that is the whole point, and it is the
//     one rule that sits above the owner/admin bypass in resolve()
//   • an entitlement can only ever SUBTRACT; it must never grant a staff member
//     something their own permissions deny
//
// See ENTITLEMENTS_DESIGN.md.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../campistry_capabilities.js');

const owner = ent => ({ role: 'owner', products: null, preset: null, overrides: {}, entitlements: ent });
const staff = ent => ({ role: 'manager', products: null, preset: null, overrides: {}, entitlements: ent });

const ROSTER_ONLY = { me: ['campers', 'structure', 'bunkbuilder'] };

// ── backward compatibility ──────────────────────────────────────────────────

test('an unset entitlement restricts nobody', () => {
    assert.strictEqual(C.resolve('me.billing', owner({})), 'edit');
    assert.strictEqual(C.resolve('me.billing', staff({})), 'edit');
    assert.strictEqual(C.resolve('me.billing', owner(undefined)), 'edit');
    assert.strictEqual(C.resolve('me.billing', owner(null)), 'edit');
});

// ── the point: it caps the owner ────────────────────────────────────────────

test('an entitlement caps an OWNER, unlike every staff-level rule', () => {
    assert.strictEqual(C.resolve('me.campers', owner(ROSTER_ONLY)), 'edit');
    assert.strictEqual(C.resolve('me.structure', owner(ROSTER_ONLY)), 'edit');
    assert.strictEqual(C.resolve('me.billing', owner(ROSTER_ONLY)), 'none');
    assert.strictEqual(C.resolve('me.payroll', owner(ROSTER_ONLY)), 'none');
});

test('an app missing from a non-empty entitlement was not bought', () => {
    assert.strictEqual(C.resolve('flow.setup', owner(ROSTER_ONLY)), 'none');
    assert.strictEqual(C.resolve('health.medications', owner(ROSTER_ONLY)), 'none');
});

test('"*" buys a whole app, including sections added later', () => {
    assert.strictEqual(C.resolve('flow.setup', owner({ flow: '*' })), 'edit');
    C.forApp('flow').forEach(cap => {
        assert.notStrictEqual(C.resolve(cap.key, owner({ flow: '*' })), 'none',
            cap.key + ' should be covered by flow:"*"');
    });
});

test('an empty section list buys the app but none of its sections', () => {
    assert.strictEqual(C.resolve('me.campers', owner({ me: [] })), 'none');
});

// ── it only ever subtracts ──────────────────────────────────────────────────

test('an entitlement never overrides a staff-level denial', () => {
    const denied = {
        role: 'manager', products: null, preset: null,
        overrides: { 'me.billing': 'none' }, entitlements: { me: '*' }
    };
    assert.strictEqual(C.resolve('me.billing', denied), 'none');
});

test('an entitlement never overrides the product gate', () => {
    const noProduct = {
        role: 'manager', products: ['flow'], preset: null,
        overrides: { 'me.campers': 'edit' }, entitlements: { me: '*' }
    };
    assert.strictEqual(C.resolve('me.campers', noProduct), 'none');
});

test('a view-only section stays view-only when entitled', () => {
    assert.strictEqual(C.resolve('me.analytics', owner({ me: '*' })), 'view');
});

// ── locked vs hidden ────────────────────────────────────────────────────────

test('lockedByEntitlement separates "not bought" from "not allowed"', () => {
    // Not bought -> the UI shows it locked, with an upgrade prompt.
    assert.strictEqual(C.lockedByEntitlement('me.billing', owner(ROSTER_ONLY)), true);
    // Not allowed -> the UI hides it; nobody upsells a counselor on Payroll.
    const denied = {
        role: 'manager', products: null, preset: null,
        overrides: { 'me.billing': 'none' }, entitlements: { me: '*' }
    };
    assert.strictEqual(C.lockedByEntitlement('me.billing', denied), false);
    assert.strictEqual(C.lockedByEntitlement('me.billing', owner({})), false);
});

test('an unknown capability key is never reported as merely unbought', () => {
    assert.strictEqual(C.lockedByEntitlement('me.not-a-real-section', owner(ROSTER_ONLY)), false);
    assert.strictEqual(C.resolve('me.not-a-real-section', owner({})), 'none');
});

// ── malformed entitlements must fail CLOSED, not open ───────────────────────
// A typo in a stored entitlement should withhold the section rather than hand
// out the whole product.

test('a malformed per-app value withholds the section', () => {
    assert.strictEqual(C.resolve('me.campers', owner({ me: 'yes' })), 'none');
    assert.strictEqual(C.resolve('me.campers', owner({ me: 42 })), 'none');
    assert.strictEqual(C.resolve('me.campers', owner({ me: null })), 'none');
});
