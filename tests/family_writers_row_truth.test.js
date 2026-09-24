// node --test tests/family_writers_row_truth.test.js
//
// Migration 214: the eleven writers that touch families but not payments stop
// locking the camp document.
//
// WHAT THIS FILE IS FOR. 214 was not written by hand — 2,375 lines of money logic
// across eighteen functions is where a silent transcription error hides, and it
// would not be a syntax error, it would be a wrong number on a family's bill.
// scripts/transform_family_writers.py applies the change by rule; this diffs
// every result against the migration that last defined it and fails on any line
// that is not part of an expected rule. The diff IS the proof.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/214_family_writers_row_truth.sql');
const codeOnly = s => s.replace(/--[^\n]*/g, ' ');
const CODE = codeOnly(SQL);

/**
 * The newest migration BEFORE 214 that defines a function.
 *
 * Resolved rather than hardcoded: 214 is itself now the newest definition of all
 * eleven, and a hardcoded list of source files silently rots the moment one of
 * them is redefined again. Getting this wrong makes the diff below compare a
 * function against itself, which passes and proves nothing.
 */
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));

function sourceOf(name) {
    let found = null;
    for (const f of MIGRATIONS) {
        if (parseInt(f) >= 214) continue;
        if (read('migrations/' + f).includes('CREATE OR REPLACE FUNCTION public.' + name)) found = f;
    }
    assert.ok(found, name + ' has no definition before 214 to diff against');
    return 'migrations/' + found;
}

const WRITERS = ['merge_camp_family_fields', 'append_family_payment_method',
    'remove_payment_method', 'set_default_payment_method',
    'use_family_card_for_canteen_auto_reload', 'flag_expiring_cards',
    'flag_plan_collection', 'resolve_chargeback', 'settle_shop_order',
    '_admin_backfill_saved_payment_methods', '_admin_clear_stale_byop_cards'];

test('every writer has a prior definition to be diffed against', () => {
    for (const fn of WRITERS) {
        const src = sourceOf(fn);
        assert.ok(parseInt(path.basename(src)) < 214,
            `${fn} would be compared against 214 itself, which proves nothing`);
    }
});

function defIn(src, name) {
    const a = src.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' not found');
    const b = src.indexOf('\n$$;', a);
    assert.ok(b > a, name + ' body not terminated');
    return src.slice(a, b + 4);
}

/** Lines present in one and not the other, with multiplicity. */
function lineDiff(orig, now) {
    const count = arr => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
    const co = count(orig.split('\n')), cn = count(now.split('\n'));
    const removed = [], added = [];
    for (const [l, c] of co) for (let i = 0; i < c - (cn.get(l) || 0); i++) removed.push(l);
    for (const [l, c] of cn) for (let i = 0; i < c - (co.get(l) || 0); i++) added.push(l);
    return { added, removed };
}

test('the diff helper detects a change, and is silent on identity', () => {
    assert.deepStrictEqual(lineDiff('a\nb', 'a\nX'), { added: ['X'], removed: ['b'] });
    assert.deepStrictEqual(lineDiff('a\nb', 'a\nb'), { added: [], removed: [] },
        'identical input must diff empty, or every test below is vacuous');
});

// Every line the rules are allowed to ADD or REMOVE. Anything else is a
// transcription error in a money function.
const ALLOWED_REMOVED = [
    /^\s*SELECT value INTO \w+ FROM camp_state_kv WHERE camp_id = [\w.]+ AND key = 'campistryMe' FOR UPDATE;$/,
    /^\s*FOR UPDATE;$/,
    /^\s*INSERT INTO camp_state_kv \(camp_id, key, value, updated_at\)$/,
    /^\s*VALUES \([\w.]+, 'campistryMe', '\{\}'::jsonb, [^)]*\)$/,
    /^\s*ON CONFLICT \(camp_id, key\) DO NOTHING;$/,
    /^\s*UPDATE camp_state_kv SET value = \w+, updated_at = .*$/,
    /^\s*UPDATE camp_state_kv$/,
    /^\s*SET value = \w+.*$/,
    /^\s*WHERE camp_id = [\w.]+ AND key = 'campistryMe';?$/,
    /^\s*AND key = 'campistryMe';?$/,
    /^\s*SELECT value INTO \w+$/,
    /^\s*FROM camp_state_kv$/,
    // the families branch, however it was read or written
    /families/,
    // R4b: the accumulator line, replaced by a save per iteration
    /^\s*\w+ := jsonb_set\(\w+, ARRAY\[rec\.key\], \w+(?:, true)?\);$/,
];
const ALLOWED_ADDED = [
    /camp_families_object\(/,
    /camp_family_for_update\(/,
    /PERFORM public\.camp_family_save\(/,
    /^\s*SELECT value INTO \w+ FROM camp_state_kv WHERE camp_id = [\w.]+ AND key = 'campistryMe';$/,
    /^\s*SELECT value INTO \w+$/,
    /^\s*FROM camp_state_kv$/,
    /^\s*WHERE camp_id = [\w.]+ AND key = 'campistryMe';?$/,
    /^\s*AND key = 'campistryMe';?$/,
];

for (const fn of WRITERS) {
    const src = sourceOf(fn);
    test(`${fn}: only the rules' lines changed`, () => {
        const orig = defIn(read(src), fn);
        const now = defIn(SQL, fn);
        const { added, removed } = lineDiff(orig, now);
        const unexplainedRemoved = removed.filter(l => l.trim() && !ALLOWED_REMOVED.some(r => r.test(l)));
        const unexplainedAdded = added.filter(l => l.trim() && !l.trim().startsWith('--')
                                                 && !ALLOWED_ADDED.some(r => r.test(l)));
        assert.deepStrictEqual(unexplainedRemoved, [],
            `${fn}: lines REMOVED from a money function that no rule explains`);
        assert.deepStrictEqual(unexplainedAdded, [],
            `${fn}: lines ADDED to a money function that no rule explains`);
    });

    test(`${fn}: signature, LANGUAGE and SECURITY are untouched`, () => {
        const head = s => s.slice(0, s.indexOf('AS $$'));
        assert.strictEqual(head(defIn(SQL, fn)), head(defIn(read(src), fn)),
            `${fn}: changing DEFINER or the argument list is a security change, not a refactor`);
    });

    // A diff test alone cannot catch a function that was never transformed: if a
    // reader is put back on me->'families' the body becomes IDENTICAL to the
    // original, the diff is empty, and "only the rules' lines changed" passes
    // while nothing moved. So each one must POSITIVELY be on the rows.
    test(`${fn}: reads and writes families through the rows, not the document`, () => {
        const body = codeOnly(defIn(SQL, fn));
        assert.doesNotMatch(body, /\w+\s*->\s*'families'/,
            `${fn} still reads the document's families branch`);
        assert.doesNotMatch(body, /#>\s*ARRAY\['families'/,
            `${fn} still reaches into the document for one family`);
        assert.doesNotMatch(body, /jsonb_set\(\s*\w+\s*,\s*(?:ARRAY\['families'|'\{families\}')/,
            `${fn} still writes the document's families branch`);
        assert.match(body, /camp_famil(ies_object|y_for_update|y_save)\(/,
            `${fn} does not touch the family rows at all — it was not transformed`);
    });

    test(`${fn}: no longer locks or writes the camp document`, () => {
        const body = codeOnly(defIn(SQL, fn));
        // A campistryMe read may remain (other branches have not moved) but must
        // not be locked, and nothing may be written back to it.
        const meReads = [...body.matchAll(/SELECT value INTO \w+[\s\S]{0,260}?key = 'campistryMe'([\s\S]{0,30}?);/g)];
        for (const m of meReads) {
            assert.doesNotMatch(m[1], /FOR UPDATE/, `${fn} still locks the camp document`);
        }
        const writes = [...body.matchAll(/UPDATE camp_state_kv[\s\S]{0,260}?;/g)]
            .filter(m => /campistryMe/.test(m[0]));
        assert.deepStrictEqual(writes.map(m => m[0].slice(0, 40)), [],
            `${fn} still writes the camp document`);
    });
}

// ── the bug a blanket rule would have caused ────────────────────────────────
test('THE SHOP AND CANTEEN LOCKS SURVIVE — removing them would lose money', () => {
    // The first version of R1 stripped FOR UPDATE from every camp_state_kv read.
    // These two blobs are still read-modify-written, so that would have
    // introduced a lost update on the shop and canteen ledgers.
    for (const [fn, key] of [['settle_shop_order', 'campistryShop'],
                             ['settle_shop_order', 'campistrySnacks'],
                             ['use_family_card_for_canteen_auto_reload', 'campistrySnacks']]) {
        const body = codeOnly(defIn(SQL, fn));
        const reads = [...body.matchAll(/SELECT value INTO \w+[\s\S]{0,260}?key = '(\w+)'([\s\S]{0,30}?);/g)]
            .filter(m => m[1] === key);
        assert.ok(reads.length > 0, `${fn} no longer reads ${key} at all`);
        assert.ok(reads.some(m => /FOR UPDATE/.test(m[2])),
            `${fn}: the ${key} lock was removed — that blob is still read-modify-written`);
    }
});

test('and those two blobs are still WRITTEN, so the lock has something to protect', () => {
    for (const [fn, key] of [['settle_shop_order', 'campistryShop'],
                             ['use_family_card_for_canteen_auto_reload', 'campistrySnacks']]) {
        const body = codeOnly(defIn(SQL, fn));
        assert.match(body, new RegExp(`UPDATE camp_state_kv[\\s\\S]{0,260}?${key}`),
            `${fn} no longer writes ${key}`);
    }
});

// ── the bug that would have made two functions do nothing ──────────────────
test('the two _admin_ functions SAVE each family — otherwise they change nothing', () => {
    // They build a whole replacement families object in a loop and used to write
    // the branch once. R4 does not match that idiom, so dropping their write
    // without R4b left a backfill that applies, reports success, and changes no
    // card on file.
    for (const fn of ['_admin_backfill_saved_payment_methods', '_admin_clear_stale_byop_cards']) {
        const body = codeOnly(defIn(SQL, fn));
        assert.match(body, /PERFORM public\.camp_family_save\(/,
            `${fn} saves no family — its entire effect is gone`);
        assert.doesNotMatch(body, /jsonb_set\(\s*\w+\s*,\s*'\{families\}'/,
            `${fn} still writes the whole branch`);
    }
});

test('every writer that wrote families still saves at least one', () => {
    for (const fn of WRITERS) {
        const orig = codeOnly(defIn(read(sourceOf(fn)), fn));
        const wrote = /jsonb_set\(\s*\w+\s*,\s*ARRAY\['families'/.test(orig)
                   || /jsonb_set\(\s*\w+\s*,\s*'\{families\}'/.test(orig);
        if (!wrote) continue;   // read-only on families
        assert.match(codeOnly(defIn(SQL, fn)), /camp_family_save\(/,
            `${fn} wrote families and now saves none — its effect was dropped`);
    }
});

// ── the migration's own shape ───────────────────────────────────────────────
test('exactly the eleven functions, and nothing else, are replaced', () => {
    const names = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)/g)].map(m => m[1]);
    assert.deepStrictEqual(names.sort(), [...WRITERS].sort());
});

test('it creates no table, takes no new lock, and writes no data', () => {
    assert.doesNotMatch(CODE, /CREATE TABLE|DROP TABLE|TRUNCATE/);
    assert.doesNotMatch(CODE, /CREATE TRIGGER|DROP TRIGGER/);
    assert.match(SQL, /SAFE TO RE-RUN/);
    assert.match(SQL, /SQL Editor/);
    assert.doesNotMatch(SQL, /supabase (db|migration|functions|secrets) /);
});

test('the confirmation asks the LIVE definitions, and names the number that matters', () => {
    const tail = SQL.slice(SQL.indexOf("SELECT 'migration 214 applied'"));
    assert.match(tail, /pg_get_functiondef\(p\.oid\) AS def/, 'asked of the database, not of this file');
    assert.match(tail, /AS locked_on_campistryme/);
    assert.match(tail, /AS still_writes_the_document/);
    assert.match(tail, /AS touch_other_blobs/, 'the shop and canteen locks are reported, not silently assumed');
    assert.match(tail, /AS functions_checked/, 'so a partial paste shows as a smaller count');
    for (const fn of WRITERS) assert.ok(tail.includes(`'${fn}'`), fn + ' is not counted');
    const lines = SQL.trimEnd().split('\n');
    assert.ok(!lines[lines.length - 1].trim().startsWith('--'),
        'a migration ending on a comment prints nothing on success');
});

test('the preflight names what must come first', () => {
    const pre = SQL.slice(SQL.indexOf('DO $$'), SQL.indexOf('$$;'));
    for (const f of ['211_families_into_rows.sql', '212_families_read_from_rows.sql',
                     '213_payments_row_truth.sql']) {
        assert.ok(pre.includes(f), f + ' is not named as a prerequisite');
    }
});

test('214 is a standalone paste, not a bundle entry', () => {
    assert.ok(!read('scripts/build-migration-bundle.py').includes('214_family_writers_row_truth'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('214_family_writers_row_truth'));
});
