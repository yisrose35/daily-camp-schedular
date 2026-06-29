/**
 * Tests for the "every period" special-activity feature.
 *
 * An "every period" special must run in EVERY period for eligible bunks. It is
 * modeled as the strongest rotation floor: exempt from frequency ceilings and
 * given a maximal escalation bonus. This suite covers the shared classifier
 * (window.SchedulerCoreUtils.isEveryPeriodSpecial) and the constant both
 * engines use.
 *
 * Run with: node --test tests/every_period_special.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUtils() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        window: {},
        document: {
            readyState: 'complete',
            getElementById() { return null; },
            addEventListener() {},
            createElement() { return { style: {}, appendChild() {} }; },
            body: { appendChild() {} }
        },
        setTimeout: (fn) => fn()
    };
    sandbox.window = sandbox.window || {};
    const code = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.SchedulerCoreUtils;
}

describe('isEveryPeriodSpecial', () => {
    let U;
    before(() => { U = loadUtils(); });

    it('is registered on SchedulerCoreUtils', () => {
        assert.strictEqual(typeof U.isEveryPeriodSpecial, 'function');
        assert.strictEqual(typeof U.EVERY_PERIOD_BONUS, 'number');
    });

    it('recognizes the boolean flag', () => {
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: true }), true);
    });

    it('accepts the numeric / string truthy forms persisted by the config', () => {
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: 1 }), true);
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: 'true' }), true);
    });

    it('is false when the flag is unset, false, or otherwise falsy', () => {
        assert.strictEqual(U.isEveryPeriodSpecial({}), false);
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: false }), false);
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: 0 }), false);
        assert.strictEqual(U.isEveryPeriodSpecial({ everyPeriod: null }), false);
    });

    it('never throws on missing / null props', () => {
        assert.strictEqual(U.isEveryPeriodSpecial(null), false);
        assert.strictEqual(U.isEveryPeriodSpecial(undefined), false);
    });

    it('bonus dwarfs a normal escalation bonus so it wins the slot race', () => {
        // A normal min/exact escalation tops out well under this. The every-
        // period floor must always sort ahead of ordinary candidates.
        assert.ok(U.EVERY_PERIOD_BONUS >= 100000);
    });
});
