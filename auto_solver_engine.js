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
        const index = new Map(); // fieldNorm → [{ startMin, endMin, bunk, grade, slotIdx, activity }]
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
                    bunk, grade, slotIdx: idx,
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
        // 4. Exact time match — OPT-IN via field's strictTiming flag.
        //    Previously hard-coded ON, which silently defeated sharing for
        //    same-grade bunks whose gap edges weren't perfectly aligned.
        //    Now defaults to OFF: capacity check above already prevents
        //    over-subscription. Camps that want strict alignment can set
        //    strictTiming: true on the field.
        const fLedger = window.AutoFieldLocks?.getFieldLedger?.(fieldName) || {};
        if (fLedger.strictTiming === true && overlapping.length > 0 && cap > 1) {
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
    // DYNAMIC DOMAIN TRACKING  (CP-SAT: forward checking)
    // =========================================================================
    // After each assignment we recount how many candidates each grade can still
    // reach in the affected time window.  getScarcityPenalty() reads from
    // gradeFieldOptions, so keeping that map live means later blocks are scored
    // with accurate, post-assignment scarcity data rather than the stale
    // snapshot built before the loop started.
    //
    // Cost: O(grades_in_window × candidates) per assignment — typically < 500
    // operations, negligible compared to the scoring loop itself.

    function updateDomainSizes(fieldIndex, startMin, endMin, candidates, gradeFieldOptions, windowBlocks) {
        const wKey = startMin + '-' + endMin;
        const wBlocks = windowBlocks.get(wKey) || [];
        if (wBlocks.length === 0) return;

        // Collect the unique grades that have blocks in this window
        const gradesInWindow = new Set(wBlocks.map(b => b.grade));

        for (const grade of gradesInWindow) {
            let reachable = 0;
            for (const c of candidates) {
                const fn = c.fieldNorm;
                const entries = fieldIndex.get(fn) || [];
                const ov = entries.filter(e => e.startMin < endMin && e.endMin > startMin);
                const crossGrade = ov.filter(e => e.grade !== grade);
                const st = c.shareType || 'same_division';
                if (st === 'same_division' && crossGrade.length > 0) continue;
                if (st === 'not_sharable' && ov.length > 0) continue;
                if (st === 'custom') {
                    const allowed = c.allowedDivisions || [];
                    if (allowed.length > 0 && crossGrade.some(e => !allowed.includes(e.grade))) continue;
                }
                if (ov.length >= (c.capacity || 2)) continue;
                reachable++;
            }
            gradeFieldOptions.set(grade + '|' + wKey, reachable);
        }
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

      // ── Build cross-grade scarcity map ───────────────────────────        // For each time window, compute how "scarce" fields are per grade.
        // scarcityMap: fieldNorm → Map<timeKey, { grades: Set, demandByGrade: Map }>
        const scarcityMap = new Map();
        const gradeFieldOptions = new Map(); // grade|startMin-endMin → count of available fields

        // Group blocks by time window
        const windowBlocks = new Map(); // "startMin-endMin" → [{ block, grade }]
        for (const block of blocks) {
            const sM = parseTime(block.startTime), eM = parseTime(block.endTime);
            if (sM == null || eM == null) continue;
            const wKey = sM + '-' + eM;
            if (!windowBlocks.has(wKey)) windowBlocks.set(wKey, []);
            windowBlocks.get(wKey).push({ block, grade: block.divName || '' });
        }

        // For each time window, count how many fields each grade can reach
        for (const [wKey, wBlocks] of windowBlocks) {
            const [sM, eM] = wKey.split('-').map(Number);
            const gradesInWindow = new Map(); // grade → block count
            for (const { grade } of wBlocks) {
                gradesInWindow.set(grade, (gradesInWindow.get(grade) || 0) + 1);
            }

            // For each grade in this window, count reachable fields
            for (const [grade, blockCount] of gradesInWindow) {
                let reachableFields = 0;
                for (const cand of candidates) {
                    // Would this field be available for this grade? (simplified check)
                    const st = cand.shareType || 'same_division';
                    // Check if any other grade already occupies it (from fieldIndex)
                    const fn = cand.fieldNorm;
                    const entries = fieldIndex.get(fn) || [];
                    const overlapping = entries.filter(e => e.startMin < eM && e.endMin > sM);
                    const crossGrade = overlapping.filter(e => e.grade !== grade);
                    if (st === 'same_division' && crossGrade.length > 0) continue;
                    if (st === 'not_sharable' && overlapping.length > 0) continue;
                    reachableFields++;
                }
                const gfKey = grade + '|' + wKey;
                gradeFieldOptions.set(gfKey, reachableFields);

                // Build per-field scarcity: which grades compete for this field at this window?
                for (const cand of candidates) {
                    const fn = cand.fieldNorm;
                    if (!scarcityMap.has(fn)) scarcityMap.set(fn, new Map());
                    const fieldWindows = scarcityMap.get(fn);
                    if (!fieldWindows.has(wKey)) fieldWindows.set(wKey, { grades: new Set(), demandByGrade: new Map() });
                    const entry = fieldWindows.get(wKey);
                    entry.grades.add(grade);
                    entry.demandByGrade.set(grade, blockCount);
                }
            }
        }

        // Scarcity scoring function: how much should we penalize using this field?
        function getScarcityPenalty(fieldNorm, startMin, endMin, myGrade) {
            const wKey = startMin + '-' + endMin;
            const fieldWindows = scarcityMap.get(fieldNorm);
            if (!fieldWindows) return 0;
            const entry = fieldWindows.get(wKey);
            if (!entry) return 0;

            let penalty = 0;
            for (const [otherGrade, otherDemand] of entry.demandByGrade) {
                if (otherGrade === myGrade) continue;
                // How scarce are fields for this other grade at this window?
                const gfKey = otherGrade + '|' + wKey;
                const otherOptions = gradeFieldOptions.get(gfKey) || 999;
                // If the other grade has very few options, penalize heavily
                if (otherOptions <= 2) penalty += 8000;       // Critical scarcity
                else if (otherOptions <= 5) penalty += 4000;  // Moderate scarcity
                else if (otherOptions <= 10) penalty += 1500; // Mild scarcity
                // Scale by demand: more bunks needing fields = more important to preserve
                penalty += otherDemand * 200;
            }

            // Also check: does MY grade have plenty of alternatives?
            const myKey = myGrade + '|' + wKey;
            const myOptions = gradeFieldOptions.get(myKey) || 0;
            if (myOptions > 15) penalty += 1000; // I have lots of options, let others have this one

            return penalty;
        }

      log('Scarcity map: ' + scarcityMap.size + ' fields, ' + windowBlocks.size + ' time windows');

        // ── Sort blocks: most constrained first ──────────────────────
        // Grades with fewer field options at their time window solve first
        blocks.sort((a, b) => {
            const aHint = a._draftActivity ? -1 : 0;
            const bHint = b._draftActivity ? -1 : 0;
            if (aHint !== bHint) return aHint - bHint;

            const aGrade = a.divName || '';
            const bGrade = b.divName || '';
            const aSM = parseTime(a.startTime), aEM = parseTime(a.endTime);
            const bSM = parseTime(b.startTime), bEM = parseTime(b.endTime);
            const aOptions = gradeFieldOptions.get(aGrade + '|' + aSM + '-' + aEM) || 999;
            const bOptions = gradeFieldOptions.get(bGrade + '|' + bSM + '-' + bEM) || 999;
            if (aOptions !== bOptions) return aOptions - bOptions;

            const aDur = (aSM != null && aEM != null) ? aEM - aSM : 0;
            const bDur = (bSM != null && bEM != null) ? bEM - bSM : 0;
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

               // Scarcity penalty: avoid using fields that other grades desperately need
                score += getScarcityPenalty(cand.fieldNorm, startMin, endMin, grade);

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
            fieldIndex.get(fn).push({ startMin, endMin, bunk, grade, slotIdx, activity: pick.sportNorm });

            // Forward checking: refresh gradeFieldOptions for this time window so
            // scarcity penalties for remaining blocks reflect the new assignment.
            updateDomainSizes(fieldIndex, startMin, endMin, candidates, gradeFieldOptions, windowBlocks);

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

        // ── LNS repair: recover Free blocks via single-swap neighbourhood ──
        const lnsFixed = lnsRepair(config);
        free = Math.max(0, free - lnsFixed);

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  SOLVE COMPLETE in ' + elapsed + 's');
        log('║  ' + blocks.length + ' blocks, ' + filled + ' filled, ' + free + ' Free');
        if (dupFixes > 0) log('║  ' + dupFixes + ' same-day duplicates fixed');
        if (lnsFixed > 0) log('║  ' + lnsFixed + ' Free blocks recovered by LNS repair');
        log('╚═══════════════════════════════════════════════════════════╝');

        return { filled, free, elapsed, dupFixes, lnsFixed };
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

                // ★ v7.0: Relaxed field check — skip GlobalFieldLocks in fallback
                // League locks protect against cross-grade interference, but the fallback
                // is filling within the SAME grade. A Free block is worse than any sport.
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;

                    // Simplified availability check (no GlobalFieldLocks)
                    const fn = normName(cand.field);
                    const entries = fieldIndex.get(fn) || [];
                    const overlapping = entries.filter(e => e.startMin < endMin && e.endMin > startMin && e.bunk !== bunk);
                    const st = cand.shareType || 'same_division';
                    const cap = cand.capacity || 2;
                    let blocked = false;

                    if (st === 'not_sharable' && overlapping.length > 0) blocked = true;
                    else if (st === 'same_division') {
                        if (overlapping.some(e => e.grade !== grade)) blocked = true;
                        if (!blocked && overlapping.filter(e => e.grade === grade).length >= cap) blocked = true;
                    } else if (overlapping.length >= cap) blocked = true;

                    // Exact time match — opt-in via cand.strictTiming flag
                    if (!blocked && cand.strictTiming === true && overlapping.length > 0 && cap > 1) {
                        const sameGrade = overlapping.filter(e => e.grade === grade);
                        if (sameGrade.length > 0 && sameGrade.some(e => e.startMin !== startMin || e.endMin !== endMin)) blocked = true;
                    }

                    if (blocked) continue;

                    sa[bunk][idx] = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _fallbackFill: true, continuation: false
                    };

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
    // LNS REPAIR  (CP-SAT: Large Neighbourhood Search)
    // =========================================================================
    // After the greedy solve there are often Free blocks whose only problem is
    // ordering: a different solve sequence would have filled them.  LNS fixes
    // this without a full backtracking rewrite.
    //
    // Algorithm (single-swap, up to MAX_ITER passes):
    //   For each remaining Free block FB:
    //     1. tryDirectFill  — maybe something freed up since the main solve
    //     2. trySwapFill    — find an auto-solved assignment that sits on the
    //                         only field FB could use, move it to a different
    //                         field, then place FB in the vacated spot.
    //                         Only commits the swap if the victim can actually
    //                         be re-assigned (net improvement guaranteed).
    //
    // Exposed as AutoSolverEngine.lnsRepair(config) so the orchestrator can
    // also call it standalone after manual edits.

    function collectFreeBlocks() {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const dt = window.divisionTimes || {};
        const result = [];

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            let grade = '';
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) { grade = g; break; }
            }
            const pbs = dt[grade]?._perBunkSlots?.[bunk] || (Array.isArray(dt[grade]) ? dt[grade] : []);

            slots.forEach((entry, idx) => {
                if (!entry || entry.field !== 'Free') return;
                if (entry._fixed || entry._pinned || entry._league) return;
                const slot = pbs[idx];
                if (!slot || slot.startMin == null || slot.endMin == null) return;
                result.push({ bunk, slotIdx: idx, grade, startMin: slot.startMin, endMin: slot.endMin });
            });
        });

        return result;
    }

    function tryDirectFill(fb, candidates, fieldIndex) {
        // Try to fill without evicting anyone — covers edge cases where something
        // freed up between the main solve and now.
        const sa = window.scheduleAssignments || {};

        // Build what this bunk has today (excluding its own Free slot)
        const doneToday = new Set();
        (sa[fb.bunk] || []).forEach((e, i) => {
            if (i === fb.slotIdx || !e || e.continuation) return;
            const act = normName(e._activity || e.sport || e.field);
            if (act && act !== 'free' && act !== 'free play') doneToday.add(act);
        });

        for (const cand of candidates) {
            if (window.isRainyDay && !cand.isIndoor) continue;
            if (doneToday.has(cand.sportNorm)) continue;
            if (!isFieldAvailableByTime(cand.field, fb.startMin, fb.endMin, fb.bunk, fb.grade, fieldIndex, cand)) continue;

            sa[fb.bunk][fb.slotIdx] = {
                field: cand.field, sport: cand.sport, _activity: cand.sport,
                _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false
            };
            const fn = normName(cand.field);
            if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
            fieldIndex.get(fn).push({
                startMin: fb.startMin, endMin: fb.endMin,
                bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
                activity: cand.sportNorm
            });
            return true;
        }
        return false;
    }

    function trySwapFill(fb, candidates, fieldIndex) {
        // For each candidate that FB wants, check if the field is exactly at
        // capacity (overage of exactly 1).  If so, try evicting one auto-solved
        // assignment to a different field, then place FB in the vacated spot.
        const sa = window.scheduleAssignments || {};

        // What does FB's bunk have today?
        const fbDoneToday = new Set();
        (sa[fb.bunk] || []).forEach((e, i) => {
            if (i === fb.slotIdx || !e || e.continuation) return;
            const act = normName(e._activity || e.sport || e.field);
            if (act && act !== 'free' && act !== 'free play') fbDoneToday.add(act);
        });

        for (const cand of candidates) {
            if (window.isRainyDay && !cand.isIndoor) continue;
            if (fbDoneToday.has(cand.sportNorm)) continue;

            const fn = cand.fieldNorm;
            const cap = cand.capacity || 2;
            const overlap = (fieldIndex.get(fn) || []).filter(e =>
                e.startMin < fb.endMin && e.endMin > fb.startMin && e.bunk !== fb.bunk
            );

            // Only attempt single-eviction swaps
            if (overlap.length !== cap) continue;

            for (const victim of overlap) {
                // Must be auto-solved and not locked
                if (victim.slotIdx == null) continue;
                const victimEntry = (sa[victim.bunk] || [])[victim.slotIdx];
                if (!victimEntry || victimEntry._fixed || victimEntry._pinned || victimEntry._league) continue;
                if (!victimEntry._autoSolved && !victimEntry._autoMode) continue;

                // Build victim's doneToday (excluding its own current slot)
                const victimDoneToday = new Set();
                (sa[victim.bunk] || []).forEach((e, i) => {
                    if (i === victim.slotIdx || !e || e.continuation) return;
                    const act = normName(e._activity || e.sport || e.field);
                    if (act && act !== 'free' && act !== 'free play') victimDoneToday.add(act);
                });

                // Temporarily remove the victim from the field index so we can
                // search for its alternative without false capacity blocks.
                const origEntries = (fieldIndex.get(fn) || []).slice();
                fieldIndex.set(fn, origEntries.filter(e =>
                    !(e.bunk === victim.bunk && e.startMin === victim.startMin && e.slotIdx === victim.slotIdx)
                ));

                // Can the victim go somewhere else?
                let victimNewCand = null;
                for (const vc of candidates) {
                    if (vc.field === cand.field) continue; // Must move to a different field
                    if (window.isRainyDay && !vc.isIndoor) continue;
                    if (victimDoneToday.has(vc.sportNorm)) continue;
                    if (isFieldAvailableByTime(vc.field, victim.startMin, victim.endMin, victim.bunk, victim.grade, fieldIndex, vc)) {
                        victimNewCand = vc;
                        break;
                    }
                }

                if (victimNewCand) {
                    // ── Commit the swap ──────────────────────────────────────
                    // 1. Move victim to its new field/sport
                    sa[victim.bunk][victim.slotIdx] = {
                        field: victimNewCand.field, sport: victimNewCand.sport,
                        _activity: victimNewCand.sport,
                        _autoMode: true, _autoSolved: true, _lnsSwapped: true, continuation: false
                    };
                    const vcFn = normName(victimNewCand.field);
                    if (!fieldIndex.has(vcFn)) fieldIndex.set(vcFn, []);
                    fieldIndex.get(vcFn).push({
                        startMin: victim.startMin, endMin: victim.endMin,
                        bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx,
                        activity: victimNewCand.sportNorm
                    });

                    // 2. Place FB in the now-vacated spot on cand's field
                    sa[fb.bunk][fb.slotIdx] = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false
                    };
                    if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                    fieldIndex.get(fn).push({
                        startMin: fb.startMin, endMin: fb.endMin,
                        bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
                        activity: cand.sportNorm
                    });

                    log('LNS swap: bunk ' + victim.bunk + ' "' + victim.activity + '" → "' + victimNewCand.sport + '" freed field for bunk ' + fb.bunk);
                    return true;

                } else {
                    // Restore field index — swap not possible
                    fieldIndex.set(fn, origEntries);
                }
            }
        }
        return false;
    }

    function lnsRepair(config) {
        config = config || {};
        const { candidates } = buildCandidates(config);
        if (candidates.length === 0) return 0;

        const MAX_ITER = 3;
        let totalImproved = 0;

        for (let iter = 0; iter < MAX_ITER; iter++) {
            const freeBlocks = collectFreeBlocks();
            if (freeBlocks.length === 0) break;

            // Rebuild a fresh field index at the start of each iteration so
            // committed swaps from the previous pass are visible.
            const fieldIndex = buildFieldTimeIndex();

            let iterImproved = 0;
            for (const fb of freeBlocks) {
                if (tryDirectFill(fb, candidates, fieldIndex)) { iterImproved++; continue; }
                if (trySwapFill(fb, candidates, fieldIndex))   { iterImproved++; }
            }

            totalImproved += iterImproved;
            if (iterImproved === 0) break; // Converged — no further improvement possible
        }

        if (totalImproved > 0) log('LNS repaired ' + totalImproved + ' Free blocks across ' + MAX_ITER + ' iterations');
        return totalImproved;
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
        lnsRepair,          // CP-SAT: large neighbourhood search repair pass
        report,
        // Expose for scheduler_core_auto.js to call
        solveSchedule: function(activityBlocks, config) {
            return solve(activityBlocks, config);
        }
    };

    window.AutoSolverEngine = AutoSolverEngine;

    console.log(TAG + ' v' + VERSION + ' loaded — purpose-built sport slot solver for auto builder');
})();
