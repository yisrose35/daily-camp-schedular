/* Stuck-priority field-pick order — proves the team most stuck on one sport
 * (e.g. basketball N days in a row) gets first pick of the league's scarce
 * diverse fields, so the streak breaks. Mirrors _trailingSportStreak and the
 * matchup sort added to both assigners in scheduler_core_leagues.js.
 *
 * Only the FIELD-PICK ORDER changes — the matchups themselves (who plays whom)
 * are fixed by the round-robin upstream and are untouched here.
 */
'use strict';
const assert = require('assert');

function trailingStreak(hist) {
    if (!hist || !hist.length) return 0;
    const last = hist[hist.length - 1];
    let n = 0; for (let i = hist.length - 1; i >= 0 && hist[i] === last; i--) n++;
    return n;
}

// ---- TEST 1: trailing same-sport streak measured correctly ----
(function () {
    assert.strictEqual(trailingStreak([]), 0);
    assert.strictEqual(trailingStreak(['Basketball']), 1);
    assert.strictEqual(trailingStreak(['Football', 'Hockey', 'Basketball', 'Basketball', 'Basketball', 'Basketball']), 4);
    assert.strictEqual(trailingStreak(['Basketball', 'Basketball', 'Football']), 1);   // streak broken by last game
    console.log('TEST 1 PASS — trailing sport streak measured correctly');
})();

// ---- TEST 2: the most-stuck team claims the one scarce diverse field ----
(function () {
    // Per-team history. Team A is stuck on Basketball ×4; the others are not.
    const H = {
        A: ['Basketball', 'Basketball', 'Basketball', 'Basketball'], // streak 4 → most urgent
        B: ['Hockey', 'Football', 'Basketball'],                     // streak 1
        C: ['Football', 'Hockey', 'Basketball', 'Football'],         // streak 1
        D: ['Basketball', 'Hockey', 'Football', 'Hockey'],           // streak 1
    };
    // Round-robin already fixed today's matchups: A vs B, C vs D.
    const matchups = [['A', 'B'], ['C', 'D']];
    // The league's pool this slot: ONE diverse field (Baseball) + plenty of basketball.
    const makePool = () => [{ field: 'Base1', sport: 'Baseball' }]
        .concat([1, 2, 3, 4, 5].map(i => ({ field: 'BK' + i, sport: 'Basketball' })));

    // Assign in a given matchup order. The per-matchup scorer prefers a diverse
    // sport when one is available (mirrors the strong sport-need + recent-guard).
    function assign(order) {
        const used = new Set(), out = {};
        order.forEach(m => {
            const avail = makePool().filter(o => !used.has(o.field));
            const pick = avail.find(o => o.sport !== 'Basketball') || avail[0];
            used.add(pick.field);
            out[m[0]] = pick.sport; out[m[1]] = pick.sport;
        });
        return out;
    }
    const stuckOf = m => trailingStreak(H[m[0]]) + trailingStreak(H[m[1]]);

    // WITHOUT stuck-priority: C vs D happens to be processed first → it grabs the
    // single diverse field → Team A is stuck on basketball a 5th time.
    const noStuck = assign([matchups[1], matchups[0]]);
    console.log('  NO stuck-priority → Team A gets', noStuck.A);
    assert.strictEqual(noStuck.A, 'Basketball', 'without stuck-priority the stuck team misses the diverse field');

    // WITH stuck-priority: sort by stuck DESC → A vs B (stuck 4+1) goes first →
    // Team A claims the diverse field → streak broken.
    const withStuck = assign(matchups.slice().sort((a, b) => stuckOf(b) - stuckOf(a)));
    console.log('  WITH stuck-priority → Team A gets', withStuck.A);
    assert.strictEqual(withStuck.A, 'Baseball', 'with stuck-priority the stuck team claims the diverse field');
    console.log('TEST 2 PASS — the most sport-stuck team claims the scarce diverse field first');
})();

console.log('\n✅ ALL STUCK-PRIORITY TESTS PASS');
