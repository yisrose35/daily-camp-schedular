// =================================================================
// schedule_versioning.js — Campistry Schedule Versioning System
// VERSION: v1.0
// =================================================================
//
// PURPOSE:
// When creating "Schedule 2" based on "Schedule 1":
// - PRESERVE: Schedule 1 remains UNTOUCHED in the database
// - INHERIT: Schedule 2 is a NEW entry (new ID) with deep copy of Schedule 1
//
// ARCHITECTURE:
// - Each schedule version has a unique ID
// - Versions are linked via `based_on` reference
// - Original schedules are NEVER modified by "Base On" operations
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Versioning v1.0 loading...");

    const DAILY_DATA_KEY = "campDailyData_v1";
    const VERSIONS_KEY = "campistry_schedule_versions";

    // =========================================================================
    // VERSION METADATA STRUCTURE
    // =========================================================================
    // {
    //   versions: {
    //     "2026-01-11": {
    //       "v1": { id: "v1", name: "Morning Schedule", created_at: "...", based_on: null },
    //       "v2": { id: "v2", name: "Afternoon Revision", created_at: "...", based_on: "v1" }
    //     }
    //   },
    //   activeVersion: {
    //     "2026-01-11": "v2"
    //   }
    // }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function generateVersionId() {
        return 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        return JSON.parse(JSON.stringify(obj));
    }

    function loadVersionMetadata() {
        try {
            const raw = localStorage.getItem(VERSIONS_KEY);
            return raw ? JSON.parse(raw) : { versions: {}, activeVersion: {} };
        } catch (e) {
            console.error("📋 Error loading version metadata:", e);
            return { versions: {}, activeVersion: {} };
        }
    }

    function saveVersionMetadata(metadata) {
        try {
            localStorage.setItem(VERSIONS_KEY, JSON.stringify(metadata));
        } catch (e) {
            console.error("📋 Error saving version metadata:", e);
        }
    }

    function loadDailyData() {
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveDailyData(data) {
        try {
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(data));
        } catch (e) {
            console.error("📋 Error saving daily data:", e);
        }
    }

    // =========================================================================
    // CORE VERSIONING FUNCTIONS
    // =========================================================================

    /**
     * Get all versions for a specific date
     * @param {string} dateKey - The date (YYYY-MM-DD)
     * @returns {Array} - Array of version objects sorted by creation time
     */
    function getVersionsForDate(dateKey) {
        const metadata = loadVersionMetadata();
        const dateVersions = metadata.versions[dateKey] || {};
        
        return Object.values(dateVersions).sort((a, b) => 
            new Date(a.created_at) - new Date(b.created_at)
        );
    }

    /**
     * Get the currently active version for a date
     * @param {string} dateKey 
     * @returns {string|null} - Version ID or null
     */
    function getActiveVersion(dateKey) {
        const metadata = loadVersionMetadata();
        return metadata.activeVersion[dateKey] || null;
    }

    /**
     * Set the active version for a date
     * @param {string} dateKey 
     * @param {string} versionId 
     */
    function setActiveVersion(dateKey, versionId) {
        const metadata = loadVersionMetadata();
        metadata.activeVersion[dateKey] = versionId;
        saveVersionMetadata(metadata);
        
        console.log(`📋 Active version set: ${dateKey} -> ${versionId}`);
        
        // Dispatch event for UI to refresh
        window.dispatchEvent(new CustomEvent('campistry-version-changed', {
            detail: { dateKey, versionId }
        }));
    }

    /**
     * Get schedule data for a specific version
     * @param {string} dateKey 
     * @param {string} versionId 
     * @returns {Object|null} - The schedule data or null
     */
    function getVersionData(dateKey, versionId) {
        const dailyData = loadDailyData();
        const versionKey = `${dateKey}__${versionId}`;
        
        // Check for versioned data first
        if (dailyData[versionKey]) {
            return dailyData[versionKey];
        }
        
        // Fallback to unversioned data (legacy support)
        if (versionId === 'v1' || versionId === 'default') {
            return dailyData[dateKey] || null;
        }
        
        return null;
    }

    /**
     * Save schedule data to a specific version
     * @param {string} dateKey 
     * @param {string} versionId 
     * @param {Object} data 
     */
    function saveVersionData(dateKey, versionId, data) {
        const dailyData = loadDailyData();
        const versionKey = `${dateKey}__${versionId}`;
        
        dailyData[versionKey] = data;
        
        // Also update the main date key if this is the active version
        const activeVersion = getActiveVersion(dateKey);
        if (versionId === activeVersion || !activeVersion) {
            dailyData[dateKey] = data;
        }
        
        saveDailyData(dailyData);
        
        console.log(`📋 Version data saved: ${versionKey}`);
    }

    // =========================================================================
    // ★★★ CREATE NEW VERSION (THE "BASE ON" FEATURE) ★★★
    // =========================================================================

    /**
     * Create a new schedule version based on an existing one
     * 
     * CRITICAL: This does NOT modify the source version!
     * It creates a DEEP COPY as a new version entry.
     * 
     * @param {string} dateKey - The date for this schedule
     * @param {string} name - Human-readable name for the new version
     * @param {string|null} basedOnVersionId - Source version to copy (null = empty)
     * @returns {Object} - { success, versionId, error }
     */
    function createVersion(dateKey, name, basedOnVersionId = null) {
        console.log(`📋 Creating new version for ${dateKey}, based on: ${basedOnVersionId || 'empty'}`);
        
        try {
            const metadata = loadVersionMetadata();
            const newVersionId = generateVersionId();
            
            // Initialize versions for this date if needed
            if (!metadata.versions[dateKey]) {
                metadata.versions[dateKey] = {};
            }
            
            // ★★★ DEEP CLONE THE SOURCE DATA ★★★
            let newVersionData = {
                scheduleAssignments: {},
                leagueAssignments: {},
                unifiedTimes: {},
                skeleton: null,
                manualSkeleton: null,
                subdivisionSchedules: {}
            };
            
            if (basedOnVersionId) {
                const sourceData = getVersionData(dateKey, basedOnVersionId);
                if (sourceData) {
                    // CRITICAL: Deep clone to ensure complete separation
                    newVersionData = deepClone(sourceData);
                    console.log(`📋 ✅ Cloned data from ${basedOnVersionId}:`, {
                        bunks: Object.keys(newVersionData.scheduleAssignments || {}).length,
                        timeSlots: Object.keys(newVersionData.unifiedTimes || {}).length
                    });
                } else {
                    console.warn(`📋 ⚠️ Source version ${basedOnVersionId} not found, creating empty`);
                }
            }
            
            // Create version metadata
            const versionMeta = {
                id: newVersionId,
                name: name || `Version ${Object.keys(metadata.versions[dateKey]).length + 1}`,
                created_at: new Date().toISOString(),
                created_by: window.AccessControl?.getCurrentUserName?.() || 'Unknown',
                based_on: basedOnVersionId,
                is_locked: false
            };
            
            // Save version metadata
            metadata.versions[dateKey][newVersionId] = versionMeta;
            saveVersionMetadata(metadata);
            
            // Save version data (the deep cloned schedule)
            saveVersionData(dateKey, newVersionId, newVersionData);
            
            console.log(`📋 ✅ Created version: ${newVersionId} "${name}"`);
            
            // Dispatch event
            window.dispatchEvent(new CustomEvent('campistry-version-created', {
                detail: { 
                    dateKey, 
                    versionId: newVersionId, 
                    basedOn: basedOnVersionId,
                    name 
                }
            }));
            
            return { 
                success: true, 
                versionId: newVersionId, 
                metadata: versionMeta 
            };
            
        } catch (e) {
            console.error("📋 Error creating version:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Create the first version for a date (if none exists)
     * @param {string} dateKey 
     * @returns {string} - The version ID
     */
    function ensureDefaultVersion(dateKey) {
        const metadata = loadVersionMetadata();
        
        if (!metadata.versions[dateKey] || Object.keys(metadata.versions[dateKey]).length === 0) {
            // Create default version from existing data
            const dailyData = loadDailyData();
            const existingData = dailyData[dateKey];
            
            const defaultVersion = {
                id: 'v1',
                name: 'Original Schedule',
                created_at: new Date().toISOString(),
                created_by: 'System',
                based_on: null,
                is_locked: false
            };
            
            if (!metadata.versions[dateKey]) {
                metadata.versions[dateKey] = {};
            }
            metadata.versions[dateKey]['v1'] = defaultVersion;
            metadata.activeVersion[dateKey] = 'v1';
            
            saveVersionMetadata(metadata);
            
            // If there's existing data, save it as v1
            if (existingData) {
                saveVersionData(dateKey, 'v1', existingData);
            }
            
            console.log(`📋 Created default version v1 for ${dateKey}`);
            return 'v1';
        }
        
        return getActiveVersion(dateKey) || Object.keys(metadata.versions[dateKey])[0];
    }

    // =========================================================================
    // VERSION MANAGEMENT
    // =========================================================================

    /**
     * Rename a version
     * @param {string} dateKey 
     * @param {string} versionId 
     * @param {string} newName 
     */
    function renameVersion(dateKey, versionId, newName) {
        const metadata = loadVersionMetadata();
        
        if (metadata.versions[dateKey]?.[versionId]) {
            metadata.versions[dateKey][versionId].name = newName;
            metadata.versions[dateKey][versionId].updated_at = new Date().toISOString();
            saveVersionMetadata(metadata);
            console.log(`📋 Renamed version ${versionId} to "${newName}"`);
        }
    }

    /**
     * Lock a version (prevent further edits)
     * @param {string} dateKey 
     * @param {string} versionId 
     */
    function lockVersion(dateKey, versionId) {
        const metadata = loadVersionMetadata();
        
        if (metadata.versions[dateKey]?.[versionId]) {
            metadata.versions[dateKey][versionId].is_locked = true;
            metadata.versions[dateKey][versionId].locked_at = new Date().toISOString();
            metadata.versions[dateKey][versionId].locked_by = 
                window.AccessControl?.getCurrentUserName?.() || 'Unknown';
            saveVersionMetadata(metadata);
            console.log(`📋 Locked version ${versionId}`);
        }
    }

    /**
     * Unlock a version
     * @param {string} dateKey 
     * @param {string} versionId 
     */
    function unlockVersion(dateKey, versionId) {
        const metadata = loadVersionMetadata();
        
        if (metadata.versions[dateKey]?.[versionId]) {
            metadata.versions[dateKey][versionId].is_locked = false;
            delete metadata.versions[dateKey][versionId].locked_at;
            delete metadata.versions[dateKey][versionId].locked_by;
            saveVersionMetadata(metadata);
            console.log(`📋 Unlocked version ${versionId}`);
        }
    }

    /**
     * Check if a version is locked
     * @param {string} dateKey 
     * @param {string} versionId 
     * @returns {boolean}
     */
    function isVersionLocked(dateKey, versionId) {
        const metadata = loadVersionMetadata();
        return metadata.versions[dateKey]?.[versionId]?.is_locked === true;
    }

    /**
     * Delete a version (only if not active and not locked)
     * @param {string} dateKey 
     * @param {string} versionId 
     * @returns {Object} - { success, error }
     */
    function deleteVersion(dateKey, versionId) {
        const metadata = loadVersionMetadata();
        
        // Cannot delete active version
        if (metadata.activeVersion[dateKey] === versionId) {
            return { success: false, error: 'Cannot delete active version' };
        }
        
        // Cannot delete locked version
        if (metadata.versions[dateKey]?.[versionId]?.is_locked) {
            return { success: false, error: 'Cannot delete locked version' };
        }
        
        // Cannot delete if other versions are based on this one
        const dependents = Object.values(metadata.versions[dateKey] || {})
            .filter(v => v.based_on === versionId);
        if (dependents.length > 0) {
            return { 
                success: false, 
                error: `Cannot delete: ${dependents.length} version(s) are based on this` 
            };
        }
        
        // Delete metadata
        delete metadata.versions[dateKey][versionId];
        saveVersionMetadata(metadata);
        
        // Delete data
        const dailyData = loadDailyData();
        const versionKey = `${dateKey}__${versionId}`;
        delete dailyData[versionKey];
        saveDailyData(dailyData);
        
        console.log(`📋 Deleted version ${versionId}`);
        return { success: true };
    }

    // =========================================================================
    // CLOUD SYNC INTEGRATION
    // =========================================================================

    /**
     * Prepare versioned data for cloud sync
     * @returns {Object} - Data structure ready for cloud storage
     */
    function prepareForCloudSync() {
        const dailyData = loadDailyData();
        const metadata = loadVersionMetadata();
        
        return {
            daily_schedules: dailyData,
            schedule_versions: metadata
        };
    }

    /**
     * Load versioned data from cloud
     * @param {Object} cloudData - Data from cloud storage
     */
    function loadFromCloudSync(cloudData) {
        if (cloudData.daily_schedules) {
            saveDailyData(cloudData.daily_schedules);
        }
        if (cloudData.schedule_versions) {
            saveVersionMetadata(cloudData.schedule_versions);
        }
        console.log("📋 Loaded version data from cloud");
    }

    // =========================================================================
    // COMPARISON TOOLS
    // =========================================================================

    /**
     * Compare two versions and return differences
     * @param {string} dateKey 
     * @param {string} versionA 
     * @param {string} versionB 
     * @returns {Object} - Diff object
     */
    function compareVersions(dateKey, versionA, versionB) {
        const dataA = getVersionData(dateKey, versionA) || {};
        const dataB = getVersionData(dateKey, versionB) || {};
        
        const assignmentsA = dataA.scheduleAssignments || {};
        const assignmentsB = dataB.scheduleAssignments || {};
        
        const allBunks = new Set([
            ...Object.keys(assignmentsA),
            ...Object.keys(assignmentsB)
        ]);
        
        const diff = {
            added: [],      // In B but not A
            removed: [],    // In A but not B
            modified: [],   // Different between A and B
            unchanged: []   // Same in both
        };
        
        for (const bunk of allBunks) {
            const inA = bunk in assignmentsA;
            const inB = bunk in assignmentsB;
            
            if (!inA && inB) {
                diff.added.push(bunk);
            } else if (inA && !inB) {
                diff.removed.push(bunk);
            } else if (JSON.stringify(assignmentsA[bunk]) !== JSON.stringify(assignmentsB[bunk])) {
                diff.modified.push(bunk);
            } else {
                diff.unchanged.push(bunk);
            }
        }
        
        return diff;
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersioning = {
        // Version queries
        getVersionsForDate,
        getActiveVersion,
        getVersionData,
        
        // Version creation
        createVersion,
        ensureDefaultVersion,
        
        // Version management
        setActiveVersion,
        saveVersionData,
        renameVersion,
        lockVersion,
        unlockVersion,
        isVersionLocked,
        deleteVersion,
        
        // Cloud sync
        prepareForCloudSync,
        loadFromCloudSync,
        
        // Comparison
        compareVersions,
        
        // Utilities
        deepClone
    };

    console.log("📋 Schedule Versioning v1.0 loaded");

})();
