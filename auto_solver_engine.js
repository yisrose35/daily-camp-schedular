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

    const VERSION = '12.0.0'; // ★ v12.0: forward-checking, dynamic re-sort, capacity-relax repair, enhanced colocate
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
        const dailyDisabledSports = config.dailyDisabledSports || {};
        const parseTimeMin = window.SchedulerCoreUtils?.parseTimeToMinutes;
        const candidates = [];

        // Parse a field's timeRules into a normalized form once per field so
        // isFieldAvailableByTime can run cheap per-call. Each rule is split into
        // type (available/unavailable), [startMin, endMin], and grade scope.
        function parseRules(rawRules) {
            if (!Array.isArray(rawRules)) return [];
            return rawRules.map(r => {
                const t = String(r.type || '').toLowerCase();
                const isUnavail = t === 'unavailable' || r.available === false;
                const isAvail = t === 'available' || r.available === true;
                const sMin = r.startMin ?? (parseTimeMin ? parseTimeMin(r.start || r.startTime) : null);
                const eMin = r.endMin ?? (parseTimeMin ? parseTimeMin(r.end || r.endTime) : null);
                return {
                    available: isAvail,
                    unavailable: isUnavail,
                    startMin: sMin,
                    endMin: eMin,
                    // Slice 3 audit fix (N11): tolerate divisions stored as a
                    // single string/number (e.g. "5" or 5). Earlier non-array
                    // values fell through to [] which silently re-scoped the
                    // rule to "all grades" — a per-grade Unavailable rule
                    // becoming a global one would block other grades.
                    divisions: Array.isArray(r.divisions)
                        ? r.divisions.map(String)
                        : (r.divisions != null && r.divisions !== '' ? [String(r.divisions)] : [])
                };
            }).filter(r => r.startMin != null && r.endMin != null && (r.available || r.unavailable));
        }

        // ★ Sport meta (maxPlayers per sport) — looked up by candidate so the
        //   solver's per-bunk capacity check can reject placements that would
        //   exceed the sport's player cap (mirrors manual isFieldAvailable).
        const sportMeta = (config.sportMetaData || window.sportMetaData || {});

        const fieldsBySport = {};
        fields.forEach(f => {
            if (disabled.has(f.name)) return;
            const rawType = f.sharableWith?.type || 'same_division';
            const divs = f.sharableWith?.divisions || [];
            const allowedPairs = f.sharableWith?.allowedPairs || {};
            let shareType = rawType;
            if (shareType === 'custom' && divs.length === 0) shareType = 'same_division';
            // ★ Per-field rule data — same source the manual builder's
            //   isFieldAvailable consumes, so the auto solver finally agrees
            //   with the manual one on grade access + grade-scoped time rules.
            // ★ Loosen `enabled` to truthy (configs may persist as 1/"true").
            const accessRestrictions = (f.accessRestrictions && f.accessRestrictions.enabled)
                ? {
                    enabled: true,
                    divisions: (f.accessRestrictions.divisions && typeof f.accessRestrictions.divisions === 'object')
                        ? f.accessRestrictions.divisions
                        : {}
                }
                : null;
            const timeRules = parseRules(f.timeRules);
            // dailyDisabledSports map: { fieldName: ['Hockey', ...] }
            const fieldDisabledSports = new Set(
                (dailyDisabledSports[f.name] || []).map(s => normName(s))
            );
            // Per-grade sharing override map (preserved verbatim — consumers
            // resolve effective shareType/capacity per grade at check time).
            const gradeShareRules = f.gradeShareRules || {};

            (f.activities || []).forEach(sportName => {
                if (!fieldsBySport[sportName]) fieldsBySport[sportName] = [];
                fieldsBySport[sportName].push({
                    name: f.name,
                    capacity: parseInt(f.sharableWith?.capacity) || parseInt(f.capacity) || 2,
                    shareType,
                    allowedDivisions: shareType === 'custom' ? divs : [],
                    allowedPairs,
                    gradeShareRules,
                    isIndoor: !!f.isIndoor,
                    accessRestrictions,
                    timeRules,
                    disabledSports: fieldDisabledSports
                });
            });
        });

        Object.entries(fieldsBySport).forEach(([sport, fieldList]) => {
            const meta = sportMeta[sport] || {};
            const maxPlayers = parseInt(meta.maxPlayers) || null;
            fieldList.forEach(field => {
                candidates.push({
                    sport: sport,
                    field: field.name,
                    fieldNorm: normName(field.name),
                    sportNorm: normName(sport),
                    capacity: field.capacity,
                    shareType: field.shareType,
                    allowedDivisions: field.allowedDivisions,
                    allowedPairs: field.allowedPairs,
                    gradeShareRules: field.gradeShareRules,
                    isIndoor: field.isIndoor,
                    accessRestrictions: field.accessRestrictions,
                    timeRules: field.timeRules,
                    disabledSports: field.disabledSports,
                    maxPlayers,
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

        // 2a. ★ GRADE ACCESS RESTRICTION
        //     Mirrors scheduler_core_auto.js:isFieldAvailable. The auto solver was
        //     placing sports on fields whose accessRestrictions excluded the bunk's
        //     grade — e.g. Hockey on a gym restricted to grades 4-6 was getting
        //     assigned to a grade-1 bunk. With this gate the candidate is rejected
        //     up front.
        if (candidate?.accessRestrictions?.enabled) {
            const divRules = candidate.accessRestrictions.divisions || {};
            // ★ Dual-key lookup — divisions may be keyed by string or numeric grade
            const gradeKey = String(grade);
            if (!(gradeKey in divRules) && !(grade in divRules)) return false;
            // Per-bunk filter inside the grade entry: empty array = "all bunks
            // in this grade", non-empty = only the listed bunks.
            const bunkList = divRules[gradeKey] || divRules[grade];
            if (Array.isArray(bunkList) && bunkList.length > 0
                && !bunkList.map(String).includes(String(bunk))) {
                return false;
            }
        }

        // 2b. ★ TIME RULES (per-grade)
        //     A field can declare Available/Unavailable windows, optionally
        //     scoped to specific grades. If the field has any Available rule
        //     applicable to this grade, [startMin, endMin] must lie inside one
        //     of them. Any overlapping Unavailable rule rejects outright.
        const rules = candidate?.timeRules;
        if (Array.isArray(rules) && rules.length > 0) {
            const myGrade = grade != null ? String(grade) : null;
            let hasGradeAvailRule = false;
            let insideGradeAvailRule = false;
            for (const r of rules) {
                // Skip rules scoped to other grades (empty divisions = all grades)
                if (r.divisions.length > 0 && myGrade && !r.divisions.includes(myGrade)) continue;
                if (r.unavailable) {
                    if (r.startMin < endMin && r.endMin > startMin) return false;
                } else if (r.available) {
                    hasGradeAvailRule = true;
                    if (startMin >= r.startMin && endMin <= r.endMin) insideGradeAvailRule = true;
                }
            }
            if (hasGradeAvailRule && !insideGradeAvailRule) return false;
        }

        // 2c. ★ DAILY DISABLED SPORTS — per-field daily override
        //     Lets the user disable a specific sport on a specific field for
        //     today only without touching base config.
        if (candidate?.disabledSports && candidate.sportNorm
            && candidate.disabledSports.has(candidate.sportNorm)) {
            return false;
        }

       // 3. Time index: capacity + cross-division sharing (THE critical check)
        const fn = normName(fieldName);
        const entries = fieldIndex.get(fn) || [];
        const overlapping = entries.filter(e => e.startMin < endMin && e.endMin > startMin && e.bunk !== bunk);
        // ★ Per-grade sharing override resolves effective shareType/capacity
        //   (e.g. "Field A is not_sharable for grade 1, same_division for others").
        const _gradeOverride = candidate?.gradeShareRules?.[grade];
        const st = _gradeOverride
            ? (_gradeOverride.type || 'not_sharable')
            : (candidate?.shareType || 'same_division');
        const cap = _gradeOverride
            ? (parseInt(_gradeOverride.capacity) || (_gradeOverride.type === 'not_sharable' ? 1 : 2))
            : (candidate?.capacity || 2);
        // ★ FIX: Sharing-type-aware capacity check — only count relevant bunks
        if (st === 'not_sharable') {
            if (overlapping.length > 0) return false;
        } else if (st === 'same_division') {
            if (overlapping.some(e => e.grade !== grade)) return false;
            const sameGrade = overlapping.filter(e => e.grade === grade);
            if (sameGrade.length >= cap) return false;
        } else if (st === 'cross_division') {
            const pairs = candidate?.allowedPairs || {};
            for (const e of overlapping) {
                if (e.grade === grade) continue;
                const key = [grade, e.grade].sort().join('|');
                if (pairs[key] !== true) return false;
            }
            if (overlapping.length >= cap) return false;
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
        // ★ Sport-level player cap (rules.js sportMetaData.maxPlayers).
        //   When two same-grade bunks share a field, each contributes its
        //   bunk size; summed roster must not exceed the sport's maxPlayers.
        if (candidate?.maxPlayers && candidate.maxPlayers > 0) {
            const divs = window.divisions || {};
            const bunkSize = (b) => {
                for (const g in divs) {
                    const dd = divs[g];
                    if (!dd || !Array.isArray(dd.bunks)) continue;
                    if (dd.bunks.map(String).includes(String(b))) {
                        const sizeMap = dd.bunkSizes || {};
                        return parseInt(sizeMap[b]) || parseInt(dd.defaultBunkSize) || parseInt(dd.bunkSize) || 0;
                    }
                }
                return 0;
            };
            let total = bunkSize(bunk);
            for (const e of overlapping) total += bunkSize(e.bunk);
            if (total > candidate.maxPlayers) return false;
        }
        // 4. Exact time alignment — MANDATORY for shared slots.
        //    When two or more bunks use the same field at the same time (sharing),
        //    their start AND end must be identical. Partial-overlap sharing is not
        //    supported: counselors can only run one group from one time to another.
        if (overlapping.length > 0) {
            if (overlapping.some(e => e.startMin !== startMin || e.endMin !== endMin)) {
                return false; // misaligned occupant — cannot share this field
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

    function getRotationScore(bunk, activityName, grade, slotIdx) {
        if (!activityName || normName(activityName) === 'free') return 0;

        if (window.RotationEngine?.calculateRotationScore) {
            const score = window.RotationEngine.calculateRotationScore({
                bunkName: bunk,
                activityName: activityName,
                divisionName: grade,
                beforeSlotIndex: slotIdx || 0,
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

        // Rotation score cache — invalidated per-bunk after each assignment
        // so scores reflect what was already placed today
        const rotationCache = new Map();
        function getCachedRotation(bunk, sport, grade, slotIdx) {
            const key = bunk + '|' + sport + '|' + (slotIdx || 0);
            if (rotationCache.has(key)) return rotationCache.get(key);
            const score = getRotationScore(bunk, sport, grade, slotIdx);
            rotationCache.set(key, score);
            return score;
        }
        function invalidateRotationCacheForBunk(bunk) {
            for (const key of rotationCache.keys()) {
                if (key.startsWith(bunk + '|')) rotationCache.delete(key);
            }
            // Also clear RotationEngine's today-cache for this bunk
            if (window.RotationEngine?.invalidateBunkTodayCache) {
                window.RotationEngine.invalidateBunkTodayCache(bunk);
            }
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

        // ── Backtracking infrastructure ─────────────────────────────
        const MAX_BACKTRACKS = 30;
        const BACKTRACK_TIME_BUDGET = 10000;
        let backtrackCount = 0;
        const assignmentStack = [];

        function snapshotState() {
            const saClone = {};
            const sa = window.scheduleAssignments || {};
            for (const bk of Object.keys(sa)) {
                if (!Array.isArray(sa[bk])) { saClone[bk] = sa[bk]; continue; }
                saClone[bk] = sa[bk].map(e => e ? Object.assign({}, e) : e);
            }
            const fiClone = new Map();
            for (const [k, arr] of fieldIndex) {
                fiClone.set(k, arr.map(e => Object.assign({}, e)));
            }
            const baClone = new Map();
            for (const [k, s] of bunkActivities) {
                baClone.set(k, new Set(s));
            }
            const fubsClone = {};
            const fubs = window.fieldUsageBySlot || {};
            for (const si of Object.keys(fubs)) {
                fubsClone[si] = {};
                for (const fn of Object.keys(fubs[si])) {
                    const o = fubs[si][fn];
                    fubsClone[si][fn] = {
                        count: o.count,
                        bunks: Object.assign({}, o.bunks),
                        divisions: o.divisions ? o.divisions.slice() : []
                    };
                }
            }
            return {
                scheduleAssignments: saClone,
                fieldIndex: fiClone,
                bunkActivities: baClone,
                fieldUsageBySlot: fubsClone,
                rotationCache: new Map(rotationCache),
                gradeFieldOptions: new Map(gradeFieldOptions)
            };
        }

        function restoreState(snapshot) {
            window.scheduleAssignments = {};
            for (const bk of Object.keys(snapshot.scheduleAssignments)) {
                const arr = snapshot.scheduleAssignments[bk];
                if (!Array.isArray(arr)) { window.scheduleAssignments[bk] = arr; continue; }
                window.scheduleAssignments[bk] = arr.map(e => e ? Object.assign({}, e) : e);
            }
            fieldIndex.clear();
            for (const [k, arr] of snapshot.fieldIndex) {
                fieldIndex.set(k, arr.map(e => Object.assign({}, e)));
            }
            bunkActivities.clear();
            for (const [k, s] of snapshot.bunkActivities) {
                bunkActivities.set(k, new Set(s));
            }
            window.fieldUsageBySlot = {};
            for (const si of Object.keys(snapshot.fieldUsageBySlot)) {
                window.fieldUsageBySlot[si] = {};
                for (const fn of Object.keys(snapshot.fieldUsageBySlot[si])) {
                    const o = snapshot.fieldUsageBySlot[si][fn];
                    window.fieldUsageBySlot[si][fn] = {
                        count: o.count,
                        bunks: Object.assign({}, o.bunks),
                        divisions: o.divisions ? o.divisions.slice() : []
                    };
                }
            }
            rotationCache.clear();
            for (const [k, v] of snapshot.rotationCache) rotationCache.set(k, v);
            gradeFieldOptions.clear();
            for (const [k, v] of snapshot.gradeFieldOptions) gradeFieldOptions.set(k, v);
        }

        function rebuildAutoFieldLocks() {
            if (!window.AutoFieldLocks) return;
            if (window.AutoFieldLocks.clearAll) window.AutoFieldLocks.clearAll();
            if (!window.AutoFieldLocks.claimField) return;
            const sa = window.scheduleAssignments || {};
            const dt = window.divisionTimes || {};
            for (const [bk, slots] of Object.entries(sa)) {
                if (!Array.isArray(slots)) continue;
                let gr = '';
                for (const [g, d] of Object.entries(divisions)) {
                    if ((d.bunks || []).map(String).includes(String(bk))) { gr = g; break; }
                }
                const pbs = window._perBunkSlots?.[gr]?.[bk]
                    || dt[gr]?._perBunkSlots?.[bk]
                    || (Array.isArray(dt[gr]) ? dt[gr] : []);
                slots.forEach((e, idx) => {
                    if (!e || e.field === 'Free' || e.continuation) return;
                    const sM = pbs[idx]?.startMin ?? e._startMin;
                    const eM = pbs[idx]?.endMin ?? e._endMin;
                    if (sM == null || eM == null) return;
                    window.AutoFieldLocks.claimField(e.field, sM, eM, bk, gr, e.sport || e._activity);
                });
            }
        }

        function findBlameTarget(block, allCandidates, startMin, endMin, bunk, grade) {
            if (assignmentStack.length === 0) return -1;
            const blockingFields = new Set();
            for (const cand of allCandidates) {
                if (!isFieldAvailableByTime(cand.field, startMin, endMin, bunk, grade, fieldIndex, cand)) {
                    blockingFields.add(normName(cand.field));
                }
            }
            if (blockingFields.size === 0) return -1;
            for (let si = assignmentStack.length - 1; si >= 0; si--) {
                const entry = assignmentStack[si];
                if (entry.pick._fixed || entry.pick._pinned || entry.pick._league) continue;
                const pickFieldNorm = normName(entry.pick.field);
                if (blockingFields.has(pickFieldNorm)) {
                    if (entry.candidateIdx + 1 < entry.scored.length) return si;
                }
            }
            return -1;
        }

        // ── Solve each block ─────────────────────────────────────────
        let filled = 0, free = 0;
        let blockIdx = 0;
        let forceStartCandidate = -1;

        while (blockIdx < blocks.length) {
            const block = blocks[blockIdx];
            const bunk = block.bunk;
            const grade = block.divName || '';
            const slotIdx = block.slots?.[0];
            const startMin = parseTime(block.startTime);
            const endMin = parseTime(block.endTime);

            if (startMin == null || endMin == null || !bunk) {
                writeFree(block);
                free++;
                blockIdx++;
                continue;
            }

            const existing = window.scheduleAssignments?.[bunk]?.[slotIdx];
            if (existing && (existing._fixed || existing._locked)) { blockIdx++; continue; }

            const doneToday = bunkActivities.get(bunk) || new Set();

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

            const scored = [];
            for (const cand of candidates) {
                if (doneToday.has(cand.sportNorm)) continue;

                if ((prevAdjacentSport && prevAdjacentSport === cand.sportNorm) ||
                    (nextAdjacentSport && nextAdjacentSport === cand.sportNorm)) continue;

                if (!isFieldAvailableByTime(cand.field, startMin, endMin, bunk, grade, fieldIndex, cand)) continue;

                if (isRainy && !cand.isIndoor) continue;

                let score = getCachedRotation(bunk, cand.sport, grade, slotIdx);
                score += getDraftBonus(block, cand);

                const fn = cand.fieldNorm;
                const existing = (fieldIndex.get(fn) || []).filter(e =>
                    e.startMin < endMin && e.endMin > startMin && e.bunk !== bunk
                );
                if (existing.length > 0) {
                    const sameAct = existing.filter(e => e.activity === cand.sportNorm);
                    if (sameAct.length > 0) score -= 1500;
                    else score += 300;
                }

                score += getScarcityPenalty(cand.fieldNorm, startMin, endMin, grade);

                const bunkNum = parseInt(String(bunk).replace(/\D/g, '')) || 0;
                const adjacentOnField = existing.some(e => {
                    const eNum = parseInt(String(e.bunk).replace(/\D/g, '')) || 0;
                    return Math.abs(eNum - bunkNum) <= 1 && e.activity === cand.sportNorm;
                });
                if (adjacentOnField) score -= 500;

                {
                    let gradeSportCount = 0;
                    for (const [ob, oslots] of Object.entries(window.scheduleAssignments || {})) {
                        if (String(ob) === String(bunk)) continue;
                        if (!Array.isArray(oslots)) continue;
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
                    score += gradeSportCount * 200;
                }

                {
                    const wk = startMin + '-' + endMin;
                    const fieldWindows = scarcityMap.get(fn);
                    if (fieldWindows && fieldWindows.has(wk)) {
                        const fw = fieldWindows.get(wk);
                        const competingGrades = fw.grades.size - 1;
                        if (competingGrades > 0) {
                            const cap = cand.capacity || 2;
                            const occ = existing.length;
                            const remaining = cap - occ - 1;
                            if (remaining <= 0) {
                                score += competingGrades * 300;
                            }
                        }
                    }
                }

                scored.push({ cand, score });
            }

            scored.sort((a, b) => {
                if (a.score !== b.score) return a.score - b.score;
                const aq = (a.cand?.qualityRank ?? a.cand?.field?.qualityRank ?? 999);
                const bq = (b.cand?.qualityRank ?? b.cand?.field?.qualityRank ?? 999);
                return aq - bq;
            });

            // Determine starting candidate index (for backtracking retries)
            let startCandIdx = 0;
            if (forceStartCandidate >= 0) {
                startCandIdx = forceStartCandidate;
                forceStartCandidate = -1;
            }

            if (scored.length === 0 || startCandIdx >= scored.length) {
                // ── Backtracking: try to undo a blamed prior assignment ──
                const canBacktrack = backtrackCount < MAX_BACKTRACKS
                    && (performance.now() - startTime) < BACKTRACK_TIME_BUDGET
                    && assignmentStack.length > 0;

                if (canBacktrack) {
                    const blameIdx = findBlameTarget(block, candidates, startMin, endMin, bunk, grade);
                    if (blameIdx >= 0) {
                        const blamed = assignmentStack[blameIdx];
                        log('BACKTRACK #' + (backtrackCount + 1) + ': block ' + blockIdx + ' (' + bunk + ') blames stack[' + blameIdx + '] (' + blamed.bunk + ' → ' + blamed.pick.sport + '), trying candidate ' + (blamed.candidateIdx + 1));
                        restoreState(blamed.snapshot);
                        const affectedBunks = new Set();
                        for (let si = blameIdx; si < assignmentStack.length; si++) {
                            affectedBunks.add(assignmentStack[si].bunk);
                        }
                        for (const ab of affectedBunks) {
                            if (window.RotationEngine?.invalidateBunkTodayCache) {
                                window.RotationEngine.invalidateBunkTodayCache(ab);
                            }
                            invalidateRotationCacheForBunk(ab);
                        }
                        rebuildAutoFieldLocks();

                        const newStartCand = blamed.candidateIdx + 1;
                        assignmentStack.length = blameIdx;
                        blockIdx = blamed.blockIdx;
                        forceStartCandidate = newStartCand;
                        backtrackCount++;
                        filled = blamed.filledBefore;
                        free = blamed.freeBefore;
                        continue;
                    }
                }

                writeFree(block);
                free++;
                blockIdx++;
                continue;
            }

            const pick = scored[startCandIdx].cand;

            // Snapshot state BEFORE committing this assignment
            const snapshot = snapshotState();

            writeAssignment(block, pick, startMin, endMin, bunk, grade, slotIdx);

            doneToday.add(pick.sportNorm);
            bunkActivities.set(bunk, doneToday);
            invalidateRotationCacheForBunk(bunk);

            const fn = pick.fieldNorm;
            if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
            fieldIndex.get(fn).push({ startMin, endMin, bunk, grade, slotIdx, activity: pick.sportNorm });

            updateDomainSizes(fieldIndex, startMin, endMin, candidates, gradeFieldOptions, windowBlocks);

            if (window.AutoFieldLocks?.claimField) {
                window.AutoFieldLocks.claimField(pick.field, startMin, endMin, bunk, grade, pick.sport);
            }

            if (window.RotationEngine?.invalidateBunkTodayCache) {
                window.RotationEngine.invalidateBunkTodayCache(bunk);
            }

            assignmentStack.push({
                blockIdx, block, bunk, slotIdx, grade, startMin, endMin,
                pick, score: scored[startCandIdx].score,
                snapshot, candidateIdx: startCandIdx, scored,
                filledBefore: filled, freeBefore: free
            });

            filled++;

            // ★ v12.0: Forward checking — detect domain wipeouts immediately.
            var fcWipeout = false;
            if (backtrackCount < MAX_BACKTRACKS && (performance.now() - startTime) < BACKTRACK_TIME_BUDGET) {
                for (var fi = blockIdx + 1; fi < blocks.length; fi++) {
                    var fb = blocks[fi];
                    if (fb._locked) continue;
                    var fbSM = parseTime(fb.startTime), fbEM = parseTime(fb.endTime);
                    if (fbSM !== startMin || fbEM !== endMin) continue;
                    var fbBunk = fb.bunk;
                    var fbGrade = fb.divName || '';
                    var fbSlotIdx = fb.slots?.[0];
                    var fbEx = window.scheduleAssignments?.[fbBunk]?.[fbSlotIdx];
                    if (fbEx && (fbEx._fixed || fbEx._locked)) continue;
                    var fbDone = bunkActivities.get(fbBunk) || new Set();
                    var fcCount = 0;
                    for (var ci = 0; ci < candidates.length && fcCount === 0; ci++) {
                        var fc = candidates[ci];
                        if (fbDone.has(fc.sportNorm)) continue;
                        if (!isFieldAvailableByTime(fc.field, fbSM, fbEM, fbBunk, fbGrade, fieldIndex, fc)) continue;
                        if (isRainy && !fc.isIndoor) continue;
                        fcCount++;
                    }
                    if (fcCount === 0) { fcWipeout = true; break; }
                }
            }
            if (fcWipeout && assignmentStack.length > 0) {
                var lastEntry = assignmentStack[assignmentStack.length - 1];
                if (lastEntry.candidateIdx + 1 < lastEntry.scored.length) {
                    log('FORWARD-CHECK: wipeout after ' + bunk + ' → ' + pick.sport + ', backtracking');
                    restoreState(lastEntry.snapshot);
                    for (var abi = assignmentStack.length - 1; abi >= 0; abi--) {
                        var ab2 = assignmentStack[abi].bunk;
                        if (window.RotationEngine?.invalidateBunkTodayCache) window.RotationEngine.invalidateBunkTodayCache(ab2);
                        invalidateRotationCacheForBunk(ab2);
                    }
                    rebuildAutoFieldLocks();
                    forceStartCandidate = lastEntry.candidateIdx + 1;
                    blockIdx = lastEntry.blockIdx;
                    filled = lastEntry.filledBefore;
                    free = lastEntry.freeBefore;
                    assignmentStack.length = assignmentStack.length - 1;
                    backtrackCount++;
                    continue;
                }
            }

            // ★ v12.0: Dynamic re-sort every 8 assignments
            if (filled > 0 && filled % 8 === 0 && blockIdx + 1 < blocks.length) {
                var remaining = blocks.slice(blockIdx + 1);
                remaining.sort(function(a, b) {
                    var aHint = a._draftActivity ? -1 : 0;
                    var bHint = b._draftActivity ? -1 : 0;
                    if (aHint !== bHint) return aHint - bHint;
                    var aSM = parseTime(a.startTime), aEM = parseTime(a.endTime);
                    var bSM = parseTime(b.startTime), bEM = parseTime(b.endTime);
                    if (aSM !== bSM) return (aSM || 0) - (bSM || 0);
                    var aG = a.divName || '', bG = b.divName || '';
                    var aOpts = gradeFieldOptions.get(aG + '|' + aSM + '-' + aEM) || 999;
                    var bOpts = gradeFieldOptions.get(bG + '|' + bSM + '-' + bEM) || 999;
                    if (aOpts !== bOpts) return aOpts - bOpts;
                    var aRegret = regretMap.get(aG + '|' + (aSM||0) + '-' + (aEM||0)) || 0;
                    var bRegret = regretMap.get(bG + '|' + (bSM||0) + '-' + (bEM||0)) || 0;
                    if (Math.abs(aRegret - bRegret) > 0.001) return bRegret - aRegret;
                    return 0;
                });
                for (var ri = 0; ri < remaining.length; ri++) blocks[blockIdx + 1 + ri] = remaining[ri];
            }

            blockIdx++;
        }

        if (backtrackCount > 0) {
            log('★ Backtracking: ' + backtrackCount + ' backtracks performed');
        }

        // ── Post-solve swap optimization ─────────────────────────────
        const swapCount = pairwiseSwapOptimization(candidates, fieldIndex, bunkActivities, divisions);

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

        // ★ v12.1: Colocate pass — aggressive sharing for any blocks still Free ──
        const { candidates: colocCands } = buildCandidates(config);
        const colocFixed = colocateFreeBlocks(colocCands);
        free = Math.max(0, free - colocFixed);

        // ★ v12.0: Capacity relaxation — last resort, allow cap+1 for remaining Free ──
        const capRelaxFixed = capacityRelaxRepair(config);
        free = Math.max(0, free - capRelaxFixed);

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  SOLVE COMPLETE in ' + elapsed + 's');
        log('║  ' + blocks.length + ' blocks, ' + filled + ' filled, ' + free + ' Free');
        if (dupFixes > 0)      log('║  ' + dupFixes + ' same-day duplicates fixed');
        if (lnsFixed > 0)      log('║  ' + lnsFixed + ' Free blocks recovered by LNS');
        if (ejectionFixed > 0) log('║  ' + ejectionFixed + ' Free blocks recovered by ejection chains');
        if (bfsFixed > 0)      log('║  ' + bfsFixed + ' Free blocks recovered by BFS augmenting');
        if (colocFixed > 0)    log('║  ' + colocFixed + ' Free blocks recovered by colocate (sharing)');
        if (capRelaxFixed > 0) log('║  ' + capRelaxFixed + ' Free blocks recovered by capacity relaxation');
        if (swapCount > 0)     log('║  ' + swapCount + ' rotation-improving swaps');
        log('╚═══════════════════════════════════════════════════════════╝');

        return { filled, free, elapsed, dupFixes, lnsFixed, ejectionFixed, bfsFixed, swapCount, capRelaxFixed };
    }


    // =========================================================================
    // WRITE HELPERS
    // =========================================================================

    // ── Cross-grade pressure helper (Slice 3 audit, N18) ──────────────
    // Repair phases used to pick the first matching candidate. That
    // could land a free block on a field other grades urgently need
    // (no spare capacity), while a less-contested alternative sat
    // unused. We can't access the main solver's full scarcityMap from
    // here (it's a closure local), but the fieldIndex passed into each
    // repair helper has everything we need to compute a simple cross-
    // grade pressure score: count distinct other grades already using
    // the candidate field in the FB's time window. Higher = more
    // contested = should be deprioritized.
    function _crossGradePressure(cand, fb, fieldIndex) {
        try {
            const fn = cand?.fieldNorm || (cand?.field ? normName(cand.field) : null);
            if (!fn || !fieldIndex?.get) return 0;
            const entries = fieldIndex.get(fn) || [];
            const otherGrades = new Set();
            for (const e of entries) {
                if (!e || e.bunk === fb.bunk) continue;
                if (e.endMin <= fb.startMin || e.startMin >= fb.endMin) continue;
                if (e.grade != null && e.grade !== fb.grade) otherGrades.add(e.grade);
            }
            return otherGrades.size;
        } catch (_) { return 0; }
    }
    function _sortCandidatesByPressure(candidates, fb, fieldIndex) {
        // Stable: lower pressure first; preserves caller's prior ordering.
        const indexed = candidates.map((c, i) => ({ c, i, p: _crossGradePressure(c, fb, fieldIndex) }));
        indexed.sort((a, b) => a.p !== b.p ? a.p - b.p : a.i - b.i);
        return indexed.map(x => x.c);
    }

    // ── Bunk-done-today helper (shared) ────────────────────────────────
    // Slice 3 audit fix (Deferred-2): centralized so the three repair
    // phases (tryDirectFill, colocateFreeBlocks, ejection chain) all
    // share the same definition. Previously each rebuilt its own from
    // scratch; if a future caller forgets the optional `extraSports`
    // arg (used by chain construction to inject in-flight commits not
    // yet in scheduleAssignments), the helpers disagree about what
    // the bunk has placed.
    function getBunkDoneToday(bunk, excludeSlotIdx, extraSports) {
        const done = new Set();
        const slots = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
        for (let i = 0; i < slots.length; i++) {
            if (i === excludeSlotIdx) continue;
            const e = slots[i];
            if (!e || e.continuation) continue;
            const act = normName(e._activity || e.sport || e.field);
            if (act && act !== 'free' && act !== 'free play') done.add(act);
        }
        if (extraSports) extraSports.forEach(s => done.add(s));
        return done;
    }

    // ── HARD WRITE GUARD ────────────────────────────────────────────────
    // Reads field rules from live globalSettings on every call — no
    // caching. Caching kept producing stale data because gs.app1.fields
    // can be reassigned by cloud-sync/facilities edits between auto runs,
    // and the cached map then pointed at old field objects whose
    // timeRules array no longer contained the rules the safety net sees.
    function commitWriteIfLegal(bunk, slotIdx, fieldName, sport, grade, startMin, endMin, entry) {
        if (!window.scheduleAssignments) return false;
        // Hoisted so cooldown / special-access blocks below can reuse the
        // resolved start/end (falling back to entry._startMin/_endMin).
        let sMin = startMin, eMin = endMin;
        if ((sMin == null || eMin == null) && entry) {
            if (entry._startMin != null) sMin = entry._startMin;
            if (entry._endMin != null) eMin = entry._endMin;
        }
        if (fieldName && fieldName !== 'Free') {
            // Always read live — safe and cheap (small array, runs only on writes)
            const gs = (typeof window.loadGlobalSettings === 'function') ? window.loadGlobalSettings() : {};
            const fields = gs.app1?.fields || [];
            const fld = fields.find(f => f && f.name === fieldName);
            if (fld) {
                // Field-level access restriction
                if (fld.accessRestrictions && fld.accessRestrictions.enabled) {
                    const divs = fld.accessRestrictions.divisions || {};
                    const gradeKey = String(grade);
                    if (!(gradeKey in divs) && !(grade in divs)) {
                        log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') ' + (sport || '?') + ' @ ' + fieldName + ' — access');
                        return false;
                    }
                    const bunkList = divs[gradeKey] || divs[grade];
                    if (Array.isArray(bunkList) && bunkList.length > 0
                        && !bunkList.map(String).includes(String(bunk))) {
                        log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') ' + (sport || '?') + ' @ ' + fieldName + ' — bunk-access');
                        return false;
                    }
                }
                // Field-level grade-scoped time rules (sMin/eMin hoisted above)
                if (Array.isArray(fld.timeRules) && fld.timeRules.length > 0
                    && sMin != null && eMin != null) {
                    const myG = grade != null ? String(grade) : null;
                    const _parseTM = window.SchedulerCoreUtils?.parseTimeToMinutes;
                    let hasGradeAvail = false, insideAvail = false;
                    for (const r of fld.timeRules) {
                        const t = String(r.type || '').toLowerCase();
                        const isUn = t === 'unavailable' || r.available === false;
                        const isAv = t === 'available' || r.available === true;
                        const rs = r.startMin != null ? r.startMin
                                  : (_parseTM ? _parseTM(r.start || r.startTime) : null);
                        const re = r.endMin != null ? r.endMin
                                  : (_parseTM ? _parseTM(r.end || r.endTime) : null);
                        if (rs == null || re == null || (!isUn && !isAv)) continue;
                        const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                        if (rDivs.length > 0 && myG && rDivs.indexOf(myG) === -1) continue;
                        if (isUn && rs < eMin && re > sMin) {
                            log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') ' + (sport || '?') + ' @ ' + fieldName + ' — Unavailable ' + rs + '-' + re + ' (slot ' + sMin + '-' + eMin + ')');
                            return false;
                        }
                        if (isAv) {
                            hasGradeAvail = true;
                            if (sMin >= rs && eMin <= re) insideAvail = true;
                        }
                    }
                    if (hasGradeAvail && !insideAvail) {
                        log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') ' + (sport || '?') + ' @ ' + fieldName + ' — outside Available (slot ' + sMin + '-' + eMin + ')');
                        return false;
                    }
                }
            }

            // ★ Special-level access restriction — when the activity matches
            //   a configured special, enforce its accessRestrictions too.
            //   Without this, a sport whose name collides with a special, or
            //   a special drafted via a non-2.7 path, slips past Step 4.95
            //   and gets cleared post-hoc.
            if (sport) {
                const specials = gs.app1?.specialActivities || [];
                const sp = specials.find(s => s && s.name === sport);
                if (sp?.accessRestrictions?.enabled) {
                    const sDivs = sp.accessRestrictions.divisions || {};
                    const gKey = String(grade);
                    if (!(gKey in sDivs) && !(grade in sDivs)) {
                        log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') special "' + sport + '" — access');
                        return false;
                    }
                    const sBunkAllow = sDivs[gKey] || sDivs[grade];
                    if (Array.isArray(sBunkAllow) && sBunkAllow.length > 0
                        && !sBunkAllow.map(String).includes(String(bunk))) {
                        log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') special "' + sport + '" — bunk-access');
                        return false;
                    }
                }
            }
        }

        // ★ Cooldown rules from rules.js — applies whether or not this is a
        //   field write (specials placed at named locations also have type
        //   constraints e.g. "no Sport 30 min after Lunch"). Without this,
        //   solver/repair phases happily violate cooldowns and Step 4.95
        //   doesn't re-check them, so violations persist into the saved day.
        try {
            if (window.SchedulingRules?.isCandidateAllowed && entry && sMin != null && eMin != null) {
                const cand = {
                    startMin: sMin,
                    endMin: eMin,
                    type: entry.type || (entry._assignedSpecial ? 'special' : 'sport'),
                    event: entry.event || entry._activity || sport || '',
                    field: fieldName,
                    _assignedSpecial: entry._assignedSpecial,
                    _specialLocation: entry._specialLocation
                };
                const existing = window.scheduleAssignments[bunk] || [];
                const template = [];
                for (let ti = 0; ti < existing.length; ti++) {
                    if (ti === slotIdx) continue;
                    const w = existing[ti];
                    if (!w || w.continuation) continue;
                    const ws = w._startMin, we = w._endMin;
                    if (ws == null || we == null) continue;
                    template.push({
                        startMin: ws, endMin: we,
                        type: w.type || (w._assignedSpecial ? 'special' : (w.field === 'Free' ? 'free' : 'sport')),
                        event: w.event || w._activity || w.sport || '',
                        field: w.field, _assignedSpecial: w._assignedSpecial,
                        _specialLocation: w._specialLocation
                    });
                }
                const _cdOpts = { mode: 'auto' };
                if (window._previousDayEndBlocks && window._previousDayEndBlocks[bunk]) {
                    _cdOpts.previousDayBlocks = window._previousDayEndBlocks[bunk];
                }
                if (!window.SchedulingRules.isCandidateAllowed(cand, template, _cdOpts)) {
                    log('writeGuard BLOCKED: ' + bunk + ' (' + grade + ') ' + (sport || '?') + ' @ ' + (fieldName || '?') + ' — cooldown rule');
                    return false;
                }
            }
        } catch (e) { /* never let a rule lookup error block legal writes */ }

        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
        window.scheduleAssignments[bunk][slotIdx] = entry;
        // Invalidate rotation caches for this bunk so any later score
        // (in repair phases or other modules) reflects the just-placed
        // activity. Earlier this was only done from the main solver
        // loop; repair-phase commits left stale scores around.
        try {
            if (window.RotationEngine?.invalidateBunkTodayCache) {
                window.RotationEngine.invalidateBunkTodayCache(bunk);
            }
        } catch (e) {
            // Log so the regression that N12 fixed (rotation cache staleness
            // after commits) isn't silently re-introduced by a signature
            // change in RotationEngine.
            console.warn('[commitWriteIfLegal] invalidate rotation cache failed:', e?.message || e);
        }
        return true;
    }

    // =========================================================================
    // SWAP LEGALITY CHECK (read-only mirror of commitWriteIfLegal validation)
    // =========================================================================
    function isSwapLegal(bunk, slotIdx, fieldName, sport, grade, startMin, endMin, fieldIndex, candidate) {
        if (!fieldName || fieldName === 'Free') return true;

        const gs = (typeof window.loadGlobalSettings === 'function') ? window.loadGlobalSettings() : {};
        const fields = gs.app1?.fields || [];
        const fld = fields.find(f => f && f.name === fieldName);
        if (fld) {
            if (fld.accessRestrictions && fld.accessRestrictions.enabled) {
                const divs = fld.accessRestrictions.divisions || {};
                const gradeKey = String(grade);
                if (!(gradeKey in divs) && !(grade in divs)) return false;
                const bunkList = divs[gradeKey] || divs[grade];
                if (Array.isArray(bunkList) && bunkList.length > 0
                    && !bunkList.map(String).includes(String(bunk))) return false;
            }
            if (Array.isArray(fld.timeRules) && fld.timeRules.length > 0
                && startMin != null && endMin != null) {
                const myG = grade != null ? String(grade) : null;
                const _parseTM = window.SchedulerCoreUtils?.parseTimeToMinutes;
                let hasGradeAvail = false, insideAvail = false;
                for (const r of fld.timeRules) {
                    const t = String(r.type || '').toLowerCase();
                    const isUn = t === 'unavailable' || r.available === false;
                    const isAv = t === 'available' || r.available === true;
                    const rs = r.startMin != null ? r.startMin
                              : (_parseTM ? _parseTM(r.start || r.startTime) : null);
                    const re = r.endMin != null ? r.endMin
                              : (_parseTM ? _parseTM(r.end || r.endTime) : null);
                    if (rs == null || re == null || (!isUn && !isAv)) continue;
                    const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                    if (rDivs.length > 0 && myG && rDivs.indexOf(myG) === -1) continue;
                    if (isUn && rs < endMin && re > startMin) return false;
                    if (isAv) {
                        hasGradeAvail = true;
                        if (startMin >= rs && endMin <= re) insideAvail = true;
                    }
                }
                if (hasGradeAvail && !insideAvail) return false;
            }
        }

        if (sport) {
            const specials = gs.app1?.specialActivities || [];
            const sp = specials.find(s => s && s.name === sport);
            if (sp?.accessRestrictions?.enabled) {
                const sDivs = sp.accessRestrictions.divisions || {};
                const gKey = String(grade);
                if (!(gKey in sDivs) && !(grade in sDivs)) return false;
                const sBunkAllow = sDivs[gKey] || sDivs[grade];
                if (Array.isArray(sBunkAllow) && sBunkAllow.length > 0
                    && !sBunkAllow.map(String).includes(String(bunk))) return false;
            }
        }

        try {
            if (window.SchedulingRules?.isCandidateAllowed && startMin != null && endMin != null) {
                const cand = {
                    startMin, endMin,
                    type: 'sport',
                    event: sport || '',
                    field: fieldName
                };
                const existing = window.scheduleAssignments?.[bunk] || [];
                const template = [];
                for (let ti = 0; ti < existing.length; ti++) {
                    if (ti === slotIdx) continue;
                    const w = existing[ti];
                    if (!w || w.continuation) continue;
                    const ws = w._startMin, we = w._endMin;
                    if (ws == null || we == null) continue;
                    template.push({
                        startMin: ws, endMin: we,
                        type: w.type || (w._assignedSpecial ? 'special' : (w.field === 'Free' ? 'free' : 'sport')),
                        event: w.event || w._activity || w.sport || '',
                        field: w.field, _assignedSpecial: w._assignedSpecial,
                        _specialLocation: w._specialLocation
                    });
                }
                const _cdOpts = { mode: 'auto' };
                if (window._previousDayEndBlocks && window._previousDayEndBlocks[bunk]) {
                    _cdOpts.previousDayBlocks = window._previousDayEndBlocks[bunk];
                }
                if (!window.SchedulingRules.isCandidateAllowed(cand, template, _cdOpts)) return false;
            }
        } catch (e) { /* safe fallback */ }

        if (!isFieldAvailableByTime(fieldName, startMin, endMin, bunk, grade, fieldIndex, candidate)) return false;

        return true;
    }


    // =========================================================================
    // POST-SOLVE PAIRWISE SWAP OPTIMIZATION
    // =========================================================================
    function pairwiseSwapOptimization(candidates, fieldIndex, bunkActivities, divisions) {
        const MAX_PASSES = 3;
        const MAX_TIME_MS = 2000;
        const swapStart = performance.now();
        const sa = window.scheduleAssignments || {};
        let totalSwaps = 0;

        const candidateByFieldSport = new Map();
        candidates.forEach(c => {
            candidateByFieldSport.set(normName(c.field) + '|' + c.sportNorm, c);
        });
        function findCandidate(fieldName, sport) {
            return candidateByFieldSport.get(normName(fieldName) + '|' + normName(sport)) || null;
        }

        function getBunkGrade(bunk) {
            for (const [g, d] of Object.entries(divisions)) {
                if ((d.bunks || []).map(String).includes(String(bunk))) return g;
            }
            return '';
        }

        function bunkHasSportElsewhere(bunk, sportNorm, excludeSlotIdx) {
            const slots = sa[bunk];
            if (!Array.isArray(slots)) return false;
            for (let i = 0; i < slots.length; i++) {
                if (i === excludeSlotIdx) continue;
                const e = slots[i];
                if (!e || e.continuation || e.field === 'Free') continue;
                if (normName(e._activity || e.sport || '') === sportNorm) return true;
            }
            return false;
        }

        function getAdjacentSport(bunk, slotIdx, direction) {
            const slots = sa[bunk];
            if (!Array.isArray(slots)) return null;
            if (direction < 0) {
                for (let i = slotIdx - 1; i >= 0; i--) {
                    const s = slots[i];
                    if (!s || s.continuation) continue;
                    if (s.field === 'Free') return null;
                    return normName(s._activity || s.sport || '');
                }
            } else {
                for (let i = slotIdx + 1; i < slots.length; i++) {
                    const s = slots[i];
                    if (!s || s.continuation) continue;
                    if (s.field === 'Free') return null;
                    return normName(s._activity || s.sport || '');
                }
            }
            return null;
        }

        for (let pass = 0; pass < MAX_PASSES; pass++) {
            if (performance.now() - swapStart > MAX_TIME_MS) break;
            let passSwaps = 0;

            const freshIndex = buildFieldTimeIndex();

            const windowGroups = new Map();
            Object.entries(sa).forEach(([bunk, slots]) => {
                if (!Array.isArray(slots)) return;
                const grade = getBunkGrade(bunk);
                slots.forEach((entry, idx) => {
                    if (!entry || entry.continuation || entry.field === 'Free') return;
                    if (entry._fixed || entry._pinned || entry._league) return;
                    const sMin = entry._startMin, eMin = entry._endMin;
                    if (sMin == null || eMin == null) return;
                    const wk = sMin + '-' + eMin;
                    if (!windowGroups.has(wk)) windowGroups.set(wk, []);
                    windowGroups.get(wk).push({ bunk, grade, slotIdx: idx, entry, startMin: sMin, endMin: eMin });
                });
            });

            for (const [wk, group] of windowGroups) {
                if (performance.now() - swapStart > MAX_TIME_MS) break;
                if (group.length < 2) continue;

                for (let i = 0; i < group.length; i++) {
                    for (let j = i + 1; j < group.length; j++) {
                        if (performance.now() - swapStart > MAX_TIME_MS) break;
                        const a = group[i], b = group[j];

                        const aSport = normName(a.entry._activity || a.entry.sport || '');
                        const bSport = normName(b.entry._activity || b.entry.sport || '');
                        if (aSport === bSport) continue;

                        if (bunkHasSportElsewhere(a.bunk, bSport, a.slotIdx)) continue;
                        if (bunkHasSportElsewhere(b.bunk, aSport, b.slotIdx)) continue;

                        const aPrev = getAdjacentSport(a.bunk, a.slotIdx, -1);
                        const aNext = getAdjacentSport(a.bunk, a.slotIdx, 1);
                        const bPrev = getAdjacentSport(b.bunk, b.slotIdx, -1);
                        const bNext = getAdjacentSport(b.bunk, b.slotIdx, 1);
                        if ((aPrev && aPrev === bSport) || (aNext && aNext === bSport)) continue;
                        if ((bPrev && bPrev === aSport) || (bNext && bNext === aSport)) continue;

                        const aRotCurr = getRotationScore(a.bunk, a.entry.sport || aSport, a.grade);
                        const bRotCurr = getRotationScore(b.bunk, b.entry.sport || bSport, b.grade);
                        const currScore = aRotCurr + bRotCurr;

                        const aRotSwap = getRotationScore(a.bunk, b.entry.sport || bSport, a.grade);
                        const bRotSwap = getRotationScore(b.bunk, a.entry.sport || aSport, b.grade);
                        const swapScore = aRotSwap + bRotSwap;

                        if (swapScore >= currScore) continue;

                        const tmpIndex = buildFieldTimeIndex();
                        const aFiEntries = tmpIndex.get(normName(a.entry.field)) || [];
                        const bFiEntries = tmpIndex.get(normName(b.entry.field)) || [];
                        const aFiIdx = aFiEntries.findIndex(e => e.bunk === a.bunk && e.slotIdx === a.slotIdx);
                        const bFiIdx = bFiEntries.findIndex(e => e.bunk === b.bunk && e.slotIdx === b.slotIdx);
                        if (aFiIdx >= 0) aFiEntries.splice(aFiIdx, 1);
                        if (bFiIdx >= 0) bFiEntries.splice(bFiIdx, 1);

                        const candA = findCandidate(b.entry.field, b.entry.sport || bSport);
                        const candB = findCandidate(a.entry.field, a.entry.sport || aSport);

                        const origA = sa[a.bunk][a.slotIdx];
                        const origB = sa[b.bunk][b.slotIdx];
                        sa[a.bunk][a.slotIdx] = null;
                        sa[b.bunk][b.slotIdx] = null;

                        const aLegal = isSwapLegal(a.bunk, a.slotIdx, b.entry.field, b.entry.sport || bSport, a.grade, a.startMin, a.endMin, tmpIndex, candA);
                        const bLegal = isSwapLegal(b.bunk, b.slotIdx, a.entry.field, a.entry.sport || aSport, b.grade, b.startMin, b.endMin, tmpIndex, candB);

                        if (aLegal && bLegal) {
                            sa[a.bunk][a.slotIdx] = {
                                field: b.entry.field, sport: b.entry.sport, _activity: b.entry._activity,
                                _autoMode: true, _autoSolved: true,
                                _startMin: a.startMin, _endMin: a.endMin, _blockStart: a.startMin,
                                _division: a.grade, continuation: false, _swapped: true
                            };
                            sa[b.bunk][b.slotIdx] = {
                                field: a.entry.field, sport: a.entry.sport, _activity: a.entry._activity,
                                _autoMode: true, _autoSolved: true,
                                _startMin: b.startMin, _endMin: b.endMin, _blockStart: b.startMin,
                                _division: b.grade, continuation: false, _swapped: true
                            };

                            group[i] = { ...a, entry: sa[a.bunk][a.slotIdx] };
                            group[j] = { ...b, entry: sa[b.bunk][b.slotIdx] };

                            passSwaps++;
                            log('SWAP: ' + a.bunk + '(' + aSport + ') ↔ ' + b.bunk + '(' + bSport + ') @ ' + wk + ' Δrot=' + (currScore - swapScore));
                        } else {
                            sa[a.bunk][a.slotIdx] = origA;
                            sa[b.bunk][b.slotIdx] = origB;
                        }
                    }
                }
            }

            totalSwaps += passSwaps;
            if (passSwaps === 0) break;
        }

        if (totalSwaps > 0) {
            log('★ Swap optimization: ' + totalSwaps + ' improving swaps in ' + ((performance.now() - swapStart) / 1000).toFixed(2) + 's');
        }
        return totalSwaps;
    }


    function writeAssignment(block, pick, startMin, endMin, bunk, grade, slotIdx) {
        if (!window.scheduleAssignments?.[bunk]) return;
        const entry = {
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
        if (!commitWriteIfLegal(bunk, slotIdx, pick.field, pick.sport, grade, startMin, endMin, entry)) return;

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
        // Slice 3 audit fix (N14): stamp time bounds even on Free entries
        // so downstream consumers (rule-template builders, descriptor
        // matchers, capacity readers) can reason about Free as a
        // first-class block. Earlier these were missing and any code
        // that built a rule template from `scheduleAssignments` skipped
        // Free slots entirely.
        //
        // The solver's primary input blocks (built by scheduler_core_auto)
        // carry `startTime` / `endTime` as strings, not `startMin` /
        // `endMin`. Fall through to `parseTimeMin` so the primary solve
        // pass also benefits — earlier this fix only landed for the
        // repair-phase `collectFreeBlocks` callers and silently emitted
        // null on the main path.
        let _sMin = block.startMin;
        let _eMin = block.endMin;
        const _ptm = window.SchedulerCoreUtils?.parseTimeToMinutes;
        if (_sMin == null && block.startTime && _ptm) _sMin = _ptm(block.startTime);
        if (_eMin == null && block.endTime && _ptm) _eMin = _ptm(block.endTime);
        window.scheduleAssignments[bunk][slotIdx] = {
            field: 'Free', sport: null, _activity: 'Free',
            _autoMode: true, _autoSolved: true, continuation: false,
            _startMin: _sMin ?? null,
            _endMin: _eMin ?? null
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
                        // Both same type — demote the later occurrence
                        demoteIdx = idx;
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

                    // ★ Route through hard guard so accessRestrictions /
                    //   timeRules / Unavailable windows reject illegal fills.
                    //   Direct writes here were the dominant source of
                    //   Step 4.95 rescues / cleared-to-Free placements.
                    const fbEntry = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _fallbackFill: true,
                        _startMin: startMin, _endMin: endMin, continuation: false
                    };
                    if (!commitWriteIfLegal(bunk, idx, cand.field, cand.sport, grade, startMin, endMin, fbEntry)) {
                        continue;
                    }

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

        // Centralized helper — same source-of-truth the ejection chain uses.
        const doneToday = getBunkDoneToday(fb.bunk, fb.slotIdx);

        // Scarcity-aware ordering: prefer candidates with fewer other-grade
        // overlaps in this window. Earlier the first matching candidate
        // won, which could land FB on a field other grades urgently need.
        const sortedCandidates = _sortCandidatesByPressure(candidates, fb, fieldIndex);

        for (const cand of sortedCandidates) {
            if (window.isRainyDay && !cand.isIndoor) continue;
            if (doneToday.has(cand.sportNorm)) continue;
            if (!isFieldAvailableByTime(cand.field, fb.startMin, fb.endMin, fb.bunk, fb.grade, fieldIndex, cand)) continue;

            const _entry = {
                field: cand.field, sport: cand.sport, _activity: cand.sport,
                _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false,
                _startMin: fb.startMin, _endMin: fb.endMin
            };
            if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, cand.field, cand.sport, fb.grade, fb.startMin, fb.endMin, _entry)) continue;
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

        // What does FB's bunk have today? Centralized helper.
        const fbDoneToday = getBunkDoneToday(fb.bunk, fb.slotIdx);

        // Scarcity-aware ordering (N18): least-contested fields first.
        const sortedCandidates = _sortCandidatesByPressure(candidates, fb, fieldIndex);
        for (const cand of sortedCandidates) {
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

                // Build victim's doneToday (excluding its own current slot).
                // Centralized helper — single source of truth.
                const victimDoneToday = getBunkDoneToday(victim.bunk, victim.slotIdx);

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
                    // Snapshot the victim's pre-swap cell so we can fully roll
                    // back if the FB write rejects. Earlier the rollback only
                    // restored fieldIndex but left scheduleAssignments[victim]
                    // mutated — a hard divergence between the index's view and
                    // actual placements.
                    const _victimSaPrev = window.scheduleAssignments?.[victim.bunk]?.[victim.slotIdx];

                    // 1. Move victim to its new field/sport
                    const _vEntry = {
                        field: victimNewCand.field, sport: victimNewCand.sport,
                        _activity: victimNewCand.sport,
                        _autoMode: true, _autoSolved: true, _lnsSwapped: true, continuation: false,
                        _startMin: victim.startMin, _endMin: victim.endMin
                    };
                    if (!commitWriteIfLegal(victim.bunk, victim.slotIdx, victimNewCand.field, victimNewCand.sport, victim.grade, victim.startMin, victim.endMin, _vEntry)) {
                        fieldIndex.set(fn, origEntries);
                        continue;
                    }
                    const vcFn = normName(victimNewCand.field);
                    if (!fieldIndex.has(vcFn)) fieldIndex.set(vcFn, []);
                    fieldIndex.get(vcFn).push({
                        startMin: victim.startMin, endMin: victim.endMin,
                        bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx,
                        activity: victimNewCand.sportNorm
                    });

                    // 2. Place FB in the now-vacated spot on cand's field
                    const _fbEntry = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _lnsRepaired: true, continuation: false,
                        _startMin: fb.startMin, _endMin: fb.endMin
                    };
                    if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, cand.field, cand.sport, fb.grade, fb.startMin, fb.endMin, _fbEntry)) {
                        // Full rollback: restore victim's prior assignment AND
                        // pop its newly-pushed fieldIndex entry, then restore
                        // the source field's pre-swap entries.
                        if (window.scheduleAssignments?.[victim.bunk]) {
                            window.scheduleAssignments[victim.bunk][victim.slotIdx] = _victimSaPrev;
                        }
                        const vcEntries = fieldIndex.get(vcFn);
                        if (Array.isArray(vcEntries) && vcEntries.length > 0) {
                            // Drop the most recently pushed entry (the one we just added).
                            vcEntries.pop();
                        }
                        fieldIndex.set(fn, origEntries);
                        continue;
                    }
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

    // =========================================================================
    // ★ v12.1: COLOCATE PASS — Aggressive sharing
    // =========================================================================
    // After the primary solve, some blocks remain Free because every candidate
    // field was at capacity or unavailable for that bunk.  However, many fields
    // have spare capacity (cap > 1) that the solver never exploited because it
    // assigns bunks independently.
    //
    // This pass reverses the logic: instead of asking "which field can I get?",
    // it asks "who is already on a field with remaining capacity, and can I join?"
    //
    // Algorithm:
    //   1. Build a map of (field, timeWindow) → [current occupants + capacity]
    //   2. For each Free block, check every occupied field-time that overlaps
    //      the block's time, in the same or compatible grade
    //   3. If capacity remains and sharing rules allow, assign this bunk to
    //      the same field/sport as the existing occupant
    //
    // This is intentionally MORE aggressive than tryDirectFill, which only looks
    // at the candidate list (fields pre-filtered for the sport type). Here we
    // look at everything that is already placed.
    // =========================================================================
    function colocateFreeBlocks(candidates) {
        const sa = window.scheduleAssignments || {};
        const freeBlocks = collectFreeBlocks();
        if (freeBlocks.length === 0) return 0;

        const fieldIndex = buildFieldTimeIndex();

        // Build ALL candidates per field so we can try different sports
        var candsByField = {};
        candidates.forEach(function(c) {
            var fn = normName(c.field);
            if (!candsByField[fn]) candsByField[fn] = [];
            candsByField[fn].push(c);
        });

        let fixed = 0;
        for (const fb of freeBlocks) {
            let placed = false;
            const doneToday = getBunkDoneToday(fb.bunk, fb.slotIdx);
            for (const [fn, entries] of fieldIndex) {
                if (placed) break;
                const overlapping = entries.filter(e =>
                    e.startMin === fb.startMin && e.endMin === fb.endMin && e.bunk !== fb.bunk
                );
                if (overlapping.length === 0) continue;

                var fieldCands = candsByField[fn];
                if (!fieldCands || fieldCands.length === 0) continue;

                for (var ci = 0; ci < fieldCands.length; ci++) {
                    var cand = fieldCands[ci];
                    if (!isFieldAvailableByTime(cand.field, fb.startMin, fb.endMin, fb.bunk, fb.grade, fieldIndex, cand)) continue;
                    if (doneToday.has(cand.sportNorm)) continue;

                    const _coEntry = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _colocated: true, continuation: false,
                        _startMin: fb.startMin, _endMin: fb.endMin
                    };
                    if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, cand.field, cand.sport, fb.grade, fb.startMin, fb.endMin, _coEntry)) continue;
                    if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                    fieldIndex.get(fn).push({
                        startMin: fb.startMin, endMin: fb.endMin,
                        bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
                        activity: cand.sportNorm
                    });
                    fixed++;
                    placed = true;
                    break;
                }
            }
        }
        if (fixed > 0) log('Colocate pass: ' + fixed + ' Free block(s) filled via aggressive sharing');
        return fixed;
    }

    // =========================================================================
    // ★ v12.0: CAPACITY RELAXATION REPAIR
    // =========================================================================
    // Last-resort: for remaining Free blocks, allow cap+1 sharing on same-division.
    function capacityRelaxRepair(config) {
        config = config || {};
        var { candidates } = buildCandidates(config);
        if (candidates.length === 0) return 0;

        var freeBlocks = collectFreeBlocks();
        if (freeBlocks.length === 0) return 0;

        var fieldIndex = buildFieldTimeIndex();
        var fixed = 0;

        for (var i = 0; i < freeBlocks.length; i++) {
            var fb = freeBlocks[i];
            var doneToday = getBunkDoneToday(fb.bunk, fb.slotIdx);
            var placed = false;

            var sortedCands = _sortCandidatesByPressure(candidates, fb, fieldIndex);
            for (var ci = 0; ci < sortedCands.length; ci++) {
                if (placed) break;
                var cand = sortedCands[ci];
                if (window.isRainyDay && !cand.isIndoor) continue;
                if (doneToday.has(cand.sportNorm)) continue;

                var fn = cand.fieldNorm;
                var cap = cand.capacity || 2;
                var overlap = (fieldIndex.get(fn) || []).filter(function(e) {
                    return e.startMin < fb.endMin && e.endMin > fb.startMin && e.bunk !== fb.bunk;
                });

                var st = cand.shareType || 'same_division';
                if (st === 'not_sharable') continue;
                if (overlap.length !== cap) continue; // only relax by exactly +1

                if (st === 'same_division') {
                    if (overlap.some(function(e) { return e.grade !== fb.grade; })) continue;
                }

                var _crEntry = {
                    field: cand.field, sport: cand.sport, _activity: cand.sport,
                    _autoMode: true, _autoSolved: true, _capacityRelaxed: true, continuation: false,
                    _startMin: fb.startMin, _endMin: fb.endMin
                };
                if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, cand.field, cand.sport, fb.grade, fb.startMin, fb.endMin, _crEntry)) continue;
                if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                fieldIndex.get(fn).push({
                    startMin: fb.startMin, endMin: fb.endMin,
                    bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
                    activity: cand.sportNorm
                });
                fixed++;
                placed = true;
            }
        }
        if (fixed > 0) log('Capacity-relax repair: ' + fixed + ' Free block(s) filled by allowing cap+1');
        return fixed;
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

        // ★ Rule guard: refuse to build a chain whose endpoint puts fb on a
        //   field its grade isn't allowed at, or during a grade-scoped
        //   Unavailable window, or for a sport the field has disabled today.
        //   Without this the chain happily evicted occupants and dropped fb
        //   into a forbidden slot — the failure surfaced later in Step 4.95.
        if (!bfsRulesPass(fbCand, fb.grade, fb.startMin, fb.endMin, fb.bunk)) return null;

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

        // getBunkDoneToday is module-scoped (defined near the top of this
        // file) so tryDirectFill / colocateFreeBlocks / chain construction
        // share one definition.

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
    // the one before it. Earlier this discarded the boolean returned by
    // commitWriteIfLegal — when a step was rejected (cooldown, etc.) the
    // schedule wasn't updated but the fieldIndex was, leaving the index's
    // view of "what's placed" out of sync with reality. We now snapshot
    // pre-write cells, run the chain, and roll back atomically if any
    // step rejects.
    function executeChain(chain, fb, fbCand, fieldIndex) {
        const sa = window.scheduleAssignments || {};
        // Stack of per-step undos in reverse application order.
        const undoStack = [];

        function rollback() {
            for (let u = undoStack.length - 1; u >= 0; u--) {
                const op = undoStack[u];
                if (op.kind === 'sa') {
                    if (sa[op.bunk]) sa[op.bunk][op.slotIdx] = op.prev;
                } else if (op.kind === 'idxRestore') {
                    fieldIndex.set(op.fn, op.prev);
                }
            }
        }

        for (let i = chain.length - 1; i >= 0; i--) {
            const { victim, newCand, sourceFn } = chain[i];

            if (sa[victim.bunk]) {
                const prevCell = sa[victim.bunk][victim.slotIdx];
                const _vEntry = {
                    field: newCand.field, sport: newCand.sport, _activity: newCand.sport,
                    _autoMode: true, _autoSolved: true, _ejected: true, continuation: false,
                    _startMin: victim.startMin, _endMin: victim.endMin
                };
                const ok = commitWriteIfLegal(victim.bunk, victim.slotIdx, newCand.field, newCand.sport, victim.grade, victim.startMin, victim.endMin, _vEntry);
                if (!ok) {
                    log('executeChain: step rejected by rule guard — rolling back chain');
                    rollback();
                    return false;
                }
                undoStack.push({ kind: 'sa', bunk: victim.bunk, slotIdx: victim.slotIdx, prev: prevCell });
            }

            // Remove victim from source field in index (snapshot first).
            if (fieldIndex.has(sourceFn)) {
                undoStack.push({ kind: 'idxRestore', fn: sourceFn, prev: fieldIndex.get(sourceFn) });
                fieldIndex.set(sourceFn, fieldIndex.get(sourceFn).filter(e =>
                    !(e.bunk === victim.bunk && e.slotIdx === victim.slotIdx)
                ));
            }

            // Add victim to destination field in index (snapshot first).
            const dstFn = normName(newCand.field);
            if (!fieldIndex.has(dstFn)) fieldIndex.set(dstFn, []);
            undoStack.push({ kind: 'idxRestore', fn: dstFn, prev: [...fieldIndex.get(dstFn)] });
            fieldIndex.get(dstFn).push({
                startMin: victim.startMin, endMin: victim.endMin,
                bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx,
                activity: normName(newCand.sport)
            });
        }

        // Place FB in the now-vacated field.
        if (sa[fb.bunk]) {
            const prevFbCell = sa[fb.bunk][fb.slotIdx];
            const _fbEntry = {
                field: fbCand.field, sport: fbCand.sport, _activity: fbCand.sport,
                _autoMode: true, _autoSolved: true, _ejectionChainFilled: true, continuation: false,
                _startMin: fb.startMin, _endMin: fb.endMin
            };
            const ok = commitWriteIfLegal(fb.bunk, fb.slotIdx, fbCand.field, fbCand.sport, fb.grade, fb.startMin, fb.endMin, _fbEntry);
            if (!ok) {
                log('executeChain: FB write rejected — rolling back chain');
                rollback();
                return false;
            }
            undoStack.push({ kind: 'sa', bunk: fb.bunk, slotIdx: fb.slotIdx, prev: prevFbCell });
        }
        const fbFn = fbCand.fieldNorm;
        if (!fieldIndex.has(fbFn)) fieldIndex.set(fbFn, []);
        fieldIndex.get(fbFn).push({
            startMin: fb.startMin, endMin: fb.endMin,
            bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx,
            activity: fbCand.sportNorm
        });
        return true;
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

                    // Snapshot PRE-commit state so we can roll back if
                    // isChainValid finds a capacity / cross-grade violation
                    // that slipped past commitWriteIfLegal. executeChain's
                    // OWN rollback handles the rule-guard-rejection path:
                    // when it returns false, state is already unchanged
                    // and we just skip without restoring.
                    const allBunksInChain = [fb, ...chain.map(m => m.victim)];
                    const saSnapshot = {};
                    allBunksInChain.forEach(({bunk, slotIdx}) => {
                        saSnapshot[bunk + '|' + slotIdx] = (window.scheduleAssignments[bunk] || [])[slotIdx];
                    });
                    const fieldsTouched = new Set([fbCand.fieldNorm, ...chain.map(m => normName(m.newCand.field)), ...chain.map(m => m.sourceFn)]);
                    const fiSnapshot = {};
                    fieldsTouched.forEach(fn => { fiSnapshot[fn] = (fieldIndex.get(fn) || []).slice(); });

                    const chainOk = executeChain(chain, fb, fbCand, fieldIndex);
                    if (!chainOk) continue; // already rolled back by executeChain itself

                    if (!isChainValid(chain, fb, fbCand, fieldIndex, candidates)) {
                        // Post-commit validation failed — restore pre-commit snapshot.
                        allBunksInChain.forEach(({bunk, slotIdx}) => {
                            if (window.scheduleAssignments[bunk]) {
                                window.scheduleAssignments[bunk][slotIdx] = saSnapshot[bunk + '|' + slotIdx];
                            }
                        });
                        fieldsTouched.forEach(fn => { fieldIndex.set(fn, fiSnapshot[fn]); });
                        continue;
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

    // ── BFS field-compatibility helper ───────────────────────────────────────
    // Returns true if fb (grade, startMin, endMin) can be placed on cand's field
    // given the CURRENT fieldIndex entries MINUS any bunks in evictedBunks.
    // Centralised access/time-rule check used by the BFS helpers below.
    // The original BFS helpers only enforced capacity + sharing, which let
    // them slip past the accessRestrictions / per-grade timeRules / disabled-
    // sport gates that isFieldAvailableByTime applies during the main solve.
    // That's how grade-restricted fields ended up filled by BFS repair.
    function bfsRulesPass(cand, grade, startMin, endMin, bunk) {
        // Grade access restriction (dual-key + per-bunk allow-list)
        if (cand?.accessRestrictions?.enabled) {
            const divRules = cand.accessRestrictions.divisions || {};
            const gradeKey = String(grade);
            if (!(gradeKey in divRules) && !(grade in divRules)) return false;
            const bunkAllow = divRules[gradeKey] || divRules[grade];
            if (bunk != null && Array.isArray(bunkAllow) && bunkAllow.length > 0
                && !bunkAllow.map(String).includes(String(bunk))) return false;
        }
        // Per-grade time rules
        const rules = cand?.timeRules;
        if (Array.isArray(rules) && rules.length > 0) {
            const myG = grade != null ? String(grade) : null;
            let hasGradeAvail = false;
            let insideAvail = false;
            for (const r of rules) {
                if (r.divisions.length > 0 && myG && !r.divisions.includes(myG)) continue;
                if (r.unavailable && r.startMin < endMin && r.endMin > startMin) return false;
                if (r.available) {
                    hasGradeAvail = true;
                    if (startMin >= r.startMin && endMin <= r.endMin) insideAvail = true;
                }
            }
            if (hasGradeAvail && !insideAvail) return false;
        }
        // Daily disabled sport for this field
        if (cand?.disabledSports && cand.sportNorm
            && cand.disabledSports.has(cand.sportNorm)) return false;

        // Cooldown / FieldCombos / generic SchedulingRules. Earlier this
        // helper checked only access + timeRules + disabledSports, so a
        // BFS chain endpoint that satisfied all three but violated a
        // cooldown was deemed legal. commitWriteIfLegal would then reject
        // it during executeChain, leaving the rest of the chain partially
        // committed. Pre-screen here so rejected endpoints are filtered
        // out before any state mutates.
        try {
            if (window.SchedulingRules?.isCandidateAllowed && startMin != null && endMin != null) {
                const candCheck = {
                    startMin, endMin,
                    type: 'sport',
                    event: cand?.sport || cand?.sportNorm || '',
                    field: cand?.field || cand?.name || ''
                };
                const existing = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
                const template = [];
                for (let ti = 0; ti < existing.length; ti++) {
                    const w = existing[ti];
                    if (!w || w.continuation) continue;
                    if (w._startMin === startMin && w._endMin === endMin) continue;
                    if (w._startMin == null || w._endMin == null) continue;
                    template.push({
                        startMin: w._startMin, endMin: w._endMin,
                        type: w.type || (w._assignedSpecial ? 'special' : (w.field === 'Free' ? 'free' : 'sport')),
                        event: w.event || w._activity || w.sport || '',
                        field: w.field, _assignedSpecial: w._assignedSpecial,
                        _specialLocation: w._specialLocation
                    });
                }
                const _cdOpts2 = { mode: 'auto' };
                if (window._previousDayEndBlocks && window._previousDayEndBlocks[bunk]) {
                    _cdOpts2.previousDayBlocks = window._previousDayEndBlocks[bunk];
                }
                if (!window.SchedulingRules.isCandidateAllowed(candCheck, template, _cdOpts2)) return false;
            }
        } catch (_) { /* never let rule-engine bug hide legal moves */ }

        return true;
    }

    function bfsCanPlace(fb, cand, fieldIndex, evictedBunks) {
        if (!bfsRulesPass(cand, fb.grade, fb.startMin, fb.endMin, fb.bunk)) return false;
        const fn = cand.fieldNorm;
        const entries = (fieldIndex.get(fn) || []).filter(e =>
            e.bunk !== fb.bunk &&
            !evictedBunks.has(e.bunk) &&
            e.startMin < fb.endMin && e.endMin > fb.startMin
        );
        return _bfsShareLegal(entries, cand, fb.grade);
    }

    // ★ Shared BFS share-legality helper: mirrors the share-type semantics
    //   used by isFieldAvailableByTime so BFS-augmenting and ejection-chain
    //   repairs cannot land a placement that violates cross_division pairs
    //   or a custom field's allowedDivisions list.
    function _bfsShareLegal(entries, cand, grade) {
        const cap = cand.capacity || 2;
        const st = cand.shareType || 'same_division';
        if (st === 'not_sharable') return entries.length === 0;
        if (st === 'same_division') {
            if (entries.some(e => e.grade !== grade)) return false;
            return entries.filter(e => e.grade === grade).length < cap;
        }
        if (st === 'cross_division') {
            const allowedPairs = cand.allowedPairs || {};
            for (const e of entries) {
                if (e.grade === grade) continue;
                const key = [grade, e.grade].sort().join('|');
                if (allowedPairs[key] !== true) return false;
            }
            return entries.length < cap;
        }
        if (st === 'custom') {
            const allowed = cand.allowedDivisions || [];
            if (allowed.length > 0) {
                if (entries.some(e => e.grade !== grade && !allowed.includes(e.grade))) return false;
                if (entries.length > 0 && !allowed.includes(grade)) return false;
            } else {
                if (entries.some(e => e.grade !== grade)) return false;
            }
            return entries.length < cap;
        }
        return entries.length < cap;
    }

    // Returns true if victim can move to newCand's field (cross-grade + cap check)
    function bfsCanMoveTo(victim, newCand, fieldIndex, evictedBunks) {
        if (!bfsRulesPass(newCand, victim.grade, victim.startMin, victim.endMin, victim.bunk)) return false;
        const nfn = newCand.fieldNorm;
        const entries = (fieldIndex.get(nfn) || []).filter(e =>
            e.bunk !== victim.bunk &&
            !evictedBunks.has(e.bunk) &&
            e.startMin < victim.endMin && e.endMin > victim.startMin
        );
        return _bfsShareLegal(entries, newCand, victim.grade);
    }

    function bfsAugmentingRepair(config) {
        config = config || {};
        const { candidates } = buildCandidates(config);
        if (candidates.length === 0) return 0;

        // ★ v11.0 REWRITE: BFS with correct cross-grade validation at every step.
        // Root cause of v11.0 violations: the original BFS executed victim evictions
        // without re-checking whether FB could actually occupy the freed field
        // (remaining same_division occupants from other grades still blocked it).
        //
        // Fix: bfsCanPlace() uses a virtual "evicted set" so we see the post-eviction
        // state before committing any writes.  Only execute when the full check passes.

        const MAX_BFS_DEPTH = 4; // Kept moderate — deep paths have high rollback risk
        const MAX_BFS_PASSES = 3;
        let totalImproved = 0;

        for (let pass = 0; pass < MAX_BFS_PASSES; pass++) {
            const freeBlocks = collectFreeBlocks();
            if (freeBlocks.length === 0) break;

            const fieldIndex = buildFieldTimeIndex();
            const tabuSet = new Set();
            let passImproved = 0;

            for (const fb of freeBlocks) {
                const sa = window.scheduleAssignments || {};

                // Build what FB's bunk has already done today
                const fbDone = new Set();
                (sa[fb.bunk] || []).forEach((e, i) => {
                    if (i === fb.slotIdx || !e || e.continuation) return;
                    const act = normName(e._activity || e.sport || e.field);
                    if (act && act !== 'free' && act !== 'free play') fbDone.add(act);
                });

                let found = false;

                // ── Depth 0: direct fill (no eviction needed) ──────────────────
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;
                    if (fbDone.has(cand.sportNorm)) continue;
                    if (tabuSet.has(fb.bunk + '|' + cand.fieldNorm)) continue;
                    if (!bfsCanPlace(fb, cand, fieldIndex, new Set())) continue;

                    // Commit
                    if (!sa[fb.bunk]) sa[fb.bunk] = [];
                    const _bfsEntry = {
                        field: cand.field, sport: cand.sport, _activity: cand.sport,
                        _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                        _startMin: fb.startMin, _endMin: fb.endMin
                    };
                    if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, cand.field, cand.sport, fb.grade, fb.startMin, fb.endMin, _bfsEntry)) continue;
                    const fn = cand.fieldNorm;
                    if (!fieldIndex.has(fn)) fieldIndex.set(fn, []);
                    fieldIndex.get(fn).push({ startMin: fb.startMin, endMin: fb.endMin, bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx, activity: cand.sportNorm });
                    log('BFS direct fill: bunk ' + fb.bunk + ' ← ' + cand.sport);
                    passImproved++;
                    found = true;
                    break;
                }
                if (found) continue;

                // ── Depth 1+: BFS augmenting path search ───────────────────────
                // Each queue entry describes a planned sequence of evictions.
                // We simulate them virtually (via evictedBunks set) before committing.
                // path = [{ victim, sourceFn, newCand }]

                const visited = new Set();
                const queue = []; // { fbCand, path[], depth }

                // Seed: for each candidate field FB could go on IF we evict some occupant
                for (const cand of candidates) {
                    if (window.isRainyDay && !cand.isIndoor) continue;
                    if (fbDone.has(cand.sportNorm)) continue;
                    const fn = cand.fieldNorm;
                    const blocking = (fieldIndex.get(fn) || []).filter(e =>
                        e.bunk !== fb.bunk && e.startMin < fb.endMin && e.endMin > fb.startMin
                    );
                    if (blocking.length === 0) continue; // handled above

                    for (const occ of blocking) {
                        if (tabuSet.has(occ.bunk + '|' + fn)) continue;
                        const stateKey = fn + '|' + occ.bunk;
                        if (visited.has(stateKey)) continue;

                        // ★ PRE-FILTER: After evicting just this occ, would the
                        // remaining blocking entries still prevent FB from going here?
                        // If yes, don't seed this path — it can never succeed at depth 1.
                        // (Deeper BFS can still fix multi-eviction cases.)
                        const remainingAfterEvict = blocking.filter(e => e.bunk !== occ.bunk);
                        const fbSt = cand.shareType || 'same_division';
                        const fbCap = cand.capacity || 2;
                        let wouldHelp = false;
                        if (fbSt === 'not_sharable') wouldHelp = remainingAfterEvict.length === 0;
                        else if (fbSt === 'same_division') wouldHelp = !remainingAfterEvict.some(e => e.grade !== fb.grade) && remainingAfterEvict.filter(e => e.grade === fb.grade).length < fbCap;
                        else wouldHelp = remainingAfterEvict.length < fbCap;

                        visited.add(stateKey);
                        queue.push({ fbCand: cand, path: [{ victim: occ, sourceFn: fn }], depth: 1, wouldHelp });
                    }
                }

                // BFS expansion
                for (let qi = 0; qi < queue.length && !found; qi++) {
                    const { fbCand, path, depth, wouldHelp } = queue[qi];
                    if (depth > MAX_BFS_DEPTH) continue;

                    const lastStep = path[path.length - 1];
                    const lastVictim = lastStep.victim;

                    // Build the set of bunks being evicted in this path (virtual state)
                    const evictedBunks = new Set(path.map(p => p.victim.bunk));

                    // Build what the last victim has done today (for same-day dedup)
                    const victimSA = (sa[lastVictim.bunk] || []);
                    if (!victimSA[lastVictim.slotIdx]) continue;
                    const victimDone = new Set();
                    victimSA.forEach((e, i) => {
                        if (i === lastVictim.slotIdx || !e || e.continuation) return;
                        const act = normName(e._activity || e.sport || e.field);
                        if (act && act !== 'free' && act !== 'free play') victimDone.add(act);
                    });

                    // Try every candidate the last victim could move to
                    for (const newCand of candidates) {
                        if (window.isRainyDay && !newCand.isIndoor) continue;
                        if (victimDone.has(newCand.sportNorm)) continue;
                        if (newCand.fieldNorm === lastStep.sourceFn) continue; // must actually move
                        if (!bfsCanMoveTo(lastVictim, newCand, fieldIndex, evictedBunks)) continue;

                        // Victim CAN move to newCand. Now check: can FB go to fbCand after
                        // all evictions in this path? (This is the critical cross-grade gate.)
                        if (wouldHelp) {
                            // ★ EXECUTION GATE: simulate all evictions, then re-check FB placement
                            const allEvicted = new Set(evictedBunks);
                            if (!bfsCanPlace(fb, fbCand, fieldIndex, allEvicted)) {
                                // Still can't place FB — continue searching (might be fixable at depth+1)
                                if (depth < MAX_BFS_DEPTH) {
                                    // Push the victim's destination conflict as next frontier
                                    const nfn = newCand.fieldNorm;
                                    const nBlocking = (fieldIndex.get(nfn) || []).filter(e =>
                                        e.bunk !== lastVictim.bunk && !evictedBunks.has(e.bunk) &&
                                        e.startMin < lastVictim.endMin && e.endMin > lastVictim.startMin
                                    );
                                    for (const nocc of nBlocking) {
                                        if (tabuSet.has(nocc.bunk + '|' + nfn)) continue;
                                        const nsk = nfn + '|' + nocc.bunk;
                                        if (visited.has(nsk)) continue;
                                        visited.add(nsk);
                                        queue.push({ fbCand, path: [...path, { victim: nocc, sourceFn: nfn }], depth: depth + 1, wouldHelp: true });
                                    }
                                }
                                continue;
                            }

                            // ✅ Both FB placement AND victim move are valid — commit the chain
                            // (For depth-1: move the one victim to newCand, then fill FB with fbCand)
                            const victim = path[0].victim;
                            const oldFn = path[0].sourceFn;
                            const nfn2 = newCand.fieldNorm;

                            // Snapshot victim's original assignment BEFORE overwriting
                            const victimOriginal = sa[victim.bunk] ? { ...sa[victim.bunk][victim.slotIdx] } : null;

                            // Move victim to newCand
                            if (sa[victim.bunk]) {
                                const _bvEntry = {
                                    field: newCand.field, sport: newCand.sport, _activity: newCand.sport,
                                    _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                                    _startMin: victim.startMin, _endMin: victim.endMin
                                };
                                if (!commitWriteIfLegal(victim.bunk, victim.slotIdx, newCand.field, newCand.sport, victim.grade, victim.startMin, victim.endMin, _bvEntry)) {
                                    continue;
                                }
                            }

                            // Update field index: remove victim from old field, add to new
                            fieldIndex.set(oldFn, (fieldIndex.get(oldFn) || []).filter(e =>
                                !(e.bunk === victim.bunk && e.slotIdx === victim.slotIdx)
                            ));
                            if (!fieldIndex.has(nfn2)) fieldIndex.set(nfn2, []);
                            fieldIndex.get(nfn2).push({ startMin: victim.startMin, endMin: victim.endMin, bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx, activity: newCand.sportNorm });
                            tabuSet.add(victim.bunk + '|' + oldFn);

                            // ★ FINAL VALIDATION: confirm FB can go on fbCand after the commit
                            // (cross-grade check on the now-live fieldIndex)
                            if (!bfsCanPlace(fb, fbCand, fieldIndex, new Set())) {
                                // Rollback — restore victim's original slot and field index
                                if (sa[victim.bunk] && victimOriginal) {
                                    sa[victim.bunk][victim.slotIdx] = victimOriginal;
                                }
                                fieldIndex.set(oldFn, (fieldIndex.get(oldFn) || []).concat([
                                    { startMin: victim.startMin, endMin: victim.endMin, bunk: victim.bunk, grade: victim.grade, slotIdx: victim.slotIdx, activity: victimOriginal?.sport || '' }
                                ]));
                                fieldIndex.set(nfn2, (fieldIndex.get(nfn2) || []).filter(e =>
                                    !(e.bunk === victim.bunk && e.slotIdx === victim.slotIdx)
                                ));
                                tabuSet.delete(victim.bunk + '|' + oldFn);
                                continue;
                            }

                            // Fill FB
                            if (!sa[fb.bunk]) sa[fb.bunk] = [];
                            const _bfsAugEntry = {
                                field: fbCand.field, sport: fbCand.sport, _activity: fbCand.sport,
                                _autoMode: true, _autoSolved: true, _bfsRepaired: true, continuation: false,
                                _startMin: fb.startMin, _endMin: fb.endMin
                            };
                            if (!commitWriteIfLegal(fb.bunk, fb.slotIdx, fbCand.field, fbCand.sport, fb.grade, fb.startMin, fb.endMin, _bfsAugEntry)) continue;
                            const fbFn = fbCand.fieldNorm;
                            if (!fieldIndex.has(fbFn)) fieldIndex.set(fbFn, []);
                            fieldIndex.get(fbFn).push({ startMin: fb.startMin, endMin: fb.endMin, bunk: fb.bunk, grade: fb.grade, slotIdx: fb.slotIdx, activity: fbCand.sportNorm });

                            log('BFS augmenting: bunk ' + fb.bunk + ' ← ' + fbCand.sport + ' (victim ' + victim.bunk + ' → ' + newCand.sport + ')');
                            passImproved++;
                            found = true;
                            break;
                        } else if (depth < MAX_BFS_DEPTH) {
                            // This eviction alone doesn't help FB — but maybe a deeper chain will
                            const nfn3 = newCand.fieldNorm;
                            const nBlocking2 = (fieldIndex.get(nfn3) || []).filter(e =>
                                e.bunk !== lastVictim.bunk && !evictedBunks.has(e.bunk) &&
                                e.startMin < lastVictim.endMin && e.endMin > lastVictim.startMin
                            );
                            for (const nocc of nBlocking2) {
                                if (tabuSet.has(nocc.bunk + '|' + nfn3)) continue;
                                const nsk = nfn3 + '|' + nocc.bunk;
                                if (visited.has(nsk)) continue;
                                visited.add(nsk);
                                queue.push({ fbCand, path: [...path, { victim: nocc, sourceFn: nfn3 }], depth: depth + 1, wouldHelp: false });
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
        colocateFreeBlocks,      // ★ v12.1: Aggressive sharing — piggyback on placed fields
        capacityRelaxRepair,     // ★ v12.0: Last resort — allow cap+1 for remaining Free blocks
        report,
        // Expose the hard-write guard so scheduler_core_auto.js Step 2.7
        // direct-write paths (special / sport-override / capacity-checked
        // / anchor) can route through the same access + timeRules +
        // sharing + cooldown / FieldCombos rule check the main solver
        // uses. Earlier those sites called only _validateWritePlacement
        // (which doesn't consult SchedulingRules) and silently violated
        // cooldowns + FieldCombos.
        commitWriteIfLegal,
        // Expose for scheduler_core_auto.js to call
        solveSchedule: function(activityBlocks, config) {
            return solve(activityBlocks, config);
        }
    };

    window.AutoSolverEngine = AutoSolverEngine;

    console.log(TAG + ' v' + VERSION + ' loaded — purpose-built sport slot solver for auto builder');
})();
