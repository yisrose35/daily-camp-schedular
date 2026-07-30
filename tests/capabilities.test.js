// node --test tests/capabilities.test.js
// The resolution rules for per-section access. The two that matter most:
//   • an UNCONFIGURED user keeps full access (or shipping this locks out every
//     existing staff member at every camp)
//   • owners/admins are never gated (or an owner can lock themselves out)
const test = require('node:test');
const assert = require('node:assert');
const C = require('../campistry_capabilities.js');

const ALL_APPS = C.appKeys();
const staff = over => Object.assign({
    role: 'scheduler', products: ALL_APPS, preset: null, overrides: {}
}, over || {});

// ── registry sanity ─────────────────────────────────────────────────────────

test('every capability key is unique and app-qualified', () => {
    const keys = C.all().map(c => c.key);
    assert.strictEqual(new Set(keys).size, keys.length);
    assert.ok(keys.every(k => /^[a-z]+\.[a-z-]+$/.test(k)));
});

test('the registry covers the apps product_access already knows about', () => {
    ['me', 'flow', 'go', 'health', 'snacks', 'live', 'link', 'notes', 'guard']
        .forEach(a => assert.ok(C.forApp(a).length > 0, a + ' has no sections'));
});

test('levelsFor drops edit on a view-only section', () => {
    assert.deepStrictEqual(C.levelsFor('me.analytics'), ['none', 'view']);
    assert.deepStrictEqual(C.levelsFor('me.billing'), ['none', 'view', 'edit']);
    assert.deepStrictEqual(C.levelsFor('nope.nope'), ['none', 'view', 'edit']);
});

// ── the backward-compatibility rule ─────────────────────────────────────────

test('an UNCONFIGURED user keeps full access to their apps', () => {
    // This is the upgrade path. Break it and every existing staff member at
    // every camp loses access to everything the moment this ships.
    const u = staff();
    assert.ok(C.isUnconfigured(u));
    assert.strictEqual(C.resolve('me.billing', u), 'edit');
    assert.strictEqual(C.resolve('go.luggage', u), 'edit');
    assert.strictEqual(C.resolve('me.analytics', u), 'view');   // view-only section
});

test('unconfigured still respects the product gate', () => {
    const u = staff({ products: ['me'] });
    assert.strictEqual(C.resolve('me.campers', u), 'edit');
    assert.strictEqual(C.resolve('go.routes', u), 'none');
});

test('a preset OR an override makes a user configured', () => {
    assert.ok(!C.isUnconfigured(staff({ preset: 'nurse' })));
    assert.ok(!C.isUnconfigured(staff({ overrides: { 'me.billing': 'none' } })));
    assert.ok(C.isUnconfigured(staff({ overrides: {} })));
    assert.ok(C.isUnconfigured(null));
});

// ── owners and admins ───────────────────────────────────────────────────────

test('owners and admins are never gated, whatever is configured', () => {
    // Even a preset that grants nothing must not lock an owner out.
    const owner = staff({ role: 'owner', preset: 'nurse', products: [], overrides: { 'me.billing': 'none' } });
    assert.strictEqual(C.resolve('me.billing', owner), 'edit');
    assert.strictEqual(C.resolve('go.setup', owner), 'edit');
    const admin = staff({ role: 'admin', products: [], preset: 'read-only' });
    assert.strictEqual(C.resolve('me.payroll', admin), 'edit');
    assert.strictEqual(C.resolve('me.analytics', admin), 'view');
});

// ── the division-head case from the brief ────────────────────────────────────

test('Division Head gets the roster but NOT billing', () => {
    const dh = staff({ preset: 'division-head' });
    assert.strictEqual(C.resolve('me.campers', dh), 'view');
    assert.strictEqual(C.resolve('me.bunkbuilder', dh), 'edit');
    assert.strictEqual(C.resolve('me.billing', dh), 'none');
    assert.strictEqual(C.resolve('me.payroll', dh), 'none');
    assert.strictEqual(C.resolve('me.analytics', dh), 'none');
    assert.ok(!C.can('me.billing', dh));
    assert.ok(C.can('me.campers', dh));
});

test('Nurse gets health and the roster read-only, nothing else', () => {
    const n = staff({ preset: 'nurse' });
    assert.strictEqual(C.resolve('health.medications', n), 'edit');
    assert.strictEqual(C.resolve('me.campers', n), 'view');
    assert.strictEqual(C.resolve('me.billing', n), 'none');
    assert.strictEqual(C.resolve('snacks.accounts', n), 'none');
});

test('Bookkeeper is the mirror image of Division Head', () => {
    const b = staff({ preset: 'bookkeeper' });
    assert.strictEqual(C.resolve('me.billing', b), 'edit');
    assert.strictEqual(C.resolve('me.payroll', b), 'edit');
    assert.strictEqual(C.resolve('me.campers', b), 'view');
    assert.strictEqual(C.resolve('flow.master-scheduler', b), 'none');
});

// ── presets and overrides ───────────────────────────────────────────────────

test('expandPreset resolves * and app.* with most-specific-wins', () => {
    const full = C.expandPreset('full');
    assert.strictEqual(full['me.billing'], 'edit');
    assert.strictEqual(full['me.analytics'], 'view');   // view-only clamps
    const nurse = C.expandPreset('nurse');
    assert.strictEqual(nurse['health.intake'], 'edit'); // from health.*
    assert.strictEqual(nurse['me.campers'], 'view');    // exact key
    assert.strictEqual(nurse['flow.setup'], 'none');    // unlisted
});

test('expandPreset on an unknown preset is empty, not a throw', () => {
    assert.deepStrictEqual(C.expandPreset('nope'), {});
    assert.deepStrictEqual(C.expandPreset(undefined), {});
});

test('an override beats the preset it sits on', () => {
    // The whole point of "fully customizable": start from Nurse, then add one.
    const n = staff({ preset: 'nurse', overrides: { 'me.billing': 'view' } });
    assert.strictEqual(C.resolve('me.billing', n), 'view');
    assert.strictEqual(C.resolve('health.intake', n), 'edit');  // preset intact
});

test('an override can also take something AWAY from a preset', () => {
    const n = staff({ preset: 'nurse', overrides: { 'health.medications': 'none' } });
    assert.strictEqual(C.resolve('health.medications', n), 'none');
    assert.strictEqual(C.resolve('health.allergies', n), 'edit');
});

test('overrides with no preset mean anything unlisted is off', () => {
    // The owner is hand-picking sections, so silence means no.
    const u = staff({ overrides: { 'me.campers': 'edit' } });
    assert.strictEqual(C.resolve('me.campers', u), 'edit');
    assert.strictEqual(C.resolve('me.billing', u), 'none');
    assert.strictEqual(C.resolve('flow.setup', u), 'none');
});

// ── fail-closed behaviour ───────────────────────────────────────────────────

test('an unknown capability resolves to none', () => {
    assert.strictEqual(C.resolve('me.does-not-exist', staff()), 'none');
    assert.strictEqual(C.resolve('', staff()), 'none');
});

test('a garbage level in storage is treated as none, not trusted', () => {
    const u = staff({ overrides: { 'me.billing': 'superuser' } });
    assert.strictEqual(C.resolve('me.billing', u), 'none');
});

test('a read-only role can never be lifted above view by a preset', () => {
    const v = staff({ role: 'viewer', preset: 'full' });
    assert.strictEqual(C.resolve('me.campers', v), 'view');
    assert.strictEqual(C.resolve('me.billing', v), 'view');
    const c = staff({ role: 'counselor', overrides: { 'flow.master-scheduler': 'edit' } });
    assert.strictEqual(C.resolve('flow.master-scheduler', c), 'view');
});

test('canEdit is strict about the difference between view and edit', () => {
    const dh = staff({ preset: 'division-head' });
    assert.ok(C.can('me.campers', dh));
    assert.ok(!C.canEdit('me.campers', dh));      // view only
    assert.ok(C.canEdit('me.bunkbuilder', dh));
});

// ── settings-UI helpers ─────────────────────────────────────────────────────

test('matchPreset names a clean preset and reports Custom once it differs', () => {
    assert.strictEqual(C.matchPreset(staff({ preset: 'nurse' })), 'nurse');
    assert.strictEqual(C.matchPreset(staff({ preset: 'nurse', overrides: { 'me.billing': 'edit' } })), null);
    assert.strictEqual(C.matchPreset(staff()), null);           // unconfigured
});

test('matchPreset recognises overrides that happen to equal a preset', () => {
    const asNurse = C.expandPreset('nurse');
    assert.strictEqual(C.matchPreset(staff({ overrides: asNurse })), 'nurse');
});

test('summarize gives a readable line for each kind of user', () => {
    assert.strictEqual(C.summarize({ role: 'owner' }), 'Owner — full access');
    assert.strictEqual(C.summarize({ role: 'admin' }), 'Admin — full access');
    assert.strictEqual(C.summarize(staff()), 'Full access to their apps');
    assert.strictEqual(C.summarize(staff({ preset: 'nurse' })), 'Nurse');
    assert.match(C.summarize(staff({ overrides: { 'me.campers': 'edit' } })), /^Custom — 1 section$/);
});

test('resolveAll covers every registered capability', () => {
    const levels = C.resolveAll(staff({ preset: 'nurse' }));
    assert.strictEqual(Object.keys(levels).length, C.all().length);
    assert.ok(Object.values(levels).every(l => C.LEVELS.includes(l)));
});

test('rank orders the levels and treats junk as none', () => {
    assert.ok(C.rank('edit') > C.rank('view'));
    assert.ok(C.rank('view') > C.rank('none'));
    assert.strictEqual(C.rank('nonsense'), 0);
});

// ── every preset is coherent ────────────────────────────────────────────────

test('no preset grants edit on a view-only section', () => {
    C.PRESETS.forEach(p => {
        const exp = C.expandPreset(p.key);
        C.all().filter(c => c.viewOnly).forEach(c => {
            assert.notStrictEqual(exp[c.key], 'edit', p.key + ' grants edit on ' + c.key);
        });
    });
});

test('every preset grants at least one section, and only valid levels', () => {
    C.PRESETS.forEach(p => {
        const exp = C.expandPreset(p.key);
        const on = Object.keys(exp).filter(k => exp[k] !== 'none');
        assert.ok(on.length > 0, p.key + ' grants nothing');
        Object.values(exp).forEach(l => assert.ok(C.LEVELS.includes(l), p.key + ' bad level ' + l));
    });
});

test('no preset except full/read-only reaches into billing or payroll', () => {
    // A money section showing up in an operational preset would be the exact
    // bug this feature exists to prevent.
    C.PRESETS.filter(p => !['full', 'read-only', 'office', 'bookkeeper'].includes(p.key))
        .forEach(p => {
            const exp = C.expandPreset(p.key);
            assert.strictEqual(exp['me.payroll'], 'none', p.key + ' reaches payroll');
            assert.strictEqual(exp['me.billing'], 'none', p.key + ' reaches billing');
        });
});

// ── Snacks / Go / Live: the view-vs-edit distinction ────────────────────────
// These three are where "view" carries real weight — a canteen worker who can
// read balances but not move money, a bus coordinator who can read routes but
// not regenerate them, a counselor who can see roll call but not mark it.

test('Snacks: the POS is separable from the rest of the canteen', () => {
    // Someone auditing the canteen should read balances without a live till.
    const auditor = staff({ overrides: {
        'snacks.dashboard': 'view', 'snacks.transactions': 'view',
        'snacks.accounts': 'view', 'snacks.pos': 'none'
    } });
    assert.strictEqual(C.resolve('snacks.accounts', auditor), 'view');
    assert.ok(!C.canEdit('snacks.accounts', auditor));   // no deposits, no cash out
    assert.strictEqual(C.resolve('snacks.pos', auditor), 'none');
    assert.strictEqual(C.resolve('snacks.menu', auditor), 'none');
});

test('Snacks: canteen staff get the till, the bookkeeper does not', () => {
    assert.strictEqual(C.expandPreset('canteen')['snacks.pos'], 'edit');
    assert.strictEqual(C.expandPreset('bookkeeper')['snacks.pos'], 'none');
    // The bookkeeper still reads the ledger.
    assert.strictEqual(C.expandPreset('bookkeeper')['snacks.transactions'], 'view');
});

test('Snacks: the Camp Shop is separable from the canteen', () => {
    // The shop is a section of Snacks, so it gates independently of the canteen.
    const shopOnly = staff({ overrides: { 'snacks.shop': 'edit', 'snacks.accounts': 'none' } });
    assert.ok(C.canEdit('snacks.shop', shopOnly));
    assert.strictEqual(C.resolve('snacks.accounts', shopOnly), 'none');

    const canteenOnly = staff({ overrides: { 'snacks.menu': 'edit', 'snacks.shop': 'view' } });
    assert.ok(!C.canEdit('snacks.shop', canteenOnly));
    assert.ok(C.can('snacks.shop', canteenOnly));
});

test('Go: routes can be readable without being regenerable', () => {
    // Regenerating routes is destructive, so read-vs-write matters here.
    const dispatcher = staff({ overrides: {
        'go.routes': 'view', 'go.addresses': 'view', 'go.fleet': 'view',
        'go.setup': 'none', 'go.luggage': 'edit'
    } });
    assert.ok(C.can('go.routes', dispatcher));
    assert.ok(!C.canEdit('go.routes', dispatcher));
    assert.strictEqual(C.resolve('go.setup', dispatcher), 'none');   // API keys
    assert.ok(C.canEdit('go.luggage', dispatcher));
});

test('Go: Luggage is separable from bussing, in both directions', () => {
    const bagsOnly = staff({ overrides: { 'go.luggage': 'edit' } });
    assert.ok(C.canEdit('go.luggage', bagsOnly));
    assert.strictEqual(C.resolve('go.routes', bagsOnly), 'none');

    const busOnly = staff({ preset: 'bus-coordinator', overrides: { 'go.luggage': 'none' } });
    assert.ok(C.canEdit('go.routes', busOnly));
    assert.strictEqual(C.resolve('go.luggage', busOnly), 'none');
});

test('Go: setup is sensitive because it holds the API keys', () => {
    assert.ok(C.get('go.setup').sensitive);
});

test('Live: roll call can be watched without being marked', () => {
    const watcher = staff({ overrides: {
        'live.dashboard': 'view', 'live.roll-call': 'view',
        'live.bunk-tracker': 'view', 'live.absences': 'none'
    } });
    assert.ok(C.can('live.roll-call', watcher));
    assert.ok(!C.canEdit('live.roll-call', watcher));    // cannot mark attendance
    assert.strictEqual(C.resolve('live.absences', watcher), 'none');
});

test('Live: a counselor role is clamped to view even on an edit grant', () => {
    // Campistry Lite staff are read-only by role; a preset must not lift that.
    const c = staff({ role: 'counselor', overrides: { 'live.roll-call': 'edit' } });
    assert.strictEqual(C.resolve('live.roll-call', c), 'view');
});

test('Division Head gets Live but still no money anywhere', () => {
    const dh = staff({ preset: 'division-head' });
    assert.ok(C.canEdit('live.roll-call', dh));
    assert.ok(C.canEdit('live.absences', dh));
    assert.strictEqual(C.resolve('snacks.accounts', dh), 'none');
    assert.strictEqual(C.resolve('snacks.pos', dh), 'none');
    assert.strictEqual(C.resolve('go.setup', dh), 'none');
});

test('every section of Snacks, Go and Live is individually addressable', () => {
    // Turning exactly one section on must leave every sibling off — that's what
    // makes "fully customizable" true rather than aspirational.
    ['snacks', 'go', 'live'].forEach(app => {
        const secs = C.forApp(app);
        assert.ok(secs.length >= 6, app + ' has too few sections to be useful');
        secs.forEach(target => {
            const u = staff({ overrides: { [target.key]: target.viewOnly ? 'view' : 'edit' } });
            assert.ok(C.can(target.key, u), target.key + ' should be on');
            secs.filter(s => s.key !== target.key).forEach(other => {
                assert.strictEqual(C.resolve(other.key, u), 'none',
                    other.key + ' leaked when only ' + target.key + ' was granted');
            });
        });
    });
});
