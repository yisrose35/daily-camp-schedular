// node --test tests/bundle_verification_rows.test.js
//
// APPLY_BUNDLE.sql ends with a table of checks the user runs after pasting it.
// That table is the only feedback anyone gets about whether a migration took,
// so a row that has gone stale is worse than no row: it reports MISSING for
// something that works, and the next person either chases a phantom or — far
// worse — learns to ignore the column.
//
// Which is exactly what happened. Two rows checked
//
//     (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance') LIKE '%bank_deposits%'
//
// and migration 173 renamed that function to get_my_balance_derived, putting a
// thin wrapper in its place. The deposit logic went with the rename; the rows
// went on reading the wrapper and reported MISSING for a behaviour that had been
// working the whole time.
//
// So: every row that asserts function X contains text T has to be checked
// against the definition of X that the bundle actually installs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BUNDLE = read('migrations/APPLY_BUNDLE.sql');

// Whole-line comments only — the bundle's own prose mentions function names and
// would otherwise be mistaken for checks. See tests/processor_conformance for
// why this is deliberately not a general comment stripper.
const code = BUNDLE.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

/**
 * The definition the bundle LEAVES IN PLACE for a function: the last one, since
 * these are CREATE OR REPLACE and later migrations win. Returns '' when the
 * bundle never defines it.
 */
/** The last CREATE of `name` that appears before `before` (default: anywhere). */
function lastCreate(name, before = Infinity) {
    // Anchored on CREATE. Matching a bare `FUNCTION public.X(` also hits the
    // GRANT and REVOKE lines that follow every definition — and since those come
    // last, "the definition the bundle leaves in place" came back as a grant
    // statement and every check against it failed. The same mistake in miniature
    // as the one this file exists to catch.
    const re = new RegExp(
        `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'g');
    let body = '', m;
    while ((m = re.exec(code))) {
        if (m.index >= before) break;
        const end = code.indexOf('\n$$;', m.index);
        if (end > m.index) body = code.slice(m.index, end + 4);
    }
    return body;
}

/** Where a function acquires `name` by being renamed INTO it, if it does. */
function renameInto(name) {
    const m = code.match(
        new RegExp(`ALTER FUNCTION public\\.(\\w+)\\([^)]*\\)\\s+RENAME TO\\s+${name}\\b`, 'i'));
    return m ? { from: m[1], at: m.index } : null;
}

function installedBody(name) {
    const direct = lastCreate(name);
    if (direct) return direct;
    // Not every function in this bundle is CREATEd under the name it ends up
    // with. 173 renames get_my_balance to get_my_balance_derived and then
    // creates a new get_my_balance in its place, so the derived function's body
    // is whatever the ORIGINAL name was last defined as BEFORE that rename.
    // Reading only CREATEs declares it missing — the same false alarm, one level
    // up.
    const r = renameInto(name);
    return r ? lastCreate(r.from, r.at) : '';
}

/** Was this function RENAMED to something else by a later migration? */
function renamedTo(name) {
    const m = code.match(
        new RegExp(`ALTER FUNCTION public\\.${name}\\([^)]*\\)\\s+RENAME TO\\s+(\\w+)`, 'i'));
    return m ? m[1] : null;
}

// Every `... proname='X' ...) LIKE '%T%'` pair in the verification block.
function prosrcChecks() {
    const out = [];
    const re = /prosrc FROM pg_proc WHERE proname='(\w+)'[^)]*\)\s*(NOT\s+)?LIKE\s+'%([^%]+)%'/gi;
    let m;
    while ((m = re.exec(code))) {
        out.push({ fn: m[1], negated: !!m[2], needle: m[3] });
    }
    return out;
}

const CHECKS = prosrcChecks();

test('the verification rows were actually found', () => {
    // Every assertion below is vacuously true against an empty list.
    assert.ok(CHECKS.length >= 6,
        `expected several prosrc checks in the bundle, found ${CHECKS.length}`);
});

test('every checked function is one the bundle installs', () => {
    for (const c of CHECKS) {
        const body = installedBody(c.fn);
        const renamed = renamedTo(c.fn);
        assert.ok(body || renamed,
            `a verification row checks ${c.fn}(), which the bundle never defines. ` +
            `It will report MISSING forever.`);
    }
});

test('a row never checks a function for text that moved out of it', () => {
    // The actual defect. Both halves matter: the function has to still exist
    // under that name, AND the text has to still be in it.
    for (const c of CHECKS) {
        if (c.negated) continue;                 // NOT LIKE asserts absence
        const body = installedBody(c.fn);
        if (!body) continue;                     // covered by the test above
        assert.ok(body.includes(c.needle),
            `the verification row for ${c.fn}() looks for "${c.needle}", which is not ` +
            `in the definition the bundle installs.` +
            (renamedTo(c.fn) ? ` That function is RENAMED to ${renamedTo(c.fn)} — ` +
                `check the new name, or the row reports MISSING for working code.` : '') +
            ` A row that cries wolf teaches everyone to ignore the column.`);
    }
});

test('a NOT LIKE row really is absent', () => {
    for (const c of CHECKS) {
        if (!c.negated) continue;
        const body = installedBody(c.fn);
        if (!body) continue;
        assert.ok(!body.includes(c.needle),
            `the verification row asserts ${c.fn}() does NOT contain "${c.needle}", ` +
            `but the installed definition does — so it reports MISSING for correct code`);
    }
});

test('a renamed function is checked under the name it now has', () => {
    // 173's rename is the one in the tree; this pins the lesson rather than the
    // instance, so the next rename is caught the same way.
    const renamed = renamedTo('get_my_balance');
    assert.strictEqual(renamed, 'get_my_balance_derived',
        'the rename this test exists to guard is gone — re-check the rows below');
    for (const c of CHECKS.filter(x => x.fn === 'get_my_balance_derived')) {
        assert.ok(installedBody('get_my_balance_derived') ||
                  installedBody('get_my_balance').includes(c.needle),
            `nothing in the bundle defines get_my_balance_derived`);
    }
    // And the wrapper must still delegate, or the derived logic is unreachable
    // however correct it is on its own.
    assert.match(installedBody('get_my_balance'), /get_my_balance_derived/,
        'the wrapper no longer calls the derived function, so deposits and the ' +
        'multi-family sum never reach the parent');
});

test('every row that asserts a FUNCTION EXISTS names a real one', () => {
    const re = /EXISTS \(SELECT 1 FROM pg_proc WHERE proname='(\w+)'\)/g;
    let m, n = 0;
    while ((m = re.exec(code))) {
        n++;
        assert.ok(installedBody(m[1]) || renamedTo(m[1]),
            `a verification row checks that ${m[1]}() exists, but the bundle never ` +
            `creates it — the row can only ever report MISSING`);
    }
    assert.ok(n >= 10, `expected many existence checks, found ${n}`);
});
