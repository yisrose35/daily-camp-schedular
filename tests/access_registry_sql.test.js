// node --test tests/access_registry_sql.test.js
//
// Phase 3 moved the per-STAFF section-access decision into the database
// (migrations 159 + 160), so there are now TWO implementations of one set of
// rules: C.resolve() in campistry_capabilities.js, and user_section_level() in
// SQL. They must agree. When they don't, nothing throws — the wrong people are
// quietly locked out, or quietly let in.
//
// This file guards both halves of that:
//
//   1. DATA — migration 159 is generated from the registry. If someone edits
//      C.CAPABILITIES or C.PRESETS and doesn't re-run the generator, the
//      checked-in SQL is stale and the database resolves against yesterday's
//      rules. The first test regenerates and compares.
//
//   2. LOGIC — the second half transliterates user_section_level()'s branches
//      into JS and checks them against C.resolve over every capability, preset
//      and role, plus the edge cases that actually bite (the finance/analytics
//      legacy fallback, the unconfigured rule, the view-only and read-only-role
//      floors, an empty product list, an empty-string preset).
//
// WHAT THIS DOES NOT PROVE: that the SQL *text* executes identically — there is
// no Postgres here to run it against. It proves the DATA is current and the
// RULES as encoded are right, which is where the mistakes actually were. The
// lookup tables below are parsed out of the generated migration rather than
// rebuilt from the registry, so the test exercises the same rows the database
// will. Verify the real function against the truth table at the bottom of
// migration 159 after applying it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../campistry_capabilities.js');
const { build } = require('../scripts/build-access-registry-sql.js');

const SQL_PATH = path.join(__dirname, '..', 'migrations', '159_access_registry_tables.sql');
const sqlText = fs.readFileSync(SQL_PATH, 'utf8');

// ── 1. the generated file is current ───────────────────────────────────────

test('migration 159 matches the capability registry (re-run the generator if this fails)', () => {
    assert.strictEqual(sqlText, build(),
        'migrations/159_access_registry_tables.sql is stale — run:\n' +
        '    node scripts/build-access-registry-sql.js');
});

// ── parse the generated rows, so the logic test uses the DB's own data ─────

function rowsOf(insertMarker) {
    const start = sqlText.indexOf(insertMarker);
    assert.ok(start >= 0, 'could not find INSERT: ' + insertMarker);
    const body = sqlText.slice(start + insertMarker.length);
    const end = body.indexOf(';');
    return body.slice(0, end).split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('('))
        .map(l => l.replace(/^\(|\),?$/g, '').split(',').map(v => {
            const t = v.trim();
            if (t === 'true') return true;
            if (t === 'false') return false;
            return t.replace(/^'|'$/g, '').replace(/''/g, "'");
        }));
}

const CAPS = new Map();          // cap_key -> { app, section, viewOnly }
for (const [cap_key, app, section, view_only] of
        rowsOf('INSERT INTO access_capabilities (cap_key, app, section, view_only) VALUES')) {
    CAPS.set(cap_key, { app, section, viewOnly: view_only });
}

const GRANTS = new Map();        // preset|cap -> { level, explicit }
for (const [preset, cap_key, level, explicit] of
        rowsOf('INSERT INTO access_preset_grants (preset, cap_key, level, explicit) VALUES')) {
    GRANTS.set(preset + '|' + cap_key, { level, explicit });
}

test('the parsed tables cover the whole registry', () => {
    assert.strictEqual(CAPS.size, C.all().length);
    assert.strictEqual(GRANTS.size, C.all().length * C.PRESETS.length);
});

// ── 2. a transliteration of user_section_level(), branch for branch ───────
//
// Deliberately written to follow the SQL's structure rather than the JS's, so
// that it can disagree with C.resolve. If it were just a copy of resolve() the
// comparison below would be worthless.

function sqlResolve(capKey, u) {
    const cap = CAPS.get(capKey);
    if (!cap) return 'edit';                                   // not catalogued

    if (u.isCampOwner) return cap.viewOnly ? 'view' : 'edit';  // camps.owner
    if (!u.isMember) return 'edit';                            // fail open

    let products = u.groupFound ? u.groupProducts : u.products;
    let preset = u.groupFound ? u.groupPreset : u.preset;
    let overrides = u.groupFound ? u.groupOverrides : u.overrides;

    products = products || [];
    overrides = overrides || {};
    if (preset === '') preset = null;

    if (u.role === 'owner' || u.role === 'admin') return cap.viewOnly ? 'view' : 'edit';

    if (Array.isArray(products) && products.length > 0 && products.indexOf(cap.app) < 0) {
        return 'none';
    }

    const unconfigured = (preset == null && Object.keys(overrides).length === 0);
    let level;
    if (unconfigured) {
        level = 'edit';
    } else {
        if (cap.section === 'finance' && !Object.prototype.hasOwnProperty.call(overrides, capKey)) {
            const g = preset != null ? GRANTS.get(preset + '|' + capKey) : null;
            if (preset == null || !(g && g.explicit)) {
                return sqlResolve(cap.app + '.analytics', u);
            }
        }
        if (Object.prototype.hasOwnProperty.call(overrides, capKey)) {
            level = overrides[capKey];
        } else if (preset != null) {
            const g = GRANTS.get(preset + '|' + capKey);
            level = g ? g.level : null;
        } else {
            level = 'none';
        }
    }

    if (level == null || ['none', 'view', 'edit'].indexOf(level) < 0) level = 'none';
    if ((u.role === 'viewer' || u.role === 'counselor') && level === 'edit') level = 'view';
    if (cap.viewOnly && level === 'edit') level = 'view';
    return level;
}

// The access object C.resolve sees, built the way campistry_access_sections.js
// apply() builds it — including its empty-array-to-null normalisation, which is
// the behaviour the SQL has to match.
function jsAccess(u) {
    const products = u.groupFound ? u.groupProducts : u.products;
    const preset = u.groupFound ? u.groupPreset : u.preset;
    const overrides = u.groupFound ? u.groupOverrides : u.overrides;
    return {
        role: u.isCampOwner ? 'owner' : u.role,
        products: (Array.isArray(products) && products.length) ? products : null,
        preset: preset || null,
        overrides: overrides || {},
        entitlements: {},
    };
}

const member = o => Object.assign({ isMember: true, isCampOwner: false, role: 'manager',
    products: null, preset: null, overrides: {}, groupFound: false }, o);

function agree(t, capKey, u, what) {
    const a = sqlResolve(capKey, u);
    const b = C.resolve(capKey, jsAccess(u));
    assert.strictEqual(a, b, `${what}: ${capKey} — SQL says '${a}', JS says '${b}'`);
}

test('SQL and JS agree for every capability under every preset', () => {
    for (const p of C.PRESETS) {
        for (const capKey of CAPS.keys()) {
            agree(test, capKey, member({ preset: p.key }), `preset=${p.key}`);
        }
    }
});

test('SQL and JS agree for every role, on the two keys phase 3 gates', () => {
    for (const role of ['owner', 'admin', 'manager', 'scheduler', 'viewer', 'counselor']) {
        for (const capKey of ['me.payroll', 'me.finance']) {
            agree(test, capKey, member({ role, preset: 'read-only' }), `role=${role}`);
            agree(test, capKey, member({ role, preset: 'full' }), `role=${role} full`);
            agree(test, capKey, member({ role }), `role=${role} unconfigured`);
        }
    }
});

test('an unconfigured member keeps full access — the backward-compatibility rule', () => {
    // The rule that makes shipping this safe: nobody who was never configured
    // is newly restricted. If this breaks, applying 160 locks out most of a
    // camp's staff at once.
    const u = member({});
    assert.strictEqual(sqlResolve('me.payroll', u), 'edit');
    assert.strictEqual(sqlResolve('me.finance', u), 'view');   // view-only cap
    agree(test, 'me.payroll', u, 'unconfigured');
    agree(test, 'me.finance', u, 'unconfigured');
});

test('overrides present but the key unlisted means off', () => {
    const u = member({ overrides: { 'me.campers': 'edit' } });
    assert.strictEqual(sqlResolve('me.payroll', u), 'none');
    agree(test, 'me.payroll', u, 'explicit-sections user');
});

test('an override beats the preset', () => {
    const u = member({ preset: 'bookkeeper', overrides: { 'me.payroll': 'none' } });
    assert.strictEqual(sqlResolve('me.payroll', u), 'none');
    agree(test, 'me.payroll', u, 'override over preset');
});

test('finance falls back to analytics when no preset or override names it', () => {
    // Access configured before "Analytics & Finance" split only ever names
    // 'analytics'. Treating finance as an unlisted key would silently take
    // financial data away from people who already had it.
    const u = member({ overrides: { 'me.analytics': 'view' } });
    assert.strictEqual(sqlResolve('me.finance', u), 'view');
    agree(test, 'me.finance', u, 'legacy analytics grant');

    const off = member({ overrides: { 'me.analytics': 'none' } });
    assert.strictEqual(sqlResolve('me.finance', off), 'none');
    agree(test, 'me.finance', off, 'legacy analytics denial');
});

test('a preset that names finance explicitly does NOT fall back', () => {
    // bookkeeper grants me.finance:view and me.analytics:view, so the fallback
    // is invisible there. Pin the mechanism with a divergent override instead.
    const u = member({ preset: 'bookkeeper', overrides: { 'me.analytics': 'none' } });
    assert.strictEqual(sqlResolve('me.finance', u), 'view',
        'explicit preset grant was discarded in favour of the analytics fallback');
    agree(test, 'me.finance', u, 'explicit preset grant wins');
});

test('the product gate denies a section of an app the user cannot open', () => {
    const u = member({ products: ['flow'], preset: 'full' });
    assert.strictEqual(sqlResolve('me.payroll', u), 'none');
    agree(test, 'me.payroll', u, 'product gate');
});

test('an EMPTY product list is no restriction, not a total denial', () => {
    // resolve() alone would deny everything for [] — apply() maps empty to null
    // before it ever gets there. Reading the table directly, the SQL sees the
    // real [] and has to make the same choice, or every member whose
    // product_access is [] loses access to everything.
    const u = member({ products: [], preset: 'full' });
    assert.strictEqual(sqlResolve('me.payroll', u), 'edit');
    agree(test, 'me.payroll', u, 'empty product list');
});

test("an empty-string preset counts as no preset", () => {
    // '' is not NULL in SQL but is falsy in JS. Getting this wrong locks a user
    // out of a section the browser is showing them.
    const u = member({ preset: '' });
    assert.strictEqual(sqlResolve('me.payroll', u), 'edit');
    agree(test, 'me.payroll', u, 'empty-string preset');
});

test('a group assignment replaces the member columns wholesale', () => {
    // Migration 097's intent, and 154's fix: no merge. The member's own
    // generous columns must not leak through a restrictive group.
    const u = member({
        preset: 'full', overrides: { 'me.payroll': 'edit' },
        groupFound: true, groupPreset: 'nurse', groupOverrides: {}, groupProducts: null,
    });
    assert.strictEqual(sqlResolve('me.payroll', u), 'none');
    agree(test, 'me.payroll', u, 'group replaces member');
});

test('a group with a NULL preset and no sections is unconfigured, not denied', () => {
    // The 154 bug in its other form: a group built from raw toggles has a NULL
    // preset. Failing that test used to fall through to the member's columns.
    // Here the group is genuinely empty, so the backward-compatibility rule
    // applies and the user keeps access rather than being locked out.
    const u = member({
        preset: 'nurse',
        groupFound: true, groupPreset: null, groupOverrides: {}, groupProducts: null,
    });
    assert.strictEqual(sqlResolve('me.payroll', u), 'edit');
    agree(test, 'me.payroll', u, 'empty group');
});

test('the camp owner and a non-member both keep access', () => {
    assert.strictEqual(sqlResolve('me.payroll', member({ isCampOwner: true, preset: 'nurse' })), 'edit');
    // Fail open, matching get_my_access. Unreachable through the policies, which
    // also require camp_id = get_user_camp_id() — but it must not be 'none'.
    assert.strictEqual(sqlResolve('me.payroll', member({ isMember: false })), 'edit');
});

// ── 3. the gate only covers the keys it claims to ─────────────────────────

const mig160 = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '160_per_user_key_rls.sql'), 'utf8');
const mig161 = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '161_per_user_snacks_key_rls.sql'), 'utf8');

test('exactly the audited keys are gated, and both read and write use one rule', () => {
    // 161 redefines camp_state_key_user_allowed, so IT holds the current set.
    const fn = mig161.slice(mig161.indexOf('FUNCTION public.camp_state_key_user_allowed'),
                            mig161.indexOf('GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed'));
    const gated = [...fn.matchAll(/WHEN '([A-Za-z_]+)'/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(gated,
        ['campistryMeFinance', 'campistryMePayroll', 'campistrySnacks'],
        'the set of per-user gated keys changed — audit every reader of the new key first');

    // The four main policies live in 160 and call the gate by name, so adding a
    // key is a function replace. They must all still carry both checks:
    // Postgres OR-combines permissive policies, so one without it reopens the
    // door through that command.
    for (const p of ['camp_state_kv_select', 'camp_state_kv_insert',
                     'camp_state_kv_update', 'camp_state_kv_delete']) {
        const start = mig160.indexOf('CREATE POLICY ' + p + ' ');
        assert.ok(start >= 0, p + ' is not defined in 160');
        const body = mig160.slice(start, mig160.indexOf(');', start));
        assert.ok(body.includes('camp_state_key_user_allowed'), p + ' is missing the per-user check');
        assert.ok(body.includes('camp_state_key_entitled'), p + ' lost the entitlement check');
    }
});

test("the counselor POS policies carry the check too, or a counselor writes past it", () => {
    // Migration 099 gives counselors their OWN insert/update policy on
    // campistrySnacks. Gating only the four main policies does nothing for
    // them — this is the same hole 157 had to close for the entitlement.
    for (const p of ['camp_state_kv_insert_counselor_snacks',
                     'camp_state_kv_update_counselor_snacks']) {
        const start = mig161.indexOf('CREATE POLICY ' + p + ' ');
        assert.ok(start >= 0, p + ' is not re-created in 161');
        const body = mig161.slice(start, mig161.indexOf(');', start));
        assert.ok(body.includes('camp_state_key_user_allowed'), p + ' is missing the per-user check');
        assert.ok(body.includes('camp_state_key_entitled'), p + ' lost the entitlement check');
    }
});

// ── 4. the snacks key: whole-app grain ────────────────────────────────────
//
// campistrySnacks holds seven sections in one key, so the gate asks a
// whole-app question. This mirrors user_app_any_section().

const SNACKS_CAPS = [...CAPS.keys()].filter(k => CAPS.get(k).app === 'snacks');

function anySnacks(u) {
    return SNACKS_CAPS.some(k => sqlResolve(k, u) !== 'none');
}

test('the snacks key follows "any section of the app"', () => {
    assert.ok(SNACKS_CAPS.length >= 7, 'snacks sections went missing from the registry');
    const expected = {
        full: true, bookkeeper: true, canteen: true, 'read-only': true,
        nurse: false, 'division-head': false, 'head-counselor': false,
        office: false, 'bus-coordinator': false,
    };
    for (const [preset, allowed] of Object.entries(expected)) {
        assert.strictEqual(anySnacks(member({ preset })), allowed,
            `preset ${preset}: expected snacks ${allowed ? 'allowed' : 'denied'}`);
    }
});

test('THE REGISTER KEEPS WORKING — an unconfigured counselor passes the gate', () => {
    // The one that could break a camp mid-day. The POS runs as a counselor
    // doing a direct upsert, and user_section_level floors counselors at
    // 'view' — so a gate on 'edit' would have killed every register in every
    // camp. The gate is "not none", and an unconfigured counselor is 'view'.
    const pos = member({ role: 'counselor' });
    assert.strictEqual(sqlResolve('snacks.pos', pos), 'view');
    assert.ok(anySnacks(pos), 'the POS counselor lost canteen access');

    const gate = mig161.slice(mig161.indexOf('FUNCTION public.user_app_any_section'),
                              mig161.indexOf('GRANT EXECUTE ON FUNCTION public.user_app_any_section'));
    assert.ok(gate.includes("<> 'none'"), 'the snacks gate no longer tests for "not none"');
    assert.ok(!/=\s*'edit'/.test(gate), 'the snacks gate tests for edit — every POS register breaks');
});

test('an unconfigured member of any role keeps the canteen', () => {
    // The backward-compatibility rule, on the key with the most readers.
    for (const role of ['owner', 'admin', 'manager', 'scheduler', 'viewer', 'counselor']) {
        assert.ok(anySnacks(member({ role })), 'unconfigured ' + role + ' lost the canteen');
    }
});

test('a nurse cannot reach the canteen ledger', () => {
    // The actual tightening: balances and spending history stop being readable
    // by every staff member with a session.
    const nurse = member({ preset: 'nurse' });
    assert.ok(!anySnacks(nurse));
    for (const k of SNACKS_CAPS) assert.strictEqual(sqlResolve(k, nurse), 'none');
});

test('an app with no catalogued sections is not gated', () => {
    // user_app_any_section returns true for an unknown app rather than denying
    // a whole product we simply have not catalogued.
    assert.strictEqual(
        [...CAPS.keys()].filter(k => CAPS.get(k).app === 'no-such-app').length, 0);
    const fn = mig161.slice(mig161.indexOf('FUNCTION public.user_app_any_section'),
                            mig161.indexOf('GRANT EXECUTE ON FUNCTION public.user_app_any_section'));
    assert.ok(fn.includes('NOT EXISTS'), 'the unknown-app fallback is gone');
});

test('writes are gated on "not none", never on "edit"', () => {
    // me.finance is a view-only capability, so it never resolves to 'edit' for
    // anyone — the owner included. Gating writes on 'edit' would make Finance
    // permanently unsaveable for every user in every camp.
    assert.strictEqual(C.resolve('me.finance', { role: 'owner', products: null,
        preset: null, overrides: {}, entitlements: {} }), 'view');

    const mig = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '160_per_user_key_rls.sql'), 'utf8');
    const fn = mig.slice(mig.indexOf('FUNCTION public.camp_state_key_user_allowed'),
                         mig.indexOf('GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed'));
    assert.ok(fn.includes("<> 'none'"), 'the key gate no longer tests for "not none"');
    assert.ok(!/=\s*'edit'/.test(fn), 'the key gate tests for edit — Finance becomes unsaveable');
});
