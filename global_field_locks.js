// ============================================================================
// global_field_locks.js - UNIFIED FIELD LOCK SYSTEM
// ============================================================================
// Beta: This module provides a SINGLE SOURCE OF TRUTH for field availability.
// ALL schedulers (specialty leagues, regular leagues, smart tiles, solver)
// MUST use this system to check and register field usage.
//
// LOCK TYPES:
// 1. GLOBAL LOCK - Field is locked for ALL divisions (used by leagues)
// 2. DIVISION LOCK - Field is locked for OTHER divisions, but one division
//    can still use it (used by electives)
// ============================================================================

(function() {
    'use strict';

    // =========================================================================
    // GLOBAL LOCK REGISTRY
    // =========================================================================
    // Structure: { slotIndex: { fieldName: lockInfo } }
    // lockInfo: { 
    //    lockedBy: 'specialty_league' | 'regular_league' | 'pinned' | 'elective',
    //    lockType: 'global' | 'division',  // NEW for electives
    //    allowedDivision: string | null,   // NEW for electives
    //    leagueName: string,
    //    division: string,
    //    activity: string,
    //    timestamp: number
    // }
    // =========================================================================
    
    const GlobalFieldLocks = {
        _locks: {},
        _initialized: false
    };

    // =========================================================================
    // INITIALIZATION - Call at start of each schedule generation
    // =========================================================================
    GlobalFieldLocks.reset = function() {
        this._locks = {};
        this._initialized = true;
        console.log('[GLOBAL_LOCKS] Field lock registry RESET');
    };

    // =========================================================================
    // LOCK A FIELD (Global) - Makes field completely unavailable at given slots
    // Used by: Regular Leagues, Specialty Leagues, Pinned events
    // =========================================================================
    /**
     * Lock a field at specific time slots (GLOBAL - no division can use)
     * @param {string} fieldName - The field to lock
     * @param {number[]} slots - Array of slot indices
     * @param {object} lockInfo - Information about who is locking
     * @param {string} lockInfo.lockedBy - 'specialty_league', 'regular_league', 'pinned'
     * @param {string} lockInfo.leagueName - Name of the league (if applicable)
     * @param {string} lockInfo.division - Division name
     * @param {string} lockInfo.activity - Activity description
     */
    GlobalFieldLocks.lockField = function(fieldName, slots, lockInfo) {
        if (!this._initialized) this.reset();
        if (!fieldName || !slots || slots.length === 0) return false;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (!this._locks[slotIdx]) {
                this._locks[slotIdx] = {};
            }
            
            // Check if already locked
            if (this._locks[slotIdx][normalizedField]) {
                const existing = this._locks[slotIdx][normalizedField];
                // console.warn(`[GLOBAL_LOCKS] ⚠️ CONFLICT: "${fieldName}" at slot ${slotIdx} already locked by ${existing.lockedBy} (${existing.leagueName || existing.activity || existing.reason})`);
                return false;
            }
            
            this._locks[slotIdx][normalizedField] = {
    ...lockInfo,
    lockType: 'global',
    fieldName: fieldName,
    timestamp: Date.now()
};
            
            // console.log(`[GLOBAL_LOCKS] 🔒 LOCKED: "${fieldName}" at slot ${slotIdx} by ${lockInfo.lockedBy} (${lockInfo.leagueName || lockInfo.activity})`);
        }
        
        return true;
    };

    // =========================================================================
    // LOCK FIELD FOR SPECIFIC DIVISION (Elective)
    // Other divisions can't use, but the specified division CAN
    // =========================================================================
    /**
     * Lock a field for all divisions EXCEPT one (used by Elective tiles)
     * @param {string} fieldName - The field to lock
     * @param {number[]} slots - Array of slot indices
     * @param {string} allowedDivision - The division that CAN still use this field
     * @param {string} reason - Description (e.g., "Elective (2nd Grade)")
     */
    GlobalFieldLocks.lockFieldForDivision = function(fieldName, slots, allowedDivision, reason) {
        if (!this._initialized) this.reset();
        if (!fieldName || !slots || slots.length === 0 || !allowedDivision) return false;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (!this._locks[slotIdx]) {
                this._locks[slotIdx] = {};
            }
            
            // Check if already locked (global lock takes precedence)
            if (this._locks[slotIdx][normalizedField]) {
                const existing = this._locks[slotIdx][normalizedField];
                if (existing.lockType === 'global') {
                    // console.warn(`[GLOBAL_LOCKS] ⚠️ Cannot add division lock for "${fieldName}" at slot ${slotIdx} - already GLOBALLY locked by ${existing.lockedBy}`);
                    return false;
                }
                // If it's another division lock, warn but allow override
                // console.warn(`[GLOBAL_LOCKS] ⚠️ Overwriting division lock for "${fieldName}" at slot ${slotIdx}`);
            }
            
            // Apply division-specific lock
            this._locks[slotIdx][normalizedField] = {
                lockedBy: 'elective',
                lockType: 'division',
                allowedDivision: allowedDivision,
                reason: reason || `Elective for ${allowedDivision}`,
                fieldName: fieldName,
                timestamp: Date.now()
            };
            
            // console.log(`[GLOBAL_LOCKS] 🎯 DIVISION LOCK: "${fieldName}" at slot ${slotIdx} - reserved for ${allowedDivision}`);
        }
        
        return true;
    };

    // =========================================================================
    // CHECK IF FIELD IS LOCKED
    // =========================================================================
    /**
     * Check if a field is locked at ANY of the given slots
     * @param {string} fieldName - The field to check
     * @param {number[]} slots - Array of slot indices to check
     * @param {string} [divisionContext] - Optional: the division asking. For division locks,
     * if this matches allowedDivision, field is NOT locked.
     * @returns {object|null} - Lock info if locked, null if available
     */
    GlobalFieldLocks.isFieldLocked = function(fieldName, slots, divisionContext) {
        if (!this._initialized) return null;
        if (!fieldName || !slots || slots.length === 0) return null;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (this._locks[slotIdx] && this._locks[slotIdx][normalizedField]) {
                const lock = this._locks[slotIdx][normalizedField];
                
                // Check if this is a division-specific lock (elective)
                if (lock.lockType === 'division' && lock.allowedDivision) {
                    // If the caller's division matches the allowed division, NOT locked for them
                    if (divisionContext && divisionContext === lock.allowedDivision) {
                        continue; // Check next slot, this one is OK for this division
                    }
                }
                
                // Either global lock or division lock where caller is NOT the allowed division
                return lock;
            }
        }
        
        return null;
    };

    // =========================================================================
    // CHECK IF FIELD IS AVAILABLE (inverse of isFieldLocked)
    // =========================================================================
    GlobalFieldLocks.isFieldAvailable = function(fieldName, slots, divisionContext) {
        return this.isFieldLocked(fieldName, slots, divisionContext) === null;
    };

    // =========================================================================
    // GET ALL LOCKED FIELDS FOR A TIME SLOT
    // =========================================================================
    GlobalFieldLocks.getLockedFieldsAtSlot = function(slotIdx, divisionContext) {
        if (!this._initialized || !this._locks[slotIdx]) return [];
        
        const locked = [];
        for (const [fieldKey, lock] of Object.entries(this._locks[slotIdx])) {
            // Skip division locks if caller is the allowed division
            if (lock.lockType === 'division' && lock.allowedDivision === divisionContext) {
                continue;
            }
            locked.push(lock.fieldName);
        }
        return locked;
    };

    // =========================================================================
    // DEBUG: Print all locks
    // =========================================================================
    GlobalFieldLocks.debugPrintLocks = function() {
        console.log('\n=== GLOBAL FIELD LOCKS ===');
        
        if (!this._initialized || Object.keys(this._locks).length === 0) {
            console.log('No locks registered.');
            return;
        }
        
        const slotIndices = Object.keys(this._locks).sort((a, b) => parseInt(a) - parseInt(b));
        
        for (const slotIdx of slotIndices) {
            const slotLocks = this._locks[slotIdx];
            const fields = Object.keys(slotLocks);
            
            if (fields.length > 0) {
                console.log(`\nSlot ${slotIdx}:`);
                fields.forEach(field => {
                    const lock = slotLocks[field];
                    if (lock.lockType === 'division') {
                        console.log(`  🎯 ${lock.fieldName}: DIVISION - ${lock.reason} (allowed: ${lock.allowedDivision})`);
                    } else {
                        console.log(`  🔒 ${lock.fieldName}: GLOBAL - ${lock.lockedBy} - ${lock.leagueName || lock.activity}`);
                    }
                });
            }
        }
        
        console.log('\n=========================\n');
    };

    // =========================================================================
    // LOCK MULTIPLE FIELDS AT ONCE
    // =========================================================================
    GlobalFieldLocks.lockMultipleFields = function(fieldNames, slots, lockInfo) {
        if (!fieldNames || fieldNames.length === 0) return true;
        
        let allSuccess = true;
        for (const fieldName of fieldNames) {
            const success = this.lockField(fieldName, slots, lockInfo);
            if (!success) allSuccess = false;
        }
        return allSuccess;
    };

    // =========================================================================
    // LOCK MULTIPLE FIELDS FOR DIVISION (Elective)
    // =========================================================================
    GlobalFieldLocks.lockMultipleFieldsForDivision = function(fieldNames, slots, allowedDivision, reason) {
        if (!fieldNames || fieldNames.length === 0) return true;
        
        let allSuccess = true;
        for (const fieldName of fieldNames) {
            const success = this.lockFieldForDivision(fieldName, slots, allowedDivision, reason);
            if (!success) allSuccess = false;
        }
        return allSuccess;
    };

    // =========================================================================
    // GET AVAILABLE FIELDS FROM A LIST
    // =========================================================================
    GlobalFieldLocks.filterAvailableFields = function(fieldNames, slots, divisionContext) {
        if (!fieldNames || fieldNames.length === 0) return [];
        return fieldNames.filter(fieldName => this.isFieldAvailable(fieldName, slots, divisionContext));
    };

    // =========================================================================
    // UNLOCK A FIELD (use sparingly - mainly for corrections)
    // =========================================================================
    GlobalFieldLocks.unlockField = function(fieldName, slots) {
        if (!this._initialized) return;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (this._locks[slotIdx] && this._locks[slotIdx][normalizedField]) {
                delete this._locks[slotIdx][normalizedField];
                console.log(`[GLOBAL_LOCKS] 🔓 UNLOCKED: "${fieldName}" at slot ${slotIdx}`);
            }
        }
    };

    // =========================================================================
    // GET LOCK SUMMARY - For debugging UI
    // =========================================================================
    GlobalFieldLocks.getLockSummary = function() {
        const summary = {
            globalLocks: [],
            divisionLocks: []
        };
        
        for (const [slotIdx, slotLocks] of Object.entries(this._locks)) {
            for (const [fieldKey, lock] of Object.entries(slotLocks)) {
                const entry = {
                    field: lock.fieldName,
                    slot: parseInt(slotIdx),
                    reason: lock.reason || lock.leagueName || lock.activity
                };
                
                if (lock.lockType === 'division') {
                    entry.allowedDivision = lock.allowedDivision;
                    summary.divisionLocks.push(entry);
                } else {
                    summary.globalLocks.push(entry);
                }
            }
        }
        
        return summary;
    };
// ============================================================================
// ADD THIS CODE TO global_field_locks.js - BEFORE THE EXPORT SECTION
// ============================================================================
// Other Scheduler Awareness - Shows fields used by other schedulers
// ============================================================================

    // =========================================================================
    // OTHER SCHEDULER AWARENESS - STATE
    // =========================================================================
    
    GlobalFieldLocks._otherSchedulerFieldUsage = {};  // { fieldName: { slots: [], divisions: [], bunks: [] } }
    GlobalFieldLocks._otherSchedulerSchedules = {};   // { bunkName: slots[] }
    GlobalFieldLocks._otherSchedulerLoaded = false;
    GlobalFieldLocks._otherSchedulerDateKey = null;

    // =========================================================================
    // HELPER: Get divisions the current user CAN edit
    // =========================================================================
    
    GlobalFieldLocks._getMyDivisions = function() {
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) return divs;
        }
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) return divs;
        }
        const role = window.AccessControl?.getCurrentRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') {
            return Object.keys(window.divisions || {});
        }
        return [];
    };

    GlobalFieldLocks._getOtherDivisions = function() {
        const allDivisions = Object.keys(window.divisions || {});
        const myDivisions = new Set(this._getMyDivisions());
        return allDivisions.filter(d => !myDivisions.has(d));
    };

    GlobalFieldLocks._getDivisionForBunk = function(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    };

    GlobalFieldLocks._formatTime = function(minutes) {
        if (minutes == null) return '?';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour = h % 12 || 12;
        return `${hour}:${m.toString().padStart(2, '0')}${ampm}`;
    };

    // =========================================================================
    // LOAD OTHER SCHEDULERS' SCHEDULES FROM CLOUD
    // =========================================================================
    
    GlobalFieldLocks.loadOtherSchedulerSchedules = async function(dateKey) {
        if (!dateKey) {
            dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        }
        
        this._otherSchedulerDateKey = dateKey;
        this._otherSchedulerFieldUsage = {};
        this._otherSchedulerSchedules = {};
        
        const role = window.AccessControl?.getCurrentRole?.() || 'viewer';
        
        // Owners/Admins don't need to see "other" schedulers - they see everything
        if (role === 'owner' || role === 'admin') {
            console.log('[GLOBAL_LOCKS] Owner/Admin mode - no field restrictions from other schedulers');
            this._otherSchedulerLoaded = true;
            return { success: true, fieldCount: 0 };
        }

        const otherDivisions = this._getOtherDivisions();
        if (otherDivisions.length === 0) {
            console.log('[GLOBAL_LOCKS] No other divisions to check');
            this._otherSchedulerLoaded = true;
            return { success: true, fieldCount: 0 };
        }

        console.log('[GLOBAL_LOCKS] Loading schedules for other divisions:', otherDivisions);

        try {
            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(dateKey);
                
                if (result?.success && result.data?.scheduleAssignments) {
                    const allSchedules = result.data.scheduleAssignments;
                    const myDivisions = new Set(this._getMyDivisions());
                    
                    for (const [bunkName, slots] of Object.entries(allSchedules)) {
                        const divName = this._getDivisionForBunk(bunkName);
                        
                        // Skip bunks that belong to MY divisions
                        if (divName && myDivisions.has(divName)) {
                            continue;
                        }
                        
                        this._otherSchedulerSchedules[bunkName] = slots;
                    }
                    
                    console.log('[GLOBAL_LOCKS] Extracted other scheduler schedules:', 
                        Object.keys(this._otherSchedulerSchedules).length, 'bunks');
                }
            }
            
            this._extractOtherSchedulerFieldUsage();
            this._registerOtherSchedulerLocks();
            
            this._otherSchedulerLoaded = true;
            
            return { 
                success: true, 
                fieldCount: Object.keys(this._otherSchedulerFieldUsage).length,
                bunkCount: Object.keys(this._otherSchedulerSchedules).length
            };
            
        } catch (e) {
            console.error('[GLOBAL_LOCKS] Error loading other scheduler schedules:', e);
            this._otherSchedulerLoaded = true;
            return { success: false, error: e.message };
        }
    };

    // =========================================================================
    // EXTRACT FIELD USAGE FROM OTHER SCHEDULERS' SCHEDULES
    // =========================================================================
    
    GlobalFieldLocks._extractOtherSchedulerFieldUsage = function() {
        this._otherSchedulerFieldUsage = {};
        
        for (const [bunkName, slots] of Object.entries(this._otherSchedulerSchedules)) {
            if (!slots || !Array.isArray(slots)) continue;
            
            const divName = this._getDivisionForBunk(bunkName);
            
            for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
                const slot = slots[slotIdx];
                if (!slot) continue;
                
                const fieldName = slot.field || slot._activity || slot.sport;
                if (!fieldName) continue;
                
                if (!this._otherSchedulerFieldUsage[fieldName]) {
                    this._otherSchedulerFieldUsage[fieldName] = {
                        slots: [],
                        slotTimes: [],
                        divisions: [],
                        bunks: [],
                        details: []
                    };
                }
                
                const usage = this._otherSchedulerFieldUsage[fieldName];
                
                if (!usage.slots.includes(slotIdx)) {
                    usage.slots.push(slotIdx);
                    
                    if (window.unifiedTimes && window.unifiedTimes[slotIdx]) {
                        const timeSlot = window.unifiedTimes[slotIdx];
                        usage.slotTimes.push({
                            slot: slotIdx,
                            label: timeSlot.label || `${this._formatTime(timeSlot.startMin)} - ${this._formatTime(timeSlot.endMin)}`
                        });
                    }
                }
                
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
                
                if (!usage.bunks.includes(bunkName)) {
                    usage.bunks.push(bunkName);
                }
                
                usage.details.push({
                    slot: slotIdx,
                    bunk: bunkName,
                    division: divName,
                    activity: slot.sport || slot._activity || 'Unknown'
                });
            }
        }
        
        console.log('[GLOBAL_LOCKS] Extracted field usage:', Object.keys(this._otherSchedulerFieldUsage).length, 'fields');
    };

    // =========================================================================
    // REGISTER FIELD LOCKS FROM OTHER SCHEDULERS
    // =========================================================================
    
    GlobalFieldLocks._registerOtherSchedulerLocks = function() {
        const activityProperties = window.activityProperties || {};
        let lockCount = 0;
        
        for (const [fieldName, usage] of Object.entries(this._otherSchedulerFieldUsage)) {
            const props = activityProperties[fieldName] || {};
            let maxCapacity = 1;
            if (props.sharableWith?.capacity) {
                maxCapacity = parseInt(props.sharableWith.capacity) || 1;
            } else if (props.sharable) {
                maxCapacity = 2;
            }
            
            for (const slotIdx of usage.slots) {
                const bunksAtSlot = usage.details.filter(d => d.slot === slotIdx).length;
                
                if (bunksAtSlot >= maxCapacity) {
                    this.lockField(fieldName, [slotIdx], {
                        lockedBy: 'other_scheduler',
                        division: usage.divisions.join(', '),
                        activity: `In use by: ${usage.bunks.slice(0, 3).join(', ')}${usage.bunks.length > 3 ? '...' : ''}`
                    });
                    lockCount++;
                }
            }
        }
        
        console.log('[GLOBAL_LOCKS] Registered', lockCount, 'field locks from other schedulers');
    };

    // =========================================================================
    // GET OTHER SCHEDULER FIELD USAGE (for UI display)
    // =========================================================================
    
    GlobalFieldLocks.getOtherSchedulerFieldUsage = function() {
        return { ...this._otherSchedulerFieldUsage };
    };

    GlobalFieldLocks.isFieldLockedByOtherScheduler = function(fieldName, slotIdx) {
        const usage = this._otherSchedulerFieldUsage[fieldName];
        if (!usage) return false;
        return usage.slots.includes(slotIdx);
    };

    // =========================================================================
    // RENDER UI PANEL FOR OTHER SCHEDULER LOCKS
    // =========================================================================
    
    GlobalFieldLocks.renderOtherSchedulerPanel = function(containerSelector) {
        const container = typeof containerSelector === 'string' 
            ? document.querySelector(containerSelector)
            : containerSelector;
            
        if (!container) return;
        
        const PANEL_ID = 'other-scheduler-fields-panel';
        const existingPanel = document.getElementById(PANEL_ID);
        if (existingPanel) existingPanel.remove();
        
        const role = window.AccessControl?.getCurrentRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') return;
        
        const fieldCount = Object.keys(this._otherSchedulerFieldUsage).length;
        if (fieldCount === 0) return;
        
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            background: linear-gradient(135deg, #FEF3C7, #FDE68A);
            border: 1px solid #F59E0B;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.15);
        `;
        
        const otherDivisions = this._getOtherDivisions();
        
        panel.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <span style="font-size: 24px;">⚠️</span>
                <div>
                    <div style="font-weight: 600; font-size: 1rem; color: #92400E;">
                        Fields Already Scheduled by Other Schedulers
                    </div>
                    <div style="font-size: 0.85rem; color: #B45309; margin-top: 2px;">
                        ${fieldCount} field${fieldCount !== 1 ? 's' : ''} in use by: ${otherDivisions.join(', ')}
                    </div>
                </div>
                <button id="${PANEL_ID}-toggle" style="
                    margin-left: auto;
                    background: white;
                    border: 1px solid #F59E0B;
                    border-radius: 6px;
                    padding: 6px 12px;
                    cursor: pointer;
                    font-size: 0.85rem;
                    color: #92400E;
                ">Show Details</button>
            </div>
            <div id="${PANEL_ID}-details" style="display: none;">
                ${this._renderOtherSchedulerDetails()}
            </div>
        `;
        
        container.insertBefore(panel, container.firstChild);
        
        const toggleBtn = document.getElementById(`${PANEL_ID}-toggle`);
        const detailsDiv = document.getElementById(`${PANEL_ID}-details`);
        
        if (toggleBtn && detailsDiv) {
            toggleBtn.addEventListener('click', () => {
                const isHidden = detailsDiv.style.display === 'none';
                detailsDiv.style.display = isHidden ? 'block' : 'none';
                toggleBtn.textContent = isHidden ? 'Hide Details' : 'Show Details';
            });
        }
    };

    GlobalFieldLocks._renderOtherSchedulerDetails = function() {
        const fields = Object.entries(this._otherSchedulerFieldUsage);
        
        if (fields.length === 0) {
            return '<p style="color: #92400E; font-size: 0.9rem;">No fields currently in use.</p>';
        }
        
        let html = `
            <div style="
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                gap: 12px;
                margin-top: 12px;
            ">
        `;
        
        for (const [fieldName, usage] of fields) {
            const timeLabels = usage.slotTimes.map(t => t.label).join(', ') || 'Multiple times';
            const divisionList = usage.divisions.join(', ');
            const bunkCount = usage.bunks.length;
            
            html += `
                <div style="
                    background: white;
                    border: 1px solid #FCD34D;
                    border-radius: 8px;
                    padding: 12px;
                ">
                    <div style="font-weight: 600; color: #78350F; margin-bottom: 6px;">
                        🏟️ ${fieldName}
                    </div>
                    <div style="font-size: 0.85rem; color: #92400E;">
                        <div>📅 Times: ${timeLabels}</div>
                        <div>👥 ${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} using</div>
                        <div>🏷️ Division${usage.divisions.length !== 1 ? 's' : ''}: ${divisionList}</div>
                    </div>
                </div>
            `;
        }
        
        html += '</div>';
        
        html += `
            <div style="
                margin-top: 12px;
                padding: 10px;
                background: #FFFBEB;
                border-radius: 6px;
                font-size: 0.85rem;
                color: #78350F;
            ">
                <strong>Note:</strong> These fields are unavailable during the times shown.
                The optimizer will automatically avoid scheduling your bunks on these fields.
            </div>
        `;
        
        return html;
    };

    // =========================================================================
    // MARK LOCKED FIELDS IN RESOURCE OVERRIDES UI
    // =========================================================================
    
    GlobalFieldLocks.markLockedFieldsInUI = function() {
        const fieldsListEl = document.getElementById('override-fields-list');
        if (!fieldsListEl) return;
        
        const role = window.AccessControl?.getCurrentRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') return;
        
        const fieldItems = fieldsListEl.querySelectorAll('.list-item');
        
        fieldItems.forEach(item => {
            const nameEl = item.querySelector('.list-item-name');
            if (!nameEl) return;
            
            const fieldName = nameEl.textContent.trim().split('\n')[0].trim();
            const usage = this._otherSchedulerFieldUsage[fieldName];
            if (!usage || usage.slots.length === 0) return;
            
            const existingBadge = nameEl.querySelector('.other-scheduler-badge');
            if (!existingBadge) {
                const badge = document.createElement('span');
                badge.className = 'other-scheduler-badge';
                badge.style.cssText = `
                    font-size: 0.7rem;
                    padding: 2px 6px;
                    background: #FEF3C7;
                    color: #92400E;
                    border-radius: 4px;
                    border: 1px solid #F59E0B;
                    margin-left: 6px;
                `;
                badge.innerHTML = `🔒 ${usage.divisions.join(', ')}`;
                badge.title = `In use by: ${usage.bunks.slice(0, 5).join(', ')}${usage.bunks.length > 5 ? '...' : ''}`;
                nameEl.appendChild(badge);
            }
            
            item.style.background = 'linear-gradient(90deg, #FEF3C7 0%, transparent 30%)';
        });
    };

    // =========================================================================
    // INITIALIZE FOR DAILY ADJUSTMENTS
    // =========================================================================
    
    GlobalFieldLocks.initializeForDailyAdjustments = async function() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        console.log('[GLOBAL_LOCKS] Initializing for Daily Adjustments, date:', dateKey);
        
        const result = await this.loadOtherSchedulerSchedules(dateKey);
        
        if (result.success) {
            setTimeout(() => {
                const container = document.getElementById('daily-adjustments-content');
                if (container) {
                    this.renderOtherSchedulerPanel(container);
                }
            }, 100);
        }
        
        return result;
    };

    // =========================================================================
    // SETUP TAB LISTENER FOR AUTO-INIT
    // =========================================================================
    
    GlobalFieldLocks._setupDailyAdjustmentsHook = function() {
        const self = this;
        
        // Hook into showTab function
        const originalShowTab = window.showTab;
        if (originalShowTab && !window._globalLocksShowTabHooked) {
            window._globalLocksShowTabHooked = true;
            window.showTab = function(tabId) {
                originalShowTab(tabId);
                
                if (tabId === 'daily-adjustments') {
                    setTimeout(() => {
                        self.initializeForDailyAdjustments();
                    }, 200);
                }
            };
        }
        
        // Listen for date changes
        window.addEventListener('campistry-date-changed', (e) => {
            const newDate = e.detail?.dateKey;
            if (newDate && newDate !== self._otherSchedulerDateKey) {
                self.loadOtherSchedulerSchedules(newDate).then(() => {
                    const container = document.getElementById('daily-adjustments-content');
                    if (container) {
                        self.renderOtherSchedulerPanel(container);
                    }
                });
            }
        });
        
        // Hook into renderResourceOverridesUI
        const checkAndHookRenderUI = () => {
            if (typeof window.renderResourceOverridesUI === 'function' && !window._globalLocksRenderUIHooked) {
                window._globalLocksRenderUIHooked = true;
                const originalRenderResourceOverridesUI = window.renderResourceOverridesUI;
                
                window.renderResourceOverridesUI = function(...args) {
                    originalRenderResourceOverridesUI.apply(this, args);
                    setTimeout(() => {
                        self.markLockedFieldsInUI();
                    }, 50);
                };
                return true;
            }
            return false;
        };
        
        if (!checkAndHookRenderUI()) {
            setTimeout(() => {
                if (!checkAndHookRenderUI()) {
                    setTimeout(checkAndHookRenderUI, 1000);
                }
            }, 500);
        }
    };

    // =========================================================================
    // AUTO-INITIALIZE HOOKS ON LOAD
    // =========================================================================
    
    // Setup hooks when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => GlobalFieldLocks._setupDailyAdjustmentsHook(), 500);
        });
    } else {
        setTimeout(() => GlobalFieldLocks._setupDailyAdjustmentsHook(), 500);
    }

// ============================================================================
// END OF ADDITION TO global_field_locks.js
// ============================================================================
    // =========================================================================
    // EXPORT GLOBALLY
    // =========================================================================
    window.GlobalFieldLocks = GlobalFieldLocks;

    console.log('[GLOBAL_LOCKS] Unified Field Lock System loaded (with Division Lock support)');

})();
