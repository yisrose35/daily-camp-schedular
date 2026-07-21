// =====================================================================
// auto_gen_metrics.js — Auto Builder "Free / gap scoreboard"
// ---------------------------------------------------------------------
// PURPOSE
//   Instrumentation (Tier 0) for the auto scheduler. After every auto
//   generation it measures how much of each bunk's day is REALLY filled
//   with a concrete activity vs. left as dead space, and — crucially —
//   WHY, so later packing/filler changes can be judged by honest numbers
//   instead of by eyeballing a single lucky seed.
//
//   THREE kinds of "not really scheduled" are measured separately:
//
//   1. Free cells        — a materialized slot whose entry is 'Free'
//                          (or a null/empty entry). Bucketed by `_source`.
//   2. Generic placeholders — a GENERIC-LAYOUT tile that was tiled but
//                          never filled with a concrete activity. These
//                          carry `_generic:true` (a filled tile flips to
//                          `_generic:false`, see scheduler_core_auto.js
//                          ~:19898/:19908). They RENDER as a category
//                          name (e.g. "special:uncategorized") so the day
//                          LOOKS full while being empty of real content.
//                          Bucketed by `_subcat`.
//   3. Uncovered minutes — time inside a bunk's active span that no slot
//                          covers at all (the makeBlock sub-floor reject
//                          leaves a physical hole, not a cell).
//
//   Only entries that are none of the above count as `filledMinutes`, so
//   `fillRatePct` reflects CONCRETE fill, not mere materialization.
//
//   Read-only: computes from window.scheduleAssignments +
//   window.divisionTimes[*]._perBunkSlots; never mutates them.
//
// OUTPUT
//   window.__lastGenMetrics = <result object>   (also console table)
//   dispatches 'campistry-autogen-metrics' with { detail: result }
//
// The core computeAutoGenMetrics() is a pure function exported for node
// unit tests (tests/auto_gen_metrics.test.js).
// =====================================================================
(function () {
    'use strict';

    // A slot entry is "Free"/empty when it holds no real activity.
    function isFreeEntry(entry) {
        if (!entry) return true; // null / missing entry == empty slot
        var name = String(entry._activity || entry.event || entry.field || '')
            .toLowerCase().trim();
        return name === '' || name === 'free';
    }

    // A generic-layout placeholder: tiled but never filled with a concrete
    // activity. `_generic:true` is the solver's own marker (a filled tile
    // flips it to false). These render as a category name and fool a naive
    // "is it Free?" check — they are NOT real scheduled content.
    function isPlaceholderEntry(entry) {
        return !!(entry && entry._generic === true);
    }

    // Continuation slots are the tail cells of a multi-slot block — their
    // minutes belong to the (filled) parent activity, so they count as
    // filled time, not as a new block.
    function isContinuation(entry) {
        return !!(entry && (entry.continuation || entry._isTransition));
    }

    function slotDuration(slot) {
        if (!slot) return 0;
        var s = (typeof slot.startMin === 'number') ? slot.startMin : null;
        var e = (typeof slot.endMin === 'number') ? slot.endMin : null;
        if (s == null || e == null || e <= s) return 0;
        return e - s;
    }

    // ------------------------------------------------------------------
    // computeAutoGenMetrics(scheduleAssignments, divisionTimes, opts)
    //   Pure. Returns a metrics object; does not touch its inputs.
    // ------------------------------------------------------------------
    function computeAutoGenMetrics(scheduleAssignments, divisionTimes, opts) {
        opts = opts || {};
        var sched = scheduleAssignments || {};
        var divTimes = divisionTimes || {};
        // Per-division configured day window { divName: { startMin, endMin } }.
        // When present, a bunk's span is measured against this window (the same
        // [dayStart,dayEnd] auto_schedule_grid.js uses to draw "+ Add" cells) so
        // leading/trailing empty time is counted as uncovered — not just the
        // physical holes between materialized slots. When absent for a division,
        // we fall back to the bunk's own slot extent (backward-compatible).
        var dayWindows = opts.dayWindows || {};

        var total = {
            divisions: 0,
            bunks: 0,
            slots: 0,
            filledSlots: 0,
            continuationSlots: 0,
            freeSlots: 0,
            placeholderSlots: 0,
            filledMinutes: 0,
            freeMinutes: 0,
            placeholderMinutes: 0,
            uncoveredMinutes: 0,
            spanMinutes: 0
        };
        var freeBySource = {};        // source -> { count, minutes }
        var placeholderBySubcat = {}; // subcat -> { count, minutes }
        var byDivision = {};          // div    -> {...}
        var worstBunks = [];          // { division, bunk, deadMinutes, ... }

        function addFreeSource(src, minutes) {
            var key = src || '(unlabeled)';
            if (!freeBySource[key]) freeBySource[key] = { count: 0, minutes: 0 };
            freeBySource[key].count += 1;
            freeBySource[key].minutes += minutes;
        }
        function addPlaceholder(subcat, minutes) {
            var key = subcat || '(uncategorized)';
            if (!placeholderBySubcat[key]) placeholderBySubcat[key] = { count: 0, minutes: 0 };
            placeholderBySubcat[key].count += 1;
            placeholderBySubcat[key].minutes += minutes;
        }

        Object.keys(divTimes).forEach(function (divName) {
            var divInfo = divTimes[divName];
            if (!divInfo || !divInfo._perBunkSlots) return; // auto per-bunk grids only
            var perBunk = divInfo._perBunkSlots;
            var bunkIds = Object.keys(perBunk);
            if (!bunkIds.length) return;

            total.divisions += 1;
            // Configured day window for this division (may be undefined).
            var win = dayWindows[divName];
            var winStart = (win && typeof win.startMin === 'number') ? win.startMin : null;
            var winEnd   = (win && typeof win.endMin === 'number') ? win.endMin : null;
            var dv = byDivision[divName] = {
                bunks: 0, freeSlots: 0, freeMinutes: 0,
                placeholderSlots: 0, placeholderMinutes: 0,
                uncoveredMinutes: 0, filledMinutes: 0, spanMinutes: 0, fillRate: 0
            };

            bunkIds.forEach(function (bunk) {
                var slots = perBunk[bunk] || [];
                if (!slots.length) return;
                var entries = sched[bunk] || [];

                total.bunks += 1;
                dv.bunks += 1;

                var bFilled = 0, bFree = 0, bPlaceholder = 0, bCovered = 0;
                var minStart = Infinity, maxEnd = -Infinity;

                for (var i = 0; i < slots.length; i++) {
                    var slot = slots[i];
                    var dur = slotDuration(slot);
                    if (dur <= 0) continue;

                    if (slot.startMin < minStart) minStart = slot.startMin;
                    if (slot.endMin > maxEnd) maxEnd = slot.endMin;
                    bCovered += dur;
                    total.slots += 1;

                    var entry = entries[i];
                    if (isFreeEntry(entry)) {
                        total.freeSlots += 1;
                        total.freeMinutes += dur;
                        bFree += dur;
                        dv.freeSlots += 1;
                        dv.freeMinutes += dur;
                        addFreeSource(entry && entry._source, dur);
                    } else if (isPlaceholderEntry(entry)) {
                        // Tiled but never filled with a concrete activity —
                        // looks full, is empty. NOT counted as filled.
                        total.placeholderSlots += 1;
                        total.placeholderMinutes += dur;
                        bPlaceholder += dur;
                        dv.placeholderSlots += 1;
                        dv.placeholderMinutes += dur;
                        addPlaceholder(entry && (entry._subcat || entry.type), dur);
                    } else if (isContinuation(entry)) {
                        total.continuationSlots += 1;
                        total.filledMinutes += dur;
                        bFilled += dur;
                    } else {
                        total.filledSlots += 1;
                        total.filledMinutes += dur;
                        bFilled += dur;
                    }
                }

                // Reference span = the division's configured day window when we
                // have it, extended to cover any slot that runs outside it (so a
                // block ending after dayEnd never yields negative uncovered). No
                // window configured → fall back to the bunk's own slot extent.
                var spanStart = (winStart != null) ? Math.min(winStart, minStart) : minStart;
                var spanEnd   = (winEnd   != null) ? Math.max(winEnd,   maxEnd)   : maxEnd;
                var span = (spanEnd > spanStart) ? (spanEnd - spanStart) : 0;
                var uncovered = Math.max(0, span - bCovered);

                total.spanMinutes += span;
                total.uncoveredMinutes += uncovered;
                dv.filledMinutes += bFilled;
                dv.uncoveredMinutes += uncovered;
                dv.spanMinutes += span;

                var dead = bFree + bPlaceholder + uncovered;
                if (dead > 0) {
                    worstBunks.push({
                        division: divName, bunk: bunk,
                        deadMinutes: dead, freeMinutes: bFree,
                        placeholderMinutes: bPlaceholder, uncoveredMinutes: uncovered,
                        fillRate: span > 0 ? (bFilled / span) : 1
                    });
                }
            });

            dv.fillRate = dv.spanMinutes > 0 ? (dv.filledMinutes / dv.spanMinutes) : 1;
        });

        var deadTotal = total.freeMinutes + total.placeholderMinutes + total.uncoveredMinutes;
        total.deadMinutes = deadTotal;
        total.fillRate = total.spanMinutes > 0
            ? (total.filledMinutes / total.spanMinutes) : 1;

        worstBunks.sort(function (a, b) { return b.deadMinutes - a.deadMinutes; });

        return {
            total: total,
            fillRatePct: Math.round(total.fillRate * 1000) / 10,
            freeBySource: freeBySource,
            placeholderBySubcat: placeholderBySubcat,
            byDivision: byDivision,
            worstBunks: worstBunks.slice(0, opts.worstLimit || 10)
        };
    }

    // ------------------------------------------------------------------
    // Browser wiring: compute + report on every completed auto generation.
    // ------------------------------------------------------------------
    // Parse a time value (number of minutes, or a "H:MM"/"H:MM AM/PM" string)
    // the same way auto_schedule_grid.js does, so the metric's day window
    // matches the window the grid draws "+ Add" cells against.
    function parseTimeToMin(v) {
        if (typeof v === 'number') return v;
        if (typeof window !== 'undefined') {
            var scu = window.SchedulerCoreUtils && window.SchedulerCoreUtils.parseTimeToMinutes;
            if (scu) { var a = scu(v); if (typeof a === 'number' && !isNaN(a)) return a; }
            var abe = window.AutoBuildEngine && window.AutoBuildEngine.parseTime;
            if (abe) { var b = abe(v); if (typeof b === 'number' && !isNaN(b)) return b; }
        }
        return null;
    }

    // Build { divName: { startMin, endMin } } from the same source the grid
    // uses: window.divisions[divName] first, then the divisionTimes entry,
    // then the 540/960 (9:00 AM – 4:00 PM) defaults.
    function buildDayWindows(divTimes) {
        var out = {};
        if (!divTimes) return out;
        var divisions = (typeof window !== 'undefined' && window.divisions) ? window.divisions : {};
        Object.keys(divTimes).forEach(function (divName) {
            var divInfo = divTimes[divName];
            if (!divInfo || !divInfo._perBunkSlots) return;
            var cfg = divisions[divName] || divInfo || {};
            var start = parseTimeToMin(cfg.startTime);
            var end   = parseTimeToMin(cfg.endTime);
            out[divName] = {
                startMin: (start != null) ? start : 540,
                endMin:   (end   != null) ? end   : 960
            };
        });
        return out;
    }

    function reportMetrics(reason) {
        try {
            var divTimes = (typeof window !== 'undefined') ? window.divisionTimes : null;
            var result = computeAutoGenMetrics(
                (typeof window !== 'undefined') ? window.scheduleAssignments : null,
                divTimes,
                { dayWindows: buildDayWindows(divTimes) }
            );
            if (typeof window !== 'undefined') {
                window.__lastGenMetrics = result;
            }

            var t = result.total;
            var head = '[GenMetrics] real-fill ' + result.fillRatePct + '%  |  '
                + 'free ' + t.freeMinutes + 'min/' + t.freeSlots + '  |  '
                + 'placeholder ' + t.placeholderMinutes + 'min/' + t.placeholderSlots + '  |  '
                + 'empty ' + t.uncoveredMinutes + 'min  |  '
                + 'dead ' + t.deadMinutes + 'min across ' + t.bunks + ' bunks'
                + (reason ? '  (' + reason + ')' : '');
            if (typeof console !== 'undefined') {
                console.log('%c' + head, 'color:#0a7; font-weight:bold;');
                if (t.placeholderSlots > 0 && console.table) {
                    console.log('%c[GenMetrics] generic placeholder tiles (look full, not filled):',
                        'color:#c60;');
                    console.table(Object.keys(result.placeholderBySubcat).map(function (sc) {
                        return { subcategory: sc,
                                 slots: result.placeholderBySubcat[sc].count,
                                 minutes: result.placeholderBySubcat[sc].minutes };
                    }).sort(function (a, b) { return b.minutes - a.minutes; }));
                }
                if (t.freeSlots > 0 && console.table) {
                    console.table(Object.keys(result.freeBySource).map(function (src) {
                        return { reason: src,
                                 slots: result.freeBySource[src].count,
                                 minutes: result.freeBySource[src].minutes };
                    }).sort(function (a, b) { return b.minutes - a.minutes; }));
                }
            }

            if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('campistry-autogen-metrics', { detail: result }));
            }
            return result;
        } catch (e) {
            if (typeof console !== 'undefined') console.warn('[GenMetrics] failed:', e);
            return null;
        }
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
        // Only measure auto-mode generations. `detail.mode === 'auto'` is set
        // by the auto engine on the completion event.
        window.addEventListener('campistry-generation-complete', function (ev) {
            var mode = ev && ev.detail && ev.detail.mode;
            if (mode && mode !== 'auto') return;
            reportMetrics(ev && ev.detail && ev.detail.reason);
        });
        // Manual on-demand trigger for the console: window.__genMetrics()
        window.__genMetrics = function () { return reportMetrics('manual'); };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            computeAutoGenMetrics: computeAutoGenMetrics,
            isFreeEntry: isFreeEntry,
            isPlaceholderEntry: isPlaceholderEntry
        };
    }
})();
