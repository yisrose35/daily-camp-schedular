// =============================================================================
// auto_solver_engine.js — PURPOSE-BUILT SOLVER FOR AUTO BUILDER v1.0
// =============================================================================
//
// CONTEXT: By the time this solver runs, the auto builder pipeline has already
// placed ALL of these via the greedy packer:
//   ✅ Pinned layers (lunch, dismissal, custom)
//   ✅ Leagues (grade-wide, staggered)
//   ✅ Swim (pool-exclusive, rotation-aware)
//   ✅ Snacks (windowed)
//   ✅ Specials (capacity + cross-division enforced)
//   ✅ Capacity-checked sports (field ledger verified)
//   ✅ Trips (fixed blocks)
//
// WHAT'S LEFT: Sport and general activity slots that the packer couldn't
// assign a field-verified sport to (usually because all fields were at
// capacity at that specific time). These show up as:
//   - type='slot', event='General Activity Slot', field=null
//   - type='sport', _assignedSport=null (packer couldn't find a field)
//
// THIS SOLVER'S JOB:
//   1. For each unfilled slot, find the best sport + field combination
//   2. Respect: same-day no-repeat, field capacity (TIME-BASED),
//      cross-division sharing, rotation fairness
//   3. Fill remaining slots with "Free" only as last resort
//
// DESIGN PRINCIPLES:
//   - TIME-BASED everything (startMin/endMin, not slot indices)
//   - Single-pass with smart ordering (most constrained first)
//   - No specials — they're already placed and locked
//   - Uses AutoFieldLocks for field availability (when available)
//   - Falls back to time-index queries for field capacity
//   - RotationEngine for fairness scoring
//   - Same-day duplicate prevention is a HARD rule
//
// INTERFACE:
//   window.AutoSolverEngine.solve(blocks, config) → { filled, free, elapsed }
//
// =============================================================================

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const TAG = '[AutoSolver]';

    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ⚠️ ' + msg, ...args); }

    function normName(str) {
        if (!str) return '';
        return str.toLowerCase().trim();
    }

    function parseTime(str) {
        if (str == null) return null;
        if (typeof str === 'number') return str;
        let s = String(str).toLowerCase().trim();
        const isPM = s.includes('pm'), isAM = s.includes('am');
        s = s.replace(/am|pm/g, '').trim();
        const parts = s.split(':');
        let h = parseInt(parts[0], 10);
        if (isNaN(h)) return null;
        const m = parseInt(parts[1], 10) || 0;
        if (isPM && h !== 12) h += 12;
        if (isAM && h === 12) h = 0;
        return h * 60 + m;
    }


    // =========================================================================
    // CANDIDATE BUILDER
    // =========================================================================
    // Builds the list of all possible (sport, field) combinations once,
    // then filters per-block based on availability + constraints.

    function buildCandidates(config) {
        const ap = config.activityProperties || window.activityProperties || {};
        const fields = config.masterFields || [];
        const disabled = new Set(config.disabledFields || []);
        const candidates = [];

        const fieldsBySport = {};
        fields.forEach(f => {
            if (disabled.has(f.name)) return;
            (f.activities || []).forEach(sportName => {
                if (!fieldsBySport[sportName]) fieldsBySport[sportName] = [];
                const rawType = f.sharableWith?.type || 'same_division';
                const divs = f.sharableWith?.divisions || [];
                // Normalize: custom with empty divisions = same_division
                let shareType = rawType;
                if (shareType === 'custom' && divs.length === 0) shareType = 'same_division';
                if (shareType === 'all') shareType = 'same_division';
                fieldsBySport[sportName].push({
                    name: f.name,
                    capacity: parseInt(f.sharableWith?.capacity) || parseInt(f.capacity) || 2,
                    shareType,
                    allowedDivisions: shareType === 'custom' ? divs : [],
                    isIndoor: !!f.isIndoor
                });
            });
        });

        Object.entries(fieldsBySport).forEach(([sport, fieldList]) => {
            fieldList.forEach(field => {
                candidates.push({
                    sport: sport,
                    field: field.name,
                    fieldNorm: normName(field.name),
                    sportNorm: normName(sport),
                    capacity: field.capacity,
                    shareType: field.shareType,
                    allowedDivisions: field.allowedDivisions,
                    isIndoor: field.isIndoor,
                    _activity: sport  // for scheduleAssignments compatibility
                });
            });
        });

        log('Built ' + candidates.length + ' candidates from ' + Object.keys(fieldsBySport).length + ' sports');
        return { candidates, fieldsBySport };
    }


    // =========================================================================
    // FIELD AVAILABILITY (time-based)
    // =========================================================================

    // Build a time index from current scheduleAssignments for field capacity checking
    function buildFieldTimeIndex() {
        const index = new Map(); // fieldNorm → [{ startMin, endMin, bunk, grade, activity }]
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const dt = window.divisionTimes || {};

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            // Find this bunk's grade
            let grade = '';
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
            }
            // Get per-bunk slots for time resolution
            const pbs = dt[grade]?._perBunkSlots?.[bunk] || (Array.isArray(dt[grade]) ? dt[grade] : []);

            slots.forEach((entry, idx) => {
                if (!entry || !entry.field || entry.field === 'Free') return;
                if (entry.continuation) return;
                const slot = pbs[idx];
                if (!slot || slot.startMin == null || slot.endMin == null) return;

                const fn = normName(entry.field);
                if (!index.has(fn)) index.set(fn, []);
                index.get(fn).push({
                    startMin: slot.startMin, endMin: slot.endMin,
                    bunk, grade,
                    activity: normName(entry._activity || entry.sport || entry.field)
                });
            });
        });

        return index;
    }

    function isFieldAvailableByTime(fieldName, startMin, endMin, bunk, grade, fieldIndex, candidate) {
        // ★ v1.1 FIX: ALWAYS check the time index (built from scheduleAssignments)
        // for capacity and cross-division sharing. Lock systems are checked
        // ADDITIONALLY for exclusive locks — they never short-circuit past
        // the capacity check, because they only contain explicit lock claims,
        // not the sport capacity data from scheduleAssignments.

        // 1. Exclusive lock checks (both systems)
        if (window.AutoFieldLocks?.isFieldLockedByTime) {
            if (window.AutoFieldLocks.isFieldLockedByTime(fieldName, startMin, endMin, grade)) return false;
        }
        if (window.GlobalFieldLocks?.isFieldLockedByTime) {
            if (window.GlobalFieldLocks.isFieldLockedByTime(fieldName, startMin, endMin, grade)) return false;
        }

        // 2. Rainy day: no outdoor fields
        if (window.isRainyDay && candidate && !candidate.isIndoor) return false;

       // 3. Time index: capacity + cross-division sharing (THE critical check)
        const fn = normName(fieldName);
        const entries = fieldIndex.get(fn) || [];
        const overlapping = entries.filter(e => e.startMin < endMin && e.endMin > startMin && e.bunk !== bunk);
        const st = candidate?.shareType || 'same_division';
        const cap = candidate?.capacity || 2;
        // ★ FIX: Sharing-type-aware capacity check — only count relevant bunks
        if (st === 'not_sharable') {
            if (overlapping.length > 0) return false;
        } else if (st === 'same_division') {
            if (overlapping.some(e => e.grade !== grade)) return false;
            const sameGrade = overlapping.filter(e => e.grade === grade);
            if (sameGrade.length >= cap) return false;
        } else if (st === 'custom') {
            const allowed = candidate?.allowedDivisions || [];
            if (allowed.length > 0) {
                if (overlapping.some(e => e.grade !== grade && !allowed.includes(e.grade))) return false;
                if (overlapping.length > 0 && !allowed.includes(grade)) return false;
            } else {
                if (overlapping.some(e => e.grade !== grade)) return false;
            }
            if (overlapping.length >= cap) return false;
        } else {
            if (overlapping.length >= cap) return false;
        }
        // 4. Exact time match: bunks sharing a field must start and end together
        if (overlapping.length > 0 && cap > 1) {
            const sameGradeOverlaps = overlapping.filter(e => e.grade === grade);
            if (sameGradeOverlaps.length > 0) {
                if (sameGradeOverlaps.some(e => e.startMin !== startMin || e.endMin !== endMin)) {
                    return false;
                }
            }
        }
        // 5. Combined field mutual exclusion
        if (window.FieldCombos?.isBlockedByCombo) {
            const combo = window.FieldCombos.isBlockedByCombo(fieldName, startMin, endMin, bunk);
            if (combo?.blocked) return false;
        }
        return true;
    }


    // =========================================================================
    // SAME-DAY ACTIVITY TRACKING
    // =========================================================================

    function buildBunkActivitiesToday() {
        const map = new Map(); // bunk → Set of normalized activity names
        const sa = window.scheduleAssignments || {};

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const activities = new Set();
            slots.forEach(entry => {
                if (!entry || entry.continuation) return;
                const act = normName(entry._activity || entry.sport || entry.field);
                if (act && act !== 'free' && act !== 'free play' && act !== 'general activity slot')
                    activities.add(act);
            });
            map.set(bunk, activities);
        });

        return map;
    }


    // =========================================================================
    // ROTATION SCORING
    // =========================================================================

    function getRotationScore(bunk, activityName, grade) {
        if (!activityName || normName(activityName) === 'free') return 0;

        if (window.RotationEngine?.calculateRotationScore) {
            const score = window.RotationEngine.calculateRotationScore({
                bunkName: bunk,
                activityName: activityName,
                divisionName: grade,
                beforeSlotIndex: 0,
                allActivities: null,
                activityProperties: window.activityProperties || {}
            });
            return score === Infinity ? 999999 : score;
        }
        return 0;
    }


    // =========================================================================
    // DRAFT HINT SCORING
    // =========================================================================
    // The packer may have a _draftActivity / _draftField from Phase 2.
    // If that activity+field combo is still available, give it a big bonus.

    function getDraftBonus(block, candidate) {
        if (!block._draftActivity) return 0;
        const draftNorm = normName(block._draftActivity);
        const candNorm = normName(candidate.sport);
        if (draftNorm === candNorm) {
            // Activity matches draft — big bonus
            if (block._draftField && normName(block._draftField) === normName(candidate.field)) {
                return -5000; // Exact match (activity + field)
            }
            return -3000; // Activity matches, different field
        }
        return 0;
    }


    // =========================================================================
    // MAIN SOLVE FUNCTION
    // =========================================================================

    function solve(blocks, config) {
        const startTime = performance.now();
        config = config || {};

        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  AUTO SOLVER ENGINE v' + VERSION + ' — Sport Slot Filler        ║');
        log('╚═══════════════════════════════════════════════════════════╝');
        log('Input: ' + blocks.length + ' unfilled blocks');

        if (blocks.length === 0) {
            log('Nothing to solve');
            return { filled: 0, free: 0, elapsed: '0.00' };
        }

        const divisions = config.divisions || window.divisions || {};
        const isRainy = config.isRainy || !!window.isRainyDay;

        // Build candidate list
        const { candidates } = buildCandidates(config);
        if (candidates.length === 0) {
            warn('No candidates available — all blocks will be Free');
            blocks.forEach(b => writeFree(b));
            return { filled: 0, free: blocks.length, elapsed: '0.00' };
        }

        // Build field time index from current state
        let fieldIndex = buildFieldTimeIndex();

        // Build today's activities per bunk
        const bunkActivities = buildBunkActivitiesToday();

        // Pre-compute rotation scores per bunk per sport
        const rotationCache = new Map();
        function getCachedRotation(bunk, sport, grade) {
            const key = bunk + '|' + sport;
            if (rotationCache.has(key)) return rotationCache.get(key);
            const score = getRotationScore(bunk, sport, grade);
            rotationCache.set(key, score);
            return score;
        }

        // ── Sort blocks: most constrained first ──────────────────────
        // Fewer candidate options → harder to fill → solve first
        blocks.sort((a, b) => {
            // Blocks with draft hints get slight priority (we want to honor them)
            const aHint = a._draftActivity ? -1 : 0;
            const bHint = b._draftActivity ? -1 : 0;
            if (aHint !== bHint) return aHint - bHint;
            // Shorter blocks are harder (less time = fewer fields available)
            const aDur = (parseTime(a.endTime) || 0) - (parseTime(a.startTime) || 0);
            const bDur = (parseTime(b.endTime) || 0) - (parseTime(b.startTime) || 0);
            return aDur - bDur;
        });

        // ── Solve each block ─────────────────────────────────────────
        let filled = 0, free = 0;

        for (const block of blocks) {
            const bunk = block.bunk;
            const grade = block.divName || '';
            const slotIdx = block.slots?.[0];
            const startMin = parseTime(block.startTime);
            const endMin = parseTime(block.endTime);

            if (startMin == null || endMin == null || !bunk) {
                writeFree(block);
                free++;
                continue;
            }

            // Already filled? Skip
            const existing = window.scheduleAssignments?.[bunk]?.[slotIdx];
            if (existing && existing._fixed) continue;

            // Get this bunk's activities so far
            const doneToday = bunkActivities.get(bunk) || new Set();

            // Score all candidates for this block
            const scored = [];
            for (const cand of candidates) {
                // Same-day repeat check (HARD rule)
                if (doneToday.has(cand.sportNorm)) continue;

                // Field availability (time-based)
                if (!isFieldAvailableByTime(cand.field, startMin, endMin, bunk, grade, fieldIndex, cand)) continue;

                // Rainy day: skip outdoor
                if (isRainy && !cand.isIndoor) continue;

                // Score: rotation + draft hint
                let score = getCachedRotation(bunk, cand.sport, grade);
                score += getDraftBonus(block, cand);

                // Prefer filling fields to capacity (same activity co-location)
                const fn = cand.fieldNorm;
                const existing = (fieldIndex.get(fn) || []).filter(e =>
                    e.startMin < endMin && e.endMin > startMin && e.bunk !== bunk
                );
                if (existing.length > 0) {
                    const sameAct = existing.filter(e => e.activity === cand.sportNorm);
                    if (sameAct.length > 0) score -= 1500; // Co-locate same activity
                    else score += 300; // Mixed activities on same field = mild penalty
                }

                // Adjacent bunk bonus (sports that need pairing)
                const bunkNum = parseInt(String(bunk).replace(/\D/g, '')) || 0;
                const adjacentOnField = existing.some(e => {
                    const eNum = parseInt(String(e.bunk).replace(/\D/g, '')) || 0;
                    return Math.abs(eNum - bunkNum) <= 1 && e.activity === cand.sportNorm;
                });
                if (adjacentOnField) score -= 500;

                scored.push({ cand, score });
            }

            if (scored.length === 0) {
                // No valid candidate — Free
                writeFree(block);
                free++;
                continue;
            }

            // Pick best
            scored.sort((a, b) => a.score - b.score);
            const pick = scored[0].cand;

            // Write assignment
            writeAssignment(block, pick, startMin, endMin, bunk, grade, slotIdx);

            // Update tracking
            doneToday.add(pick.sportNorm);
            bunkActivities.set(bunk, doneToday);

            // Update field index so subsequent blocks see this assignment
            const fn = pick.fieldNorm;
            if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
            fieldIndex.get(fn).push({ startMin, endMin, bunk, grade, activity: pick.sportNorm });

            // Register in AutoFieldLocks if available
            if (window.AutoFieldLocks?.claimField) {
                window.AutoFieldLocks.claimField(pick.field, startMin, endMin, bunk, grade, pick.sport);
            }

            // Invalidate rotation cache for this bunk
            if (window.RotationEngine?.invalidateBunkTodayCache) {
                window.RotationEngine.invalidateBunkTodayCache(bunk);
            }

            filled++;
        }

        // ── Same-day duplicate sweep (safety net) ────────────────────
        const dupFixes = sameDayDuplicateSweep();

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  SOLVE COMPLETE in ' + elapsed + 's');
        log('║  ' + blocks.length + ' blocks, ' + filled + ' filled, ' + free + ' Free');
        if (dupFixes > 0) log('║  ' + dupFixes + ' same-day duplicates fixed');
        log('╚═══════════════════════════════════════════════════════════╝');

        return { filled, free, elapsed, dupFixes };
    }


    // =========================================================================
    // WRITE HELPERS
    // =========================================================================

    function writeAssignment(block, pick, startMin, endMin, bunk, grade, slotIdx) {
        if (!window.scheduleAssignments?.[bunk]) return;
        window.scheduleAssignments[bunk][slotIdx] = {
            field: pick.field,
            sport: pick.sport,
            _activity: pick.sport,
            _autoMode: true,
            _autoSolved: true,
            _startMin: startMin,
            _endMin: endMin,
            _blockStart: startMin,
            _division: grade,
            continuation: false
        };

        // Register in fieldUsageBySlot for compatibility with fillers/utils/canBlockFit
        const fubs = window.fieldUsageBySlot || {};
        if (!fubs[slotIdx]) fubs[slotIdx] = {};
        if (!fubs[slotIdx][pick.field]) fubs[slotIdx][pick.field] = { count: 0, bunks: {}, divisions: [] };
        fubs[slotIdx][pick.field].count++;
        fubs[slotIdx][pick.field].bunks[bunk] = pick.sport;
        if (grade && !fubs[slotIdx][pick.field].divisions.includes(grade)) {
            fubs[slotIdx][pick.field].divisions.push(grade);
        }
    }

    function writeFree(block) {
        const bunk = block.bunk;
        const slotIdx = block.slots?.[0];
        if (!window.scheduleAssignments?.[bunk]) return;
        window.scheduleAssignments[bunk][slotIdx] = {
            field: 'Free', sport: null, _activity: 'Free',
            _autoMode: true, _autoSolved: true, continuation: false
        };
    }


    // =========================================================================
    // SAME-DAY DUPLICATE SWEEP (safety net)
    // =========================================================================
    // After solving, scan each bunk for the same activity appearing twice.
    // If found, demote the one with worse rotation score to Free.

    function sameDayDuplicateSweep() {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        let fixes = 0;

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const seen = new Map(); // activity → slotIdx

            let grade = '';
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
            }

            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || entry._fixed || entry._pinned || entry._league) return;
                const act = normName(entry._activity || entry.sport || entry.field);
                if (!act || act === 'free' || act === 'free play' || act === 'general activity slot') return;

                if (seen.has(act)) {
                    // Duplicate! Demote the one that was auto-solved (not capacity-checked)
                    const prevIdx = seen.get(act);
                    const prevEntry = slots[prevIdx];
                    const currIsSolved = !!entry._autoSolved;
                    const prevIsSolved = !!prevEntry?._autoSolved;

                    let demoteIdx;
                    if (currIsSolved && !prevIsSolved) demoteIdx = idx;
                    else if (!currIsSolved && prevIsSolved) demoteIdx = prevIdx;
                    else {
                        // Both same type — demote by rotation score
                        const currScore = getRotationScore(bunk, act, grade);
                        demoteIdx = idx; // default: demote current
                    }

                    slots[demoteIdx] = {
                        field: 'Free', sport: null, _activity: 'Free',
                        _autoMode: true, _autoSolved: true, _demotedFrom: act, continuation: false
                    };
                    fixes++;
                    warn('Dup fix: ' + bunk + ' "' + act + '" at slot ' + demoteIdx + ' → Free');

                    // Update seen to point to the surviving one
                    seen.set(act, demoteIdx === idx ? prevIdx : idx);
                } else {
                    seen.set(act, idx);
                }
            });
        });

        return fixes;
    }


    // =========================================================================
    // FALLBACK SWEEP
    // =========================================================================
    // After the main solve, scan for remaining Free blocks and try harder
    // to fill them — allow same-day repeats of common sports as last resort.

    function fallbackSweep(config) {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const dt = window.divisionTimes || {};
        const { candidates } = buildCandidates(config || {});
        const fieldIndex = buildFieldTimeIndex();
        let filled = 0;

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            let grade = '';
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
            }
            const pbs = dt[grade]?._perBunkSlots?.[bunk] || [];

            slots.forEach((entry, idx) => {
                if (!entry || entry.field !== 'Free') return;
                const slot = pbs[idx];
                if (!slot) return;
                const startMin = slot.startMin, endMin = slot.endMin;

                // Try to find ANY available sport (allows repeats)
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;
                    if (!isFieldAvailableByTime(cand.field, startMin, endMin, bunk, grade, fieldIndex, cand)) continue;

                    sa[bunk][idx] = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _fallbackFill: true, continuation: false
                    };

                    const fn = cand.fieldNorm;
                    if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                    fieldIndex.get(fn).push({ startMin, endMin, bunk, grade, activity: cand.sportNorm });
                    filled++;
                    break;
                }
            });
        });

        if (filled > 0) log('Fallback sweep filled ' + filled + ' remaining Free blocks');
        return filled;
    }


    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    function report() {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        let totalSlots = 0, filledSlots = 0, freeSlots = 0, nullSlots = 0;
        const freeByGrade = {};

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            let grade = '';
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
            }
            slots.forEach((entry, idx) => {
                totalSlots++;
                if (!entry) { nullSlots++; return; }
                if (entry.field === 'Free') {
                    freeSlots++;
                    if (!freeByGrade[grade]) freeByGrade[grade] = [];
                    freeByGrade[grade].push({ bunk, idx });
                } else {
                    filledSlots++;
                }
            });
        });

        console.log('%c═══ AUTO SOLVER REPORT ═══', 'color:#2E7D32;font-weight:bold');
        console.log('Total: ' + totalSlots + ' | Filled: ' + filledSlots + ' | Free: ' + freeSlots + ' | Null: ' + nullSlots);
        if (freeSlots > 0) {
            Object.entries(freeByGrade).forEach(([grade, blocks]) => {
                console.log('  ' + grade + ': ' + blocks.length + ' Free — ' +
                    blocks.slice(0, 5).map(b => 'Bunk' + b.bunk + '#' + b.idx).join(', ') +
                    (blocks.length > 5 ? '...' : ''));
            });
        }
    }


    // =========================================================================
    // EXPORTS
    // =========================================================================

    const AutoSolverEngine = {
        version: VERSION,
        solve,
        fallbackSweep,
        sameDayDuplicateSweep,
        report,
        // Expose for scheduler_core_auto.js to call
        solveSchedule: function(activityBlocks, config) {
            return solve(activityBlocks, config);
        }
    };

    window.AutoSolverEngine = AutoSolverEngine;

    console.log(TAG + ' v' + VERSION + ' loaded — purpose-built sport slot solver for auto builder');
})();
