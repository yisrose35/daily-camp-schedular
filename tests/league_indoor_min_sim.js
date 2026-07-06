// =============================================================================
// league_indoor_min_sim.js
// -----------------------------------------------------------------------------
// Sim for the INDOOR MINIMUM guarantee (league.indoorRequirement, op '>='/'='):
// "if the user turns on the indoor rule, the number entered is the MINIMUM
// number of indoor games each team must get per day — scheduling must keep to it."
//
// The solver already had: neediest-first matchup ordering, a hard (non-blocking)
// per-matchup filter, and a scoring bias. This sim covers the three mechanisms
// that CLOSE the remaining gaps (mirrored exactly from scheduler_core_leagues.js):
//
//   1. _indoorRescuePass — post-assignment, within one game: a below-floor team
//      left outdoors is relocated to a FREE same-sport indoor court, else trades
//      courts with a same-sport matchup whose teams already met the floor.
//   2. Cross-league INDOOR RESERVATION — a league with no unmet indoor need
//      withholds up to <demand> indoor fields for later-processed leagues that
//      still owe teams indoor games (senior leagues would otherwise drain the
//      gyms first — same failure shape as the away-zone poach).
//   3. End-of-day VERIFICATION — teams ending below the floor are reported.
// =============================================================================

'use strict';
const assert = require('assert');

// --- mirrors of the engine helpers ------------------------------------------
function _optIsIndoor(option) {
    const fo = option && option.fieldObj;
    return !!(fo && (fo.rainyDayAvailable === true || fo.isIndoor === true));
}

// exact mirror of _indoorRescuePass (window killswitch stubbed to "on")
function indoorRescuePass(assignments, availablePool, leagueRules) {
    const req = leagueRules && leagueRules.indoorRequirement;
    if (!req || !req.enabled) return assignments;
    const op = req.op || '>=';
    if (op === '<=') return assignments;
    const target = Number.isFinite(req.count) ? req.count : 1;
    const counts = leagueRules.indoorCounts || {};
    const optByField = {};
    availablePool.forEach(o => { if (!optByField[o.field]) optByField[o.field] = o; });
    const isIndoorField = f => _optIsIndoor(optByField[f]);
    const used = new Set(assignments.map(a => a && a.field));
    assignments.forEach(a => {
        if (!a || !a.field || isIndoorField(a.field)) return;
        if (Math.min(counts[a.team1] || 0, counts[a.team2] || 0) >= target) return;
        const free = availablePool.find(o => o.sport === a.sport && !used.has(o.field) && _optIsIndoor(o));
        if (free) { used.delete(a.field); used.add(free.field); a.field = free.field; return; }
        const donor = assignments.find(b => b && b !== a && b.sport === a.sport && b.field && isIndoorField(b.field)
            && Math.min(counts[b.team1] || 0, counts[b.team2] || 0) >= target);
        if (donor) { const f = a.field; a.field = donor.field; donor.field = f; }
    });
    return assignments;
}

// exact mirror of the cross-league reservation predicate
function reserveIndoorForLater(availablePool, league, applicableLeagues, indoorCountsByLeague) {
    const _iNeed = l => {
        const r = l && l.indoorRequirement;
        if (!r || !r.enabled || (r.op || '>=') === '<=') return 0;
        const tgt = Number.isFinite(r.count) ? r.count : 1;
        const ic = indoorCountsByLeague[l.name] || {};
        return Math.ceil((l.teams || []).filter(t => (ic[t] || 0) < tgt).length / 2);
    };
    if (_iNeed(league) !== 0) return availablePool;   // needy league keeps its gyms
    const _later = applicableLeagues.slice(applicableLeagues.indexOf(league) + 1).filter(l => _iNeed(l) > 0);
    if (!_later.length) return availablePool;
    const _laterSports = new Set(); _later.forEach(l => (l.sports || []).forEach(s => _laterSports.add(s)));
    const _demand = _later.reduce((n, l) => n + _iNeed(l), 0);
    const _indoorFields = [...new Set(availablePool.filter(o => _optIsIndoor(o) && _laterSports.has(o.sport)).map(o => o.field))];
    const _myMatchups = Math.max(1, Math.floor((league.teams || []).length / 2));
    const _allFieldCount = new Set(availablePool.map(o => o.field)).size;
    const _maxDrop = Math.max(0, _allFieldCount - _myMatchups);
    const _drop = new Set(_indoorFields.slice(0, Math.min(_demand, _maxDrop)));
    return availablePool.filter(o => !_drop.has(o.field));
}

// --- fixtures ----------------------------------------------------------------
const GYM1 = { field: 'New Gym', sport: 'Basketball', fieldObj: { rainyDayAvailable: true } };
const GYM2 = { field: 'Old Gym', sport: 'Basketball', fieldObj: { rainyDayAvailable: true } };
const OUT1 = { field: 'Court A', sport: 'Basketball', fieldObj: {} };
const OUT2 = { field: 'Court B', sport: 'Basketball', fieldObj: {} };
const FBALL = { field: 'Turf', sport: 'Football', fieldObj: {} };
const POOL = [GYM1, GYM2, OUT1, OUT2, FBALL];
const REQ1 = { enabled: true, op: '>=', count: 1 };

// =============================================================================
// TEST 1 — rescue (a): below-floor matchup outdoors + FREE same-sport gym → moved
// =============================================================================
{
    const asg = [
        { team1: 'T1', team2: 'T2', field: 'Court A', sport: 'Basketball' },   // below floor, outdoors
        { team1: 'T3', team2: 'T4', field: 'New Gym', sport: 'Basketball' },   // indoors
    ];
    indoorRescuePass(asg, POOL, { indoorRequirement: REQ1, indoorCounts: {} });
    assert.strictEqual(asg[0].field, 'Old Gym', 'below-floor matchup relocated to the free gym');
    assert.strictEqual(asg[1].field, 'New Gym', 'other matchup untouched');
}
console.log('TEST 1 PASS — free-court rescue moves a below-floor matchup indoors (same sport)');

// =============================================================================
// TEST 2 — rescue (b): no free gym → court TRADE with a met-floor matchup
// =============================================================================
{
    const asg = [
        { team1: 'T1', team2: 'T2', field: 'New Gym', sport: 'Basketball' },   // T1/T2 met floor already
        { team1: 'T3', team2: 'T4', field: 'Old Gym', sport: 'Basketball' },   // T3/T4 met floor already
        { team1: 'T5', team2: 'T6', field: 'Court A', sport: 'Basketball' },   // below floor, outdoors
    ];
    indoorRescuePass(asg, POOL, { indoorRequirement: REQ1, indoorCounts: { T1: 1, T2: 1, T3: 1, T4: 2 } });
    assert.ok(asg[2].field === 'New Gym' || asg[2].field === 'Old Gym', 'below-floor matchup traded indoors');
    const fields = asg.map(a => a.field).sort();
    assert.deepStrictEqual(fields, ['Court A', 'New Gym', 'Old Gym'], 'trade swapped courts, no double-book');
}
console.log('TEST 2 PASS — court trade lifts a below-floor matchup using a met-floor matchup\'s gym');

// =============================================================================
// TEST 3 — no over-rescue: met-floor teams stay put; '<=' ceiling never rescues
// =============================================================================
{
    const asg = [{ team1: 'T1', team2: 'T2', field: 'Court A', sport: 'Basketball' }];
    indoorRescuePass(asg, POOL, { indoorRequirement: REQ1, indoorCounts: { T1: 1, T2: 1 } });
    assert.strictEqual(asg[0].field, 'Court A', 'met-floor matchup NOT moved');
    const asg2 = [{ team1: 'T1', team2: 'T2', field: 'Court A', sport: 'Basketball' }];
    indoorRescuePass(asg2, POOL, { indoorRequirement: { enabled: true, op: '<=', count: 1 }, indoorCounts: {} });
    assert.strictEqual(asg2[0].field, 'Court A', "'<=' ceiling rule never forces indoor");
    // different sport never hijacks a gym (Football matchup, gyms are Basketball)
    const asg3 = [{ team1: 'T1', team2: 'T2', field: 'Turf', sport: 'Football' }];
    indoorRescuePass(asg3, POOL, { indoorRequirement: REQ1, indoorCounts: {} });
    assert.strictEqual(asg3[0].field, 'Turf', 'same-sport-only: no cross-sport moves');
}
console.log('TEST 3 PASS — rescue is floor-only, met-floor-safe, and same-sport-only');

// =============================================================================
// TEST 4 — cross-league reservation: senior (no rule) yields gyms to junior (rule)
// =============================================================================
{
    const senior = { name: 'Major', teams: ['A', 'B', 'C', 'D'], sports: ['Basketball', 'Football'] };
    const junior = { name: 'Week1', teams: ['T1', 'T2', 'T3', 'T4'], sports: ['Basketball'], indoorRequirement: REQ1 };
    const order = [senior, junior];
    // day start: junior's 4 teams all below floor → demand ceil(4/2)=2 gyms withheld
    let pool = reserveIndoorForLater(POOL.slice(), senior, order, {});
    assert.ok(!pool.some(o => o.field === 'New Gym') && !pool.some(o => o.field === 'Old Gym'),
        'both gyms withheld from the senior league while the junior still owes indoor games');
    assert.ok(pool.some(o => o.field === 'Court A') && pool.some(o => o.field === 'Turf'), 'outdoor fields untouched');
    // once junior's teams met the floor → nothing withheld
    pool = reserveIndoorForLater(POOL.slice(), senior, order, { Week1: { T1: 1, T2: 1, T3: 1, T4: 1 } });
    assert.strictEqual(pool.length, POOL.length, 'no withholding once the floor is met');
    // the NEEDY league itself never loses its gyms
    pool = reserveIndoorForLater(POOL.slice(), junior, [junior, senior], {});
    assert.strictEqual(pool.length, POOL.length, 'a league with unmet indoor need keeps its full pool');
}
console.log('TEST 4 PASS — cross-league reservation guards gyms for the indoor-minimum league');

// =============================================================================
// TEST 5 — safety valve: never withhold below the league's own matchup count
// =============================================================================
{
    const senior = { name: 'Major', teams: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], sports: ['Basketball'] }; // 4 matchups
    const junior = { name: 'Week1', teams: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], sports: ['Basketball'], indoorRequirement: REQ1 };
    // pool of exactly 5 fields; senior needs 4 → at most 1 may be withheld (demand is 3)
    const pool = reserveIndoorForLater(POOL.slice(), senior, [senior, junior], {});
    const fieldsLeft = new Set(pool.map(o => o.field)).size;
    assert.ok(fieldsLeft >= 4, 'senior league keeps >= its own matchup count of fields (kept ' + fieldsLeft + ')');
}
console.log('TEST 5 PASS — safety valve never starves the yielding league below its own games');

// =============================================================================
// TEST 6 — end-of-day verification flags exactly the below-floor teams
// =============================================================================
{
    const l = { name: 'Week1', enabled: true, teams: ['T1', 'T2', 'T3', 'T4'], indoorRequirement: { enabled: true, op: '>=', count: 2 } };
    const ic = { T1: 2, T2: 1, T3: 0 };   // T4 absent → 0
    const tgt = l.indoorRequirement.count;
    const short = l.teams.filter(t => (ic[t] || 0) < tgt);
    assert.deepStrictEqual(short, ['T2', 'T3', 'T4'], 'verification catches every team below the floor');
}
console.log('TEST 6 PASS — end-of-day verification reports the exact shortfall');

console.log('\nALL 6 LEAGUE-INDOOR-MINIMUM TESTS PASS');
