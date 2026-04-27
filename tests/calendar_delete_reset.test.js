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

function makeSupabaseMock() {
    supabaseLog = [];
    return {
        from(table) {
            const chain = {
                _filters: {},
                _action: null,
                _updatePayload: null,
                select() { chain._action = 'select'; return chain; },
                delete() { chain._action = 'delete'; return chain; },
                update(payload) { chain._action = 'update'; chain._updatePayload = payload; return chain; },
                eq(col, val) {
                    chain._filters[col] = val;
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
        canEraseData() { return role === 'owner' || role === 'admin'; },
        canEraseAllCampData() { return role === 'owner'; },
        canSave() { return role !== 'viewer'; }
    };
    global.PermissionsDB = {
        hasFullAccess() { return role === 'owner' || role === 'admin'; }
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

    it('scheduler: removes only own bunks, preserves others', async () => {
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
                }
            })
        });

        supabaseMockData = {
            '2026-07-15': [{
                id: 'record-1',
                camp_id: 'test-camp-123',
                date_key: '2026-07-15',
                scheduler_name: 'Owner',
                schedule_data: {
                    scheduleAssignments: { 'Bunk 1': ['Basketball'], 'Bunk 3': ['Swimming'] },
                    leagueAssignments: { 'Bunk 1': ['League A'], 'Bunk 3': ['League B'] }
                }
            }]
        };
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        global.ScheduleDB = {
            loadSchedule: async () => ({
                success: true,
                data: {
                    scheduleAssignments: { 'Bunk 3': ['Swimming'], 'Bunk 4': ['Drama'] },
                    leagueAssignments: { 'Bunk 3': ['League B'] }
                }
            })
        };

        setupMocks('scheduler');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        const data = JSON.parse(fakeStorage['campDailyData_v1'] || '{}');
        const sched = data['2026-07-15']?.scheduleAssignments || {};
        assert.equal(sched['Bunk 1'], undefined, 'Bunk 1 removed (scheduler owns it)');
        assert.equal(sched['Bunk 2'], undefined, 'Bunk 2 removed (scheduler owns it)');
        assert.ok(sched['Bunk 3'], 'Bunk 3 preserved (other scheduler)');
        assert.ok(sched['Bunk 4'], 'Bunk 4 preserved (other scheduler)');

        const selectCall = supabaseLog.find(l => l.action === 'select');
        assert.ok(selectCall, 'Supabase select called to load records');
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

    it('scheduler: permission denied', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] }, leagueAssignments: {} }
            })
        });
        supabaseLog = [];
        setupMocks('scheduler');

        await global.eraseAllDailyData();

        const data = JSON.parse(fakeStorage['campDailyData_v1']);
        assert.ok(data['2026-07-15'], 'Data NOT deleted');
        assert.equal(supabaseLog.length, 0);
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
            'specialtyLeagueHistory_v1': JSON.stringify({ round: 2 })
        });
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        global.SchedulerCoreLeagues = { clearAllGamesPerDate() {} };

        setupMocks('owner');

        await global.eraseAllDailyData();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Rotation history preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'League matchup history preserved');
        assert.ok(fakeStorage.hasOwnProperty('specialtyLeagueHistory_v1'), 'Specialty league history preserved');
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

describe('startNewHalf', () => {

    it('owner: clears ALL counters + schedules', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'smartTileHistory_v1': JSON.stringify({ data: true }),
            'smartTileSpecialHistory_v1': JSON.stringify({ data: true }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 }),
            'specialtyLeagueHistory_v1': JSON.stringify({ sgame: 3 }),
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': { scheduleAssignments: { 'Bunk 1': ['Art'] } }
            })
        });
        global.supabase = makeSupabaseMock(); // fresh log so delete assertion is clean
        clearCloudKeysCalls = [];
        setupMocks('owner');
        reloadCalled = false;

        await global.startNewHalf();

        // All 6 keys removed
        assert.equal(fakeStorage.hasOwnProperty('campRotationHistory_v1'), false);
        assert.equal(fakeStorage.hasOwnProperty('smartTileHistory_v1'), false);
        assert.equal(fakeStorage.hasOwnProperty('smartTileSpecialHistory_v1'), false);
        assert.equal(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), false);
        assert.equal(fakeStorage.hasOwnProperty('specialtyLeagueHistory_v1'), false);
        assert.equal(fakeStorage.hasOwnProperty('campDailyData_v1'), false);

        // Direct Supabase delete must fire (not just clearCloudKeys which skips the table)
        const supabaseDelete = supabaseLog.find(
            e => e.action === 'delete' && e.table === 'daily_schedules' && e.filters.camp_id === 'test-camp-123'
        );
        assert.ok(supabaseDelete, 'startNewHalf must directly delete from Supabase daily_schedules table');

        // All 9 cloud keys
        const keys = clearCloudKeysCalls[0] || [];
        assert.ok(keys.includes('leagueRoundState'));
        assert.ok(keys.includes('leagueHistory'));
        assert.ok(keys.includes('specialtyLeagueHistory'));
        assert.ok(keys.includes('daily_schedules'));
        assert.ok(keys.includes('manualUsageOffsets'));
        assert.ok(keys.includes('historicalCounts'));
        assert.ok(keys.includes('historicalCountedDates'), 'historicalCountedDates must be cleared with historicalCounts');
        assert.ok(keys.includes('smartTileHistory'));
        assert.ok(keys.includes('rotationHistory'));

        assert.ok(reloadCalled);
    });

    it('user cancels: everything preserved', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'campDailyData_v1': JSON.stringify({ '2026-07-15': {} }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 })
        });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        confirmResult = false;
        reloadCalled = false;

        await global.startNewHalf();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'Preserved');
        assert.ok(fakeStorage.hasOwnProperty('campDailyData_v1'), 'Preserved');
        assert.ok(fakeStorage.hasOwnProperty('campLeagueHistory_v2'), 'Preserved');
        assert.equal(clearCloudKeysCalls.length, 0);
        assert.equal(reloadCalled, false);
    });

    it('scheduler: permission denied', async () => {
        resetStorage({
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'campDailyData_v1': JSON.stringify({ '2026-07-15': {} })
        });
        clearCloudKeysCalls = [];
        setupMocks('scheduler');
        reloadCalled = false;

        await global.startNewHalf();

        assert.ok(fakeStorage.hasOwnProperty('campRotationHistory_v1'), 'NOT cleared');
        assert.ok(fakeStorage.hasOwnProperty('campDailyData_v1'), 'NOT cleared');
        assert.equal(reloadCalled, false);
    });
});

describe('Scope: New Half vs Reset History', () => {

    it('reset history clears LESS than new half', async () => {
        // Set up all keys
        const allKeys = {
            'campRotationHistory_v1': JSON.stringify({ data: true }),
            'smartTileHistory_v1': JSON.stringify({ data: true }),
            'smartTileSpecialHistory_v1': JSON.stringify({ data: true }),
            'campLeagueHistory_v2': JSON.stringify({ game: 5 }),
            'specialtyLeagueHistory_v1': JSON.stringify({ sgame: 3 }),
            'campDailyData_v1': JSON.stringify({ '2026-07-15': {} })
        };

        // Run eraseRotationHistory
        resetStorage({ ...allKeys });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        await global.eraseRotationHistory();

        const afterReset = { ...fakeStorage };
        const resetRemoved = Object.keys(allKeys).filter(k => !afterReset.hasOwnProperty(k));
        const resetPreserved = Object.keys(allKeys).filter(k => afterReset.hasOwnProperty(k));

        // Run startNewHalf
        resetStorage({ ...allKeys });
        clearCloudKeysCalls = [];
        setupMocks('owner');
        await global.startNewHalf();

        const afterNewHalf = { ...fakeStorage };
        const nhRemoved = Object.keys(allKeys).filter(k => !afterNewHalf.hasOwnProperty(k));

        // New Half removes strictly more
        assert.ok(nhRemoved.length > resetRemoved.length,
            `New Half removes ${nhRemoved.length} keys vs Reset History's ${resetRemoved.length}`);

        // Reset History should preserve leagues + schedules
        assert.ok(resetPreserved.includes('campLeagueHistory_v2'), 'Reset preserves league history');
        assert.ok(resetPreserved.includes('specialtyLeagueHistory_v1'), 'Reset preserves specialty league');
        assert.ok(resetPreserved.includes('campDailyData_v1'), 'Reset preserves daily schedules');
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

    it('scheduler: cleanupDateFromHistory called for both leagues after partial delete', async () => {
        resetStorage({
            'campDailyData_v1': JSON.stringify({
                '2026-07-15': {
                    scheduleAssignments: { 'Bunk 1': ['Hoops'], 'Bunk 3': ['Soccer'] },
                    leagueAssignments: {}
                }
            })
        });

        supabaseMockData = {
            '2026-07-15': [{
                id: 'rec-1',
                camp_id: 'test-camp-123',
                date_key: '2026-07-15',
                scheduler_name: 'Scheduler',
                schedule_data: {
                    scheduleAssignments: { 'Bunk 1': ['Hoops'], 'Bunk 3': ['Soccer'] },
                    leagueAssignments: {}
                }
            }]
        };
        supabaseLog = [];
        global.supabase = makeSupabaseMock();
        global.ScheduleDB = {
            loadSchedule: async () => ({ success: false })
        };

        let regularCleanup = null;
        let specialtyCleanup = null;
        global.SchedulerCoreLeagues = {
            cleanupDateFromHistory(dateKey) { regularCleanup = dateKey; }
        };
        global.SchedulerCoreSpecialtyLeagues = {
            cleanupDateFromHistory(dateKey) { specialtyCleanup = dateKey; }
        };

        setupMocks('scheduler');
        global.currentScheduleDate = '2026-07-15';

        await global.eraseCurrentDailyData();

        assert.equal(regularCleanup, '2026-07-15', 'regular cleanupDateFromHistory called');
        assert.equal(specialtyCleanup, '2026-07-15', 'specialty cleanupDateFromHistory called');
    });
});
