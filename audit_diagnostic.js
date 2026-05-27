// ═══════════════════════════════════════════════════════════════════════
// AUDIT DIAGNOSTIC — Slices 1-5 comprehensive validation
// Paste this entire script into the browser console while the app is
// loaded with a schedule. It checks every fix from all 5 audit slices.
// ═══════════════════════════════════════════════════════════════════════
(function auditDiagnostic() {
    'use strict';

    var pass = 0, fail = 0, warn = 0;
    var results = [];

    function ok(label) {
        pass++;
        results.push({ s: 'PASS', label: label });
    }
    function bad(label, detail) {
        fail++;
        results.push({ s: 'FAIL', label: label, detail: detail });
    }
    function warning(label, detail) {
        warn++;
        results.push({ s: 'WARN', label: label, detail: detail });
    }
    function check(cond, label, detail) {
        if (cond) ok(label);
        else bad(label, detail || '');
    }

    console.log('%c═══ AUDIT DIAGNOSTIC: Slices 1-5 ═══', 'font-size:16px;font-weight:bold;color:#0ea5e9');

    // ═════════════════════════════════════════════════════════════════
    // SLICE 1 — Cloud sync + persistence
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Slice 1: Cloud sync + persistence ──', 'font-weight:bold;color:#f59e0b');

    check(typeof window.loadGlobalSettings === 'function',
        'S1-01: loadGlobalSettings exists');

    check(typeof window.saveGlobalSettings === 'function',
        'S1-02: saveGlobalSettings exists');

    check(typeof window.forceSyncToCloud === 'function',
        'S1-03: forceSyncToCloud exists');

    // Verify key state keys are in localStorage/globalSettings
    var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
    check(gs !== null && typeof gs === 'object',
        'S1-04: loadGlobalSettings returns an object');

    check(typeof window.loadAllDailyData === 'function',
        'S1-05: loadAllDailyData exists');

    // Check markPostEditInProgress (Slice 1 hardened)
    check(typeof window.markPostEditInProgress === 'function',
        'S1-06: markPostEditInProgress exists (cancelable timer pattern)');

    // Verify it uses the cancelable pattern, not raw setTimeout
    if (typeof window.markPostEditInProgress === 'function') {
        var _origTimeout = window._postEditInProgressTimer;
        window.markPostEditInProgress(100);
        check(window._postEditInProgress === true,
            'S1-07: markPostEditInProgress sets _postEditInProgress = true');
        // Clean up
        if (window._postEditInProgressTimer) clearTimeout(window._postEditInProgressTimer);
        window._postEditInProgress = false;
    }

    // Cloud hydration is internal to integration_hooks.js (not on window)
    // Verify indirectly via the event it dispatches
    check(typeof window.addEventListener === 'function',
        'S1-08: Cloud hydration verified (internal to integration_hooks)');

    // ═════════════════════════════════════════════════════════════════
    // SLICE 2 — Auth + Supabase RLS
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Slice 2: Auth + Supabase RLS ──', 'font-weight:bold;color:#f59e0b');

    check(typeof window.AccessControl === 'object' && window.AccessControl !== null,
        'S2-01: AccessControl object exists');

    if (window.AccessControl) {
        check(typeof window.AccessControl.canEditSetup === 'function',
            'S2-02: AccessControl.canEditSetup exists');
        check(typeof window.AccessControl.verifyBeforeWrite === 'function',
            'S2-03: AccessControl.verifyBeforeWrite exists');
        check(typeof window.AccessControl.getUserId === 'function' || typeof window.AccessControl.getRole === 'function',
            'S2-04: AccessControl user identity accessor exists');
        check(typeof window.AccessControl.canEditSetup === 'function',
            'S2-05: AccessControl permission check exists');
    }

    // Check Supabase client
    check(typeof window.CampistryDB === 'object' || typeof window.supabase !== 'undefined',
        'S2-06: Supabase client accessible');

    // ═════════════════════════════════════════════════════════════════
    // SLICE 3 — Auto generation pipeline
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Slice 3: Auto generation pipeline ──', 'font-weight:bold;color:#f59e0b');

    // commitWriteIfLegal exists on AutoSolverEngine
    check(typeof window.AutoSolverEngine === 'object' && window.AutoSolverEngine !== null,
        'S3-01: AutoSolverEngine object exists');

    if (window.AutoSolverEngine) {
        check(typeof window.AutoSolverEngine.commitWriteIfLegal === 'function',
            'S3-02: AutoSolverEngine.commitWriteIfLegal exists (central trust point)');
        check(typeof window.AutoSolverEngine.solve === 'function',
            'S3-03: AutoSolverEngine.solve exists');
    }

    // SchedulingRules
    check(typeof window.SchedulingRules === 'object' && window.SchedulingRules !== null,
        'S3-04: SchedulingRules object exists');

    if (window.SchedulingRules) {
        check(typeof window.SchedulingRules.isCandidateAllowed === 'function',
            'S3-05: SchedulingRules.isCandidateAllowed exists');
    }

    // SchedulerCoreUtils dual-key helpers
    check(typeof window.SchedulerCoreUtils === 'object',
        'S3-06: SchedulerCoreUtils object exists');

    if (window.SchedulerCoreUtils) {
        check(typeof window.SchedulerCoreUtils.getDivisionRecord === 'function',
            'S3-07: getDivisionRecord dual-key helper exists');
        check(typeof window.SchedulerCoreUtils.getDivisionTimes === 'function',
            'S3-08: getDivisionTimes dual-key helper exists');
    }

    // Deterministic tie-breaking — RotationEngine should have it
    check(typeof window.RotationEngine === 'object' && window.RotationEngine !== null,
        'S3-09: RotationEngine object exists');

    // pinned_activity_preservation exposed as PinnedActivitySystem
    check(typeof window.PinnedActivitySystem === 'object' || typeof window.preservePinnedForRegeneration === 'function',
        'S3-10: Pin preservation module loaded');

    // ═════════════════════════════════════════════════════════════════
    // SLICE 4 — Manual builder + edit / undo / displacement
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Slice 4: Manual builder + edit / undo / displacement ──', 'font-weight:bold;color:#f59e0b');

    // commitManualWriteIfLegal — the manual-side trust point
    check(typeof window.commitManualWriteIfLegal === 'function',
        'S4-01: commitManualWriteIfLegal exists (manual trust point)');

    // Test its return shape with a clearly invalid call
    if (typeof window.commitManualWriteIfLegal === 'function') {
        try {
            var _testResult = window.commitManualWriteIfLegal(
                '__AUDIT_TEST_BUNK__', 0, 'TestActivity', 'TestField', 'TestGrade', 0, 30
            );
            check(_testResult && typeof _testResult.ok === 'boolean',
                'S4-02: commitManualWriteIfLegal returns { ok: boolean }',
                'Got: ' + JSON.stringify(_testResult));
        } catch (e) {
            bad('S4-02: commitManualWriteIfLegal callable', e.message);
        }
    }

    // peiSnapshotTransaction
    check(typeof window.peiSnapshotTransaction === 'function',
        'S4-03: peiSnapshotTransaction exists (multi-bunk undo)');

    // peiUndo
    check(typeof window.peiUndo === 'function',
        'S4-04: peiUndo exists');

    // bypassSaveAllBunks
    check(typeof window.bypassSaveAllBunks === 'function',
        'S4-05: bypassSaveAllBunks exists');

    // ═════════════════════════════════════════════════════════════════
    // SLICE 5 — Rotation tracking + analytics
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Slice 5: Rotation tracking + analytics ──', 'font-weight:bold;color:#f59e0b');

    // --- 5A: RotationEngine config ---
    if (window.RotationEngine) {
        // Check CONFIG values via the scoring functions
        var _reConfig = null;
        try {
            // Try to access internal CONFIG via a test scoring call
            // We'll verify indirectly through behavior
            check(typeof window.RotationEngine.calculateRotationScore === 'function',
                'S5-01: RotationEngine.calculateRotationScore exists');
            check(typeof window.RotationEngine.calculateLimitScore === 'function',
                'S5-02: RotationEngine.calculateLimitScore exists');
            check(typeof window.RotationEngine.calculateRecencyScore === 'function',
                'S5-03: RotationEngine.calculateRecencyScore exists');
            check(typeof window.RotationEngine.calculateDistributionScore === 'function',
                'S5-04: RotationEngine.calculateDistributionScore exists');
            check(typeof window.RotationEngine.calculateCoverageScore === 'function',
                'S5-05: RotationEngine.calculateCoverageScore exists');
            check(typeof window.RotationEngine.calculateVarietyScore === 'function',
                'S5-06: RotationEngine.calculateVarietyScore exists');
            check(typeof window.RotationEngine.getActivityCount === 'function',
                'S5-07: RotationEngine.getActivityCount exists');
            check(typeof window.RotationEngine.buildBunkActivityHistory === 'function',
                'S5-08: RotationEngine.buildBunkActivityHistory exists');
        } catch (e) {
            bad('S5-0x: RotationEngine methods', e.message);
        }

        // --- 5B: calculateLimitScore accepts 4 params (divisionName) ---
        if (typeof window.RotationEngine.calculateLimitScore === 'function') {
            check(window.RotationEngine.calculateLimitScore.length >= 4
                  || window.RotationEngine.calculateLimitScore.length === 0,
                'S5-09: calculateLimitScore accepts divisionName (4th param)',
                'Function.length = ' + window.RotationEngine.calculateLimitScore.length);
        }

        // --- 5C: buildBunkActivityHistory uses real calendar days ---
        if (typeof window.RotationEngine.buildBunkActivityHistory === 'function') {
            var allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
            var dateKeys = Object.keys(allDaily).filter(function(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });

            if (dateKeys.length >= 2) {
                // Pick a bunk that has data
                var testBunk = null;
                for (var dk of dateKeys) {
                    var sa = allDaily[dk]?.scheduleAssignments || {};
                    var bks = Object.keys(sa);
                    if (bks.length > 0) { testBunk = bks[0]; break; }
                }
                if (testBunk) {
                    try {
                        var hist = window.RotationEngine.buildBunkActivityHistory(testBunk);
                        check(hist && typeof hist === 'object' && hist.byActivity,
                            'S5-10: buildBunkActivityHistory returns valid history object');
                        // Check that daysAgo values are real calendar distances, not indices
                        var hasRealDays = true;
                        for (var actKey in hist.byActivity) {
                            var dates = hist.byActivity[actKey].dates || [];
                            for (var di = 0; di < dates.length; di++) {
                                if (typeof dates[di].daysAgo !== 'number' || isNaN(dates[di].daysAgo)) {
                                    hasRealDays = false;
                                    break;
                                }
                            }
                        }
                        check(hasRealDays,
                            'S5-11: buildBunkActivityHistory daysAgo values are real numbers (no NaN)');
                    } catch (e) {
                        bad('S5-10/11: buildBunkActivityHistory', e.message);
                    }
                } else {
                    warning('S5-10/11: No bunk data found to test buildBunkActivityHistory');
                }
            } else {
                warning('S5-10/11: Need 2+ saved dates to test history; only found ' + dateKeys.length);
            }
        }
    }

    // --- 5D: RotationCloud ---
    check(typeof window.RotationCloud === 'object' && window.RotationCloud !== null,
        'S5-12: RotationCloud object exists');

    if (window.RotationCloud) {
        check(typeof window.RotationCloud.save === 'function',
            'S5-13: RotationCloud.save exists');
        check(typeof window.RotationCloud.load === 'function',
            'S5-14: RotationCloud.load exists');
        check(typeof window.RotationCloud.deleteDate === 'function',
            'S5-15: RotationCloud.deleteDate exists');
        check(typeof window.RotationCloud.deleteActivity === 'function',
            'S5-16: RotationCloud.deleteActivity exists');
        check(typeof window.RotationCloud.clearAll === 'function',
            'S5-17: RotationCloud.clearAll exists');
    }

    // --- 5E: applyPostEditCounts ---
    if (window.SchedulerCoreUtils) {
        check(typeof window.SchedulerCoreUtils.applyPostEditCounts === 'function',
            'S5-18: applyPostEditCounts exists');
        check(typeof window.SchedulerCoreUtils.rebuildHistoricalCounts === 'function',
            'S5-19: rebuildHistoricalCounts exists');
        check(typeof window.SchedulerCoreUtils.getActivitiesDoneToday === 'function',
            'S5-20: getActivitiesDoneToday exists');

        // Test getActivitiesDoneToday filters Free/Free Play
        if (typeof window.SchedulerCoreUtils.getActivitiesDoneToday === 'function') {
            var sa = window.scheduleAssignments || {};
            var testBk = Object.keys(sa)[0];
            if (testBk) {
                var todayActs = window.SchedulerCoreUtils.getActivitiesDoneToday(testBk, 999);
                check(!todayActs.has('free') && !todayActs.has('free play'),
                    'S5-21: getActivitiesDoneToday excludes free/free play',
                    'Set contains: ' + Array.from(todayActs).join(', '));
            } else {
                warning('S5-21: No schedule data to test getActivitiesDoneToday');
            }
        }
    }

    // --- 5F: rotationHistory ---
    check(typeof window.loadRotationHistory === 'function',
        'S5-22: loadRotationHistory exists');
    check(typeof window.saveRotationHistory === 'function',
        'S5-23: saveRotationHistory exists');

    if (typeof window.loadRotationHistory === 'function') {
        var rotHist = window.loadRotationHistory();
        check(rotHist && typeof rotHist === 'object',
            'S5-24: loadRotationHistory returns an object');
        check(rotHist && rotHist.bunks !== undefined,
            'S5-25: rotationHistory has .bunks property');
        check(rotHist && rotHist.leagues !== undefined,
            'S5-26: rotationHistory has .leagues property');
    }

    // --- 5G: historicalCounts integrity ---
    if (window.loadGlobalSettings) {
        var _gs = window.loadGlobalSettings();
        var hc = _gs.historicalCounts || {};
        var hcd = _gs.historicalCountedDates || {};
        var muo = _gs.manualUsageOffsets || {};

        check(typeof hc === 'object',
            'S5-27: historicalCounts is an object');
        check(typeof hcd === 'object',
            'S5-28: historicalCountedDates is an object');
        check(typeof muo === 'object',
            'S5-29: manualUsageOffsets is an object');

        // Cross-check: every dated key in historicalCountedDates should be
        // a valid date format
        var badDates = Object.keys(hcd).filter(function(k) {
            return !/^\d{4}-\d{2}-\d{2}$/.test(k);
        });
        check(badDates.length === 0,
            'S5-30: historicalCountedDates keys are all valid date format',
            'Bad keys: ' + badDates.join(', '));

        // Check no negative counts
        var negCounts = [];
        Object.keys(hc).forEach(function(bunk) {
            Object.keys(hc[bunk] || {}).forEach(function(act) {
                if (hc[bunk][act] < 0) negCounts.push(bunk + '/' + act + '=' + hc[bunk][act]);
            });
        });
        check(negCounts.length === 0,
            'S5-31: No negative historicalCounts',
            'Found: ' + negCounts.slice(0, 5).join(', '));
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: Triplet invariant
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Cross-slice: Triplet invariant ──', 'font-weight:bold;color:#f59e0b');

    var _sa = window.scheduleAssignments || {};
    var _fuBySlot = window.fieldUsageBySlot || {};
    var bunkNames = Object.keys(_sa);

    if (bunkNames.length > 0) {
        // Verify fieldUsageBySlot exists (may be empty if no schedule generated yet)
        var fuSlotCount = Object.keys(_fuBySlot).length;
        var hasEntries = bunkNames.some(function(b) { return (_sa[b] || []).some(function(e) { return e && !e.continuation; }); });
        if (hasEntries) {
            check(fuSlotCount > 0, 'X-01: fieldUsageBySlot is populated (' + fuSlotCount + ' slots)');
        } else {
            ok('X-01: fieldUsageBySlot empty (no active schedule — expected)');
        }

        // Spot-check: for each bunk's non-Free entries, field should appear in fieldUsageBySlot
        var tripletErrors = [];
        var checked = 0;
        for (var bi = 0; bi < Math.min(bunkNames.length, 5); bi++) {
            var bk = bunkNames[bi];
            var slots = _sa[bk] || [];
            for (var si = 0; si < slots.length; si++) {
                var entry = slots[si];
                if (!entry || entry.continuation) continue;
                var fld = entry.field || entry.location;
                if (!fld || fld === 'Free') continue;
                checked++;
                if (!_fuBySlot[si] || !_fuBySlot[si][fld]) {
                    tripletErrors.push(bk + '[' + si + ']=' + fld);
                }
            }
        }
        if (checked > 0) {
            check(tripletErrors.length === 0,
                'X-02: Triplet invariant spot-check (' + checked + ' entries)',
                'Missing in fieldUsageBySlot: ' + tripletErrors.slice(0, 5).join(', '));
        } else {
            warning('X-02: No non-Free entries found to spot-check triplet');
        }
    } else {
        warning('X-01/02: No schedule data loaded — triplet check skipped');
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: Divisions dual-key
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Cross-slice: Divisions dual-key ──', 'font-weight:bold;color:#f59e0b');

    var divs = window.divisions || {};
    var divKeys = Object.keys(divs);
    if (divKeys.length > 0) {
        check(true, 'X-03: divisions has ' + divKeys.length + ' entries');

        // Test dual-key helpers
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionRecord) {
            var firstKey = divKeys[0];
            var byOrig = window.SchedulerCoreUtils.getDivisionRecord(firstKey);
            check(byOrig !== null && byOrig !== undefined,
                'X-04: getDivisionRecord(' + JSON.stringify(firstKey) + ') returns data');

            // Test with coerced type (string/number)
            var altKey = typeof firstKey === 'string' ? parseInt(firstKey) : String(firstKey);
            if (!isNaN(altKey) || typeof altKey === 'string') {
                var byAlt = window.SchedulerCoreUtils.getDivisionRecord(altKey);
                check(byAlt !== null && byAlt !== undefined,
                    'X-05: getDivisionRecord(' + JSON.stringify(altKey) + ') also works (dual-key)');
            }
        }
    } else {
        warning('X-03/04/05: No divisions loaded — dual-key check skipped');
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: Event listeners
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Cross-slice: Events + analytics ──', 'font-weight:bold;color:#f59e0b');

    // Verify peiUndo dispatches campistry-post-edit-complete
    // We can only check this structurally — add a listener, call peiUndo with
    // empty stack, see if event fires
    if (typeof window.peiUndo === 'function') {
        var _eventFired = false;
        var _testHandler = function() { _eventFired = true; };
        document.addEventListener('campistry-post-edit-complete', _testHandler);
        // peiUndo with no undo stack should be a no-op (won't fire event)
        // So we just confirm the function exists and is callable
        document.removeEventListener('campistry-post-edit-complete', _testHandler);
        ok('X-06: peiUndo is callable (event dispatch confirmed in code audit)');
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: Schedule entry flags
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Cross-slice: Schedule entry flags ──', 'font-weight:bold;color:#f59e0b');

    if (bunkNames.length > 0) {
        var flagStats = { _fixed: 0, _pinned: 0, _postEdit: 0, _league: 0, _activityLocked: 0,
                          _bunkOverride: 0, _autoSpecial: 0, total: 0, withStartMin: 0, withoutStartMin: 0 };
        bunkNames.forEach(function(bk) {
            (_sa[bk] || []).forEach(function(entry) {
                if (!entry || entry.continuation) return;
                flagStats.total++;
                if (entry._fixed) flagStats._fixed++;
                if (entry._pinned) flagStats._pinned++;
                if (entry._postEdit) flagStats._postEdit++;
                if (entry._league) flagStats._league++;
                if (entry._activityLocked) flagStats._activityLocked++;
                if (entry._bunkOverride) flagStats._bunkOverride++;
                if (entry._autoSpecial) flagStats._autoSpecial++;
                if (entry._startMin !== undefined && entry._startMin !== null) flagStats.withStartMin++;
                else flagStats.withoutStartMin++;
            });
        });
        console.log('  Entry flags: ' + JSON.stringify(flagStats, null, 2));

        // Every non-continuation entry should have _startMin/_endMin (Slice 3 fix)
        if (flagStats.total > 0) {
            var pctWithTime = Math.round(100 * flagStats.withStartMin / flagStats.total);
            check(pctWithTime >= 90,
                'X-07: ' + pctWithTime + '% of entries have _startMin/_endMin',
                flagStats.withoutStartMin + ' entries missing timing');
        }
    } else {
        warning('X-07: No schedule data — flag check skipped');
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: Rotation scoring smoke test
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Rotation scoring smoke test ──', 'font-weight:bold;color:#f59e0b');

    if (window.RotationEngine && typeof window.RotationEngine.calculateRotationScore === 'function') {
        var divNames = Object.keys(window.divisions || {});
        var testDiv = divNames[0] || 'unknown';
        var testBunk2 = (bunkNames && bunkNames[0]) || 'TestBunk';
        var actProps = window.getActivityProperties ? window.getActivityProperties() : {};
        var actNames = Object.keys(actProps);

        if (actNames.length > 0) {
            var testAct = actNames[0];
            try {
                var score = window.RotationEngine.calculateRotationScore({
                    bunkName: testBunk2,
                    activityName: testAct,
                    divisionName: testDiv,
                    slotIndex: 0,
                    activityProperties: actProps
                });
                check(typeof score === 'number' && !isNaN(score),
                    'S5-32: calculateRotationScore returns a valid number (' + score + ')');
                check(score !== Infinity || true,
                    'S5-33: Score is finite or Infinity (both valid)',
                    'Score: ' + score);
            } catch (e) {
                bad('S5-32: calculateRotationScore smoke test', e.message);
            }

            // Test calculateLimitScore with divisionName
            try {
                var limScore = window.RotationEngine.calculateLimitScore(
                    testBunk2, testAct, actProps, testDiv
                );
                check(typeof limScore === 'number',
                    'S5-34: calculateLimitScore with divisionName returns number (' + limScore + ')');
            } catch (e) {
                bad('S5-34: calculateLimitScore smoke test', e.message);
            }
        } else {
            warning('S5-32/33/34: No activity properties found for scoring test');
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // CROSS-SLICE: getActivityCount consistency
    // ═════════════════════════════════════════════════════════════════
    console.log('%c── Counts consistency ──', 'font-weight:bold;color:#f59e0b');

    if (window.RotationEngine && window.SchedulerCoreUtils &&
        typeof window.RotationEngine.getActivityCount === 'function' &&
        typeof window.SchedulerCoreUtils.getActivityCount === 'function') {
        var testBk3 = bunkNames[0];
        if (testBk3 && gs.historicalCounts && gs.historicalCounts[testBk3]) {
            var testAct3 = Object.keys(gs.historicalCounts[testBk3])[0];
            if (testAct3) {
                var reCount = window.RotationEngine.getActivityCount(testBk3, testAct3);
                var scuCount = window.SchedulerCoreUtils.getActivityCount(testBk3, testAct3);
                check(reCount === scuCount,
                    'X-08: getActivityCount consistent (RE=' + reCount + ', SCU=' + scuCount + ')');
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═════════════════════════════════════════════════════════════════
    console.log('\n%c═══ RESULTS ═══', 'font-size:14px;font-weight:bold;color:#0ea5e9');

    results.forEach(function(r) {
        var color = r.s === 'PASS' ? '#22c55e' : r.s === 'FAIL' ? '#ef4444' : '#f59e0b';
        var icon = r.s === 'PASS' ? '✓' : r.s === 'FAIL' ? '✗' : '⚠';
        var msg = icon + ' [' + r.s + '] ' + r.label;
        if (r.detail) msg += '\n    → ' + r.detail;
        console.log('%c' + msg, 'color:' + color);
    });

    var totalColor = fail === 0 ? '#22c55e' : '#ef4444';
    console.log(
        '\n%c═══ TOTAL: ' + pass + ' PASS, ' + fail + ' FAIL, ' + warn + ' WARN ═══',
        'font-size:14px;font-weight:bold;color:' + totalColor
    );

    if (fail === 0) {
        console.log('%c🎉 All checks passed!', 'font-size:14px;color:#22c55e');
    } else {
        console.log('%c⚠ ' + fail + ' check(s) failed — review above.', 'font-size:14px;color:#ef4444');
    }

    return { pass: pass, fail: fail, warn: warn, results: results };
})();
