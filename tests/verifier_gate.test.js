// =============================================================================
// Every verify_* function must be runnable by the person it was written for.
//
// WHY. These verifiers exist to be pasted into the Supabase SQL Editor by the
// camp owner, because that is the only way this project applies anything — it
// has no CLI. The SQL Editor carries NO JWT, so auth.uid() is NULL, so
// camp_reader() returns false, so a verifier gated on camp_reader() alone
// answers {"error":"not_your_camp"} to the one person entitled to run it.
//
// That has now happened three times: 202's verifier, then 211's was written
// correctly after it, and then 216/217/218 repeated the original mistake
// because the correct pattern lived only in a file nobody re-read.
//
// current_user does not help: inside SECURITY DEFINER it is the function's
// owner for every caller alike. The working gate reads the JWT claims and
// only enforces when there ARE claims — a real API caller is checked, a
// direct SQL session is not, and a direct SQL session already has whatever
// access it likes.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/** Every verify_* function defined in migrations, with its body. */
function verifiers() {
    const out = [];
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && !f.startsWith('APPLY'))) {
        const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
        const re = /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(verify_\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql)) !== null) {
            const start = m.index;
            const end = sql.indexOf('$$;', start);
            if (end < 0) continue;
            out.push({ file: f, name: m[1], args: m[2], body: sql.slice(start, end) });
        }
    }
    return out;
}

// Verifiers that take no camp id have nothing to gate on, so the rule does not
// apply to them.
const scoped = () => verifiers().filter(v => /p_camp_id\s+uuid/.test(v.args));

test('a camp-scoped verifier does not lock out the SQL Editor', () => {
    const broken = [];
    for (const v of scoped()) {
        const callsReader = /NOT\s+public\.camp_reader\s*\(\s*p_camp_id\s*\)/.test(v.body);
        if (!callsReader) continue;                 // gated some other way, or not at all
        const readsClaims = /current_setting\('request\.jwt\.claims',\s*true\)/.test(v.body);
        const onlyWhenClaims = /v_claims\s+IS\s+NOT\s+NULL/i.test(v.body);
        if (!readsClaims || !onlyWhenClaims) {
            broken.push(`${v.file}: ${v.name}`);
        }
    }
    assert.deepStrictEqual(broken, [],
        'These answer not_your_camp to the owner pasting them into the SQL Editor, '
        + 'which is the only way they are ever run. Gate like migration 211:\n'
        + "  v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');\n"
        + '  IF v_claims IS NOT NULL\n'
        + "     AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'\n"
        + '     AND NOT public.camp_reader(p_camp_id) THEN ...');
});

test('the gate still refuses a real caller from another camp', () => {
    // The exemption is for "no JWT", not for "any JWT". A verifier that
    // stopped checking camp_reader entirely would pass the test above while
    // handing one camp's balances to another camp's logged-in owner.
    for (const v of scoped()) {
        if (!/current_setting\('request\.jwt\.claims'/.test(v.body)) continue;
        assert.match(v.body, /NOT\s+public\.camp_reader\s*\(\s*p_camp_id\s*\)/,
            `${v.file}: ${v.name} reads the JWT but never checks camp_reader — `
            + 'an authenticated caller from another camp would be served');
    }
});
