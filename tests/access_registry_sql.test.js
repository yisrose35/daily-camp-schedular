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

    // The camp-wide default for this person's JOB (migration 165).
    const ra = u.roleAccess || null;
    let roleLevel = null, roleNames = false;
    if (ra) {
        const ro = ra.overrides || {};
        if (Object.prototype.hasOwnProperty.call(ro, capKey)) {
            roleLevel = ro[capKey]; roleNames = true;
        } else if (ra.preset) {
            const g = GRANTS.get(ra.preset + '|' + capKey);
            roleLevel = g ? g.level : null;
            roleNames = !!(g && g.explicit);
        }
    }
    const roleConfigures = !!(ra && (ra.preset || Object.keys(ra.overrides || {}).length));

    // A role default makes the person CONFIGURED, or the legacy full-access
    // rule would override the very thing the owner set on the role.
    const unconfigured = (preset == null && Object.keys(overrides).length === 0 && !roleConfigures);
    let level;
    if (unconfigured) {
        level = 'edit';
    } else {
        if (cap.section === 'finance' && !Object.prototype.hasOwnProperty.call(overrides, capKey)
            && !roleNames) {
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
        } else if (roleLevel != null) {
            level = roleLevel;
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
        roleAccess: u.roleAccess || null,
    };
}

const member = o => Object.assign({ isMember: true, isCampOwner: false, role: 'manager',
    products: null, preset: null, overrides: {}, groupFound: false, roleAccess: null }, o);

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
const mig163 = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '163_per_user_health_shop_luggage_rls.sql'), 'utf8');
const mig164 = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '164_per_user_campistryme_rls.sql'), 'utf8');

/** The body of camp_state_key_user_allowed as one migration defines it. */
function gateFn(sql) {
    return sql.slice(sql.indexOf('FUNCTION public.camp_state_key_user_allowed'),
                     sql.indexOf('GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed'));
}

test('exactly the audited keys are gated, and both read and write use one rule', () => {
    // 164 is the latest redefinition of camp_state_key_user_allowed, so IT
    // holds the current set. Each key here was added only after its readers
    // were audited; changing this list without doing that is the mistake this
    // assertion exists to catch.
    const gated = [...gateFn(mig164).matchAll(/WHEN '([A-Za-z_]+)'/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(gated, [
        'campistryHealth', 'campistryLuggage', 'campistryMe', 'campistryMeFinance',
        'campistryMePayroll', 'campistryShop', 'campistrySnacks',
    ], 'the set of per-user gated keys changed — audit every reader of the new key first');

    // app1 and campStructure must NOT be gated: both are read by Flow, Lite,
    // Snacks, Go, badges and an edge function, so neither can be treated as
    // Me-owned by any policy.
    for (const k of ['app1', 'campStructure'])
        assert.ok(!gateFn(mig164).includes("'" + k + "'"),
            k + ' is gated on a Me capability — that breaks pages unrelated to Campistry Me');

    // A later migration must carry every key an earlier one gated, or replacing
    // the function silently un-gates it. CREATE OR REPLACE makes that a quiet
    // regression rather than an error.
    for (const earlier of [mig161, mig163]) {
        for (const k of [...gateFn(earlier).matchAll(/WHEN '([A-Za-z_]+)'/g)].map(m => m[1]))
            assert.ok(gateFn(mig164).includes(k), k + ' was dropped by a later redefinition');
    }

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

// ── 4b. per-JOB defaults (165) ────────────────────────────────────────────
//
// "Everyone with the title Scheduler gets this" plus "but THIS scheduler also
// does bussing". The role default is the WEAKER layer, so the per-person screen
// stays an exception list rather than a full re-specification.

const SCHED_DEFAULT = { preset: null, overrides: { 'flow.schedule': 'edit', 'flow.print': 'edit' } };

test('a role default applies to someone with no personal access record', () => {
    // The whole point, and the subtle part: a role default has to make the
    // person COUNT AS CONFIGURED, or the legacy full-access rule overrides the
    // very thing the owner just set — and it would appear to do nothing for
    // exactly the people it is for.
    const u = member({ role: 'scheduler', roleAccess: SCHED_DEFAULT });
    assert.strictEqual(sqlResolve('flow.schedule', u), 'edit');
    assert.strictEqual(sqlResolve('me.billing', u), 'none',
        'the role default did not restrict anything — legacy full access won');
    agree(test, 'flow.schedule', u, 'role default');
    agree(test, 'me.billing', u, 'role default');
});

test('one person can be given more on top, and keeps the rest of the role', () => {
    // The scheduler who also does bussing.
    const u = member({ role: 'scheduler', roleAccess: SCHED_DEFAULT,
                       overrides: { 'go.routes': 'edit' } });
    assert.strictEqual(sqlResolve('go.routes', u), 'edit', 'the personal grant did not apply');
    assert.strictEqual(sqlResolve('flow.schedule', u), 'edit',
        'the role default was lost the moment one personal override existed');
    assert.strictEqual(sqlResolve('me.billing', u), 'none');
    for (const k of ['go.routes', 'flow.schedule', 'me.billing']) agree(test, k, u, 'role + personal');
});

test('a personal override BEATS the role default, in both directions', () => {
    const tighter = member({ role: 'scheduler', roleAccess: SCHED_DEFAULT,
                             overrides: { 'flow.schedule': 'none' } });
    assert.strictEqual(sqlResolve('flow.schedule', tighter), 'none');
    const looser = member({ role: 'scheduler',
                            roleAccess: { preset: null, overrides: { 'flow.schedule': 'none' } },
                            overrides: { 'flow.schedule': 'edit' } });
    assert.strictEqual(sqlResolve('flow.schedule', looser), 'edit');
    agree(test, 'flow.schedule', tighter, 'personal tightens');
    agree(test, 'flow.schedule', looser, 'personal loosens');
});

test("a person's own PRESET shadows the role default entirely", () => {
    // A preset is a complete specification of that person's access, so it
    // replaces the role's opinion rather than merging with it. Otherwise
    // "Nurse" would quietly inherit whatever the job default granted.
    const u = member({ role: 'scheduler', preset: 'nurse', roleAccess: SCHED_DEFAULT });
    assert.strictEqual(sqlResolve('flow.schedule', u), 'none',
        'the role default leaked through a personal preset');
    assert.notStrictEqual(sqlResolve('health.medications', u), 'none');
    agree(test, 'flow.schedule', u, 'personal preset shadows role');
});

test('a role default can itself be a preset', () => {
    const u = member({ role: 'scheduler', roleAccess: { preset: 'head-counselor', overrides: {} } });
    assert.notStrictEqual(sqlResolve('flow.schedule', u), 'none');
    assert.strictEqual(sqlResolve('me.billing', u), 'none');
    for (const cap of CAPS.keys()) agree(test, cap, u, 'role preset default');
});

test('an EMPTY role default is not a restriction — it is no default', () => {
    // set_camp_role_access deletes the row for this case on purpose. If an
    // empty default counted as "configured", a whole job title would be denied
    // everything unlisted, i.e. everything.
    for (const empty of [null, { preset: null, overrides: {} }]) {
        const u = member({ role: 'scheduler', roleAccess: empty });
        assert.strictEqual(sqlResolve('me.campers', u), 'edit',
            'an empty role default locked the job out');
        agree(test, 'me.campers', u, 'empty role default');
    }
});

test('the role default never lifts anyone past the entitlement', () => {
    // The ceiling holds above all of this. Checked through the real resolver,
    // since the transliteration deliberately does not model entitlements.
    const access = {
        role: 'scheduler', products: null, preset: null, overrides: {},
        entitlements: { me: '*' },              // no Flow
        roleAccess: SCHED_DEFAULT,              // grants Flow
    };
    assert.strictEqual(C.resolve('flow.schedule', access), 'none');
});

test('a role default does not apply to an owner or admin', () => {
    // They are ungated by design; a default for them would be a setting that
    // silently does nothing, which is why the table rejects those roles.
    for (const role of ['owner', 'admin']) {
        const u = member({ role, roleAccess: SCHED_DEFAULT });
        assert.strictEqual(sqlResolve('me.billing', u), 'edit');
        agree(test, 'me.billing', u, role + ' ignores role defaults');
    }
});

test('SQL and JS agree on role defaults across every capability and preset', () => {
    for (const p of C.PRESETS) {
        const u = member({ role: 'scheduler', roleAccess: { preset: p.key, overrides: {} } });
        for (const cap of CAPS.keys()) agree(test, cap, u, 'role default preset=' + p.key);
    }
});

// ── 5. health / shop / luggage (163) ──────────────────────────────────────

function anyApp(app, u) {
    return [...CAPS.keys()].filter(k => CAPS.get(k).app === app)
        .some(k => sqlResolve(k, u) !== 'none');
}

test('health, shop and luggage land where the presets say they should', () => {
    // Mirrors the table in 163's header. The grain matches what migration 157
    // already uses for the CAMP entitlement on these same keys, so the
    // camp-level and user-level rules stay readable as one rule.
    var expected = {
        //                 health,  shop,   luggage
        'full':            [true,   true,   true],
        'read-only':       [true,   true,   true],
        'nurse':           [true,   false,  false],
        'canteen':         [false,  true,   false],
        'bus-coordinator': [false,  false,  true],
        'division-head':   [false,  false,  false],
        'head-counselor':  [false,  false,  false],
        'office':          [false,  false,  false],
        'bookkeeper':      [false,  false,  false],
    };
    for (const [preset, want] of Object.entries(expected)) {
        const u = member({ preset });
        assert.strictEqual(anyApp('health', u), want[0], preset + ' health');
        assert.strictEqual(sqlResolve('snacks.shop', u) !== 'none', want[1], preset + ' shop');
        assert.strictEqual(sqlResolve('go.luggage', u) !== 'none', want[2], preset + ' luggage');
    }
});

test('an unconfigured member keeps health, shop and luggage', () => {
    // The backward-compatibility rule again, on the three newest keys. If this
    // breaks, applying 163 takes Health away from most of a camp at once.
    for (const role of ['owner', 'admin', 'manager', 'scheduler', 'viewer', 'counselor']) {
        const u = member({ role });
        assert.ok(anyApp('health', u), 'unconfigured ' + role + ' lost Health');
        assert.notStrictEqual(sqlResolve('snacks.shop', u), 'none');
        assert.notStrictEqual(sqlResolve('go.luggage', u), 'none');
    }
});

test('the nurse preset reaches every health section, and nothing else new', () => {
    const nurse = member({ preset: 'nurse' });
    for (const k of [...CAPS.keys()].filter(k => CAPS.get(k).app === 'health')) {
        assert.notStrictEqual(sqlResolve(k, nurse), 'none', 'nurse lost ' + k);
    }
    assert.strictEqual(sqlResolve('go.luggage', nurse), 'none');
    assert.strictEqual(sqlResolve('snacks.shop', nurse), 'none');
});

test('163 changes no policies — it only replaces the gate function', () => {
    // The whole point of routing every policy through one function: adding a
    // key is a function replace. A CREATE POLICY here would mean the four
    // policies had drifted and needed re-stating, which is worth noticing.
    assert.ok(!/CREATE POLICY/.test(mig163),
        '163 rewrites a policy — adding a key should only replace the gate function');
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
