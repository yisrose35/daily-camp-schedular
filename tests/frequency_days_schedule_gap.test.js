/**
 * Tests for: frequencyDays cooldown measured in SCHEDULE-days, not calendar days.
 *
 * Run with:  node --test tests/frequency_days_schedule_gap.test.js
 *
 * Two fixes are covered here:
 *
 *  1. Utils.scheduledDaysBetween (scheduler_core_utils.js) — the shared gap
 *     helper every frequencyDays cooldown gate now uses. It counts only days a
 *     bunk is actually at camp (has a real slot). A day the grade is off (no
 *     schedule, e.g. Sunday) does NOT count toward "min N days between visits",
 *     so "6 days between" means 6 days of SCHEDULES, not 6 calendar dates.
 *
 *  2. RotationEngine.getDaysSinceActivityForCooldown (rotation_engine.js) — the
 *     manual/shared cooldown path now returns a schedule-day gap for the most
 *     recent post-epoch occurrence instead of the raw calendar daysAgo.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function boot(files) {
    const win = {};
    const sb = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sb.global = sb;
    vm.createContext(sb);
    for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sb, { filename: f });
    }
    return win;
}

describe('Utils.scheduledDaysBetween — schedule-day gap (not calendar days)', () => {
    const win = boot(['scheduler_core_utils.js']);
    const U = win.SchedulerCoreUtils;

    it('is exposed on SchedulerCoreUtils', () => {
        assert.equal(typeof U.scheduledDaysBetween, 'function');
    });

    it("skips a day the grade is OFF (no schedule) — Sunday does not count", () => {
        // Prior visit Thu 07-16; today Mon 07-20. Fri + Sat scheduled, Sun off.
        const allDaily = {
            '2026-07-16': { scheduleAssignments: { B1: [{ _activity: 'Swim' }] } },
            '2026-07-17': { scheduleAssignments: { B1: [{ _activity: 'Soccer' }] } }, // Fri — present
            '2026-07-18': { scheduleAssignments: { B1: [{ _activity: 'Art' }] } },    // Sat — present
            '2026-07-19': { scheduleAssignments: {} },                               // Sun — grade OFF
        };
        // Present schedule-days strictly between (16, 20): Fri, Sat = 2, +1 for today = 3.
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-16', '2026-07-20', allDaily), 3);
    });

    it('equals the calendar diff when every in-between day IS scheduled', () => {
        const allDaily = {
            '2026-07-16': { scheduleAssignments: { B1: [{ _activity: 'Swim' }] } },
            '2026-07-17': { scheduleAssignments: { B1: [{ _activity: 'Soccer' }] } },
            '2026-07-18': { scheduleAssignments: { B1: [{ _activity: 'Art' }] } },
            '2026-07-19': { scheduleAssignments: { B1: [{ _activity: 'Music' }] } },
        };
        // Fri, Sat, Sun all present = 3, +1 = 4 (matches the old calendar diff).
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-16', '2026-07-20', allDaily), 4);
    });

    it('consecutive schedule-days give a gap of 1 (back-to-back)', () => {
        const allDaily = {
            '2026-07-19': { scheduleAssignments: { B1: [{ _activity: 'Swim' }] } },
        };
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-19', '2026-07-20', allDaily), 1);
    });

    it('a Free slot still counts as present (grade is at camp, just idle)', () => {
        const allDaily = {
            '2026-07-18': { scheduleAssignments: { B1: [{ _activity: 'Free' }] } }, // present
        };
        // Sat present between (17, 20) -> 1, +1 = 2.
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-17', '2026-07-20', allDaily), 2);
    });

    it('a transition-only day does NOT count as present', () => {
        const allDaily = {
            '2026-07-18': { scheduleAssignments: { B1: [{ _activity: 'Lunch', _isTransition: true }] } },
        };
        // Only slot is a transition -> not present -> 0 between, +1 = 1.
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-17', '2026-07-20', allDaily), 1);
    });

    it('only counts days STRICTLY between the prior visit and today', () => {
        const allDaily = {
            '2026-07-16': { scheduleAssignments: { B1: [{ _activity: 'Swim' }] } }, // == fromKey, excluded
            '2026-07-17': { scheduleAssignments: { B1: [{ _activity: 'Soccer' }] } },
            '2026-07-20': { scheduleAssignments: { B1: [{ _activity: 'Art' }] } },  // == toKey, excluded
            '2026-07-21': { scheduleAssignments: { B1: [{ _activity: 'Music' }] } },// after today, excluded
        };
        // Only 07-17 is strictly between -> 1, +1 = 2.
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-16', '2026-07-20', allDaily), 2);
    });

    it('returns 0 for a missing endpoint (nothing to measure)', () => {
        assert.equal(U.scheduledDaysBetween('B1', '', '2026-07-20', {}), 0);
        assert.equal(U.scheduledDaysBetween('B1', '2026-07-16', '', {}), 0);
    });
});

describe('RotationEngine.getDaysSinceActivityForCooldown — uses the schedule-day gap', () => {
    it('returns the schedule-day gap for the most recent post-epoch occurrence', () => {
        const win = boot(['rotation_engine.js']);
        const calls = [];
        // Epoch active + a stubbed scheduledDaysBetween so we can prove the
        // cooldown path returns ITS value (schedule-days), not the calendar
        // daysAgo=4 carried in the history entry.
        win.SchedulerCoreUtils = {
            getRotationEpoch: () => '2026-07-01',
            scheduledDaysBetween: (bunk, from, to) => { calls.push([bunk, from, to]); return 3; },
            getDaysSinceActivity: () => null,
        };
        win.currentScheduleDate = '2026-07-20';
        win.RotationEngine.getActivitiesDoneToday = () => new Set();
        win.RotationEngine.getBunkHistory = () => ({
            byActivity: {
                swim: { dates: [{ dateKey: '2026-07-16', daysAgo: 4 }], daysSinceLast: 4 },
            },
        });

        const gap = win.RotationEngine.getDaysSinceActivityForCooldown('B1', 'Swim');
        assert.equal(gap, 3, 'cooldown returns the schedule-day gap, not the calendar daysAgo (4)');
        assert.deepEqual(calls[0], ['B1', '2026-07-16', '2026-07-20'],
            'anchored on the prior occurrence date and today');
    });
});
