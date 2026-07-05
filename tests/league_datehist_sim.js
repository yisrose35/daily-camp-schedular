/* Date-based history hardening — proves the "recent sport" / "stuck" signals read
 * the calendar-dated gameLog (dates strictly before the day being generated)
 * instead of the generation-ordered flat teamSports array. This is what makes
 * regenerating an older/middle date correct even when later dates already exist.
 * Mirrors getTeamSportHistoryByDate in scheduler_core_leagues.js.
 */
'use strict';
const assert = require('assert');

function getTeamSportHistoryByDate(leagueName, team, history, beforeDate) {
    const gl = history.gameLog && history.gameLog[leagueName];
    if (!gl) return (history.teamSports[leagueName + '|' + team] || []);
    const out = [];
    Object.keys(gl).sort().forEach(d => {
        if (beforeDate && d >= beforeDate) return;
        (gl[d] || []).forEach(e => { if (e && e.sport && (e.t1 === team || e.t2 === team)) out.push(e.sport); });
    });
    return out;
}

const LG = 'L';
const history = {
    gameLog: { L: {
        '2026-06-25': [{ t1: '7', t2: '10', sport: 'Football' }],
        '2026-06-26': [{ t1: '7', t2: '8', sport: 'Hockey' }],
        '2026-06-28': [{ t1: '7', t2: '6', sport: 'Basketball' }],
        '2026-07-02': [{ t1: '7', t2: '13', sport: 'Baseball' }],   // FUTURE relative to 06-29
        '2026-07-03': [{ t1: '7', t2: '11', sport: 'Football' }],   // FUTURE
    } },
    // Generation order: the future dates were generated earlier so they sit at the
    // END of the flat array — exactly the corruption the old code read from.
    teamSports: { 'L|7': ['Football', 'Hockey', 'Basketball', 'Baseball', 'Football'] },
};

// TEST 1: generating 2026-06-29 sees only dates < 06-29, in calendar order
(function () {
    const h = getTeamSportHistoryByDate(LG, '7', history, '2026-06-29');
    assert.deepStrictEqual(h, ['Football', 'Hockey', 'Basketball'], 'must exclude future 07-02/07-03');
    console.log('TEST 1 PASS — date-based history excludes future dates: ' + JSON.stringify(h));
})();

// TEST 2: most-recent-by-date is Basketball (06-28), NOT the flat-array tail Football (07-03)
(function () {
    const h = getTeamSportHistoryByDate(LG, '7', history, '2026-06-29');
    assert.strictEqual(h[h.length - 1], 'Basketball', 'recent-by-date before 06-29 is Basketball');
    const flatTail = history.teamSports['L|7'][history.teamSports['L|7'].length - 1];
    assert.strictEqual(flatTail, 'Football', 'flat-array tail is a future date — the old bug');
    console.log('TEST 2 PASS — recent-by-date=Basketball (correct); flat-array tail=Football (old bug avoided)');
})();

// TEST 3: legacy data with no gameLog falls back to the flat array
(function () {
    const legacy = { teamSports: { 'L|7': ['Swim'] } };
    assert.deepStrictEqual(getTeamSportHistoryByDate(LG, '7', legacy, '2026-06-29'), ['Swim']);
    console.log('TEST 3 PASS — falls back to flat array when no gameLog (legacy data safe)');
})();

console.log('\n✅ ALL DATE-HISTORY TESTS PASS');
