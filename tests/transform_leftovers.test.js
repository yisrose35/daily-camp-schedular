// =============================================================================
// What a mechanical rewrite leaves behind.
//
// WHY THIS EXISTS. 219 was produced by scripts/transform_canteen_writers.py,
// which re-pointed thirteen canteen writers off a whole-document read onto
// per-camper rows. Its rule for the document read was to replace it with a
// literal NULL and carry on:
//
//     v_value := NULL::jsonb;  -- document no longer read
//     v_locked_acct := public.canteen_account_lock(p_camp_id, p_camper_name);
//
// It did not remove the check that used to follow the read. So four functions
// then said:
//
//     IF v_value IS NULL THEN RETURN … 'no_canteen_data'; END IF;
//
// on the line after setting v_value to NULL. refund_canteen_deposit_from_
// processor, refund_canteen_deposit_from_stripe, merge_canteen_autoreload_card
// and update_canteen_autoreload_state returned an error on EVERY call, live, from
// the day 219 was applied — the refunds after the processor had already paid the
// parent back.
//
// 219's own behaviour test never called any of the four, so four of thirteen
// converted functions went to production without being executed once.
//
// Two rules, both cheap, both catching a whole class rather than an instance:
//
//   1. No function may return on a variable it set to NULL a few lines earlier.
//      That is a guard that always fires, and there is no reason to write one.
//   2. Every function a migration CONVERTS must be called by a behaviour test.
//      A transform that reports "13/13 converted" is reporting how many times it
//      substituted text.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const PGTESTS = path.join(ROOT, 'scripts', 'pgtests');

/** Every function body in every migration, as {file, name, body}. */
function bodies() {
    const out = [];
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (!/^\d+.*\.sql$/.test(f)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
        const re = /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)\s*\(/g;
        let m;
        while ((m = re.exec(sql)) !== null) {
            const end = sql.indexOf('\n$$;', m.index);
            if (end < 0) continue;
            out.push({ file: f, name: m[1], body: sql.slice(m.index, end) });
        }
    }
    return out;
}

/** Comments blanked, so prose describing the bug is not read as the bug. */
function code(sql) {
    return sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length));
}

test('no function returns on a variable it just set to NULL', () => {
    const bad = [];
    for (const { file, name, body } of bodies()) {
        const src = code(body);
        // Only the CURRENT definition of a function matters: an earlier migration
        // may carry the broken version that a later one replaced, and flagging
        // history would make this test impossible to pass.
        const laterFix = bodies().some(o => o.name === name && o.file > file);
        if (laterFix) continue;

        for (const set of src.matchAll(/(\w+)\s*:=\s*NULL::jsonb\s*;/g)) {
            const v = set[1];
            const after = src.slice(set.index + set[0].length);
            // Reassigned to something real before the check? Then the check is
            // about that value, not about the NULL.
            const reassigned = new RegExp(`\\b${v}\\s*:=\\s*(?!NULL::jsonb)`).exec(after);
            const guard = new RegExp(`IF\\s+${v}\\s+IS\\s+NULL\\s+THEN[\\s\\S]{0,400}?RETURN`, 'i')
                .exec(after);
            if (!guard) continue;
            if (reassigned && reassigned.index < guard.index) continue;
            bad.push(`${file}: ${name} returns on ${v}, which it set to NULL `
                     + `${after.slice(0, guard.index).split('\n').length} line(s) earlier`);
        }
    }
    assert.deepStrictEqual(bad, [],
        'A guard on a variable set to NULL above it fires on every call. This is what made four '
        + 'canteen money functions return an error for months — see migration 229:\n  '
        + bad.join('\n  '));
});

test('every function a transform converted is called by a behaviour test', () => {
    // The migrations produced by scripts/transform_canteen_writers.py, and the
    // marker it leaves in each body it rewrote.
    const MARKER = /219: one camper's row, not the camp's document/;
    const converted = new Set();
    for (const { name, body } of bodies()) {
        if (MARKER.test(body)) converted.add(name);
    }
    // Nothing to check if the transform's output has been fully rewritten by
    // hand — which is the direction of travel, not a reason to skip.
    if (converted.size === 0) return;

    const tests = fs.readdirSync(PGTESTS)
        .map(f => fs.readFileSync(path.join(PGTESTS, f), 'utf8'))
        .join('\n');

    const uncalled = [...converted]
        .filter(fn => !new RegExp(`\\b${fn}\\s*\\(`).test(tests))
        .sort();
    assert.deepStrictEqual(uncalled, [],
        'These were rewritten by a script and are executed by no behaviour test. Four functions '
        + 'in exactly this position returned an error on every call, live, for months:\n  '
        + uncalled.join('\n  '));
});

test('the transform script still refuses what it was taught to refuse', () => {
    // The script's own guards are the reason 219 was not worse. They are load
    // bearing, and easy to delete when a run is inconvenient.
    const p = path.join(ROOT, 'scripts', 'transform_canteen_writers.py');
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /campistrySnacks/,
        'the transform must be scoped to the snacks document, or it rewrites unrelated writers');
    // Keyed by (name, arity): keying by name alone is what made 219 miss four
    // overloads and 220 revive four retired ones.
    assert.match(src, /arity|pronargs|len\(\s*types\s*\)|nargs/i,
        'the transform must key functions by name AND arity — Postgres does, and 219 did not');
});
