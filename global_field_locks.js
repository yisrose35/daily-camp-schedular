// ============================================================================
// global_field_locks.js - UNIFIED FIELD LOCK SYSTEM v2.0
// ============================================================================
// UPDATED: Now supports loading locks from CLOUD to enable multi-scheduler
// coordination. Each scheduler can see what fields are taken by others.
//
// WORKFLOW:
// 1. Scheduler B calls GlobalFieldLocks.loadFromCloud()
// 2. This loads all field usage from cloud (other schedulers' work)
// 3. Scheduler B's generator checks locks before assigning fields
// 4. No complex merging needed - just respect the locks!
// ============================================================================

(function() {
    'use strict';

    // =========================================================================
    // GLOBAL LOCK REGISTRY
    // =========================================================================
    
    const GlobalFieldLocks = {
        _locks: {},
        _initialized: false,
        _cloudLocksLoaded: false
    };

    // =========================================================================
    // INITIALIZATION - Call at start of each schedule generation
    // =========================================================================
    GlobalFieldLocks.reset = function() {
        this._locks = {};
        this._initialized = true;
        this._cloudLocksLoaded = false;
        console.log('[GLOBAL_LOCKS] Field lock registry RESET');
    };

    // =========================================================================
    // ★★★ NEW: LOAD LOCKS FROM CLOUD ★★★
    // This is the KEY function for multi-scheduler support
    // =========================================================================
    /**
     * Load field locks from cloud data (other schedulers' work)
     * Call this BEFORE generation to know what fields are already taken
     * 
     * @param {string[]} [excludeDivisions] - Divisions to SKIP (your own divisions)
     * @returns {Promise<{success: boolean, locksLoaded: number}>}
     */
    GlobalFieldLocks.loadFromCloud = async function(excludeDivisions = []) {
        console.log('[GLOBAL_LOCKS] ☁️ Loading field locks from cloud...');
        
        if (!this._initialized) this.reset();
        
        try {
            // 1. Get current date
            const today = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            
            // 2. Load cloud state
            let cloudSchedules = {};
            
            if (window.supabase && window.getCampId) {
                const campId = window.getCampId();
                if (campId && campId !== 'demo_camp_001') {
                    const { data, error } = await window.supabase
                        .from('camp_state')
                        .select('state')
                        .eq('camp_id', campId)
                        .single();
                    
                    if (data && data.state) {
                        cloudSchedules = data.state.daily_schedules || {};
                    }
                    if (error) {
                        console.warn('[GLOBAL_LOCKS] Cloud load error:', error);
                    }
                }
            }
            
            // 3. Get today's schedule data
            const todayData = cloudSchedules[today];
            if (!todayData) {
                console.log('[GLOBAL_LOCKS] No cloud data for today - no locks to import');
                this._cloudLocksLoaded = true;
                return { success: true, locksLoaded: 0 };
            }
            
            // Handle both formats: {scheduleAssignments: {...}} or direct {...}
            const assignments = todayData.scheduleAssignments || todayData;
            
            // 4. Build set of bunks to EXCLUDE (my divisions' bunks)
            const excludeBunks = new Set();
            const divisions = window.divisions || {};
            
            for (const divName of excludeDivisions) {
                const divInfo = divisions[divName] || divisions[String(divName)];
                if (divInfo && divInfo.bunks) {
                    divInfo.bunks.forEach(b => excludeBunks.add(String(b)));
                }
            }
            
            console.log(`[GLOBAL_LOCKS] Excluding bunks from divisions [${excludeDivisions.join(', ')}]: ${excludeBunks.size} bunks`);
            
            // 5. Register locks from OTHER schedulers' bunks
            let locksLoaded = 0;
            
            for (const [bunkName, slots] of Object.entries(assignments)) {
                // Skip my own bunks
                if (excludeBunks.has(String(bunkName))) {
                    continue;
                }
                
                // Process each slot
                if (Array.isArray(slots)) {
                    slots.forEach((slot, slotIdx) => {
                        if (slot && slot.field && slot.field !== 'Free' && slot.field !== '') {
                            // Skip continuation slots (already counted in primary)
                            if (slot.continuation) return;
                            
                            // Calculate how many slots this activity spans
                            const slotsUsed = [slotIdx];
                            for (let i = slotIdx + 1; i < slots.length; i++) {
                                if (slots[i] && slots[i].continuation) {
                                    slotsUsed.push(i);
                                } else {
                                    break;
                                }
                            }
                            
                            // Register the lock
                            this.lockField(slot.field, slotsUsed, {
                                lockedBy: 'cloud_scheduler',
                                bunk: bunkName,
                                activity: slot._activity || slot.field,
                                source: 'cloud'
                            });
                            
                            locksLoaded++;
                        }
                    });
                }
            }
            
            // 6. Also load league assignments if they exist
            const leagueAssignments = todayData.leagueAssignments || {};
            for (const [divName, divLeagues] of Object.entries(leagueAssignments)) {
                // Skip my divisions
                if (excludeDivisions.includes(divName)) continue;
                
                for (const [slotIdx, leagueData] of Object.entries(divLeagues)) {
                    if (leagueData && leagueData.matchups) {
                        leagueData.matchups.forEach(matchup => {
                            if (matchup.field) {
                                // League games typically span multiple slots
                                const slots = leagueData.slots || [parseInt(slotIdx)];
                                this.lockField(matchup.field, slots, {
                                    lockedBy: 'league',
                                    leagueName: leagueData.leagueName || 'League',
                                    division: divName,
                                    activity: matchup.sport,
                                    source: 'cloud'
                                });
                                locksLoaded++;
                            }
                        });
                    }
                }
            }
            
            this._cloudLocksLoaded = true;
            console.log(`[GLOBAL_LOCKS] ✅ Loaded ${locksLoaded} field locks from cloud`);
            
            return { success: true, locksLoaded };
            
        } catch (e) {
            console.error('[GLOBAL_LOCKS] Error loading from cloud:', e);
            return { success: false, locksLoaded: 0, error: e.message };
        }
    };

    // =========================================================================
    // CHECK IF CLOUD LOCKS ARE LOADED
    // =========================================================================
    GlobalFieldLocks.areCloudLocksLoaded = function() {
        return this._cloudLocksLoaded;
    };

    // =========================================================================
    // LOCK A FIELD (Global) - Makes field completely unavailable at given slots
    // =========================================================================
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
                // Don't warn for duplicate cloud locks
                if (existing.source !== 'cloud' || lockInfo.source !== 'cloud') {
                    // console.warn(`[GLOBAL_LOCKS] ⚠️ CONFLICT: "${fieldName}" at slot ${slotIdx} already locked`);
                }
                return false;
            }
            
            // Apply global lock
            this._locks[slotIdx][normalizedField] = {
                ...lockInfo,
                lockType: 'global',
                fieldName: fieldName,
                timestamp: Date.now()
            };
        }
        
        return true;
    };

    // =========================================================================
    // LOCK FIELD FOR SPECIFIC DIVISION (Elective)
    // =========================================================================
    GlobalFieldLocks.lockFieldForDivision = function(fieldName, slots, allowedDivision, reason) {
        if (!this._initialized) this.reset();
        if (!fieldName || !slots || slots.length === 0 || !allowedDivision) return false;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (!this._locks[slotIdx]) {
                this._locks[slotIdx] = {};
            }
            
            if (this._locks[slotIdx][normalizedField]) {
                const existing = this._locks[slotIdx][normalizedField];
                if (existing.lockType === 'global') {
                    return false;
                }
            }
            
            this._locks[slotIdx][normalizedField] = {
                lockedBy: 'elective',
                lockType: 'division',
                allowedDivision: allowedDivision,
                reason: reason || `Elective for ${allowedDivision}`,
                fieldName: fieldName,
                timestamp: Date.now()
            };
        }
        
        return true;
    };

    // =========================================================================
    // CHECK IF FIELD IS LOCKED
    // =========================================================================
    GlobalFieldLocks.isFieldLocked = function(fieldName, slots, divisionContext) {
        if (!this._initialized) return null;
        if (!fieldName || !slots || slots.length === 0) return null;
        
        const normalizedField = fieldName.toLowerCase().trim();
        
        for (const slotIdx of slots) {
            if (this._locks[slotIdx] && this._locks[slotIdx][normalizedField]) {
                const lock = this._locks[slotIdx][normalizedField];
                
                if (lock.lockType === 'division' && lock.allowedDivision) {
                    if (divisionContext && divisionContext === lock.allowedDivision) {
                        continue;
                    }
                }
                
                return lock;
            }
        }
        
        return null;
    };

    // =========================================================================
    // CHECK IF FIELD IS AVAILABLE
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
            if (lock.lockType === 'division' && lock.allowedDivision === divisionContext) {
                continue;
            }
            locked.push(lock.fieldName);
        }
        return locked;
    };

    // =========================================================================
    // GET AVAILABLE FIELDS FROM A LIST
    // =========================================================================
    GlobalFieldLocks.filterAvailableFields = function(fieldNames, slots, divisionContext) {
        if (!fieldNames || fieldNames.length === 0) return [];
        return fieldNames.filter(fieldName => this.isFieldAvailable(fieldName, slots, divisionContext));
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
        
        let cloudLocks = 0;
        let localLocks = 0;
        
        for (const slotIdx of slotIndices) {
            const slotLocks = this._locks[slotIdx];
            const fields = Object.keys(slotLocks);
            
            if (fields.length > 0) {
                console.log(`\nSlot ${slotIdx}:`);
                fields.forEach(field => {
                    const lock = slotLocks[field];
                    const source = lock.source === 'cloud' ? '☁️' : '📍';
                    if (lock.source === 'cloud') cloudLocks++;
                    else localLocks++;
                    
                    if (lock.lockType === 'division') {
                        console.log(`  ${source} 🎯 ${lock.fieldName}: DIVISION - ${lock.reason} (allowed: ${lock.allowedDivision})`);
                    } else {
                        console.log(`  ${source} 🔒 ${lock.fieldName}: ${lock.lockedBy} - ${lock.bunk || lock.leagueName || lock.activity}`);
                    }
                });
            }
        }
        
        console.log(`\n📊 Summary: ${cloudLocks} cloud locks, ${localLocks} local locks`);
        console.log('=========================\n');
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
    // UNLOCK A FIELD
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
    // GET LOCK SUMMARY
    // =========================================================================
    GlobalFieldLocks.getLockSummary = function() {
        const summary = {
            totalLocks: 0,
            cloudLocks: 0,
            localLocks: 0,
            globalLocks: [],
            divisionLocks: []
        };
        
        for (const [slotIdx, slotLocks] of Object.entries(this._locks)) {
            for (const [fieldKey, lock] of Object.entries(slotLocks)) {
                summary.totalLocks++;
                if (lock.source === 'cloud') summary.cloudLocks++;
                else summary.localLocks++;
                
                const entry = {
                    field: lock.fieldName,
                    slot: parseInt(slotIdx),
                    source: lock.source || 'local',
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

    console.log('[GLOBAL_LOCKS] Unified Field Lock System v2.0 loaded (with Cloud support)');

})();
