// =============================================================================
// campistry_go_stop_master.js — Canonical Stop Master + camper-stop history
//
// Persists corner-aware bus stops and per-camper stop history so that
// assignments survive roster/season churn. Mirrors the Transfinder "Stop Master"
// concept: a reusable library of intersection+corner stops keyed by label.
//
// Piggybacks on go_standalone_data table (data_type='stop_master' and
// 'camper_stop_history'), same pattern as campistry_go_persistence.js.
// Falls back to localStorage when Supabase is unavailable.
//
// Payload — stop_master:
//   {
//     version: 1,
//     savedAt: ISO,
//     stops: {
//       [stopKey]: {
//         key, label, lat, lng, corner, isSingleAddress,
//         firstSeen, lastSeen, seenCount
//       }
//     }
//   }
//
// Payload — camper_stop_history (keyed by camper name):
//   {
//     version: 1,
//     savedAt: ISO,
//     seasons: [{
//       label, savedAt,
//       campers: { [name]: { stopKey, busId, stopLabel } }
//     }]  // capped at HISTORY_CAP most recent seasons
//   }
//
// Public API:
//   window.GoStopMaster.loadStops()            → Promise<map stopKey→stop>
//   window.GoStopMaster.upsertStops(stops)     → Promise<ok>    // stops: array from createCornerStops
//   window.GoStopMaster.recordSeason(label, routes) → Promise<ok>
//   window.GoStopMaster.getGrandfatherMap()    → Promise<{camperName → {stopKey, busId}}>
//   window.GoStopMaster.stopKey(label, corner) → string canonical key
// =============================================================================

window.GoStopMaster = (function () {
    'use strict';

    const STOPS_TYPE = 'stop_master';
    const HIST_TYPE  = 'camper_stop_history';
    const LS_STOPS   = 'campistry_go_stop_master_v1';
    const LS_HIST    = 'campistry_go_camper_history_v1';
    const VERSION    = 1;
    const SEASON_CAP = 3;

    function stopKey(label, corner) {
        return (String(label || '').toLowerCase().trim() + '|' + String(corner || '').toUpperCase())
            .replace(/\s+/g, ' ');
    }

    function cloudAvailable() { return !!window.GoCloudSync; }

    async function _cloudLoad(type) {
        if (!cloudAvailable()) return null;
        try {
            const all = await window.GoCloudSync.loadAll();
            return all ? (all[type] || null) : null;
        } catch (e) {
            console.warn('[GoStopMaster] Cloud load failed (' + type + '):', e.message);
            return null;
        }
    }
    async function _cloudSave(type, payload) {
        if (!cloudAvailable()) return { ok: false, reason: 'no-cloud' };
        try { return await window.GoCloudSync.save(type, payload); }
        catch (e) { return { ok: false, error: e }; }
    }
    function _localLoad(key) {
        try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
        catch (_) { return null; }
    }
    function _localSave(key, p) {
        try { localStorage.setItem(key, JSON.stringify(p)); return true; } catch (_) { return false; }
    }

    async function _load(type, lsKey, empty) {
        const cloud = await _cloudLoad(type);
        if (cloud && cloud.version === VERSION) { _localSave(lsKey, cloud); return cloud; }
        const local = _localLoad(lsKey);
        if (local && local.version === VERSION) return local;
        return empty();
    }

    async function _save(type, lsKey, payload) {
        payload.savedAt = new Date().toISOString();
        payload.version = VERSION;
        _localSave(lsKey, payload);
        const cloud = await _cloudSave(type, payload);
        return cloud.ok || !cloudAvailable();
    }

    // -------------------------------------------------------------------------
    // Stops
    // -------------------------------------------------------------------------
    async function loadStops() {
        const p = await _load(STOPS_TYPE, LS_STOPS, () => ({ version: VERSION, stops: {} }));
        return p.stops || {};
    }

    /** Accepts stop objects with {address/label, lat, lng, corner, isSingleAddress}. */
    async function upsertStops(stops) {
        if (!Array.isArray(stops) || !stops.length) return false;
        const payload = await _load(STOPS_TYPE, LS_STOPS, () => ({ version: VERSION, stops: {} }));
        const now = new Date().toISOString();
        let upserts = 0;
        stops.forEach(function (s) {
            const label = s.label || s.address; if (!label) return;
            const key = stopKey(label, s.corner);
            const existing = payload.stops[key];
            if (existing) {
                existing.lastSeen = now;
                existing.seenCount = (existing.seenCount || 1) + 1;
                existing.lat = s.lat; existing.lng = s.lng;
            } else {
                payload.stops[key] = {
                    key, label, lat: s.lat, lng: s.lng,
                    corner: s.corner || '',
                    isSingleAddress: !!s.isSingleAddress,
                    firstSeen: now, lastSeen: now, seenCount: 1
                };
            }
            upserts++;
        });
        await _save(STOPS_TYPE, LS_STOPS, payload);
        console.log('[GoStopMaster] Upserted ' + upserts + ' stops (library size: ' + Object.keys(payload.stops).length + ')');
        return true;
    }

    // -------------------------------------------------------------------------
    // Camper history
    // -------------------------------------------------------------------------
    function _emptyHist() { return { version: VERSION, seasons: [] }; }

    async function recordSeason(label, routes) {
        if (!Array.isArray(routes) || !routes.length) return false;
        const payload = await _load(HIST_TYPE, LS_HIST, _emptyHist);
        const now = new Date().toISOString();
        const campers = {};
        routes.forEach(function (r) {
            (r.stops || []).forEach(function (st) {
                if (st.isMonitor || st.isCounselor) return;
                const key = stopKey(st.address || st.label, st.corner);
                (st.campers || []).forEach(function (c) {
                    campers[c.name] = {
                        stopKey: key,
                        stopLabel: st.address || st.label,
                        busId: r.busId
                    };
                });
            });
        });
        payload.seasons.unshift({ label: label || now.slice(0, 10), savedAt: now, campers });
        payload.seasons = payload.seasons.slice(0, SEASON_CAP);
        await _save(HIST_TYPE, LS_HIST, payload);
        console.log('[GoStopMaster] Recorded season "' + label + '": ' + Object.keys(campers).length + ' campers');
        return true;
    }

    async function getGrandfatherMap() {
        const payload = await _load(HIST_TYPE, LS_HIST, _emptyHist);
        const latest = payload.seasons[0];
        if (!latest) return {};
        return latest.campers || {};
    }

    return { loadStops, upsertStops, recordSeason, getGrandfatherMap, stopKey };
})();
