/**
 * Tests for: eraseCurrentDailyData, eraseAllDailyData, eraseRotationHistory, startNewHalf
 *
 * Run with:  node --test tests/calendar_delete_reset.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT — simulate browser globals that calendar.js needs
// =====================================================================

// --- localStorage mock ---
let fakeStorage = {};
global.localStorage = {
    getItem(k) { return fakeStorage.hasOwnProperty(k) ? fakeStorage[k] : null; },
    setItem(k, v) { fakeStorage[k] = String(v); },
    removeItem(k) { delete fakeStorage[k]; },
    hasOwnProperty(k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k); }
};

function resetStorage(seed) {
    fakeStorage = seed ? JSON.parse(JSON.stringify(seed)) : {};
}

// --- DOM stubs ---
global.document = {
    readyState: 'complete',
    getElementById() { return null; },
    addEventListener() {},
    createElement(tag) { return { id: '', style: {}, appendChild() {} }; },
    body: { appendChild() {} }
};

// --- window = global in Node ---
global.window = global;

// --- confirm / alert / reload ---
let confirmResult = true;
let alertMessages = [];
let reloadCalled = false;

global.confirm = function(msg) { return confirmResult; };
global.alert = function(msg) { alertMessages.push(msg); };

// location.reload stub
global.location = { reload() { reloadCalled = true; } };

// --- CustomEvent stub ---
global.CustomEvent = class CustomEvent {
    constructor(type, opts) {
        this.type = type;
        this.detail = opts?.detail;
    }
};

let dispatchedEvents = [];
const origDispatchEvent = global.dispatchEvent;
global.dispatchEvent = function(evt) {
    if (evt.type === 'campistry-schedule-deleted') {
        dispatchedEvents.push(evt.detail);
    }
    return true;
};
global.addEventListener = function() {};
global.removeEventListener = function() {};

// --- console is already available in Node ---

// --- Supabase mock ---
let supabaseLog = [];
let supabaseMockData = {};
let supabaseKvData = {};   // ★ HR-70: camp_state_kv rows (key → value)

function makeSupabaseMock() {
    supabaseLog = [];
    supabaseKvData = {};
    return {
        from(table) {
            const chain = {
                _filters: {},
                _action: null,
                _updatePayload: null,
                _selectArg: null,
                select(arg) { chain._action = 'select'; chain._selectArg = arg; return chain; },
                delete() { chain._action = 'delete'; return chain; },
                update(payload) { chain._action = 'update'; chain._updatePayload = payload; return chain; },
                // ★ HR-70: verified KV push support (upsert + read-back)
                upsert(payload, opts) {
                    supabaseLog.push({ action: 'upsert', table, payload, opts });
                    if (table === 'camp_state_kv' && payload && payload.key) {
                        supabaseKvData[payload.key] = payload.value;
                    }
                    return Promise.resolve({ error: null });
                },
                maybeSingle() {
                    const key = chain._filters.key;
                    return Promise.resolve({
                        data: { value: Object.prototype.hasOwnProperty.call(supabaseKvData, key) ? supabaseKvData[key] : null },
                        error: null
                    });
                },
                eq(col, val) {
                    chain._filters[col] = val;
                    // select('*').eq('camp_id', ...) — return a chain-like thenable that
                    // also supports a second .eq('date_key', ...) filter
                    if (chain._action === 'select' && chain._selectArg === '*' && col === 'camp_id') {
                        const result = {
                            eq(col2, val2) {
                                chain._filters[col2] = val2;
                                supabaseLog.push({ action: 'select_all', table, filters: { ...chain._filters } });
                                if (col2 === 'date_key') {
                                    return Promise.resolve({ data: supabaseMockData[val2] || [], error: null });
                                }
                                const allRecords = [];
                                Object.entries(supabaseMockData).forEach(([dk, recs]) => {
                                    (Array.isArray(recs) ? recs : [recs]).forEach(r => allRecords.push(r));
                                });
                                return Promise.resolve({ data: allRecords, error: null });
                            },
                            then(resolve, reject) {
                                supabaseLog.push({ action: 'select_all', table, filters: { ...chain._filters } });
                                const allRecords = [];
                                Object.entries(supabaseMockData).forEach(([dk, recs]) => {
                                    (Array.isArray(recs) ? recs : [recs]).forEach(r => allRecords.push(r));
                                });
                                return Promise.resolve({ data: allRecords, error: null }).then(resolve, reject);
                            }
                        };
                        return result;
                    }
                    if (chain._action === 'select' && col === 'date_key') {
                        supabaseLog.push({ action: 'select', table, filters: { ...chain._filters } });
                        const key = chain._filters.date_key || '';
                        return Promise.resolve({ data: supabaseMockData[key] || [], error: null });
                    }
                    if (chain._action === 'delete') {
                        supabaseLog.push({ action: 'delete', table, filters: { ...chain._filters } });
                        if (chain._filters.id) { /* single record */ }
                        else if (chain._filters.date_key) { delete supabaseMockData[chain._filters.date_key]; }
                        else { supabaseMockData = {}; }
                        return Promise.resolve({ error: null });
                    }
                    if (chain._action === 'update') {
                        supabaseLog.push({ action: 'update', table, filters: { ...chain._filters }, payload: chain._updatePayload });
                        return Promise.resolve({ error: null });
                    }
                    return chain;
                }
            };
            return chain;
        }
    };
}

// --- Tracking arrays ---
let clearCloudKeysCalls = [];
let saveGlobalSettingsCalls = [];

// --- Pre-load stubs so calendar.js IIFE doesn't crash ---
global.currentScheduleDate = '2026-07-15';
global.scheduleAssignments = {};
global.leagueAssignments = {};
global.updateTable = function() {};
global.initScheduleSystem = function() {};
global.setTimeout = global.setTimeout; // already exists in Node

global.divisions = {
    'Junior Boys': { bunks: ['Bunk 1', 'Bunk 2'] },
    'Senior Boys': { bunks: ['Bunk 3', 'Bunk 4'] }
};

global.AccessControl = {
    getCurrentRole() { return 'owner'; },
    showPermissionDenied() {},
    getEditableDivisions() { return ['Junior Boys']; },
    canEditAnything() { return true; },
    verifyBeforeWrite() { return Promise.resolve(true); }
};

global.PermissionsDB = {
    hasFullAccess() { return true; },
    getEditableDivisions() { return ['Junior Boys']; }
};

global.clearCloudKeys = async function(keys) { clearCloudKeysCalls.push(keys.slice()); };
global.saveGlobalSettings = function(key, val) { saveGlobalSettingsCalls.push({ key, val }); };
global.forceSyncToCloud = async function() {};

global.supabase = makeSupabaseMock();
global.CampistryDB = {
    getClient() { return global.supabase; },
    getCampId() { return 'test-camp-123'; }
};
global.ScheduleDB = {
    deleteSchedule: async function() { return { success: true }; },
    loadSchedule: async function() { return { success: false }; }
};

// =====================================================================
// LOAD calendar.js — its IIFE runs, stubs absorb side effects
// =====================================================================
require('../calendar.js');

// =====================================================================
// HELPER: reset mocks per test
// =====================================================================
function setupMocks(role) {
    clearCloudKeysCalls = [];
    saveGlobalSettingsCalls = [];
    alertMessages = [];
    reloadCalled = false;
    dispatchedEvents = [];
    confirmResult = true;

    global.AccessControl = {
        getCurrentRole() { return role; },
        showPermissionDenied(action) { alertMessages.push('Permission denied: ' + action); },
        getEditableDivisions() { return ['Junior Boys']; },
        getGeneratableDivisions() { return ['Junior Boys']; },
        canEraseData() { return role === 'owner' || role === 'admin' || role === 'scheduler'; },
        canEraseAllCampData() { return role === 'owner'; },
        canSave() { return role !== 'viewer'; }
    };
    global.PermissionsDB = {
        hasFullAccess() { return role === 'owner' || role === 'admin' || role === 'scheduler'; }
    };
    global.CampistryDB = {
        getClient() { return global.supabase; },
        getCampId() { return 'test-camp-123'; }
    };
    global.clearCloudKeys = async function(keys) { clearCloudKeysCalls.push(keys.slice()); };
    global.saveGlobalSettings = function(key, val) { saveGlobalSettingsCalls.push({ key, val }); };
    global.forceSyncToCloud = async function() {};
    global.updateTable = function() {};
    global.initScheduleSystem = function() {};
}

// =====================================================================
// TESTS
// =====================================================================

describe('eraseCurrentDailyData', () => {

    it('owner: deletes today from cloud + localStorage, preserves other dates', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': {
                    scheduleAssignments: { 'Bunk 1': ['Basketball'], 'Bunk 3': ['Art'] },
                    leagueAssignments: { 'Bunk 1': ['League A'] }
                },
                '2026-07-16': {
                    scheduleAssignments: { 'Bunk 2': ['Swimming'] },
                    leagueAssignments: {}
                }
            })
        });

        supabaseMockData = {};
        global.supabase = makeSupabaseMock();
        global.ScheduleDB = {
            deleteSchedule: async function(dateKey) {
                supabaseLog.push({ action: 'ScheduleDB.deleteSchedule', dateKey });
                return { success: true };
            }
        };

        setupMocks('owner');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        // Cloud call
        const dbCall = supabaseLog.find(l => l.action === 'ScheduleDB.deleteSchedule');
        assert.ok(dbCall, 'ScheduleDB.deleteSchedule should be called');
        assert.equal(dbCall.dateKey, '2026-07-15');

        // localStorage
        const remaining = JSON.parse(fakeStorage['campDailyData_v1'] || '{}');
        assert.equal(remaining['2026-07-15'], undefined, 'Today removed from localStorage');
        assert.ok(remaining['2026-07-16'], 'Other dates preserved');

        // Globals
        assert.deepEqual(global.scheduleAssignments, {});
        assert.deepEqual(global.leagueAssignments, {});

        // Event
        assert.ok(dispatchedEvents.length >= 1, 'Delete event dispatched');
    });

    it('viewer: permission denied, data untouched', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] }, leagueAssignments: {} }
            })
        });
        supabaseLog = [];
        setupMocks('viewer');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        const data = JSON.parse(fakeStorage['campDailyData_v1']);
        assert.ok(data['2026-07-15'], 'Data should still exist');
        assert.equal(supabaseLog.length, 0, 'No Supabase calls');
    });

    it('owner cancels confirm: data preserved', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] }, leagueAssignments: {} }
            })
        });
        supabaseLog = [];
        setupMocks('owner');
        confirmResult = false;
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        const data = JSON.parse(fakeStorage['campDailyData_v1']);
        assert.ok(data['2026-07-15'], 'Data preserved after cancel');
        assert.equal(supabaseLog.length, 0, 'No Supabase calls');
    });

    // v3.13: Scheduler now has admin permissions — full delete like owner/admin
    it('scheduler: scoped delete — only assigned divisions bunks removed', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': {
                    scheduleAssignments: {
                        'Bunk 1': ['Basketball'],
                        'Bunk 2': ['Art'],
                        'Bunk 3': ['Swimming'],
                        'Bunk 4': ['Drama']
                    },
                    leagueAssignments: { 'Bunk 1': ['League A'], 'Bunk 3': ['League B'] }
                },
                '2026-07-16': {
                    scheduleAssignments: { 'Bunk 2': ['Swimming'] },
                    leagueAssignments: {}
                }
            })
        });

        supabaseLog = [];
        supabaseMockData = {
            '2026-07-15': [{ id: 'rec1', schedule_data: {
                scheduleAssignments: { 'Bunk 1': ['Basketball'], 'Bunk 2': ['Art'], 'Bunk 3': ['Swimming'], 'Bunk 4': ['Drama'] },
                leagueAssignments: { 'Bunk 1': ['League A'], 'Bunk 3': ['League B'] }
            }}]
        };
        global.supabase = makeSupabaseMock();

        setupMocks('scheduler');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        // Cloud: should update (not full delete) since Senior Boys bunks remain
        const updateCall = supabaseLog.find(l => l.action === 'update');
        assert.ok(updateCall, 'Cloud record updated (not deleted) since other bunks remain');

        // localStorage — Junior Boys bunks removed, Senior Boys preserved
        const remaining = JSON.parse(fakeStorage['campDailyData_v1'] || '{}');
        assert.ok(remaining['2026-07-15'], 'Date still exists (other bunks remain)');
        assert.equal(remaining['2026-07-15'].scheduleAssignments['Bunk 1'], undefined, 'Bunk 1 removed');
        assert.equal(remaining['2026-07-15'].scheduleAssignments['Bunk 2'], undefined, 'Bunk 2 removed');
        assert.deepEqual(remaining['2026-07-15'].scheduleAssignments['Bunk 3'], ['Swimming'], 'Bunk 3 preserved');
        assert.deepEqual(remaining['2026-07-15'].scheduleAssignments['Bunk 4'], ['Drama'], 'Bunk 4 preserved');
        assert.ok(remaining['2026-07-16'], 'Other dates preserved');
    });
});

describe('eraseAllDailyData', () => {

    it('owner: deletes all dates from cloud + localStorage', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] }, leagueAssignments: {} },
                '2026-07-16': { scheduleAssignments: { 'Bunk 2': ['Music'] }, leagueAssignments: {} },
                '2026-07-17': { scheduleAssignments: { 'Bunk 3': ['Drama'] }, leagueAssignments: {} }
            })
        });
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        setupMocks('owner');
        reloadCalled = false;

        await global.eraseAllDailyData();

        assert.equal(fakeStorage.hasOwnProperty('campDailyData_v1'), false, 'All daily data removed');

        const deleteCall = supabaseLog.find(l => l.action === 'delete' && l.filters.camp_id && !l.filters.date_key);
        assert.ok(deleteCall, 'Supabase bulk delete called');

        const cloudClear = clearCloudKeysCalls.find(keys => keys.includes('daily_schedules'));
        assert.ok(cloudClear, 'clearCloudKeys called with daily_schedules');

        assert.deepEqual(global.scheduleAssignments, {});
        assert.deepEqual(global.leagueAssignments, {});
        assert.ok(reloadCalled, 'Page reload triggered');
    });

    it('scheduler: scoped erase — only assigned divisions removed across all dates', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': {
                    scheduleAssignments: { 'Bunk 1': ['Art'], 'Bunk 3': ['Music'] },
                    leagueAssignments: {}
                },
                '2026-07-16': {
                    scheduleAssignments: { 'Bunk 2': ['Swim'], 'Bunk 4': ['Drama'] },
                    leagueAssignments: {}
                }
            })
        });
        supabaseLog = [];
        supabaseMockData = {
            '2026-07-15': [{ id: 'rec1', schedule_data: {
                scheduleAssignments: { 'Bunk 1': ['Art'], 'Bunk 3': ['Music'] },
                leagueAssignments: {}
            }}],
            '2026-07-16': [{ id: 'rec2', schedule_data: {
                scheduleAssignments: { 'Bunk 2': ['Swim'], 'Bunk 4': ['Drama'] },
                leagueAssignments: {}
            }}]
        };
        global.supabase = makeSupabaseMock();
        setupMocks('scheduler');
        reloadCalled = false;

        await global.eraseAllDailyData();

        // localStorage should still exist but Junior Boys bunks removed
        const remaining = JSON.parse(fakeStorage['campDailyData_v1'] || '{}');
        assert.equal(remaining['2026-07-15']?.scheduleAssignments?.['Bunk 1'], undefined, 'Bunk 1 removed from 07-15');
        assert.deepEqual(remaining['2026-07-15']?.scheduleAssignments?.['Bunk 3'], ['Music'], 'Bunk 3 preserved on 07-15');
        assert.equal(remaining['2026-07-16']?.scheduleAssignments?.['Bunk 2'], undefined, 'Bunk 2 removed from 07-16');
        assert.deepEqual(remaining['2026-07-16']?.scheduleAssignments?.['Bunk 4'], ['Drama'], 'Bunk 4 preserved on 07-16');
        assert.ok(reloadCalled, 'Page reload triggered');
    });

    it('owner: clears gamesPerDate for regular + specialty leagues, resets leagueRoundState, dispatches event', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] }, leagueAssignments: {} }
            })
        });
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        dispatchedEvents = [];
        saveGlobalSettingsCalls = [];

        let regularClearAllCalled = false;
        let specialtyClearAllCalled = false;
        global.SchedulerCoreLeagues = {
            clearAllGamesPerDate() { regularClearAllCalled = true; }
        };
        global.SchedulerCoreSpecialtyLeagues = {
            clearAllGamesPerDate() { specialtyClearAllCalled = true; }
        };
        global.leagueRoundState = { 'Hoops': { currentRound: 12 } };

        setupMocks('owner');
        reloadCalled = false;

        await global.eraseAllDailyData();

        assert.ok(regularClearAllCalled, 'regular clearAllGamesPerDate called');
        assert.ok(specialtyClearAllCalled, 'specialty clearAllGamesPerDate called');
        assert.deepEqual(global.leagueRoundState, {}, 'leagueRoundState reset to {}');

        const roundSave = saveGlobalSettingsCalls.find(c => c.key === 'leagueRoundState');
        assert.ok(roundSave, 'leagueRoundState saved to cloud');
        assert.deepEqual(roundSave.val, {}, 'leagueRoundState cloud value is empty');

        const evt = dispatchedEvents.find(e => e.dateKey === '*');
        assert.ok(evt, 'campistry-schedule-deleted event dispatched with dateKey="*"');
    });

    it('owner: preserves rotation history and league matchup history', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({ '2026-07-15': { scheduleAssignments: {}, leagueAssignments: {} } }),
            'campRotationHistory_v1': JSON.stringify({ 'Bunk 1': { 'Art': 3 } }),
            'campLeagueHistory_v2': JSON.stringify({ teamSports: { 'Hoops|TeamA': ['Baseball'] }, matchupHistory: {}, gamesPerDate: {}, offCampusCounts: {} }),
            'campSpecialtyLeagueHistory_v1': JSON.stringify({ round: 2 })
        });
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        global.SchedulerCoreLeagues = { clearAllGamesPerDate() {} };

        setupMocks('owner');

        await global.eraseAllDailyData();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Rotation history preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'League matchup history preserved');
        assert.ok(fakeStorage.hasOwnProperty('campSpecialtyLeagueHistory_v1'), 'Specialty league history preserved');
    });
});

describe('eraseRotationHistory', () => {

    it('owner: clears rotation keys, preserves schedules + leagues', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ 'Bunk 1': { 'Basketball': 3 } }),
            'smartTileHistory_v1': JSON.stringify({ tile1: 'data' }),
            'smartTileSpecialHistory_v1': JSON.stringify({ special1: 'data' }),
            'campDailyData_v1': JSON.stringify({ '2026-07-15': { scheduleAssignments: {} } }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 })
        });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        reloadCalled = false;

        await global.eraseRotationHistory();

        // Removed
        assert.equal(fakeStorage.hasOwnProperty('campRotationHistory_v1'), false, 'Rotation history removed');
        assert.equal(fakeStorage.hasOwnProperty('smartTileHistory_v1'), false, 'Smart tile removed');
        assert.equal(fakeStorage.hasOwnProperty('smartTileSpecialHistory_v1'), false, 'Smart tile special removed');

        // Preserved
        assert.ok(fakeStorage.hasOwnProperty('campDailyData_v1'), 'Schedules preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'League history preserved');

        // Cloud keys
        const keys = clearCloudKeysCalls[0] || [];
        assert.ok(keys.includes('manualUsageOffsets'));
        assert.ok(keys.includes('historicalCounts'));
        assert.ok(keys.includes('historicalCountedDates'), 'historicalCountedDates must be cleared with historicalCounts');
        assert.ok(keys.includes('smartTileHistory'));
        assert.ok(keys.includes('rotationHistory'));

        // Should NOT touch league/schedule cloud keys
        const allKeys = clearCloudKeysCalls.flat();
        assert.ok(!allKeys.includes('leagueHistory'), 'leagueHistory NOT cleared');
        assert.ok(!allKeys.includes('daily_schedules'), 'daily_schedules NOT cleared');

        assert.ok(reloadCalled, 'Reload triggered');
    });

    it('viewer: permission denied', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true })
        });
        clearCloudKeysCalls = [];
        setupMocks('viewer');

        await global.eraseRotationHistory();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Data NOT cleared');
        assert.equal(clearCloudKeysCalls.length, 0);
    });
});

describe('startNewHalf (non-deleting epoch reset)', () => {

    // ★ HR: startNewHalf no longer deletes anything. It stamps a rotation
    // epoch (ISO dateKey), resets counter stores, and leaves schedules,
    // league history blobs, and rotation_counts intact.

    function setupEpochMocks() {
        global.RotationCloud = {
            clearAllCalls: 0,
            clearAll: async function() { this.clearAllCalls++; return true; },
            clearForBunks: async function() { return true; }
        };
        global.RotationEvents = {
            clearAllCompletedCalls: [],
            clearAllCompleted: function(dateKeys, bunkFilter) { this.clearAllCompletedCalls.push([dateKeys, bunkFilter]); }
        };
        global.RotationEngine = { clearAllHistory: function() {} };
        global.SchedulerCoreLeagues = {
            epochStamps: [],
            setHistoryEpoch: function(d) { this.epochStamps.push(d); return true; }
        };
        global.SchedulerCoreSpecialtyLeagues = {
            epochStamps: [],
            setHistoryEpoch: function(d) { this.epochStamps.push(d); return true; }
        };
        global.LeaguesAPI = {
            resetCalls: 0,
            resetStandingsAndPlayoffs: function() { this.resetCalls++; return 2; }
        };
        global.SpecialtyLeaguesAPI = {
            resetCalls: 0,
            resetStandingsAndPlayoffs: function() { this.resetCalls++; return 1; }
        };
        global.leagueRoundState = { League: { currentRound: 7 } };
        delete global.loadGlobalSettings;
        delete global.Utils;
    }

    function findSetting(key) {
        return saveGlobalSettingsCalls.filter(c => c.key === key).pop();
    }

    it('owner: stamps epoch, resets counters, DELETES NOTHING', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ bunks: { 'Bunk 1': { Art: 3 } }, leagues: {} }),
            'smartTileHistory_v1': JSON.stringify({ data: true }),
            'smartTileSpecialHistory_v1': JSON.stringify({ data: true }),
            'campLeagueHistory_v2': JSON.stringify({ gamesPerDate: { League: { '2026-06-30': 2 } } }),
            'campSpecialtyLeagueHistory_v1': JSON.stringify({ gameLog: {} }),
            'campDailyData_v1': JSON.stringify({
                '2026-07-01': { scheduleAssignments: { 'Bunk 1': ['Art'] } }
            })
        });
        supabaseMockData = {
            '2026-07-01': [{ id: 'rec1', schedule_data: { scheduleAssignments: { 'Bunk 1': ['Art'] } } }]
        };
        global.supabase = makeSupabaseMock();
        setupMocks('owner');
        setupEpochMocks();
        reloadCalled = false;

        await global.startNewHalf();

        // ── Nothing deleted ──
        assert.ok(fakeStorage.hasOwnProperty('campDailyData_v1'), 'daily schedules preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'league history blob preserved (carries the epoch stamp)');
        assert.ok(fakeStorage.hasOwnProperty('campSpecialtyLeagueHistory_v1'), 'specialty history blob preserved');
        const supabaseDelete = supabaseLog.find(e => e.action === 'delete' && e.table === 'daily_schedules');
        assert.equal(supabaseDelete, undefined, 'startNewHalf must NOT delete from daily_schedules');
        assert.equal(global.RotationCloud.clearAllCalls, 0, 'rotation_counts table must NOT be cleared (reads are epoch-filtered)');
        const daily = JSON.parse(fakeStorage['campDailyData_v1']);
        assert.deepEqual(daily['2026-07-01'].scheduleAssignments['Bunk 1'], ['Art'], 'old schedule content intact');

        // ── Epoch stamped ──
        const epochCall = findSetting('rotationEpoch');
        assert.ok(epochCall, 'rotationEpoch written to globalSettings');
        assert.match(epochCall.val.date, /^\d{4}-\d{2}-\d{2}$/, 'epoch is an ISO dateKey');
        const todayKey = new Date().toISOString().slice(0, 10);
        assert.ok(epochCall.val.date >= new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10),
            'epoch is not in the distant past');
        const app1Call = findSetting('app1');
        assert.ok(app1Call, 'app1 blob written');
        assert.equal(app1Call.val.halfStartDate, epochCall.val.date, 'halfStartDate hook set to the epoch');

        // ── League machinery invoked with the SAME epoch ──
        assert.deepEqual(global.SchedulerCoreLeagues.epochStamps, [epochCall.val.date], 'regular league blob stamped');
        assert.deepEqual(global.SchedulerCoreSpecialtyLeagues.epochStamps, [epochCall.val.date], 'specialty league blob stamped');
        assert.equal(global.LeaguesAPI.resetCalls, 1, 'regular standings/playoffs reset');
        assert.equal(global.SpecialtyLeaguesAPI.resetCalls, 1, 'specialty standings/playoffs reset');

        // ── Counter stores cleared (one-time clears; epoch-filtered rebuilders repopulate) ──
        const rot = findSetting('rotationHistory');
        assert.deepEqual(rot.val, { bunks: {}, leagues: {} }, 'rotationHistory reset to empty shape');
        ['historicalCounts', 'historicalCountedDates', 'historicalCountsByDate',
         'manualUsageOffsets', 'smartTileHistory', 'swimRotationHistory',
         'activityHistory', 'leagueRoundState'].forEach(k => {
            const c = findSetting(k);
            assert.ok(c, k + ' cleared via saveGlobalSettings');
            assert.deepEqual(c.val, {}, k + ' cleared to {}');
        });
        assert.equal(fakeStorage.hasOwnProperty('campRotationHistory_v1'), false, 'local rotation history removed');
        assert.equal(fakeStorage.hasOwnProperty('smartTileHistory_v1'), false);
        assert.equal(fakeStorage.hasOwnProperty('smartTileSpecialHistory_v1'), false);
        assert.deepEqual(global.leagueRoundState, {}, 'in-memory round state reset');
        assert.equal(global.RotationEvents.clearAllCompletedCalls.length, 1, 'rotation-event completions wiped');

        // ★ HR-70: the critical keys must land in camp_state_kv via the
        // VERIFIED direct push (the batch queue loses the reload race).
        assert.equal(supabaseKvData.rotationEpoch && supabaseKvData.rotationEpoch.date, epochCall.val.date,
            'rotationEpoch verified-pushed to camp_state_kv');
        ['rotationHistory', 'historicalCounts', 'historicalCountedDates', 'historicalCountsByDate',
         'manualUsageOffsets', 'smartTileHistory', 'swimRotationHistory', 'activityHistory',
         'leagueRoundState'].forEach(k => {
            assert.ok(Object.prototype.hasOwnProperty.call(supabaseKvData, k), k + ' verified-pushed to camp_state_kv');
        });
        const _backstop = JSON.parse(fakeStorage['campistry_rotationEpoch'] || 'null');
        assert.equal(_backstop && _backstop.date, epochCall.val.date, 'device-local epoch backstop written');
        assert.ok(_backstop && _backstop.setAt > 0, 'backstop carries the reset-action time (newest-wins resolution)');

        assert.ok(reloadCalled, 'Reload triggered');
    });

    // ★ HR-61 v2 helpers: local-timezone dateKeys (match _hrTodayKey)
    function localKey(offsetDays) {
        const d = new Date();
        d.setDate(d.getDate() + (offsetDays || 0));
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    it('epoch = TODAY when no schedule exists for today (first-morning reset)', async () => {
        resetStorage({});
        supabaseMockData = {};
        global.supabase = makeSupabaseMock();
        setupMocks('owner');
        setupEpochMocks();
        reloadCalled = false;

        await global.startNewHalf();

        const epochCall = findSetting('rotationEpoch');
        assert.equal(epochCall.val.date, localKey(0), 'new half starts today');
    });

    it("epoch = TOMORROW when today's schedule exists — today is pushed to the previous half (night-before reset)", async () => {
        resetStorage({});
        supabaseMockData = {
            [localKey(0)]: [{ id: 'r-today', schedule_data: { scheduleAssignments: { 'Bunk 1': [{ _activity: 'Art' }] } } }]
        };
        global.supabase = makeSupabaseMock();
        setupMocks('owner');
        setupEpochMocks();
        reloadCalled = false;

        await global.startNewHalf();

        const epochCall = findSetting('rotationEpoch');
        assert.equal(epochCall.val.date, localKey(1), "today's schedule stays in the old half; counting restarts tomorrow");
        // and today's schedule must not have been touched
        const del = supabaseLog.find(e => e.action === 'delete' && e.table === 'daily_schedules');
        assert.equal(del, undefined, 'no deletion of today');
    });

    it('user cancels: nothing written, nothing cleared', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'campDailyData_v1': JSON.stringify({ '2026-07-01': {} }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 })
        });
        setupMocks('owner');
        setupEpochMocks();
        confirmResult = false;
        reloadCalled = false;

        await global.startNewHalf();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Preserved');
        assert.ok(fakeStorage.hasOwnProperty('campDailyData_v1'), 'Preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'Preserved');
        assert.equal(findSetting('rotationEpoch'), undefined, 'no epoch written');
        assert.equal(reloadCalled, false);
    });

    it('admin: allowed — epoch stamped', async () => {
        resetStorage({});
        setupMocks('admin');
        setupEpochMocks();
        reloadCalled = false;

        await global.startNewHalf();

        const epochCall = findSetting('rotationEpoch');
        assert.ok(epochCall, 'admin can stamp the epoch');
        assert.ok(reloadCalled, 'reset ran to completion');
    });

    it('scheduler: permission denied (owner/admin-only feature)', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'campDailyData_v1': JSON.stringify({ '2026-07-01': {} })
        });
        setupMocks('scheduler');
        setupEpochMocks();
        reloadCalled = false;

        await global.startNewHalf();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Data NOT touched');
        assert.equal(findSetting('rotationEpoch'), undefined, 'no epoch written');
        assert.equal(global.SchedulerCoreLeagues.epochStamps.length, 0, 'no league stamp');
        assert.equal(reloadCalled, false, 'no reload');
        assert.ok(alertMessages.some(m => /Permission denied/i.test(m)), 'permission denied surfaced');
    });

    it('viewer: permission denied', async () => {
        resetStorage({ 'campRotationHistory_v1': JSON.stringify({ data: true }) });
        setupMocks('viewer');
        setupEpochMocks();

        await global.startNewHalf();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Data NOT touched');
        assert.equal(findSetting('rotationEpoch'), undefined, 'no epoch written');
    });

    it('failed league stamp surfaces a warning instead of a clean success alert', async () => {
        resetStorage({});
        setupMocks('owner');
        setupEpochMocks();
        global.SchedulerCoreLeagues.setHistoryEpoch = function() { return false; };
        reloadCalled = false;

        await global.startNewHalf();

        assert.ok(alertMessages.some(m => /warning/i.test(m)), 'warning alert shown on partial failure');
        assert.ok(reloadCalled, 'still reloads (epoch itself was written)');
    });
});

describe('Scope: New Half vs Reset History', () => {

    it('both preserve schedules + league blobs; only New Half stamps the epoch', async () => {
        const allKeys = {
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'smartTileHistory_v1': JSON.stringify({ data: true }),
            'smartTileSpecialHistory_v1': JSON.stringify({ data: true }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 }),
            'campSpecialtyLeagueHistory_v1': JSON.stringify({ sgame: 3 }),
            'campDailyData_v1': JSON.stringify({ '2026-07-01': {} })
        };

        // Run eraseRotationHistory
        resetStorage({ ...allKeys });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        global.RotationCloud = { clearAll: async function() { return true; }, clearForBunks: async function() { return true; } };
        global.RotationEvents = { clearAllCompleted: function() {} };
        await global.eraseRotationHistory();
        const afterReset = { ...fakeStorage };
        const resetEpoch = saveGlobalSettingsCalls.filter(c => c.key === 'rotationEpoch').pop();

        // Run startNewHalf
        resetStorage({ ...allKeys });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        global.RotationCloud = { clearAllCalls: 0, clearAll: async function() { this.clearAllCalls++; return true; } };
        global.RotationEvents = { clearAllCompletedCalls: [], clearAllCompleted: function() { this.clearAllCompletedCalls.push(1); } };
        global.RotationEngine = { clearAllHistory: function() {} };
        global.SchedulerCoreLeagues = { setHistoryEpoch: function() { return true; } };
        global.SchedulerCoreSpecialtyLeagues = { setHistoryEpoch: function() { return true; } };
        global.LeaguesAPI = { resetStandingsAndPlayoffs: function() { return 0; } };
        global.SpecialtyLeaguesAPI = { resetStandingsAndPlayoffs: function() { return 0; } };
        delete global.loadGlobalSettings;
        await global.startNewHalf();
        const afterNewHalf = { ...fakeStorage };
        const nhEpoch = saveGlobalSettingsCalls.filter(c => c.key === 'rotationEpoch').pop();

        // BOTH preserve schedules and league history blobs now
        ['campDailyData_v1', 'campLeagueHistory_v2', 'campSpecialtyLeagueHistory_v1'].forEach(k => {
            assert.ok(afterReset.hasOwnProperty(k), 'Reset History preserves ' + k);
            assert.ok(afterNewHalf.hasOwnProperty(k), 'New Half preserves ' + k);
        });

        // Only New Half stamps the counting epoch
        assert.equal(resetEpoch, undefined, 'Reset History does not write an epoch');
        assert.ok(nhEpoch, 'New Half writes the rotationEpoch');
    });
});

describe('gamesPerDate cleanup on day delete', () => {

    it('owner: cleanupDateFromHistory called for both regular and specialty leagues', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Hoops'] }, leagueAssignments: {} }
            })
        });

        let regularCleanup = null;
        let specialtyCleanup = null;
        global.SchedulerCoreLeagues = {
            cleanupDateFromHistory(dateKey) { regularCleanup = dateKey; }
        };
        global.SchedulerCoreSpecialtyLeagues = {
            cleanupDateFromHistory(dateKey) { specialtyCleanup = dateKey; }
        };

        global.supabase = makeSupabaseMock();
        global.ScheduleDB = {
            deleteSchedule: async function(dateKey) {
                supabaseLog.push({ action: 'ScheduleDB.deleteSchedule', dateKey });
                return { success: true };
            }
        };

        setupMocks('owner');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        assert.equal(regularCleanup, '2026-07-15', 'regular cleanupDateFromHistory called');
        assert.equal(specialtyCleanup, '2026-07-15', 'specialty cleanupDateFromHistory called');
    });

    it('scheduler: SCOPED resetDayRecords called (unscoped cleanup skipped — LG-5)', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': {
                    scheduleAssignments: { 'Bunk 1': ['Hoops'], 'Bunk 3': ['Soccer'] },
                    leagueAssignments: {}
                }
            })
        });

        supabaseLog = [];
        supabaseMockData = {
            '2026-07-15': [{ id: 'rec1', schedule_data: {
                scheduleAssignments: { 'Bunk 1': ['Hoops'], 'Bunk 3': ['Soccer'] },
                leagueAssignments: {}
            }}]
        };
        global.supabase = makeSupabaseMock();

        // ★ LG-5: a scheduler's day delete must NOT run the unscoped
        // cleanupDateFromHistory (it would roll back every OTHER scheduler's
        // leagues for the date). It must instead reconcile the scheduler's own
        // leagues via the division-scoped resetDayRecords.
        let regularCleanup = null;
        let specialtyCleanup = null;
        let regularScoped = null;
        let specialtyScoped = null;
        global.SchedulerCoreLeagues = {
            cleanupDateFromHistory(dateKey) { regularCleanup = dateKey; },
            resetDayRecords(divisions, dateKey) { regularScoped = { divisions, dateKey }; }
        };
        global.SchedulerCoreSpecialtyLeagues = {
            cleanupDateFromHistory(dateKey) { specialtyCleanup = dateKey; },
            resetDayRecords(divisions, dateKey) { specialtyScoped = { divisions, dateKey }; }
        };

        setupMocks('scheduler');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        assert.equal(regularCleanup, null, 'unscoped regular cleanup NOT called for scheduler');
        assert.equal(specialtyCleanup, null, 'unscoped specialty cleanup NOT called for scheduler');
        assert.ok(regularScoped, 'scoped regular resetDayRecords called');
        assert.equal(regularScoped.dateKey, '2026-07-15', 'scoped regular reset targets the date');
        assert.deepEqual(regularScoped.divisions, ['Junior Boys'], 'scoped regular reset limited to own divisions');
        assert.ok(specialtyScoped, 'scoped specialty resetDayRecords called');
        assert.equal(specialtyScoped.dateKey, '2026-07-15', 'scoped specialty reset targets the date');
        assert.deepEqual(specialtyScoped.divisions, ['Junior Boys'], 'scoped specialty reset limited to own divisions');
    });
});
