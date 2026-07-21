// =====================================================================
// auto_gen_metrics.js — Auto Builder "Free / gap scoreboard"
// ---------------------------------------------------------------------
// PURPOSE
//   Instrumentation (Tier 0) for the auto scheduler. After every auto
//   generation it measures how much of each bunk's day is actually
//   filled vs. left as dead space, and — crucially — WHY each Free slot
//   survived, by bucketing on the `_source` tag the solver stamps on
//   every Free it writes (e.g. 'null-bucket-fill-free', 'iron-gate-
//   time-rule', 'sub-min-sweep', 'fn-floor-enforce-rem', ...).
//
//   This is read-only: it computes from the final in-memory schedule
//   (window.scheduleAssignments + window.divisionTimes[*]._perBunkSlots)
//   and never mutates it. It exists so that later packing/filler changes
//   can be judged by "Free-minutes dropped from X to Y" instead of by
//   eyeballing a single lucky seed.
//
// TWO KINDS OF DEAD SPACE ARE MEASURED
//   1. Free cells        — a materialized slot whose entry is 'Free'
//                          (or a null/empty entry). Bucketed by `_source`.
//   2. Uncovered minutes — time inside a bunk's active span that no slot
//                          covers at all (the makeBlock sub-floor reject
//                          leaves a physical hole, not a Free cell).
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

        var total = {
            divisions: 0,
            bunks: 0,
            slots: 0,
            filledSlots: 0,
            continuationSlots: 0,
            freeSlots: 0,
            filledMinutes: 0,
            freeMinutes: 0,
            uncoveredMinutes: 0,
            spanMinutes: 0
        };
        var freeBySource = {};   // source -> { count, minutes }
        var byDivision = {};     // div    -> { bunks, freeSlots, freeMinutes, uncoveredMinutes, filledMinutes, spanMinutes, fillRate }
        var worstBunks = [];     // { division, bunk, deadMinutes, freeMinutes, uncoveredMinutes, fillRate }

        function addFreeSource(src, minutes) {
            var key = src || '(unlabeled)';
            if (!freeBySource[key]) freeBySource[key] = { count: 0, minutes: 0 };
            freeBySource[key].count += 1;
            freeBySource[key].minutes += minutes;
        }

        Object.keys(divTimes).forEach(function (divName) {
            var divInfo = divTimes[divName];
            if (!divInfo || !divInfo._perBunkSlots) return; // auto per-bunk grids only
            var perBunk = divInfo._perBunkSlots;
            var bunkIds = Object.keys(perBunk);
            if (!bunkIds.length) return;

            total.divisions += 1;
            var dv = byDivision[divName] = {
                bunks: 0, freeSlots: 0, freeMinutes: 0, uncoveredMinutes: 0,
                filledMinutes: 0, spanMinutes: 0, fillRate: 0
            };

            bunkIds.forEach(function (bunk) {
                var slots = perBunk[bunk] || [];
                if (!slots.length) return;
                var entries = sched[bunk] || [];

                total.bunks += 1;
                dv.bunks += 1;

                var bFilled = 0, bFree = 0, bCovered = 0;
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
                    if (isContinuation(entry) && !isFreeEntry(entry)) {
                        total.continuationSlots += 1;
                        total.filledMinutes += dur;
                        bFilled += dur;
                    } else if (isFreeEntry(entry)) {
                        total.freeSlots += 1;
                        total.freeMinutes += dur;
                        bFree += dur;
                        dv.freeSlots += 1;
                        dv.freeMinutes += dur;
                        addFreeSource(entry && entry._source, dur);
                    } else {
                        total.filledSlots += 1;
                        total.filledMinutes += dur;
                        bFilled += dur;
                    }
                }

                var span = (maxEnd > minStart) ? (maxEnd - minStart) : 0;
                var uncovered = Math.max(0, span - bCovered);

                total.spanMinutes += span;
                total.uncoveredMinutes += uncovered;
                dv.filledMinutes += bFilled;
                dv.uncoveredMinutes += uncovered;
                dv.spanMinutes += span;

                var dead = bFree + uncovered;
                if (dead > 0) {
                    worstBunks.push({
                        division: divName, bunk: bunk,
                        deadMinutes: dead, freeMinutes: bFree, uncoveredMinutes: uncovered,
                        fillRate: span > 0 ? (bFilled / span) : 1
                    });
                }
            });

            dv.fillRate = dv.spanMinutes > 0 ? (dv.filledMinutes / dv.spanMinutes) : 1;
        });

        var deadTotal = total.freeMinutes + total.uncoveredMinutes;
        total.deadMinutes = deadTotal;
        total.fillRate = total.spanMinutes > 0
            ? (total.filledMinutes / total.spanMinutes) : 1;

        worstBunks.sort(function (a, b) { return b.deadMinutes - a.deadMinutes; });

        return {
            total: total,
            fillRatePct: Math.round(total.fillRate * 1000) / 10,
            freeBySource: freeBySource,
            byDivision: byDivision,
            worstBunks: worstBunks.slice(0, opts.worstLimit || 10)
        };
    }

    // ------------------------------------------------------------------
    // Browser wiring: compute + report on every completed auto generation.
    // ------------------------------------------------------------------
    function reportMetrics(reason) {
        try {
            var result = computeAutoGenMetrics(
                (typeof window !== 'undefined') ? window.scheduleAssignments : null,
                (typeof window !== 'undefined') ? window.divisionTimes : null,
                {}
            );
            if (typeof window !== 'undefined') {
                window.__lastGenMetrics = result;
            }

            var t = result.total;
            var head = '[GenMetrics] fill ' + result.fillRatePct + '%  |  '
                + 'free ' + t.freeMinutes + 'min/' + t.freeSlots + ' slots  |  '
                + 'uncovered ' + t.uncoveredMinutes + 'min  |  '
                + 'dead ' + t.deadMinutes + 'min across ' + t.bunks + ' bunks'
                + (reason ? '  (' + reason + ')' : '');
            if (typeof console !== 'undefined') {
                console.log('%c' + head, 'color:#0a7; font-weight:bold;');
                if (t.freeSlots > 0 && console.table) {
                    var rows = Object.keys(result.freeBySource).map(function (src) {
                        return {
                            reason: src,
                            slots: result.freeBySource[src].count,
                            minutes: result.freeBySource[src].minutes
                        };
                    }).sort(function (a, b) { return b.minutes - a.minutes; });
                    console.table(rows);
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
        module.exports = { computeAutoGenMetrics: computeAutoGenMetrics, isFreeEntry: isFreeEntry };
    }
})();
