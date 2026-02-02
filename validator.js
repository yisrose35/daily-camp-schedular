// =================================================================
// validator.js v2.3 — COMPREHENSIVE SCHEDULE VALIDATOR
// =================================================================
// 
// CHECKS FOR:
// ✅ Cross-division conflicts (different divs can't share at same time)
// ✅ Per-division capacity violations (too many same-div bunks)
// ✅ Same-day activity repetitions
// ✅ Missing required activities (lunch/dismissal)
// ✅ Division-specific time awareness
//
// v2.3 FIXES:
// - ★★★ Separate cross-division vs capacity violations ★★★
// - ★★★ Correctly reads sharableWith.capacity from config ★★★
// - ★★★ Shows "different divisions" error vs "capacity exceeded" ★★★
//
// =================================================================

(function() {
    'use strict';

    // Fields/activities to ignore in capacity checks
    const IGNORED_FIELDS = [
        'free', 'no field', 'no game', 'unassigned league',
        'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'swim', 'pool',
        'canteen', 'gameroom', 'game room'
    ];

    // Activities to ignore in same-day repetition checks
    const IGNORED_ACTIVITIES = [
        'free', 'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'transition', 'buffer'
    ];

    /**
     * Main validation function
     */
    function validateSchedule() {
        console.log('🛡️ Running comprehensive schedule validation v2.3...');
        
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const activityProperties = getActivityProperties();
        
        const errors = [];
        const warnings = [];
        
        // =====================================================================
        // 1. CROSS-DIVISION TIME-BASED CONFLICTS
        // =====================================================================
        const crossDivConflicts = checkCrossDivisionTimeConflicts(assignments, divisions, divisionTimes, activityProperties);
        crossDivConflicts.forEach(c => errors.push(c));
        
        // =====================================================================
        // 2. SAME-SLOT CAPACITY VIOLATIONS (within same division)
        // =====================================================================
        const capacityErrors = checkSameSlotCapacity(assignments, divisions, divisionTimes, activityProperties);
        capacityErrors.forEach(c => errors.push(c));
        
        // =====================================================================
        // 3. SAME-DAY ACTIVITY REPETITIONS
        // =====================================================================
        const repetitionErrors = checkSameDayRepetitions(assignments);
        repetitionErrors.forEach(c => errors.push(c));
        
        // =====================================================================
        // 4. MISSING REQUIRED ACTIVITIES
        // =====================================================================
        const missingWarnings = checkMissingRequired(assignments, divisions, divisionTimes);
        missingWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 5. EMPTY SLOTS (with v2.2 league awareness)
        // =====================================================================
        const emptyWarnings = checkEmptySlots(assignments, divisions, divisionTimes);
        emptyWarnings.forEach(w => warnings.push(w));
        
        // Show results
        console.log(`🛡️ Validation complete: ${errors.length} errors, ${warnings.length} warnings`);
        showValidationModal(errors, warnings);
        
        return { errors, warnings };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

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
     * ★★★ FIXED v2.3: Get field capacity with CASE-INSENSITIVE lookup ★★★
     */
    function getFieldCapacity(fieldName, activityProperties) {
        // Use centralized utility if available
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        
        // ★★★ v2.3 FIX: Case-insensitive lookup ★★★
        const props = findPropsForField(fieldName, activityProperties);
        
        // Check sharableWith config
        if (props.sharableWith) {
            // type='not_sharable' → 1
            if (props.sharableWith.type === 'not_sharable') {
                return 1;
            }
            // type='all' → unlimited (999)
            if (props.sharableWith.type === 'all') {
                return 999;
            }
            // type='custom' → configured capacity (default 2)
            if (props.sharableWith.type === 'custom') {
                return parseInt(props.sharableWith.capacity) || 2;
            }
            // Any sharableWith without explicit not_sharable = default 2
            if (props.sharableWith.capacity) {
                return parseInt(props.sharableWith.capacity);
            }
            // sharableWith exists but no capacity set → default 2
            return 2;
        }
        
        // Legacy sharable boolean
        if (props.sharable) {
            return 2;
        }
        
        // Check direct capacity property
        if (props.capacity) {
            return parseInt(props.capacity) || 1;
        }
        
        return 1; // Default: not sharable
    }

    /**
     * ★★★ v2.3: Case-insensitive property lookup ★★★
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

    // =========================================================================
    // CHECK 1: CROSS-DIVISION TIME-BASED CONFLICTS
    // =========================================================================

    function checkCrossDivisionTimeConflicts(assignments, divisions, divisionTimes, activityProperties) {
        const errors = [];
        
        // Build a map of all field usages with their actual time ranges
        // { fieldName: [{ bunk, divName, slotIdx, startMin, endMin }] }
        const fieldUsageByTime = {};
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            // Find which division this bunk belongs to
            let divName = null;
            for (const [d, data] of Object.entries(divisions)) {
                if ((data.bunks || []).map(String).includes(String(bunk))) {
                    divName = d;
                    break;
                }
            }
            
            if (!divName) return;
            
            const divSlots = divisionTimes[divName] || [];
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                
                // Skip league entries in conflict check
                if (entry._isLeague || entry._allMatchups) return;
                
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
        
        // Now check for conflicts
        Object.entries(fieldUsageByTime).forEach(([fieldName, usages]) => {
            if (usages.length < 2) return;
            
            // Get properties for this field/activity (case-insensitive)
            const props = findPropsForField(fieldName, activityProperties);
            const sharableWith = props.sharableWith || {};
            
            // ★★★ v2.2 FIX: Get ACTUAL capacity from config ★★★
            let maxCapacity = 1;
            if (sharableWith.type === 'all') {
                maxCapacity = 999;
            } else if (sharableWith.type === 'not_sharable') {
                maxCapacity = 1;
            } else if (sharableWith.type === 'custom') {
                maxCapacity = parseInt(sharableWith.capacity) || 2;
            } else if (sharableWith.capacity) {
                maxCapacity = parseInt(sharableWith.capacity);
            } else if (props.sharable) {
                maxCapacity = 2;
            }
            
            // ★★★ v2.2: Separate CROSS-DIVISION conflicts from CAPACITY violations ★★★
            // If sharableWith.type !== 'all', different divisions cannot share at overlapping times
            const canShareAcrossDivisions = sharableWith.type === 'all';
            
            // Group usages by time overlap
            const processed = new Set();
            
            usages.forEach((usage, i) => {
                if (processed.has(i)) return;
                
                const overlapping = [usage];
                processed.add(i);
                
                usages.forEach((other, j) => {
                    if (i === j || processed.has(j)) return;
                    
                    // Check TIME overlap
                    const hasOverlap = usage.startMin < other.endMin && usage.endMin > other.startMin;
                    
                    if (hasOverlap) {
                        overlapping.push(other);
                        processed.add(j);
                    }
                });
                
                if (overlapping.length < 2) return;
                
                // Get unique divisions in this overlap group
                const divisionsInGroup = [...new Set(overlapping.map(g => g.divName))];
                
                // ★★★ Check for CROSS-DIVISION conflict ★★★
                if (!canShareAcrossDivisions && divisionsInGroup.length > 1) {
                    const timeStart = Math.min(...overlapping.map(g => g.startMin));
                    const timeEnd = Math.max(...overlapping.map(g => g.endMin));
                    const timeLabel = `${formatTime(timeStart)} - ${formatTime(timeEnd)}`;
                    
                    const bunkList = overlapping.map(g => `${g.bunk} (Div ${g.divName})`).join(', ');
                    
                    errors.push(
                        `<strong>Cross-Division Conflict:</strong> <u>${fieldName}</u> used by ` +
                        `<strong>${overlapping.length}</strong> bunks from <strong>different divisions</strong> during ${timeLabel}<br>` +
                        `<small style="color:#666;">Divisions: ${divisionsInGroup.join(', ')} | Bunks: ${bunkList}</small><br>` +
                        `<small style="color:#888;">This activity cannot be shared across divisions at the same time.</small>`
                    );
                } else {
                    // Same division(s) - check capacity per division
                    divisionsInGroup.forEach(divName => {
                        const divUsages = overlapping.filter(g => g.divName === divName);
                        
                        if (divUsages.length > maxCapacity) {
                            const timeStart = Math.min(...divUsages.map(g => g.startMin));
                            const timeEnd = Math.max(...divUsages.map(g => g.endMin));
                            const timeLabel = `${formatTime(timeStart)} - ${formatTime(timeEnd)}`;
                            
                            const bunkList = divUsages.map(g => g.bunk).join(', ');
                            
                            errors.push(
                                `<strong>Capacity Exceeded:</strong> <u>${fieldName}</u> used by ` +
                                `<strong>${divUsages.length}</strong> bunks in Division ${divName} at ${timeLabel} ` +
                                `(Max Capacity: ${maxCapacity})<br>` +
                                `<small style="color:#666;">Bunks: ${bunkList}</small>`
                            );
                        }
                    });
                }
            });
        });
        
        return errors;
    }

    // =========================================================================
    // CHECK 2: SAME-SLOT CAPACITY (within same division) - REMOVED
    // =========================================================================
    // NOTE: This check is now merged into checkCrossDivisionTimeConflicts
    // which handles both cross-division conflicts AND per-division capacity

    function checkSameSlotCapacity(assignments, divisions, divisionTimes, activityProperties) {
        // This function is now a no-op since checkCrossDivisionTimeConflicts
        // handles both cross-division and same-division capacity violations
        return [];
    }

    // =========================================================================
    // CHECK 3: SAME-DAY ACTIVITY REPETITIONS
    // =========================================================================

    function checkSameDayRepetitions(assignments) {
        const errors = [];
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const activitySlots = {}; // { activityName: [slotIndices] }
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation || entry._isTransition) return;
                
                // ★★★ v2.2: Skip league entries for repetition check ★★★
                if (entry._isLeague || entry._allMatchups) return;
                
                const activity = entry._activity?.toLowerCase().trim();
                if (!activity || IGNORED_ACTIVITIES.some(ignored => activity.includes(ignored))) return;
                
                if (!activitySlots[activity]) activitySlots[activity] = [];
                activitySlots[activity].push(slotIdx);
            });
            
            // Report activities done more than once
            Object.entries(activitySlots).forEach(([activity, slotIndices]) => {
                if (slotIndices.length > 1) {
                    errors.push(
                        `<strong>Same-Day Repetition:</strong> <u>${bunk}</u> has ` +
                        `<strong>"${activity}"</strong> scheduled ${slotIndices.length} times ` +
                        `(slots: ${slotIndices.join(', ')})`
                    );
                }
            });
        });
        
        return errors;
    }

    // =========================================================================
    // CHECK 4: MISSING REQUIRED ACTIVITIES
    // =========================================================================

    function checkMissingRequired(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        // Check if lunch/dismissal are configured as required
        const requiredActivities = ['lunch']; // Add more if needed
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk] || [];
                
                requiredActivities.forEach(required => {
                    const hasActivity = slots.some(s => 
                        s && (s._activity?.toLowerCase().includes(required) || 
                              s.field?.toLowerCase?.().includes(required))
                    );
                    
                    if (!hasActivity && slots.length > 0) {
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
    // CHECK 5: EMPTY SLOTS (★★★ v2.2 FIX: League-aware ★★★)
    // =========================================================================

    function checkEmptySlots(assignments, divisions, divisionTimes) {
        const warnings = [];
        const emptyByDiv = {}; // { divName: { slotIdx: count } }
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            // ★★★ v2.2 FIX: Get league assignments for this division ★★★
            const leagueAssignments = window.leagueAssignments?.[divName] || {};
            
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk] || [];
                
                for (let i = 0; i < divSlots.length; i++) {
                    const entry = slots[i];
                    
                    // ★★★ v2.2 FIX: Multiple ways to detect league content ★★★
                    // 1. Check leagueAssignments for this division/slot
                    const hasLeagueAssignment = leagueAssignments[i]?.matchups?.length > 0;
                    
                    // 2. Check if entry itself is a league entry
                    const entryIsLeague = entry && (
                        entry._isLeague === true ||
                        entry._allMatchups?.length > 0 ||
                        entry._leagueGame === true ||
                        (entry.field && typeof entry.field === 'string' && entry.field.includes(' vs ')) ||
                        (entry._activity && typeof entry._activity === 'string' && 
                         (entry._activity.toLowerCase().includes('league') || 
                          entry._activity.toLowerCase().includes('game')))
                    );
                    
                    // 3. Check if entry has any meaningful content
                    const hasContent = entry && (
                        entry._activity || 
                        entry.field || 
                        entry.sport ||
                        entry.continuation
                    );
                    
                    // ★★★ v2.2: Slot is NOT empty if any of these are true ★★★
                    const isEmpty = !hasContent && !hasLeagueAssignment && !entryIsLeague;
                    
                    if (isEmpty) {
                        if (!emptyByDiv[divName]) emptyByDiv[divName] = {};
                        if (!emptyByDiv[divName][i]) emptyByDiv[divName][i] = 0;
                        emptyByDiv[divName][i]++;
                    }
                }
            });
        });
        
        // Report slots where ALL bunks are empty (excluding league slots)
        Object.entries(emptyByDiv).forEach(([divName, slots]) => {
            const totalBunks = divisions[divName]?.bunks?.length || 0;
            const divSlots = divisionTimes[divName] || [];
            
            // ★★★ v2.2 FIX: Also check leagueAssignments at division level ★★★
            const leagueAssignments = window.leagueAssignments?.[divName] || {};
            
            Object.entries(slots).forEach(([slotIdx, emptyCount]) => {
                const slotIdxNum = parseInt(slotIdx);
                
                // ★★★ v2.2 FIX: Skip if this slot has league data ★★★
                if (leagueAssignments[slotIdxNum]?.matchups?.length > 0) {
                    return; // This is a league slot, don't warn
                }
                
                if (emptyCount === totalBunks && totalBunks > 0) {
                    const slotInfo = divSlots[slotIdxNum];
                    const timeLabel = slotInfo 
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
    // SHOW VALIDATION MODAL
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
            <div style="background:white; padding:25px; border-radius:12px; width:700px; max-width:90vw; max-height:85vh; overflow-y:auto; box-shadow:0 10px 25px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:15px;">
                    <h2 style="margin:0; color:#333; display:flex; align-items:center; gap:8px;">
                        🛡️ Schedule Validator
                        <span style="font-size:0.6em; background:#e0e0e0; padding:2px 8px; border-radius:4px;">v2.3</span>
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
                    <div style="flex:1; background:${errors.length > 0 ? '#FFEBEE' : '#E8F5E9'}; padding:15px; border-radius:8px; text-align:center;">
                        <div style="font-size:2em; font-weight:bold; color:${errors.length > 0 ? '#C62828' : '#2E7D32'};">${errors.length}</div>
                        <div style="font-size:0.85em; color:#666;">Errors</div>
                    </div>
                    <div style="flex:1; background:${warnings.length > 0 ? '#FFF3E0' : '#E8F5E9'}; padding:15px; border-radius:8px; text-align:center;">
                        <div style="font-size:2em; font-weight:bold; color:${warnings.length > 0 ? '#EF6C00' : '#2E7D32'};">${warnings.length}</div>
                        <div style="font-size:0.85em; color:#666;">Warnings</div>
                    </div>
                </div>
            `;
            
            // Errors
            if (errors.length > 0) {
                content += `
                    <div style="margin-bottom:20px;">
                        <h3 style="margin:0 0 10px 0; color:#C62828; font-size:1.1em; display:flex; align-items:center; gap:8px;">
                            <span>❌</span> Errors (Must Fix)
                        </h3>
                        <ul style="list-style:none; padding:0; margin:0; max-height:250px; overflow-y:auto;">
                            ${errors.map(e => `
                                <li style="background:#FFEBEE; color:#B71C1C; padding:12px; margin-bottom:6px; border-radius:6px; border-left:4px solid #F44336; font-size:0.95em;">
                                    ${e}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `;
            }
            
            // Warnings
            if (warnings.length > 0) {
                content += `
                    <div style="margin-bottom:20px;">
                        <h3 style="margin:0 0 10px 0; color:#EF6C00; font-size:1.1em; display:flex; align-items:center; gap:8px;">
                            <span>⚠️</span> Warnings (Review)
                        </h3>
                        <ul style="list-style:none; padding:0; margin:0; max-height:200px; overflow-y:auto;">
                            ${warnings.map(w => `
                                <li style="background:#FFF3E0; color:#E65100; padding:12px; margin-bottom:6px; border-radius:6px; border-left:4px solid #FF9800; font-size:0.95em;">
                                    ${w}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `;
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

    // Add animation style
    if (!document.getElementById('validator-style')) {
        const style = document.createElement('style');
        style.id = 'validator-style';
        style.innerHTML = `
            @keyframes fadeIn { 
                from { opacity: 0; transform: scale(0.95); } 
                to { opacity: 1; transform: scale(1); } 
            }
        `;
        document.head.appendChild(style);
    }

    // Export
    window.validateSchedule = validateSchedule;
    window.ScheduleValidator = {
        validate: validateSchedule,
        getFieldCapacity: getFieldCapacity
    };

    console.log('🛡️ Validator v2.3 loaded - ★★★ CROSS-DIV vs CAPACITY SEPARATION ★★★');

})();
