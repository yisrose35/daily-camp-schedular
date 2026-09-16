// node --test tests/camp_scoped_rpc_auth.test.js
//
// A camp id was being used as a password, and it is not one — camp ids sit in
// public form URLs, tip links and the canteen deposit page by design.
//
// Four SECURITY DEFINER RPCs took a camp id, checked nothing about the caller,
// and were granted to `anon`:
//
//   get_canteen_accounts   every camper's NAME, balance, limits and the camp's
//                          entire transaction ledger
//   get_link_tip_targets   every staff member's zelle/venmo/paypal/cashapp
//   get_link_tips_config   the tips config blob, which carries staffPay handles
//   get_camp_broadcasts    every message the camp has sent its parents
//
// Not one needed anon: every caller is the parent portal or Lite, both logged
// in. And removing anon alone would have left them readable by any logged-in
// user of any OTHER camp, so each one now asks whether the caller has a real
// relationship with that camp.
//
// Two of the writers were mine: flag_expiring_cards and
// sync_family_ledger_payments went out granted to `authenticated`.
//
// The last test here is the point of the file: it re-runs the audit that found
// all this, so the next function added with the same shape fails CI instead of
// waiting to be noticed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M183 = read('migrations/183_lock_down_camp_scoped_readers.sql');

const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+[a-z]?_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

/** Every CREATE of a function, in apply order: name -> {args, body}. Last wins. */
function catalogue() {
    const out = {};
    for (const f of MIGRATIONS) {
        const sql = read('migrations/' + f);
        const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql))) {
            const end = sql.indexOf('\n$$;', m.index);
            out[m[1]] = { file: f, args: m[2],
                          body: sql.slice(m.index, end > 0 ? end : m.index + 4000) };
        }
    }
    return out;
}

/** Roles a function ends up executable by, applying GRANTs and REVOKEs in order. */
function grantsOf() {
    const out = {};
    for (const f of MIGRATIONS) {
        const sql = read('migrations/' + f);
        for (const m of sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\)\s*TO ([^;]+);/g)) {
            const s = out[m[1]] || (out[m[1]] = new Set());
            m[2].split(',').forEach(r => s.add(r.trim()));
        }
        for (const m of sql.matchAll(/REVOKE (?:ALL|EXECUTE) ON FUNCTION public\.(\w+)\([^)]*\)\s*FROM ([^;]+);/g)) {
            const s = out[m[1]] || (out[m[1]] = new Set());
            m[2].split(',').forEach(r => s.delete(r.trim()));
        }
    }
    return out;
}

const FNS = catalogue();
const GRANTS = grantsOf();

test('the catalogue was actually read', () => {
    assert.ok(Object.keys(FNS).length > 200,
        `only ${Object.keys(FNS).length} functions found — the parser is broken`);
    for (const n of ['get_canteen_accounts', 'get_link_tip_targets', 'camp_reader']) {
        assert.ok(FNS[n], `${n} is missing from the catalogue`);
    }
});

// ── 1. the four are shut ────────────────────────────────────────────────────

const LOCKED = ['get_canteen_accounts', 'get_link_tip_targets',
                'get_link_tips_config', 'get_camp_broadcasts'];

test('none of the leaking readers is reachable by anon any more', () => {
    for (const n of LOCKED) {
        assert.ok(!GRANTS[n].has('anon'),
            `${n} is still granted to anon — a camp id is all anyone needs`);
        assert.ok(GRANTS[n].has('authenticated'),
            `${n} is no longer callable by the app at all`);
    }
});

test('each one asks who is calling, not just what camp', () => {
    // Removing anon is half of it. Without this, any logged-in user of any
    // other camp reads the lot by passing a different uuid.
    for (const n of LOCKED) {
        const body = FNS[n].body;
        assert.match(body, /camp_reader\(|camp_staff_member\(|camp_parent_campers\(/,
            `${n} still has no caller check`);
        assert.match(body, /'not_authorized'/,
            `${n} has no path that refuses`);
    }
});

// ── 2. the canteen change, which is the one with teeth ──────────────────────

test('a stranger gets nothing from the canteen', () => {
    const body = FNS.get_canteen_accounts.body;
    assert.match(body, /jsonb_array_length\(v_mine\) = 0 THEN[\s\S]{0,200}'not_authorized'/,
        'a caller with no relationship to the camp still gets a reply');
});

test('a parent gets their own children, not the camp', () => {
    const body = FNS.get_canteen_accounts.body;
    assert.match(body, /FOR k IN SELECT jsonb_array_elements_text\(v_mine\) LOOP/,
        'the accounts map is not filtered to the caller’s own campers');
    // The ledger matters as much as the balances: it is a list of what other
    // people's children bought.
    assert.match(body, /v_mine \? COALESCE\(t->>'camper', ''\)/,
        'the transaction list is returned unfiltered, so a parent still sees ' +
        'every other family’s canteen purchases');
    assert.match(body, /'scope', 'parent'/,
        'nothing tells the caller the reply was scoped');
});

test('staff still get the whole camp, and are checked first', () => {
    // The POS needs every account. And a staff member who is also a parent at
    // the same camp must not be cut down to their own child.
    const body = FNS.get_canteen_accounts.body;
    const staffAt = body.indexOf('camp_staff_member(p_camp_id)');
    const parentAt = body.indexOf('camp_parent_campers(p_camp_id)');
    assert.ok(staffAt > 0 && parentAt > staffAt,
        'the parent branch is tested before the staff branch');
});

test('the POS still qualifies as staff', () => {
    // pos-pin-login signs a shadow user in for real and gives them a
    // camp_users row. If camp_staff_member only accepted owner/admin, every
    // register in the country would stop working.
    const helper = FNS.camp_staff_member.body;
    assert.ok(!/role IN \('owner', 'admin'\)/.test(helper),
        'camp_staff_member excludes counselors, which locks the POS out of ' +
        'the canteen balances it exists to read');
    assert.match(helper, /accepted_at IS NOT NULL/,
        'a pending invite counts as staff');
    const pos = read('supabase/functions/pos-pin-login/index.ts');
    assert.match(pos, /from\("camp_users"\)\.insert/);
    assert.match(pos, /accepted_at: new Date\(\)\.toISOString\(\)/);
});

// ── 3. the helpers ──────────────────────────────────────────────────────────

test('the helpers are camp-SCOPED, unlike get_user_role', () => {
    // get_user_role() answers for the caller's own camp via get_user_camp_id(),
    // so it can say nothing about a camp id passed in from outside. Using it
    // here would have been an authorization check that checks the wrong camp.
    for (const n of ['camp_staff_member', 'camp_parent_campers', 'camp_reader']) {
        assert.ok(FNS[n], `${n} is missing`);
        assert.match(FNS[n].args, /p_camp_id uuid/, `${n} is not camp-scoped`);
        assert.ok(!/get_user_camp_id\(\)/.test(FNS[n].body),
            `${n} resolves the caller's OWN camp instead of the one asked about`);
    }
    assert.match(FNS.camp_parent_campers.body, /i\.user_id = auth\.uid\(\)/);
    assert.match(FNS.camp_parent_campers.body, /expires_at IS NULL OR i\.expires_at > now\(\)/,
        'an expired invite still grants access');
});

test('the helpers are not themselves callable by anon', () => {
    for (const n of ['camp_staff_member', 'camp_parent_campers', 'camp_reader']) {
        assert.ok(!GRANTS[n].has('anon'), `${n} is exposed to anon`);
    }
});

// ── 4. the two writers that were mine ───────────────────────────────────────

test('my two writers are service_role only', () => {
    for (const n of ['flag_expiring_cards', 'sync_family_ledger_payments']) {
        assert.ok(!GRANTS[n].has('authenticated'),
            `${n} WRITES to a camp blob and any logged-in user can still call it ` +
            `against any camp id`);
        assert.ok(!GRANTS[n].has('anon'), `${n} is exposed to anon`);
        assert.ok(GRANTS[n].has('service_role'),
            `${n} is no longer callable by the nightly runner that needs it`);
    }
    assert.match(M183, /REVOKE EXECUTE ON FUNCTION public\.flag_expiring_cards/);
    assert.match(M183, /REVOKE EXECUTE ON FUNCTION public\.sync_family_ledger_payments/);
});

// ── 5. the audit itself, so the next one is caught here ─────────────────────

test('no camp-scoped SECURITY DEFINER function is open to anon without a gate', () => {
    // Legitimately public, each for a stated reason. Anything NOT on this list
    // that takes a camp id, bypasses RLS and is reachable by anon has to
    // authorize its caller — or be added here with a reason.
    const PUBLIC_BY_DESIGN = {
        get_camp_public_tokenization_key:
            'the card page a family opens has no session; returns only the PUBLIC key',
        get_shop_catalogue: 'a shop catalogue is a price list',
        get_link_camp_forms: 'the list of forms a camp offers, no responses',
        get_link_camp_lists: 'packing lists and similar, published to families',
        get_camp_canteen_stripe_status: 'whether deposits are switched on, nothing more',
        submit_public_application: 'the public application form itself',
        get_public_application_status: 'gated by the application token, not the camp id',
        flag_application_payment_followup: 'gated by the application token',
        get_public_form_config:
            'the public registration/staff form itself — p_kind is just which of ' +
            'the two, not a secret, and the form is meant to be open',
        // These four are gated by an id that acts as a bearer token: an
        // enrollment id ('enr_<ms>_<6 base36>') or a staff application id
        // ('staff_<ms>_<4 base36>'), both minted client-side by the public
        // form. That is a real gate, not an open door — but it is a bearer
        // token of moderate entropy with no rate limiting in front of it, and
        // get_contract_offer returns payType/payRate while accept_staff_contract
        // records an acceptance. Worth strengthening; tracked separately.
        get_postaccept_bootstrap: 'gated by the enrollment id (bearer token)',
        submit_postaccept_response: 'gated by the enrollment id (bearer token)',
        get_contract_offer: 'gated by the staff application id (bearer token)',
        accept_staff_contract: 'gated by the staff application id (bearer token)',
        get_posthire_bootstrap: 'gated by the staff application id (bearer token)',
        submit_posthire_response: 'gated by the staff application id (bearer token)',
    };
    const TOKEN_GATED = /,\s*p_\w*(token|slug|code|key|email|ref)\w*\s+text/i;

    const offenders = [];
    for (const [name, { args, body, file }] of Object.entries(FNS)) {
        const g = GRANTS[name];
        if (!g || !g.has('anon')) continue;
        if (!/SECURITY DEFINER/.test(body)) continue;
        if (!/camp_id|p_camp/.test(args)) continue;
        if (PUBLIC_BY_DESIGN[name]) continue;
        if (TOKEN_GATED.test(args)) continue;           // the second arg IS the secret
        const authorizes = /auth\.uid\(\)|camp_users|link_parent_invites|camp_reader\(|camp_staff_member\(|not_authorized|get_user_role|_deposit_can_admin/.test(body);
        if (!authorizes) offenders.push(`${name} (${file})`);
    }
    assert.deepStrictEqual(offenders, [],
        'these take a camp id, bypass RLS and are callable by anyone with that ' +
        'id, and they check nothing about the caller. Either authorize them or ' +
        'add them to PUBLIC_BY_DESIGN with a reason:\n  ' + offenders.join('\n  '));
});

test('nothing that WRITES is reachable by anon at all', () => {
    // A read leak is bad; an anonymous write is worse. Public form submission
    // is the one deliberate exception and is named.
    const WRITE_OK = new Set([
        'submit_public_application', 'submit_postaccept_response',
        'submit_posthire_response', 'accept_staff_contract',
        'flag_application_payment_followup', 'submit_canteen_deposit',
    ]);
    const bad = [];
    for (const [name, { body }] of Object.entries(FNS)) {
        const g = GRANTS[name];
        if (!g || !g.has('anon')) continue;
        if (WRITE_OK.has(name)) continue;
        if (/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(body)) bad.push(name);
    }
    assert.deepStrictEqual(bad, [],
        'anon can call these and they write: ' + bad.join(', '));
});
