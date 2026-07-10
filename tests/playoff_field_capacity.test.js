// =============================================================================
// playoff_field_capacity.test.js — tests for PlayoffMode.getFieldShortages,
// the pure capacity check behind the Playoff Hub's "you scheduled 6 baseball
// games but only 5 baseball fields exist" warning.
// Run: node --test tests/playoff_field_capacity.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const PM = require('../playoff_mode.js');

// fields config: name -> sports it hosts
const FIELDS = {
    'Diamond 1': ['Baseball'],
    'Diamond 2': ['Baseball'],
    'Diamond 3': ['Baseball'],
    'Diamond 4': ['Baseball'],
    'Diamond 5': ['Baseball'],
    'Court A': ['Basketball'],
    'Multi 1': ['Baseball', 'Kickball'],
    'Multi 2': ['Baseball', 'Kickball'],
};
function fieldsForSport(sport) {
    return Object.keys(FIELDS).filter(f => FIELDS[f].includes(sport));
}
function onlyDiamondsForSport(sport) {
    return sport === 'Baseball'
        ? ['Diamond 1', 'Diamond 2', 'Diamond 3', 'Diamond 4', 'Diamond 5']
        : fieldsForSport(sport);
}

let _id = 0;
function mu(teamA, teamB, sport, field, winner) {
    return { id: 'm' + (++_id), teamA, teamB, sport: sport || '', field: field || '', winner: winner || null };
}
function round(matchups, reservedActivities) {
    return { number: 1, matchups, byes: [], reservedActivities: reservedActivities || [] };
}

test('6 baseball games vs 5 baseball fields → per-sport shortfall of 1', () => {
    const r = round([
        mu('T1', 'T2', 'Baseball'), mu('T3', 'T4', 'Baseball'), mu('T5', 'T6', 'Baseball'),
        mu('T7', 'T8', 'Baseball'), mu('T9', 'T10', 'Baseball'), mu('T11', 'T12', 'Baseball'),
    ]);
    const warnings = PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport });
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], { kind: 'sport', sport: 'Baseball', games: 6, capacity: 5, shortfall: 1 });
});

test('games ≤ fields → no warnings', () => {
    const r = round([
        mu('T1', 'T2', 'Baseball'), mu('T3', 'T4', 'Baseball'),
        mu('T5', 'T6', 'Basketball'),
    ]);
    assert.deepStrictEqual(PM.getFieldShortages(r, { fieldsForSport: fieldsForSport }), []);
});

test('decided and BYE/unfilled matchups are not counted as games', () => {
    const r = round([
        mu('T1', 'T2', 'Baseball', '', 'T1'),      // decided — not scheduled again
        mu('T3', 'BYE', 'Baseball'),               // BYE placeholder — skipped
        mu('T4', '', 'Baseball'),                  // half-filled — skipped
        mu('T5', 'T6', 'Baseball'),
    ]);
    assert.deepStrictEqual(PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport }), []);
});

test('reserved fields are excluded from capacity (saved for teams that are out)', () => {
    // 5 baseball games, 5 diamonds — but 1 diamond is reserved for the kids
    // that are out, so only 4 remain for games.
    const r = round([
        mu('T1', 'T2', 'Baseball'), mu('T3', 'T4', 'Baseball'), mu('T5', 'T6', 'Baseball'),
        mu('T7', 'T8', 'Baseball'), mu('T9', 'T10', 'Baseball'),
    ], ['Diamond 5']);
    const warnings = PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].kind, 'sport');
    assert.strictEqual(warnings[0].capacity, 4);
    assert.strictEqual(warnings[0].shortfall, 1);
});

test('an explicit user pick of a reserved field restores that capacity', () => {
    // Same as above, but the user explicitly assigned the reserved diamond to
    // one matchup — explicit picks win over the reserve, so all 5 games fit.
    const r = round([
        mu('T1', 'T2', 'Baseball', 'Diamond 5'), mu('T3', 'T4', 'Baseball'), mu('T5', 'T6', 'Baseball'),
        mu('T7', 'T8', 'Baseball'), mu('T9', 'T10', 'Baseball'),
    ], ['Diamond 5']);
    assert.deepStrictEqual(PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport }), []);
});

test('matchups with no sport are reported as skipped, not counted as games', () => {
    const r = round([
        mu('T1', 'T2', ''), mu('T3', 'T4', 'Baseball'),
    ]);
    const warnings = PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport });
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], { kind: 'no_sport', count: 1 });
});

test('same field explicitly picked for two matchups → field_dup warning', () => {
    const r = round([
        mu('T1', 'T2', 'Baseball', 'Diamond 1'),
        mu('T3', 'T4', 'Baseball', 'Diamond 1'),
    ]);
    const warnings = PM.getFieldShortages(r, { fieldsForSport: onlyDiamondsForSport });
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], { kind: 'field_dup', field: 'Diamond 1', picks: 2 });
});

test('cross-sport contention on shared fields → overall shortfall', () => {
    // 2 baseball + 2 kickball games; kickball only plays on the 2 multi-use
    // fields, baseball has 7 options. Per-sport both fit, but only pretend the
    // camp has ONLY the two multi fields: 4 games, 2 fields.
    const multiOnly = sport => ['Multi 1', 'Multi 2'];
    const r = round([
        mu('T1', 'T2', 'Baseball'), mu('T3', 'T4', 'Baseball'),
        mu('T5', 'T6', 'Kickball'), mu('T7', 'T8', 'Kickball'),
    ]);
    const warnings = PM.getFieldShortages(r, { fieldsForSport: multiOnly });
    // Per-sport: 2 games vs 2 fields each → fine. Overall: 4 games, 2 fields.
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], { kind: 'overall', games: 4, capacity: 2, shortfall: 2 });
});

test('specialty mode: shared court pool with multiple games per court', () => {
    // 7 games on 2 courts × 3 games each = capacity 6 → 1 dropped.
    const matchups = [];
    for (let i = 1; i <= 14; i += 2) matchups.push(mu('T' + i, 'T' + (i + 1)));
    const r = round(matchups);
    const warnings = PM.getFieldShortages(r, { sharedFieldPool: ['Court 1', 'Court 2'], gamesPerField: 3 });
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], { kind: 'overall', games: 7, capacity: 6, shortfall: 1 });
});

test('specialty mode: enough court capacity → no warnings', () => {
    const r = round([mu('T1', 'T2'), mu('T3', 'T4'), mu('T5', 'T6')]);
    assert.deepStrictEqual(
        PM.getFieldShortages(r, { sharedFieldPool: ['Court 1'], gamesPerField: 3 }), []);
});

test('empty / malformed rounds return no warnings', () => {
    assert.deepStrictEqual(PM.getFieldShortages(null, { fieldsForSport: fieldsForSport }), []);
    assert.deepStrictEqual(PM.getFieldShortages({}, { fieldsForSport: fieldsForSport }), []);
    assert.deepStrictEqual(PM.getFieldShortages(round([]), { fieldsForSport: fieldsForSport }), []);
});
