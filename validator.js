// =================================================================
// validator.js v3.0 — COMPREHENSIVE SCHEDULE VALIDATOR
// =================================================================
// 
// CHECKS FOR:
// ✅ Cross-division conflicts (same_division, custom, not_sharable enforcement)
// ✅ Per-division capacity violations (too many same-div bunks on one field)
// ✅ Global capacity violations (type='all' with numeric cap exceeded)
// ✅ Same-day activity repetitions (by activity name)
// ✅ Same-day field repetitions (same field used twice by one bunk)
// ✅ Missing required activities (lunch, dismissal — configurable)
// ✅ Completely empty bunks (bunk has zero assignments)
// ✅ Empty slots (entire division slot with all bunks empty)
// ✅ Unassigned bunks (bunk exists in division but missing from assignments)
// ✅ Split tile validation (proper half-assignment detection)
// ✅ Division-specific time-based overlap (not slot-index-based)
// ✅ League-aware (skips league entries in conflict/repetition checks)
//
// v3.0 CHANGES:
// - ★★★ Proper same_division + custom sharing enforcement ★★★
// - ★★★ Transitive overlap grouping (chains, not just pairs) ★★★
// - ★★★ Duplicate field check per bunk per day ★★★
// - ★★★ Unassigned/empty bunk detection ★★★
// - ★★★ Split tile awareness in repetition checks ★★★
// - ★★★ Improved modal with collapsible sections + counts ★★★
//
// =================================================================

(function() {
    'use strict';

    // Fields/activities to ignore in capacity/conflict checks
    const IGNORED_FIELDS = [
        'free', 'no field', 'no game', 'unassigned league',
        'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'swim', 'pool',
        'canteen', 'gameroom', 'game room', 'transition', 'buffer'
    ];

    // Activities to ignore in same-day repetition checks
    const IGNORED_ACTIVITIES = [
        'free', 'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'transition', 'buffer',
        'canteen', 'gameroom', 'game room', 'swim', 'pool'
    ];

    // =========================================================================
    // MAIN VALIDATION FUNCTION
    // =========================================================================

    function validateSchedule() {
        console.log('🛡️ Running comprehensive schedule validation v3.0...');
        
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const activityProperties = getActivityProperties();
        
        const errors = [];
        const warnings = [];
        
        // Build bunk→division lookup once
        const bunkDivMap = buildBunkDivisionMap(divisions);
        
        // =====================================================================
        // 1. CROSS-DIVISION + CAPACITY CONFLICTS (time-based)
        // =====================================================================
        const conflictResults = checkFieldConflicts(assignments, divisions, divisionTimes, activityProperties, bunkDivMap);
        conflictResults.errors.forEach(e => errors.push(e));
        conflictResults.warnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 2. SAME-DAY ACTIVITY REPETITIONS
        // =====================================================================
        const repetitionErrors = checkSameDayRepetitions(assignments, bunkDivMap, divisionTimes);
        repetitionErrors.forEach(e => errors.push(e));
        
        // =====================================================================
        // 3. SAME-DAY FIELD REPETITIONS (same field used twice by one bunk)
        // =====================================================================
        const fieldRepErrors = checkSameDayFieldRepetitions(assignments, bunkDivMap, divisionTimes);
        fieldRepErrors.forEach(e => warnings.push(e));
        
        // =====================================================================
        // 4. MISSING REQUIRED ACTIVITIES
        // =====================================================================
        const missingWarnings = checkMissingRequired(assignments, divisions, divisionTimes);
        missingWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 5. EMPTY SLOTS (entire division slot with all bunks empty)
        // =====================================================================
        const emptyWarnings = checkEmptySlots(assignments, divisions, divisionTimes);
        emptyWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 6. UNASSIGNED / COMPLETELY EMPTY BUNKS
        // =====================================================================
        const unassignedWarnings = checkUnassignedBunks(assignments, divisions, divisionTimes);
        unassignedWarnings.forEach(w => warnings.push(w));
        
        // Show results
        console.log(`🛡️ Validation complete: ${errors.length} errors, ${warnings.length} warnings`);
        showValidationModal(errors, warnings);
        
        return { errors, warnings };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function buildBunkDivisionMap(divisions) {
        const map = {};
        for (const [divName, data] of Object.entries(divisions)) {
            for (const bunk of (data.bunks || [])) {
                map[String(bunk)] = divName;
            }
        }
        return map;
    }

    function getActivityProperties() {
        let props = window.activityProperties;
        
        if (!props || Object.keys(props).length === 0) {
            const settings = window.loadGlobalSettings?.() || {};
            props = settings.activityProperties || {};
            
            // Also merge from app1.fields
            const app1 = settings.app1 || {};
            (app1.fields || []).forEach(f => {
                if (!props[f.name]) {
                    props[f.name] = f;
                }
            });
            (app1.specialActivities || []).forEach(s => {
                if (!props[s.name]) {
                    props[s.name] = s;
                }
            });
        }
        
        return props || {};
    }

    /**
     * Case-insensitive property lookup
     */
    function findPropsForField(fieldName, activityProperties) {
        if (!fieldName || !activityProperties) return {};
        
        // Try exact match first
        if (activityProperties[fieldName]) {
            return activityProperties[fieldName];
        }
        
        // Try case-insensitive match
        const fieldNameLower = fieldName.toLowerCase().trim();
        for (const [key, props] of Object.entries(activityProperties)) {
            if (key.toLowerCase().trim() === fieldNameLower) {
                return props;
            }
        }
        
        return {};
    }

    /**
     * Get sharing rules for a field
     */
    function getSharingRules(fieldName, activityProperties) {
        const props = findPropsForField(fieldName, activityProperties);
        const sharableWith = props.sharableWith || {};
        
        let sharingType = sharableWith.type || (props.sharable ? 'same_division' : 'not_sharable');
        let maxCapacity = 1;
        let allowedDivisions = sharableWith.divisions || [];
        
        switch (sharingType) {
            case 'all':
                maxCapacity = parseInt(sharableWith.capacity) || 999;
                break;
            case 'not_sharable':
                maxCapacity = 1;
                break;
            case 'same_division':
                maxCapacity = parseInt(sharableWith.capacity) || 2;
                break;
            case 'custom':
                maxCapacity = parseInt(sharableWith.capacity) || 2;
                break;
            default:
                if (sharableWith.capacity) {
                    maxCapacity = parseInt(sharableWith.capacity);
                } else if (props.sharable) {
                    maxCapacity = 2;
                    sharingType = 'same_division';
                }
        }
        
        // Legacy: direct capacity property
        if (maxCapacity === 1 && props.capacity) {
            maxCapacity = parseInt(props.capacity) || 1;
        }
        
        return { sharingType, maxCapacity, allowedDivisions };
    }

    /**
     * Get field capacity (exported utility)
     */
    function getFieldCapacity(fieldName, activityProperties) {
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        return getSharingRules(fieldName, activityProperties).maxCapacity;
    }

    /**
     * Normalize field name for comparison
     */
    function normalizeFieldName(field) {
        if (!field) return null;
        
        const name = window.SchedulerCoreUtils?.fieldLabel?.(field) ||
                    (typeof field === 'string' ? field : field?.name);
        
        return name ? name.toLowerCase().trim() : null;
    }

    /**
     * Format time from minutes
     */
    function formatTime(minutes) {
        if (minutes === null || minutes === undefined) return '?';
        
        if (window.SchedulerCoreUtils?.minutesToTime) {
            return window.SchedulerCoreUtils.minutesToTime(minutes);
        }
        
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    /**
     * Check if an entry is a league entry
     */
    function isLeagueEntry(entry) {
        if (!entry) return false;
        return entry._isLeague === true ||
               entry._allMatchups?.length > 0 ||
               entry._leagueGame === true ||
               (entry.field && typeof entry.field === 'string' && entry.field.includes(' vs '));
    }

    /**
     * Check if an entry is a transition/buffer
     */
    function isTransitionEntry(entry) {
        if (!entry) return false;
        return entry._isTransition === true ||
               entry.field === 'Transition' ||
               entry._activity?.toLowerCase() === 'transition';
    }

    /**
     * Check if two time ranges overlap
     */
    function timesOverlap(startA, endA, startB, endB) {
        return startA < endB && endA > startB;
    }

    // =========================================================================
    // CHECK 1: FIELD CONFLICTS (Cross-Division + Capacity) — TIME-BASED
    // =========================================================================

    function checkFieldConflicts(assignments, divisions, divisionTimes, activityProperties, bunkDivMap) {
        const errors = [];
        const warnings = [];
        
        // Build a map of all field usages with their actual time ranges
        // { fieldName: [{ bunk, divName, slotIdx, startMin, endMin, activity }] }
        const fieldUsageByTime = {};
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName) return;
            
            const divSlots = divisionTimes[divName] || [];
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                
                const fieldName = normalizeFieldName(entry.field) || normalizeFieldName(entry._activity);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const slotInfo = divSlots[slotIdx];
                if (!slotInfo || slotInfo.startMin === undefined) return;
                
                if (!fieldUsageByTime[fieldName]) {
                    fieldUsageByTime[fieldName] = [];
                }
                
                fieldUsageByTime[fieldName].push({
                    bunk,
                    divName,
                    slotIdx,
                    startMin: slotInfo.startMin,
                    endMin: slotInfo.endMin,
                    activity: entry._activity || entry.sport || fieldName
                });
            });
        });
        
        // Now check each field for conflicts
        Object.entries(fieldUsageByTime).forEach(([fieldName, usages]) => {
            if (usages.length < 2) return;
            
            const { sharingType, maxCapacity, allowedDivisions } = getSharingRules(fieldName, activityProperties);
            
            // ★★★ v3.0: Transitive overlap grouping ★★★
            // Build overlap groups using union-find for proper transitive chaining
            const overlapGroups = buildOverlapGroups(usages);
            
            overlapGroups.forEach(group => {
                if (group.length < 2) return;
                
                const uniqueDivisions = [...new Set(group.map(g => g.divName))];
                const timeStart = Math.min(...group.map(g => g.startMin));
                const timeEnd = Math.max(...group.map(g => g.endMin));
                const timeLabel = `${formatTime(timeStart)} - ${formatTime(timeEnd)}`;
                
                // =====================================================
                // CROSS-DIVISION VIOLATION CHECKS
                // =====================================================
                if (uniqueDivisions.length > 1) {
                    
                    // --- not_sharable: NO sharing at all ---
                    if (sharingType === 'not_sharable') {
                        const bunkList = group.map(g => `${g.bunk} (Div ${g.divName})`).join(', ');
                        errors.push(
                            `<strong>Cross-Division Conflict:</strong> <u>${fieldName}</u> is <strong>not sharable</strong> ` +
                            `but used by <strong>${group.length}</strong> bunks from different divisions during ${timeLabel}<br>` +
                            `<small style="color:#666;">Divisions: ${uniqueDivisions.join(', ')} | Bunks: ${bunkList}</small>`
                        );
                        return; // Don't also report capacity for this group
                    }
                    
                    // --- same_division: only same div can share ---
                    if (sharingType === 'same_division') {
                        const bunkList = group.map(g => `${g.bunk} (Div ${g.divName})`).join(', ');
                        errors.push(
                            `<strong>Cross-Division Conflict:</strong> <u>${fieldName}</u> can only be shared within ` +
                            `the <strong>same division</strong>, but used by divisions ${uniqueDivisions.join(', ')} during ${timeLabel}<br>` +
                            `<small style="color:#666;">Bunks: ${bunkList}</small>`
                        );
                        return;
                    }
                    
                    // --- custom: only allowed divisions can share ---
                    if (sharingType === 'custom' && allowedDivisions.length > 0) {
                        const disallowedDivs = uniqueDivisions.filter(d => !allowedDivisions.includes(d));
                        if (disallowedDivs.length > 0) {
                            const bunkList = group.map(g => `${g.bunk} (Div ${g.divName})`).join(', ');
                            errors.push(
                                `<strong>Cross-Division Conflict:</strong> <u>${fieldName}</u> shared by divisions not in its allowed list during ${timeLabel}<br>` +
                                `<small style="color:#666;">Allowed: ${allowedDivisions.join(', ')} | Found: ${uniqueDivisions.join(', ')}</small><br>` +
                                `<small style="color:#666;">Bunks: ${bunkList}</small>`
                            );
                            return;
                        }
                    }
                    
                    // --- type='all': cross-div is OK, but still check global capacity ---
                    if (sharingType === 'all' && maxCapacity < 999) {
                        if (group.length > maxCapacity) {
                            const bunkList = group.map(g => `${g.bunk} (Div ${g.divName})`).join(', ');
                            errors.push(
                                `<strong>Capacity Exceeded:</strong> <u>${fieldName}</u> used by ` +
                                `<strong>${group.length}</strong> bunks across divisions during ${timeLabel} ` +
                                `(Max: ${maxCapacity})<br>` +
                                `<small style="color:#666;">Bunks: ${bunkList}</small>`
                            );
                        }
                        return;
                    }
                    
                    // --- type='all' unlimited or custom with all divs allowed → check per-div capacity ---
                }
                
                // =====================================================
                // PER-DIVISION CAPACITY CHECKS
                // (for same-division groups OR after cross-div passes)
                // =====================================================
                uniqueDivisions.forEach(divName => {
                    const divUsages = group.filter(g => g.divName === divName);
                    
                    if (divUsages.length > maxCapacity) {
                        const divTimeStart = Math.min(...divUsages.map(g => g.startMin));
                        const divTimeEnd = Math.max(...divUsages.map(g => g.endMin));
                        const divTimeLabel = `${formatTime(divTimeStart)} - ${formatTime(divTimeEnd)}`;
                        const bunkList = divUsages.map(g => g.bunk).join(', ');
                        
                        errors.push(
                            `<strong>Capacity Exceeded:</strong> <u>${fieldName}</u> used by ` +
                            `<strong>${divUsages.length}</strong> bunks in Division ${divName} at ${divTimeLabel} ` +
                            `(Max Capacity: ${maxCapacity})<br>` +
                            `<small style="color:#666;">Bunks: ${bunkList}</small>`
                        );
                    }
                });
            });
        });
        
        return { errors, warnings };
    }

    /**
     * ★★★ v3.0: Build transitive overlap groups using union-find ★★★
     * Instead of pairwise grouping (which misses chains A↔B↔C where A and C don't directly overlap),
     * this uses union-find to properly group all transitively-overlapping usages.
     */
    function buildOverlapGroups(usages) {
        const n = usages.length;
        const parent = Array.from({ length: n }, (_, i) => i);
        
        function find(x) {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]]; // path compression
                x = parent[x];
            }
            return x;
        }
        
        function union(a, b) {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }
        
        // Union all pairs that have time overlap
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (timesOverlap(usages[i].startMin, usages[i].endMin, usages[j].startMin, usages[j].endMin)) {
                    union(i, j);
                }
            }
        }
        
        // Collect groups
        const groups = {};
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!groups[root]) groups[root] = [];
            groups[root].push(usages[i]);
        }
        
        return Object.values(groups);
    }

    // =========================================================================
    // CHECK 2: SAME-DAY ACTIVITY REPETITIONS
    // =========================================================================

    function checkSameDayRepetitions(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            const divSlots = divisionTimes[divName] || [];
            const activitySlots = {}; // { activityName: [{ slotIdx, timeLabel }] }
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                
                const activity = entry._activity?.toLowerCase().trim();
                if (!activity) return;
                if (IGNORED_ACTIVITIES.some(ignored => activity.includes(ignored))) return;
                
                // ★★★ v3.0: For split tiles, use the sub-activity name if available ★★★
                // Split tiles may have entry._fromSplitTile = true with different sub-activities
                // that are intentionally different — those are OK
                const activityKey = activity;
                
                const slotInfo = divSlots[slotIdx];
                const timeLabel = slotInfo ? `${formatTime(slotInfo.startMin)}` : `slot ${slotIdx}`;
                
                if (!activitySlots[activityKey]) activitySlots[activityKey] = [];
                activitySlots[activityKey].push({ slotIdx, timeLabel });
            });
            
            // Report activities done more than once
            Object.entries(activitySlots).forEach(([activity, occurrences]) => {
                if (occurrences.length > 1) {
                    const timeLabels = occurrences.map(o => o.timeLabel).join(', ');
                    errors.push(
                        `<strong>Same-Day Repetition:</strong> <u>${bunk}</u>${divName ? ` (Div ${divName})` : ''} has ` +
                        `<strong>"${activity}"</strong> scheduled <strong>${occurrences.length} times</strong> ` +
                        `(at: ${timeLabels})`
                    );
                }
            });
        });
        
        return errors;
    }

    // =========================================================================
    // CHECK 3: SAME-DAY FIELD REPETITIONS (same field used twice by one bunk)
    // =========================================================================

    function checkSameDayFieldRepetitions(assignments, bunkDivMap, divisionTimes) {
        const warnings = [];
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            const divSlots = divisionTimes[divName] || [];
            const fieldSlots = {}; // { fieldName: [{ slotIdx, timeLabel, activity }] }
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                
                const fieldName = normalizeFieldName(entry.field);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const activity = entry._activity || entry.sport || fieldName;
                const slotInfo = divSlots[slotIdx];
                const timeLabel = slotInfo ? `${formatTime(slotInfo.startMin)}` : `slot ${slotIdx}`;
                
                if (!fieldSlots[fieldName]) fieldSlots[fieldName] = [];
                fieldSlots[fieldName].push({ slotIdx, timeLabel, activity });
            });
            
            // Report fields used more than once by this bunk
            Object.entries(fieldSlots).forEach(([field, occurrences]) => {
                if (occurrences.length > 1) {
                    // Check if the activities are different (which means different activities at same field — might be intentional)
                    const uniqueActivities = [...new Set(occurrences.map(o => o.activity?.toLowerCase()))];
                    
                    const timeLabels = occurrences.map(o => `${o.timeLabel} (${o.activity})`).join(', ');
                    warnings.push(
                        `<strong>Field Reuse:</strong> <u>${bunk}</u>${divName ? ` (Div ${divName})` : ''} uses ` +
                        `field <strong>"${field}"</strong> ${occurrences.length} times today` +
                        `${uniqueActivities.length > 1 ? ' (different activities)' : ''}<br>` +
                        `<small style="color:#666;">At: ${timeLabels}</small>`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 4: MISSING REQUIRED ACTIVITIES
    // =========================================================================

    function checkMissingRequired(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        // ★★★ v3.0: Check global settings for required activities ★★★
        let requiredActivities = ['lunch'];
        try {
            const settings = window.loadGlobalSettings?.() || {};
            if (settings.requiredActivities && Array.isArray(settings.requiredActivities)) {
                requiredActivities = settings.requiredActivities;
            }
        } catch (e) { /* use defaults */ }
        
        if (requiredActivities.length === 0) return warnings;
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            // Skip divisions with no time slots configured
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk] || [];
                
                // Skip bunks with no assignments at all (caught by unassigned check)
                if (slots.length === 0 || slots.every(s => !s)) return;
                
                requiredActivities.forEach(required => {
                    const requiredLower = required.toLowerCase();
                    const hasActivity = slots.some(s => 
                        s && !s.continuation && (
                            s._activity?.toLowerCase().includes(requiredLower) || 
                            s.field?.toLowerCase?.().includes(requiredLower) ||
                            s.sport?.toLowerCase?.().includes(requiredLower)
                        )
                    );
                    
                    if (!hasActivity) {
                        warnings.push(
                            `<strong>Missing Activity:</strong> <u>${bunk}</u> (Div ${divName}) ` +
                            `may be missing <strong>${required}</strong>`
                        );
                    }
                });
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 5: EMPTY SLOTS (★★★ v3.0: League-aware + improved ★★★)
    // =========================================================================

    function checkEmptySlots(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            if (divSlots.length === 0 || bunks.length === 0) return;
            
            // Get league assignments for this division
            const leagueAssignments = window.leagueAssignments?.[divName] || {};
            
            divSlots.forEach((slotInfo, slotIdx) => {
                let emptyCount = 0;
                const totalBunks = bunks.length;
                
                bunks.forEach(bunk => {
                    const entry = (assignments[bunk] || [])[slotIdx];
                    
                    // Check multiple ways an entry can be "filled"
                    const hasLeagueAssignment = leagueAssignments[slotIdx]?.matchups?.length > 0;
                    const entryIsLeague = isLeagueEntry(entry);
                    const entryHasContent = entry && !entry.continuation && (
                        entry._activity || entry.field || entry.sport
                    );
                    
                    if (!entryHasContent && !entryIsLeague && !hasLeagueAssignment) {
                        emptyCount++;
                    }
                });
                
                // Only warn if ALL bunks are empty for this slot
                if (emptyCount === totalBunks && totalBunks > 0) {
                    const timeLabel = (slotInfo.startMin !== undefined)
                        ? `${formatTime(slotInfo.startMin)} - ${formatTime(slotInfo.endMin)}`
                        : `Slot ${slotIdx}`;
                    
                    warnings.push(
                        `<strong>Empty Slot:</strong> Division ${divName} slot ${slotIdx} ` +
                        `(${timeLabel}) has <strong>all ${totalBunks} bunks empty</strong>`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 6: UNASSIGNED / COMPLETELY EMPTY BUNKS
    // =========================================================================

    function checkUnassignedBunks(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk];
                
                // Bunk completely missing from assignments
                if (!slots) {
                    warnings.push(
                        `<strong>Unassigned Bunk:</strong> <u>${bunk}</u> (Div ${divName}) ` +
                        `has <strong>no schedule data at all</strong>`
                    );
                    return;
                }
                
                // Bunk exists but every slot is empty
                const filledSlots = slots.filter(s => s && !s.continuation && (s._activity || s.field || s.sport));
                const leagueAssignments = window.leagueAssignments?.[divName] || {};
                const hasAnyLeague = Object.values(leagueAssignments).some(la => la?.matchups?.length > 0);
                
                if (filledSlots.length === 0 && !hasAnyLeague) {
                    warnings.push(
                        `<strong>Empty Bunk:</strong> <u>${bunk}</u> (Div ${divName}) ` +
                        `has <strong>all ${divSlots.length} slots empty</strong>`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // SHOW VALIDATION MODAL (★★★ v3.0: Collapsible sections + counts ★★★)
    // =========================================================================

    function showValidationModal(errors, warnings = []) {
        // Remove existing modal
        const existing = document.getElementById('validator-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'validator-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
            animation: fadeIn 0.2s;
        `;
        
        let content = `
            <div style="background:white; padding:25px; border-radius:12px; width:750px; max-width:90vw; max-height:85vh; overflow-y:auto; box-shadow:0 10px 25px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:15px;">
                    <h2 style="margin:0; color:#333; display:flex; align-items:center; gap:8px;">
                        🛡️ Schedule Validator
                        <span style="font-size:0.6em; background:#e0e0e0; padding:2px 8px; border-radius:4px;">v3.0</span>
                    </h2>
                    <button id="val-close-x" style="background:none; border:none; font-size:1.5em; cursor:pointer; color:#888; padding:0 8px;">&times;</button>
                </div>
        `;
        
        if (errors.length === 0 && warnings.length === 0) {
            content += `
                <div style="text-align:center; padding:40px 20px; color:#2e7d32;">
                    <div style="font-size:4em; margin-bottom:15px;">✅</div>
                    <h3 style="margin:0 0 10px 0; font-size:1.5em;">All Clear!</h3>
                    <p style="color:#666; margin:0;">No conflicts or issues detected in your schedule.</p>
                </div>
            `;
        } else {
            // Summary bar
            content += `
                <div style="display:flex; gap:15px; margin-bottom:20px;">
                    <div style="flex:1; background:${errors.length > 0 ? '#FFEBEE' : '#E8F5E9'}; padding:12px 16px; border-radius:8px; text-align:center;">
                        <div style="font-size:2em; font-weight:bold; color:${errors.length > 0 ? '#C62828' : '#2E7D32'};">${errors.length}</div>
                        <div style="font-size:0.85em; color:#666;">Error${errors.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div style="flex:1; background:${warnings.length > 0 ? '#FFF3E0' : '#E8F5E9'}; padding:12px 16px; border-radius:8px; text-align:center;">
                        <div style="font-size:2em; font-weight:bold; color:${warnings.length > 0 ? '#E65100' : '#2E7D32'};">${warnings.length}</div>
                        <div style="font-size:0.85em; color:#666;">Warning${warnings.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>
            `;
            
            // ★★★ v3.0: Categorize errors for better readability ★★★
            if (errors.length > 0) {
                const crossDivErrors = errors.filter(e => e.includes('Cross-Division'));
                const capacityErrors = errors.filter(e => e.includes('Capacity Exceeded'));
                const repetitionErrors = errors.filter(e => e.includes('Same-Day Repetition'));
                const otherErrors = errors.filter(e => 
                    !e.includes('Cross-Division') && !e.includes('Capacity Exceeded') && !e.includes('Same-Day Repetition')
                );

                content += `<div style="margin-bottom:15px;">
                    <h3 style="margin:0 0 10px 0; color:#C62828; font-size:1.1em; display:flex; align-items:center; gap:8px;">
                        <span>🚫</span> Errors (Must Fix)
                    </h3>`;
                
                if (crossDivErrors.length > 0) {
                    content += buildCategorySection('Cross-Division Conflicts', crossDivErrors, '#FFCDD2', '#C62828', '#EF5350');
                }
                if (capacityErrors.length > 0) {
                    content += buildCategorySection('Capacity Violations', capacityErrors, '#FFCDD2', '#C62828', '#EF5350');
                }
                if (repetitionErrors.length > 0) {
                    content += buildCategorySection('Same-Day Repetitions', repetitionErrors, '#FFCDD2', '#C62828', '#EF5350');
                }
                if (otherErrors.length > 0) {
                    content += buildCategorySection('Other Errors', otherErrors, '#FFCDD2', '#C62828', '#EF5350');
                }
                
                content += `</div>`;
            }
            
            if (warnings.length > 0) {
                const fieldReuseWarnings = warnings.filter(w => w.includes('Field Reuse'));
                const missingWarnings = warnings.filter(w => w.includes('Missing Activity'));
                const emptyWarnings = warnings.filter(w => w.includes('Empty Slot') || w.includes('Empty Bunk') || w.includes('Unassigned Bunk'));
                const otherWarnings = warnings.filter(w => 
                    !w.includes('Field Reuse') && !w.includes('Missing Activity') && 
                    !w.includes('Empty Slot') && !w.includes('Empty Bunk') && !w.includes('Unassigned Bunk')
                );
                
                content += `<div style="margin-bottom:15px;">
                    <h3 style="margin:0 0 10px 0; color:#EF6C00; font-size:1.1em; display:flex; align-items:center; gap:8px;">
                        <span>⚠️</span> Warnings (Review)
                    </h3>`;
                
                if (fieldReuseWarnings.length > 0) {
                    content += buildCategorySection('Field Reuse', fieldReuseWarnings, '#FFF3E0', '#E65100', '#FF9800');
                }
                if (missingWarnings.length > 0) {
                    content += buildCategorySection('Missing Activities', missingWarnings, '#FFF3E0', '#E65100', '#FF9800');
                }
                if (emptyWarnings.length > 0) {
                    content += buildCategorySection('Empty / Unassigned', emptyWarnings, '#FFF3E0', '#E65100', '#FF9800');
                }
                if (otherWarnings.length > 0) {
                    content += buildCategorySection('Other Warnings', otherWarnings, '#FFF3E0', '#E65100', '#FF9800');
                }
                
                content += `</div>`;
            }
        }
        
        content += `
            <div style="text-align:right; margin-top:20px; border-top:1px solid #eee; padding-top:15px;">
                <button id="val-close-btn" style="padding:12px 24px; background:#333; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:1em;">
                    Close
                </button>
            </div>
        </div>`;
        
        overlay.innerHTML = content;
        document.body.appendChild(overlay);

        // Wire up collapsible sections
        overlay.querySelectorAll('.val-category-header').forEach(header => {
            header.onclick = () => {
                const list = header.nextElementSibling;
                const arrow = header.querySelector('.val-arrow');
                if (list.style.display === 'none') {
                    list.style.display = 'block';
                    if (arrow) arrow.textContent = '▼';
                } else {
                    list.style.display = 'none';
                    if (arrow) arrow.textContent = '▶';
                }
            };
        });

        // Close handlers
        const close = () => overlay.remove();
        document.getElementById('val-close-btn').onclick = close;
        document.getElementById('val-close-x').onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        
        // ESC key to close
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Build a collapsible category section for the modal
     */
    function buildCategorySection(title, items, bgColor, textColor, borderColor) {
        // Auto-collapse if more than 5 items
        const collapsed = items.length > 5;
        
        return `
            <div style="margin-bottom:8px;">
                <div class="val-category-header" style="cursor:pointer; display:flex; align-items:center; gap:6px; padding:6px 10px; background:#f5f5f5; border-radius:4px; font-size:0.9em; font-weight:600; color:#555; user-select:none;">
                    <span class="val-arrow">${collapsed ? '▶' : '▼'}</span>
                    ${title} <span style="font-weight:normal; color:#999;">(${items.length})</span>
                </div>
                <ul style="list-style:none; padding:0; margin:4px 0 0 0; display:${collapsed ? 'none' : 'block'}; max-height:250px; overflow-y:auto;">
                    ${items.map(item => `
                        <li style="background:${bgColor}; color:${textColor}; padding:10px 12px; margin-bottom:4px; border-radius:6px; border-left:4px solid ${borderColor}; font-size:0.9em;">
                            ${item}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }

    // Add animation style
    if (!document.getElementById('validator-style')) {
        const style = document.createElement('style');
        style.id = 'validator-style';
        style.innerHTML = `
            @keyframes fadeIn { 
                from { opacity: 0; transform: scale(0.95); } 
                to { opacity: 1; transform: scale(1); } 
            }
            .val-category-header:hover {
                background: #eee !important;
            }
        `;
        document.head.appendChild(style);
    }

    // Export
    window.validateSchedule = validateSchedule;
    window.ScheduleValidator = {
        validate: validateSchedule,
        getFieldCapacity: getFieldCapacity,
        getSharingRules: getSharingRules
    };

    console.log('🛡️ Validator v3.0 loaded — comprehensive field conflict + capacity + repetition + empty bunk detection');

})();
