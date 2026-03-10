// =============================================================================
// bunk_engine_integration.js — Campistry Bunk Engine Integration v2.0
// =============================================================================
// Bridge between BunkScheduleEngine (placement) and total_solver_engine (assignment).
//
// v2.0 Changes:
//   ★ Complete rewrite of runBunkGeneration() to feed solver directly.
//   ★ buildPerBunkDivisionTimes(): each bunk gets its own slot array
//     (_isPerBunk mode). Handles the case where Bunk 1 has 2 slots 11-12
//     and Bunk 2 has 3 slots 11-12 — they're independent, no index collision.
//   ★ Locked slots (swim, lunch, snack) written to scheduleAssignments as
//     _fixed — solver skips them.
//   ★ activityBlocks built with correct per-bunk slot indices for unlocked
//     placeholder slots — solver fills specific activity + field.
//
// Flow:
//   daily_adjustments.runOptimizer()
//     → BunkEngineIntegration.handleAutoGenerate()
//       → runBunkGeneration()
//         → BunkScheduleEngine.build()         [Phases 0-4: placement only]
//         → buildPerBunkDivisionTimes()        [_isPerBunk slot arrays]
//         → write locked slots to scheduleAssignments
//         → buildActivityBlocks()              [typed placeholders for solver]
//         → Solver.solveSchedule()             [specific activity + field]
//         → persist + fire campistry-generation-complete
// =============================================================================

(function () {
    'use strict';

    var VERSION = '2.0.0';

    function log(msg) {
        console.log('[BunkEngineIntegration v' + VERSION + '] ' + msg);
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function fmtTime(min) {
        if (min == null) return '?';
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ap;
    }

    function isBunkMode() {
        var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return (gs.app1?.generationMode || gs.generationMode) === 'bunk';
    }

    // =========================================================================
    // PUBLIC ENTRY POINT
    // =========================================================================
    // Called by daily_adjustments.runOptimizer() when bunk mode is active.
    // Returns true if handled (prevents the caller from running the old pipeline).

    async function handleAutoGenerate(dateStr, daAutoLayers, showAlert) {
        if (!isBunkMode()) return false;

        log('handleAutoGenerate() called for ' + dateStr);

        var errorMsg = null;
        var successMsg = null;

        await runBunkGeneration(
            dateStr,
            daAutoLayers,
            function (msg) { successMsg = msg; },
            function (msg) { errorMsg = msg; }
        );

        if (errorMsg) {
            await showAlert('⚠️ ' + errorMsg);
        } else if (successMsg) {
            log(successMsg);
        }

        return true; // always handled — don't fall through to old pipeline
    }

    // =========================================================================
    // MAIN GENERATION PIPELINE
    // =========================================================================

    async function runBunkGeneration(dateStr, daAutoLayers, onComplete, onError) {
        if (!window.BunkScheduleEngine) {
            onError('BunkScheduleEngine not loaded');
            return;
        }
        // total_solver_engine exposes its solver via window._SolverInternals.Solver
        // (Part 1 sets _SolverInternals, Part 2 attaches solveSchedule to it)
        var Solver = window._SolverInternals?.Solver;
        if (!Solver?.solveSchedule) {
            onError('total_solver_engine not loaded (window._SolverInternals.Solver.solveSchedule missing — ensure both part1 and part2 are loaded)');
            return;
        }

        try {
            // ── 1. Full pre-generation wipe ──────────────────────────────
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            window.GlobalFieldLocks?.clearAllLocks?.();
            window._preGenClearActive = true;
            window._generationInProgress = true;

            log('Starting generation for ' + dateStr);

            // ── 2. Run BunkScheduleEngine (Phases 0-4) ───────────────────
            var result = window.BunkScheduleEngine.build({
                dateStr: dateStr,
                layers: daAutoLayers
            });

            window._preGenClearActive = false;
            window._generationInProgress = false;

            var bunkTimelines = result.bunkTimelines || {};
            var bunkCount = Object.keys(bunkTimelines).length;

            if (bunkCount === 0) {
                onError('BunkScheduleEngine produced no timelines — check layers');
                return;
            }

            log('BunkScheduleEngine produced ' + bunkCount + ' bunk timelines');

            // ── 3. Build per-bunk divisionTimes ──────────────────────────
            // Each bunk gets its own independent slot array.
            // Bunk 1 with 2 slots 11-12 and Bunk 2 with 3 slots 11-12
            // are handled cleanly — their slot indices are independent.
            var divisions = window.divisions ||
                window.loadGlobalSettings?.()?.app1?.divisions || {};

            var perBunkDivisionTimes = buildPerBunkDivisionTimes(bunkTimelines, divisions);
            window.divisionTimes = perBunkDivisionTimes;
            window._autoDivisionTimesBuilt = true;

            log('divisionTimes built (_isPerBunk mode) for ' +
                Object.keys(perBunkDivisionTimes).length + ' divisions');

            // ── 4. Initialize scheduleAssignments with correct slot counts ─
            Object.values(bunkTimelines).forEach(function (tl) {
                var bunkSlots = perBunkDivisionTimes[tl.divisionName]
                    ?._perBunkSlots?.[tl.bunkName] || [];
                window.scheduleAssignments[tl.bunkName] = new Array(bunkSlots.length).fill(null);
            });

            // ── 5. Write locked slots directly to scheduleAssignments ─────
            // Swim, lunch, snack, dismissal are already fully resolved.
            // Mark as _fixed so the solver leaves them alone.
            var lockedCount = 0;
            Object.values(bunkTimelines).forEach(function (tl) {
                var bunkSlots = perBunkDivisionTimes[tl.divisionName]
                    ?._perBunkSlots?.[tl.bunkName] || [];

                tl.slots.forEach(function (slot) {
                    if (!slot.locked) return;

                    var indices = findSlotIndices(bunkSlots, slot.startMin, slot.endMin);
                    if (indices.length === 0) return;

                    indices.forEach(function (idx, i) {
                        window.scheduleAssignments[tl.bunkName][idx] = {
                            _activity: slot.activity,
                            field: slot.field || null,
                            _fixed: true,
                            _autoGenerated: true,
                            _startMin: slot.startMin,
                            _endMin: slot.endMin,
                            continuation: i > 0
                        };
                    });

                    lockedCount++;
                });
            });

            log('Wrote ' + lockedCount + ' locked slots to scheduleAssignments');

            // ── 6. Build activityBlocks for the solver ────────────────────
            // One block per unlocked placeholder slot per bunk.
            // slot indices are per-bunk — Bunk 1 index 2 ≠ Bunk 2 index 2.
            var activityBlocks = buildActivityBlocks(bunkTimelines, perBunkDivisionTimes);

            if (activityBlocks.length === 0) {
                onError('No solvable slots found — check layer types and time windows');
                return;
            }

            log('Built ' + activityBlocks.length + ' activity blocks for solver');

            // ── 7. Build solver config ────────────────────────────────────
            var rotationHistory = window.loadRotationHistory?.() || {};
            var config = {
                activityProperties: window.activityProperties || {},
                rotationHistory: rotationHistory,
                divisions: divisions,
                dateStr: dateStr,
                _bunkMode: true
            };

            // ── 8. Run the solver ─────────────────────────────────────────
            log('Handing off to Solver.solveSchedule()...');
            Solver.solveSchedule(activityBlocks, config);

            // ── 9. Update rotation history ────────────────────────────────
            window.RotationEngine?.clearHistoryCache?.();

            // ── 10. Persist ───────────────────────────────────────────────
            window.saveCurrentDailyData?.('scheduleAssignments', window.scheduleAssignments);
            window.saveCurrentDailyData?.('_autoGenerated', true);
            window.saveCurrentDailyData?.('_generationMode', 'bunk');
            window.saveCurrentDailyData?.('divisionTimes', perBunkDivisionTimes);

            window.ScheduleDB?.saveSchedule?.(dateStr, {
                scheduleAssignments: window.scheduleAssignments,
                divisionTimes: perBunkDivisionTimes,
                _autoGenerated: true,
                _generationMode: 'bunk',
                savedAt: new Date().toISOString()
            });

            // ── 11. Fire completion event and update UI ───────────────────
            window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
                detail: {
                    dateKey: dateStr,
                    mode: 'bunk',
                    bunkCount: bunkCount
                }
            }));

            window.updateTable?.();

            var msg = '✅ Schedule Generated! (' + bunkCount + ' bunks';
            if (result.warnings?.length > 0) {
                msg += ', ' + result.warnings.length + ' warnings';
            }
            msg += ')';

            log('Generation complete: ' + msg);
            onComplete(msg, result);

        } catch (err) {
            window._preGenClearActive = false;
            window._generationInProgress = false;
            console.error('[BunkEngineIntegration] Generation failed:', err);
            onError('Generation error: ' + err.message);
        }
    }

    // =========================================================================
    // BUILD PER-BUNK DIVISION TIMES
    // =========================================================================
    // Converts bunkTimelines into the _isPerBunk divisionTimes structure.
    //
    // Key design: each bunk's slot array is built from ITS OWN timeline.
    // If Bunk 1 has slots [11:00-11:30, 11:30-12:00] and
    //    Bunk 2 has slots [11:00-11:20, 11:20-11:40, 11:40-12:00],
    // they get separate arrays — slot index 1 means different times for each.
    //
    // The solver calls Utils._getPerBunkSlots(divSlots, bunkName) which
    // already handles this correctly when _isPerBunk is true.

    function buildPerBunkDivisionTimes(bunkTimelines, divisions) {
        var divisionTimes = {};

        // Group timelines by division
        var byDiv = {};
        Object.values(bunkTimelines).forEach(function (tl) {
            if (!byDiv[tl.divisionName]) byDiv[tl.divisionName] = [];
            byDiv[tl.divisionName].push(tl);
        });

        Object.keys(byDiv).forEach(function (divName) {
            var divGroup = byDiv[divName];
            var perBunkSlots = {};

            divGroup.forEach(function (tl) {
                // ALL slots (locked + unlocked) go in the array — indices must
                // cover the full day so scheduleAssignments is correctly sized.
                perBunkSlots[tl.bunkName] = tl.slots.map(function (slot) {
                    return {
                        startMin: slot.startMin,
                        endMin: slot.endMin,
                        label: fmtTime(slot.startMin) + ' - ' + fmtTime(slot.endMin),
                        _locked: slot.locked || false,
                        _activityType: slot.activityType,
                        _source: slot.source
                    };
                });
            });

            // Max slot count across all bunks in this division
            var maxLen = Math.max.apply(null,
                Object.values(perBunkSlots).map(function (s) { return s.length; })
            );

            divisionTimes[divName] = {
                _isPerBunk: true,
                _perBunkSlots: perBunkSlots,
                // Provide length for code that reads divisionTimes[div].length
                length: maxLen
            };

            log('divisionTimes[' + divName + ']: _isPerBunk, ' +
                Object.keys(perBunkSlots).length + ' bunks, max ' + maxLen + ' slots');
        });

        return divisionTimes;
    }

    // =========================================================================
    // FIND SLOT INDICES
    // =========================================================================
    // Given a bunk's slot array and a time range, returns which slot indices
    // the range overlaps. Used when writing locked slots and building blocks.

    function findSlotIndices(bunkSlots, startMin, endMin) {
        var indices = [];
        for (var i = 0; i < bunkSlots.length; i++) {
            var s = bunkSlots[i];
            if (s.startMin < endMin && s.endMin > startMin) {
                indices.push(i);
            }
        }
        return indices;
    }

    // =========================================================================
    // BUILD ACTIVITY BLOCKS FOR SOLVER
    // =========================================================================
    // Converts unlocked bunk timeline slots into the exact format that
    // Solver.solveSchedule(activityBlocks, config) expects.
    //
    // Each block:
    //   bunk    — bunk name (string)
    //   divName — division name (string)
    //   slots   — array of slot INDICES into this bunk's own slot array
    //   startTime / endTime — minutes (integer), for field conflict detection
    //   event   — activity type hint ('sports', 'special', 'activity')
    //   type    — always 'slot'
    //
    // Locked slots are skipped — already written to scheduleAssignments as _fixed.
    // 'free' and 'change' type slots are also skipped.

    function buildActivityBlocks(bunkTimelines, perBunkDivisionTimes) {
        var activityBlocks = [];
        var skipped = 0;

        Object.values(bunkTimelines).forEach(function (tl) {
            var bunkSlots = perBunkDivisionTimes[tl.divisionName]
                ?._perBunkSlots?.[tl.bunkName] || [];

            tl.slots.forEach(function (slot) {
                // Skip locked slots — already in scheduleAssignments as _fixed
                if (slot.locked) return;

                // Skip non-solvable types
                var type = (slot.activityType || '').toLowerCase();
                if (type === 'free' || type === 'change' || type === 'break') {
                    skipped++;
                    return;
                }

                // Find slot indices for this time range in this bunk's own array
                var slotIndices = findSlotIndices(bunkSlots, slot.startMin, slot.endMin);

                if (slotIndices.length === 0) {
                    console.warn('[BunkEngineIntegration] No slot indices found for',
                        tl.bunkName, fmtTime(slot.startMin), '-', fmtTime(slot.endMin));
                    return;
                }

                activityBlocks.push({
                    bunk: tl.bunkName,
                    divName: tl.divisionName,
                    slots: slotIndices,
                    startTime: slot.startMin,   // integer minutes — field conflict checks
                    endTime: slot.endMin,
                    event: slot.activityType,   // type only — solver picks specific activity
                    type: 'slot',
                    _autoGenerated: true,
                    _bunkMode: true
                });
            });
        });

        if (skipped > 0) {
            log('Skipped ' + skipped + ' free/change/locked slots');
        }

        return activityBlocks;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.BunkEngineIntegration = {
        isBunkMode: isBunkMode,
        handleAutoGenerate: handleAutoGenerate,
        // Exposed for diagnostics / testing
        buildPerBunkDivisionTimes: buildPerBunkDivisionTimes,
        buildActivityBlocks: buildActivityBlocks,
        VERSION: VERSION
    };

    log('Loaded v' + VERSION);

})();
