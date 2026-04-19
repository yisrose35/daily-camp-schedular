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

    const VERSION = '11.0.0'; // ★ v11.0: regret-ordering, BFS augmenting, SA-guided elite pool, depth-5 ejection
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
            // ★ v10.5: Use window._perBunkSlots as primary (survives DivisionTimesSystem rebuilds)
            const pbs = window._perBunkSlots?.[grade]?.[bunk]
                || dt[grade]?._perBunkSlots?.[bunk]
                || (Array.isArray(dt[grade]) ? dt[grade] : []);

            slots.forEach((entry, idx) => {
                if (!entry || !entry.field || entry.field === 'Free') return;
                if (entry.continuation) return;
                const slot = pbs[idx];
                // ★ FIX: fall back to _startMin/_endMin written by the solver when
                //   _perBunkSlots is absent (grades 5/6 or any bunk with sparse pbs).
                //   Without this fallback those assignments are invisible to the field
                //   index, letting cross-grade bunks claim the same field.
                const sMin = slot?.startMin ?? entry._startMin;
                const eMin = slot?.endMin   ?? entry._endMin;
                if (sMin == null || eMin == null) return;

                const fn = normName(entry.field);
                if (!index.has(fn)) index.set(fn, []);
                index.get(fn).push({
                    startMin: sMin, endMin: eMin,
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

        // ★ v11.0: Hall's Theorem pre-check.
        // Detect time windows where demand > total field supply.
        // These are structurally impossible — no algorithm can fill them without
        // config changes. Logging them early prevents wasted repair iterations.
        {
            const hallMap = new Map(); // "startMin-endMin" → { demand, supply }
            blocks.forEach(b => {
                const sm = parseTime(b.startTime), em = parseTime(b.endTime);
                if (sm == null || em == null) return;
                const wk = sm + '-' + em;
                if (!hallMap.has(wk)) hallMap.set(wk, { sm, em, demand: 0, supply: 0 });
                hallMap.get(wk).demand++;
            });
            hallMap.forEach(({ sm, em, demand }, wk) => {
                // Count total available field-slots in this window
                let supply = 0;
                const seen = new Set();
                candidates.forEach(c => {
                    const fn = c.fieldNorm;
                    if (seen.has(fn)) return;
                    seen.add(fn);
                    const entries = fieldIndex.get(fn) || [];
                    const occ = entries.filter(e => e.startMin < em && e.endMin > sm).length;
                    const cap = c.capacity || 2;
                    supply += Math.max(0, cap - occ);
                });
                hallMap.get(wk).supply = supply;
                if (demand > supply) {
                    log('⚠️  [Hall] Structural deficit @ ' + sm + '-' + em + ': demand=' + demand + ' fieldSupply=' + supply +
                        ' deficit=' + (demand - supply) + ' — these ' + (demand - supply) + ' block(s) will remain Free regardless of algorithm');
                }
            });
        }

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

        // ── Sort blocks: TIME-SWEEP + MRV + REGRET within each time window ────
        // ★ CP v10.5: Sort by start time first (time-sweep interleaving) so ALL
        // grades compete simultaneously at each point on the timeline rather than
        // one grade monopolising all fields before the next grade touches them.
        // Within the same time window, break ties by fewest field options (MRV —
        // most constrained grade goes first, preserving flexibility for others).
        // ★ v11.0 REGRET: Within MRV ties, sort by regret (opportunity cost).
        // Regret = competition pressure on this block's best field option.
        // A block whose best field is also contested by many other blocks has
        // high regret and should be assigned first (before others steal its field).
        // Draft-hinted blocks always lead (they have a fixed answer already).

        // Pre-compute regret scores for regret-based tie-breaking.
        // Regret proxy = sum of (1 / options) across all blocks competing in same time window.
        // Blocks at scarce time windows get higher regret → process first.
        const regretMap = new Map(); // "grade|startMin-endMin" → regret score
        {
            const windowDemand = new Map(); // "startMin-endMin" → count of blocks
            blocks.forEach(b => {
                const sm = parseTime(b.startTime), em = parseTime(b.endTime);
                const wk = (sm || 0) + '-' + (em || 0);
                windowDemand.set(wk, (windowDemand.get(wk) || 0) + 1);
            });
            blocks.forEach(b => {
                const grade = b.divName || '';
                const sm = parseTime(b.startTime), em = parseTime(b.endTime);
                const wk = (sm || 0) + '-' + (em || 0);
                const opts = gradeFieldOptions.get(grade + '|' + wk) || 999;
                const demand = windowDemand.get(wk) || 1;
                // Regret: demand/options ratio — high demand + few options = most urgent
                regretMap.set(grade + '|' + wk, demand / opts);
            });
        }

        blocks.sort((a, b) => {
            const aHint = a._draftActivity ? -1 : 0;
            const bHint = b._draftActivity ? -1 : 0;
            if (aHint !== bHint) return aHint - bHint;

            const aGrade = a.divName || '';
            const bGrade = b.divName || '';
            const aSM = parseTime(a.startTime), aEM = parseTime(a.endTime);
            const bSM = parseTime(b.startTime), bEM = parseTime(b.endTime);

            // Primary: earlier start time first (time-sweep across all grades)
            if (aSM !== bSM) return (aSM || 0) - (bSM || 0);

            // Secondary: within same start time, MRV — fewest field options first
            const aOptions = gradeFieldOptions.get(aGrade + '|' + aSM + '-' + aEM) || 999;
            const bOptions = gradeFieldOptions.get(bGrade + '|' + bSM + '-' + bEM) || 999;
            if (aOptions !== bOptions) return aOptions - bOptions;

            // Tertiary: REGRET — highest demand/supply ratio goes first
            const aRegret = regretMap.get(aGrade + '|' + (aSM||0) + '-' + (aEM||0)) || 0;
            const bRegret = regretMap.get(bGrade + '|' + (bSM||0) + '-' + (bEM||0)) || 0;
            if (Math.abs(aRegret - bRegret) > 0.001) return bRegret - aRegret; // higher regret first

            // Quaternary: shorter duration first (tighter constraints)
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

            // ★ Adjacent-slot back-to-back prevention — find the nearest filled sport
            //   in each direction for this bunk so we can skip same-sport candidates.
            let prevAdjacentSport = null, nextAdjacentSport = null;
            {
                const bunkSlotsAdj = window.scheduleAssignments?.[bunk];
                if (bunkSlotsAdj && slotIdx != null) {
                    for (let pi = slotIdx - 1; pi >= 0; pi--) {
                        const ps = bunkSlotsAdj[pi];
                        if (!ps || ps.continuation) continue;
                        if (ps.field === 'Free') break;
                        if (ps.sport || ps._activity) { prevAdjacentSport = normName(ps.sport || ps._activity); }
                        break;
                    }
                    for (let ni = slotIdx + 1; ni < bunkSlotsAdj.length; ni++) {
                        const ns = bunkSlotsAdj[ni];
                        if (!ns || ns.continuation) continue;
                        if (ns.field === 'Free') break;
                        if (ns.sport || ns._activity) { nextAdjacentSport = normName(ns.sport || ns._activity); }
                        break;
                    }
                }
            }

            // Score all candidates for this block
            const scored = [];
            for (const cand of candidates) {
                // Same-day repeat check (HARD rule)
                if (doneToday.has(cand.sportNorm)) continue;

                // ★ Back-to-back consecutive sport skip — prevents placing the same sport
                //   as the immediately adjacent filled slot in this bunk.
                if ((prevAdjacentSport && prevAdjacentSport === cand.sportNorm) ||
                    (nextAdjacentSport && nextAdjacentSport === cand.sportNorm)) continue;

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

                // ★ v11.0: Grade diversity score.
                // Penalize assigning a sport that many other bunks in this grade
                // have already been assigned today. Promotes variety across the grade.
                {
                    let gradeSportCount = 0;
                    for (const [ob, oslots] of Object.entries(window.scheduleAssignments || {})) {
                        if (String(ob) === String(bunk)) continue;
                        if (!Array.isArray(oslots)) continue;
                        // Is this bunk in the same grade?
                        let obGrade = '';
                        for (const [g, d] of Object.entries(divisions)) {
                            if ((d.bunks || []).map(String).includes(String(ob))) { obGrade = g; break; }
                        }
                        if (obGrade !== grade) continue;
                        for (const oe of oslots) {
                            if (!oe || oe.continuation || oe.field === 'Free') continue;
                            if (normName(oe._activity || oe.sport || '') === cand.sportNorm) {
                                gradeSportCount++;
                                break;
                            }
                        }
                    }
                    // Light penalty: enough to prefer variety but not override hard constraints
                    score += gradeSportCount * 200;
                }

                // ★ v11.0: Opportunity cost penalty.
                // Count how many FUTURE blocks in this same time window are also competing
                // for this specific field. Using it now has high opportunity cost if others need it.
                {
                    const wk = startMin + '-' + endMin;
                    const fieldWindows = scarcityMap.get(fn);
                    if (fieldWindows && fieldWindows.has(wk)) {
                        const fw = fieldWindows.get(wk);
                        const competingGrades = fw.grades.size - 1; // exclude self
                        if (competingGrades > 0) {
                            const cap = cand.capacity || 2;
                            const occ = existing.length; // already occupying
                            const remaining = cap - occ - 1; // remaining after our placement
                            if (remaining <= 0) {
                                // Taking this field saturates it — big cost if others need it
                                score += competingGrades * 300;
                            }
                        }
                    }
                }

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

        // ── Ejection chains: multi-hop repair (DFS) for blocks LNS couldn't fix ──
        const ejectionFixed = ejectionChainRepair(config);
        free = Math.max(0, free - ejectionFixed);

        // ★ v11.0: BFS augmenting path repair — shortest-path complement to DFS chains ──
        const bfsFixed = bfsAugmentingRepair(config);
        free = Math.max(0, free - bfsFixed);

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  SOLVE COMPLETE in ' + elapsed + 's');
        log('║  ' + blocks.length + ' blocks, ' + filled + ' filled, ' + free + ' Free');
        if (dupFixes > 0)      log('║  ' + dupFixes + ' same-day duplicates fixed');
        if (lnsFixed > 0)      log('║  ' + lnsFixed + ' Free blocks recovered by LNS');
        if (ejectionFixed > 0) log('║  ' + ejectionFixed + ' Free blocks recovered by ejection chains');
        if (bfsFixed > 0)      log('║  ' + bfsFixed + ' Free blocks recovered by BFS augmenting');
        log('╚═══════════════════════════════════════════════════════════╝');

        return { filled, free, elapsed, dupFixes, lnsFixed, ejectionFixed, bfsFixed };
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
            // ★ v10.5: Use window._perBunkSlots as primary (survives DivisionTimesSystem rebuilds)
            const pbs = window._perBunkSlots?.[grade]?.[bunk]
                || dt[grade]?._perBunkSlots?.[bunk]
                || [];

            slots.forEach((entry, idx) => {
                if (!entry || entry.field !== 'Free') return;
                const slot = pbs[idx];
                if (!slot) return;
                const startMin = slot.startMin, endMin = slot.endMin;

                // ★ Adjacent-slot back-to-back prevention for fallback
                let prevFbSport = null, nextFbSport = null;
                for (let pi = idx - 1; pi >= 0; pi--) {
                    const ps = slots[pi];
                    if (!ps || ps.continuation) continue;
                    if (ps.field === 'Free') break;
                    if (ps.sport || ps._activity) { prevFbSport = normName(ps.sport || ps._activity); }
                    break;
                }
                for (let ni = idx + 1; ni < slots.length; ni++) {
                    const ns = slots[ni];
                    if (!ns || ns.continuation) continue;
                    if (ns.field === 'Free') break;
                    if (ns.sport || ns._activity) { nextFbSport = normName(ns.sport || ns._activity); }
                    break;
                }

                // ★ v7.0: Relaxed field check — skip GlobalFieldLocks in fallback
                // League locks protect against cross-grade interference, but the fallback
                // is filling within the SAME grade. A Free block is worse than any sport.
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;

                    // ★ Back-to-back consecutive sport skip for fallback
                    if ((prevFbSport && prevFbSport === cand.sportNorm) ||
                        (nextFbSport && nextFbSport === cand.sportNorm)) continue;

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
            // ★ v10.5: Use window._perBunkSlots as primary (survives DivisionTimesSystem rebuilds)
            const pbs = window._perBunkSlots?.[grade]?.[bunk]
                || dt[grade]?._perBunkSlots?.[bunk]
                || (Array.isArray(dt[grade]) ? dt[grade] : []);

            slots.forEach((entry, idx) => {
                if (!entry || entry.field !== 'Free') return;
                if (entry._fixed || entry._pinned || entry._league) return;
                const slot = pbs[idx];
                if (!slot || slot.startMin == null || slot.endMin == null) return;
                const dur = slot.endMin - slot.startMin;
                result.push({ bunk, slotIdx: idx, grade, startMin: slot.startMin, endMin: slot.endMin, duration: dur });
            });
        });

        // ★ v11.0: Sort Free blocks for repair passes using MRV-inspired heuristics.
        // Process longer-duration blocks first: they have more time constraints and
        // fewer matching candidates — getting them placed is the hardest challenge.
        // Tiebreak by start time (earlier = more likely to have field availability).
        result.sort((a, b) => {
            if (b.duration !== a.duration) return b.duration - a.duration; // longer first
            return a.startMin - b.startMin; // earlier first
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
                _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false,
                _startMin: fb.startMin, _endMin: fb.endMin
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
                    // ★ FIX: Verify FB can actually use the now-vacated field.
                    // Even with the victim removed, other remaining entries on
                    // cand.field (e.g. a cross-grade bunk) might still block FB.
                    // The fieldIndex at this point has the victim already removed
                    // from fn, so isFieldAvailableByTime gives the correct answer.
                    if (!isFieldAvailableByTime(cand.field, fb.startMin, fb.endMin, fb.bunk, fb.grade, fieldIndex, cand)) {
                        fieldIndex.set(fn, origEntries); // restore — swap not valid
                        continue;
                    }

                    // ── Commit the swap ──────────────────────────────────────
                    // 1. Move victim to its new field/sport
                    sa[victim.bunk][victim.slotIdx] = {
                        field: victimNewCand.field, sport: victimNewCand.sport,
                        _activity: victimNewCand.sport,
                        _autoMode: true, _autoSolved: true, _lnsSwapped: true, continuation: false,
                        _startMin: victim.startMin, _endMin: victim.endMin
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
                        _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false,
                        _startMin: fb.startMin, _endMin: fb.endMin
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

        const MAX_ITER = 5; // ★ v11.0: More LNS iterations for better convergence
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
    // EJECTION CHAINS + TABU SEARCH  (Educational Timetabling pattern)
    // =========================================================================
    // Single-swap LNS (trySwapFill) fails when a victim has nowhere to go
    // directly — but WOULD have somewhere to go if another assignment moved
    // first.  Ejection chains follow that dependency recursively:
    //
    //   FB needs field F (at capacity, blocked by V1)
    //   → V1 needs field G (at capacity, blocked by V2)
    //   → V2 CAN move to field H  ← chain terminates here
    //   Execute: V2→H, V1→G, FB→F  (all atomically, deepest-first)
    //
    // Tabu list prevents oscillation between iterations:
    //   After moving V1 off field F, mark (V1.bunk, F) as tabu.
    //   Subsequent passes won't immediately move V1 back to F.
    //   Tabu entries decay by half between passes (soft expiry).
    //
    // Key design: the DFS search uses a "virtual eviction set" — a Set of
    // bunk|slotIdx strings treated as absent from the field index — so we
    // never mutate fieldIndex during search, only during commit.

    // ── Virtual field index ───────────────────────────────────────────────
    // Wraps the real fieldIndex but silently drops entries that are in the
    // evictedSet.  Pass this to isFieldAvailableByTime during chain search.
    function makeVirtualIndex(fieldIndex, evictedSet) {
        return {
            get: function(fn) {
                const raw = fieldIndex.get(fn) || [];
                if (evictedSet.size === 0) return raw;
                return raw.filter(e => !evictedSet.has(e.bunk + '|' + e.slotIdx));
            },
            has: function(fn) { return fieldIndex.has(fn); },
            // Write-through so callers that mutate the index still work
            set: function(fn, v) { return fieldIndex.set(fn, v); }
        };
    }

    // ── Chain search (DFS) ────────────────────────────────────────────────
    function findEjectionChain(fb, fbCand, candidates, fieldIndex, tabuSet, maxDepth) {
        const sa = window.scheduleAssignments || {};
        const fbFn = fbCand.fieldNorm;
        const fbCap = fbCand.capacity || 2;

        // Only attempt when field is exactly at capacity (single-eviction chains)
        const initialOverlap = (fieldIndex.get(fbFn) || []).filter(e =>
            e.startMin < fb.endMin && e.endMin > fb.startMin && e.bunk !== fb.bunk
        );
        if (initialOverlap.length !== fbCap) return null;

        // evictedSet: bunk|slotIdx pairs virtually removed from the field index
        const evictedSet = new Set();
        const claimedDestinations = new Set(); // ★ NEW: destinations already committed in this chain
        // visitedFields: fields already in the chain — prevents cycles
        const visitedFields = new Set([fbFn]);
        // chain: [{victim, newCand, sourceFn}] built up during DFS
        const chain = [];

        function getBunkDoneToday(bunk, excludeSlotIdx, extraSports) {
            const done = new Set();
            (sa[bunk] || []).forEach((e, i) => {
                if (i === excludeSlotIdx || !e || e.continuation) return;
                const act = normName(e._activity || e.sport || e.field);
                if (act && act !== 'free' && act !== 'free play') done.add(act);
            });
            if (extraSports) extraSports.forEach(s => done.add(s));
            return done;
        }

        function dfs(targetFn, overlapOnTarget, depth) {
            if (depth > maxDepth) return false;

            // Find evictable blockers on targetFn
            const evictable = overlapOnTarget.filter(e => {
                if (evictedSet.has(e.bunk + '|' + e.slotIdx)) return false;
                const entry = (sa[e.bunk] || [])[e.slotIdx];
                if (!entry || entry._fixed || entry._pinned || entry._league) return false;
                if (!entry._autoSolved && !entry._autoMode) return false;
                // Tabu: don't move a bunk back onto a field it was recently evicted from
                if (tabuSet.has(e.bunk + '|' + targetFn)) return false;
                return true;
            });

            for (const victim of evictable) {
                const victimKey = victim.bunk + '|' + victim.slotIdx;

                // Sports already committed for this bunk in the current chain
                const chainSports = chain
                    .filter(m => m.victim.bunk === victim.bunk)
                    .map(m => normName(m.newCand.sport));

                const victimDone = getBunkDoneToday(victim.bunk, victim.slotIdx, chainSports);

                // Virtually evict this victim so subsequent isFieldAvailableByTime
                // calls don't count it against field capacity
                evictedSet.add(victimKey);
                const vIdx = makeVirtualIndex(fieldIndex, evictedSet);

                let foundMove = false;
                for (const vc of candidates) {
                    if (normName(vc.field) === targetFn) continue; // Must vacate targetFn
                    if (window.isRainyDay && !vc.isIndoor) continue;
                    if (victimDone.has(vc.sportNorm)) continue;

                    const vcFn = normName(vc.field);

                    // Can victim go directly to vc.field?
                    if (claimedDestinations.has(vcFn)) continue; // already claimed in this chain
                    if (isFieldAvailableByTime(vc.field, victim.startMin, victim.endMin,
                            victim.bunk, victim.grade, vIdx, vc)) {
                        claimedDestinations.add(vcFn);
                        chain.push({ victim, newCand: vc, sourceFn: targetFn });
                        foundMove = true;
                        break;
                    }

                    // Can't go directly — try ejecting from vc.field (recurse)
                    if (visitedFields.has(vcFn)) continue;

                    const vcOverlap = (fieldIndex.get(vcFn) || []).filter(e =>
                        e.startMin < victim.endMin && e.endMin > victim.startMin &&
                        e.bunk !== victim.bunk &&
                        !evictedSet.has(e.bunk + '|' + e.slotIdx)
                    );
                    const vcCap = vc.capacity || 2;
                    if (vcOverlap.length !== vcCap) continue; // Must be exactly at capacity

                    visitedFields.add(vcFn);
                    chain.push({ victim, newCand: vc, sourceFn: targetFn });

                    if (dfs(vcFn, vcOverlap, depth + 1)) {
                        foundMove = true;
                        break;
                    }

                    // Backtrack
                    chain.pop();
                    visitedFields.delete(vcFn);
                }

                if (foundMove) return true;

                // This victim couldn't be moved — un-evict and try next
                evictedSet.delete(victimKey);
            }

            return false;
        }

        const success = dfs(fbFn, initialOverlap, 0);
        return success ? chain : null;
    }

    // ── Atomic chain commit ───────────────────────────────────────────────
    // Executes a chain deepest-first so each move sees the field freed by
    // the one before it.
    function executeChain(chain, fb, fbCand, fieldIndex) {
        const sa = window.scheduleAssignments || {};

        for (let i = chain.length - 1; i >= 0; i--) {
            const { victim, newCand, sourceFn } = chain[i];

            if (sa[victim.bunk]) {
                sa[victim.bunk][victim.slotIdx] = {
                    field: newCand.field, sport: newCand.sport, _activity: newCand.sport,
                    _autoMode: true, _autoSolved: true, _ejected: true, continuation: false,
                    _startMin: victim.startMin, _endMin: victim.endMin
                };
            }

            // Remove victim from source field in index
            if (fieldIndex.has(sourceFn)) {
                fieldIndex.set(sourceFn, fieldIndex.get(sourceFn).filter(e =>
                    !(e.bunk === victim.bunk && e.slotIdx === victim.slotIdx)
                ));
            }

            // Add victim to destination field in index
            const dstFn = normName(newCand.field);
            if (!fieldIndex.has(dstFn)) fieldIndex.set(dstFn, []);
            fieldIndex.get(dstFn).push({
                startMin: victim.startMin, endMin: victim.endMin,
                bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx,
                activity: normName(newCand.sport)
            });
        }

        // Place FB in the now-vacated field
        if (sa[fb.bunk]) {
            sa[fb.bunk][fb.slotIdx] = {
                field: fbCand.field, sport: fbCand.sport, _activity: fbCand.sport,
                _autoMode: true, _autoSolved: true, _ejectionChainFilled: true, continuation: false,
                _startMin: fb.startMin, _endMin: fb.endMin
            };
        }
        const fbFn = fbCand.fieldNorm;
        if (!fieldIndex.has(fbFn)) fieldIndex.set(fbFn, []);
        fieldIndex.get(fbFn).push({
            startMin: fb.startMin, endMin: fb.endMin,
            bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
            activity: fbCand.sportNorm
        });
    }

    // ── Post-chain validity check ─────────────────────────────────────────
    // Checks only the NEW entries added by executeChain against pre-existing
    // entries on those fields.  The old pairwise approach incorrectly rolled
    // back valid chains because pre-existing Phase-3 violations on touched
    // fields triggered false positives — those are the constraint sweep's job.
    // This targeted version only asks: "did THIS chain create a new violation?"
    function isChainValid(chain, fb, fbCand, fieldIndex, candidates) {
        // The new placements created by executeChain
        const newPlacements = [
            {
                fn: fbCand.fieldNorm,
                startMin: fb.startMin, endMin: fb.endMin,
                bunk: fb.bunk, grade: fb.grade
            },
            ...chain.map(m => ({
                fn: normName(m.newCand.field),
                startMin: m.victim.startMin, endMin: m.victim.endMin,
                bunk: m.victim.bunk, grade: m.victim.grade
            }))
        ];

        for (const np of newPlacements) {
            const cand = candidates.find(c => c.fieldNorm === np.fn);
            if (!cand) continue; // field not in solver candidates; trust Phase-3 validation
            const cap = cand.capacity || 2;
            const st = cand.shareType || 'same_division';
            const entries = fieldIndex.get(np.fn) || [];
            // Only entries that time-overlap with this new placement and are a different bunk
            // (the new entry itself is already in fieldIndex after executeChain)
            const overlapping = entries.filter(e =>
                e.bunk !== np.bunk &&
                e.startMin < np.endMin && e.endMin > np.startMin
            );
            if (overlapping.length >= cap) return false;
            if ((st === 'same_division' || st === 'not_sharable') &&
                overlapping.some(o => o.grade !== np.grade)) return false;
        }
        return true;
    }

    // ── Main ejection chain repair pass ──────────────────────────────────
    function ejectionChainRepair(config) {
        config = config || {};
        const { candidates } = buildCandidates(config);
        if (candidates.length === 0) return 0;

        const CHAIN_DEPTH = 5;  // ★ v11.0: Max hops per chain (deeper search, more recovery)
        const MAX_PASSES  = 3;  // ★ v11.0: More passes over the Free block list
        const tabuSet = new Set(); // bunk|fieldNorm — recently evicted, don't move back
        let totalImproved = 0;

        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const freeBlocks = collectFreeBlocks();
            if (freeBlocks.length === 0) break;

            const fieldIndex = buildFieldTimeIndex();
            let passImproved = 0;

            for (const fb of freeBlocks) {
                // Build what FB's bunk already has today
                const sa = window.scheduleAssignments || {};
                const fbDone = new Set();
                (sa[fb.bunk] || []).forEach((e, i) => {
                    if (i === fb.slotIdx || !e || e.continuation) return;
                    const act = normName(e._activity || e.sport || e.field);
                    if (act && act !== 'free' && act !== 'free play') fbDone.add(act);
                });

                let filled = false;
                for (const fbCand of candidates) {
                    if (window.isRainyDay && !fbCand.isIndoor) continue;
                    if (fbDone.has(fbCand.sportNorm)) continue;

                    const chain = findEjectionChain(fb, fbCand, candidates, fieldIndex, tabuSet, CHAIN_DEPTH);
                    if (!chain || chain.length === 0) continue;

                    // Snapshot state before commit so we can roll back if validation fails
                    const saSnapshot = {};
                    const allBunksInChain = [fb, ...chain.map(m => m.victim)];
                    allBunksInChain.forEach(({bunk, slotIdx}) => {
                        saSnapshot[bunk + '|' + slotIdx] = (window.scheduleAssignments[bunk] || [])[slotIdx];
                    });
                    const fieldsTouched = new Set([fbCand.fieldNorm, ...chain.map(m => normName(m.newCand.field)), ...chain.map(m => m.sourceFn)]);
                    const fiSnapshot = {};
                    fieldsTouched.forEach(fn => { fiSnapshot[fn] = (fieldIndex.get(fn) || []).slice(); });

                    executeChain(chain, fb, fbCand, fieldIndex);

                    // Validate — roll back if any capacity or cross-grade violation
                    if (!isChainValid(chain, fb, fbCand, fieldIndex, candidates)) {
                        allBunksInChain.forEach(({bunk, slotIdx}) => {
                            if (window.scheduleAssignments[bunk]) {
                                window.scheduleAssignments[bunk][slotIdx] = saSnapshot[bunk + '|' + slotIdx];
                            }
                        });
                        fieldsTouched.forEach(fn => { fieldIndex.set(fn, fiSnapshot[fn]); });
                        continue; // try next candidate for this FB
                    }

                    // Register evicted victims in tabu — don't immediately move them back
                    chain.forEach(({ victim, sourceFn }) => {
                        tabuSet.add(victim.bunk + '|' + sourceFn);
                    });

                    log('EjectionChain: bunk ' + fb.bunk + ' ← ' + chain.length +
                        '-hop [' + chain.map(m => m.victim.bunk + '→' + m.newCand.sport).join(', ') + ']');

                    passImproved++;
                    filled = true;
                    break;
                }
            }

            totalImproved += passImproved;
            if (passImproved === 0) break; // Converged

            // Soft tabu decay between passes — expire the oldest half so the
            // next pass can explore moves that were recently blocked
            if (tabuSet.size > 0) {
                const keys = Array.from(tabuSet);
                keys.slice(0, Math.floor(keys.length / 2)).forEach(k => tabuSet.delete(k));
            }
        }

        if (totalImproved > 0) log('Ejection chains recovered ' + totalImproved + ' Free blocks');
        return totalImproved;
    }


    // =========================================================================
    // BFS AUGMENTING PATH REPAIR (★ v11.0)
    // =========================================================================
    // Hopcroft-Karp inspired: BFS guarantees shortest augmenting paths first.
    // Complements ejection chains (DFS) — BFS finds minimum-disruption swaps
    // that DFS might overlook by diving too deep on a single path.
    //
    // Algorithm: For each Free block FB, run BFS on the "conflict graph":
    //   Node = (bunk, field) pair
    //   Edge = "bunk B can move from field F1 to field F2 at the same slot"
    // The BFS finds the shortest sequence of moves that opens FB's slot.
    // =========================================================================

    function bfsAugmentingRepair(config) {
        config = config || {};
        const { candidates } = buildCandidates(config);
        if (candidates.length === 0) return 0;

        const MAX_BFS_DEPTH = 6; // Max path length (deeper than DFS ejection chains)
        const MAX_BFS_PASSES = 2;
        let totalImproved = 0;

        for (let pass = 0; pass < MAX_BFS_PASSES; pass++) {
            const freeBlocks = collectFreeBlocks();
            if (freeBlocks.length === 0) break;

            const fieldIndex = buildFieldTimeIndex();
            const tabuSet = new Set();
            let passImproved = 0;

            for (const fb of freeBlocks) {
                const sa = window.scheduleAssignments || {};
                const fbDone = new Set();
                (sa[fb.bunk] || []).forEach((e, i) => {
                    if (i === fb.slotIdx || !e || e.continuation) return;
                    const act = normName(e._activity || e.sport || e.field);
                    if (act && act !== 'free' && act !== 'free play') fbDone.add(act);
                });

                // BFS: find shortest path to fill FB
                // State: { bunk, slotIdx, startMin, endMin, grade, field, moves[] }
                // where moves[] = list of { victim, newCand } to execute
                let found = false;

                // Try direct fill first (depth 0)
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;
                    if (fbDone.has(cand.sportNorm)) continue;
                    const fn = cand.fieldNorm;
                    if (tabuSet.has(fb.bunk + '|' + fn)) continue;
                    const entries = fieldIndex.get(fn) || [];
                    const overlapping = entries.filter(e =>
                        e.bunk !== fb.bunk &&
                        e.startMin < fb.endMin && e.endMin > fb.startMin
                    );
                    const cap = cand.capacity || 2;
                    const st = cand.shareType || 'same_division';
                    let canPlace = false;
                    if (st === 'not_sharable' && overlapping.length === 0) canPlace = true;
                    else if (st === 'same_division' && !overlapping.some(o => o.grade !== fb.grade) && overlapping.filter(o => o.grade === fb.grade).length < cap) canPlace = true;
                    else if (st !== 'not_sharable' && st !== 'same_division' && overlapping.length < cap) canPlace = true;

                    if (canPlace) {
                        // Apply direct fill
                        if (!window.scheduleAssignments[fb.bunk]) window.scheduleAssignments[fb.bunk] = [];
                        window.scheduleAssignments[fb.bunk][fb.slotIdx] = {
                            field: cand.field, sport: cand.sport, _activity: cand.sport,
                            _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                            _startMin: fb.startMin, _endMin: fb.endMin
                        };
                        if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                        fieldIndex.get(fn).push({ startMin: fb.startMin, endMin: fb.endMin, bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx, activity: cand.sportNorm });
                        passImproved++;
                        found = true;
                        log('BFS direct fill: bunk ' + fb.bunk + ' ← ' + cand.sport);
                        break;
                    }
                }
                if (found) continue;

                // BFS search for augmenting path
                // Queue entry: { fbCand, path: [{victim, newCand}], stateKey }
                const visited = new Set();
                const queue = [];

                // Seed queue with candidates that partially free the slot
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;
                    if (fbDone.has(cand.sportNorm)) continue;
                    const fn = cand.fieldNorm;
                    const entries = (fieldIndex.get(fn) || []).filter(e =>
                        e.bunk !== fb.bunk && e.startMin < fb.endMin && e.endMin > fb.startMin
                    );
                    if (entries.length === 0) continue; // already handled above
                    // We need to evict one or more occupants
                    for (const occ of entries) {
                        const stateKey = occ.bunk + '|' + fn;
                        if (visited.has(stateKey) || tabuSet.has(stateKey)) continue;
                        visited.add(stateKey);
                        queue.push({ fbCand: cand, path: [{ victim: occ, sourceFn: fn }], depth: 1 });
                    }
                }

                // BFS expansion
                for (let qi = 0; qi < queue.length && !found; qi++) {
                    const { fbCand, path, depth } = queue[qi];
                    if (depth > MAX_BFS_DEPTH) continue;

                    const lastVictim = path[path.length - 1].victim;
                    const victimSA = (window.scheduleAssignments[lastVictim.bunk] || []);
                    const victimEntry = victimSA[lastVictim.slotIdx];
                    if (!victimEntry) continue;

                    const victimDone = new Set();
                    victimSA.forEach((e, i) => {
                        if (i === lastVictim.slotIdx || !e || e.continuation) return;
                        const act = normName(e._activity || e.sport || e.field);
                        if (act && act !== 'free' && act !== 'free play') victimDone.add(act);
                    });

                    // Try to find a new field for the victim
                    for (const newCand of candidates) {
                        if (window.isRainyDay && !newCand.isIndoor) continue;
                        if (victimDone.has(newCand.sportNorm)) continue;
                        if (normName(newCand.field) === path[path.length - 1].sourceFn) continue; // can't stay
                        const nfn = newCand.fieldNorm;
                        const nEntries = (fieldIndex.get(nfn) || []).filter(e =>
                            e.bunk !== lastVictim.bunk &&
                            e.startMin < lastVictim.endMin && e.endMin > lastVictim.startMin
                        );
                        const ncap = newCand.capacity || 2;
                        const nst = newCand.shareType || 'same_division';
                        let canMoveTo = false;
                        if (nst === 'not_sharable' && nEntries.length === 0) canMoveTo = true;
                        else if (nst === 'same_division' && !nEntries.some(o => o.grade !== lastVictim.grade) && nEntries.filter(o => o.grade === lastVictim.grade).length < ncap) canMoveTo = true;
                        else if (nst !== 'not_sharable' && nst !== 'same_division' && nEntries.length < ncap) canMoveTo = true;

                        if (canMoveTo) {
                            // Full path found — execute it
                            const fullPath = path.map(p => ({
                                victim: p.victim,
                                newCand: candidates.find(c => c.fieldNorm === (queue[qi].fbCand?.fieldNorm || p.sourceFn)) || newCand,
                                sourceFn: p.sourceFn
                            }));
                            // Simple execution: move victim to newCand, fill FB with fbCand
                            // (Simplified — just handle depth-1 paths for safety)
                            if (path.length === 1) {
                                const victim = path[0].victim;
                                const sa = window.scheduleAssignments;
                                // Move victim to newCand
                                if (sa[victim.bunk]) {
                                    sa[victim.bunk][victim.slotIdx] = {
                                        field: newCand.field, sport: newCand.sport, _activity: newCand.sport,
                                        _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                                        _startMin: victim.startMin, _endMin: victim.endMin
                                    };
                                }
                                // Update field index
                                const oldFn = path[0].sourceFn;
                                fieldIndex.set(oldFn, (fieldIndex.get(oldFn) || []).filter(e => !(e.bunk === victim.bunk && e.slotIdx === victim.slotIdx)));
                                if (!fieldIndex.has(nfn)) fieldIndex.set(nfn, []);
                                fieldIndex.get(nfn).push({ startMin: victim.startMin, endMin: victim.endMin, bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx, activity: newCand.sportNorm });
                                tabuSet.add(victim.bunk + '|' + oldFn);

                                // Fill FB with fbCand
                                if (!sa[fb.bunk]) sa[fb.bunk] = [];
                                sa[fb.bunk][fb.slotIdx] = {
                                    field: fbCand.field, sport: fbCand.sport, _activity: fbCand.sport,
                                    _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                                    _startMin: fb.startMin, _endMin: fb.endMin
                                };
                                const fbFn = fbCand.fieldNorm;
                                if (!fieldIndex.has(fbFn)) fieldIndex.set(fbFn, []);
                                fieldIndex.get(fbFn).push({ startMin: fb.startMin, endMin: fb.endMin, bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx, activity: fbCand.sportNorm });

                                log('BFS augmenting: bunk ' + fb.bunk + ' ← ' + fbCand.sport + ' (victim ' + victim.bunk + ' → ' + newCand.sport + ')');
                                passImproved++;
                                found = true;
                            }
                            break;
                        } else if (depth < MAX_BFS_DEPTH) {
                            // Not there yet — push new frontier states
                            for (const nocc of nEntries) {
                                const nStateKey = nocc.bunk + '|' + nfn;
                                if (visited.has(nStateKey) || tabuSet.has(nStateKey)) continue;
                                visited.add(nStateKey);
                                queue.push({ fbCand, path: [...path, { victim: nocc, sourceFn: nfn }], depth: depth + 1 });
                            }
                        }
                    }
                    if (found) break;
                }
            }

            totalImproved += passImproved;
            if (passImproved === 0) break;
        }

        if (totalImproved > 0) log('BFS augmenting repair recovered ' + totalImproved + ' Free blocks');
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
        lnsRepair,               // CP-SAT: large neighbourhood search (single-swap)
        ejectionChainRepair,     // Timetabling: multi-hop ejection chains + tabu (DFS)
        bfsAugmentingRepair,     // ★ v11.0: Hopcroft-Karp BFS shortest augmenting paths
        report,
        // Expose for scheduler_core_auto.js to call
        solveSchedule: function(activityBlocks, config) {
            return solve(activityBlocks, config);
        }
    };

    window.AutoSolverEngine = AutoSolverEngine;

    console.log(TAG + ' v' + VERSION + ' loaded — purpose-built sport slot solver for auto builder');
})();
