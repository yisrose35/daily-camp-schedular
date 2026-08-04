// =============================================================================
// league_camp_report.js  —  NOT a pass/fail test. A MEASUREMENT.
// -----------------------------------------------------------------------------
// Baseline for the global-assignment rewrite. Runs the REAL engine over a camp
// shaped like the user's (6 leagues, 12 fields, 6 periods, chinuch on) and
// prints the numbers that actually matter, so the new assigner can be judged
// against them instead of against an opinion:
//
//   • SPORT SPREAD   per team — how lopsided is each team's day
//   • BACK-TO-BACK   a team playing the same sport in consecutive periods
//   • GAMES PER TEAM by league — is the shortfall landing on one grade
//   • BYES           by league
//
//   node tests/league_camp_report.js            current engine
//   node tests/league_camp_report.js --global   with the new assigner (when it lands)
//
// The camp: 36 teams over 6 leagues wanting ~17 simultaneous games against 12
// fields — 7 basketball courts, 2 hockey, 2 football, 1 turf. The basketball
// skew is the point: it is why the leftover is always a court.
// =============================================================================

'use strict';
const fs = require('fs');
const path = require('path');

const cloudKV = {};
const settings = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.window = {
    loadGlobalSettings: () => settings,
    saveGlobalSettings: (k, v) => { settings[k] = v; },
    supabase: { from() { return {
        select() { const q = { _k: null };
            q.eq = function (c, v) { if (c === 'key') q._k = v; return q; };
            q.maybeSingle = async function () { return { data: cloudKV[q._k] !== undefined ? { value: cloudKV[q._k] } : null, error: null }; };
            return q; },
        upsert: async function (row) { cloudKV[row.key] = row.value; return { error: null }; },
    }; } },
    CampistryDB: { getCampId: () => 'camp-1' },
    __leagueHistoryPushRetryMs: 10,
    currentScheduleDate: null,
    divisionTimes: {},
    addEventListener: () => {},
    CustomEvent: function CustomEvent(t, o) { this.type = t; this.detail = (o || {}).detail; },
    dispatchEvent: () => true,
    loadAllDailyData: () => ({}),
    getFieldsInZone: () => [],
};
global.document = { readyState: 'complete', addEventListener: () => {} };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8'));

const origLog = console.log, origWarn = console.warn;
console.log = () => {};
require('../scheduler_core_leagues.js');
console.log = origLog;
const Leagues = global.window.SchedulerCoreLeagues;

// ---------------------------------------------------------------------------
// The camp, shaped like the real one.
// ---------------------------------------------------------------------------
const BALL = ['Basketball', 'Football', 'Hockey', 'Newcomb'];
const SENIOR_SPORTS = ['Basketball', 'Football', 'Hockey', 'Volleyball'];
const LEAGUES = [
    { name: '8th Grade', div: '8th', teams: 5,  sports: SENIOR_SPORTS },
    { name: '7th Grade', div: '7th', teams: 4,  sports: SENIOR_SPORTS },
    { name: '6th Grade', div: '6th', teams: 7,  sports: BALL },
    { name: '5th Grade', div: '5th', teams: 10, sports: BALL },
    { name: '4th Grade', div: '4th', teams: 6,  sports: BALL },
    { name: '3rd Grade', div: '3rd', teams: 3,  sports: BALL },
];
const AGE_ORDER = ['8th', '7th', '6th', '5th', '4th', '3rd'];
let _n = 0;
LEAGUES.forEach(l => { l.roster = []; for (let i = 0; i < l.teams; i++) l.roster.push('T' + (++_n)); });

// 12 fields — the basketball skew is deliberate.
const FIELDS = [
    'Lower bball (1)', 'Lower bball (2)', 'Upper(bball)', 'New Gym bball(1)',
    'New Gym Bball(2)', 'Red and Black bball (1)', 'Red and Black bball (2)',
].map(n => ({ name: n, activities: ['Basketball'] }))
    .concat([
        { name: 'Old Gym Hockey', activities: ['Hockey'] },
        { name: 'Hockey(Rink)', activities: ['Hockey'] },
        { name: 'Football (field 1)', activities: ['Football'] },
        { name: 'Football (field 2)', activities: ['Football'] },
        { name: 'Small Turf', activities: ['Newcomb', 'Volleyball'] },
    ]);

// ★ PULLED LIVE from the camp (2026-08-04). Four periods run all six grades —
// that is where 17 wanted games meet 12 fields. Three are already staggered to
// four grades, and those are the periods where the juniors actually get a
// scarce sport.
const PERIOD_DIVS = [
    ['8th','7th','6th','5th','4th','3rd'],   //  9:45
    ['8th','7th','6th','5th','4th','3rd'],   // 10:35
    ['8th','7th','6th','5th'],               // 11:25
    ['8th','7th','4th','3rd'],               // 12:10
    ['6th','5th','4th','3rd'],               //  1:00
    ['8th','7th','6th','5th','4th','3rd'],   //  2:00
    ['8th','7th','6th','5th','4th','3rd'],   //  2:55
];
const PERIODS = PERIOD_DIVS.length;
const SLOT_MIN = [585, 635, 685, 730, 780, 840, 895];
const SLOT_START = i => SLOT_MIN[i];
const DAYS = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'];

function blocksFor(l) {
    const out = [];
    for (let i = 0; i < PERIODS; i++) {
        if (PERIOD_DIVS[i].indexOf(l.div) < 0) continue;   // this grade is off this period
        out.push({
            type: 'league', event: 'League Time', divName: l.div, leagueName: l.name,
            startTime: SLOT_START(i), endTime: SLOT_START(i) + 45, slots: [i],
        });
    }
    return out;
}
function makeContext() {
    const blocks = [];
    LEAGUES.forEach(l => blocks.push(...blocksFor(l)));
    const masterLeagues = {};
    LEAGUES.forEach(l => {
        masterLeagues[l.name] = {
            name: l.name, enabled: true, divisions: [l.div], teams: l.roster.slice(),
            sports: l.sports.slice(), schedulingPriority: 'sport_variety',
            chinuch: { enabled: true },
            sportDailyLimits: l.sports.indexOf('Volleyball') >= 0 ? { Volleyball: 1 } : { Newcomb: 1 },
        };
    });
    const divisions = {};
    LEAGUES.forEach(l => { divisions[l.div] = { bunks: [l.div + 'B1'] }; });
    return {
        schedulableSlotBlocks: blocks, masterLeagues, disabledLeagues: [], divisions,
        fillBlock: function (b, pick) { b._filled = true; b._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS, disabledFields: [],
    };
}
function gen(date) {
    global.window.currentScheduleDate = date;
    global.window._activeGenDate = date;
    const dt = {};
    LEAGUES.forEach(l => {
        dt[l.div] = [];
        for (let i = 0; i < PERIODS; i++) dt[l.div].push({ startMin: SLOT_START(i), endMin: SLOT_START(i) + 45 });
    });
    global.window.divisionTimes = dt;
    global.window.getDivisionAgeOrder = names => AGE_ORDER.filter(d => (names || []).indexOf(d) >= 0);
    global.window.GlobalFieldLocks.reset();
    const ctx = makeContext();
    console.log = () => {}; console.warn = () => {};
    try { Leagues.processRegularLeagues(ctx); }
    finally { console.log = origLog; console.warn = origWarn; }
    return ctx;
}

// team → [sport|null per period], read off the tiles the engine wrote.
function readDay(ctx) {
    const byTeam = {}, byes = {};
    LEAGUES.forEach(l => { byes[l.name] = 0; l.roster.forEach(t => { byTeam[t] = new Array(PERIODS).fill(null); }); });
    ctx.schedulableSlotBlocks.forEach(b => {
        const p = b._pick; if (!p) return;
        const period = b.slots[0];
        (p._allMatchups || []).forEach(line => {
            if (/—\s*Bye/i.test(line)) {
                const lg = LEAGUES.find(l => l.name === b.leagueName);
                if (lg) byes[lg.name]++;
                return;
            }
            const m = line.match(/^(.+?) vs (.+?) @ .*\((\w+)\)/);
            if (m) { [m[1], m[2]].forEach(t => { if (byTeam[t]) byTeam[t][period] = m[3]; }); return; }
            const g = line.match(/^round robin \((.+?)\) @ .*\((\w+)\)/);
            if (g) g[1].split(',').map(s => s.trim()).forEach(t => { if (byTeam[t]) byTeam[t][period] = g[2]; });
        });
    });
    return { byTeam, byes };
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
console.log('CAMP REPORT — ' + (process.argv.indexOf('--global') >= 0 ? 'GLOBAL ASSIGNER' : 'CURRENT ENGINE'));
console.log('36 teams / 6 leagues / 12 fields / ' + PERIODS + ' periods');
console.log('='.repeat(78));

if (process.argv.indexOf('--global') >= 0) global.window.__leagueGlobalAssign = true;

let last = null;
DAYS.forEach(d => { last = readDay(gen(d)); });   // earlier days build history

const rows = [];
let campB2B = 0, campGames = 0, campSlots = 0;
LEAGUES.forEach(l => {
    let games = 0, b2b = 0, slots = 0;
    const spread = [];
    l.roster.forEach(t => {
        const a = last.byTeam[t];
        const counts = {};
        a.forEach(s => { if (s) { counts[s] = (counts[s] || 0) + 1; games++; } });
        slots += PERIODS;
        for (let i = 1; i < a.length; i++) if (a[i] && a[i - 1] && a[i] === a[i - 1]) b2b++;
        const vals = Object.values(counts);
        const played = vals.reduce((x, y) => x + y, 0);
        // lopsidedness: share of a team's games spent on its single most-played sport
        spread.push(played ? Math.max.apply(null, vals) / played : 0);
    });
    campB2B += b2b; campGames += games; campSlots += slots;
    rows.push({
        league: l.name,
        teams: l.teams,
        gamesPerTeam: (games / l.teams).toFixed(2),
        topSportShare: (100 * spread.reduce((a, b) => a + b, 0) / spread.length).toFixed(0) + '%',
        backToBack: b2b,
        byes: last.byes[l.name],
    });
});

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('League', 12) + pad('Teams', 7) + pad('Games/team', 12)
    + pad('Top sport', 11) + pad('Back-to-back', 14) + 'Byes');
console.log('-'.repeat(78));
rows.forEach(r => console.log(pad(r.league, 12) + pad(r.teams, 7) + pad(r.gamesPerTeam, 12)
    + pad(r.topSportShare, 11) + pad(r.backToBack, 14) + r.byes));
console.log('-'.repeat(78));
console.log('CAMP: ' + campB2B + ' back-to-back, ' + (campGames / 36).toFixed(2) + ' games/team avg');
console.log('"Top sport" = share of a team\'s games spent on its single most-played sport.');
console.log('100% means that team played one sport all day. Lower is better.\n');
