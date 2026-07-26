'use strict';
// ★ TEAM RENAME — a renamed team keeps its identity.
//
// The bug this covers: a camp starts its league with placeholder names
// ("Team 1" … "Team 18"), then by game 2 the campers pick real ones ("The
// Pancakes", "The Waffles"). Team identity in this app IS the name string, so
// the only way to fix a name used to be delete + re-add — which stranded the
// standings, the entered scores, and the record that Team 1 had already played
// Team 2 at basketball. The engine then re-staged matchups it had already run
// and restarted every sport cycle.
//
// Drives the REAL modules: league_team_rename.js (identity/alias model) and the
// two engines' renameTeamInHistory + load-time alias fold. Both engines are
// browser IIFEs that assign window.* as a side effect, so stub the storage +
// settings surface, require them, then exercise the exported functions.

const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// in-memory cloud + localStorage + daily-schedule stubs
// ---------------------------------------------------------------------------
const cloud = {};
const savedDates = [];
let dailyData = {};

global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] != null ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
};
global.window = global.window || {};
global.window.loadGlobalSettings = () => ({
    leagueHistory: cloud.leagueHistory,
    specialtyLeagueHistory: cloud.specialtyLeagueHistory,
    leaguesByName: cloud.leaguesByName || {},
    specialtyLeagues: cloud.specialtyLeagues || {},
});
global.window.saveGlobalSettings = (k, v) => { cloud[k] = v; };
global.window.loadAllDailyData = () => dailyData;
global.window.invalidateDailyDataCache = () => {};
global.window.ScheduleDB = { saveSchedule: (date) => savedDates.push(date) };

const LTR = require('../league_team_rename.js');
global.window.LeagueTeamRename = LTR;
require('../scheduler_core_leagues.js');
require('../scheduler_core_specialty_leagues.js');

const Leagues = global.window.SchedulerCoreLeagues;
const Specialty = global.window.SchedulerCoreSpecialtyLeagues;

const mk = (a, b) => [a, b].sort().join('|');

function reset() {
    delete cloud.leagueHistory;
    delete cloud.specialtyLeagueHistory;
    cloud.leaguesByName = {};
    cloud.specialtyLeagues = {};
    global.localStorage._m = {};
    dailyData = {};
    savedDates.length = 0;
}

/** The camp's league as it exists mid-season: placeholder names, real record. */
function seedRegularLeague() {
    const LG = 'Majors';
    const league = {
        name: LG,
        teams: ['Team 1', 'Team 2', 'Team 3', 'Team 4'],
        sports: ['Basketball', 'Baseball', 'Hockey'],
        divisions: ['Seniors'],
        standings: {
            'Team 1': { w: 2, l: 0, t: 0, pf: 40, pa: 22, diff: 18 },
            'Team 2': { w: 0, l: 2, t: 0, pf: 22, pa: 40, diff: -18 },
            'Team 3': { w: 1, l: 1, t: 0 },
            'Team 4': { w: 1, l: 1, t: 0 },
        },
        games: [{
            date: '2026-07-01', gameLabel: 'Game 1', gameNumber: 1, importedFrom: 'auto',
            matches: [
                { teamA: 'Team 1', teamB: 'Team 2', scoreA: 21, scoreB: 11, sport: 'Basketball' },
                { teamA: 'Team 3', teamB: 'Team 4', scoreA: 5, scoreB: 5, sport: 'Baseball' },
            ],
        }],
        playoff: {
            enabled: true,
            rounds: [{ number: 1, matchups: [{ teamA: 'Team 1', teamB: 'Team 4', winner: 'Team 1', sport: 'Hockey' }], byes: ['Team 2'] }],
        },
        chinuch: { enabled: true, bunkFacilities: { 'Team 1': 'Beis Medrash', 'Team 2': 'Room 3' } },
    };
    cloud.leaguesByName = { [LG]: league };

    cloud.leagueHistory = {
        teamSports: {
            [`${LG}|Team 1`]: ['Basketball', 'Hockey'],
            [`${LG}|Team 2`]: ['Basketball'],
            [`${LG}|Team 4`]: ['Hockey'],
        },
        matchupHistory: {
            [`${LG}:${mk('Team 1', 'Team 2')}`]: 1,
            [`${LG}:${mk('Team 1', 'Team 4')}`]: 1,
        },
        gamesPerDate: { [LG]: { '2026-07-01': 1, '2026-07-02': 1 } },
        offCampusCounts: { [`${LG}|Team 1`]: 2, [`${LG}|Team 2`]: 1 },
        ocTripsByDate: { [LG]: { '2026-07-01': ['Team 1', 'Team 2'] } },
        chinuchByDate: { [LG]: { '2026-07-02': ['Team 1', 'Team 3'] } },
        gameLog: {
            [LG]: {
                '2026-07-01': [
                    { t1: 'Team 1', t2: 'Team 2', sport: 'Basketball', g: 'Game 1' },
                    { t1: 'Team 3', t2: 'Team 4', sport: 'Baseball', g: 'Game 1' },
                ],
                '2026-07-02': [{ t1: 'Team 1', t2: 'Team 4', sport: 'Hockey', g: 'Game 2' }],
            },
        },
        _tombstones: {},
        _savedAt: 1000,
    };
    return league;
}

/** Apply a rename the way LeaguesAPI.renameTeam does: config + alias, then the
 *  engine's history migration. (leagues.js itself is DOM-bound, so the test
 *  drives the same three steps directly.) */
function renameRegular(league, oldName, newName) {
    const v = LTR.validateRename(league, oldName, newName);
    if (!v.ok) return v;
    const config = LTR.applyToLeagueConfig(league, oldName, v.newName);
    LTR.recordAlias(league, oldName, v.newName);
    const history = Leagues.renameTeamInHistory(league.name, oldName, v.newName);
    const schedules = LTR.applyToDailySchedules(league.name, oldName, v.newName);
    return { ok: true, newName: v.newName, config, history, schedules };
}

// ===========================================================================
// 1. THE REPORTED SCENARIO
// ===========================================================================
test('rename — Team 1 → The Pancakes keeps the matchup + sport record', () => {
    reset();
    const league = seedRegularLeague();

    const res = renameRegular(league, 'Team 1', 'The Pancakes');
    assert.strictEqual(res.ok, true);

    // Roster rewritten IN PLACE (order preserved — the round-robin fallback
    // pairing is derived from roster order).
    assert.deepStrictEqual(league.teams, ['The Pancakes', 'Team 2', 'Team 3', 'Team 4']);

    const h = cloud.leagueHistory;
    // Who-played-who followed the rename: the program knows The Pancakes and
    // Team 2 have already met, and it is still ONE meeting (not two teams with
    // one each, and not a doubled count).
    assert.strictEqual(h.matchupHistory[`${'Majors'}:${mk('Team 1', 'Team 2')}`], undefined);
    assert.strictEqual(h.matchupHistory[`Majors:${mk('The Pancakes', 'Team 2')}`], 1);
    assert.strictEqual(h.matchupHistory[`Majors:${mk('The Pancakes', 'Team 4')}`], 1);

    // Sport history followed too, so the sport cycle doesn't restart.
    assert.strictEqual(h.teamSports['Majors|Team 1'], undefined);
    assert.deepStrictEqual(h.teamSports['Majors|The Pancakes'], ['Basketball', 'Hockey']);

    // gameLog — the date-keyed record every variety decision reads.
    assert.deepStrictEqual(
        h.gameLog['Majors']['2026-07-01'].map(e => [e.t1, e.t2]),
        [['The Pancakes', 'Team 2'], ['Team 3', 'Team 4']]);
    assert.deepStrictEqual(h.gameLog['Majors']['2026-07-02'][0].t1, 'The Pancakes');
});

test('rename — the matchup key re-sorts when the new name changes pair order', () => {
    reset();
    const league = seedRegularLeague();
    // "Zebras" sorts AFTER "Team 2", where "Team 1" sorted before it — so the
    // sorted pair key flips. A naive substring swap would leave an unsorted key
    // that getMatchupKey could never look up again.
    renameRegular(league, 'Team 1', 'Zebras');

    const h = cloud.leagueHistory;
    assert.strictEqual(h.matchupHistory['Majors:Team 2|Zebras'], 1);
    assert.strictEqual(h.matchupHistory['Majors:Zebras|Team 2'], undefined);
});

test('rename — standings, entered scores, playoff bracket and chinuch follow', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');

    // Standings row moved intact — the season does not restart.
    assert.strictEqual(league.standings['Team 1'], undefined);
    assert.deepStrictEqual(league.standings['The Pancakes'], { w: 2, l: 0, t: 0, pf: 40, pa: 22, diff: 18 });

    // Entered scores keep pointing at the right team.
    const m = league.games[0].matches[0];
    assert.strictEqual(m.teamA, 'The Pancakes');
    assert.strictEqual(m.scoreA, 21);

    // Playoff bracket: matchup slot, winner and byes.
    const r1 = league.playoff.rounds[0];
    assert.strictEqual(r1.matchups[0].teamA, 'The Pancakes');
    assert.strictEqual(r1.matchups[0].winner, 'The Pancakes');
    assert.deepStrictEqual(r1.byes, ['Team 2']);

    // Chinuch facility assignment is keyed by team.
    assert.strictEqual(league.chinuch.bunkFacilities['Team 1'], undefined);
    assert.strictEqual(league.chinuch.bunkFacilities['The Pancakes'], 'Beis Medrash');
});

test('rename — away-trip counters and per-date team lists follow', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');

    const h = cloud.leagueHistory;
    assert.strictEqual(h.offCampusCounts['Majors|Team 1'], undefined);
    assert.strictEqual(h.offCampusCounts['Majors|The Pancakes'], 2);
    assert.deepStrictEqual(h.ocTripsByDate['Majors']['2026-07-01'], ['The Pancakes', 'Team 2']);
    assert.deepStrictEqual(h.chinuchByDate['Majors']['2026-07-02'], ['The Pancakes', 'Team 3']);
});

// ===========================================================================
// 2. SAVED SCHEDULES
// ===========================================================================
test('rename — saved schedule matchup strings are rewritten, field/sport untouched', () => {
    reset();
    const league = seedRegularLeague();
    // A team called "Red" is the trap: a blind string replace would corrupt
    // "@ Red Field" and "(Red Ball)" too.
    league.teams.push('Red');
    dailyData = {
        '2026-07-01': {
            leagueAssignments: {
                Seniors: {
                    3: {
                        leagueName: 'Majors', gameLabel: 'Game 1', sport: 'Basketball',
                        matchups: [
                            'Red vs Team 2 @ Red Field (Red Ball)',
                            'Team 3 vs Team 4 @ Court B (Baseball)',
                            'Team 5 — Bye',
                        ],
                    },
                },
            },
            scheduleAssignments: {
                'Bunk A': {
                    3: {
                        _leagueName: 'Majors', _activity: 'League: Majors', _h2h: true,
                        _allMatchups: ['Red vs Team 2 @ Red Field (Red Ball)', 'Red — Chinuch (Room 3)'],
                    },
                },
            },
        },
    };

    const res = LTR.applyToDailySchedules('Majors', 'Red', 'The Pancakes');
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.dates, ['2026-07-01']);
    assert.deepStrictEqual(savedDates, ['2026-07-01']);   // pushed through the verified per-date path

    const la = dailyData['2026-07-01'].leagueAssignments.Seniors[3].matchups;
    assert.strictEqual(la[0], 'The Pancakes vs Team 2 @ Red Field (Red Ball)');  // field + sport intact
    assert.strictEqual(la[1], 'Team 3 vs Team 4 @ Court B (Baseball)');          // untouched
    assert.strictEqual(la[2], 'Team 5 — Bye');

    const sa = dailyData['2026-07-01'].scheduleAssignments['Bunk A'][3]._allMatchups;
    assert.strictEqual(sa[0], 'The Pancakes vs Team 2 @ Red Field (Red Ball)');
    assert.strictEqual(sa[1], 'The Pancakes — Chinuch (Room 3)');
});

test('rename — another league with a same-named team is not touched', () => {
    reset();
    dailyData = {
        '2026-07-01': {
            leagueAssignments: {
                Seniors: {
                    3: { leagueName: 'Majors', matchups: ['Team 1 vs Team 2 @ Court A (Basketball)'] },
                    4: { leagueName: 'Minors', matchups: ['Team 1 vs Team 2 @ Court B (Hockey)'] },
                },
            },
        },
    };
    LTR.applyToDailySchedules('Majors', 'Team 1', 'The Pancakes');
    const s = dailyData['2026-07-01'].leagueAssignments.Seniors;
    assert.strictEqual(s[3].matchups[0], 'The Pancakes vs Team 2 @ Court A (Basketball)');
    assert.strictEqual(s[4].matchups[0], 'Team 1 vs Team 2 @ Court B (Hockey)');
});

// ===========================================================================
// 3. THE ALIAS SAFETY NET
// ===========================================================================
test('alias fold — old-name games arriving after the rename land on the renamed team', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');

    // A second device that never received the rename pushes its lineage; the
    // LG-8 (league, date) merge unions it in, so day 3 comes back under the OLD
    // name. Without the alias fold the engine would see a phantom "Team 1" with
    // its own matchup + sport record and generate blind to half the season.
    const merged = JSON.parse(JSON.stringify(cloud.leagueHistory));
    merged.gameLog['Majors']['2026-07-03'] = [{ t1: 'Team 1', t2: 'Team 3', sport: 'Baseball', g: 'Game 3' }];
    merged.teamSports['Majors|Team 1'] = ['Baseball'];
    merged.matchupHistory[`Majors:${mk('Team 1', 'Team 3')}`] = 1;
    cloud.leagueHistory = merged;

    const h = Leagues.loadHistory();

    assert.strictEqual(h.gameLog['Majors']['2026-07-03'][0].t1, 'The Pancakes');
    // Merged into the existing array rather than living beside it.
    assert.strictEqual(h.teamSports['Majors|Team 1'], undefined);
    assert.deepStrictEqual(h.teamSports['Majors|The Pancakes'], ['Basketball', 'Hockey', 'Baseball']);
    assert.strictEqual(h.matchupHistory[`Majors:${mk('The Pancakes', 'Team 3')}`], 1);
});

test('alias fold — both spellings of a counter collapse into one sum', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');

    // A cold start on a fresh device: only the cloud row is present, so
    // loadLeagueHistory adopts it as-is (no cloud+local merge, and therefore no
    // rebuild-from-gameLog to paper over the aggregates). The row carries BOTH
    // spellings of the same pair — the migrated one plus entries a stale writer
    // added under the old name.
    const stale = JSON.parse(JSON.stringify(cloud.leagueHistory));
    stale.matchupHistory[`Majors:${mk('Team 1', 'Team 2')}`] = 2;
    stale.offCampusCounts['Majors|Team 1'] = 3;
    stale.teamSports['Majors|Team 1'] = ['Baseball'];
    cloud.leagueHistory = stale;
    global.localStorage._m = {};                      // no local backup → no merge path

    const h = Leagues.loadHistory();
    // Summed into the live name, not split across two phantom teams and not
    // silently dropped.
    assert.strictEqual(h.matchupHistory[`Majors:${mk('The Pancakes', 'Team 2')}`], 3);   // 1 + 2
    assert.strictEqual(h.matchupHistory[`Majors:${mk('Team 1', 'Team 2')}`], undefined);
    assert.strictEqual(h.offCampusCounts['Majors|The Pancakes'], 5);                     // 2 + 3
    assert.strictEqual(h.offCampusCounts['Majors|Team 1'], undefined);
    assert.deepStrictEqual(h.teamSports['Majors|The Pancakes'], ['Basketball', 'Hockey', 'Baseball']);
    assert.strictEqual(h.teamSports['Majors|Team 1'], undefined);
});

test('alias fold — re-creating a team with a retired name gives it a fresh record', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');

    // The camp adds a brand-new "Team 1" (a real 5th team). It is NOT the
    // Pancakes, so its games must not be folded into them.
    league.teams.push('Team 1');
    LTR.dropAliasFor(league, 'Team 1');
    assert.strictEqual(LTR.canonicalName(league, 'Team 1'), 'Team 1');

    const merged = JSON.parse(JSON.stringify(cloud.leagueHistory));
    merged.gameLog['Majors']['2026-07-04'] = [{ t1: 'Team 1', t2: 'Team 3', sport: 'Hockey', g: 'Game 4' }];
    cloud.leagueHistory = merged;

    const h = Leagues.loadHistory();
    assert.strictEqual(h.gameLog['Majors']['2026-07-04'][0].t1, 'Team 1');
});

test('canonicalName — rename chains collapse, and a live team is never an alias', () => {
    const league = { name: 'Majors', teams: ['Flapjacks', 'Team 2'] };
    LTR.recordAlias(league, 'Team 1', 'The Pancakes');
    LTR.recordAlias(league, 'The Pancakes', 'Flapjacks');

    // BOTH former names resolve directly — no chain to walk, no cycle risk.
    assert.strictEqual(LTR.canonicalName(league, 'Team 1'), 'Flapjacks');
    assert.strictEqual(LTR.canonicalName(league, 'The Pancakes'), 'Flapjacks');
    assert.strictEqual(LTR.canonicalName(league, 'Flapjacks'), 'Flapjacks');
    // Case/whitespace drift in a parsed schedule string still resolves.
    assert.strictEqual(LTR.canonicalName(league, '  team 1 '), 'Flapjacks');
    // Live team and placeholders are left alone.
    assert.strictEqual(LTR.canonicalName(league, 'Team 2'), 'Team 2');
    assert.strictEqual(LTR.canonicalName(league, 'BYE'), 'BYE');
    assert.strictEqual(LTR.canonicalName(league, 'TBD'), 'TBD');

    // An alias whose target was deleted is inert.
    const orphaned = { name: 'Majors', teams: ['Team 2'], teamAliases: { 'Team 1': 'Gone' } };
    assert.strictEqual(LTR.canonicalName(orphaned, 'Team 1'), 'Team 1');
    assert.strictEqual(LTR.resolverFor(orphaned), null);
});

// ===========================================================================
// 4. VALIDATION
// ===========================================================================
test('validateRename — rejects empty, duplicate and reserved names', () => {
    const league = { name: 'Majors', teams: ['Team 1', 'Team 2'] };

    assert.strictEqual(LTR.validateRename(league, 'Team 1', '   ').ok, false);
    assert.match(LTR.validateRename(league, 'Team 1', '').reason, /empty/i);

    // Duplicate — case-insensitive, because the names collide for every keyed store.
    assert.strictEqual(LTR.validateRename(league, 'Team 1', 'Team 2').ok, false);
    assert.match(LTR.validateRename(league, 'Team 1', 'team 2').reason, /already has a team/i);

    // BYE/TBD are matchup placeholders the scheduler filters on.
    assert.strictEqual(LTR.validateRename(league, 'Team 1', 'BYE').ok, false);
    assert.strictEqual(LTR.validateRename(league, 'Team 1', 'tbd').ok, false);

    // Not in this league.
    assert.strictEqual(LTR.validateRename(league, 'Team 9', 'Whatever').ok, false);

    // Unchanged is flagged, not an error.
    const same = LTR.validateRename(league, 'Team 1', 'Team 1');
    assert.strictEqual(same.ok, false);
    assert.strictEqual(same.unchanged, true);

    // A pure case/spacing fix on the SAME team is allowed.
    const fix = LTR.validateRename(league, 'Team 1', ' team 1 ');
    assert.strictEqual(fix.ok, true);
    assert.strictEqual(fix.newName, 'team 1');

    // Trims.
    assert.strictEqual(LTR.validateRename(league, 'Team 1', '  The Pancakes  ').newName, 'The Pancakes');
});

test('rename is idempotent — replaying it changes nothing more', () => {
    reset();
    const league = seedRegularLeague();
    renameRegular(league, 'Team 1', 'The Pancakes');
    const after1 = JSON.stringify(cloud.leagueHistory.matchupHistory);

    // A second device replays the same rename (or the user re-applies it).
    renameRegular(league, 'The Pancakes', 'The Pancakes');
    Leagues.loadHistory();
    assert.strictEqual(JSON.stringify(cloud.leagueHistory.matchupHistory), after1);
    assert.deepStrictEqual(league.teams, ['The Pancakes', 'Team 2', 'Team 3', 'Team 4']);
});

// ===========================================================================
// 5. SPECIALTY LEAGUES — same problem, different stores
// ===========================================================================
test('specialty rename — field rotation, slot debt, meeting dates and gameLog follow', () => {
    reset();
    const ID = 'sl_hockey_1';
    const league = {
        id: ID, name: 'Hockey League',
        teams: ['Team 1', 'Team 2', 'Team 3'],
        standings: { 'Team 1': { w: 3, l: 0, t: 0 }, 'Team 2': { w: 0, l: 3, t: 0 }, 'Team 3': { w: 1, l: 1, t: 0 } },
        games: [{
            date: '2026-07-01', gameLabel: 'Game 1', importedFrom: 'auto',
            matches: [{ teamA: 'Team 1', teamB: 'Team 2', scoreA: 4, scoreB: 1, winner: 'Team 1' }],
        }],
        conferences: { East: ['Team 1', 'Team 2'], West: ['Team 3'] },
    };
    cloud.specialtyLeagues = { [ID]: league };
    cloud.specialtyLeagueHistory = {
        teamFieldRotation: { [`${ID}|Team 1`]: ['Rink A', 'Rink B'], [`${ID}|Team 2`]: ['Rink A'] },
        lastSlotOrder: { [`${ID}|Team 1`]: 2 },
        slotDebt: { [`${ID}|Team 1`]: 3, [`${ID}|Team 2`]: 1 },
        matchupHistory: { [`${ID}|${mk('Team 1', 'Team 2')}`]: ['2026-07-01', '2026-07-03'] },
        gamesPerDate: { [ID]: { '2026-07-01': 1 } },
        gameLog: { [ID]: { '2026-07-01': [{ tA: 'Team 1', tB: 'Team 2', field: 'Rink A', g: 'Game 1', s: 2 }] } },
        _tombstones: {}, _savedAt: 1000,
    };

    LTR.applyToLeagueConfig(league, 'Team 1', 'The Pancakes');
    LTR.recordAlias(league, 'Team 1', 'The Pancakes');
    const res = Specialty.renameTeamInHistory(ID, 'Team 1', 'The Pancakes');
    assert.strictEqual(res.ok, true);

    const h = cloud.specialtyLeagueHistory;
    assert.deepStrictEqual(h.teamFieldRotation[`${ID}|The Pancakes`], ['Rink A', 'Rink B']);
    assert.strictEqual(h.teamFieldRotation[`${ID}|Team 1`], undefined);
    assert.strictEqual(h.lastSlotOrder[`${ID}|The Pancakes`], 2);
    assert.strictEqual(h.slotDebt[`${ID}|The Pancakes`], 3);
    assert.deepStrictEqual(h.matchupHistory[`${ID}|${mk('The Pancakes', 'Team 2')}`], ['2026-07-01', '2026-07-03']);
    assert.strictEqual(h.matchupHistory[`${ID}|${mk('Team 1', 'Team 2')}`], undefined);
    assert.strictEqual(h.gameLog[ID]['2026-07-01'][0].tA, 'The Pancakes');

    // Config: standings, entered result + winner, and the conference roster.
    assert.deepStrictEqual(league.teams, ['The Pancakes', 'Team 2', 'Team 3']);
    assert.deepStrictEqual(league.standings['The Pancakes'], { w: 3, l: 0, t: 0 });
    assert.strictEqual(league.games[0].matches[0].teamA, 'The Pancakes');
    assert.strictEqual(league.games[0].matches[0].winner, 'The Pancakes');
    assert.deepStrictEqual(league.conferences.East, ['The Pancakes', 'Team 2']);
});

test('specialty alias fold — stale old-name day folds in on load', () => {
    reset();
    const ID = 'sl_hockey_1';
    cloud.specialtyLeagues = {
        [ID]: { id: ID, name: 'Hockey League', teams: ['The Pancakes', 'Team 2'], standings: {}, games: [], teamAliases: { 'Team 1': 'The Pancakes' } },
    };
    cloud.specialtyLeagueHistory = {
        teamFieldRotation: { [`${ID}|The Pancakes`]: ['Rink A'], [`${ID}|Team 1`]: ['Rink C'] },
        lastSlotOrder: {}, slotDebt: { [`${ID}|Team 1`]: 2, [`${ID}|The Pancakes`]: 1 },
        matchupHistory: { [`${ID}|${mk('Team 1', 'Team 2')}`]: ['2026-07-05'] },
        gamesPerDate: {},
        gameLog: { [ID]: { '2026-07-05': [{ tA: 'Team 1', tB: 'Team 2', field: 'Rink C', g: 'Game 2', s: 1 }] } },
        _tombstones: {}, _savedAt: 1000,
    };

    const folded = Specialty.loadHistory();

    assert.deepStrictEqual(folded.teamFieldRotation[`${ID}|The Pancakes`], ['Rink A', 'Rink C']);
    assert.strictEqual(folded.teamFieldRotation[`${ID}|Team 1`], undefined);
    assert.strictEqual(folded.slotDebt[`${ID}|The Pancakes`], 3);   // 1 + 2, cumulative
    assert.deepStrictEqual(folded.matchupHistory[`${ID}|${mk('The Pancakes', 'Team 2')}`], ['2026-07-05']);
    assert.strictEqual(folded.gameLog[ID]['2026-07-05'][0].tA, 'The Pancakes');
});
