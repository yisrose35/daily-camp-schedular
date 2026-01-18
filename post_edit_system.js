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
// - Smart reassignment using rotation-aware logic from scheduler_logic_fillers
//
// INTEGRATION: Add this file AFTER unified_schedule_system.js
//
// v2.2 FIXES:
// - Fixed Supabase client access pattern (uses CampistryDB.getClient())
// - Smart rotation-aware reassignment when bypassing
// - Proper date_key column name
//
// v2.3 FIXES:
// - Fixed bunkHistory data structure (object with timestamps, not array)
//
// =============================================================================

(function() {
    'use strict';

    console.log('📝 Post-Generation Edit System v2.3 (FIXED ROTATION HISTORY) loading...');

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
    
    // Helper to get field label (mirrors scheduler_core_utils)
    function fieldLabel(f) {
        if (window.SchedulerCoreUtils?.fieldLabel) {
            return window.SchedulerCoreUtils.fieldLabel(f);
        }
        return (f && f.name) ? f.name : (typeof f === 'string' ? f : '');
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
                    available: f.available !== false,
                    activities: f.activities || []
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
    
    // Get activity properties map (mirrors scheduler setup)
    function getActivityProperties() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        
        // Fields
        (app1.fields || []).forEach(f => {
            if (f.name) {
                props[f.name] = {
                    ...f,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 2 : 1)
                };
            }
        });
        
        // Specials
        (app1.specialActivities || []).forEach(s => {
            if (s.name) {
                props[s.name] = {
                    ...s,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1
                };
            }
        });
        
        return props;
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
    // SMART ROTATION HELPERS (borrowed from scheduler_logic_fillers)
    // =========================================================================
    
    /**
     * Get activities this bunk has already done today (before the given slot)
     */
    function getActivitiesDoneToday(bunk, beforeSlot) {
        const done = new Set();
        const bunkData = window.scheduleAssignments?.[bunk];
        if (!bunkData) return done;
        
        for (let i = 0; i < beforeSlot; i++) {
            const entry = bunkData[i];
            if (entry) {
                const actName = entry._activity || entry.sport || fieldLabel(entry.field);
                if (actName && actName.toLowerCase() !== 'free' && actName.toLowerCase() !== 'transition') {
                    done.add(actName.toLowerCase().trim());
                }
            }
        }
        return done;
    }
    
    /**
     * Calculate rotation score for an activity (lower = better)
     * Mirrors the logic from scheduler_logic_fillers.js
     * 
     * NOTE: rotationHistory.bunks[bunk] is an OBJECT with activity names as keys
     * and timestamps as values, NOT an array.
     */
    function calculateRotationScore(bunk, activityName, slots) {
        const firstSlot = slots[0];
        const doneToday = getActivitiesDoneToday(bunk, firstSlot);
        const actLower = activityName.toLowerCase().trim();
        
        // HARD BLOCK: Already done today
        if (doneToday.has(actLower)) {
            return Infinity;
        }
        
        // Check rotation history (object with activity names as keys, timestamps as values)
        let score = 0;
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
        const bunkHistory = rotationHistory.bunks?.[bunk] || {};
        const lastTimestamp = bunkHistory[activityName];
        
        if (lastTimestamp) {
            // Calculate days since last done
            const now = Date.now();
            const daysSince = Math.floor((now - lastTimestamp) / (1000 * 60 * 60 * 24));
            
            if (daysSince === 0) {
                return Infinity; // Same day - blocked
            } else if (daysSince === 1) {
                score += 5000; // Heavy penalty for yesterday
            } else if (daysSince === 2) {
                score += 2000; // Penalty for 2 days ago
            } else if (daysSince <= 7) {
                score += 500; // Minor penalty for this week
            }
        }
        
        // Check historical counts for frequency
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        const activityCount = historicalCounts[bunk]?.[activityName] || 0;
        
        // Bonus for never-done or under-utilized activities
        if (activityCount === 0 && !lastTimestamp) {
            score -= 1500; // Never done - big bonus
        } else if (activityCount < 3) {
            score -= 800; // Under-utilized bonus
        } else if (activityCount > 5) {
            score += 1500; // High frequency penalty
        }
        
        return score;
    }
    
    /**
     * Check if a field has capacity for this bunk at these slots
     */
    function checkFieldCapacity(fieldName, slots, excludeBunk) {
        const activityProperties = getActivityProperties();
        const props = activityProperties[fieldName] || {};
        const maxCapacity = props.capacity || 1;
        
        const conflictCheck = checkLocationConflict(fieldName, slots, excludeBunk);
        return conflictCheck.currentUsage < maxCapacity;
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
                                    <div style="font-size: 0.75rem; color: #6b7280;">Override permissions and move their activities (uses smart rotation)</div>
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
            
            // CRITICAL: Capture radio selection BEFORE checkAndShowConflicts() re-renders the HTML
            let resolutionChoice = 'notify'; // default
            const resolutionRadio = document.querySelector('input[name="conflict-resolution"]:checked');
            if (resolutionRadio) {
                resolutionChoice = resolutionRadio.value;
                console.log('[PostEdit] Captured resolution choice BEFORE re-render:', resolutionChoice);
            }
            
            // Now check conflicts (using direct function, not the UI renderer)
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            
            if (conflictCheck?.hasConflict) {
                // Use the pre-captured resolutionChoice
                console.log('[PostEdit] Using captured resolution:', resolutionChoice);
                
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
            console.error('[PostEdit] ❌ No slots found for time range:', startMin, '-', endMin);
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, { 
            activity, 
            location, 
            startMin, 
            endMin, 
            slots, 
            hasConflict, 
            resolutionChoice,
            isClear
        });
        
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
        
        // Debug: Log what we just saved
        console.log(`[PostEdit] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        // CRITICAL: Save to localStorage FIRST (immediate persistence)
        const currentDate = window.currentDate || new Date().toISOString().split('T')[0];
        const storageKey = `scheduleAssignments_${currentDate}`;
        try {
            localStorage.setItem(storageKey, JSON.stringify(window.scheduleAssignments));
            console.log(`[PostEdit] ✅ Saved to localStorage: ${storageKey}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to localStorage:', e);
        }
        
        // Also save to the unified data key
        const unifiedKey = `campDailyData_v1_${currentDate}`;
        try {
            const dailyData = JSON.parse(localStorage.getItem(unifiedKey) || '{}');
            dailyData.scheduleAssignments = window.scheduleAssignments;
            dailyData._postEditAt = Date.now();
            localStorage.setItem(unifiedKey, JSON.stringify(dailyData));
            console.log(`[PostEdit] ✅ Saved to unified storage: ${unifiedKey}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to unified storage:', e);
        }
        
        // Set a flag to prevent cloud overwrites for the next few seconds
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        setTimeout(() => {
            window._postEditInProgress = false;
            console.log('[PostEdit] Post-edit protection expired');
        }, 5000);
        
        // Then trigger cloud save
        window.saveSchedule?.();
        
        // Force UI refresh - use multiple methods to ensure it works
        console.log('[PostEdit] Triggering UI refresh...');
        
        // Method 1: Direct updateTable
        if (window.updateTable) {
            console.log('[PostEdit] Calling window.updateTable()');
            window.updateTable();
        }
        
        // Method 2: Direct render to container (bypass throttle)
        setTimeout(() => {
            const container = document.getElementById('scheduleTable');
            if (container && window.renderStaggeredView) {
                console.log('[PostEdit] Forcing direct renderStaggeredView...');
                window.renderStaggeredView(container);
            }
        }, 100);
        
        // Method 3: Also try UnifiedScheduleSystem if available
        if (window.UnifiedScheduleSystem?.render) {
            console.log('[PostEdit] Calling UnifiedScheduleSystem.render()...');
            window.UnifiedScheduleSystem.render();
        }
        
        // Method 4: Dispatch event for other systems to pick up
        window.dispatchEvent(new CustomEvent('campistry-schedule-updated', { 
            detail: { bunk, activity, location } 
        }));
        
        if (window.showToast) {
            window.showToast(`✅ Updated ${bunk}: ${isClear ? 'Cleared' : activity}`, 'success');
        } else {
            console.log(`[PostEdit] ✅ Updated ${bunk}: ${isClear ? 'Cleared' : activity}`);
        }
    }

    function applyDirectEdit(bunk, slots, activity, location, isClear) {
        console.log(`[PostEdit] applyDirectEdit called:`, { bunk, slots, activity, location, isClear });
        
        // Format field correctly: "Location – Activity" if both present
        let fieldValue;
        if (isClear) {
            fieldValue = 'Free';
        } else if (location && activity) {
            fieldValue = `${location} – ${activity}`;
        } else if (location) {
            fieldValue = location;
        } else {
            fieldValue = activity;
        }
        
        console.log(`[PostEdit] Setting field value: "${fieldValue}" for slots:`, slots);
        
        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: fieldValue,
                sport: null,
                continuation: i > 0,
                _fixed: true,
                _pinned: !isClear,
                _activity: isClear ? 'Free' : activity,
                _location: location,
                _postEdit: true,
                _editedAt: Date.now()
            };
            console.log(`[PostEdit] Set bunk ${bunk} slot ${idx}:`, window.scheduleAssignments[bunk][idx]);
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
                smartReassignBunkActivity(conflictBunk, uniqueSlots, location);
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
                    smartReassignBunkActivity(conflictBunk, uniqueSlots, location);
                }
                
                // CRITICAL: For bypass mode, we need to save ALL bunks, not just ours
                // The regular saveSchedule filters to only editable bunks
                console.log('[PostEdit] 🔓 Bypass mode - saving ALL modified bunks to cloud');
                bypassSaveAllBunks(nonEditableConflicts.map(c => c.bunk));
                
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
    
    // =========================================================================
    // SMART REASSIGNMENT (uses rotation-aware logic)
    // =========================================================================
    
    /**
     * Smart reassignment that uses the same rotation logic as the main scheduler.
     * Finds the best alternative location considering:
     * - Field availability and capacity
     * - Rotation history (avoid same-day repeats)
     * - Activity compatibility
     * - Division preferences
     */
    function smartReassignBunkActivity(bunk, slots, avoidLocation) {
        console.log(`[PostEdit] 🧠 Smart reassigning ${bunk} away from ${avoidLocation}`);
        
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) {
            console.warn(`[PostEdit] No existing entry for ${bunk} at slot ${slots[0]}`);
            return;
        }
        
        const originalActivity = entry._activity || entry.sport || fieldLabel(entry.field);
        const divName = Object.keys(window.divisions || {}).find(d => 
            window.divisions[d]?.bunks?.includes(bunk)
        );
        
        console.log(`[PostEdit] Original activity: ${originalActivity}, Division: ${divName}`);
        
        // Get all available alternatives with rotation scores
        const alternative = findSmartAlternative(bunk, originalActivity, slots, avoidLocation, divName);
        
        if (alternative) {
            console.log(`[PostEdit] ✅ Smart alternative for ${bunk}: ${alternative.field} (score: ${alternative.score})`);
            
            // Format the field value correctly: "Location – Activity"
            const fieldValue = `${alternative.field} – ${originalActivity}`;
            
            slots.forEach((idx, i) => {
                window.scheduleAssignments[bunk][idx] = {
                    ...entry,
                    field: fieldValue,
                    _location: alternative.field,
                    _activity: originalActivity,
                    continuation: i > 0,
                    _reassigned: true,
                    _smartReassigned: true,
                    _originalField: avoidLocation,
                    _reassignedAt: Date.now(),
                    _rotationScore: alternative.score
                };
            });
            
            if (window.showToast) {
                window.showToast(`↪️ Smart-moved ${bunk} to ${alternative.field}`, 'info');
            }
        } else {
            console.warn(`[PostEdit] ⚠️ No smart alternative found for ${bunk}, marking as Free`);
            
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
    
    /**
     * Find the best alternative location using rotation-aware scoring.
     * Returns { field: string, score: number } or null
     */
    function findSmartAlternative(bunk, activityName, slots, avoidLocation, divName) {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const fields = app1.fields || [];
        const activityProperties = getActivityProperties();
        
        const activityLower = activityName.toLowerCase();
        const candidates = [];
        
        // Build list of candidate fields
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
                // Check capacity
                if (checkFieldCapacity(field.name, slots, bunk)) {
                    // Calculate rotation score
                    const rotationScore = calculateRotationScore(bunk, field.name, slots);
                    
                    // Skip if blocked by rotation (Infinity score)
                    if (rotationScore === Infinity) {
                        console.log(`[PostEdit] Skipping ${field.name} - rotation blocked`);
                        continue;
                    }
                    
                    // Add division preference bonus
                    let preferenceScore = 0;
                    const fieldProps = activityProperties[field.name] || {};
                    if (fieldProps.preferences?.enabled && fieldProps.preferences?.list) {
                        const prefList = fieldProps.preferences.list;
                        const prefIdx = prefList.indexOf(divName);
                        if (prefIdx !== -1) {
                            preferenceScore = -100 * (prefList.length - prefIdx); // Negative = good
                        }
                    }
                    
                    candidates.push({
                        field: field.name,
                        score: rotationScore + preferenceScore,
                        rotationScore,
                        preferenceScore
                    });
                }
            }
        }
        
        // Sort by score (lower is better)
        candidates.sort((a, b) => a.score - b.score);
        
        console.log(`[PostEdit] Smart alternatives for ${bunk}:`, 
            candidates.slice(0, 5).map(c => `${c.field}(${c.score})`).join(', ')
        );
        
        return candidates[0] || null;
    }
    
    // =========================================================================
    // BYPASS SAVE - Direct Supabase access for other scheduler's bunks
    // =========================================================================
    
    async function bypassSaveAllBunks(bypassBunks) {
        const currentDate = window.currentDate || new Date().toISOString().split('T')[0];
        const assignments = window.scheduleAssignments || {};
        
        // Build a payload with just the bypassed bunks
        const bypassPayload = {};
        const uniqueBunks = [...new Set(bypassBunks)];
        
        uniqueBunks.forEach(bunk => {
            if (assignments[bunk]) {
                bypassPayload[bunk] = assignments[bunk];
            }
        });
        
        console.log('[PostEdit] Bypass save payload:', { 
            bunks: Object.keys(bypassPayload).length,
            date: currentDate 
        });
        
        // Get Supabase client using the correct Campistry access pattern
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.();
        const currentUserId = window.CampistryDB?.getUserId?.();
        const currentUserEmail = window.CampistryDB?.getCurrentUser?.()?.email || 
                                window.SupabaseClient?.currentUser?.email || 
                                'bypass_override';
        
        if (client && campId) {
            try {
                console.log('[PostEdit] Fetching other scheduler records...', { campId, currentUserId, date: currentDate });
                
                // Get existing records from OTHER schedulers (not the current user)
                const { data: existing, error: fetchError } = await client
                    .from('daily_schedules')
                    .select('*')
                    .eq('camp_id', campId)
                    .eq('date_key', currentDate)
                    .neq('scheduler_id', currentUserId);
                
                if (fetchError) {
                    console.error('[PostEdit] Error fetching existing schedules:', fetchError);
                }
                
                console.log('[PostEdit] Found', existing?.length || 0, 'other scheduler records');
                
                // For each other scheduler's record, merge our bypass changes
                if (existing && existing.length > 0) {
                    for (const record of existing) {
                        const existingAssignments = record.schedule_data?.scheduleAssignments || {};
                        
                        // Merge bypass bunks into their data
                        const mergedAssignments = {
                            ...existingAssignments,
                            ...bypassPayload
                        };
                        
                        const updatedData = {
                            ...record.schedule_data,
                            scheduleAssignments: mergedAssignments,
                            _bypassedAt: Date.now(),
                            _bypassedBy: currentUserEmail
                        };
                        
                        const { error: updateError } = await client
                            .from('daily_schedules')
                            .update({ 
                                schedule_data: updatedData,
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', record.id);
                        
                        if (updateError) {
                            console.error('[PostEdit] Error updating other scheduler record:', updateError);
                        } else {
                            console.log(`[PostEdit] ✅ Bypass saved to record: ${record.created_by || record.scheduler_id}`);
                        }
                    }
                } else {
                    console.log('[PostEdit] No other scheduler records found to update');
                }
                
                console.log('[PostEdit] ✅ Bypass save complete');
                
            } catch (e) {
                console.error('[PostEdit] Bypass save error:', e);
            }
        } else {
            console.warn('[PostEdit] Supabase client or campId not available for bypass save', {
                hasClient: !!client,
                hasCampId: !!campId,
                hasUserId: !!currentUserId
            });
        }
    }
    
    // =========================================================================
    // NOTIFICATIONS
    // =========================================================================
    
    function sendSchedulerNotification(bunks, location, activity, type) {
        const currentUserEmail = window.CampistryDB?.getCurrentUser?.()?.email || 
                                window.SupabaseClient?.currentUser?.email || 
                                'Unknown scheduler';
        const currentDate = window.currentDate || new Date().toISOString().split('T')[0];
        
        const notification = {
            type: type === 'bypassed' ? 'schedule_override' : 'schedule_conflict',
            message: type === 'bypassed' 
                ? `${currentUserEmail} has overridden permissions and reassigned your bunks (${bunks.join(', ')}) away from ${location} for ${activity}`
                : `${currentUserEmail} has scheduled ${activity} at ${location}, conflicting with your bunks: ${bunks.join(', ')}. Please resolve the double-booking.`,
            bunks: bunks,
            location: location,
            activity: activity,
            date: currentDate,
            from: currentUserEmail,
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
        // Strategy 1: Override window.editCell
        const overrideWindowEditCell = () => {
            if (window.editCell && window.editCell !== enhancedEditCell && !window.editCell._isEnhanced) {
                console.log('[PostEdit] Overriding window.editCell');
                window._originalEditCell = window.editCell;
                window.editCell = enhancedEditCell;
                window.editCell._isEnhanced = true;
            }
        };
        
        overrideWindowEditCell();
        setTimeout(overrideWindowEditCell, 500);
        setTimeout(overrideWindowEditCell, 1500);
        setTimeout(overrideWindowEditCell, 3000);
        
        // Strategy 2: Capture phase click listener
        document.addEventListener('click', (e) => {
            const td = e.target.closest('td');
            if (!td) return;
            
            const table = td.closest('#scheduleTable, .schedule-table, [data-schedule]');
            if (!table) return;
            
            const onclickStr = td.getAttribute('onclick') || (td.onclick ? td.onclick.toString() : '');
            const isClickable = td.style.cursor === 'pointer' || 
                               getComputedStyle(td).cursor === 'pointer';
            
            if (!isClickable && !onclickStr.includes('editCell')) return;
            
            let bunk, startMin, endMin, currentText;
            
            const match = onclickStr.match(/editCell\s*\(\s*["']?([^"',]+)["']?\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*["']?([^"']*)["']?\s*\)/);
            if (match) {
                bunk = match[1];
                startMin = parseInt(match[2], 10);
                endMin = parseInt(match[3], 10);
                currentText = match[4] || '';
            }
            
            if (!bunk) {
                const row = td.closest('tr');
                if (row) {
                    const firstCell = row.querySelector('td:first-child, th:first-child');
                    if (firstCell) {
                        bunk = firstCell.textContent?.trim();
                    }
                }
                currentText = td.textContent?.trim() || '';
            }
            
            if (!bunk || isNaN(startMin) || isNaN(endMin)) {
                return;
            }
            
            e.stopPropagation();
            e.preventDefault();
            e.stopImmediatePropagation();
            
            console.log('[PostEdit] Intercepted cell click:', { bunk, startMin, endMin, currentText });
            enhancedEditCell(bunk, startMin, endMin, currentText);
            
        }, true);
        
        // Strategy 3: Patch cells after each render
        const patchAfterRender = () => {
            const table = document.getElementById('scheduleTable');
            if (!table) return;
            
            const cells = table.querySelectorAll('td');
            cells.forEach(td => {
                if (td._postEditPatched) return;
                if (!td.onclick) return;
                
                td._postEditPatched = true;
                const originalOnclick = td.onclick;
                
                td.onclick = function(e) {
                    const fnStr = originalOnclick.toString();
                    const match = fnStr.match(/editCell\s*\(\s*["']?([^"',]+)["']?\s*,\s*(\d+)\s*,\s*(\d+)/);
                    
                    if (match) {
                        const bunk = match[1];
                        const startMin = parseInt(match[2], 10);
                        const endMin = parseInt(match[3], 10);
                        const currentText = td.textContent?.trim() || '';
                        
                        console.log('[PostEdit] Patched cell clicked:', { bunk, startMin, endMin });
                        enhancedEditCell(bunk, startMin, endMin, currentText);
                        return;
                    }
                    
                    originalOnclick.call(this, e);
                };
            });
        };
        
        setTimeout(patchAfterRender, 1000);
        setTimeout(patchAfterRender, 2000);
        setTimeout(patchAfterRender, 5000);
        
        if (window.updateTable && !window.updateTable._postEditHooked) {
            const originalUpdate = window.updateTable;
            window.updateTable = function(...args) {
                const result = originalUpdate.apply(this, args);
                setTimeout(patchAfterRender, 100);
                return result;
            };
            window.updateTable._postEditHooked = true;
            console.log('[PostEdit] Hooked updateTable for cell patching');
        }
        
        const observer = new MutationObserver(() => {
            setTimeout(patchAfterRender, 50);
        });
        
        const scheduleContainer = document.getElementById('scheduleTable') || 
                                   document.getElementById('unified-schedule');
        if (scheduleContainer) {
            observer.observe(scheduleContainer, { childList: true, subtree: true });
        }
        
        console.log('[PostEdit] Click interceptor installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initPostEditSystem() {
        window.editCell = enhancedEditCell;
        setupClickInterceptor();
        
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
        
        console.log('📝 Post-Generation Edit System v2.3 initialized');
        console.log('   - Enhanced editCell with modal UI');
        console.log('   - Click interceptor active (3 strategies)');
        console.log('   - Conflict detection with RBAC awareness');
        console.log('   - Smart rotation-aware bypass reassignment');
        console.log('   - Fixed Supabase client access (CampistryDB)');
        console.log('   - Fixed bunkHistory data structure (object, not array)');
        console.log('   - Field format: "Location – Activity"');
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
    window.bypassSaveAllBunks = bypassSaveAllBunks;
    window.smartReassignBunkActivity = smartReassignBunkActivity;
    window.findSmartAlternative = findSmartAlternative;
    
    // Diagnostic function
    window.diagnosePostEdit = function(bunk) {
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        console.log('=== POST-EDIT DIAGNOSTIC ===');
        console.log('Date:', dateKey);
        console.log('window.scheduleAssignments exists:', !!window.scheduleAssignments);
        console.log('Total bunks in memory:', Object.keys(window.scheduleAssignments || {}).length);
        
        // Supabase access check
        console.log('\n--- Supabase Access ---');
        console.log('CampistryDB available:', !!window.CampistryDB);
        console.log('CampistryDB.getClient():', !!window.CampistryDB?.getClient?.());
        console.log('CampistryDB.getCampId():', window.CampistryDB?.getCampId?.());
        console.log('CampistryDB.getUserId():', window.CampistryDB?.getUserId?.());
        console.log('Fallback window.supabase:', !!window.supabase);
        
        if (bunk) {
            console.log(`\n--- Bunk ${bunk} ---`);
            console.log(`Bunk data:`, window.scheduleAssignments?.[bunk]);
            
            // Check rotation score
            const slots = [0, 1, 2];
            const rotationScore = calculateRotationScore(bunk, 'Baseball', slots);
            console.log(`Sample rotation score (Baseball):`, rotationScore);
            
            // Show rotation history structure
            const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };
            const bunkHistory = rotationHistory.bunks?.[bunk] || {};
            console.log(`Rotation history for ${bunk}:`, bunkHistory);
            console.log(`  Type:`, typeof bunkHistory);
            console.log(`  Is array:`, Array.isArray(bunkHistory));
            console.log(`  Keys:`, Object.keys(bunkHistory));
        }
        
        // Check localStorage
        const storageKey = `scheduleAssignments_${dateKey}`;
        const stored = localStorage.getItem(storageKey);
        console.log('\n--- localStorage ---');
        console.log('Key:', storageKey);
        console.log('Exists:', !!stored);
        
        if (stored && bunk) {
            const parsed = JSON.parse(stored);
            console.log(`Bunk ${bunk}:`, parsed?.[bunk]);
        }
        
        console.log('\nPost-edit protection active:', !!window._postEditInProgress);
        console.log('=== END DIAGNOSTIC ===');
    };

    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        initPostEditSystem();
    }

})();
