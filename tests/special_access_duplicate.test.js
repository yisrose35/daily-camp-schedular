/**
 * Tests for: scheduler_core_auto.js special-activity access checks
 *            (isSpecialAvailableForDivision / isSpecialAvailableForBunk).
 *
 * Run with:  node --test tests/special_access_duplicate.test.js
 *
 * Why this exists: a camp reported a special ("Sushi") restricted away from a
 * whole grade still being scheduled for that grade. Root cause: the camp's
 * config carries DUPLICATE special rows differing only by case ("Sushi" vs
 * "sushi"), and the duplicate had no access restriction. The old first-match
 * lookup could resolve to the unrestricted copy, defeating the gate. The
 * checks must now consider EVERY same-name copy and fail closed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAuto(specials) {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    win.loadGlobalSettings = () => ({ app1: { specialActivities: specials } });
    win.getGlobalSpecialActivities = () => specials;
    win.getAllSpecialActivities = () => specials;
    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_auto.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'scheduler_core_auto.js' });
    return win;
}

const restricted = {
    name: 'Sushi',
    accessRestrictions: { enabled: true, divisions: { 'Second Grade': [], 'Third Grade': [] } }
};
const unrestrictedDup = { name: 'sushi', accessRestrictions: { enabled: false, divisions: {} } };

describe('special access — duplicate-safe division check', () => {
    it('exposes the access helpers on window', () => {
        const win = loadAuto([restricted]);
        assert.equal(typeof win.isSpecialAvailableForDivision, 'function');
        assert.equal(typeof win.isSpecialAvailableForBunk, 'function');
    });

    it('blocks an excluded grade with a single restricted copy', () => {
        const win = loadAuto([restricted]);
        const gs = win.loadGlobalSettings();
        assert.equal(win.isSpecialAvailableForDivision('Sushi', 'First Grade', gs), false);
        assert.equal(win.isSpecialAvailableForDivision('Sushi', 'Second Grade', gs), true);
    });

    it('blocks the excluded grade even when an unrestricted duplicate exists (the bug)', () => {
        // Duplicate ordered FIRST — old first-match would have read it and leaked.
        const win = loadAuto([unrestrictedDup, restricted]);
        const gs = win.loadGlobalSettings();
        assert.equal(win.isSpecialAvailableForDivision('Sushi', 'First Grade', gs), false,
            'a restriction on ANY same-name copy must hold');
        assert.equal(win.isSpecialAvailableForDivision('sushi', 'First Grade', gs), false,
            'lookup by the duplicate name must also be blocked');
    });

    it('still allows grades that ARE in the allowlist', () => {
        const win = loadAuto([unrestrictedDup, restricted]);
        const gs = win.loadGlobalSettings();
        assert.equal(win.isSpecialAvailableForDivision('Sushi', 'Second Grade', gs), true);
    });

    it('enforces per-bunk lists across duplicates', () => {
        const perBunk = {
            name: 'Sushi',
            accessRestrictions: { enabled: true, divisions: { 'First Grade': ['Bunk 1'] } }
        };
        const win = loadAuto([unrestrictedDup, perBunk]);
        const gs = win.loadGlobalSettings();
        assert.equal(win.isSpecialAvailableForBunk('Sushi', 'First Grade', 'Bunk 1', gs), true);
        assert.equal(win.isSpecialAvailableForBunk('Sushi', 'First Grade', 'Bunk 2', gs), false);
    });

    it('open special (no restrictions) is available everywhere', () => {
        const win = loadAuto([{ name: 'Open Thing', accessRestrictions: { enabled: false, divisions: {} } }]);
        const gs = win.loadGlobalSettings();
        assert.equal(win.isSpecialAvailableForDivision('Open Thing', 'First Grade', gs), true);
        assert.equal(win.isSpecialAvailableForBunk('Open Thing', 'First Grade', 'Bunk 9', gs), true);
    });
});
