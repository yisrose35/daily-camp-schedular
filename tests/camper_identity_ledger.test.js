// =============================================================================
// The camper-identity ledger.
//
// WHY THIS EXISTS. Migration 216 made (camp_id, person_id) a real identity, and
// when this file was written almost nothing used it: 16 tables carried a camper
// NAME and no id, and 30 functions took p_camper_name. "Everything follows camp
// id and camper id" was therefore not a statement about today — it was a
// direction, and a direction nobody measures is a direction nobody travels.
//
// 223 finished the tables: every one of them now records a person_id and keeps
// it true on insert. The thirty functions are what is left, and they are the
// half that decides behaviour — a function that takes a name is a system that
// asks for a name.
//
// So this is a RATCHET, not a report. Every name-keyed surface is listed below
// by name. A surface that disappears from the codebase must be struck off the
// list, and a surface that APPEARS and is not on the list fails this test. The
// count can go down. It cannot go up.
//
// A name is not an identity: two campers share one, a rename orphans the
// history, a trailing space invents a person. This project already has 354
// canteen accounts pointing at a name its roster cannot resolve — that is what
// the failure mode looks like once it has been running for a season.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/** Every migration file, oldest first, so a later definition wins. */
function migrationFiles() {
    return fs.readdirSync(MIGRATIONS)
        .filter(f => f.endsWith('.sql') && !f.startsWith('APPLY'))
        .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
        .map(f => ({ name: f, sql: fs.readFileSync(path.join(MIGRATIONS, f), 'utf8') }));
}

/**
 * Tables whose only camper reference is a NAME.
 *
 * A table carrying BOTH a name and an id is not counted: the name is a label
 * there, which is fine and often wanted on a printed sheet. It is the tables
 * where the name is the ONLY handle that cannot survive a rename.
 */
/**
 * Migration 223 gives a person_id to EVERY table with a uuid camp_id and a text
 * camper_name, discovered from the catalog in a loop — so the columns it adds
 * appear in no CREATE TABLE anywhere, and a reader of the files alone cannot see
 * them.
 *
 * The ledger trusts that sweep only while 223 carries both halves of it: the
 * loop AND the assertion that no such table was left without a column and a
 * stamping trigger. Delete the assertion and this test stops believing the
 * sweep, which is the behaviour you want from a ratchet.
 */
function sweep223() {
    const sql = fs.readFileSync(
        path.join(MIGRATIONS, '223_every_camper_reference_gets_an_id.sql'), 'utf8');
    const hasLoop = /ADD COLUMN IF NOT EXISTS person_id bigint/.test(sql)
                 && /a\.attname = 'camper_name' AND a\.atttypid = 'text'::regtype/.test(sql);
    const hasAssertion = /RAISE EXCEPTION '223 left camper names without an id/.test(sql);
    return hasLoop && hasAssertion;
}

function nameKeyedTables() {
    const swept = sweep223();
    const found = new Map();
    for (const { name, sql } of migrationFiles()) {
        const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g;
        let m;
        while ((m = re.exec(sql)) !== null) {
            const table = m[1];
            const decl = [...m[2].matchAll(/^\s*(\w+)\s+([\w[\]]+)/gm)]
                .map(c => ({ col: c[1].toLowerCase(), type: c[2].toLowerCase() }));
            const cols = decl.map(d => d.col);
            // A boolean is not a camper. camp_link_program_settings.
            // camper_mail_enabled is a feature flag, and counting it as a camper
            // reference meant this ledger could never reach zero however much
            // work was done — a target you cannot hit is not a target.
            const camper = decl
                .filter(d => d.col.includes('camper') && d.type !== 'boolean')
                .map(d => d.col);
            if (!camper.length) continue;
            // `person_id` counts as a camper identity: 216's registry spans
            // campers AND staff, so the column that carries the id is not
            // called camper_id. Missing that flagged camp_canteen_accounts —
            // a table keyed on the id — as name-keyed, which is the ledger
            // reporting the opposite of the truth.
            const hasId = camper.some(c => c.endsWith('_id') || c.endsWith('_ids'))
                       || cols.includes('person_id')
                       // 223's sweep, and the one table it handles by hand.
                       || (swept && cols.includes('camp_id') && cols.includes('camper_name'))
                       || (swept && table === 'link_parent_invites');
            const hasName = camper.some(c => !c.endsWith('_id') && !c.endsWith('_ids'));
            if (hasName && !hasId) found.set(table, name);
        }
    }
    return found;
}

/**
 * Functions whose CURRENT definition takes a camper name.
 *
 * "Current" matters: these functions are redefined across migrations, and a
 * later file may already have moved one onto an id. Counting every historical
 * definition would report work as outstanding after it was finished.
 */
function nameKeyedFunctions() {
    const latest = new Map();
    for (const { name, sql } of migrationFiles()) {
        const re = /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql)) !== null) {
            latest.set(m[1], { args: m[2], file: name });
        }
    }
    const found = new Map();
    for (const [fn, { args, file }] of latest) {
        if (/\bp_camper(_name)?\b/.test(args)) found.set(fn, file);
    }
    return found;
}

// ── the ledger ──────────────────────────────────────────────────────────────
// Struck off as each is converted. Do not add to these lists to make a failure
// go away — a new entry means a new surface that cannot survive a rename.

// Empty as of migration 223, which gave a person_id to every table with a uuid
// camp_id and a text camper_name — banquest_pending_links,
// camp_billing_enrollments, cardknox_checkout_intents,
// link_camper_face_descriptors, link_camper_faces, link_camper_mail,
// link_health_submissions, link_messages, link_photo_purchases, link_photo_tags,
// link_tip_cart_items, link_tips, parent_pickup_requests and pickup_alerts —
// plus link_parent_invites, whose camper_names array got a positional person_ids
// array. camp_link_program_settings was never really on this list:
// camper_mail_enabled is a feature flag, not a camper.
//
// Every one of those columns is backfilled AND kept true by a BEFORE INSERT
// trigger, which is the half that matters: a column filled once by a migration
// and maintained by nobody is a snapshot that starts lying with the next row.
//
// An empty TABLES half does NOT mean campers are identified by id. It means the
// id is now RECORDED everywhere. The thirty functions below still take a name,
// so a name is still what the system asks for and answers on, and a name is
// still what a rename breaks. That is the remaining work.
const TABLES_ON_NAMES = [];

const FUNCTIONS_ON_NAMES = [
    '_camper_mail_record',
    // 225's two new name-accepting surfaces. They exist so the name question can
    // be answered by the ID rule — _invite_covers_camper resolves and then calls
    // _invite_covers_person — but they still accept a name, so they still count.
    // They go when the callers send ids.
    '_invite_covers_camper',
    '_parent_invite_for',
    '_parent_owns_camper',
    'add_pickup_alert_league_recipients',
    'create_cardknox_checkout_intent',
    'credit_canteen_balance_from_processor',
    'credit_canteen_balance_from_stripe',
    'get_canteen_history',
    'mark_pickup_alert_league_checked',
    'merge_canteen_autoreload_card',
    'promote_confirmed_face',
    'receipt_recipient',
    'record_link_photo_purchase',
    'refund_canteen_deposit_from_processor',
    'refund_canteen_deposit_from_stripe',
    'resolve_photo_tag',
    'set_camper_face_consent',
    'set_canteen_auto_reload',
    'set_canteen_limits',
    'submit_camper_headshot',
    'submit_camper_mail',
    'submit_canteen_deposit',
    'submit_canteen_purchase',
    'submit_health_document',
    'submit_link_form_response',
    'submit_link_tip',
    'submit_pickup_request',
    'submit_shop_order',
    'update_canteen_autoreload_state',
    'use_family_card_for_canteen_auto_reload',
    'verify_my_camper',
];

test('no NEW table identifies a camper by name alone', () => {
    const found = [...nameKeyedTables().keys()].sort();
    const unlisted = found.filter(t => !TABLES_ON_NAMES.includes(t));
    assert.deepStrictEqual(unlisted, [],
        'These tables carry a camper name and no camper id. A name cannot survive a rename, '
        + 'and two campers can share one. Key on (camp_id, person_id) — see migration 216.');
});

test('no NEW function takes a camper name', () => {
    const found = [...nameKeyedFunctions().keys()].sort();
    const unlisted = found.filter(f => !FUNCTIONS_ON_NAMES.includes(f));
    assert.deepStrictEqual(unlisted, [],
        'These functions identify a camper by name. Take p_camper_id and resolve through '
        + 'camp_people instead — see migration 216.');
});

test('the ledger has no stale entries — struck off as each is converted', () => {
    // The other direction, and the reason this is a ratchet rather than a
    // checklist: an entry that no longer matches means the work is DONE and
    // the list is lying about how much is left. A ledger that overstates the
    // remaining work is as useless as one that understates it.
    const tables = nameKeyedTables();
    const fns = nameKeyedFunctions();
    const staleTables = TABLES_ON_NAMES.filter(t => !tables.has(t));
    const staleFns = FUNCTIONS_ON_NAMES.filter(f => !fns.has(f));
    assert.deepStrictEqual(staleTables, [],
        'Converted — strike these tables off TABLES_ON_NAMES.');
    assert.deepStrictEqual(staleFns, [],
        'Converted — strike these functions off FUNCTIONS_ON_NAMES.');
});

test('the identity itself is defined exactly once, and spans campers AND staff', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS, '216_camp_people_identity.sql'), 'utf8');
    // The primary key is the whole point: a number is taken camp-wide, not
    // taken-per-kind. Including kind in the key would let a counselor and a
    // camper hold the same number, which campistry_me.js:246 says camps
    // explicitly do not want.
    assert.match(sql, /CONSTRAINT camp_people_pkey PRIMARY KEY \(camp_id, person_id\)/);
    assert.doesNotMatch(sql, /PRIMARY KEY \(camp_id, kind, person_id\)/);
    assert.match(sql, /CHECK \(kind IN \('camper', 'staff'\)\)/);
    // And it must be scoped per camp, never globally.
    assert.doesNotMatch(sql, /PRIMARY KEY \(person_id\)/);
});

/**
 * Of the functions that still take a name, the ones that will ALSO accept an id.
 *
 * A function keeps its name parameter long after it stops deciding anything by
 * it — every caller passes one, and breaking eleven call sites to delete an
 * argument is not the same work as moving the decision. So the raw count below
 * barely moves while the actual conversion happens, and a number that does not
 * move is a number nobody watches. This is the one that moves.
 */
function alsoTakeAnId() {
    const latest = new Map();
    for (const { name, sql } of migrationFiles()) {
        const re = /CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql)) !== null) latest.set(m[1], m[2]);
    }
    const out = [];
    for (const [fn, args] of latest) {
        if (!/\bp_camper(_name)?\b/.test(args)) continue;
        if (/\bp_camper_id\b|\bp_person_id\b/.test(args)) out.push(fn);
    }
    return out.sort();
}

test('progress is reported, so the direction is visible', () => {
    const t = nameKeyedTables().size, f = nameKeyedFunctions().size;
    const withId = alsoTakeAnId();
    console.log(`    of those, ${withId.length} already accept a camper id: ${withId.join(', ')}`);
    // Not an assertion about the numbers — a place for them to be seen. When
    // this reaches 0/0, every camper reference in the database is an id.
    console.log(`    camper-identity ledger: ${t} tables and ${f} functions still on names`);
    assert.ok(t <= TABLES_ON_NAMES.length && f <= FUNCTIONS_ON_NAMES.length);
});
