// =============================================================================
// campistry_go_cloud.js — Go-Specific Cloud Persistence
// =============================================================================
//
// Saves ALL Campistry Go data to the `go_standalone_data` Supabase table so it
// survives browser cache clears / new devices. This applies in BOTH standalone
// and connected (Campistry Me) mode — standaloneMode only controls WHERE camper
// and staff data comes from (manual/CSV vs Campistry Me), not whether we save.
//
// The main camp_state table strips addresses and routes because they are large.
// This module handles the full Go dataset in separate rows per data_type.
//
// TABLE: go_standalone_data
//   camp_id   text         (FK to camp)
//   data_type text         ('state' | 'addresses' | 'routes')
//   data      jsonb        (the actual payload)
//   updated_at timestamptz
//   PRIMARY KEY (camp_id, data_type)
//
// Data types:
//   'state'     — setup, buses, shifts, monitors, counselors (all modes)
//   'addresses' — geocoded camper addresses (large; kept in own row)
//   'routes'    — computed route results   (large; kept in own row)
//
// SQL to create:
//   CREATE TABLE IF NOT EXISTS go_standalone_data (
//     camp_id    text        NOT NULL,
//     data_type  text        NOT NULL,
//     data       jsonb       NOT NULL DEFAULT '{}',
//     updated_at timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (camp_id, data_type)
//   );
//   ALTER TABLE go_standalone_data ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "camp members can manage go data"
//     ON go_standalone_data FOR ALL
//     USING (camp_id = (SELECT camp_id FROM camp_users WHERE user_id = auth.uid() LIMIT 1))
//     WITH CHECK (camp_id = (SELECT camp_id FROM camp_users WHERE user_id = auth.uid() LIMIT 1));
//
// =============================================================================

window.GoCloudSync = (function () {
    'use strict';

    const TABLE = 'go_standalone_data';

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function getCampId() {
        return (
            window.CampistryDB?.getCampId?.() ||
            localStorage.getItem('campistry_camp_id') ||
            null
        );
    }

    function getClient() {
        return window.supabase || null;
    }

    function isReady() {
        const campId = getCampId();
        const client = getClient();
        if (!campId) { console.warn('[GoCloud] No camp_id — skipping'); return false; }
        if (!client)  { console.warn('[GoCloud] Supabase not ready — skipping'); return false; }
        return true;
    }

    // -------------------------------------------------------------------------
    // save(dataType, data)
    // Upserts one row in go_standalone_data.
    // Fire-and-forget — callers don't need to await.
    // -------------------------------------------------------------------------
    async function save(dataType, data) {
        if (!isReady()) return { ok: false, reason: 'not-ready' };
        const campId = getCampId();
        const client = getClient();

        try {
            const { error } = await client
                .from(TABLE)
                .upsert(
                    {
                        camp_id:    campId,
                        data_type:  dataType,
                        data:       data,
                        updated_at: new Date().toISOString()
                    },
                    { onConflict: 'camp_id,data_type' }
                );

            if (error) {
                console.warn('[GoCloud] Save error for', dataType, ':', error.message);
                return { ok: false, error };
            }
            console.log('[GoCloud] Saved:', dataType);
            return { ok: true };
        } catch (e) {
            console.error('[GoCloud] Save exception:', dataType, e);
            return { ok: false, error: e };
        }
    }

    // -------------------------------------------------------------------------
    // loadAll()
    // Fetches all rows for this camp and returns them as
    // { addresses: {...}, routes: {...} } (keys = data_type values).
    // Returns null if nothing found or error.
    // -------------------------------------------------------------------------
    async function loadAll() {
        if (!isReady()) return null;
        const campId = getCampId();
        const client = getClient();

        try {
            const { data, error } = await client
                .from(TABLE)
                .select('data_type, data')
                .eq('camp_id', campId);

            if (error) {
                console.warn('[GoCloud] Load error:', error.message);
                return null;
            }
            if (!data || !data.length) {
                console.log('[GoCloud] No go_standalone_data found for camp');
                return null;
            }

            const result = {};
            for (const row of data) {
                result[row.data_type] = row.data;
            }
            console.log('[GoCloud] Loaded data types:', Object.keys(result).join(', '));
            return result;
        } catch (e) {
            console.error('[GoCloud] Load exception:', e);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    return { save, loadAll };
})();
