/* FN-58 logic simulation — auto-saved games sync (score preservation).
 * Replicates LeaguesAPI.syncGamesFromGeneration's core logic exactly as
 * written in leagues.js and proves:
 *   1. fresh generation creates auto games (manual games untouched)
 *   2. regen same matchups → entered scores preserved (incl. flipped team order)
 *   3. regen changed matchups → vanished pair's score dropped, survivor kept
 *   4. label shift (renumbering) → pair-only fallback still preserves score
 *   5. empty generation (league dropped from day) → date's auto games cleared
 */
'use strict';
const assert = require('assert');

const pairKey = (a, b) => [a, b].sort().join('|');
const isAuto = g => g && (g.importedFrom === 'auto' || g.importedFrom === 'schedule');

function syncGames(league, dateKey, gameEntries) {
    if (!Array.isArray(league.games)) league.games = [];
    const oldByLabelPair = {}, oldByPair = {}, oldPairCount = {};
    league.games.forEach(g => {
        if (g.date !== dateKey || !isAuto(g)) return;
        (g.matches || []).forEach(m => {
            if (m.scoreA == null && m.scoreB == null) return;
            const pk = pairKey(m.teamA, m.teamB);
            oldByLabelPair[(g.gameLabel || '') + '|' + pk] = m;
            oldByPair[pk] = m;
            oldPairCount[pk] = (oldPairCount[pk] || 0) + 1;
        });
    });
    league.games = league.games.filter(g => !(g.date === dateKey && isAuto(g)));
    const newPairCount = {};
    (gameEntries || []).forEach(ge => (ge && ge.matches || []).forEach(m => {
        newPairCount[pairKey(m.teamA, m.teamB)] = (newPairCount[pairKey(m.teamA, m.teamB)] || 0) + 1;
    }));
    (gameEntries || []).forEach(ge => {
        if (!ge || !Array.isArray(ge.matches) || ge.matches.length === 0) return;
        const numMatch = String(ge.gameLabel || '').match(/Game\s*(\d+)/i);
        league.games.push({
            date: dateKey,
            gameLabel: ge.gameLabel || 'Game',
            gameNumber: ge.gameNumber != null ? ge.gameNumber : (numMatch ? parseInt(numMatch[1], 10) : null),
            matches: ge.matches.map(m => {
                const pk = pairKey(m.teamA, m.teamB);
                let old = oldByLabelPair[(ge.gameLabel || '') + '|' + pk];
                if (!old && oldPairCount[pk] === 1 && newPairCount[pk] === 1) old = oldByPair[pk];
                const aligned = old && old.teamA === m.teamA;
                return {
                    teamA: m.teamA, teamB: m.teamB,
                    scoreA: old ? (aligned ? old.scoreA : old.scoreB) : null,
                    scoreB: old ? (aligned ? old.scoreB : old.scoreA) : null,
                    sport: m.sport || null
                };
            }),
            importedFrom: 'auto'
        });
    });
    league.games.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.gameNumber || 0) - (b.gameNumber || 0));
}

// ---- Test 1: fresh gen creates auto games; manual game untouched ----
{
    const league = { games: [{ date: '2026-06-27', gameLabel: 'My manual game', matches: [{ teamA: 'X', teamB: 'Y', scoreA: 5, scoreB: 3 }] }] };
    syncGames(league, '2026-06-27', [{ gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4', sport: 'Gaga' }, { teamA: '2', teamB: '3', sport: 'Hockey' }] }]);
    assert.strictEqual(league.games.length, 2);
    assert.ok(league.games.some(g => g.gameLabel === 'My manual game' && g.matches[0].scoreA === 5), 'manual game preserved');
    const auto = league.games.find(g => g.importedFrom === 'auto');
    assert.strictEqual(auto.matches.length, 2);
    assert.strictEqual(auto.matches[0].scoreA, null);
    assert.strictEqual(auto.gameNumber, 1);
    console.log('TEST 1 PASS — fresh auto games created, manual untouched');
}

// ---- Test 2: regen same matchups → scores preserved (even flipped order) ----
{
    const league = { games: [] };
    syncGames(league, 'd', [{ gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4', sport: 'Gaga' }] }]);
    league.games[0].matches[0].scoreA = 10; // team 1
    league.games[0].matches[0].scoreB = 7;  // team 4
    // regen returns the same pair but flipped order
    syncGames(league, 'd', [{ gameLabel: 'Game 1', matches: [{ teamA: '4', teamB: '1', sport: 'Belts' }] }]);
    const m = league.games[0].matches[0];
    assert.strictEqual(m.teamA, '4');
    assert.strictEqual(m.scoreA, 7, 'team 4 keeps its 7');
    assert.strictEqual(m.scoreB, 10, 'team 1 keeps its 10');
    assert.strictEqual(m.sport, 'Belts', 'sport refreshed from regen');
    console.log('TEST 2 PASS — regen preserves scores, aligned to team order');
}

// ---- Test 3: regen changed matchups → vanished score dropped, survivor kept ----
{
    const league = { games: [] };
    syncGames(league, 'd', [{ gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4' }, { teamA: '2', teamB: '3' }] }]);
    league.games[0].matches[0].scoreA = 8; league.games[0].matches[0].scoreB = 2;   // 1v4 scored
    league.games[0].matches[1].scoreA = 4; league.games[0].matches[1].scoreB = 4;   // 2v3 scored
    // regen: 1v4 survives, 2v3 → became 2v4 + 1v3
    syncGames(league, 'd', [{ gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4' }, { teamA: '2', teamB: '4' }] }]);
    const g = league.games[0];
    assert.strictEqual(g.matches.find(m => pairKey(m.teamA, m.teamB) === '1|4').scoreA, 8, '1v4 score kept');
    assert.strictEqual(g.matches.find(m => pairKey(m.teamA, m.teamB) === '2|4').scoreA, null, 'new pair starts blank');
    assert.ok(!g.matches.some(m => pairKey(m.teamA, m.teamB) === '2|3'), 'vanished pair gone');
    console.log('TEST 3 PASS — changed matchups replace cleanly');
}

// ---- Test 4: label shift (renumbering) → pair-only fallback preserves ----
{
    const league = { games: [] };
    syncGames(league, 'd', [{ gameLabel: 'Game 5', matches: [{ teamA: '1', teamB: '4' }] }]);
    league.games[0].matches[0].scoreA = 3; league.games[0].matches[0].scoreB = 1;
    // an earlier day inserted → renumbered to Game 6 on regen
    syncGames(league, 'd', [{ gameLabel: 'Game 6', matches: [{ teamA: '1', teamB: '4' }] }]);
    assert.strictEqual(league.games[0].gameLabel, 'Game 6');
    assert.strictEqual(league.games[0].matches[0].scoreA, 3, 'score survives the label shift');
    console.log('TEST 4 PASS — pair-only fallback survives renumbering');
}

// ---- Test 5: empty generation clears the date's auto games ----
{
    const league = { games: [] };
    syncGames(league, 'd', [{ gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4' }] }]);
    assert.strictEqual(league.games.length, 1);
    syncGames(league, 'd', []);   // league dropped from the day
    assert.strictEqual(league.games.length, 0);
    console.log('TEST 5 PASS — empty regen clears the date');
}

// ---- Test 6: multiple games per day — same pair twice stays distinct ----
{
    const league = { games: [] };
    // two league periods in one day; a 2-team-style rematch (1v4 in BOTH games)
    syncGames(league, 'd', [
        { gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4', sport: 'Gaga' }, { teamA: '2', teamB: '3', sport: 'Hockey' }] },
        { gameLabel: 'Game 2', matches: [{ teamA: '1', teamB: '4', sport: 'Belts' }, { teamA: '2', teamB: '3', sport: 'Jumbo' }] }
    ]);
    assert.strictEqual(league.games.length, 2, 'two game entries for the day');
    // score game 1's 1v4 only
    league.games.find(g => g.gameLabel === 'Game 1').matches[0].scoreA = 9;
    league.games.find(g => g.gameLabel === 'Game 1').matches[0].scoreB = 6;
    // score game 2's 1v4 differently
    league.games.find(g => g.gameLabel === 'Game 2').matches[0].scoreA = 2;
    league.games.find(g => g.gameLabel === 'Game 2').matches[0].scoreB = 3;
    // regen: same two games (sports may differ)
    syncGames(league, 'd', [
        { gameLabel: 'Game 1', matches: [{ teamA: '1', teamB: '4', sport: 'Dodgeball' }, { teamA: '2', teamB: '3', sport: 'Coloring' }] },
        { gameLabel: 'Game 2', matches: [{ teamA: '1', teamB: '4', sport: 'Jumprope' }, { teamA: '2', teamB: '3', sport: 'Machanayim' }] }
    ]);
    const g1 = league.games.find(g => g.gameLabel === 'Game 1');
    const g2 = league.games.find(g => g.gameLabel === 'Game 2');
    assert.strictEqual(g1.matches[0].scoreA, 9, 'Game 1 keeps ITS 1v4 score');
    assert.strictEqual(g2.matches[0].scoreA, 2, 'Game 2 keeps ITS 1v4 score (label+pair identity, no cross-bleed)');
    assert.strictEqual(g2.matches[1].scoreA, null, 'unscored match stays blank');
    console.log('TEST 6 PASS — multi-game day: per-game score identity holds');
}

console.log('\nALL 6 AUTO-SAVE TESTS PASS');
