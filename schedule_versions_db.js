// =================================================================
// schedule_versions_db.js — Database-Backed Schedule Versioning
// VERSION: v1.1 (SUPABASE CLIENT FIX)
// =================================================================
//
// UPDATES:
// - Switched from raw fetch to window.supabase client for reliability
// - Improved error handling and logging
//
// =================================================================
(function() {
    'use strict';

    console.log("📋 Schedule Versions DB v1.1 (SUPABASE CLIENT FIX) loading...");

    const VERSIONS_TABLE = "schedule_versions";

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getCampId() {
        // Support function or local storage fallback
        return (window.getCampId && window.getCampId()) || 
               localStorage.getItem('campistry_user_id') || 
               'demo_camp_001';
    }

    function deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        return JSON.parse(JSON.stringify(obj));
    }

    async function getSupabase() {
        if (window.supabase) return window.supabase;
        // Small delay to allow initialization
        return new Promise(resolve => setTimeout(() => resolve(window.supabase), 100));
    }

    // =========================================================================
    // DATABASE OPERATIONS
    // =========================================================================

    /**
     * List all schedule versions for a specific date
     */
    async function listVersions(dateKey) {
        const supabase = await getSupabase();
        if (!supabase) return [];

        const campId = getCampId();
        
        const { data, error } = await supabase
            .from(VERSIONS_TABLE)
            .select('*')
            .eq('camp_id', campId)
            .eq('date', dateKey)
            .order('created_at', { ascending: false }); // Newest first

        if (error) {
            console.error("📋 [DB] Error listing versions:", error);
            return [];
        }

        return data || [];
    }

    /**
     * Get a specific version by ID
     */
    async function getVersion(versionId) {
        const supabase = await getSupabase();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from(VERSIONS_TABLE)
            .select('*')
            .eq('id', versionId)
            .maybeSingle();

        if (error) {
            console.error("📋 [DB] Error getting version:", error);
            return null;
        }

        return data;
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Create a new schedule version (INSERT)
     */
    async function createVersion(dateKey, name, scheduleData, basedOnId = null) {
        console.log(`📋 [DB] Creating NEW version for ${dateKey}`);

        const supabase = await getSupabase();
        if (!supabase) return { success: false, error: 'Supabase not initialized' };

        const campId = getCampId();
        
        try {
            // Get current user
            const { data: { user } } = await supabase.auth.getUser();
            const userId = user?.id || 'anon';

            // Construct payload
            const payload = {
                camp_id: campId,
                date: dateKey,
                name: name,
                based_on: basedOnId,
                schedule_data: deepClone(scheduleData),
                is_active: false,
                created_by: userId,
                created_at: new Date().toISOString()
            };

            const { data, error } = await supabase
                .from(VERSIONS_TABLE)
                .insert(payload)
                .select()
                .single();

            if (error) {
                console.error("📋 [DB] INSERT failed:", error);
                return { success: false, error: error.message };
            }

            console.log(`📋 [DB] ✅ Created version ID: ${data.id}`);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('campistry-version-created', {
                detail: { 
                    dateKey, 
                    versionId: data.id, 
                    name 
                }
            }));

            return { success: true, version: data };

        } catch (e) {
            console.error("📋 [DB] Exception:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Create a version based on an existing one
     */
    async function createBasedOn(sourceVersionId, newName) {
        const source = await getVersion(sourceVersionId);
        if (!source) return { success: false, error: "Source version not found" };

        const newData = deepClone(source.schedule_data);
        newData._clonedFrom = {
            sourceId: sourceVersionId,
            sourceName: source.name,
            clonedAt: new Date().toISOString()
        };

        return createVersion(source.date, newName, newData, sourceVersionId);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.ScheduleVersionsDB = {
        listVersions,
        getVersion,
        createVersion,
        saveVersion: createVersion, // Alias for backward compatibility
        createBasedOn
    };

    console.log("📋 Schedule Versions DB v1.1 loaded");

})();
