// ============================================================================
// total_solver_engine.js (ULTIMATE v12.3 - HYPER-OPTIMIZED CONSTRAINT SOLVER)
// ============================================================================
// ★★★ v12.3: STRICT CROSS-GRADE EXCLUSIVITY — ALL FIELD TYPES ★★★
//
// WHAT'S NEW IN v12.3 (over v12.1):
// ──────────────────────────────────
// QUALITY:
//  Q1. STRICT CROSS-GRADE EXCLUSIVITY:
//      - Now enforced on ALL field types (including 'all').
//      - If a field is used by Grade 1, Grade 2 cannot use it, even if
//        the field type is 'all' or 'custom'.
//      - Logic applied universally in:
//        * Domain building
//        * Cost evaluation
//        * AC-3 propagation
//        * Augmenting path matching
//        * Safety backstop
//
// WHAT'S NEW IN v12.1 (over v12.0):
// ──────────────────────────────────
// QUALITY:
//  Q1. SAME-FIELD ACTIVITY CONSISTENCY:
//      - Enforces that if multiple bunks share a field (e.g. sharing type 'all'
//        or 'same_division'), they MUST be doing the same activity/sport.
//      - Adds 'activityName' to the high-performance Time Index.
//      - Adds live checks during candidate filtering and augmenting path matching.
//      - Adds a final backstop safety sweep to catch and fix any activity mismatches.
//
// PERFORMANCE:
//  P1. FUSED DOMAIN INITIALIZATION — compat matrix + domain init merged into
//      ONE pass. Eliminates the entire buildCompatibilityMatrix step and its
//      O(N×C) redundant iteration. Domains built directly with ALL checks.
//  P2. PRE-COMPUTED FIELD PROPERTY MAP — capacity, sharing type, and division
//      preferences cached in a Map ONCE. Eliminates repeated property chain
//      lookups in every hot path.
//  P3. BATCHED ROTATION SCORING — rotation scores pre-computed per bunk×activity
//      ONCE before domain init.
//  P4. SORTED TIME INDEX — field time entries sorted by startMin for binary
//      search on overlap queries.
//  P5. REUSABLE SCRATCH OBJECTS — pick objects reused during cost evaluation.
//
// DIAGNOSTICS:
//  D1. ALL LOGGING GATED — debug, rotation, cross-div, and v12 logging
//      controlled by flags. Zero console overhead in production.
//
// SOLVING PIPELINE (v12.3):
//   1. buildAllCandidateOptions()        — master activity list (once)
//   2. buildFieldTimeIndex()             — sorted time-indexed field usage (w/ Activity Name)
//   3. precomputeFieldProperties()       — capacity + sharing type map
//   4. precomputeRotationScores()        — bunk×activity score map
//   5. buildDomainsAndSlotGroups()       — FUSED domain + group build
//   6. propagateAC3()                    — arc consistency
//   7. solveSlotGroups()                 — augmenting path matching (w/ Activity Checks)
//   8. backjumpSolver()                  — resolve remaining
//   9. postSolveLocalSearch()            — polish + swap chains
//   10. Cross-Division & Activity Sweep  — final safety check
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
    let _fieldPropertyMap = new Map();     // fieldName → { capacity, sharingType, prefList, prefExclusive }
    let _rotationScoreMap = new Map();     // "bunk|activity" → score
    let _bunkDivisionCache = new Map();    // bunk → divName

    // Domain-based structures
    let _domains = null;          // Map<blockIdx, Set<candIdx>>
    let _slotGroups = null;       // Map<timeKey, blockIdx[]>
    let _assignedBlocks = new Set();
    let _assignments = new Map(); // blockIdx → { candIdx, pick, cost }

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
        return lo;  // Upper bound — scan from 0 to lo-1
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
            if (e.endMin > startMin) count++;  // startMin < endMin is guaranteed by upperBound
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
                        beforeSlotIndex: 0,  // Slot-independent for batch
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

    function getPrecomputedRotationScore(bunk, activityName) {
        if (!activityName || activityName === 'Free') return 0;
        var key = bunk + '|' + activityName;
        var cached = _rotationScoreMap.get(key);
        if (cached !== undefined) {
            _perfCounters.rotationCacheHits++;
            return cached;
        }
        _perfCounters.rotationCacheMisses++;

        // Fallback: compute on demand
        return getCachedRotationPenalty_fallback(bunk, activityName);
    }

    function getCachedRotationPenalty_fallback(bunk, activityName) {
        if (!activityName || activityName === 'Free') return 0;
        var key = bunk + '|' + activityName;
        var cached = _rotationScoreCache.get(key);
        if (cached !== undefined) return cached;

        var score;
        if (window.RotationEngine?.calculateRotationScore) {
            score = window.RotationEngine.calculateRotationScore({
                bunkName: bunk,
                activityName: activityName,
                divisionName: getBunkDivision(bunk),
                beforeSlotIndex: 999,
                allActivities: null,
                activityProperties: activityProperties
            });
        } else {
            var todayActivities = getActivitiesDoneToday(bunk, 999);
            if (todayActivities.has(normName(activityName))) {
                score = Infinity;
            } else {
                score = 0;
            }
        }

        _rotationScoreCache.set(key, score);
        _rotationScoreMap.set(key, score);
        return score;
    }

  function invalidateRotationCacheForBunk(bunk) {
        // Invalidate all entries for this bunk
        for (var [key] of _rotationScoreCache) {
            if (key.startsWith(bunk + '|')) _rotationScoreCache.delete(key);
        }
        for (var [key2] of _rotationScoreMap) {
            if (key2.startsWith(bunk + '|')) _rotationScoreMap.delete(key2);
        }
        // ★★★ v12.1 FIX: Cache keys are "bunk:slotIdx", not just "bunk" ★★★
        for (var [key3] of _todayCache) {
            if (key3.startsWith(bunk + ':')) _todayCache.delete(key3);
        }
    }

    // ========================================================================
    // TODAY ACTIVITIES CACHE
    // ========================================================================

    function getActivitiesDoneToday(bunk, beforeSlotIndex) {
        var cacheKey = bunk + ':' + beforeSlotIndex;
        var cached = _todayCache.get(cacheKey);
        if (cached) return cached;

        var activities = new Set();
        var assignments = window.scheduleAssignments?.[bunk] || [];
        for (var i = 0; i < Math.min(beforeSlotIndex, assignments.length); i++) {
            var entry = assignments[i];
            if (!entry || entry.continuation) continue;
            var act = normName(entry._activity || entry.sport || entry.field);
            if (act && act !== 'free' && act !== 'free play') activities.add(act);
        }
        _todayCache.set(cacheKey, activities);
        return activities;
    }

    function getDaysSinceActivity(bunk, activityName) {
        if (window.RotationEngine?.getDaysSinceActivity) {
            return window.RotationEngine.getDaysSinceActivity(bunk, activityName, 0);
        }
        return null;
    }

    function getActivityCount(bunk, activityName) {
        if (window.RotationEngine?.getActivityCount) {
            return window.RotationEngine.getActivityCount(bunk, activityName);
        }
        var globalSettings = window.loadGlobalSettings?.() || {};
        var historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        var manualOffsets = globalSettings.manualUsageOffsets || {};
        var baseCount = historicalCounts[bunk]?.[activityName] || 0;
        var offset = manualOffsets[bunk]?.[activityName] || 0;
        return Math.max(0, baseCount + offset);
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

    // ★★★ v12.1: LIVE type-balance check for General Activity Slot fairness ★★★
    function getLiveTypeBalance(bunk, beforeSlot) {
        var todayDone = getActivitiesDoneToday(bunk, beforeSlot);
        var sports = 0;
        var specials = 0;
        todayDone.forEach(function(act) {
            if (window.RotationEngine?.isSpecialActivity?.(act)) {
                specials++;
            } else if (act !== 'free' && act !== 'free play' && act !== 'lunch' &&
                       act !== 'snacks' && act !== 'swim' && act !== 'dismissal') {
                sports++;
            }
        });
        return { sports: sports, specials: specials };
    }

    // ★★★ v12.1: LIVE type-balance check for General Activity Slot fairness ★★★
    function isSpecialCandidate(cand) {
        return cand && (cand.type === 'special' || cand._type === 'special');
    }

    function buildAllCandidateOptions(config) {
        var options = [];
        var seenKeys = new Set();
        var disabledFields = window.currentDisabledFields || config.disabledFields || [];
        var disabledSet = new Set(disabledFields);

        config.masterFields?.forEach(function(f) {
            if (disabledSet.has(f.name)) return;
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
            if (!s.name || disabledSet.has(s.name)) return;
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
                if (disabledSet.has(fieldName)) return;
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
    // ★★★ v12.0 P5: REUSABLE SCRATCH PICK for cost evaluation ★★★
    // ========================================================================

    var _scratchPick = { field: '', sport: null, _activity: '', _type: '' };

    function setScratchPick(cand) {
        _scratchPick.field = cand.field;
        _scratchPick.sport = cand.sport;
        _scratchPick._activity = cand.activityName;
        _scratchPick._type = cand.type;
        return _scratchPick;
    }

    function clonePick(cand) {
        return {
            field: cand.field, sport: cand.sport,
            _activity: cand.activityName, _type: cand.type
        };
    }

   // ========================================================================
    // PENALTY ENGINE (uses pre-computed lookups)
    // ========================================================================

    function calculatePenaltyCost(block, pick) {
        var bunk = block.bunk;
        var act = pick._activity;
        var fieldName = pick.field;
        var actNorm = normName(act);
        var fieldNorm = normName(fieldName);
        var blockDivName = block.divName || '';
        var blockStart = block.startTime;
        var blockEnd = block.endTime;
        var slots = block.slots || [];
        var penalty = 0;

        // =================================================================
        // HARD CONSTRAINTS (return 999999 = impossible)
        // =================================================================

        // ── 1. Same-day activity duplicate ───────────────────────────────
        // Pre-computed rotation scores used beforeSlotIndex=0 so they miss
        // same-day duplicates. Check LIVE schedule state.
        if (actNorm && actNorm !== 'free' && actNorm !== 'free play') {
            var todayDone = getActivitiesDoneToday(bunk, slots[0] ?? 999);
            if (todayDone.has(actNorm)) return 999999;
        }

        // ── 2. Field capacity & cross-division sharing ───────────────────
        // Domains from Step 5 go stale as Steps 6-8 assign blocks.
        // Check the LIVE field time index for every assignment attempt.
        if (fieldName && fieldName !== 'Free' &&
            blockDivName && blockStart !== undefined && blockEnd !== undefined) {

            var fp = _fieldPropertyMap.get(fieldName);
            var sType = fp ? fp.sharingType : getSharingType(fieldName);
            var cap = fp ? fp.capacity : getFieldCapacity(fieldName);

            // ★★★ v12.3: ALWAYS block cross-grade field sharing ★★★
            if (checkCrossDivisionTimeConflict(fieldName, blockDivName, blockStart, blockEnd, bunk)) return 999999;
            if (checkSameFieldActivityMismatch(fieldName, blockStart, blockEnd, act, bunk)) return 999999;
            if (sType === 'not_sharable') {
                if (getFieldUsageFromTimeIndex(fieldNorm, blockStart, blockEnd, bunk) >= cap) return 999999;
            } else {
                if (countSameDivisionUsage(fieldName, blockDivName, blockStart, blockEnd, bunk) >= cap) return 999999;
            }
        }

        // ── 3. Division preference exclusivity ───────────────────────────
        var fieldProp = _fieldPropertyMap.get(fieldName);
        if (fieldProp?.prefList) {
            if (fieldProp.prefList.indexOf(blockDivName) === -1 && fieldProp.prefExclusive) return 999999;
        } else {
            var actPrefProps = activityProperties[act];
            if (actPrefProps?.preferences?.enabled &&
                (actPrefProps.preferences.list || []).indexOf(blockDivName) === -1 &&
                actPrefProps.preferences.exclusive) return 999999;
        }

        // ── 4. Rotation score (recency / streak / variety) ──────────────
        var rotationPenalty = getPrecomputedRotationScore(bunk, act);
        if (rotationPenalty === Infinity) return 999999;

        // ── 5. Max lifetime usage ────────────────────────────────────────
        var specialRule = activityProperties[act];
        if (specialRule?.maxUsage > 0) {
            var hist = getActivityCount(bunk, act);
            var todayCount = getActivitiesDoneToday(bunk, slots[0] || 999).has(actNorm) ? 1 : 0;
            if (hist + todayCount >= specialRule.maxUsage) return 999999;
        }

        // =================================================================
        // SOFT PENALTIES (lower = better, scored additively)
        // =================================================================

        // ── Rotation score ───────────────────────────────────────────────
        penalty += rotationPenalty;

        // ── ★★★ v12.1: Live sport/special type balance for General Activity Slots ★★★
        // Without this, sports dominate due to having more field×activity combinations.
        if (block.event === 'General Activity Slot' || block.event === 'general activity slot') {
            var typeBalance = getLiveTypeBalance(bunk, slots[0] ?? 0);
            var pickIsSpecial = (pick._type === 'special');
            var imbalance = typeBalance.sports - typeBalance.specials;

            if (!pickIsSpecial && imbalance >= 2) {
                // Already 2+ more sports than specials — strong penalty on more sports
                penalty += 3000 + (imbalance - 1) * 1000;
            } else if (!pickIsSpecial && imbalance >= 1) {
                // 1 more sport than special — moderate penalty
                penalty += 1500;
            } else if (pickIsSpecial && imbalance >= 2) {
                // Specials behind by 2+ — strong bonus for picking special
                penalty -= 2000;
            } else if (pickIsSpecial && imbalance >= 1) {
                // Specials behind by 1 — moderate bonus
                penalty -= 1000;
            } else if (pickIsSpecial && typeBalance.specials > typeBalance.sports + 1) {
                // Too many specials already — gentle penalty
                penalty += 1500;
            }
        }
        // ── Bunk size vs field capacity ──────────────────────────────────
        var bunkMeta = window.getBunkMetaData?.(bunk) || globalConfig?.bunkMetaData?.[bunk] || {};
        if (bunkMeta.size) {
            var apCap = activityProperties[fieldName]?.capacity;
            if (apCap && bunkMeta.size > apCap) penalty += 5000;
        }

        // ── Division preferences (soft bonus) ────────────────────────────
        if (fieldProp?.prefList) {
            var prefIdx = fieldProp.prefList.indexOf(blockDivName);
            if (prefIdx !== -1) {
                penalty -= (50 - prefIdx * 5);
            } else {
                penalty += 8000;
            }
        } else {
            var actPrefProps2 = activityProperties[act];
            if (actPrefProps2?.preferences?.enabled) {
                var prefIdx2 = (actPrefProps2.preferences.list || []).indexOf(blockDivName);
                if (prefIdx2 !== -1) {
                    penalty -= (50 - prefIdx2 * 5);
                } else {
                    penalty += 8000;
                }
            }
        }

        // ── Adjacent bunk bonus ──────────────────────────────────────────
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

        // ── Tie-breaking randomness ──────────────────────────────────────
        penalty += Math.random() * (ROTATION_CONFIG.TIE_BREAKER_RANDOMNESS || 300);

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
                _assignedBlocks.add(bi);
                _assignments.set(bi, {
                    candIdx: -1,
                    pick: { field: "Free", sport: null, _activity: "Free" },
                    cost: 100000
                });
                applyPickToSchedule(block, _assignments.get(bi).pick);
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
        var MAX_SWAP_ATTEMPTS = 200;  // ★★★ v12.0: Prevent exponential search ★★★
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
    // ★★★ v12.0: MAIN SOLVER PIPELINE ★★★
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

        console.log('\n[SOLVER] ★★★ HYPER-OPTIMIZED v12.1 — FUSED CONSTRAINT SOLVER ★★★');
        console.log('[SOLVER] Pipeline: FieldProps → RotScores → FusedDomains → AC-3 → AugMatch → Backjump → Polish');
        console.log('[SOLVER] ' + activityBlocks.length + ' activity blocks to solve');

        // ═══ STEP 1: Build candidate options ONCE ═══
        var t1 = performance.now();
        allCandidateOptions = buildAllCandidateOptions(config);
        console.log('[SOLVER] Step 1: ' + allCandidateOptions.length + ' candidates (' + (performance.now() - t1).toFixed(1) + 'ms)');

        // ═══ STEP 2: Build sorted time-indexed field map ═══
        var t2 = performance.now();
        buildFieldTimeIndex();
        console.log('[SOLVER] Step 2: Field time index (sorted) (' + (performance.now() - t2).toFixed(1) + 'ms)');

        // ═══ STEP 3: Pre-compute field properties ★NEW★ ═══
        var t3 = performance.now();
        precomputeFieldProperties();
        console.log('[SOLVER] Step 3: Field properties (' + _fieldPropertyMap.size + ' fields) (' + (performance.now() - t3).toFixed(1) + 'ms)');

        // ═══ STEP 4: Pre-compute rotation scores ★NEW★ ═══
        var t4 = performance.now();
        precomputeRotationScores(activityBlocks);
        console.log('[SOLVER] Step 4: Rotation scores (' + _rotationScoreMap.size + ' pairs) (' + (performance.now() - t4).toFixed(1) + 'ms)');

        // ═══ STEP 5: Fused Domain + Slot Group Build ★REPLACES Steps 3-5 of v11★ ═══
        var t5 = performance.now();
        var fusedResult = buildDomainsAndSlotGroups(activityBlocks);
        _domains = fusedResult.domains;
        _slotGroups = fusedResult.slotGroups;
        var avgDomain = _domains.size > 0
            ? (Array.from(_domains.values()).reduce(function(s, d) { return s + d.size; }, 0) / _domains.size).toFixed(1)
            : '0';
        console.log('[SOLVER] Step 5: Fused domains+groups (' + _slotGroups.size + ' groups, avg domain ' + avgDomain + ') (' + (performance.now() - t5).toFixed(1) + 'ms)');

        // ═══ STEP 6: AC-3 Constraint Propagation ═══
        var t6 = performance.now();
        var ac3Result = propagateAC3(activityBlocks);
        console.log('[SOLVER] Step 6: AC-3 — ' + ac3Result.autoAssigned + ' auto-assigned, ' + ac3Result.propagated + ' pruned (' + (performance.now() - t6).toFixed(1) + 'ms)');

        // ═══ STEP 7: Augmenting Path Matching ★IMPROVED★ ═══
        var t7 = performance.now();
        var matchedCount = solveSlotGroups(activityBlocks);
        console.log('[SOLVER] Step 7: AugMatch ' + matchedCount + ' (total: ' + _assignedBlocks.size + '/' + activityBlocks.length + ') (' + (performance.now() - t7).toFixed(1) + 'ms)');

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
        for (var [, ref] of _assignments) {
            var actNorm2 = normName(ref.pick._activity || ref.pick.field);
            if (actNorm2 === 'free' || actNorm2 === 'free (timeout)') freeCount++;
        }

        console.log('\n[SOLVER] ══════════════════════════════════════════');
        console.log('[SOLVER] ✅ v12.1 SOLVE COMPLETE: ' + solveTime.toFixed(0) + 'ms');
        console.log('[SOLVER]    ' + activityBlocks.length + ' blocks, ' + freeCount + ' Free');
        console.log('[SOLVER]    AC-3: ' + ac3Result.autoAssigned + ' | AugMatch: ' + matchedCount + ' | Backjump: ' + (activityBlocks.length - ac3Result.autoAssigned - matchedCount));
        if (_perfCounters.augmentingPathAttempts > 0) {
            console.log('[SOLVER]    Augmenting paths: ' + _perfCounters.augmentingPathSuccesses + '/' + _perfCounters.augmentingPathAttempts + ' successful');
        }
        console.log('[SOLVER]    Rotation cache: ' + _perfCounters.rotationCacheHits + ' hits, ' + _perfCounters.rotationCacheMisses + ' misses');
        console.log('[SOLVER]    Time index queries: ' + _perfCounters.timeIndexQueries + ', domain pruned: ' + _perfCounters.domainPruned);
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
        console.log('\n=== SOLVER v12.1 STATS ===');
        console.log('Normalized names:      ' + _normalizedNames.size);
        console.log('Rotation score map:    ' + _rotationScoreMap.size);
        console.log('Rotation score cache: ' + _rotationScoreCache.size);
        console.log('Field property map:    ' + _fieldPropertyMap.size);
        console.log('Today activity cache: ' + _todayCache.size);
        console.log('Field time index:      ' + _fieldTimeIndex.size + ' fields');
        var totalEntries = 0;
        for (var entries of _fieldTimeIndex.values()) totalEntries += entries.length;
        console.log('  Total time entries: ' + totalEntries);
        console.log('Assigned blocks:        ' + _assignedBlocks.size);
        console.log('Active assignments:     ' + _assignments.size);
        if (_slotGroups) console.log('Slot groups:          ' + _slotGroups.size);
        if (_domains) {
            var avg = _domains.size > 0
                ? (Array.from(_domains.values()).reduce(function(s, d) { return s + d.size; }, 0) / _domains.size).toFixed(1)
                : '0';
            console.log('Avg domain size:        ' + avg);
        }
        console.log('\nPerf Counters:');
        console.log('  Rotation cache hits:  ' + _perfCounters.rotationCacheHits);
        console.log('  Rotation cache misses:' + _perfCounters.rotationCacheMisses);
        console.log('  Time index queries:    ' + _perfCounters.timeIndexQueries);
        console.log('  Domain pruned:         ' + _perfCounters.domainPruned);
        console.log('  Aug path attempts:     ' + _perfCounters.augmentingPathAttempts);
        console.log('  Aug path successes:    ' + _perfCounters.augmentingPathSuccesses);
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
