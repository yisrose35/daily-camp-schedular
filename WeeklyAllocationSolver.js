// =================================================================
// WeeklyAllocationSolver.js  (v1.0)
// =================================================================
// Runs once per week (or on demand). Takes grade-level layer rules
// with timesPerWeek constraints and distributes activity categories
// across bunks and days. Reads previous week's matrix for rotation
// continuity. Produces a weekly bunk matrix that BunkTimelineSolver
// consumes during daily generation.
//
// KEY CONCEPTS:
//   Layer Rule  — user-defined constraint per grade:
//                 { type, duration, windowStart, windowEnd,
//                   timesPerDay, timesPerWeek, weeklyOp }
//   Weekly Matrix — output: per-bunk, per-day list of activity types
//                 saved to globalSettings.app1.weeklyBunkMatrix
//   Locked Cell — user-override on the matrix; treated as a hard
//                 commitment the daily engine cannot move
//
// STORAGE:
//   globalSettings.app1.gradeLayerRules    — layer rule definitions
//   globalSettings.app1.weeklyBunkMatrix   — { weekKey: { bunk: { dateStr: [types] } } }
//   globalSettings.app1.weeklyBunkLocks    — { weekKey: { bunk: { dateStr: [types] } } }
//
// ARCHITECTURE CONTRACT:
//   - Reads from RotationEngine.getDaysSinceActivity for fairness
//   - Reads from campStructure for bunks-per-grade
//   - Does NOT modify total_solver_engine.js or rotation_engine.js
//   - Does NOT touch perBunkSlots (that's BunkTimelineSolver's job)
//   - Output format is directly consumed by BunkTimelineSolver.js
// =================================================================

(function () {
    'use strict';

    var VERSION = '1.0';

    // =================================================================
    // LOGGING
    // =================================================================
    var _logs = [];
    function log(msg) {
        _logs.push(msg);
        console.log('[WeeklyAllocSolver] ' + msg);
    }
    function warn(msg) {
        _logs.push('⚠ ' + msg);
        console.warn('[WeeklyAllocSolver] ' + msg);
    }
    function getLogs() { return _logs.slice(); }
    function clearLogs() { _logs = []; }

    // =================================================================
    // DATE UTILITIES
    // =================================================================

    /** Return 'YYYY-Www' ISO week key for a given date string */
    function getWeekKey(dateStr) {
        var d = new Date(dateStr);
        var jan4 = new Date(d.getFullYear(), 0, 4);
        var startOfWeek = new Date(jan4);
        startOfWeek.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
        var diff = d - startOfWeek;
        var weekNum = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
        return d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
    }

    /**
     * Return the ISO date strings for Mon–Fri of the week containing dateStr.
     * Camps typically run Mon–Fri; we expose this so callers can pass
     * custom day lists if needed (e.g., Sun–Thu camps).
     */
    function getWeekDays(dateStr, activeDays) {
        activeDays = activeDays || [1, 2, 3, 4, 5]; // Mon=1 … Fri=5
        var d = new Date(dateStr);
        var dow = d.getDay(); // 0=Sun
        var monday = new Date(d);
        monday.setDate(d.getDate() - ((dow + 6) % 7));
        var days = [];
        for (var i = 0; i < 7; i++) {
            var cur = new Date(monday);
            cur.setDate(monday.getDate() + i);
            var curDow = cur.getDay();
            if (activeDays.indexOf(curDow) !== -1) {
                days.push(toDateStr(cur));
            }
        }
        return days;
    }

    function toDateStr(d) {
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function addDays(dateStr, n) {
        var d = new Date(dateStr);
        d.setDate(d.getDate() + n);
        return toDateStr(d);
    }

    // =================================================================
    // SETTINGS ACCESSORS
    // =================================================================

    function getGlobalSettings() {
        return window.loadGlobalSettings ? window.loadGlobalSettings() : {};
    }

    function getApp1() {
        return getGlobalSettings().app1 || {};
    }

    function getCampStructure() {
        return getGlobalSettings().campStructure || {};
    }

    /**
     * Get all grade → bunk mappings.
     * Returns { gradeName: [bunkName, ...], ... }
     */
    function getGradeBunkMap() {
        var structure = getCampStructure();
        var map = {};
        Object.keys(structure).forEach(function (divName) {
            var divData = structure[divName];
            if (!divData || typeof divData !== 'object') return;
            var grades = divData.grades || {};
            Object.keys(grades).forEach(function (gradeName) {
                var gradeData = grades[gradeName];
                var bunks = Array.isArray(gradeData.bunks) ? gradeData.bunks : [];
                if (bunks.length === 0) return;
                // Use qualified key if the grade name appears in multiple divisions
                map[gradeName] = bunks;
            });
        });
        return map;
    }

    /**
     * Get all bunks, flat list.
     */
    function getAllBunks() {
        var map = getGradeBunkMap();
        var bunks = [];
        Object.values(map).forEach(function (bs) {
            bs.forEach(function (b) {
                if (bunks.indexOf(b) === -1) bunks.push(b);
            });
        });
        return bunks;
    }

    /**
     * Load the layer rules for all grades.
     * Stored at app1.gradeLayerRules: { gradeName: [layerRule, ...] }
     * Each layerRule: {
     *   id, type, duration, windowStart, windowEnd,
     *   timesPerDay, timesPerWeek, weeklyOp
     * }
     */
    function getGradeLayerRules() {
        return getApp1().gradeLayerRules || {};
    }

    // =================================================================
    // ANCHOR CLASSIFICATION
    // =================================================================

    /**
     * Compute the anchor class for a layer rule.
     * ratio = duration / (windowEnd - windowStart)  [both in minutes]
     * >= 0.85  → HARD
     * 0.40–0.84 → SOFT
     * < 0.40   → FILLER
     * > 1.00   → INVALID
     */
    function classifyAnchor(layer) {
        var dur = layer.duration || 0;
        var windowMin = (layer.windowEnd || 0) - (layer.windowStart || 0);
        if (windowMin <= 0) return 'HARD'; // No window = fixed
        var ratio = dur / windowMin;
        if (ratio > 1.0) return 'INVALID';
        if (ratio >= 0.85) return 'HARD';
        if (ratio >= 0.40) return 'SOFT';
        return 'FILLER';
    }

    // =================================================================
    // WEEKLY CONSTRAINT RESOLUTION
    // =================================================================

    /**
     * For a single layer rule, resolve the min/max times-per-week.
     * weeklyOp: '=' | '>=' | '<='
     * Returns { min, max }
     */
    function resolveWeeklyConstraint(layer, numDays) {
        var tpw = layer.timesPerWeek;
        var op = layer.weeklyOp || '>=';
        var tpd = layer.timesPerDay || 1;

        // If timesPerWeek not set, derive from timesPerDay × numDays
        if (!tpw && tpw !== 0) {
            tpw = tpd * numDays;
            op = '<=';
        }

        tpw = parseInt(tpw, 10) || 0;
        var absoluteMax = tpd * numDays;

        if (op === '=' || op === '==') {
            return { min: tpw, max: tpw };
        } else if (op === '>=') {
            return { min: tpw, max: absoluteMax };
        } else if (op === '<=') {
            return { min: 0, max: Math.min(tpw, absoluteMax) };
        }
        return { min: 0, max: absoluteMax };
    }

    // =================================================================
    // ROTATION SCORING
    // =================================================================

    /**
     * Score how much bunk needs a given activity type.
     * Higher = needs it more = allocate earlier in the week.
     * Uses RotationEngine.getDaysSinceActivity if available,
     * otherwise falls back to a uniform score.
     */
    function rotationScore(bunkName, activityType) {
        if (window.RotationEngine && window.RotationEngine.getDaysSinceActivity) {
            var days = window.RotationEngine.getDaysSinceActivity(bunkName, activityType, 0);
            if (days === null || days === undefined) return 999; // Never done → highest priority
            return days;
        }
        // Fallback via SchedulerCoreUtils
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDaysSinceActivity) {
            var days2 = window.SchedulerCoreUtils.getDaysSinceActivity(bunkName, activityType, 0);
            if (days2 === null || days2 === undefined) return 999;
            return days2;
        }
        return 1; // No history available — treat all bunks equally
    }

    // =================================================================
    // PREVIOUS WEEK MATRIX READ
    // =================================================================

    /**
     * Read the matrix for the previous week.
     * Returns { bunk: { dateStr: [types] } } or {}
     */
    function getPreviousWeekMatrix(weekKey) {
        var app1 = getApp1();
        var stored = app1.weeklyBunkMatrix || {};
        // Derive prev week key
        var prevWeekDate = addDays(weekKey.split('-W')[0] + '-01-01', -7);
        var prevKey = getWeekKey(prevWeekDate);
        return stored[prevKey] || {};
    }

    // =================================================================
    // LOCK ACCESSORS
    // =================================================================

    function getWeekLocks(weekKey) {
        var app1 = getApp1();
        var locks = app1.weeklyBunkLocks || {};
        return locks[weekKey] || {};
    }

    function saveWeekLocks(weekKey, locks) {
        var g = getGlobalSettings();
        if (!g.app1) g.app1 = {};
        if (!g.app1.weeklyBunkLocks) g.app1.weeklyBunkLocks = {};
        g.app1.weeklyBunkLocks[weekKey] = locks;
        if (window.saveGlobalSettings) window.saveGlobalSettings('app1', g.app1);
        window.forceSyncToCloud && window.forceSyncToCloud();
    }

    // =================================================================
    // CORE SOLVER
    // =================================================================

    /**
     * Solve the weekly allocation for all bunks.
     *
     * @param {string} dateStr — any date within the target week
     * @param {object} [opts]
     *   opts.activeDays    {number[]}  day-of-week indices to include (default [1,2,3,4,5])
     *   opts.force         {boolean}   re-solve even if matrix already exists for this week
     * @returns {object} result
     *   result.weekKey     {string}
     *   result.matrix      { bunk: { dateStr: [types] } }
     *   result.warnings    {string[]}
     *   result.skipped     {boolean}   true if existing matrix was returned without re-solving
     */
    function solve(dateStr, opts) {
        opts = opts || {};
        clearLogs();

        var weekKey = getWeekKey(dateStr);
        var weekDays = getWeekDays(dateStr, opts.activeDays);
        var numDays = weekDays.length;
        var warnings = [];

        log('==================================================');
        log('WeeklyAllocationSolver v' + VERSION);
        log('Week: ' + weekKey + ' (' + numDays + ' days: ' + weekDays.join(', ') + ')');
        log('==================================================');

        // ── Return existing matrix if not forcing re-solve ──────────────
        if (!opts.force) {
            var app1Check = getApp1();
            var existing = (app1Check.weeklyBunkMatrix || {})[weekKey];
            if (existing && Object.keys(existing).length > 0) {
                log('Existing matrix found for ' + weekKey + ' — returning without re-solve (pass force:true to override)');
                return { weekKey: weekKey, matrix: existing, warnings: [], skipped: true };
            }
        }

        // ── Load data ───────────────────────────────────────────────────
        var gradeBunkMap = getGradeBunkMap();
        var gradeLayerRules = getGradeLayerRules();
        var locks = getWeekLocks(weekKey);

        var gradeNames = Object.keys(gradeBunkMap);
        if (gradeNames.length === 0) {
            warn('No grades found in camp structure');
            return { weekKey: weekKey, matrix: {}, warnings: ['No grades found in camp structure'], skipped: false };
        }

        log('Grades: ' + gradeNames.join(', '));

        // ── Build the matrix skeleton ────────────────────────────────────
        // matrix[bunk][dateStr] = [activityType, ...]
        var matrix = {};
        var allBunks = [];

        gradeNames.forEach(function (grade) {
            (gradeBunkMap[grade] || []).forEach(function (bunk) {
                if (allBunks.indexOf(bunk) === -1) allBunks.push(bunk);
                if (!matrix[bunk]) {
                    matrix[bunk] = {};
                    weekDays.forEach(function (d) { matrix[bunk][d] = []; });
                }
            });
        });

        log('Bunks: ' + allBunks.length + ' total');

        // ── Apply locks first (they are immovable) ───────────────────────
        var lockedCellCount = 0;
        Object.keys(locks).forEach(function (bunk) {
            if (!matrix[bunk]) return;
            Object.keys(locks[bunk] || {}).forEach(function (d) {
                if (!matrix[bunk][d]) return;
                matrix[bunk][d] = locks[bunk][d].slice(); // copy locked types
                lockedCellCount++;
            });
        });
        if (lockedCellCount > 0) log('Applied ' + lockedCellCount + ' locked cells');

        // ── Process each grade ───────────────────────────────────────────
        gradeNames.forEach(function (grade) {
            var bunks = gradeBunkMap[grade] || [];
            var rules = gradeLayerRules[grade] || [];

            if (bunks.length === 0) { warn('Grade ' + grade + ': no bunks'); return; }
            if (rules.length === 0) { warn('Grade ' + grade + ': no layer rules defined'); return; }

            log('\n[Grade: ' + grade + '] ' + bunks.length + ' bunks, ' + rules.length + ' rules');

            // Classify rules, compute weekly constraints, validate
            var processedRules = [];
            rules.forEach(function (rule) {
                var anchor = classifyAnchor(rule);
                if (anchor === 'INVALID') {
                    var msg = grade + ': Layer "' + rule.type + '" has duration > window — INVALID, skipped';
                    warn(msg);
                    warnings.push(msg);
                    return;
                }
                var constraint = resolveWeeklyConstraint(rule, numDays);
                processedRules.push({
                    type: rule.type,
                    anchor: anchor,
                    timesPerDay: rule.timesPerDay || 1,
                    constraint: constraint, // { min, max }
                    rule: rule
                });
                log('  Rule "' + rule.type + '": anchor=' + anchor +
                    ', weekly ' + (rule.weeklyOp || '>=') + ' ' + (rule.timesPerWeek || '?') +
                    ' → min=' + constraint.min + ' max=' + constraint.max);
            });

            // Sort rules: HARD first (must-satisfy), then SOFT, then FILLER
            processedRules.sort(function (a, b) {
                var order = { HARD: 0, SOFT: 1, FILLER: 2 };
                return (order[a.anchor] || 2) - (order[b.anchor] || 2);
            });

            // ── Per-bunk allocation ──────────────────────────────────────
            bunks.forEach(function (bunk) {
                var bunkMatrix = matrix[bunk]; // { dateStr: [types] }

                processedRules.forEach(function (pr) {
                    var type = pr.type;
                    var minNeeded = pr.constraint.min;
                    var maxAllowed = pr.constraint.max;
                    var timesPerDay = pr.timesPerDay;

                    // Count slots already assigned (from locks)
                    var currentCount = 0;
                    weekDays.forEach(function (d) {
                        (bunkMatrix[d] || []).forEach(function (t) {
                            if (t === type) currentCount++;
                        });
                    });

                    if (currentCount >= minNeeded && currentCount > 0) {
                        log('  ' + bunk + ' / ' + type + ': already satisfied by locks (' + currentCount + ')');
                        return;
                    }

                    var remaining = Math.min(maxAllowed, minNeeded) - currentCount;
                    if (remaining <= 0) return;

                    // Score each day by rotation need (how long since bunk did this type)
                    // Then spread the remaining slots across highest-need days first
                    var dayScores = weekDays.map(function (d) {
                        // Is the cell locked? If so, don't add more to it
                        var isLocked = locks[bunk] && locks[bunk][d];
                        var slotsFilled = (bunkMatrix[d] || []).filter(function (t) { return t === type; }).length;
                        var slotsOpen = timesPerDay - slotsFilled;
                        if (isLocked || slotsOpen <= 0) return null;

                        // Use rotation score to bias which days get this activity
                        // (proxy: rotation score for the type, weighted by day-of-week distance
                        //  from the last known occurrence — simpler is better here)
                        var score = rotationScore(bunk, type);
                        return { d: d, score: score, slotsOpen: slotsOpen };
                    }).filter(Boolean);

                    // Sort by score descending (highest need first)
                    dayScores.sort(function (a, b) { return b.score - a.score; });

                    var placed = 0;
                    for (var di = 0; di < dayScores.length && placed < remaining; di++) {
                        var ds = dayScores[di];
                        var canPlace = Math.min(ds.slotsOpen, remaining - placed);
                        for (var ci = 0; ci < canPlace; ci++) {
                            bunkMatrix[ds.d].push(type);
                            placed++;
                        }
                    }

                    if (placed < minNeeded - currentCount) {
                        var msg = grade + ' / ' + bunk + ' / ' + type +
                            ': could only place ' + (placed + currentCount) + ' of ' + minNeeded + ' required slots';
                        warn(msg);
                        warnings.push(msg);
                    } else {
                        log('  ' + bunk + ' / ' + type + ': placed ' + placed + ' slot(s) across week');
                    }
                });
            });
        });

        // ── Persist matrix ───────────────────────────────────────────────
        _saveMatrix(weekKey, matrix);

        log('\n==================================================');
        log('SOLVE COMPLETE: ' + allBunks.length + ' bunks × ' + numDays + ' days');
        if (warnings.length > 0) log(warnings.length + ' warning(s)');
        log('==================================================');

        return { weekKey: weekKey, matrix: matrix, warnings: warnings, skipped: false };
    }

    // =================================================================
    // STORAGE
    // =================================================================

    function _saveMatrix(weekKey, matrix) {
        try {
            var g = getGlobalSettings();
            if (!g.app1) g.app1 = {};
            if (!g.app1.weeklyBunkMatrix) g.app1.weeklyBunkMatrix = {};
            g.app1.weeklyBunkMatrix[weekKey] = matrix;
            if (window.saveGlobalSettings) window.saveGlobalSettings('app1', g.app1);
            window.forceSyncToCloud && window.forceSyncToCloud();
            log('Matrix saved to globalSettings.app1.weeklyBunkMatrix[' + weekKey + ']');
        } catch (e) {
            console.error('[WeeklyAllocSolver] Failed to save matrix:', e);
        }
    }

    /**
     * Load the saved matrix for a given week.
     * Returns { bunk: { dateStr: [types] } } or null
     */
    function loadMatrix(dateStr) {
        var weekKey = getWeekKey(dateStr);
        var app1 = getApp1();
        return (app1.weeklyBunkMatrix || {})[weekKey] || null;
    }

    /**
     * Return a single bunk's allocation row for a given date.
     * Returns [activityType, ...] or []
     */
    function getBunkDayRow(bunkName, dateStr) {
        var matrix = loadMatrix(dateStr);
        if (!matrix || !matrix[bunkName]) return [];
        return matrix[bunkName][dateStr] || [];
    }

    // =================================================================
    // LOCK MANAGEMENT (called from UI)
    // =================================================================

    /**
     * Lock a specific bunk/date cell to a set of activity types.
     * Once locked, the solver and the daily engine will not change it.
     */
    function lockCell(dateStr, bunkName, types) {
        var weekKey = getWeekKey(dateStr);
        var locks = getWeekLocks(weekKey);
        if (!locks[bunkName]) locks[bunkName] = {};
        locks[bunkName][dateStr] = types.slice();
        saveWeekLocks(weekKey, locks);
        // Also update the live matrix
        var app1 = getApp1();
        var matrix = (app1.weeklyBunkMatrix || {})[weekKey];
        if (matrix && matrix[bunkName]) {
            matrix[bunkName][dateStr] = types.slice();
            _saveMatrix(weekKey, matrix);
        }
        log('Locked cell: ' + bunkName + ' / ' + dateStr + ' → ' + JSON.stringify(types));
    }

    /**
     * Remove a lock from a bunk/date cell.
     */
    function unlockCell(dateStr, bunkName) {
        var weekKey = getWeekKey(dateStr);
        var locks = getWeekLocks(weekKey);
        if (locks[bunkName]) {
            delete locks[bunkName][dateStr];
            saveWeekLocks(weekKey, locks);
            log('Unlocked cell: ' + bunkName + ' / ' + dateStr);
        }
    }

    /**
     * Check if a bunk/date cell is locked.
     */
    function isCellLocked(dateStr, bunkName) {
        var weekKey = getWeekKey(dateStr);
        var locks = getWeekLocks(weekKey);
        return !!(locks[bunkName] && locks[bunkName][dateStr]);
    }

    // =================================================================
    // LAYER RULE STORAGE (called from UI layer editor)
    // =================================================================

    /**
     * Save layer rules for a grade.
     * rules: [{ id, type, duration, windowStart, windowEnd, timesPerDay, timesPerWeek, weeklyOp }, ...]
     */
    function saveGradeLayerRules(gradeName, rules) {
        var g = getGlobalSettings();
        if (!g.app1) g.app1 = {};
        if (!g.app1.gradeLayerRules) g.app1.gradeLayerRules = {};
        g.app1.gradeLayerRules[gradeName] = rules;
        if (window.saveGlobalSettings) window.saveGlobalSettings('app1', g.app1);
        window.forceSyncToCloud && window.forceSyncToCloud();
        log('Saved ' + rules.length + ' layer rules for ' + gradeName);
    }

    /**
     * Get layer rules for a grade (or all grades).
     */
    function getLayerRules(gradeName) {
        var rules = getGradeLayerRules();
        if (gradeName) return rules[gradeName] || [];
        return rules;
    }

    // =================================================================
    // MATRIX SUMMARY (for UI rendering)
    // =================================================================

    /**
     * Return a summary of the matrix for a week, suitable for rendering
     * the weekly plan grid in the UI.
     *
     * Returns:
     * {
     *   weekKey, weekDays,
     *   rows: [{ bunk, grade, days: { dateStr: { types, locked } } }],
     *   warnings
     * }
     */
    function getMatrixSummary(dateStr) {
        var weekKey = getWeekKey(dateStr);
        var weekDays = getWeekDays(dateStr);
        var matrix = loadMatrix(dateStr) || {};
        var locks = getWeekLocks(weekKey);
        var gradeBunkMap = getGradeBunkMap();
        var warnings = [];

        // Build bunk→grade reverse map
        var bunkGradeMap = {};
        Object.keys(gradeBunkMap).forEach(function (grade) {
            (gradeBunkMap[grade] || []).forEach(function (bunk) {
                bunkGradeMap[bunk] = grade;
            });
        });

        var rows = Object.keys(matrix).sort(function (a, b) {
            // Sort bunks naturally: numeric portion first
            var numA = parseInt(String(a).match(/(\d+)/)?.[1]) || 999;
            var numB = parseInt(String(b).match(/(\d+)/)?.[1]) || 999;
            if (numA !== numB) return numA - numB;
            return a.localeCompare(b);
        }).map(function (bunk) {
            var days = {};
            weekDays.forEach(function (d) {
                var types = (matrix[bunk] && matrix[bunk][d]) ? matrix[bunk][d].slice() : [];
                var locked = !!(locks[bunk] && locks[bunk][d]);
                days[d] = { types: types, locked: locked };
            });
            return { bunk: bunk, grade: bunkGradeMap[bunk] || '?', days: days };
        });

        return { weekKey: weekKey, weekDays: weekDays, rows: rows, warnings: warnings };
    }

    // =================================================================
    // PUBLIC API
    // =================================================================

    window.WeeklyAllocationSolver = {
        VERSION: VERSION,

        // Core solver
        solve: solve,

        // Matrix access
        loadMatrix: loadMatrix,
        getBunkDayRow: getBunkDayRow,
        getMatrixSummary: getMatrixSummary,

        // Lock management
        lockCell: lockCell,
        unlockCell: unlockCell,
        isCellLocked: isCellLocked,

        // Layer rule storage
        saveGradeLayerRules: saveGradeLayerRules,
        getLayerRules: getLayerRules,

        // Classification utilities (shared with BunkTimelineSolver)
        classifyAnchor: classifyAnchor,
        resolveWeeklyConstraint: resolveWeeklyConstraint,
        getWeekKey: getWeekKey,
        getWeekDays: getWeekDays,

        // Debug
        getLogs: getLogs
    };

    log('WeeklyAllocationSolver v' + VERSION + ' loaded');

})();
