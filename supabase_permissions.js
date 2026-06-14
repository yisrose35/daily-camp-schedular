// =============================================================================
// supabase_permissions.js v5.0 — CAMPISTRY PERMISSIONS LAYER
// =============================================================================
//
// RBAC integration layer for schedule operations.
//
// REPLACES: Permission checking scattered across multiple files
//
// PROVIDES:
// - Division/bunk edit permissions
// - Data filtering by user's divisions
// - Integration with AccessControl module
// - Blocked cell detection for UI
//
// REQUIRES: supabase_client.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔐 Campistry Permissions v5.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================

    let _isInitialized = false;
    let _editableDivisions = [];
    let _editableBunks = [];
    let _subdivisions = [];
    let _userSubdivisionIds = [];
    let _directDivisionAssignments = [];

    const DEBUG = false;

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (DEBUG) {
            console.log('🔐 [Permissions]', ...args);
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) return;

        // Wait for CampistryDB to be ready
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // Load subdivisions and calculate permissions
        await loadSubdivisions();
        await calculateEditableResources();

        _isInitialized = true;
        log('Initialized');

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('campistry-permissions-ready'));
    }

    // =========================================================================
    // LOAD SUBDIVISIONS
    // =========================================================================

    async function loadSubdivisions() {
        const campId = window.CampistryDB?.getCampId?.();
        if (!campId) {
            log('No camp ID, cannot load subdivisions');
            return;
        }

        const client = window.CampistryDB?.getClient?.();
        if (!client) {
            log('No Supabase client');
            return;
        }

        try {
            const { data, error } = await client
                .from('subdivisions')
                .select('*')
                .eq('camp_id', campId)
                .order('name');

            if (error) {
                console.warn('🔐 Error loading subdivisions:', error);
                _subdivisions = [];
                return;
            }

            _subdivisions = data || [];
            log('Loaded subdivisions:', _subdivisions.length);
        } catch (e) {
            console.warn('🔐 Exception loading subdivisions:', e);
            _subdivisions = [];
        }

        // Get user's subdivision assignments from membership
        const membership = window._campistryMembership;
        if (membership) {
            _userSubdivisionIds = membership.subdivision_ids || [];
            _directDivisionAssignments = membership.assigned_divisions || [];
        }
    }

    // =========================================================================
    // CALCULATE EDITABLE RESOURCES
    // =========================================================================

    async function calculateEditableResources() {
        // Delegate to AccessControl as the single source of truth for division assignments.
        // PermissionsDB's job here is solely to derive the bunk list from those divisions.
        if (window.AccessControl?.getEditableDivisions) {
            _editableDivisions = window.AccessControl.getEditableDivisions();
            _editableBunks = window.AccessControl.canEditAnything?.()
                ? getAllBunkIds()
                : getBunksForDivisions(_editableDivisions);
            log('Permissions synced from AccessControl:', {
                divisions: _editableDivisions.length,
                bunks: _editableBunks.length
            });
            return;
        }

        // Fallback when AccessControl is not yet loaded (early init race)
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        log('Fallback permission calc for role:', role);

        if (role === 'owner' || role === 'admin') {
            _editableDivisions = getAllDivisionNames();
            _editableBunks = getAllBunkIds();
            return;
        }

        if (role === 'viewer') {
            _editableDivisions = [];
            _editableBunks = [];
            return;
        }

        // Scheduler fallback — subdivisions loaded by loadSubdivisions()
        _editableDivisions = [];
        if (_userSubdivisionIds.length > 0) {
            _userSubdivisionIds.forEach(subId => {
                const subdivision = _subdivisions.find(s => s.id === subId);
                if (subdivision?.divisions) _editableDivisions.push(...subdivision.divisions);
            });
        }
        if (_directDivisionAssignments.length > 0) {
            _editableDivisions.push(..._directDivisionAssignments);
        }
        _editableDivisions = [...new Set(_editableDivisions)];
        _editableBunks = getBunksForDivisions(_editableDivisions);

        if (role === 'scheduler' && _editableDivisions.length === 0) {
            console.warn('🔐 ⚠️ SCHEDULER HAS NO DIVISION ASSIGNMENTS!');
        }
    }

    // =========================================================================
    // HELPER: GET ALL DIVISIONS
    // =========================================================================

    function getAllDivisionNames() {
        // Try window.divisions first
        if (window.divisions && typeof window.divisions === 'object') {
            return Object.keys(window.divisions);
        }

        // Try GlobalAuthority
        if (window.GlobalAuthority?.getRegistry) {
            const registry = window.GlobalAuthority.getRegistry();
            if (registry?.divisions) {
                return Object.keys(registry.divisions);
            }
        }

        return [];
    }

    // =========================================================================
    // HELPER: GET ALL BUNKS
    // =========================================================================

    function getAllBunkIds() {
        // window.bunks is an array of bunk NAME STRINGS in this app;
        // legacy object form ({id,name}) is still handled.
        const bunks = window.bunks || window.globalBunks || [];
        return bunks
            .map(b => typeof b === 'string' ? b : String(b.id || b.name))
            .filter(b => b && b !== 'undefined');
    }

    // =========================================================================
    // HELPER: GET BUNKS FOR DIVISIONS
    // =========================================================================

    function getBunksForDivisions(divisionNames) {
        const divisionSet = new Set(divisionNames.map(String));

        // Primary: the division registry — bunk membership lives at
        // divisions[name].bunks (array of bunk-name strings).
        const divs = window.divisions || {};
        const fromRegistry = [];
        Object.entries(divs).forEach(([name, info]) => {
            if (!divisionSet.has(String(name))) return;
            (info?.bunks || []).forEach(b => {
                const v = typeof b === 'string' ? b : String(b.id || b.name);
                if (v && v !== 'undefined') fromRegistry.push(v);
            });
        });
        if (fromRegistry.length > 0) return fromRegistry;

        // Legacy fallback: object-shaped window.bunks with division refs.
        const bunks = window.bunks || window.globalBunks || [];
        return bunks
            .filter(bunk => {
                if (typeof bunk === 'string') return false;
                const divId = String(bunk.divisionId || bunk.division);
                const divName = getDivisionName(divId);
                return divisionSet.has(divName) || divisionSet.has(divId);
            })
            .map(b => String(b.id || b.name))
            .filter(b => b && b !== 'undefined');
    }

    function getDivisionName(divisionId) {
        const divisions = window.divisions || {};
        // If divisionId is already a name, return it
        if (divisions[divisionId]) return divisionId;
        
        // Otherwise look up by ID
        for (const [name, div] of Object.entries(divisions)) {
            if (String(div.id) === String(divisionId)) return name;
        }
        return divisionId;
    }

    // =========================================================================
    // PUBLIC API: PERMISSION CHECKS
    // =========================================================================

    function canEditDivision(divisionName) {
        if (window.AccessControl?.canEditDivision) return window.AccessControl.canEditDivision(divisionName);
        // Fallback
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') return true;
        if (role === 'viewer') return false;
        return _editableDivisions.includes(String(divisionName));
    }

    function canEditBunk(bunkId) {
        const role = window.CampistryDB?.getRole?.() || 'viewer';

        // ★ CB-136: v3.13 — schedulers have full edit access (matches AccessControl.canEditBunk).
        // This duplicate had diverged: it still scoped schedulers to _editableBunks, so a scheduler
        // editing a bunk outside their assignment got `false` here vs `true` from AccessControl.
        // Owners/admins/schedulers all bypass; only viewers are blocked.
        if (role === 'owner' || role === 'admin' || role === 'scheduler') return true;

        // Viewers can't edit
        if (role === 'viewer') return false;

        // Any other role - check specific permissions
        return _editableBunks.includes(String(bunkId));
    }

    function getEditableDivisions() {
        if (window.AccessControl?.getEditableDivisions) return window.AccessControl.getEditableDivisions();
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') return getAllDivisionNames();
        return [..._editableDivisions];
    }

    function getEditableBunks() {
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        if (role === 'owner' || role === 'admin') {
            return getAllBunkIds();
        }
        return [..._editableBunks];
    }

    function isReadOnly() {
        if (window.AccessControl?.canSave) return !window.AccessControl.canSave();
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        return role === 'viewer';
    }

    function hasFullAccess() {
        if (window.AccessControl?.canEditAnything) return window.AccessControl.canEditAnything();
        const role = window.CampistryDB?.getRole?.() || 'viewer';
        return role === 'owner' || role === 'admin';
    }

    // =========================================================================
    // DATA FILTERING
    // =========================================================================

    /**
     * Filter schedule data to only include bunks this user can edit.
     * Used before saving to prevent overwriting other schedulers' work.
     *
     * ★★★ CB-131 — DEAD CODE (advertised but never wired). This + PermissionsGuard's
     * validateScheduleWrite/validateLeagueWrite/assertCanWriteGrade are documented as the
     * bunk-level write guard, but a repo-wide grep shows NO save path calls them (only
     * rbac_diagnostics self-tests). The safety net is currently provided instead by
     * scheduler_id row scoping + the v3.13 "scheduler = full edit by design" model. DO NOT
     * assume this filter runs — if you relax row scoping or merge schedulers' rows, wire this
     * (or an equivalent) into the save path FIRST. Left in place (not removed) for that future use.
     */
    function filterToMyDivisions(scheduleAssignments) {
        if (hasFullAccess()) {
            return scheduleAssignments;
        }

        const filtered = {};
        const myBunks = new Set(getEditableBunks());

        Object.entries(scheduleAssignments || {}).forEach(([bunkId, slots]) => {
            if (myBunks.has(String(bunkId))) {
                filtered[bunkId] = slots;
            }
        });

        log('Filtered to my divisions:', Object.keys(filtered).length, 'of', Object.keys(scheduleAssignments || {}).length);
        return filtered;
    }

    /**
     * Mark which bunks in a merged schedule are blocked (owned by other schedulers).
     * Returns a Map<bunkId, { schedulerName, schedulerId }>
     */
    function getBlockedBunks(mergedRecords) {
        if (hasFullAccess()) {
            return new Map();
        }

        const blocked = new Map();
        const myBunks = new Set(getEditableBunks());
        const myUserId = window.CampistryDB?.getUserId?.();

        mergedRecords.forEach(record => {
            // Skip my own records
            if (record.scheduler_id === myUserId) return;

            const assignments = record.schedule_data?.scheduleAssignments || {};
            Object.keys(assignments).forEach(bunkId => {
                if (!myBunks.has(String(bunkId))) {
                    blocked.set(bunkId, {
                        schedulerName: record.scheduler_name || 'Another Scheduler',
                        schedulerId: record.scheduler_id
                    });
                }
            });
        });

        return blocked;
    }

    /**
     * Get blocked slots for UI rendering.
     * Returns Map<slotIndex, Set<bunkId>>
     */
    function getBlockedSlots(mergedRecords) {
        if (hasFullAccess()) {
            return new Map();
        }

        const blocked = new Map();
        const myBunks = new Set(getEditableBunks());
        const myUserId = window.CampistryDB?.getUserId?.();

        mergedRecords.forEach(record => {
            if (record.scheduler_id === myUserId) return;

            const assignments = record.schedule_data?.scheduleAssignments || {};
            Object.entries(assignments).forEach(([bunkId, slots]) => {
                if (myBunks.has(String(bunkId))) return;

                Object.keys(slots || {}).forEach(slotIdx => {
                    if (!blocked.has(slotIdx)) {
                        blocked.set(slotIdx, new Set());
                    }
                    blocked.get(slotIdx).add(bunkId);
                });
            });
        });

        return blocked;
    }

    // =========================================================================
    // REFRESH
    // =========================================================================

    async function refresh() {
        log('Refreshing permissions...');
        // Re-sync bunk list from AccessControl's current division assignments
        await calculateEditableResources();
        return {
            divisions: _editableDivisions,
            bunks: _editableBunks
        };
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.PermissionsDB = {
        initialize,
        refresh,
        
        // Permission checks
        canEditDivision,
        canEditBunk,
        getEditableDivisions,
        getEditableBunks,
        isReadOnly,
        hasFullAccess,
        
        // Data filtering
        filterToMyDivisions,
        getBlockedBunks,
        getBlockedSlots,
        
        // State
        get isInitialized() { return _isInitialized; }
    };

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    // Wait for CampistryDB to be ready
    if (window.CampistryDB?.ready) {
        window.CampistryDB.ready.then(() => {
            setTimeout(initialize, 50);
        });
    } else {
        // Fallback: wait for event
        window.addEventListener('campistry-db-ready', () => {
            setTimeout(initialize, 50);
        });
    }

})();
