// node --test tests/migration_doc_calls.test.js
//
// Every migration in this repo is pasted BY HAND into the Supabase SQL Editor —
// the user has no CLI. So the "how to verify this" line in a migration's header
// is not a comment, it is the interface. A wrong one costs a round trip and
// reads to the user like the migration failed.
//
// This has now happened twice, both times mine:
//
//   ERROR 42883: function public.verify_ledger_projection(unknown) does not exist
//   ERROR 42883: function public.verify_canteen_archive() does not exist
//
// Both were documented with bare parentheses against a function declared with a
// required parameter. The database is right and the instruction was wrong, which
// is the worst way round: nothing in the suite noticed, because the SQL itself
// was valid and only the prose was broken.
//
// So the prose is checked here. For every `public.thing()` written in a comment
// anywhere in migrations/, if a CREATE OR REPLACE FUNCTION in migrations/
// declares `thing` with at least one parameter that has no DEFAULT, the call
// cannot resolve and this fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'migrations');
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

/** Split a parameter list on top-level commas — types can contain parens. */
function splitArgs(inner) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of inner) {
        if (ch === '(') { depth++; cur += ch; }
        else if (ch === ')') { depth--; cur += ch; }
        else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.filter(a => a.trim());
}

/**
 * name -> fewest required (no DEFAULT) parameters across every declaration.
 * The FEWEST, because an overload taking none makes a bare call legal.
 */
function requiredArgsByName() {
    const req = new Map();
    for (const f of FILES) {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        const re = /CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi;
        let m;
        while ((m = re.exec(src))) {
            const name = m[1].toLowerCase();
            let depth = 1, i = re.lastIndex;
            while (i < src.length && depth > 0) {
                if (src[i] === '(') depth++;
                else if (src[i] === ')') depth--;
                i++;
            }
            const required = splitArgs(src.slice(re.lastIndex, i - 1))
                .filter(a => !/\bDEFAULT\b/i.test(a)).length;
            const prev = req.get(name);
            if (prev === undefined || required < prev) req.set(name, required);
        }
    }
    return req;
}

test('the parameter parser handles the signatures actually in use', () => {
    assert.deepStrictEqual(splitArgs('p_camp_id uuid'), ['p_camp_id uuid']);
    assert.deepStrictEqual(splitArgs('a uuid, b text'), ['a uuid', ' b text']);
    assert.strictEqual(splitArgs('a numeric(10,2), b text').length, 2,
        'a comma inside a type is not a parameter boundary');
    assert.deepStrictEqual(splitArgs(''), [], 'a no-arg function has no parameters');
    assert.deepStrictEqual(splitArgs('   '), []);
});

test('it finds the real signatures rather than an empty map', () => {
    const req = requiredArgsByName();
    // Guard against the check silently passing because it parsed nothing.
    assert.ok(req.size > 50, `expected many functions, found ${req.size}`);
    assert.strictEqual(req.get('verify_canteen_archive'), 1, 'takes a camp id, no default');
    assert.strictEqual(req.get('get_my_balance_derived'), 0, 'p_camp_id has a DEFAULT');
});

test('no migration documents a call that the database would reject', () => {
    const req = requiredArgsByName();
    const bad = [];
    for (const f of FILES) {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        src.split('\n').forEach((line, n) => {
            const comment = line.match(/--(.*)$/);
            if (!comment) return;
            const re = /public\.([a-z0-9_]+)\(\s*\)/g;
            let m;
            while ((m = re.exec(comment[1]))) {
                const name = m[1].toLowerCase();
                const need = req.get(name);
                if (need > 0) {
                    bad.push(`${f}:${n + 1} — public.${name}() is documented with no arguments, `
                           + `but it is declared with ${need} required parameter(s)`);
                }
            }
        });
    }
    assert.deepStrictEqual(bad, [], 'ERROR 42883 waiting to happen:\n' + bad.join('\n'));
});
