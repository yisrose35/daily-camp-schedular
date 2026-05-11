/**
 * Tests for: auto_layout_swap.js — Phase C layout renegotiation.
 *
 * Run with:  node --test tests/auto_layout_swap.test.js
 *
 * Follows the vm-sandbox pattern from the Phase A tests:
 *   loadInto('auto_layout_swap.js', ctx) to isolate the module.
 *   Callbacks are mocked — no scheduler dependency.
 *
 * FOUR KEY SCENARIOS TESTED:
 *   1. Swap IS applied: special at T1 + Free at T2 (in window) → swap committed.
 *   2. No-improvement swap: fillSlotWithSport fails → rollback, not committed.
 *   3. Window violation: Free's time is outside donor's layer window → no proposal.
 *   4. Same-day repeat guard: moveBlock returns false → rollback.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ---------------------------------------------------------------------------
// vm-sandbox helpers (same pattern as auto_feasibility.test.js)
// ---------------------------------------------------------------------------

function makeSandbox() {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol,
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    return sandbox;
}

function loadInto(filename, ctx) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

function setup() {
    const sb = makeSandbox();
    loadInto('auto_layout_swap.js', sb);
    return sb;
}

// ---------------------------------------------------------------------------
// Minimal schedule builder helpers.
// ---------------------------------------------------------------------------

function makeEntry(opts) {
    return {
        field:      opts.field      || 'Court A',
        _activity:  opts.activity   || 'Basketball',
        type:       opts.type       || 'sport',
        _blockType: opts.type       || 'sport',
        _startMin:  opts.startMin   ?? 540,
        _endMin:    opts.endMin     ?? 580,
        _grade:     opts.grade      || '1',
        continuation: opts.continuation || false,
    };
}

function makeFreeEntry(opts) {
    return {
        field:      'Free',
        _activity:  'Free',
        _startMin:  opts.startMin  ?? 600,
        _endMin:    opts.endMin    ?? 640,
        _grade:     opts.grade     || '1',
        _freeReason: opts.reason   || 'capacity_deficit',
        continuation: false,
    };
}

function makeSpecialEntry(opts) {
    return {
        field:      opts.field    || 'Art Room',
        _activity:  opts.activity || 'Pottery',
        type:       'special',
        _blockType: 'special',
        _startMin:  opts.startMin ?? 540,
        _endMin:    opts.endMin   ?? 580,
        _grade:     opts.grade    || '1',
        continuation: false,
    };
}

// Build mock callbacks backed by a local scheduleAssignments copy.
function makeMockCallbacks(scheduleAssignments) {
    // state wrapper so restore can swap the reference and all callbacks see the update.
    const state = { sa: JSON.parse(JSON.stringify(scheduleAssignments)) };

    return {
        get sa() { return state.sa; },
        countFrees: () => Object.values(state.sa)
            .reduce((n, slots) => n + (slots || [])
                .filter(e => e && e.field === 'Free' && !e.continuation).length, 0),
        snapshot: () => JSON.parse(JSON.stringify(state.sa)),
        restore:  (snap) => { state.sa = JSON.parse(JSON.stringify(snap)); },

        // Default moveBlock: moves the donor to the target slot, clears old slot.
        // Override per-test to inject failures.
        moveBlock: (bunk, donorSlotIdx, freeSlotIdx, donorEntry) => {
            const slots = state.sa[bunk];
            if (!slots) return false;
            const target = slots[freeSlotIdx];
            if (!target || target.field !== 'Free') return false;
            // Write donor to target.
            state.sa[bunk][freeSlotIdx] = {
                ...donorEntry,
                _startMin: target._startMin,
                _endMin:   target._endMin,
                _layoutSwapped: true,
            };
            // Clear donor's old slot to Free.
            const donorSlot = state.sa[bunk][donorSlotIdx] || {};
            state.sa[bunk][donorSlotIdx] = {
                field: 'Free', _activity: 'Free',
                _startMin: donorSlot._startMin, _endMin: donorSlot._endMin,
                _grade:    donorSlot._grade,
                _freeReason: 'layout_swap_candidate',
                continuation: false,
            };
            return true;
        },

        // Default fillSlotWithSport: fills the slot with a Basketball entry (always succeeds).
        fillSlotWithSport: (bunk, slotIdx) => {
            const slots = state.sa[bunk];
            if (!slots || !slots[slotIdx]) return false;
            const slot = slots[slotIdx];
            state.sa[bunk][slotIdx] = {
                field: 'Court A', _activity: 'Basketball',
                type: 'sport', _blockType: 'sport',
                _startMin: slot._startMin, _endMin: slot._endMin,
                _grade: slot._grade,
                continuation: false,
            };
            return true;
        },
    };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('AutoLayoutSwap — exposure', () => {
    it('exposes window.AutoLayoutSwap with run, proposeSwaps, applySwap', () => {
        const sb = setup();
        const als = sb.window.AutoLayoutSwap;
        assert.ok(als, 'AutoLayoutSwap must be on window');
        assert.equal(typeof als.run,          'function');
        assert.equal(typeof als.proposeSwaps, 'function');
        assert.equal(typeof als.applySwap,    'function');
        assert.equal(typeof als.VERSION,      'string');
    });
});

describe('AutoLayoutSwap — proposeSwaps (analysis)', () => {
    it('returns a proposal when donor window covers the Free slot', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const layers = [
            // Pottery window covers both slots (540-700).
            { type: 'special', event: 'Pottery', startMin: 540, endMin: 700 }
        ];
        const proposals = sb.window.AutoLayoutSwap.proposeSwaps(sa, layers);
        assert.ok(proposals.length > 0, 'should produce at least one proposal');
        const p = proposals[0];
        assert.equal(p.donor.activity, 'Pottery');
        assert.equal(p.donor.slotIdx, 0, 'donor at slot 0');
        assert.equal(p.free.slotIdx,  1, 'free at slot 1');
    });

    it('returns NO proposal when Free is outside donor layer window', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 800, endMin: 840, grade: '1' }),   // 1:20pm — outside Pottery window
            ]
        };
        const layers = [
            { type: 'special', event: 'Pottery', startMin: 540, endMin: 700 }   // window ends 11:40am
        ];
        const proposals = sb.window.AutoLayoutSwap.proposeSwaps(sa, layers);
        assert.equal(proposals.length, 0, 'window violation → no proposal');
    });

    it('returns NO proposal when duration mismatches', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),  // 40 min
                makeFreeEntry({ startMin: 600, endMin: 660, grade: '1' }),                           // 60 min
            ]
        };
        const layers = [{ type: 'special', event: 'Pottery', startMin: 540, endMin: 700 }];
        const proposals = sb.window.AutoLayoutSwap.proposeSwaps(sa, layers);
        assert.equal(proposals.length, 0, 'duration mismatch → no proposal');
    });

    it('scores proposals by donor start time — earlier donors first', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Archery', startMin: 620, endMin: 660, grade: '1' }),
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 700, endMin: 740, grade: '1' }),
            ]
        };
        const layers = [
            { type: 'special', event: 'Archery', startMin: 540, endMin: 800 },
            { type: 'special', event: 'Pottery', startMin: 540, endMin: 800 },
        ];
        const proposals = sb.window.AutoLayoutSwap.proposeSwaps(sa, layers);
        assert.ok(proposals.length >= 2);
        // Pottery (540) should come before Archery (620).
        assert.equal(proposals[0].donor.activity, 'Pottery', 'earlier donor ranked first');
    });

    it('ignores anchor-type blocks (sport, lunch, swim) as donors', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeEntry({ field: 'Pool', activity: 'Swim', type: 'swim', startMin: 540, endMin: 580 }),
                makeFreeEntry({ startMin: 600, endMin: 640 }),
            ]
        };
        const layers = [{ type: 'swim', grade: '1', startMin: 540, endMin: 700 }];
        const proposals = sb.window.AutoLayoutSwap.proposeSwaps(sa, layers);
        assert.equal(proposals.length, 0, 'swim is not a donor type');
    });
});

describe('AutoLayoutSwap — applySwap', () => {
    it('commits when moveBlock + fillSlotWithSport succeed and frees decrease', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const cbs = makeMockCallbacks(sa);
        const proposal = {
            donor: { bunk: 'B1', slotIdx: 0, activity: 'Pottery', startMin: 540, endMin: 580, grade: '1', entry: sa.B1[0] },
            free:  { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 },
        };
        const committed = sb.window.AutoLayoutSwap.applySwap(proposal, cbs);
        assert.equal(committed, true, 'swap should be committed');
        // After swap: slot 0 has Basketball (sport), slot 1 has Pottery (donor).
        assert.equal(cbs.sa.B1[0].field, 'Court A',  'donor slot now has sport');
        assert.equal(cbs.sa.B1[1]._activity, 'Pottery', 'free slot now has donor');
        assert.equal(cbs.countFrees(), 0, 'no Frees remaining');
    });

    it('rolls back when fillSlotWithSport fails and free count unchanged', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const cbs = makeMockCallbacks(sa);
        // Override: sport fill always fails.
        cbs.fillSlotWithSport = () => false;

        const proposal = {
            donor: { bunk: 'B1', slotIdx: 0, activity: 'Pottery', startMin: 540, endMin: 580, grade: '1', entry: sa.B1[0] },
            free:  { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 },
        };
        const committed = sb.window.AutoLayoutSwap.applySwap(proposal, cbs);
        assert.equal(committed, false, 'should not commit when sport fill fails');
        // State should be restored to original.
        assert.equal(cbs.sa.B1[0]._activity, 'Pottery', 'slot 0 restored to donor');
        assert.equal(cbs.sa.B1[1].field, 'Free',        'slot 1 restored to Free');
        assert.equal(cbs.countFrees(), 1, 'Free count unchanged');
    });

    it('rolls back when moveBlock returns false (same-day repeat / rules violation)', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const cbs = makeMockCallbacks(sa);
        // Override: move rejected (e.g. same-day repeat detected by rules check).
        cbs.moveBlock = () => false;

        const proposal = {
            donor: { bunk: 'B1', slotIdx: 0, activity: 'Pottery', startMin: 540, endMin: 580, grade: '1', entry: sa.B1[0] },
            free:  { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 },
        };
        const committed = sb.window.AutoLayoutSwap.applySwap(proposal, cbs);
        assert.equal(committed, false, 'should not commit when moveBlock rejects');
        // State unchanged.
        assert.equal(cbs.sa.B1[0]._activity, 'Pottery', 'slot 0 unchanged');
        assert.equal(cbs.sa.B1[1].field, 'Free',        'slot 1 unchanged');
    });

    it('rolls back when moveBlock throws an exception', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const cbs = makeMockCallbacks(sa);
        cbs.moveBlock = () => { throw new Error('simulated error'); };

        const proposal = {
            donor: { bunk: 'B1', slotIdx: 0, activity: 'Pottery', startMin: 540, endMin: 580, grade: '1', entry: sa.B1[0] },
            free:  { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 },
        };
        assert.doesNotThrow(() => sb.window.AutoLayoutSwap.applySwap(proposal, cbs),
            'applySwap should not propagate exceptions');
        // State restored.
        assert.equal(cbs.sa.B1[0]._activity, 'Pottery');
        assert.equal(cbs.sa.B1[1].field, 'Free');
    });
});

describe('AutoLayoutSwap — run (end-to-end)', () => {
    it('applies a swap when it is the only way to reduce Frees', () => {
        const sb = setup();
        // B1 has Pottery at slot 0 (sport-friendly morning) and a Free at slot 1
        // (sport-hostile afternoon). Pottery's layer window covers slot 1.
        // After swap: slot 0 gets Basketball, slot 1 gets Pottery. Frees: 0.
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const layers = [{ type: 'special', event: 'Pottery', startMin: 540, endMin: 700 }];
        const cbs = makeMockCallbacks(sa);

        const result = sb.window.AutoLayoutSwap.run({
            scheduleAssignments: cbs.sa,
            layers,
            callbacks: cbs,
        });

        assert.equal(result.totalSwaps, 1, 'exactly one swap applied');
        assert.equal(cbs.countFrees(), 0, 'no Frees after swap');
    });

    it('does not commit a swap when no proposal reduces Frees', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ]
        };
        const layers = [{ type: 'special', event: 'Pottery', startMin: 540, endMin: 700 }];
        const cbs = makeMockCallbacks(sa);
        // Both move and fill reject — net frees unchanged.
        cbs.fillSlotWithSport = () => false;

        const result = sb.window.AutoLayoutSwap.run({
            scheduleAssignments: cbs.sa,
            layers,
            callbacks: cbs,
        });

        assert.equal(result.totalSwaps, 0, 'no swap committed when no improvement');
        assert.equal(cbs.countFrees(), 1, 'Free count unchanged');
    });

    it('stops iterating when no improvement found in a pass', () => {
        const sb = setup();
        const sa = { B1: [makeFreeEntry({ startMin: 540, endMin: 580 })] };
        const layers = [];   // no donors → no proposals
        const cbs = makeMockCallbacks(sa);

        let moveCallCount = 0;
        cbs.moveBlock = () => { moveCallCount++; return false; };

        sb.window.AutoLayoutSwap.run({ scheduleAssignments: cbs.sa, layers, callbacks: cbs });
        assert.equal(moveCallCount, 0, 'no move attempted when no proposals');
    });

    it('applies multiple swaps across different bunks in one run', () => {
        const sb = setup();
        const sa = {
            B1: [
                makeSpecialEntry({ activity: 'Pottery', startMin: 540, endMin: 580, grade: '1' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '1' }),
            ],
            B2: [
                makeSpecialEntry({ activity: 'Archery', startMin: 540, endMin: 580, grade: '2' }),
                makeFreeEntry({ startMin: 600, endMin: 640, grade: '2' }),
            ],
        };
        const layers = [
            { type: 'special', event: 'Pottery', startMin: 540, endMin: 700 },
            { type: 'special', event: 'Archery',  startMin: 540, endMin: 700 },
        ];
        const cbs = makeMockCallbacks(sa);

        const result = sb.window.AutoLayoutSwap.run({
            scheduleAssignments: cbs.sa,
            layers,
            callbacks: cbs,
        });

        assert.equal(result.totalSwaps, 2, 'one swap per bunk');
        assert.equal(cbs.countFrees(), 0,  'all Frees resolved');
    });

    it('respects maxSwapsPerIter limit', () => {
        const sb = setup();
        // 5 Frees on B1, each with a donor.
        const slots = [];
        for (let i = 0; i < 5; i++) {
            slots.push(makeSpecialEntry({ activity: 'Pottery', startMin: 540 + i * 40, endMin: 580 + i * 40 }));
        }
        for (let i = 0; i < 5; i++) {
            slots.push(makeFreeEntry({ startMin: 740 + i * 40, endMin: 780 + i * 40 }));
        }
        const sa = { B1: slots };
        const layers = [{ type: 'special', event: 'Pottery', startMin: 540, endMin: 1200 }];
        const cbs = makeMockCallbacks(sa);

        let moveCount = 0;
        const origMove = cbs.moveBlock.bind(cbs);
        cbs.moveBlock = (...args) => { moveCount++; return origMove(...args); };

        sb.window.AutoLayoutSwap.run({
            scheduleAssignments: cbs.sa,
            layers,
            callbacks: cbs,
            maxSwapsPerIter: 2,   // only try 2 per iteration
        });

        assert.ok(moveCount <= 2 * 3, 'moveBlock called at most maxSwapsPerIter * maxIterations times');
    });
});

describe('AutoLayoutSwap — internal helpers', () => {
    it('isDonorCompatibleWithFree: same bunk, same duration, window ok → true', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.isDonorCompatibleWithFree;
        const donor = { bunk: 'B1', slotIdx: 0, startMin: 540, endMin: 580, layerWindowStart: 540, layerWindowEnd: 700 };
        const free  = { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 };
        assert.equal(fn(donor, free), true);
    });

    it('isDonorCompatibleWithFree: different bunk → false', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.isDonorCompatibleWithFree;
        const donor = { bunk: 'B1', slotIdx: 0, startMin: 540, endMin: 580, layerWindowStart: null, layerWindowEnd: null };
        const free  = { bunk: 'B2', slotIdx: 1, startMin: 600, endMin: 640 };
        assert.equal(fn(donor, free), false, 'different bunk → false');
    });

    it('isDonorCompatibleWithFree: duration mismatch → false', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.isDonorCompatibleWithFree;
        const donor = { bunk: 'B1', slotIdx: 0, startMin: 540, endMin: 580, layerWindowStart: null, layerWindowEnd: null };
        const free  = { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 660 };   // 60 min vs 40 min
        assert.equal(fn(donor, free), false, 'duration mismatch → false');
    });

    it('isDonorCompatibleWithFree: free slot before layer window start → false', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.isDonorCompatibleWithFree;
        const donor = { bunk: 'B1', slotIdx: 0, startMin: 660, endMin: 700, layerWindowStart: 650, layerWindowEnd: 900 };
        const free  = { bunk: 'B1', slotIdx: 1, startMin: 600, endMin: 640 };   // before window start 650
        assert.equal(fn(donor, free), false, 'free before layerWindowStart → false');
    });

    it('isDonorCompatibleWithFree: free slot after layer window end → false', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.isDonorCompatibleWithFree;
        const donor = { bunk: 'B1', slotIdx: 0, startMin: 540, endMin: 580, layerWindowStart: 540, layerWindowEnd: 620 };
        const free  = { bunk: 'B1', slotIdx: 1, startMin: 660, endMin: 700 };   // ends at 700 > window end 620
        assert.equal(fn(donor, free), false, 'free after layerWindowEnd → false');
    });

    it('findFrees skips filled slots and continuation entries', () => {
        const sb = setup();
        const fn = sb.window.AutoLayoutSwap._internal.findFrees;
        const sa = {
            B1: [
                { field: 'Court A', _activity: 'Basketball' },                          // filled — skip
                { field: 'Free', _activity: 'Free', continuation: true, _startMin: 540 }, // continuation — skip
                { field: 'Free', _activity: 'Free', _startMin: 600, _endMin: 640 },      // real Free
            ]
        };
        const frees = fn(sa);
        assert.equal(frees.length, 1);
        assert.equal(frees[0].slotIdx, 2);
    });
});
