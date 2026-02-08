
// =================================================================
// permissions_guard.js — Campistry Permission Enforcement Layer
// VERSION: v1.0
// =================================================================
//
// ARCHITECTURE:
// - READ ACCESS: Everyone (Owner, Admin, Scheduler) can view ALL data
// - WRITE ACCESS: Schedulers limited to their assigned Division's Grades
// - Owners/Admins have full write access to everything
//
// TERMINOLOGY:
// - Division: A subdivision of the camp (e.g., "Juniors", "Seniors")
// - Grade/Bunk: Individual groups within a division
// - Scheduler: User assigned to specific division(s)
//
// =================================================================
(function() {
    'use strict';

    console.log("🛡️ Permissions Guard v1.0 loading...");

    // =========================================================================
    // PERMISSION CACHE
    // =========================================================================
    
    let _userRole = null;
    let _userDivisions = [];  // Divisions the user is assigned to
    let _userGrades = new Set();  // Grades/Bunks the user can edit
    let _isInitialized = false;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_isInitialized) return;

        console.log("🛡️ Initializing permissions...");

        // Get role from AccessControl
        _userRole = window.AccessControl?.getCurrentRole?.() || 
                    window.getCampistryUserRole?.() || 
                    'viewer';

        // Get user's assigned divisions
        _userDivisions = getUserAssignedDivisions();

        // Build the set of grades this user can edit
        _userGrades = buildEditableGrades(_userDivisions);

        _isInitialized = true;

        console.log("🛡️ Permissions initialized:", {
            role: _userRole,
            divisions: _userDivisions,
            editableGrades: [..._userGrades]
        });

        // Dispatch event for other modules
        window.dispatchEvent(new CustomEvent('campistry-permissions-ready', {
            detail: {
                role: _userRole,
                divisions: _userDivisions,
                editableGrades: [..._userGrades]
            }
        }));
    }

    function getUserAssignedDivisions() {
        // Priority 1: AccessControl
        if (window.AccessControl?.getEditableDivisions) {
            const divs = window.AccessControl.getEditableDivisions();
            if (divs && divs.length > 0) return divs;
        }

        // Priority 2: SubdivisionScheduleManager
        if (window.SubdivisionScheduleManager?.getDivisionsToSchedule) {
            const divs = window.SubdivisionScheduleManager.getDivisionsToSchedule();
            if (divs && divs.length > 0) return divs;
        }

        // Priority 3: Membership data
        if (window._campistryMembership?.assigned_divisions) {
            return window._campistryMembership.assigned_divisions;
        }

        // Priority 4: Subdivision IDs -> Division names
        if (window.AccessControl?.getUserSubdivisionIds) {
            const subIds = window.AccessControl.getUserSubdivisionIds();
            if (subIds && subIds.length > 0) {
                return mapSubdivisionsToDivisions(subIds);
            }
        }

        // Fallback: Owner/Admin gets all divisions
        if (_userRole === 'owner' || _userRole === 'admin') {
            return Object.keys(window.divisions || {});
        }

        return [];
    }

    function mapSubdivisionsToDivisions(subdivisionIds) {
        const divisions = [];
        const allSubdivisions = window.AccessControl?._subdivisions || [];
        
        for (const sub of allSubdivisions) {
            if (subdivisionIds.includes(sub.id) && sub.division_ids) {
                divisions.push(...sub.division_ids);
            }
        }
        
        return [...new Set(divisions)];
    }

    function buildEditableGrades(divisionIds) {
        const grades = new Set();
        const allDivisions = window.divisions || {};

        for (const divId of divisionIds) {
            const divInfo = allDivisions[divId] || allDivisions[String(divId)];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(bunk => grades.add(String(bunk)));
            }
            // Also add the division ID itself as editable (for division-level metadata)
            grades.add(String(divId));
        }

        return grades;
    }

    // =========================================================================
    // PERMISSION CHECKS
    // =========================================================================

    /**
     * Check if user has FULL access (Owner or Admin)
     */
    function hasFullAccess() {
        return _userRole === 'owner' || _userRole === 'admin';
    }

    /**
     * Check if user can READ data (always true - everyone can view everything)
     */
    function canRead(/* gradeOrDivision */) {
        // READ ACCESS: Everyone can view ALL data
        return true;
    }

    /**
     * Check if user can WRITE to a specific grade/bunk
     * @param {string} gradeId - The grade/bunk ID to check
     * @returns {boolean} - True if user can edit this grade
     */
    function canWriteGrade(gradeId) {
        // Owners and Admins can edit everything
        if (hasFullAccess()) return true;

        // Viewers cannot write anything
        if (_userRole === 'viewer') return false;

        // Schedulers can only edit grades in their assigned divisions
        return _userGrades.has(String(gradeId));
    }

    /**
     * Check if user can WRITE to a specific division
     * @param {string} divisionId - The division ID to check
     * @returns {boolean} - True if user can edit this division
     */
    function canWriteDivision(divisionId) {
        // Owners and Admins can edit everything
        if (hasFullAccess()) return true;

        // Viewers cannot write anything
        if (_userRole === 'viewer') return false;

        // Schedulers can only edit their assigned divisions
        return _userDivisions.includes(String(divisionId)) || 
               _userDivisions.includes(divisionId);
    }

    /**
     * Filter an object to only include keys the user can edit
     * @param {Object} data - Object with grade IDs as keys
     * @returns {Object} - Filtered object with only editable grades
     */
    function filterWritableGrades(data) {
        if (hasFullAccess()) return data;

        const filtered = {};
        for (const [key, value] of Object.entries(data)) {
            if (canWriteGrade(key)) {
                filtered[key] = value;
            }
        }
        return filtered;
    }

    /**
     * Validate a write operation and throw if not allowed
     * @param {string} gradeId - The grade being edited
     * @throws {Error} - If write is not allowed
     */
    function assertCanWriteGrade(gradeId) {
        if (!canWriteGrade(gradeId)) {
            const error = new Error(`Permission denied: Cannot edit grade "${gradeId}". You are only assigned to divisions: [${_userDivisions.join(', ')}]`);
            error.code = 'PERMISSION_DENIED';
            error.gradeId = gradeId;
            error.userDivisions = _userDivisions;
            throw error;
        }
    }

    /**
     * Validate a write operation and throw if not allowed
     * @param {string} divisionId - The division being edited
     * @throws {Error} - If write is not allowed
     */
    function assertCanWriteDivision(divisionId) {
        if (!canWriteDivision(divisionId)) {
            const error = new Error(`Permission denied: Cannot edit division "${divisionId}". You are only assigned to: [${_userDivisions.join(', ')}]`);
            error.code = 'PERMISSION_DENIED';
            error.divisionId = divisionId;
            error.userDivisions = _userDivisions;
            throw error;
        }
    }

    // =========================================================================
    // WRITE INTERCEPTION - Wraps save operations to enforce permissions
    // =========================================================================

    /**
     * Intercept and validate schedule assignments before saving
     * @param {Object} scheduleAssignments - The assignments to save
     * @returns {Object} - Filtered assignments (only what user can edit)
     */
    function validateScheduleWrite(scheduleAssignments) {
        if (hasFullAccess()) {
            return { allowed: true, data: scheduleAssignments, blocked: {} };
        }

        const allowed = {};
        const blocked = {};

        for (const [bunkId, schedule] of Object.entries(scheduleAssignments)) {
            if (canWriteGrade(bunkId)) {
                allowed[bunkId] = schedule;
            } else {
                blocked[bunkId] = schedule;
                console.warn(`🛡️ [BLOCKED] Cannot edit bunk "${bunkId}" - not in your divisions`);
            }
        }

        if (Object.keys(blocked).length > 0) {
            console.warn(`🛡️ Write blocked for ${Object.keys(blocked).length} bunks:`, Object.keys(blocked));
        }

        return { 
            allowed: Object.keys(blocked).length === 0, 
            data: allowed, 
            blocked 
        };
    }

    /**
     * Intercept and validate league assignments before saving
     * @param {Object} leagueAssignments - The league data to save
     * @returns {Object} - Filtered assignments
     */
    function validateLeagueWrite(leagueAssignments) {
        if (hasFullAccess()) {
            return { allowed: true, data: leagueAssignments, blocked: {} };
        }

        const allowed = {};
        const blocked = {};

        for (const [divisionId, leagueData] of Object.entries(leagueAssignments)) {
            if (canWriteDivision(divisionId)) {
                allowed[divisionId] = leagueData;
            } else {
                blocked[divisionId] = leagueData;
                console.warn(`🛡️ [BLOCKED] Cannot edit division "${divisionId}" leagues`);
            }
        }

        return { 
            allowed: Object.keys(blocked).length === 0, 
            data: allowed, 
            blocked 
        };
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /**
     * Check if a UI element should be editable
     * @param {string} gradeId - The grade this element represents
     * @returns {boolean}
     */
    function isElementEditable(gradeId) {
        return canWriteGrade(gradeId);
    }

    /**
     * Get CSS class for element based on editability
     * @param {string} gradeId 
     * @returns {string} - CSS class name
     */
    function getEditabilityClass(gradeId) {
        if (canWriteGrade(gradeId)) {
            return 'campistry-editable';
        }
        return 'campistry-readonly';
    }

    /**
     * Show permission denied toast
     * @param {string} context - What action was blocked
     */
    function showPermissionDenied(context) {
        const message = `⛔ Cannot edit ${context} - outside your assigned divisions`;
        
        // Try to use existing toast system
        if (window.showToast) {
            window.showToast(message, 'error');
        } else {
            alert(message);
        }
    }

    // =========================================================================
    // REFRESH PERMISSIONS
    // =========================================================================

    function refresh() {
        _isInitialized = false;
        _userRole = null;
        _userDivisions = [];
        _userGrades = new Set();
        initialize();
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.PermissionsGuard = {
        // Initialization
        initialize,
        refresh,
        
        // Basic checks
        hasFullAccess,
        canRead,
        canWriteGrade,
        canWriteDivision,
        
        // Assertions (throw on failure)
        assertCanWriteGrade,
        assertCanWriteDivision,
        
        // Filtering
        filterWritableGrades,
        validateScheduleWrite,
        validateLeagueWrite,
        
        // UI helpers
        isElementEditable,
        getEditabilityClass,
        showPermissionDenied,
        
        // Getters
        getUserRole: () => _userRole,
        getUserDivisions: () => [..._userDivisions],
        getEditableGrades: () => [..._userGrades],
        isInitialized: () => _isInitialized
    };

    // Auto-initialize when AccessControl is ready
    window.addEventListener('campistry-rbac-ready', () => {
        console.log("🛡️ RBAC ready, initializing permissions...");
        setTimeout(initialize, 100);
    });

    // Also try to initialize on load
    if (document.readyState === 'complete') {
        setTimeout(initialize, 500);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 500));
    }

    // ★★★ v1.1 SECURITY: Freeze to prevent monkey-patching ★★★
    Object.freeze(window.PermissionsGuard);
    try {
        Object.defineProperty(window, 'PermissionsGuard', {
            value: window.PermissionsGuard,
            writable: false,
            configurable: false
        });
    } catch (e) { /* already frozen */ }

    console.log("🛡️ Permissions Guard v1.1 loaded (frozen)");

})();
