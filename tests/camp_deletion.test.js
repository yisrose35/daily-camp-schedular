// =============================================================================
// Deleting a camp must delete its data.
//
// WHY THIS EXISTS. camp_clone.js was the only code path that deletes a camp,
// and it cleared three tables by name — rotation_counts, daily_schedules,
// camp_state_kv — out of the 67 that carry a camp_id. It read none of the three
// results, and supabase-js returns { error } rather than throwing, so an RLS
// refusal deleted nothing, reported nothing, and the next line deleted the camp
// regardless. The one error it did check produced the sentence "Data cleared,
// but camp row could not be deleted" — stating as fact the thing it never
// checked.
//
// The result: 42 camps that no longer exist, still holding 2,194 camper
// records, 430 canteen accounts and $95 of balances that nobody can see, bill
// or refund.
//
// The fix has to be a rule rather than a longer list, because a list is what
// failed. Migration 222 discovers the camp-scoped tables from the catalog, so
// this test's job is to keep it that way — and to keep the client from growing
// a second, shorter list beside it.
//
// Behaviour (a camp deletion really clearing every table, on a real Postgres)
// is proved by scripts/pgtests/222_deleting_a_camp_deletes_its_data.sql. This
// file guards the shape that behaviour depends on.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIG = fs.readFileSync(
    path.join(ROOT, 'migrations', '222_deleting_a_camp_deletes_its_data.sql'), 'utf8');
const CLONE = fs.readFileSync(path.join(ROOT, 'camp_clone.js'), 'utf8');

/** deleteCopy's body, which is the only function under test here. */
function deleteCopyBody() {
    const start = CLONE.indexOf('async function deleteCopy(');
    assert.ok(start > 0, 'camp_clone.js no longer has deleteCopy — this test needs rewriting');
    // The next top-level function declaration ends it.
    const rest = CLONE.slice(start + 10);
    const end = rest.search(/\n    (?:async )?function /);
    return rest.slice(0, end < 0 ? rest.length : end);
}

test('the camp-scoped table list is discovered, not written down', () => {
    // The whole point. A literal list of table names in this migration would rot
    // exactly the way the client's list of three rotted.
    assert.match(MIG, /FROM pg_class c/,
        '_camp_scoped_tables must read the catalog');
    assert.match(MIG, /a\.attname IN \('camp_id', 'copy_camp_id'\)/,
        'the rule is "has a uuid column called camp_id", which is what makes it self-maintaining');
    // source_camp_id must NOT be swept: debug_copies rows are ABOUT the copy,
    // and deleting the camp a copy was made from must not delete the registry
    // entry for a copy that still exists. Comments are stripped first — the file
    // discusses source_camp_id at length precisely to explain the exclusion.
    const code = MIG.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    assert.doesNotMatch(code, /source_camp_id/,
        'source_camp_id points at the camp cloned FROM — sweeping it would delete a live copy'
        + "'s registry row");
    // A relname filter would turn the discovery back into a list.
    assert.doesNotMatch(MIG, /c\.relname IN \(/,
        'a relname IN (...) filter is a hardcoded table list wearing a catalog query as a disguise');
});

test('camp_state_kv is purged first, because its own triggers clear projections', () => {
    assert.match(MIG, /ORDER BY \(c\.relname <> 'camp_state_kv'\)/,
        "202's and 205's AFTER DELETE triggers on camp_state_kv clear the ledger and billing "
        + 'projections; purging it first means those tables are already empty when the loop '
        + 'reaches them rather than being refilled behind it');
});

test('a purge that cannot finish refuses the deletion instead of half-doing it', () => {
    // A camp that is gone with half its data behind is the bug 222 exists to
    // fix. A camp that is still there, with all its data, is recoverable.
    assert.match(MIG, /RAISE EXCEPTION\s*\n?\s*'purge_camp_data: % rows left/,
        'purge_camp_data must re-count every table and raise on anything left');
    assert.match(MIG, /BEFORE DELETE ON public\.camps/,
        'BEFORE, so the children are gone before referential integrity is checked — and so a '
        + 'raise aborts the parent delete');
});

test('the orphan purge deletes nothing unless told to', () => {
    // There is no undo for 2,194 rows, and a function whose no-argument form
    // destroys data is a function somebody destroys data with by accident.
    assert.match(MIG, /purge_orphaned_camp_data\(p_confirm boolean DEFAULT false\)/,
        'the default must be a dry run');
    assert.match(MIG, /IF NOT p_confirm THEN/,
        'the dry-run branch must come before anything is deleted');
    assert.match(MIG, /'dry_run', true, 'deleted', false/,
        'the dry run must say so in its own answer, not leave the caller to assume it');
    // "Orphan" means the camp does not exist. Not old, not empty, not
    // test-looking.
    assert.match(MIG, /NOT EXISTS \(SELECT 1 FROM public\.camps c WHERE c\.id = x\.%I\)/,
        'the only definition of an orphan is that its camp is gone');
});

test('nothing in the migration calls a function defined later in the file', () => {
    // 221's lesson: PL/pgSQL resolves a function name when the line first RUNS,
    // so a forward reference applies cleanly, passes its tests, and throws on
    // the first real call. 219 shipped exactly that and every canteen purchase
    // failed.
    const defs = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.(\w+)/g)]
        .map(m => ({ name: m[1], at: m.index }));
    for (const d of defs) {
        const callers = [...MIG.matchAll(new RegExp(`public\\.${d.name}\\s*\\(`, 'g'))];
        for (const c of callers) {
            if (c.index < d.at && !/CREATE OR REPLACE FUNCTION\s+public\.\w+$/.test(MIG.slice(0, c.index + 1))) {
                // A mention before the definition is only a problem inside a
                // function body; REVOKE/GRANT/COMMENT lines come after by
                // construction, and the final SELECT is at the very end.
                const line = MIG.slice(MIG.lastIndexOf('\n', c.index) + 1, MIG.indexOf('\n', c.index));
                assert.ok(/^\s*(REVOKE|GRANT|COMMENT|SELECT|DROP|--)/.test(line),
                    `public.${d.name} is called on line "${line.trim()}" before it is defined — `
                    + 'PL/pgSQL resolves that at first execution, which is migration 221 all over again');
            }
        }
    }
});

test('deleteCopy no longer carries its own list of tables to clear', () => {
    const body = deleteCopyBody();
    for (const t of ['rotation_counts', 'daily_schedules', 'camp_state_kv']) {
        assert.ok(!new RegExp(`from\\('${t}'\\)[\\s\\S]{0,40}\\.delete\\(`).test(body),
            `deleteCopy still deletes ${t} by name. Three names out of 67 is what caused this; `
            + "migration 222's trigger clears every camp-scoped table, so the list must go.");
    }
});

test('deleteCopy reads the error on the delete it depends on', () => {
    const body = deleteCopyBody();
    const del = body.indexOf("from('camps').delete()");
    assert.ok(del > 0, 'deleteCopy must still delete the camps row — that is what fires the trigger');
    const after = body.slice(del);
    assert.match(after.slice(0, 400), /if \(del\.error\)/,
        'the camps delete must be checked BEFORE anything else is claimed about it — supabase-js '
        + 'returns { error }, it does not throw, which is how the old failure stayed silent');
    assert.doesNotMatch(body, /Data cleared, but/,
        'that message asserted a cleanup nobody had checked');
});

test('deleteCopy verifies the cleanup server-side instead of announcing it', () => {
    const body = deleteCopyBody();
    assert.match(body, /rpc\('verify_camp_deleted'/,
        'counting from the client proves nothing: once we have left the copy, RLS hides its rows, '
        + 'so 0 rows is also what total failure looks like. verify_camp_deleted runs as owner.');
    assert.match(body, /fully_deleted !== true/,
        'the verifier answers fully_deleted only when the camp row is gone AND no rows remain — '
        + 'reading it is the whole point of calling it');
});

test('there is still exactly one place that deletes a camp', () => {
    // A second deletion path would be a second list, and this file would be
    // guarding the wrong one.
    const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
    const found = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (/from\(\s*['"]camps['"]\s*\)[\s\S]{0,60}\.delete\(/.test(src)) found.push(f);
    }
    assert.deepStrictEqual(found, ['camp_clone.js'],
        'another file deletes a camps row. Migration 222 covers it — the trigger fires whoever '
        + 'does the deleting — but it must also check the error and verify, so add it here.');
});
