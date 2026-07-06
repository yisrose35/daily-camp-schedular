/* Need-first sport allocation — proves the cross-league caps now hand a scarce
 * sport to whoever NEEDS it most (regardless of seniority), and that a needy team
 * actually PICKS the scarce sport instead of an abundant one on a nicer field.
 *
 * Mirrors, exactly as written in scheduler_core_leagues.js:
 *   - _sportNeed (per-league starvation for a sport vs that league's most-played)
 *   - the need-weighted largest-remainder cap block (game-count fallback when
 *     nobody has a specific need)
 *   - the assigner scorer's per-team need + ★ scarcity bonus + field-quality
 *
 * Scenario mirrors the live 7th-grade finding: football is scarce (2 fields).
 * The SENIOR league has already caught its teams up on football; the JUNIOR (7th)
 * has never played it. Need-first must give 7th BOTH football fields and the
 * senior ZERO — the opposite of seniority order.
 */
'use strict';
const assert = require('assert');

// ---- field inventory: football scarce (2), basketball plentiful (10) ----
function fieldsBySport() { return { Football: 2, Hockey: 2, Baseball: 3, Basketball: 10 }; }
const SPORTS = ['Baseball', 'Basketball', 'Football', 'Hockey'];

// ---- _sportNeed: Σ over teams of max(0, mostPlayed(team) − plays(team,sport)) ----
function teamCounts(histArr) { const c = {}; histArr.forEach(s => { c[s] = (c[s] || 0) + 1; }); return c; }
function sportNeed(league, sport) {
    let total = 0;
    league.histories.forEach(h => {
        const c = teamCounts(h);
        let mostPlayed = 0; for (const s in c) if (c[s] > mostPlayed) mostPlayed = c[s];
        total += Math.max(0, mostPlayed - (c[sport] || 0));
    });
    return total;
}

// mirrors the UPDATED need-weighted cap block in scheduler_core_leagues.js
function computeCaps(leagues, dayId) {
    const allSports = new Set(); leagues.forEach(l => l.sports.forEach(s => allSports.add(s)));
    const fbs = fieldsBySport();
    const games = {}; leagues.forEach(l => { games[l.name] = Math.max(1, Math.floor(l.histories.length / 2)); });
    let seed = 0; const ds = String(dayId || ''); for (let i = 0; i < ds.length; i++) seed = (seed * 31 + ds.charCodeAt(i)) & 0x7fffffff;
    const caps = {}; leagues.forEach(l => { caps[l.name] = {}; });
    const byNeedSports = [];
    allSports.forEach(sport => {
        const fc = fbs[sport] || 0; if (fc <= 0) return;
        const parts = leagues.filter(l => l.sports.includes(sport));
        let weights = parts.map(l => sportNeed(l, sport));
        const totalNeed = weights.reduce((s, w) => s + w, 0);
        const byNeed = totalNeed > 0;
        if (!byNeed) weights = parts.map(l => games[l.name]); else byNeedSports.push(sport);
        const totalW = weights.reduce((s, w) => s + w, 0) || 1;
        const rows = parts.map((l, idx) => { const exact = fc * weights[idx] / totalW; const base = Math.floor(exact); return { name: l.name, base, frac: exact - base, idx }; });
        let rem = fc - rows.reduce((s, r) => s + r.base, 0);
        rows.sort((a, b) => (b.frac - a.frac) || (((a.idx + seed) % rows.length) - ((b.idx + seed) % rows.length)));
        for (let i = 0; i < rows.length; i++) rows[i].base += (i < rem ? 1 : 0);
        rows.forEach(r => { caps[r.name][sport] = r.base; });
    });
    caps.__byNeed = byNeedSports;
    return caps;
}

// =====================================================================
// TEST 1 — caught-up senior drops to football cap 0; starved junior gets both
// =====================================================================
(function () {
    // Senior(8/9): 8 teams, EVERY team has already played football twice (caught up).
    const seniorHist = []; for (let i = 0; i < 8; i++) seniorHist.push(['Football', 'Football', 'Baseball', 'Hockey']);
    // Junior(7): 16 teams, NONE has ever played football (played other sports).
    const juniorHist = []; for (let i = 0; i < 16; i++) juniorHist.push(['Baseball', 'Hockey', 'Basketball']);
    const leagues = [
        { name: 'Senior(8/9)', sports: SPORTS, histories: seniorHist }, // senior → processed first
        { name: 'Junior(7)', sports: SPORTS, histories: juniorHist },
    ];
    const caps = computeCaps(leagues, '2026-06-30');
    console.log('TEST 1 caps:', JSON.stringify({ Senior: caps['Senior(8/9)'], Junior: caps['Junior(7)'] }));
    console.log('   need-weighted sports:', caps.__byNeed.join(', '));
    assert(caps['Senior(8/9)'].Football === 0, 'caught-up senior must get Football cap 0, got ' + caps['Senior(8/9)'].Football);
    assert(caps['Junior(7)'].Football === 2, 'starved junior must get BOTH football fields, got ' + caps['Junior(7)'].Football);
    assert(caps.__byNeed.includes('Football'), 'Football should be allocated by need');
    console.log('TEST 1 PASS — need-first overrides seniority: senior Football 0, junior Football 2\n');
})();

// =====================================================================
// TEST 2 — season start (no history) → no specific need → game-count fallback
// =====================================================================
(function () {
    const empty = n => { const a = []; for (let i = 0; i < n; i++) a.push([]); return a; };
    const leagues = [
        { name: 'Senior(8/9)', sports: SPORTS, histories: empty(18) }, // 9 games
        { name: 'Junior(7)', sports: SPORTS, histories: empty(16) },   // 8 games
    ];
    const caps = computeCaps(leagues, '2026-06-30');
    console.log('TEST 2 caps:', JSON.stringify({ Senior: caps['Senior(8/9)'], Junior: caps['Junior(7)'] }));
    // No team needs any sport specifically → fall back to game-count split; both
    // share the 2 football fields (1 each), nobody dropped to 0.
    assert(!caps.__byNeed.includes('Football'), 'season start: Football must use size fallback, not need');
    assert(caps['Senior(8/9)'].Football + caps['Junior(7)'].Football === 2, 'football fields conserved');
    assert(caps['Senior(8/9)'].Football >= 1 && caps['Junior(7)'].Football >= 1, 'each league keeps a share at season start');
    console.log('TEST 2 PASS — with no specific need, falls back to size (tie → time priority)\n');
})();

// =====================================================================
// TEST 3 — within a league, scarcity makes a needy team PICK football
//          over a nicer-ranked basketball field
// =====================================================================
(function () {
    // Replicates the MV scorer terms for one matchup, both sports fresh for both.
    const poolFieldsBySport = fieldsBySport();
    const maxPoolFields = Math.max(1, ...Object.values(poolFieldsBySport));
    const scarcityBonus = sport => ((maxPoolFields / (poolFieldsBySport[sport] || 1)) - 1) * 300;
    // field quality: basketball court is the BEST-ranked field, football a lesser one.
    const fqBonus = { Basketball: 200, Football: 140 };

    function scoreOption(sport, withScarcity) {
        // both teams have never played this sport → need 1000 each, fresh = 1
        let score = 1000 + 1000;
        if (withScarcity) score += (1 + 1) * scarcityBonus(sport);
        score += fqBonus[sport];           // field quality (no randomness for determinism)
        return score;
    }
    const pick = withScarcity => {
        const fb = scoreOption('Football', withScarcity);
        const bk = scoreOption('Basketball', withScarcity);
        return fb >= bk ? 'Football' : 'Basketball';
    };
    const before = pick(false), after = pick(true);
    console.log('TEST 3  without scarcity → picks', before, ' | with scarcity → picks', after);
    assert(before === 'Basketball', 'without scarcity the nicer basketball field wins (the bug)');
    assert(after === 'Football', 'with scarcity the needy team must grab the scarce football field');
    console.log('TEST 3 PASS — scarcity bonus flips the pick from Basketball to Football\n');
})();

console.log('✅ ALL NEED-FIRST TESTS PASS');
