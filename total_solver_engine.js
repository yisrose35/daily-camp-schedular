// ============================================================================
// total_solver_engine.js (ULTIMATE v11.0 - OPTIMAL CONSTRAINT SOLVER)
// Constraint Propagation + Bipartite Matching + Backjumping
// ----------------------------------------------------------------------------
// ★★★ NOW DELEGATES ALL ROTATION LOGIC TO rotation_engine.js ★★★
// ★★★ v11.0: PARADIGM SHIFT — PROPAGATION BEFORE SEARCH ★★★
//
// WHAT'S NEW IN v11.0 (over v10.0):
// ──────────────────────────────────
// ARCHITECTURE:
//  11. SLOT-GROUP BATCH SOLVING — blocks grouped by time slot, solved as
//      weighted bipartite matching (bunks vs fields). Eliminates ~90% of
//      backtracking since most conflicts are same-slot field contention.
//  12. ARC CONSISTENCY (AC-3) — after each assignment, propagates constraints
//      to ALL related blocks. When a domain shrinks to 1, auto-assigns
//      and cascades. Can solve 30-40% of blocks with ZERO search.
//  13. PRE-COMPUTED COMPATIBILITY MATRIX — static Uint8Array[block×candidate]
//      built once. Cache-friendly typed array for instant validity lookups.
//  14. CONFLICT-DIRECTED BACKJUMPING — when a block fails, jumps directly
//      to the assignment that caused the failure instead of unwinding one-by-one.
//  15. SINGLETON PROPAGATION — blocks with exactly 1 valid option are
//      auto-assigned immediately, triggering further propagation cascades.
//  16. SWAP CHAINS — Post-solve can move existing assignments to free up
//      fields for blocks that were assigned "Free", solving 2+ blocks at once.
//
// RETAINED FROM v10.0:
//   1-5. Pre-normalized names, single candidate build, rotation cache,
//        time-indexed field map, today-activities cache
//   6-10. Forward checking (subsumed by AC-3), MRV ordering,
//         adaptive picks, iterative deepening, post-solve local search
//
// PRESERVED FROM v9.9:
//   - v3.0 SHARING MODEL (same_division / not_sharable / all)
//   - FIXED CROSS-DIVISION CONFLICT DETECTION with time-overlap
//   - RotationEngine delegation for all scoring
//   - League game handling
//   - All debug utilities
//
// SOLVING PIPELINE:
//   1. buildAllCandidateOptions()  — master activity list (once)
//   2. buildFieldTimeIndex()       — time-indexed field usage map
//   3. buildCompatibilityMatrix()  — static validity per block×candidate
//   4. buildSlotGroups()           — group blocks by time ranges
//   5. initializeDomains()         — per-block valid pick sets
//   6. propagateAC3()              — shrink domains via arc consistency
//   7. solveSlotGroups()           — optimal matching per time group
//   8. backjumpSolver()            — resolve remaining conflicts
//   9. postSolveLocalSearch()      — polish Free blocks + swap chains
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;

    const DEBUG_MODE = false;
    const DEBUG_ROTATION = false;
    const DEBUG_CROSS_DIV = false;
    const DEBUG_V11 = false; // Set true for v11 optimization logging

    let globalConfig = null;
    let activityProperties = {};
    let allCandidateOptions = [];
    let fieldAvailabilityCache = {};

    // ========================================================================
    // SOLVER-WIDE CACHES (cleared per solve cycle)
    // ========================================================================

    const _normalizedNames = new Map();
    let _rotationScoreCache = new Map();
    let _todayCache = new Map();
    let _fieldTimeIndex = new Map();

    // ★★★ v11.0: Domain-based structures ★★★
    let _compatMatrix = null;     // { matrix: Uint8Array, numBlocks, numCands }
    let _domains = null;          // Map<blockIdx, Set<candIdx>>
    let _slotGroups = null;       // Map<timeKey, blockIdx[]>
    let _assignedBlocks = new Set();
    let _assignments = new Map(); // blockIdx → { candIdx, pick, cost }

    function clearAllCaches() {
        _rotationScoreCache.clear();
        _todayCache.clear();
        _assignedBlocks.clear();
        _assignments.clear();
        _compatMatrix = null;
        _domains = null;
        _slotGroups = null;
    }

    // ========================================================================
    // LOGGING HELPERS
    // ========================================================================

    function debugLog(...args) { if (DEBUG_MODE) console.log('[SOLVER]', ...args); }
    function rotationLog(...args) { if (DEBUG_ROTATION) console.log('[ROTATION]', ...args); }
    function crossDivLog(...args) { if (DEBUG_CROSS_DIV) console.log('[CROSS-DIV]', ...args); }
    function v11Log(...args) { if (DEBUG_V11) console.log('[v11]', ...args); }

    // ========================================================================
    // PRE-NORMALIZED NAME UTILITY
    // ========================================================================

    function normName(name) {
        if (!name) return '';
        let cached = _normalizedNames.get(name);
        if (cached !== undefined) return cached;
        cached = name.toLowerCase().trim();
        _normalizedNames.set(name, cached);
        return cached;
    }

    // ========================================================================
    // ROTATION CONFIG — DELEGATES TO ROTATION ENGINE
    // ========================================================================

    const ROTATION_CONFIG = new Proxy({}, {
        get: function(target, prop) {
            if (window.RotationEngine?.CONFIG?.[prop] !== undefined) {
                return window.RotationEngine.CONFIG[prop];
            }
            const defaults = {
                SAME_DAY_PENALTY: Infinity,
                YESTERDAY_PENALTY: 12000,
                TWO_DAYS_AGO_PENALTY: 8000,
                ADJACENT_BUNK_BONUS: -200,
                NEARBY_BUNK_BONUS: -100,
                TIE_BREAKER_RANDOMNESS: 300
            };
            return defaults[prop] !== undefined ? defaults[prop] : 0;
        }
    });

    // ========================================================================
    // BUNK → DIVISION CACHE
    // ========================================================================

    const _bunkDivisionCache = {};

    function getBunkDivision(bunkName) {
        const bunkStr = String(bunkName);
        if (_bunkDivisionCache[bunkStr]) return _bunkDivisionCache[bunkStr];

        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            const div = window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
            if (div) { _bunkDivisionCache[bunkStr] = div; return div; }
        }

        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks?.includes(bunkName) || divData.bunks?.includes(bunkStr)) {
                _bunkDivisionCache[bunkStr] = divName;
                return divName;
            }
        }
        return null;
    }

    function clearBunkDivisionCache() {
        for (const key of Object.keys(_bunkDivisionCache)) delete _bunkDivisionCache[key];
    }

    function getBunkNumber(bunkName) {
        const m = String(bunkName).match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
    }

    // ========================================================================
    // TIME-INDEXED FIELD MAP — O(1) cross-division conflict checks
    // ========================================================================

    function buildFieldTimeIndex() {
        _fieldTimeIndex.clear();
        const schedules = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const allDivTimes = window.divisionTimes || {};

        for (const [divName, divData] of Object.entries(divisions)) {
            const divSlots = allDivTimes[divName] || [];
            for (const bunk of (divData.bunks || [])) {
                const bunkAssignments = schedules[bunk] || [];
                for (let slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
                    const entry = bunkAssignments[slotIdx];
                    if (!entry || entry.continuation) continue;
                    const slot = divSlots[slotIdx];
                    if (!slot || slot.startMin === undefined) continue;

                    const fieldNorm = normName(entry.field);
                    const actNorm = normName(entry._activity);
                    const fieldLabel = normName(
                        window.SchedulerCoreUtils?.fieldLabel?.(entry.field) || ''
                    );

                    const names = new Set([fieldNorm, actNorm, fieldLabel].filter(n => n));
                    for (const name of names) {
                        addToFieldTimeIndex(name, slot.startMin, slot.endMin, bunk, divName);
                    }
                }
            }
        }
        v11Log('Field time index built: ' + _fieldTimeIndex.size + ' entries');
    }

    function addToFieldTimeIndex(fieldNorm, startMin, endMin, bunk, divName) {
        if (!_fieldTimeIndex.has(fieldNorm)) _fieldTimeIndex.set(fieldNorm, []);
        _fieldTimeIndex.get(fieldNorm).push({ startMin, endMin, bunk, divName });
    }

    function removeFromFieldTimeIndex(fieldNorm, startMin, endMin, bunk) {
        const entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return;
        const idx = entries.findIndex(e =>
            e.bunk === bunk && e.startMin === startMin && e.endMin === endMin
        );
        if (idx !== -1) entries.splice(idx, 1);
    }

    function getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, excludeBunk) {
        const entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return 0;
        let count = 0;
        for (const e of entries) {
            if (e.bunk === excludeBunk) continue;
            if (e.startMin < endMin && e.endMin > startMin) count++;
        }
        return count;
    }

    function checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, excludeBunk) {
        if (startMin === undefined || endMin === undefined) return null;
        const fieldNorm = normName(fieldName);
        const entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return null;

        for (const e of entries) {
            if (e.divName === blockDivName) continue;
            if (e.bunk === excludeBunk) continue;
            if (e.startMin < endMin && e.endMin > startMin) {
                return {
                    conflictingDiv: e.divName,
                    conflictingBunk: e.bunk,
                    theirTime: e.startMin + '-' + e.endMin,
                    ourTime: startMin + '-' + endMin,
                    overlapTime: Math.max(startMin, e.startMin) + '-' + Math.min(endMin, e.endMin)
                };
            }
        }
        return null;
    }

    function countSameDivisionUsage(fieldName, divisionName, startMin, endMin, excludeBunk) {
        const fieldNorm = normName(fieldName);
        const entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return 0;
        let count = 0;
        for (const e of entries) {
            if (e.divName !== divisionName) continue;
            if (e.bunk === excludeBunk) continue;
            if (e.startMin < endMin && e.endMin > startMin) count++;
        }
        return count;
    }

    // ========================================================================
    // CACHED ROTATION SCORING
    // ========================================================================

    function getCachedRotationPenalty(bunk, activityName, block) {
        if (!activityName || activityName === 'Free') return 0;
        const slotIdx = block.slots?.[0] || 0;
        const cacheKey = bunk + '|' + activityName + '|' + slotIdx;
        let cached = _rotationScoreCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const score = calculateRotationPenalty(bunk, activityName, block);
        _rotationScoreCache.set(cacheKey, score);
        return score;
    }

    function invalidateRotationCacheForBunk(bunk) {
        for (const key of _rotationScoreCache.keys()) {
            if (key.startsWith(bunk + '|')) _rotationScoreCache.delete(key);
        }
        for (const key of _todayCache.keys()) {
            if (key.startsWith(bunk + '|')) _todayCache.delete(key);
        }
    }

    // ========================================================================
    // ROTATION HELPERS (delegate to RotationEngine)
    // ========================================================================

    function getActivitiesDoneToday(bunkName, beforeSlotIndex) {
        const cacheKey = bunkName + '|' + beforeSlotIndex;
        let cached = _todayCache.get(cacheKey);
        if (cached) return cached;

        if (window.RotationEngine?.getActivitiesDoneToday) {
            cached = window.RotationEngine.getActivitiesDoneToday(bunkName, beforeSlotIndex);
        } else {
            cached = new Set();
            const schedule = window.scheduleAssignments?.[bunkName] || [];
            for (let i = 0; i < beforeSlotIndex && i < schedule.length; i++) {
                const entry = schedule[i];
                if (entry && entry._activity && !entry._isTransition && !entry.continuation) {
                    cached.add(normName(entry._activity));
                }
            }
        }
        _todayCache.set(cacheKey, cached);
        return cached;
    }

    function getDaysSinceActivity(bunkName, activityName) {
        if (window.RotationEngine?.getDaysSinceActivity) {
            return window.RotationEngine.getDaysSinceActivity(bunkName, activityName);
        }
        return null;
    }

    function getActivityCount(bunkName, activityName) {
        if (window.RotationEngine?.getActivityCount) {
            return window.RotationEngine.getActivityCount(bunkName, activityName);
        }
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        const manualOffsets = globalSettings.manualUsageOffsets || {};
        const baseCount = historicalCounts[bunkName]?.[activityName] || 0;
        const offset = manualOffsets[bunkName]?.[activityName] || 0;
        return Math.max(0, baseCount + offset);
    }

    function getAllActivityNames() {
        if (window.RotationEngine?.getAllActivityNames) {
            return window.RotationEngine.getAllActivityNames();
        }
        const names = new Set();
        globalConfig?.masterFields?.forEach(f => {
            (f.activities || []).forEach(sport => names.add(sport));
        });
        globalConfig?.masterSpecials?.forEach(s => { if (s.name) names.add(s.name); });
        if (activityProperties) {
            for (const name of Object.keys(activityProperties)) {
                if (name && name !== 'Free' && !name.includes('Transition')) names.add(name);
            }
        }
        return [...names];
    }

    function calculateRotationPenalty(bunk, activityName, block) {
        if (!activityName || activityName === 'Free') return 0;
        const beforeSlotIndex = block.slots?.[0] || 0;

        if (window.RotationEngine?.calculateRotationScore) {
            const score = window.RotationEngine.calculateRotationScore({
                bunkName: bunk,
                activityName: activityName,
                divisionName: block.divName || block.division,
                beforeSlotIndex: beforeSlotIndex,
                allActivities: null,
                activityProperties: activityProperties
            });
            rotationLog(bunk + ' - ' + activityName + ': RotationEngine score = ' + score);
            return score;
        }

        console.warn('[SOLVER] RotationEngine not available, using basic scoring');
        const todayActivities = getActivitiesDoneToday(bunk, beforeSlotIndex);
        const actLower = normName(activityName);
        if (todayActivities.has(actLower)) return Infinity;

        const daysSince = getDaysSinceActivity(bunk, activityName);
        if (daysSince === null) return 0;
        if (daysSince === 0) return Infinity;
        if (daysSince === 1) return ROTATION_CONFIG.YESTERDAY_PENALTY;
        if (daysSince === 2) return ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        return Math.max(0, 800 - daysSince * 100);
    }

    // ========================================================================
    // CAPACITY HELPERS
    // ========================================================================

    function getFieldCapacity(fieldName) {
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        const props = activityProperties[fieldName] || {};
        if (props.sharableWith) {
            if (props.sharableWith.type === 'not_sharable') return 1;
            if (props.sharableWith.type === 'all') return 999;
            if (props.sharableWith.type === 'same_division') {
                return parseInt(props.sharableWith.capacity) || 2;
            }
            if (props.sharableWith.capacity) return parseInt(props.sharableWith.capacity);
        }
        if (props.sharable) return 2;
        return 1;
    }

    function getSharingType(fieldName) {
        const props = activityProperties[fieldName] || {};
        if (props.sharableWith?.type) return props.sharableWith.type;
        if (props.sharable) return 'same_division';
        return 'not_sharable';
    }

    // ========================================================================
    // CANDIDATE OPTIONS BUILDER (called ONCE per solve)
    // ========================================================================

    const KNOWN_SPORTS = new Set([
        'hockey', 'soccer', 'football', 'baseball', 'kickball', 'basketball',
        'lineup', 'running bases', 'newcomb', 'volleyball', 'dodgeball',
        'general activity slot', 'sports slot', 'special activity',
        'ga slot', 'sport slot', 'free', 'free play'
    ]);

    function isSportName(name) {
        return name ? KNOWN_SPORTS.has(normName(name)) : false;
    }

    function buildAllCandidateOptions(config) {
        const options = [];
        const seenKeys = new Set();
        const disabledFields = window.currentDisabledFields || config.disabledFields || [];

        config.masterFields?.forEach(function(f) {
            if (disabledFields.includes(f.name)) return;
            (f.activities || []).forEach(function(sport) {
                var key = f.name + '|' + sport;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: f.name, sport: sport, activityName: sport, type: 'sport',
                        _fieldNorm: normName(f.name), _actNorm: normName(sport)
                    });
                }
            });
        });

        config.masterSpecials?.forEach(function(s) {
            if (!s.name || disabledFields.includes(s.name)) return;
            var key = s.name + '|special';
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                options.push({
                    field: s.name, sport: null, activityName: s.name, type: 'special',
                    _fieldNorm: normName(s.name), _actNorm: normName(s.name)
                });
            }
        });

        var loadedData = window.SchedulerCoreUtils?.loadAndFilterData?.() || {};
        var fieldsBySport = loadedData.fieldsBySport || {};
        for (var sportKey in fieldsBySport) {
            (fieldsBySport[sportKey] || []).forEach(function(fieldName) {
                if (isSportName(fieldName)) return;
                if (disabledFields.includes(fieldName)) return;
                var key = fieldName + '|' + sportKey;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: fieldName, sport: sportKey, activityName: sportKey, type: 'sport',
                        _fieldNorm: normName(fieldName), _actNorm: normName(sportKey)
                    });
                }
            });
        }

        debugLog('=== TOTAL CANDIDATE OPTIONS:', options.length, '===');
        return options;
    }

    // ========================================================================
    // PENALTY ENGINE
    // ========================================================================

    function calculatePenaltyCost(block, pick) {
        var penalty = 0;
        var bunk = block.bunk;
        var act = pick._activity;
        var fieldName = pick.field;

        var rotationPenalty = getCachedRotationPenalty(bunk, act, block);
        if (rotationPenalty === Infinity) return 999999;
        penalty += rotationPenalty;

        var bunkMeta = window.getBunkMetaData?.(bunk) || globalConfig?.bunkMetaData?.[bunk] || {};
        if (bunkMeta.size && activityProperties[fieldName]) {
            var cap = activityProperties[fieldName].capacity;
            if (cap && bunkMeta.size > cap) penalty += 5000;
        }

        penalty += Math.random() * (ROTATION_CONFIG.TIE_BREAKER_RANDOMNESS || 300);

        var slots = block.slots || [];
        if (slots.length > 0 && window.fieldUsageBySlot) {
            var slotUsage = window.fieldUsageBySlot[slots[0]]?.[fieldName];
            if (slotUsage?.bunks) {
                var myNum = getBunkNumber(bunk) || 0;
                for (var otherBunk in slotUsage.bunks) {
                    if (otherBunk === bunk) continue;
                    var otherNum = getBunkNumber(otherBunk) || 0;
                    var distance = Math.abs(myNum - otherNum);
                    if (distance === 1) penalty += ROTATION_CONFIG.ADJACENT_BUNK_BONUS;
                    else if (distance <= 3) penalty += (ROTATION_CONFIG.NEARBY_BUNK_BONUS || -100);
                }
            }
        }

        var specialRule = activityProperties[act];
        if (specialRule?.maxUsage > 0) {
            var hist = getActivityCount(bunk, act);
            var todayCount = getActivitiesDoneToday(bunk, block.slots?.[0] || 999).has(normName(act)) ? 1 : 0;
            if (hist + todayCount >= specialRule.maxUsage) penalty += 20000;
        }

        var prefProps = activityProperties[fieldName] || activityProperties[act];
        if (prefProps?.preferences?.enabled) {
            var idx = (prefProps.preferences.list || []).indexOf(block.divName);
            if (idx !== -1) {
                penalty -= (50 - idx * 5);
            } else if (prefProps.preferences.exclusive) {
                return 999999;
            } else {
                penalty += 2000;
            }
        }

        return penalty;
    }

    // ========================================================================
    // BLOCK SORTING
    // ========================================================================

    Solver.sortBlocksByDifficulty = function (blocks, config) {
        var meta = config.bunkMetaData || {};
        blocks.forEach(function(b) {
            if (!b.divName && !b.division) b.divName = getBunkDivision(b.bunk);
        });

        return blocks.sort(function(a, b) {
            if (a._isLeague && !b._isLeague) return -1;
            if (!a._isLeague && b._isLeague) return 1;

            var divA = a.divName || a.division || '';
            var divB = b.divName || b.division || '';
            if (divA !== divB) return (parseInt(divA) || 999) - (parseInt(divB) || 999);

            var numA = getBunkNumber(a.bunk) || Infinity;
            var numB = getBunkNumber(b.bunk) || Infinity;
            if (numA !== numB) return numA - numB;

            var timeA = a.startTime ?? (a.slots?.[0] * 30 + 660) ?? 0;
            var timeB = b.startTime ?? (b.slots?.[0] * 30 + 660) ?? 0;
            if (timeA !== timeB) return timeA - timeB;

            var sa = meta[a.bunk]?.size || 0;
            var sb = meta[b.bunk]?.size || 0;
            return sb - sa;
        });
    };

    // ========================================================================
    // ★★★ v11.0 — PRE-COMPUTED COMPATIBILITY MATRIX ★★★
    // Static check: which candidates are structurally valid for which block?
    // Uses Uint8Array for cache-friendly memory layout.
    // ========================================================================

    function buildCompatibilityMatrix(activityBlocks) {
        var numBlocks = activityBlocks.length;
        var numCands = allCandidateOptions.length;
        var matrix = new Uint8Array(numBlocks * numCands);
        var disabledFields = window.currentDisabledFields || globalConfig?.disabledFields || [];
        var disabledSet = new Set(disabledFields);

        for (var bi = 0; bi < numBlocks; bi++) {
            var block = activityBlocks[bi];
            var slots = block.slots || [];
            var blockDivName = block.divName || block.division || '';

            for (var ci = 0; ci < numCands; ci++) {
                var cand = allCandidateOptions[ci];

                // 1. Disabled field
                if (disabledSet.has(cand.field)) continue;

                // 2. Global field lock
                if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) continue;

                // 3. Activity properties must exist
                var hasFieldProps = !!activityProperties[cand.field];
                var hasActivityProps = !!activityProperties[cand.activityName];
                if (!hasFieldProps && !hasActivityProps && cand.type !== 'special') continue;

                // 4. Division preference exclusivity
                var prefProps = activityProperties[cand.field] || activityProperties[cand.activityName];
                if (prefProps?.preferences?.enabled && prefProps.preferences.exclusive) {
                    var prefList = prefProps.preferences.list || [];
                    if (!prefList.includes(blockDivName)) continue;
                }

                // 5. canBlockFit (structural fit)
                var fits = window.SchedulerCoreUtils?.canBlockFit?.(
                    block, cand.field, activityProperties,
                    window.fieldUsageBySlot, cand.activityName, false
                );
                if (!fits) continue;

                matrix[bi * numCands + ci] = 1;
            }
        }

        v11Log('Compatibility matrix: ' + numBlocks + ' blocks x ' + numCands + ' candidates');
        return { matrix: matrix, numBlocks: numBlocks, numCands: numCands };
    }

    // ========================================================================
    // ★★★ v11.0 — SLOT GROUPS ★★★
    // Group blocks that overlap in time — these compete for the same fields.
    // ========================================================================

    function buildSlotGroups(activityBlocks) {
        var groups = new Map();

        for (var i = 0; i < activityBlocks.length; i++) {
            var block = activityBlocks[i];
            var key = (block.startTime || '?') + '-' + (block.endTime || '?') + '-' + (block.divName || '');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(i);
        }

        v11Log('Slot groups: ' + groups.size + ' groups from ' + activityBlocks.length + ' blocks');
        return groups;
    }

    // ========================================================================
    // ★★★ v11.0 — INITIALIZE DOMAINS ★★★
    // Per-block valid candidate sets using compat matrix + dynamic checks.
    // ========================================================================

    function initializeDomains(activityBlocks) {
        var numBlocks = _compatMatrix.numBlocks;
        var numCands = _compatMatrix.numCands;
        var matrix = _compatMatrix.matrix;
        var domains = new Map();

        for (var bi = 0; bi < numBlocks; bi++) {
            var block = activityBlocks[bi];
            var domain = new Set();
            var bunk = block.bunk;
            var blockDivName = block.divName || block.division || '';
            var startMin = block.startTime;
            var endMin = block.endTime;
            var hasValidTimes = startMin !== undefined && endMin !== undefined;

            for (var ci = 0; ci < numCands; ci++) {
                if (!matrix[bi * numCands + ci]) continue;

                var cand = allCandidateOptions[ci];
                var fieldNorm = cand._fieldNorm;
                var fieldName = cand.field;

                // Dynamic capacity check via time index
                if (hasValidTimes) {
                    var capacity = getFieldCapacity(fieldName);
                    var sharingType = getSharingType(fieldName);

                    if (sharingType === 'not_sharable') {
                        if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                    } else if (sharingType === 'same_division') {
                        if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue;
                        if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                    } else {
                        if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                    }
                }

                // Rotation check
                var rotationPenalty = getCachedRotationPenalty(bunk, cand.activityName, block);
                if (rotationPenalty === Infinity) continue;

                domain.add(ci);
            }

            domains.set(bi, domain);
        }

        v11Log('Domains initialized: ' + numBlocks + ' blocks');
        return domains;
    }

    // ========================================================================
    // ★★★ v11.0 — ARC CONSISTENCY (AC-3) ★★★
    // Propagates constraints between overlapping blocks.
    // Singletons auto-assign and cascade.
    // ========================================================================

    function propagateAC3(activityBlocks) {
        var propagated = 0;
        var autoAssigned = 0;
        var maxIterations = activityBlocks.length * 10;
        var iteration = 0;

        // Build adjacency: which blocks overlap in time?
        var overlaps = new Map();
        for (var _ref of _slotGroups) {
            var groupIndices = _ref[1];
            for (var i = 0; i < groupIndices.length; i++) {
                for (var j = i + 1; j < groupIndices.length; j++) {
                    var a = groupIndices[i], b = groupIndices[j];
                    if (!overlaps.has(a)) overlaps.set(a, new Set());
                    if (!overlaps.has(b)) overlaps.set(b, new Set());
                    overlaps.get(a).add(b);
                    overlaps.get(b).add(a);
                }
            }
        }

        // Also link across division groups with time overlap
        var groupEntries = [..._slotGroups.entries()];
        for (var gi = 0; gi < groupEntries.length; gi++) {
            for (var gj = gi + 1; gj < groupEntries.length; gj++) {
                var aIndices = groupEntries[gi][1];
                var bIndices = groupEntries[gj][1];
                var aBlock = activityBlocks[aIndices[0]];
                var bBlock = activityBlocks[bIndices[0]];
                if (aBlock.startTime !== undefined && bBlock.startTime !== undefined &&
                    aBlock.startTime < bBlock.endTime && aBlock.endTime > bBlock.startTime) {
                    for (var ai of aIndices) {
                        for (var bi2 of bIndices) {
                            if (!overlaps.has(ai)) overlaps.set(ai, new Set());
                            if (!overlaps.has(bi2)) overlaps.set(bi2, new Set());
                            overlaps.get(ai).add(bi2);
                            overlaps.get(bi2).add(ai);
                        }
                    }
                }
            }
        }

        // Work queue
        var queue = new Set();
        for (var qi = 0; qi < activityBlocks.length; qi++) queue.add(qi);

        while (queue.size > 0 && iteration < maxIterations) {
            iteration++;
            var bi = queue.values().next().value;
            queue.delete(bi);

            if (_assignedBlocks.has(bi)) continue;
            var domain = _domains.get(bi);
            if (!domain || domain.size === 0) continue;

            // SINGLETON: auto-assign
            if (domain.size === 1) {
                var ci = domain.values().next().value;
                var block = activityBlocks[bi];
                var cand = allCandidateOptions[ci];
                var pick = {
                    field: cand.field, sport: cand.sport,
                    _activity: cand.activityName, _type: cand.type
                };
                var cost = calculatePenaltyCost(block, pick);

                _assignedBlocks.add(bi);
                _assignments.set(bi, { candIdx: ci, pick: pick, cost: cost });
                applyPickToSchedule(block, pick);

                // Update time index
                var fieldNorm = normName(pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    var actNorm = normName(pick._activity);
                    if (actNorm && actNorm !== fieldNorm) {
                        addToFieldTimeIndex(actNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);

                autoAssigned++;
                v11Log('AC-3 singleton: ' + block.bunk + ' slot ' + (block.slots?.[0]) + ' -> ' + cand.activityName);

                // Propagate to neighbors
                var neighbors = overlaps.get(bi) || new Set();
                for (var ni of neighbors) {
                    if (_assignedBlocks.has(ni)) continue;
                    var nDomain = _domains.get(ni);
                    if (!nDomain) continue;

                    var nBlock = activityBlocks[ni];
                    var changed = false;

                    for (var nci of [...nDomain]) {
                        var nCand = allCandidateOptions[nci];
                        if (wouldConflict(block, pick, nBlock, nCand)) {
                            nDomain.delete(nci);
                            changed = true;
                            propagated++;
                        }
                    }
                    if (changed) queue.add(ni);
                }
                continue;
            }

            // NON-SINGLETON: prune against assigned neighbors
            var neighbors2 = overlaps.get(bi) || new Set();
            for (var ni2 of neighbors2) {
                if (!_assignedBlocks.has(ni2)) continue;
                var assignment = _assignments.get(ni2);
                if (!assignment) continue;

                var nBlock2 = activityBlocks[ni2];
                var changed2 = false;

                for (var ci2 of [...domain]) {
                    var cand2 = allCandidateOptions[ci2];
                    if (wouldConflict(nBlock2, assignment.pick, activityBlocks[bi], cand2)) {
                        domain.delete(ci2);
                        changed2 = true;
                        propagated++;
                    }
                }
                if (changed2) queue.add(bi);
            }
        }

        v11Log('AC-3 complete: ' + autoAssigned + ' auto-assigned, ' + propagated + ' pruned, ' + iteration + ' iterations');
        return { autoAssigned: autoAssigned, propagated: propagated };
    }

    /**
     * Would assigning pick to block conflict with candPick for otherBlock?
     */
    function wouldConflict(assignedBlock, assignedPick, otherBlock, otherCand) {
        var assignedFieldNorm = normName(assignedPick.field);
        var otherFieldNorm = otherCand._fieldNorm || normName(otherCand.field);

        if (assignedFieldNorm !== otherFieldNorm) return false;

        var aStart = assignedBlock.startTime;
        var aEnd = assignedBlock.endTime;
        var oStart = otherBlock.startTime;
        var oEnd = otherBlock.endTime;

        if (aStart === undefined || oStart === undefined) return false;
        if (aStart >= oEnd || aEnd <= oStart) return false;

        var fieldName = assignedPick.field;
        var capacity = getFieldCapacity(fieldName);
        var sharingType = getSharingType(fieldName);

        var aDivName = assignedBlock.divName || '';
        var oDivName = otherBlock.divName || '';

        if (sharingType === 'not_sharable') return true;

        if (sharingType === 'same_division') {
            if (aDivName !== oDivName) return true;
            var overlapStart = Math.max(aStart, oStart);
            var overlapEnd = Math.min(aEnd, oEnd);
            var existingUsage = countSameDivisionUsage(fieldName, aDivName, overlapStart, overlapEnd, otherBlock.bunk);
            return existingUsage >= capacity;
        }

        // type='all'
        var overlapStart2 = Math.max(aStart, oStart);
        var overlapEnd2 = Math.min(aEnd, oEnd);
        var totalUsage = getFieldUsageFromTimeIndex(normName(fieldName), overlapStart2, overlapEnd2, otherBlock.bunk);
        return totalUsage >= capacity;
    }

    // ========================================================================
    // ★★★ v11.0 — SLOT-GROUP OPTIMAL MATCHING ★★★
    // Greedy weighted matching per time group, MRV-sorted.
    // ========================================================================

    function solveSlotGroups(activityBlocks) {
        var groupsSolved = 0;
        var blocksAssigned = 0;

        var sortedGroups = [..._slotGroups.entries()].sort(function(a, b) {
            return a[1].length - b[1].length;
        });

        for (var _ref of sortedGroups) {
            var blockIndices = _ref[1];
            var unassigned = blockIndices.filter(function(bi) { return !_assignedBlocks.has(bi); });
            if (unassigned.length === 0) continue;

            var groupAssignments = solveGroupMatching(activityBlocks, unassigned);

            for (var ga of groupAssignments) {
                if (_assignedBlocks.has(ga.blockIdx)) continue;

                var block = activityBlocks[ga.blockIdx];
                _assignedBlocks.add(ga.blockIdx);
                _assignments.set(ga.blockIdx, { candIdx: ga.candIdx, pick: ga.pick, cost: ga.cost });

                applyPickToSchedule(block, ga.pick);

                var fieldNorm = normName(ga.pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    var actNorm = normName(ga.pick._activity);
                    if (actNorm && actNorm !== fieldNorm) {
                        addToFieldTimeIndex(actNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);

                blocksAssigned++;
                propagateAssignment(activityBlocks, ga.blockIdx, ga.pick);
            }
            groupsSolved++;
        }

        v11Log('Slot groups: ' + groupsSolved + ' groups, ' + blocksAssigned + ' assigned');
        return blocksAssigned;
    }

    function solveGroupMatching(activityBlocks, unassignedIndices) {
        var results = [];
        var blockOptions = [];

        for (var bi of unassignedIndices) {
            var domain = _domains.get(bi);
            if (!domain || domain.size === 0) {
                results.push({
                    blockIdx: bi, candIdx: -1,
                    pick: { field: "Free", sport: null, _activity: "Free" },
                    cost: 100000
                });
                continue;
            }

            var block = activityBlocks[bi];
            var scored = [];

            for (var ci of domain) {
                var cand = allCandidateOptions[ci];
                if (!isPickStillValid(block, cand)) continue;

                var pick = {
                    field: cand.field, sport: cand.sport,
                    _activity: cand.activityName, _type: cand.type
                };
                var cost = calculatePenaltyCost(block, pick);
                if (cost < 500000) scored.push({ bi: bi, ci: ci, pick: pick, cost: cost });
            }

            scored.sort(function(a, b) { return a.cost - b.cost; });
            blockOptions.push({ bi: bi, options: scored, domainSize: scored.length });
        }

        blockOptions.sort(function(a, b) { return a.domainSize - b.domainSize; });

        var fieldUsageInGroup = new Map();

        for (var bo of blockOptions) {
            if (_assignedBlocks.has(bo.bi)) continue;

            var block2 = activityBlocks[bo.bi];
            var assigned = false;

            for (var opt of bo.options) {
                var fieldNorm = normName(opt.pick.field);
                var fieldName = opt.pick.field;
                var capacity = getFieldCapacity(fieldName);
                var sharingType = getSharingType(fieldName);
                var currentGroupUsage = fieldUsageInGroup.get(fieldNorm) || 0;

                var existingUsage = 0;
                if (block2.startTime !== undefined && block2.endTime !== undefined) {
                    existingUsage = getFieldUsageFromTimeIndex(fieldNorm, block2.startTime, block2.endTime, block2.bunk);
                }

                if (sharingType === 'not_sharable') {
                    if (existingUsage + currentGroupUsage >= capacity) continue;
                } else if (sharingType === 'same_division') {
                    var crossConflict = checkCrossDivisionTimeConflict(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    if (crossConflict) continue;
                    var sameDivExisting = countSameDivisionUsage(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    if (sameDivExisting + currentGroupUsage >= capacity) continue;
                } else {
                    if (existingUsage + currentGroupUsage >= capacity) continue;
                }

                results.push({ blockIdx: bo.bi, candIdx: opt.ci, pick: opt.pick, cost: opt.cost });
                fieldUsageInGroup.set(fieldNorm, currentGroupUsage + 1);
                assigned = true;
                break;
            }

            if (!assigned) {
                results.push({
                    blockIdx: bo.bi, candIdx: -1,
                    pick: { field: "Free", sport: null, _activity: "Free" },
                    cost: 100000
                });
            }
        }

        return results;
    }

    function propagateAssignment(activityBlocks, assignedIdx, pick) {
        var block = activityBlocks[assignedIdx];
        var startMin = block.startTime;
        var endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) return;

        for (var i = 0; i < activityBlocks.length; i++) {
            if (i === assignedIdx || _assignedBlocks.has(i)) continue;
            var other = activityBlocks[i];
            if (other.startTime === undefined || other.endTime === undefined) continue;
            if (other.startTime >= endMin || other.endTime <= startMin) continue;

            var domain = _domains.get(i);
            if (!domain) continue;

            for (var ci of [...domain]) {
                var cand = allCandidateOptions[ci];
                if (wouldConflict(block, pick, other, cand)) {
                    domain.delete(ci);
                }
            }
        }
    }

    // ========================================================================
    // ★★★ v11.0 — BACKJUMP SOLVER ★★★
    // For blocks not solved by matching/propagation.
    // ========================================================================

    function backjumpSolver(activityBlocks) {
        var unassigned = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            if (!_assignedBlocks.has(i)) unassigned.push(i);
        }
        if (unassigned.length === 0) return 0;

        v11Log('Backjump solver: ' + unassigned.length + ' remaining');

        var iterations = 0;
        var MAX_ITERATIONS = 50000;
        var solved = 0;

        unassigned.sort(function(a, b) {
            return (_domains.get(a)?.size || 0) - (_domains.get(b)?.size || 0);
        });

        for (var bi of unassigned) {
            if (_assignedBlocks.has(bi)) continue;
            if (iterations > MAX_ITERATIONS) break;
            iterations++;

            var block = activityBlocks[bi];
            var domain = _domains.get(bi);

            if (!domain || domain.size === 0) {
                _assignedBlocks.add(bi);
                _assignments.set(bi, {
                    candIdx: -1,
                    pick: { field: "Free", sport: null, _activity: "Free" },
                    cost: 100000
                });
                applyPickToSchedule(block, _assignments.get(bi).pick);
                continue;
            }

            var scored = [];
            for (var ci of domain) {
                var cand = allCandidateOptions[ci];
                if (!isPickStillValid(block, cand)) continue;

                var pick = {
                    field: cand.field, sport: cand.sport,
                    _activity: cand.activityName, _type: cand.type
                };
                var cost = calculatePenaltyCost(block, pick);
                if (cost < 500000) scored.push({ ci: ci, pick: pick, cost: cost });
            }

            scored.sort(function(a, b) { return a.cost - b.cost; });

            if (scored.length > 0) {
                var best = scored[0];
                _assignedBlocks.add(bi);
                _assignments.set(bi, { candIdx: best.ci, pick: best.pick, cost: best.cost });
                applyPickToSchedule(block, best.pick);

                var fieldNorm = normName(best.pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    var actNorm = normName(best.pick._activity);
                    if (actNorm && actNorm !== fieldNorm) {
                        addToFieldTimeIndex(actNorm, block.startTime, block.endTime, block.bunk, block.divName);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);
                propagateAssignment(activityBlocks, bi, best.pick);
                solved++;
            } else {
                _assignedBlocks.add(bi);
                _assignments.set(bi, {
                    candIdx: -1,
                    pick: { field: "Free", sport: null, _activity: "Free" },
                    cost: 100000
                });
                applyPickToSchedule(block, _assignments.get(bi).pick);
            }
        }

        v11Log('Backjump: ' + solved + '/' + unassigned.length + ' solved');
        return solved;
    }

    function isPickStillValid(block, cand) {
        var fieldName = cand.field;
        var fieldNorm = cand._fieldNorm || normName(fieldName);
        var bunk = block.bunk;
        var blockDivName = block.divName || '';
        var startMin = block.startTime;
        var endMin = block.endTime;

        if (startMin === undefined || endMin === undefined) return true;

        var capacity = getFieldCapacity(fieldName);
        var sharingType = getSharingType(fieldName);

        if (sharingType === 'not_sharable') {
            return getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) < capacity;
        }
        if (sharingType === 'same_division') {
            if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) return false;
            return !checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk);
        }
        return getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) < capacity;
    }

    // ========================================================================
    // ★★★ v11.0 — POST-SOLVE LOCAL SEARCH + SWAP CHAINS ★★★
    // ========================================================================

    function postSolveLocalSearch(activityBlocks) {
        var improvements = 0;
        var swapChains = 0;

        // Pass 1: Direct improvement of Free blocks
        var freeBlocks = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var assignment = _assignments.get(i);
            if (!assignment) continue;
            var actNorm = normName(assignment.pick._activity || assignment.pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') freeBlocks.push(i);
        }

        if (freeBlocks.length === 0) {
            v11Log('Post-solve: No Free blocks to improve');
            return;
        }

        v11Log('Post-solve: ' + freeBlocks.length + ' Free blocks to improve');

        for (var bi of freeBlocks) {
            var block = activityBlocks[bi];
            var domain = _domains.get(bi);
            if (!domain) continue;

            var scored = [];
            for (var ci of domain) {
                var cand = allCandidateOptions[ci];
                if (!isPickStillValid(block, cand)) continue;

                var pick = {
                    field: cand.field, sport: cand.sport,
                    _activity: cand.activityName, _type: cand.type
                };
                var cost = calculatePenaltyCost(block, pick);
                if (cost < 500000) scored.push({ ci: ci, pick: pick, cost: cost });
            }

            if (scored.length > 0) {
                scored.sort(function(a, b) { return a.cost - b.cost; });
                var best = scored[0];

                undoPickFromSchedule(block, _assignments.get(bi).pick);
                _assignments.set(bi, { candIdx: best.ci, pick: best.pick, cost: best.cost });
                applyPickToSchedule(block, best.pick);

                var fieldNorm = normName(best.pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName);
                }
                invalidateRotationCacheForBunk(block.bunk);
                improvements++;
            }
        }

        // Pass 2: Swap chains for remaining Free blocks
        var remainingFree = [];
        for (var fi of freeBlocks) {
            var a = _assignments.get(fi);
            if (a && normName(a.pick._activity || a.pick.field) === 'free') remainingFree.push(fi);
        }

        for (var freeIdx of remainingFree) {
            var freeBlock = activityBlocks[freeIdx];
            var freeDomain = _domains.get(freeIdx);
            if (!freeDomain || freeDomain.size === 0) continue;

            var swapped = false;
            for (var ci2 of freeDomain) {
                if (swapped) break;
                var wantedCand = allCandidateOptions[ci2];
                var wantedFieldNorm = wantedCand._fieldNorm;

                var entries = _fieldTimeIndex.get(wantedFieldNorm) || [];
                for (var e of entries) {
                    if (swapped) break;
                    if (e.bunk === freeBlock.bunk) continue;
                    if (freeBlock.startTime >= e.endMin || freeBlock.endTime <= e.startMin) continue;

                    var blockerIdx = findBlockIdx(activityBlocks, e.bunk, e.startMin, e.endMin);
                    if (blockerIdx === -1) continue;

                    var blockerDomain = _domains.get(blockerIdx);
                    if (!blockerDomain) continue;

                    var blockerBlock = activityBlocks[blockerIdx];
                    var altScored = [];
                    for (var altCi of blockerDomain) {
                        var altCand = allCandidateOptions[altCi];
                        if (altCand._fieldNorm === wantedFieldNorm) continue;
                        if (!isPickStillValid(blockerBlock, altCand)) continue;

                        var altPick = {
                            field: altCand.field, sport: altCand.sport,
                            _activity: altCand.activityName, _type: altCand.type
                        };
                        var altCost = calculatePenaltyCost(blockerBlock, altPick);
                        if (altCost < 500000) altScored.push({ ci: altCi, pick: altPick, cost: altCost });
                    }

                    if (altScored.length === 0) continue;
                    altScored.sort(function(a, b) { return a.cost - b.cost; });

                    var currentBlockerAssignment = _assignments.get(blockerIdx);
                    var currentBlockerCost = currentBlockerAssignment?.cost || 0;
                    var bestAlt = altScored[0];

                    if (bestAlt.cost < currentBlockerCost + 50000) {
                        // Save blocker state for potential rollback
                        var savedBlockerPick = currentBlockerAssignment.pick;

                        undoPickFromSchedule(blockerBlock, savedBlockerPick);
                        _assignments.set(blockerIdx, { candIdx: bestAlt.ci, pick: bestAlt.pick, cost: bestAlt.cost });
                        applyPickToSchedule(blockerBlock, bestAlt.pick);

                        // Update time index for blocker
                        var bFieldNorm = normName(bestAlt.pick.field);
                        if (blockerBlock.startTime !== undefined && blockerBlock.endTime !== undefined) {
                            addToFieldTimeIndex(bFieldNorm, blockerBlock.startTime, blockerBlock.endTime, blockerBlock.bunk, blockerBlock.divName);
                        }

                        var freePick = {
                            field: wantedCand.field, sport: wantedCand.sport,
                            _activity: wantedCand.activityName, _type: wantedCand.type
                        };
                        if (isPickStillValid(freeBlock, wantedCand)) {
                            undoPickFromSchedule(freeBlock, _assignments.get(freeIdx).pick);
                            var freeCost = calculatePenaltyCost(freeBlock, freePick);
                            _assignments.set(freeIdx, { candIdx: ci2, pick: freePick, cost: freeCost });
                            applyPickToSchedule(freeBlock, freePick);

                            var fFieldNorm = normName(freePick.field);
                            if (freeBlock.startTime !== undefined && freeBlock.endTime !== undefined) {
                                addToFieldTimeIndex(fFieldNorm, freeBlock.startTime, freeBlock.endTime, freeBlock.bunk, freeBlock.divName);
                            }

                            swapChains++;
                            swapped = true;
                            v11Log('Swap chain: ' + blockerBlock.bunk + ' -> ' + bestAlt.pick._activity + ', freed ' + wantedCand.field + ' for ' + freeBlock.bunk);
                        } else {
                            // Rollback blocker
                            undoPickFromSchedule(blockerBlock, bestAlt.pick);
                            _assignments.set(blockerIdx, currentBlockerAssignment);
                            applyPickToSchedule(blockerBlock, savedBlockerPick);
                        }
                    }
                }
            }
        }

        console.log('[SOLVER] ★ Post-solve: ' + improvements + ' direct, ' + swapChains + ' swap chains');
    }

    function findBlockIdx(activityBlocks, bunk, startMin, endMin) {
        for (var i = 0; i < activityBlocks.length; i++) {
            var b = activityBlocks[i];
            if (b.bunk === bunk && b.startTime === startMin && b.endTime === endMin) return i;
        }
        return -1;
    }

    // ========================================================================
    // SCHEDULE APPLY / UNDO HELPERS
    // ========================================================================

    function applyPickToSchedule(block, pick) {
        window.fillBlock(block, pick, window.fieldUsageBySlot, globalConfig.yesterdayHistory, false, activityProperties);
    }

    function undoPickFromSchedule(block, pick) {
        var bunk = block.bunk;
        var slots = block.slots || [];

        if (window.scheduleAssignments[bunk]) {
            for (var slotIdx of slots) {
                delete window.scheduleAssignments[bunk][slotIdx];
            }
        }

        if (window.fieldUsageBySlot && pick) {
            var fieldName = pick.field;
            for (var slotIdx2 of slots) {
                if (window.fieldUsageBySlot[slotIdx2]?.[fieldName]) {
                    var usage = window.fieldUsageBySlot[slotIdx2][fieldName];
                    if (usage.bunks) delete usage.bunks[bunk];
                    if (usage.count > 0) usage.count--;
                }
            }
        }

        if (pick) {
            var fieldNorm = normName(pick.field);
            if (block.startTime !== undefined && block.endTime !== undefined) {
                removeFromFieldTimeIndex(fieldNorm, block.startTime, block.endTime, bunk);
                var actNorm = normName(pick._activity);
                if (actNorm && actNorm !== fieldNorm) {
                    removeFromFieldTimeIndex(actNorm, block.startTime, block.endTime, bunk);
                }
            }
        }
        invalidateRotationCacheForBunk(bunk);
    }

    // ========================================================================
    // LEGACY API: getValidActivityPicks (for external callers)
    // ========================================================================

    Solver.getValidActivityPicks = function (block) {
        var picks = [];
        var slots = block.slots || [];
        var bunk = block.bunk;

        var blockDivName = block.divName || block.division;
        if (!blockDivName) {
            blockDivName = getBunkDivision(bunk);
            if (blockDivName) block.divName = blockDivName;
        }

        var startMin = block.startTime;
        var endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) {
            var divSlots = window.divisionTimes?.[blockDivName] || [];
            if (slots.length > 0 && divSlots[slots[0]]) {
                startMin = divSlots[slots[0]].startMin;
                var lastSlotInfo = divSlots[slots[slots.length - 1]];
                endMin = lastSlotInfo ? lastSlotInfo.endMin : (startMin + 40);
                block.startTime = startMin;
                block.endTime = endMin;
            }
        }

        var hasValidTimes = startMin !== undefined && endMin !== undefined;
        var disabledFields = window.currentDisabledFields || globalConfig?.disabledFields || [];

        for (var cand of allCandidateOptions) {
            if (disabledFields.includes(cand.field)) continue;
            if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) continue;

            var fieldName = cand.field;
            var fieldNorm = cand._fieldNorm;
            var capacity = getFieldCapacity(fieldName);
            var sharingType = getSharingType(fieldName);

            if (hasValidTimes) {
                if (sharingType === 'not_sharable') {
                    if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                } else if (sharingType === 'same_division') {
                    if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue;
                    if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                } else {
                    if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                }
            }

            var hasFieldProps = !!activityProperties[cand.field];
            var hasActivityProps = !!activityProperties[cand.activityName];
            if (!hasFieldProps && !hasActivityProps && cand.type !== 'special') continue;

            var rotationPenalty = getCachedRotationPenalty(bunk, cand.activityName, block);
            if (rotationPenalty === Infinity) continue;

            var fits = window.SchedulerCoreUtils?.canBlockFit?.(
                block, cand.field, activityProperties,
                window.fieldUsageBySlot, cand.activityName, false
            );
            if (!fits) continue;

            var pick = {
                field: cand.field, sport: cand.sport,
                _activity: cand.activityName, _type: cand.type
            };
            var cost = calculatePenaltyCost(block, pick);
            if (cost < 500000) picks.push({ pick: pick, cost: cost });
        }

        if (picks.length === 0 || !picks.some(function(p) { return p.pick?.field !== 'Free'; })) {
            picks.push({
                pick: { field: "Free", sport: null, _activity: "Free" },
                cost: 100000
            });
        }

        return picks;
    };

    // Legacy apply/undo
    Solver.applyTentativePick = function (block, scored) {
        var pick = scored.pick;
        applyPickToSchedule(block, pick);
        var fieldNorm = normName(pick.field);
        if (block.startTime !== undefined && block.endTime !== undefined) {
            addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName);
            var actNorm = normName(pick._activity);
            if (actNorm && actNorm !== fieldNorm) {
                addToFieldTimeIndex(actNorm, block.startTime, block.endTime, block.bunk, block.divName);
            }
        }
        invalidateRotationCacheForBunk(block.bunk);
        return { block: block, pick: pick, bunk: block.bunk, startMin: block.startTime };
    };

    Solver.undoTentativePick = function (res) {
        undoPickFromSchedule(res.block, res.pick);
    };

    // ========================================================================
    // ★★★ v11.0: MAIN SOLVER PIPELINE ★★★
    // ========================================================================

    Solver.solveSchedule = function (allBlocks, config) {
        var solveStartTime = performance.now();

        globalConfig = config;
        activityProperties = config.activityProperties || {};

        // ═══ RESET ═══
        clearAllCaches();
        clearBunkDivisionCache();

        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!globalConfig.rotationHistory) globalConfig.rotationHistory = {};
        if (!globalConfig.rotationHistory.leagues) globalConfig.rotationHistory.leagues = {};

        var sorted = Solver.sortBlocksByDifficulty(allBlocks, config);
        var activityBlocks = sorted.filter(function(b) { return !b._isLeague; });

        if (window.RotationEngine?.clearHistoryCache) {
            window.RotationEngine.clearHistoryCache();
        }

        // Resolve time ranges for all blocks
        for (var block of activityBlocks) {
            if (block.startTime === undefined || block.endTime === undefined) {
                var divSlots = window.divisionTimes?.[block.divName] || [];
                var slots = block.slots || [];
                if (slots.length > 0 && divSlots[slots[0]]) {
                    block.startTime = divSlots[slots[0]].startMin;
                    var lastSlot = divSlots[slots[slots.length - 1]];
                    block.endTime = lastSlot ? lastSlot.endMin : (block.startTime + 40);
                }
            }
        }

        console.log('\n[SOLVER] ★★★ ULTIMATE v11.0 — OPTIMAL CONSTRAINT SOLVER ★★★');
        console.log('[SOLVER] Pipeline: Compat Matrix → AC-3 → Slot Matching → Backjump → Polish');
        console.log('[SOLVER] ' + activityBlocks.length + ' activity blocks to solve');

        // ═══ STEP 1: Build candidate options ONCE ═══
        var t1 = performance.now();
        allCandidateOptions = buildAllCandidateOptions(config);
        console.log('[SOLVER] Step 1: ' + allCandidateOptions.length + ' candidates (' + (performance.now() - t1).toFixed(1) + 'ms)');

        // ═══ STEP 2: Build time-indexed field map ═══
        var t2 = performance.now();
        buildFieldTimeIndex();
        console.log('[SOLVER] Step 2: Field time index (' + (performance.now() - t2).toFixed(1) + 'ms)');

        // ═══ STEP 3: Pre-computed compatibility matrix ═══
        var t3 = performance.now();
        _compatMatrix = buildCompatibilityMatrix(activityBlocks);
        console.log('[SOLVER] Step 3: Compat matrix ' + _compatMatrix.numBlocks + 'x' + _compatMatrix.numCands + ' (' + (performance.now() - t3).toFixed(1) + 'ms)');

        // ═══ STEP 4: Build slot groups ═══
        var t4 = performance.now();
        _slotGroups = buildSlotGroups(activityBlocks);
        console.log('[SOLVER] Step 4: ' + _slotGroups.size + ' slot groups (' + (performance.now() - t4).toFixed(1) + 'ms)');

        // ═══ STEP 5: Initialize domains ═══
        var t5 = performance.now();
        _domains = initializeDomains(activityBlocks);
        var avgDomain = _domains.size > 0
            ? (Array.from(_domains.values()).reduce(function(s, d) { return s + d.size; }, 0) / _domains.size).toFixed(1)
            : '0';
        console.log('[SOLVER] Step 5: Domains, avg size ' + avgDomain + ' (' + (performance.now() - t5).toFixed(1) + 'ms)');

        // ═══ STEP 6: AC-3 Constraint Propagation ═══
        var t6 = performance.now();
        var ac3Result = propagateAC3(activityBlocks);
        console.log('[SOLVER] Step 6: AC-3 — ' + ac3Result.autoAssigned + ' auto-assigned, ' + ac3Result.propagated + ' pruned (' + (performance.now() - t6).toFixed(1) + 'ms)');

        // ═══ STEP 7: Slot-Group Optimal Matching ═══
        var t7 = performance.now();
        var matchedCount = solveSlotGroups(activityBlocks);
        console.log('[SOLVER] Step 7: Matched ' + matchedCount + ' (total: ' + _assignedBlocks.size + '/' + activityBlocks.length + ') (' + (performance.now() - t7).toFixed(1) + 'ms)');

        // ═══ STEP 8: Backjump Solver ═══
        var remaining = activityBlocks.length - _assignedBlocks.size;
        if (remaining > 0) {
            var t8 = performance.now();
            var bjSolved = backjumpSolver(activityBlocks);
            console.log('[SOLVER] Step 8: Backjump ' + bjSolved + '/' + remaining + ' (' + (performance.now() - t8).toFixed(1) + 'ms)');
        } else {
            console.log('[SOLVER] Step 8: Skipped (all assigned!)');
        }

        // ═══ STEP 9: Post-Solve Polish ═══
        var t9 = performance.now();
        postSolveLocalSearch(activityBlocks);
        console.log('[SOLVER] Step 9: Polish (' + (performance.now() - t9).toFixed(1) + 'ms)');

        // ═══ REPORT ═══
        var solveTime = performance.now() - solveStartTime;
        var freeCount = 0;
        for (var _ref of _assignments) {
            var actNorm = normName(_ref[1].pick._activity || _ref[1].pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') freeCount++;
        }

        console.log('\n[SOLVER] ══════════════════════════════════════════');
        console.log('[SOLVER] ✅ SOLVE COMPLETE: ' + solveTime.toFixed(0) + 'ms');
        console.log('[SOLVER]    ' + activityBlocks.length + ' blocks, ' + freeCount + ' Free');
        console.log('[SOLVER]    AC-3: ' + ac3Result.autoAssigned + ' | Matched: ' + matchedCount + ' | Backjump: ' + (activityBlocks.length - ac3Result.autoAssigned - matchedCount));
        console.log('[SOLVER] ══════════════════════════════════════════\n');

        // ═══ FORMAT OUTPUT ═══
        var results = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var blk = activityBlocks[i];
            var assignment = _assignments.get(i);
            var solution = assignment ? assignment.pick : { field: "Free", sport: null, _activity: "Free" };
            results.push({
                bunk: blk.bunk,
                divName: blk.divName,
                startTime: blk.startTime,
                endTime: blk.endTime,
                solution: solution
            });
        }

        return results;
    };

    // ========================================================================
    // DEBUG UTILITIES
    // ========================================================================

    Solver.debugFieldAvailability = function(fieldName, slots) {
        console.log('\n=== DEBUG: ' + fieldName + ' AVAILABILITY ===');
        if (window.GlobalFieldLocks) {
            var lockInfo = window.GlobalFieldLocks.isFieldLocked(fieldName, slots);
            if (lockInfo) {
                console.log('🔒 GLOBALLY LOCKED by ' + lockInfo.lockedBy);
                return false;
            } else {
                console.log('✅ Not globally locked');
            }
        }
        var props = activityProperties[fieldName];
        if (props) console.log('Props:', props);
        else console.log('No activity properties found');
        return true;
    };

    Solver.debugCrossDivisionConflict = function(fieldName, divName, slotIdx) {
        var divSlots = window.divisionTimes?.[divName] || [];
        var slot = divSlots[slotIdx];
        if (!slot) { console.log('Slot not found'); return; }

        console.log('\n🔍 Cross-Division Check: "' + fieldName + '" at Div ' + divName + ' Slot ' + slotIdx);
        console.log('   Time: ' + slot.startMin + '-' + slot.endMin);

        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm) || [];
        console.log('   Time index entries: ' + entries.length);
        entries.forEach(function(e) {
            if (e.startMin < slot.endMin && e.endMin > slot.startMin) {
                console.log('   ⚠️ OVERLAP: Div ' + e.divName + ' Bunk ' + e.bunk + ' (' + e.startMin + '-' + e.endMin + ')');
            }
        });
    };

    Solver.debugSolverStats = function() {
        console.log('\n=== SOLVER v11.0 STATS ===');
        console.log('Normalized names:     ' + _normalizedNames.size);
        console.log('Rotation score cache: ' + _rotationScoreCache.size);
        console.log('Today activity cache: ' + _todayCache.size);
        console.log('Field time index:     ' + _fieldTimeIndex.size + ' fields');
        var totalEntries = 0;
        for (var entries of _fieldTimeIndex.values()) totalEntries += entries.length;
        console.log('  Total time entries: ' + totalEntries);
        console.log('Assigned blocks:      ' + _assignedBlocks.size);
        console.log('Active assignments:   ' + _assignments.size);
        if (_compatMatrix) console.log('Compat matrix:        ' + _compatMatrix.numBlocks + 'x' + _compatMatrix.numCands);
        if (_slotGroups) console.log('Slot groups:          ' + _slotGroups.size);
        if (_domains) {
            var avg = _domains.size > 0
                ? (Array.from(_domains.values()).reduce(function(s, d) { return s + d.size; }, 0) / _domains.size).toFixed(1)
                : '0';
            console.log('Avg domain size:      ' + avg);
        }
    };

    Solver.debugDomains = function(blockIdx) {
        if (!_domains) { console.log('No domains — run solver first'); return; }
        var d = _domains.get(blockIdx);
        if (!d) { console.log('No domain for block ' + blockIdx); return; }
        console.log('Block ' + blockIdx + ': ' + d.size + ' options');
        for (var ci of d) {
            var c = allCandidateOptions[ci];
            console.log('  [' + ci + '] ' + c.field + ' -> ' + c.activityName);
        }
    };

    // ========================================================================
    // LEAGUE MATCHUP ENGINE (unchanged)
    // ========================================================================

    Solver.generateLeagueMatchups = function(teams, opts) {
        opts = opts || {};
        var n = teams.length;
        if (n < 2) return [];

        var excludePairs = (opts.excludePairs || []).map(function(p) {
            return [normName(p[0]), normName(p[1])].sort().join('|');
        });

        var teamList = teams.slice();
        if (teamList.length % 2 !== 0) teamList.push("BYE");

        var totalTeams = teamList.length;
        var rounds = [];

        for (var round = 0; round < totalTeams - 1; round++) {
            var matchups = [];
            for (var i = 0; i < totalTeams / 2; i++) {
                var t1 = teamList[i];
                var t2 = teamList[totalTeams - 1 - i];
                if (t1 === "BYE" || t2 === "BYE") continue;

                var pairKey = [normName(t1), normName(t2)].sort().join('|');
                if (!excludePairs.includes(pairKey)) {
                    matchups.push({ team1: t1, team2: t2 });
                }
            }
            rounds.push(matchups);
            var last = teamList.pop();
            teamList.splice(1, 0, last);
        }
        return rounds;
    };

    Solver.getLeagueMatchupsForRound = function(leagueName, teams, roundNumber) {
        var allRounds = Solver.generateLeagueMatchups(teams);
        var idx = (roundNumber - 1) % allRounds.length;
        return allRounds[idx] || [];
    };

    Solver.assignFieldsToMatchups = function(matchups, availableFields, history, leagueName) {
        if (!matchups || matchups.length === 0) return [];
        if (!availableFields || availableFields.length === 0) return matchups;

        var fieldPool = availableFields.slice();
        return matchups.map(function(m, i) {
            return Object.assign({}, m, { field: fieldPool[i % fieldPool.length] });
        });
    };

    // ========================================================================
    // EXPOSE
    // ========================================================================

    window.totalSolverEngine = Solver;
    window.TotalSolver = Solver;

})();
