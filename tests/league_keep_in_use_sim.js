// =============================================================================
// league_keep_in_use_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL SchedulerCoreLeagues.processRegularLeagues to prove the
// "Keep in use" facility rule (Facilities → the field → Keep In Use).
//
// The camp's New Gym hosts ONLY Basketball and must never sit idle. League
// sports are handed out by team NEED, so on a day when every team is starved of
// Football (and caught up on Basketball) both matchups take the football fields
// and the gym gets no game at all. With the facility flagged, ONE matchup must
// be forced onto Basketball @ New Gym — without dropping a game.
//
//   TEST 1 — CONTROL (flag OFF): both matchups go to Football, gym idle.
//            Proves the scenario really does starve the gym (non-vacuous).
//   TEST 2 — FLAG ON: exactly one matchup is moved onto Basketball @ New Gym,
//            still 2 games, no bye.
//   TEST 3 — ALREADY IN USE: the gym is the only Basketball court and a matchup
//            lands there naturally → nothing is forced, no game disturbed.
//   TEST 4 — NO LEAGUE CAN COVER IT: the league doesn't play Basketball at all →
//            the engine warns and leaves the games alone (the STEP 7.96 sweep is
//            the backstop for that case).
//   TEST 5 — KILLSWITCH: window.__leagueKeepInUse = false restores TEST 1.
// =============================================================================

'use strict';
const assert = require('assert');

// --- Browser shims so both IIFEs load + processRegularLeagues runs in Node ----
const cloud = {};
global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.document = {
    readyState: 'complete', addEventListener: () => {}, removeEventListener: () => {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {} } }),
    body: { appendChild() {} },
};
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};

// Fields config, shared by the league pool builder AND getKeepInUseFields.
let FIELDS = [];
global.loadGlobalSettings = () => ({ leagueHistory: cloud.leagueHistory, app1: { fields: FIELDS } });
global.saveGlobalSettings = (k, v) => { cloud[k] = v; };
global.currentScheduleDate = '2026-07-24';
global.divisionTimes = { 'Grade 7': [{ startMin: 600, endMin: 660 }] };
global.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = (opts || {}).detail; };
global.dispatchEvent = () => true;

require('../scheduler_core_utils.js');
require('../scheduler_core_leagues.js');
const Leagues = global.window.SchedulerCoreLeagues;
assert.ok(Leagues && typeof Leagues.processRegularLeagues === 'function', 'league module loaded');
assert.ok(typeof global.window.SchedulerCoreUtils.getKeepInUseFields === 'function', 'utils helper present');

// -----------------------------------------------------------------------------
// Scenario: 4 teams, one league period. Sports Basketball + Football.
//   New Gym          → Basketball only   (the keep-in-use facility)
//   Football Field 1 → Football
//   Football Field 2 → Football
// History: every team has played Basketball 3× and Football 0× → both matchups
// naturally want Football, and there are exactly 2 football fields for them.
// -----------------------------------------------------------------------------
const TEAMS = ['T1', 'T2', 'T3', 'T4'];

function makeFields(keepInUse, gymSports) {
    return [
        Object.assign(
            { name: 'New Gym', activities: gymSports || ['Basketball'], available: true },
            keepInUse ? { keepInUse: { enabled: true } } : {}
        ),
        { name: 'Football Field 1', activities: ['Football'], available: true },
        { name: 'Football Field 2', activities: ['Football'], available: true },
    ];
}

// Seed a game log so getTeamSportHistoryByDate sees 3 basketball games each and
// zero football — the "nobody is due for basketball" day the user described.
function seedHistory() {
    const gameLog = { 'Grade 7 League': {} };
    ['2026-07-21', '2026-07-22', '2026-07-23'].forEach((d, i) => {
        gameLog['Grade 7 League'][d] = [
            { t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game ' + (i * 2 + 1) },
            { t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game ' + (i * 2 + 2) },
        ];
    });
    cloud.leagueHistory = {
        gamesPerDate: { 'Grade 7 League': { '2026-07-21': 2, '2026-07-22': 2, '2026-07-23': 2 } },
        teamSports: {}, matchups: {}, gameLog: gameLog, _savedAt: Date.now(),
    };
}

function makeContext(leagueSports) {
    return {
        schedulableSlotBlocks: [{
            type: 'league', event: 'League Time', divName: 'Grade 7',
            leagueName: 'Grade 7 League', startTime: 600, endTime: 660, slots: [0],
        }],
        masterLeagues: {
            'Grade 7 League': {
                name: 'Grade 7 League', enabled: true, divisions: ['Grade 7'],
                teams: TEAMS.slice(), sports: leagueSports || ['Basketball', 'Football'],
                schedulingPriority: 'sport_variety',
            },
        },
        disabledLeagues: [],
        divisions: { 'Grade 7': { bunks: ['7A', '7B'], startTime: '10:00 AM', endTime: '11:00 AM' } },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {},
        activityProperties: {},
        rotationHistory: {},
        fields: FIELDS,
        disabledFields: [],
    };
}

const parseGames = (block) => ((block && block._pick && block._pick._allMatchups) || [])
    .map(l => /^(.+?) vs (.+?) @ (.+?) \((.+?)\)$/.exec(l))
    .filter(Boolean)
    .map(m => ({ teams: m[1] + ' vs ' + m[2], field: m[3], sport: m[4] }));

// Capture the engine's own [KeepInUse] narration so a test can tell a free
// same-sport REDIRECT apart from a FORCED sport change.
let LOG = [];
function captureLogs(fn) {
    LOG = [];
    const rl = console.log, rw = console.warn;
    console.log = (...a) => { LOG.push(a.join(' ')); };
    console.warn = (...a) => { LOG.push(a.join(' ')); };
    try { return fn(); } finally { console.log = rl; console.warn = rw; }
}
const kiuLines = () => LOG.filter(l => /\[KeepInUse\]/.test(l));
const didForce = () => kiuLines().some(l => /forced/.test(l));
const didRedirect = () => kiuLines().some(l => /same sport, nothing else changes/.test(l));

// Returns the games as [{teams, sport, field}] parsed from the block the engine wrote.
function run({ keepInUse = false, gymSports = null, leagueSports = null, fields = null } = {}) {
    FIELDS = fields || makeFields(keepInUse, gymSports);
    seedHistory();
    global.localStorage._m = {};
    const ctx = makeContext(leagueSports);
    captureLogs(() => Leagues.processRegularLeagues(ctx));
    return parseGames(ctx.schedulableSlotBlocks[0]);
}

const gymGames = (games) => games.filter(g => g.field === 'New Gym');

// =============================================================================
// TEST 1 — CONTROL: without the flag the gym really does sit idle
// =============================================================================
{
    const games = run({ keepInUse: false });
    assert.strictEqual(games.length, 2, 'TEST1: both matchups placed, got ' + JSON.stringify(games));
    assert.ok(games.every(g => g.sport === 'Football'),
        'TEST1: need-first sends both to Football, got ' + JSON.stringify(games));
    assert.strictEqual(gymGames(games).length, 0, 'TEST1: New Gym is idle (scenario is non-vacuous)');
    console.log('✅ TEST 1 — control: nobody got Basketball, New Gym idle');
}

// =============================================================================
// TEST 2 — FLAG ON: exactly one matchup forced onto Basketball @ New Gym
// =============================================================================
{
    const games = run({ keepInUse: true });
    assert.strictEqual(games.length, 2, 'TEST2: still 2 games — no game was dropped, got ' + JSON.stringify(games));
    const inGym = gymGames(games);
    assert.strictEqual(inGym.length, 1, 'TEST2: exactly one game in the New Gym, got ' + JSON.stringify(games));
    assert.strictEqual(inGym[0].sport, 'Basketball', 'TEST2: it is the sport the gym hosts');
    assert.strictEqual(games.filter(g => g.sport === 'Football').length, 1,
        'TEST2: the other matchup keeps its football field, got ' + JSON.stringify(games));
    const fields = new Set(games.map(g => g.field));
    assert.strictEqual(fields.size, 2, 'TEST2: no two games share a field, got ' + JSON.stringify(games));
    console.log('✅ TEST 2 — one matchup forced to Basketball @ New Gym, both games kept');
}

// =============================================================================
// TEST 3 — ALREADY IN USE: gym is the only basketball court and a game lands
//          there on its own → nothing forced, nothing disturbed
// =============================================================================
{
    // Only one football field now, so one matchup must take basketball anyway.
    FIELDS = null;
    const before = makeFields;
    void before;
    // Rebuild with a single football field by running a custom context.
    seedHistory();
    global.localStorage._m = {};
    FIELDS = [
        { name: 'New Gym', activities: ['Basketball'], available: true, keepInUse: { enabled: true } },
        { name: 'Football Field 1', activities: ['Football'], available: true },
    ];
    const ctx = makeContext(null);
    Leagues.processRegularLeagues(ctx);
    const games = ((ctx.schedulableSlotBlocks[0]._pick || {})._allMatchups || [])
        .map(l => /^(.+?) vs (.+?) @ (.+?) \((.+?)\)$/.exec(l)).filter(Boolean)
        .map(m => ({ teams: m[1] + ' vs ' + m[2], field: m[3], sport: m[4] }));
    assert.strictEqual(games.length, 2, 'TEST3: both matchups placed, got ' + JSON.stringify(games));
    assert.strictEqual(gymGames(games).length, 1, 'TEST3: exactly one game in the gym (natural, not doubled)');
    console.log('✅ TEST 3 — gym used naturally: no extra forcing, no double-book');
}

// =============================================================================
// TEST 4 — NO LEAGUE CAN COVER IT: league plays Football only. The engine must
//          not invent a game — it warns, and STEP 7.96 covers the gym instead.
// =============================================================================
{
    const games = run({ keepInUse: true, leagueSports: ['Football'] });
    assert.strictEqual(games.length, 2, 'TEST4: games are untouched, got ' + JSON.stringify(games));
    assert.ok(games.every(g => g.sport === 'Football'), 'TEST4: still all football');
    assert.ok(kiuLines().some(w => /New Gym/.test(w) && /no league at this period plays a sport it hosts/.test(w)),
        'TEST4: the engine says the gym could not be covered by a league: ' + JSON.stringify(kiuLines()));
    assert.ok(!didForce(), 'TEST4: and it did not invent a game');
    console.log('✅ TEST 4 — no league plays the gym\'s sport: warns, never fabricates a game');
}

// =============================================================================
// TEST 5 — KILLSWITCH
// =============================================================================
{
    global.window.__leagueKeepInUse = false;
    const games = run({ keepInUse: true });
    global.window.__leagueKeepInUse = undefined;
    assert.strictEqual(gymGames(games).length, 0, 'TEST5: killswitch restores the old behaviour');
    console.log('✅ TEST 5 — window.__leagueKeepInUse=false disables the rule');
}

// =============================================================================
// TEST 6 — REDIRECT: somebody is ALREADY playing Basketball → just give them
//          the gym. Same sport, different court, nothing forced.
// The league is starved of Basketball this time (history is all Football), and
// there are two basketball courts so the natural pick need not be the gym.
// =============================================================================
{
    const gameLogAllFootball = () => {
        cloud.leagueHistory = {
            gamesPerDate: { 'Grade 7 League': { '2026-07-22': 2, '2026-07-23': 2 } },
            teamSports: {}, matchups: {},
            gameLog: {
                'Grade 7 League': {
                    '2026-07-22': [{ t1: 'T1', t2: 'T2', sport: 'Football', g: 'Game 1' }, { t1: 'T3', t2: 'T4', sport: 'Football', g: 'Game 2' }],
                    '2026-07-23': [{ t1: 'T1', t2: 'T3', sport: 'Football', g: 'Game 3' }, { t1: 'T2', t2: 'T4', sport: 'Football', g: 'Game 4' }],
                }
            },
            _savedAt: Date.now(),
        };
    };
    FIELDS = [
        { name: 'New Gym', activities: ['Basketball'], available: true, keepInUse: { enabled: true } },
        { name: 'Outdoor Court', activities: ['Basketball'], available: true },
        { name: 'Football Field 1', activities: ['Football'], available: true },
    ];
    gameLogAllFootball();
    global.localStorage._m = {};
    const ctx = makeContext(null);
    captureLogs(() => Leagues.processRegularLeagues(ctx));
    const games = parseGames(ctx.schedulableSlotBlocks[0]);

    assert.strictEqual(games.length, 2, 'TEST6: both matchups placed, got ' + JSON.stringify(games));
    assert.strictEqual(gymGames(games).length, 1, 'TEST6: the gym is in use, got ' + JSON.stringify(games));
    assert.strictEqual(gymGames(games)[0].sport, 'Basketball', 'TEST6: with Basketball');
    assert.ok(!didForce(), 'TEST6: nothing was FORCED — the team was already playing Basketball: ' + JSON.stringify(kiuLines()));
    console.log('✅ TEST 6 — a team already on Basketball is simply handed the gym (no forcing)');
}

// =============================================================================
// TEST 7 — CROSS-LEAGUE: two leagues share the period. The senior league is
//          caught up on Basketball (plays Football); the junior league still
//          needs Basketball. The gym must go to the JUNIOR's real basketball
//          game — the senior must NOT be forced onto basketball just because it
//          happens to be processed first.
// =============================================================================
{
    FIELDS = [
        { name: 'New Gym', activities: ['Basketball'], available: true, keepInUse: { enabled: true } },
        { name: 'Outdoor Court', activities: ['Basketball'], available: true },
        { name: 'Football Field 1', activities: ['Football'], available: true },
        { name: 'Football Field 2', activities: ['Football'], available: true },
    ];
    // Senior: 3 basketball games, 0 football → starved of Football.
    // Junior: 3 football games,   0 basketball → starved of Basketball.
    const log = { Senior: {}, Junior: {} };
    ['2026-07-21', '2026-07-22', '2026-07-23'].forEach((d, i) => {
        log.Senior[d] = [{ t1: 'S1', t2: 'S2', sport: 'Basketball', g: 'Game ' + (i + 1) }];
        log.Junior[d] = [{ t1: 'J1', t2: 'J2', sport: 'Football', g: 'Game ' + (i + 1) }];
    });
    cloud.leagueHistory = {
        gamesPerDate: { Senior: { '2026-07-21': 1, '2026-07-22': 1, '2026-07-23': 1 }, Junior: { '2026-07-21': 1, '2026-07-22': 1, '2026-07-23': 1 } },
        teamSports: {}, matchups: {}, gameLog: log, _savedAt: Date.now(),
    };
    global.localStorage._m = {};

    const ctx = {
        schedulableSlotBlocks: [
            { type: 'league', event: 'League Time', divName: 'Grade 9', leagueName: 'Senior', startTime: 600, endTime: 660, slots: [0] },
            { type: 'league', event: 'League Time', divName: 'Grade 7', leagueName: 'Junior', startTime: 600, endTime: 660, slots: [0] },
        ],
        masterLeagues: {
            // Object order = processing order here (no getDivisionAgeOrder in Node),
            // so Senior runs first and Junior is the last-chance forcer.
            Senior: { name: 'Senior', enabled: true, divisions: ['Grade 9'], teams: ['S1', 'S2'], sports: ['Basketball', 'Football'], schedulingPriority: 'sport_variety' },
            Junior: { name: 'Junior', enabled: true, divisions: ['Grade 7'], teams: ['J1', 'J2'], sports: ['Basketball', 'Football'], schedulingPriority: 'sport_variety' },
        },
        disabledLeagues: [],
        divisions: {
            'Grade 9': { bunks: ['9A'], startTime: '10:00 AM', endTime: '11:00 AM' },
            'Grade 7': { bunks: ['7A'], startTime: '10:00 AM', endTime: '11:00 AM' },
        },
        fillBlock: function (block, pick) { block._filled = true; block._pick = pick; },
        fieldUsageBySlot: {}, activityProperties: {}, rotationHistory: {},
        fields: FIELDS, disabledFields: [],
    };
    global.divisionTimes = { 'Grade 9': [{ startMin: 600, endMin: 660 }], 'Grade 7': [{ startMin: 600, endMin: 660 }] };
    captureLogs(() => Leagues.processRegularLeagues(ctx));

    const senior = parseGames(ctx.schedulableSlotBlocks[0]);
    const junior = parseGames(ctx.schedulableSlotBlocks[1]);
    assert.strictEqual(senior.length, 1, 'TEST7: senior game placed, got ' + JSON.stringify(senior));
    assert.strictEqual(junior.length, 1, 'TEST7: junior game placed, got ' + JSON.stringify(junior));
    assert.strictEqual(senior[0].sport, 'Football', 'TEST7: the senior league keeps the sport it needed');
    assert.strictEqual(junior[0].sport, 'Basketball', 'TEST7: the junior league plays the basketball it needed');
    assert.strictEqual(junior[0].field, 'New Gym', 'TEST7: and its game is the one put in the gym, got ' + JSON.stringify(junior));
    assert.ok(!didForce(), 'TEST7: no sport was forced on anybody: ' + JSON.stringify(kiuLines()));
    console.log('✅ TEST 7 — cross-league: the gym goes to the league already playing Basketball, senior untouched');

    global.divisionTimes = { 'Grade 7': [{ startMin: 600, endMin: 660 }] };   // restore
}

console.log('\n🎉 league_keep_in_use_sim: all tests passed');
