// =============================================================================
// The camper-identity ledger.
//
// WHY THIS EXISTS. Migration 216 made (camp_id, person_id) a real identity, but
// almost nothing uses it yet: 21 tables carry a camper NAME and no id, and 30
// functions take p_camper_name. "Everything follows camp id and camper id" is
// therefore not a statement about today — it is a direction, and a direction
// nobody measures is a direction nobody travels.
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
function nameKeyedTables() {
    const found = new Map();
    for (const { name, sql } of migrationFiles()) {
        const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g;
        let m;
        while ((m = re.exec(sql)) !== null) {
            const table = m[1];
            const cols = [...m[2].matchAll(/^\s*(\w+)\s+\w/gm)].map(c => c[1].toLowerCase());
            const camper = cols.filter(c => c.includes('camper'));
            if (!camper.length) continue;
            const hasId = camper.some(c => c.endsWith('_id') || c.endsWith('_ids'));
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

const TABLES_ON_NAMES = [
    'banquest_pending_links',
    'camp_billing_enrollments',
    'camp_link_program_settings',      // camper_mail_enabled — a flag, not a camper
    'cardknox_checkout_intents',
    'link_camper_face_descriptors',
    'link_camper_faces',
    'link_camper_mail',
    'link_health_submissions',
    'link_messages',
    'link_parent_invites',
    'link_photo_purchases',
    'link_photo_tags',
    'link_tip_cart_items',
    'link_tips',
    'parent_pickup_requests',
    'pickup_alerts',
];

const FUNCTIONS_ON_NAMES = [
    '_camper_mail_record',
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

test('progress is reported, so the direction is visible', () => {
    const t = nameKeyedTables().size, f = nameKeyedFunctions().size;
    // Not an assertion about the numbers — a place for them to be seen. When
    // this reaches 0/0, every camper reference in the database is an id.
    console.log(`    camper-identity ledger: ${t} tables and ${f} functions still on names`);
    assert.ok(t <= TABLES_ON_NAMES.length && f <= FUNCTIONS_ON_NAMES.length);
});
