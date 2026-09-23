// =============================================================================
// A call site's argument count, against the signature the migrations define.
//
// WHY THIS EXISTS. PL/pgSQL resolves a function name at the first EXECUTION of
// the statement that calls it, not when the body is compiled. So a migration
// that calls a function with the wrong number of arguments APPLIES CLEANLY, the
// calling function EXISTS, and the failure waits inside whichever branch holds
// the call until something takes that branch. 221 taught this once. Two money
// writers were doing it the whole time:
//
//     camp_family_for_update(uuid, text)      -- 213. TWO arguments.
//     camp_family_save(uuid, text, jsonb)     -- 213. THREE arguments.
//
//     record_autopay_installment   called camp_family_save with 4 and with 5
//     settle_shop_order            called camp_family_for_update with 3
//                                  and camp_family_save with 4
//
// 214's transform rewrote document path reads and writes —
//
//     v_me #> ARRAY['families', K, 'charges']
//     jsonb_set(v_me, ARRAY['families', K, 'charges'], …)
//
// — into calls passing the path as extra arguments, and nothing created the
// functions to receive them. No field-scoped form exists in any migration.
//
// What that cost: charge-due-installments charges a card and THEN calls
// record_autopay_installment to record it and mark the installment paid. The
// call raised 42883, nothing was recorded, the installment stayed 'pending', and
// the next night charged the same card again. And no Camp Shop order could be
// charged to a camp bill at all.
//
// Neither pglast nor the migration harness catches this: the parser sees valid
// SQL, and the harness only runs the branches its behaviour test reaches. Only a
// comparison of every call site against every signature does — which is cheap,
// so here it is.
//
// THE RULE ABOUT HISTORY. Only the CURRENT definition of a function counts. An
// earlier migration carrying a broken version that a later one replaced is
// history, and flagging history would make this test impossible to pass. Same
// rule as tests/transform_leftovers.test.js.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/** Migration files in apply order, excluding the generated bundle. */
function files() {
    return fs.readdirSync(MIGRATIONS)
        .filter(f => /^\d+.*\.sql$/.test(f) && !/APPLY_BUNDLE/.test(f))
        .sort();
}

/**
 * Comments AND single-quoted string literals blanked, so prose describing a call
 * is not read as one — and neither is a signature written out as text. 228's
 * preflight holds
 *     'public.credit_canteen_balance_from_processor(uuid,text,numeric,text,text,text)'
 * in a text[] of signatures to check, which the first version of this test read
 * as a six-argument call. Same lesson as scripts/check_plpgsql_bodies.py.
 *
 * Dollar-quoted bodies are NOT blanked: that is where the real calls live. A
 * lone apostrophe inside a comment cannot unbalance anything because comments go
 * first.
 */
function code(sql) {
    const noComments = sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length));
    // '' is an escaped quote inside a literal, so a run of them never opens one.
    //
    // Replaced with a PLACEHOLDER, not with spaces. Blanking a literal to
    // whitespace erases arguments: public._name_letters('Sara Schepansky')
    // became public._name_letters(               ) and counted as ZERO
    // arguments, so 236 was reported as calling a one-argument function with
    // none. The placeholder keeps the same length — line numbers stay right —
    // and contains no quote, comma or parenthesis, so it is exactly one
    // argument and nothing else can be read out of it.
    return noComments.replace(/'(?:''|[^'])*'/g, m => 'x'.repeat(m.length));
}

/**
 * The balanced text between the parenthesis at `open` and its match.
 * Returns null when unbalanced, so a truncated file cannot throw.
 */
function balanced(src, open) {
    let depth = 1;
    for (let i = open + 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return src.slice(open + 1, i);
        }
    }
    return null;
}

/** Split on top-level commas only — a nested call is one argument. */
function topLevelParts(s) {
    if (s.trim() === '') return [];
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

/**
 * name -> Set<number> of argument counts the function can be CALLED with, once
 * the whole chain has been replayed.
 *
 * Two levels, and collapsing them is a bug I wrote first: Postgres keys a
 * function by (name, ARGUMENT TYPES), so a DROP targets one DECLARED signature —
 * but a surviving signature with defaults is callable with fewer arguments than
 * it declares. 231 drops submit_canteen_deposit(text,numeric,uuid) and creates a
 * four-parameter form with two defaults; the three-argument call in 079 is still
 * perfectly valid, and the first version of this reported it as wrong.
 *
 *   declared  : Map<name, Map<declaredCount, defaultCount>>   what DROP targets
 *   callable  : union over survivors of declaredCount-defaultCount .. declaredCount
 *
 * Replayed in order, within files as well as across them, because a CREATE after
 * a DROP revives the signature — the lesson tests/camp_scoped_rpc_auth.test.js
 * learned when 220 resurrected four retired overloads.
 */
function signatures() {
    const declared = new Map();   // name -> Map<declaredCount, defaultCount>
    const origin = new Map();     // name -> file that last defined it

    for (const f of files()) {
        const src = code(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        const events = [];

        const cre = /CREATE(?: OR REPLACE)? FUNCTION\s+(?:public\.)?(\w+)\s*\(/g;
        let m;
        while ((m = cre.exec(src)) !== null) {
            const params = balanced(src, m.index + m[0].length - 1);
            if (params === null) continue;
            const parts = topLevelParts(params);
            events.push({
                at: m.index, kind: 'create', name: m[1],
                n: parts.length,
                defaults: parts.filter(p => /\bDEFAULT\b/i.test(p)).length,
            });
        }

        const dro = /DROP FUNCTION(?:\s+IF EXISTS)?\s+(?:public\.)?(\w+)\s*\(/g;
        while ((m = dro.exec(src)) !== null) {
            const params = balanced(src, m.index + m[0].length - 1);
            if (params === null) continue;
            events.push({
                at: m.index, kind: 'drop', name: m[1],
                n: topLevelParts(params).length,
            });
        }

        events.sort((a, b) => a.at - b.at);
        for (const e of events) {
            if (!declared.has(e.name)) declared.set(e.name, new Map());
            const sigs = declared.get(e.name);
            if (e.kind === 'create') {
                sigs.set(e.n, e.defaults);
                origin.set(e.name, f);
            } else {
                sigs.delete(e.n);
            }
        }
    }

    const live = new Map();
    for (const [name, sigs] of declared) {
        const callable = new Set();
        for (const [n, defaults] of sigs) {
            for (let k = n - defaults; k <= n; k++) callable.add(k);
        }
        live.set(name, callable);
    }
    return { live, origin };
}

/** Where the LATEST definition of each function sits, for the history rule. */
function latestDefinition() {
    const at = new Map();
    for (const f of files()) {
        const src = code(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        const re = /CREATE(?: OR REPLACE)? FUNCTION\s+(?:public\.)?(\w+)\s*\(/g;
        let m;
        while ((m = re.exec(src)) !== null) at.set(m[1], { file: f, at: m.index });
    }
    return at;
}

/**
 * Every `public.<name>(...)` call site that is NOT itself a definition or a
 * grant, tagged with which function body it sits in.
 */
function callSites() {
    const out = [];
    for (const f of files()) {
        const raw = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
        const src = code(raw);
        // Where each function definition starts, so a call can be attributed to
        // the function that contains it.
        //
        // Each definition's END matters as much as its start. Without it a call
        // in a trailing DO block is attributed to the last function defined
        // above it, and the history rule then skips the call because THAT
        // function is redefined later — so a real bad call in a DO block would
        // be excused by an unrelated redefinition.
        const owners = [];
        const dre = /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)\s*\(/g;
        let d;
        while ((d = dre.exec(src)) !== null) {
            const end = src.indexOf('\n$$;', d.index);
            owners.push({ name: d[1], at: d.index, end: end < 0 ? src.length : end + 4 });
        }

        const re = /\bpublic\.(\w+)\s*\(/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const before = src.slice(Math.max(0, m.index - 60), m.index);
            // The definition itself, or a grant/revoke/drop naming the signature.
            if (/(CREATE OR REPLACE FUNCTION|CREATE FUNCTION|DROP FUNCTION|REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION|ALTER FUNCTION|COMMENT ON FUNCTION)\s*(IF EXISTS\s*)?$/i
                .test(before)) continue;

            const args = balanced(src, m.index + m[0].length - 1);
            if (args === null) continue;
            let owner = null;
            for (const o of owners) {
                if (o.at < m.index && m.index < o.end) owner = o;
                else if (o.at > m.index) break;
            }
            out.push({
                file: f,
                line: src.slice(0, m.index).split('\n').length,
                callee: m[1],
                args: topLevelParts(args).length,
                inside: owner ? owner.name : null,
                insideAt: owner ? owner.at : -1,
            });
        }
    }
    return out;
}

test('no migration calls a function with an argument count it does not have', () => {
    const { live, origin } = signatures();
    const latest = latestDefinition();
    const bad = [];

    for (const c of callSites()) {
        const arities = live.get(c.callee);
        if (!arities || arities.size === 0) continue;   // defined outside migrations
        if (arities.has(c.args)) continue;

        // History does not count. If the function CONTAINING this call is
        // redefined later, the version carrying the bad call is not the one in
        // the database.
        if (c.inside) {
            const cur = latest.get(c.inside);
            if (cur && (cur.file > c.file
                        || (cur.file === c.file && cur.at > c.insideAt))) continue;
        }
        bad.push(`${c.file}:${c.line}  ${c.inside || '(top level)'} calls `
                 + `public.${c.callee}() with ${c.args} argument(s); live arities are `
                 + `${[...arities].sort((a, b) => a - b).join(', ')} `
                 + `(last defined in ${origin.get(c.callee)})`);
    }

    assert.deepStrictEqual(bad, [],
        'A call with the wrong argument count APPLIES CLEANLY and raises 42883 only when its '
        + 'branch runs — which for record_autopay_installment meant a card was charged and the '
        + 'installment stayed pending, so the next night charged it again. See migration 233:\n  '
        + bad.join('\n  '));
});

test('the two functions 233 fixed take the arguments 213 gave them', () => {
    // A named guard beside the general rule, so that if somebody "restores" a
    // field-scoped call the failure names these functions instead of appearing
    // as one line in a list.
    //
    // Counted STRUCTURALLY, with the same balanced-paren walk the general rule
    // uses. The first version of this matched /camp_family_save\([^)]*,[^)]*,[^)]*,/
    // against the body, which happily crossed an opening parenthesis and read the
    // comma inside jsonb_build_object('charges', v_kept) as a fourth argument —
    // so it failed on the CORRECT three-argument call. A regex that counts
    // arguments has to understand nesting, which is why this does not use one.
    const { live } = signatures();
    assert.deepStrictEqual([...live.get('camp_family_for_update')], [2],
        'camp_family_for_update takes (camp, key) and returns the whole locked payload');
    assert.deepStrictEqual([...live.get('camp_family_save')], [3],
        'camp_family_save takes (camp, key, whole payload)');

    const latest = latestDefinition();
    const watched = ['record_autopay_installment', 'settle_shop_order'];
    const helpers = ['camp_family_save', 'camp_family_for_update'];
    const seen = new Map();
    const bad = [];

    for (const c of callSites()) {
        if (!watched.includes(c.inside)) continue;
        if (!helpers.includes(c.callee)) continue;
        // Only the definition that is actually in the database.
        const cur = latest.get(c.inside);
        if (!cur || cur.file !== c.file || cur.at !== c.insideAt) continue;

        seen.set(`${c.inside}/${c.callee}`, true);
        const ok = live.get(c.callee);
        if (!ok.has(c.args)) {
            bad.push(`${c.file}:${c.line}  ${c.inside} calls ${c.callee}() with `
                     + `${c.args} argument(s), not ${[...ok].join(' or ')}`);
        }
    }

    assert.deepStrictEqual(bad, [], bad.join('\n  '));
    // And the calls are still THERE. Without this the assertion above passes for
    // a body that stopped writing to the family at all, which is the failure it
    // was written to catch.
    for (const fn of watched) {
        assert.ok(seen.has(`${fn}/camp_family_save`),
            `${fn} no longer saves the family at all`);
    }
    assert.ok(seen.has('settle_shop_order/camp_family_for_update'),
        'settle_shop_order no longer locks the family before writing its charges');
});
