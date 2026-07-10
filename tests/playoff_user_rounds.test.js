// =============================================================================
// playoff_user_rounds.test.js — data-model tests for the user-defined-rounds
// playoff redesign (playoff_mode.js v2).
// Run: node --test tests/playoff_user_rounds.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const PM = require('../playoff_mode.js');

function freshLeague() {
    return {
        name: 'Test League',
        teams: ['Lions', 'Tigers', 'Bears', 'Wolves', 'Hawks', 'Eagles'],
        sports: ['Basketball', 'Hockey']
    };
}

test('getOrInit initializes the user-defined-rounds model', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    assert.strictEqual(p.enabled, false);
    assert.deepStrictEqual(p.rounds, []);
    assert.deepStrictEqual(p.reservedActivities, []);
    assert.strictEqual(p.currentRound, 1);
    assert.strictEqual(p.startGameCount, null);
});

test('getOrInit normalizes startGameCount: keeps valid counts, nulls garbage', () => {
    const league = freshLeague();
    league.playoff = { enabled: true, rounds: [], currentRound: 1, startGameCount: 7 };
    assert.strictEqual(PM.getOrInit(league).startGameCount, 7);
    const league2 = freshLeague();
    league2.playoff = { enabled: true, rounds: [], currentRound: 1, startGameCount: -3 };
    assert.strictEqual(PM.getOrInit(league2).startGameCount, null);
    const league3 = freshLeague();
    league3.playoff = { enabled: true, rounds: [], currentRound: 1, startGameCount: '5' };
    assert.strictEqual(PM.getOrInit(league3).startGameCount, null);
});

test('createRound appends N empty matchups with sequential numbering', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    const r1 = PM.createRound(p, 3);
    const r2 = PM.createRound(p, 2);
    assert.strictEqual(r1.number, 1);
    assert.strictEqual(r2.number, 2);
    assert.strictEqual(r1.matchups.length, 3);
    assert.strictEqual(r2.matchups.length, 2);
    assert.ok(Array.isArray(r1.byes));
    r1.matchups.forEach(m => {
        assert.strictEqual(m.teamA, '');
        assert.strictEqual(m.teamB, '');
        assert.strictEqual(m.winner, null);
        assert.ok(m.id);
    });
});

test('createRound clamps a bad matchup count to at least 1', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    const r = PM.createRound(p, 'garbage');
    assert.strictEqual(r.matchups.length, 1);
});

test('getActiveMatchups returns only fully-filled, undecided matchups of the current round', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    p.enabled = true;
    const r1 = PM.createRound(p, 4);
    r1.matchups[0].teamA = 'Lions'; r1.matchups[0].teamB = 'Tigers';
    r1.matchups[1].teamA = 'Bears'; r1.matchups[1].teamB = 'Wolves';
    r1.matchups[1].winner = 'Bears';                 // decided — excluded
    r1.matchups[2].teamA = 'Hawks';                  // half-filled — excluded
    // matchups[3] untouched — excluded
    p.currentRound = 1;

    assert.strictEqual(PM.isLeagueInPlayoff(league), true);
    const active = PM.getActiveMatchups(league);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].teamA, 'Lions');
});

test('getActiveRound resolves by round NUMBER, not array index', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    p.enabled = true;
    PM.createRound(p, 2);
    const r2 = PM.createRound(p, 1);
    r2.matchups[0].teamA = 'Lions'; r2.matchups[0].teamB = 'Bears';
    p.currentRound = 2;
    assert.strictEqual(PM.getActiveRound(league), r2);
    assert.strictEqual(PM.getActiveMatchups(league)[0].teamB, 'Bears');
});

test('isRoundComplete: filled matchups all need winners; empty placeholders ignored; half-filled blocks', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    const r = PM.createRound(p, 3);
    assert.strictEqual(PM.isRoundComplete(r), false);          // nothing filled

    r.matchups[0].teamA = 'Lions'; r.matchups[0].teamB = 'Tigers';
    assert.strictEqual(PM.isRoundComplete(r), false);          // no winner yet

    r.matchups[0].winner = 'Lions';
    assert.strictEqual(PM.isRoundComplete(r), true);           // empty placeholders don't block

    r.matchups[1].teamA = 'Bears';                             // half-filled blocks
    assert.strictEqual(PM.isRoundComplete(r), false);

    r.matchups[1].teamB = 'Wolves';
    r.matchups[1].winner = 'Wolves';
    assert.strictEqual(PM.isRoundComplete(r), true);
});

test('removeRound renumbers remaining rounds and clamps currentRound', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    PM.createRound(p, 4);
    PM.createRound(p, 2);
    PM.createRound(p, 1);
    p.currentRound = 3;
    PM.removeRound(p, 2);
    assert.strictEqual(p.rounds.length, 2);
    assert.deepStrictEqual(p.rounds.map(r => r.number), [1, 2]);
    assert.strictEqual(p.rounds[1].matchups.length, 1);        // old round 3 kept its matchups
    assert.strictEqual(p.currentRound, 2);                     // clamped into range
});

test('getEliminatedTeams: losers are out unless they reappear in a later round (matchup or bye)', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    p.enabled = true;
    const r1 = PM.createRound(p, 2);
    r1.matchups[0] = { ...r1.matchups[0], teamA: 'Lions', teamB: 'Tigers', winner: 'Lions' };
    r1.matchups[1] = { ...r1.matchups[1], teamA: 'Bears', teamB: 'Wolves', winner: 'Wolves' };
    const r2 = PM.createRound(p, 1);
    r2.matchups[0] = { ...r2.matchups[0], teamA: 'Lions', teamB: 'Wolves' };
    // Tigers lost R1 but the user brings them back on a bye in R2 (their call)
    r2.byes = ['Tigers'];

    assert.deepStrictEqual(PM.getEliminatedTeams(league), ['Bears']);
});

test('getChampion: winner of a decided single-matchup final round', () => {
    const league = freshLeague();
    const p = PM.getOrInit(league);
    p.enabled = true;
    const r1 = PM.createRound(p, 2);
    r1.matchups[0] = { ...r1.matchups[0], teamA: 'Lions', teamB: 'Tigers', winner: 'Lions' };
    r1.matchups[1] = { ...r1.matchups[1], teamA: 'Bears', teamB: 'Wolves', winner: 'Wolves' };
    const final = PM.createRound(p, 1);
    assert.strictEqual(PM.getChampion(league), null);          // final not filled yet
    final.matchups[0].teamA = 'Lions';
    final.matchups[0].teamB = 'Wolves';
    assert.strictEqual(PM.getChampion(league), null);          // not decided yet
    final.matchups[0].winner = 'Wolves';
    assert.strictEqual(PM.getChampion(league), 'Wolves');
});

test('legacy v1 auto-generated bracket data still loads and schedules', () => {
    const league = freshLeague();
    // Shape produced by the retired v1 bracket engine, incl. BYE + adjust fields
    league.playoff = {
        enabled: true,
        style: 'fixed',
        seedOrder: ['Lions', 'Tigers', 'Bears'],
        bracketAdjust: { mode: 'none', eliminated: [], byes: {}, playIn: [] },
        rounds: [{
            number: 1,
            matchups: [
                { id: 'a', teamA: 'Lions', teamB: 'BYE', seedA: 1, seedB: 4, sport: '', field: '', winner: 'Lions', isBye: true },
                { id: 'b', teamA: 'Tigers', teamB: 'Bears', seedA: 2, seedB: 3, sport: 'Hockey', field: '', winner: null, isBye: false }
            ]
        }],
        reservedActivities: ['Canteen'],
        currentRound: 1
    };
    const p = PM.getOrInit(league);
    assert.ok(Array.isArray(p.rounds[0].byes));                // byes array added by migration
    assert.strictEqual(PM.isLeagueInPlayoff(league), true);
    const active = PM.getActiveMatchups(league);
    assert.strictEqual(active.length, 1);                      // BYE matchup filtered out
    assert.strictEqual(active[0].sport, 'Hockey');
    assert.strictEqual(PM.isRoundComplete(p.rounds[0]), false);
    league.playoff.rounds[0].matchups[1].winner = 'Bears';
    assert.strictEqual(PM.isRoundComplete(p.rounds[0]), true);
    assert.deepStrictEqual(p.reservedActivities, ['Canteen']); // reservations preserved
});
