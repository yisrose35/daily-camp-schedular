
// =============================================================================
// auto_joint_placer.js — JOINT GRADE-WIDE PLACEMENT CSP v1.0
// =============================================================================
// Places all grade-wide blocks (swim, leagues, snacks) JOINTLY across all
// grades in a single coupled CSP with backtracking search.
//
// WHY: Sequential placement (place swim for grade 1, then grade 2...) boxes
// later grades into corners. Joint placement considers all grades simultaneously,
// finding a globally consistent assignment.
//
// ALGORITHM:
//   1. Build variables: one per (grade, grade-wide-activity) pair
//   2. Build domains: feasible start times for each variable
//   3. Search: backtracking with MRV ordering + forward checking
//   4. Return: mapping of (grade, activity) → (startMin, endMin)
//
// INTEGRATES WITH: scheduler_core_auto.js Phase 0
//   - Replaces sequential placeLeagueForGrade calls
//   - Uses same field ledger, resource tracker, and constraint checks
// =============================================================================

(function () {
    'use strict';

    const TAG = '[JointPlacer]';
    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ⚠️ ' + msg, ...args); }

    const TIME_STEP = 5; // 5-minute increments for domain generation

    // =========================================================================
    // MAIN ENTRY
    // =========================================================================

    /**
     * Jointly place all grade-wide blocks.
     *
     * @param {Object} params
     * @param {Object} params.divisions        — window.divisions
     * @param {Array}  params.gradeWideBlocks   — Array of { grade, type, event, layer, dMin, dMax, windowStart, windowEnd, needsPool, needsField, fieldName }
     * @param {Function} params.isFieldAvailable — (fieldName, startMin, endMin, bunk, grade, activity) => boolean
     * @param {Function} params.canUsePoolAtTime — (grade, startMin, endMin) => boolean
     * @param {Function} params.canUseSpecialAtTime — (specialName, grade, startMin, endMin) => boolean
     * @param {Function} params.claimField       — (fieldName, startMin, endMin, bunk, grade, activity) => void
     * @param {Function} params.rtRegister       — (type, name, grade, startMin, endMin) => void
     * @param {Object} params.bunkTimelines     — current timelines (to check existing walls)
     * @param {Function} params.getBunksForGrade — (grade) => bunk[]
     * @param {number} params.seed              — iteration seed for tie-breaking
     *
     * @returns {{ success: boolean, placements: Array<{grade, type, event, startMin, endMin, duration}>, unplaced: Array }}
     */
    function solve(params) {
        const {
            divisions, gradeWideBlocks, isFieldAvailable, canUsePoolAtTime,
            canUseSpecialAtTime, claimField, rtRegister, bunkTimelines,
            getBunksForGrade, seed
        } = params;

        if (!gradeWideBlocks || gradeWideBlocks.length === 0) {
            return { success: true, placements: [], unplaced: [] };
        }

        const startMs = Date.now();

        // -----------------------------------------------------------------
        // STEP 1: Build variables
        // -----------------------------------------------------------------
        const variables = gradeWideBlocks.map((block, idx) => ({
            id: idx,
            grade: block.grade,
            type: block.type,
            event: block.event,
            layer: block.layer,
            dMin: block.dMin || 30,
            dMax: block.dMax || 60,
            windowStart: block.windowStart,
            windowEnd: block.windowEnd,
            needsPool: block.needsPool || false,
            needsField: block.needsField || false,
            fieldName: block.fieldName || null,
            assignment: null // { startMin, endMin, duration }
        }));

        // -----------------------------------------------------------------
        // STEP 2: Build domains (feasible start times)
        // -----------------------------------------------------------------
        variables.forEach(v => {
            v.domain = [];
            const dur = v.dMin; // Use minimum duration for domain generation
            for (let t = v.windowStart; t + dur <= v.windowEnd; t += TIME_STEP) {
                // Check against existing walls in ALL bunks of this grade
                const bunks = getBunksForGrade(v.grade);
                let blocked = false;
                for (const bunk of bunks) {
                    const tl = bunkTimelines[bunk] || [];
                    for (const wall of tl) {
                        if (!wall._fixed) continue;
                        if (t < wall.endMin && (t + dur) > wall.startMin) {
                            blocked = true;
                            break;
                        }
                    }
                    if (blocked) break;
                }
                if (!blocked) {
                    v.domain.push(t);
                }
            }
        });

        // -----------------------------------------------------------------
        // STEP 3: Backtracking search with MRV + forward checking
        // -----------------------------------------------------------------
        const solution = backtrack(variables, 0, params);

        const elapsed = Date.now() - startMs;
        log('Solved ' + variables.length + ' variables in ' + elapsed + 'ms');

        if (!solution) {
            // Partial fallback: return what we placed
            const placed = variables.filter(v => v.assignment !== null);
            const unplaced = variables.filter(v => v.assignment === null);
            warn('Could not place all grade-wide blocks. Placed: ' + placed.length + '/' + variables.length);
            return {
                success: false,
                placements: placed.map(v => ({
                    grade: v.grade, type: v.type, event: v.event,
                    layer: v.layer, fieldName: v.fieldName,
                    startMin: v.assignment.startMin, endMin: v.assignment.endMin,
                    duration: v.assignment.duration
                })),
                unplaced: unplaced.map(v => ({
                    grade: v.grade, type: v.type, event: v.event
                }))
            };
        }

        return {
            success: true,
            placements: variables.map(v => ({
                grade: v.grade, type: v.type, event: v.event,
                layer: v.layer, fieldName: v.fieldName,
                startMin: v.assignment.startMin, endMin: v.assignment.endMin,
                duration: v.assignment.duration
            })),
            unplaced: []
        };
    }

    // =========================================================================
    // BACKTRACKING SOLVER
    // =========================================================================

    function backtrack(variables, depth, params) {
        // All assigned?
        if (variables.every(v => v.assignment !== null)) {
            return true;
        }

        // MRV: pick the unassigned variable with smallest domain
        let bestVar = null;
        let bestDomainSize = Infinity;
        for (const v of variables) {
            if (v.assignment !== null) continue;
            const liveCount = countLiveDomain(v, variables, params);
            if (liveCount < bestDomainSize) {
                bestDomainSize = liveCount;
                bestVar = v;
            }
            if (liveCount === 0) break; // dead end, fail fast
        }

        if (!bestVar || bestDomainSize === 0) {
            return false;
        }

        // Try each value in domain, ordered by least-constraining-value
        const orderedDomain = orderValues(bestVar, variables, params);

        for (const startMin of orderedDomain) {
            const duration = computeBestDuration(bestVar, startMin, variables, params);
            if (duration < bestVar.dMin) continue;

            const endMin = startMin + duration;

            // Check constraints
            if (!isConsistent(bestVar, startMin, endMin, variables, params)) continue;

            // Assign
            bestVar.assignment = { startMin, endMin, duration };

            // Forward check: does any unassigned variable have an empty live domain?
            let fc = true;
            for (const v of variables) {
                if (v.assignment !== null) continue;
                if (countLiveDomain(v, variables, params) === 0) {
                    fc = false;
                    break;
                }
            }

            if (fc && backtrack(variables, depth + 1, params)) {
                return true;
            }

            // Undo
            bestVar.assignment = null;
        }

        return false;
    }

    // =========================================================================
    // CONSTRAINT CHECKING
    // =========================================================================

    /**
     * Check if assigning (startMin, endMin) to variable is consistent
     * with all already-assigned variables.
     */
    function isConsistent(variable, startMin, endMin, allVars, params) {
        const { canUsePoolAtTime, isFieldAvailable, getBunksForGrade } = params;

        // 1. Pool exclusivity: if this is swim, no other grade's swim can overlap
        if (variable.needsPool) {
            for (const other of allVars) {
                if (other === variable || other.assignment === null) continue;
                if (!other.needsPool) continue;
                if (other.grade === variable.grade) continue; // same grade OK
                // Different grade swim cannot overlap
                if (startMin < other.assignment.endMin && endMin > other.assignment.startMin) {
                    return false;
                }
            }
        }

        // 2. Same grade: no two grade-wide blocks for the same grade can overlap
        for (const other of allVars) {
            if (other === variable || other.assignment === null) continue;
            if (other.grade !== variable.grade) continue;
            if (startMin < other.assignment.endMin && endMin > other.assignment.startMin) {
                return false;
            }
        }

        // 3. Field exclusivity: if needs a specific field, check it
        if (variable.needsField && variable.fieldName) {
            const bunks = getBunksForGrade(variable.grade);
            if (bunks.length > 0) {
                if (!isFieldAvailable(variable.fieldName, startMin, endMin, String(bunks[0]), variable.grade, variable.event)) {
                    return false;
                }
            }

            // Also check against other variables that use the same field
            for (const other of allVars) {
                if (other === variable || other.assignment === null) continue;
                if (other.fieldName !== variable.fieldName) continue;
                if (other.grade === variable.grade) continue;
                if (startMin < other.assignment.endMin && endMin > other.assignment.startMin) {
                    return false;
                }
            }
        }

        // 4. Cross-grade resource conflicts for same-type activities
        // e.g., two league games on the same field at the same time
        if (variable.type === 'league' || variable.type === 'specialty_league') {
            for (const other of allVars) {
                if (other === variable || other.assignment === null) continue;
                if (other.type !== 'league' && other.type !== 'specialty_league') continue;
                if (other.grade === variable.grade) continue;
                // If they share an event/field, they can't overlap
                if (other.fieldName && variable.fieldName && other.fieldName === variable.fieldName) {
                    if (startMin < other.assignment.endMin && endMin > other.assignment.startMin) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    // =========================================================================
    // DOMAIN HELPERS
    // =========================================================================

    /**
     * Count how many values in v's domain are still feasible given current assignments.
     */
    function countLiveDomain(v, allVars, params) {
        let count = 0;
        for (const startMin of v.domain) {
            const dur = v.dMin;
            const endMin = startMin + dur;
            if (isConsistent(v, startMin, endMin, allVars, params)) {
                count++;
            }
        }
        return count;
    }

    /**
     * Order values by least-constraining-value heuristic.
     * Values that leave the most options for other variables come first.
     */
    function orderValues(variable, allVars, params) {
        const scored = variable.domain.map(startMin => {
            const endMin = startMin + variable.dMin;
            if (!isConsistent(variable, startMin, endMin, allVars, params)) {
                return { startMin, score: -Infinity };
            }

            // Temporarily assign and count remaining options for others
            variable.assignment = { startMin, endMin, duration: variable.dMin };
            let totalOptions = 0;
            for (const v of allVars) {
                if (v.assignment !== null && v !== variable) continue;
                if (v === variable) continue;
                totalOptions += countLiveDomain(v, allVars, params);
            }
            variable.assignment = null;

            return { startMin, score: totalOptions };
        });

        return scored
            .filter(s => s.score > -Infinity)
            .sort((a, b) => b.score - a.score)
            .map(s => s.startMin);
    }

    /**
     * Compute the best duration for a variable at a given start time.
     * Prefers dMin but can expand up to dMax if it doesn't cause conflicts.
     */
    function computeBestDuration(variable, startMin, allVars, params) {
        let bestDur = variable.dMin;

        // Try expanding toward dMax in 5-min increments
        for (let d = variable.dMin + TIME_STEP; d <= variable.dMax; d += TIME_STEP) {
            if (startMin + d > variable.windowEnd) break;
            if (isConsistent(variable, startMin, startMin + d, allVars, params)) {
                bestDur = d;
            } else {
                break;
            }
        }

        return bestDur;
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.AutoJointPlacer = { solve };

})();
