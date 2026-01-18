// =============================================================================
// POST-GENERATION EDIT SYSTEM - Enhanced Cell Editing with Conflict Resolution
// =============================================================================
// 
// REPLACES: The simple prompt-based editCell in unified_schedule_system.js
// 
// FEATURES:
// - Modal UI for editing cells post-generation
// - Activity name, start/end times, and location/field selection
// - Scans current schedule for field conflicts
// - If conflict detected: warns user, offers Accept (pin + regenerate) or Decline
// - Pinned activities are preserved during regeneration
//
// INTEGRATION: Add this file AFTER unified_schedule_system.js
// Then call: window.initPostEditSystem();
//
// =============================================================================

(function() {
    'use strict';

    console.log('📝 Post-Generation Edit System loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridiem = null;
        
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridiem = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        
        // Try 24h format first
        const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
        if (match24) {
            let h = parseInt(match24[1], 10);
            const m = parseInt(match24[2], 10);
            
            if (meridiem) {
                if (h === 12) h = (meridiem === 'am' ? 0 : 12);
                else if (meridiem === 'pm' && h < 12) h += 12;
            }
            
            return h * 60 + m;
        }
        
        return null;
    }

    function minutesToTimeString(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
    }

    function findSlotIndexForTime(targetMin, unifiedTimes) {
        if (!unifiedTimes || !Array.isArray(unifiedTimes)) return -1;
        
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slot = unifiedTimes[i];
            const slotStart = slot.startMin !== undefined ? slot.startMin : 
                (slot.start instanceof Date ? slot.start.getHours() * 60 + slot.start.getMinutes() : null);
            
            if (slotStart === targetMin) return i;
        }
        return -1;
    }

    function findSlotsForRange(startMin, endMin, unifiedTimes) {
        if (!unifiedTimes || !Array.isArray(unifiedTimes)) return [];
        
        const slots = [];
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slot = unifiedTimes[i];
            const slotStart = slot.startMin !== undefined ? slot.startMin :
                (slot.start instanceof Date ? slot.start.getHours() * 60 + slot.start.getMinutes() : null);
            const slotEnd = slot.endMin !== undefined ? slot.endMin :
                (slot.end instanceof Date ? slot.end.getHours() * 60 + slot.end.getMinutes() : null);
            
            if (slotStart !== null && slotEnd !== null) {
                // Slot overlaps with our range
                if (slotStart < endMin && slotEnd > startMin) {
                    slots.push(i);
                }
            }
        }
        return slots;
    }

    // =========================================================================
    // GET ALL AVAILABLE LOCATIONS (Fields + Special Activities with locations)
    // =========================================================================

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        
        const locations = [];
        const seen = new Set();
        
        // 1. Fields
        const fields = app1.fields || [];
        fields.forEach(f => {
            if (f.name && !seen.has(f.name)) {
                locations.push({
                    name: f.name,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 2 : 1),
                    available: f.available !== false
                });
                seen.add(f.name);
            }
        });
        
        // 2. Special Activities (as locations if they have a location property)
        const specials = app1.specialActivities || [];
        specials.forEach(s => {
            if (s.name && !seen.has(s.name)) {
                locations.push({
                    name: s.name,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1,
                    available: s.available !== false,
                    location: s.location || null
                });
                seen.add(s.name);
            }
        });
        
        return locations.sort((a, b) => a.name.localeCompare(b.name));
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    /**
     * Check if a location is already in use at the given slots
     * Returns: { hasConflict: boolean, conflicts: [{bunk, activity, slot}], canShare: boolean }
     */
    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        const locations = getAllLocations();
        const locationInfo = locations.find(l => l.name.toLowerCase() === locationName.toLowerCase());
        const maxCapacity = locationInfo?.capacity || 1;
        
        const conflicts = [];
        const usageBySlot = {};
        
        // Count usage at each slot
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const entryActivity = entry._activity || entryField;
                
                // Check if this entry uses our location
                if (entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase()) {
                    usageBySlot[slotIdx].push({
                        bunk: bunkName,
                        activity: entryActivity || entryField,
                        field: entryField
                    });
                }
            }
        }
        
        // Check if any slot exceeds capacity
        let hasConflict = false;
        let currentUsage = 0;
        
        for (const slotIdx of slots) {
            const slotUsage = usageBySlot[slotIdx] || [];
            currentUsage = Math.max(currentUsage, slotUsage.length);
            
            // Adding one more would exceed capacity
            if (slotUsage.length >= maxCapacity) {
                hasConflict = true;
                slotUsage.forEach(u => {
                    if (!conflicts.find(c => c.bunk === u.bunk && c.slot === slotIdx)) {
                        conflicts.push({ ...u, slot: slotIdx });
                    }
                });
            }
        }
        
        return {
            hasConflict,
            conflicts,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage,
            maxCapacity
        };
    }

    // =========================================================================
    // MODAL UI
    // =========================================================================

    function createModal() {
        // Remove existing
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        
        // Overlay
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease;
        `;
        
        // Modal
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        // Parse current value to extract field if possible
        let currentActivity = currentValue || '';
        let currentField = '';
        
        // Try to get current entry data
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
                currentActivity = entry._activity || currentField || currentValue;
            }
        }
        
        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="margin: 0; font-size: 1.25rem; color: #1f2937;">Edit Schedule Cell</h2>
                <button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #9ca3af; line-height: 1;">&times;</button>
            </div>
            
            <div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;">
                <div style="font-weight: 600; color: #374151;">${bunk}</div>
                <div style="font-size: 0.875rem; color: #6b7280;">
                    ${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}
                </div>
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <!-- Activity Name -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Activity Name
                    </label>
                    <input type="text" id="post-edit-activity" 
                        value="${currentActivity}"
                        placeholder="e.g., Impromptu Carnival, Basketball"
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;">
                    <div style="font-size: 0.75rem; color: #9ca3af; margin-top: 4px;">
                        Enter CLEAR or FREE to empty this slot
                    </div>
                </div>
                
                <!-- Time Range -->
                <div style="display: flex; gap: 12px;">
                    <div style="flex: 1;">
                        <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                            Start Time
                        </label>
                        <input type="time" id="post-edit-start" 
                            value="${minutesToTimeString(startMin)}"
                            style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;">
                    </div>
                    <div style="flex: 1;">
                        <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                            End Time
                        </label>
                        <input type="time" id="post-edit-end" 
                            value="${minutesToTimeString(endMin)}"
                            style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;">
                    </div>
                </div>
                
                <!-- Location/Field -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Location / Field
                    </label>
                    <select id="post-edit-location" 
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box; background: white;">
                        <option value="">-- No specific location --</option>
                        <optgroup label="Fields">
                            ${locations.filter(l => l.type === 'field').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (capacity: ${l.capacity})` : ''}</option>`
                            ).join('')}
                        </optgroup>
                        <optgroup label="Special Activities">
                            ${locations.filter(l => l.type === 'special').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`
                            ).join('')}
                        </optgroup>
                    </select>
                </div>
                
                <!-- Conflict Warning Area -->
                <div id="post-edit-conflict" style="display: none;"></div>
                
                <!-- Buttons -->
                <div style="display: flex; gap: 12px; margin-top: 8px;">
                    <button id="post-edit-cancel" style="
                        flex: 1;
                        padding: 12px;
                        border: 1px solid #d1d5db;
                        border-radius: 8px;
                        background: white;
                        color: #374151;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Cancel</button>
                    <button id="post-edit-save" style="
                        flex: 1;
                        padding: 12px;
                        border: none;
                        border-radius: 8px;
                        background: #2563eb;
                        color: white;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Save Changes</button>
                </div>
            </div>
        `;
        
        // Event handlers
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        // Check conflicts when location changes
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        const startInput = document.getElementById('post-edit-start');
        const endInput = document.getElementById('post-edit-end');
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const newStartMin = parseTimeToMinutes(startInput.value);
            const newEndMin = parseTimeToMinutes(endInput.value);
            
            if (!location || !newStartMin || !newEndMin) {
                conflictArea.style.display = 'none';
                return null;
            }
            
            const newSlots = findSlotsForRange(newStartMin, newEndMin, unifiedTimes);
            const conflictCheck = checkLocationConflict(location, newSlots, bunk);
            
            if (conflictCheck.hasConflict) {
                const conflictBunks = [...new Set(conflictCheck.conflicts.map(c => c.bunk))];
                conflictArea.style.display = 'block';
                conflictArea.innerHTML = `
                    <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <span style="font-size: 1.25rem;">⚠️</span>
                            <strong style="color: #92400e;">Location Conflict Detected</strong>
                        </div>
                        <p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;">
                            <strong>${location}</strong> is already in use by:
                        </p>
                        <ul style="margin: 0; padding-left: 20px; color: #78350f; font-size: 0.875rem;">
                            ${conflictBunks.map(b => `<li>${b}</li>`).join('')}
                        </ul>
                        <p style="margin: 8px 0 0 0; color: #78350f; font-size: 0.875rem;">
                            If you proceed, the system will attempt to reassign the conflicting activities to other available locations.
                        </p>
                    </div>
                `;
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        startInput.addEventListener('change', checkAndShowConflicts);
        endInput.addEventListener('change', checkAndShowConflicts);
        
        // Initial check
        checkAndShowConflicts();
        
        // Save handler
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            const newStartMin = parseTimeToMinutes(startInput.value);
            const newEndMin = parseTimeToMinutes(endInput.value);
            
            if (!activity) {
                alert('Please enter an activity name.');
                return;
            }
            
            if (!newStartMin || !newEndMin || newEndMin <= newStartMin) {
                alert('Please enter valid start and end times.');
                return;
            }
            
            const conflictCheck = location ? checkAndShowConflicts() : null;
            
            if (conflictCheck?.hasConflict) {
                // Show confirmation dialog
                const proceed = confirm(
                    `⚠️ CONFLICT WARNING\n\n` +
                    `"${location}" is already in use during this time.\n\n` +
                    `If you proceed:\n` +
                    `• Your activity will be PINNED to this location\n` +
                    `• Conflicting activities will be moved to other available locations\n` +
                    `• The schedule will be partially regenerated\n\n` +
                    `Do you want to proceed?`
                );
                
                if (!proceed) return;
                
                // User accepted - apply with regeneration
                onSave({
                    activity,
                    location,
                    startMin: newStartMin,
                    endMin: newEndMin,
                    hasConflict: true,
                    conflicts: conflictCheck.conflicts
                });
            } else {
                // No conflict - just apply
                onSave({
                    activity,
                    location,
                    startMin: newStartMin,
                    endMin: newEndMin,
                    hasConflict: false,
                    conflicts: []
                });
            }
            
            closeModal();
        };
        
        // Focus activity input
        document.getElementById('post-edit-activity').focus();
    }

    // =========================================================================
    // APPLY EDIT WITH OPTIONAL REGENERATION
    // =========================================================================

    function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, conflicts } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (slots.length === 0) {
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, {
            activity,
            location,
            startMin,
            endMin,
            slots,
            hasConflict
        });
        
        // Initialize if needed
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }
        
        if (hasConflict && conflicts.length > 0) {
            // Need to handle conflicts - move conflicting activities
            resolveConflictsAndApply(bunk, slots, activity, location, conflicts);
        } else {
            // No conflict - just apply directly
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }
        
        // Save and refresh
        window.saveSchedule?.();
        window.updateTable?.();
        
        // Show success toast
        if (window.showToast) {
            window.showToast(`✅ Updated ${bunk}: ${isClear ? 'Cleared' : activity}`, 'success');
        }
    }

    function applyDirectEdit(bunk, slots, activity, location, isClear) {
        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: isClear ? 'Free' : (location || activity),
                sport: null,
                continuation: i > 0,
                _fixed: true,
                _pinned: !isClear,
                _activity: isClear ? 'Free' : activity,
                _postEdit: true,
                _editedAt: Date.now()
            };
        });
        
        // Register location usage if specified
        if (location && !isClear && window.registerLocationUsage) {
            const divName = Object.keys(window.divisions || {}).find(d => 
                window.divisions[d]?.bunks?.includes(bunk)
            );
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName);
            });
        }
    }

    function resolveConflictsAndApply(bunk, slots, activity, location, conflicts) {
        console.log('[PostEdit] Resolving conflicts...', conflicts);
        
        // First, apply the pinned edit
        applyDirectEdit(bunk, slots, activity, location, false);
        
        // Lock this field for these slots
        if (window.GlobalFieldLocks) {
            const divName = Object.keys(window.divisions || {}).find(d => 
                window.divisions[d]?.bunks?.includes(bunk)
            );
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'post_edit_pinned',
                division: divName,
                activity: activity
            });
        }
        
        // Now handle each conflicting bunk
        const conflictsByBunk = {};
        conflicts.forEach(c => {
            if (!conflictsByBunk[c.bunk]) {
                conflictsByBunk[c.bunk] = [];
            }
            conflictsByBunk[c.bunk].push(c.slot);
        });
        
        // Try to reassign each conflicting bunk to a different location
        for (const [conflictBunk, conflictSlots] of Object.entries(conflictsByBunk)) {
            const uniqueSlots = [...new Set(conflictSlots)];
            reassignBunkActivity(conflictBunk, uniqueSlots, location);
        }
    }

    function reassignBunkActivity(bunk, slots, avoidLocation) {
        console.log(`[PostEdit] Reassigning ${bunk} away from ${avoidLocation} at slots:`, slots);
        
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) return;
        
        const originalActivity = entry._activity || entry.sport || 'Activity';
        
        // Find an alternative location
        const alternative = findAlternativeLocation(originalActivity, slots, avoidLocation);
        
        if (alternative) {
            console.log(`[PostEdit] Found alternative for ${bunk}: ${alternative}`);
            
            slots.forEach((idx, i) => {
                window.scheduleAssignments[bunk][idx] = {
                    ...entry,
                    field: alternative,
                    continuation: i > 0,
                    _reassigned: true,
                    _originalField: avoidLocation,
                    _reassignedAt: Date.now()
                };
            });
            
            if (window.showToast) {
                window.showToast(`↪️ Moved ${bunk} to ${alternative}`, 'info');
            }
        } else {
            // No alternative found - mark as Free
            console.warn(`[PostEdit] No alternative found for ${bunk}, marking as Free`);
            
            slots.forEach((idx, i) => {
                window.scheduleAssignments[bunk][idx] = {
                    field: 'Free',
                    sport: null,
                    continuation: i > 0,
                    _fixed: false,
                    _activity: 'Free',
                    _noAlternative: true,
                    _originalActivity: originalActivity,
                    _originalField: avoidLocation
                };
            });
            
            if (window.showToast) {
                window.showToast(`⚠️ ${bunk}: No alternative found, set to Free`, 'warning');
            }
        }
    }

    function findAlternativeLocation(activityName, slots, avoidLocation) {
        const locations = getAllLocations();
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fields = app1.fields || [];
        
        // Find fields that can host this activity type
        const activityLower = activityName.toLowerCase();
        const candidateFields = [];
        
        // Check each field
        for (const field of fields) {
            if (field.name.toLowerCase() === avoidLocation.toLowerCase()) continue;
            if (field.available === false) continue;
            
            // Check if field supports this activity
            const activities = field.activities || [];
            const supportsActivity = activities.some(a => 
                a.toLowerCase() === activityLower ||
                activityLower.includes(a.toLowerCase()) ||
                a.toLowerCase().includes(activityLower)
            );
            
            // Or if it's a general field
            const isGeneral = activities.length === 0 || 
                activities.some(a => a.toLowerCase().includes('general'));
            
            if (supportsActivity || isGeneral) {
                candidateFields.push(field);
            }
        }
        
        // Check each candidate for availability
        for (const field of candidateFields) {
            const conflictCheck = checkLocationConflict(field.name, slots, null);
            
            if (!conflictCheck.hasConflict) {
                return field.name;
            }
            
            // Can we share?
            if (conflictCheck.canShare) {
                return field.name;
            }
        }
        
        // No suitable alternative found
        return null;
    }

    // =========================================================================
    // ENHANCED EDIT CELL - Replaces the original
    // =========================================================================

    function enhancedEditCell(bunk, startMin, endMin, current) {
        if (!bunk) return;
        
        const unifiedTimes = window.unifiedTimes || [];
        const slotIdx = findSlotIndexForTime(startMin, unifiedTimes);
        
        // Check multi-scheduler blocking
        if (window.MultiSchedulerAutonomous?.isBunkSlotBlocked) {
            const blockCheck = window.MultiSchedulerAutonomous.isBunkSlotBlocked(bunk, slotIdx);
            if (blockCheck.blocked) {
                if (window.showToast) {
                    window.showToast(`🔒 Cannot edit: ${blockCheck.reason}`, 'error');
                } else {
                    alert(`🔒 Cannot edit: ${blockCheck.reason}`);
                }
                return;
            }
        }
        
        // Check RBAC permissions
        if (window.AccessControl && !window.AccessControl.canEditBunk?.(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        
        // Show the enhanced modal
        showEditModal(bunk, startMin, endMin, current, (editData) => {
            applyEdit(bunk, editData);
        });
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initPostEditSystem() {
        // Replace the original editCell with enhanced version
        window.editCell = enhancedEditCell;
        
        // Add CSS for animations
        if (!document.getElementById('post-edit-styles')) {
            const style = document.createElement('style');
            style.id = 'post-edit-styles';
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                
                #${MODAL_ID} input:focus,
                #${MODAL_ID} select:focus {
                    outline: none;
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }
                
                #${MODAL_ID} button:hover {
                    opacity: 0.9;
                }
                
                #${MODAL_ID} button:active {
                    transform: scale(0.98);
                }
            `;
            document.head.appendChild(style);
        }
        
        console.log('📝 Post-Generation Edit System initialized');
        console.log('   - Enhanced editCell with modal UI');
        console.log('   - Conflict detection enabled');
        console.log('   - Smart reassignment enabled');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.initPostEditSystem = initPostEditSystem;
    window.enhancedEditCell = enhancedEditCell;
    window.checkLocationConflict = checkLocationConflict;
    window.getAllLocations = getAllLocations;

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        initPostEditSystem();
    }

})();
