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
    //   lockedBy: 'specialty_league' | 'regular_league' | 'pinned' | 'elective',
    //   lockType: 'global' | 'division',  // NEW for electives
    //   allowedDivision: string | null,   // NEW for electives
    //   leagueName: string,
    //   division: string,
    //   activity: string,
    //   timestamp: number
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
                console.warn(`[GLOBAL_LOCKS] ⚠️ CONFLICT: "${fieldName}" at slot ${slotIdx} already locked by ${existing.lockedBy} (${existing.leagueName || existing.activity || existing.reason})`);
                return false;
            }
            
            // Apply global lock
            this._locks[slotIdx][normalizedField] = {
                ...lockInfo,
                lockType: 'global',  // Explicitly mark as global
                fieldName: fieldName, // Store original case
                timestamp: Date.now()
            };
            
            console.log(`[GLOBAL_LOCKS] 🔒 LOCKED: "${fieldName}" at slot ${slotIdx} by ${lockInfo.lockedBy} (${lockInfo.leagueName || lockInfo.activity})`);
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
                    console.warn(`[GLOBAL_LOCKS] ⚠️ Cannot add division lock for "${fieldName}" at slot ${slotIdx} - already GLOBALLY locked by ${existing.lockedBy}`);
                    return false;
                }
                // If it's another division lock, warn but allow override
                console.warn(`[GLOBAL_LOCKS] ⚠️ Overwriting division lock for "${fieldName}" at slot ${slotIdx}`);
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
            
            console.log(`[GLOBAL_LOCKS] 🎯 DIVISION LOCK: "${fieldName}" at slot ${slotIdx} - reserved for ${allowedDivision}`);
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
     *                                     if this matches allowedDivision, field is NOT locked.
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

    // =========================================================================
    // EXPORT GLOBALLY
    // =========================================================================
    window.GlobalFieldLocks = GlobalFieldLocks;

    console.log('[GLOBAL_LOCKS] Unified Field Lock System loaded (with Division Lock support)');

})();
