// ============================================================================
// total_solver_engine.js (ULTIMATE v13.0 - HUMAN-INTELLIGENT SCHEDULING)
// ============================================================================
// ★★★ v13.0: ACTIVITY-FIRST PLANNER + THREE-PASS SIMULATION ★★★
// ★★★ v12.4: SCARCITY-AWARE SORTING + DEEP FREE RESOLUTION ★★★
// ★★★ v12.3: STRICT CROSS-GRADE EXCLUSIVITY — ALL FIELD TYPES ★★★
//
// SOLVING PIPELINE (v13.0):
//   1. buildAllCandidateOptions()        — master activity list (once)
//   2. buildFieldTimeIndex()             — sorted time-indexed field usage
//   3. precomputeFieldProperties()       — capacity + sharing type map
//   4. precomputeRotationScores()        — bunk×activity score map
//   4.5 precomputeResourceMaps()         — unique fields, time constraints, small bunks
//   === THREE-PASS LOOP ===
//   5.5 activityFirstPlanner()           — wish lists → allocation → domain steering
//   5. buildDomainsAndSlotGroups()       — FUSED domain + group build
//   6. propagateAC3()                    — arc consistency
//   7. solveSlotGroups()                 — augmenting path matching
//   8. backjumpSolver()                  — resolve remaining
//   9. postSolveLocalSearch()            — polish + swap chains
//   9.5 deepFreeResolution()             — displacement chains
//   === ANALYSIS → ADJUST → NEXT PASS ===
//   10. Cross-Division & Activity Sweep  — final safety check
// ============================================================================

(function () {
    'use strict';

    const Solver = {};
    const MAX_MATCHUP_ITERATIONS = 2000;

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

    let _fieldPropertyMap = new Map();
    let _rotationScoreMap = new Map();
    let _bunkDivisionCache = new Map();

    let _domains = null;
    let _slotGroups = null;
    let _assignedBlocks = new Set();
    let _assignments = new Map();

    // ★★★ v13.0: Activity-First Planner state ★★★
    let _activityPlan = new Map();
    let _activityDebt = new Map();
    let _scarcityMap = new Map();
    let _uniqueFieldMap = new Map();
    let _timeConstrainedBoost = new Map();
    let _skeletonContext = new Map();
    let _smallBunkFlags = new Set();
    let _passNumber = 0;
    let _passAnalysis = null;

    let _perfCounters = {
        rotationCacheHits: 0, rotationCacheMisses: 0,
        timeIndexQueries: 0, domainPruned: 0,
        augmentingPathAttempts: 0, augmentingPathSuccesses: 0
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
        _activityPlan.clear();
        _scarcityMap.clear();
        _skeletonContext.clear();
        _perfCounters = {
            rotationCacheHits: 0, rotationCacheMisses: 0,
            timeIndexQueries: 0, domainPruned: 0,
            augmentingPathAttempts: 0, augmentingPathSuccesses: 0
        };
    }

    // ========================================================================
    // LOGGING HELPERS
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
    // ROTATION CONFIG
    // ========================================================================

    const ROTATION_CONFIG = new Proxy({}, {
        get: function(target, prop) {
            if (window.RotationEngine?.CONFIG?.[prop] !== undefined) {
                return window.RotationEngine.CONFIG[prop];
            }
            var defaults = {
                YESTERDAY_PENALTY: 12000, TWO_DAYS_AGO_PENALTY: 8000,
                THREE_DAYS_AGO_PENALTY: 5000, SAME_DAY_PENALTY: Infinity,
                TIE_BREAKER_RANDOMNESS: 300, ADJACENT_BUNK_BONUS: -150, NEARBY_BUNK_BONUS: -100
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

    function clearBunkDivisionCache() { _bunkDivisionCache.clear(); }

    function getBunkNumber(bunkName) {
        if (!bunkName) return null;
        var m = String(bunkName).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // ========================================================================
    // PRE-COMPUTED FIELD PROPERTY MAP
    // ========================================================================

    function precomputeFieldProperties() {
        _fieldPropertyMap.clear();
        var props = activityProperties || {};
        var _storedFieldProps = {};
        try {
            var gs = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            var storedFields = gs.fields || gs.app1?.fields || [];
            for (var fi = 0; fi < storedFields.length; fi++) {
                var sf = storedFields[fi];
                if (sf && sf.name) _storedFieldProps[sf.name] = sf;
            }
        } catch(e) {}

        for (var i = 0; i < allCandidateOptions.length; i++) {
            var cand = allCandidateOptions[i];
            var fieldName = cand.field;
            if (_fieldPropertyMap.has(fieldName)) continue;
            var fieldProps = props[fieldName] || _storedFieldProps[fieldName] || {};
            if (!fieldProps.sharableWith && !fieldProps.sharable && _storedFieldProps[fieldName]) {
                fieldProps = _storedFieldProps[fieldName];
            }
            var capacity = 1, sharingType = 'not_sharable', prefList = null, prefExclusive = false;
            if (fieldProps.sharableWith) {
                var sw = fieldProps.sharableWith;
                if (sw.type === 'not_sharable') { capacity = 1; sharingType = 'not_sharable'; }
                else if (sw.type === 'all') { capacity = parseInt(sw.capacity) || 999; sharingType = 'all'; }
                else if (sw.type === 'same_division') { capacity = parseInt(sw.capacity) || 2; sharingType = 'same_division'; }
                else if (sw.type === 'custom') { capacity = parseInt(sw.capacity) || 2; sharingType = 'custom'; }
                else if (sw.capacity) { capacity = parseInt(sw.capacity); sharingType = 'same_division'; }
                else { capacity = 2; sharingType = 'same_division'; }
            } else if (fieldProps.sharable) { capacity = 2; sharingType = 'same_division'; }
            var prefProps = fieldProps;
            if (!prefProps?.preferences?.enabled) {
                var actProps = props[cand.activityName];
                if (actProps?.preferences?.enabled) prefProps = actProps;
            }
            if (prefProps?.preferences?.enabled) {
                prefList = prefProps.preferences.list || [];
                prefExclusive = !!prefProps.preferences.exclusive;
            }
            _fieldPropertyMap.set(fieldName, { capacity: capacity, sharingType: sharingType, prefList: prefList, prefExclusive: prefExclusive, hasProps: true });
        }
        v12Log('Field properties pre-computed: ' + _fieldPropertyMap.size + ' fields');
    }

    function getFieldCapacity(fieldName) {
        var cached = _fieldPropertyMap.get(fieldName);
        if (cached) return cached.capacity;
        if (window.SchedulerCoreUtils?.getFieldCapacity) return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
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
    // SORTED TIME INDEX
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
                    var fieldLabel = normName(window.SchedulerCoreUtils?.fieldLabel?.(entry.field) || '');
                    var entryActivityNorm = normName(entry._activity || entry.sport || entry.field);
                    var names = new Set([fieldNorm, actNorm, fieldLabel].filter(function(n) { return n; }));
                    for (var name of names) {
                        addToFieldTimeIndex(name, slot.startMin, slot.endMin, bunk, divName, entryActivityNorm);
                    }
                }
            }
        }
        for (var [key, entries] of _fieldTimeIndex) {
            entries.sort(function(a, b) { return a.startMin - b.startMin; });
        }
        v12Log('Field time index built: ' + _fieldTimeIndex.size + ' entries (sorted)');
    }

    function addToFieldTimeIndex(fieldNorm, startMin, endMin, bunk, divName, activityName) {
        if (!_fieldTimeIndex.has(fieldNorm)) _fieldTimeIndex.set(fieldNorm, []);
        var entries = _fieldTimeIndex.get(fieldNorm);
        entries.push({ startMin: startMin, endMin: endMin, bunk: bunk, divName: divName, activityName: activityName || '' });
        if (entries.length > 1 && entries[entries.length - 1].startMin < entries[entries.length - 2].startMin) {
            entries.sort(function(a, b) { return a.startMin - b.startMin; });
        }
    }

    function removeFromFieldTimeIndex(fieldNorm, startMin, endMin, bunk) {
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries) return;
        var idx = entries.findIndex(function(e) { return e.bunk === bunk && e.startMin === startMin && e.endMin === endMin; });
        if (idx !== -1) entries.splice(idx, 1);
    }

    function findFirstOverlapIndex(entries, queryStart, queryEnd) {
        var lo = 0, hi = entries.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (entries[mid].startMin >= queryEnd) hi = mid;
            else lo = mid + 1;
        }
        return lo;
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
            if (e.endMin > startMin) count++;
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
                return { conflictingDiv: e.divName, conflictingBunk: e.bunk, theirTime: e.startMin + '-' + e.endMin, ourTime: startMin + '-' + endMin, overlapTime: Math.max(startMin, e.startMin) + '-' + Math.min(endMin, e.endMin) };
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
            if (e.activityName && e.activityName !== actNorm) return e.activityName;
        }
        return null;
    }
// ========================================================================
    // ★★★ TIME-BASED GLOBAL FIELD LOCK CHECK (Cross-Division Safe) ★★★
    // ========================================================================
    // GlobalFieldLocks uses slot INDICES which are division-specific.
    // A league locking Field B at DivA slot [5] won't block DivB slot [3]
    // even if they overlap in wall-clock time. This helper checks by TIME.
    // ========================================================================

    function isFieldLockedByTime(fieldName, startMin, endMin, divisionContext) {
        var GFL = window.GlobalFieldLocks;
        if (!GFL || !GFL._initialized || !GFL._locks) return false;
        if (!fieldName || startMin == null || endMin == null) return false;

        // Use the dedicated method if available (from patched global_field_locks.js)
        if (GFL.isFieldLockedByTime) {
            return !!GFL.isFieldLockedByTime(fieldName, startMin, endMin, divisionContext);
        }

        // Inline fallback: scan all lock slots for time-based overlap
        var normalizedField = fieldName.toLowerCase().trim();

        for (var slotIdx in GFL._locks) {
            var slotLocks = GFL._locks[slotIdx];
            if (!slotLocks || !slotLocks[normalizedField]) continue;

            var lock = slotLocks[normalizedField];

            // Skip division locks where caller IS the allowed division
            if (lock.lockType === 'division' && lock.allowedDivision) {
                if (divisionContext && divisionContext === lock.allowedDivision) continue;
            }

            // Get the lock's actual time range
            var lockStartMin = lock.startMin;
            var lockEndMin = lock.endMin;

            // If lock doesn't have explicit times, derive from the lock's division slots
            if (lockStartMin == null || lockEndMin == null) {
                var lockDiv = lock.division;
                if (lockDiv) {
                    var firstDiv = lockDiv.split(',')[0].trim();
                    var divSlots = window.divisionTimes?.[firstDiv] || [];
                    var slot = divSlots[parseInt(slotIdx, 10)];
                    if (slot) {
                        lockStartMin = slot.startMin;
                        lockEndMin = slot.endMin;
                    }
                }
            }

            // Can't determine time — skip
            if (lockStartMin == null || lockEndMin == null) continue;

            // Check TIME OVERLAP
            if (lockStartMin < endMin && lockEndMin > startMin) {
                return true;
            }
        }

        return false;
    }
    // ========================================================================
    // BATCHED ROTATION SCORING
    // ========================================================================

    function precomputeRotationScores(activityBlocks) {
        _rotationScoreMap.clear();
        var bunkSet = new Set();
        var actSet = new Set();
        for (var i = 0; i < activityBlocks.length; i++) bunkSet.add(activityBlocks[i].bunk);
        for (var j = 0; j < allCandidateOptions.length; j++) actSet.add(allCandidateOptions[j].activityName);
        var scored = 0;
        for (var bunk of bunkSet) {
            var divName = getBunkDivision(bunk);
            for (var actName of actSet) {
                if (!actName || actName === 'Free') continue;
                var key = bunk + '|' + actName;
                if (_rotationScoreMap.has(key)) continue;
                var score;
                if (window.RotationEngine?.calculateRotationScore) {
                    score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: actName, divisionName: divName, beforeSlotIndex: 0, allActivities: null, activityProperties: activityProperties });
                } else {
                    var todayActivities = getActivitiesDoneToday(bunk, 999);
                    score = todayActivities.has(normName(actName)) ? Infinity : 0;
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
        if (cached !== undefined) { _perfCounters.rotationCacheHits++; return cached; }
        _perfCounters.rotationCacheMisses++;
        return getCachedRotationPenalty_fallback(bunk, activityName);
    }

    function getCachedRotationPenalty_fallback(bunk, activityName) {
        if (!activityName || activityName === 'Free') return 0;
        var key = bunk + '|' + activityName;
        var cached = _rotationScoreCache.get(key);
        if (cached !== undefined) return cached;
        var score;
        if (window.RotationEngine?.calculateRotationScore) {
            score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: activityName, divisionName: getBunkDivision(bunk), beforeSlotIndex: 999, allActivities: null, activityProperties: activityProperties });
        } else {
            var todayActivities = getActivitiesDoneToday(bunk, 999);
            score = todayActivities.has(normName(activityName)) ? Infinity : 0;
        }
        _rotationScoreCache.set(key, score);
        _rotationScoreMap.set(key, score);
        return score;
    }

    function invalidateRotationCacheForBunk(bunk) {
        for (var [key] of _rotationScoreCache) { if (key.startsWith(bunk + '|')) _rotationScoreCache.delete(key); }
        for (var [key2] of _rotationScoreMap) { if (key2.startsWith(bunk + '|')) _rotationScoreMap.delete(key2); }
        for (var [key3] of _todayCache) { if (key3.startsWith(bunk + ':')) _todayCache.delete(key3); }
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
        if (window.RotationEngine?.getDaysSinceActivity) return window.RotationEngine.getDaysSinceActivity(bunk, activityName, 0);
        return null;
    }

    function getActivityCount(bunk, activityName) {
        if (window.RotationEngine?.getActivityCount) return window.RotationEngine.getActivityCount(bunk, activityName);
        var globalSettings = window.loadGlobalSettings?.() || {};
        var historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        var manualOffsets = globalSettings.manualUsageOffsets || {};
        var baseCount = historicalCounts[bunk]?.[activityName] || 0;
        var offset = manualOffsets[bunk]?.[activityName] || 0;
        return Math.max(0, baseCount + offset);
    }

    // ========================================================================
    // CANDIDATE OPTIONS BUILDER
    // ========================================================================

    const KNOWN_SPORTS = new Set(['hockey','soccer','football','baseball','kickball','basketball','lineup','running bases','newcomb','volleyball','dodgeball','general activity slot','sports slot','special activity','ga slot','sport slot','free','free play']);

    function isSportName(name) { return name ? KNOWN_SPORTS.has(normName(name)) : false; }

    function getLiveTypeBalance(bunk, beforeSlot) {
        var todayDone = getActivitiesDoneToday(bunk, beforeSlot);
        var sports = 0, specials = 0;
        todayDone.forEach(function(act) {
            if (window.RotationEngine?.isSpecialActivity?.(act)) specials++;
            else if (act !== 'free' && act !== 'free play' && act !== 'lunch' && act !== 'snacks' && act !== 'swim' && act !== 'dismissal') sports++;
        });
        return { sports: sports, specials: specials };
    }

    function isSpecialCandidate(cand) { return cand && (cand.type === 'special' || cand._type === 'special'); }

    function buildAllCandidateOptions(config) {
        var options = [];
        var seenKeys = new Set();
        var disabledFields = window.currentDisabledFields || config.disabledFields || [];
        var disabledSet = new Set(disabledFields);
        config.masterFields?.forEach(function(f) {
            if (disabledSet.has(f.name)) return;
            (f.activities || []).forEach(function(sport) {
                var key = f.name + '|' + sport;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: f.name, sport: sport, activityName: sport, type: 'sport', _fieldNorm: normName(f.name), _actNorm: normName(sport) }); }
            });
        });
        config.masterSpecials?.forEach(function(s) {
            if (!s.name || disabledSet.has(s.name)) return;
            var key = s.name + '|special';
            if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: s.name, sport: null, activityName: s.name, type: 'special', _fieldNorm: normName(s.name), _actNorm: normName(s.name) }); }
        });
        var loadedData = window.SchedulerCoreUtils?.loadAndFilterData?.() || {};
        var fieldsBySport = loadedData.fieldsBySport || {};
        for (var sportKey in fieldsBySport) {
            (fieldsBySport[sportKey] || []).forEach(function(fieldName) {
                if (isSportName(fieldName)) return;
                if (disabledSet.has(fieldName)) return;
                var key = fieldName + '|' + sportKey;
                if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: fieldName, sport: sportKey, activityName: sportKey, type: 'sport', _fieldNorm: normName(fieldName), _actNorm: normName(sportKey) }); }
            });
        }
        debugLog('=== TOTAL CANDIDATE OPTIONS:', options.length, '===');
        return options;
    }

    // ========================================================================
    // REUSABLE SCRATCH PICK
    // ========================================================================

    var _scratchPick = { field: '', sport: null, _activity: '', _type: '' };
    function setScratchPick(cand) { _scratchPick.field = cand.field; _scratchPick.sport = cand.sport; _scratchPick._activity = cand.activityName; _scratchPick._type = cand.type; return _scratchPick; }
    function clonePick(cand) { return { field: cand.field, sport: cand.sport, _activity: cand.activityName, _type: cand.type }; }

    // ========================================================================
    // PENALTY ENGINE (v13.0 — with plan steering, scarcity, skeleton, zones)
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

        // === HARD CONSTRAINTS ===
        if (actNorm && actNorm !== 'free' && actNorm !== 'free play') {
            var todayDone = getActivitiesDoneToday(bunk, slots[0] ?? 999);
            if (todayDone.has(actNorm)) return 999999;
        // ★★★ v14.2-FIX: Direct live check bypassing stale cache ★★★
        if (actNorm && actNorm !== 'free' && actNorm !== 'free play') {
            var liveSlots = window.scheduleAssignments?.[bunk] || [];
            var mySlotSet = new Set(slots);
            for (var lsi = 0; lsi < liveSlots.length; lsi++) {
                if (mySlotSet.has(lsi)) continue;
                var lsEntry = liveSlots[lsi];
                if (!lsEntry || lsEntry.continuation || lsEntry._isTransition) continue;
                var lsAct = normName(lsEntry._activity || lsEntry.sport || lsEntry.field);
                if (lsAct === actNorm) return 999999;
            }
        }
        }
        if (fieldName && fieldName !== 'Free' && blockDivName && blockStart !== undefined && blockEnd !== undefined) {
            var fp = _fieldPropertyMap.get(fieldName);
            var sType = fp ? fp.sharingType : getSharingType(fieldName);
            var cap = fp ? fp.capacity : getFieldCapacity(fieldName);
            if (checkCrossDivisionTimeConflict(fieldName, blockDivName, blockStart, blockEnd, bunk)) return 999999;
            if (checkSameFieldActivityMismatch(fieldName, blockStart, blockEnd, act, bunk)) return 999999;
            if (sType === 'not_sharable') { if (getFieldUsageFromTimeIndex(fieldNorm, blockStart, blockEnd, bunk) >= cap) return 999999; }
            else { if (countSameDivisionUsage(fieldName, blockDivName, blockStart, blockEnd, bunk) >= cap) return 999999; }
        }
        var fieldProp = _fieldPropertyMap.get(fieldName);
        if (fieldProp?.prefList) {
            if (fieldProp.prefList.indexOf(blockDivName) === -1 && fieldProp.prefExclusive) return 999999;
        } else {
            var actPrefProps = activityProperties[act];
            if (actPrefProps?.preferences?.enabled && (actPrefProps.preferences.list || []).indexOf(blockDivName) === -1 && actPrefProps.preferences.exclusive) return 999999;
        }
        var rotationPenalty = getPrecomputedRotationScore(bunk, act);
        if (rotationPenalty === Infinity) return 999999;
        var specialRule = activityProperties[act];
        if (specialRule?.maxUsage > 0) {
            var hist = getActivityCount(bunk, act);
            var todayCount = getActivitiesDoneToday(bunk, slots[0] || 999).has(actNorm) ? 1 : 0;
            if (hist + todayCount >= specialRule.maxUsage) return 999999;
        }

       // === SOFT PENALTIES ===
        penalty += rotationPenalty;
        // ★★★ v14.0 FREE PERIOD PENALTY — Free is ALWAYS the worst option ★★★
        // 100000 decisively outweighs all soft penalties combined (rotation,
        // type balance, zone travel, scarcity, etc.) so the solver will
        // exhaust every real option before considering Free.
        if (actNorm === 'free' || fieldName === 'Free') {
            penalty += 100000;
        }

        // Type balance for General Activity Slots
        if (block.event === 'General Activity Slot' || block.event === 'general activity slot') {
            var typeBalance = getLiveTypeBalance(bunk, slots[0] ?? 0);
            var pickIsSpecial = (pick._type === 'special');
            var imbalance = typeBalance.sports - typeBalance.specials;
            if (!pickIsSpecial && imbalance >= 2) penalty += 3000 + (imbalance - 1) * 1000;
            else if (!pickIsSpecial && imbalance >= 1) penalty += 1500;
            else if (pickIsSpecial && imbalance >= 2) penalty -= 2000;
            else if (pickIsSpecial && imbalance >= 1) penalty -= 1000;
            else if (pickIsSpecial && typeBalance.specials > typeBalance.sports + 1) penalty += 1500;
        }

        // Bunk size vs field capacity
        var bunkMeta = window.getBunkMetaData?.(bunk) || globalConfig?.bunkMetaData?.[bunk] || {};
        if (bunkMeta.size) {
            var apCap = activityProperties[fieldName]?.capacity;
            if (apCap && bunkMeta.size > apCap) penalty += 5000;
        }

        // Division preferences
        if (fieldProp?.prefList) {
            var prefIdx = fieldProp.prefList.indexOf(blockDivName);
            if (prefIdx !== -1) penalty -= (50 - prefIdx * 5);
            else penalty += 8000;
        } else {
            var actPrefProps2 = activityProperties[act];
            if (actPrefProps2?.preferences?.enabled) {
                var prefIdx2 = (actPrefProps2.preferences.list || []).indexOf(blockDivName);
                if (prefIdx2 !== -1) penalty -= (50 - prefIdx2 * 5);
                else penalty += 8000;
            }
        }

        // ★★★ ENHANCED SHARING INCENTIVE — strongly prefer occupied fields ★★★
        if (fieldName && fieldName !== 'Free' && slots.length > 0 && blockStart !== undefined && blockEnd !== undefined) {
            var sharingEntries = _fieldTimeIndex.get(fieldNorm) || [];
            var fieldOccupied = false;
            var sameActivityOnField = false;
            for (var sei = 0; sei < sharingEntries.length; sei++) {
                var se = sharingEntries[sei];
                if (se.bunk === bunk) continue;
                if (se.endMin <= blockStart || se.startMin >= blockEnd) continue;
                fieldOccupied = true;
                if (se.activity && se.activity === actNorm) sameActivityOnField = true;
            }
            if (sameActivityOnField) {
                // Same activity already running on this field — HUGE bonus
                penalty -= 3000;
            } else if (fieldOccupied) {
                // Field occupied but different activity — mild discouragement
                penalty += 500;
            } else {
                // Empty field — slight penalty to prefer consolidation
                penalty += 200;
            }
        }
        // ★★★ FILL-TO-CAPACITY — pack fields to max within the grade ★★★
        if (fieldName && fieldName !== 'Free' && blockStart !== undefined && blockEnd !== undefined) {
            var fcFp = _fieldPropertyMap.get(fieldName);
            var fcCap = fcFp ? fcFp.capacity : getFieldCapacity(fieldName);
            var fcSameDiv = 0;
            var fcSameAct = true;
            var fcEntries = _fieldTimeIndex.get(fieldNorm) || [];
            for (var fci = 0; fci < fcEntries.length; fci++) {
                var fce = fcEntries[fci];
                if (fce.bunk === bunk) continue;
                if (fce.endMin <= blockStart || fce.startMin >= blockEnd) continue;
                if (fce.divName === blockDivName) {
                    fcSameDiv++;
                    if (fce.activity && fce.activity !== actNorm) fcSameAct = false;
                }
            }
            if (fcCap > 1 && fcSameAct) {
                // How full is this field within the grade? (0 = empty, fcCap-1 = one spot left)
                var spotsLeft = fcCap - 1 - fcSameDiv;  // -1 because we'd be taking a spot
                if (fcSameDiv > 0 && spotsLeft >= 0) {
                    // Field already has grade-mates doing same activity — reward filling it
                    // Bonus SCALES: closer to full = bigger reward
                    var fillRatio = fcSameDiv / (fcCap - 1);  // 0.5 = half full, 1.0 = one spot left
                    penalty -= Math.round(3000 + (fillRatio * 5000));
                    // cap=2, 1 bunk there: -3000 + -5000 = -8000
                    // cap=3, 1 bunk there: -3000 + -2500 = -5500
                    // cap=3, 2 bunks there: -3000 + -5000 = -8000 (last spot!)
                }
                if (fcSameDiv === 0 && fcCap > 1) {
                    // Empty sharable field — penalize picking it if other fields could be filled
                    penalty += 500;
                }
            }
        }
        // Adjacent bunk distance bonus
        if (slots.length > 0 && window.fieldUsageBySlot) {
            var slotUsage = window.fieldUsageBySlot[slots[0]]?.[fieldName];
            if (slotUsage?.bunks) {
                var myNum = getBunkNumber(bunk) || 0;
                for (var otherBunk in slotUsage.bunks) {
                    if (otherBunk === bunk) continue;
                    var otherNum = getBunkNumber(otherBunk) || 0;
                    var distance = Math.abs(myNum - otherNum);
                    if (distance === 1) penalty -= 500;
                    else if (distance <= 3) penalty -= 300;
                    else penalty -= 100;
                }
            }
        }

        // ★★★ v13.0: Activity-First Plan Steering ★★★
        if (_activityPlan.size > 0 && block._blockIdx !== undefined) {
            var planEntry = _activityPlan.get(block._blockIdx);
            if (planEntry) {
                if (normName(planEntry.activity) === actNorm) penalty += planEntry.steering;
                else penalty += 2000;
            }
        }

        // ★★★ v13.0: Resource Scarcity Penalty ★★★
        if (fieldName && fieldName !== 'Free' && blockStart !== undefined) {
            for (var [scKey, scRatio] of _scarcityMap) {
                if (normName(scKey.split('|')[0]) === actNorm) {
                    if (scRatio > 2) penalty += 2000;
                    if (scRatio > 3) penalty += 3000;
                    break;
                }
            }
        }

        // ★★★ v13.0: Skeleton-Context Flow ★★★
        if ((block.event === 'General Activity Slot' || block.event === 'general activity slot') && block._blockIdx !== undefined) {
            var blockCtx = _skeletonContext.get(block._blockIdx);
            if (blockCtx) {
                var pickIsSpecType = (pick._type === 'special');
                var prevIsHigh = (blockCtx.prevType === 'sport' || (blockCtx.prevEvent && blockCtx.prevEvent.toLowerCase().indexOf('league') !== -1));
                var nextIsHigh = (blockCtx.nextType === 'sport' || (blockCtx.nextEvent && blockCtx.nextEvent.toLowerCase().indexOf('league') !== -1));
                if (prevIsHigh && nextIsHigh) { if (pickIsSpecType) penalty -= 2500; else penalty += 1500; }
                else if (blockCtx.prevType === 'special' && blockCtx.nextType === 'special') { if (!pickIsSpecType) penalty -= 2500; else penalty += 1500; }
                else if (blockCtx.prevType === 'general' || blockCtx.nextType === 'general') {
                    var pos = blockCtx.positionInDay || 0;
                    if (pos % 2 === 0 && !pickIsSpecType) penalty -= 500;
                    else if (pos % 2 === 1 && pickIsSpecType) penalty -= 500;
                }
            }
        }

        // ★★★ v13.0: Don't Waste Unique Resources ★★★
        if (fieldName && fieldName !== 'Free') {
            for (var [urAct, urCount] of _uniqueFieldMap) {
                if (urCount === 1 && normName(urAct) !== actNorm) {
                    var thisFieldHostsUnique = allCandidateOptions.some(function(uc) { return uc.field === fieldName && uc.activityName === urAct; });
                    if (thisFieldHostsUnique) {
                        var ourFieldCount = _uniqueFieldMap.get(act) || 0;
                        if (ourFieldCount > 1) penalty += 5000;
                    }
                }
            }
        }

        // ★★★ v13.0: Zone/Travel-Aware Sequencing ★★★
        if (fieldName && fieldName !== 'Free' && bunk && block.startTime !== undefined) {
            var myZone = window.getZoneForField?.(fieldName);
            var bunkAssigns = window.scheduleAssignments?.[bunk] || [];
            var prevZone = null;
            if (slots.length > 0 && slots[0] > 0) {
                var prevEntry = bunkAssigns[slots[0] - 1];
                if (prevEntry && prevEntry.field && prevEntry.field !== 'Free') prevZone = window.getZoneForField?.(prevEntry.field);
            }
            if (myZone && prevZone) {
                var mzn = (typeof myZone === 'object') ? (myZone.name || '') : myZone;
                var pzn = (typeof prevZone === 'object') ? (prevZone.name || '') : prevZone;
                if (mzn && pzn) { if (mzn === pzn) penalty -= 300; else penalty += 500; }
            }
        }

        // ★★★ v13.0: Time-Constrained Activity Boost ★★★
        if (act) { var tcBoost = _timeConstrainedBoost.get(act); if (tcBoost) penalty -= tcBoost.boost; }

        // ★★★ v13.0: Activity Debt from Previous Passes ★★★
        if (bunk && act && _activityDebt.size > 0) {
            var debtLookup = _activityDebt.get(bunk + '|' + act);
            if (debtLookup) penalty += debtLookup;
        }

        // Tie-breaking randomness
        penalty += Math.random() * (ROTATION_CONFIG.TIE_BREAKER_RANDOMNESS || 300);
        return penalty;
    }

    // ========================================================================
    // BLOCK SORTING
    // ========================================================================

    Solver.sortBlocksByDifficulty = function (blocks, config) {
        var meta = config.bunkMetaData || {};
        blocks.forEach(function(b) { if (!b.divName && !b.division) b.divName = getBunkDivision(b.bunk); });
        var divBlockCounts = {};
        for (var i = 0; i < blocks.length; i++) {
            if (blocks[i]._isLeague) continue;
            var dn = blocks[i].divName || blocks[i].division || '';
            if (!divBlockCounts[dn]) divBlockCounts[dn] = 0;
            divBlockCounts[dn]++;
        }
        var divScarcity = {};
        var divisions = window.divisions || {};
        for (var dk in divisions) {
            var bc = (divisions[dk].bunks || []).length;
            divScarcity[dk] = (bc > 0 && divBlockCounts[dk]) ? (divBlockCounts[dk] / bc) : 999;
        }
        return blocks.sort(function(a, b) {
            if (a._isLeague && !b._isLeague) return -1;
            if (!a._isLeague && b._isLeague) return 1;
            var divA = a.divName || a.division || '', divB = b.divName || b.division || '';
            var sA = divScarcity[divA] || 999, sB = divScarcity[divB] || 999;
            if (Math.abs(sA - sB) > 1) return sA - sB;
            if (divA !== divB) return (parseInt(divA) || 999) - (parseInt(divB) || 999);
            var numA = getBunkNumber(a.bunk) || Infinity, numB = getBunkNumber(b.bunk) || Infinity;
            if (numA !== numB) return numA - numB;
            var timeA = a.startTime ?? (a.slots?.[0] * 30 + 660) ?? 0, timeB = b.startTime ?? (b.slots?.[0] * 30 + 660) ?? 0;
            return timeA - timeB;
        });
    };

    // ========================================================================
    // v13.0: PRECOMPUTE RESOURCE MAPS
    // ========================================================================

    function precomputeResourceMaps(activityBlocks) {
        _uniqueFieldMap.clear(); _timeConstrainedBoost.clear(); _smallBunkFlags.clear();
        var activityToFields = {};
        for (var i = 0; i < allCandidateOptions.length; i++) {
            var c = allCandidateOptions[i];
            if (!c.activityName || c.activityName === 'Free') continue;
            if (!activityToFields[c.activityName]) activityToFields[c.activityName] = new Set();
            activityToFields[c.activityName].add(c.field);
        }
        for (var actName in activityToFields) _uniqueFieldMap.set(actName, activityToFields[actName].size);
        var props = activityProperties || {};
        for (var fieldName in props) {
            var fpx = props[fieldName]; if (!fpx) continue;
            var rules = fpx.timeRules || [];
            var availRules = rules.filter(function(r) { return r.type === 'Available'; });
            if (availRules.length > 0) {
                var totalWindowMinutes = 0;
                for (var ri = 0; ri < availRules.length; ri++) {
                    var r = availRules[ri];
                    var rStart = r.startMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.start) || 0);
                    var rEnd = r.endMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.end) || 0);
                    totalWindowMinutes += Math.max(0, rEnd - rStart);
                }
                if (totalWindowMinutes < 240) {
                    _timeConstrainedBoost.set(fieldName, { windowMinutes: totalWindowMinutes, totalMinutes: 480, boost: Math.round(3000 * (1 - totalWindowMinutes / 480)) });
                }
            }
        }
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        var sportMeta = window.getSportMetaData?.() || window.sportMetaData || {};
        var minThresholds = [];
        for (var sport in sportMeta) { if (sportMeta[sport].minPlayers) minThresholds.push(sportMeta[sport].minPlayers); }
        if (minThresholds.length > 0) {
            minThresholds.sort(function(a, b) { return a - b; });
            var medianMin = minThresholds[Math.floor(minThresholds.length / 2)];
            for (var bunkName in bunkMeta) { var size = bunkMeta[bunkName]?.size || 0; if (size > 0 && size < medianMin) _smallBunkFlags.add(bunkName); }
        }
        // Skeleton context
        var bunkBlocks = {};
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi]; var bk = blk.bunk;
            if (!bunkBlocks[bk]) bunkBlocks[bk] = [];
            bunkBlocks[bk].push({ idx: bi, startTime: blk.startTime || 0, event: blk.event || '' });
        }
        var dailyData = window.loadCurrentDailyData?.() || {};
        var skeleton = dailyData.manualSkeleton || [];
        for (var bunkKey in bunkBlocks) {
            var bBlocks = bunkBlocks[bunkKey];
            bBlocks.sort(function(a, b) { return a.startTime - b.startTime; });
            var bunkDiv = getBunkDivision(bunkKey);
            var fullTimeline = [];
            for (var ski = 0; ski < skeleton.length; ski++) {
                var sk = skeleton[ski]; if (sk.division !== bunkDiv) continue;
                var skStart = window.SchedulerCoreUtils?.parseTimeToMinutes?.(sk.startTime) || 0;
                fullTimeline.push({ startTime: skStart, event: sk.event || sk.type || '', type: sk.type || '' });
            }
            fullTimeline.sort(function(a, b) { return a.startTime - b.startTime; });
            for (var bbi = 0; bbi < bBlocks.length; bbi++) {
                var curBlock = bBlocks[bbi]; var prevType = null, nextType = null, prevEvent = '', nextEvent = '';
                for (var ti = 0; ti < fullTimeline.length; ti++) {
                    if (fullTimeline[ti].startTime < curBlock.startTime) { prevEvent = fullTimeline[ti].event; prevType = categorizeSkeletonEvent(fullTimeline[ti]); }
                    if (fullTimeline[ti].startTime > curBlock.startTime && nextType === null) { nextEvent = fullTimeline[ti].event; nextType = categorizeSkeletonEvent(fullTimeline[ti]); }
                }
                _skeletonContext.set(curBlock.idx, { prevType: prevType, nextType: nextType, prevEvent: prevEvent, nextEvent: nextEvent, positionInDay: bbi, totalBlocksForBunk: bBlocks.length });
            }
        }
        v12Log('v13 Resource maps: ' + _uniqueFieldMap.size + ' activities, ' + _timeConstrainedBoost.size + ' time-constrained, ' + _smallBunkFlags.size + ' small bunks');
    }

    function categorizeSkeletonEvent(item) {
        var ev = (item.event || item.type || '').toLowerCase();
        if (ev.includes('league') || ev.includes('sport') || ev.includes('swim') || ev.includes('pool')) return 'sport';
        if (ev.includes('special') || ev.includes('elective')) return 'special';
        if (ev.includes('lunch') || ev.includes('snack') || ev.includes('dismissal')) return 'break';
        if (ev.includes('activity') || ev.includes('general')) return 'general';
        return 'other';
    }

    // ========================================================================
    // v13.0: ACTIVITY-FIRST PLANNER
    // ========================================================================

    function activityFirstPlanner(activityBlocks) {
        _activityPlan.clear(); _scarcityMap.clear();
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        var divTimeGroups = {};
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi];
            if (!blk.divName) blk.divName = getBunkDivision(blk.bunk) || '';
            var key = blk.divName + '|' + (blk.startTime || '?') + '-' + (blk.endTime || '?');
            if (!divTimeGroups[key]) divTimeGroups[key] = [];
            divTimeGroups[key].push(bi);
        }
        for (var groupKey in divTimeGroups) {
            var blockIndices = divTimeGroups[groupKey];
            if (blockIndices.length === 0) continue;
            var sampleBlock = activityBlocks[blockIndices[0]];
            var divName = sampleBlock.divName, startMin = sampleBlock.startTime, endMin = sampleBlock.endTime;
            if (startMin === undefined || endMin === undefined) continue;
            // PHASE A: Wish lists
            var wishLists = {}, bunkSizes = {};
            for (var i = 0; i < blockIndices.length; i++) {
                var block = activityBlocks[blockIndices[i]]; var bunk = block.bunk;
                var bSize = bunkMeta[bunk]?.size || 0; bunkSizes[bunk] = bSize;
                var wishes = [], candidateActivities = new Set();
                for (var ci = 0; ci < allCandidateOptions.length; ci++) { var cand = allCandidateOptions[ci]; if (cand.activityName && cand.activityName !== 'Free') candidateActivities.add(cand.activityName); }
                for (var actName of candidateActivities) {
                    var actNorm = normName(actName);
                    var todayDone = getActivitiesDoneToday(bunk, block.slots?.[0] ?? 999);
                    if (todayDone.has(actNorm)) continue;
                    var rotScore = getPrecomputedRotationScore(bunk, actName);
                    if (rotScore === Infinity) continue;
                    var soloCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(actName, bSize, false);
                    var needsSharing = soloCheck && !soloCheck.valid && soloCheck.severity === 'hard';
                    var isSpecial = window.RotationEngine?.isSpecialActivity?.(actName) || allCandidateOptions.some(function(c) { return c.activityName === actName && c.type === 'special'; });
                    var debtBonus = _activityDebt.get(bunk + '|' + actName) || 0;
                    var tcInfo = _timeConstrainedBoost.get(actName);
                    var timeBoost = tcInfo ? -tcInfo.boost : 0;
                    wishes.push({ activity: actName, need: rotScore + debtBonus + timeBoost, actType: isSpecial ? 'special' : 'sport', needsSharing: needsSharing, bunkSize: bSize });
                }
                wishes.sort(function(a, b) { return a.need - b.need; });
                wishLists[bunk] = wishes;
            }
            // PHASE B: Allocation
            var actFieldSlots = {};
            for (var ci3 = 0; ci3 < allCandidateOptions.length; ci3++) {
                var c3 = allCandidateOptions[ci3]; if (!c3.activityName || c3.activityName === 'Free') continue;
                if (!actFieldSlots[c3.activityName]) actFieldSlots[c3.activityName] = new Set();
                actFieldSlots[c3.activityName].add(c3.field);
            }
            var activitySupply = {}; for (var afs in actFieldSlots) activitySupply[afs] = actFieldSlots[afs].size;
            var bunkList = blockIndices.map(function(bi2) { return activityBlocks[bi2].bunk; });
            // Small bunk pairing
            var pairedBunks = new Map();
            for (var sbi = 0; sbi < bunkList.length; sbi++) {
                var sBunk = bunkList[sbi]; if (!_smallBunkFlags.has(sBunk) || pairedBunks.has(sBunk)) continue;
                var myNum = getBunkNumber(sBunk) || 0, bestPartner = null, bestDist = Infinity;
                for (var pbi = 0; pbi < bunkList.length; pbi++) {
                    var pBunk = bunkList[pbi]; if (pBunk === sBunk) continue;
                    if (pairedBunks.has(pBunk) && pairedBunks.get(pBunk) !== sBunk) continue;
                    var dist = Math.abs((getBunkNumber(pBunk) || 0) - myNum);
                    if (dist < bestDist) { bestDist = dist; bestPartner = pBunk; }
                }
                if (bestPartner) pairedBunks.set(sBunk, bestPartner);
            }
            var allocated = {}, activityUsed = {};
            var sortedBunks = bunkList.slice().sort(function(a, b) { return (wishLists[a]?.length || 0) - (wishLists[b]?.length || 0); });
            for (var abi = 0; abi < sortedBunks.length; abi++) {
                var aBunk = sortedBunks[abi]; if (allocated[aBunk]) continue;
                var wishes2 = wishLists[aBunk] || [];
                for (var wi = 0; wi < wishes2.length; wi++) {
                    var wish = wishes2[wi];
                    if ((activityUsed[wish.activity] || 0) >= (activitySupply[wish.activity] || 0)) continue;
                    if (wish.needsSharing && pairedBunks.has(aBunk)) {
                        var partner = pairedBunks.get(aBunk);
                        var combinedSize = (bunkSizes[aBunk] || 0) + (bunkSizes[partner] || 0);
                        var combinedCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(wish.activity, combinedSize, false);
                        if (combinedCheck && !combinedCheck.valid && combinedCheck.severity === 'hard') continue;
                    }
                    var projectedPlayers = bunkSizes[aBunk] || 0;
                    for (var existBunk in allocated) { if (allocated[existBunk] === wish.activity) projectedPlayers += (bunkSizes[existBunk] || 0); }
                    var maxReqs = window.SchedulerCoreUtils?.getSportPlayerRequirements?.(wish.activity);
                    if (maxReqs?.maxPlayers && projectedPlayers > maxReqs.maxPlayers * 1.3) continue;
                    allocated[aBunk] = wish.activity;
                    activityUsed[wish.activity] = (activityUsed[wish.activity] || 0) + 1;
                    if (pairedBunks.has(aBunk) && !allocated[pairedBunks.get(aBunk)]) {
                        var prt = pairedBunks.get(aBunk);
                        if ((wishLists[prt] || []).some(function(w) { return w.activity === wish.activity; }) && (activityUsed[wish.activity] || 0) < (activitySupply[wish.activity] || 0)) {
                            allocated[prt] = wish.activity; activityUsed[wish.activity]++;
                        }
                    }
                    break;
                }
                if (allocated[aBunk] && wishes2.length > 0 && allocated[aBunk] !== wishes2[0].activity) {
                    var dk2 = aBunk + '|' + wishes2[0].activity;
                    _activityDebt.set(dk2, (_activityDebt.get(dk2) || 0) - 2000);
                }
            }
            // PHASE C: Write plan + scarcity
            for (var pi = 0; pi < blockIndices.length; pi++) {
                var bIdx = blockIndices[pi]; var pBunk = activityBlocks[bIdx].bunk;
                if (allocated[pBunk]) _activityPlan.set(bIdx, { activity: allocated[pBunk], steering: -8000 });
            }
            for (var scAct in activityUsed) {
                var demand = 0;
                for (var scBunk in wishLists) { if (wishLists[scBunk]?.some(function(w) { return w.activity === scAct; })) demand++; }
                var scSupply = activitySupply[scAct] || 1;
                if (demand > scSupply) _scarcityMap.set(scAct + '|' + startMin, demand / scSupply);
            }
        }
        console.log('[SOLVER-v13] 🧠 Activity-First Planner: ' + _activityPlan.size + ' blocks planned, ' + _scarcityMap.size + ' scarce, ' + _activityDebt.size + ' debt');
    }

    // ========================================================================
    // v13.0: PASS ANALYSIS + ADJUSTMENT
    // ========================================================================

    function analyzePassResult(activityBlocks, passNum) {
        var analysis = { passNumber: passNum, freeBlocks: [], yesterdayRepeats: [], playerViolations: [], freeBlockBunks: new Set(), totalFree: 0, totalBlocks: activityBlocks.length, score: 0 };
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        for (var i = 0; i < activityBlocks.length; i++) {
            var asgn = _assignments.get(i); if (!asgn) continue;
            var block = activityBlocks[i];
            var actNorm = normName(asgn.pick._activity || asgn.pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') {
                analysis.freeBlocks.push({ blockIdx: i, bunk: block.bunk, divName: block.divName, startTime: block.startTime, endTime: block.endTime });
                analysis.freeBlockBunks.add(block.bunk); analysis.totalFree++; analysis.score += 10000;
            }
            if (actNorm && actNorm !== 'free') {
                var daysSince = getDaysSinceActivity(block.bunk, asgn.pick._activity);
                if (daysSince === 1) { analysis.yesterdayRepeats.push({ blockIdx: i, bunk: block.bunk, activity: asgn.pick._activity }); analysis.score += 5000; }
            }
            if (actNorm && actNorm !== 'free' && asgn.pick.field && asgn.pick.field !== 'Free') {
                var fieldNorm = normName(asgn.pick.field);
                var entries = _fieldTimeIndex.get(fieldNorm) || [];
                var totalPlayers = bunkMeta[block.bunk]?.size || 0;
                for (var ei = 0; ei < entries.length; ei++) {
                    var e = entries[ei]; if (e.bunk === block.bunk) continue;
                    if (e.endMin <= block.startTime || e.startMin >= block.endTime) continue;
                    totalPlayers += (bunkMeta[e.bunk]?.size || 0);
                }
                var pCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(asgn.pick._activity, totalPlayers, false);
                if (pCheck && !pCheck.valid) { analysis.playerViolations.push({ blockIdx: i, bunk: block.bunk, activity: asgn.pick._activity, players: totalPlayers, severity: pCheck.severity }); analysis.score += (pCheck.severity === 'hard' ? 8000 : 2000); }
            }
            if (actNorm && actNorm !== 'free') analysis.score += Math.min(asgn.cost || 0, 50000);
        }
        console.log('[SOLVER-v13] 📊 Pass ' + passNum + ': ' + analysis.totalFree + ' Free, ' + analysis.yesterdayRepeats.length + ' yday repeats, Score: ' + analysis.score);
        return analysis;
    }

    function adjustPlanFromAnalysis(activityBlocks, analysis) {
        if (!analysis) return;
        for (var fi = 0; fi < analysis.freeBlocks.length; fi++) {
            var fb = analysis.freeBlocks[fi];
            for (var ci = 0; ci < allCandidateOptions.length; ci++) {
                var c = allCandidateOptions[ci]; if (!c.activityName || c.activityName === 'Free') continue;
                var dKey = fb.bunk + '|' + c.activityName;
                _activityDebt.set(dKey, (_activityDebt.get(dKey) || 0) - 5000);
            }
        }
        for (var yi = 0; yi < analysis.yesterdayRepeats.length; yi++) {
            var yr = analysis.yesterdayRepeats[yi]; var yrKey = yr.bunk + '|' + yr.activity;
            _activityDebt.set(yrKey, (_activityDebt.get(yrKey) || 0) + 10000);
        }
        for (var pvi = 0; pvi < analysis.playerViolations.length; pvi++) {
            var pv = analysis.playerViolations[pvi];
            if (pv.severity === 'hard') { var pvKey = pv.bunk + '|' + pv.activity; _activityDebt.set(pvKey, (_activityDebt.get(pvKey) || 0) + 20000); }
        }
    }

    // ========================================================================
    // FUSED DOMAIN + SLOT GROUP BUILD
    // ========================================================================

    function buildDomainsAndSlotGroups(activityBlocks) {
        var numBlocks = activityBlocks.length, numCands = allCandidateOptions.length;
        var domains = new Map(), slotGroups = new Map();
        var disabledSet = new Set(window.currentDisabledFields || globalConfig?.disabledFields || []);
        var globallyValidCands = new Uint8Array(numCands);
        for (var ci = 0; ci < numCands; ci++) {
            var cand = allCandidateOptions[ci]; if (disabledSet.has(cand.field)) continue;
            if (!activityProperties[cand.field] && !activityProperties[cand.activityName] && cand.type !== 'special') continue;
            globallyValidCands[ci] = 1;
        }
        for (var bi = 0; bi < numBlocks; bi++) {
            var block = activityBlocks[bi];
            block._blockIdx = bi;
            var domain = new Set(), bunk = block.bunk;
            var blockDivName = block.divName || block.division || '';
            if (!blockDivName && bunk) { blockDivName = getBunkDivision(bunk) || ''; if (blockDivName) block.divName = blockDivName; }
            var slots = block.slots || [];
            var startMin = block.startTime, endMin = block.endTime;
            if (startMin === undefined || endMin === undefined) {
                var divSlots = window.divisionTimes?.[blockDivName] || [];
                if (slots.length > 0 && divSlots[slots[0]]) {
                    startMin = divSlots[slots[0]].startMin;
                    var lastSlot = divSlots[slots[slots.length - 1]];
                    endMin = lastSlot ? lastSlot.endMin : (startMin + 40);
                    block.startTime = startMin; block.endTime = endMin;
                }
            }
            var hasValidTimes = startMin !== undefined && endMin !== undefined;
            var groupKey = (startMin || '?') + '-' + (endMin || '?') + '-' + blockDivName;
            if (!slotGroups.has(groupKey)) slotGroups.set(groupKey, []);
            slotGroups.get(groupKey).push(bi);
            for (var ci2 = 0; ci2 < numCands; ci2++) {
                if (!globallyValidCands[ci2]) continue;
                var cand2 = allCandidateOptions[ci2], fieldName = cand2.field, fieldNorm = cand2._fieldNorm;
                if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, blockDivName)) continue;
                // ★★★ FIX v13.1: TIME-BASED lock check for cross-division league conflicts ★★★
                if (hasValidTimes && isFieldLockedByTime(fieldName, startMin, endMin, blockDivName)) continue;
                var fieldProp = _fieldPropertyMap.get(fieldName);
                if (fieldProp?.prefExclusive && fieldProp.prefList && fieldProp.prefList.indexOf(blockDivName) === -1) continue;
                var fits = window.SchedulerCoreUtils?.canBlockFit?.(block, fieldName, activityProperties, window.fieldUsageBySlot, cand2.activityName, false);
                if (fits === false) continue;
                if (hasValidTimes) {
                    var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
                    var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);
                    if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                    if (sharingType === 'not_sharable') { if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue; }
                    else { if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue; }
                }
                var rotationPenalty = getPrecomputedRotationScore(bunk, cand2.activityName);
                if (rotationPenalty === Infinity) continue;
                domain.add(ci2);
            }
            domains.set(bi, domain);
        }
        return { domains: domains, slotGroups: slotGroups };
    }
    // ========================================================================
    // AC-3 CONSTRAINT PROPAGATION
    // ========================================================================

    function propagateAC3(activityBlocks) {
        var propagated = 0, autoAssigned = 0, maxIterations = activityBlocks.length * 10, iteration = 0;
        var overlaps = new Map();
        for (var [, groupIndices] of _slotGroups) {
            for (var i = 0; i < groupIndices.length; i++) {
                for (var j = i + 1; j < groupIndices.length; j++) {
                    var a = groupIndices[i], b = groupIndices[j];
                    if (!overlaps.has(a)) overlaps.set(a, new Set());
                    if (!overlaps.has(b)) overlaps.set(b, new Set());
                    overlaps.get(a).add(b); overlaps.get(b).add(a);
                }
            }
        }
        var groupEntries = [];
        for (var [gKey, gIndices] of _slotGroups) {
            if (gIndices.length === 0) continue;
            var sample = activityBlocks[gIndices[0]];
            if (sample.startTime !== undefined) groupEntries.push({ start: sample.startTime, end: sample.endTime, indices: gIndices });
        }
        groupEntries.sort(function(a, b) { return a.start - b.start; });
        for (var gi = 0; gi < groupEntries.length; gi++) {
            var gA = groupEntries[gi];
            for (var gj = gi + 1; gj < groupEntries.length; gj++) {
                var gB = groupEntries[gj]; if (gB.start >= gA.end) break;
                for (var ai of gA.indices) { for (var bi2 of gB.indices) {
                    if (!overlaps.has(ai)) overlaps.set(ai, new Set());
                    if (!overlaps.has(bi2)) overlaps.set(bi2, new Set());
                    overlaps.get(ai).add(bi2); overlaps.get(bi2).add(ai);
                }}
            }
        }
        var queue = new Set();
        for (var qi = 0; qi < activityBlocks.length; qi++) queue.add(qi);
        while (queue.size > 0 && iteration < maxIterations) {
            iteration++;
            var bi3 = queue.values().next().value; queue.delete(bi3);
            if (_assignedBlocks.has(bi3)) continue;
            var domain = _domains.get(bi3); if (!domain || domain.size === 0) continue;
            if (domain.size === 1) {
                var ci3 = domain.values().next().value;
                var block = activityBlocks[bi3], cand3 = allCandidateOptions[ci3], pick = clonePick(cand3);
                var singletonBlocked = false;
                if (block.startTime !== undefined && block.endTime !== undefined && block.divName) {
                    if (checkCrossDivisionTimeConflict(cand3.field, block.divName, block.startTime, block.endTime, block.bunk)) singletonBlocked = true;
                }
                if (singletonBlocked) {
                    pick = { field: "Free", sport: null, _activity: "Free" };
                    _assignedBlocks.add(bi3); _assignments.set(bi3, { candIdx: -1, pick: pick, cost: 100000 }); applyPickToSchedule(block, pick);
                } else {
                    var cost = calculatePenaltyCost(block, pick);
                    _assignedBlocks.add(bi3); _assignments.set(bi3, { candIdx: ci3, pick: pick, cost: cost }); applyPickToSchedule(block, pick);
                    var fieldNorm = normName(pick.field);
                    if (block.startTime !== undefined && block.endTime !== undefined) {
                        var pickActNorm = normName(pick._activity);
                        addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, pickActNorm);
                        if (pickActNorm && pickActNorm !== fieldNorm) addToFieldTimeIndex(pickActNorm, block.startTime, block.endTime, block.bunk, block.divName, pickActNorm);
                    }
                    invalidateRotationCacheForBunk(block.bunk);
                }
                autoAssigned++;
                var neighbors = overlaps.get(bi3) || new Set();
                for (var ni of neighbors) {
                    if (_assignedBlocks.has(ni)) continue;
                    var nDomain = _domains.get(ni); if (!nDomain) continue;
                    var nBlock = activityBlocks[ni], changed = false;
                    for (var nci of Array.from(nDomain)) { if (wouldConflict(block, pick, nBlock, allCandidateOptions[nci])) { nDomain.delete(nci); changed = true; propagated++; } }
                    if (changed) queue.add(ni);
                }
                continue;
            }
            var neighbors2 = overlaps.get(bi3) || new Set();
            for (var ni2 of neighbors2) {
                if (!_assignedBlocks.has(ni2)) continue;
                var assignment = _assignments.get(ni2); if (!assignment) continue;
                var nBlock2 = activityBlocks[ni2], changed2 = false;
                for (var ci4 of Array.from(domain)) { if (wouldConflict(nBlock2, assignment.pick, activityBlocks[bi3], allCandidateOptions[ci4])) { domain.delete(ci4); changed2 = true; propagated++; } }
                if (changed2) queue.add(bi3);
            }
        }
        v12Log('AC-3: ' + autoAssigned + ' auto-assigned, ' + propagated + ' pruned');
        return { autoAssigned: autoAssigned, propagated: propagated };
    }

    function wouldConflict(assignedBlock, assignedPick, otherBlock, otherCand) {
        var assignedFieldNorm = normName(assignedPick.field), otherFieldNorm = otherCand._fieldNorm || normName(otherCand.field);
        if (assignedFieldNorm !== otherFieldNorm) return false;
        var aStart = assignedBlock.startTime, aEnd = assignedBlock.endTime, oStart = otherBlock.startTime, oEnd = otherBlock.endTime;
        if (aStart === undefined || oStart === undefined) return false;
        if (aStart >= oEnd || aEnd <= oStart) return false;
        var fieldProp = _fieldPropertyMap.get(assignedPick.field);
        var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(assignedPick.field);
        var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(assignedPick.field);
        var aDivName = assignedBlock.divName || '', oDivName = otherBlock.divName || '';
        if (sharingType === 'not_sharable') return true;
        if (aDivName && oDivName && aDivName !== oDivName) return true;
        var overlapStart = Math.max(aStart, oStart), overlapEnd = Math.min(aEnd, oEnd);
        return countSameDivisionUsage(assignedPick.field, aDivName, overlapStart, overlapEnd, otherBlock.bunk) >= capacity;
    }

    // ========================================================================
    // AUGMENTING PATH MATCHING
    // ========================================================================

    function solveSlotGroups(activityBlocks) {
        var groupsSolved = 0, blocksAssigned = 0;
        // ★★★ v13.0-FIX2: Global tracker — survives across ALL groups ★★★
        var globalBunkActivities = new Map(); // bunk → Set<actNorm>
        // Seed with pre-solver placements (leagues, smart tiles, split tiles, etc.)
        var allBunks = Object.keys(window.scheduleAssignments || {});
        for (var gbi = 0; gbi < allBunks.length; gbi++) {
            var gbBunk = allBunks[gbi];
            var gbSlots = window.scheduleAssignments[gbBunk] || [];
            for (var gsi = 0; gsi < gbSlots.length; gsi++) {
                var gbEntry = gbSlots[gsi];
                if (!gbEntry || gbEntry.continuation || gbEntry._isTransition) continue;
                var gbAct = normName(gbEntry._activity || gbEntry.sport || gbEntry.field);
                if (gbAct && gbAct !== 'free' && gbAct !== 'free play' && gbAct !== 'transition/buffer') {
                    if (!globalBunkActivities.has(gbBunk)) globalBunkActivities.set(gbBunk, new Set());
                    globalBunkActivities.get(gbBunk).add(gbAct);
                }
            }
        }
        var sortedGroups = Array.from(_slotGroups.entries()).sort(function(a, b) { return a[1].length - b[1].length; });
        for (var [, blockIndices] of sortedGroups) {
            // ★★★ v13.0-FIX: Clear stale today-cache before each group ★★★
            _todayCache.clear();
            var unassigned = blockIndices.filter(function(bi) { return !_assignedBlocks.has(bi); });
            if (unassigned.length === 0) continue;
            var groupAssignments = solveGroupMatchingAugmented(activityBlocks, unassigned, globalBunkActivities);
            for (var ga of groupAssignments) {
                if (_assignedBlocks.has(ga.blockIdx)) continue;
                var block = activityBlocks[ga.blockIdx];
                _assignedBlocks.add(ga.blockIdx); _assignments.set(ga.blockIdx, { candIdx: ga.candIdx, pick: ga.pick, cost: ga.cost });
                applyPickToSchedule(block, ga.pick);
                var fieldNorm = normName(ga.pick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var gaActNorm = normName(ga.pick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, gaActNorm);
                    if (gaActNorm && gaActNorm !== fieldNorm) addToFieldTimeIndex(gaActNorm, block.startTime, block.endTime, block.bunk, block.divName, gaActNorm);
                }
                invalidateRotationCacheForBunk(block.bunk);
                propagateAssignment(activityBlocks, ga.blockIdx, ga.pick);
                // ★★★ v13.0-FIX2: Update global tracker ★★★
                var gaActForTracker = normName(ga.pick._activity || ga.pick.field);
                if (gaActForTracker && gaActForTracker !== 'free' && gaActForTracker !== 'free play') {
                    if (!globalBunkActivities.has(block.bunk)) globalBunkActivities.set(block.bunk, new Set());
                    globalBunkActivities.get(block.bunk).add(gaActForTracker);
                }
                blocksAssigned++;
            }
            // ★★★ v13.0-FIX: Invalidate caches after group picks applied ★★★
            _todayCache.clear();
            groupsSolved++;
        }
        v12Log('Slot groups: ' + groupsSolved + ' groups, ' + blocksAssigned + ' assigned');
        return blocksAssigned;
    }

    function solveGroupMatchingAugmented(activityBlocks, unassignedIndices, globalBunkActivities) {
        globalBunkActivities = globalBunkActivities || new Map();
        var results = [], blockOptions = [];
        for (var bi of unassignedIndices) {
            var domain = _domains.get(bi);
            if (!domain || domain.size === 0) { results.push({ blockIdx: bi, candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 }); continue; }
            var block = activityBlocks[bi], scored = [];
            for (var ci of domain) { var cand = allCandidateOptions[ci]; if (!isPickStillValid(block, cand)) continue;
                // ★★★ v13.0-FIX2: Check global cross-group tracker ★★★
                var p1ActNorm = normName(cand.activityName);
                if (p1ActNorm && p1ActNorm !== 'free' && p1ActNorm !== 'free play') {
                    var p1GlobalDone = globalBunkActivities.get(block.bunk);
                    if (p1GlobalDone && p1GlobalDone.has(p1ActNorm)) continue;
                }
                setScratchPick(cand); var cost = calculatePenaltyCost(block, _scratchPick); if (cost < 900000) scored.push({ bi: bi, ci: ci, cost: cost }); }
            scored.sort(function(a, b) { return a.cost - b.cost; });
            blockOptions.push({ bi: bi, options: scored, domainSize: scored.length });
        }
        blockOptions.sort(function(a, b) { return a.domainSize - b.domainSize; });
        var fieldUsageInGroup = new Map(), fieldDivsInGroup = new Map();
        // ★★★ v13.0-FIX: Track activities assigned per bunk within group to prevent same-day duplicates ★★★
        var bunkActivitiesInGroup = new Map();
        for (var bo of blockOptions) {
            if (_assignedBlocks.has(bo.bi)) continue;
            var block2 = activityBlocks[bo.bi], assigned = false;
            for (var oi = 0; oi < bo.options.length; oi++) {
                var opt = bo.options[oi], cand2 = allCandidateOptions[opt.ci];
                // ★★★ v13.0-FIX2: Skip if activity already done by this bunk (in-group, cross-group, or pre-solver) ★★★
                var candActNorm_chk = normName(cand2.activityName);
                if (candActNorm_chk && candActNorm_chk !== 'free' && candActNorm_chk !== 'free play') {
                    var bunkDoneInGroup = bunkActivitiesInGroup.get(block2.bunk);
                    if (bunkDoneInGroup && bunkDoneInGroup.has(candActNorm_chk)) continue;
                    // Check global cross-group tracker
                    var globalDone = globalBunkActivities.get(block2.bunk);
                    if (globalDone && globalDone.has(candActNorm_chk)) continue;
                    // Also check live schedule for pre-solver placements
                    var liveDone = getActivitiesDoneToday(block2.bunk, block2.slots?.[0] ?? 999);
                    if (liveDone.has(candActNorm_chk)) continue;
                }
                var fieldNorm2 = cand2._fieldNorm, fieldName = cand2.field;
                var fieldProp = _fieldPropertyMap.get(fieldName);
                var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
                var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);
                var currentGroupUsage = fieldUsageInGroup.get(fieldNorm2) || 0;
                var existingUsage = (block2.startTime !== undefined && block2.endTime !== undefined) ? getFieldUsageFromTimeIndex(fieldNorm2, block2.startTime, block2.endTime, block2.bunk) : 0;
                var canFit = false;
                if (sharingType === 'not_sharable') {
                    canFit = (existingUsage + currentGroupUsage < capacity);
                } else if (sharingType === 'same_division' || sharingType === 'custom') {
                    var crossConflict = checkCrossDivisionTimeConflict(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    if (!crossConflict && block2.divName) {
                        for (var gri = 0; gri < results.length; gri++) {
                            var gr = results[gri]; if (gr.candIdx === -1 || normName(gr.pick.field) !== fieldNorm2) continue;
                            var grBlock = activityBlocks[gr.blockIdx];
                            if (grBlock.divName && grBlock.divName !== block2.divName && grBlock.startTime < block2.endTime && grBlock.endTime > block2.startTime) { crossConflict = true; break; }
                        }
                    }
                    if (!crossConflict) {
                        var actMismatch = checkSameFieldActivityMismatch(fieldName, block2.startTime, block2.endTime, cand2.activityName, block2.bunk);
                        if (!actMismatch) {
                            var candActNorm2 = normName(cand2.activityName);
                            for (var gria = 0; gria < results.length; gria++) {
                                var gra = results[gria]; if (gra.candIdx === -1 || normName(gra.pick.field) !== fieldNorm2) continue;
                                var graBlock = activityBlocks[gra.blockIdx];
                                if (graBlock.startTime < block2.endTime && graBlock.endTime > block2.startTime) {
                                    var graActNorm = normName(gra.pick._activity);
                                    if (graActNorm && candActNorm2 && graActNorm !== candActNorm2) { actMismatch = graActNorm; break; }
                                }
                            }
                        }
                        if (!actMismatch) {
                            var sameDivGroupUsage = 0;
                            if (block2.divName) {
                                for (var gri2 = 0; gri2 < results.length; gri2++) {
                                    var gr2 = results[gri2]; if (gr2.candIdx === -1 || normName(gr2.pick.field) !== fieldNorm2) continue;
                                    var grBlock2 = activityBlocks[gr2.blockIdx];
                                    if (grBlock2.divName === block2.divName && grBlock2.startTime < block2.endTime && grBlock2.endTime > block2.startTime) sameDivGroupUsage++;
                                }
                            }
                            canFit = (countSameDivisionUsage(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk) + sameDivGroupUsage < capacity);
                        }
                    }
                } else {
                    var crossConflictAll = checkCrossDivisionTimeConflict(fieldName, block2.divName, block2.startTime, block2.endTime, block2.bunk);
                    if (!crossConflictAll && block2.divName) {
                        for (var griAll = 0; griAll < results.length; griAll++) {
                            var grAll = results[griAll]; if (grAll.candIdx === -1 || normName(grAll.pick.field) !== fieldNorm2) continue;
                            var grBlockAll = activityBlocks[grAll.blockIdx];
                            if (grBlockAll.divName && grBlockAll.divName !== block2.divName && grBlockAll.startTime < block2.endTime && grBlockAll.endTime > block2.startTime) { crossConflictAll = true; break; }
                        }
                    }
                    canFit = !crossConflictAll && (existingUsage + currentGroupUsage < capacity);
                }
                if (canFit) {
                    results.push({ blockIdx: bo.bi, candIdx: opt.ci, pick: clonePick(cand2), cost: opt.cost });
                    fieldUsageInGroup.set(fieldNorm2, currentGroupUsage + 1);
                    if (!fieldDivsInGroup.has(fieldNorm2)) fieldDivsInGroup.set(fieldNorm2, new Set());
                    fieldDivsInGroup.get(fieldNorm2).add(block2.divName || '');
                    // ★★★ v13.0-FIX: Record activity for this bunk ★★★
                    if (!bunkActivitiesInGroup.has(block2.bunk)) bunkActivitiesInGroup.set(block2.bunk, new Set());
                    var assignedActNorm = normName(cand2.activityName);
                    if (assignedActNorm && assignedActNorm !== 'free') bunkActivitiesInGroup.get(block2.bunk).add(assignedActNorm);
                    assigned = true; break;
                }
                // Augmenting path
                if (sharingType === 'not_sharable' && currentGroupUsage >= capacity) {
                    _perfCounters.augmentingPathAttempts++;
                    var currentHolder = null;
                    for (var ri = results.length - 1; ri >= 0; ri--) { if (normName(results[ri].pick.field) === fieldNorm2 && results[ri].candIdx !== -1) { currentHolder = ri; break; } }
                    if (currentHolder !== null) {
                        var holderResult = results[currentHolder], holderBi = holderResult.blockIdx, holderBlock = activityBlocks[holderBi];
                        var holderOptions = blockOptions.find(function(x) { return x.bi === holderBi; });
                        if (holderOptions) {
                            for (var altOi = 0; altOi < holderOptions.options.length; altOi++) {
                                var altOpt = holderOptions.options[altOi]; if (altOpt.ci === holderResult.candIdx) continue;
                                var altCand = allCandidateOptions[altOpt.ci], altFieldNorm = altCand._fieldNorm;
                                if (altFieldNorm === fieldNorm2) continue;
                                var altGroupUsage = fieldUsageInGroup.get(altFieldNorm) || 0, altCapacity = getFieldCapacity(altCand.field);
                                var altExisting = holderBlock.startTime !== undefined ? getFieldUsageFromTimeIndex(altFieldNorm, holderBlock.startTime, holderBlock.endTime, holderBlock.bunk) : 0;
                                if (altExisting + altGroupUsage < altCapacity) {
                                    var altCrossConflict = checkCrossDivisionTimeConflict(altCand.field, holderBlock.divName, holderBlock.startTime, holderBlock.endTime, holderBlock.bunk);
                                    if (altCrossConflict) continue;
                                    var altGrpDivs = fieldDivsInGroup.get(altFieldNorm);
                                    if (altGrpDivs && holderBlock.divName) { var altCrossBad = false; for (var agd of altGrpDivs) { if (agd && agd !== holderBlock.divName) { altCrossBad = true; break; } } if (altCrossBad) continue; }
                                    fieldUsageInGroup.set(fieldNorm2, (fieldUsageInGroup.get(fieldNorm2) || 1) - 1);
                                    results[currentHolder] = { blockIdx: holderBi, candIdx: altOpt.ci, pick: clonePick(altCand), cost: altOpt.cost };
                                    fieldUsageInGroup.set(altFieldNorm, altGroupUsage + 1);
                                    if (!fieldDivsInGroup.has(altFieldNorm)) fieldDivsInGroup.set(altFieldNorm, new Set());
                                    fieldDivsInGroup.get(altFieldNorm).add(holderBlock.divName || '');
                                    results.push({ blockIdx: bo.bi, candIdx: opt.ci, pick: clonePick(cand2), cost: opt.cost });
                                    fieldUsageInGroup.set(fieldNorm2, (fieldUsageInGroup.get(fieldNorm2) || 0) + 1);
                                    if (!fieldDivsInGroup.has(fieldNorm2)) fieldDivsInGroup.set(fieldNorm2, new Set());
                                    fieldDivsInGroup.get(fieldNorm2).add(block2.divName || '');
                                    // ★★★ v13.0-FIX: Record activity for this bunk (aug path) ★★★
                                    if (!bunkActivitiesInGroup.has(block2.bunk)) bunkActivitiesInGroup.set(block2.bunk, new Set());
                                    var augActNorm = normName(cand2.activityName);
                                    if (augActNorm && augActNorm !== 'free') bunkActivitiesInGroup.get(block2.bunk).add(augActNorm);
                                    // Also update holder's activity record
                                    if (!bunkActivitiesInGroup.has(holderBlock.bunk)) bunkActivitiesInGroup.set(holderBlock.bunk, new Set());
                                    var holderActNorm = normName(altCand.activityName);
                                    if (holderActNorm && holderActNorm !== 'free') bunkActivitiesInGroup.get(holderBlock.bunk).add(holderActNorm);
                                    assigned = true; _perfCounters.augmentingPathSuccesses++; break;
                                }
                            }
                        }
                    }
                    if (assigned) break;
                }
            }
            if (!assigned) results.push({ blockIdx: bo.bi, candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 });
        }
        return results;
    }

    function propagateAssignment(activityBlocks, assignedIdx, pick) {
        var block = activityBlocks[assignedIdx], startMin = block.startTime, endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) return;
        for (var i = 0; i < activityBlocks.length; i++) {
            if (i === assignedIdx || _assignedBlocks.has(i)) continue;
            var other = activityBlocks[i]; if (other.startTime === undefined || other.endTime === undefined) continue;
            if (other.startTime >= endMin || other.endTime <= startMin) continue;
            var domain = _domains.get(i); if (!domain) continue;
            for (var ci of Array.from(domain)) { if (wouldConflict(block, pick, other, allCandidateOptions[ci])) { domain.delete(ci); _perfCounters.domainPruned++; } }
        }
    }

    // ========================================================================
    // BACKJUMP SOLVER
    // ========================================================================

    function backjumpSolver(activityBlocks) {
        var unassigned = [];
        for (var i = 0; i < activityBlocks.length; i++) { if (!_assignedBlocks.has(i)) unassigned.push(i); }
        if (unassigned.length === 0) return 0;
        var iterations = 0, MAX_ITERATIONS = 50000, solved = 0;
        unassigned.sort(function(a, b) { return (_domains.get(a)?.size || 0) - (_domains.get(b)?.size || 0); });
        for (var bi of unassigned) {
            if (_assignedBlocks.has(bi) || iterations > MAX_ITERATIONS) break; iterations++;
            // ★★★ v13.0-FIX: Fresh cache for each backjump block ★★★
            _todayCache.clear();
            var block = activityBlocks[bi], domain = _domains.get(bi);
            if (!domain || domain.size === 0) {
                var lastChancePick = null;
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var lcScored = [];
                    for (var lci = 0; lci < allCandidateOptions.length; lci++) { var lcCand = allCandidateOptions[lci]; if (!isPickStillValid(block, lcCand)) continue; setScratchPick(lcCand); var lcCost = calculatePenaltyCost(block, _scratchPick); if (lcCost < 900000) lcScored.push({ ci: lci, cost: lcCost }); }
                    if (lcScored.length > 0) { lcScored.sort(function(x, y) { return x.cost - y.cost; }); lastChancePick = clonePick(allCandidateOptions[lcScored[0].ci]); }
                }
                _assignedBlocks.add(bi);
                if (lastChancePick) { _assignments.set(bi, { candIdx: -1, pick: lastChancePick, cost: 100000 }); applyPickToSchedule(block, lastChancePick); invalidateRotationCacheForBunk(block.bunk); _todayCache.clear(); }
                else { _assignments.set(bi, { candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 }); applyPickToSchedule(block, _assignments.get(bi).pick); }
                continue;
            }
            var scored = [];
            for (var ci of domain) { var cand = allCandidateOptions[ci]; if (!isPickStillValid(block, cand)) continue; setScratchPick(cand); var cost = calculatePenaltyCost(block, _scratchPick); if (cost < 900000) scored.push({ ci: ci, cost: cost }); }
            scored.sort(function(a, b) { return a.cost - b.cost; });
            if (scored.length > 0) {
                var best = scored[0], bestCand = allCandidateOptions[best.ci], bestPick = clonePick(bestCand);
                _assignedBlocks.add(bi); _assignments.set(bi, { candIdx: best.ci, pick: bestPick, cost: best.cost }); applyPickToSchedule(block, bestPick);                var fieldNorm = normName(bestPick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var bjActNorm = normName(bestPick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, bjActNorm);
                    if (bjActNorm && bjActNorm !== fieldNorm) addToFieldTimeIndex(bjActNorm, block.startTime, block.endTime, block.bunk, block.divName, bjActNorm);
                }
                invalidateRotationCacheForBunk(block.bunk); propagateAssignment(activityBlocks, bi, bestPick); solved++;
            } else {
                _assignedBlocks.add(bi); _assignments.set(bi, { candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 }); applyPickToSchedule(block, _assignments.get(bi).pick);
            }
        }
        v12Log('Backjump: ' + solved + '/' + unassigned.length + ' solved');
        return solved;
    }

  function isPickStillValid(block, cand) {
        var fieldName = cand.field, fieldNorm = cand._fieldNorm || normName(fieldName), bunk = block.bunk, blockDivName = block.divName || '', startMin = block.startTime, endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) return true;
        // ★★★ v14.2-FIX: Direct same-day repeat check (bypass stale cache) ★★★
        var candActNorm = normName(cand.activityName);
        if (candActNorm && candActNorm !== 'free' && candActNorm !== 'free play') {
            var bunkSlots = window.scheduleAssignments?.[bunk] || [];
            var mySlots = new Set(block.slots || []);
            for (var sdi = 0; sdi < bunkSlots.length; sdi++) {
                if (mySlots.has(sdi)) continue;
                var sdEntry = bunkSlots[sdi];
                if (!sdEntry || sdEntry.continuation || sdEntry._isTransition) continue;
                var sdAct = normName(sdEntry._activity || sdEntry.sport || sdEntry.field);
                if (sdAct === candActNorm) return false;
            }
        }
        // ★★★ FIX v13.1: Time-based global lock check for cross-division league conflicts ★★★
        if (isFieldLockedByTime(fieldName, startMin, endMin, blockDivName)) return false;
        var fieldProp = _fieldPropertyMap.get(fieldName);
        var capacity = fieldProp ? fieldProp.capacity : getFieldCapacity(fieldName);
        var sharingType = fieldProp ? fieldProp.sharingType : getSharingType(fieldName);
        if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) return false;
        if (sharingType === 'not_sharable') return getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) < capacity;
        return countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) < capacity;
    }

    // ========================================================================
    // POST-SOLVE LOCAL SEARCH + SWAP CHAINS
    // ========================================================================

    function postSolveLocalSearch(activityBlocks) {
        _todayCache.clear();
        var improvements = 0, swapChains = 0, MAX_SWAP_ATTEMPTS = 500;
        var freeBlocks = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var assignment = _assignments.get(i); if (!assignment) continue;
            var actNorm = normName(assignment.pick._activity || assignment.pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') freeBlocks.push(i);
        }
        if (freeBlocks.length === 0) return;
        // Pass 1: Direct improvement
        for (var bi of freeBlocks) {
            var block = activityBlocks[bi], domain = _domains.get(bi); if (!domain) continue;
            var scored = [];
            for (var ci of domain) { var cand = allCandidateOptions[ci]; if (!isPickStillValid(block, cand)) continue; setScratchPick(cand); var cost = calculatePenaltyCost(block, _scratchPick); if (cost < 900000) scored.push({ ci: ci, cost: cost }); }
            if (scored.length > 0) {
                scored.sort(function(a, b) { return a.cost - b.cost; });
                var best = scored[0], bestCand = allCandidateOptions[best.ci], bestPick = clonePick(bestCand);
                undoPickFromSchedule(block, _assignments.get(bi).pick);
                _assignments.set(bi, { candIdx: best.ci, pick: bestPick, cost: best.cost }); applyPickToSchedule(block, bestPick);
                var fieldNorm = normName(bestPick.field);
                if (block.startTime !== undefined && block.endTime !== undefined) {
                    var psActNorm = normName(bestPick._activity);
                    addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, psActNorm);
                    if (psActNorm && psActNorm !== fieldNorm) addToFieldTimeIndex(psActNorm, block.startTime, block.endTime, block.bunk, block.divName, psActNorm);
                }
                invalidateRotationCacheForBunk(block.bunk); improvements++;
            }
        }
        // Pass 2: Swap chains
        var remainingFree = [];
        for (var fi of freeBlocks) { var a = _assignments.get(fi); if (a && normName(a.pick._activity || a.pick.field) === 'free') remainingFree.push(fi); }
        var swapAttempts = 0;
        for (var freeIdx of remainingFree) {
            if (swapAttempts >= MAX_SWAP_ATTEMPTS) break;
            var freeBlock = activityBlocks[freeIdx], freeDomain = _domains.get(freeIdx);
            if (!freeDomain || freeDomain.size === 0) continue;
            var swapped = false;
            for (var ci2 of freeDomain) {
                if (swapped || swapAttempts >= MAX_SWAP_ATTEMPTS) break; swapAttempts++;
                var wantedCand = allCandidateOptions[ci2], wantedFieldNorm = wantedCand._fieldNorm;
                var entries = _fieldTimeIndex.get(wantedFieldNorm) || [];
                for (var e of entries) {
                    if (swapped) break;
                    if (e.bunk === freeBlock.bunk) continue;
                    if (freeBlock.startTime >= e.endMin || freeBlock.endTime <= e.startMin) continue;
                    var blockerIdx = findBlockIdx(activityBlocks, e.bunk, e.startMin, e.endMin);
                    if (blockerIdx === -1) continue;
                    var blockerDomain = _domains.get(blockerIdx); if (!blockerDomain) continue;
                    var blockerBlock = activityBlocks[blockerIdx], altScored = [];
                    for (var altCi of blockerDomain) {
                        var altCand = allCandidateOptions[altCi]; if (altCand._fieldNorm === wantedFieldNorm) continue;
                        if (!isPickStillValid(blockerBlock, altCand)) continue;
                        setScratchPick(altCand); var altCost = calculatePenaltyCost(blockerBlock, _scratchPick);
                        if (altCost < 900000) altScored.push({ ci: altCi, cost: altCost });
                    }
                    if (altScored.length > 0) {
                        altScored.sort(function(x, y) { return x.cost - y.cost; });
                        _todayCache.clear();
                        var wantedActNorm = normName(wantedCand.activityName);
                        if (wantedActNorm && wantedActNorm !== 'free' && wantedActNorm !== 'free play') {
                            var freeSlot = freeBlock.slots ? freeBlock.slots[0] : 999;
                            var todayForFree = getActivitiesDoneToday(freeBlock.bunk, freeSlot);
                            if (todayForFree.has(wantedActNorm)) continue;
                        }
                        if (blockerBlock.startTime !== undefined && blockerBlock.divName) {
                            var altBestCand = allCandidateOptions[altScored[0].ci];
                            if (checkCrossDivisionTimeConflict(altBestCand.field, blockerBlock.divName, blockerBlock.startTime, blockerBlock.endTime, blockerBlock.bunk)) continue;
                        }
                        // Execute swap
                        undoPickFromSchedule(blockerBlock, _assignments.get(blockerIdx).pick);
                        var altPick = clonePick(allCandidateOptions[altScored[0].ci]);
                        _assignments.set(blockerIdx, { candIdx: altScored[0].ci, pick: altPick, cost: altScored[0].cost }); applyPickToSchedule(blockerBlock, altPick);
                        undoPickFromSchedule(freeBlock, _assignments.get(freeIdx).pick);
                        var wantedPick = clonePick(wantedCand);
                        _todayCache.clear();
                        var wantedCost = calculatePenaltyCost(freeBlock, wantedPick);
                        _assignments.set(freeIdx, { candIdx: ci2, pick: wantedPick, cost: wantedCost }); applyPickToSchedule(freeBlock, wantedPick);
                        invalidateRotationCacheForBunk(blockerBlock.bunk); invalidateRotationCacheForBunk(freeBlock.bunk); _todayCache.clear();
                        swapChains++; swapped = true;
                    }
                }
            }
        }
        v12Log('Post-solve: ' + improvements + ' direct + ' + swapChains + ' swaps');
    }

    function findBlockIdx(activityBlocks, bunk, startMin, endMin) {
        for (var i = 0; i < activityBlocks.length; i++) { if (activityBlocks[i].bunk === bunk && activityBlocks[i].startTime === startMin && activityBlocks[i].endTime === endMin) return i; }
        return -1;
    }

    // ========================================================================
    // SCHEDULE APPLY / UNDO
    // ========================================================================

    function applyPickToSchedule(block, pick) {
        var bunk = block.bunk, slots = block.slots || [];
        if (!window.scheduleAssignments[bunk]) return;
        var fName = pick.field;
        for (var i = 0; i < slots.length; i++) {
            window.scheduleAssignments[bunk][slots[i]] = { field: fName, sport: pick.sport, continuation: i > 0, _fixed: false, _activity: pick._activity || fName, _fromSplitTile: block.fromSplitTile || false, _startMin: block.startTime, _endMin: block.endTime };
            if (window.fieldUsageBySlot && window.fieldUsageBySlot[slots[i]]) {
                if (!window.fieldUsageBySlot[slots[i]][fName]) window.fieldUsageBySlot[slots[i]][fName] = { count: 0, bunks: {} };
                window.fieldUsageBySlot[slots[i]][fName].count++;
                window.fieldUsageBySlot[slots[i]][fName].bunks[bunk] = pick.sport || pick._activity;
            }
        }
    }

    function undoPickFromSchedule(block, pick) {
        var bunk = block.bunk, slots = block.slots || [];
        if (!window.scheduleAssignments[bunk]) return;
        var fieldName = pick ? pick.field : null;
        for (var i = 0; i < slots.length; i++) {
            var slotIdx2 = slots[i]; window.scheduleAssignments[bunk][slotIdx2] = null;
            if (fieldName && window.fieldUsageBySlot?.[slotIdx2]?.[fieldName]) {
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
                if (actNorm && actNorm !== fieldNorm) removeFromFieldTimeIndex(actNorm, block.startTime, block.endTime, bunk);
            }
        }
        invalidateRotationCacheForBunk(bunk);
    }

    // ========================================================================
    // v12.4: DEEP FREE RESOLUTION
    // ========================================================================

    function deepFreeResolution(activityBlocks) {
        _todayCache.clear();
        var freeIndices = [];
        for (var i = 0; i < activityBlocks.length; i++) { var asgn = _assignments.get(i); if (!asgn) continue; var an = normName(asgn.pick._activity || asgn.pick.field); if (an === 'free' || an === 'free (timeout)') freeIndices.push(i); }
        if (freeIndices.length === 0) return 0;
        console.log('[SOLVER-v12.4] 🧠 Deep Free Resolution: ' + freeIndices.length + ' Free blocks');
        var divFree = {};
        for (var fi of freeIndices) { var dn = activityBlocks[fi].divName || ''; divFree[dn] = (divFree[dn] || 0) + 1; }
        freeIndices.sort(function(a, b) { return (divFree[activityBlocks[b].divName || ''] || 0) - (divFree[activityBlocks[a].divName || ''] || 0); });
        var resolved = 0;
        var disabledSet = window.currentDisabledFields || globalConfig?.disabledFields || [];
        for (var idx = 0; idx < freeIndices.length; idx++) {
            var bi = freeIndices[idx], block = activityBlocks[bi], bunk = block.bunk, blockDiv = block.divName || '';
            var startMin = block.startTime, endMin = block.endTime, slots = block.slots || [];
            if (startMin === undefined || endMin === undefined) continue;
            // Phase 1: Fresh scan
            _todayCache.clear();
            var fresh = [];
            for (var ci = 0; ci < allCandidateOptions.length; ci++) {
                var cand = allCandidateOptions[ci];
                if (disabledSet.indexOf(cand.field) !== -1) continue;
                if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) continue;
                // ★★★ FIX v13.1: Time-based lock check for cross-division league conflicts ★★★
                if (isFieldLockedByTime(cand.field, startMin, endMin, blockDiv)) continue;
                if (checkCrossDivisionTimeConflict(cand.field, blockDiv, startMin, endMin, bunk)) continue;
                var fp = _fieldPropertyMap.get(cand.field), cap = fp ? fp.capacity : getFieldCapacity(cand.field), sType = fp ? fp.sharingType : getSharingType(cand.field);
                if (sType === 'not_sharable') { if (getFieldUsageFromTimeIndex(cand._fieldNorm, startMin, endMin, bunk) >= cap) continue; }
                else { if (countSameDivisionUsage(cand.field, blockDiv, startMin, endMin, bunk) >= cap) continue; }
                var today = getActivitiesDoneToday(bunk, slots[0] ?? 999), candAct = normName(cand.activityName);
                if (candAct && candAct !== 'free' && candAct !== 'free play' && today.has(candAct)) continue;
                if (!activityProperties[cand.field] && !activityProperties[cand.activityName] && cand.type !== 'special') continue;
                if (window.SchedulerCoreUtils?.canBlockFit && !window.SchedulerCoreUtils.canBlockFit(block, cand.field, activityProperties, null, cand.activityName, false)) continue;
                setScratchPick(cand); var cost = calculatePenaltyCost(block, _scratchPick);
                if (cost < 900000) fresh.push({ ci: ci, cost: cost });
            }
            if (fresh.length > 0) {
                fresh.sort(function(a, b) { return a.cost - b.cost; });
                var pick = clonePick(allCandidateOptions[fresh[0].ci]);
                undoPickFromSchedule(block, _assignments.get(bi).pick);
                _assignments.set(bi, { candIdx: fresh[0].ci, pick: pick, cost: fresh[0].cost }); applyPickToSchedule(block, pick);
                var pfn = normName(pick.field); addToFieldTimeIndex(pfn, startMin, endMin, bunk, blockDiv, normName(pick._activity));
                var pan = normName(pick._activity); if (pan && pan !== pfn) addToFieldTimeIndex(pan, startMin, endMin, bunk, blockDiv, pan);
                invalidateRotationCacheForBunk(bunk); _todayCache.clear(); resolved++;
                console.log('[SOLVER-v12.4]    ✅ ' + bunk + ' → ' + pick.field + ' (' + pick._activity + ')');
                continue;
            }
            // Phase 2: Displacement
            var displaced = false;
            for (var otherBi = 0; otherBi < activityBlocks.length; otherBi++) {
                if (displaced) break;
                var otherBlock = activityBlocks[otherBi];
                if (otherBi === bi || otherBlock.divName !== blockDiv || otherBlock.bunk === bunk) continue;
                if (otherBlock.startTime === undefined || otherBlock.endTime === undefined) continue;
                if (otherBlock.startTime >= endMin || otherBlock.endTime <= startMin) continue;
                var otherAsgn = _assignments.get(otherBi); if (!otherAsgn || normName(otherAsgn.pick._activity) === 'free') continue;
                _todayCache.clear();
                var ourToday = getActivitiesDoneToday(bunk, slots[0] ?? 999);
                if (ourToday.has(normName(otherAsgn.pick._activity))) continue;
                var otherDom = _domains.get(otherBi); if (!otherDom || otherDom.size === 0) continue;
                var curFieldNorm = normName(otherAsgn.pick.field), alts = [];
                for (var altCi of otherDom) {
                    var altC = allCandidateOptions[altCi]; if (normName(altC.field) === curFieldNorm) continue;
                    if (!isPickStillValid(otherBlock, altC)) continue;
                    if (checkCrossDivisionTimeConflict(altC.field, otherBlock.divName, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk)) continue;
                    _todayCache.clear(); var theirToday = getActivitiesDoneToday(otherBlock.bunk, otherBlock.slots?.[0] ?? 999);
                    var altAct = normName(altC.activityName); if (altAct && altAct !== 'free' && theirToday.has(altAct)) continue;
                    setScratchPick(altC); var altCost = calculatePenaltyCost(otherBlock, _scratchPick);
                    if (altCost < 900000) alts.push({ ci: altCi, cost: altCost, cand: altC });
                }
                if (alts.length === 0) continue;
                alts.sort(function(a, b) { return a.cost - b.cost; });
                var saved = { candIdx: otherAsgn.candIdx, pick: otherAsgn.pick, cost: otherAsgn.cost };
                undoPickFromSchedule(otherBlock, otherAsgn.pick);
                var altPick = clonePick(alts[0].cand);
                _assignments.set(otherBi, { candIdx: alts[0].ci, pick: altPick, cost: alts[0].cost }); applyPickToSchedule(otherBlock, altPick);
                var altFn = normName(altPick.field);
                addToFieldTimeIndex(altFn, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk, otherBlock.divName, normName(altPick._activity));
                removeFromFieldTimeIndex(curFieldNorm, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk);
                invalidateRotationCacheForBunk(otherBlock.bunk); _todayCache.clear();
                // Can WE get something now?
                var postFresh = [];
                for (var pci = 0; pci < allCandidateOptions.length; pci++) {
                    var pC = allCandidateOptions[pci];
                    if (disabledSet.indexOf(pC.field) !== -1) continue;
                   if (window.GlobalFieldLocks?.isFieldLocked(pC.field, slots)) continue;
                    if (isFieldLockedByTime(pC.field, startMin, endMin, blockDiv)) continue;
                    if (checkCrossDivisionTimeConflict(pC.field, blockDiv, startMin, endMin, bunk)) continue;
                    var pfp = _fieldPropertyMap.get(pC.field), pCap = pfp ? pfp.capacity : getFieldCapacity(pC.field), pSt = pfp ? pfp.sharingType : getSharingType(pC.field);
                    if (pSt === 'not_sharable') { if (getFieldUsageFromTimeIndex(pC._fieldNorm, startMin, endMin, bunk) >= pCap) continue; }
                    else { if (countSameDivisionUsage(pC.field, blockDiv, startMin, endMin, bunk) >= pCap) continue; }
                    var pToday = getActivitiesDoneToday(bunk, slots[0] ?? 999), pAct = normName(pC.activityName);
                    if (pAct && pAct !== 'free' && pAct !== 'free play' && pToday.has(pAct)) continue;
                    if (!activityProperties[pC.field] && !activityProperties[pC.activityName] && pC.type !== 'special') continue;
                    setScratchPick(pC); var pCost = calculatePenaltyCost(block, _scratchPick);
                    if (pCost < 900000) postFresh.push({ ci: pci, cost: pCost });
                }
                if (postFresh.length > 0) {
                    postFresh.sort(function(a, b) { return a.cost - b.cost; });
                    var ourPick = clonePick(allCandidateOptions[postFresh[0].ci]);
                    undoPickFromSchedule(block, _assignments.get(bi).pick);
                    _assignments.set(bi, { candIdx: postFresh[0].ci, pick: ourPick, cost: postFresh[0].cost }); applyPickToSchedule(block, ourPick);
                    var ourFn = normName(ourPick.field); addToFieldTimeIndex(ourFn, startMin, endMin, bunk, blockDiv, normName(ourPick._activity));
                    var ourAn = normName(ourPick._activity); if (ourAn && ourAn !== ourFn) addToFieldTimeIndex(ourAn, startMin, endMin, bunk, blockDiv, ourAn);
                    invalidateRotationCacheForBunk(bunk); _todayCache.clear(); resolved++; displaced = true;
                    console.log('[SOLVER-v12.4]    🔄 ' + bunk + ' → ' + ourPick.field + ' [displaced ' + otherBlock.bunk + ' → ' + altPick.field + ']');
                } else {
                    undoPickFromSchedule(otherBlock, altPick); removeFromFieldTimeIndex(altFn, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk);
                    _assignments.set(otherBi, saved); applyPickToSchedule(otherBlock, saved.pick);
                    addToFieldTimeIndex(curFieldNorm, otherBlock.startTime, otherBlock.endTime, otherBlock.bunk, otherBlock.divName, normName(saved.pick._activity));
                    invalidateRotationCacheForBunk(otherBlock.bunk); _todayCache.clear();
                }
            }
        }
        console.log('[SOLVER-v12.4] 🧠 Complete: ' + resolved + '/' + freeIndices.length + ' resolved');
        return resolved;
    }

    // ========================================================================
    // v13.0: INTERNAL SOLVE PASS
    // ========================================================================

    function runSolvePass(activityBlocks, config, passNum, isShadow) {
        _passNumber = passNum;
        _rotationScoreCache.clear(); _todayCache.clear(); _assignedBlocks.clear(); _assignments.clear();
        _domains = null; _slotGroups = null; _activityPlan.clear(); _scarcityMap.clear();
        _perfCounters = { rotationCacheHits: 0, rotationCacheMisses: 0, timeIndexQueries: 0, domainPruned: 0, augmentingPathAttempts: 0, augmentingPathSuccesses: 0 };
        var savedSchedule = null, savedFieldUsage = null;
        if (isShadow) {
            savedSchedule = JSON.parse(JSON.stringify(window.scheduleAssignments || {}));
            savedFieldUsage = JSON.parse(JSON.stringify(window.fieldUsageBySlot || {}));
        }
        for (var bi = 0; bi < activityBlocks.length; bi++) {
            var blk = activityBlocks[bi];
            if (window.scheduleAssignments?.[blk.bunk]) {
                for (var si = 0; si < (blk.slots || []).length; si++) {
                    var slotIdx = blk.slots[si], existing = window.scheduleAssignments[blk.bunk][slotIdx];
                    if (existing && !existing._fixed && !existing._bunkOverride) {
                        window.scheduleAssignments[blk.bunk][slotIdx] = null;
                        if (existing.field && window.fieldUsageBySlot?.[slotIdx]?.[existing.field]) { var fu = window.fieldUsageBySlot[slotIdx][existing.field]; if (fu.bunks) delete fu.bunks[blk.bunk]; if (fu.count > 0) fu.count--; }
                    }
                }
            }
        }
        console.log('\n[SOLVER-v13] ═══ PASS ' + passNum + ' (' + (isShadow ? '✏️ PENCIL' : '🖊️ INK') + ') ═══');
        buildFieldTimeIndex();
        precomputeRotationScores(activityBlocks);
        activityFirstPlanner(activityBlocks);
        var fusedResult = buildDomainsAndSlotGroups(activityBlocks);
        _domains = fusedResult.domains; _slotGroups = fusedResult.slotGroups;
        propagateAC3(activityBlocks);
        solveSlotGroups(activityBlocks);
        if (activityBlocks.length - _assignedBlocks.size > 0) backjumpSolver(activityBlocks);
        postSolveLocalSearch(activityBlocks);
        deepFreeResolution(activityBlocks);
        var analysis = analyzePassResult(activityBlocks, passNum);
        if (isShadow) {
            for (var ubi = 0; ubi < activityBlocks.length; ubi++) {
                var uBlk = activityBlocks[ubi];
                if (window.scheduleAssignments?.[uBlk.bunk]) { for (var usi = 0; usi < (uBlk.slots || []).length; usi++) window.scheduleAssignments[uBlk.bunk][uBlk.slots[usi]] = null; }
            }
            window.scheduleAssignments = savedSchedule; window.fieldUsageBySlot = savedFieldUsage;
            buildFieldTimeIndex();
        }
        return analysis;
    }

    // ========================================================================
    // v13.0: MAIN SOLVER PIPELINE
    // ========================================================================

    Solver.solveSchedule = function (allBlocks, config) {
        var solveStartTime = performance.now();
        globalConfig = config; activityProperties = config.activityProperties || {};
        clearAllCaches(); clearBunkDivisionCache(); _activityDebt.clear();
        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!globalConfig.rotationHistory) globalConfig.rotationHistory = {};
        if (!globalConfig.rotationHistory.leagues) globalConfig.rotationHistory.leagues = {};
        var sorted = Solver.sortBlocksByDifficulty(allBlocks, config);
        var activityBlocks = sorted.filter(function(b) { return !b._isLeague; });
        if (window.RotationEngine?.clearHistoryCache) window.RotationEngine.clearHistoryCache();
        console.log('\n[SOLVER] ★★★ v13.0 — HUMAN-INTELLIGENT THREE-PASS SOLVER ★★★');
        console.log('[SOLVER] ' + activityBlocks.length + ' activity blocks to solve');
        var t1 = performance.now();
        allCandidateOptions = buildAllCandidateOptions(config);
        console.log('[SOLVER] Step 1: ' + allCandidateOptions.length + ' candidates (' + (performance.now() - t1).toFixed(1) + 'ms)');
        var t2 = performance.now(); buildFieldTimeIndex(); console.log('[SOLVER] Step 2: Time index (' + (performance.now() - t2).toFixed(1) + 'ms)');
        var t3 = performance.now(); precomputeFieldProperties(); console.log('[SOLVER] Step 3: Field props (' + _fieldPropertyMap.size + ') (' + (performance.now() - t3).toFixed(1) + 'ms)');
        var t4 = performance.now(); precomputeRotationScores(activityBlocks); console.log('[SOLVER] Step 4: Rotation scores (' + _rotationScoreMap.size + ') (' + (performance.now() - t4).toFixed(1) + 'ms)');
        var t45 = performance.now(); precomputeResourceMaps(activityBlocks); console.log('[SOLVER] Step 4.5: Resource maps (' + (performance.now() - t45).toFixed(1) + 'ms)');
        // THREE-PASS PIPELINE
        var MAX_PASSES = 3, bestAnalysis = null, passAnalyses = [];
        for (var passNum = 1; passNum <= MAX_PASSES; passNum++) {
            var isShadow = (passNum < MAX_PASSES);
            if (passNum > 1 && bestAnalysis && bestAnalysis.totalFree === 0 && bestAnalysis.yesterdayRepeats.length === 0 && bestAnalysis.playerViolations.filter(function(v) { return v.severity === 'hard'; }).length === 0) {
                console.log('[SOLVER-v13] ✨ Pass ' + (passNum - 1) + ' was perfect — committing!'); break;
            }
            if (passNum > 1 && bestAnalysis) adjustPlanFromAnalysis(activityBlocks, bestAnalysis);
            if (passNum === MAX_PASSES) isShadow = false;
            var analysis = runSolvePass(activityBlocks, config, passNum, isShadow);
            passAnalyses.push(analysis);
            if (!bestAnalysis || analysis.score < bestAnalysis.score) bestAnalysis = analysis;
            if (isShadow && analysis.totalFree === 0 && analysis.yesterdayRepeats.length === 0 && analysis.playerViolations.filter(function(v) { return v.severity === 'hard'; }).length === 0) {
                console.log('[SOLVER-v13] ✨ Pass ' + passNum + ' perfect — committing ink...');
                runSolvePass(activityBlocks, config, passNum + 1, false); passNum = MAX_PASSES;
            }
        }
        // REPORT
        var solveTime = performance.now() - solveStartTime, freeCount = 0;
        for (var [, ref] of _assignments) { var actNorm2 = normName(ref.pick._activity || ref.pick.field); if (actNorm2 === 'free' || actNorm2 === 'free (timeout)') freeCount++; }
        console.log('\n[SOLVER] ══════════════════════════════════════════');
        console.log('[SOLVER] ✅ v13.0 COMPLETE: ' + solveTime.toFixed(0) + 'ms (' + passAnalyses.length + ' passes)');
        console.log('[SOLVER]    ' + activityBlocks.length + ' blocks, ' + freeCount + ' Free');
        for (var pai = 0; pai < passAnalyses.length; pai++) { var pa = passAnalyses[pai]; console.log('[SOLVER]    Pass ' + pa.passNumber + ': Score=' + pa.score + ', Free=' + pa.totalFree + ', YdayRepeats=' + pa.yesterdayRepeats.length); }
        console.log('[SOLVER]    Plan: ' + _activityPlan.size + ' steered, Scarcity: ' + _scarcityMap.size + ', SmallBunks: ' + _smallBunkFlags.size);
        console.log('[SOLVER] ══════════════════════════════════════════\n');

        // STEP 10: Cross-Division Safety Sweep
        var crossDivFixes = 0, fieldTimeUsage = new Map();
        for (var sbi = 0; sbi < activityBlocks.length; sbi++) {
            var sBlock = activityBlocks[sbi], sAssign = _assignments.get(sbi);
            if (!sAssign || !sBlock.divName) continue;
            var sFieldNorm = normName(sAssign.pick.field); if (sFieldNorm === 'free') continue;
            var sStart = sBlock.startTime, sEnd = sBlock.endTime; if (sStart === undefined || sEnd === undefined) continue;
            var sKey = sFieldNorm + ':' + sStart + '-' + sEnd;
            if (!fieldTimeUsage.has(sKey)) fieldTimeUsage.set(sKey, []);
            fieldTimeUsage.get(sKey).push({ bi: sbi, div: sBlock.divName, bunk: sBlock.bunk, act: normName(sAssign.pick._activity || sAssign.pick.sport || sAssign.pick.field) });
        }
        for (var [ftKey, ftUsers] of fieldTimeUsage) {
            if (ftUsers.length < 2) continue;
            // Activity mismatch check
            var ftActivities = new Set();
            for (var ftai = 0; ftai < ftUsers.length; ftai++) { var ftAssign = _assignments.get(ftUsers[ftai].bi); if (ftAssign) { var ftAct = normName(ftAssign.pick._activity || ftAssign.pick.sport || ftAssign.pick.field); if (ftAct && ftAct !== 'free') ftActivities.add(ftAct); } }
            if (ftActivities.size > 1) {
                var keepAct = ftActivities.values().next().value;
                for (var ftmi = 0; ftmi < ftUsers.length; ftmi++) { var ftmAssign = _assignments.get(ftUsers[ftmi].bi); if (!ftmAssign) continue; var ftmAct = normName(ftmAssign.pick._activity || ftmAssign.pick.sport || ftmAssign.pick.field); if (ftmAct && ftmAct !== 'free' && ftmAct !== keepAct) { var mBlock = activityBlocks[ftUsers[ftmi].bi]; undoPickFromSchedule(mBlock, _assignments.get(ftUsers[ftmi].bi).pick); _assignments.set(ftUsers[ftmi].bi, { candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 }); applyPickToSchedule(mBlock, _assignments.get(ftUsers[ftmi].bi).pick); crossDivFixes++; } }
            }
            // Cross-division check
            var ftDivs = new Set(ftUsers.map(function(u) { return u.div; }));
            if (ftDivs.size <= 1) continue;
            var keepDiv = ftUsers[0].div;
            for (var fti = 1; fti < ftUsers.length; fti++) {
                if (ftUsers[fti].div !== keepDiv) {
                    var vBlock = activityBlocks[ftUsers[fti].bi]; undoPickFromSchedule(vBlock, _assignments.get(ftUsers[fti].bi).pick);
                    _assignments.set(ftUsers[fti].bi, { candIdx: -1, pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 }); applyPickToSchedule(vBlock, _assignments.get(ftUsers[fti].bi).pick);
                    crossDivFixes++;
                }
            }
        }
        if (crossDivFixes > 0) {
        console.warn('[SOLVER] ★★★ Fixed ' + crossDivFixes + ' cross-division violations ★★★');
        // ★★★ v14.1: Re-solve displaced blocks instead of leaving them as Free ★★★
        console.log('[SOLVER-v14.1] 🔄 Re-solving ' + crossDivFixes + ' displaced blocks...');
        _todayCache.clear();
        deepFreeResolution(activityBlocks);
        postSolveLocalSearch(activityBlocks);
        // Count remaining Free after re-solve
        var postCrossDivFree = 0;
        for (var pcdi = 0; pcdi < activityBlocks.length; pcdi++) {
            var pcdAssign = _assignments.get(pcdi);
            if (pcdAssign) { var pcdAct = normName(pcdAssign.pick._activity || pcdAssign.pick.field); if (pcdAct === 'free' || pcdAct === 'free (timeout)') postCrossDivFree++; }
        }
        console.log('[SOLVER-v14.1] ✅ Post cross-div re-solve: ' + postCrossDivFree + ' Free remaining');
    }

   // ★★★ v14.2-FIX: FINAL SAME-DAY DUPLICATE SWEEP ★★★
    {
        var dupFixCount = 0;
        var bunkActivityMap = new Map();
        for (var di = 0; di < activityBlocks.length; di++) {
            var dBlock = activityBlocks[di], dAssign = _assignments.get(di);
            if (!dAssign) continue;
            var dActNorm = normName(dAssign.pick._activity || dAssign.pick.field);
            if (!dActNorm || dActNorm === 'free' || dActNorm === 'free play') continue;
            if (!bunkActivityMap.has(dBlock.bunk)) bunkActivityMap.set(dBlock.bunk, new Map());
            var bunkMap = bunkActivityMap.get(dBlock.bunk);
            if (bunkMap.has(dActNorm)) {
                var existingIdx = bunkMap.get(dActNorm);
                var existingCost = _assignments.get(existingIdx)?.cost || 0;
                var currentCost = dAssign.cost || 0;
                var replaceIdx = currentCost >= existingCost ? di : existingIdx;
                var keepIdx = replaceIdx === di ? existingIdx : di;
                var replaceBlock = activityBlocks[replaceIdx];
                undoPickFromSchedule(replaceBlock, _assignments.get(replaceIdx).pick);
                var freePick = { field: "Free", sport: null, _activity: "Free" };
                _assignments.set(replaceIdx, { candIdx: -1, pick: freePick, cost: 100000 });
                applyPickToSchedule(replaceBlock, freePick);
                bunkMap.set(dActNorm, keepIdx);
                dupFixCount++;
                console.warn('[SOLVER-v14.2] 🔧 Fixed same-day dup: ' + dBlock.bunk + ' "' + dActNorm + '" twice → block ' + replaceIdx + ' → Free');
            } else {
                bunkMap.set(dActNorm, di);
            }
        }
        // Check against pinned/fixed entries not managed by solver
        for (var [dsBunk, dsActMap] of bunkActivityMap) {
            var dsBunkSlots = window.scheduleAssignments?.[dsBunk] || [];
            var solverSlots = new Set();
            for (var dsi2 = 0; dsi2 < activityBlocks.length; dsi2++) {
                if (activityBlocks[dsi2].bunk === dsBunk) {
                    (activityBlocks[dsi2].slots || []).forEach(function(s) { solverSlots.add(s); });
                }
            }
            for (var dssi = 0; dssi < dsBunkSlots.length; dssi++) {
                if (solverSlots.has(dssi)) continue;
                var dsEntry = dsBunkSlots[dssi];
                if (!dsEntry || dsEntry.continuation || dsEntry._isTransition) continue;
                var dsAct = normName(dsEntry._activity || dsEntry.sport || dsEntry.field);
                if (!dsAct || dsAct === 'free' || dsAct === 'free play') continue;
                if (dsActMap.has(dsAct)) {
                    var conflictIdx = dsActMap.get(dsAct);
                    var conflictBlock = activityBlocks[conflictIdx];
                    undoPickFromSchedule(conflictBlock, _assignments.get(conflictIdx).pick);
                    var freePick2 = { field: "Free", sport: null, _activity: "Free" };
                    _assignments.set(conflictIdx, { candIdx: -1, pick: freePick2, cost: 100000 });
                    applyPickToSchedule(conflictBlock, freePick2);
                    dsActMap.delete(dsAct);
                    dupFixCount++;
                    console.warn('[SOLVER-v14.2] 🔧 Fixed dup vs pinned: ' + dsBunk + ' "' + dsAct + '" solver block ' + conflictIdx + ' vs pinned slot ' + dssi);
                }
            }
        }
        if (dupFixCount > 0) {
            console.warn('[SOLVER-v14.2] ★★★ Fixed ' + dupFixCount + ' same-day duplicate(s) in final sweep ★★★');
            _todayCache.clear();
            deepFreeResolution(activityBlocks);
        }
    }
        var results = [];
        for (var idx = 0; idx < activityBlocks.length; idx++) {
            var blk = activityBlocks[idx], assignmentResult = _assignments.get(idx);
            var solution = assignmentResult ? assignmentResult.pick : { field: "Free", sport: null, _activity: "Free" };
            results.push({ block: blk, pick: solution, bunk: blk.bunk, slots: blk.slots, divName: blk.divName, cost: assignmentResult?.cost ?? 100000 });
        }
        return results;
    };

    // ========================================================================
    // LEGACY API
    // ========================================================================

    Solver.getValidActivityPicks = function (block) {
        var picks = [], slots = block.slots || [], bunk = block.bunk;
        var blockDivName = block.divName || block.division; if (!blockDivName) { blockDivName = getBunkDivision(bunk); if (blockDivName) block.divName = blockDivName; }
        var startMin = block.startTime, endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) { var divSlots = window.divisionTimes?.[blockDivName] || []; if (slots.length > 0 && divSlots[slots[0]]) { startMin = divSlots[slots[0]].startMin; endMin = divSlots[slots[slots.length - 1]]?.endMin || (startMin + 40); block.startTime = startMin; block.endTime = endMin; } }
        var hasValidTimes = startMin !== undefined && endMin !== undefined;
        var disabledFields = window.currentDisabledFields || globalConfig?.disabledFields || [];
        for (var cand of allCandidateOptions) {
            if (disabledFields.includes(cand.field)) continue;
            if (window.GlobalFieldLocks?.isFieldLocked(cand.field, slots)) continue;
            // ★★★ FIX v13.1: Time-based lock check for cross-division league conflicts ★★★
            if (hasValidTimes && isFieldLockedByTime(cand.field, startMin, endMin, blockDivName)) continue;
            var fieldName = cand.field, fieldNorm = cand._fieldNorm, capacity = getFieldCapacity(fieldName), sharingType = getSharingType(fieldName);
            if (hasValidTimes) {
                if (checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, bunk)) continue;
                if (sharingType === 'not_sharable') { if (getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, bunk) >= capacity) continue; }
                else { if (countSameDivisionUsage(fieldName, blockDivName, startMin, endMin, bunk) >= capacity) continue; }
            }
            if (!activityProperties[cand.field] && !activityProperties[cand.activityName] && cand.type !== 'special') continue;
            var rotationPenalty = getPrecomputedRotationScore(bunk, cand.activityName); if (rotationPenalty === Infinity) continue;
            var fits = window.SchedulerCoreUtils?.canBlockFit?.(block, cand.field, activityProperties, window.fieldUsageBySlot, cand.activityName, false); if (!fits) continue;
            var pick = clonePick(cand), cost = calculatePenaltyCost(block, pick);
            if (cost < 900000) picks.push({ pick: pick, cost: cost });
        }
        if (picks.length === 0 || !picks.some(function(p) { return p.pick?.field !== 'Free'; })) picks.push({ pick: { field: "Free", sport: null, _activity: "Free" }, cost: 100000 });
        return picks;
    };

    Solver.applyTentativePick = function (block, scored) {
        var pick = scored.pick; applyPickToSchedule(block, pick);
        var fieldNorm = normName(pick.field);
        if (block.startTime !== undefined && block.endTime !== undefined) { var tpActNorm = normName(pick._activity); addToFieldTimeIndex(fieldNorm, block.startTime, block.endTime, block.bunk, block.divName, tpActNorm); if (tpActNorm && tpActNorm !== fieldNorm) addToFieldTimeIndex(tpActNorm, block.startTime, block.endTime, block.bunk, block.divName, tpActNorm); }
        invalidateRotationCacheForBunk(block.bunk);
        return { block: block, pick: pick, bunk: block.bunk, startMin: block.startTime };
    };

    Solver.undoTentativePick = function (res) { undoPickFromSchedule(res.block, res.pick); };

    // ========================================================================
    // LEAGUE MATCHUP ENGINE
    // ========================================================================

    Solver.generateLeagueMatchups = function(teams, opts) {
        opts = opts || {}; var n = teams.length; if (n < 2) return [];
        var excludePairs = (opts.excludePairs || []).map(function(p) { return [normName(p[0]), normName(p[1])].sort().join('|'); });
        var teamList = teams.slice(); if (teamList.length % 2 !== 0) teamList.push("BYE");
        var totalTeams = teamList.length, rounds = [];
        for (var round = 0; round < totalTeams - 1; round++) {
            var matchups = [];
            for (var i = 0; i < totalTeams / 2; i++) { var t1 = teamList[i], t2 = teamList[totalTeams - 1 - i]; if (t1 === "BYE" || t2 === "BYE") continue; var pairKey = [normName(t1), normName(t2)].sort().join('|'); if (!excludePairs.includes(pairKey)) matchups.push({ team1: t1, team2: t2 }); }
            rounds.push(matchups); var last = teamList.pop(); teamList.splice(1, 0, last);
        }
        return rounds;
    };
    Solver.getLeagueMatchupsForRound = function(leagueName, teams, roundNumber) { var allRounds = Solver.generateLeagueMatchups(teams); return allRounds[(roundNumber - 1) % allRounds.length] || []; };
    Solver.assignFieldsToMatchups = function(matchups, availableFields, history, leagueName) {
        if (!matchups || matchups.length === 0) return [];
        if (!availableFields || availableFields.length === 0) return matchups;
        var fieldPool = availableFields.slice();
        return matchups.map(function(m, i) { return Object.assign({}, m, { field: fieldPool[i % fieldPool.length] }); });
    };

    // ========================================================================
    // DEBUG
    // ========================================================================

    Solver.debugCrossDivision = function(fieldName, divName, slotIdx) {
        var divSlots = window.divisionTimes?.[divName] || [], slot = divSlots[slotIdx]; if (!slot) { console.log('Slot not found'); return; }
        console.log('\n🔍 Cross-Division Check: "' + fieldName + '" at Div ' + divName + ' Slot ' + slotIdx + ' Time: ' + slot.startMin + '-' + slot.endMin);
        var entries = _fieldTimeIndex.get(normName(fieldName)) || [];
        entries.forEach(function(e) { if (e.startMin < slot.endMin && e.endMin > slot.startMin) console.log('    ⚠️ OVERLAP: Div ' + e.divName + ' Bunk ' + e.bunk + ' (' + e.startMin + '-' + e.endMin + ')'); });
    };
    Solver.debugSolverStats = function() {
        console.log('\n=== SOLVER v13.0 STATS ===');
        console.log('Field property map: ' + _fieldPropertyMap.size + ', Rotation score map: ' + _rotationScoreMap.size);
        console.log('Field time index: ' + _fieldTimeIndex.size + ' fields, Assigned: ' + _assignedBlocks.size);
        console.log('Aug path: ' + _perfCounters.augmentingPathAttempts + ' attempts, ' + _perfCounters.augmentingPathSuccesses + ' successes');
    };
    Solver.debugDomains = function(blockIdx) {
        if (!_domains) { console.log('No domains'); return; } var d = _domains.get(blockIdx); if (!d) { console.log('No domain for block ' + blockIdx); return; }
        console.log('Block ' + blockIdx + ': ' + d.size + ' options');
        for (var ci of d) { var c = allCandidateOptions[ci]; console.log('  [' + ci + '] ' + c.field + ' -> ' + c.activityName); }
    };

    // ========================================================================
    // EXPOSE
    // ========================================================================

    window.totalSolverEngine = Solver;
    window.TotalSolver = Solver;

})();
