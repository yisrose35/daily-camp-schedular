// =============================================================================
// auto_build_solver_adapter.js — Campistry Auto Build Solver Adapter v1.0.0
// =============================================================================
//
// PURPOSE:
//   Bridges the AutoBuildEngine output into runSkeletonOptimizer without any
//   cross-contamination of manual-mode state.  This is the replacement for the
//   ad-hoc "call runSkeletonOptimizer with result.skeleton" code scattered across
//   auto_schedule_planner.js and daily_adjustments.js.
//
// THE CORE PROBLEM THIS SOLVES:
//   runSkeletonOptimizer was designed for the manual pipeline.  Calling it
//   directly from auto mode causes several issues:
//
//   1. STEP 2 reads bunk overrides from loadCurrentDailyData('bunkActivityOverrides')
//      OR from window._autoBunkOverrides — two sources with no clear priority.
//      The adapter guarantees the auto overrides are always in the right place.
//
//   2. STEP 0 does an RBAC-aware wipe — but auto mode already wiped in Prep.
//      The adapter disables the redundant STEP 0 wipe so we don't double-wipe.
//
//   3. division_times_integration.js wraps runSkeletonOptimizer to rebuild
//      divisionTimes from whatever skeleton it can find.  In auto mode divisionTimes
//      was already built correctly by AutoBuildPrep.  The adapter signals the
//      integration layer to skip its rebuild.
//
//   4. The optimizer's skeleton parameter is used correctly — auto skeleton is
//      passed directly and never pulled from manual storage paths.
//
// RESPONSIBILITIES:
//   - Configure window globals for auto-mode solver run
//   - Call the (division_times_integration.js-wrapped) runSkeletonOptimizer
//     with the correct arguments and skip flags
//   - Restore original solver state after completion
//   - Surface any solver errors cleanly
//
// PUBLIC API:
//   window.AutoBuildSolverAdapter.run(engineResult, options) → Promise<{ok, error}>
//
// =============================================================================

(function () {
    'use strict';

    var VERSION = '1.0.0';

    function log()  { console.log.apply(console,  ['[AutoBuildSolverAdapter]'].concat(Array.prototype.slice.call(arguments))); }
    function warn() { console.warn.apply(console, ['[AutoBuildSolverAdapter]'].concat(Array.prototype.slice.call(arguments))); }
    function err()  { console.error.apply(console,['[AutoBuildSolverAdapter]'].concat(Array.prototype.slice.call(arguments))); }

    // =========================================================================
    // ADAPTER FLAGS
    // These are read by the integration layer and solver during auto runs.
    // They are always cleaned up in the finally block.
    // =========================================================================

    var _autoRunActive = false;

    function _setAutoFlags(on) {
        // Signals division_times_integration.js to skip its skeleton-based rebuild
        // (our divisionTimes is already correct from AutoBuildPrep).
        window._autoBuildRunActive = on;

        // Signals scheduler_core_main STEP 0 to skip the redundant wipe
        // (AutoBuildPrep already did the full wipe).
        window._skipGenerationWipe = on;

        _autoRunActive = on;
    }

    // =========================================================================
    // GUARD: ENSURE STEP 2 BUNK OVERRIDES ARE IN PLACE
    // =========================================================================
    //
    // scheduler_core_main STEP 2 reads:
    //   window.loadCurrentDailyData?.('bunkActivityOverrides')
    // AND falls back to:
    //   window._autoBunkOverrides
    //
    // AutoBuildPrep already stored overrides in both places via
    // saveCurrentDailyData('bunkActivityOverrides').  This function is a
    // belt-and-suspenders check that runs just before the solver starts.

    function _ensureBunkOverrides(engineResult) {
        var overrides = engineResult.bunkOverrides || [];
        if (overrides.length === 0) return;

        // Guarantee the window global is set (primary STEP 2 source in auto mode)
        if (!window._autoBunkOverrides || window._autoBunkOverrides.length === 0) {
            window._autoBunkOverrides = overrides;
            log('Re-set _autoBunkOverrides (' + overrides.length + ') before solver run');
        }
    }

    // =========================================================================
    // GUARD: SKELETON INTEGRITY CHECK
    // =========================================================================
    //
    // Before handing the skeleton to the solver, verify it looks sane.
    // Returns { ok: true } or { ok: false, error: string }.

    function _validateSkeleton(skeleton) {
        if (!skeleton || !Array.isArray(skeleton)) {
            return { ok: false, error: 'Skeleton is not an array' };
        }
        if (skeleton.length === 0) {
            return { ok: false, error: 'Skeleton is empty' };
        }

        var hasDivision = skeleton.some(function(b) {
            return b && (b.division || b.divName);
        });
        if (!hasDivision) {
            return { ok: false, error: 'Skeleton blocks have no division property' };
        }

        return { ok: true };
    }

    // =========================================================================
    // MAIN RUN
    // =========================================================================

    async function run(engineResult, options) {
        options = options || {};

        var skeleton  = engineResult.skeleton  || [];
        var dateKey   = options.dateKey
            || window.currentScheduleDate
            || new Date().toISOString().split('T')[0];

        // Validate skeleton before touching any state
        var validation = _validateSkeleton(skeleton);
        if (!validation.ok) {
            return { ok: false, error: validation.error };
        }

        log('='.repeat(60));
        log('AUTO BUILD SOLVER ADAPTER — ' + dateKey);
        log(skeleton.length + ' skeleton blocks, ' + (engineResult.bunkOverrides?.length || 0) + ' bunk overrides');
        log('='.repeat(60));

        // Set flag so optimizer knows it's in auto mode
        _setAutoFlags(true);
        // Mark generation in progress (prevents remote merges during generation)
        window._generationInProgress = true;

        try {
            // Belt-and-suspenders: make sure bunk overrides are accessible
            _ensureBunkOverrides(engineResult);

            // Resolve the optimizer function.
            // division_times_integration.js wraps runSkeletonOptimizer — we want
            // the wrapped version so it fires the integration layer's pre-checks.
            // However, since AutoBuildPrep already locked divisionTimes, the
            // integration layer's rebuild will be a no-op (skeleton param is used
            // as-is and divisionTimes is not restored from storage).
            var optimizer = window.runSkeletonOptimizer;
            if (typeof optimizer !== 'function') {
                return { ok: false, error: 'runSkeletonOptimizer not available' };
            }

            // Determine which divisions to generate.
            // In auto mode we always generate all divisions the engine produced.
            var allowedDivisions = options.allowedDivisions || null;
            if (window.AccessControl?.filterDivisionsForGeneration) {
                allowedDivisions = window.AccessControl.filterDivisionsForGeneration(allowedDivisions);
                if (allowedDivisions.length === 0) {
                    return { ok: false, error: 'No divisions assigned to this user — contact camp owner' };
                }
                log('RBAC filtered divisions:', allowedDivisions);
            }

            // Call the optimizer.
            // Signature: runSkeletonOptimizer(manualSkeleton, externalOverrides, allowedDivisions, existingScheduleSnapshot, existingUnifiedTimes)
            // We pass the auto skeleton as the first argument so it is never
            // read from any storage path.
            var externalOverrides = options.externalOverrides || null;
            var existingSnapshot  = options.existingSnapshot  || null;
            var existingUnified   = options.existingUnified   || null;

            log('Calling runSkeletonOptimizer with', skeleton.length, 'blocks...');
            var optimizerResult = await optimizer(
                skeleton,
                externalOverrides,
                allowedDivisions,
                existingSnapshot,
                existingUnified
            );

            if (optimizerResult === false) {
                return { ok: false, error: 'runSkeletonOptimizer returned false (RBAC or empty schedule)' };
            }

            log('Solver completed successfully');
            return { ok: true };

        } catch (e) {
            err('Solver threw:', e);
            return { ok: false, error: String(e) };

        } finally {
            // Always clean up flags
            _setAutoFlags(false);
            window._generationInProgress = false;
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.AutoBuildSolverAdapter = {
        VERSION,
        run,
        isAutoRunActive: function () { return _autoRunActive; }
    };

    log('Auto Build Solver Adapter v' + VERSION + ' loaded');

})();
