// =============================================================================
// campistry_cloud_bootstrap.js — Lightweight Camp Data Hydrator v1.1
// =============================================================================
//
// Fetches campStructure + app1 (camperRoster) from Supabase camp_state_kv,
// merges into campGlobalSettings_v1 localStorage, then dispatches
// 'campistry-cloud-hydrated'. Always write BEFORE dispatch — no early fire.
//
// Loaded by: campistry_live.html, campistry_health.html,
//            campistry_snacks.html, campistry_link_admin.html
//
// Requires: config.js, supabase-js@2.js, supabase_client.js (must load first)
// =============================================================================

(function () {
    'use strict';

    var STORAGE_KEY = 'campGlobalSettings_v1';
    var FETCH_KEYS  = ['campStructure', 'app1', 'campistryMe', 'bunkMetaData', 'fields', 'campistrySnacks', 'campistryHealth'];

    // Guard: only one successful cloud hydration per page load
    var _hydrated = false;

    function readLocal() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; }
    }

    function writeLocal(obj) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch (_) {}
    }

    // Merge cloud keys into localStorage.
    // ALWAYS re-read immediately before writing so we don't clobber
    // keys another writer may have touched while the cloud fetch was in flight.
    function mergeIntoLocal(cloudData) {
        // Fresh read right before write — minimises the race window
        var current = readLocal();
        var written = [];

        FETCH_KEYS.forEach(function (key) {
            if (cloudData[key] !== undefined) {
                current[key] = cloudData[key];
                written.push(key);
            }
        });

        if (written.length) {
            writeLocal(current);
            console.log('[CampBootstrap] Wrote cloud keys to localStorage:', written.join(', '));
        }
        return written.length > 0;
    }

    function signalReady() {
        // Set the flag Link admin polls for
        window.__CAMPISTRY_CLOUD_READY__ = true;
        // Dispatch the event every listener waits for
        try { window.dispatchEvent(new CustomEvent('campistry-cloud-hydrated')); } catch (_) {}
    }

    async function bootstrap() {
        var db = window.CampistryDB;
        if (!db) {
            console.warn('[CampBootstrap] CampistryDB not available — localStorage only');
            signalReady();
            return;
        }

        try { await db.ready; } catch (_) {}

        var campId = db.getCampId();
        var client  = db.getClient();

        if (!campId || !client) {
            console.warn('[CampBootstrap] No camp ID or Supabase client — localStorage only');
            signalReady();
            return;
        }

        try {
            var result = await client
                .from('camp_state_kv')
                .select('key, value')
                .eq('camp_id', campId)
                .in('key', FETCH_KEYS);

            if (result.error) {
                if (result.error.code === '42501') {
                    // RLS denied — user role can't read this camp's data
                    console.warn('[CampBootstrap] RLS denied — using localStorage');
                } else {
                    console.warn('[CampBootstrap] Supabase error:', result.error.message);
                }
                signalReady();
                return;
            }

            var rows = result.data || [];
            if (!rows.length) {
                console.warn('[CampBootstrap] No camp_state_kv rows for camp', campId,
                    '— Me may not have been set up yet');
                signalReady();
                return;
            }

            // Build flat object from per-key rows
            var cloudData = {};
            rows.forEach(function (row) { cloudData[row.key] = row.value; });

            var rosterCount = cloudData.app1 && cloudData.app1.camperRoster
                ? Object.keys(cloudData.app1.camperRoster).length : 0;
            console.log('[CampBootstrap] Cloud fetch OK —', rows.length, 'keys,', rosterCount, 'campers');

            // Write first, signal after — never the other way around
            mergeIntoLocal(cloudData);
            _hydrated = true;
            signalReady();

        } catch (e) {
            console.warn('[CampBootstrap] Fetch threw:', e.message || e);
            signalReady();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(bootstrap, 100); });
    } else {
        setTimeout(bootstrap, 100);
    }

    console.log('[CampBootstrap] v1.1 loaded');

})();
