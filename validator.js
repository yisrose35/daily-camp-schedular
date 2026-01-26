// =================================================================
// validator.js v2.0 — COMPREHENSIVE SCHEDULE VALIDATOR
// =================================================================
// 
// CHECKS FOR:
// ✅ Same-slot capacity violations (basic)
// ✅ Cross-division TIME-based conflicts (NEW!)
// ✅ Same-day activity repetitions
// ✅ Missing required activities (lunch/dismissal)
// ✅ Division-specific time awareness
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
        console.log('🛡️ Running comprehensive schedule validation...');
        
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
        // 4. MISSING REQUIRED ACTIVITIES (optional - as warnings)
        // =====================================================================
        const missingWarnings = checkMissingRequired(assignments, divisions, divisionTimes);
        missingWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 5. EMPTY SLOTS CHECK
        // =====================================================================
        const emptyWarnings = checkEmptySlots(assignments, divisions, divisionTimes);
        emptyWarnings.forEach(w => warnings.push(w));
        
        console.log(`🛡️ Validation complete: ${errors.length} errors, ${warnings.length} warnings`);
        
        // Show results
        showValidationModal(errors, warnings);
        
        return { errors, warnings };
    }

    /**
     * Get activity properties from multiple sources
     */
    function getActivityProperties() {
        // Try multiple sources
        let props = window.activityProperties;
        
        if (!props || Object.keys(props).length === 0) {
            props = window.SchedulerCoreUtils?.getActivityProperties?.();
        }
        
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
     * Get field capacity from properties
     */
    function getFieldCapacity(fieldName, activityProperties) {
        const props = activityProperties[fieldName] || {};
        
        if (props.sharableWith?.capacity) {
            return parseInt(props.sharableWith.capacity) || 1;
        }
        if (props.sharableWith?.type === 'all' || props.sharableWith?.type === 'custom' || props.sharable) {
            return 2;
        }
        if (props.capacity) {
            return parseInt(props.capacity) || 1;
        }
        
        return 1;
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
        return `${h12}:${String(mins).padStart(2, '0')} ${ampm}`;
    }

    // =========================================================================
    // CHECK 1: CROSS-DIVISION TIME-BASED CONFLICTS
    // =========================================================================

    function checkCrossDivisionTimeConflicts(assignments, divisions, divisionTimes, activityProperties) {
        const errors = [];
        
        // Build time-based field usage map
        // { fieldName: [ { bunk, div, start, end, slot } ] }
        const fieldTimeUsage = {};
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            // Find division for this bunk
            const divName = Object.entries(divisions).find(([d, data]) => 
                data.bunks?.includes(bunk) || data.bunks?.includes(Number(bunk))
            )?.[0];
            
            if (!divName) return;
            
            const divSlots = divisionTimes[divName] || [];
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                
                const fieldName = normalizeFieldName(entry.field);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const slotInfo = divSlots[slotIdx];
                if (!slotInfo) return;
                
                if (!fieldTimeUsage[fieldName]) fieldTimeUsage[fieldName] = [];
                
                fieldTimeUsage[fieldName].push({
                    bunk,
                    div: divName,
                    start: slotInfo.startMin,
                    end: slotInfo.endMin,
                    slot: slotIdx,
                    activity: entry._activity || fieldName
                });
            });
        });
        
        // Check for overlapping time windows that exceed capacity
        const reportedConflicts = new Set();
        
        Object.entries(fieldTimeUsage).forEach(([fieldName, usages]) => {
            const capacity = getFieldCapacity(fieldName, activityProperties);
            
            // Check each usage against all others for time overlap
            for (let i = 0; i < usages.length; i++) {
                const base = usages[i];
                
                // Find all usages that overlap with this one
                const overlapping = usages.filter(u => 
                    u.start < base.end && u.end > base.start
                );
                
                if (overlapping.length > capacity) {
                    // Check if this is a cross-division conflict
                    const uniqueDivs = [...new Set(overlapping.map(u => u.div))];
                    
                    if (uniqueDivs.length > 1) {
                        // Calculate overlap window
                        const overlapStart = Math.max(...overlapping.map(u => u.start));
                        const overlapEnd = Math.min(...overlapping.map(u => u.end));
                        
                        // Create unique key to avoid duplicate reports
                        const key = `${fieldName}-${overlapStart}-${overlapEnd}`;
                        
                        if (!reportedConflicts.has(key)) {
                            reportedConflicts.add(key);
                            
                            const bunkList = overlapping.map(u => `${u.bunk} (Div ${u.div})`).join(', ');
                            
                            errors.push(
                                `<strong>🚨 Cross-Division Conflict:</strong> <u>${fieldName}</u> has ` +
                                `<strong>${overlapping.length}</strong> bunks during ` +
                                `${formatTime(overlapStart)} - ${formatTime(overlapEnd)} ` +
                                `(Capacity: ${capacity})<br>` +
                                `<small style="color:#666;">Bunks: ${bunkList}</small>`
                            );
                        }
                    }
                }
            }
        });
        
        return errors;
    }

    // =========================================================================
    // CHECK 2: SAME-SLOT CAPACITY VIOLATIONS
    // =========================================================================

    function checkSameSlotCapacity(assignments, divisions, divisionTimes, activityProperties) {
        const errors = [];
        
        // Build slot-based usage map (for same-division conflicts)
        // { "divName-slotIdx-fieldName": [bunks] }
        const slotUsage = {};
        
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = Object.entries(divisions).find(([d, data]) => 
                data.bunks?.includes(bunk) || data.bunks?.includes(Number(bunk))
            )?.[0];
            
            if (!divName) return;
            
            const divSlots = divisionTimes[divName] || [];
            
            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                
                const fieldName = normalizeFieldName(entry.field);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const key = `${divName}-${slotIdx}-${fieldName}`;
                if (!slotUsage[key]) {
                    slotUsage[key] = {
                        bunks: [],
                        divName,
                        slotIdx,
                        fieldName,
                        slotInfo: divSlots[slotIdx]
                    };
                }
                slotUsage[key].bunks.push(bunk);
            });
        });
        
        // Check capacities
        Object.values(slotUsage).forEach(usage => {
            const capacity = getFieldCapacity(usage.fieldName, activityProperties);
            
            if (usage.bunks.length > capacity) {
                const timeLabel = usage.slotInfo 
                    ? `${formatTime(usage.slotInfo.startMin)} - ${formatTime(usage.slotInfo.endMin)}`
                    : `Slot ${usage.slotIdx}`;
                
                errors.push(
                    `<strong>Double Booking:</strong> <u>${usage.fieldName}</u> used by ` +
                    `<strong>${usage.bunks.length}</strong> bunks in Division ${usage.divName} ` +
                    `at ${timeLabel} (Capacity: ${capacity})<br>` +
                    `<small style="color:#666;">Bunks: ${usage.bunks.join(', ')}</small>`
                );
            }
        });
        
        return errors;
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
    // CHECK 5: EMPTY SLOTS
    // =========================================================================

    function checkEmptySlots(assignments, divisions, divisionTimes) {
        const warnings = [];
        const emptyByDiv = {}; // { divName: { slotIdx: count } }
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            const leagueAssignments = window.leagueAssignments?.[divName] || {};
            
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk] || [];
                
                for (let i = 0; i < divSlots.length; i++) {
                    const entry = slots[i];
                    const hasLeague = leagueAssignments[i]?.matchups?.length > 0;
                    
                    const isEmpty = !entry || (!entry._activity && !entry.field && !entry.continuation && !hasLeague);
                    
                    if (isEmpty) {
                        if (!emptyByDiv[divName]) emptyByDiv[divName] = {};
                        if (!emptyByDiv[divName][i]) emptyByDiv[divName][i] = 0;
                        emptyByDiv[divName][i]++;
                    }
                }
            });
        });
        
        // Report slots where ALL bunks are empty
        Object.entries(emptyByDiv).forEach(([divName, slots]) => {
            const totalBunks = divisions[divName]?.bunks?.length || 0;
            const divSlots = divisionTimes[divName] || [];
            
            Object.entries(slots).forEach(([slotIdx, emptyCount]) => {
                if (emptyCount === totalBunks && totalBunks > 0) {
                    const slotInfo = divSlots[slotIdx];
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
                        <span style="font-size:0.6em; background:#e0e0e0; padding:2px 8px; border-radius:4px;">v2.0</span>
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
                        <div style="font-size:2em; margin-bottom:5px;">${errors.length > 0 ? '🚫' : '✅'}</div>
                        <div style="font-weight:bold; color:${errors.length > 0 ? '#C62828' : '#2E7D32'};">${errors.length} Error${errors.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div style="flex:1; background:${warnings.length > 0 ? '#FFF3E0' : '#E8F5E9'}; padding:15px; border-radius:8px; text-align:center;">
                        <div style="font-size:2em; margin-bottom:5px;">${warnings.length > 0 ? '⚠️' : '✅'}</div>
                        <div style="font-weight:bold; color:${warnings.length > 0 ? '#E65100' : '#2E7D32'};">${warnings.length} Warning${warnings.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>
            `;
            
            // Errors
            if (errors.length > 0) {
                content += `
                    <div style="margin-bottom:20px;">
                        <h3 style="color:#C62828; margin:0 0 10px 0; font-size:1.1em; display:flex; align-items:center; gap:8px;">
                            <span>🚫</span> Errors (Must Fix)
                        </h3>
                        <ul style="list-style:none; padding:0; margin:0; max-height:250px; overflow-y:auto;">
                            ${errors.map(e => `
                                <li style="background:#FFEBEE; color:#B71C1C; padding:12px; margin-bottom:6px; border-radius:6px; border-left:4px solid #C62828; font-size:0.95em;">
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
                        <h3 style="color:#E65100; margin:0 0 10px 0; font-size:1.1em; display:flex; align-items:center; gap:8px;">
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

    console.log('🛡️ Validator v2.0 loaded - Cross-division time conflict detection enabled');

})();
