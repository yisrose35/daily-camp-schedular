/**
 * Tests for: auto_fill_slot.js — the leftover-Free-slot fallback filler must
 * obey the rotation engine's HARD gates.
 *
 * Run with:  node --test tests/auto_fill_rotation_gate.test.js
 *
 * Found via the 2026-07-09 brain trace: bunk לב's Free slot was filled with
 * Basketball even though the rotation engine had it fair-share-BLOCKED
 * (Infinity). The filler's local scorer knows recency and per-period caps but
 * never consulted RotationEngine, so hard blocks (fair-share cap,
 * frequencyDays cooldown, cohort waits, availableDays) leaked through the
 * last-resort path. scoreAndPick now hard-gates every candidate through
 * calculateRotationScore.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const norm = (v) => JSON.parse(JSON.stringify(v));

function makeSandbox() {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    sandbox.window.currentScheduleDate = '2026-07-09';
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

function setup(rotScores, recencyScores) {
    const sb = makeSandbox();
    const win = sb.window;
    win.loadAllDailyData = () => ({});
    win.loadRotationHistory = () => ({ bunks: {} });
    win.scheduleAssignments = {};
    win.activityProperties = {};
    // Stub engine: per-activity score, Infinity = hard block
    win.RotationEngine = {
        CONFIG: { YESTERDAY_PENALTY: 50000 },
        calculateRotationScore: ({ activityName }) =>
            (activityName in rotScores ? rotScores[activityName] : 0)
    };
    if (recencyScores) {
        win.RotationEngine.calculateRecencyScore = (bunk, act) =>
            (act in recencyScores ? recencyScores[act] : -5000);
    }
    loadInto('auto_fill_slot.js', sb);
    return sb;
}

const cand = (name) => ({ activity: name, field: name + ' Field', type: 'sport', maxUsage: 0, exactFrequency: 0 });

describe('fallback filler — rotation hard-gate', () => {
    it('skips an engine-blocked candidate and picks an allowed one', () => {
        const sb = setup({ Basketball: Infinity, Baseball: 0 });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Baseball')], '2026-07-09', 'לב', 1);
        assert.ok(pick, 'an allowed candidate must be picked');
        assert.equal(pick.activity, 'Baseball', 'blocked Basketball must be skipped');
    });

    it('returns null (slot stays Free) when every candidate is hard-blocked', () => {
        const sb = setup({ Basketball: Infinity, Baseball: Infinity });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Baseball')], '2026-07-09', 'לב', 1);
        assert.equal(pick, null, 'design intent: Free beats an engine-blocked repeat');
    });

    it('works unchanged when RotationEngine is absent', () => {
        const sb = setup({});
        delete sb.window.RotationEngine;
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball')], '2026-07-09', 'לב', 1);
        assert.equal(pick.activity, 'Basketball', 'no engine → prior behavior preserved');
    });

    it('still enforces its own same-day duplicate block', () => {
        const sb = setup({});
        sb.window.scheduleAssignments = { 'לב': [{ _activity: 'Baseball' }] };
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball'), cand('Hockey')], '2026-07-09', 'לב', 1);
        assert.equal(pick.activity, 'Hockey', 'same-day duplicate must be skipped');
    });
});

describe('fallback filler — back-to-back (yesterday) gate', () => {
    // Second 3-day live run (2026-07-09 trace): bunk לב's pool was
    // {Basketball: fair-share blocked, Baseball: done YESTERDAY}. The Infinity
    // gate skipped Basketball but Baseball (recency 50000, finite) filled —
    // the same activity two days running. The fill must leave the slot Free.

    it('skips a did-it-yesterday candidate even when it is the only legal one', () => {
        const sb = setup({ Basketball: Infinity, Baseball: 56520 },
                         { Baseball: 50000 });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick, null, 'yesterday-repeat must stay Free, not refill');
    });

    it('prefers an older candidate over a yesterday one', () => {
        const sb = setup({}, { Baseball: 50000, Hockey: 4500 });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball'), cand('Hockey')], '2026-07-09', 'לב', 0);
        assert.equal(pick.activity, 'Hockey', 'the 3-days-ago candidate must win');
    });

    it('kill switch __fallbackYesterdayGate=false restores the old behavior', () => {
        const sb = setup({ Baseball: 56520 }, { Baseball: 50000 });
        sb.window.__fallbackYesterdayGate = false;
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick && pick.activity, 'Baseball', 'gate off → repeat allowed');
    });

    it('same-day recency (Infinity) is also caught by the recency gate', () => {
        const sb = setup({}, { Baseball: Infinity });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick, null, 'Infinity recency >= YESTERDAY_PENALTY → skip');
    });

    it('engine without calculateRecencyScore keeps prior behavior (no crash)', () => {
        const sb = setup({ Baseball: 56520 });   // no recency stub installed
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick && pick.activity, 'Baseball', 'no recency API → old behavior');
    });
});

// ★ Last-resort fair-share relax (2026-07-08/09 live finding): bunk לב's WHOLE
//   pool was fair-share-capped + cooldown-blocked, so the strict gates left the
//   slot Free two days running. Policy: no-back-to-back > no-Free > fair-share
//   bookkeeping — when the strict pass yields nothing, re-score once with
//   __fairShareHardCap=false. Only fair-share blocks lift; same-day, yesterday,
//   and every other hard cap still hold.
//
// Stub: fsBlocked activities return Infinity ONLY while __fairShareHardCap is on
// (mirroring the real engine, whose fair-share block lives behind that switch);
// hardBlocked activities return Infinity unconditionally (maxUsage/cooldown/etc.).
function setupRelax({ fsBlocked = [], hardBlocked = [], recencyScores = null } = {}) {
    const sb = makeSandbox();
    const win = sb.window;
    win.loadAllDailyData = () => ({});
    win.loadRotationHistory = () => ({ bunks: {} });
    win.scheduleAssignments = {};
    win.activityProperties = {};
    win.RotationEngine = {
        CONFIG: { YESTERDAY_PENALTY: 50000 },
        calculateRotationScore: ({ activityName }) => {
            if (hardBlocked.includes(activityName)) return Infinity;
            if (fsBlocked.includes(activityName) && win.__fairShareHardCap !== false) return Infinity;
            return 0;
        }
    };
    if (recencyScores) {
        win.RotationEngine.calculateRecencyScore = (bunk, act) =>
            (act in recencyScores ? recencyScores[act] : -5000);
    }
    loadInto('auto_fill_slot.js', sb);
    return sb;
}

describe('fallback filler — last-resort fair-share relax', () => {
    it('fills a slot whose pool is entirely fair-share-capped (instead of Free)', () => {
        const sb = setupRelax({ fsBlocked: ['Basketball', 'Dodgeball'] });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Dodgeball')], '2026-07-09', 'לב', 1);
        assert.ok(pick, 'relaxed pass must produce a pick');
        assert.equal(pick._fairShareRelaxed, true, 'pick must be flagged as relaxed');
        assert.notEqual(sb.window.__fairShareHardCap, false, 'cap switch must be restored after the pass');
    });

    it('does NOT relax when the strict pass already has a legal candidate', () => {
        const sb = setupRelax({ fsBlocked: ['Basketball'] });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Hockey')], '2026-07-09', 'לב', 1);
        assert.equal(pick.activity, 'Hockey', 'strict pick wins');
        assert.ok(!pick._fairShareRelaxed, 'no relax flag on a strict pick');
    });

    it('relaxed pass still refuses a did-it-yesterday candidate', () => {
        const sb = setupRelax({ fsBlocked: ['Basketball', 'Baseball'],
                                recencyScores: { Baseball: 50000 } });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball'), cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick && pick.activity, 'Basketball', 'yesterday candidate skipped even relaxed');
    });

    it('stays Free when the only relaxed candidate was done yesterday', () => {
        const sb = setupRelax({ fsBlocked: ['Baseball'],
                                recencyScores: { Baseball: 50000 } });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball')], '2026-07-09', 'לב', 0);
        assert.equal(pick, null, 'no-back-to-back outranks no-Free');
    });

    it('a non-fair-share hard block (maxUsage/cooldown) never relaxes', () => {
        const sb = setupRelax({ hardBlocked: ['Basketball'] });
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball')], '2026-07-09', 'לב', 1);
        assert.equal(pick, null, 'unconditional engine block survives the relax pass');
    });

    it('relaxed pass still enforces the same-day duplicate block', () => {
        const sb = setupRelax({ fsBlocked: ['Baseball'] });
        sb.window.scheduleAssignments = { 'לב': [{ _activity: 'Baseball' }] };
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Baseball')], '2026-07-09', 'לב', 1);
        assert.equal(pick, null, 'already doing it today → no relax fill');
    });

    it('kill switch __fallbackFairShareRelax=false keeps the strict Free behavior', () => {
        const sb = setupRelax({ fsBlocked: ['Basketball'] });
        sb.window.__fallbackFairShareRelax = false;
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball')], '2026-07-09', 'לב', 1);
        assert.equal(pick, null, 'relax disabled → slot stays Free');
    });

    it('user-set global __fairShareHardCap=false is left untouched (no double toggle)', () => {
        const sb = setupRelax({ fsBlocked: ['Basketball'] });
        sb.window.__fairShareHardCap = false;   // user already disabled the cap globally
        const pick = sb.window.AutoFillSlot._scoreAndPick(
            'לב', [cand('Basketball')], '2026-07-09', 'לב', 1);
        assert.equal(pick && pick.activity, 'Basketball', 'strict pass already unblocked');
        assert.ok(!pick._fairShareRelaxed, 'not a relax pick — cap was globally off');
        assert.equal(sb.window.__fairShareHardCap, false, 'global switch preserved');
    });
});
