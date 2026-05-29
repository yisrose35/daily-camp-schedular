// =============================================================================
// campistry_cloud_bootstrap.js — Lightweight Camp Data Hydrator v1.0
// =============================================================================
//
// Fetches campStructure + app1 (camperRoster) from Supabase camp_state_kv
// and merges them into the shared campGlobalSettings_v1 localStorage key.
// Dispatches 'campistry-cloud-hydrated' so any listening app JS can re-render.
//
// Loaded by: campistry_live.html, campistry_health.html,
//            campistry_snacks.html, campistry_link_admin.html
//
// Requires: config.js, supabase-js@2.js, supabase_client.js (must load first)
// =============================================================================

(function () {
    'use strict';

    var STORAGE_KEY = 'campGlobalSettings_v1';
    // Keys from camp_state_kv that contain camper/structure data
    var FETCH_KEYS   = ['campStructure', 'app1', 'bunkMetaData', 'fields'];

    function readLocal() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; }
    }

    function writeLocal(obj) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch (_) {}
    }

    function dispatchHydrated() {
        try { window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated')); } catch (_) {}
    }

    // Merge cloud keys into existing localStorage — cloud wins on a per-key basis
    // but we never wipe keys that aren't in the fetched set (e.g. daily live data).
    function mergeIntoLocal(cloudData) {
        var local = readLocal();
        var changed = false;

        FETCH_KEYS.forEach(function (key) {
            if (cloudData[key] !== undefined) {
                local[key] = cloudData[key];
                changed = true;
            }
        });

        if (changed) {
            writeLocal(local);
            console.log('[CampBootstrap] Merged cloud keys:', Object.keys(cloudData).filter(function(k){ return cloudData[k] !== undefined; }));
        }
        return changed;
    }

    async function bootstrap() {
        // Wait for CampistryDB to finish auth + camp detection
        var db = window.CampistryDB;
        if (!db) {
            console.warn('[CampBootstrap] CampistryDB not available — running localStorage-only');
            dispatchHydrated();
            return;
        }

        try {
            await db.ready;
        } catch (_) {}

        var campId = db.getCampId();
        var client  = db.getClient();

        if (!campId || !client) {
            console.warn('[CampBootstrap] No camp ID or Supabase client — using localStorage only');
            dispatchHydrated();
            return;
        }

        // Check if localStorage already has a roster — still fetch from cloud
        // to ensure we have the latest (Me page may have been edited on another device)
        var local = readLocal();
        var hasLocalRoster = local.app1 && local.app1.camperRoster && Object.keys(local.app1.camperRoster).length > 0;

        if (hasLocalRoster) {
            // Dispatch immediately so the app renders right away with cached data
            dispatchHydrated();
        }

        try {
            var result = await client
                .from('camp_state_kv')
                .select('key, value')
                .eq('camp_id', campId)
                .in('key', FETCH_KEYS);

            if (result.error) {
                if (result.error.code === '42501') {
                    // RLS denied — role doesn't have read access to this camp
                    console.warn('[CampBootstrap] RLS denied camp_state_kv read — using localStorage');
                } else {
                    console.warn('[CampBootstrap] camp_state_kv error:', result.error.message);
                }
                if (!hasLocalRoster) dispatchHydrated();
                return;
            }

            var rows = result.data || [];
            if (rows.length === 0) {
                console.warn('[CampBootstrap] No rows in camp_state_kv for camp', campId);
                if (!hasLocalRoster) dispatchHydrated();
                return;
            }

            // Reconstruct a flat object from the per-key rows
            var cloudData = {};
            rows.forEach(function (row) {
                cloudData[row.key] = row.value;
            });

            var rosterCount = cloudData.app1 && cloudData.app1.camperRoster
                ? Object.keys(cloudData.app1.camperRoster).length : 0;
            console.log('[CampBootstrap] Fetched', rows.length, 'keys from cloud —', rosterCount, 'campers');

            var changed = mergeIntoLocal(cloudData);

            // Always dispatch after fetching — even if no change, listeners need to render
            dispatchHydrated();

        } catch (e) {
            console.warn('[CampBootstrap] Fetch failed:', e.message);
            if (!hasLocalRoster) dispatchHydrated();
        }
    }

    // Run after DOM is ready so the Supabase client has had a chance to init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(bootstrap, 150); });
    } else {
        setTimeout(bootstrap, 150);
    }

    console.log('[CampBootstrap] Loaded — will hydrate camp data from Supabase');

})();
