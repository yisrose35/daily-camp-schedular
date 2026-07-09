/**
 * Tests for: scheduler_core_main.js _healCrossDayRepeats (STEP 7.95).
 *
 * Run with:  node --test tests/repeat_heal_sweep.test.js
 *
 * Live finding 2026-07-09 (build cfc2d22): every FILLER is yesterday-gated, but
 * the main solver's yesterday policy is soft — single-bunk division לב got
 * Dodgeball @740-805 two days running and RECENCY-SWAP had no same-window peer
 * to trade with. STEP 7.95 re-runs each surviving did-it-yesterday placement
 * through the gated fallback filler. IMPROVE-ONLY: if the filler has no legal
 * non-repeat, the original entry is restored — a repeat is never traded for a
 * Free.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// MOCK ENVIRONMENT (scheduler_core_main.js top-level needs these)
// =====================================================================

let fakeStorage = {};
global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k) ? fakeStorage[k] : null; },
    setItem(k, v) { fakeStorage[k] = String(v); },
    removeItem(k) { delete fakeStorage[k]; }
};

global.document = {
    readyState: 'complete',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return { id: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {} }
};

global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.loadGlobalSettings = function () { return {}; };
global.SchedulerCoreUtils = { parseTimeToMinutes() { return null; }, minutesToTimeLabel() { return ''; } };

require('../scheduler_core_main.js');

const heal = global._healCrossDayRepeats;

// ---------------------------------------------------------------------
// Per-test state: a stub engine where recencyByAct names the activities
// done yesterday (50000) — everything else is old (4500). A stub filler
// that either writes `replacement` and returns true, or returns false.
// ---------------------------------------------------------------------
let fillerCalls;
function setup({ recencyByAct = {}, replacement = 'Hockey', fillerSucceeds = true } = {}) {
    fillerCalls = [];
    global.__repeatHealSweep = undefined;
    global.__regenSlotScope = null;
    global.GenTrace = { active: false };
    global.getSpecialActivities = () => [{ name: 'Arts & Crafts' }, { name: 'Pizza Making' }];
    global.RotationEngine = {
        CONFIG: { YESTERDAY_PENALTY: 50000 },
        calculateRecencyScore(bunk, act) {
            return (act in recencyByAct) ? recencyByAct[act] : 4500;
        }
    };
    global.AutoFillSlot = {
        autoFillSlotSilent(bunk, idx, kind) {
            fillerCalls.push({ bunk, idx, kind });
            if (!fillerSucceeds) return false;
            global.scheduleAssignments[bunk][idx] = {
                field: replacement + ' Field', sport: replacement, _activity: replacement,
                _location: replacement + ' Field', continuation: false, _fixed: true, _autoFilled: true
            };
            return true;
        }
    };
}

const sportEntry = (act, extra) => Object.assign(
    { field: act + ' Field', sport: act, _activity: act, continuation: false, _startMin: 740, _endMin: 805 }, extra);

describe('STEP 7.95 — cross-day repeat heal', () => {
    it('replaces a did-it-yesterday solver placement with the filler pick', () => {
        setup({ recencyByAct: { Dodgeball: 50000 } });
        global.scheduleAssignments = { 'לב': [sportEntry('Dodgeball')] };
        const res = heal();
        assert.deepEqual(res, { healed: 1, kept: 0 });
        assert.equal(global.scheduleAssignments['לב'][0]._activity, 'Hockey');
        assert.equal(fillerCalls[0].kind, 'sport', 'sport entry must ask for a sport replacement');
    });

    it('IMPROVE-ONLY: restores the original when the filler has no legal pick', () => {
        setup({ recencyByAct: { Dodgeball: 50000 }, fillerSucceeds: false });
        const orig = sportEntry('Dodgeball');
        global.scheduleAssignments = { 'לב': [orig] };
        const res = heal();
        assert.deepEqual(res, { healed: 0, kept: 1 });
        assert.equal(global.scheduleAssignments['לב'][0], orig, 'repeat beats Free — original restored');
    });

    it('leaves non-repeat placements untouched (filler never called)', () => {
        setup({ recencyByAct: {} });
        global.scheduleAssignments = { 'לב': [sportEntry('Dodgeball')] };
        const res = heal();
        assert.deepEqual(res, { healed: 0, kept: 0 });
        assert.equal(fillerCalls.length, 0);
        assert.equal(global.scheduleAssignments['לב'][0]._activity, 'Dodgeball');
    });

    it('skips pinned / league / override / continuation / transition entries', () => {
        setup({ recencyByAct: { Dodgeball: 50000 } });
        global.scheduleAssignments = { 'לב': [
            sportEntry('Dodgeball', { _pinned: true }),
            sportEntry('Dodgeball', { _leagueName: 'ABBL' }),
            sportEntry('Dodgeball', { _bunkOverride: true }),
            sportEntry('Dodgeball', { continuation: true }),
            sportEntry('Dodgeball', { _isTransition: true }),
            sportEntry('Dodgeball', { _postEdit: true }),
        ] };
        const res = heal();
        assert.deepEqual(res, { healed: 0, kept: 0 });
        assert.equal(fillerCalls.length, 0);
    });

    it('skips the lead slot of a multi-slot span (would orphan continuations)', () => {
        setup({ recencyByAct: { Swimming: 50000 } });
        global.scheduleAssignments = { 'לב': [
            sportEntry('Swimming'),
            sportEntry('Swimming', { continuation: true }),
        ] };
        const res = heal();
        assert.deepEqual(res, { healed: 0, kept: 0 });
        assert.equal(fillerCalls.length, 0);
    });

    it('skips a same-day duplicate (Infinity recency) — validator domain, not heal', () => {
        setup({ recencyByAct: { Dodgeball: Infinity } });
        global.scheduleAssignments = { 'לב': [sportEntry('Dodgeball')] };
        const res = heal();
        assert.deepEqual(res, { healed: 0, kept: 0 });
        assert.equal(fillerCalls.length, 0);
    });

    it('asks for a SPECIAL replacement when the repeat is a configured special', () => {
        setup({ recencyByAct: { 'Arts & Crafts': 50000 } });
        global.scheduleAssignments = { 'לב': [
            { field: 'Arts & Crafts Shack', sport: null, _activity: 'Arts & Crafts', continuation: false, _startMin: 740, _endMin: 805 }
        ] };
        heal();
        assert.equal(fillerCalls.length, 1);
        assert.equal(fillerCalls[0].kind, 'special');
    });

    it('respects the per-tile regen scope (background bunks untouched)', () => {
        setup({ recencyByAct: { Dodgeball: 50000 } });
        global.scheduleAssignments = {
            'לב': [sportEntry('Dodgeball')],
            'אחר': [sportEntry('Dodgeball')],
        };
        global.__regenSlotScope = { 'לב': { regen: new Set([0]), orig: [] } };
        const res = heal();
        assert.deepEqual(res, { healed: 1, kept: 0 });
        assert.equal(fillerCalls.length, 1);
        assert.equal(fillerCalls[0].bunk, 'לב');
        assert.equal(global.scheduleAssignments['אחר'][0]._activity, 'Dodgeball', 'background bunk preserved');
    });

    it('kill switch __repeatHealSweep=false disables the sweep', () => {
        setup({ recencyByAct: { Dodgeball: 50000 } });
        global.__repeatHealSweep = false;
        global.scheduleAssignments = { 'לב': [sportEntry('Dodgeball')] };
        const res = heal();
        assert.equal(res, null);
        assert.equal(global.scheduleAssignments['לב'][0]._activity, 'Dodgeball');
    });

    it('records a repeat-heal GenTrace decision when tracing is active', () => {
        setup({ recencyByAct: { Dodgeball: 50000 } });
        const decs = [];
        global.GenTrace = { active: true, decision: d => decs.push(d) };
        global.scheduleAssignments = { 'לב': [sportEntry('Dodgeball')] };
        heal();
        assert.equal(decs.length, 1);
        assert.equal(decs[0].kind, 'repeat-heal');
        assert.equal(decs[0].from, 'Dodgeball');
        assert.equal(decs[0].chosen.name, 'Hockey');
        assert.equal(decs[0].window, '740-805');
    });
});
