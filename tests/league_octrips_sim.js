// =============================================================================
// league_octrips_sim.js
// -----------------------------------------------------------------------------
// ★ LG-13 / LG-21: off-campus away-trip counts used to be a flat, date-less
// counter incremented on EVERY generation of an away day and never rolled back
// by any regen/delete path — trips inflated per regen and permanently skewed
// ocSelectGroups' fairness (trip*10000 dominates its score). Trips are now
// recorded per (league, date) in history.ocTripsByDate; this sim drives the
// REAL scheduler_core_leagues.js module and proves:
//   TEST 1 — resetDayRecords subtracts the date's trip charges exactly.
//   TEST 2 — cleanupDateFromHistory (date delete) subtracts trips too.
//   TEST 3 — mergeLeagueHistories rebuilds the flat counters from the merged
//            per-day trip records (divergent lineages can't double-charge),
//            adopts each lineage's unique days, and a pure-legacy league (flat
//            counts, no per-day record) keeps its counts.
//   TEST 4 — resetOffCampusHistory sticks across a merge with a stale copy
//            (_ocResetAt marker), per-league and all-league variants.
// =============================================================================

'use strict';
const assert = require('assert');

const cloudKV = {};
const settings = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};

function makeSupabaseStub() {
    return {
        from() {
            return {
                select() {
                    const q = { _k: null };
                    q.eq = function (col, v) { if (col === 'key') q._k = v; return q; };
                    q.maybeSingle = async function () {
                        return { data: cloudKV[q._k] !== undefined ? { value: cloudKV[q._k] } : null, error: null };
                    };
                    return q;
                },
                upsert: async function (row) { cloudKV[row.key] = row.value; return { error: null }; },
            };
        },
    };
}

global.window = {
    loadGlobalSettings: () => settings,
    saveGlobalSettings: (k, v) => { settings[k] = v; },
    supabase: makeSupabaseStub(),
    CampistryDB: { getCampId: () => 'camp-1' },
    __leagueHistoryPushRetryMs: 10,
    currentScheduleDate: null,
    divisionTimes: {},
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; },
    dispatchEvent: () => true,
    loadAllDailyData: () => ({}),
};
global.document = { readyState: 'complete', addEventListener: () => {} };

const origLog = console.log;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.mergeLeagueHistories === 'function', 'module loaded');

const LG = 'Away League';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function seedHistory(h) {
    settings.leagueHistory = JSON.parse(JSON.stringify(h));
    global.localStorage.setItem('campLeagueHistory_v2', JSON.stringify(h));
}
function currentHistory() {
    return Leagues.getHistorySnapshot();
}
function baseHistory(savedAt) {
    return {
        teamSports: {}, matchupHistory: {}, gamesPerDate: { [LG]: { '2026-07-01': 2 } },
        offCampusCounts: { [LG + '|A']: 1, [LG + '|B']: 1 },
        ocTripsByDate: { [LG]: { '2026-07-01': ['A', 'B'] } },
        gameLog: { [LG]: { '2026-07-01': [{ t1: 'A', t2: 'B', sport: 'Soccer', g: 'Game 1' }] } },
        _tombstones: {}, _savedAt: savedAt,
    };
}

(async function main() {

    // Config the reset paths read to find the league's divisions.
    settings.leaguesByName = { [LG]: { name: LG, divisions: ['Juniors'], teams: ['A', 'B', 'C', 'D'] } };

    // ---- TEST 1: resetDayRecords subtracts the date's trips ----
    {
        seedHistory(baseHistory(1000));
        Leagues.resetDayRecords(['Juniors'], '2026-07-01');
        const h = currentHistory();
        assert.strictEqual(h.offCampusCounts[LG + '|A'], undefined, 'A trip subtracted');
        assert.strictEqual(h.offCampusCounts[LG + '|B'], undefined, 'B trip subtracted');
        assert.ok(!(h.ocTripsByDate[LG] || {})['2026-07-01'], 'per-day trip record removed');
        console.log('✅ TEST 1 — resetDayRecords rolls back the date\'s away trips');
    }

    // ---- TEST 2: cleanupDateFromHistory subtracts trips ----
    {
        seedHistory(baseHistory(1000));
        Leagues.cleanupDateFromHistory('2026-07-01');
        const h = currentHistory();
        assert.strictEqual(h.offCampusCounts[LG + '|A'], undefined, 'A trip subtracted on date delete');
        assert.ok(!(h.ocTripsByDate[LG] || {})['2026-07-01'], 'per-day trip record removed on date delete');
        console.log('✅ TEST 2 — cleanupDateFromHistory rolls back the date\'s away trips');
    }

    // ---- TEST 3: merge rebuilds flat counters from per-day records ----
    {
        // Lineage A (fresher): days 1+2 — A,B traveled day 1; C,D day 2.
        const a = baseHistory(2000);
        a.ocTripsByDate[LG]['2026-07-02'] = ['C', 'D'];
        a.offCampusCounts = { [LG + '|A']: 1, [LG + '|B']: 1, [LG + '|C']: 1, [LG + '|D']: 1 };
        // Lineage B (older): same day 1 (conflicting copy, inflated counts from
        // the old regen bug) + a day 3 that A never saw.
        const b = baseHistory(1500);
        b.offCampusCounts = { [LG + '|A']: 3, [LG + '|B']: 3 };   // inflated legacy counts
        b.ocTripsByDate[LG]['2026-07-03'] = ['A', 'C'];
        // A legacy league with flat counts but NO per-day record survives.
        b.offCampusCounts['Legacy League|Z'] = 4;

        const m = Leagues.mergeLeagueHistories(a, b);
        assert.deepStrictEqual(m.ocTripsByDate[LG]['2026-07-01'], ['A', 'B'], 'fresher day-1 record wins');
        assert.deepStrictEqual(m.ocTripsByDate[LG]['2026-07-02'], ['C', 'D'], 'A-only day adopted');
        assert.deepStrictEqual(m.ocTripsByDate[LG]['2026-07-03'], ['A', 'C'], 'B-only day adopted');
        // Rebuilt counts: A = day1 + day3 = 2, B = 1, C = day2 + day3 = 2, D = 1.
        assert.strictEqual(m.offCampusCounts[LG + '|A'], 2, 'A count rebuilt (no inflation)');
        assert.strictEqual(m.offCampusCounts[LG + '|B'], 1, 'B count rebuilt');
        assert.strictEqual(m.offCampusCounts[LG + '|C'], 2, 'C count rebuilt');
        assert.strictEqual(m.offCampusCounts[LG + '|D'], 1, 'D count rebuilt');
        // Legacy league keeps the fresher copy's flat entries; b's legacy-league
        // count lives only in the OLDER copy so it is not in F — but a league
        // with no per-day record in EITHER copy keeps F's flat entries:
        const a2 = JSON.parse(JSON.stringify(a));
        a2.offCampusCounts['Legacy League|Z'] = 4;
        const m2 = Leagues.mergeLeagueHistories(a2, b);
        assert.strictEqual(m2.offCampusCounts['Legacy League|Z'], 4, 'pure-legacy league keeps flat counts');
        console.log('✅ TEST 3 — merge rebuilds trip counters from per-day records (union, no double-charge)');
    }

    // ---- TEST 4: resetOffCampusHistory sticks across merges ----
    {
        seedHistory(baseHistory(Date.now() - 60000));
        global.window.resetOffCampusHistory(LG);          // per-league reset
        await sleep(30);                                   // let the verified push settle
        const afterReset = currentHistory();
        assert.strictEqual(afterReset.offCampusCounts[LG + '|A'], undefined, 'reset cleared A');
        assert.ok(afterReset._ocResetAt && afterReset._ocResetAt[LG] > 0, 'reset marker stamped');

        // A STALE copy (saved before the reset) still carries the trips — the
        // merge must NOT resurrect them.
        const stale = baseHistory(Date.now() - 30000);
        const m = Leagues.mergeLeagueHistories(afterReset, stale);
        assert.strictEqual(m.offCampusCounts[LG + '|A'], undefined, 'stale copy cannot resurrect reset trips');
        assert.ok(!((m.ocTripsByDate[LG] || {})['2026-07-01']), 'stale per-day trip record blocked by reset marker');

        // A day recorded AFTER the reset (fresher copy) survives.
        const fresh = baseHistory(Date.now() + 60000);
        fresh.ocTripsByDate[LG] = { '2026-07-09': ['C', 'D'] };
        fresh.offCampusCounts = { [LG + '|C']: 1, [LG + '|D']: 1 };
        fresh._ocResetAt = afterReset._ocResetAt;
        const m2 = Leagues.mergeLeagueHistories(afterReset, fresh);
        assert.strictEqual(m2.offCampusCounts[LG + '|C'], 1, 'post-reset trips survive the merge');
        console.log('✅ TEST 4 — resetOffCampusHistory sticks across merges; post-reset trips survive');
    }

    console.log('\n🎉 league_octrips_sim: ALL TESTS PASSED');
    process.exit(0);
})().catch(e => { console.error('❌ FAILED:', e); process.exit(1); });
