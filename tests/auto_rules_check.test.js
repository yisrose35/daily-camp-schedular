/**
 * Tests for: rules.js SchedulingRules.isCandidateAllowed + the
 *            anchor-type contract that Slice 3 audit hardened.
 *
 * Run with:  node --test tests/auto_rules_check.test.js
 *
 * Why this exists: every Slice 3 audit cycle found a writer that
 * bypassed the cooldown / anchor-type checks. These tests are the
 * regression net so the next contributor (or me-instance) can't
 * silently re-introduce the same class of bug.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- Minimal browser env ---
const win = {};
const sandbox = {
    window: win,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Object, Array, JSON, String, Number, Boolean,
    Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite
};
sandbox.global = sandbox;
vm.createContext(sandbox);

// --- Load rules.js into the sandbox ---
function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

// rules.js depends on window.loadGlobalSettings — stub it before load.
sandbox.window.loadGlobalSettings = () => ({});
loadInto('rules.js', sandbox);

const SR = sandbox.window.SchedulingRules;

describe('SchedulingRules surface', () => {
    it('exposes isCandidateAllowed', () => {
        assert.ok(SR);
        assert.equal(typeof SR.isCandidateAllowed, 'function');
    });

    it('returns true when no rules are configured', () => {
        sandbox.window.loadGlobalSettings = () => ({});
        const ok = SR.isCandidateAllowed(
            { startMin: 600, endMin: 645, type: 'sport', event: 'Soccer', field: 'Field A' },
            [],
            { mode: 'auto' }
        );
        assert.equal(ok, true);
    });

    it('allows a sport candidate with no conflicting template', () => {
        sandbox.window.loadGlobalSettings = () => ({
            schedulingRules: {
                cooldowns: [{
                    target: { kind: 'type', value: 'sport' },
                    reference: { kind: 'event', value: 'Lunch' },
                    minutes: 30,
                    timing: 'after',
                    mode: 'auto'
                }]
            }
        });
        const ok = SR.isCandidateAllowed(
            { startMin: 600, endMin: 645, type: 'sport', event: 'Soccer', field: 'Field A' },
            [],
            { mode: 'auto' }
        );
        assert.equal(ok, true);
    });
});

describe('cooldown rule application', () => {
    beforeEach(() => {
        sandbox.window.loadGlobalSettings = () => ({
            schedulingRules: {
                cooldowns: [{
                    target: { kind: 'type', value: 'sport' },
                    reference: { kind: 'type', value: 'lunch' },
                    minutes: 30,
                    timing: 'after',
                    mode: 'auto'
                }]
            }
        });
    });

    it('blocks a sport placed 15 minutes after lunch (within 30-min cooldown)', () => {
        const ok = SR.isCandidateAllowed(
            // candidate: Soccer at 12:45 (765 min)
            { startMin: 765, endMin: 810, type: 'sport', event: 'Soccer', field: 'Field A' },
            // template: Lunch ended at 12:30 (750 min)
            [{ startMin: 690, endMin: 750, type: 'lunch', event: 'Lunch', field: 'Lunch' }],
            { mode: 'auto' }
        );
        assert.equal(ok, false, 'sport 15 min after lunch should be blocked by 30 min cooldown');
    });

    it('allows a sport placed 45 minutes after lunch (past cooldown)', () => {
        const ok = SR.isCandidateAllowed(
            { startMin: 795, endMin: 840, type: 'sport', event: 'Soccer', field: 'Field A' },
            [{ startMin: 690, endMin: 750, type: 'lunch', event: 'Lunch', field: 'Lunch' }],
            { mode: 'auto' }
        );
        assert.equal(ok, true, 'sport 45 min after lunch should pass 30 min cooldown');
    });

    it('does NOT block an anchor write of type=lunch (anchor-type fix)', () => {
        // Slice 3 audit regression check: previously _runRulesCheck
        // stamped candidates as type='sport' for anchor writes, so a
        // "no Sport within 30 min of Lunch" cooldown would block the
        // Lunch anchor itself. With the fix, candidates correctly
        // carry type='lunch' and the rule does not apply.
        const ok = SR.isCandidateAllowed(
            { startMin: 690, endMin: 750, type: 'lunch', event: 'Lunch', field: 'Lunch' },
            [{ startMin: 600, endMin: 645, type: 'sport', event: 'Soccer', field: 'Field A' }],
            { mode: 'auto' }
        );
        assert.equal(ok, true, 'lunch anchor must not be blocked by sport-vs-lunch cooldown');
    });

    it('respects mode filtering — auto-only rule does not fire in manual mode', () => {
        const ok = SR.isCandidateAllowed(
            { startMin: 765, endMin: 810, type: 'sport', event: 'Soccer', field: 'Field A' },
            [{ startMin: 690, endMin: 750, type: 'lunch', event: 'Lunch', field: 'Lunch' }],
            { mode: 'manual' }
        );
        assert.equal(ok, true, 'auto-only rule must not block in manual mode');
    });
});
