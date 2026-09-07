// =============================================================================
// campistry_go_sandbox.js — Campistry Go cost guard
// =============================================================================
//
// WHY THIS EXISTS
//   Campistry Go can reach three PAID map providers:
//     • Google Address Validation  (geocoding, billed per address)
//     • Google Route Optimization / GMPRO  (billed per request, via the
//       optimize-routes Supabase edge function which holds a platform key)
//     • Geoapify Route Planner  (paid credits)
//   A stale API key saved in a camp's Go Setup is enough to start billing.
//   The user's directive: "I don't want to pay when testing or in general."
//
// TWO LAYERS
//   1. NO-PAID (permanent, default ON): the three paid providers can NEVER
//      fire. Their public entry points self-abort, so routing/geocoding fall
//      back to the free, in-house paths that ship by default:
//        Census geocoder · ORS free tier · Nominatim · Overpass/OSM ·
//        the neighborhood road-graph router · the local 2-opt TSP solver.
//      Turning paid back on is a deliberate, explicit opt-in (see allowPaid).
//
//   2. SANDBOX (toggle, default ON): additionally SKIP the free external
//      calls (Census / ORS / Nominatim geocoding) and use deterministic MOCK
//      coordinates, so testing makes ZERO network calls to any map provider.
//      Turn it OFF (in Go → Setup → Advanced, or the banner) to do real,
//      still-free geocoding against Census.
//
//   Both flags live in localStorage so the choice sticks per browser without a
//   cloud round-trip, and are readable before any engine script parses.
// =============================================================================

window.CampistryGoSandbox = (function () {
    'use strict';

    var LS_SANDBOX   = 'campistry_go_sandbox';    // '1' on (default) | '0' off
    var LS_ALLOWPAID = 'campistry_go_allow_paid'; // '1' opt-in to paid | else off

    function _get(k) { try { return localStorage.getItem(k); } catch (_e) { return null; } }
    function _put(k, v) { try { localStorage.setItem(k, v); } catch (_e) {} }

    // --- Paid providers: OFF unless the user explicitly opts back in ----------
    // A runtime override (window.__CAMPISTRY_GO_ALLOW_PAID__ = true) or the
    // persisted flag both work; default is FALSE so nothing bills by accident.
    function allowPaid() {
        if (window.__CAMPISTRY_GO_ALLOW_PAID__ === true) return true;
        return _get(LS_ALLOWPAID) === '1';
    }
    function setAllowPaid(on) { _put(LS_ALLOWPAID, on ? '1' : '0'); }

    // --- Sandbox: ON until explicitly turned off ------------------------------
    function isSandbox() {
        if (window.__CAMPISTRY_GO_SANDBOX__ === false) return false;
        if (window.__CAMPISTRY_GO_SANDBOX__ === true) return true;
        return _get(LS_SANDBOX) !== '0'; // default ON
    }
    function setSandbox(on) { _put(LS_SANDBOX, on ? '1' : '0'); }

    // --- Deterministic mock geocoder (no network) -----------------------------
    // FNV-1a hash → stable pseudo-random per address string.
    function _hash(s) {
        var h = 2166136261 >>> 0;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }
    // A stable base point for the camp when its address can't be resolved for
    // real. Lakewood, NJ area — matches the sample data's region; only used so
    // camper mock points have something to cluster around.
    var _DEFAULT_CAMP = { lat: 40.0959, lng: -74.2179 };

    function campCoords() {
        var s = (window._GoSetup && window._GoSetup()) || {};
        if (typeof s.campLat === 'number' && typeof s.campLng === 'number') {
            return { lat: s.campLat, lng: s.campLng };
        }
        return _DEFAULT_CAMP;
    }

    // Mock a camp point deterministically from its address string (tight jitter
    // around the default center so different test camps land in different spots).
    function mockCampGeocode(addr) {
        var seed = _hash('camp|' + (addr || 'camp'));
        var ang = (seed % 3600) / 3600 * Math.PI * 2;
        var rad = ((seed >>> 12) % 1000) / 1000 * 0.02; // ~1.4 mi max
        return {
            lat: _DEFAULT_CAMP.lat + Math.cos(ang) * rad,
            lng: _DEFAULT_CAMP.lng + Math.sin(ang) * rad,
            _mock: true
        };
    }

    // Mock a camper point: a stable offset from the camp within ~5 miles, so the
    // router sees realistic residential spread and clustering.
    function mockGeocode(street, city, state, zip) {
        var camp = campCoords();
        var seed = _hash([street || '', city || '', state || '', zip || ''].join('|'));
        var ang = (seed % 3600) / 3600 * Math.PI * 2;
        // radius biased toward the middle of the disc, up to ~0.07deg (~5 mi)
        var rad = (0.25 + ((seed >>> 11) % 1000) / 1000 * 0.75) * 0.07;
        return {
            lat: camp.lat + Math.cos(ang) * rad,
            lng: camp.lng + Math.sin(ang) * rad * 1.3, // lng span wider (mid-lat)
            confidence: 0.9,
            precision: 'MOCK',
            source: 'mock',
            zipMatch: true,
            _mock: true
        };
    }

    // Console breadcrumb so it's obvious which mode is live.
    try {
        console.log('[Go] Cost guard: paid providers ' +
            (allowPaid() ? '⚠ ENABLED (will bill)' : '✅ BLOCKED') +
            ' · sandbox ' + (isSandbox() ? '🧪 ON (mock geocode, no network)' : 'off (free Census)'));
    } catch (_e) {}

    var api = {
        allowPaid: allowPaid,
        setAllowPaid: setAllowPaid,
        isSandbox: isSandbox,
        setSandbox: setSandbox,
        mockGeocode: mockGeocode,
        mockCampGeocode: mockCampGeocode
    };

    // -------------------------------------------------------------------------
    // Status chip — a small fixed control so the mode is always visible and
    // one click away. Changing a mode reloads (geocodes/routes were computed
    // under the old mode and must be recomputed).
    // -------------------------------------------------------------------------
    function _mount() {
        if (document.getElementById('go-sandbox-chip')) return;
        var wrap = document.createElement('div');
        wrap.id = 'go-sandbox-chip';
        wrap.style.cssText =
            'position:fixed;right:14px;bottom:14px;z-index:2147483000;' +
            'font-family:"DM Sans",system-ui,sans-serif;font-size:12px;' +
            'background:#fff;border:1px solid #e2e8f0;border-radius:12px;' +
            'box-shadow:0 6px 24px rgba(0,0,0,.12);padding:10px 12px;' +
            'display:flex;flex-direction:column;gap:8px;min-width:210px;';

        function render() {
            var paid = allowPaid(), sb = isSandbox();
            wrap.innerHTML =
                '<div style="font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px;">' +
                    '<span style="width:8px;height:8px;border-radius:50%;background:' +
                    (paid ? '#ef4444' : '#16a34a') + ';display:inline-block;"></span>' +
                    'Campistry Go — cost guard</div>' +
                '<div style="color:#475569;line-height:1.5;">' +
                    '💳 Paid APIs: <b style="color:' + (paid ? '#b91c1c' : '#15803d') + '">' +
                        (paid ? 'ENABLED ⚠' : 'BLOCKED') + '</b><br>' +
                    '🧪 Sandbox: <b style="color:' + (sb ? '#c2410c' : '#475569') + '">' +
                        (sb ? 'ON (mock, no network)' : 'OFF (free Census)') + '</b>' +
                '</div>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button data-act="sb" style="flex:1;cursor:pointer;border:1px solid #e2e8f0;' +
                        'background:#f8fafc;border-radius:8px;padding:5px 8px;font:inherit;font-size:11px;">' +
                        (sb ? 'Turn sandbox off' : 'Turn sandbox on') + '</button>' +
                    '<button data-act="paid" style="flex:1;cursor:pointer;border:1px solid #e2e8f0;' +
                        'background:#f8fafc;border-radius:8px;padding:5px 8px;font:inherit;font-size:11px;">' +
                        (paid ? 'Block paid' : 'Enable paid') + '</button>' +
                '</div>';
        }
        render();

        wrap.addEventListener('click', function (e) {
            var b = e.target.closest('button'); if (!b) return;
            var act = b.getAttribute('data-act');
            if (act === 'sb') {
                setSandbox(!isSandbox());
            } else if (act === 'paid') {
                if (!allowPaid()) {
                    if (!window.confirm('Enable PAID map providers (Google / Geoapify)?\n\n' +
                        'This can incur real charges. Only do this when you intend to make ' +
                        'live, billable API calls.')) return;
                }
                setAllowPaid(!allowPaid());
            } else { return; }
            location.reload();
        });

        document.body.appendChild(wrap);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _mount);
    } else { _mount(); }

    window.CampistryGoSandbox = api;
    return api;
})();
