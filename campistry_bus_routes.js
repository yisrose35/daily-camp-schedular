// =============================================================================
// campistry_bus_routes.js — read Campistry Go's routes from anywhere else
//
// Go computes bus routes; Me's print sheets, Link and anything else that wants
// "which bus is this camper on" need to read them without importing Go's
// 500KB of routing engine. This module is that bridge: it normalizes Go's
// saved-route structure into a flat camper → bus index.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE GO'S ROUTES ACTUALLY LIVE
//
// Not in campGlobalSettings_v1. Go deliberately STRIPS savedRoutes before
// writing there, because road geometry alone runs to several megabytes and
// blows the localStorage quota (see the save() quota handler in
// campistry_go.js). So the routes are in two other places:
//
//   1. localStorage['campistry_go_data'] — full state, this device only
//   2. the go_standalone_data table, data_type 'routes' — the durable copy
//
// loadLocal() covers a device where Go has been opened. loadCloud() covers
// everything else and is what a fresh browser needs. Callers should kick off
// the cloud load and re-render when it lands, rather than assuming local has
// anything.
//
// Go also keeps TWO modes — dismissal (PM, going home) and arrival (AM, coming
// in) — with independent routes. A camper is usually on a different bus in
// each, so the index keeps them separate rather than collapsing to "the" bus.
// ─────────────────────────────────────────────────────────────────────────────
//
// Exposed as window.CampistryBusRoutes (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var B = {};

    B.STORE_KEY = 'campistry_go_data';
    B.MODES = ['dismissal', 'arrival'];

    /** Campers on a stop are either plain strings or { name } objects. */
    function camperName(c) {
        if (!c) return '';
        return String(typeof c === 'string' ? c : (c.name || '')).trim();
    }

    /**
     * Flatten one mode's savedRoutes into per-camper stop rows.
     * savedRoutes is [{ shift, routes: [{ busName, stops: [{ stopNum, campers }] }] }].
     */
    B.collectMode = function (savedRoutes, mode) {
        var out = [];
        (savedRoutes || []).forEach(function (shiftResult) {
            if (!shiftResult) return;
            var shift = shiftResult.shift || {};
            var shiftLabel = shift.label || shift.name || '';
            (shiftResult.routes || []).forEach(function (r) {
                if (!r) return;
                (r.stops || []).forEach(function (st) {
                    if (!st) return;
                    (st.campers || []).forEach(function (c) {
                        var name = camperName(c);
                        if (!name) return;
                        out.push({
                            camperName: name,
                            mode: mode || '',
                            shift: shiftLabel,
                            busId: r.busId || '',
                            busName: r.busName || '',
                            busColor: r.busColor || '',
                            stopNum: st.stopNum || 0,
                            address: st.address || '',
                            monitor: (r.monitor && (r.monitor.name || r.monitor)) || '',
                            counselors: (r.counselors || []).map(function (x) {
                                return (x && (x.name || x)) || '';
                            }).filter(Boolean)
                        });
                    });
                });
            });
        });
        return out;
    };

    /**
     * Every route row across both modes, from a Go state blob.
     *
     * Go stores the ACTIVE mode's routes at the top level (D.savedRoutes) and
     * each mode's own copy under D.dismissal / D.arrival. Reading both and
     * de-duplicating is what stops the active mode being counted twice or, in
     * older saves where only the top level was written, being missed entirely.
     */
    B.collect = function (goData) {
        var d = goData || {};
        var rows = [];
        B.MODES.forEach(function (mode) {
            var m = d[mode];
            if (m && m.savedRoutes) rows = rows.concat(B.collectMode(m.savedRoutes, mode));
        });
        // Top-level savedRoutes belong to whichever mode was active.
        if (d.savedRoutes) {
            var active = d.activeMode || 'dismissal';
            var already = rows.some(function (r) { return r.mode === active; });
            if (!already) rows = rows.concat(B.collectMode(d.savedRoutes, active));
        }
        return rows;
    };

    /**
     * camper → { dismissal: row, arrival: row } index.
     *
     * A camper appearing twice in one mode (shouldn't happen — Go dedups
     * across buses — but a stale save can) keeps the FIRST row, so the answer
     * is at least stable across renders.
     */
    B.index = function (goData) {
        var idx = {};
        B.collect(goData).forEach(function (r) {
            var key = r.camperName;
            if (!idx[key]) idx[key] = {};
            var mode = r.mode || 'dismissal';
            if (!idx[key][mode]) idx[key][mode] = r;
        });
        return idx;
    };

    /** One camper's row for a mode, or null. Name match is case-insensitive. */
    B.forCamper = function (idx, name, mode) {
        if (!idx || !name) return null;
        var entry = idx[name];
        if (!entry) {
            // Rosters and Go can disagree on spacing/case; fall back to a
            // normalized scan rather than reporting "no bus" for a typo.
            var want = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
            var hit = Object.keys(idx).filter(function (k) {
                return k.toLowerCase().replace(/\s+/g, ' ').trim() === want;
            })[0];
            if (!hit) return null;
            entry = idx[hit];
        }
        return entry[mode || 'dismissal'] || null;
    };

    /** Read Go's full state from this device. Returns {} when it isn't there. */
    B.loadLocal = function () {
        try {
            var raw = localStorage.getItem(B.STORE_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) { return {}; }
    };

    /**
     * Pull the durable route copy out of go_standalone_data.
     * Resolves to a Go-shaped blob ({ savedRoutes, dismissal, arrival }) or
     * null — never rejects, because a missing table or an offline device
     * should degrade to "no bus data", not break the page.
     */
    B.loadCloud = function (client, campId) {
        if (!client || !campId) return Promise.resolve(null);
        try {
            return client.from('go_standalone_data')
                .select('data').eq('camp_id', campId).eq('data_type', 'routes').maybeSingle()
                .then(function (res) {
                    if (!res || res.error || !res.data || !res.data.data) return null;
                    var d = res.data.data;
                    return {
                        activeMode: d.activeMode || 'dismissal',
                        savedRoutes: d.savedRoutes || null,
                        dismissal: { savedRoutes: d.dismissalRoutes || null },
                        arrival: { savedRoutes: d.arrivalRoutes || null }
                    };
                }, function () { return null; });
        } catch (e) { return Promise.resolve(null); }
    };

    /** Local first, cloud only if local has nothing. */
    B.load = function (client, campId) {
        var local = B.loadLocal();
        if (B.collect(local).length) return Promise.resolve(local);
        return B.loadCloud(client, campId).then(function (cloud) { return cloud || local; });
    };

    /** Bus names in play, for a filter dropdown. */
    B.busNames = function (goData, mode) {
        var seen = {};
        B.collect(goData).forEach(function (r) {
            if (mode && r.mode !== mode) return;
            if (r.busName) seen[r.busName] = 1;
        });
        return Object.keys(seen).sort(function (a, b) {
            return a.localeCompare(b, undefined, { numeric: true });
        });
    };

    if (typeof window !== 'undefined') window.CampistryBusRoutes = B;
    if (typeof module !== 'undefined' && module.exports) module.exports = B;
})();
