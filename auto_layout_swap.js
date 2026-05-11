// =============================================================================
// auto_layout_swap.js — PHASE C: Layout Renegotiation ("brain" step)
// =============================================================================
//
// Runs as Step 4.97 — after the rule safety net (Step 4.95), before Phase 5
// save. Only fires when Free blocks remain after the full pipeline.
//
// INSIGHT: The solver fills slots greedily in sequence. A special placed at
// time T1 (sport-friendly window, good field availability) blocks a sport from
// going there. If a Free exists at T2 (sport-hostile window, capacity deficit)
// and T2 is within the special's layer window, we can swap: move the special
// to T2 (it doesn't compete for sport fields) and fill T1 with a sport.
// Net result: one fewer Free.
//
// ALGORITHM:
//   For each remaining Free block F at (bunk, T2):
//     For each placed special/league D at (bunk, T1) whose layer window
//     contains T2 and whose duration matches:
//       snapshot → move D to T2 → try fillSlotWithSport at T1 →
//       if countFrees() decreased → commit; else restore
//   Repeat until no swap improves (max 3 iterations).
//
// WRITE PATHS: This module does NOT write to scheduleAssignments itself.
// All writes go through caller-provided callbacks that wrap the existing
// four legal write paths:
//   moveBlock  → path 2 (_runRulesCheck + direct write to Free slot)
//   fillSlotWithSport → path 1 (commitWriteIfLegal via lnsRepair)
//
// TEST CONVENTION: loadable into a vm sandbox via loadInto('auto_layout_swap.js', ctx).
// Callbacks are mocked; no browser globals required.
//
// =============================================================================

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const TAG = '[AutoLayoutSwap]';

    function log(msg) { try { console.log(TAG + ' ' + msg); } catch (_) {} }
    function warn(msg) { try { console.warn(TAG + ' ⚠ ' + msg); } catch (_) {} }

    // -------------------------------------------------------------------------
    // Block types that can serve as donors.
    // Anchors (lunch, swim, snack, change, transition) are NEVER moved.
    // -------------------------------------------------------------------------
    const DONOR_TYPES = new Set(['special', 'league', 'specialty_league', 'rotation_event']);

    // -------------------------------------------------------------------------
    // Build a registry of every placed moveable block in scheduleAssignments.
    // Each entry records the block's current slot, timing, and the layer's
    // allowed time window (so we can check if the donor can go to a Free slot).
    // -------------------------------------------------------------------------
    function buildPlacementRegistry(scheduleAssignments, layers) {
        // Index layers by activity name so we can quickly look up the window.
        const layerByActivity = new Map();
        for (const layer of (layers || [])) {
            const t = (layer.type || '').toLowerCase();
            if (!DONOR_TYPES.has(t)) continue;
            const name = layer.event || layer.name || layer.activity || '';
            if (name && !layerByActivity.has(name)) layerByActivity.set(name, layer);
        }

        const registry = [];
        for (const [bunk, slots] of Object.entries(scheduleAssignments || {})) {
            if (!Array.isArray(slots)) continue;
            slots.forEach((entry, slotIdx) => {
                if (!entry || entry.field === 'Free' || entry.continuation) return;
                const blockType = (entry.type || entry._blockType || '').toLowerCase();
                if (!DONOR_TYPES.has(blockType)) return;
                const activity = entry._activity || entry.sport || entry.event || '';
                const layer = layerByActivity.get(activity) || null;
                registry.push({
                    bunk:             String(bunk),
                    slotIdx,
                    entry,            // full entry (for reinsertion at target slot)
                    activity,
                    blockType,
                    startMin:         entry._startMin ?? null,
                    endMin:           entry._endMin   ?? null,
                    grade:            entry._grade    || null,
                    layerWindowStart: layer ? (layer.startMin ?? layer.startMin ?? null) : null,
                    layerWindowEnd:   layer ? (layer.endMin   ?? layer.endMin   ?? null) : null,
                });
            });
        }
        return registry;
    }

    // -------------------------------------------------------------------------
    // Find all remaining Free blocks with their timing info.
    // -------------------------------------------------------------------------
    function findFrees(scheduleAssignments) {
        const frees = [];
        for (const [bunk, slots] of Object.entries(scheduleAssignments || {})) {
            if (!Array.isArray(slots)) continue;
            slots.forEach((entry, slotIdx) => {
                if (!entry || entry.field !== 'Free' || entry.continuation) return;
                frees.push({
                    bunk:     String(bunk),
                    slotIdx,
                    startMin: entry._startMin ?? null,
                    endMin:   entry._endMin   ?? null,
                    reason:   entry._freeReason || 'unknown',
                });
            });
        }
        return frees;
    }

    // -------------------------------------------------------------------------
    // Check whether a donor is structurally compatible with a Free slot.
    // Full legality (rules, same-day repeat, cooldowns) is enforced by the
    // moveBlock callback; this is a cheap pre-filter.
    // -------------------------------------------------------------------------
    function isDonorCompatibleWithFree(donor, free) {
        // Must be same bunk.
        if (donor.bunk !== free.bunk) return false;
        // Can't swap a slot with itself.
        if (donor.slotIdx === free.slotIdx) return false;
        // Both must have timing data.
        if (donor.startMin == null || donor.endMin == null) return false;
        if (free.startMin  == null || free.endMin  == null) return false;
        // Duration must match (the donor fills the Free's slot exactly).
        const donorDur = donor.endMin - donor.startMin;
        const freeDur  = free.endMin  - free.startMin;
        if (donorDur !== freeDur) return false;
        // Free slot's time must fall within the donor's layer window (if known).
        if (donor.layerWindowStart != null && free.startMin < donor.layerWindowStart) return false;
        if (donor.layerWindowEnd   != null && free.endMin   > donor.layerWindowEnd)   return false;
        return true;
    }

    // -------------------------------------------------------------------------
    // Generate ordered swap proposals.
    // Each proposal: move donor D (at T1) to free F (at T2), then try to fill
    // T1 with a sport. Proposals sorted: donors earliest in day first (morning
    // slots have better sport-field availability).
    // -------------------------------------------------------------------------
    function proposeSwaps(scheduleAssignments, layers) {
        const registry = buildPlacementRegistry(scheduleAssignments, layers);
        const frees    = findFrees(scheduleAssignments);

        const proposals = [];
        for (const free of frees) {
            for (const donor of registry) {
                if (!isDonorCompatibleWithFree(donor, free)) continue;
                // Score by how early the donor is — earlier = better sport availability.
                proposals.push({ donor, free, score: donor.startMin ?? 9999 });
            }
        }

        proposals.sort((a, b) => a.score - b.score);
        return proposals;
    }

    // -------------------------------------------------------------------------
    // Apply a single swap atomically via callbacks.
    // Returns true if the swap was committed (improved Free count).
    //
    // callbacks (all required):
    //   snapshot()                                → opaque snap object
    //   restore(snap)                             → void
    //   moveBlock(bunk, donorSlotIdx, freeSlotIdx, donorEntry) → bool
    //     Moves the donor from its current slot to the Free slot:
    //       1. Validates donor placement at the Free slot (rules check).
    //       2. Writes donor entry to freeSlotIdx (was Free → now donor).
    //       3. Clears donorSlotIdx to Free (was donor → now available).
    //       4. Rebuilds fieldUsageBySlot.
    //     Returns false if the move is illegal (window, repeat, rules).
    //   fillSlotWithSport(bunk, slotIdx)          → bool
    //     Attempts to place a sport at the newly-freed donorSlotIdx
    //     (via commitWriteIfLegal / lnsRepair). Returns true if a sport
    //     was placed.
    //   countFrees()                              → number
    // -------------------------------------------------------------------------
    function applySwap(proposal, callbacks) {
        const { donor, free } = proposal;
        const { snapshot, restore, moveBlock, fillSlotWithSport, countFrees } = callbacks;

        const freesBefore = countFrees();
        const snap = snapshot();

        try {
            // 1. Move the donor to the Free slot (path 2 in caller).
            const moved = moveBlock(donor.bunk, donor.slotIdx, free.slotIdx, donor.entry);
            if (!moved) { restore(snap); return false; }

            // 2. Attempt to fill the vacated slot with a sport (path 1 in caller).
            fillSlotWithSport(donor.bunk, donor.slotIdx);

            // 3. Commit only if Free count improved.
            if (countFrees() < freesBefore) {
                log('✅ Swap committed: bunk=' + donor.bunk
                    + ' moved "' + donor.activity + '" slot ' + donor.slotIdx
                    + '→' + free.slotIdx);
                return true;
            }

            restore(snap);
            return false;
        } catch (e) {
            try { restore(snap); } catch (_) {}
            warn('applySwap error: ' + (e && e.message));
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Main runner — called from Step 4.97.
    // opts:
    //   scheduleAssignments — current schedule (read for proposals)
    //   layers              — all grade layers (for window lookup)
    //   callbacks           — see applySwap above
    //   maxIterations       — outer loop bound (default 3)
    //   maxSwapsPerIter     — proposals tried per iteration (default 20)
    // -------------------------------------------------------------------------
    function run(opts) {
        const {
            scheduleAssignments,
            layers,
            callbacks,
            maxIterations   = 3,
            maxSwapsPerIter = 20,
        } = opts;

        let totalSwaps = 0;

        for (let iter = 0; iter < maxIterations; iter++) {
            const proposals = proposeSwaps(scheduleAssignments, layers);
            if (proposals.length === 0) break;

            let swappedThisIter = 0;
            let tried = 0;
            for (const proposal of proposals) {
                if (tried++ >= maxSwapsPerIter) break;
                if (applySwap(proposal, callbacks)) {
                    swappedThisIter++;
                    totalSwaps++;
                }
            }
            if (swappedThisIter === 0) break;   // no improvement this pass
        }

        log('Phase C complete: ' + totalSwaps + ' layout swap(s) applied');
        return { totalSwaps };
    }

    // -------------------------------------------------------------------------
    // Exports.
    // -------------------------------------------------------------------------
    const AutoLayoutSwap = {
        VERSION,
        run,
        proposeSwaps,
        applySwap,
        _internal: {
            buildPlacementRegistry,
            findFrees,
            isDonorCompatibleWithFree,
        },
    };

    if (typeof window !== 'undefined') window.AutoLayoutSwap = AutoLayoutSwap;
    if (typeof module !== 'undefined' && module.exports) module.exports = AutoLayoutSwap;
})();
