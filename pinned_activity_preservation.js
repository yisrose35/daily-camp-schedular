// =============================================================================
// PINNED ACTIVITY PRESERVATION SYSTEM
// =============================================================================
// 
// PURPOSE: Ensures that user-pinned activities (from post-generation edits)
// survive full schedule regenerations.
//
// HOW IT WORKS:
// 1. Before generation: Captures all entries with _pinned: true
// 2. Registers their field usage in GlobalFieldLocks to prevent conflicts
// 3. After generation: Restores pinned entries to their original slots
//
// INTEGRATION: Add this file AFTER scheduler_core_main.js and post_edit_system.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📌 Pinned Activity Preservation System loading...');

    // =========================================================================
    // STORAGE FOR PINNED ACTIVITIES
    // =========================================================================
    
    let _pinnedSnapshot = {};  // { bunk: { slotIdx: entry } }
    let _pinnedFieldLocks = []; // Track what we locked so we can verify

    // =========================================================================
    // CAPTURE PINNED ACTIVITIES (Call before generation)
    // =========================================================================

    /**
     * Scan current scheduleAssignments and capture all pinned entries
     * @param {string[]} allowedDivisions - Optional: only capture from these divisions
     * @returns {object} Snapshot of pinned activities
     */
    function capturePinnedActivities(allowedDivisions) {
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        
        _pinnedSnapshot = {};
        _pinnedFieldLocks = [];
        
        let capturedCount = 0;
        
        // Build set of allowed bunks if divisions filter provided
        let allowedBunks = null;
        if (allowedDivisions && allowedDivisions.length > 0) {
            allowedBunks = new Set();
            for (const divName of allowedDivisions) {
                const divInfo = divisions[divName];
                if (divInfo?.bunks) {
                    divInfo.bunks.forEach(b => allowedBunks.add(b));
                }
            }
        }
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            // Skip if not in allowed divisions
            if (allowedBunks && !allowedBunks.has(bunkName)) {
                continue;
            }
            
            if (!slots || !Array.isArray(slots)) continue;

            // ★ Build a set of every name that's currently a real activity in
            //   the camp's registries. Anything pinned that doesn't appear in
            //   this set is a ghost left behind by deleted-but-not-cleaned
            //   data; we drop those pins so each generation can place fresh.
            //   Without this, a special you removed from the registry months
            //   ago can still be carried forward via _pinned indefinitely.
            const _validNames = new Set();
            const _addNames = (arr, key) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(o => { if (o && o[key]) _validNames.add(String(o[key])); });
            };
            try {
                const _gs = window.loadGlobalSettings?.() || {};
                _addNames(window.getAllSpecialActivities?.() || [], 'name');
                _addNames(_gs.app1?.specialActivities, 'name');
                _addNames(_gs.app1?.allSports, 'name');
                if (Array.isArray(_gs.app1?.allSports)) {
                    _gs.app1.allSports.forEach(s => { if (typeof s === 'string') _validNames.add(s); });
                }
                _addNames(_gs.app1?.fields, 'name');
                _addNames(_gs.app1?.facilities, 'name');
                // Always-OK names: structural slots that aren't user-managed
                ['lunch','Swim','Change','Lineup','Snacks','Snack','Dismissal','Free'].forEach(n => _validNames.add(n));
            } catch (_) {}

            // Grade for this bunk — used to check the field/special
            // accessRestrictions below. If we can't determine the grade we
            // fall through to the ghost-only checks (no accessRestrictions
            // gate applied) rather than risk dropping a valid pin.
            const _bunkGrade = Object.keys(divisions).find(d =>
                (divisions[d]?.bunks || []).map(String).includes(String(bunkName))
            ) || null;
            const _gsForCheck = (typeof window.loadGlobalSettings === 'function')
                ? (window.loadGlobalSettings() || {})
                : (window.globalSettings || {});
            const _allFields = _gsForCheck.app1?.fields || [];
            const _allSpecials = _gsForCheck.app1?.specialActivities
                || (window.getAllSpecialActivities ? window.getAllSpecialActivities() : []);

            // Returns true if this pinned entry is still legal under the
            // current field/special accessRestrictions for this bunk. The
            // gate mirrors AutoSolverEngine's grade-access check and the
            // smart-logic-adapter's canBunkAccessSpecial check, so a
            // schedule-time edit pinned BEFORE you tightened a restriction
            // does not get carried forward into the new build.
            // Slice 3 audit fix (N6): every divisions lookup tries both the
            // string and raw forms of the bunk's grade key. Earlier this used
            // single-key access only, which silently dropped pins when the
            // type-mismatch occurred between the access-restrictions store
            // (often string keys) and the divisions resolution (sometimes
            // numeric). Mirrors the dual-key pattern in commitWriteIfLegal.
            const _gradeKey = String(_bunkGrade);
            const _accessAllowsBunk = (rules) => {
                const divRules = rules.divisions || {};
                if (!(_gradeKey in divRules) && !(_bunkGrade in divRules)) return false;
                const bunkList = divRules[_gradeKey] || divRules[_bunkGrade];
                if (Array.isArray(bunkList) && bunkList.length > 0
                    && !bunkList.map(String).includes(String(bunkName))) return false;
                return true;
            };

            const _isPinnedEntryStillAllowed = (entry) => {
                if (!_bunkGrade) return true;
                const fieldName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const actName = entry._activity || entry.event || '';
                const sMin = entry._startMin;
                const eMin = entry._endMin;

                // 1. Field-level access restriction
                let fld = null;
                if (fieldName && fieldName !== 'Free') {
                    fld = _allFields.find(f => f && f.name === fieldName);
                    // ★ Config-level shut-off: host field toggled UNAVAILABLE in
                    //   Facilities (available:false). A placement pinned BEFORE the
                    //   field was disabled must not be carried forward.
                    if (fld && fld.available === false) return false;
                    if (fld?.accessRestrictions?.enabled && !_accessAllowsBunk(fld.accessRestrictions)) {
                        return false;
                    }
                }

                // 2. Special-level access restriction (when the pinned
                //    activity is a configured special)
                if (actName) {
                    const sp = _allSpecials.find(s => s && s.name === actName);
                    // ★ Config-level shut-off: special toggled UNAVAILABLE in
                    //   Facilities (available:false). Drop the carried-forward pin
                    //   so a disabled special is never restored into the schedule.
                    if (sp && sp.available === false) return false;
                    if (sp?.accessRestrictions?.enabled && !_accessAllowsBunk(sp.accessRestrictions)) {
                        return false;
                    }
                }

                // 3. Slice 3 audit fix (N7): also drop pins that violate the
                //    field's per-grade timeRules, today's disabledFields, or
                //    today's per-field disabledSports. Earlier the gate
                //    checked access only; a pin set yesterday would survive
                //    even after the user explicitly added a rule that
                //    blocks it for today.
                if (fld && Array.isArray(fld.timeRules) && fld.timeRules.length > 0
                    && sMin != null && eMin != null) {
                    const myG = _gradeKey;
                    let hasGradeAvail = false, insideAvail = false;
                    for (const r of fld.timeRules) {
                        const t = String(r.type || '').toLowerCase();
                        const isUnavail = t === 'unavailable' || r.available === false;
                        const isAvail = t === 'available' || r.available === true;
                        const rs = r.startMin;
                        const re = r.endMin;
                        if (rs == null || re == null || (!isAvail && !isUnavail)) continue;
                        const rDivs = Array.isArray(r.divisions) ? r.divisions.map(String) : [];
                        if (rDivs.length > 0 && !rDivs.includes(myG)) continue;
                        if (isUnavail && rs < eMin && re > sMin) return false;
                        if (isAvail) {
                            hasGradeAvail = true;
                            if (sMin >= rs && eMin <= re) insideAvail = true;
                        }
                    }
                    if (hasGradeAvail && !insideAvail) return false;
                }

                if (fieldName) {
                    const dailyDisabled = window.dailyDisabledFields || window.currentDayOverrides?.disabledFields || [];
                    if (Array.isArray(dailyDisabled) && dailyDisabled.map(String).includes(String(fieldName))) return false;
                    const dsByField = window.dailyDisabledSportsByField || {};
                    const ds = dsByField[fieldName];
                    if (ds && actName && (ds.has?.(actName) || (Array.isArray(ds) && ds.includes(actName)))) return false;
                }

                // 4. Slice 4 audit fix — also check cooldown / FieldCombos
                // rules. Earlier the gate stopped at access + timeRules +
                // disabledFields/Sports. A pin could survive even if a
                // newly-added cooldown made the placement illegal — the
                // pin then resurrected the violation on the next auto-gen.
                if (window.SchedulingRules?.isCandidateAllowed
                    && sMin != null && eMin != null && actName) {
                    try {
                        const sp = _allSpecials.find(s => s && s.name === actName);
                        const cand = {
                            startMin: sMin, endMin: eMin,
                            type: sp ? 'special' : 'sport',
                            event: actName,
                            field: fieldName
                        };
                        const template = [];
                        for (let ti = 0; ti < slots.length; ti++) {
                            const w = slots[ti];
                            if (!w || w === entry || w.continuation) continue;
                            if (w._startMin == null || w._endMin == null) continue;
                            template.push({
                                startMin: w._startMin, endMin: w._endMin,
                                type: w.type || (w._assignedSpecial ? 'special' : (w.field === 'Free' ? 'free' : 'sport')),
                                event: w.event || w._activity || w.sport || '',
                                field: w.field
                            });
                        }
                        if (!window.SchedulingRules.isCandidateAllowed(cand, template, { mode: 'auto' })) return false;
                    } catch (_) { /* rule-engine error never blocks a legal pin */ }
                }

                return true;
            };

            let droppedGhosts = 0;
            let droppedDisallowed = 0;
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];

                // ★ Staggered shared-room reserved WALL: the auto solver tags these
                //   _pinned:true so every post-solve sweep treats them like lunch (a
                //   wall it never demotes). But unlike a USER pin they must be
                //   re-DERIVED from the layer config on every regeneration (the
                //   stagger anchor depends on the live grade set / shifted days), not
                //   frozen and carried forward. Skip them here so capture/restore
                //   never snapshots an auto-derived wall as a user pin.
                if (entry && entry._staggerReserved === true) {
                    continue;
                }

                // Check if this is a pinned entry
                if (entry && entry._pinned === true) {
                    // Drop pin if its activity isn't in any current registry.
                    const actName = entry._activity || entry.field || entry.event;
                    if (actName && _validNames.size > 0 && !_validNames.has(String(actName))) {
                        droppedGhosts++;
                        continue;
                    }

                    // Drop pin if the field/special no longer allows this
                    // bunk's grade. Without this gate, a sport pinned to a
                    // field BEFORE the user tightened the field's
                    // accessRestrictions would survive every regen.
                    if (!_isPinnedEntryStillAllowed(entry)) {
                        droppedDisallowed++;
                        continue;
                    }

                    if (!_pinnedSnapshot[bunkName]) {
                        _pinnedSnapshot[bunkName] = {};
                    }

                    _pinnedSnapshot[bunkName][slotIdx] = {
                        ...entry,
                        _preservedAt: Date.now()
                    };

                    capturedCount++;

                    // Track field lock info.
                    // ★ FACILITY RESERVATION: a pinned custom layer or pinned
                    //   special carries its field in `_customField` /
                    //   `_specialLocation` when `entry.field` itself is null
                    //   (the layer-config representation). Fall back to those so
                    //   the host facility is reserved for the pinned activity and
                    //   can never be handed to another bunk — without this, a
                    //   custom.pinned block with no `.field` registered NO lock.
                    let fieldName = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                    if (!fieldName || fieldName === 'Free') {
                        fieldName = entry._customField || entry._specialLocation || fieldName;
                    }
                    if (fieldName && fieldName !== 'Free') {
                        _pinnedFieldLocks.push({
                            field: fieldName,
                            slot: slotIdx,
                            bunk: bunkName,
                            activity: entry._activity || fieldName
                        });
                    }
                }
            }
            if (droppedGhosts > 0) {
                console.warn('[PinnedPreserve] 👻 Dropped ' + droppedGhosts + ' pinned ghost slot(s) for bunk ' + bunkName + ' (activity not in current registry)');
            }
            if (droppedDisallowed > 0) {
                console.warn('[PinnedPreserve] 🚫 Dropped ' + droppedDisallowed + ' pinned slot(s) for bunk ' + bunkName + ' (field/special no longer allows this grade)');
            }
        }
        
        console.log(`[PinnedPreserve] 📌 Captured ${capturedCount} pinned activities from ${Object.keys(_pinnedSnapshot).length} bunks`);
        
        if (_pinnedFieldLocks.length > 0) {
            console.log(`[PinnedPreserve] 🔒 Will lock ${_pinnedFieldLocks.length} field-slot combinations`);
        }
        
        return _pinnedSnapshot;
    }

    // =========================================================================
    // REGISTER PINNED FIELD LOCKS (Call during generation setup)
    // =========================================================================

    /**
     * Lock all fields used by pinned activities so they don't get assigned to others
     * Call this AFTER GlobalFieldLocks.reset() but BEFORE any scheduling
     */
    function registerPinnedFieldLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn('[PinnedPreserve] GlobalFieldLocks not available');
            return;
        }
        
        const divisions = window.divisions || {};
        let locksRegistered = 0;
        
        for (const lockInfo of _pinnedFieldLocks) {
            // Find division for this bunk
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            
            const success = window.GlobalFieldLocks.lockField(
                lockInfo.field,
                [lockInfo.slot],
                {
                    lockedBy: 'pinned_activity',
                    division: divName || 'unknown',
                    activity: lockInfo.activity,
                    bunk: lockInfo.bunk,
                    _pinnedLock: true
                }
            );
            
            if (success !== false) {
                locksRegistered++;
            }
        }
        
        console.log(`[PinnedPreserve] 🔒 Registered ${locksRegistered}/${_pinnedFieldLocks.length} field locks for pinned activities`);
    }

    /**
     * Also register in fieldUsageBySlot if that's being used
     */
    function registerPinnedFieldUsage(fieldUsageBySlot, activityProperties) {
        if (!fieldUsageBySlot) return;
        
        const divisions = window.divisions || {};
        
        for (const lockInfo of _pinnedFieldLocks) {
            const slotIdx = lockInfo.slot;
            const fieldName = lockInfo.field;
            
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            
            // Get field capacity
            const props = activityProperties?.[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }
            
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = {
                    count: 0,
                    divisions: [],
                    bunks: {},
                    _locked: true,
                    _fromPinned: true
                };
            }
            
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++;
            usage.bunks[lockInfo.bunk] = lockInfo.activity;
            
            const divName = Object.keys(divisions).find(d => 
                divisions[d]?.bunks?.includes(lockInfo.bunk)
            );
            if (divName && !usage.divisions.includes(divName)) {
                usage.divisions.push(divName);
            }
        }
        
        console.log(`[PinnedPreserve] 📊 Registered pinned field usage in fieldUsageBySlot`);
    }

    // =========================================================================
    // RESTORE PINNED ACTIVITIES (Call after generation)
    // =========================================================================

    /**
     * Restore all captured pinned activities back into scheduleAssignments
     * @returns {number} Number of entries restored
     */
    function restorePinnedActivities() {
        const assignments = window.scheduleAssignments || {};
        let restoredCount = 0;
        
        for (const [bunkName, pinnedSlots] of Object.entries(_pinnedSnapshot)) {
            // Initialize bunk array if needed
            if (!assignments[bunkName]) {
                const totalSlots = (window.unifiedTimes || []).length;
                assignments[bunkName] = new Array(totalSlots);
            }
            
            for (const [slotIdxStr, entry] of Object.entries(pinnedSlots)) {
                const slotIdx = parseInt(slotIdxStr, 10);
                
                // Restore the pinned entry
                assignments[bunkName][slotIdx] = {
                    ...entry,
                    _restoredAt: Date.now()
                };
                
                restoredCount++;
            }
        }
        
        console.log(`[PinnedPreserve] ✅ Restored ${restoredCount} pinned activities`);
        
        return restoredCount;
    }

    // =========================================================================
    // HOOK INTO SCHEDULER - Automatic Integration
    // =========================================================================

    /**
     * Wrap the main generation function to automatically preserve pinned activities
     */
    function hookSchedulerGeneration() {
        // Hook into runScheduler if it exists
        if (typeof window.runScheduler === 'function' && !window.runScheduler._pinnedHooked) {
            const originalRunScheduler = window.runScheduler;
            
            window.runScheduler = async function(...args) {
                console.log('[PinnedPreserve] 🚀 Generation starting - capturing pinned activities');
                
                // Get allowed divisions from args if provided
                const allowedDivisions = args[0]?.allowedDivisions || null;
                
                // Capture before generation
                capturePinnedActivities(allowedDivisions);
                
                // Run original
                const result = await originalRunScheduler.apply(this, args);
                
                // Restore after generation
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[PinnedPreserve] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    
                    // Save the restored data
                    window.saveSchedule?.();
                }
                
                return result;
            };
            
            window.runScheduler._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into runScheduler');
        }
        
        // Also hook into generateSchedule if different
        if (typeof window.generateSchedule === 'function' && !window.generateSchedule._pinnedHooked) {
            const originalGenerateSchedule = window.generateSchedule;
            
            window.generateSchedule = async function(...args) {
                console.log('[PinnedPreserve] 🚀 Generation starting - capturing pinned activities');
                
                const allowedDivisions = args[0]?.allowedDivisions || 
                                        window.selectedDivisionsForGeneration || 
                                        null;
                
                // Capture before generation
                capturePinnedActivities(allowedDivisions);
                
                // Run original
                const result = await originalGenerateSchedule.apply(this, args);
                
                // Restore after generation
                if (Object.keys(_pinnedSnapshot).length > 0) {
                    console.log('[PinnedPreserve] 🔄 Generation complete - restoring pinned activities');
                    restorePinnedActivities();
                    
                    // Save and refresh
                    window.saveSchedule?.();
                    window.updateTable?.();
                }
                
                return result;
            };
            
            window.generateSchedule._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into generateSchedule');
        }
        
        // Hook into the Step 1.5 pattern used by scheduler_core_main.js
        if (typeof window.executeStep1_5 === 'function' && !window.executeStep1_5._pinnedHooked) {
            const originalStep1_5 = window.executeStep1_5;
            
            window.executeStep1_5 = function(snapshot, divisions, allowedDivisions, fieldUsageBySlot, activityProperties, existingUnifiedTimes) {
                // First, register our pinned field locks BEFORE the background restore
                if (_pinnedFieldLocks.length > 0) {
                    console.log('[PinnedPreserve] 📌 Registering pinned field locks in Step 1.5');
                    registerPinnedFieldLocks();
                    registerPinnedFieldUsage(fieldUsageBySlot, activityProperties);
                }
                
                // Run original
                return originalStep1_5.apply(this, arguments);
            };
            
            window.executeStep1_5._pinnedHooked = true;
            console.log('[PinnedPreserve] ✅ Hooked into executeStep1_5');
        }
    }

    // =========================================================================
    // EVENT-BASED HOOKS (Alternative approach)
    // =========================================================================

    // Listen for generation events
    window.addEventListener('campistry-generation-starting', (e) => {
        console.log('[PinnedPreserve] 📡 Received generation-starting event');
        const allowedDivisions = e.detail?.allowedDivisions || null;
        capturePinnedActivities(allowedDivisions);
    });

    window.addEventListener('campistry-generation-complete', (e) => {
        if (Object.keys(_pinnedSnapshot).length > 0) {
            console.log('[PinnedPreserve] 📡 Received generation-complete event - restoring');
            restorePinnedActivities();
        }
    });

    // =========================================================================
    // MANUAL TRIGGER FUNCTIONS
    // =========================================================================

    /**
     * Manually trigger the full preservation cycle
     * Call this if automatic hooks aren't working
     */
    window.preservePinnedForRegeneration = function(allowedDivisions) {
        capturePinnedActivities(allowedDivisions);
        registerPinnedFieldLocks();
    };

    /**
     * Manually restore after generation
     */
    window.restorePinnedAfterRegeneration = function() {
        const count = restorePinnedActivities();
        window.saveSchedule?.();
        window.updateTable?.();
        return count;
    };

    // =========================================================================
    // UTILITY: View/Clear Pinned Activities
    // =========================================================================

    /**
     * Get all currently pinned activities in the schedule
     */
    window.getPinnedActivities = function() {
        const assignments = window.scheduleAssignments || {};
        const pinned = [];
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    pinned.push({
                        bunk: bunkName,
                        slot: slotIdx,
                        activity: entry._activity || entry.field,
                        field: typeof entry.field === 'object' ? entry.field?.name : entry.field,
                        editedAt: entry._editedAt || entry._preservedAt
                    });
                }
            }
        }
        
        return pinned;
    };

    /**
     * Remove the pinned flag from a specific entry (allows it to be regenerated)
     */
    window.unpinActivity = function(bunk, slotIdx) {
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry) {
            delete entry._pinned;
            delete entry._postEdit;
            entry._unpinnedAt = Date.now();
            
            window.saveSchedule?.();
            window.updateTable?.();
            
            console.log(`[PinnedPreserve] 📌❌ Unpinned ${bunk} at slot ${slotIdx}`);
            return true;
        }
        return false;
    };

    /**
     * Unpin all activities (allows full regeneration)
     */
    window.unpinAllActivities = function() {
        const assignments = window.scheduleAssignments || {};
        let unpinnedCount = 0;
        
        for (const [bunkName, slots] of Object.entries(assignments)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const entry = slots[slotIdx];
                if (entry && entry._pinned === true) {
                    delete entry._pinned;
                    delete entry._postEdit;
                    entry._unpinnedAt = Date.now();
                    unpinnedCount++;
                }
            }
        }
        
        window.saveSchedule?.();
        window.updateTable?.();
        
        console.log(`[PinnedPreserve] 📌❌ Unpinned ${unpinnedCount} activities`);
        return unpinnedCount;
    };

    // =========================================================================
    // DEBUG HELPERS
    // =========================================================================

    window.debugPinnedSnapshot = function() {
        console.log('[PinnedPreserve] Current snapshot:', _pinnedSnapshot);
        console.log('[PinnedPreserve] Field locks:', _pinnedFieldLocks);
        return { snapshot: _pinnedSnapshot, locks: _pinnedFieldLocks };
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        // Try to hook immediately
        hookSchedulerGeneration();
        
        // Also retry after a delay (in case scheduler loads later)
        setTimeout(hookSchedulerGeneration, 1000);
        setTimeout(hookSchedulerGeneration, 3000);
        
        console.log('📌 Pinned Activity Preservation System initialized');
        console.log('   - Auto-hooks into runScheduler/generateSchedule');
        console.log('   - Listens for campistry-generation-* events');
        console.log('   - Manual: preservePinnedForRegeneration(), restorePinnedAfterRegeneration()');
        console.log('   - Utilities: getPinnedActivities(), unpinActivity(bunk, slot), unpinAllActivities()');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.PinnedActivitySystem = {
        capture: capturePinnedActivities,
        registerLocks: registerPinnedFieldLocks,
        registerUsage: registerPinnedFieldUsage,
        restore: restorePinnedActivities,
        getAll: window.getPinnedActivities,
        unpin: window.unpinActivity,
        unpinAll: window.unpinAllActivities,
        debug: window.debugPinnedSnapshot
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
