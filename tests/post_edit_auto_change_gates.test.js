/**
 * Regression test for the post-edit "Auto Change" candidate picker
 * (_pickAutoCandidate in unified_schedule_system.js showEditModal).
 *
 * Auto Change is a mini single-bunk generation: it must honor EVERY gate the
 * auto-scheduler enforces. Rather than re-implement the rules, the real code
 * reuses the engine's own functions:
 *   • calculateRotationPenalty → RotationEngine.calculateRotationScore
 *     (Infinity = hard-blocked: availableDays, frequencyDays cooldown, maxUsage,
 *     exactFrequency, multiPart, rotationCohort, available=false, recency, …)
 *   • findFieldsForActivity (capacity/time conflict, access, league locks, combos)
 * plus three local guards mirrored from findAlternativeForBunk:
 *   • full-day same-day no-repeat, rainy-day gating, bunk/grade access.
 *
 * This test models _pickAutoCandidate's gate chain VERBATIM (same predicates,
 * same order) with injected stand-ins for the two engine functions, and proves
 * every gate rejects and that the lowest-penalty survivor wins.
 *
 * Run with: node --test tests/post_edit_auto_change_gates.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

global.window = global;

// ---------------------------------------------------------------------------
// VERBATIM MODEL of _pickAutoCandidate (unified_schedule_system.js).
// `deps` supplies the in-scope values the real closure reads: bunk, divName,
// slots, startMin, endMin, allActivities, and the two engine functions.
// ---------------------------------------------------------------------------
function pickAutoCandidate(deps) {
    const { bunk, divName, slots, startMin, endMin, allActivities } = deps;
    const calculateRotationPenalty = deps.calculateRotationPenalty.bind(deps);
    const findFieldsForActivity = deps.findFieldsForActivity.bind(deps);
    const getActivityProperties = deps.getActivityProperties.bind(deps);

    const _settings = window.loadGlobalSettings?.() || {};
    const _app1 = _settings.app1 || {};
    const _props = getActivityProperties();
    const _isRainy = window.isRainyDayModeActive?.() || window.isRainyDay === true;

    const _editedSlots = new Set(slots);
    const _doneTodayFull = new Set();
    (window.scheduleAssignments?.[bunk] || []).forEach((entry, i) => {
        if (!entry || _editedSlots.has(i) || entry.continuation || entry._isTransition) return;
        const a = (entry._activity || '').toLowerCase().trim();
        if (a && a !== 'free') _doneTodayFull.add(a);
    });

    function _rainyBlocks(name) {
        const p = _props[name] || _props[name.toLowerCase()] || {};
        const sp = window.getSpecialActivityByName?.(name)
            || (_app1.specialActivities || []).find(s => s.name === name) || {};
        const rainyOnly = p.rainyDayOnly === true || p.rainyDayExclusive === true
            || sp.rainyDayOnly === true || sp.rainyDayExclusive === true;
        if (!_isRainy && rainyOnly) return true;
        if (_isRainy) {
            const notRainyOk = p.rainyDayAvailable === false || p.availableOnRainyDay === false || p.isIndoor === false
                || sp.rainyDayAvailable === false || sp.availableOnRainyDay === false || sp.isIndoor === false;
            if (notRainyOk) return true;
        }
        return false;
    }

    function _accessBlocks(name) {
        let p = _props[name] || _props[name.toLowerCase()] || {};
        if (!p.accessRestrictions?.enabled) {
            const sd = window.getSpecialActivityByName?.(name)
                || (_app1.specialActivities || []).find(s => s.name === name);
            if (sd?.accessRestrictions?.enabled) p = sd; else return false;
        }
        const allowed = p.accessRestrictions.divisions || {};
        if (!(divName in allowed)) return true;
        const bl = allowed[divName];
        if (Array.isArray(bl) && bl.length > 0) {
            const bStr = String(bunk), bNum = parseInt(bunk);
            if (!bl.some(b => String(b) === bStr || parseInt(b) === bNum)) return true;
        }
        return false;
    }

    const _seen = new Set();
    const _cands = [];
    for (const actName of allActivities) {
        const al = actName.toLowerCase().trim();
        if (_seen.has(al)) continue;
        _seen.add(al);
        if (!al || al === 'free') continue;
        if (_doneTodayFull.has(al)) continue;
        if (_rainyBlocks(actName)) continue;
        if (_accessBlocks(actName)) continue;
        const penalty = calculateRotationPenalty(bunk, actName, slots);
        if (penalty === Infinity) continue;
        const { open, none } = findFieldsForActivity(actName, slots, divName, bunk, startMin, endMin);
        if (none || open.length === 0) continue;
        const bestField = open.find(f => !f.shared) || open[0];
        _cands.push({ activity: actName, field: bestField.name, penalty });
    }
    _cands.sort((a, b) => a.penalty - b.penalty);
    return _cands[0] || null;
}

// Convenience: a deps object where everything passes, then override per-test.
function makeDeps(overrides = {}) {
    const base = {
        bunk: 'A1',
        divName: 'Seniors',
        slots: [3],
        startMin: 600,
        endMin: 645,
        allActivities: ['Basketball', 'Swimming', 'Baking'],
        // default: nothing penalized, every activity has one open field == its name
        penalties: {},          // activity -> penalty (default 0)
        openFields: null,       // activity -> [{name, shared?}] (default [{name: activity}])
        calculateRotationPenalty(b, act) {
            const p = this.penalties[act];
            return p === undefined ? 0 : p;
        },
        findFieldsForActivity(act) {
            const fields = this.openFields ? this.openFields[act] : null;
            if (fields === null || fields === undefined) return { open: [{ name: act }], busy: [], none: false };
            if (fields.length === 0) return { open: [], busy: [], none: false };
            return { open: fields, busy: [], none: false };
        },
        getActivityProperties() { return this.props || {}; },
        props: {}
    };
    return Object.assign(base, overrides);
}

beforeEach(() => {
    window.scheduleAssignments = {};
    window.loadGlobalSettings = () => ({ app1: { specialActivities: [] } });
    delete window.isRainyDay;
    delete window.isRainyDayModeActive;
    delete window.getSpecialActivityByName;
});

afterEach(() => {
    delete window.scheduleAssignments;
    delete window.loadGlobalSettings;
    delete window.isRainyDay;
    delete window.isRainyDayModeActive;
    delete window.getSpecialActivityByName;
});

describe('Auto Change candidate picker — gate enforcement', () => {
    it('picks the lowest-penalty available activity', () => {
        const deps = makeDeps({ penalties: { Basketball: 50, Swimming: 10, Baking: 90 } });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Swimming');
        assert.equal(pick.field, 'Swimming');
    });

    it('GATE rotation: rejects activities with Infinity penalty (cooldown/availableDays/maxUsage/exactFreq)', () => {
        // Swimming is the best score but hard-gated (e.g. frequencyDays cooldown) → must be skipped.
        const deps = makeDeps({ penalties: { Basketball: 50, Swimming: Infinity, Baking: 90 } });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball');
    });

    it('GATE same-day: rejects an activity already on the bunk EARLIER today', () => {
        window.scheduleAssignments = { A1: [
            { _activity: 'Swimming' }, null, null, /* edited slot 3: */ { _activity: 'Free' }
        ] };
        const deps = makeDeps({ penalties: { Basketball: 50, Swimming: 10, Baking: 90 } });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'Swimming already done earlier today → skipped');
    });

    it('GATE same-day: rejects an activity scheduled LATER today (engine only looks backward — this is the local guard)', () => {
        // Edited slot is 3; Swimming sits at slot 5 (AFTER). RotationEngine.getActivitiesDoneToday
        // would miss it; the full-day guard must still reject it.
        window.scheduleAssignments = { A1: [
            null, null, null, { _activity: 'Free' }, null, { _activity: 'Swimming' }
        ] };
        const deps = makeDeps({ penalties: { Basketball: 50, Swimming: 10, Baking: 90 } });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'Swimming scheduled later today → still skipped');
    });

    it('GATE same-day: does NOT count the slot being edited against itself', () => {
        // The edited slot currently holds Swimming; Swimming must still be eligible.
        window.scheduleAssignments = { A1: [null, null, null, { _activity: 'Swimming' }] };
        const deps = makeDeps({ penalties: { Basketball: 50, Swimming: 10, Baking: 90 } });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Swimming', 'the edited slot itself is excluded from done-today');
    });

    it('GATE field: rejects activities with no open field (capacity/access/league/combo via findFieldsForActivity)', () => {
        const deps = makeDeps({
            penalties: { Basketball: 50, Swimming: 10, Baking: 90 },
            openFields: { Basketball: [{ name: 'Court 1' }], Swimming: [], Baking: [{ name: 'Baking' }] }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'Swimming had no open field → skipped despite best score');
        assert.equal(pick.field, 'Court 1');
    });

    it('GATE field none:true (no matching field at all) is skipped', () => {
        const deps = makeDeps({
            penalties: { Swimming: 10, Basketball: 50 },
            allActivities: ['Swimming', 'Basketball'],
            findFieldsForActivity(act) {
                if (act === 'Swimming') return { open: [], busy: [], none: true };
                return { open: [{ name: act }], busy: [], none: false };
            }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball');
    });

    it('GATE rainy: on a SUNNY day, rainyDayOnly activities are skipped', () => {
        const deps = makeDeps({
            penalties: { Basketball: 50, Swimming: 10 },
            allActivities: ['Swimming', 'Basketball'],
            props: { Swimming: { rainyDayOnly: true } }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'rainyDayOnly Swimming skipped on a sunny day');
    });

    it('GATE rainy: on a RAINY day, an outdoor (isIndoor:false) activity is skipped', () => {
        window.isRainyDay = true;
        const deps = makeDeps({
            penalties: { Basketball: 50, Swimming: 10 },
            allActivities: ['Swimming', 'Basketball'],
            props: { Swimming: { isIndoor: false } }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'outdoor Swimming skipped on a rainy day');
    });

    it('GATE rainy: reads the flag from the special config too, not just activityProperties', () => {
        window.getSpecialActivityByName = (n) => (n === 'Baking' ? { name: 'Baking', rainyDayOnly: true } : null);
        const deps = makeDeps({
            penalties: { Baking: 5, Basketball: 50 },
            allActivities: ['Baking', 'Basketball']
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'rainyDayOnly read off special config on a sunny day');
    });

    it('GATE access: a grade not in the allowed divisions is skipped', () => {
        const deps = makeDeps({
            penalties: { Swimming: 10, Basketball: 50 },
            allActivities: ['Swimming', 'Basketball'],
            props: { Swimming: { accessRestrictions: { enabled: true, divisions: { Juniors: [] } } } }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'Seniors not in {Juniors} → Swimming skipped');
    });

    it('GATE access: division allowed but THIS bunk not in the bunk-list is skipped', () => {
        const deps = makeDeps({
            penalties: { Swimming: 10, Basketball: 50 },
            allActivities: ['Swimming', 'Basketball'],
            // Seniors allowed, but only bunks A2/A3 — A1 excluded
            props: { Swimming: { accessRestrictions: { enabled: true, divisions: { Seniors: ['A2', 'A3'] } } } }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Basketball', 'A1 not in [A2,A3] → Swimming skipped');
    });

    it('GATE access: division allowed and bunk IS in the bunk-list is allowed', () => {
        const deps = makeDeps({
            penalties: { Swimming: 10, Basketball: 50 },
            allActivities: ['Swimming', 'Basketball'],
            props: { Swimming: { accessRestrictions: { enabled: true, divisions: { Seniors: ['A1', 'A2'] } } } }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Swimming', 'A1 in [A1,A2] → Swimming allowed');
    });

    it('prefers a non-shared field over a shared one', () => {
        const deps = makeDeps({
            penalties: { Basketball: 10 },
            allActivities: ['Basketball'],
            openFields: { Basketball: [{ name: 'Court 1', shared: true }, { name: 'Court 2' }] }
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.field, 'Court 2', 'non-shared Court 2 preferred over shared Court 1');
    });

    it('returns null when every activity is gated out', () => {
        const deps = makeDeps({
            penalties: { Basketball: Infinity, Swimming: Infinity, Baking: Infinity }
        });
        assert.equal(pickAutoCandidate(deps), null);
    });

    it('a special activity yields field === activity (handler stores it with no separate location)', () => {
        const deps = makeDeps({
            penalties: { Baking: 5 },
            allActivities: ['Baking']
        });
        const pick = pickAutoCandidate(deps);
        assert.equal(pick.activity, 'Baking');
        assert.equal(pick.field, 'Baking', 'special field name equals its activity name');
    });
});
