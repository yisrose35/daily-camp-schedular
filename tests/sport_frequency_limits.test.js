/**
 * Tests for: per-sport usage/frequency limits — the same mechanism specials use.
 *
 * Run with:  node --test tests/sport_frequency_limits.test.js
 *
 * Sports live only as names inside a field's activities[] and normally get NO
 * activity-properties entry, so maxUsage/frequencyDays/exactFrequency never
 * applied to them. buildActivityProperties (scheduler_core_loader.js) now reads
 * sportMetaData and, for any sport that HAS a limit configured, builds an entry
 * carrying the same fields a special uses — so RotationEngine.calculateLimitScore
 * enforces it identically. This verifies the wiring AND the enforcement.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function boot(sportMeta) {
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
    win.getSportMetaData = () => sportMeta || {};
    for (const f of ['scheduler_core_loader.js', 'rotation_engine.js']) {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sb, { filename: f });
    }
    return win;
}

describe('per-sport frequency limits', () => {
    it('gives a LIMITED sport its own activity-props entry (same fields as specials)', () => {
        const win = boot({ Soccer: { maxUsage: 2, maxUsagePeriod: 'week', frequencyDays: 3 } });
        const props = win.buildActivityProperties([], [{ name: 'Soccer Field', activities: ['Soccer', 'Kickball'] }]);
        assert.ok(props['Soccer'], 'Soccer gets a props entry');
        assert.equal(props['Soccer'].type, 'sport');
        assert.equal(props['Soccer'].maxUsage, 2);
        assert.equal(props['Soccer'].maxUsagePeriod, 'week');
        assert.equal(props['Soccer'].frequencyDays, 3);
    });

    it('leaves an UNLIMITED sport with no entry (unchanged behavior)', () => {
        const win = boot({ Soccer: { maxUsage: 2 } });
        const props = win.buildActivityProperties([], [{ name: 'F', activities: ['Soccer', 'Kickball'] }]);
        assert.equal(props['Kickball'], undefined, 'Kickball has no limit → stays undefined');
    });

    it('never clobbers a special of the same name', () => {
        const win = boot({ Soccer: { maxUsage: 2 } });
        const props = win.buildActivityProperties(
            [{ name: 'Soccer', type: 'special', maxUsage: 9 }],
            [{ name: 'F', activities: ['Soccer'] }]);
        assert.equal(props['Soccer'].type, 'special', 'the special entry wins');
        assert.equal(props['Soccer'].maxUsage, 9);
    });

    it('ENFORCEMENT: calculateLimitScore blocks the sport at its cap, allows below', () => {
        const win = boot({ Soccer: { maxUsage: 2, maxUsagePeriod: 'week' } });
        const props = win.buildActivityProperties([], [{ name: 'F', activities: ['Soccer'] }]);
        // bunk A already did Soccer twice → at the cap
        win.RotationEngine.getActivityCount = b => (b === 'A' ? 2 : 0);
        win.RotationEngine.clearHistoryCache();
        assert.equal(win.RotationEngine.calculateLimitScore('A', 'Soccer', props, 'D'), Infinity, 'at cap → blocked');
        // bunk B has done it zero times → not blocked
        win.RotationEngine.clearHistoryCache();
        assert.notEqual(win.RotationEngine.calculateLimitScore('B', 'Soccer', props, 'D'), Infinity, 'below cap → allowed');
    });

    it('a sport name lower-cased key is also registered (solver normName lookups)', () => {
        const win = boot({ Soccer: { frequencyDays: 4 } });
        const props = win.buildActivityProperties([], [{ name: 'F', activities: ['Soccer'] }]);
        assert.ok(props['soccer'], 'lowercase key present');
        assert.equal(props['soccer'].frequencyDays, 4);
    });
});
