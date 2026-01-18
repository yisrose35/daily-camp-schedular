// =============================================================================
// POST-GENERATION EDIT SYSTEM - Enhanced Cell Editing with Conflict Resolution
// =============================================================================
// 
// FEATURES:
// - Modal UI for editing cells post-generation
// - Activity name and location/field selection
// - Optional time change (hidden by default, shown on request)
// - Scans current schedule for field conflicts
// - If conflict detected: warns user, offers Accept (pin + regenerate) or Decline
// - Pinned activities are preserved during regeneration
//
// INTEGRATION: Add this file AFTER unified_schedule_system.js
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
                if (slotStart < endMin && slotEnd > startMin) {
                    slots.push(i);
                }
            }
        }
        return slots;
    }

    // =========================================================================
    // GET ALL AVAILABLE LOCATIONS
    // =========================================================================

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        
        const locations = [];
        const seen = new Set();
        
        // Fields
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
        
        // Special Activities
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

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        const locations = getAllLocations();
        const locationInfo = locations.find(l => l.name.toLowerCase() === locationName.toLowerCase());
        const maxCapacity = locationInfo?.capacity || 1;
        
        // Get editable bunks for permission check
        const editableBunks = getEditableBunks();
        
        const conflicts = [];
        const usageBySlot = {};
        
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const entryActivity = entry._activity || entryField;
                
                if (entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase()) {
                    usageBySlot[slotIdx].push({
                        bunk: bunkName,
                        activity: entryActivity || entryField,
                        field: entryField,
                        canEdit: editableBunks.has(bunkName)
                    });
                }
            }
        }
        
        let hasConflict = false;
        let currentUsage = 0;
        
        for (const slotIdx of slots) {
            const slotUsage = usageBySlot[slotIdx] || [];
            currentUsage = Math.max(currentUsage, slotUsage.length);
            
            if (slotUsage.length >= maxCapacity) {
                hasConflict = true;
                slotUsage.forEach(u => {
                    if (!conflicts.find(c => c.bunk === u.bunk && c.slot === slotIdx)) {
                        conflicts.push({ ...u, slot: slotIdx });
                    }
                });
            }
        }
        
        // Separate editable vs non-editable conflicts
        const editableConflicts = conflicts.filter(c => c.canEdit);
        const nonEditableConflicts = conflicts.filter(c => !c.canEdit);
        
        return {
            hasConflict,
            conflicts,
            editableConflicts,
            nonEditableConflicts,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage,
            maxCapacity
        };
    }
    
    // Get set of bunks the current user can edit
    function getEditableBunks() {
        const editableBunks = new Set();
        
        // Try AccessControl first
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        const divisions = window.divisions || {};
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => editableBunks.add(String(b)));
            }
        }
        
        // If no RBAC, assume all bunks are editable
        if (editableBunks.size === 0 && !window.AccessControl) {
            Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(b));
        }
        
        return editableBunks;
    }

    // =========================================================================
    // MODAL UI
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        
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
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
        
        // Close on Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        
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
                <div style="font-size: 0.875rem; color: #6b7280;" id="post-edit-time-display">
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
                
                <!-- Change Time Toggle -->
                <div>
                    <button type="button" id="post-edit-time-toggle" style="
                        background: none;
                        border: none;
                        color: #2563eb;
                        font-size: 0.875rem;
                        cursor: pointer;
                        padding: 0;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    ">
                        <span id="post-edit-time-arrow">▶</span> Change time
                    </button>
                    
                    <!-- Time Range (Hidden by default) -->
                    <div id="post-edit-time-section" style="display: none; margin-top: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    Start Time
                                </label>
                                <input type="time" id="post-edit-start" 
                                    value="${minutesToTimeString(startMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    End Time
                                </label>
                                <input type="time" id="post-edit-end" 
                                    value="${minutesToTimeString(endMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                        </div>
                    </div>
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
        
        // Store original times
        let useOriginalTime = true;
        const originalStartMin = startMin;
        const originalEndMin = endMin;
        
        // Event handlers
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        // Time toggle
        const timeToggle = document.getElementById('post-edit-time-toggle');
        const timeSection = document.getElementById('post-edit-time-section');
        const timeArrow = document.getElementById('post-edit-time-arrow');
        const timeDisplay = document.getElementById('post-edit-time-display');
        
        timeToggle.onclick = () => {
            const isHidden = timeSection.style.display === 'none';
            timeSection.style.display = isHidden ? 'block' : 'none';
            timeArrow.textContent = isHidden ? '▼' : '▶';
            useOriginalTime = !isHidden;
        };
        
        // Conflict checking
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        const startInput = document.getElementById('post-edit-start');
        const endInput = document.getElementById('post-edit-end');
        
        function getEffectiveTimes() {
            if (useOriginalTime) {
                return { startMin: originalStartMin, endMin: originalEndMin };
            }
            return {
                startMin: parseTimeToMinutes(startInput.value) || originalStartMin,
                endMin: parseTimeToMinutes(endInput.value) || originalEndMin
            };
        }
        
        function updateTimeDisplay() {
            const times = getEffectiveTimes();
            timeDisplay.textContent = `${minutesToTimeLabel(times.startMin)} - ${minutesToTimeLabel(times.endMin)}`;
        }
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!location) {
                conflictArea.style.display = 'none';
                return null;
            }
            
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                
                conflictArea.style.display = 'block';
                
                let html = `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 1.25rem;">⚠️</span>
                        <strong style="color: #92400e;">Location Conflict Detected</strong>
                    </div>
                    <p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;">
                        <strong>${location}</strong> is already in use:
                    </p>`;
                
                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px;">
                        <div style="font-size: 0.75rem; color: #059669; font-weight: 600; margin-bottom: 4px;">✓ YOUR DIVISIONS (will be reassigned):</div>
                        <ul style="margin: 0; padding-left: 20px; color: #78350f; font-size: 0.875rem;">
                            ${editableBunks.map(b => `<li>${b}</li>`).join('')}
                        </ul>
                    </div>`;
                }
                
                if (nonEditableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px;">
                        <div style="font-size: 0.75rem; color: #dc2626; font-weight: 600; margin-bottom: 4px;">✗ OTHER SCHEDULER'S DIVISIONS:</div>
                        <ul style="margin: 0; padding-left: 20px; color: #78350f; font-size: 0.875rem;">
                            ${nonEditableBunks.map(b => `<li>${b}</li>`).join('')}
                        </ul>
                    </div>
                    
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #f59e0b;">
                        <div style="font-size: 0.875rem; font-weight: 600; color: #78350f; margin-bottom: 8px;">
                            How should we handle the other scheduler's bunks?
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="notify" checked style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">📧 Notify other scheduler</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Create double-booking & send them a warning to resolve</div>
                                </div>
                            </label>
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="bypass" style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">🔓 Bypass & reassign their bunks</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Override permissions and move their activities</div>
                                </div>
                            </label>
                        </div>
                    </div>`;
                }
                
                html += `</div>`;
                conflictArea.innerHTML = html;
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        startInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        endInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        
        // Initial check
        checkAndShowConflicts();
        
        // Save handler
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!activity) {
                alert('Please enter an activity name.');
                return;
            }
            
            if (times.endMin <= times.startMin) {
                alert('End time must be after start time.');
                return;
            }
            
            const conflictCheck = location ? checkAndShowConflicts() : null;
            
            if (conflictCheck?.hasConflict) {
                // Get resolution choice for non-editable conflicts
                let resolutionChoice = 'notify'; // default
                const resolutionRadio = document.querySelector('input[name="conflict-resolution"]:checked');
                if (resolutionRadio) {
                    resolutionChoice = resolutionRadio.value;
                }
                
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: true,
                    conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice: resolutionChoice
                });
            } else {
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: false,
                    conflicts: []
                });
            }
            
            closeModal();
        };
        
        // Focus activity input
        document.getElementById('post-edit-activity').focus();
        document.getElementById('post-edit-activity').select();
    }

    // =========================================================================
    // APPLY EDIT
    // =========================================================================

    function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (slots.length === 0) {
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, { activity, location, startMin, endMin, slots, hasConflict, resolutionChoice });
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }
        
        if (hasConflict) {
            resolveConflictsAndApply(bunk, slots, activity, location, editData);
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }
        
        window.saveSchedule?.();
        window.updateTable?.();
        
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
        
        if (location && !isClear && window.registerLocationUsage) {
            const divName = Object.keys(window.divisions || {}).find(d => 
                window.divisions[d]?.bunks?.includes(bunk)
            );
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName);
            });
        }
    }

    function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
        const editableConflicts = editData.editableConflicts || [];
        const nonEditableConflicts = editData.nonEditableConflicts || [];
        const resolutionChoice = editData.resolutionChoice || 'notify';
        
        console.log('[PostEdit] Resolving conflicts...', {
            editable: editableConflicts.length,
            nonEditable: nonEditableConflicts.length,
            resolution: resolutionChoice
        });
        
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
        
        // Reassign bunks we CAN edit (always)
        if (editableConflicts.length > 0) {
            const conflictsByBunk = {};
            editableConflicts.forEach(c => {
                if (!conflictsByBunk[c.bunk]) {
                    conflictsByBunk[c.bunk] = [];
                }
                conflictsByBunk[c.bunk].push(c.slot);
            });
            
            for (const [conflictBunk, conflictSlots] of Object.entries(conflictsByBunk)) {
                const uniqueSlots = [...new Set(conflictSlots)];
                reassignBunkActivity(conflictBunk, uniqueSlots, location);
            }
        }
        
        // Handle non-editable conflicts based on choice
        if (nonEditableConflicts.length > 0) {
            const nonEditableBunks = [...new Set(nonEditableConflicts.map(c => c.bunk))];
            
            if (resolutionChoice === 'bypass') {
                // BYPASS: Override permissions and reassign their bunks too
                console.log('[PostEdit] 🔓 BYPASSING permissions to reassign other scheduler bunks:', nonEditableBunks);
                
                const conflictsByBunk = {};
                nonEditableConflicts.forEach(c => {
                    if (!conflictsByBunk[c.bunk]) {
                        conflictsByBunk[c.bunk] = [];
                    }
                    conflictsByBunk[c.bunk].push(c.slot);
                });
                
                for (const [conflictBunk, conflictSlots] of Object.entries(conflictsByBunk)) {
                    const uniqueSlots = [...new Set(conflictSlots)];
                    reassignBunkActivity(conflictBunk, uniqueSlots, location);
                }
                
                if (window.showToast) {
                    window.showToast(`🔓 Bypassed permissions - reassigned ${nonEditableBunks.length} bunk(s)`, 'info');
                }
                
                // Still send a notification that you made changes to their bunks
                sendSchedulerNotification(nonEditableBunks, location, activity, 'bypassed');
                
            } else {
                // NOTIFY: Just create double-booking and notify them
                console.warn(`[PostEdit] 📧 Double-booking created with bunks from other schedulers: ${nonEditableBunks.join(', ')}`);
                
                if (window.showToast) {
                    window.showToast(`📧 Notification sent to other scheduler about conflict`, 'warning');
                }
                
                sendSchedulerNotification(nonEditableBunks, location, activity, 'conflict');
            }
        }
    }
    
    // Send notification to other schedulers about conflict
    function sendSchedulerNotification(bunks, location, activity, type) {
        const currentUser = window.SupabaseClient?.currentUser?.email || 'Unknown scheduler';
        const currentDate = window.currentDate || new Date().toISOString().split('T')[0];
        
        const notification = {
            type: type === 'bypassed' ? 'schedule_override' : 'schedule_conflict',
            message: type === 'bypassed' 
                ? `${currentUser} has overridden permissions and reassigned your bunks (${bunks.join(', ')}) away from ${location} for ${activity}`
                : `${currentUser} has scheduled ${activity} at ${location}, conflicting with your bunks: ${bunks.join(', ')}. Please resolve the double-booking.`,
            bunks: bunks,
            location: location,
            activity: activity,
            date: currentDate,
            from: currentUser,
            timestamp: Date.now()
        };
        
        console.log('[PostEdit] 📧 Scheduler notification:', notification);
        
        // Store notification in localStorage for now (can be enhanced to use Supabase later)
        const notificationKey = `campistry_notifications_${currentDate}`;
        const existing = JSON.parse(localStorage.getItem(notificationKey) || '[]');
        existing.push(notification);
        localStorage.setItem(notificationKey, JSON.stringify(existing));
        
        // Also try to store in cloud if available
        if (window.CloudSyncHelpers?.queueForSync) {
            window.CloudSyncHelpers.queueForSync('notifications', { 
                key: notificationKey, 
                data: existing 
            });
        }
        
        // Dispatch event for real-time notification systems
        window.dispatchEvent(new CustomEvent('campistry-scheduler-notification', { 
            detail: notification 
        }));
    }

    function reassignBunkActivity(bunk, slots, avoidLocation) {
        console.log(`[PostEdit] Reassigning ${bunk} away from ${avoidLocation}`);
        
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) return;
        
        const originalActivity = entry._activity || entry.sport || 'Activity';
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
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fields = app1.fields || [];
        
        const activityLower = activityName.toLowerCase();
        const candidateFields = [];
        
        for (const field of fields) {
            if (field.name.toLowerCase() === avoidLocation.toLowerCase()) continue;
            if (field.available === false) continue;
            
            const activities = field.activities || [];
            const supportsActivity = activities.some(a => 
                a.toLowerCase() === activityLower ||
                activityLower.includes(a.toLowerCase()) ||
                a.toLowerCase().includes(activityLower)
            );
            
            const isGeneral = activities.length === 0 || 
                activities.some(a => a.toLowerCase().includes('general'));
            
            if (supportsActivity || isGeneral) {
                candidateFields.push(field);
            }
        }
        
        for (const field of candidateFields) {
            const conflictCheck = checkLocationConflict(field.name, slots, null);
            
            if (!conflictCheck.hasConflict || conflictCheck.canShare) {
                return field.name;
            }
        }
        
        return null;
    }

    // =========================================================================
    // ENHANCED EDIT CELL
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
        
        // Show modal
        showEditModal(bunk, startMin, endMin, current, (editData) => {
            applyEdit(bunk, editData);
        });
    }

    // =========================================================================
    // CLICK INTERCEPTOR - Captures cell clicks before original handler
    // =========================================================================

    function setupClickInterceptor() {
        document.addEventListener('click', (e) => {
            // Check if click is on a schedule cell (td in schedule table)
            const cell = e.target.closest('td[data-bunk][data-start-min]');
            if (!cell) return;
            
            // Get cell data
            const bunk = cell.dataset.bunk;
            const startMin = parseInt(cell.dataset.startMin, 10);
            const endMin = parseInt(cell.dataset.endMin, 10);
            const currentText = cell.textContent?.trim() || '';
            
            if (!bunk || isNaN(startMin) || isNaN(endMin)) return;
            
            // Prevent original handler
            e.stopPropagation();
            e.preventDefault();
            
            // Call our enhanced edit
            enhancedEditCell(bunk, startMin, endMin, currentText);
            
        }, true); // Use capture phase to intercept before other handlers
        
        console.log('[PostEdit] Click interceptor installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initPostEditSystem() {
        // Override window.editCell
        window.editCell = enhancedEditCell;
        
        // Also set up click interceptor as backup
        setupClickInterceptor();
        
        // Add CSS
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
        console.log('   - Click interceptor active');
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
    window.getEditableBunks = getEditableBunks;
    window.sendSchedulerNotification = sendSchedulerNotification;

    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        initPostEditSystem();
    }

})();
