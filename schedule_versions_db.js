// =================================================================
// schedule_versions_db.js — Database-Backed Schedule Versioning
// VERSION: v1.0
// =================================================================
//
// CRITICAL FIX: This module ensures Schedule 1 persists when
// Schedule 2 is created by using INSERT (new row) instead of
// UPDATE (overwrite).
//
// DATABASE SCHEMA REQUIRED:
// CREATE TABLE schedule_versions (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   camp_id UUID NOT NULL REFERENCES camps(owner),
//   date DATE NOT NULL,
//   name TEXT NOT NULL,
//   based_on UUID REFERENCES schedule_versions(id),
//   schedule_data JSONB NOT NULL,
//   is_active BOOLEAN DEFAULT true,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   created_by UUID,
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
// CREATE INDEX idx_schedule_versions_camp_date ON schedule_versions(camp_id, date);
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Versions DB v1.0 loading...");

    const SUPABASE_URL = "https://bzqmhcumuarrbueqttfh.supabase.co";
    const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cW1oY3VtdWFycmJ1ZXF0dGZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NDg3NDAsImV4cCI6MjA4MjEyNDc0MH0.5WpFBj1s1937XNZ0yxLdlBWO7xolPtf7oB10LDLONsI";
    const VERSIONS_TABLE = "schedule_versions";

    // =========================================================================
    // HELPERS
    // =========================================================================

    async function getSessionToken() {
        try {
            const { data } = await window.supabase.auth.getSession();
            return data.session?.access_token || null;
        } catch (e) { return null; }
    }

    function getCampId() {
        return window.getCampId?.() || localStorage.getItem('campistry_user_id') || 'demo_camp_001';
    }

    function deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        return JSON.parse(JSON.stringify(obj));
    }

    // =========================================================================
    // DATABASE OPERATIONS
    // =========================================================================

    /**
     * List all schedule versions for a specific date
     * @param {string} dateKey - The date (YYYY-MM-DD)
     * @returns {Array} - Array of version objects
     */
    async function listVersions(dateKey) {
        try {
            const token = await getSessionToken();
            if (!token) return [];

            const campId = getCampId();
            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?camp_id=eq.${campId}&date=eq.${dateKey}&order=created_at.asc`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error("📋 [DB] Failed to list versions:", response.status);
                return [];
            }

            const versions = await response.json();
            console.log(`📋 [DB] Found ${versions.length} versions for ${dateKey}`);
            return versions;

        } catch (e) {
            console.error("📋 [DB] Error listing versions:", e);
            return [];
        }
    }

    /**
     * Get a specific version by ID
     * @param {string} versionId - The version UUID
     * @returns {Object|null} - The version object or null
     */
    async function getVersion(versionId) {
        try {
            const token = await getSessionToken();
            if (!token) return null;

            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?id=eq.${versionId}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) return null;

            const data = await response.json();
            return data.length > 0 ? data[0] : null;

        } catch (e) {
            console.error("📋 [DB] Error getting version:", e);
            return null;
        }
    }

    /**
     * Get the currently active version for a date
     * @param {string} dateKey - The date
     * @returns {Object|null} - The active version or null
     */
    async function getActiveVersion(dateKey) {
        try {
            const token = await getSessionToken();
            if (!token) return null;

            const campId = getCampId();
            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?camp_id=eq.${campId}&date=eq.${dateKey}&is_active=eq.true&limit=1`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) return null;

            const data = await response.json();
            return data.length > 0 ? data[0] : null;

        } catch (e) {
            console.error("📋 [DB] Error getting active version:", e);
            return null;
        }
    }

    // =========================================================================
    // ★★★ CREATE NEW VERSION - ALWAYS INSERT, NEVER UPDATE SOURCE ★★★
    // =========================================================================

    /**
     * Create a new schedule version
     * 
     * CRITICAL: This function ALWAYS uses INSERT to create a NEW row.
     * It NEVER modifies the source version.
     * 
     * @param {string} dateKey - The date for this schedule
     * @param {string} name - Human-readable name
     * @param {Object} scheduleData - The schedule data to save
     * @param {string|null} basedOnId - UUID of source version (null = fresh)
     * @returns {Object} - { success, version, error }
     */
    async function createVersion(dateKey, name, scheduleData, basedOnId = null) {
        console.log(`📋 [DB] Creating NEW version for ${dateKey}`);
        console.log(`📋 [DB]   Name: "${name}"`);
        console.log(`📋 [DB]   Based on: ${basedOnId || 'none (fresh)'}`);

        try {
            const token = await getSessionToken();
            if (!token) {
                return { success: false, error: 'Not authenticated' };
            }

            const campId = getCampId();
            const user = await window.supabase.auth.getUser();
            const userId = user?.data?.user?.id;

            // ★★★ CRITICAL: Create payload WITHOUT an ID ★★★
            // This forces Supabase to INSERT a new row with auto-generated UUID
            const payload = {
                // NO 'id' field - Supabase will generate one
                camp_id: campId,
                date: dateKey,
                name: name,
                based_on: basedOnId,  // Reference to source (doesn't modify source)
                schedule_data: deepClone(scheduleData),  // Deep clone for safety
                is_active: false,  // New versions start inactive
                created_by: userId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            console.log(`📋 [DB] INSERT payload (no ID = new row):`, {
                camp_id: payload.camp_id,
                date: payload.date,
                name: payload.name,
                based_on: payload.based_on,
                is_active: payload.is_active,
                data_bunks: Object.keys(payload.schedule_data?.scheduleAssignments || {}).length
            });

            // ★★★ USE POST (INSERT), NOT PATCH (UPDATE) ★★★
            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}`;
            
            const response = await fetch(url, {
                method: 'POST',  // ← INSERT, creates new row
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("📋 [DB] INSERT failed:", response.status, errorText);
                return { success: false, error: `Database error: ${response.status}` };
            }

            const newVersions = await response.json();
            const newVersion = newVersions[0];

            console.log(`📋 [DB] ✅ Created NEW version with ID: ${newVersion.id}`);
            console.log(`📋 [DB] ✅ Source version ${basedOnId} is UNCHANGED`);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('campistry-version-created', {
                detail: {
                    dateKey,
                    versionId: newVersion.id,
                    basedOn: basedOnId,
                    name
                }
            }));

            return { success: true, version: newVersion };

        } catch (e) {
            console.error("📋 [DB] Error creating version:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Create a version based on an existing one (the "Base On" feature)
     * 
     * CRITICAL: This CLONES the source, it does NOT modify it.
     * 
     * @param {string} sourceVersionId - UUID of version to copy
     * @param {string} newName - Name for the new version
     * @returns {Object} - { success, version, error }
     */
    async function createBasedOn(sourceVersionId, newName) {
        console.log(`📋 [DB] ═══════════════════════════════════════════`);
        console.log(`📋 [DB] "BASE ON" OPERATION`);
        console.log(`📋 [DB] Source ID: ${sourceVersionId}`);
        console.log(`📋 [DB] New Name: "${newName}"`);
        console.log(`📋 [DB] ═══════════════════════════════════════════`);

        // Step 1: Load the source version (READ ONLY)
        const sourceVersion = await getVersion(sourceVersionId);
        
        if (!sourceVersion) {
            console.error(`📋 [DB] ❌ Source version ${sourceVersionId} not found`);
            return { success: false, error: 'Source version not found' };
        }

        console.log(`📋 [DB] ✅ Loaded source: "${sourceVersion.name}"`);
        console.log(`📋 [DB]    Date: ${sourceVersion.date}`);
        console.log(`📋 [DB]    Bunks: ${Object.keys(sourceVersion.schedule_data?.scheduleAssignments || {}).length}`);

        // Step 2: Deep clone the schedule data
        const clonedData = deepClone(sourceVersion.schedule_data);
        
        // Add metadata about the clone
        clonedData._clonedFrom = {
            sourceId: sourceVersionId,
            sourceName: sourceVersion.name,
            clonedAt: new Date().toISOString()
        };

        // Step 3: CREATE a NEW version (INSERT, not UPDATE)
        const result = await createVersion(
            sourceVersion.date,
            newName,
            clonedData,
            sourceVersionId  // Link to source for history
        );

        if (result.success) {
            console.log(`📋 [DB] ═══════════════════════════════════════════`);
            console.log(`📋 [DB] ✅ "BASE ON" COMPLETE`);
            console.log(`📋 [DB] Source "${sourceVersion.name}" (${sourceVersionId}) → UNCHANGED`);
            console.log(`📋 [DB] New "${newName}" (${result.version.id}) → CREATED`);
            console.log(`📋 [DB] ═══════════════════════════════════════════`);
        }

        return result;
    }

    // =========================================================================
    // UPDATE VERSION (for editing an existing version)
    // =========================================================================

    /**
     * Update an existing version's schedule data
     * This DOES modify the specified version (use for saving edits)
     * 
     * @param {string} versionId - UUID of version to update
     * @param {Object} scheduleData - New schedule data
     * @returns {Object} - { success, error }
     */
    async function updateVersion(versionId, scheduleData) {
        console.log(`📋 [DB] Updating version ${versionId}...`);

        try {
            const token = await getSessionToken();
            if (!token) {
                return { success: false, error: 'Not authenticated' };
            }

            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?id=eq.${versionId}`;
            
            const response = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    schedule_data: scheduleData,
                    updated_at: new Date().toISOString()
                })
            });

            if (!response.ok) {
                console.error("📋 [DB] Update failed:", response.status);
                return { success: false, error: `Update failed: ${response.status}` };
            }

            console.log(`📋 [DB] ✅ Updated version ${versionId}`);
            return { success: true };

        } catch (e) {
            console.error("📋 [DB] Error updating version:", e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // SET ACTIVE VERSION
    // =========================================================================

    /**
     * Set a version as the active one for its date
     * (Deactivates other versions for the same date)
     * 
     * @param {string} versionId - UUID of version to activate
     * @returns {Object} - { success, error }
     */
    async function setActiveVersion(versionId) {
        console.log(`📋 [DB] Setting active version: ${versionId}`);

        try {
            const token = await getSessionToken();
            if (!token) {
                return { success: false, error: 'Not authenticated' };
            }

            // Get the version to find its date
            const version = await getVersion(versionId);
            if (!version) {
                return { success: false, error: 'Version not found' };
            }

            const campId = getCampId();

            // Step 1: Deactivate all versions for this date
            const deactivateUrl = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?camp_id=eq.${campId}&date=eq.${version.date}`;
            
            await fetch(deactivateUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ is_active: false })
            });

            // Step 2: Activate the specified version
            const activateUrl = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?id=eq.${versionId}`;
            
            const response = await fetch(activateUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ is_active: true })
            });

            if (!response.ok) {
                return { success: false, error: 'Failed to activate version' };
            }

            console.log(`📋 [DB] ✅ Version ${versionId} is now active`);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('campistry-version-activated', {
                detail: { versionId, dateKey: version.date }
            }));

            return { success: true };

        } catch (e) {
            console.error("📋 [DB] Error setting active version:", e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // DELETE VERSION
    // =========================================================================

    /**
     * Delete a version (soft delete by marking inactive, or hard delete)
     * 
     * @param {string} versionId - UUID of version to delete
     * @param {boolean} hardDelete - If true, permanently removes the row
     * @returns {Object} - { success, error }
     */
    async function deleteVersion(versionId, hardDelete = false) {
        console.log(`📋 [DB] Deleting version ${versionId} (hard=${hardDelete})`);

        try {
            const token = await getSessionToken();
            if (!token) {
                return { success: false, error: 'Not authenticated' };
            }

            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?id=eq.${versionId}`;

            if (hardDelete) {
                // Permanent deletion
                const response = await fetch(url, {
                    method: 'DELETE',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (!response.ok) {
                    return { success: false, error: 'Delete failed' };
                }
            } else {
                // Soft delete (just mark inactive)
                const response = await fetch(url, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        is_active: false,
                        deleted_at: new Date().toISOString()
                    })
                });

                if (!response.ok) {
                    return { success: false, error: 'Soft delete failed' };
                }
            }

            console.log(`📋 [DB] ✅ Version ${versionId} deleted`);
            return { success: true };

        } catch (e) {
            console.error("📋 [DB] Error deleting version:", e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // RENAME VERSION
    // =========================================================================

    async function renameVersion(versionId, newName) {
        try {
            const token = await getSessionToken();
            if (!token) {
                return { success: false, error: 'Not authenticated' };
            }

            const url = `${SUPABASE_URL}/rest/v1/${VERSIONS_TABLE}?id=eq.${versionId}`;
            
            const response = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: newName,
                    updated_at: new Date().toISOString()
                })
            });

            if (!response.ok) {
                return { success: false, error: 'Rename failed' };
            }

            console.log(`📋 [DB] ✅ Renamed version ${versionId} to "${newName}"`);
            return { success: true };

        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // MIGRATION: Import from old system
    // =========================================================================

    /**
     * Migrate existing schedule data to the new versioning system
     * Creates "Version 1" for each date that has schedule data
     */
    async function migrateFromLegacy() {
        console.log("📋 [DB] Starting legacy migration...");

        try {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            const dates = Object.keys(dailyData).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));

            console.log(`📋 [DB] Found ${dates.length} dates to migrate`);

            for (const dateKey of dates) {
                const scheduleData = dailyData[dateKey];
                if (!scheduleData || !scheduleData.scheduleAssignments) continue;

                // Check if versions already exist for this date
                const existing = await listVersions(dateKey);
                if (existing.length > 0) {
                    console.log(`📋 [DB] Skipping ${dateKey} - already has ${existing.length} versions`);
                    continue;
                }

                // Create Version 1
                const result = await createVersion(
                    dateKey,
                    'Schedule 1 (Migrated)',
                    scheduleData,
                    null
                );

                if (result.success) {
                    // Set as active
                    await setActiveVersion(result.version.id);
                    console.log(`📋 [DB] ✅ Migrated ${dateKey} as version ${result.version.id}`);
                }
            }

            console.log("📋 [DB] Migration complete!");
            return { success: true };

        } catch (e) {
            console.error("📋 [DB] Migration error:", e);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersionsDB = {
        // Read operations
        listVersions,
        getVersion,
        getActiveVersion,

        // Write operations
        createVersion,
        createBasedOn,
        updateVersion,

        // Version management
        setActiveVersion,
        deleteVersion,
        renameVersion,

        // Migration
        migrateFromLegacy
    };

    console.log("📋 Schedule Versions DB v1.0 loaded");
    console.log("📋 Use ScheduleVersionsDB.createBasedOn(sourceId, name) for 'Base On' feature");

})();
