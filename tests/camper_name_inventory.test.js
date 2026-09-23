// =============================================================================
// The camper-name inventory (Ted, TED-002).
//
// docs/CAMPER_NAME_INVENTORY.md lists every place the pages still identify a
// camper by name. This keeps it honest: the document must match the code, and
// no count may rise above the baseline below. When a step of the plan lands,
// lower the baseline to the new count, so the ratchet only turns one way.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const inv = require('../scripts/camper_name_inventory.js');

// Counts on 2026-09-23. Lower these as places move to numbers. Never raise them.
const BASELINE = { records: 97, enrollments: 44, families: 73, bunks: 53, roster: 190, edge: 130, database: 4 };

test('the inventory document matches the code', () => {
    const want = inv.render(inv.count());
    const have = fs.readFileSync(inv.OUT, 'utf8');
    assert.strictEqual(have, want, 'run: node scripts/camper_name_inventory.js');
});

test('no new place identifies a camper by name', () => {
    const c = inv.count();
    const grew = Object.keys(BASELINE).filter(k => c[k].total > BASELINE[k])
        .map(k => k + ': ' + BASELINE[k] + ' → ' + c[k].total);
    assert.deepStrictEqual(grew, [],
        'New name-keyed code. Use camperId (the camper number) instead:\n  ' + grew.join('\n  '));
});

test('the counter sees what it claims to', () => {
    const k = Object.fromEntries(inv.KINDS.map(x => [x.id, x.test]));
    assert.ok(k.records("log.push({ camperName: n, medication: m })"));
    assert.ok(!k.records("log.push({ camperName: n, camperId: id })"), 'a record WITH a number is not name-only');
    assert.ok(k.enrollments("if (e.camperName === name) {"));
    assert.ok(k.families("f.camperIds.indexOf(n)"));
    assert.ok(k.bunks("bunkAsgn[b].push(n)"));
    assert.ok(k.roster("var c = roster[name];"));
    assert.ok(!k.roster("rosterCount = 3"));
});

test('the inventory covers the edge functions and the database, not only the pages', () => {
    const c = inv.count();
    assert.ok(c.edge && c.edge.total > 0 && Object.keys(c.edge.files).every(f => f.startsWith('supabase/functions/')));
    assert.ok(!Object.keys(c.edge.files).some(f => /payments-checkout\/|payments-canteen-checkout\/|payments-charge\//.test(f)),
        'superseded functions are not counted');
    assert.strictEqual(c.database.total, inv.DB_NAME_KEYS.length, 'a database item disappeared from the migrations — update the list');
    const doc = fs.readFileSync(inv.OUT, 'utf8');
    assert.match(doc, /Edge functions: a camper named without their number/);
    assert.match(doc, /Database: storage keyed by a camper's name/);
});

// ── the Snacks page finds an account by its camper's number ─────────────────
test('a renamed camper\'s canteen account is filed under their current roster key', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
    const start = src.indexOf('function _accountsUnderCurrentNames');
    const end = src.indexOf('// Overlay the row-backed truth');
    const ctx = { getRoster: () => ({ 'Ayala Weiss-Katz': { camperId: 880 }, 'Dov Lerner': { camperId: 881 },
                                      'Old Key Taken': { camperId: 882 } }), Object, String };
    vm.runInNewContext(src.slice(start, end), ctx);
    const out = ctx._accountsUnderCurrentNames({
        'Ayala Weiss':   { balance: 12, camperId: 880 },   // renamed: moves to her current key
        'Dov Lerner':    { balance: 3,  camperId: 881 },   // unchanged
        'Old Key':       { balance: 1,  camperId: 882 },   // renamed onto a key another account used
        'Old Key Taken': { balance: 9,  camperId: 999 },   // not on the roster: moves aside, kept
        'Nobody':        { balance: 4 },                    // no number: left as it is
    });
    assert.strictEqual(out['Ayala Weiss-Katz'].balance, 12);
    assert.strictEqual(out['Ayala Weiss-Katz'].accountKey, 'Ayala Weiss', 'the server key is remembered');
    assert.ok(!('Ayala Weiss' in out));
    assert.strictEqual(out['Dov Lerner'].balance, 3);
    assert.strictEqual(out['Old Key Taken'].camperId, 882, 'the enrolled camper is found under their own key');
    assert.strictEqual(out['Old Key Taken'].balance, 1);
    assert.strictEqual(Object.values(out).find(a => a.camperId === 999).balance, 9, 'the other account is kept');
    assert.strictEqual(out['Nobody'].balance, 4);
    assert.match(src, /target\.accounts = _accountsUnderCurrentNames\(rows\.accounts\);/);
});

test('a departed child\'s account never sits where an enrolled child of the same name is looked up', () => {
    // Avi Katz #10 left with $40; a new Avi Katz is #11. The server keeps the
    // departed account under "Avi Katz" and gives the new one its own key.
    const src = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
    const ctx = { getRoster: () => ({ 'Avi Katz': { camperId: 11 } }), Object, String };
    vm.runInNewContext(src.slice(src.indexOf('function _accountsUnderCurrentNames'), src.indexOf('// Overlay the row-backed truth')), ctx);
    const out = ctx._accountsUnderCurrentNames({
        'Avi Katz':     { balance: 40, camperId: 10 },
        'Avi Katz #11': { balance: 2,  camperId: 11 },
    });
    assert.strictEqual(out['Avi Katz'].camperId, 11, 'the enrolled Avi is shown the departed Avi\'s money');
    assert.strictEqual(out['Avi Katz'].balance, 2);
    const departed = Object.values(out).find(a => a.camperId === 10);
    assert.strictEqual(departed.balance, 40, 'the departed Avi\'s money must still be listed');
    assert.strictEqual(Object.keys(out).length, 2);
});
