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
        // Uncovered gaps at or below this length are STRUCTURAL slivers — the
        // bell schedule's own inter-period transition breaks (e.g. 12:10-12:15).
        // Nothing can ever be scheduled in them (every activity is longer), so
        // counting them as "dead" makes the headline overstate failure ~3× on a
        // camp whose frame has 5-min breaks. They stay inside uncoveredMinutes/
        // deadMinutes (back-compat) but are ALSO totaled separately so the
        // report can split structural from actionable.
        var sliverMax = (typeof opts.sliverMax === 'number') ? opts.sliverMax : 5;
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
            sliverMinutes: 0,
            spanMinutes: 0
        };
        var freeBySource = {};        // source -> { count, minutes }
        var placeholderBySubcat = {}; // subcat -> { count, minutes }
        var placeholderIvals = {};    // subcat -> [[startMin,endMin], ...] (for peak-concurrency advice)
        var byDivision = {};          // div    -> {...}
        var worstBunks = [];          // { division, bunk, deadMinutes, ... }

        function addFreeSource(src, minutes) {
            var key = src || '(unlabeled)';
            if (!freeBySource[key]) freeBySource[key] = { count: 0, minutes: 0 };
            freeBySource[key].count += 1;
            freeBySource[key].minutes += minutes;
        }
        function addPlaceholder(subcat, minutes, startMin, endMin) {
            var key = subcat || '(uncategorized)';
            if (!placeholderBySubcat[key]) placeholderBySubcat[key] = { count: 0, minutes: 0 };
            placeholderBySubcat[key].count += 1;
            placeholderBySubcat[key].minutes += minutes;
            if (typeof startMin === 'number' && typeof endMin === 'number' && endMin > startMin) {
                (placeholderIvals[key] = placeholderIvals[key] || []).push([startMin, endMin]);
            }
        }

        // Peak simultaneous count of a set of [s,e) intervals — the most that ever
        // overlap at one instant. For placeholder tiles of a subcat, this is roughly
        // how many MORE concurrent seats (distinct activities or shared capacity) the
        // camp would need at its worst moment to fill them with real content.
        function peakConcurrency(ivals) {
            if (!ivals || !ivals.length) return 0;
            var pts = [];
            for (var i = 0; i < ivals.length; i++) {
                pts.push([ivals[i][0], 1]);
                pts.push([ivals[i][1], -1]);
            }
            pts.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); }); // ends before starts at a tie
            var cur = 0, peak = 0;
            for (var j = 0; j < pts.length; j++) { cur += pts[j][1]; if (cur > peak) peak = cur; }
            return peak;
        }

        // The uncovered gaps inside [start,end] not covered by any interval in
        // `ivals` — i.e. WHERE a bunk's empty "+ Add" time actually is. Returns
        // [{startMin,endMin}, ...]. Merges the covered intervals first so touching
        // slots ([600,640),[640,680)) leave no phantom gap between them.
        function gapsIn(start, end, ivals) {
            if (!(end > start)) return [];
            var iv = (ivals || []).slice().sort(function (a, b) { return a[0] - b[0]; });
            var gaps = [], cursor = start;
            for (var i = 0; i < iv.length; i++) {
                var s = iv[i][0], e = iv[i][1];
                if (s > cursor) { gaps.push({ startMin: cursor, endMin: Math.min(s, end) }); }
                if (e > cursor) cursor = e;
                if (cursor >= end) break;
            }
            if (cursor < end) gaps.push({ startMin: cursor, endMin: end });
            return gaps.filter(function (g) { return g.endMin > g.startMin; });
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
                uncoveredMinutes: 0, sliverMinutes: 0,
                filledMinutes: 0, spanMinutes: 0, fillRate: 0,
                // The window this division's fill was measured against, so a
                // surprising gap can be checked against the configured day start.
                dayWindow: (winStart != null && winEnd != null)
                    ? { startMin: winStart, endMin: winEnd, source: 'divisions.startTime/endTime' }
                    : { startMin: null, endMin: null, source: 'bunk-slot-extent (no divisions[div] window)' }
            };

            bunkIds.forEach(function (bunk) {
                var slots = perBunk[bunk] || [];
                if (!slots.length) return;
                var entries = sched[bunk] || [];

                total.bunks += 1;
                dv.bunks += 1;

                var bFilled = 0, bFree = 0, bPlaceholder = 0, bCovered = 0;
                var minStart = Infinity, maxEnd = -Infinity;
                var covIvals = [];   // covered [start,end) intervals, for locating the empty gaps

                for (var i = 0; i < slots.length; i++) {
                    var slot = slots[i];
                    var dur = slotDuration(slot);
                    if (dur <= 0) continue;

                    if (slot.startMin < minStart) minStart = slot.startMin;
                    if (slot.endMin > maxEnd) maxEnd = slot.endMin;
                    covIvals.push([slot.startMin, slot.endMin]);
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
                        addPlaceholder(entry && (entry._subcat || entry.type), dur, slot.startMin, slot.endMin);
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

                // Locate the gaps, then split off structural slivers (≤ sliverMax,
                // e.g. the frame's 5-min transition breaks) from actionable holes.
                var emptyIntervals = (uncovered > 0)
                    ? gapsIn(spanStart, spanEnd, covIvals)
                    : [];
                var bSliver = 0;
                emptyIntervals.forEach(function (g) {
                    var gDur = g.endMin - g.startMin;
                    if (gDur > 0 && gDur <= sliverMax) bSliver += gDur;
                });

                total.spanMinutes += span;
                total.uncoveredMinutes += uncovered;
                total.sliverMinutes += bSliver;
                dv.filledMinutes += bFilled;
                dv.uncoveredMinutes += uncovered;
                dv.sliverMinutes += bSliver;
                dv.spanMinutes += span;

                var dead = bFree + bPlaceholder + uncovered;
                if (dead > 0) {
                    worstBunks.push({
                        division: divName, bunk: bunk,
                        deadMinutes: dead, freeMinutes: bFree,
                        placeholderMinutes: bPlaceholder, uncoveredMinutes: uncovered,
                        sliverMinutes: bSliver,
                        emptyIntervals: emptyIntervals,
                        fillRate: span > 0 ? (bFilled / span) : 1
                    });
                }
            });

            dv.fillRate = dv.spanMinutes > 0 ? (dv.filledMinutes / dv.spanMinutes) : 1;
        });

        var deadTotal = total.freeMinutes + total.placeholderMinutes + total.uncoveredMinutes;
        total.deadMinutes = deadTotal;
        // Actionable dead = dead minus the structural frame slivers nothing can fill.
        total.actionableDeadMinutes = Math.max(0, deadTotal - total.sliverMinutes);
        total.fillRate = total.spanMinutes > 0
            ? (total.filledMinutes / total.spanMinutes) : 1;
        // Fill measured against SCHEDULABLE time (span minus structural slivers) —
        // the number that should read 100% when every fillable minute is filled.
        var schedulableSpan = total.spanMinutes - total.sliverMinutes;
        total.fillRateSchedulable = schedulableSpan > 0
            ? (total.filledMinutes / schedulableSpan) : 1;

        worstBunks.sort(function (a, b) { return b.deadMinutes - a.deadMinutes; });

        // Open slots — tiles the engine DROPPED at emit under honest-open-time
        // (scheduler_core_auto.js [GENERIC-HONEST]): unfillable, so no placeholder
        // was manufactured. Their time already lands in uncoveredMinutes via the
        // day windows — do NOT add it to placeholder totals (that would double-
        // count) — but they carry the one thing the uncovered math can't know:
        // WHICH subcategory the plan wanted there. Fold them into the capacity
        // advice so the warning still names the exact seats that are short.
        var openSlots = Array.isArray(opts.openSlots) ? opts.openSlots : [];
        var openBySubcat = {};  // subcat -> { count, minutes }
        var openIvals = {};     // subcat -> [[s,e], ...]
        openSlots.forEach(function (o) {
            if (!o || typeof o.startMin !== 'number' || typeof o.endMin !== 'number' || o.endMin <= o.startMin) return;
            var key = o.subcat || '(uncategorized)';
            if (!openBySubcat[key]) openBySubcat[key] = { count: 0, minutes: 0 };
            openBySubcat[key].count += 1;
            openBySubcat[key].minutes += (o.endMin - o.startMin);
            (openIvals[key] = openIvals[key] || []).push([o.startMin, o.endMin]);
        });
        total.openSlots = 0;
        total.openMinutes = 0;
        Object.keys(openBySubcat).forEach(function (k) {
            total.openSlots += openBySubcat[k].count;
            total.openMinutes += openBySubcat[k].minutes;
        });

        // Capacity advice — an unfillable slot (a residual placeholder entry, or an
        // emit-dropped open slot) exists ONLY when concurrent demand for a subcategory
        // exceeds the distinct activities/seats the camp actually has (the engine's own
        // SEAT-AUDIT / WEEKLY-MUST shortfalls). `seatsShort` = peak simultaneous
        // unfillable slots of that subcat = roughly how many MORE concurrent seats
        // (distinct activities or shared capacity) would be needed at the worst moment
        // to fill them with real content. This is a CONFIG lever, not a solver one —
        // no reshuffle invents variety that isn't configured.
        var adviceKeys = {};
        Object.keys(placeholderBySubcat).forEach(function (k) { adviceKeys[k] = 1; });
        Object.keys(openBySubcat).forEach(function (k) { adviceKeys[k] = 1; });
        var capacityAdvice = Object.keys(adviceKeys).map(function (sc) {
            var ph = placeholderBySubcat[sc] || { count: 0, minutes: 0 };
            var op = openBySubcat[sc] || { count: 0, minutes: 0 };
            return {
                subcat: sc,
                placeholderSlots: ph.count + op.count,
                placeholderMinutes: ph.minutes + op.minutes,
                seatsShort: peakConcurrency((placeholderIvals[sc] || []).concat(openIvals[sc] || []))
            };
        }).sort(function (a, b) { return b.placeholderMinutes - a.placeholderMinutes; });

        return {
            total: total,
            fillRatePct: Math.round(total.fillRate * 1000) / 10,
            fillRateSchedulablePct: Math.round(total.fillRateSchedulable * 1000) / 10,
            freeBySource: freeBySource,
            placeholderBySubcat: placeholderBySubcat,
            openBySubcat: openBySubcat,
            capacityAdvice: capacityAdvice,
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

    // Minutes-since-midnight → "9:20 AM" for readable console output.
    function fmtTime(min) {
        if (typeof min !== 'number') return String(min);
        var scu = (typeof window !== 'undefined') && window.SchedulerCoreUtils
            && window.SchedulerCoreUtils.minutesToTimeLabel;
        if (scu) { try { return scu(min); } catch (e) {} }
        var h = Math.floor(min / 60), m = min % 60;
        var ap = h >= 12 ? 'PM' : 'AM';
        var h12 = h % 12; if (h12 === 0) h12 = 12;
        return h12 + ':' + (m < 10 ? '0' + m : m) + ' ' + ap;
    }

    function reportMetrics(reason) {
        try {
            var divTimes = (typeof window !== 'undefined') ? window.divisionTimes : null;
            var result = computeAutoGenMetrics(
                (typeof window !== 'undefined') ? window.scheduleAssignments : null,
                divTimes,
                { dayWindows: buildDayWindows(divTimes),
                  // tiles the engine dropped as honest open time ([GENERIC-HONEST]) —
                  // they still drive the capacity advice's per-subcat attribution
                  openSlots: ((typeof window !== 'undefined') && window.__genOpenSlots) || [] }
            );
            if (typeof window !== 'undefined') {
                window.__lastGenMetrics = result;
            }

            var t = result.total;
            var head = '[GenMetrics] real-fill ' + result.fillRatePct + '%'
                + (t.sliverMinutes > 0 ? ' (' + result.fillRateSchedulablePct + '% of schedulable time)' : '')
                + '  |  free ' + t.freeMinutes + 'min/' + t.freeSlots + '  |  '
                + 'placeholder ' + t.placeholderMinutes + 'min/' + t.placeholderSlots + '  |  '
                + 'empty ' + t.uncoveredMinutes + 'min'
                + (t.sliverMinutes > 0 ? ' (' + t.sliverMinutes + 'min = bell-schedule transition slivers, unfillable by design)' : '')
                + '  |  actionable dead ' + t.actionableDeadMinutes + 'min across ' + t.bunks + ' bunks'
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
                // WHERE the empty "+ Add" time is — the surprising kind (a bunk
                // sitting empty before its first activity). Shows the worst few so
                // "why did 1st Grade get dead time?" is answered at a glance.
                // Only bunks with ACTIONABLE empty time (more than the frame's own
                // transition slivers) — otherwise every bunk lists its 5-min breaks
                // and the real holes drown in structural noise.
                var emptyBunks = (result.worstBunks || []).filter(function (b) {
                    return (b.uncoveredMinutes - (b.sliverMinutes || 0)) > 0
                        && b.emptyIntervals && b.emptyIntervals.length;
                });
                if (emptyBunks.length) {
                    console.log('%c[GenMetrics] empty (uncovered) time — no tile at all, measured vs each division\'s day window (transition slivers excluded):',
                        'color:#a30;');
                    emptyBunks.slice(0, 8).forEach(function (b) {
                        var win = result.byDivision[b.division] && result.byDivision[b.division].dayWindow;
                        var winStr = (win && win.startMin != null)
                            ? (' [' + b.division + ' day ' + fmtTime(win.startMin) + '–' + fmtTime(win.endMin) + ']') : '';
                        var real = b.emptyIntervals.filter(function (g) { return (g.endMin - g.startMin) > 5; });
                        var where = real.map(function (g) {
                            return fmtTime(g.startMin) + '–' + fmtTime(g.endMin);
                        }).join(', ');
                        var actionable = b.uncoveredMinutes - (b.sliverMinutes || 0);
                        console.log('   • ' + b.bunk + winStr + ': ' + actionable + 'min empty @ ' + where
                            + ((b.sliverMinutes || 0) > 0 ? ' (+' + b.sliverMinutes + 'min transition slivers)' : ''));
                    });
                }
                // Capacity advice: unfillable slots are a CONFIG lever, not a solver
                // one — the engine already ran fill/surplus/absorb/reorder/seat-enforce
                // and left these open because concurrent demand outran the distinct
                // activities configured. Tell the owner, per subcat, how many more
                // concurrent seats would fill them.
                if (result.capacityAdvice && result.capacityAdvice.length) {
                    var advice = result.capacityAdvice
                        .filter(function (a) { return a.seatsShort > 0; })
                        .map(function (a) {
                            return '+' + a.seatsShort + ' seat(s) of "' + a.subcat + '" '
                                 + '(' + a.placeholderSlots + ' unfillable slot(s)/' + a.placeholderMinutes + 'min)';
                        });
                    if (advice.length) {
                        console.log('%c[GenMetrics] to fill the dead space, add activities/sharing: '
                            + advice.join(' · ')
                            + '  — no reshuffle can fill these; they need more distinct activities or capacity.',
                            'color:#a30; font-weight:bold;');
                    }
                }
                // Impossible floors (engine side-channel): a subcat whose per-day floor
                // exceeds its DISTINCT activities can never be met with repeats off —
                // that's a config contradiction, not a seat shortage, so call it out
                // separately from the +seats advice.
                var floorWarns = (typeof window !== 'undefined' && window.__genFloorWarnings) || [];
                if (floorWarns.length) {
                    var seenFW = {}, fwParts = [];
                    floorWarns.forEach(function (w) {
                        if (!w || !w.subcat) return;
                        var k = w.subcat + '|' + w.floor + '|' + w.avail;
                        if (seenFW[k]) return; seenFW[k] = 1;
                        fwParts.push('"' + w.subcat + '" floor ' + w.floor + ' vs ' + w.avail + ' distinct activit' + (w.avail === 1 ? 'y' : 'ies'));
                    });
                    if (fwParts.length) {
                        console.log('%c[GenMetrics] impossible floors (config, not capacity): ' + fwParts.join(' · ')
                            + '  — with same-day repeats off these floors can NEVER be met; add activities or lower the floors.',
                            'color:#a30; font-weight:bold;');
                    }
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
