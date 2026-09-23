// =============================================================================
// Every column that points at a camper, and whether a move carries it.
//
// WHY THIS EXISTS. 237's _move_person_references discovers its work from the
// catalog: tables with a column literally named person_id. That is the rule 223
// established, and it is right for everything 223 touched.
//
// canteen_transactions is not one of those tables. It has no person_id; it has
//
//     camper_id  text
//
// which 227's canteen_post fills with person_id::text. So it IS a person
// reference — same number, different column name, different type — and 237's
// cascade never saw it. A hand renumber moved a camper's ACCOUNT and left their
// whole LEDGER behind, which matters because the balance is rebuilt from that
// ledger.
//
// Discovery cannot fix this by itself: nothing in the catalog distinguishes
// canteen_transactions.camper_id (proven to hold a person_id) from
// link_outbox.camper_id (documented as "roster camperId", which since 216 is
// PROBABLY the same number — and probably is not enough to rewrite a row on).
//
// So 238 names what it moves, and this test is the check beside the list. A list
// without one is how 214's transform produced 233.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/**
 * How each person-reference column is handled, and why.
 *
 *   'moved'        — a real person_id, discovered from the catalog and carried
 *                    by _move_person_references.
 *   'moved (text)' — holds person_id under another name; NAMED in 238 because a
 *                    catalog rule cannot tell it from the inferred ones.
 *   'not moved'    — probably a person reference, not provably one. Reported by
 *                    verify_person_references as a disagreement rather than
 *                    rewritten, because writing to a column whose meaning is
 *                    inferred is the failure mode this whole chain is about.
 */
const HANDLING = {
    'canteen_transactions.camper_id': 'moved (text)',
    'link_outbox.camper_id': 'not moved',
    'link_form_responses.camper_id': 'not moved',
};

/** Comments blanked, so prose naming a column is not read as a definition. */
function code(sql) {
    return sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length));
}

function files() {
    return fs.readdirSync(MIGRATIONS)
        .filter(f => /^\d+.*\.sql$/.test(f) && !/APPLY/.test(f))
        .sort();
}

/**
 * Every `<table>.<column>` where the column is named camper_id — i.e. a person
 * reference that the person_id discovery does NOT cover.
 */
function camperIdColumns() {
    const found = new Set();
    for (const f of files()) {
        const src = code(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        // Table bodies, so a parameter named p_camper_id is not mistaken for one.
        const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const table = m[1];
            if (/^\s*camper_id\s+(text|bigint|integer)/mi.test(m[2])) {
                found.add(`${table}.camper_id`);
            }
        }
        // And ALTER TABLE … ADD COLUMN camper_id, which is how one could arrive
        // later without touching a CREATE TABLE.
        const alt = /ALTER TABLE\s+(?:public\.)?(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+camper_id\b/gi;
        while ((m = alt.exec(src)) !== null) found.add(`${m[1]}.camper_id`);
    }
    return [...found].sort();
}

test('every camper_id column says whether a move carries it', () => {
    const unclassified = camperIdColumns().filter(c => !HANDLING[c]);
    assert.deepStrictEqual(unclassified, [],
        'These columns name a camper and the person_id discovery does not cover them. Say '
        + 'whether _move_person_references carries each one and why — an unclassified person '
        + 'reference is one a renumber silently leaves behind, which is what happened to the '
        + 'canteen ledger. See migration 238:\n  ' + unclassified.join('\n  '));

    // And no stale entries, for the same reason every other ledger here has none.
    const gone = Object.keys(HANDLING).filter(c => !camperIdColumns().includes(c)).sort();
    assert.deepStrictEqual(gone, [],
        'No longer exists — strike these from HANDLING:\n  ' + gone.join('\n  '));
});

test('238 names the one it moves, and only that one', () => {
    const sql = fs.readFileSync(
        path.join(MIGRATIONS, '238_the_ledger_moves_with_the_person.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('_person_reference_columns'));

    // The proven one is named as a literal in the reference set.
    assert.match(body, /SELECT 'canteen_transactions', 'camper_id', true/,
        '238 must name canteen_transactions.camper_id explicitly — it cannot be discovered');

    // And the inferred ones are NOT. If either appears as a moved literal, the
    // file has started rewriting a column whose meaning nobody has established.
    for (const [col, how] of Object.entries(HANDLING)) {
        if (how !== 'not moved') continue;
        const table = col.split('.')[0];
        assert.doesNotMatch(body, new RegExp(`SELECT '${table}', 'camper_id'`),
            `238 moves ${col}, which is only PROBABLY a person id. It carries 223's `
            + `person_id as well, so the honest move is to report a disagreement, not to `
            + `overwrite one of the two.`);
    }
});

test('the ledger column really does hold a person id, per 227', () => {
    // The single fact the 'moved (text)' classification rests on. If 227's
    // canteen_post stopped writing person_id into camper_id, moving that column
    // on a renumber would be rewriting something else entirely.
    const sql = fs.readFileSync(
        path.join(MIGRATIONS, '227_the_canteen_follows_the_person.sql'), 'utf8');
    const post = sql.slice(sql.indexOf('FUNCTION public.canteen_post'));
    const body = post.slice(0, post.indexOf('\n$$;'));
    assert.match(body.replace(/--[^\n]*/g, ''), /person_id::text/,
        'canteen_post no longer writes person_id::text into canteen_transactions, so '
        + "238's 'moved (text)' classification for camper_id is no longer true");
});
