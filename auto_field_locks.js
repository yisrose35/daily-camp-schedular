// =============================================================================
// auto_field_locks.js — TIME-BASED FIELD LOCK SYSTEM FOR AUTO BUILDER
// =============================================================================
// Designed for auto mode where every bunk has a unique slot structure.
// Slot indices are meaningless across bunks — all tracking is by time range.
//
// DIFFERENCES FROM GlobalFieldLocks (manual mode):
//   Manual: slot-index-based, one slot structure per division
//   Auto:   time-range-based, per-bunk slot structures
//
// COEXISTENCE:
//   - Manual mode uses window.GlobalFieldLocks (unchanged)
//   - Auto mode uses window.AutoFieldLocks (this file)
//   - scheduler_core_auto.js detects mode and uses the right one
//   - Both expose compatible query APIs so downstream code works
//
// LOCK TYPES:
//   1. EXCLUSIVE — field completely unavailable at time range (leagues, pinned)
//   2. CAPACITY  — field has N slots; each claim consumes one
//   3. DIVISION  — field available only to one division at time range
//
// =============================================================================

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const TAG = '[AutoFieldLocks]';

    // =========================================================================
    // INTERNAL STATE
    // =========================================================================

    // Claims: array of { field, startMin, endMin, bunk, grade, activity, lockType, capacity }
    let _claims = [];
    let _initialized = false;

    // Cache: field properties (capacity, sharing type)
    const _fieldProps = new Map();

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function reset() {
        _claims = [];
        _fieldProps.clear();
        _initialized = true;
        console.log(TAG + ' Field lock registry RESET');
    }

    function buildFieldPropertyCache() {
        _fieldProps.clear();
        const ap = window.activityProperties || {};
        Object.entries(ap).forEach(([name, props]) => {
            if (!props) return;
            const shareInfo = props.sharableWith || {};
            _fieldProps.set(name.toLowerCase().trim(), {
                name: name,
                capacity: parseInt(shareInfo.capacity) || parseInt(props.capacity) || (shareInfo.type === 'not_sharable' ? 1 : 2),
                shareType: shareInfo.type || 'same_division',
                allowedDivisions: shareInfo.divisions || [],
                isIndoor: !!props.isIndoor,
                isField: props.type === 'field' || !!props.isField
            });
        });
    }

    function getFieldProps(fieldName) {
        if (!fieldName) return null;
        const key = fieldName.toLowerCase().trim();
        if (_fieldProps.has(key)) return _fieldProps.get(key);
        // Fallback: build from live activityProperties
        const ap = window.activityProperties || {};
        const props = ap[fieldName];
        if (!props) return { name: fieldName, capacity: 2, shareType: 'same_division', allowedDivisions: [], isIndoor: false, isField: false };
        const shareInfo = props.sharableWith || {};
        const result = {
            name: fieldName,
            capacity: parseInt(shareInfo.capacity) || parseInt(props.capacity) || (shareInfo.type === 'not_sharable' ? 1 : 2),
            shareType: shareInfo.type || 'same_division',
            allowedDivisions: shareInfo.divisions || [],
            isIndoor: !!props.isIndoor,
            isField: props.type === 'field' || !!props.isField
        };
        _fieldProps.set(key, result);
        return result;
    }


    // =========================================================================
    // CLAIM / LOCK A FIELD
    // =========================================================================

    /**
     * Register a field claim at a specific time range.
     * @param {string} fieldName
     * @param {number} startMin - Start time in minutes from midnight
     * @param {number} endMin   - End time in minutes from midnight
     * @param {string} bunk     - Bunk name
     * @param {string} grade    - Grade/division name
     * @param {string} activity - Activity name
     * @param {object} [opts]   - Optional: { lockType: 'exclusive'|'capacity'|'division', lockedBy: string }
     * @returns {boolean} true if claim was accepted
     */
    function claimField(fieldName, startMin, endMin, bunk, grade, activity, opts) {
        if (!_initialized) reset();
        if (!fieldName || startMin == null || endMin == null || endMin <= startMin) return false;
        opts = opts || {};

        const lockType = opts.lockType || 'capacity';

        // For capacity claims, check availability first
        if (lockType === 'capacity' || lockType === 'division') {
            if (!isFieldAvailable(fieldName, startMin, endMin, bunk, grade)) return false;
        }

        _claims.push({
            field: fieldName,
            fieldNorm: fieldName.toLowerCase().trim(),
            startMin, endMin, bunk, grade, activity,
            lockType,
            lockedBy: opts.lockedBy || 'auto_scheduler',
            timestamp: Date.now()
        });

        // Combined field mutual exclusion
        if (window.FieldCombos?.isInCombo?.(fieldName)) {
            const exclusive = window.FieldCombos.getExclusiveFields(fieldName);
            for (const partner of exclusive) {
                _claims.push({
                    field: partner,
                    fieldNorm: partner.toLowerCase().trim(),
                    startMin, endMin, bunk: '_combo_lock', grade, activity,
                    lockType: 'exclusive',
                    lockedBy: 'combined_field',
                    timestamp: Date.now()
                });
            }
        }

        return true;
    }

    /**
     * Shorthand: lock a field exclusively (no one else can use it)
     */
    function lockField(fieldName, startMin, endMin, grade, activity, lockedBy) {
        return claimField(fieldName, startMin, endMin, '_lock', grade, activity, {
            lockType: 'exclusive', lockedBy: lockedBy || 'auto_lock'
        });
    }

    /**
     * Compatibility wrapper: lockField with slot indices (bridges to manual-mode callers)
     * Converts slot indices to time ranges using per-bunk slots.
     */
    function lockFieldBySlots(fieldName, slotIndices, lockInfo) {
        if (!_initialized) reset();
        if (!fieldName || !slotIndices || slotIndices.length === 0) return false;

        const grade = lockInfo?.division || '';
        const activity = lockInfo?.activity || lockInfo?.leagueName || '';
        const lockedBy = lockInfo?.lockedBy || 'auto_lock';

        // Try to resolve time from divisionTimes
        let startMin = null, endMin = null;
        if (grade && window.divisionTimes?.[grade]) {
            const dt = window.divisionTimes[grade];
            // Check per-bunk slots first (auto mode), then division-level
            const firstSlotIdx = slotIndices[0];
            const lastSlotIdx = slotIndices[slotIndices.length - 1];

            // Try any bunk's per-bunk slots
            if (dt._perBunkSlots) {
                const anyBunkSlots = Object.values(dt._perBunkSlots)[0];
                if (anyBunkSlots) {
                    const first = anyBunkSlots[firstSlotIdx];
                    const last = anyBunkSlots[lastSlotIdx];
                    if (first) startMin = first.startMin;
                    if (last) endMin = last.endMin;
                }
            }
            // Fallback: division-level slots
            if (startMin == null && Array.isArray(dt)) {
                const first = dt[firstSlotIdx];
                const last = dt[lastSlotIdx];
                if (first) startMin = first.startMin;
                if (last) endMin = last.endMin;
            }
        }

        if (startMin == null || endMin == null) {
            // Can't resolve times — store as slot-based fallback for manual-mode compat
            // This shouldn't happen in auto mode, but defensive coding
            console.warn(TAG + ' Cannot resolve time for slots ' + slotIndices.join(',') + ' in ' + grade);
            return false;
        }

        return claimField(fieldName, startMin, endMin, '_lock', grade, activity, {
            lockType: lockInfo?.lockType === 'division' ? 'division' : 'exclusive',
            lockedBy
        });
    }


    // =========================================================================
    // UNCLAIM / UNLOCK
    // =========================================================================

    function unclaimField(fieldName, bunk, startMin) {
        const norm = fieldName.toLowerCase().trim();
        _claims = _claims.filter(c =>
            !(c.fieldNorm === norm && c.bunk === bunk && c.startMin === startMin)
        );
    }

    function unclaimAllForBunk(bunk) {
        _claims = _claims.filter(c => c.bunk !== bunk);
    }

    function unlockField(fieldName, startMin, endMin) {
        const norm = fieldName.toLowerCase().trim();
        _claims = _claims.filter(c => {
            if (c.fieldNorm !== norm) return true;
            if (c.lockType !== 'exclusive') return true;
            // Remove if overlapping
            return !(c.startMin < endMin && c.endMin > startMin);
        });
    }


    // =========================================================================
    // AVAILABILITY QUERIES
    // =========================================================================

    /**
     * Get all claims overlapping a time range for a field.
     */
    function getOverlappingClaims(fieldName, startMin, endMin, excludeBunk) {
        const norm = fieldName.toLowerCase().trim();
        return _claims.filter(c =>
            c.fieldNorm === norm &&
            c.startMin < endMin && c.endMin > startMin &&
            c.bunk !== excludeBunk
        );
    }

    /**
     * Check if a field is available for a bunk at a given time range.
     * Enforces: capacity, sharing type (cross-division rules), exclusive locks.
     */
    function isFieldAvailable(fieldName, startMin, endMin, bunk, grade) {
        if (!fieldName || startMin == null || endMin == null) return false;
        const fp = getFieldProps(fieldName);
        const overlapping = getOverlappingClaims(fieldName, startMin, endMin, bunk);

        // Exclusive locks block everyone
        if (overlapping.some(c => c.lockType === 'exclusive')) return false;

        // Capacity check
        if (overlapping.length >= fp.capacity) return false;

        // Sharing rules
        if (fp.shareType === 'not_sharable' && overlapping.length > 0) return false;

        if (fp.shareType === 'same_division') {
            if (overlapping.some(c => c.grade !== grade)) return false;
        }

        if (fp.shareType === 'custom') {
            const allowed = fp.allowedDivisions || [];
            if (overlapping.some(c => c.grade !== grade && !allowed.includes(c.grade))) return false;
            if (overlapping.length > 0 && !allowed.includes(grade)) return false;
        }

        // Rainy day: no outdoor fields
        if (window.isRainyDay && !fp.isIndoor && fp.isField) return false;

        return true;
    }

    /**
     * Check if field is locked by time (compatibility with GlobalFieldLocks.isFieldLockedByTime)
     * Returns lock info object or null.
     */
    function isFieldLockedByTime(fieldName, startMin, endMin, divisionContext) {
        if (!fieldName || startMin == null || endMin == null) return null;
        const overlapping = getOverlappingClaims(fieldName, startMin, endMin, null);

        for (const claim of overlapping) {
            if (claim.lockType === 'exclusive') {
                // Division locks: skip if caller IS the allowed division
                if (claim.lockType === 'division' && claim.grade === divisionContext) continue;
                return {
                    lockedBy: claim.lockedBy,
                    lockType: claim.lockType,
                    fieldName: claim.field,
                    division: claim.grade,
                    activity: claim.activity,
                    startMin: claim.startMin,
                    endMin: claim.endMin,
                    reason: claim.field + ' locked by ' + claim.lockedBy + ' (' + claim.activity + ')'
                };
            }
        }

        // Combined field check
        if (window.FieldCombos?.isBlockedByCombo) {
            const comboCheck = window.FieldCombos.isBlockedByCombo(fieldName, startMin, endMin, null);
            if (comboCheck.blocked) {
                return {
                    lockedBy: 'combined_field', lockType: 'exclusive', fieldName,
                    blockedBy: comboCheck.blocker,
                    reason: fieldName + ' blocked by combo partner ' + comboCheck.blocker
                };
            }
        }

        return null;
    }

    /**
     * Compatibility: isFieldLocked by slot indices
     */
    function isFieldLocked(fieldName, slotIndices, divisionContext) {
        // Convert slots to time — use any available per-bunk slot data
        if (!slotIndices || slotIndices.length === 0) return null;
        if (!divisionContext) return null;
        const dt = window.divisionTimes?.[divisionContext];
        if (!dt) return null;

        let startMin = null, endMin = null;
        if (dt._perBunkSlots) {
            const anyBunkSlots = Object.values(dt._perBunkSlots)[0];
            if (anyBunkSlots?.[slotIndices[0]]) {
                startMin = anyBunkSlots[slotIndices[0]].startMin;
                endMin = anyBunkSlots[slotIndices[slotIndices.length - 1]]?.endMin;
            }
        } else if (Array.isArray(dt)) {
            if (dt[slotIndices[0]]) {
                startMin = dt[slotIndices[0]].startMin;
                endMin = dt[slotIndices[slotIndices.length - 1]]?.endMin;
            }
        }
        if (startMin == null || endMin == null) return null;
        return isFieldLockedByTime(fieldName, startMin, endMin, divisionContext);
    }

    function isFieldAvailableByTime(fieldName, startMin, endMin, divisionContext) {
        return isFieldLockedByTime(fieldName, startMin, endMin, divisionContext) === null;
    }


    // =========================================================================
    // USAGE QUERIES (for solver integration)
    // =========================================================================

    /**
     * Count how many claims a field has in a time range (for capacity checks).
     * Optionally filter by division.
     */
    function getFieldUsageCount(fieldName, startMin, endMin, excludeBunk) {
        return getOverlappingClaims(fieldName, startMin, endMin, excludeBunk).length;
    }

    /**
     * Count same-division usage (for same_division sharing enforcement).
     */
    function getSameDivisionUsage(fieldName, grade, startMin, endMin, excludeBunk) {
        return getOverlappingClaims(fieldName, startMin, endMin, excludeBunk)
            .filter(c => c.grade === grade).length;
    }

    /**
     * Check if any other division is using this field at this time.
     */
    function hasCrossDivisionConflict(fieldName, grade, startMin, endMin, excludeBunk) {
        return getOverlappingClaims(fieldName, startMin, endMin, excludeBunk)
            .some(c => c.grade !== grade && c.lockType !== 'exclusive');
    }

    /**
     * Get all fields locked at a specific time (for UI display).
     */
    function getLockedFieldsAtTime(startMin, endMin, divisionContext) {
        const locked = new Set();
        _claims.forEach(c => {
            if (c.startMin >= endMin || c.endMin <= startMin) return;
            if (c.lockType === 'exclusive') {
                if (c.lockType === 'division' && c.grade === divisionContext) return;
                locked.add(c.field);
            }
        });
        return [...locked];
    }


    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    function getLockSummary() {
        const exclusive = _claims.filter(c => c.lockType === 'exclusive');
        const capacity = _claims.filter(c => c.lockType === 'capacity');
        return {
            totalClaims: _claims.length,
            exclusiveLocks: exclusive.length,
            capacityClaims: capacity.length,
            byField: (() => {
                const map = {};
                _claims.forEach(c => {
                    if (!map[c.field]) map[c.field] = 0;
                    map[c.field]++;
                });
                return map;
            })()
        };
    }

    function debugPrintLocks() {
        console.log('\n%c═══ AUTO FIELD LOCKS ═══', 'color:#6A1B9A;font-weight:bold');
        if (_claims.length === 0) {
            console.log('  No claims registered.');
            return;
        }
        console.log('  Total claims: ' + _claims.length);

        // Group by field
        const byField = {};
        _claims.forEach(c => {
            if (!byField[c.field]) byField[c.field] = [];
            byField[c.field].push(c);
        });
        Object.entries(byField).sort((a, b) => a[0].localeCompare(b[0])).forEach(([field, claims]) => {
            console.log('\n  ' + field + ' (' + claims.length + ' claims):');
            claims.sort((a, b) => a.startMin - b.startMin).forEach(c => {
                const timeStr = _minutesToLabel(c.startMin) + '-' + _minutesToLabel(c.endMin);
                console.log('    ' + timeStr + ' | ' + c.bunk + ' (' + c.grade + ') | ' + c.activity + ' [' + c.lockType + ']');
            });
        });
    }

    function _minutesToLabel(min) {
        if (min == null) return '?';
        let h = Math.floor(min / 60), m = min % 60;
        const ap = h >= 12 ? 'pm' : 'am';
        h = h % 12 || 12;
        return h + ':' + String(m).padStart(2, '0') + ap;
    }


    // =========================================================================
    // SYNC BRIDGE: Copy exclusive locks into GlobalFieldLocks
    // =========================================================================
    // Call after generation so downstream code (fillers, canBlockFit,
    // post-edit, unified_schedule_system) sees all auto-mode locks.

    function syncToGlobalFieldLocks() {
        if (!window.GlobalFieldLocks) {
            console.warn(TAG + ' GlobalFieldLocks not available — skipping sync');
            return 0;
        }
        const dt = window.divisionTimes || {};
        let synced = 0;

        _claims.filter(c => c.lockType === 'exclusive').forEach(claim => {
            // Resolve time range to slot indices for GlobalFieldLocks
            const grade = claim.grade;
            if (!grade || !dt[grade]) return;

            const pbs = dt[grade]._perBunkSlots;
            // Find ANY bunk's slot that overlaps this lock's time range
            const slotsToLock = [];
            if (pbs) {
                const anyBunk = Object.values(pbs)[0] || [];
                anyBunk.forEach((slot, idx) => {
                    if (slot.startMin < claim.endMin && slot.endMin > claim.startMin) {
                        slotsToLock.push(idx);
                    }
                });
            } else if (Array.isArray(dt[grade])) {
                dt[grade].forEach((slot, idx) => {
                    if (slot.startMin < claim.endMin && slot.endMin > claim.startMin) {
                        slotsToLock.push(idx);
                    }
                });
            }

            if (slotsToLock.length > 0) {
                window.GlobalFieldLocks.lockField(claim.field, slotsToLock, {
                    lockedBy: claim.lockedBy || 'auto_lock',
                    division: claim.grade,
                    activity: claim.activity,
                    startMin: claim.startMin,
                    endMin: claim.endMin
                });
                synced++;
            }
        });

        if (synced > 0) console.log(TAG + ' Synced ' + synced + ' exclusive locks → GlobalFieldLocks');
        return synced;
    }


    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.AutoFieldLocks = {
        version: VERSION,
        reset,
        buildFieldPropertyCache,

        // ── Time-based API (primary for auto mode) ────────────────────
        claimField,                    // (fieldName, startMin, endMin, bunk, grade, activity, opts)
        lockField,                     // (fieldName, startMin, endMin, grade, activity, lockedBy)
        unclaimField,
        unclaimAllForBunk,
        unlockField,

        // ── Time-based queries ────────────────────────────────────────
        isFieldAvailableByTime: isFieldAvailable,  // (fieldName, startMin, endMin, bunk, grade)
        isFieldLockedByTime,           // (fieldName, startMin, endMin, divisionContext)
        isFieldAvailableByTimeInverse: isFieldAvailableByTime,
        getFieldUsageCount,
        getSameDivisionUsage,
        hasCrossDivisionConflict,
        getOverlappingClaims,
        getLockedFieldsAtTime,

        // ── Slot-based compatibility bridge (for downstream code) ─────
        lockFieldBySlots,              // (fieldName, slotIndices, lockInfo)
        lockFieldForDivision: function(fieldName, slots, allowedDivision, reason) {
            return lockFieldBySlots(fieldName, slots, {
                lockType: 'division', division: allowedDivision,
                lockedBy: 'elective', activity: reason
            });
        },
        isFieldLocked,                 // (fieldName, slotIndices, divisionContext) → lock|null
        isFieldAvailable: function(fieldName, slots, divisionContext) {
            return isFieldLocked(fieldName, slots, divisionContext) === null;
        },
        getLockedFieldsAtSlot: function(slotIdx, divisionContext) {
            if (!divisionContext) return [];
            const dt = window.divisionTimes?.[divisionContext];
            if (!dt) return [];
            const slots = dt._perBunkSlots ? Object.values(dt._perBunkSlots)[0] : (Array.isArray(dt) ? dt : []);
            const slot = slots?.[slotIdx];
            if (!slot) return [];
            return getLockedFieldsAtTime(slot.startMin, slot.endMin, divisionContext);
        },

        // ── Sync bridge ───────────────────────────────────────────────
        syncToGlobalFieldLocks,

        // ── Diagnostics ───────────────────────────────────────────────
        getLockSummary,
        debugPrintLocks,

        // Direct access
        get _claims() { return _claims; },
        get _initialized() { return _initialized; }
    };

    console.log(TAG + ' v' + VERSION + ' loaded — time-based field locks for auto builder');
})();
