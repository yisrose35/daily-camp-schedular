/**
 * Tests for: total_solver_engine.js applyPickToSchedule — special-access guard.
 *
 * Run with:  node --test tests/total_solver_special_access.test.js
 *
 * Why this exists: the MANUAL builder's real solver is total_solver_engine.js.
 * It enforced only the hosting FIELD's access restriction, never the special's
 * OWN restriction — so a special hosted on a field that admits a grade (e.g.
 * "Basketball Clinic" at "Jump Shot") was placed for grades the special itself
 * excluded. The write chokepoint now downgrades such a placement to Free.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function setup() {
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

    // "Basketball Clinic" is a special hosted at field "Jump Shot",
    // restricted to grades 7 and 8 only.
    const specials = [{
        name: 'Basketball Clinic', location: 'Jump Shot',
        accessRestrictions: { enabled: true, divisions: { '7': [], '8': [] } }
    }];
    win.loadGlobalSettings = () => ({ app1: { specialActivities: specials, fields: [] } });
    win.getGlobalSpecialActivities = () => specials;
    win.getAllSpecialActivities = () => specials;
    win.globalSettings = { app1: { specialActivities: specials } };
    win.scheduleAssignments = {};

    for (const f of ['scheduler_core_auto.js', 'total_solver_engine.js']) {
        vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sb, { filename: f });
    }
    const api = (win.TotalSolver && win.TotalSolver.applyPickToSchedule) ? win.TotalSolver : win._SolverInternals;
    return { win, apply: api.applyPickToSchedule };
}

describe('total_solver_engine applyPickToSchedule — special access guard', () => {
    it('exposes applyPickToSchedule and the access helper', () => {
        const { win, apply } = setup();
        assert.equal(typeof apply, 'function');
        assert.equal(typeof win.isSpecialAvailableForBunk, 'function');
    });

    it('downgrades a restricted special to Free for an excluded grade', () => {
        const { win, apply } = setup();
        win.scheduleAssignments['ב'] = [null];
        apply({ bunk: 'ב', slots: [0], divName: 'Camp Agudah > 4' },
              { field: 'Jump Shot', sport: null, _activity: 'Basketball Clinic' });
        const e = win.scheduleAssignments['ב'][0];
        assert.equal(e.field, 'Free', 'excluded grade must not keep the special');
        assert.equal(e._activity, 'Free');
    });

    it('keeps the special for an allowed grade', () => {
        const { win, apply } = setup();
        win.scheduleAssignments['b7'] = [null];
        apply({ bunk: 'b7', slots: [0], divName: '7' },
              { field: 'Jump Shot', sport: null, _activity: 'Basketball Clinic' });
        const e = win.scheduleAssignments['b7'][0];
        assert.equal(e.field, 'Jump Shot', 'allowed grade must keep the special');
        assert.equal(e._activity, 'Basketball Clinic');
    });

    it('leaves an unrestricted activity untouched', () => {
        const { win, apply } = setup();
        win.scheduleAssignments['x'] = [null];
        apply({ bunk: 'x', slots: [0], divName: 'Camp Agudah > 4' },
              { field: 'Soccer Field', sport: 'Soccer', _activity: 'Soccer' });
        const e = win.scheduleAssignments['x'][0];
        assert.equal(e.field, 'Soccer Field');
        assert.equal(e._activity, 'Soccer');
    });
});
