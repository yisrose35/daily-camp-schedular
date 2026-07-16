// =================================================================
// app1.js — v5.2: Grades Are The Scheduling Units (Clean UI)
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 5.2 - Cleaned UI: removed redundant elements, fixed selected border
// 
// KEY CONCEPT:
//   Division (e.g. "Juniors")    = organizational parent group
//   Grade    (e.g. "1st Grade")  = the SCHEDULING UNIT (columns in builder)
//   Bunk     (e.g. "1A", "1B")   = individual groups within a grade
//
// v5.2 CHANGES vs v5.1:
// - Removed "🏕️ Camp Scheduler" page title
// - Removed redundant static intro card ("Configure Your Camp Structure")
// - Fixed green selection ring clipping (outline instead of box-shadow)
// - Updated panel headers: "Divisions" → "Grades", cleaned descriptions
// - Simplified Campistry Me link banner
// - Removed legacy "All Divisions" subtitle (parent-division groups replace it)
// - Cleaned up detail pane (removed redundant color row)
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "5.2";
    const DEBOUNCE_MS = 150;
    const DEFAULT_BUNK_SIZE = 0;
    
    const DEFAULT_COLORS = Object.freeze([
        "#00C896", "#6366F1", "#F59E0B", "#EF4444",
        "#8B5CF6", "#3B82F6", "#10B981", "#EC4899",
        "#F97316", "#14B8A6", "#84CC16", "#A855F7",
        "#06B6D4", "#F43F5E", "#22C55E", "#FBBF24"
    ]);
    
    const DEFAULT_SPORTS = Object.freeze([
        "Baseball", "Basketball", "Football", "Hockey", "Kickball",
        "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
    ]);
    
    const DEFAULT_DURATIONS = Object.freeze({
        "General Activity": 60,
        "Sports Slot": 60,
        "Special Activity": 60,
        "Swim": 60,
        "League Game": 60,
        "Specialty League": 60
    });

    // ==================== STATE ====================
    const state = {
        bunks: [],
        divisions: {},
        specialActivities: [],
        availableDivisions: [],
        selectedDivision: null,
        bunkMetaData: {},
        sportMetaData: {},
        allSports: [...DEFAULT_SPORTS],
        savedSkeletons: {},
        skeletonAssignments: {},
        divisionGroups: {}
    };

    // ==================== UTILITIES ====================
    
    function deepClone(obj) {
        if (obj === null || obj === undefined) return obj;
        try { return structuredClone(obj); }
        catch { return JSON.parse(JSON.stringify(obj)); }
    }
    
    function debounce(fn, delay = DEBOUNCE_MS) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    }
    
    function safeGet(obj, path, defaultVal = null) {
        if (!obj || !path) return defaultVal;
        const keys = path.split('.');
        let result = obj;
        for (const key of keys) {
            if (result === null || result === undefined) return defaultVal;
            result = result[key];
        }
        return result ?? defaultVal;
    }
    
    function parseTimeToMinutes(str) { return window.CampUtils.parseTimeToMinutes(str); }  // → campistry_utils.js (canonical superset; equivalence harness-proven)
    
    function compareBunks(a, b) {
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
    }
    
    function sortBunksInPlace(arr) {
        if (!Array.isArray(arr)) return;
        arr.sort(compareBunks);
    }

    // Globally-available helper: return division/grade keys in the user's
    // Campistry Me order. Used everywhere a list of grade columns is rendered
    // (Daily Adjustments, Master Builder, analytics, print, calendar) so the
    // column order is identical across the whole site.
    //
    // ★ FN-50 / JSONB-order fix: the Campistry Me grade order is the single
    //   source of truth, BUT campStructure is stored as JSONB in the cloud and
    //   JSONB does NOT preserve object key order — it normalizes (shortest key
    //   first, then byte order). So Object.keys(campStructure) is an unreliable
    //   PARENT-division order after any cloud round-trip (it would, e.g., hoist
    //   "Seniors" ahead of "Day Camp" purely because the name is shorter). We
    //   therefore order parents by the number of their first grade — exactly
    //   like the Me / Flow Divisions view — and lean on each division's
    //   gradeOrder array (order-stable in JSONB) for the grades within it.
    //   AND: a grade NAME that repeats across divisions becomes a QUALIFIED
    //   column key ("Day Camp > 4") in window.divisions (see gradeBasedDivisions
    //   below). We rebuild those same qualified keys here so the lookup matches;
    //   otherwise every duplicated-name grade silently dropped out of the user's
    //   order and clumped at the back by number.
    // ★ PRIORITY / logic order — the pure Camp-Structure (Me) order. This is the
    //   single source of truth for the SOLVER (field-quality seniority via
    //   getDivisionAgeOrder + the division processing order in state.availableDivisions).
    //   It deliberately does NOT honor the UI-only column reorder (app1.viewColumnOrder);
    //   that reorder is display-only, applied on top by getUserDivisionOrder below. So a
    //   user can make the schedule LOOK like 3-2-1 while priority stays 1-2-3.
    window._getMeDivisionOrder = function (keys) {
        if (!Array.isArray(keys) || keys.length === 0) return keys || [];
        var gs = (typeof window.loadGlobalSettings === 'function') ? (window.loadGlobalSettings() || {}) : {};
        var cs = gs.campStructure || {};
        var divs = window.divisions || {};

        // Mirror gradeBasedDivisions' qualifier basis: count grade NAMES across
        // divisions from each division's grades object (NOT gradeOrder).
        var gradeNameCounts = {};
        Object.keys(cs).forEach(function (divName) {
            var d = cs[divName];
            if (!d || typeof d !== 'object') return;
            Object.keys(d.grades || {}).forEach(function (g) {
                gradeNameCounts[g] = (gradeNameCounts[g] || 0) + 1;
            });
        });

        // Resolve a division's grade order the same way the build does:
        // gradeOrder (filtered to existing grades) + any leftover grades.
        var gradesInOrder = function (divName) {
            var d = cs[divName] || {};
            var grades = d.grades || {};
            var all = Object.keys(grades);
            var ord = d.gradeOrder;
            return (Array.isArray(ord) && ord.length)
                ? ord.filter(function (g) { return g in grades; })
                     .concat(all.filter(function (g) { return ord.indexOf(g) < 0; }))
                : all;
        };

        // Parent-division order — MIRRORS the Camp Structure (Me) page exactly
        // (campistry_me.js _sortedDivisions), so Flow / print / analytics column order
        // COPIES what the user sees and arranges in Campistry Me. Me is the single
        // source of truth for order:
        //   • explicit PARENT-level manualColumnOrder positions lead (the Me up/down
        //     arrange order), then
        //   • when ANY manual order list exists, the rest is alphabetical by parent
        //     NAME; only when NO manual order exists at all do we fall back to a numeric
        //     parent-NAME sort — byte-for-byte the same rule as _sortedDivisions.
        // (The OLD `firstGradeNum` heuristic ordered parents by the number inside their
        //  first grade — which DIVERGED from the Me page's alphabetical order for named
        //  divisions like Camp Agudah / Day Camp. That Me↔Flow mismatch is the bug this
        //  removes. To set a non-alphabetical parent order, arrange divisions in Me; both
        //  Me and Flow then follow it.)
        // The Me page's division order lives in the DEDICATED app1.divisionOrder key
        // (parent names only — written exclusively by Me reorders, so Flow's
        // schedule-column order can't clobber it). Legacy parent-level entries in
        // app1.manualColumnOrder are honored next; otherwise alphabetical. This is the
        // exact same source campistry_me _getDivisionOrder reads, so Me and Flow agree.
        var divOrd = (gs.app1 && Array.isArray(gs.app1.divisionOrder)) ? gs.app1.divisionOrder : [];
        var manualOrd = (gs.app1 && Array.isArray(gs.app1.manualColumnOrder)) ? gs.app1.manualColumnOrder : [];
        var parentManualPos = {};
        divOrd.forEach(function (k) { if (cs[k] != null && parentManualPos[k] == null) parentManualPos[k] = Object.keys(parentManualPos).length; });
        manualOrd.forEach(function (k) { if (cs[k] != null && parentManualPos[k] == null) parentManualPos[k] = Object.keys(parentManualPos).length; });
        var hasAnyOrderList = divOrd.length > 0 || manualOrd.length > 0;
        var parents = Object.keys(cs).slice().sort(function (a, b) {
            var pa = parentManualPos[a], pb = parentManualPos[b];
            if (pa != null && pb != null && pa !== pb) return pa - pb;
            if (pa != null && pb == null) return -1;   // user-positioned parents lead
            if (pa == null && pb != null) return 1;
            if (!hasAnyOrderList) {                     // mirror _sortedDivisions' else-branch
                var na = parseInt(a, 10), nb = parseInt(b, 10);
                if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
            }
            return String(a).localeCompare(String(b));
        });

        // Flat, QUALIFIED canonical column order → position map.
        var pos = {};
        var idx = 0;
        parents.forEach(function (divName) {
            gradesInOrder(divName).forEach(function (g) {
                var key = gradeNameCounts[g] > 1 ? (divName + ' > ' + g) : g;
                if (pos[key] == null) pos[key] = idx++;
            });
        });

        return keys.slice().sort(function (a, b) {
            var ai = pos[a] == null ? 1e9 : pos[a];
            var bi = pos[b] == null ? 1e9 : pos[b];
            if (ai !== bi) return ai - bi;
            // Keys not in campStructure (transient/legacy): parent, then numeric, then alpha.
            var aParent = (divs[a] && divs[a].parentDivision) || a;
            var bParent = (divs[b] && divs[b].parentDivision) || b;
            var pai = parents.indexOf(aParent), pbi = parents.indexOf(bParent);
            if (pai >= 0 && pbi >= 0 && pai !== pbi) return pai - pbi;
            var ma = String(a).match(/(\d+)/), mb = String(b).match(/(\d+)/);
            var xa = ma ? parseInt(ma[1], 10) : NaN, xb = mb ? parseInt(mb[1], 10) : NaN;
            if (!isNaN(xa) && !isNaN(xb) && xa !== xb) return xa - xb;
            return String(a).localeCompare(String(b));
        });
    };

    // ★ UI-ONLY column reorder (app1.viewColumnOrder). The user can drag grade
    //   columns in Daily Adjustments / the Manual (Master Schedule) Builder to set
    //   how the schedule LOOKS, independent of the Me priority order. Given a list
    //   already in Me order, re-sequence it to follow the saved view order; columns
    //   absent from the view order keep their Me-relative position at the end (so a
    //   newly-added grade still shows up). Empty/absent view order → returns the Me
    //   order unchanged, so a camp that never touches this is byte-identical to before.
    window._applyViewColumnOrder = function (meOrdered) {
        if (!Array.isArray(meOrdered) || meOrdered.length === 0) return meOrdered || [];
        var gs = (typeof window.loadGlobalSettings === 'function') ? (window.loadGlobalSettings() || {}) : {};
        var vco = (gs.app1 && Array.isArray(gs.app1.viewColumnOrder)) ? gs.app1.viewColumnOrder : [];
        if (!vco.length) return meOrdered;
        var posV = {};
        vco.forEach(function (k, i) { if (posV[k] == null) posV[k] = i; });
        return meOrdered.map(function (k, i) { return { k: k, i: i }; }).sort(function (a, b) {
            var pa = posV[a.k], pb = posV[b.k];
            if (pa != null && pb != null) return pa !== pb ? pa - pb : a.i - b.i;
            if (pa != null) return -1;   // columns the user explicitly ordered lead
            if (pb != null) return 1;
            return a.i - b.i;            // both absent → keep Me order
        }).map(function (o) { return o.k; });
    };

    // ★ DISPLAY column order = Me order + the UI-only view reorder on top. Single
    //   source of truth for how grade columns are SEQUENCED in every view that shows
    //   the schedule (Daily Adjustments, Manual Builder grid, print, calendar,
    //   analytics). The PRIORITY order (field quality + solver) does NOT pass through
    //   here — it calls _getMeDivisionOrder directly — so the look can differ from the
    //   priority. When no viewColumnOrder is set this is identical to the Me order.
    window.getUserDivisionOrder = function (keys) {
        return window._applyViewColumnOrder(window._getMeDivisionOrder(keys));
    };

    // ★ Per-day division/grade presence. A grade can be marked present only on
    //   certain weekdays (Campistry Me grade editor → daysPresent). On a date
    //   when it's absent, its column is dropped from the date-specific schedule
    //   views (Master Scheduler, Unified, Daily, Print). daysPresent absent or
    //   non-array → present every day (backward compatible). [] → present no day.
    window.isDivisionPresentOnDate = function (divKey, dateStr) {
        try {
            var d = (window.divisions || {})[divKey];
            var dp = d && d.daysPresent;
            if (!Array.isArray(dp)) return true;            // no restriction
            var ds = dateStr || window.currentScheduleDate || '';
            var p = String(ds).split('-').map(Number);
            if (!(p[0] && p[1] && p[2])) return true;        // unknown date → show
            var dow = new Date(p[0], p[1] - 1, p[2]).getDay();
            var names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return dp.indexOf(names[dow]) !== -1;
        } catch (e) { return true; }
    };
    window.filterDivisionsByDate = function (keys, dateStr) {
        if (!Array.isArray(keys)) return keys;
        return keys.filter(function (k) { return window.isDivisionPresentOnDate(k, dateStr); });
    };

    // ★ FN-51: canonical AGE order for Field Quality seniority — index 0 = most
    //   senior = gets the rank-1 field. It is EXACTLY the Camp Structure (Me) PRIORITY
    //   order (_getMeDivisionOrder), just flipped for the "Grade age order" toggle
    //   (app1.divisionAgeDirection). It uses _getMeDivisionOrder — NOT the display
    //   getUserDivisionOrder — so the UI-only column reorder (app1.viewColumnOrder)
    //   can never shift field-quality seniority: the schedule may LOOK 3-2-1 while the
    //   solver still prioritizes by the Me order 1-2-3. Single source of truth for
    //   priority: whatever the user arranges in Campistry Me.
    window.getDivisionAgeOrder = function (names) {
        var keys = Array.isArray(names) && names.length ? names.slice() : Object.keys(window.divisions || {});
        var gs = (typeof window.loadGlobalSettings === 'function') ? (window.loadGlobalSettings() || {}) : {};
        var ordered = (typeof window._getMeDivisionOrder === 'function')
            ? window._getMeDivisionOrder(keys) : keys.slice();
        var dir = (gs.app1 && gs.app1.divisionAgeDirection) || 'youngToOld';
        // youngToOld = the Me list runs top(young) → bottom(old), so oldest-first = reversed
        return dir === 'oldToYoung' ? ordered.slice() : ordered.slice().reverse();
    };

    function escapeHtml(str) { return window.CampUtils.escapeHtml(str); }  // → campistry_utils.js (canonical)

    // ==================== SYNC SPINE ====================
    
    function syncSpine() {
        window.setGlobalDivisions?.(deepClone(state.divisions));
        window.setGlobalBunks?.(deepClone(state.bunks));
    }

    // ==================== COLOR MANAGEMENT ====================
    
    function getColorIndex() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.divisionColorIndex || 0;
    }
    
    function setColorIndex(index) {
        window.saveGlobalSettings?.('divisionColorIndex', index);
    }
    
    function getNextDivisionColor() {
        const index = getColorIndex();
        const color = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
        setColorIndex(index + 1);
        return color;
    }
    
    function getNextUniqueDivisionColor(divisionsObj = state.divisions) {
        const usedColors = new Set(
            Object.values(divisionsObj || {}).map(d => d?.color).filter(Boolean)
        );
        const startIndex = getColorIndex();
        for (let i = 0; i < DEFAULT_COLORS.length; i++) {
            const index = (startIndex + i) % DEFAULT_COLORS.length;
            const color = DEFAULT_COLORS[index];
            if (!usedColors.has(color)) {
                setColorIndex(index + 1);
                return color;
            }
        }
        return getNextDivisionColor();
    }

    // ==================== STYLES ====================
    
    function ensureSharedSetupStyles() {
        if (document.getElementById("setup-shared-styles")) return;
        
        const style = document.createElement("style");
        style.id = "setup-shared-styles";
        style.textContent = `
            /* ===== Global Setup / Detail Pane Shell (Modern Pro Camp) ===== */
            .detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 18px 20px;
                background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                min-height: 360px;
                box-shadow: 0 18px 40px rgba(15, 23, 42, 0.06);
            }
            
            .division-card {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #FFFFFF;
                padding: 10px 16px;
                margin: 4px 0;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
                cursor: pointer;
                transition: all 0.16s ease;
            }
            
            .division-card:hover {
                box-shadow: 0 12px 26px rgba(15, 23, 42, 0.12);
                transform: translateY(-1px);
                background-color: #F9FAFB;
            }
            
            /* ★ v5.2 FIX: Use outline instead of box-shadow spread 
               so the green ring doesn't get clipped by the parent container */
            .division-card.selected {
                border-color: #00C896;
                outline: 2px solid rgba(0, 200, 150, 0.55);
                outline-offset: 0px;
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 65%);
            }
            
            /* ★ v5.2: Give the grade list breathing room for outlines */
            #divisionButtons.master-list {
                padding: 3px;
            }
            
            .division-card-top {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 4px;
            }
            
            .division-pill {
                padding: 4px 16px;
                border-radius: 999px;
                color: #FFFFFF;
                font-weight: 600;
                font-size: 0.9rem;
                min-width: 32px;
                display: flex;
                justify-content: center;
                align-items: center;
                box-shadow: 0 4px 10px rgba(15, 23, 42, 0.22);
            }
            
            .division-color-chip-list {
                width: 22px;
                height: 22px;
                border-radius: 6px;
                border: 1px solid rgba(15, 23, 42, 0.12);
                box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
            }
            
            .division-card-subline {
                font-size: 0.8rem;
                color: #6B7280;
            }
            
            .division-edit-shell {
                padding: 4px 0 0;
                border-radius: 16px;
                background: transparent;
            }
            
            .division-edit-header {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                padding-bottom: 10px;
                border-bottom: 1px solid #E5E7EB;
                margin-bottom: 14px;
            }
            
            .division-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 600;
                font-size: 0.98rem;
                color: #111827;
            }
            
            .division-status-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            
            .division-name {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .division-header-summary {
                font-size: 0.8rem;
                color: #6B7280;
                font-weight: 400;
            }
            
            .division-edit-grid {
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            
            .division-mini-card {
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                padding: 12px 14px;
                box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
            }
            
            .division-mini-header {
                font-weight: 600;
                font-size: 0.82rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #374151;
                margin-bottom: 6px;
            }
            
            .division-mini-help {
                font-size: 0.78rem;
                color: #9CA3AF;
                margin: 0 0 6px;
            }
            
            .division-bunk-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 12px;
                border-radius: 999px;
                background: #F1F5F9;
                color: #1E293B;
                font-size: 0.8rem;
                font-weight: 500;
                border: 1px solid transparent;
                transition: all 0.15s ease;
            }
            
            .division-bunk-pill:hover {
                background: rgba(13, 124, 92, 0.12);
                border-color: #0D7C5C;
            }
            
            .bunk-size-badge {
                background: #E2E8F0;
                color: #64748B;
                padding: 1px 6px;
                border-radius: 999px;
                font-size: 0.7rem;
                font-weight: 500;
            }
            
            .division-color-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.8rem;
                color: #6B7280;
                margin-bottom: 12px;
            }

            /* ===== Parent Division Group Headers ===== */
            .parent-division-label {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 4px 2px;
                font-size: 0.72rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6B7280;
            }

            .parent-division-label:not(:first-child) {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #F3F4F6;
            }

            .parent-division-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }

            .bunk-delete-confirm {
                background: #FEF2F2;
                border-color: #FECACA;
                animation: shake 0.3s ease-in-out;
            }
            
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                25% { transform: translateX(-2px); }
                75% { transform: translateX(2px); }
            }

            /* ===== Builder Mode Slider ===== */
            .builder-mode-wrapper {
                display: flex;
                justify-content: center;
                margin: 10px 0 24px 0;
            }
            .builder-mode-slider {
                display: flex;
                background: #E2E8F0;
                border-radius: 999px;
                padding: 4px;
                position: relative;
                width: 456px;
                max-width: 100%;
                box-shadow: inset 0 2px 4px rgba(15, 23, 42, 0.05);
            }
            .builder-mode-option {
                flex: 1;
                text-align: center;
                padding: 10px 4px;
                font-size: 0.9rem;
                font-weight: 600;
                color: #64748B;
                cursor: pointer;
                z-index: 2;
                white-space: nowrap;
                transition: color 0.3s;
            }
            .builder-mode-option.active {
                color: #0D7C5C;
            }
            .builder-mode-indicator {
                position: absolute;
                top: 4px;
                bottom: 4px;
                width: calc(33.333% - 2.67px);
                background: #FFFFFF;
                border-radius: 999px;
                box-shadow: 0 2px 8px rgba(15, 23, 42, 0.1);
                transition: transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
                z-index: 1;
            }
            .builder-mode-slider[data-mode="manual"] .builder-mode-indicator {
                transform: translateX(0);
            }
            .builder-mode-slider[data-mode="helper"] .builder-mode-indicator {
                transform: translateX(100%);
            }
            .builder-mode-slider[data-mode="auto"] .builder-mode-indicator {
                transform: translateX(200%);
            }
        `;
        document.head.appendChild(style);    }

    // ==================== CAMPISTRY ME LINK BANNER ====================

    // Campistry Me link is now in the header (index.html)

   // ==================== UI RENDERING ====================
    
    function renderBuilderModeSlider() {
        if (document.getElementById('builder-mode-container')) return;

        const globalData = window.loadGlobalSettings?.() || {};
        const currentMode = globalData.app1?.builderMode || 'manual';

        const wrapper = document.createElement('div');
        wrapper.id = 'builder-mode-container';
        wrapper.className = 'builder-mode-wrapper';

        wrapper.innerHTML = `
            <div class="builder-mode-slider" id="builderModeSlider" data-mode="${currentMode}">
                <div class="builder-mode-indicator"></div>
                <div class="builder-mode-option ${currentMode === 'manual' ? 'active' : ''}" data-target="manual">Manual Builder</div>
                <div class="builder-mode-option ${currentMode === 'helper' ? 'active' : ''}" data-target="helper">Helper Mode</div>
                <div class="builder-mode-option ${currentMode === 'auto' ? 'active' : ''}" data-target="auto">Auto Builder</div>
            </div>
        `;

        wrapper.querySelectorAll('.builder-mode-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                const targetMode = e.currentTarget.dataset.target;
                const slider = document.getElementById('builderModeSlider');
                
                // Update UI visually
                slider.dataset.mode = targetMode;
                wrapper.querySelectorAll('.builder-mode-option').forEach(o => o.classList.remove('active'));
                e.currentTarget.classList.add('active');

               // Save setting globally
                const g = window.loadGlobalSettings?.() || {};
                if (!g.app1) g.app1 = {};
                g.app1.builderMode = targetMode;
                window.saveGlobalSettings?.('app1', g.app1);
                window.forceSyncToCloud?.();
                
                // ★ Notify loaded modules so they re-init with the new mode
                // This clears stale window._daBuilderMode and forces proper data loading
                window.dispatchEvent(new CustomEvent('campistry-builder-mode-changed', { 
                    detail: { mode: targetMode } 
                }));
            });
        });

        // ★ Sync slider UI if cloud hydration arrives after initial render
        window.addEventListener('campistry-cloud-hydrated', () => {
            const slider = document.getElementById('builderModeSlider');
            if (!slider) return;
            const freshMode = window.loadGlobalSettings?.()?.app1?.builderMode || 'manual';
            if (slider.dataset.mode !== freshMode) {
                slider.dataset.mode = freshMode;
                slider.querySelectorAll('.builder-mode-option').forEach(o => {
                    o.classList.toggle('active', o.dataset.target === freshMode);
                });
                window.dispatchEvent(new CustomEvent('campistry-builder-mode-changed', {
                    detail: { mode: freshMode }
                }));
            }
        });

        // Safely inject it above the main setup grid layout
        const divBtns = document.getElementById("divisionButtons");
        if (divBtns) {
            let layoutContainer = divBtns.parentElement;
            // Traverse up to find the main flex container holding the sidebar and right pane
            while (layoutContainer && layoutContainer.tagName !== 'BODY') {
                const style = window.getComputedStyle(layoutContainer);
                if (style.display === 'flex' || style.display === 'grid') {
                    break;
                }
                layoutContainer = layoutContainer.parentElement;
            }
            if (layoutContainer && layoutContainer.tagName !== 'BODY') {
                layoutContainer.parentNode.insertBefore(wrapper, layoutContainer);
            } else {
                divBtns.parentNode.insertBefore(wrapper, divBtns);
            }
        }
    }
    
    /**
     * Render grade cards in the left panel, grouped by parent division
     */
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No grades yet. <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Open Campistry Me</a> to create divisions, grades, and bunks.
                </p>
            `;
            renderDivisionDetailPane();
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
       // Parent-group order = the Me page order. Derive it from getUserDivisionOrder
       // (the single source of truth for column order) so this "Scheduling Grades"
       // view matches Camp Structure exactly instead of re-sorting parents by the
       // number inside their first grade (which diverged from Me for named divisions
       // like Camp Agudah / Day Camp). state.divisions is already keyed in
       // getUserDivisionOrder order; dedupe its parents to get the group order.
        const _orderedGradeKeys = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(Object.keys(state.divisions))
            : Object.keys(state.divisions);
        const _seenParents = new Set();
        const groupOrder = [];
        _orderedGradeKeys.forEach(gradeKey => {
            const parent = (state.divisions[gradeKey] && state.divisions[gradeKey].parentDivision) || 'All';
            if (!_seenParents.has(parent)) { _seenParents.add(parent); groupOrder.push(parent); }
        });
        // Defensive: include any groups that have no grades in state.divisions.
        Object.keys(state.divisionGroups).forEach(p => {
            if (!_seenParents.has(p)) { _seenParents.add(p); groupOrder.push(p); }
        });
        
        groupOrder.forEach(parentDivName => {
            const group = state.divisionGroups[parentDivName];
            if (!group || !group.grades?.length) return;
            
            // Parent division header (only show if there are real named groups)
            if (parentDivName !== "All") {
                const groupHeader = document.createElement("div");
                groupHeader.className = "parent-division-label";
                groupHeader.innerHTML = `
                    <span class="parent-division-dot" style="background-color:${escapeHtml(group.color)};"></span>
                    ${escapeHtml(parentDivName)}
                `;
                fragment.appendChild(groupHeader);
            }
            
           // Grade cards within this parent division — preserve user-defined
           // order from campStructure (set via drag-and-drop in Campistry Me).
            const sortedGrades = [...group.grades];
            sortedGrades.forEach(gradeName => {
                const divObj = state.divisions[gradeName];
                if (!divObj) return;
                
                const card = document.createElement("div");
                card.className = "division-card";
                if (state.selectedDivision === gradeName) {
                    card.classList.add("selected");
                }
                
                card.addEventListener("click", () => {
                    state.selectedDivision = gradeName;
                    saveData();
                    setupDivisionButtons();
                    renderDivisionDetailPane();
                });
                
                const color = divObj.color || DEFAULT_COLORS[0];
                const hasTime = divObj.startTime && divObj.endTime;
                
                card.innerHTML = `
                    <div class="division-card-top">
                        <div class="division-pill" style="background-color:${escapeHtml(color)}">
                            ${escapeHtml(gradeName)}
                        </div>
                    </div>
                    <div class="division-card-subline">
                        ${hasTime
                            ? `<span style="color:#0D7C5C; font-weight:500;">${escapeHtml(divObj.startTime)} – ${escapeHtml(divObj.endTime)}</span>`
                            : `<span style="color:#D97706; font-style:italic;">No times set</span>`}
                    </div>
                `;
                
                fragment.appendChild(card);
            });
        });
        
        container.appendChild(fragment);
        renderDivisionDetailPane();
    }
    
    /**
     * Render grade detail pane — times are editable, structure is read-only
     */
    function renderDivisionDetailPane() {
        const pane = document.getElementById("division-detail-pane");
        if (!pane) return;
        
        pane.innerHTML = "";
        
        if (!state.selectedDivision || !state.divisions[state.selectedDivision]) {
            pane.innerHTML = `
                <p class="muted" style="padding: 20px 0; text-align: center;">
                    Select a grade on the left to configure its <strong>times</strong>
                    and view its <strong>bunks</strong>.
                </p>
            `;
            return;
        }
        
        const gradeName = state.selectedDivision;
        const divObj = state.divisions[gradeName];
        const parentDiv = divObj.parentDivision || "";
        
        // ====== CONTENT ======
        pane.innerHTML = `
            <div class="division-edit-grid">
                <!-- TIMES CARD (editable) -->
                <div class="division-mini-card">
                    <div class="division-mini-header"><span>Grade Times</span></div>
                    <p class="division-mini-help">Set the daily time window for this grade.</p>
                    <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                        <input id="time-start-input" value="${escapeHtml(divObj.startTime || "9:00am")}" placeholder="9:00am" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                        <span style="color:#9CA3AF;">to</span>
                        <input id="time-end-input" value="${escapeHtml(divObj.endTime || "4:00pm")}" placeholder="4:00pm" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                        <button id="save-times-btn" style="background:#111827; color:white; border:none; padding:5px 14px; border-radius:8px; font-size:0.8rem; cursor:pointer; font-weight:500;">Save Times</button>
                        ${parentDiv ? `<button id="apply-times-all-btn" style="background:#F3F4F6; color:#374151; border:1px solid #D1D5DB; padding:5px 14px; border-radius:8px; font-size:0.78rem; cursor:pointer; font-weight:500;" title="Apply these times to all grades in ${escapeHtml(parentDiv)}">Apply to All in ${escapeHtml(parentDiv)}</button>` : ''}
                    </div>
                </div>
                
                <!-- BUNKS (read-only) -->
                <div class="division-mini-card">
                    <div class="division-mini-header"><span>Bunks</span></div>
                    <p class="division-mini-help">Bunks in this grade. <a href="campistry_me.html" style="color:#7C3AED; font-weight:500;">Edit in Campistry Me</a></p>
                    <div id="bunk-list" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                </div>
            </div>
        `;
        
        // ====== WIRE UP: Times ======
        const startInput = pane.querySelector("#time-start-input");
        const endInput = pane.querySelector("#time-end-input");
        const saveTimesBtn = pane.querySelector("#save-times-btn");
        const applyAllBtn = pane.querySelector("#apply-times-all-btn");
        
        const saveTimes = () => {
            const rawStart = (startInput?.value || "").trim();
            const rawEnd = (endInput?.value || "").trim();
            
            // Allow clearing both times
            if (!rawStart && !rawEnd) {
                divObj.startTime = "";
                divObj.endTime = "";
                syncSpine();
                saveData();
                setupDivisionButtons();
                renderDivisionDetailPane();
                return;
            }
            
            // Both must be provided
            if (!rawStart || !rawEnd) {
                alert("Please enter both a start and end time, or leave both empty.");
                return;
            }
            
            // Validate format
            const startMin = parseTimeToMinutes(rawStart);
            const endMin = parseTimeToMinutes(rawEnd);
            
            if (startMin === null) {
                alert("Invalid start time format. Use format like 9:00am or 2:30pm");
                startInput?.focus();
                return;
            }
            if (endMin === null) {
                alert("Invalid end time format. Use format like 9:00am or 2:30pm");
                endInput?.focus();
                return;
            }
            
            // End must be after start
            if (endMin <= startMin) {
                alert("End time must be after start time.");
                endInput?.focus();
                return;
            }
            
            divObj.startTime = rawStart;
            divObj.endTime = rawEnd;
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        };
        
        saveTimesBtn?.addEventListener("click", saveTimes);
        startInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        endInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        
        // "Apply to All in Division" — sets same times for all sibling grades
       
            
           applyAllBtn?.addEventListener("click", () => {
            const newStart = (startInput?.value || "").trim();
            const newEnd = (endInput?.value || "").trim();
            if (!newStart || !newEnd) {
                alert("Please enter both a start and end time before applying to all.");
                return;
            }
            
            const startMin = parseTimeToMinutes(newStart);
            const endMin = parseTimeToMinutes(newEnd);
            
            if (startMin === null) {
                alert("Invalid start time format. Use format like 9:00am or 2:30pm");
                return;
            }
            if (endMin === null) {
                alert("Invalid end time format. Use format like 9:00am or 2:30pm");
                return;
            }
            if (endMin <= startMin) {
                alert("End time must be after start time.");
                return;
            }
            
            const group = state.divisionGroups[parentDiv];
            if (!group) return;
            
            group.grades.forEach(siblingGrade => {
                const sibling = state.divisions[siblingGrade];
                if (sibling) {
                    sibling.startTime = newStart;
                    sibling.endTime = newEnd;
                }
            });
            
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        });
        
        // ====== BUNK LIST (read-only pills) ======
        const bunkList = pane.querySelector("#bunk-list");
        if (bunkList) {
            if (!divObj.bunks?.length) {
                bunkList.innerHTML = '<p class="muted">No bunks assigned yet.</p>';
            } else {
                // Preserve user-defined bunk order (drag-and-drop in Campistry Me)
                const sorted = [...divObj.bunks];
                sorted.forEach(bunkName => {
                    const meta = state.bunkMetaData[bunkName] || { size: 0 };
                    const pill = document.createElement("span");
                    pill.className = "division-bunk-pill";
                    pill.style.cursor = "default";
                    pill.innerHTML = `
                        ${escapeHtml(bunkName)} 
                        <span class="bunk-size-badge">${meta.size || 0}</span>
                    `;
                    bunkList.appendChild(pill);
                });
            }
        }
    }

    // ==================== PERSISTENCE ====================
    
    function saveData() {
        const app1Data = window.loadGlobalSettings?.()?.app1 || {};

        const data = {
            ...app1Data,
            bunks: state.bunks,
            divisions: state.divisions,
            availableDivisions: state.availableDivisions,
            selectedDivision: state.selectedDivision,
            allSports: state.allSports,
            savedSkeletons: state.savedSkeletons,
            skeletonAssignments: state.skeletonAssignments,
            specialActivities: state.specialActivities,
            bunkMetaData: state.bunkMetaData,
            // sportMetaData is written by facilities.js — prefer the fresh storage
            // value so that app1 saves don't overwrite facilities.js changes.
            sportMetaData: app1Data.sportMetaData || state.sportMetaData,
            divisionGroups: state.divisionGroups
        };
        // ★ camperRoster is owned exclusively by Campistry Me. If Flow ever loads
        //   before Me's CSV-import sync arrives (or before hydrateFromCloud
        //   completes), app1Data.camperRoster is empty/missing and the spread
        //   above silently propagates that. The downstream cloud merge replaces
        //   app1 wholesale, so Flow's stale-empty camperRoster wipes the
        //   freshly imported 480-camper roster from cloud. Drop the key here so
        //   the cloud-side merge in executeBatchSync preserves whatever Me last
        //   wrote.
        delete data.camperRoster;

        window.saveGlobalSettings?.("app1", data);

        updateWindowApp1();
    }
    
    function loadData(opts) {
        var _opts = opts || {};
        const globalData = window.loadGlobalSettings?.() || {};
        const data = globalData.app1 || {};
        const campStructure = globalData.campStructure || {};
        
        try {
            const existingTimes = {};
            if (data.divisions) {
                Object.entries(data.divisions).forEach(([name, div]) => {
                    if (div?.startTime || div?.endTime) {
                        existingTimes[name] = {
                            startTime: div.startTime || "",
                            endTime: div.endTime || ""
                        };
                    }
                });
            }
            
            if (Object.keys(campStructure).length > 0) {
                console.log("[app1 v5.2] Loading GRADES as scheduling units from campStructure");
                const gradeBasedDivisions = {};
                const allBunks = [];
                const divGroups = {};
                
                const gradeNameCounts = {};
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    Object.keys(divData.grades || {}).forEach(gradeName => {
                        gradeNameCounts[gradeName] = (gradeNameCounts[gradeName] || 0) + 1;
                    });
                });

                // Count bunk name occurrences across ALL grades to detect cross-grade collisions
                const bunkNameCounts = {};
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    Object.entries(divData.grades || {}).forEach(([, gradeData]) => {
                        (gradeData.bunks || []).forEach(b => {
                            bunkNameCounts[b] = (bunkNameCounts[b] || 0) + 1;
                        });
                    });
                });

                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;

                    const parentColor = divData.color || getNextUniqueDivisionColor(gradeBasedDivisions);
                    const allGrades = Object.keys(divData.grades || {});
                    const ord = divData.gradeOrder;
                    const gradeNames = Array.isArray(ord) && ord.length
                        ? ord.filter(g => g in (divData.grades || {})).concat(allGrades.filter(g => !ord.includes(g)))
                        : allGrades;

                    divGroups[divName] = { color: parentColor, grades: [] };

                    gradeNames.forEach(gradeName => {
                        const gradeData = divData.grades[gradeName];
                        const rawBunks = gradeData.bunks || [];

                        const key = gradeNameCounts[gradeName] > 1
                            ? `${divName} > ${gradeName}`
                            : gradeName;

                        if (gradeNameCounts[gradeName] > 1) {
                            console.warn(`[app1 v5.2] Grade "${gradeName}" exists in multiple divisions — using "${key}"`);
                        }

                        // Qualify bunk names that appear in more than one grade to prevent
                        // key collisions in scheduleAssignments (e.g. Grade 1 "Bunk 1" vs Grade 2 "Bunk 1")
                        const bunks = rawBunks.map(b => bunkNameCounts[b] > 1 ? `${key}:${b}` : b);
                        if (bunks.some((b, i) => b !== rawBunks[i])) {
                            console.warn(`[app1 v5.2] Grade "${key}" has bunk name conflicts — qualified:`, bunks);
                        }

                        bunks.forEach(b => { if (!allBunks.includes(b)) allBunks.push(b); });

                        const times = existingTimes[key] || existingTimes[gradeName] || existingTimes[divName] || {};

                        gradeBasedDivisions[key] = {
                            startTime: times.startTime || "",
                            endTime: times.endTime || "",
                            // Honor the user-defined bunk order from campStructure
                            // (set via drag-and-drop in Campistry Me) verbatim.
                            bunks: [...bunks],
                            color: parentColor,
                            parentDivision: divName
                        };
                        // ★ Per-day presence (set per grade in the Campistry Me grade
                        //   editor). When present, the grade's column is hidden in the
                        //   date-specific schedule views on weekdays not in the list.
                        if (Array.isArray(gradeData.daysPresent)) {
                            gradeBasedDivisions[key].daysPresent = gradeData.daysPresent.slice();
                        }

                        divGroups[divName].grades.push(key);
                    });
                });
                
                state.divisions = gradeBasedDivisions;
                state.bunks = allBunks;
                // Preserve user-defined grade order from campStructure
                // (set via drag-and-drop in Campistry Me).
                state.divisionGroups = divGroups;
                
            } else {
                console.log("[app1 v5.2] No campStructure found, falling back to flat divisions");
                const globalDivisions = window.getGlobalDivisions?.() || {};
                const globalBunks = window.getGlobalBunks?.() || [];
                
                if (Object.keys(globalDivisions).length > 0) {
                    state.divisions = deepClone(globalDivisions);
                } else if (data.divisions && Object.keys(data.divisions).length > 0) {
                    state.divisions = deepClone(data.divisions);
                } else {
                    state.divisions = {};
                }
                
                if (globalBunks.length > 0) {
                    state.bunks = deepClone(globalBunks);
                } else if (data.bunks?.length > 0) {
                    state.bunks = deepClone(data.bunks);
                } else {
                    state.bunks = [];
                }
                
                const validDivisions = {};
                Object.entries(state.divisions).forEach(([divName, div]) => {
                    if (typeof div !== 'object' || div === null) return;
                    validDivisions[divName] = {
                        startTime: div.startTime || "",
                        endTime: div.endTime || "",
                        bunks: Array.isArray(div.bunks) ? div.bunks.slice() : [],
                        color: div.color || getNextUniqueDivisionColor(validDivisions),
                        // Preserve legacy grouping fields so divisionGroups stays intact.
                        parentDivision: div.parentDivision || null
                    };
                });
                state.divisions = validDivisions;

                // Preserve the user's existing groupings if present in the cloud
                // payload (legacy app1.divisionGroups). Otherwise reconstruct
                // groups from parentDivision references, and finally fall back
                // to a single "All" bucket.
                if (data.divisionGroups && typeof data.divisionGroups === 'object' && Object.keys(data.divisionGroups).length > 0) {
                    state.divisionGroups = deepClone(data.divisionGroups);
                } else {
                    const reconstructedGroups = {};
                    Object.entries(state.divisions).forEach(([divName, div]) => {
                        const parent = div.parentDivision || 'All';
                        if (!reconstructedGroups[parent]) {
                            reconstructedGroups[parent] = { color: div.color || '#6B7280', grades: [] };
                        }
                        reconstructedGroups[parent].grades.push(divName);
                    });
                    state.divisionGroups = Object.keys(reconstructedGroups).length > 0
                        ? reconstructedGroups
                        : { "All": { color: "#6B7280", grades: Object.keys(state.divisions) } };
                }
            }
            
            // Order the grade-keyed scheduling units by the user's Campistry Me
            // PRIORITY order — this is the canonical base state.availableDivisions
            // that drives the solver's division processing order, so it must stay on
            // _getMeDivisionOrder (NOT the display getUserDivisionOrder). The UI-only
            // column reorder (app1.viewColumnOrder) is applied per-view at render time
            // by getUserDivisionOrder, so it never shifts the solver's processing
            // order. _getMeDivisionOrder is parent-order-stable against JSONB key
            // normalization and rebuilds qualified "Parent > Grade" keys.
            const sortedDivKeys = (typeof window._getMeDivisionOrder === 'function')
                ? window._getMeDivisionOrder(Object.keys(state.divisions))
                : Object.keys(state.divisions);
            const sortedDivisions = {};
            sortedDivKeys.forEach(k => { sortedDivisions[k] = state.divisions[k]; });
            state.divisions = sortedDivisions;

            state.availableDivisions = sortedDivKeys;
            state.specialActivities = data.specialActivities || [];            state.bunkMetaData = data.bunkMetaData || {};
            state.sportMetaData = data.sportMetaData || {};
            state.selectedDivision = data.selectedDivision || state.availableDivisions[0] || null;
            state.allSports = Array.isArray(data.allSports) ? data.allSports : [...DEFAULT_SPORTS];
            state.savedSkeletons = data.savedSkeletons || {};
            state.skeletonAssignments = data.skeletonAssignments || {};
            
            // Recompute bunk sizes from the live camperRoster every load.
            // This is the bridge from Campistry Me's roster → Flow's
            // bunkMetaData[bunk].size, which the sport player-count rules
            // and shared-field capacity checks consume. It runs on every
            // app1.loadData (cloud-hydrate, page reload, cross-tab storage
            // event), so Flow always gets fresh counts even when Me was
            // never opened in the current session.
            const camperRoster = data.camperRoster || {};
            const bunkCounts = {};
            Object.values(camperRoster).forEach(camper => {
                if (camper?.bunk) {
                    bunkCounts[camper.bunk] = (bunkCounts[camper.bunk] || 0) + 1;
                }
            });
            const rosterIsPopulated = Object.keys(camperRoster).length > 0;
            // Set size for bunks that have campers
            Object.entries(bunkCounts).forEach(([bunk, count]) => {
                if (!state.bunkMetaData[bunk]) state.bunkMetaData[bunk] = {};
                state.bunkMetaData[bunk].size = count;
            });
            // Zero out sizes for known bunks with no campers — but ONLY when
            // the roster is actually populated. If roster is totally empty
            // (e.g. cloud not yet hydrated, or new camp with no CSV imported
            // yet), preserve any manually-configured sizes instead of
            // wiping them.
            if (rosterIsPopulated) {
                (state.bunks || []).forEach(b => {
                    if (!(b in bunkCounts)) {
                        if (!state.bunkMetaData[b]) state.bunkMetaData[b] = {};
                        state.bunkMetaData[b].size = 0;
                    }
                });
            }

            // Apply manually-entered kid counts. A manual count always overrides
            // the roster-derived count so the user can correct the number without
            // re-importing a CSV. Bunks with no manual count fall back to roster.
            const bunkManualCounts = (globalData.campistryMe || {}).bunkManualCounts || {};
            Object.entries(bunkManualCounts).forEach(([bunk, count]) => {
                if (typeof count !== 'number') return;
                if (!state.bunkMetaData[bunk]) state.bunkMetaData[bunk] = {};
                state.bunkMetaData[bunk].size = count;
            });

            const orphanedBunks = Object.keys(bunkCounts).filter(b => !state.bunks.includes(b));
            if (orphanedBunks.length > 0) {
                console.warn('[app1] Campers assigned to bunks not found in any grade:', orphanedBunks);
            }
            
            updateWindowApp1();

            // Only sync back to global store on initial / user-driven loads.
            // When refreshing from storage/cloud, the data just came FROM
            // the store — writing it back creates a cloud-sync feedback loop
            // (saveGlobalSettings → cloud sync → hydrated event → refresh → repeat).
            if (!_opts.skipSync) {
                syncSpine();
            }

            console.log(`[app1 v5.2] Loaded ${state.availableDivisions.length} grades as scheduling units:`, state.availableDivisions);

        } catch (e) {
            console.error("Error loading app1 data:", e);
        }
    }
    
    function updateWindowApp1() {
        window.app1 = {
            get divisions() { return state.divisions; },
            get bunks() { return state.bunks; },
            get availableDivisions() { return state.availableDivisions; },
            startTime: "9:00am",
            endTime: "4:00pm",
            defaultDurations: { ...DEFAULT_DURATIONS },
            increments: 30,
            get activities() { return state.specialActivities; },
            get bunkMetaData() { return state.bunkMetaData; },
            get sportMetaData() { return state.sportMetaData; },
            get divisionGroups() { return state.divisionGroups; }
        };
        
        window.divisions = state.divisions;
        window.availableDivisions = state.availableDivisions;
        window.bunks = state.bunks;
        window.allSports = state.allSports;
    }



    // ==================== INITIALIZATION ====================
    
   function initApp1() {
        ensureSharedSetupStyles();
        loadData();
        
        // Render the top builder mode slider
        renderBuilderModeSlider();
        
        // Style detail pane
        const detailPane = document.getElementById("division-detail-pane");
        if (detailPane) {
            detailPane.classList.add("detail-pane");
            detailPane.style.marginTop = "8px";
        }
        
        // --- Wire up the Erase All Button ---
        const eraseAllBtn = document.getElementById("eraseAllBtn");
        if (eraseAllBtn) {
            const newBtn = eraseAllBtn.cloneNode(true);
            eraseAllBtn.parentNode.replaceChild(newBtn, eraseAllBtn);
            
            newBtn.addEventListener("click", async () => {
                if (!window.AccessControl?.canEraseAllCampData?.()) {
                    window.AccessControl?.showPermissionDenied?.('erase all camp data');
                    return;
                }
                if (confirm("⚠️ WARNING: This will delete ALL camp data, divisions, bunks, and schedules.\n\nThis action cannot be undone.\n\nAre you sure?")) {
                    const confirm2 = confirm("Are you absolutely sure? All data will be lost forever.");
                    if (confirm2) {
                        if (window.resetCloudState) {
                            newBtn.textContent = "Erasing...";
                            newBtn.disabled = true;
                            newBtn.style.opacity = "0.7";
                            
                            const success = await window.resetCloudState();
                            
                            if (success) {
                                alert("All data erased successfully.");
                                window.location.reload();
                            } else {
                                alert("Error erasing data from cloud. Please check connection.");
                                newBtn.textContent = "Erase All Camp Data";
                                newBtn.disabled = false;
                                newBtn.style.opacity = "1";
                            }
                        } else {
                            localStorage.clear();
                            window.location.reload();
                        }
                    }
                }
            });
        }
        
       // Initial render
        setupDivisionButtons();
        renderDivisionDetailPane();
        
        const modeToggleEl = document.getElementById('schedule-mode-toggle');
        if (modeToggleEl) window.renderAutoModeToggle?.(modeToggleEl);
        console.log(`[app1] v${VERSION} initialized — grades are scheduling units`);
    }

    // Refresh primitive — re-reads divisions/grades/bunks/campers from the
    // shared store (populated by Campistry Me) and re-renders the setup UI.
    // Debounced so bursts of storage events collapse into a single render.
    let _app1RefreshTimer = null;
    function refreshApp1FromStorage(reason) {
        try {
            // When refreshing FROM storage/cloud, skip syncSpine() —
            // data was just read from the shared store so writing it
            // back triggers a cloud-sync → hydrated → refresh loop.
            loadData({ skipSync: true });
            setupDivisionButtons();
            renderDivisionDetailPane();
            console.log('[app1] refreshed (' + (reason || 'unknown') + ')');
        } catch (e) {
            console.warn('[app1] refresh failed:', e);
        }
    }
    function scheduleApp1Refresh(reason) {
        if (_app1RefreshTimer) clearTimeout(_app1RefreshTimer);
        _app1RefreshTimer = setTimeout(function () {
            _app1RefreshTimer = null;
            refreshApp1FromStorage(reason);
        }, 200);
    }
    window.refreshApp1FromStorage = refreshApp1FromStorage;

    // Layer A — cross-tab: Me in tab 1, Flow in tab 2, same browser.
    window.addEventListener('storage', function (e) {
        if (e.key === 'campGlobalSettings_v1' || e.key === 'CAMPISTRY_LOCAL_CACHE') {
            scheduleApp1Refresh('storage:' + e.key);
        }
    });
    // Layer B bridge — cloud hydration (including realtime-triggered re-hydrate)
    // updates globals; re-render the setup UI to match.
    window.addEventListener('campistry-cloud-hydrated', function () {
        scheduleApp1Refresh('cloud-hydrated');
    });

    // ==================== WINDOW EXPORTS ====================
    window.initApp1 = initApp1;
    
    window.getDivisions = () => state.divisions;
    window.getBunkMetaData = () => state.bunkMetaData;
    // Read fresh from storage so facilities.js changes are always visible
    window.getSportMetaData = () => {
        const fresh = window.loadGlobalSettings?.()?.app1?.sportMetaData;
        return fresh || state.sportMetaData;
    };
    window.getGlobalSpecialActivities = () => state.specialActivities;
    window.getAllGlobalSports = () => [...state.allSports].sort();
    window.getSavedSkeletons = () => state.savedSkeletons || {};
    window.getSkeletonAssignments = () => state.skeletonAssignments || {};
    
    window.getDivisionGroups = () => state.divisionGroups;
    window.getCampStructure = () => {
        const globalData = window.loadGlobalSettings?.() || {};
        return globalData.campStructure || {};
    };
    window.getParentDivision = (gradeName) => {
        return state.divisions[gradeName]?.parentDivision || null;
    };
    
    window.addGlobalSport = (sportName) => {
        if (!sportName) return;
        const s = sportName.trim();
        if (s && !state.allSports.find(sp => sp.toLowerCase() === s.toLowerCase())) {
            state.allSports.push(s);
            saveData();
        }
    };

    window.removeGlobalSport = (sportName) => {
        if (!sportName) return;
        const idx = state.allSports.findIndex(sp =>
            sp.toLowerCase() === sportName.toLowerCase()
        );
        if (idx !== -1) {
            state.allSports.splice(idx, 1);
            saveData();
            window.forceSyncToCloud?.();
            if (typeof window.cleanupDeletedSport === 'function') {
                window.cleanupDeletedSport(sportName);
            }
        }
    };
    
    window.saveSkeleton = (name, skeletonData) => {
        if (!name || !skeletonData) return;
        state.savedSkeletons[name] = skeletonData;
        saveData();
    };
    
    window.deleteSkeleton = (name) => {
        if (!name) return;
        delete state.savedSkeletons[name];
        Object.keys(state.skeletonAssignments).forEach(day => {
            if (state.skeletonAssignments[day] === name) {
                delete state.skeletonAssignments[day];
            }
        });
        saveData();
    };
    
    window.saveSkeletonAssignments = (assignments) => {
        if (!assignments) return;
        state.skeletonAssignments = assignments;
        saveData();
    };
    
    window.saveGlobalSpecialActivities = (updatedActivities) => {
        // ★ Defensive dedupe. Previously cloud-sync races could produce
        //   thousands of duplicate rows for the same special (one user hit
        //   216× per rainy-only entry). De-dup by name here so corruption
        //   can't survive a save round-trip.
        //   ★ Now CASE-INSENSITIVE (shared helper) so a casing-drift duplicate
        //   ("Sushi"/"sushi") is healed too — the old exact-name dedupe let both
        //   survive and the unrestricted phantom copy defeated the user's access
        //   restriction. The helper prefers the restricted/real row.
        const _input = Array.isArray(updatedActivities) ? updatedActivities : [];
        const cleaned = window.dedupeSpecialsByName
            ? window.dedupeSpecialsByName(_input)
            : (() => { const m = new Map(); for (const a of _input) { if (a && a.name) { const k = String(a.name).trim().toLowerCase(); if (!m.has(k)) m.set(k, a); } } return [...m.values()]; })();
        if (cleaned.length !== _input.length) {
            console.warn('[saveGlobalSpecialActivities] de-duplicated', _input.length - cleaned.length, 'rows');
        }

        state.specialActivities = cleaned;
        saveData();
        // Also write the root-level key that all readers check first —
        // without this, the cloud_sync_helpers version's dual-write is lost
        // once app1 initialises and replaces that function.
        window.saveGlobalSettings?.('specialActivities', cleaned);
        // Sync special_activities.js in-memory cache so getAllSpecialActivities()
        // returns the fresh list immediately without needing a storage reload.
        // The setter defined in special_activities.js accepts an array directly.
        try { window.specialActivities = cleaned; } catch(_) {}
        window.refreshSpecialActivitiesFromStorage?.();
    };
    
    window.addDivisionBunk = (divName, bunkName) => {
        console.warn("[app1] addDivisionBunk is deprecated — manage bunks in Campistry Me");
        return false;
    };
    
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    updateWindowApp1();

})();
