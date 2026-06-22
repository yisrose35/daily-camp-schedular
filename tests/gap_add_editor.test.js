/**
 * Regression test for the auto-mode "+ Add" gap editor.
 *
 * BUG: In auto mode, mid-day gaps are uncovered TIME with no underlying
 *      _perBunkSlots slot. Clicking the "+ Add" gap indicator routed to
 *      enhancedEditCell(bunk, startMin, endMin, ''), which called
 *      findSlotsForRange() — got [] for the gap — and bailed with
 *      "Error: Could not find time slots for this block." So nothing opened.
 *
 * FIX: When the clicked range resolves to no slot AND we're in auto mode
 *      (_perBunkSlots present), materialize a slot for the range first via
 *      ensurePerBunkSlotForRange (the same primitive the save flow uses),
 *      then open the editor with that slot.
 *
 * This test copies the REAL ensurePerBunkSlotForRange (unified_schedule_system.js)
 * and the REAL Utils.findSlotsForRange (scheduler_core_utils.js) verbatim, plus a
 * faithful model of enhancedEditCell's slot-resolution branch, and proves:
 *   1. the gap genuinely resolves to zero slots (reproduces the bug condition)
 *   2. materialization injects a dedicated slot and PRESERVES the surrounding
 *      activities (remapped by startMin)
 *   3. after the fix, the editor would open (slots.length > 0) for an auto gap
 *   4. in manual mode (no _perBunkSlots) the path is left untouched
 *
 * Run with: node --test tests/gap_add_editor.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── minimal browser globals ──
global.window = global;
global.console = { log() {}, warn() {}, error() {} };

// Stub used by ensurePerBunkSlotForRange for slot labels — format is irrelevant
// to the assertions, only that it produces a string.
function minutesToTimeLabel(mins) {
    if (mins === null || mins === undefined) return '';
    const h = Math.floor(mins / 60), m = mins % 60;
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${h12}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// =====================================================================
// VERBATIM COPY: Utils.findSlotsForRange (scheduler_core_utils.js:116)
// =====================================================================
function findSlotsForRange(startMin, endMin, divisionOrBunk = null, bunkName = null) {
    const slots = [];
    if (startMin == null || endMin == null) return slots;

    if (divisionOrBunk && window.divisionTimes) {
        let divName = String(divisionOrBunk);

        if (!window.divisionTimes[divName]) {
            const divisions = window.divisions || {};
            const bunkStr = String(divisionOrBunk);
            for (const [dName, dData] of Object.entries(divisions)) {
                if (dData.bunks?.some(b => String(b) === bunkStr)) {
                    divName = dName;
                    if (!bunkName) bunkName = bunkStr;
                    break;
                }
            }
        }

        const hasPerBunkSlots = !!window.divisionTimes[divName]?._perBunkSlots;
        if (hasPerBunkSlots && bunkName) {
            const perBunkSlots = window.divisionTimes[divName]._perBunkSlots[String(bunkName)];
            if (perBunkSlots && perBunkSlots.length > 0) {
                for (let i = 0; i < perBunkSlots.length; i++) {
                    const slot = perBunkSlots[i];
                    if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                        slots.push(i);
                    }
                }
                if (slots.length > 0) return slots;
            }
        }

        const divSlots = window.divisionTimes[divName];
        if (divSlots && divSlots.length > 0) {
            for (let i = 0; i < divSlots.length; i++) {
                const slot = divSlots[i];
                if (!(slot.endMin <= startMin || slot.startMin >= endMin)) {
                    slots.push(i);
                }
            }
            return slots;
        }
    }
    return slots;
}

// =====================================================================
// VERBATIM COPY: ensurePerBunkSlotForRange (unified_schedule_system.js:6089)
// =====================================================================
function ensurePerBunkSlotForRange(bunkName, divName, targetStart, targetEnd) {
    const perBunkSlots = window.divisionTimes?.[divName]?._perBunkSlots?.[String(bunkName)];
    if (!perBunkSlots) return [];

    const newSlots = [];
    const resultIndices = [];

    for (let i = 0; i < perBunkSlots.length; i++) {
        const slot = { ...perBunkSlots[i] };
        const overlapStart = Math.max(slot.startMin, targetStart);
        const overlapEnd = Math.min(slot.endMin, targetEnd);
        const hasOverlap = overlapStart < overlapEnd;

        if (!hasOverlap) {
            newSlots.push(slot);
            continue;
        }

        if (slot.startMin < targetStart) {
            newSlots.push({
                ...slot,
                endMin: targetStart,
                label: minutesToTimeLabel(slot.startMin) + ' - ' + minutesToTimeLabel(targetStart),
                _splitFrom: i
            });
        }

        const targetSlot = {
            ...slot,
            startMin: overlapStart,
            endMin: overlapEnd,
            label: minutesToTimeLabel(overlapStart) + ' - ' + minutesToTimeLabel(overlapEnd),
            _reshapedForEdit: true
        };
        resultIndices.push(newSlots.length);
        newSlots.push(targetSlot);

        if (slot.endMin > targetEnd) {
            newSlots.push({
                ...slot,
                startMin: targetEnd,
                endMin: slot.endMin,
                label: minutesToTimeLabel(targetEnd) + ' - ' + minutesToTimeLabel(slot.endMin),
                _splitFrom: i
            });
        }
    }

    if (resultIndices.length === 0) {
        resultIndices.push(newSlots.length);
        newSlots.push({
            startMin: targetStart,
            endMin: targetEnd,
            event: 'GA',
            type: 'slot',
            label: minutesToTimeLabel(targetStart) + ' - ' + minutesToTimeLabel(targetEnd),
            _reshapedForEdit: true,
            _injected: true
        });
        newSlots.sort(function (a, b) { return a.startMin - b.startMin; });
        resultIndices[0] = newSlots.findIndex(function (s) { return s._reshapedForEdit && s.startMin === targetStart; });
    }

    newSlots.forEach(function (s, idx) { s.slotIndex = idx; });

    var oldAssignments = window.scheduleAssignments?.[bunkName] || [];
    var newAssignments = new Array(newSlots.length);

    var oldSlotEntries = {};
    for (var oi = 0; oi < perBunkSlots.length; oi++) {
        if (oldAssignments[oi]) {
            oldSlotEntries[perBunkSlots[oi].startMin] = oldAssignments[oi];
        }
    }

    for (var ni = 0; ni < newSlots.length; ni++) {
        if (resultIndices.includes(ni)) continue;
        var entry = oldSlotEntries[newSlots[ni].startMin];
        if (entry) {
            newAssignments[ni] = entry;
        } else if (newSlots[ni]._splitFrom !== undefined) {
            var origEntry = oldAssignments[newSlots[ni]._splitFrom];
            if (origEntry) {
                newAssignments[ni] = { ...origEntry, _splitRemainder: true };
            }
        }
    }

    window.divisionTimes[divName]._perBunkSlots[String(bunkName)] = newSlots;
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    window.scheduleAssignments[bunkName] = newAssignments;

    return resultIndices;
}

// =====================================================================
// MODEL of the fixed enhancedEditCell slot-resolution branch
// (unified_schedule_system.js enhancedEditCell). Returns the slots the
// editor would open with; [] means it shows the "no time slots" error and
// does NOT open.
// =====================================================================
function resolveSlotsForEdit(bunk, divName, startMin, endMin) {
    let slots = findSlotsForRange(startMin, endMin, divName, bunk);

    if (slots.length === 0 && startMin != null && endMin != null &&
        window.divisionTimes?.[divName]?._perBunkSlots) {
        slots = ensurePerBunkSlotForRange(bunk, divName, startMin, endMin) || [];
    }
    return slots;
}

// =====================================================================
// FIXTURES
// =====================================================================
function setupAutoMode() {
    // Majors1 has Swim 650-700 and Soccer 800-850 with an uncovered gap 700-800.
    window.divisions = { Majors: { bunks: ['Majors1'] } };
    window.divisionTimes = {
        Majors: {
            _perBunkSlots: {
                Majors1: [
                    { startMin: 650, endMin: 700, slotIndex: 0 },
                    { startMin: 800, endMin: 850, slotIndex: 1 }
                ]
            }
        }
    };
    window.scheduleAssignments = {
        Majors1: [
            { _activity: 'Swim', _startMin: 650, _endMin: 700 },
            { _activity: 'Soccer', _startMin: 800, _endMin: 850 }
        ]
    };
}

function setupManualMode() {
    // Manual: division-level slots, NO _perBunkSlots.
    window.divisions = { Majors: { bunks: ['Majors1'] } };
    window.divisionTimes = {
        Majors: [
            { startMin: 650, endMin: 700 },
            { startMin: 800, endMin: 850 }
        ]
    };
    window.scheduleAssignments = { Majors1: [{ _activity: 'Swim' }, { _activity: 'Soccer' }] };
}

// =====================================================================
// TESTS
// =====================================================================
describe('auto-mode gap "+ Add" editor', () => {
    beforeEach(setupAutoMode);

    it('reproduces the bug: an uncovered gap resolves to zero slots', () => {
        // The gap is 700-800 (between Swim end and Soccer start).
        const slots = findSlotsForRange(700, 800, 'Majors', 'Majors1');
        assert.equal(slots.length, 0, 'uncovered time must overlap no existing slot');
    });

    it('materializes a dedicated slot for the gap range', () => {
        const idxs = ensurePerBunkSlotForRange('Majors1', 'Majors', 700, 800);
        assert.equal(idxs.length, 1, 'returns exactly one target index for the gap');

        const slots = window.divisionTimes.Majors._perBunkSlots.Majors1;
        const target = slots[idxs[0]];
        assert.equal(target.startMin, 700);
        assert.equal(target.endMin, 800);
    });

    it('preserves the surrounding activities when materializing', () => {
        ensurePerBunkSlotForRange('Majors1', 'Majors', 700, 800);
        const slots = window.divisionTimes.Majors._perBunkSlots.Majors1;
        const asg = window.scheduleAssignments.Majors1;

        const swim = slots.findIndex(s => s.startMin === 650);
        const soccer = slots.findIndex(s => s.startMin === 800);
        assert.ok(swim !== -1 && soccer !== -1, 'both original slots still present');
        assert.equal(asg[swim]._activity, 'Swim', 'Swim survived the remap');
        assert.equal(asg[soccer]._activity, 'Soccer', 'Soccer survived the remap');

        // The newly injected gap slot is empty (ready for the new activity).
        const gap = slots.findIndex(s => s.startMin === 700 && s.endMin === 800);
        assert.ok(!asg[gap], 'gap slot starts empty');
    });

    it('after the fix the editor opens for an auto gap (slots non-empty)', () => {
        const slots = resolveSlotsForEdit('Majors1', 'Majors', 700, 800);
        assert.ok(slots.length > 0, 'editor opens instead of erroring on the gap');
        // And the resolved slot is the gap range.
        const resolved = window.divisionTimes.Majors._perBunkSlots.Majors1[slots[0]];
        assert.equal(resolved.startMin, 700);
        assert.equal(resolved.endMin, 800);
    });

    it('does not materialize when the clicked range is already a real slot', () => {
        const before = window.divisionTimes.Majors._perBunkSlots.Majors1.length;
        const slots = resolveSlotsForEdit('Majors1', 'Majors', 650, 700);
        const after = window.divisionTimes.Majors._perBunkSlots.Majors1.length;
        assert.equal(slots.length, 1, 'existing slot resolves directly');
        assert.equal(after, before, 'no new slot injected for an already-covered range');
    });
});

describe('manual-mode is left untouched', () => {
    beforeEach(setupManualMode);

    it('does not attempt per-bunk materialization without _perBunkSlots', () => {
        // A 700-800 "gap" in manual mode has no per-bunk slots to reshape; the
        // guard skips materialization, so the existing behavior is preserved.
        const slots = resolveSlotsForEdit('Majors1', 'Majors', 700, 800);
        assert.equal(slots.length, 0, 'manual path unchanged (no _perBunkSlots reshape)');
        // The materializer itself refuses without per-bunk slots.
        assert.deepEqual(ensurePerBunkSlotForRange('Majors1', 'Majors', 700, 800), []);
    });
});
