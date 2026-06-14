
// =================================================================
// schedule_versions_db.js — Database-Backed Schedule Versioning
// VERSION: v1.2 (UPDATE SUPPORT)
// =================================================================

(function() {
    'use strict';

    console.log("📋 Schedule Versions DB v1.2 (UPDATE SUPPORT) loading...");

    const VERSIONS_TABLE = "schedule_versions";

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getCampId() {
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
        return new Promise(resolve => setTimeout(() => resolve(window.supabase), 100));
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    async function listVersions(dateKey) {
        const supabase = await getSupabase();
        if (!supabase) return [];

        const campId = getCampId();
        
        const { data, error } = await supabase
            .from(VERSIONS_TABLE)
            .select('*')
            .eq('camp_id', campId)
            .eq('date_key', dateKey)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("📋 [DB] Error listing versions:", error);
            return [];
        }
        return data || [];
    }

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
            const { data: { user } } = await supabase.auth.getUser();
            const userId = user?.id || 'anon';

            const payload = {
    camp_id: campId,
    date_key: dateKey,
    name: name,
    schedule_data: deepClone(scheduleData),
    created_by: userId
};

            const { data, error } = await supabase
                .from(VERSIONS_TABLE)
                .insert(payload)
                .select()
                .single();

            if (error) throw error;

            console.log(`📋 [DB] ✅ Created version ID: ${data.id}`);
            return { success: true, version: data };

        } catch (e) {
            console.error("📋 [DB] Create Exception:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Update an existing version (PATCH) - For Overwriting
     */
    async function updateVersion(versionId, scheduleData) {
        console.log(`📋 [DB] Updating version ${versionId}...`);
        const supabase = await getSupabase();
        if (!supabase) return { success: false, error: 'Supabase not initialized' };

        try {
            const { error } = await supabase
                .from(VERSIONS_TABLE)
                .update({
                    schedule_data: deepClone(scheduleData),
                    updated_at: new Date().toISOString()
                })
                .eq('id', versionId);

            if (error) throw error;

            console.log(`📋 [DB] ✅ Successfully updated version ${versionId}`);
            return { success: true };

        } catch (e) {
            console.error("📋 [DB] Update Exception:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * ★★★ CB-22: Delete a version by id. This was REFERENCED by the auto-backup
     * cleanup loop (unified_schedule_system.cleanupOldAutoBackups) but never
     * existed/exported, so MAX_AUTO_BACKUPS_PER_DATE was silently unenforced and
     * the schedule_versions table grew without bound. Now implemented + exported.
     */
    async function deleteVersion(versionId) {
        console.log(`📋 [DB] Deleting version ${versionId}...`);
        const supabase = await getSupabase();
        if (!supabase) return { success: false, error: 'Supabase not initialized' };
        try {
            const { error } = await supabase
                .from(VERSIONS_TABLE)
                .delete()
                .eq('id', versionId);
            if (error) throw error;
            console.log(`📋 [DB] ✅ Deleted version ${versionId}`);
            return { success: true };
        } catch (e) {
            console.error("📋 [DB] Delete Exception:", e);
            return { success: false, error: e.message };
        }
    }

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
        saveVersion: createVersion, // Alias
        updateVersion, // ★ NEW: Added for overwrite support
        deleteVersion, // ★ CB-22: enables auto-backup cleanup (was referenced but missing)
        createBasedOn
    };

    console.log("📋 Schedule Versions DB v1.2 loaded");

})();
