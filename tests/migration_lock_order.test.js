// =============================================================================
// Lock ordering for migrations that add a trigger to camp_state_kv.
//
// WHY. Migration 216's first live paste died with "40P01: deadlock detected".
// Two lock orders were exactly opposite:
//
//   the app saving a document  →  camp_state_kv (row), then the projection
//                                 table (row), because the trigger reads it
//   the migration              →  the projection table (CREATE INDEX, ALTER
//                                 TABLE, REVOKE all take AccessExclusive),
//                                 then camp_state_kv for DROP TRIGGER
//
// Neither can proceed. It only bites once the trigger already exists — an
// earlier paste, or two pastes at once — which is exactly when someone is
// re-running a migration to fix something, i.e. the worst moment.
//
// The fix is one line: take camp_state_kv up front in the strongest mode the
// file will need. Every other writer must already hold camp_state_kv before it
// can want the projection table, so only one order remains. This test makes
// that line non-optional for every future projection migration, because the
// next person to add one will not have watched 216 deadlock.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/**
 * Comments stripped, blanked rather than deleted so every offset still points
 * at the same place in the original file.
 *
 * This is not fussiness. The first run of this test flagged migration 216 for
 * "taking locks on its own table first" — because the comment EXPLAINING the
 * deadlock names ALTER TABLE, and a regex over raw text cannot tell prose from
 * SQL. A rule that fires on its own documentation teaches people to delete the
 * documentation.
 */
function stripComments(sql) {
    return sql
        .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

function files() {
    return fs.readdirSync(MIGRATIONS)
        .filter(f => f.endsWith('.sql') && !f.startsWith('APPLY'))
        .map(f => ({
            name: f,
            sql: stripComments(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')),
        }));
}

/** Migrations that attach a trigger to camp_state_kv — schema prefix optional. */
function triggerMigrations() {
    return files().filter(({ sql }) =>
        /CREATE TRIGGER[\s\S]{0,400}?\bON\s+(?:public\.)?camp_state_kv\b/i.test(sql));
}

// Written before the deadlock was understood. Each takes the projection table's
// locks first and camp_state_kv second, so each can deadlock against a live
// writer on a re-paste. They are recorded rather than silently tolerated: the
// remedy is one line at the top, and it is worth adding the next time any of
// them is touched.
const PREDATES_THE_RULE = [
    '202_ledger_projection.sql',
    '203_canteen_archive.sql',
    '205_parent_balance_off_the_blob.sql',
    '208_payments_into_rows.sql',
    '211_families_into_rows.sql',
];

test('a migration that triggers on camp_state_kv locks it first', () => {
    const offenders = [];
    for (const { name, sql } of triggerMigrations()) {
        if (PREDATES_THE_RULE.includes(name)) continue;
        const lock = sql.search(/LOCK\s+TABLE\s+public\.camp_state_kv\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE/i);
        const firstTrigger = sql.search(/CREATE TRIGGER/i);
        const firstDdl = sql.search(/CREATE (?:UNIQUE )?INDEX|ALTER TABLE/i);
        if (lock < 0) { offenders.push(`${name}: never locks camp_state_kv`); continue; }
        if (firstDdl >= 0 && lock > firstDdl) {
            offenders.push(`${name}: locks camp_state_kv AFTER taking locks on its own table`);
        }
        if (firstTrigger >= 0 && lock > firstTrigger) {
            offenders.push(`${name}: locks camp_state_kv after CREATE TRIGGER`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'Take camp_state_kv up front:\n'
        + "  SET LOCAL lock_timeout = '15s';\n"
        + '  LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;\n'
        + 'See migration 216 section 0b for why.');
});

test('the lock comes with a timeout, so a busy moment fails instead of hanging', () => {
    for (const { name, sql } of triggerMigrations()) {
        if (PREDATES_THE_RULE.includes(name)) continue;
        const lock = sql.search(/LOCK\s+TABLE\s+public\.camp_state_kv/i);
        const timeout = sql.search(/SET\s+LOCAL\s+lock_timeout/i);
        assert.ok(timeout >= 0 && timeout < lock,
            `${name}: set lock_timeout before taking the lock, or a busy camp hangs the editor `
            + 'with an exclusive lock held on every camp document');
    }
});

test('the exemption list has no stale entries', () => {
    // Same ratchet rule as the camper-identity ledger: a list that names files
    // which no longer qualify is a list that lies about the work left.
    const names = triggerMigrations().map(f => f.name);
    const stale = PREDATES_THE_RULE.filter(f => !names.includes(f));
    assert.deepStrictEqual(stale, [],
        'These no longer put a trigger on camp_state_kv — remove them from PREDATES_THE_RULE.');
});
