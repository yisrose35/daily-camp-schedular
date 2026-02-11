// ============================================================================
// total_solver_engine.js (ULTIMATE v13.0 - HUMAN-INTELLIGENT SCHEDULING)
// ============================================================================
// ★★★ v13.0: ACTIVITY-FIRST PLANNER + THREE-PASS SIMULATION ★★★
// ★★★ v12.4: SCARCITY-AWARE SORTING + DEEP FREE RESOLUTION ★★★
// ★★★ v12.3: STRICT CROSS-GRADE EXCLUSIVITY — ALL FIELD TYPES ★★★
//
// WHAT'S NEW IN v12.3 (over v12.1):
// ──────────────────────────────────
// QUALITY:
//  Q1. STRICT CROSS-GRADE EXCLUSIVITY:
//      - Now enforced on ALL field types (including 'all').
//      - If a field is used by Grade 1, Grade 2 cannot use it, even if
//        the field type is 'all' or 'custom'.
//      - Logic applied universally in:
//        * Domain building
//        * Cost evaluation
//        * AC-3 propagation
//        * Augmenting path matching
//        * Safety backstop
//
// WHAT'S NEW IN v12.1 (over v12.0):
// ──────────────────────────────────
// QUALITY:
//  Q1. SAME-FIELD ACTIVITY CONSISTENCY:
//      - Enforces that if multiple bunks share a field (e.g. sharing type 'all'
//        or 'same_division'), they MUST be doing the same activity/sport.
//      - Adds 'activityName' to the high-performance Time Index.
//      - Adds live checks during candidate filtering and augmenting path matching.
//      - Adds a final backstop safety sweep to catch and fix any activity mismatches.
//
// PERFORMANCE:
//  P1. FUSED DOMAIN INITIALIZATION — compat matrix + domain init merged into
//      ONE pass. Eliminates the entire buildCompatibilityMatrix step and its
//      O(N×C) redundant iteration. Domains built directly with ALL checks.
//  P2. PRE-COMPUTED FIELD PROPERTY MAP — capacity, sharing type, and division
//      preferences cached in a Map ONCE. Eliminates repeated property chain
//      lookups in every hot path.
//  P3. BATCHED ROTATION SCORING — rotation scores pre-computed per bunk×activity
//      ONCE before domain init.
//  P4. SORTED TIME INDEX — field time entries sorted by startMin for binary
//      search on overlap queries.
//  P5. REUSABLE SCRATCH OBJECTS — pick objects reused during cost evaluation.
//
// DIAGNOSTICS:
//  D1. ALL LOGGING GATED — debug, rotation, cross-div, and v12 logging
//      controlled by flags. Zero console overhead in production.
//
// SOLVING PIPELINE (v12.3):
//   1. buildAllCandidateOptions()        — master activity list (once)
//   2. buildFieldTimeIndex()             — sorted time-indexed field usage (w/ Activity Name)
//   3. precomputeFieldProperties()       — capacity + sharing type map
//   4. precomputeRotationScores()        — bunk×activity score map
//   5. buildDomainsAndSlotGroups()       — FUSED domain + group build
//   6. propagateAC3()                    — arc consistency
//   7. solveSlotGroups()                 — augmenting path matching (w/ Activity Checks)
//   8. backjumpSolver()                  — resolve remaining
//   9. postSolveLocalSearch()            — polish + swap chains
//   10. Cross-Division & Activity Sweep  — final safety check
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;

    // ★★★ v12.0: ALL LOGGING GATED — set to true ONLY for debugging ★★★
    const DEBUG_MODE = false;
    const DEBUG_ROTATION = false;
    const DEBUG_CROSS_DIV = false;
    const DEBUG_V12 = false;

    let globalConfig = null;
    let activityProperties = {};
    let allCandidateOptions = [];

    // ========================================================================
    // SOLVER-WIDE CACHES (cleared per solve cycle)
    // ========================================================================

    const _normalizedNames = new Map();
    let _rotationScoreCache = new Map();
    let _todayCache = new Map();
    let _fieldTimeIndex = new Map();

    // ★★★ v12.0: NEW pre-computed lookup tables ★★★
    let _fieldPropertyMap = new Map();     // fieldName → { capacity, sharingType, prefList, prefExclusive }
    let _rotationScoreMap = new Map();     // "bunk|activity" → score
    let _bunkDivisionCache = new Map();    // bunk → divName

    // Domain-based structures
    let _domains = null;          // Map<blockIdx, Set<candIdx>>
    let _slotGroups = null;       // Map<timeKey, blockIdx[]>
    let _assignedBlocks = new Set();
    let _assignments = new Map(); // blockIdx → { candIdx, pick, cost }

    // ★★★ v13.0: Activity-First Planner state ★★★
    let _activityPlan = new Map();      // blockIdx → { activity, steering }
    let _activityDebt = new Map();      // "bunk|activity" → debtScore
    let _scarcityMap = new Map();       // "field|startMin" → scarcityRatio
    let _uniqueFieldMap = new Map();    // activity → number of fields that host it
    let _timeConstrainedBoost = new Map(); // activity → { windowMinutes, totalMinutes }
    let _skeletonContext = new Map();   // blockIdx → { prevType, nextType, prevEvent, nextEvent }
    let _smallBunkFlags = new Set();    // set of bunk names that are below min-player threshold
    let _passNumber = 0;               // current pass (1=pencil, 2=ink attempt, 3=final)
    let _passAnalysis = null;           // analysis results from previous pass

    // ★★★ v12.0: Performance counters ★★★
    let _perfCounters = {
        rotationCacheHits: 0,
        rotationCacheMisses: 0,
        timeIndexQueries: 0,
        domainPruned: 0,
        augmentingPathAttempts: 0,
        augmentingPathSuccesses: 0
    };

    function clearAllCaches() {
        _rotationScoreCache.clear();
        _todayCache.clear();
        _assignedBlocks.clear();
        _assignments.clear();
        _fieldPropertyMap.clear();
        _rotationScoreMap.clear();
        _domains = null;
        _slotGroups = null;
        // ★★★ v13.0: Clear planner state ★★★
        _activityPlan.clear();
        _scarcityMap.clear();
        _skeletonContext.clear();
        // Don't clear _activityDebt — it persists across passes
        // Don't clear _uniqueFieldMap, _timeConstrainedBoost, _smallBunkFlags — rebuilt per solve
        _perfCounters = {
            rotationCacheHits: 0, rotationCacheMisses: 0,
            timeIndexQueries: 0, domainPruned: 0,
            augmentingPathAttempts: 0, augmentingPathSuccesses: 0
        };
    }

    // ========================================================================
    // LOGGING HELPERS (NO-OP when flags are false)
    // ========================================================================

    function debugLog() { if (DEBUG_MODE) console.log.apply(console, ['[SOLVER]'].concat(Array.from(arguments))); }
    function rotationLog() { if (DEBUG_ROTATION) console.log.apply(console, ['[ROTATION]'].concat(Array.from(arguments))); }
    function crossDivLog() { if (DEBUG_CROSS_DIV) console.log.apply(console, ['[CROSS-DIV]'].concat(Array.from(arguments))); }
    function v12Log() { if (DEBUG_V12) console.log.apply(console, ['[v12]'].concat(Array.from(arguments))); }

    // ========================================================================
    // PRE-NORMALIZED NAME UTILITY
    // ========================================================================

    function normName(name) {
        if (!name) return '';
        var cached = _normalizedNames.get(name);
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
            var defaults = {
                YESTERDAY_PENALTY: 12000,
                TWO_DAYS_AGO_PENALTY: 8000,
                THREE_DAYS_AGO_PENALTY: 5000,
                SAME_DAY_PENALTY: Infinity,
                TIE_BREAKER_RANDOMNESS: 300,
                ADJACENT_BUNK_BONUS: -150,
                NEARBY_BUNK_BONUS: -100
            };
            return defaults[prop] !== undefined ? defaults[prop] : 0;
        }
    });

    // ========================================================================
    // BUNK → DIVISION CACHE
    // ========================================================================

    function getBunkDivision(bunkName) {
        if (!bunkName) return '';
        var cached = _bunkDivisionCache.get(bunkName);
        if (cached !== undefined) return cached;

        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            var div = window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
            _bunkDivisionCache.set(bunkName, div || '');
            return div || '';
        }

        var divisions = window.divisions || {};
        for (var divName in divisions) {
            var bunks = divisions[divName]?.bunks || [];
            if (bunks.indexOf(bunkName) !== -1) {
                _bunkDivisionCache.set(bunkName, divName);
                return divName;
            }
        }
        _bunkDivisionCache.set(bunkName, '');
        return '';
    }

    function clearBunkDivisionCache() {
        _bunkDivisionCache.clear();
    }

    function getBunkNumber(bunkName) {
        if (!bunkName) return null;
        var m = String(bunkName).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // ========================================================================
    // ★★★ v12.0 P2: PRE-COMPUTED FIELD PROPERTY MAP ★★★
    // Built ONCE per solve. Eliminates repeated property chain lookups.
    // ========================================================================

    function precomputeFieldProperties() {
        _fieldPropertyMap.clear();
        var props = activityProperties || {};

        // ★★★ v12.2 FIX: Load field sharing rules from campGlobalSettings_v1.fields[] ★★★
        // The UI stores field properties in a fields[] array, not in activityProperties.
        // Build a lookup so the solver sees the correct sharing/capacity rules.
        var _storedFieldProps = {};
        try {
            var gs = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            var storedFields = gs.fields || gs.app1?.fields || [];
            for (var fi = 0; fi < storedFields.length; fi++) {
                var sf = storedFields[fi];
                if (sf && sf.name) _storedFieldProps[sf.name] = sf;
            }
        } catch(e) { /* ignore parse errors */ }

        // Process all known fields from candidates
        for (var i = 0; i < allCandidateOptions.length; i++) {
            var cand = allCandidateOptions[i];
            var fieldName = cand.field;
            if (_fieldPropertyMap.has(fieldName)) continue;

            // Merge: activityProperties takes precedence, then stored fields
            var fieldProps = props[fieldName] || _storedFieldProps[fieldName] || {};
            // If activityProperties entry exists but has no sharableWith, check stored fields
            if (!fieldProps.sharableWith && !fieldProps.sharable && _storedFieldProps[fieldName]) {
                fieldProps = _storedFieldProps[fieldName];
            }
            var capacity = 1;
            var sharingType = 'not_sharable';
            var prefList = null;
            var prefExclusive = false;

            // Capacity + sharing type
            if (fieldProps.sharableWith) {
                var sw = fieldProps.sharableWith;
                if (sw.type === 'not_sharable') { capacity = 1; sharingType = 'not_sharable'; }
                else if (sw.type === 'all') { capacity = parseInt(sw.capacity) || 999; sharingType = 'all'; }
                else if (sw.type === 'same_division') { capacity = parseInt(sw.capacity) || 2; sharingType = 'same_division'; }
                else if (sw.type === 'custom') { capacity = parseInt(sw.capacity) || 2; sharingType = 'custom'; }
                else if (sw.capacity) { capacity = parseInt(sw.capacity); sharingType = 'same_division'; }
                else { capacity = 2; sharingType = 'same_division'; }
            } else if (fieldProps.sharable) {
                capacity = 2; sharingType = 'same_division';
            }

            // Division preferences
            var prefProps = fieldProps;
            if (!prefProps?.preferences?.enabled) {
                // Also check activity name props
                var actProps = props[cand.activityName];
                if (actProps?.preferences?.enabled) prefProps = actProps;
            }
            if (prefProps?.preferences?.enabled) {
                prefList = prefProps.preferences.list || [];
                prefExclusive = !!prefProps.preferences.exclusive;
            }

            _fieldPropertyMap.set(fieldName, {
                capacity: capacity,
                sharingType: sharingType,
                prefList: prefList,
                prefExclusive: prefExclusive,
                hasProps: true
            });
        }

        v12Log('Field properties pre-computed: ' + _fieldPropertyMap.size + ' fields');
    }

    function getFieldCapacity(fieldName) {
        var cached = _fieldPropertyMap.get(fieldName);
        if (cached) return cached.capacity;

        // Fallback for fields not in candidate list
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        return 1;
    }

    function getSharingType(fieldName) {
        var cached = _fieldPropertyMap.get(fieldName);
        if (cached) return cached.sharingType;

        var props = activityProperties[fieldName] || {};
        if (props.sharableWith?.type) return props.sharableWith.type;
        if (props.sharable) return 'same_division';
        return 'not_sharable';
    }

    // ========================================================================
    // ★★★ v12.0 P4: SORTED TIME INDEX — Binary search for overlaps ★★★
    // ========================================================================

    function buildFieldTimeIndex() {
        _fieldTimeIndex.clear();
        var schedules = window.scheduleAssignments || {};
        var divisions = window.divisions || {};
        var allDivTimes = window.divisionTimes || {};

        for (var divName in divisions) {
            var divSlots = allDivTimes[divName] || [];
            var bunks = divisions[divName]?.bunks || [];
            for (var bi = 0; bi < bunks.length; bi++) {
                var bunk = bunks[bi];
                var bunkAssignments = schedules[bunk] || [];
                for (var slotIdx = 0; slotIdx < divSlots.length; slotIdx++) {
                    var entry = bunkAssignments[slotIdx];
                    if (!entry || entry.continuation) continue;
                    var slot = divSlots[slotIdx];
                    if (!slot || slot.startMin === undefined) continue;

                    var fieldNorm = normName(entry.field);
                    var actNorm = normName(entry._activity);
                    var fieldLabel = normName(
                        window.SchedulerCoreUtils?.fieldLabel?.(entry.field) || ''
                    );
                    
                    var entryActivityNorm = normName(entry._activity || entry.sport || entry.field);
                    var names = new Set([fieldNorm, actNorm, fieldLabel].filter(function(n) { return n; }));
                    for (var name of names) {
                        addToFieldTimeIndex(name, slot.startMin, slot.endMin, bunk, divName, entryActivityNorm);
                    }
                }
            }
        }

        // ★★★ v12.0: Sort all entries by startMin for binary search ★★★
        for (var [key, entries] of _fieldTimeIndex) {
            entries.sort(function(a, b) { return a.startMin - b.startMin; });
        }

        v12Log('Field time index built: ' + _fieldTimeIndex.size + ' entries (sorted)');
    }

    function addToFieldTimeIndex(fieldNorm, startMin, endMin, bunk, divName, activityName) {
        if (!_fieldTimeIndex.has(fieldNorm)) _fieldTimeIndex.set(fieldNorm, []);
        // Insert maintaining sort order (most inserts are at the end or near it)
        var entries = _fieldTimeIndex.get(fieldNorm);
        entries.push({ startMin: startMin, endMin: endMin, bunk: bunk, divName: divName, activityName: activityName || '' });
        // Re-sort only if needed (entries pushed out of order)
        if (entries.length > 1 && entries[entries.length - 1].startMin < entries[entries.length - 2].startMin) {
            entries.sort(function(a, b) { return a.startMin - b.startMin; });
        }
    }

    function removeFromFieldTimeIndex(fieldNorm, startMin, endMin, bunk) {
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return;
        var idx = entries.findIndex(function(e) {
            return e.bunk === bunk && e.startMin === startMin && e.endMin === endMin;
        });
        if (idx !== -1) entries.splice(idx, 1);
    }

    // ★★★ v12.0 P4: Binary search for first entry that could overlap ★★★
    function findFirstOverlapIndex(entries, queryStart, queryEnd) {
        // Find first entry where endMin > queryStart (could overlap)
        // Since entries are sorted by startMin, we look for entries where startMin < queryEnd
        var lo = 0, hi = entries.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (entries[mid].startMin >= queryEnd) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return lo;  // Upper bound — scan from 0 to lo-1
    }

    function getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, excludeBunk) {
        _perfCounters.timeIndexQueries++;
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries || entries.length === 0) return 0;
        var count = 0;
        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) {
            var e = entries[i];
            if (e.bunk === excludeBunk) continue;
            if (e.endMin > startMin) count++;  // startMin < endMin is guaranteed by upperBound
        }
        return count;
    }

    function checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, excludeBunk) {
        if (startMin === undefined || endMin === undefined) return null;
        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return null;

        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) {
            var e = entries[i];
            if (e.divName === blockDivName) continue;
            if (e.bunk === excludeBunk) continue;
            if (e.endMin > startMin) {
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
        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return 0;
        var count = 0;
        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) {
            var e = entries[i];
            if (e.divName !== divisionName) continue;
            if (e.bunk === excludeBunk) continue;
            if (e.endMin > startMin) count++;
        }
        return count;
    }

    // ★★★ v12.1: Same-field activity mismatch check ★★★
    // When bunks share a field, they MUST be doing the same sport/activity.
    // Returns the conflicting activity name if mismatch found, null if OK.
    function checkSameFieldActivityMismatch(fieldName, startMin, endMin, activityName, excludeBunk) {
        if (!activityName || activityName === 'Free' || activityName === 'free') return null;
        var fieldNorm = normName(fieldName);
        var actNorm = normName(activityName);
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return null;
        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) {
            var e = entries[i];
            if (e.bunk === excludeBunk) continue;
            if (e.endMin <= startMin) continue;
            // Entry overlaps in time — check activity
            if (e.activityName && e.activityName !== actNorm) {
                return e.activityName;
            }
        }
        return null;
    }

    // ========================================================================
    // ★★★ v12.0 P3: BATCHED ROTATION SCORING ★★★
    // Pre-compute rotation scores per bunk×activity ONCE.
    // ========================================================================

    function precomputeRotationScores(activityBlocks) {
        _rotationScoreMap.clear();

        // Collect unique bunk×activity pairs needed
        var pairs = new Set();
        var bunkSet = new Set();
        var actSet = new Set();

        for (var i = 0; i < activityBlocks.length; i++) {
            bunkSet.add(activityBlocks[i].bunk);
        }
        for (var j = 0; j < allCandidateOptions.length; j++) {
            actSet.add(allCandidateOptions[j].activityName);
        }

        // For each bunk, score each activity
        var scored = 0;
        for (var bunk of bunkSet) {
            var divName = getBunkDivision(bunk);
            for (var actName of actSet) {
                if (!actName || actName === 'Free') continue;
                var key = bunk + '|' + actName;
                if (_rotationScoreMap.has(key)) continue;

                var score;
                if (window.RotationEngine?.calculateRotationScore) {
                    score = window.RotationEngine.calculateRotationScore({
                        bunkName: bunk,
                        activityName: actName,
                        divisionName: divName,
                        beforeSlotIndex: 0,  // Slot-independent for batch
                        allActivities: null,
                        activityProperties: activityProperties
                    });
                } else {
                    // Basic fallback
                    var todayActivities = getActivitiesDoneToday(bunk, 999);
                    if (todayActivities.has(normName(actName))) {
                        score = Infinity;
                    } else {
                        score = 0;
                    }
                }

                _rotationScoreMap.set(key, score);
                scored++;
            }
        }

        v12Log('Rotation scores pre-computed: ' + scored + ' bunk×activity pairs');
    }

    // ========================================================================
    // ★★★ v13.0: PRECOMPUTE RESOURCE MAPS ★★★
    // Built ONCE per solve. Identifies unique resources, time constraints,
    // small bunks, and skeleton context for intelligent planning.
    // ========================================================================

    function precomputeResourceMaps(activityBlocks) {
        _uniqueFieldMap.clear();
        _timeConstrainedBoost.clear();
        _smallBunkFlags.clear();

        // --- 1. Unique Field Map: for each activity, how many fields host it? ---
        var activityToFields = {};
        for (var i = 0; i < allCandidateOptions.length; i++) {
            var c = allCandidateOptions[i];
            var act = c.activityName;
            if (!act || act === 'Free') continue;
            if (!activityToFields[act]) activityToFields[act] = new Set();
            activityToFields[act].add(c.field);
        }
        for (var actName in activityToFields) {
            _uniqueFieldMap.set(actName, activityToFields[actName].size);
        }

        // --- 2. Time-Constrained Activity Detection ---
        // Activities with time rules have narrower windows — they should be prioritized
        // during their available times so they don't go to waste.
        var props = activityProperties || {};
        for (var fieldName in props) {
            var fp = props[fieldName];
            if (!fp) continue;
            var rules = fp.timeRules || [];
            var availRules = rules.filter(function(r) { return r.type === 'Available'; });
            if (availRules.length > 0) {
                // This activity has explicit availability windows
                var totalWindowMinutes = 0;
                for (var ri = 0; ri < availRules.length; ri++) {
                    var r = availRules[ri];
                    var rStart = r.startMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.start) || 0);
                    var rEnd = r.endMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.end) || 0);
                    totalWindowMinutes += Math.max(0, rEnd - rStart);
                }
                // Compare to total day length (~480 min = 8 hours)
                var totalDay = 480;
                if (totalWindowMinutes < totalDay * 0.5) {
                    // Available less than half the day — this is a constrained resource
                    _timeConstrainedBoost.set(fieldName, {
                        windowMinutes: totalWindowMinutes,
                        totalMinutes: totalDay,
                        boost: Math.round(3000 * (1 - totalWindowMinutes / totalDay))
                    });
                }
            }
        }
        // Also check specials
        var specials = window.getGlobalSpecialActivities?.() || [];
        for (var si = 0; si < specials.length; si++) {
            var sp = specials[si];
            var spProps = activityProperties[sp.name];
            if (spProps && spProps.timeRules && spProps.timeRules.length > 0) {
                var spAvail = spProps.timeRules.filter(function(r) { return r.type === 'Available'; });
                if (spAvail.length > 0 && !_timeConstrainedBoost.has(sp.name)) {
                    var spWindow = 0;
                    for (var sri = 0; sri < spAvail.length; sri++) {
                        var sr = spAvail[sri];
                        var srStart = sr.startMin ?? 0;
                        var srEnd = sr.endMin ?? 0;
                        spWindow += Math.max(0, srEnd - srStart);
                    }
                    if (spWindow < 240) {
                        _timeConstrainedBoost.set(sp.name, {
                            windowMinutes: spWindow,
                            totalMinutes: 480,
                            boost: Math.round(3000 * (1 - spWindow / 480))
                        });
                    }
                }
            }
        }

        // --- 3. Small Bunk Detection ---
        // Bunks whose size alone is below the min-player threshold for most sports
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        var sportMeta = window.getSportMetaData?.() || window.sportMetaData || {};
        var minThresholds = [];
        for (var sport in sportMeta) {
            if (sportMeta[sport].minPlayers) minThresholds.push(sportMeta[sport].minPlayers);
        }
        if (minThresholds.length > 0) {
            // Use the median min-player threshold as the "small bunk" cutoff
            minThresholds.sort(function(a, b) { return a - b; });
            var medianMin = minThresholds[Math.floor(minThresholds.length / 2)];
            for (var bunkName in bunkMeta) {
                var size = bunkMeta[bunkName]?.size || 0;
                if (size > 0 && size < medianMin) {
                    _smallBunkFlags.add(bunkName);
                }
            }
        }

        // --- 4. Skeleton Context (what's before/after each block) ---
        // Group blocks by bunk, sort by time, then record prev/next types
        var bunkBlocks = {};
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi];
            var bk = blk.bunk;
            if (!bunkBlocks[bk]) bunkBlocks[bk] = [];
            bunkBlocks[bk].push({ idx: bi, startTime: blk.startTime || 0, event: blk.event || '' });
        }

        // Also pull skeleton data for non-general blocks (leagues, swim, etc.)
        var dailyData = window.loadCurrentDailyData?.() || {};
        var skeleton = dailyData.manualSkeleton || [];

        for (var bunkKey in bunkBlocks) {
            var bBlocks = bunkBlocks[bunkKey];
            bBlocks.sort(function(a, b) { return a.startTime - b.startTime; });

            var bunkDiv = getBunkDivision(bunkKey);

            // Build full timeline: skeleton events + general blocks for this bunk's division
            var fullTimeline = [];
            for (var ski = 0; ski < skeleton.length; ski++) {
                var sk = skeleton[ski];
                if (sk.division !== bunkDiv) continue;
                var skStart = window.SchedulerCoreUtils?.parseTimeToMinutes?.(sk.startTime) || 0;
                fullTimeline.push({
                    startTime: skStart,
                    event: sk.event || sk.type || '',
                    type: sk.type || ''
                });
            }
            fullTimeline.sort(function(a, b) { return a.startTime - b.startTime; });

            for (var bbi = 0; bbi < bBlocks.length; bbi++) {
                var curBlock = bBlocks[bbi];
                var prevType = null, nextType = null;
                var prevEvent = '', nextEvent = '';

                // Find what's before and after in the full timeline
                for (var ti = 0; ti < fullTimeline.length; ti++) {
                    if (fullTimeline[ti].startTime < curBlock.startTime) {
                        prevEvent = fullTimeline[ti].event;
                        prevType = categorizeSkeletonEvent(fullTimeline[ti]);
                    }
                    if (fullTimeline[ti].startTime > curBlock.startTime && nextType === null) {
                        nextEvent = fullTimeline[ti].event;
                        nextType = categorizeSkeletonEvent(fullTimeline[ti]);
                    }
                }

                _skeletonContext.set(curBlock.idx, {
                    prevType: prevType,
                    nextType: nextType,
                    prevEvent: prevEvent,
                    nextEvent: nextEvent,
                    positionInDay: bbi,
                    totalBlocksForBunk: bBlocks.length
                });
            }
        }

        v12Log('v13 Resource maps: ' + _uniqueFieldMap.size + ' activities, ' +
               _timeConstrainedBoost.size + ' time-constrained, ' +
               _smallBunkFlags.size + ' small bunks, ' +
               _skeletonContext.size + ' skeleton contexts');
    }

    function categorizeSkeletonEvent(item) {
        var ev = (item.event || item.type || '').toLowerCase();
        if (ev.includes('league')) return 'sport';
        if (ev.includes('sport')) return 'sport';
        if (ev.includes('swim') || ev.includes('pool')) return 'sport';
        if (ev.includes('special')) return 'special';
        if (ev.includes('elective')) return 'special';
        if (ev.includes('lunch') || ev.includes('snack') || ev.includes('dismissal')) return 'break';
        if (ev.includes('activity') || ev.includes('general')) return 'general';
        if (ev.includes('smart')) return 'mixed';
        return 'other';
    }

    // ========================================================================
    // ★★★ v13.0: ACTIVITY-FIRST PLANNER ★★★
    // The "thinking" phase — runs BEFORE domain building.
    // Mimics a human scheduler: look at history, build wish lists,
    // allocate activities across division, then steer the solver.
    // ========================================================================

    function activityFirstPlanner(activityBlocks) {
        _activityPlan.clear();
        _scarcityMap.clear();

        var divisions = window.divisions || {};
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        var sportMeta = window.getSportMetaData?.() || window.sportMetaData || {};

        // Group blocks by division + time slot
        var divTimeGroups = {};  // "divName|startMin-endMin" → [blockIdx, ...]
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi];
            if (!blk.divName) blk.divName = getBunkDivision(blk.bunk) || '';
            var key = blk.divName + '|' + (blk.startTime || '?') + '-' + (blk.endTime || '?');
            if (!divTimeGroups[key]) divTimeGroups[key] = [];
            divTimeGroups[key].push(bi);
        }

        // For each division×time group, run the allocation
        for (var groupKey in divTimeGroups) {
            var blockIndices = divTimeGroups[groupKey];
            if (blockIndices.length === 0) continue;

            var sampleBlock = activityBlocks[blockIndices[0]];
            var divName = sampleBlock.divName;
            var startMin = sampleBlock.startTime;
            var endMin = sampleBlock.endTime;
            if (startMin === undefined || endMin === undefined) continue;

            // ══════════════════════════════════════════════════════════
            // PHASE A: BUILD WISH LISTS (per bunk)
            // ══════════════════════════════════════════════════════════
            var wishLists = {};  // bunk → [{ activity, need, actType }, ...]
            var bunkSizes = {}; // bunk → player count

            for (var i = 0; i < blockIndices.length; i++) {
                var block = activityBlocks[blockIndices[i]];
                var bunk = block.bunk;
                var bSize = bunkMeta[bunk]?.size || 0;
                bunkSizes[bunk] = bSize;

                var wishes = [];

                // Get all candidate activities for this block
                var candidateActivities = new Set();
                for (var ci = 0; ci < allCandidateOptions.length; ci++) {
                    var cand = allCandidateOptions[ci];
                    if (!cand.activityName || cand.activityName === 'Free') continue;
                    candidateActivities.add(cand.activityName);
                }

                // Score each activity by rotation need
                for (var actName of candidateActivities) {
                    var actNorm = normName(actName);

                    // Same-day duplicate check
                    var todayDone = getActivitiesDoneToday(bunk, block.slots?.[0] ?? 999);
                    if (todayDone.has(actNorm)) continue;

                    // Get rotation score (lower = more needed)
                    var rotScore = getPrecomputedRotationScore(bunk, actName);
                    if (rotScore === Infinity) continue;

                    // Check time availability for this activity
                    var actProps = activityProperties[actName];
                    if (actProps?.timeRules?.length > 0) {
                        // Check if activity is available at this time
                        var timeAvail = false;
                        var tempSlots = block.slots || [];
                        for (var tsi = 0; tsi < tempSlots.length; tsi++) {
                            if (window.SchedulerCoreUtils?.isTimeAvailable?.(tempSlots[tsi], actProps)) {
                                timeAvail = true;
                                break;
                            }
                        }
                        // Also check division restrictions on time rules
                        if (actProps.timeRules) {
                            var divFilteredRules = actProps.timeRules.filter(function(r) {
                                return !r.divisions || r.divisions.length === 0 || r.divisions.includes(divName);
                            });
                            if (divFilteredRules.length === 0 && actProps.timeRules.some(function(r) { return r.type === 'Available'; })) {
                                continue; // No applicable rules for this division
                            }
                        }
                        if (!timeAvail) continue;
                    }

                    // Solo player count check — can this bunk do this activity ALONE?
                    var soloCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(actName, bSize, false);
                    var needsSharing = soloCheck && !soloCheck.valid && soloCheck.severity === 'hard';

                    // Determine activity type
                    var isSpecial = window.RotationEngine?.isSpecialActivity?.(actName) ||
                                   (allCandidateOptions.some(function(c) { return c.activityName === actName && c.type === 'special'; }));

                    // Apply debt bonus from previous passes
                    var debtKey = bunk + '|' + actName;
                    var debtBonus = _activityDebt.get(debtKey) || 0;

                    // Time-constrained boost: if this activity has a narrow window and
                    // we're IN that window, boost its priority so it doesn't go to waste
                    var timeBoost = 0;
                    var tcInfo = _timeConstrainedBoost.get(actName);
                    if (tcInfo) {
                        timeBoost = -tcInfo.boost; // Negative = more desirable
                    }

                    wishes.push({
                        activity: actName,
                        need: rotScore + debtBonus + timeBoost,  // Lower = more needed
                        actType: isSpecial ? 'special' : 'sport',
                        needsSharing: needsSharing,
                        bunkSize: bSize
                    });
                }

                // Sort by need (lowest = most wanted)
                wishes.sort(function(a, b) { return a.need - b.need; });
                wishLists[bunk] = wishes;
            }

            // ══════════════════════════════════════════════════════════
            // PHASE B: ACTIVITY ALLOCATION (division-wide matching)
            // ══════════════════════════════════════════════════════════

            // Count supply: how many fields can host each activity at this time?
            var activitySupply = {};  // activity → available slots count
            for (var ci2 = 0; ci2 < allCandidateOptions.length; ci2++) {
                var c2 = allCandidateOptions[ci2];
                if (!c2.activityName || c2.activityName === 'Free') continue;
                if (!activitySupply[c2.activityName]) activitySupply[c2.activityName] = 0;

                // Check if this specific field is available at this time
                var fp = _fieldPropertyMap.get(c2.field);
                var cap = fp ? fp.capacity : 1;
                var sType = fp ? fp.sharingType : 'not_sharable';

                // Cross-div check
                if (divName && startMin !== undefined) {
                    if (checkCrossDivisionTimeConflict(c2.field, divName, startMin, endMin, null)) continue;
                }

                // Capacity check
                if (sType === 'not_sharable') {
                    var used = getFieldUsageFromTimeIndex(c2._fieldNorm, startMin, endMin, null);
                    if (used < cap) activitySupply[c2.activityName]++;
                } else {
                    var sameDivUsed = countSameDivisionUsage(c2.field, divName, startMin, endMin, null);
                    if (sameDivUsed < cap) activitySupply[c2.activityName]++;
                }
            }

            // Deduplicate supply (multiple candidates for same activity on same field)
            // Actually we want unique field slots per activity
            var actFieldSlots = {};
            for (var ci3 = 0; ci3 < allCandidateOptions.length; ci3++) {
                var c3 = allCandidateOptions[ci3];
                if (!c3.activityName || c3.activityName === 'Free') continue;
                if (!actFieldSlots[c3.activityName]) actFieldSlots[c3.activityName] = new Set();
                actFieldSlots[c3.activityName].add(c3.field);
            }
            for (var afs in actFieldSlots) {
                activitySupply[afs] = actFieldSlots[afs].size;
            }

            // Small bunk pairing: pair small bunks with neighbors BEFORE allocation
            var bunkList = blockIndices.map(function(bi) { return activityBlocks[bi].bunk; });
            var pairedBunks = new Map();  // smallBunk → partnerBunk

            for (var sbi = 0; sbi < bunkList.length; sbi++) {
                var sBunk = bunkList[sbi];
                if (!_smallBunkFlags.has(sBunk)) continue;
                if (pairedBunks.has(sBunk)) continue;

                // Find nearest neighbor that isn't already paired
                var myNum = getBunkNumber(sBunk) || 0;
                var bestPartner = null;
                var bestDist = Infinity;
                for (var pbi = 0; pbi < bunkList.length; pbi++) {
                    var pBunk = bunkList[pbi];
                    if (pBunk === sBunk) continue;
                    if (pairedBunks.has(pBunk) && pairedBunks.get(pBunk) !== sBunk) continue;
                    var pNum = getBunkNumber(pBunk) || 0;
                    var dist = Math.abs(myNum - pNum);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestPartner = pBunk;
                    }
                }
                if (bestPartner) {
                    pairedBunks.set(sBunk, bestPartner);
                }
            }

            // Allocate: greedy assignment, most-needed bunks first
            var allocated = {};  // bunk → activityName
            var activityUsed = {};  // activity → count of bunks assigned

            // Sort bunks by how constrained they are (fewer wishes = solve first)
            var sortedBunks = bunkList.slice().sort(function(a, b) {
                return (wishLists[a]?.length || 0) - (wishLists[b]?.length || 0);
            });

            for (var abi = 0; abi < sortedBunks.length; abi++) {
                var aBunk = sortedBunks[abi];
                if (allocated[aBunk]) continue;
                var wishes2 = wishLists[aBunk] || [];

                for (var wi = 0; wi < wishes2.length; wi++) {
                    var wish = wishes2[wi];
                    var supply = activitySupply[wish.activity] || 0;
                    var used2 = activityUsed[wish.activity] || 0;

                    // Check if there's capacity for this activity
                    if (used2 >= supply) continue;

                    // If this bunk needs sharing, check if partner can also do this activity
                    if (wish.needsSharing && pairedBunks.has(aBunk)) {
                        var partner = pairedBunks.get(aBunk);
                        var combinedSize = (bunkSizes[aBunk] || 0) + (bunkSizes[partner] || 0);
                        var combinedCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(wish.activity, combinedSize, false);
                        if (combinedCheck && !combinedCheck.valid && combinedCheck.severity === 'hard') {
                            continue; // Even combined, too many/few players
                        }
                    }

                    // Check combined player count with anyone already assigned to this activity
                    var projectedPlayers = bunkSizes[aBunk] || 0;
                    for (var existBunk in allocated) {
                        if (allocated[existBunk] === wish.activity) {
                            projectedPlayers += (bunkSizes[existBunk] || 0);
                        }
                    }
                    var maxReqs = window.SchedulerCoreUtils?.getSportPlayerRequirements?.(wish.activity);
                    if (maxReqs?.maxPlayers && projectedPlayers > maxReqs.maxPlayers * 1.3) {
                        continue; // Would exceed max by >30%
                    }

                    // Assign!
                    allocated[aBunk] = wish.activity;
                    activityUsed[wish.activity] = (activityUsed[wish.activity] || 0) + 1;

                    // If paired small bunk, try to assign partner the same activity
                    if (pairedBunks.has(aBunk) && !allocated[pairedBunks.get(aBunk)]) {
                        var prt = pairedBunks.get(aBunk);
                        var prtWishes = wishLists[prt] || [];
                        var prtWantsThis = prtWishes.some(function(w) { return w.activity === wish.activity; });
                        if (prtWantsThis && (activityUsed[wish.activity] || 0) < (activitySupply[wish.activity] || 0)) {
                            allocated[prt] = wish.activity;
                            activityUsed[wish.activity]++;
                        }
                    }
                    break;
                }

                // Track debt for bunks that didn't get their #1 wish
                if (allocated[aBunk] && wishes2.length > 0 && allocated[aBunk] !== wishes2[0].activity) {
                    var debtKey2 = aBunk + '|' + wishes2[0].activity;
                    var existing = _activityDebt.get(debtKey2) || 0;
                    _activityDebt.set(debtKey2, existing - 2000);  // Negative = boost priority next time
                }
            }

            // ══════════════════════════════════════════════════════════
            // PHASE C: WRITE PLAN + SCARCITY MAP
            // ══════════════════════════════════════════════════════════

            for (var pi = 0; pi < blockIndices.length; pi++) {
                var bIdx = blockIndices[pi];
                var pBunk = activityBlocks[bIdx].bunk;
                if (allocated[pBunk]) {
                    _activityPlan.set(bIdx, {
                        activity: allocated[pBunk],
                        steering: -8000  // Strong bonus for matching plan
                    });
                }
            }

            // Scarcity map: for each activity, demand vs supply
            for (var scAct in activityUsed) {
                var demand = 0;
                for (var scBunk in wishLists) {
                    if (wishLists[scBunk]?.some(function(w) { return w.activity === scAct; })) demand++;
                }
                var scSupply = activitySupply[scAct] || 1;
                if (demand > scSupply) {
                    var scKey = scAct + '|' + startMin;
                    _scarcityMap.set(scKey, demand / scSupply);
                }
            }
        }

        console.log('[SOLVER-v13] 🧠 Activity-First Planner: ' + _activityPlan.size + ' blocks planned, ' +
                    _scarcityMap.size + ' scarce resources, ' + _activityDebt.size + ' debt entries');
    }

    // ========================================================================
    // ★★★ v13.0: PASS ANALYSIS — Learn from simulation results ★★★
    // ========================================================================

    function analyzePassResult(activityBlocks, passNum) {
        var analysis = {
            passNumber: passNum,
            freeBlocks: [],
            yesterdayRepeats: [],
            playerViolations: [],
            bottlenecks: {},   // "field|time" → { demand, supply }
            freeBlockBunks: new Set(),
            totalFree: 0,
            totalBlocks: activityBlocks.length,
            score: 0
        };

        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};

        for (var i = 0; i < activityBlocks.length; i++) {
            var asgn = _assignments.get(i);
            if (!asgn) continue;
            var block = activityBlocks[i];
            var actNorm = normName(asgn.pick._activity || asgn.pick.field);

            // Count Free blocks
            if (actNorm === 'free' || actNorm === 'free (timeout)') {
                analysis.freeBlocks.push({
                    blockIdx: i,
                    bunk: block.bunk,
                    divName: block.divName,
                    startTime: block.startTime,
                    endTime: block.endTime
                });
                analysis.freeBlockBunks.add(block.bunk);
                analysis.totalFree++;
                analysis.score += 10000;  // Heavy penalty for Free
            }

            // Check yesterday repeats
            if (actNorm && actNorm !== 'free') {
                var daysSince = getDaysSinceActivity(block.bunk, asgn.pick._activity);
                if (daysSince === 1) {
                    analysis.yesterdayRepeats.push({
                        blockIdx: i,
                        bunk: block.bunk,
                        activity: asgn.pick._activity
                    });
                    analysis.score += 5000;
                }
            }

            // Check player count violations
            if (actNorm && actNorm !== 'free' && asgn.pick.field && asgn.pick.field !== 'Free') {
                var fieldNorm = normName(asgn.pick.field);
                var entries = _fieldTimeIndex.get(fieldNorm) || [];
                var totalPlayers = bunkMeta[block.bunk]?.size || 0;
                for (var ei = 0; ei < entries.length; ei++) {
                    var e = entries[ei];
                    if (e.bunk === block.bunk) continue;
                    if (e.endMin <= block.startTime || e.startMin >= block.endTime) continue;
                    totalPlayers += (bunkMeta[e.bunk]?.size || 0);
                }
                var pCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(asgn.pick._activity, totalPlayers, false);
                if (pCheck && !pCheck.valid) {
                    analysis.playerViolations.push({
                        blockIdx: i,
                        bunk: block.bunk,
                        activity: asgn.pick._activity,
                        players: totalPlayers,
                        severity: pCheck.severity
                    });
                    analysis.score += (pCheck.severity === 'hard' ? 8000 : 2000);
                }
            }

            // Rotation quality score
            if (actNorm && actNorm !== 'free') {
                analysis.score += Math.min(asgn.cost || 0, 50000);
            }
        }

        console.log('[SOLVER-v13] 📊 Pass ' + passNum + ' Analysis: ' +
                    analysis.totalFree + ' Free, ' +
                    analysis.yesterdayRepeats.length + ' yesterday repeats, ' +
                    analysis.playerViolations.length + ' player violations, ' +
                    'Score: ' + analysis.score);

        return analysis;
    }

    // ========================================================================
    // ★★★ v13.0: ADJUST PLAN FROM ANALYSIS ★★★
    // ========================================================================

    function adjustPlanFromAnalysis(activityBlocks, analysis) {
        if (!analysis) return;

        // 1. Bunks that were Free → boost their priority for ALL activities
        for (var fi = 0; fi < analysis.freeBlocks.length; fi++) {
            var fb = analysis.freeBlocks[fi];
            // Add debt so these bunks get priority in next pass
            for (var ci = 0; ci < allCandidateOptions.length; ci++) {
                var c = allCandidateOptions[ci];
                if (!c.activityName || c.activityName === 'Free') continue;
                var dKey = fb.bunk + '|' + c.activityName;
                var existing = _activityDebt.get(dKey) || 0;
                _activityDebt.set(dKey, existing - 5000);  // Big boost
            }
        }

        // 2. Yesterday repeats → increase penalty for that activity for that bunk
        for (var yi = 0; yi < analysis.yesterdayRepeats.length; yi++) {
            var yr = analysis.yesterdayRepeats[yi];
            var yrKey = yr.bunk + '|' + yr.activity;
            var yrExisting = _activityDebt.get(yrKey) || 0;
            _activityDebt.set(yrKey, yrExisting + 10000);  // Penalize repeating
        }

        // 3. Player violations → remove those activity+bunk combos from plan
        for (var pvi = 0; pvi < analysis.playerViolations.length; pvi++) {
            var pv = analysis.playerViolations[pvi];
            if (pv.severity === 'hard') {
                var pvKey = pv.bunk + '|' + pv.activity;
                _activityDebt.set(pvKey, (_activityDebt.get(pvKey) || 0) + 20000);
            }
        }

        console.log('[SOLVER-v13] 🔧 Plan adjusted: ' + _activityDebt.size + ' debt entries after analysis');
    }

    // ========================================================================
    // ★★★ v12.0 P1: FUSED DOMAIN + SLOT GROUP BUILD ★★★
    // Replaces: buildCompatibilityMatrix + buildSlotGroups + initializeDomains
    // ONE pass builds everything: domains, slot groups, and validates candidates.
    // ========================================================================

    function buildDomainsAndSlotGroups(activityBlocks) {
        var numBlocks = activityBlocks.length;
        var numCands = allCandidateOptions.length;
        var domains = new Map();
        var slotGroups = new Map();
        var disabledFields = window.currentDisabledFields || globalConfig?.disabledFields || [];
        var disabledSet = new Set(disabledFields);

        // Pre-compute which candidates are globally disabled or locked
        // (These checks don't depend on the block, so do them ONCE)
        var globallyValidCands = new Uint8Array(numCands);
        for (var ci = 0; ci < numCands; ci++) {
            var cand = allCandidateOptions[ci];
            if (disabledSet.has(cand.field)) continue;

            // Activity properties must exist
            var hasFieldProps = !!activityProperties[cand.field];
            var hasActivityProps = !!activityProperties[cand.activityName];
            if (!hasFieldProps && !hasActivityProps && cand.type !== 'special') continue;

            globallyValidCands[ci] = 1;
        }

        var globallyValidCount = 0;
        for (var k = 0; k < numCands; k++) if (globallyValidCands[k]) globallyValidCount++;
        v12Log('Globally valid candidates: ' + globallyValidCount + '/' + numCands);

        for (var bi = 0; bi < numBlocks; bi++) {
            var block = activityBlocks[bi];
            block._blockIdx = bi;  // ★★★ v13.0: Tag for plan/context lookup ★★★
            var domain = new Set();
            var bunk = block.bunk;
           var blockDivName = block.divName || block.division || '';
if (!blockDivName && bunk) {
    blockDivName = getBunkDivision(bunk) || '';
    if (blockDivName) block.divName = blockDivName;
}
            var slots = block.slots || [];

            // Resolve time ranges
            var startMin = block.startTime;
            var endMin = block.endTime;
            if (startMin === undefined || endMin === undefined) {
                var divSlots = window.divisionTimes?.[blockDivName] || [];
                if (slots.length > 0 && divSlots[slots[0]]) {
                    startMin = divSlots[slots[0]].startMin;
                    var lastSlot = divSlots[slots[slots.length - 1]];
                    endMin = lastSlot ? lastSlot.endMin : (startMin + 40);
                    block.startTime = startMin;
                    block.endTime = endMin;
                }
            }
            var hasValidTimes = startMin !== undefined && endMin !== undefined;

            // Build slot group key
            var groupKey = (startMin || '?') + '-' + (endMin || '?') + '-' + blockDivName;
            if (!slotGroups.has(groupKey)) slotGroups.set(groupKey, []);
            slotGroups.get(groupKey).push(bi);

            // ★★★ FUSED: Check each candidate in ONE pass ★★★
            for (var ci2 = 0; ci2 < numCands; ci2++) {
                if (!globallyValidCands[ci2]) continue;

                var cand2 = allCandidateOptions[ci2];
                var fieldName = cand2.field;
                var fieldNorm = cand2._fieldNorm;

                // 1. Global field lock check (slot-dependent)
                if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots)) continue;

                // 2. Division preference exclusivity (use pre-computed)
                var fieldProp = _fieldPropertyMap.get(fieldName);
                if (fieldProp?.prefExclusive && fieldProp.prefList) {
                    if (fieldProp.prefList.indexOf(blockDivName) === -1) continue;
                }

                // 3. canBlockFit structural check
                var fits = window.SchedulerCoreUtils?.canBlockFit?.(
                    block, fieldName, activityProperties,
                    window.fieldUsageBySlot, cand2.activityName, false
                );
                if (fits === false) continue;

                // 4. Dynamic capacity check via time index (v12: sorted binary search)
                if (hasValidTimes) {
                    var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
                    var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);

                    // ★★★ v12.3: ALWAYS block cross-grade field sharing ★★★
                    if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                    if (sharingType === 'not_sharable') {
                        if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                    } else {
                        if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue;
                    }
                }

                // 5. Rotation check (v12: use pre-computed map)
                var rotationPenalty = getPrecomputedRotationScore(bunk, cand2.activityName);
                if (rotationPenalty === Infinity) continue;

                domain.add(ci2);
            }

            domains.set(bi, domain);
        }

        v12Log('Fused build: ' + numBlocks + ' blocks, ' + slotGroups.size + ' groups');
        return { domains: domains, slotGroups: slotGroups };
    }

    // ========================================================================
    // ★★★ v11.0/v12.0 — ARC CONSISTENCY (AC-3) ★★★
    // Propagates constraints between overlapping blocks.
    // Singletons auto-assign and cascade.
    // ========================================================================

    function propagateAC3(activityBlocks) {
        var propagated = 0;
        var autoAssigned = 0;
        var maxIterations = activityBlocks.length * 10;
        var iteration = 0;

        // Build adjacency: which blocks overlap in time?
        // ★★★ v12.0: Build from slot groups directly (no O(G²) scan) ★★★
        var overlaps = new Map();

        // Intra-group overlaps (blocks in same group always overlap)
        for (var [, groupIndices] of _slotGroups) {
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

        // Cross-group overlaps: only check groups whose times actually overlap
        // ★★★ v12.0: Sort groups by startTime, sweep to find overlaps ★★★
        var groupEntries = [];
        for (var [gKey, gIndices] of _slotGroups) {
            if (gIndices.length === 0) continue;
            var sample = activityBlocks[gIndices[0]];
            if (sample.startTime !== undefined) {
                groupEntries.push({ start: sample.startTime, end: sample.endTime, indices: gIndices });
            }
        }
        groupEntries.sort(function(a, b) { return a.start - b.start; });

        for (var gi = 0; gi < groupEntries.length; gi++) {
            var gA = groupEntries[gi];
            for (var gj = gi + 1; gj < groupEntries.length; gj++) {
                var gB = groupEntries[gj];
                if (gB.start >= gA.end) break;  // Sorted: no more overlaps possible

                for (var ai of gA.indices) {
                    for (var bi2 of gB.indices) {
                        if (!overlaps.has(ai)) overlaps.set(ai, new Set());
                        if (!overlaps.has(bi2)) overlaps.set(bi2, new Set());
                        overlaps.get(ai).add(bi2);
                        overlaps.get(bi2).add(ai);
                    }
                }
            }
        }

        // Work queue
        var queue = new Set();
        for (var qi = 0; qi < activityBlocks.length; qi++) queue.add(qi);

        while (queue.size > 0 && iteration < maxIterations) {
            iteration++;
            var bi3 = queue.values().next().value;
            queue.delete(bi3);

            if (_assignedBlocks.has(bi3)) continue;
            var domain = _domains.get(bi3);
            if (!domain || domain.size === 0) continue;

            // SINGLETON: auto-assign
            if (domain.size === 1) {
                var ci3 = domain.values().next().value;
                var block = activityBlocks[bi3];
                var cand3 = allCandidateOptions[ci3];
                var pick = clonePick(cand3);
                
                // ★★★ v12.3: Cross-grade check even for singletons ★★★
                var singletonBlocked = false;
                if (block.startTime !== undefined && block.endTime !== undefined && block.divName) {
                    if (checkCrossDivisionTimeConflict(cand3.field, block.divName, block.startTime, block.endTime, block.bunk)) {
                        singletonBlocked = true;
                    }
                }

                if (singletonBlocked) {
                    // Cross-grade conflict — assign Free instead
                    pick = { field: "Free", sport: null, _activity: "Free" };
                    _assignedBlocks.add(bi3);
                    _assignments.set(bi3, { candIdx: -1, pick: pick, cost: 100000 });
                    applyPickToSchedule(block, pick);
                } else {
                    var cost = calculatePenaltyCost(block, pick);
                    _assignedBlocks.add(bi3);
                    _assignments.set(bi3, { candIdx: ci3, pick: pick, cost: cost });
                    applyPickToSchedule(block, pick);

                    var fieldNorm = normName(pick.field);
                    if (block.startTime !== undefined && block.endTime !== undefined) {
                        var pickActNorm = normName(pick._activity);
                        addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, pickActNorm);
                        if (pickActNorm && pickActNorm !== fieldNorm) {
                            addToFieldTimeIndex(pickActNorm, block.startTime, block.endTime, block.bunk, block.divName, pickActNorm);
                        }
                    }
                    invalidateRotationCacheForBunk(block.bunk);
                }
                autoAssigned++;

                // Propagate to neighbors
                var neighbors = overlaps.get(bi3) || new Set();
                for (var ni of neighbors) {
                    if (_assignedBlocks.has(ni)) continue;
                    var nDomain = _domains.get(ni);
                    if (!nDomain) continue;

                    var nBlock = activityBlocks[ni];
                    var changed = false;

                    for (var nci of Array.from(nDomain)) {
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
            var neighbors2 = overlaps.get(bi3) || new Set();
            for (var ni2 of neighbors2) {
                if (!_assignedBlocks.has(ni2)) continue;
                var assignment = _assignments.get(ni2);
                if (!assignment) continue;

                var nBlock2 = activityBlocks[ni2];
                var changed2 = false;

                for (var ci4 of Array.from(domain)) {
                    var cand4 = allCandidateOptions[ci4];
                    if (wouldConflict(nBlock2, assignment.pick, activityBlocks[bi3], cand4)) {
                        domain.delete(ci4);
                        changed2 = true;
                        propagated++;
                    }
                }
                if (changed2) queue.add(bi3);
            }
        }

        v12Log('AC-3 complete: ' + autoAssigned + ' auto-assigned, ' + propagated + ' pruned, ' + iteration + ' iterations');
        return { autoAssigned: autoAssigned, propagated: propagated };
    }

    /**
     * Would assigning pick to block conflict with candPick for otherBlock?
     * Uses pre-computed field properties for speed.
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

        // ★★★ v12.0: Use pre-computed field properties ★★★
        var fieldProp = _fieldPropertyMap.get(assignedPick.field);
        var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(assignedPick.field);
        var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(assignedPick.field);

        var aDivName = assignedBlock.divName || '';
        var oDivName = otherBlock.divName || '';

        if (sharingType === 'not_sharable') return true;
        // ★★★ v12.3: Different grade = always conflict ★★★
        if (aDivName && oDivName && aDivName !== oDivName) return true;
        // Same grade — check capacity
        var overlapStart = Math.max(aStart, oStart);
        var overlapEnd = Math.min(aEnd, oEnd);
        var existingUsage = countSameDivisionUsage(assignedPick.field, aDivName, overlapStart, overlapEnd, otherBlock.bunk);
        return existingUsage >= capacity;
    }

    // ========================================================================
    // ★★★ v12.0 Q1: AUGMENTING PATH MATCHING ★★★
    // When a field is taken, try 1-level reassignment of the current holder.
    // ========================================================================

    function solveSlotGroups(activityBlocks) {
        var groupsSolved = 0;
        var blocksAssigned = 0;

        var sortedGroups = Array.from(_slotGroups.entries()).sort(function(a, b) {
            return a[1].length - b[1].length;  // Smallest groups first
        });

        for (var [, blockIndices] of sortedGroups) {
            var unassigned = blockIndices.filter(function(bi) { return !_assignedBlocks.has(bi); });
            if (unassigned.length === 0) continue;

            var groupAssignments = solveGroupMatchingAugmented(activityBlocks, unassigned);

            for (var ga of groupAssignments) {
                if (_assignedBlocks.has(ga.blockIdx)) continue;

                var block = activityBlocks[ga.blockIdx];
                _assignedBlocks.add(ga.blockIdx);
                _assignments.set(ga.blockIdx, { candIdx: ga.candIdx, pick: ga.pick, cost: ga.cost });

                applyPickToSchedule(block, ga.pick);

                var fieldNorm = normName(ga.pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var gaActNorm = normName(ga.pick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, gaActNorm);
                    if (gaActNorm && gaActNorm !== fieldNorm) {
                        addToFieldTimeIndex(gaActNorm, block.startTime, block.endTime, block.bunk, block.divName, gaActNorm);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);
                propagateAssignment(activityBlocks, ga.blockIdx, ga.pick);

                blocksAssigned++;
            }
            groupsSolved++;
        }

        v12Log('Slot groups: ' + groupsSolved + ' groups, ' + blocksAssigned + ' assigned');
        return blocksAssigned;
    }

    function solveGroupMatchingAugmented(activityBlocks, unassignedIndices) {
        var results = [];
        var blockOptions = [];

        // Phase 1: Score all options for all blocks
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

                // ★★★ v12.0 P5: Use scratch pick for cost evaluation ★★★
                setScratchPick(cand);
                var cost = calculatePenaltyCost(block, _scratchPick);
                if (cost < 500000) scored.push({ bi: bi, ci: ci, cost: cost });
            }

            scored.sort(function(a, b) { return a.cost - b.cost; });
            blockOptions.push({ bi: bi, options: scored, domainSize: scored.length });
        }

        // Phase 2: MRV sort (most constrained first)
        blockOptions.sort(function(a, b) { return a.domainSize - b.domainSize; });

        // Phase 3: Assign with augmenting paths
       var fieldUsageInGroup = new Map();
        var fieldDivsInGroup = new Map();
        var fieldAssignedTo = new Map();

        for (var bo of blockOptions) {
            if (_assignedBlocks.has(bo.bi)) continue;
            var block2 = activityBlocks[bo.bi];
            var assigned = false;

            for (var oi = 0; oi < bo.options.length; oi++) {
                var opt = bo.options[oi];
                var cand2 = allCandidateOptions[opt.ci];
                var fieldNorm2 = cand2._fieldNorm;
                var fieldName = cand2.field;
                var fieldProp = _fieldPropertyMap.get(fieldName);
                var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
                var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);
                var currentGroupUsage = fieldUsageInGroup.get(fieldNorm2) || 0;

                var existingUsage = 0;
                if (block2.startTime !== undefined && block2.endTime !== undefined) {
                    existingUsage = getFieldUsageFromTimeIndex(fieldNorm2, block2.startTime, block2.endTime, block2.bunk);
                }

                var canFit = false;
                if (sharingType === 'not_sharable') {
                    canFit = (existingUsage + currentGroupUsage < capacity);
                } else if (sharingType === 'same_division' || sharingType === 'custom') {
                    var crossConflict = checkCrossDivisionTimeConflict(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    // ★★★ v12.1 FIX: Also check within-group results for cross-division conflicts ★★★
                    // The time index may not contain assignments made within this group's current solve pass
                    if (!crossConflict && block2.divName) {
                        for (var gri = 0; gri < results.length; gri++) {
                            var gr = results[gri];
                            if (gr.candIdx === -1) continue;
                            if (normName(gr.pick.field) !== fieldNorm2) continue;
                            var grBlock = activityBlocks[gr.blockIdx];
                            if (grBlock.divName && grBlock.divName !== block2.divName) {
                                if (grBlock.startTime < block2.endTime && grBlock.endTime > block2.startTime) {
                                    crossConflict = { conflictingDiv: grBlock.divName, conflictingBunk: grBlock.bunk, source: 'in-group' };
                                    break;
                                }
                            }
                        }
                    }
                    if (!crossConflict) {
                        // ★★★ v12.1: Same-field bunks must play same sport ★★★
                        var actMismatch = checkSameFieldActivityMismatch(fieldName, block2.startTime, block2.endTime, cand2.activityName, block2.bunk);
                        if (!actMismatch) {
                            var candActNorm2 = normName(cand2.activityName);
                            for (var gria = 0; gria < results.length; gria++) {
                                var gra = results[gria];
                                if (gra.candIdx === -1) continue;
                                if (normName(gra.pick.field) !== fieldNorm2) continue;
                                var graBlock = activityBlocks[gra.blockIdx];
                                if (graBlock.startTime < block2.endTime && graBlock.endTime > block2.startTime) {
                                    var graActNorm = normName(gra.pick._activity);
                                    if (graActNorm && candActNorm2 && graActNorm !== candActNorm2) {
                                        actMismatch = graActNorm; break;
                                    }
                                }
                            }
                        }
                        if (actMismatch) { /* activity mismatch — can't share */ }
                        else {
                            // ★★★ v12.1 FIX: Count only same-division usage from within-group results ★★★
                            var sameDivGroupUsage = 0;
                            if (block2.divName) {
                                for (var gri2 = 0; gri2 < results.length; gri2++) {
                                    var gr2 = results[gri2];
                                    if (gr2.candIdx === -1) continue;
                                    if (normName(gr2.pick.field) !== fieldNorm2) continue;
                                    var grBlock2 = activityBlocks[gr2.blockIdx];
                                    if (grBlock2.divName === block2.divName) {
                                        if (grBlock2.startTime < block2.endTime && grBlock2.endTime > block2.startTime) {
                                            sameDivGroupUsage++;
                                        }
                                    }
                                }
                            }
                            var sameDivExisting = countSameDivisionUsage(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                            canFit = (sameDivExisting + sameDivGroupUsage < capacity);
                        }
                    }
                } else {
                    // ★★★ v12.3: type='all' also blocks cross-grade sharing ★★★
                    var crossConflictAll = checkCrossDivisionTimeConflict(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    if (!crossConflictAll && block2.divName) {
                        for (var griAll = 0; griAll < results.length; griAll++) {
                            var grAll = results[griAll];
                            if (grAll.candIdx === -1) continue;
                            if (normName(grAll.pick.field) !== fieldNorm2) continue;
                            var grBlockAll = activityBlocks[grAll.blockIdx];
                            if (grBlockAll.divName && grBlockAll.divName !== block2.divName) {
                                if (grBlockAll.startTime < block2.endTime && grBlockAll.endTime > block2.startTime) {
                                    crossConflictAll = true;
                                    break;
                                }
                            }
                        }
                    }
                    canFit = !crossConflictAll && (existingUsage + currentGroupUsage < capacity);
                }

               if (canFit) {
                    // Direct assignment
                    results.push({
                        blockIdx: bo.bi, candIdx: opt.ci,
                        pick: clonePick(cand2), cost: opt.cost
                    });
                    fieldUsageInGroup.set(fieldNorm2, currentGroupUsage + 1);
                    if (!fieldDivsInGroup.has(fieldNorm2)) fieldDivsInGroup.set(fieldNorm2, new Set());
                    fieldDivsInGroup.get(fieldNorm2).add(block2.divName || '');
                    fieldAssignedTo.set(fieldNorm2 + ':' + bo.bi, { blockIdx: bo.bi, ci: opt.ci });
                    assigned = true;
                    break;
                }

                // ★★★ v12.0 Q1: Augmenting path — try to reassign current holder ★★★
                if (sharingType === 'not_sharable' && currentGroupUsage >= capacity) {
                    _perfCounters.augmentingPathAttempts++;

                    // Find who is currently using this field in this group
                    var currentHolder = null;
                    for (var ri = results.length - 1; ri >= 0; ri--) {
                        if (normName(results[ri].pick.field) === fieldNorm2 && results[ri].candIdx !== -1) {
                            currentHolder = ri;
                            break;
                        }
                    }

                    if (currentHolder !== null) {
                        var holderResult = results[currentHolder];
                        var holderBi = holderResult.blockIdx;
                        var holderBlock = activityBlocks[holderBi];
                        var holderOptions = blockOptions.find(function(x) { return x.bi === holderBi; });

                        if (holderOptions) {
                            // Can the holder take a different field?
                            for (var altOi = 0; altOi < holderOptions.options.length; altOi++) {
                                var altOpt = holderOptions.options[altOi];
                                if (altOpt.ci === holderResult.candIdx) continue;  // Skip current assignment

                                var altCand = allCandidateOptions[altOpt.ci];
                                var altFieldNorm = altCand._fieldNorm;
                                if (altFieldNorm === fieldNorm2) continue;  // Same field, skip

                                var altGroupUsage = fieldUsageInGroup.get(altFieldNorm) || 0;
                                var altCapacity = getFieldCapacity(altCand.field);
                                var altExisting = 0;
                                if (holderBlock.startTime !== undefined) {
                                    altExisting = getFieldUsageFromTimeIndex(altFieldNorm, holderBlock.startTime, holderBlock.endTime, holderBlock.bunk);
                                }

                               if (altExisting + altGroupUsage < altCapacity) {
                                    // ★★★ v12.1: Cross-div check on augmenting path alt field ★★★
                                    var altSharingType = getSharingType(altCand.field);
                                    // ★★★ v12.3: ALL types enforce cross-grade exclusivity ★★★
                                    {
                                        var altCrossConflict = checkCrossDivisionTimeConflict(altCand.field, holderBlock.divName, holderBlock.startTime, holderBlock.endTime, holderBlock.bunk);
                                        if (altCrossConflict) continue;
                                        // Also check in-group for cross-div
                                        var altGrpDivs = fieldDivsInGroup.get(altFieldNorm);
                                        if (altGrpDivs && holderBlock.divName) {
                                            var altCrossBad = false;
                                            for (var agd of altGrpDivs) {
                                                if (agd && agd !== holderBlock.divName) { altCrossBad = true; break; }
                                            }
                                            if (altCrossBad) continue;
                                        }
                                    }
                                    // Reassign holder to alternative
                                    fieldUsageInGroup.set(fieldNorm2, (fieldUsageInGroup.get(fieldNorm2) || 1) - 1);
                                    var holderDiv = holderBlock.divName || '';
                                    if ((fieldUsageInGroup.get(fieldNorm2) || 0) === 0) {
                                        var oldSet = fieldDivsInGroup.get(fieldNorm2);
                                        if (oldSet) oldSet.delete(holderDiv);
                                    }
                                    results[currentHolder] = {
                                        blockIdx: holderBi, candIdx: altOpt.ci,
                                        pick: clonePick(altCand), cost: altOpt.cost
                                    };
                                    fieldUsageInGroup.set(altFieldNorm, altGroupUsage + 1);
                                    if (!fieldDivsInGroup.has(altFieldNorm)) fieldDivsInGroup.set(altFieldNorm, new Set());
                                    fieldDivsInGroup.get(altFieldNorm).add(holderDiv);

                                    // Now assign current block to freed field
                                    results.push({
                                        blockIdx: bo.bi, candIdx: opt.ci,
                                        pick: clonePick(cand2), cost: opt.cost
                                    });
                                    fieldUsageInGroup.set(fieldNorm2, (fieldUsageInGroup.get(fieldNorm2) || 0) + 1);
                                    if (!fieldDivsInGroup.has(fieldNorm2)) fieldDivsInGroup.set(fieldNorm2, new Set());
                                    fieldDivsInGroup.get(fieldNorm2).add(block2.divName || '');
                                    assigned = true;
                                    _perfCounters.augmentingPathSuccesses++;
                                    break;
                                }
                            }
                        }
                    }
                    if (assigned) break;
                }
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

            for (var ci of Array.from(domain)) {
                var cand = allCandidateOptions[ci];
                if (wouldConflict(block, pick, other, cand)) {
                    domain.delete(ci);
                    _perfCounters.domainPruned++;
                }
            }
        }
    }

    // ========================================================================
    // ★★★ v12.0 Q2: SMARTER BACKJUMP SOLVER ★★★
    // ========================================================================

    function backjumpSolver(activityBlocks) {
        var unassigned = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            if (!_assignedBlocks.has(i)) unassigned.push(i);
        }
        if (unassigned.length === 0) return 0;

        v12Log('Backjump solver: ' + unassigned.length + ' remaining');

        var iterations = 0;
        var MAX_ITERATIONS = 50000;
        var solved = 0;

        // MRV sort
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
                // ★★★ v12.4: Last-chance fresh scan — domain may have been over-pruned ★★★
                var lastChancePick = null;
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var lcScored = [];
                    for (var lci = 0; lci < allCandidateOptions.length; lci++) {
                        var lcCand = allCandidateOptions[lci];
                        if (!isPickStillValid(block, lcCand)) continue;
                        setScratchPick(lcCand);
                        var lcCost = calculatePenaltyCost(block, _scratchPick);
                        if (lcCost < 500000) lcScored.push({ ci: lci, cost: lcCost });
                    }
                    if (lcScored.length > 0) {
                        lcScored.sort(function(x, y) { return x.cost - y.cost; });
                        lastChancePick = clonePick(allCandidateOptions[lcScored[0].ci]);
                        v12Log('Last-chance rescue: ' + block.bunk + ' → ' + lastChancePick.field + ' (' + lastChancePick._activity + ')');
                    }
                }
                _assignedBlocks.add(bi);
                if (lastChancePick) {
                    _assignments.set(bi, { candIdx: -1, pick: lastChancePick, cost: 100000 });
                    applyPickToSchedule(block, lastChancePick);
                    invalidateRotationCacheForBunk(block.bunk);
                    _todayCache.clear();
                } else {
                    _assignments.set(bi, {
                        candIdx: -1,
                        pick: { field: "Free", sport: null, _activity: "Free" },
                        cost: 100000
                    });
                    applyPickToSchedule(block, _assignments.get(bi).pick);
                }
                continue;
            }

            // ★★★ v12.0 P5: Use scratch pick for cost evaluation ★★★
            var scored = [];
            for (var ci of domain) {
                var cand = allCandidateOptions[ci];
                if (!isPickStillValid(block, cand)) continue;

                setScratchPick(cand);
                var cost = calculatePenaltyCost(block, _scratchPick);
                if (cost < 500000) scored.push({ ci: ci, cost: cost });
            }

            scored.sort(function(a, b) { return a.cost - b.cost; });

            if (scored.length > 0) {
                var best = scored[0];
                var bestCand = allCandidateOptions[best.ci];
                var bestPick = clonePick(bestCand);

                _assignedBlocks.add(bi);
                _assignments.set(bi, { candIdx: best.ci, pick: bestPick, cost: best.cost });
                applyPickToSchedule(block, bestPick);

                var fieldNorm = normName(bestPick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var bjActNorm = normName(bestPick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, bjActNorm);
                    if (bjActNorm && bjActNorm !== fieldNorm) {
                        addToFieldTimeIndex(bjActNorm, block.startTime, block.endTime, block.bunk, block.divName, bjActNorm);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);
                propagateAssignment(activityBlocks, bi, bestPick);
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

        v12Log('Backjump: ' + solved + '/' + unassigned.length + ' solved');
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

        // ★★★ v12.0: Use pre-computed field properties ★★★
        var fieldProp = _fieldPropertyMap.get(fieldName);
        var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
        var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);

        // ★★★ v12.3: ALWAYS block cross-grade field sharing ★★★
        if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) return false;
        if (sharingType === 'not_sharable') {
            return getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) < capacity;
        }
        return countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) < capacity;
    }

    // ========================================================================
    // ★★★ v12.0 Q3: IMPROVED POST-SOLVE + SWAP CHAINS ★★★
    // ========================================================================

    function postSolveLocalSearch(activityBlocks) {
        // ★★★ v12.2 FIX: Clear stale today-activities cache before polish phase ★★★
        // Without this, getActivitiesDoneToday returns cached results from the main
        // solve pass that don't reflect pre-solver placements (split tiles, leagues, etc.)
        _todayCache.clear();
        
        var improvements = 0;
        var swapChains = 0;
        var MAX_SWAP_ATTEMPTS = 500;  // ★★★ v12.4: Increased for better fill rates ★★★
        // Pass 1: Direct improvement of Free blocks
        var freeBlocks = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var assignment = _assignments.get(i);
            if (!assignment) continue;
            var actNorm = normName(assignment.pick._activity || assignment.pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') freeBlocks.push(i);
        }

        if (freeBlocks.length === 0) {
            v12Log('Post-solve: No Free blocks to improve');
            return;
        }

        v12Log('Post-solve: ' + freeBlocks.length + ' Free blocks to improve');

        for (var bi of freeBlocks) {
            var block = activityBlocks[bi];
            var domain = _domains.get(bi);
            if (!domain) continue;

            var scored = [];
            for (var ci of domain) {
                var cand = allCandidateOptions[ci];
                if (!isPickStillValid(block, cand)) continue;

                setScratchPick(cand);
                var cost = calculatePenaltyCost(block, _scratchPick);
                if (cost < 500000) scored.push({ ci: ci, cost: cost });
            }

            if (scored.length > 0) {
                scored.sort(function(a, b) { return a.cost - b.cost; });
                var best = scored[0];
                var bestCand = allCandidateOptions[best.ci];
                var bestPick = clonePick(bestCand);

                undoPickFromSchedule(block, _assignments.get(bi).pick);
                _assignments.set(bi, { candIdx: best.ci, pick: bestPick, cost: best.cost });
                applyPickToSchedule(block, bestPick);

                var fieldNorm = normName(bestPick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var psActNorm = normName(bestPick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, psActNorm);
                    if (psActNorm && psActNorm !== fieldNorm) {
                        addToFieldTimeIndex(psActNorm, block.startTime, block.endTime, block.bunk, block.divName, psActNorm);
                    }
                }
                invalidateRotationCacheForBunk(block.bunk);
                improvements++;
            }
        }

        // Pass 2: Swap chains for remaining Free blocks (with depth limit)
        var remainingFree = [];
        for (var fi of freeBlocks) {
            var a = _assignments.get(fi);
            if (a && normName(a.pick._activity || a.pick.field) === 'free') remainingFree.push(fi);
        }

        var swapAttempts = 0;
        for (var freeIdx of remainingFree) {
            if (swapAttempts >= MAX_SWAP_ATTEMPTS) break;  // ★★★ v12.0: Early termination ★★★

            var freeBlock = activityBlocks[freeIdx];
            var freeDomain = _domains.get(freeIdx);
            if (!freeDomain || freeDomain.size === 0) continue;

            var swapped = false;
            for (var ci2 of freeDomain) {
                if (swapped || swapAttempts >= MAX_SWAP_ATTEMPTS) break;
                swapAttempts++;

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

                        setScratchPick(altCand);
                        var altCost = calculatePenaltyCost(blockerBlock, _scratchPick);
                        if (altCost < 500000) altScored.push({ ci: altCi, cost: altCost });
                    }

                    if (altScored.length > 0) {
                        altScored.sort(function(x, y) { return x.cost - y.cost; });
                        var altBest = altScored[0];
                        var altBestCand = allCandidateOptions[altBest.ci];

                        // ★★★ v12.2 FIX: Check for same-day duplicate BEFORE swapping ★★★
                        _todayCache.clear(); // Ensure fresh check
                        var wantedActNorm = normName(wantedCand.activityName);
                        if (wantedActNorm && wantedActNorm !== 'free' && wantedActNorm !== 'free play') {
                            var freeSlot = freeBlock.slots ? freeBlock.slots[0] : 999;
                            var todayForFree = getActivitiesDoneToday(freeBlock.bunk, freeSlot);
                            if (todayForFree.has(wantedActNorm)) continue; // Skip — would create duplicate
                        }

                        // ★★★ v12.3: Check blocker's new field for cross-grade conflict ★★★
                        if (blockerBlock.startTime !== undefined && blockerBlock.divName &&
                            checkCrossDivisionTimeConflict(altBestCand.field, blockerBlock.divName, blockerBlock.startTime, blockerBlock.endTime, blockerBlock.bunk)) {
                            continue; // Skip this swap — blocker's alt field has cross-grade conflict
                        }

                        // Execute swap
                        undoPickFromSchedule(blockerBlock, _assignments.get(blockerIdx).pick);
                        var altPick = clonePick(altBestCand);
                        _assignments.set(blockerIdx, { candIdx: altBest.ci, pick: altPick, cost: altBest.cost });
                        applyPickToSchedule(blockerBlock, altPick);

                        undoPickFromSchedule(freeBlock, _assignments.get(freeIdx).pick);
                        var wantedPick = clonePick(wantedCand);
                        _todayCache.clear(); // ★★★ v12.2: Fresh check after blocker moved ★★★
                        var wantedCost = calculatePenaltyCost(freeBlock, wantedPick);
                        _assignments.set(freeIdx, { candIdx: ci2, pick: wantedPick, cost: wantedCost });
                        applyPickToSchedule(freeBlock, wantedPick);
                        // ★★★ v12.2 FIX: Invalidate caches after swap ★★★
                        invalidateRotationCacheForBunk(blockerBlock.bunk);
                        invalidateRotationCacheForBunk(freeBlock.bunk);
                        _todayCache.clear();

                        swapChains++;
                        swapped = true;
                    }
                }
            }
        }

        v12Log('Post-solve: ' + improvements + ' direct + ' + swapChains + ' swaps (' + swapAttempts + ' attempts)');
    }

    function findBlockIdx(activityBlocks, bunk, startMin, endMin) {
        for (var i = 0; i < activityBlocks.length; i++) {
            if (activityBlocks[i].bunk === bunk &&
                activityBlocks[i].startTime === startMin &&
                activityBlocks[i].endTime === endMin) {
                return i;
            }
        }
        return -1;
    }

    // ========================================================================
    // SCHEDULE APPLY / UNDO
    // ========================================================================

    function applyPickToSchedule(block, pick) {
        var bunk = block.bunk;
        var slots = block.slots || [];
        if (!window.scheduleAssignments[bunk]) return;

        var fName = pick.field;
        for (var i = 0; i < slots.length; i++) {
            window.scheduleAssignments[bunk][slots[i]] = {
                field: fName,
                sport: pick.sport,
                continuation: i > 0,
                _fixed: false,
                _activity: pick._activity || fName,
                _fromSplitTile: block.fromSplitTile || false,
                _startMin: block.startTime,
                _endMin: block.endTime
            };

            // Track field usage
            if (window.fieldUsageBySlot && window.fieldUsageBySlot[slots[i]]) {
                if (!window.fieldUsageBySlot[slots[i]][fName]) {
                    window.fieldUsageBySlot[slots[i]][fName] = { count: 0, bunks: {} };
                }
                window.fieldUsageBySlot[slots[i]][fName].count++;
                window.fieldUsageBySlot[slots[i]][fName].bunks[bunk] = pick.sport || pick._activity;
            }
        }
    }

    function undoPickFromSchedule(block, pick) {
        var bunk = block.bunk;
        var slots = block.slots || [];
        if (!window.scheduleAssignments[bunk]) return;

        var fieldName = pick ? pick.field : null;

        for (var i = 0; i < slots.length; i++) {
            var slotIdx2 = slots[i];
            window.scheduleAssignments[bunk][slotIdx2] = null;

            if (fieldName && window.fieldUsageBySlot && window.fieldUsageBySlot[slotIdx2] && window.fieldUsageBySlot[slotIdx2][fieldName]) {
                var usage = window.fieldUsageBySlot[slotIdx2][fieldName];
                if (usage.bunks) delete usage.bunks[bunk];
                if (usage.count > 0) usage.count--;
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
    // ★★★ v12.4: DEEP FREE RESOLUTION — "Human-Like" Resource Planning ★★★
    // ========================================================================
    // After the main solver + polish, any remaining Free blocks get one more
    // shot. This mimics a human scheduler looking at the board and saying:
    //    "Wait, there are open fields — why is this bunk sitting Free?"
    //    
    // Phase 1: Fresh direct assignment (re-scan ALL candidates, current state)
    // Phase 2: Displacement — move a same-div bunk to its alternative to
    //          free up a field for the Free bunk
    // ========================================================================
    function deepFreeResolution(activityBlocks) {
        _todayCache.clear();
        // Find all Free blocks
        var freeIndices = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var asgn = _assignments.get(i);
            if (!asgn) continue;
            var an = normName(asgn.pick._activity || asgn.pick.field);
            if (an === 'free' || an === 'free (timeout)') freeIndices.push(i);
        }
        if (freeIndices.length === 0) return 0;
        console.log('[SOLVER-v12.4] 🧠 Deep Free Resolution: ' + freeIndices.length + ' Free blocks');
        // Sort: divisions with MORE free blocks first (they need the most help)
        var divFree = {};
        for (var fi of freeIndices) {
            var dn = activityBlocks[fi].divName || '';
            divFree[dn] = (divFree[dn] || 0) + 1;
        }
        freeIndices.sort(function(a, b) {
            var cA = divFree[activityBlocks[a].divName || ''] || 0;
            var cB = divFree[activityBlocks[b].divName || ''] || 0;
            return cB - cA;
        });
        var resolved = 0;
        var disabledSet = window.currentDisabledFields || globalConfig?.disabledFields || [];
        for (var idx = 0; idx < freeIndices.length; idx++) {
            var bi = freeIndices[idx];
            var block = activityBlocks[bi];
            var bunk = block.bunk;
            var blockDiv = block.divName || '';
            var startMin = block.startTime;
            var endMin = block.endTime;
            var slots = block.slots || [];
            if (startMin === undefined || endMin === undefined) continue;
            // ═══ PHASE 1: Fresh candidate scan ═══
            _todayCache.clear();
            var fresh = [];
            for (var ci = 0; ci < allCandidateOptions.length; ci++) {
                var cand = allCandidateOptions[ci];
                if (disabledSet.indexOf(cand.field) !== -1) continue;
                if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) continue;
                // Cross-division: no sharing across grades
                if (checkCrossDivisionTimeConflict(cand.field, blockDiv, startMin, endMin, bunk)) continue;
                // Capacity check
                var fp = _fieldPropertyMap.get(cand.field);
                var cap = fp ? fp.capacity : getFieldCapacity(cand.field);
                var sType = fp ? fp.sharingType : getSharingType(cand.field);
                if (sType === 'not_sharable') {
                    if (getFieldUsageFromTimeIndex(cand._fieldNorm, startMin, endMin, bunk) >= cap) continue;
                } else {
                    if (countSameDivisionUsage(cand.field, blockDiv, startMin, endMin, bunk) >= cap) continue;
                }
                // Same-day duplicate
                var today = getActivitiesDoneToday(bunk, slots[0] ?? 999);
                var candAct = normName(cand.activityName);
                if (candAct && candAct !== 'free' && candAct !== 'free play' && today.has(candAct)) continue;
                // Activity props exist
                if (!activityProperties[cand.field] && !activityProperties[cand.activityName] && cand.type !== 'special') continue;
                // canBlockFit
                if (window.SchedulerCoreUtils?.canBlockFit) {
                    if (!window.SchedulerCoreUtils.canBlockFit(block, cand.field, activityProperties, null, cand.activityName, false)) continue;
                }
                setScratchPick(cand);
                var cost = calculatePenaltyCost(block, _scratchPick);
                if (cost < 500000) fresh.push({ ci: ci, cost: cost });
            }
            if (fresh.length > 0) {
                fresh.sort(function(a, b) { return a.cost - b.cost; });
                var pick = clonePick(allCandidateOptions[fresh[0].ci]);
                undoPickFromSchedule(block, _assignments.get(bi).pick);
                _assignments.set(bi, { candIdx: fresh[0].ci, pick: pick, cost: fresh[0].cost });
                applyPickToSchedule(block, pick);
                // Update time index
                var pfn = normName(pick.field);
                addToFieldTimeIndex(pfn, startMin, endMin, bunk, blockDiv, normName(pick._activity));
                var pan = normName(pick._activity);
                if (pan && pan !== pfn) addToFieldTimeIndex(pan, startMin, endMin, bunk, blockDiv, pan);
                invalidateRotationCacheForBunk(bunk);
                _todayCache.clear();
                resolved++;
                console.log('[SOLVER-v12.4]    ✅ ' + bunk + ' → ' + pick.field + ' (' + pick._activity + ')');
                continue;
            }
            // ═══ PHASE 2: Displacement chain ═══
            // Find a same-division bunk that is using a field. If THEY can move
            // to an alternative, WE might be able to use what they free up.
            var displaced = false;
            for (var otherBi = 0; otherBi < activityBlocks.length; otherBi++) {
                if (displaced) break;
                if (otherBi === bi) continue;
                var otherBlock = activityBlocks[otherBi];
                if (otherBlock.divName !== blockDiv) continue;
                if (otherBlock.bunk === bunk) continue;
                if (otherBlock.startTime === undefined || otherBlock.endTime === undefined) continue;
                if (otherBlock.startTime >= endMin || otherBlock.endTime <= startMin) continue;
                var otherAsgn = _assignments.get(otherBi);
                if (!otherAsgn) continue;
                if (normName(otherAsgn.pick._activity) === 'free') continue;
                // Would their activity create a same-day dup for us?
                _todayCache.clear();
                var ourToday = getActivitiesDoneToday(bunk, slots[0] ?? 999);
                if (ourToday.has(normName(otherAsgn.pick._activity))) continue;
                // Can THEY move to something else?
                var otherDom = _domains.get(otherBi);
                if (!otherDom || otherDom.size === 0) continue;
                var curFieldNorm = normName(otherAsgn.pick.field);
                var alts = [];
                for (var altCi of otherDom) {
                    var altC = allCandidateOptions[altCi];
                    if (normName(altC.field) === curFieldNorm) continue;
                    if (!isPickStillValid(otherBlock, altC)) continue;
                    // Cross-div check on alt
                    if (checkCrossDivisionTimeConflict(altC.field, otherBlock.divName, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk)) continue;
                    // Same-day dup check for them
                    _todayCache.clear();
                    var theirToday = getActivitiesDoneToday(otherBlock.bunk, otherBlock.slots?.[0] ?? 999);
                    var altAct = normName(altC.activityName);
                    if (altAct && altAct !== 'free' && theirToday.has(altAct)) continue;
                    setScratchPick(altC);
                    var altCost = calculatePenaltyCost(otherBlock, _scratchPick);
                    if (altCost < 500000) alts.push({ ci: altCi, cost: altCost, cand: altC });
                }
                if (alts.length === 0) continue;
                alts.sort(function(a, b) { return a.cost - b.cost; });
                // Save state in case we need to undo
                var saved = { candIdx: otherAsgn.candIdx, pick: otherAsgn.pick, cost: otherAsgn.cost };
                // Move them
                undoPickFromSchedule(otherBlock, otherAsgn.pick);
                var altPick = clonePick(alts[0].cand);
                _assignments.set(otherBi, { candIdx: alts[0].ci, pick: altPick, cost: alts[0].cost });
                applyPickToSchedule(otherBlock, altPick);
                // Update time index for the swap
                var altFn = normName(altPick.field);
                addToFieldTimeIndex(altFn, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk, otherBlock.divName, normName(altPick._activity));
                removeFromFieldTimeIndex(curFieldNorm, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk);
                invalidateRotationCacheForBunk(otherBlock.bunk);
                _todayCache.clear();
                // Now re-check: can WE get something?
                var postFresh = [];
                for (var pci = 0; pci < allCandidateOptions.length; pci++) {
                    var pC = allCandidateOptions[pci];
                    if (disabledSet.indexOf(pC.field) !== -1) continue;
                    if (window.GlobalFieldLocks?.isFieldLocked(pC.field, slots)) continue;
                    if (checkCrossDivisionTimeConflict(pC.field, blockDiv, startMin, endMin, bunk)) continue;
                    var pfp = _fieldPropertyMap.get(pC.field);
                    var pCap = pfp ? pfp.capacity : getFieldCapacity(pC.field);
                    var pSt = pfp ? pfp.sharingType : getSharingType(pC.field);
                    if (pSt === 'not_sharable') {
                        if (getFieldUsageFromTimeIndex(pC._fieldNorm, startMin, endMin, bunk) >= pCap) continue;
                    } else {
                        if (countSameDivisionUsage(pC.field, blockDiv, startMin, endMin, bunk) >= pCap) continue;
                    }
                    var pToday = getActivitiesDoneToday(bunk, slots[0] ?? 999);
                    var pAct = normName(pC.activityName);
                    if (pAct && pAct !== 'free' && pAct !== 'free play' && pToday.has(pAct)) continue;
                    if (!activityProperties[pC.field] && !activityProperties[pC.activityName] && pC.type !== 'special') continue;
                    setScratchPick(pC);
                    var pCost = calculatePenaltyCost(block, _scratchPick);
                    if (pCost < 500000) postFresh.push({ ci: pci, cost: pCost });
                }
                if (postFresh.length > 0) {
                    postFresh.sort(function(a, b) { return a.cost - b.cost; });
                    var ourPick = clonePick(allCandidateOptions[postFresh[0].ci]);
                    undoPickFromSchedule(block, _assignments.get(bi).pick);
                    _assignments.set(bi, { candIdx: postFresh[0].ci, pick: ourPick, cost: postFresh[0].cost });
                    applyPickToSchedule(block, ourPick);
                    var ourFn = normName(ourPick.field);
                    addToFieldTimeIndex(ourFn, startMin, endMin, bunk, blockDiv, normName(ourPick._activity));
                    var ourAn = normName(ourPick._activity);
                    if (ourAn && ourAn !== ourFn) addToFieldTimeIndex(ourAn, startMin, endMin, bunk, blockDiv, ourAn);
                    invalidateRotationCacheForBunk(bunk);
                    _todayCache.clear();
                    resolved++;
                    displaced = true;
                    console.log('[SOLVER-v12.4]    🔄 ' + bunk + ' → ' + ourPick.field + ' [displaced ' + otherBlock.bunk + ' → ' + altPick.field + ']');
                } else {
                    // Undo — didn't help
                    undoPickFromSchedule(otherBlock, altPick);
                    removeFromFieldTimeIndex(altFn, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk);
                    _assignments.set(otherBi, saved);
                    applyPickToSchedule(otherBlock, saved.pick);
                    addToFieldTimeIndex(curFieldNorm, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk, otherBlock.divName, normName(saved.pick._activity));
                    invalidateRotationCacheForBunk(otherBlock.bunk);
                    _todayCache.clear();
                }
            }
            if (!displaced) {
                console.log('[SOLVER-v12.4]    ❌ ' + bunk + ' @ ' + startMin + '-' + endMin + ' — no available fields');
            }
        }
        console.log('[SOLVER-v12.4] 🧠 Complete: ' + resolved + '/' + freeIndices.length + ' resolved');
        return resolved;
    }

    // ========================================================================
    // ★★★ v13.0: INTERNAL SOLVE PASS (runs one full pipeline iteration) ★★★
    // ========================================================================

    function runSolvePass(activityBlocks, config, passNum, isShadow) {
        _passNumber = passNum;

        // Reset per-pass state (but NOT debt — that accumulates across passes)
        _rotationScoreCache.clear();
        _todayCache.clear();
        _assignedBlocks.clear();
        _assignments.clear();
        _domains = null;
        _slotGroups = null;
        _activityPlan.clear();
        _scarcityMap.clear();
        _perfCounters = {
            rotationCacheHits: 0, rotationCacheMisses: 0,
            timeIndexQueries: 0, domainPruned: 0,
            augmentingPathAttempts: 0, augmentingPathSuccesses: 0
        };

        // If shadow pass, save schedule state so we can restore it
        var savedSchedule = null;
        var savedFieldUsage = null;
        if (isShadow) {
            savedSchedule = JSON.parse(JSON.stringify(window.scheduleAssignments || {}));
            savedFieldUsage = JSON.parse(JSON.stringify(window.fieldUsageBySlot || {}));
        }

        // Clear any previous pass assignments from schedule
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi];
            if (window.scheduleAssignments?.[blk.bunk]) {
                for (var si = 0; si < (blk.slots || []).length; si++) {
                    var slotIdx = blk.slots[si];
                    var existing = window.scheduleAssignments[blk.bunk][slotIdx];
                    if (existing && !existing._fixed && !existing._bunkOverride) {
                        window.scheduleAssignments[blk.bunk][slotIdx] = null;
                        // Clean field usage
                        if (existing.field && window.fieldUsageBySlot?.[slotIdx]?.[existing.field]) {
                            var fu = window.fieldUsageBySlot[slotIdx][existing.field];
                            if (fu.bunks) delete fu.bunks[blk.bunk];
                            if (fu.count > 0) fu.count--;
                        }
                    }
                }
            }
        }

        var passLabel = isShadow ? '✏️ PENCIL' : '🖊️ INK';
        console.log('\n[SOLVER-v13] ═══ PASS ' + passNum + ' (' + passLabel + ') ═══');

        // ═══ Rebuild time index (reflects current schedule state) ═══
        buildFieldTimeIndex();

        // ═══ Rebuild rotation scores ═══
        precomputeRotationScores(activityBlocks);

        // ═══ Step 5.5: Activity-First Planner ═══
        var t55 = performance.now();
        activityFirstPlanner(activityBlocks);
        console.log('[SOLVER-v13] Step 5.5: Activity-First Planner (' + (performance.now() - t55).toFixed(1) + 'ms)');

        // ═══ Build domains + slot groups ═══
        var fusedResult = buildDomainsAndSlotGroups(activityBlocks);
        _domains = fusedResult.domains;
        _slotGroups = fusedResult.slotGroups;

        // ═══ AC-3 ═══
        var ac3Result = propagateAC3(activityBlocks);

        // ═══ Augmenting path matching ═══
        var matchedCount = solveSlotGroups(activityBlocks);

        // ═══ Backjump ═══
        var remaining = activityBlocks.length - _assignedBlocks.size;
        if (remaining > 0) {
            backjumpSolver(activityBlocks);
        }

        // ═══ Post-solve polish ═══
        postSolveLocalSearch(activityBlocks);

        // ═══ Deep Free Resolution ═══
        deepFreeResolution(activityBlocks);

        // ═══ Analyze this pass ═══
        var analysis = analyzePassResult(activityBlocks, passNum);

        // If shadow pass, restore original schedule state
        if (isShadow) {
            // Undo all assignments from this pass
            for (var ubi = 0; ubi < activityBlocks.length; ubi++) {
                var uBlk = activityBlocks[ubi];
                if (window.scheduleAssignments?.[uBlk.bunk]) {
                    for (var usi = 0; usi < (uBlk.slots || []).length; usi++) {
                        window.scheduleAssignments[uBlk.bunk][uBlk.slots[usi]] = null;
                    }
                }
            }
            // Restore saved state
            window.scheduleAssignments = savedSchedule;
            window.fieldUsageBySlot = savedFieldUsage;
            // Rebuild time index from restored state
            buildFieldTimeIndex();
        }

        return analysis;
    }

    // ========================================================================
    // ★★★ v13.0: MAIN SOLVER PIPELINE ★★★
    // ========================================================================

    Solver.solveSchedule = function (allBlocks, config) {
        var solveStartTime = performance.now();

        globalConfig = config;
        activityProperties = config.activityProperties || {};

        // ═══ RESET ═══
        clearAllCaches();
        clearBunkDivisionCache();
        _activityDebt.clear();  // Fresh debt for this solve

        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!globalConfig.rotationHistory) globalConfig.rotationHistory = {};
        if (!globalConfig.rotationHistory.leagues) globalConfig.rotationHistory.leagues = {};

        var sorted = Solver.sortBlocksByDifficulty(allBlocks, config);
        var activityBlocks = sorted.filter(function(b) { return !b._isLeague; });

        if (window.RotationEngine?.clearHistoryCache) {
            window.RotationEngine.clearHistoryCache();
        }

        console.log('\n[SOLVER] ★★★ v13.0 — HUMAN-INTELLIGENT THREE-PASS SOLVER ★★★');
        console.log('[SOLVER] Pipeline: ResourceMaps → [ActivityPlan → Domains → AC-3 → AugMatch → Backjump → Polish] × 3');
        console.log('[SOLVER] ' + activityBlocks.length + ' activity blocks to solve');

        // ═══ STEP 1: Build candidate options ONCE ═══
        var t1 = performance.now();
        allCandidateOptions = buildAllCandidateOptions(config);
        console.log('[SOLVER] Step 1: ' + allCandidateOptions.length + ' candidates (' + (performance.now() - t1).toFixed(1) + 'ms)');

        // ═══ STEP 2: Build initial time index ═══
        var t2 = performance.now();
        buildFieldTimeIndex();
        console.log('[SOLVER] Step 2: Field time index (' + (performance.now() - t2).toFixed(1) + 'ms)');

        // ═══ STEP 3: Pre-compute field properties ═══
        var t3 = performance.now();
        precomputeFieldProperties();
        console.log('[SOLVER] Step 3: Field properties (' + _fieldPropertyMap.size + ' fields) (' + (performance.now() - t3).toFixed(1) + 'ms)');

        // ═══ STEP 4: Pre-compute initial rotation scores ═══
        var t4 = performance.now();
        precomputeRotationScores(activityBlocks);
        console.log('[SOLVER] Step 4: Rotation scores (' + _rotationScoreMap.size + ' pairs) (' + (performance.now() - t4).toFixed(1) + 'ms)');

        // ═══ STEP 4.5: Precompute resource maps (once) ═══
        var t45 = performance.now();
        precomputeResourceMaps(activityBlocks);
        console.log('[SOLVER] Step 4.5: Resource maps (' + (performance.now() - t45).toFixed(1) + 'ms)');

        // ═══════════════════════════════════════════════════════════════
        // THREE-PASS PIPELINE
        // Pass 1: Pencil (silent simulation)
        // Pass 2: Ink attempt (if Pass 1 had issues, use lessons learned)
        // Pass 3: Final ink (if Pass 2 still has issues, one more try)
        // ═══════════════════════════════════════════════════════════════

        var MAX_PASSES = 3;
        var bestAnalysis = null;
        var passAnalyses = [];

        for (var passNum = 1; passNum <= MAX_PASSES; passNum++) {
            var isShadow = (passNum < MAX_PASSES); // Last pass is always ink
            var isPencil = (passNum === 1);

            // For pass 2+, check if we even need another pass
            if (passNum > 1 && bestAnalysis && bestAnalysis.totalFree === 0 &&
                bestAnalysis.yesterdayRepeats.length === 0 &&
                bestAnalysis.playerViolations.filter(function(v) { return v.severity === 'hard'; }).length === 0) {
                console.log('[SOLVER-v13] ✨ Pass ' + (passNum - 1) + ' was perfect — committing!');
                break;
            }

            // If this is pass 2+, adjust plan based on previous analysis
            if (passNum > 1 && bestAnalysis) {
                adjustPlanFromAnalysis(activityBlocks, bestAnalysis);
            }

            // On the LAST pass, always commit (not shadow)
            if (passNum === MAX_PASSES) isShadow = false;

            var analysis = runSolvePass(activityBlocks, config, passNum, isShadow);
            passAnalyses.push(analysis);

            // Track best result
            if (!bestAnalysis || analysis.score < bestAnalysis.score) {
                bestAnalysis = analysis;
            }

            // If shadow pass was perfect, run one more as ink to commit
            if (isShadow && analysis.totalFree === 0 &&
                analysis.yesterdayRepeats.length === 0 &&
                analysis.playerViolations.filter(function(v) { return v.severity === 'hard'; }).length === 0) {
                console.log('[SOLVER-v13] ✨ Pass ' + passNum + ' simulation was perfect — committing as ink...');
                // Run final ink pass
                runSolvePass(activityBlocks, config, passNum + 1, false);
                passNum = MAX_PASSES; // Exit loop
            }
        }

        // ═══ REPORT ═══
        var solveTime = performance.now() - solveStartTime;
        var freeCount = 0;
        for (var [, ref] of _assignments) {
            var actNorm2 = normName(ref.pick._activity || ref.pick.field);
            if (actNorm2 === 'free' || actNorm2 === 'free (timeout)') freeCount++;
        }

        console.log('\n[SOLVER] ══════════════════════════════════════════');
        console.log('[SOLVER] ✅ v13.0 SOLVE COMPLETE: ' + solveTime.toFixed(0) + 'ms (' + passAnalyses.length + ' passes)');
        console.log('[SOLVER]    ' + activityBlocks.length + ' blocks, ' + freeCount + ' Free');
        for (var pai = 0; pai < passAnalyses.length; pai++) {
            var pa = passAnalyses[pai];
            console.log('[SOLVER]    Pass ' + pa.passNumber + ': Score=' + pa.score + ', Free=' + pa.totalFree +
                        ', YdayRepeats=' + pa.yesterdayRepeats.length + ', PlayerViolations=' + pa.playerViolations.length);
        }
        console.log('[SOLVER]    Activity plan: ' + _activityPlan.size + ' blocks steered');
        console.log('[SOLVER]    Scarcity map: ' + _scarcityMap.size + ' scarce resources');
        console.log('[SOLVER]    Small bunks: ' + _smallBunkFlags.size + ' detected');
        console.log('[SOLVER]    Time-constrained: ' + _timeConstrainedBoost.size + ' activities boosted');
        console.log('[SOLVER]    Unique resources: ' + Array.from(_uniqueFieldMap.entries()).filter(function(e) { return e[1] === 1; }).length + ' single-field activities protected');
        console.log('[SOLVER] ══════════════════════════════════════════\n');

        // ═══ STEP 10: Cross-Division Safety Sweep ★★★ v12.1 BACKSTOP ★★★ ═══
        var crossDivFixes = 0;
        var fieldTimeUsage = new Map();
        for (var sbi = 0; sbi < activityBlocks.length; sbi++) {
            var sBlock = activityBlocks[sbi];
            var sAssign = _assignments.get(sbi);
            if (!sAssign || !sBlock.divName) continue;
            var sFieldNorm = normName(sAssign.pick.field);
            if (sFieldNorm === 'free') continue;
            var sStart = sBlock.startTime;
            var sEnd = sBlock.endTime;
            if (sStart === undefined || sEnd === undefined) continue;
            var sKey = sFieldNorm + ':' + sStart + '-' + sEnd;
            if (!fieldTimeUsage.has(sKey)) fieldTimeUsage.set(sKey, []);
            var sActName = normName(sAssign.pick._activity || sAssign.pick.sport || sAssign.pick.field);
            fieldTimeUsage.get(sKey).push({ bi: sbi, div: sBlock.divName, bunk: sBlock.bunk, act: sActName });
        }
        for (var [ftKey, ftUsers] of fieldTimeUsage) {
            if (ftUsers.length < 2) continue;
            // ★★★ v12.1: Check same-activity constraint (bunks sharing must play same sport) ★★★
            var ftActivities = new Set();
            for (var ftai = 0; ftai < ftUsers.length; ftai++) {
                var ftAssign = _assignments.get(ftUsers[ftai].bi);
                if (ftAssign) {
                    var ftAct = normName(ftAssign.pick._activity || ftAssign.pick.sport || ftAssign.pick.field);
                    if (ftAct && ftAct !== 'free') ftActivities.add(ftAct);
                }
            }
            if (ftActivities.size > 1) {
                // Multiple different activities on same field at same time — remove extras
                var keepAct = ftActivities.values().next().value;
                for (var ftmi = 0; ftmi < ftUsers.length; ftmi++) {
                    var ftmAssign = _assignments.get(ftUsers[ftmi].bi);
                    if (!ftmAssign) continue;
                    var ftmAct = normName(ftmAssign.pick._activity || ftmAssign.pick.sport || ftmAssign.pick.field);
                    if (ftmAct && ftmAct !== 'free' && ftmAct !== keepAct) {
                        var mBlock = activityBlocks[ftUsers[ftmi].bi];
                        undoPickFromSchedule(mBlock, _assignments.get(ftUsers[ftmi].bi).pick);
                        _assignments.set(ftUsers[ftmi].bi, {
                            candIdx: -1,
                            pick: { field: "Free", sport: null, _activity: "Free" },
                            cost: 100000
                        });
                        applyPickToSchedule(mBlock, _assignments.get(ftUsers[ftmi].bi).pick);
                        console.warn('[SOLVER] ⚠️ ACTIVITY-MISMATCH FIX: Removed ' + ftmAct + ' from ' + ftUsers[ftmi].bunk + ' on ' + ftKey.split(':')[0] + ' — conflicts with ' + keepAct);
                        crossDivFixes++;
                    }
                }
            }
            var ftDivs = new Set(ftUsers.map(function(u) { return u.div; }));
            if (ftDivs.size <= 1) continue;
            var ftFieldName = ftKey.split(':')[0];
            var ftSharingType = getSharingType(ftFieldName);
            // ★★★ v12.3: ALL types enforce cross-grade exclusivity ★★★
            if (ftSharingType === 'all' || ftSharingType === 'same_division' || ftSharingType === 'not_sharable' || ftSharingType === 'custom') {
                var keepDiv = ftUsers[0].div;
                for (var fti = 1; fti < ftUsers.length; fti++) {
                    if (ftUsers[fti].div !== keepDiv) {
                        var violator = ftUsers[fti];
                        var vBlock = activityBlocks[violator.bi];
                        undoPickFromSchedule(vBlock, _assignments.get(violator.bi).pick);
                        _assignments.set(violator.bi, {
                            candIdx: -1,
                            pick: { field: "Free", sport: null, _activity: "Free" },
                            cost: 100000
                        });
                        applyPickToSchedule(vBlock, _assignments.get(violator.bi).pick);
                        console.warn('[SOLVER] ⚠️ CROSS-DIV FIX: Removed ' + ftFieldName + ' from ' + violator.bunk + ' (Div ' + violator.div + ') — conflicts with Div ' + keepDiv);
                        crossDivFixes++;
                    }
                }
            }
        }
        if (crossDivFixes > 0) {
            console.warn('[SOLVER] ★★★ Fixed ' + crossDivFixes + ' cross-division violations ★★★');
        }

        // ═══ FORMAT OUTPUT ═══
        var results = [];
        for (var idx = 0; idx < activityBlocks.length; idx++) {
            var blk = activityBlocks[idx];
            var assignmentResult = _assignments.get(idx);
            var solution = assignmentResult
                ? assignmentResult.pick
                : { field: "Free", sport: null, _activity: "Free" };

            results.push({
                block: blk,
                pick: solution,
                bunk: blk.bunk,
                slots: blk.slots,
                divName: blk.divName,
                cost: assignmentResult?.cost ?? 100000
            });
        }

        return results;
    };

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
                // ★★★ v12.3: ALWAYS block cross-grade field sharing ★★★
                if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                if (sharingType === 'not_sharable') {
                    if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue;
                } else {
                    if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue;
                }
            }

            var hasFieldProps = !!activityProperties[cand.field];
            var hasActivityProps = !!activityProperties[cand.activityName];
            if (!hasFieldProps && !hasActivityProps && cand.type !== 'special') continue;

            var rotationPenalty = getPrecomputedRotationScore(bunk, cand.activityName);
            if (rotationPenalty === Infinity) continue;

            var fits = window.SchedulerCoreUtils?.canBlockFit?.(
                block, cand.field, activityProperties,
                window.fieldUsageBySlot, cand.activityName, false
            );
            if (!fits) continue;

            var pick = clonePick(cand);
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
            var tpActNorm = normName(pick._activity);
            addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, tpActNorm);
            if (tpActNorm && tpActNorm !== fieldNorm) {
                addToFieldTimeIndex(tpActNorm, block.startTime, block.endTime, block.bunk, block.divName, tpActNorm);
            }
        }
        invalidateRotationCacheForBunk(block.bunk);
        return { block: block, pick: pick, bunk: block.bunk, startMin: block.startTime };
    };

    Solver.undoTentativePick = function (res) {
        undoPickFromSchedule(res.block, res.pick);
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
    // DEBUG UTILITIES
    // ========================================================================

    Solver.debugCrossDivision = function(fieldName, divName, slotIdx) {
        var divSlots = window.divisionTimes?.[divName] || [];
        var slot = divSlots[slotIdx];
        if (!slot) { console.log('Slot not found'); return; }

        console.log('\n🔍 Cross-Division Check: "' + fieldName + '" at Div ' + divName + ' Slot ' + slotIdx);
        console.log('    Time: ' + slot.startMin + '-' + slot.endMin);

        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm) || [];
        console.log('    Time index entries: ' + entries.length);
        entries.forEach(function(e) {
            if (e.startMin < slot.endMin && e.endMin > slot.startMin) {
                console.log('    ⚠️ OVERLAP: Div ' + e.divName + ' Bunk ' + e.bunk + ' (' + e.startMin + '-' + e.endMin + ')');
            }
        });
    };

    Solver.debugSolverStats = function() {
        console.log('\n=== SOLVER v13.0 STATS ===');
        console.log('Normalized names:       ' + _normalizedNames.size);
        console.log('Rotation score map:     ' + _rotationScoreMap.size);
        console.log('Rotation score cache: ' + _rotationScoreCache.size);
        console.log('Field property map:     ' + _fieldPropertyMap.size);
        console.log('Today activity cache: ' + _todayCache.size);
        console.log('Field time index:       ' + _fieldTimeIndex.size + ' fields');
        var totalEntries = 0;
        for (var entries of _fieldTimeIndex.values()) totalEntries += entries.length;
        console.log('  Total time entries: ' + totalEntries);
        console.log('Assigned blocks:         ' + _assignedBlocks.size);
        console.log('Active assignments:      ' + _assignments.size);
        if (_slotGroups) console.log('Slot groups:           ' + _slotGroups.size);
        if (_domains) {
            var avg = _domains.size > 0
                ? (Array.from(_domains.values()).reduce(function(s, d) { return s + d.size; }, 0) / _domains.size).toFixed(1)
                : '0';
            console.log('Avg domain size:         ' + avg);
        }
        console.log('\nPerf Counters:');
        console.log('  Rotation cache hits:  ' + _perfCounters.rotationCacheHits);
        console.log('  Rotation cache misses:' + _perfCounters.rotationCacheMisses);
        console.log('  Time index queries:     ' + _perfCounters.timeIndexQueries);
        console.log('  Domain pruned:          ' + _perfCounters.domainPruned);
        console.log('  Aug path attempts:      ' + _perfCounters.augmentingPathAttempts);
        console.log('  Aug path successes:     ' + _perfCounters.augmentingPathSuccesses);
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
    // EXPOSE
    // ========================================================================

    window.totalSolverEngine = Solver;
    window.TotalSolver = Solver;

})();
