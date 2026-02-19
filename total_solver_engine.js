
// ============================================================================
// total_solver_engine_part1.js (v15.0 — FULL-GRADE + RAINY DAY)
// ============================================================================
// ★★★ v15.0: FULL-GRADE = PER GRADE (e.g. "1st Grade"), NOT per division ★★★
// ★★★ v15.0: RAINY DAY CAPACITY + TIME-RULE OVERRIDES BUILT INTO SOLVER ★★★
// ★★★ v14.2: FINAL SAME-DAY DUPLICATE SWEEP ★★★
// ★★★ v13.0: ACTIVITY-FIRST PLANNER + THREE-PASS SIMULATION ★★★
//
// PART 1: Infrastructure (loaded first)
//   - Namespace, caches, logging
//   - Name normalization, rotation config
//   - Bunk→Grade cache (divName = grade like "1st Grade")
//   - ★ Rainy day detection + capacity/time overrides (v15.0)
//   - Pre-computed field property map (rainy-aware)
//   - Sorted time index + all query helpers
//   - Time-based global field lock check
//   - Batched rotation scoring
//   - Today activities cache
//   - Candidate options builder
//   - Scratch pick helpers
//   - ★ Penalty engine with fullGrade steering bonus (v15.0)
//   - Block sorting
//   - Resource maps, skeleton context (v13.0)
//   - Activity-First Planner (v13.0)
//   - Pass analysis + adjustment
//   - Schedule apply / undo
//   - Expose _SolverInternals to Part 2
// ============================================================================

(function () {
    'use strict';

    var Solver = {};
    var MAX_MATCHUP_ITERATIONS = 2000;

    var DEBUG_MODE = false;
    var DEBUG_ROTATION = false;
    var DEBUG_CROSS_DIV = false;
    var DEBUG_V12 = false;

    var globalConfig = null;
    var activityProperties = {};
    var allCandidateOptions = [];

    // ========================================================================
    // SOLVER-WIDE CACHES
    // ========================================================================
    var _normalizedNames = new Map();
    var _rotationScoreCache = new Map();
    var _todayCache = new Map();
    var _fieldTimeIndex = new Map();
    var _fieldPropertyMap = new Map();
    var _rotationScoreMap = new Map();
    var _bunkDivisionCache = new Map();

    var _domains = null;
    var _slotGroups = null;
    var _assignedBlocks = new Set();
    var _assignments = new Map();

    // v13.0: Activity-First Planner state
    var _activityPlan = new Map();
    var _activityDebt = new Map();
    var _scarcityMap = new Map();
    var _uniqueFieldMap = new Map();
    var _timeConstrainedBoost = new Map();
    var _skeletonContext = new Map();
    var _smallBunkFlags = new Set();
    var _passNumber = 0;
    var _passAnalysis = null;

    // ★★★ v15.0: Rainy day state (cached once per solve) ★★★
    var _isRainyDay = false;
    var _rainyCapOverrides = new Map();   // fieldName → overridden capacity int
    var _rainyTimeBypasses = new Set();   // fieldNames that ignore time rules on rainy days

    var _perfCounters = {
        rotationCacheHits: 0, rotationCacheMisses: 0,
        timeIndexQueries: 0, domainPruned: 0,
        augmentingPathAttempts: 0, augmentingPathSuccesses: 0
    };

    function clearAllCaches() {
        _rotationScoreCache.clear(); _todayCache.clear();
        _assignedBlocks.clear(); _assignments.clear();
        _fieldPropertyMap.clear(); _rotationScoreMap.clear();
        _domains = null; _slotGroups = null;
        _activityPlan.clear(); _scarcityMap.clear(); _skeletonContext.clear();
        _isRainyDay = false; _rainyCapOverrides.clear(); _rainyTimeBypasses.clear();
        _perfCounters = { rotationCacheHits: 0, rotationCacheMisses: 0, timeIndexQueries: 0, domainPruned: 0, augmentingPathAttempts: 0, augmentingPathSuccesses: 0 };
    }

    // ========================================================================
    // LOGGING
    // ========================================================================
    function debugLog() { if (DEBUG_MODE) console.log.apply(console, ['[SOLVER]'].concat(Array.from(arguments))); }
    function rotationLog() { if (DEBUG_ROTATION) console.log.apply(console, ['[ROTATION]'].concat(Array.from(arguments))); }
    function crossDivLog() { if (DEBUG_CROSS_DIV) console.log.apply(console, ['[CROSS-DIV]'].concat(Array.from(arguments))); }
    function v12Log() { if (DEBUG_V12) console.log.apply(console, ['[v12]'].concat(Array.from(arguments))); }

    // ========================================================================
    // NAME NORMALIZATION
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
    // ROTATION CONFIG (delegates to RotationEngine)
    // ========================================================================
    var ROTATION_CONFIG = new Proxy({}, {
        get: function(target, prop) {
            if (window.RotationEngine?.CONFIG?.[prop] !== undefined) return window.RotationEngine.CONFIG[prop];
            var defaults = { YESTERDAY_PENALTY: 12000, TWO_DAYS_AGO_PENALTY: 8000, THREE_DAYS_AGO_PENALTY: 5000, SAME_DAY_PENALTY: Infinity, TIE_BREAKER_RANDOMNESS: 300, ADJACENT_BUNK_BONUS: -150, NEARBY_BUNK_BONUS: -100 };
            return defaults[prop] !== undefined ? defaults[prop] : 0;
        }
    });

    // ========================================================================
    // BUNK → GRADE CACHE
    // In Campistry, divName = grade (e.g. "1st Grade"), NOT the parent
    // division ("Juniors"). getBunkDivision returns the GRADE name.
    // ========================================================================
    function getBunkDivision(bunkName) {
        if (!bunkName) return '';
        var cached = _bunkDivisionCache.get(bunkName);
        if (cached !== undefined) return cached;
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            var div = window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
            _bunkDivisionCache.set(bunkName, div || ''); return div || '';
        }
        var divisions = window.divisions || {};
        for (var divName in divisions) {
            var bunks = divisions[divName]?.bunks || [];
            if (bunks.indexOf(bunkName) !== -1) { _bunkDivisionCache.set(bunkName, divName); return divName; }
        }
        _bunkDivisionCache.set(bunkName, ''); return '';
    }
    function clearBunkDivisionCache() { _bunkDivisionCache.clear(); }
    function getBunkNumber(bunkName) {
        if (!bunkName) return null;
        var m = String(bunkName).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // ========================================================================
    // ★★★ v15.0: RAINY DAY DETECTION + OVERRIDE CACHE ★★★
    // Called ONCE at the start of each solve cycle. Caches:
    //   _isRainyDay — boolean
    //   _rainyCapOverrides — Map<fieldName, capacity>
    //   _rainyTimeBypasses — Set<fieldName> (fields whose timeRules are ignored)
    // ========================================================================
    function detectRainyDayMode(config) {
        _isRainyDay = false;
        _rainyCapOverrides.clear();
        _rainyTimeBypasses.clear();

        // 1. Check every source of rainy-day truth
        if (config?.isRainyDayMode === true) _isRainyDay = true;
        if (!_isRainyDay) { try { if (window.isRainyDayModeActive?.()) _isRainyDay = true; } catch(e) {} }
        if (!_isRainyDay && window.isRainyDay === true) _isRainyDay = true;
        if (!_isRainyDay) { try { var d = window.loadCurrentDailyData?.() || {}; if (d.rainyDayMode === true || d.isRainyDay === true) _isRainyDay = true; } catch(e) {} }

        if (!_isRainyDay) return; // normal day, nothing to override

        // 2. Scan fields and specials for capacity overrides + time bypasses
        try {
            var gs = window.loadGlobalSettings?.() || {};
            var fields = gs.app1?.fields || gs.fields || [];
            for (var i = 0; i < fields.length; i++) {
                var f = fields[i]; if (!f || !f.name) continue;
                if (f.rainyDayCapacity > 0) {
                    _rainyCapOverrides.set(f.name, parseInt(f.rainyDayCapacity, 10));
                }
                if (f.rainyDayAvailableAllDay === true && f.timeRules && f.timeRules.length > 0) {
                    _rainyTimeBypasses.add(f.name);
                }
            }
            var specials = gs.app1?.specialActivities || [];
            for (var j = 0; j < specials.length; j++) {
                var s = specials[j]; if (!s || !s.name) continue;
                if (s.rainyDayCapacity > 0) {
                    _rainyCapOverrides.set(s.name, parseInt(s.rainyDayCapacity, 10));
                }
                if (s.rainyDayAvailableAllDay === true && s.timeRules && s.timeRules.length > 0) {
                    _rainyTimeBypasses.add(s.name);
                }
            }
        } catch(e) { console.warn('[SOLVER] Rainy day override scan error:', e); }

        console.log('[SOLVER-v15] 🌧️ RAINY DAY MODE ACTIVE');
        if (_rainyCapOverrides.size > 0) console.log('[SOLVER-v15]    📊 Capacity overrides: ' + Array.from(_rainyCapOverrides.entries()).map(function(e) { return e[0] + '→' + e[1]; }).join(', '));
        if (_rainyTimeBypasses.size > 0) console.log('[SOLVER-v15]    ⏰ Time bypasses: ' + Array.from(_rainyTimeBypasses).join(', '));
    }

    // ========================================================================
    // FIELD PROPERTY MAP (★ rainy-day aware capacities + time bypass)
    // ========================================================================
    function precomputeFieldProperties() {
        _fieldPropertyMap.clear();
        var props = activityProperties || {};
        var _storedFieldProps = {};
        try {
            var gs = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            var storedFields = gs.fields || gs.app1?.fields || [];
            for (var fi = 0; fi < storedFields.length; fi++) { var sf = storedFields[fi]; if (sf && sf.name) _storedFieldProps[sf.name] = sf; }
        } catch(e) {}

        for (var i = 0; i < allCandidateOptions.length; i++) {
            var cand = allCandidateOptions[i];
            var fieldName = cand.field;
            if (_fieldPropertyMap.has(fieldName)) continue;
            var fieldProps = props[fieldName] || _storedFieldProps[fieldName] || {};
            if (!fieldProps.sharableWith && !fieldProps.sharable && _storedFieldProps[fieldName]) fieldProps = _storedFieldProps[fieldName];

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

            // ★★★ v15.0: RAINY DAY CAPACITY OVERRIDE ★★★
            if (_isRainyDay && _rainyCapOverrides.has(fieldName)) {
                var rainCap = _rainyCapOverrides.get(fieldName);
                if (rainCap > capacity) {
                    v12Log('🌧️ Capacity override: ' + fieldName + ' ' + capacity + ' → ' + rainCap);
                    capacity = rainCap;
                    // If field was not_sharable but now has higher capacity, upgrade sharing
                    if (sharingType === 'not_sharable' && capacity > 1) sharingType = 'same_division';
                }
            }

            var prefProps = fieldProps;
            if (!prefProps?.preferences?.enabled) { var actProps = props[cand.activityName]; if (actProps?.preferences?.enabled) prefProps = actProps; }
            if (prefProps?.preferences?.enabled) { prefList = prefProps.preferences.list || []; prefExclusive = !!prefProps.preferences.exclusive; }

            _fieldPropertyMap.set(fieldName, { capacity: capacity, sharingType: sharingType, prefList: prefList, prefExclusive: prefExclusive, hasProps: true });
        }
        v12Log('Field properties pre-computed: ' + _fieldPropertyMap.size + ' fields' + (_isRainyDay ? ' (🌧️ rainy overrides applied)' : ''));
    }

    function getFieldCapacity(fieldName) {
        var cached = _fieldPropertyMap.get(fieldName);
        if (cached) return cached.capacity;
        // ★ Rainy day fallback for fields not in candidate list
        if (_isRainyDay && _rainyCapOverrides.has(fieldName)) return _rainyCapOverrides.get(fieldName);
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
                    for (var name of names) addToFieldTimeIndex(name, slot.startMin, slot.endMin, bunk, divName, entryActivityNorm);
                }
            }
        }
        for (var [key, entries] of _fieldTimeIndex) entries.sort(function(a, b) { return a.startMin - b.startMin; });
        v12Log('Field time index built: ' + _fieldTimeIndex.size + ' entries (sorted)');
    }

    function addToFieldTimeIndex(fieldNorm, startMin, endMin, bunk, divName, activityName) {
        if (!_fieldTimeIndex.has(fieldNorm)) _fieldTimeIndex.set(fieldNorm, []);
        var entries = _fieldTimeIndex.get(fieldNorm);
        entries.push({ startMin: startMin, endMin: endMin, bunk: bunk, divName: divName, activityName: activityName || '' });
        if (entries.length > 1 && entries[entries.length - 1].startMin < entries[entries.length - 2].startMin) entries.sort(function(a, b) { return a.startMin - b.startMin; });
    }
    function removeFromFieldTimeIndex(fieldNorm, startMin, endMin, bunk) {
        var entries = _fieldTimeIndex.get(fieldNorm); if (!entries) return;
        var idx = entries.findIndex(function(e) { return e.bunk === bunk && e.startMin === startMin && e.endMin === endMin; });
        if (idx !== -1) entries.splice(idx, 1);
    }
    function findFirstOverlapIndex(entries, queryStart, queryEnd) {
        var lo = 0, hi = entries.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (entries[mid].startMin >= queryEnd) hi = mid; else lo = mid + 1; }
        return lo;
    }
    function getFieldUsageFromTimeIndex(fieldNorm, startMin, endMin, excludeBunk) {
        _perfCounters.timeIndexQueries++;
        var entries = _fieldTimeIndex.get(fieldNorm);
        if (!entries || entries.length === 0) return 0;
        var count = 0, upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) { var e = entries[i]; if (e.bunk === excludeBunk) continue; if (e.endMin > startMin) count++; }
        return count;
    }
    function checkCrossDivisionTimeConflict(fieldName, blockDivName, startMin, endMin, excludeBunk) {
        if (startMin === undefined || endMin === undefined) return null;
        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm); if (!entries) return null;
        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) {
            var e = entries[i];
            if (e.divName === blockDivName) continue;
            if (e.bunk === excludeBunk) continue;
            if (e.endMin > startMin) return { conflictingDiv: e.divName, conflictingBunk: e.bunk, theirTime: e.startMin + '-' + e.endMin, ourTime: startMin + '-' + endMin, overlapTime: Math.max(startMin, e.startMin) + '-' + Math.min(endMin, e.endMin) };
        }
        return null;
    }
    function countSameDivisionUsage(fieldName, divisionName, startMin, endMin, excludeBunk) {
        var fieldNorm = normName(fieldName);
        var entries = _fieldTimeIndex.get(fieldNorm); if (!entries) return 0;
        var count = 0, upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) { var e = entries[i]; if (e.divName !== divisionName) continue; if (e.bunk === excludeBunk) continue; if (e.endMin > startMin) count++; }
        return count;
    }
    function checkSameFieldActivityMismatch(fieldName, startMin, endMin, activityName, excludeBunk) {
        if (!activityName || activityName === 'Free' || activityName === 'free') return null;
        var fieldNorm = normName(fieldName), actNorm = normName(activityName);
        var entries = _fieldTimeIndex.get(fieldNorm); if (!entries) return null;
        var upperBound = findFirstOverlapIndex(entries, startMin, endMin);
        for (var i = 0; i < upperBound; i++) { var e = entries[i]; if (e.bunk === excludeBunk) continue; if (e.endMin <= startMin) continue; if (e.activityName && e.activityName !== actNorm) return e.activityName; }
        return null;
    }

    // ========================================================================
    // TIME-BASED GLOBAL FIELD LOCK CHECK
    // ========================================================================
    function isFieldLockedByTime(fieldName, startMin, endMin, divisionContext) {
        var GFL = window.GlobalFieldLocks;
        if (!GFL || !GFL._initialized || !GFL._locks) return false;
        if (!fieldName || startMin == null || endMin == null) return false;
        if (GFL.isFieldLockedByTime) return !!GFL.isFieldLockedByTime(fieldName, startMin, endMin, divisionContext);
        var normalizedField = fieldName.toLowerCase().trim();
        for (var slotIdx in GFL._locks) {
            var slotLocks = GFL._locks[slotIdx]; if (!slotLocks || !slotLocks[normalizedField]) continue;
            var lock = slotLocks[normalizedField];
            if (lock.lockType === 'division' && lock.allowedDivision && divisionContext && divisionContext === lock.allowedDivision) continue;
            var lockStartMin = lock.startMin, lockEndMin = lock.endMin;
            if (lockStartMin == null || lockEndMin == null) {
                var lockDiv = lock.division; if (lockDiv) { var firstDiv = lockDiv.split(',')[0].trim(); var divSlots = window.divisionTimes?.[firstDiv] || []; var slot = divSlots[parseInt(slotIdx, 10)]; if (slot) { lockStartMin = slot.startMin; lockEndMin = slot.endMin; } }
            }
            if (lockStartMin == null || lockEndMin == null) continue;
            if (lockStartMin < endMin && lockEndMin > startMin) return true;
        }
        return false;
    }

    // ========================================================================
    // BATCHED ROTATION SCORING
    // ========================================================================
    function precomputeRotationScores(activityBlocks) {
        _rotationScoreMap.clear();
        var bunkSet = new Set(), actSet = new Set();
        for (var i = 0; i < activityBlocks.length; i++) bunkSet.add(activityBlocks[i].bunk);
        for (var j = 0; j < allCandidateOptions.length; j++) actSet.add(allCandidateOptions[j].activityName);
        var scored = 0;
        for (var bunk of bunkSet) {
            var divName = getBunkDivision(bunk);
            for (var actName of actSet) {
                if (!actName || actName === 'Free') continue;
                var key = bunk + '|' + actName; if (_rotationScoreMap.has(key)) continue;
                var score;
                if (window.RotationEngine?.calculateRotationScore) score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: actName, divisionName: divName, beforeSlotIndex: 0, allActivities: null, activityProperties: activityProperties });
                else { var todayActivities = getActivitiesDoneToday(bunk, 999); score = todayActivities.has(normName(actName)) ? Infinity : 0; }
                _rotationScoreMap.set(key, score); scored++;
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
        var cached = _rotationScoreCache.get(key); if (cached !== undefined) return cached;
        var score;
        if (window.RotationEngine?.calculateRotationScore) score = window.RotationEngine.calculateRotationScore({ bunkName: bunk, activityName: activityName, divisionName: getBunkDivision(bunk), beforeSlotIndex: 999, allActivities: null, activityProperties: activityProperties });
        else { var todayActivities = getActivitiesDoneToday(bunk, 999); score = todayActivities.has(normName(activityName)) ? Infinity : 0; }
        _rotationScoreCache.set(key, score); _rotationScoreMap.set(key, score); return score;
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
        var cached = _todayCache.get(cacheKey); if (cached) return cached;
        var activities = new Set();
        var assignments = window.scheduleAssignments?.[bunk] || [];
        for (var i = 0; i < Math.min(beforeSlotIndex, assignments.length); i++) {
            var entry = assignments[i]; if (!entry || entry.continuation) continue;
            var act = normName(entry._activity || entry.sport || entry.field);
            if (act && act !== 'free' && act !== 'free play') activities.add(act);
        }
        _todayCache.set(cacheKey, activities); return activities;
    }
    function getDaysSinceActivity(bunk, activityName) { if (window.RotationEngine?.getDaysSinceActivity) return window.RotationEngine.getDaysSinceActivity(bunk, activityName, 0); return null; }
    function getActivityCount(bunk, activityName) {
        if (window.RotationEngine?.getActivityCount) return window.RotationEngine.getActivityCount(bunk, activityName);
        var globalSettings = window.loadGlobalSettings?.() || {};
        var historicalCounts = globalConfig?.historicalCounts || globalSettings.historicalCounts || {};
        var manualOffsets = globalSettings.manualUsageOffsets || {};
        return Math.max(0, (historicalCounts[bunk]?.[activityName] || 0) + (manualOffsets[bunk]?.[activityName] || 0));
    }

    // ========================================================================
    // CANDIDATE OPTIONS BUILDER
    // ========================================================================
    var KNOWN_SPORTS = new Set(['hockey','soccer','football','baseball','kickball','basketball','lineup','running bases','newcomb','volleyball','dodgeball','general activity slot','sports slot','special activity','ga slot','sport slot','free','free play']);
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
        var options = [], seenKeys = new Set();
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
            if (!seenKeys.has(key)) { seenKeys.add(key); options.push({ field: s.name, sport: null, activityName: s.name, type: 'special', _fieldNorm: normName(s.name), _actNorm: normName(s.name), _fullGrade: s.fullGrade === true }); }
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
    // SCRATCH PICK HELPERS
    // ========================================================================
    var _scratchPick = { field: '', sport: null, _activity: '', _type: '' };
    function setScratchPick(cand) { _scratchPick.field = cand.field; _scratchPick.sport = cand.sport; _scratchPick._activity = cand.activityName; _scratchPick._type = cand.type; return _scratchPick; }
    function clonePick(cand) { return { field: cand.field, sport: cand.sport, _activity: cand.activityName, _type: cand.type, _fullGrade: cand._fullGrade || false }; }

    // ========================================================================
    // PENALTY ENGINE (v15.0 — rainy-aware, fullGrade bonus, plan steering)
    // ========================================================================
    function calculatePenaltyCost(block, pick) {
        var bunk = block.bunk, act = pick._activity, fieldName = pick.field;
        var actNorm = normName(act), fieldNorm = normName(fieldName);
        var blockDivName = block.divName || '', blockStart = block.startTime, blockEnd = block.endTime;
        var slots = block.slots || [];
        var penalty = 0;

        // === HARD CONSTRAINTS ===
        if (actNorm && actNorm !== 'free' && actNorm !== 'free play') {
            var todayDone = getActivitiesDoneToday(bunk, slots[0] ?? 999);
            if (todayDone.has(actNorm)) return 999999;
           // v14.3: Direct live check — also check field name for robustness
            var liveSlots = window.scheduleAssignments?.[bunk] || [];
            var mySlotSet = new Set(slots);
            for (var lsi = 0; lsi < liveSlots.length; lsi++) {
                if (mySlotSet.has(lsi)) continue;
                var lsEntry = liveSlots[lsi];
                if (!lsEntry || lsEntry.continuation || lsEntry._isTransition) continue;
                var lsAct = normName(lsEntry._activity || lsEntry.sport || '');
                var lsField = normName(lsEntry.field || '');
                if ((lsAct && lsAct === actNorm) || (lsField && lsField !== 'free' && lsAct === actNorm)) return 999999;
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
        if (fieldProp?.prefList) { if (fieldProp.prefList.indexOf(blockDivName) === -1 && fieldProp.prefExclusive) return 999999; }
        else { var actPrefProps = activityProperties[act]; if (actPrefProps?.preferences?.enabled && (actPrefProps.preferences.list || []).indexOf(blockDivName) === -1 && actPrefProps.preferences.exclusive) return 999999; }
        var rotationPenalty = getPrecomputedRotationScore(bunk, act);
        if (rotationPenalty === Infinity) return 999999;
        var specialRule = activityProperties[act];
        if (specialRule?.maxUsage > 0) {
            var hist = getActivityCount(bunk, act);
            var todayCount = getActivitiesDoneToday(bunk, slots[0] || 999).has(actNorm) ? 1 : 0;
            if (hist + todayCount >= specialRule.maxUsage) return 999999;
        }

        // ★★★ v15.0: RAINY DAY TIME-RULE CHECK ★★★
        // If it's a rainy day and this field has rainyDayAvailableAllDay, skip time rule rejection.
        // Otherwise, existing time-rule logic in domain building handles it.

        // === SOFT PENALTIES ===
        penalty += rotationPenalty;
        if (actNorm === 'free' || fieldName === 'Free') penalty += 100000;

        // Type balance for GA Slots
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
        // Bunk size
        var bunkMeta = window.getBunkMetaData?.(bunk) || globalConfig?.bunkMetaData?.[bunk] || {};
        if (bunkMeta.size) { var apCap = activityProperties[fieldName]?.capacity; if (apCap && bunkMeta.size > apCap) penalty += 5000; }
        // Division preferences
        if (fieldProp?.prefList) { var prefIdx = fieldProp.prefList.indexOf(blockDivName); if (prefIdx !== -1) penalty -= (50 - prefIdx * 5); else penalty += 8000; }
        else { var actPrefProps2 = activityProperties[act]; if (actPrefProps2?.preferences?.enabled) { var prefIdx2 = (actPrefProps2.preferences.list || []).indexOf(blockDivName); if (prefIdx2 !== -1) penalty -= (50 - prefIdx2 * 5); else penalty += 8000; } }

        // Sharing incentive
        if (fieldName && fieldName !== 'Free' && slots.length > 0 && blockStart !== undefined && blockEnd !== undefined) {
            var sharingEntries = _fieldTimeIndex.get(fieldNorm) || [];
            var fieldOccupied = false, sameActivityOnField = false;
            for (var sei = 0; sei < sharingEntries.length; sei++) { var se = sharingEntries[sei]; if (se.bunk === bunk) continue; if (se.endMin <= blockStart || se.startMin >= blockEnd) continue; fieldOccupied = true; if (se.activityName && se.activityName === actNorm) sameActivityOnField = true; }
           if (sameActivityOnField) penalty -= 1500;
else if (fieldOccupied) penalty += 500;
else penalty += 200;
        }
        // Fill-to-capacity
        if (fieldName && fieldName !== 'Free' && blockStart !== undefined && blockEnd !== undefined) {
            var fcFp = _fieldPropertyMap.get(fieldName);
            var fcCap = fcFp ? fcFp.capacity : getFieldCapacity(fieldName);
            var fcSameDiv = 0, fcSameAct = true;
            var fcEntries = _fieldTimeIndex.get(fieldNorm) || [];
            for (var fci = 0; fci < fcEntries.length; fci++) { var fce = fcEntries[fci]; if (fce.bunk === bunk) continue; if (fce.endMin <= blockStart || fce.startMin >= blockEnd) continue; if (fce.divName === blockDivName) { fcSameDiv++; if (fce.activityName && fce.activityName !== actNorm) fcSameAct = false; } }
            if (fcCap > 1 && fcSameAct) {
                var spotsLeft = fcCap - 1 - fcSameDiv;
                if (fcSameDiv > 0 && spotsLeft >= 0) { var fillRatio = fcSameDiv / (fcCap - 1); penalty -= Math.round(1500 + (fillRatio * 2000)); }
                if (fcSameDiv === 0 && fcCap > 1) penalty += 500;
            }
        }
        // Adjacent bunk distance
        if (slots.length > 0 && window.fieldUsageBySlot) {
            var slotUsage = window.fieldUsageBySlot[slots[0]]?.[fieldName];
            if (slotUsage?.bunks) { var myNum = getBunkNumber(bunk) || 0; for (var otherBunk in slotUsage.bunks) { if (otherBunk === bunk) continue; var distance = Math.abs((getBunkNumber(otherBunk) || 0) - myNum); if (distance === 1) penalty -= 500; else if (distance <= 3) penalty -= 300; else penalty -= 100; } }
        }
        // v13.0: Plan steering
        if (_activityPlan.size > 0 && block._blockIdx !== undefined) { var planEntry = _activityPlan.get(block._blockIdx); if (planEntry) { if (normName(planEntry.activity) === actNorm) penalty += planEntry.steering; else penalty += 2000; } }
        // Scarcity
        if (fieldName && fieldName !== 'Free' && blockStart !== undefined) { for (var [scKey, scRatio] of _scarcityMap) { if (normName(scKey.split('|')[0]) === actNorm) { if (scRatio > 2) penalty += 2000; if (scRatio > 3) penalty += 3000; break; } } }
        // Skeleton context
        if ((block.event === 'General Activity Slot' || block.event === 'general activity slot') && block._blockIdx !== undefined) {
            var blockCtx = _skeletonContext.get(block._blockIdx);
            if (blockCtx) {
                var pickIsSpecType = (pick._type === 'special');
                var prevIsHigh = (blockCtx.prevType === 'sport' || (blockCtx.prevEvent && blockCtx.prevEvent.toLowerCase().indexOf('league') !== -1));
                var nextIsHigh = (blockCtx.nextType === 'sport' || (blockCtx.nextEvent && blockCtx.nextEvent.toLowerCase().indexOf('league') !== -1));
                if (prevIsHigh && nextIsHigh) { if (pickIsSpecType) penalty -= 2500; else penalty += 1500; }
                else if (blockCtx.prevType === 'special' && blockCtx.nextType === 'special') { if (!pickIsSpecType) penalty -= 2500; else penalty += 1500; }
                else if (blockCtx.prevType === 'general' || blockCtx.nextType === 'general') { var pos = blockCtx.positionInDay || 0; if (pos % 2 === 0 && !pickIsSpecType) penalty -= 500; else if (pos % 2 === 1 && pickIsSpecType) penalty -= 500; }
            }
        }
        // Unique resources
        if (fieldName && fieldName !== 'Free') { for (var [urAct, urCount] of _uniqueFieldMap) { if (urCount === 1 && normName(urAct) !== actNorm) { var thisFieldHostsUnique = allCandidateOptions.some(function(uc) { return uc.field === fieldName && uc.activityName === urAct; }); if (thisFieldHostsUnique) { var ourFieldCount = _uniqueFieldMap.get(act) || 0; if (ourFieldCount > 1) penalty += 5000; } } } }
        // Zone/travel
        if (fieldName && fieldName !== 'Free' && bunk && block.startTime !== undefined) {
            var myZone = window.getZoneForField?.(fieldName);
            var bunkAssigns = window.scheduleAssignments?.[bunk] || [];
            var prevZone = null;
            if (slots.length > 0 && slots[0] > 0) { var prevEntry = bunkAssigns[slots[0] - 1]; if (prevEntry && prevEntry.field && prevEntry.field !== 'Free') prevZone = window.getZoneForField?.(prevEntry.field); }
            if (myZone && prevZone) { var mzn = (typeof myZone === 'object') ? (myZone.name || '') : myZone; var pzn = (typeof prevZone === 'object') ? (prevZone.name || '') : prevZone; if (mzn && pzn) { if (mzn === pzn) penalty -= 300; else penalty += 500; } }
        }
        // Time-constrained boost
        if (act) { var tcBoost = _timeConstrainedBoost.get(act); if (tcBoost) penalty -= tcBoost.boost; }
        // Debt
        if (bunk && act && _activityDebt.size > 0) { var debtLookup = _activityDebt.get(bunk + '|' + act); if (debtLookup) penalty += debtLookup; }

        // ★★★ v15.0: fullGrade steering — if this activity has _fullGrade, bonus ★★★
        // This makes the solver PREFER fullGrade picks, used in conjunction with
        // the fullGrade forcing logic in Part 2's solveGroupMatchingAugmented
        if (pick._fullGrade || activityProperties[act]?.fullGrade || activityProperties[act]?._fullGrade) penalty -= 15000;

        // Tie-breaker
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
    for (var i = 0; i < blocks.length; i++) { if (blocks[i]._isLeague) continue; var dn = blocks[i].divName || blocks[i].division || ''; if (!divBlockCounts[dn]) divBlockCounts[dn] = 0; divBlockCounts[dn]++; }
    var divScarcity = {}, divisions = window.divisions || {};
    for (var dk in divisions) { var bc = (divisions[dk].bunks || []).length; divScarcity[dk] = (bc > 0 && divBlockCounts[dk]) ? (divBlockCounts[dk] / bc) : 999; }

    // ★★★ v15.2: SCARCE ACTIVITY PRIORITY ★★★
    // Count how many fields each activity can be played on
    var activityFieldCount = {};
    for (var ci = 0; ci < allCandidateOptions.length; ci++) {
        var cand = allCandidateOptions[ci];
        var actName = cand.activityName;
        if (!actName || actName === 'Free') continue;
        if (!activityFieldCount[actName]) activityFieldCount[actName] = new Set();
        activityFieldCount[actName].add(cand.field);
    }
    // Find the median field count to identify scarce activities
    var fieldCounts = Object.values(activityFieldCount).map(function(s) { return s.size; });
    fieldCounts.sort(function(a, b) { return a - b; });
    var medianFields = fieldCounts.length > 0 ? fieldCounts[Math.floor(fieldCounts.length / 2)] : 1;
    // Activities with far fewer fields than median are "scarce"
    var scarceActivities = new Set();
    for (var actKey in activityFieldCount) {
        if (activityFieldCount[actKey].size <= Math.max(1, Math.floor(medianFields / 3))) {
            scarceActivities.add(normName(actKey));
        }
    }
    if (scarceActivities.size > 0) {
        console.log('[SOLVER] ★ Scarce activities detected:', Array.from(scarceActivities).join(', '), '(median fields:', medianFields + ')');
    }
    // For each bunk, check if they need a scarce activity (never done or very under-done)
    var bunkNeedsScarce = {};
    for (var bi2 = 0; bi2 < blocks.length; bi2++) {
        var blk = blocks[bi2];
        if (blk._isLeague) continue;
        var bunk = blk.bunk;
        if (bunkNeedsScarce[bunk] !== undefined) continue;
        bunkNeedsScarce[bunk] = false;
        for (var scAct of scarceActivities) {
            var count = getActivityCount(bunk, scAct);
            var avg = 0;
            var allActs = Object.keys(activityFieldCount);
            for (var aai = 0; aai < allActs.length; aai++) { avg += getActivityCount(bunk, allActs[aai]); }
            avg = allActs.length > 0 ? avg / allActs.length : 0;
            if (count < avg - 0.5 || count === 0) {
                bunkNeedsScarce[bunk] = true;
                break;
            }
        }
    }

    return blocks.sort(function(a, b) {
        if (a._isLeague && !b._isLeague) return -1;
        if (!a._isLeague && b._isLeague) return 1;
        // ★★★ v15.2: Bunks that need scarce activities go FIRST ★★★
        var aNeedsScarce = bunkNeedsScarce[a.bunk] ? 1 : 0;
        var bNeedsScarce = bunkNeedsScarce[b.bunk] ? 1 : 0;
        if (aNeedsScarce !== bNeedsScarce) return bNeedsScarce - aNeedsScarce;
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
    // v13.0: PRECOMPUTE RESOURCE MAPS (★ rainy time bypass)
    // ========================================================================
    function precomputeResourceMaps(activityBlocks) {
        _uniqueFieldMap.clear(); _timeConstrainedBoost.clear(); _smallBunkFlags.clear();
        var activityToFields = {};
        for (var i = 0; i < allCandidateOptions.length; i++) { var c = allCandidateOptions[i]; if (!c.activityName || c.activityName === 'Free') continue; if (!activityToFields[c.activityName]) activityToFields[c.activityName] = new Set(); activityToFields[c.activityName].add(c.field); }
        for (var actName in activityToFields) _uniqueFieldMap.set(actName, activityToFields[actName].size);
        var props = activityProperties || {};
        for (var fieldName in props) {
            var fpx = props[fieldName]; if (!fpx) continue;
            // ★★★ v15.0: Skip time rules if rainy day bypass active ★★★
            if (_isRainyDay && _rainyTimeBypasses.has(fieldName)) {
                v12Log('🌧️ Time bypass: ' + fieldName + ' — available all day');
                continue; // don't add time-constrained boost for bypassed fields
            }
            var rules = fpx.timeRules || [];
            var availRules = rules.filter(function(r) { return r.type === 'Available'; });
            if (availRules.length > 0) {
                var totalWindowMinutes = 0;
                for (var ri = 0; ri < availRules.length; ri++) { var r = availRules[ri]; var rStart = r.startMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.start) || 0); var rEnd = r.endMin ?? (window.SchedulerCoreUtils?.parseTimeToMinutes?.(r.end) || 0); totalWindowMinutes += Math.max(0, rEnd - rStart); }
                if (totalWindowMinutes < 240) _timeConstrainedBoost.set(fieldName, { windowMinutes: totalWindowMinutes, totalMinutes: 480, boost: Math.round(3000 * (1 - totalWindowMinutes / 480)) });
            }
        }
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        var sportMeta = window.getSportMetaData?.() || window.sportMetaData || {};
        var minThresholds = [];
        for (var sport in sportMeta) { if (sportMeta[sport].minPlayers) minThresholds.push(sportMeta[sport].minPlayers); }
        if (minThresholds.length > 0) { minThresholds.sort(function(a, b) { return a - b; }); var medianMin = minThresholds[Math.floor(minThresholds.length / 2)]; for (var bunkName in bunkMeta) { var size = bunkMeta[bunkName]?.size || 0; if (size > 0 && size < medianMin) _smallBunkFlags.add(bunkName); } }
        // Skeleton context
        var bunkBlocks = {};
        for (var bi = 0; bi < activityBlocks.length; bi++) { var blk = activityBlocks[bi]; var bk = blk.bunk; if (!bunkBlocks[bk]) bunkBlocks[bk] = []; bunkBlocks[bk].push({ idx: bi, startTime: blk.startTime || 0, event: blk.event || '' }); }
        var dailyData = window.loadCurrentDailyData?.() || {};
        var skeleton = dailyData.manualSkeleton || [];
        for (var bunkKey in bunkBlocks) {
            var bBlocks = bunkBlocks[bunkKey]; bBlocks.sort(function(a, b) { return a.startTime - b.startTime; });
            var bunkDiv = getBunkDivision(bunkKey);
            var fullTimeline = [];
            for (var ski = 0; ski < skeleton.length; ski++) { var sk = skeleton[ski]; if (sk.division !== bunkDiv) continue; var skStart = window.SchedulerCoreUtils?.parseTimeToMinutes?.(sk.startTime) || 0; fullTimeline.push({ startTime: skStart, event: sk.event || sk.type || '', type: sk.type || '' }); }
            fullTimeline.sort(function(a, b) { return a.startTime - b.startTime; });
            for (var bbi = 0; bbi < bBlocks.length; bbi++) {
                var curBlock = bBlocks[bbi]; var prevType = null, nextType = null, prevEvent = '', nextEvent = '';
                for (var ti = 0; ti < fullTimeline.length; ti++) { if (fullTimeline[ti].startTime < curBlock.startTime) { prevEvent = fullTimeline[ti].event; prevType = categorizeSkeletonEvent(fullTimeline[ti]); } if (fullTimeline[ti].startTime > curBlock.startTime && nextType === null) { nextEvent = fullTimeline[ti].event; nextType = categorizeSkeletonEvent(fullTimeline[ti]); } }
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
        for (var bi = 0; bi < activityBlocks.length; bi++) { var blk = activityBlocks[bi]; if (!blk.divName) blk.divName = getBunkDivision(blk.bunk) || ''; var key = blk.divName + '|' + (blk.startTime || '?') + '-' + (blk.endTime || '?'); if (!divTimeGroups[key]) divTimeGroups[key] = []; divTimeGroups[key].push(bi); }
        for (var groupKey in divTimeGroups) {
            var blockIndices = divTimeGroups[groupKey]; if (blockIndices.length === 0) continue;
            var sampleBlock = activityBlocks[blockIndices[0]];
            var divName = sampleBlock.divName, startMin = sampleBlock.startTime, endMin = sampleBlock.endTime;
            if (startMin === undefined || endMin === undefined) continue;
            var wishLists = {}, bunkSizes = {};
            for (var i = 0; i < blockIndices.length; i++) {
                var block = activityBlocks[blockIndices[i]]; var bunk = block.bunk;
                var bSize = bunkMeta[bunk]?.size || 0; bunkSizes[bunk] = bSize;
                var wishes = [], candidateActivities = new Set();
                for (var ci = 0; ci < allCandidateOptions.length; ci++) { var cand = allCandidateOptions[ci]; if (cand.activityName && cand.activityName !== 'Free') candidateActivities.add(cand.activityName); }
                for (var actNameW of candidateActivities) {
                    var actNorm = normName(actNameW);
                    var todayDone = getActivitiesDoneToday(bunk, block.slots?.[0] ?? 999);
                    if (todayDone.has(actNorm)) continue;
                    var rotScore = getPrecomputedRotationScore(bunk, actNameW); if (rotScore === Infinity) continue;
                    var soloCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(actNameW, bSize, false);
                    var needsSharing = soloCheck && !soloCheck.valid && soloCheck.severity === 'hard';
                    var isSpecial = window.RotationEngine?.isSpecialActivity?.(actNameW) || allCandidateOptions.some(function(c) { return c.activityName === actNameW && c.type === 'special'; });
                    var debtBonus = _activityDebt.get(bunk + '|' + actNameW) || 0;
                    var tcInfo = _timeConstrainedBoost.get(actNameW); var timeBoost = tcInfo ? -tcInfo.boost : 0;
                    wishes.push({ activity: actNameW, need: rotScore + debtBonus + timeBoost, actType: isSpecial ? 'special' : 'sport', needsSharing: needsSharing, bunkSize: bSize });
                }
                wishes.sort(function(a, b) { return a.need - b.need; }); wishLists[bunk] = wishes;
            }
            var actFieldSlots = {};
            for (var ci3 = 0; ci3 < allCandidateOptions.length; ci3++) { var c3 = allCandidateOptions[ci3]; if (!c3.activityName || c3.activityName === 'Free') continue; if (!actFieldSlots[c3.activityName]) actFieldSlots[c3.activityName] = new Set(); actFieldSlots[c3.activityName].add(c3.field); }
            var activitySupply = {}; for (var afs in actFieldSlots) activitySupply[afs] = actFieldSlots[afs].size;
            var bunkList = blockIndices.map(function(bi2) { return activityBlocks[bi2].bunk; });
            var pairedBunks = new Map();
            for (var sbi = 0; sbi < bunkList.length; sbi++) { var sBunk = bunkList[sbi]; if (!_smallBunkFlags.has(sBunk) || pairedBunks.has(sBunk)) continue; var myNum = getBunkNumber(sBunk) || 0, bestPartner = null, bestDist = Infinity; for (var pbi = 0; pbi < bunkList.length; pbi++) { var pBunk = bunkList[pbi]; if (pBunk === sBunk) continue; if (pairedBunks.has(pBunk) && pairedBunks.get(pBunk) !== sBunk) continue; var dist = Math.abs((getBunkNumber(pBunk) || 0) - myNum); if (dist < bestDist) { bestDist = dist; bestPartner = pBunk; } } if (bestPartner) pairedBunks.set(sBunk, bestPartner); }
            var allocated = {}, activityUsed = {};
            var sortedBunks = bunkList.slice().sort(function(a, b) { return (wishLists[a]?.length || 0) - (wishLists[b]?.length || 0); });
            for (var abi = 0; abi < sortedBunks.length; abi++) {
                var aBunk = sortedBunks[abi]; if (allocated[aBunk]) continue;
                var wishes2 = wishLists[aBunk] || [];
                for (var wi = 0; wi < wishes2.length; wi++) {
                    var wish = wishes2[wi];
                    if ((activityUsed[wish.activity] || 0) >= (activitySupply[wish.activity] || 0)) continue;
                    if (wish.needsSharing && pairedBunks.has(aBunk)) { var partner = pairedBunks.get(aBunk); var combinedSize = (bunkSizes[aBunk] || 0) + (bunkSizes[partner] || 0); var combinedCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(wish.activity, combinedSize, false); if (combinedCheck && !combinedCheck.valid && combinedCheck.severity === 'hard') continue; }
                    var projectedPlayers = bunkSizes[aBunk] || 0;
                    for (var existBunk in allocated) { if (allocated[existBunk] === wish.activity) projectedPlayers += (bunkSizes[existBunk] || 0); }
                    var maxReqs = window.SchedulerCoreUtils?.getSportPlayerRequirements?.(wish.activity);
                    if (maxReqs?.maxPlayers && projectedPlayers > maxReqs.maxPlayers * 1.3) continue;
                    allocated[aBunk] = wish.activity; activityUsed[wish.activity] = (activityUsed[wish.activity] || 0) + 1;
                    if (pairedBunks.has(aBunk) && !allocated[pairedBunks.get(aBunk)]) { var prt = pairedBunks.get(aBunk); if ((wishLists[prt] || []).some(function(w) { return w.activity === wish.activity; }) && (activityUsed[wish.activity] || 0) < (activitySupply[wish.activity] || 0)) { allocated[prt] = wish.activity; activityUsed[wish.activity]++; } }
                    break;
                }
                if (allocated[aBunk] && wishes2.length > 0 && allocated[aBunk] !== wishes2[0].activity) { var dk2 = aBunk + '|' + wishes2[0].activity; _activityDebt.set(dk2, (_activityDebt.get(dk2) || 0) - 2000); }
            }
            for (var pi = 0; pi < blockIndices.length; pi++) { var bIdx = blockIndices[pi]; var pBunk2 = activityBlocks[bIdx].bunk; if (allocated[pBunk2]) _activityPlan.set(bIdx, { activity: allocated[pBunk2], steering: -8000 }); }
            for (var scAct in activityUsed) { var demand = 0; for (var scBunk in wishLists) { if (wishLists[scBunk]?.some(function(w) { return w.activity === scAct; })) demand++; } var scSupply = activitySupply[scAct] || 1; if (demand > scSupply) _scarcityMap.set(scAct + '|' + startMin, demand / scSupply); }
        }
        console.log('[SOLVER-v13] 🧠 Activity-First Planner: ' + _activityPlan.size + ' planned, ' + _scarcityMap.size + ' scarce, ' + _activityDebt.size + ' debt');
    }

    // ========================================================================
    // PASS ANALYSIS + ADJUSTMENT
    // ========================================================================
    function analyzePassResult(activityBlocks, passNum) {
        var analysis = { passNumber: passNum, freeBlocks: [], yesterdayRepeats: [], playerViolations: [], freeBlockBunks: new Set(), totalFree: 0, totalBlocks: activityBlocks.length, score: 0 };
        var bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        for (var i = 0; i < activityBlocks.length; i++) {
            var asgn = _assignments.get(i); if (!asgn) continue;
            var block = activityBlocks[i], actNorm = normName(asgn.pick._activity || asgn.pick.field);
            if (actNorm === 'free' || actNorm === 'free (timeout)') { analysis.freeBlocks.push({ blockIdx: i, bunk: block.bunk, divName: block.divName, startTime: block.startTime, endTime: block.endTime }); analysis.freeBlockBunks.add(block.bunk); analysis.totalFree++; analysis.score += 10000; }
            if (actNorm && actNorm !== 'free') { var daysSince = getDaysSinceActivity(block.bunk, asgn.pick._activity); if (daysSince === 1) { analysis.yesterdayRepeats.push({ blockIdx: i, bunk: block.bunk, activity: asgn.pick._activity }); analysis.score += 5000; } }
            if (actNorm && actNorm !== 'free' && asgn.pick.field && asgn.pick.field !== 'Free') {
                var fieldNorm2 = normName(asgn.pick.field); var entries = _fieldTimeIndex.get(fieldNorm2) || [];
                var totalPlayers = bunkMeta[block.bunk]?.size || 0;
                for (var ei = 0; ei < entries.length; ei++) { var e = entries[ei]; if (e.bunk === block.bunk) continue; if (e.endMin <= block.startTime || e.startMin >= block.endTime) continue; totalPlayers += (bunkMeta[e.bunk]?.size || 0); }
                var pCheck = window.SchedulerCoreUtils?.checkPlayerCountForSport?.(asgn.pick._activity, totalPlayers, false);
                if (pCheck && !pCheck.valid) { analysis.playerViolations.push({ blockIdx: i, bunk: block.bunk, activity: asgn.pick._activity, players: totalPlayers, severity: pCheck.severity }); analysis.score += (pCheck.severity === 'hard' ? 8000 : 2000); }
            }
            if (actNorm && actNorm !== 'free') analysis.score += Math.min(asgn.cost || 0, 50000);
        }
        console.log('[SOLVER-v13] 📊 Pass ' + passNum + ': ' + analysis.totalFree + ' Free, ' + analysis.yesterdayRepeats.length + ' yday, Score: ' + analysis.score);
        return analysis;
    }
    function adjustPlanFromAnalysis(activityBlocks, analysis) {
        if (!analysis) return;
        for (var fi = 0; fi < analysis.freeBlocks.length; fi++) { var fb = analysis.freeBlocks[fi]; for (var ci = 0; ci < allCandidateOptions.length; ci++) { var c = allCandidateOptions[ci]; if (!c.activityName || c.activityName === 'Free') continue; var dKey = fb.bunk + '|' + c.activityName; _activityDebt.set(dKey, (_activityDebt.get(dKey) || 0) - 5000); } }
        for (var yi = 0; yi < analysis.yesterdayRepeats.length; yi++) { var yr = analysis.yesterdayRepeats[yi]; var yrKey = yr.bunk + '|' + yr.activity; _activityDebt.set(yrKey, (_activityDebt.get(yrKey) || 0) + 10000); }
        for (var pvi = 0; pvi < analysis.playerViolations.length; pvi++) { var pv = analysis.playerViolations[pvi]; if (pv.severity === 'hard') { var pvKey = pv.bunk + '|' + pv.activity; _activityDebt.set(pvKey, (_activityDebt.get(pvKey) || 0) + 20000); } }
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
        if (window.fieldUsageBySlot && window.fieldUsageBySlot[slots[i]]) { if (!window.fieldUsageBySlot[slots[i]][fName]) window.fieldUsageBySlot[slots[i]][fName] = { count: 0, bunks: {} }; window.fieldUsageBySlot[slots[i]][fName].count++; window.fieldUsageBySlot[slots[i]][fName].bunks[bunk] = pick.sport || pick._activity; }
    }
    // ★★★ v15.1 FIX: Clear stale caches so next penalty check sees this assignment ★★★
    // Without this, _todayCache returns stale "not done today" for this bunk,
    // allowing the same activity to be picked again for the same bunk.
    for (var [tKey] of _todayCache) { if (tKey.startsWith(bunk + ':')) _todayCache.delete(tKey); }
    // Also update the time index
    if (block.startTime !== undefined && block.endTime !== undefined) {
        var pickFieldNorm = normName(fName);
        addToFieldTimeIndex(pickFieldNorm, block.startTime, block.endTime, bunk, block.divName || '', normName(pick._activity || fName));
        var pickActNorm = normName(pick._activity || fName);
        if (pickActNorm && pickActNorm !== pickFieldNorm) addToFieldTimeIndex(pickActNorm, block.startTime, block.endTime, bunk, block.divName || '', pickActNorm);
    }
}
    function undoPickFromSchedule(block, pick) {
        var bunk = block.bunk, slots = block.slots || [];
        if (!window.scheduleAssignments[bunk]) return;
        var fieldName = pick ? pick.field : null;
        for (var i = 0; i < slots.length; i++) { var slotIdx2 = slots[i]; window.scheduleAssignments[bunk][slotIdx2] = null; if (fieldName && window.fieldUsageBySlot?.[slotIdx2]?.[fieldName]) { var usage = window.fieldUsageBySlot[slotIdx2][fieldName]; if (usage.bunks) delete usage.bunks[bunk]; if (usage.count > 0) usage.count--; } }
        if (pick) { var fieldNorm = normName(pick.field); if (block.startTime !== undefined && block.endTime !== undefined) { removeFromFieldTimeIndex(fieldNorm, block.startTime, block.endTime, bunk); var actNorm = normName(pick._activity); if (actNorm && actNorm !== fieldNorm) removeFromFieldTimeIndex(actNorm, block.startTime, block.endTime, bunk); } }
        invalidateRotationCacheForBunk(bunk);
    }

    // ========================================================================
    // EXPOSE INTERNALS TO PART 2
    // ========================================================================
    window._SolverInternals = {
        Solver: Solver, normName: normName, getBunkDivision: getBunkDivision, getBunkNumber: getBunkNumber,
        clearBunkDivisionCache: clearBunkDivisionCache, clearAllCaches: clearAllCaches,
        detectRainyDayMode: detectRainyDayMode,
        get globalConfig() { return globalConfig; }, set globalConfig(v) { globalConfig = v; },
        get activityProperties() { return activityProperties; }, set activityProperties(v) { activityProperties = v; },
        get allCandidateOptions() { return allCandidateOptions; }, set allCandidateOptions(v) { allCandidateOptions = v; },
        get _domains() { return _domains; }, set _domains(v) { _domains = v; },
        get _slotGroups() { return _slotGroups; }, set _slotGroups(v) { _slotGroups = v; },
        get _assignedBlocks() { return _assignedBlocks; },
        get _assignments() { return _assignments; },
        get _activityDebt() { return _activityDebt; },
        get _activityPlan() { return _activityPlan; },
        get _scarcityMap() { return _scarcityMap; },
        get _fieldPropertyMap() { return _fieldPropertyMap; },
        get _fieldTimeIndex() { return _fieldTimeIndex; },
        get _todayCache() { return _todayCache; },
        get _perfCounters() { return _perfCounters; }, set _perfCounters(v) { _perfCounters = v; },
        get _isRainyDay() { return _isRainyDay; },
        get _rainyCapOverrides() { return _rainyCapOverrides; },
        get _rainyTimeBypasses() { return _rainyTimeBypasses; },
        get _passNumber() { return _passNumber; }, set _passNumber(v) { _passNumber = v; },
        ROTATION_CONFIG: ROTATION_CONFIG,
        precomputeFieldProperties: precomputeFieldProperties,
        buildFieldTimeIndex: buildFieldTimeIndex,
        addToFieldTimeIndex: addToFieldTimeIndex,
        removeFromFieldTimeIndex: removeFromFieldTimeIndex,
        getFieldUsageFromTimeIndex: getFieldUsageFromTimeIndex,
        checkCrossDivisionTimeConflict: checkCrossDivisionTimeConflict,
        countSameDivisionUsage: countSameDivisionUsage,
        checkSameFieldActivityMismatch: checkSameFieldActivityMismatch,
        isFieldLockedByTime: isFieldLockedByTime,
        precomputeRotationScores: precomputeRotationScores,
        getPrecomputedRotationScore: getPrecomputedRotationScore,
        invalidateRotationCacheForBunk: invalidateRotationCacheForBunk,
        getActivitiesDoneToday: getActivitiesDoneToday,
        getDaysSinceActivity: getDaysSinceActivity,
        getActivityCount: getActivityCount,
        getFieldCapacity: getFieldCapacity,
        getSharingType: getSharingType,
        buildAllCandidateOptions: buildAllCandidateOptions,
        setScratchPick: setScratchPick, clonePick: clonePick,
        calculatePenaltyCost: calculatePenaltyCost,
        precomputeResourceMaps: precomputeResourceMaps,
        activityFirstPlanner: activityFirstPlanner,
        analyzePassResult: analyzePassResult,
        adjustPlanFromAnalysis: adjustPlanFromAnalysis,
        applyPickToSchedule: applyPickToSchedule,
        undoPickFromSchedule: undoPickFromSchedule,
        getLiveTypeBalance: getLiveTypeBalance,
        isSpecialCandidate: isSpecialCandidate
    };

    console.log('[SOLVER] Part 1 loaded (v15.0 — fullGrade per-grade + rainy day overrides)');
})();
// ============================================================================
// total_solver_engine_part2.js (v15.0 — SOLVING PIPELINE)
// ============================================================================
// Requires: total_solver_engine_part1.js loaded first (window._SolverInternals)
//
// ★★★ v15.0: fullGrade = per GRADE (e.g. "1st Grade"), NOT per division ★★★
// ★★★ v15.0: Rainy day time-rule bypass in domain building ★★★
// ★★★ v14.2: Same-day duplicate sweep ★★★
// ★★★ v14.1: Cross-div re-solve ★★★
// ★★★ v13.0: Three-pass pipeline ★★★
// ============================================================================

(function () {
    'use strict';
    var S = window._SolverInternals;
    if (!S) { console.error('[SOLVER Part 2] FATAL: Part 1 not loaded!'); return; }
    var Solver = S.Solver;
    var normName = S.normName;
    var getBunkDivision = S.getBunkDivision;
    var getBunkNumber = S.getBunkNumber;

    // ========================================================================
    // FUSED DOMAIN + SLOT GROUP BUILD (★ rainy time bypass)
    // ========================================================================
    function buildDomainsAndSlotGroups(activityBlocks) {
        var allCands = S.allCandidateOptions, actProps = S.activityProperties, gCfg = S.globalConfig;
        var numBlocks = activityBlocks.length, numCands = allCands.length;
        var domains = new Map(), slotGroups = new Map();
        var disabledSet = new Set(window.currentDisabledFields || gCfg?.disabledFields || []);
        var globallyValid = new Uint8Array(numCands);
        for (var ci = 0; ci < numCands; ci++) { var c = allCands[ci]; if (disabledSet.has(c.field)) continue; if (!actProps[c.field] && !actProps[c.activityName] && c.type !== 'special') continue; globallyValid[ci] = 1; }
        for (var bi = 0; bi < numBlocks; bi++) {
            var block = activityBlocks[bi]; block._blockIdx = bi;
            var domain = new Set(), bunk = block.bunk;
            var blockDiv = block.divName || block.division || '';
            if (!blockDiv && bunk) { blockDiv = getBunkDivision(bunk) || ''; if (blockDiv) block.divName = blockDiv; }
            var slots = block.slots || [], startMin = block.startTime, endMin = block.endTime;
            if (startMin === undefined || endMin === undefined) {
                var ds = window.divisionTimes?.[blockDiv] || [];
                if (slots.length > 0 && ds[slots[0]]) { startMin = ds[slots[0]].startMin; var ls = ds[slots[slots.length-1]]; endMin = ls ? ls.endMin : (startMin+40); block.startTime = startMin; block.endTime = endMin; }
            }
            var hasTime = startMin !== undefined && endMin !== undefined;
            var gk = (startMin||'?')+'-'+(endMin||'?')+'-'+blockDiv;
            if (!slotGroups.has(gk)) slotGroups.set(gk, []);
            slotGroups.get(gk).push(bi);
            for (var ci2 = 0; ci2 < numCands; ci2++) {
                if (!globallyValid[ci2]) continue;
                var c2 = allCands[ci2], fn = c2.field, fnorm = c2._fieldNorm;
                if (window.GlobalFieldLocks?.isFieldLocked(fn, slots, blockDiv)) continue;
                if (hasTime && S.isFieldLockedByTime(fn, startMin, endMin, blockDiv)) continue;
                // ★ v15.0: Rainy time bypass — skip canBlockFit (which enforces time rules)
                var skipTimeCheck = S._isRainyDay && S._rainyTimeBypasses.has(fn);
                var fp = S._fieldPropertyMap.get(fn);
                if (fp?.prefExclusive && fp.prefList && fp.prefList.indexOf(blockDiv) === -1) continue;
                if (!skipTimeCheck) { var fits = window.SchedulerCoreUtils?.canBlockFit?.(block, fn, actProps, window.fieldUsageBySlot, c2.activityName, false); if (fits === false) continue; }
                if (hasTime) {
                    var cap = fp ? fp.capacity : S.getFieldCapacity(fn);
                    var st = fp ? fp.sharingType : S.getSharingType(fn);
                    if (S.checkCrossDivisionTimeConflict(fn, blockDiv, startMin, endMin, bunk)) continue;
                    if (st === 'not_sharable') { if (S.getFieldUsageFromTimeIndex(fnorm, startMin, endMin, bunk) >= cap) continue; }
                    else { if (S.countSameDivisionUsage(fn, blockDiv, startMin, endMin, bunk) >= cap) continue; }
                }
                if (S.getPrecomputedRotationScore(bunk, c2.activityName) === Infinity) continue;
                domain.add(ci2);
            }
            domains.set(bi, domain);
        }
        return { domains: domains, slotGroups: slotGroups };
    }

    // ========================================================================
    // AC-3
    // ========================================================================
    function propagateAC3(activityBlocks) {
        var allCands = S.allCandidateOptions;
        var propagated = 0, autoAssigned = 0, maxIter = activityBlocks.length * 10, iter = 0;
        var overlaps = new Map();
        for (var [,gi] of S._slotGroups) { for (var i=0;i<gi.length;i++) for (var j=i+1;j<gi.length;j++) { if (!overlaps.has(gi[i])) overlaps.set(gi[i], new Set()); if (!overlaps.has(gi[j])) overlaps.set(gi[j], new Set()); overlaps.get(gi[i]).add(gi[j]); overlaps.get(gi[j]).add(gi[i]); } }
        var ge = [];
        for (var [,gis] of S._slotGroups) { if (gis.length===0) continue; var sm = activityBlocks[gis[0]]; if (sm.startTime !== undefined) ge.push({start:sm.startTime,end:sm.endTime,indices:gis}); }
        ge.sort(function(a,b){return a.start-b.start;});
        for (var gi2=0;gi2<ge.length;gi2++) { var gA=ge[gi2]; for (var gj=gi2+1;gj<ge.length;gj++) { var gB=ge[gj]; if (gB.start>=gA.end) break; for (var ai of gA.indices) for (var bi2 of gB.indices) { if (!overlaps.has(ai)) overlaps.set(ai,new Set()); if (!overlaps.has(bi2)) overlaps.set(bi2,new Set()); overlaps.get(ai).add(bi2); overlaps.get(bi2).add(ai); } } }
        var queue = new Set(); for (var qi=0;qi<activityBlocks.length;qi++) queue.add(qi);
        while (queue.size > 0 && iter < maxIter) {
            iter++; var bi3 = queue.values().next().value; queue.delete(bi3);
            if (S._assignedBlocks.has(bi3)) continue;
            var dom = S._domains.get(bi3); if (!dom || dom.size === 0) continue;
            if (dom.size === 1) {
                var ci3 = dom.values().next().value, blk = activityBlocks[bi3], c3 = allCands[ci3], pk = S.clonePick(c3);
                var blocked = false;
                if (blk.startTime!==undefined && blk.endTime!==undefined && blk.divName) { if (S.checkCrossDivisionTimeConflict(c3.field,blk.divName,blk.startTime,blk.endTime,blk.bunk)) blocked = true; }
                if (blocked) { pk = {field:"Free",sport:null,_activity:"Free"}; S._assignedBlocks.add(bi3); S._assignments.set(bi3,{candIdx:-1,pick:pk,cost:100000}); S.applyPickToSchedule(blk,pk); }
                else { var cost = S.calculatePenaltyCost(blk,pk); S._assignedBlocks.add(bi3); S._assignments.set(bi3,{candIdx:ci3,pick:pk,cost:cost}); S.applyPickToSchedule(blk,pk); var fn = normName(pk.field); if (blk.startTime!==undefined && blk.endTime!==undefined) { var pan = normName(pk._activity); S.addToFieldTimeIndex(fn,blk.startTime,blk.endTime,blk.bunk,blk.divName,pan); if (pan && pan!==fn) S.addToFieldTimeIndex(pan,blk.startTime,blk.endTime,blk.bunk,blk.divName,pan); } S.invalidateRotationCacheForBunk(blk.bunk); }
                autoAssigned++;
                var nb = overlaps.get(bi3) || new Set();
                for (var ni of nb) { if (S._assignedBlocks.has(ni)) continue; var nd = S._domains.get(ni); if (!nd) continue; var chg=false; for (var nci of Array.from(nd)) { if (wouldConflict(blk,pk,activityBlocks[ni],allCands[nci])) { nd.delete(nci); chg=true; propagated++; } } if (chg) queue.add(ni); }
                continue;
            }
            var nb2 = overlaps.get(bi3) || new Set();
            for (var ni2 of nb2) { if (!S._assignedBlocks.has(ni2)) continue; var asgn = S._assignments.get(ni2); if (!asgn) continue; var chg2=false; for (var ci4 of Array.from(dom)) { if (wouldConflict(activityBlocks[ni2],asgn.pick,activityBlocks[bi3],allCands[ci4])) { dom.delete(ci4); chg2=true; propagated++; } } if (chg2) queue.add(bi3); }
        }
        return { autoAssigned:autoAssigned, propagated:propagated };
    }
    function wouldConflict(aBlock,aPick,oBlock,oCand) {
        var afn = normName(aPick.field), ofn = oCand._fieldNorm || normName(oCand.field);
        if (afn !== ofn) return false;
        var aS=aBlock.startTime,aE=aBlock.endTime,oS=oBlock.startTime,oE=oBlock.endTime;
        if (aS===undefined||oS===undefined) return false; if (aS>=oE||aE<=oS) return false;
        var fp = S._fieldPropertyMap.get(aPick.field); var cap = fp?fp.capacity:S.getFieldCapacity(aPick.field); var st = fp?fp.sharingType:S.getSharingType(aPick.field);
        if (st==='not_sharable') return true;
        var aDiv=aBlock.divName||'',oDiv=oBlock.divName||'';
        if (aDiv&&oDiv&&aDiv!==oDiv) return true;
        return S.countSameDivisionUsage(aPick.field,aDiv,Math.max(aS,oS),Math.min(aE,oE),oBlock.bunk)>=cap;
    }

    // ========================================================================
    // ★★★ SLOT GROUP MATCHING WITH FULL-GRADE PER GRADE (v15.0) ★★★
    // ========================================================================
    function solveSlotGroups(activityBlocks) {
        var allCands = S.allCandidateOptions, actProps = S.activityProperties;
        var groupsSolved = 0, blocksAssigned = 0;
        var globalBunkActs = new Map();
        var allBunks = Object.keys(window.scheduleAssignments || {});
        for (var gbi=0;gbi<allBunks.length;gbi++) { var gb=allBunks[gbi],gbs=window.scheduleAssignments[gb]||[]; for (var gsi=0;gsi<gbs.length;gsi++) { var ge=gbs[gsi]; if (!ge||ge.continuation||ge._isTransition) continue; var ga=normName(ge._activity||ge.sport||ge.field); if (ga&&ga!=='free'&&ga!=='free play'&&ga!=='transition/buffer') { if (!globalBunkActs.has(gb)) globalBunkActs.set(gb,new Set()); globalBunkActs.get(gb).add(ga); } } }
        var sorted = Array.from(S._slotGroups.entries()).sort(function(a,b){return a[1].length-b[1].length;});
        for (var [,blockIndices] of sorted) {
            S._todayCache.clear();
            var unassigned = blockIndices.filter(function(bi){return !S._assignedBlocks.has(bi);});
            if (unassigned.length===0) continue;
            var grpResults = solveGroupAugmented(activityBlocks, unassigned, globalBunkActs);
            for (var ga2 of grpResults) {
                if (S._assignedBlocks.has(ga2.blockIdx)) continue;
                var blk = activityBlocks[ga2.blockIdx];
                S._assignedBlocks.add(ga2.blockIdx); S._assignments.set(ga2.blockIdx,{candIdx:ga2.candIdx,pick:ga2.pick,cost:ga2.cost});
                S.applyPickToSchedule(blk,ga2.pick);
                var fn = normName(ga2.pick.field);
                if (blk.startTime!==undefined&&blk.endTime!==undefined) { var an = normName(ga2.pick._activity); S.addToFieldTimeIndex(fn,blk.startTime,blk.endTime,blk.bunk,blk.divName,an); if (an&&an!==fn) S.addToFieldTimeIndex(an,blk.startTime,blk.endTime,blk.bunk,blk.divName,an); }
                S.invalidateRotationCacheForBunk(blk.bunk);
                propagateAssignment(activityBlocks,ga2.blockIdx,ga2.pick);
                var tracker = normName(ga2.pick._activity||ga2.pick.field);
                if (tracker&&tracker!=='free'&&tracker!=='free play') { if (!globalBunkActs.has(blk.bunk)) globalBunkActs.set(blk.bunk,new Set()); globalBunkActs.get(blk.bunk).add(tracker); }
                blocksAssigned++;
            }
            S._todayCache.clear(); groupsSolved++;
        }
        return blocksAssigned;
    }

    function solveGroupAugmented(activityBlocks, unassigned, globalBunkActs) {
        var allCands = S.allCandidateOptions, actProps = S.activityProperties;
        globalBunkActs = globalBunkActs || new Map();
        var results = [], blockOpts = [];
        for (var bi of unassigned) {
            var dom = S._domains.get(bi);
            if (!dom||dom.size===0) { results.push({blockIdx:bi,candIdx:-1,pick:{field:"Free",sport:null,_activity:"Free"},cost:100000}); continue; }
            var blk = activityBlocks[bi], sc = [];
            for (var ci of dom) { var c = allCands[ci]; if (!isPickStillValid(blk,c)) continue;
                var an = normName(c.activityName);
                if (an&&an!=='free'&&an!=='free play') { var gd = globalBunkActs.get(blk.bunk); if (gd&&gd.has(an)) continue; }
                S.setScratchPick(c); var cost = S.calculatePenaltyCost(blk,S.setScratchPick(c)); if (cost<900000) sc.push({bi:bi,ci:ci,cost:cost}); }
            sc.sort(function(a,b){return a.cost-b.cost;});
            blockOpts.push({bi:bi,options:sc,domainSize:sc.length});
        }
        blockOpts.sort(function(a,b){return a.domainSize-b.domainSize;});
        var fieldUsageGrp = new Map(), fieldDivsGrp = new Map(), bunkActsGrp = new Map();
        // ★★★ v15.0: fullGrade per GRADE — key = "gradeName|start|end" ★★★
        var fullGradeMap = new Map();

        for (var bo of blockOpts) {
            if (S._assignedBlocks.has(bo.bi)) continue;
            var b2 = activityBlocks[bo.bi], assigned = false;
            // ★ fullGrade check: divName IS the grade (e.g. "1st Grade")
            var fgKey = (b2.divName||'')+'|'+(b2.startTime??'')+'|'+(b2.endTime??'');
            var fgExist = fullGradeMap.get(fgKey);
            if (fgExist) {
                var fgPk = fgExist.pick, fgAn = normName(fgPk._activity||fgPk.field);
                var fgDone1 = bunkActsGrp.get(b2.bunk), fgDone2 = globalBunkActs.get(b2.bunk);
                var fgDup = (fgDone1&&fgDone1.has(fgAn))||(fgDone2&&fgDone2.has(fgAn));
                if (!fgDup) { var fgLive = S.getActivitiesDoneToday(b2.bunk,b2.slots?.[0]??999); if (!fgLive.has(fgAn)) {
                    results.push({blockIdx:bo.bi,candIdx:fgExist.candIdx,pick:fgPk,cost:fgExist.cost});
                    if (!bunkActsGrp.has(b2.bunk)) bunkActsGrp.set(b2.bunk,new Set()); bunkActsGrp.get(b2.bunk).add(fgAn);
                    assigned = true; console.log('[FULL_GRADE] Forced '+b2.bunk+' → '+fgPk._activity+' (grade: '+b2.divName+')');
                } }
            }
            if (assigned) continue;
            for (var oi=0;oi<bo.options.length;oi++) {
                var opt = bo.options[oi], c2 = allCands[opt.ci];
                var cAn = normName(c2.activityName);
                if (cAn&&cAn!=='free'&&cAn!=='free play') {
                    var bg = bunkActsGrp.get(b2.bunk); if (bg&&bg.has(cAn)) continue;
                    var gd2 = globalBunkActs.get(b2.bunk); if (gd2&&gd2.has(cAn)) continue;
                    var ld = S.getActivitiesDoneToday(b2.bunk,b2.slots?.[0]??999); if (ld.has(cAn)) continue;
                }
                var fn2=c2._fieldNorm, fName=c2.field;
                var fp=S._fieldPropertyMap.get(fName), cap=fp?fp.capacity:S.getFieldCapacity(fName), st=fp?fp.sharingType:S.getSharingType(fName);
                var grpUse=fieldUsageGrp.get(fn2)||0;
                var existUse=(b2.startTime!==undefined&&b2.endTime!==undefined)?S.getFieldUsageFromTimeIndex(fn2,b2.startTime,b2.endTime,b2.bunk):0;
                var canFit=false;
                if (st==='not_sharable') { canFit=(existUse+grpUse<cap); }
                else if (st==='same_division'||st==='custom') {
                    var xc=S.checkCrossDivisionTimeConflict(fName,b2.divName,b2.startTime,b2.endTime,b2.bunk);
                    if (!xc&&b2.divName) { for (var ri=0;ri<results.length;ri++) { var r=results[ri]; if (r.candIdx===-1||normName(r.pick.field)!==fn2) continue; var rb=activityBlocks[r.blockIdx]; if (rb.divName&&rb.divName!==b2.divName&&rb.startTime<b2.endTime&&rb.endTime>b2.startTime) { xc=true; break; } } }
                    if (!xc) { var am=S.checkSameFieldActivityMismatch(fName,b2.startTime,b2.endTime,c2.activityName,b2.bunk); if (!am) { var cAn2=normName(c2.activityName); for (var ri2=0;ri2<results.length;ri2++) { var r2=results[ri2]; if (r2.candIdx===-1||normName(r2.pick.field)!==fn2) continue; var rb2=activityBlocks[r2.blockIdx]; if (rb2.startTime<b2.endTime&&rb2.endTime>b2.startTime) { var ra=normName(r2.pick._activity); if (ra&&cAn2&&ra!==cAn2) { am=ra; break; } } } }
                    if (!am) { var sdgu=0; if (b2.divName) { for (var ri3=0;ri3<results.length;ri3++) { var r3=results[ri3]; if (r3.candIdx===-1||normName(r3.pick.field)!==fn2) continue; var rb3=activityBlocks[r3.blockIdx]; if (rb3.divName===b2.divName&&rb3.startTime<b2.endTime&&rb3.endTime>b2.startTime) sdgu++; } } canFit=(S.countSameDivisionUsage(fName,b2.divName,b2.startTime,b2.endTime,b2.bunk)+sdgu<cap); } }
                } else {
                    var xca=S.checkCrossDivisionTimeConflict(fName,b2.divName,b2.startTime,b2.endTime,b2.bunk);
                    if (!xca&&b2.divName) { for (var ria=0;ria<results.length;ria++) { var ra2=results[ria]; if (ra2.candIdx===-1||normName(ra2.pick.field)!==fn2) continue; var rba=activityBlocks[ra2.blockIdx]; if (rba.divName&&rba.divName!==b2.divName&&rba.startTime<b2.endTime&&rba.endTime>b2.startTime) { xca=true; break; } } }
                    canFit=!xca&&(existUse+grpUse<cap);
                }
                if (canFit) {
                    var newPk = S.clonePick(c2);
                    results.push({blockIdx:bo.bi,candIdx:opt.ci,pick:newPk,cost:opt.cost});
                    fieldUsageGrp.set(fn2,grpUse+1);
                    if (!fieldDivsGrp.has(fn2)) fieldDivsGrp.set(fn2,new Set()); fieldDivsGrp.get(fn2).add(b2.divName||'');
                    if (!bunkActsGrp.has(b2.bunk)) bunkActsGrp.set(b2.bunk,new Set());
                    var aAn=normName(c2.activityName); if (aAn&&aAn!=='free') bunkActsGrp.get(b2.bunk).add(aAn);
                    // ★ v15.0: Record fullGrade if activity has _fullGrade
                    if (newPk._fullGrade||actProps[c2.activityName]?.fullGrade||actProps[c2.activityName]?._fullGrade) { fullGradeMap.set(fgKey,{pick:newPk,candIdx:opt.ci,cost:opt.cost}); }
                    assigned=true; break;
                }
                // Augmenting path
                if (st==='not_sharable'&&grpUse>=cap) {
                    S._perfCounters.augmentingPathAttempts++;
                    var holder=null; for (var ri4=results.length-1;ri4>=0;ri4--) { if (normName(results[ri4].pick.field)===fn2&&results[ri4].candIdx!==-1) { holder=ri4; break; } }
                    if (holder!==null) {
                        var hr=results[holder],hBi=hr.blockIdx,hBlk=activityBlocks[hBi];
                        var hOpts=blockOpts.find(function(x){return x.bi===hBi;});
                        if (hOpts) { for (var aoi=0;aoi<hOpts.options.length;aoi++) {
                            var ao=hOpts.options[aoi]; if (ao.ci===hr.candIdx) continue;
                            var ac=allCands[ao.ci],afn=ac._fieldNorm; if (afn===fn2) continue;
                            var agu=fieldUsageGrp.get(afn)||0,acap=S.getFieldCapacity(ac.field);
                            var aeu=hBlk.startTime!==undefined?S.getFieldUsageFromTimeIndex(afn,hBlk.startTime,hBlk.endTime,hBlk.bunk):0;
                            if (aeu+agu<acap) {
                                if (S.checkCrossDivisionTimeConflict(ac.field,hBlk.divName,hBlk.startTime,hBlk.endTime,hBlk.bunk)) continue;
                                var agd=fieldDivsGrp.get(afn); if (agd&&hBlk.divName) { var bad=false; for (var d of agd) { if (d&&d!==hBlk.divName) { bad=true; break; } } if (bad) continue; }
                                fieldUsageGrp.set(fn2,(fieldUsageGrp.get(fn2)||1)-1);
                                results[holder]={blockIdx:hBi,candIdx:ao.ci,pick:S.clonePick(ac),cost:ao.cost};
                                fieldUsageGrp.set(afn,agu+1); if (!fieldDivsGrp.has(afn)) fieldDivsGrp.set(afn,new Set()); fieldDivsGrp.get(afn).add(hBlk.divName||'');
                                results.push({blockIdx:bo.bi,candIdx:opt.ci,pick:S.clonePick(c2),cost:opt.cost});
                                fieldUsageGrp.set(fn2,(fieldUsageGrp.get(fn2)||0)+1); if (!fieldDivsGrp.has(fn2)) fieldDivsGrp.set(fn2,new Set()); fieldDivsGrp.get(fn2).add(b2.divName||'');
                                if (!bunkActsGrp.has(b2.bunk)) bunkActsGrp.set(b2.bunk,new Set()); var augAn=normName(c2.activityName); if (augAn&&augAn!=='free') bunkActsGrp.get(b2.bunk).add(augAn);
                                if (!bunkActsGrp.has(hBlk.bunk)) bunkActsGrp.set(hBlk.bunk,new Set()); var hAn=normName(ac.activityName); if (hAn&&hAn!=='free') bunkActsGrp.get(hBlk.bunk).add(hAn);
                                assigned=true; S._perfCounters.augmentingPathSuccesses++; break;
                            }
                        } }
                    }
                    if (assigned) break;
                }
            }
            if (!assigned) results.push({blockIdx:bo.bi,candIdx:-1,pick:{field:"Free",sport:null,_activity:"Free"},cost:100000});
        }
        return results;
    }

    function propagateAssignment(activityBlocks, idx, pick) {
        var allCands = S.allCandidateOptions;
        var blk = activityBlocks[idx], sM = blk.startTime, eM = blk.endTime;
        if (sM===undefined||eM===undefined) return;
        for (var i=0;i<activityBlocks.length;i++) { if (i===idx||S._assignedBlocks.has(i)) continue; var o=activityBlocks[i]; if (o.startTime===undefined||o.endTime===undefined) continue; if (o.startTime>=eM||o.endTime<=sM) continue; var dom=S._domains.get(i); if (!dom) continue; for (var ci of Array.from(dom)) { if (wouldConflict(blk,pick,o,allCands[ci])) { dom.delete(ci); S._perfCounters.domainPruned++; } } }
    }

    // ========================================================================
    // BACKJUMP + isPickStillValid
    // ========================================================================
    function isPickStillValid(block, cand) {
        var fn=cand.field,fnorm=cand._fieldNorm||normName(fn),bunk=block.bunk,bDiv=block.divName||'',sM=block.startTime,eM=block.endTime;
        if (sM===undefined||eM===undefined) return true;
        var cAn=normName(cand.activityName);
        if (cAn&&cAn!=='free'&&cAn!=='free play') { var bs=window.scheduleAssignments?.[bunk]||[]; var ms=new Set(block.slots||[]); for (var i=0;i<bs.length;i++) { if (ms.has(i)) continue; var e=bs[i]; if (!e||e.continuation||e._isTransition) continue; if (normName(e._activity||e.sport||e.field)===cAn) return false; } }
        if (S.isFieldLockedByTime(fn,sM,eM,bDiv)) return false;
        var fp=S._fieldPropertyMap.get(fn); var cap=fp?fp.capacity:S.getFieldCapacity(fn); var st=fp?fp.sharingType:S.getSharingType(fn);
        if (S.checkCrossDivisionTimeConflict(fn,bDiv,sM,eM,bunk)) return false;
        if (st==='not_sharable') return S.getFieldUsageFromTimeIndex(fnorm,sM,eM,bunk)<cap;
        return S.countSameDivisionUsage(fn,bDiv,sM,eM,bunk)<cap;
    }

    function backjumpSolver(activityBlocks) {
        var allCands=S.allCandidateOptions; var un=[]; for (var i=0;i<activityBlocks.length;i++) { if (!S._assignedBlocks.has(i)) un.push(i); }
        if (un.length===0) return 0; var iter=0,MAX=50000,solved=0;
        un.sort(function(a,b){return (S._domains.get(a)?.size||0)-(S._domains.get(b)?.size||0);});
        for (var bi of un) {
            if (S._assignedBlocks.has(bi)||iter>MAX) break; iter++; S._todayCache.clear();
            var blk=activityBlocks[bi],dom=S._domains.get(bi);
            if (!dom||dom.size===0) { var lcp=null; if (blk.startTime!==undefined&&blk.endTime!==undefined) { var lcs=[]; for (var lci=0;lci<allCands.length;lci++) { var lc=allCands[lci]; if (!isPickStillValid(blk,lc)) continue; S.setScratchPick(lc); var lcc=S.calculatePenaltyCost(blk,S.setScratchPick(lc)); if (lcc<900000) lcs.push({ci:lci,cost:lcc}); } if (lcs.length>0) { lcs.sort(function(x,y){return x.cost-y.cost;}); lcp=S.clonePick(allCands[lcs[0].ci]); } }
                S._assignedBlocks.add(bi); if (lcp) { S._assignments.set(bi,{candIdx:-1,pick:lcp,cost:100000}); S.applyPickToSchedule(blk,lcp); S.invalidateRotationCacheForBunk(blk.bunk); S._todayCache.clear(); } else { S._assignments.set(bi,{candIdx:-1,pick:{field:"Free",sport:null,_activity:"Free"},cost:100000}); S.applyPickToSchedule(blk,S._assignments.get(bi).pick); } continue; }
            var sc=[]; for (var ci of dom) { var c=allCands[ci]; if (!isPickStillValid(blk,c)) continue; S.setScratchPick(c); var cost=S.calculatePenaltyCost(blk,S.setScratchPick(c)); if (cost<900000) sc.push({ci:ci,cost:cost}); }
            sc.sort(function(a,b){return a.cost-b.cost;});
            if (sc.length>0) { var best=sc[0],bp=S.clonePick(allCands[best.ci]); S._assignedBlocks.add(bi); S._assignments.set(bi,{candIdx:best.ci,pick:bp,cost:best.cost}); S.applyPickToSchedule(blk,bp); var fn=normName(bp.field); if (blk.startTime!==undefined&&blk.endTime!==undefined) { var an=normName(bp._activity); S.addToFieldTimeIndex(fn,blk.startTime,blk.endTime,blk.bunk,blk.divName,an); if (an&&an!==fn) S.addToFieldTimeIndex(an,blk.startTime,blk.endTime,blk.bunk,blk.divName,an); } S.invalidateRotationCacheForBunk(blk.bunk); propagateAssignment(activityBlocks,bi,bp); solved++; }
            else { S._assignedBlocks.add(bi); S._assignments.set(bi,{candIdx:-1,pick:{field:"Free",sport:null,_activity:"Free"},cost:100000}); S.applyPickToSchedule(blk,S._assignments.get(bi).pick); }
        }
        return solved;
    }

    // ========================================================================
    // POST-SOLVE + DEEP FREE RESOLUTION
    // ========================================================================
    function postSolveLocalSearch(activityBlocks) {
        var allCands=S.allCandidateOptions; S._todayCache.clear();
        var improvements=0,swapChains=0,MAX_SWAP=500;
        var freeBlocks=[]; for (var i=0;i<activityBlocks.length;i++) { var a=S._assignments.get(i); if (!a) continue; var an=normName(a.pick._activity||a.pick.field); if (an==='free'||an==='free (timeout)') freeBlocks.push(i); }
        if (freeBlocks.length===0) return;
        for (var bi of freeBlocks) { var blk=activityBlocks[bi],dom=S._domains.get(bi); if (!dom) continue; var sc=[]; for (var ci of dom) { var c=allCands[ci]; if (!isPickStillValid(blk,c)) continue; S.setScratchPick(c); var cost=S.calculatePenaltyCost(blk,S.setScratchPick(c)); if (cost<900000) sc.push({ci:ci,cost:cost}); } if (sc.length>0) { sc.sort(function(a,b){return a.cost-b.cost;}); var bp=S.clonePick(allCands[sc[0].ci]); S.undoPickFromSchedule(blk,S._assignments.get(bi).pick); S._assignments.set(bi,{candIdx:sc[0].ci,pick:bp,cost:sc[0].cost}); S.applyPickToSchedule(blk,bp); var fn=normName(bp.field); if (blk.startTime!==undefined&&blk.endTime!==undefined) { var an2=normName(bp._activity); S.addToFieldTimeIndex(fn,blk.startTime,blk.endTime,blk.bunk,blk.divName,an2); if (an2&&an2!==fn) S.addToFieldTimeIndex(an2,blk.startTime,blk.endTime,blk.bunk,blk.divName,an2); } S.invalidateRotationCacheForBunk(blk.bunk); improvements++; } }
        // Swap chains
        var remaining=[]; for (var fi of freeBlocks) { var a2=S._assignments.get(fi); if (a2&&normName(a2.pick._activity||a2.pick.field)==='free') remaining.push(fi); }
        var swapAttempts=0;
        for (var freeIdx of remaining) {
            if (swapAttempts>=MAX_SWAP) break;
            var fb=activityBlocks[freeIdx],fd=S._domains.get(freeIdx); if (!fd||fd.size===0) continue; var swapped=false;
            for (var ci2 of fd) { if (swapped||swapAttempts>=MAX_SWAP) break; swapAttempts++; var wc=allCands[ci2],wfn=wc._fieldNorm; var entries=S._fieldTimeIndex.get(wfn)||[];
                for (var e of entries) { if (swapped) break; if (e.bunk===fb.bunk) continue; if (fb.startTime>=e.endMin||fb.endTime<=e.startMin) continue;
                    var bIdx=findBlockIdx(activityBlocks,e.bunk,e.startMin,e.endMin); if (bIdx===-1) continue; var bd=S._domains.get(bIdx); if (!bd) continue; var bb=activityBlocks[bIdx],alts=[];
                    for (var aci of bd) { var ac=allCands[aci]; if (ac._fieldNorm===wfn) continue; if (!isPickStillValid(bb,ac)) continue; S.setScratchPick(ac); var acost=S.calculatePenaltyCost(bb,S.setScratchPick(ac)); if (acost<900000) alts.push({ci:aci,cost:acost}); }
                    if (alts.length>0) { alts.sort(function(x,y){return x.cost-y.cost;}); S._todayCache.clear(); var wan=normName(wc.activityName); if (wan&&wan!=='free'&&wan!=='free play') { var td=S.getActivitiesDoneToday(fb.bunk,fb.slots?fb.slots[0]:999); if (td.has(wan)) continue; }
                        if (bb.startTime!==undefined&&bb.divName) { var abc=allCands[alts[0].ci]; if (S.checkCrossDivisionTimeConflict(abc.field,bb.divName,bb.startTime,bb.endTime,bb.bunk)) continue; }
                        S.undoPickFromSchedule(bb,S._assignments.get(bIdx).pick); var ap=S.clonePick(allCands[alts[0].ci]); S._assignments.set(bIdx,{candIdx:alts[0].ci,pick:ap,cost:alts[0].cost}); S.applyPickToSchedule(bb,ap);
                        S.undoPickFromSchedule(fb,S._assignments.get(freeIdx).pick); var wp=S.clonePick(wc); S._todayCache.clear(); var wCost=S.calculatePenaltyCost(fb,wp); S._assignments.set(freeIdx,{candIdx:ci2,pick:wp,cost:wCost}); S.applyPickToSchedule(fb,wp);
                        S.invalidateRotationCacheForBunk(bb.bunk); S.invalidateRotationCacheForBunk(fb.bunk); S._todayCache.clear(); swapChains++; swapped=true;
                    }
                }
            }
        }
    }
    function findBlockIdx(activityBlocks,bunk,sM,eM) { for (var i=0;i<activityBlocks.length;i++) { if (activityBlocks[i].bunk===bunk&&activityBlocks[i].startTime===sM&&activityBlocks[i].endTime===eM) return i; } return -1; }

    function deepFreeResolution(activityBlocks) {
        var allCands=S.allCandidateOptions, actProps=S.activityProperties, gCfg=S.globalConfig;
        S._todayCache.clear();
        var freeIdx=[]; for (var i=0;i<activityBlocks.length;i++) { var a=S._assignments.get(i); if (!a) continue; var an=normName(a.pick._activity||a.pick.field); if (an==='free'||an==='free (timeout)') freeIdx.push(i); }
        if (freeIdx.length===0) return 0;
        console.log('[SOLVER-v12.4] 🧠 Deep Free Resolution: '+freeIdx.length+' Free blocks');
        // Sort by division density (divisions with most Free blocks first)
        var divFree = {};
        for (var dfi of freeIdx) { var dfn = activityBlocks[dfi].divName || ''; divFree[dfn] = (divFree[dfn] || 0) + 1; }
        freeIdx.sort(function(a, b) { return (divFree[activityBlocks[b].divName || ''] || 0) - (divFree[activityBlocks[a].divName || ''] || 0); });
        var resolved=0, disabled=window.currentDisabledFields||gCfg?.disabledFields||[];
        for (var idx=0;idx<freeIdx.length;idx++) {
            var bi=freeIdx[idx],blk=activityBlocks[bi],bunk=blk.bunk,bDiv=blk.divName||'',sM=blk.startTime,eM=blk.endTime,slots=blk.slots||[];
            if (sM===undefined||eM===undefined) continue; S._todayCache.clear();
            var fresh=[];
            for (var ci=0;ci<allCands.length;ci++) { var c=allCands[ci]; if (disabled.indexOf(c.field)!==-1) continue; if (window.GlobalFieldLocks?.isFieldLocked(c.field,slots)) continue; if (S.isFieldLockedByTime(c.field,sM,eM,bDiv)) continue; if (S.checkCrossDivisionTimeConflict(c.field,bDiv,sM,eM,bunk)) continue;
                var fp=S._fieldPropertyMap.get(c.field),cap=fp?fp.capacity:S.getFieldCapacity(c.field),st=fp?fp.sharingType:S.getSharingType(c.field);
                if (st==='not_sharable') { if (S.getFieldUsageFromTimeIndex(c._fieldNorm,sM,eM,bunk)>=cap) continue; } else { if (S.countSameDivisionUsage(c.field,bDiv,sM,eM,bunk)>=cap) continue; }
                var td=S.getActivitiesDoneToday(bunk,slots[0]??999),cAn=normName(c.activityName); if (cAn&&cAn!=='free'&&cAn!=='free play'&&td.has(cAn)) continue;
                if (!actProps[c.field]&&!actProps[c.activityName]&&c.type!=='special') continue;
                if (window.SchedulerCoreUtils?.canBlockFit && !(S._isRainyDay && S._rainyTimeBypasses.has(c.field)) && !window.SchedulerCoreUtils.canBlockFit(blk,c.field,actProps,null,c.activityName,false)) continue;
                S.setScratchPick(c); var cost=S.calculatePenaltyCost(blk,S.setScratchPick(c)); if (cost<900000) fresh.push({ci:ci,cost:cost});
            }
            if (fresh.length>0) { fresh.sort(function(a,b){return a.cost-b.cost;}); var pk=S.clonePick(allCands[fresh[0].ci]); S.undoPickFromSchedule(blk,S._assignments.get(bi).pick); S._assignments.set(bi,{candIdx:fresh[0].ci,pick:pk,cost:fresh[0].cost}); S.applyPickToSchedule(blk,pk); var pfn=normName(pk.field); S.addToFieldTimeIndex(pfn,sM,eM,bunk,bDiv,normName(pk._activity)); var pan=normName(pk._activity); if (pan&&pan!==pfn) S.addToFieldTimeIndex(pan,sM,eM,bunk,bDiv,pan); S.invalidateRotationCacheForBunk(bunk); S._todayCache.clear(); resolved++; continue; }
            // Phase 2: Displacement (abbreviated for space — same logic as v12.4)
            for (var obi=0;obi<activityBlocks.length;obi++) {
                var ob=activityBlocks[obi]; if (obi===bi||ob.divName!==bDiv||ob.bunk===bunk) continue;
                if (ob.startTime===undefined||ob.endTime===undefined) continue; if (ob.startTime>=eM||ob.endTime<=sM) continue;
                var oa=S._assignments.get(obi); if (!oa||normName(oa.pick._activity)==='free') continue; S._todayCache.clear();
                if (S.getActivitiesDoneToday(bunk,slots[0]??999).has(normName(oa.pick._activity))) continue;
                var od=S._domains.get(obi); if (!od||od.size===0) continue;
                var cfn=normName(oa.pick.field),alts=[];
                for (var aci of od) { var ac=allCands[aci]; if (normName(ac.field)===cfn) continue; if (!isPickStillValid(ob,ac)) continue; if (S.checkCrossDivisionTimeConflict(ac.field,ob.divName,ob.startTime,ob.endTime,ob.bunk)) continue; S._todayCache.clear(); var otd=S.getActivitiesDoneToday(ob.bunk,ob.slots?.[0]??999); var aAn=normName(ac.activityName); if (aAn&&aAn!=='free'&&otd.has(aAn)) continue; S.setScratchPick(ac); var ac2=S.calculatePenaltyCost(ob,S.setScratchPick(ac)); if (ac2<900000) alts.push({ci:aci,cost:ac2,cand:ac}); }
                if (alts.length===0) continue; alts.sort(function(a,b){return a.cost-b.cost;});
                var saved={candIdx:oa.candIdx,pick:oa.pick,cost:oa.cost};
                S.undoPickFromSchedule(ob,oa.pick); var ap=S.clonePick(alts[0].cand); S._assignments.set(obi,{candIdx:alts[0].ci,pick:ap,cost:alts[0].cost}); S.applyPickToSchedule(ob,ap);
                S.addToFieldTimeIndex(normName(ap.field),ob.startTime,ob.endTime,ob.bunk,ob.divName,normName(ap._activity)); S.removeFromFieldTimeIndex(cfn,ob.startTime,ob.endTime,ob.bunk); S.invalidateRotationCacheForBunk(ob.bunk); S._todayCache.clear();
                var pf2=[]; for (var pci=0;pci<allCands.length;pci++) { var pc=allCands[pci]; if (disabled.indexOf(pc.field)!==-1) continue; if (S.isFieldLockedByTime(pc.field,sM,eM,bDiv)) continue; if (S.checkCrossDivisionTimeConflict(pc.field,bDiv,sM,eM,bunk)) continue; var pfp=S._fieldPropertyMap.get(pc.field),pcap=pfp?pfp.capacity:S.getFieldCapacity(pc.field),pst=pfp?pfp.sharingType:S.getSharingType(pc.field); if (pst==='not_sharable') { if (S.getFieldUsageFromTimeIndex(pc._fieldNorm,sM,eM,bunk)>=pcap) continue; } else { if (S.countSameDivisionUsage(pc.field,bDiv,sM,eM,bunk)>=pcap) continue; } var ptd=S.getActivitiesDoneToday(bunk,slots[0]??999),pAn=normName(pc.activityName); if (pAn&&pAn!=='free'&&pAn!=='free play'&&ptd.has(pAn)) continue; if (!actProps[pc.field]&&!actProps[pc.activityName]&&pc.type!=='special') continue; S.setScratchPick(pc); var pCost=S.calculatePenaltyCost(blk,S.setScratchPick(pc)); if (pCost<900000) pf2.push({ci:pci,cost:pCost}); }
                if (pf2.length>0) { pf2.sort(function(a,b){return a.cost-b.cost;}); var opk=S.clonePick(allCands[pf2[0].ci]); S.undoPickFromSchedule(blk,S._assignments.get(bi).pick); S._assignments.set(bi,{candIdx:pf2[0].ci,pick:opk,cost:pf2[0].cost}); S.applyPickToSchedule(blk,opk); S.addToFieldTimeIndex(normName(opk.field),sM,eM,bunk,bDiv,normName(opk._activity)); S.invalidateRotationCacheForBunk(bunk); S._todayCache.clear(); resolved++; break; }
                else { S.undoPickFromSchedule(ob,ap); S.removeFromFieldTimeIndex(normName(ap.field),ob.startTime,ob.endTime,ob.bunk); S._assignments.set(obi,saved); S.applyPickToSchedule(ob,saved.pick); S.addToFieldTimeIndex(cfn,ob.startTime,ob.endTime,ob.bunk,ob.divName,normName(saved.pick._activity)); S.invalidateRotationCacheForBunk(ob.bunk); S._todayCache.clear(); }
            }
        }
        console.log('[SOLVER-v12.4] 🧠 Complete: '+resolved+'/'+freeIdx.length+' resolved');
        return resolved;
    }

    // ========================================================================
    // INTERNAL SOLVE PASS (v13.0 three-pass)
    // ========================================================================
    function internalSolvePass(activityBlocks, passNum) {
        S._passNumber = passNum;
        S._assignedBlocks.clear(); S._assignments.clear(); S._todayCache.clear();
        // Undo all schedule assignments for solver blocks (preserve _fixed and _bunkOverride)
        for (var i=0;i<activityBlocks.length;i++) { var blk=activityBlocks[i]; var slots=blk.slots||[]; if (!window.scheduleAssignments[blk.bunk]) continue; for (var si=0;si<slots.length;si++) { var existing = window.scheduleAssignments[blk.bunk][slots[si]]; if (existing && !existing._fixed && !existing._bunkOverride) { if (existing.field && window.fieldUsageBySlot?.[slots[si]]?.[existing.field]) { var fu = window.fieldUsageBySlot[slots[si]][existing.field]; if (fu.bunks) delete fu.bunks[blk.bunk]; if (fu.count > 0) fu.count--; } window.scheduleAssignments[blk.bunk][slots[si]] = null; } } }
        S.buildFieldTimeIndex();
        S.precomputeFieldProperties();
        S.precomputeRotationScores(activityBlocks);
        S.precomputeResourceMaps(activityBlocks);
        if (passNum <= 1) S.activityFirstPlanner(activityBlocks);
        Solver.sortBlocksByDifficulty(activityBlocks, S.globalConfig);
        var result = buildDomainsAndSlotGroups(activityBlocks);
        S._domains = result.domains; S._slotGroups = result.slotGroups;
        var ac3 = propagateAC3(activityBlocks);
        var grpSolved = solveSlotGroups(activityBlocks);
        var bjSolved = backjumpSolver(activityBlocks);
        postSolveLocalSearch(activityBlocks);
        deepFreeResolution(activityBlocks);
        var analysis = S.analyzePassResult(activityBlocks, passNum);
        console.log('[SOLVER-v13] Pass '+passNum+' complete: AC3='+ac3.autoAssigned+' Grp='+grpSolved+' BJ='+bjSolved+' Free='+analysis.totalFree);
        return analysis;
    }

    // ========================================================================
    // ★★★ v14.2: SAME-DAY DUPLICATE SWEEP ★★★
    // Final safety — scans entire schedule and removes duplicates
    // ========================================================================
    function sameDayDuplicateSweep(activityBlocks) {
        var schedules = window.scheduleAssignments || {};
        var dupFixCount = 0;
        var bunkActivityMap = new Map();
        // Phase 1: Check solver blocks against each other
        for (var di = 0; di < activityBlocks.length; di++) {
            var dBlock = activityBlocks[di], dAssign = S._assignments.get(di);
            if (!dAssign) continue;
            var dActNorm = normName(dAssign.pick._activity || dAssign.pick.field);
            if (!dActNorm || dActNorm === 'free' || dActNorm === 'free play') continue;
            if (!bunkActivityMap.has(dBlock.bunk)) bunkActivityMap.set(dBlock.bunk, new Map());
            var bunkMap = bunkActivityMap.get(dBlock.bunk);
            if (bunkMap.has(dActNorm)) {
                var existingIdx = bunkMap.get(dActNorm);
                var existingCost = S._assignments.get(existingIdx)?.cost || 0;
                var currentCost = dAssign.cost || 0;
                var replaceIdx = currentCost >= existingCost ? di : existingIdx;
                var keepIdx = replaceIdx === di ? existingIdx : di;
                var replaceBlock = activityBlocks[replaceIdx];
                S.undoPickFromSchedule(replaceBlock, S._assignments.get(replaceIdx).pick);
                var freePick = { field: "Free", sport: null, _activity: "Free" };
                S._assignments.set(replaceIdx, { candIdx: -1, pick: freePick, cost: 100000 });
                S.applyPickToSchedule(replaceBlock, freePick);
                bunkMap.set(dActNorm, keepIdx);
                dupFixCount++;
                console.warn('[v14.2-SWEEP] 🔧 Fixed same-day dup: ' + dBlock.bunk + ' "' + dActNorm + '" twice → block ' + replaceIdx + ' → Free');
            } else {
                bunkMap.set(dActNorm, di);
            }
        }
        // Phase 2: Check solver blocks against pinned/fixed entries
        for (var [dsBunk, dsActMap] of bunkActivityMap) {
            var dsBunkSlots = schedules[dsBunk] || [];
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
                    S.undoPickFromSchedule(conflictBlock, S._assignments.get(conflictIdx).pick);
                    var freePick2 = { field: "Free", sport: null, _activity: "Free" };
                    S._assignments.set(conflictIdx, { candIdx: -1, pick: freePick2, cost: 100000 });
                    S.applyPickToSchedule(conflictBlock, freePick2);
                    dsActMap.delete(dsAct);
                    dupFixCount++;
                    console.warn('[v14.2-SWEEP] 🔧 Fixed dup vs pinned: ' + dsBunk + ' "' + dsAct + '" solver block ' + conflictIdx + ' vs pinned slot ' + dssi);
                }
            }
        }
        if (dupFixCount > 0) {
            console.warn('[v14.2-SWEEP] ★★★ Fixed ' + dupFixCount + ' same-day duplicate(s) ★★★');
            S._todayCache.clear();
            deepFreeResolution(activityBlocks);
        }
        return dupFixCount;
    }

    // ========================================================================
    // ★★★ v14.1: CROSS-DIVISION VIOLATION RE-SOLVE ★★★
    // ========================================================================
    function crossDivisionReSolve(activityBlocks) {
        var allCands = S.allCandidateOptions, actProps = S.activityProperties;
        var violations = [];
        for (var i = 0; i < activityBlocks.length; i++) {
            var asgn = S._assignments.get(i); if (!asgn || asgn.candIdx === -1) continue;
            var blk = activityBlocks[i];
            if (blk.startTime === undefined || blk.endTime === undefined) continue;
            var conflict = S.checkCrossDivisionTimeConflict(asgn.pick.field, blk.divName, blk.startTime, blk.endTime, blk.bunk);
            if (conflict) violations.push({ blockIdx: i, block: blk, assignment: asgn, conflict: conflict });
        }
        if (violations.length === 0) return 0;
        console.log('[v14.1] 🔧 Cross-division violations: ' + violations.length);
        var resolved = 0;
        for (var vi = 0; vi < violations.length; vi++) {
            var v = violations[vi], bi = v.blockIdx, blk2 = v.block;
            S._todayCache.clear();
            var alt = [];
            for (var ci = 0; ci < allCands.length; ci++) {
                var c = allCands[ci]; if (!isPickStillValid(blk2, c)) continue;
                if (S.checkCrossDivisionTimeConflict(c.field, blk2.divName, blk2.startTime, blk2.endTime, blk2.bunk)) continue;
                S.setScratchPick(c); var cost = S.calculatePenaltyCost(blk2, S.setScratchPick(c));
                if (cost < 900000) alt.push({ ci: ci, cost: cost });
            }
            if (alt.length > 0) {
                alt.sort(function(a, b) { return a.cost - b.cost; });
                var pk = S.clonePick(allCands[alt[0].ci]);
                S.undoPickFromSchedule(blk2, v.assignment.pick);
                S._assignments.set(bi, { candIdx: alt[0].ci, pick: pk, cost: alt[0].cost });
                S.applyPickToSchedule(blk2, pk);
                var fn = normName(pk.field);
                S.addToFieldTimeIndex(fn, blk2.startTime, blk2.endTime, blk2.bunk, blk2.divName, normName(pk._activity));
                S.invalidateRotationCacheForBunk(blk2.bunk); S._todayCache.clear();
                resolved++;
            }
        }
        console.log('[v14.1] 🔧 Resolved: ' + resolved + '/' + violations.length);
        return resolved;
    }

    // ========================================================================
    // ★★★ MAIN SOLVER PIPELINE (v15.0 — rainy init + three-pass) ★★★
    // ========================================================================
    Solver.solveSchedule = function(activityBlocks, config) {
        var startTime = performance.now();
        console.log('╔═══════════════════════════════════════════════════════════╗');
        console.log('║  TOTAL SOLVER ENGINE v15.0 — fullGrade + Rainy Day       ║');
        console.log('╚═══════════════════════════════════════════════════════════╝');
        console.log('[SOLVER] Input: ' + activityBlocks.length + ' blocks');

        S.clearAllCaches();
        S.clearBunkDivisionCache();
        S.globalConfig = config || {};
        S.activityProperties = window.activityProperties || config.activityProperties || {};
        if (!window.leagueRoundState) window.leagueRoundState = {};
        if (!S.globalConfig.rotationHistory) S.globalConfig.rotationHistory = {};
        if (!S.globalConfig.rotationHistory.leagues) S.globalConfig.rotationHistory.leagues = {};
        if (window.RotationEngine?.clearHistoryCache) window.RotationEngine.clearHistoryCache();

        // ★★★ v15.0: DETECT RAINY DAY AND CACHE OVERRIDES ★★★
        S.detectRainyDayMode(config);

        S.allCandidateOptions = S.buildAllCandidateOptions(S.globalConfig);
        if (S.allCandidateOptions.length === 0) { console.error('[SOLVER] No candidate options!'); return; }

        // Ensure divName is set for all blocks
        for (var pi = 0; pi < activityBlocks.length; pi++) {
            var pb = activityBlocks[pi];
            if (!pb.divName && !pb.division && pb.bunk) pb.divName = getBunkDivision(pb.bunk) || '';
        }

        // v13.0: Three-pass pipeline
        var bestAnalysis = null, bestPass = -1;
        var savedAssignments = [];

        for (var pass = 0; pass < 3; pass++) {
            console.log('\n[SOLVER-v13] ═══ PASS ' + (pass + 1) + '/3 ═══');
            var analysis = internalSolvePass(activityBlocks, pass + 1);

            if (!bestAnalysis || analysis.score < bestAnalysis.score) {
                bestAnalysis = analysis; bestPass = pass + 1;
                // Save schedule state
                savedAssignments = [];
                for (var si = 0; si < activityBlocks.length; si++) {
                    var sa = S._assignments.get(si);
                    if (sa) savedAssignments.push({ blockIdx: si, candIdx: sa.candIdx, pick: JSON.parse(JSON.stringify(sa.pick)), cost: sa.cost });
                }
            }

            if (analysis.totalFree === 0 && analysis.yesterdayRepeats.length === 0) {
                console.log('[SOLVER-v13] ✅ Perfect score on pass ' + (pass + 1) + ' — skipping remaining');
                break;
            }

            if (pass < 2) S.adjustPlanFromAnalysis(activityBlocks, analysis);
        }

        // Restore best pass
        if (bestPass > 0 && savedAssignments.length > 0) {
            console.log('[SOLVER-v13] 🏆 Best pass: ' + bestPass + ' (score: ' + bestAnalysis.score + ')');
            // Clear and re-apply
            for (var ri = 0; ri < activityBlocks.length; ri++) {
                var rb = activityBlocks[ri], rs = rb.slots || [];
                if (!window.scheduleAssignments[rb.bunk]) continue;
                for (var rsi = 0; rsi < rs.length; rsi++) window.scheduleAssignments[rb.bunk][rs[rsi]] = null;
            }
            S._assignedBlocks.clear(); S._assignments.clear();
            for (var sai = 0; sai < savedAssignments.length; sai++) {
                var sa2 = savedAssignments[sai];
                S._assignedBlocks.add(sa2.blockIdx);
                S._assignments.set(sa2.blockIdx, { candIdx: sa2.candIdx, pick: sa2.pick, cost: sa2.cost });
                S.applyPickToSchedule(activityBlocks[sa2.blockIdx], sa2.pick);
            }
        }

        // v14.1: Cross-division re-solve
        S.buildFieldTimeIndex();
        crossDivisionReSolve(activityBlocks);

        // v14.2: Same-day duplicate sweep (with pinned check)
        sameDayDuplicateSweep(activityBlocks);

        // Final stats
        var freeCount = 0;
        for (var fi = 0; fi < activityBlocks.length; fi++) {
            var fa = S._assignments.get(fi);
            if (fa && (normName(fa.pick._activity || fa.pick.field) === 'free' || normName(fa.pick._activity || fa.pick.field) === 'free (timeout)')) freeCount++;
        }

        var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log('╔═══════════════════════════════════════════════════════════╗');
        console.log('║  SOLVE COMPLETE in ' + elapsed + 's');
        console.log('║  ' + activityBlocks.length + ' blocks, ' + freeCount + ' Free');
        if (S._isRainyDay) console.log('║  🌧️ Rainy Day: ' + S._rainyCapOverrides.size + ' cap overrides, ' + S._rainyTimeBypasses.size + ' time bypasses');
        console.log('╚═══════════════════════════════════════════════════════════╝');

        // Return results array (used by callers)
        var results = [];
        for (var rri = 0; rri < activityBlocks.length; rri++) {
            var rrBlk = activityBlocks[rri], rrAsgn = S._assignments.get(rri);
            var rrSolution = rrAsgn ? rrAsgn.pick : { field: "Free", sport: null, _activity: "Free" };
            results.push({ block: rrBlk, pick: rrSolution, bunk: rrBlk.bunk, slots: rrBlk.slots, divName: rrBlk.divName, cost: rrAsgn?.cost ?? 100000 });
        }
        return results;
    };

    // ========================================================================
    // LEGACY API
    // ========================================================================
    Solver.generateSchedule = function(activityBlocks, config) { return Solver.solveSchedule(activityBlocks, config); };

    Solver.getValidActivityPicks = function(block) {
        var allCands = S.allCandidateOptions, actProps = S.activityProperties;
        var picks = [], slots = block.slots || [], bunk = block.bunk;
        var blockDiv = block.divName || block.division;
        if (!blockDiv) { blockDiv = getBunkDivision(bunk); if (blockDiv) block.divName = blockDiv; }
        var startMin = block.startTime, endMin = block.endTime;
        if (startMin === undefined || endMin === undefined) {
            var divSlots = window.divisionTimes?.[blockDiv] || [];
            if (slots.length > 0 && divSlots[slots[0]]) { startMin = divSlots[slots[0]].startMin; var ls = divSlots[slots[slots.length - 1]]; endMin = ls ? ls.endMin : (startMin + 40); }
        }
        if (!allCands || allCands.length === 0) allCands = S.buildAllCandidateOptions(S.globalConfig || {});
        var todayDone = S.getActivitiesDoneToday(bunk, slots[0] ?? 999);
        for (var ci = 0; ci < allCands.length; ci++) {
            var c = allCands[ci], fn = c.field, an = normName(c.activityName);
            if (an && an !== 'free' && todayDone.has(an)) continue;
            if (window.GlobalFieldLocks?.isFieldLocked(fn, slots, blockDiv)) continue;
            if (startMin !== undefined && endMin !== undefined) {
                if (S.isFieldLockedByTime(fn, startMin, endMin, blockDiv)) continue;
                if (S.checkCrossDivisionTimeConflict(fn, blockDiv, startMin, endMin, bunk)) continue;
            }
            var fp = S._fieldPropertyMap.get(fn), cap = fp ? fp.capacity : S.getFieldCapacity(fn), st = fp ? fp.sharingType : S.getSharingType(fn);
            if (startMin !== undefined && endMin !== undefined) {
                if (st === 'not_sharable') { if (S.getFieldUsageFromTimeIndex(normName(fn), startMin, endMin, bunk) >= cap) continue; }
                else { if (S.countSameDivisionUsage(fn, blockDiv, startMin, endMin, bunk) >= cap) continue; }
            }
            picks.push({ field: fn, sport: c.sport, _activity: c.activityName, _type: c.type });
        }
        return picks;
    };

    // ========================================================================
    // LEAGUE MATCHUP ENGINE
    // ========================================================================
    Solver.generateLeagueMatchups = function(config) {
        var teams = config.teams || [], rounds = config.rounds || 1, existingMatchups = config.existingMatchups || [];
        if (teams.length < 2) return existingMatchups;
        var matchups = existingMatchups.slice(), pairCounts = {};
        for (var i = 0; i < matchups.length; i++) {
            var m = matchups[i]; if (!m || !m.team1 || !m.team2) continue;
            var pk = [m.team1, m.team2].sort().join('|');
            pairCounts[pk] = (pairCounts[pk] || 0) + 1;
        }
        for (var r = 0; r < rounds; r++) {
            var roundMatchups = [], used = new Set(), shuffled = teams.slice();
            for (var si = shuffled.length - 1; si > 0; si--) { var sj = Math.floor(Math.random() * (si + 1)); var tmp = shuffled[si]; shuffled[si] = shuffled[sj]; shuffled[sj] = tmp; }
            var candidates = [];
            for (var ti = 0; ti < shuffled.length; ti++) {
                for (var tj = ti + 1; tj < shuffled.length; tj++) {
                    var t1 = shuffled[ti], t2 = shuffled[tj];
                    var pk2 = [t1, t2].sort().join('|');
                    candidates.push({ team1: t1, team2: t2, count: pairCounts[pk2] || 0 });
                }
            }
            candidates.sort(function(a, b) { return a.count - b.count; });
            for (var ci = 0; ci < candidates.length; ci++) {
                var c = candidates[ci];
                if (used.has(c.team1) || used.has(c.team2)) continue;
                roundMatchups.push({ team1: c.team1, team2: c.team2, round: matchups.length + roundMatchups.length + 1 });
                used.add(c.team1); used.add(c.team2);
                var pk3 = [c.team1, c.team2].sort().join('|');
                pairCounts[pk3] = (pairCounts[pk3] || 0) + 1;
                if (used.size >= teams.length - 1) break;
            }
            matchups = matchups.concat(roundMatchups);
        }
        return matchups;
    };

    // ========================================================================
    // DEBUG UTILITIES
    // ========================================================================
    Solver.debugFieldConflicts = function(fieldName) {
        var fn = normName(fieldName); var entries = S._fieldTimeIndex.get(fn);
        if (!entries || entries.length === 0) { console.log('[DEBUG] No entries for ' + fieldName); return; }
        console.log('[DEBUG] ' + fieldName + ': ' + entries.length + ' entries');
        for (var i = 0; i < entries.length; i++) { var e = entries[i]; console.log('  ' + e.startMin + '-' + e.endMin + ' ' + e.bunk + ' (' + e.divName + ') act=' + e.activityName); }
    };
    Solver.debugBlockAssignment = function(blockIdx) {
        var a = S._assignments.get(blockIdx);
        if (!a) { console.log('[DEBUG] Block ' + blockIdx + ' not assigned'); return; }
        console.log('[DEBUG] Block ' + blockIdx + ':', a.pick._activity || a.pick.field, 'field=' + a.pick.field, 'cost=' + a.cost);
    };
    Solver.debugPerfCounters = function() { console.table(S._perfCounters); };
    Solver.debugRainyDay = function() {
        console.log('[DEBUG] Rainy Day Active:', S._isRainyDay);
        if (S._rainyCapOverrides.size > 0) { console.log('[DEBUG] Capacity Overrides:'); for (var [k, v] of S._rainyCapOverrides) console.log('  ' + k + ' → ' + v); }
        if (S._rainyTimeBypasses.size > 0) { console.log('[DEBUG] Time Bypasses:', Array.from(S._rainyTimeBypasses)); }
    };
    Solver.debugSolverStats = function() {
        console.log('\n=== SOLVER v15.0 STATS ===');
        console.log('Field property map: ' + S._fieldPropertyMap.size + ', Rotation score map: ' + (S._perfCounters.rotationCacheHits + S._perfCounters.rotationCacheMisses));
        console.log('Field time index: ' + S._fieldTimeIndex.size + ' fields, Assigned: ' + S._assignedBlocks.size);
        console.log('Aug path: ' + S._perfCounters.augmentingPathAttempts + ' attempts, ' + S._perfCounters.augmentingPathSuccesses + ' successes');
        if (S._isRainyDay) console.log('🌧️ Rainy: ' + S._rainyCapOverrides.size + ' cap overrides, ' + S._rainyTimeBypasses.size + ' time bypasses');
    };
    Solver.debugDomains = function(blockIdx) {
        if (!S._domains) { console.log('No domains'); return; } var d = S._domains.get(blockIdx); if (!d) { console.log('No domain for block ' + blockIdx); return; }
        console.log('Block ' + blockIdx + ': ' + d.size + ' options');
        for (var ci of d) { var c = S.allCandidateOptions[ci]; console.log('  [' + ci + '] ' + c.field + ' -> ' + c.activityName); }
    };
    Solver.debugCrossDivConflict = function(fieldName, divName, slotIdx) {
        var divSlots = window.divisionTimes?.[divName] || [], slot = divSlots[slotIdx]; if (!slot) { console.log('Slot not found'); return; }
        console.log('\n🔍 Cross-Division Check: "' + fieldName + '" at Div ' + divName + ' Slot ' + slotIdx + ' Time: ' + slot.startMin + '-' + slot.endMin);
        var entries = S._fieldTimeIndex.get(normName(fieldName)) || [];
        entries.forEach(function(e) { if (e.startMin < slot.endMin && e.endMin > slot.startMin) console.log('    ⚠️ OVERLAP: Div ' + e.divName + ' Bunk ' + e.bunk + ' (' + e.startMin + '-' + e.endMin + ')'); });
    };

    // ========================================================================
    // EXPOSE
    // ========================================================================
    window.totalSolverEngine = Solver;
    window.TotalSolver = Solver;
    window.TotalSolverEngine = Solver;

    console.log('[SOLVER] Part 2 loaded (v15.0 — pipeline, fullGrade per-grade, rainy day)');
})();
