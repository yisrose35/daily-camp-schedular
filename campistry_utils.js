// ═══════════════════════════════════════════════════════════════════════
// CAMPISTRY SHARED UTILS  (window.CampUtils)
// ───────────────────────────────────────────────────────────────────────
// Single source of truth for tiny PURE helpers that were copy-pasted across
// many files over 10 months. Loaded FIRST (before all other app scripts) in
// every HTML, so every file can delegate to it at module-init or render time.
//
// Cleanup doctrine: only PURE, behavior-identical (or supersettable) helpers
// live here. Helpers that legitimately differ per module (e.g. uid() with a
// subsystem prefix, timesOverlap() with different signatures, or anything that
// reads module-specific globals) are intentionally NOT consolidated.
//
// Per-file callers keep their original local function NAME but make the body a
// one-line delegation to CampUtils, so call sites never change.
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var CampUtils = {
        // HTML-escape for safe innerHTML/attribute interpolation. The COMPLETE
        // escaper (escapes & < > " '), so output is safe in BOTH element-body and
        // double/single-quoted attribute contexts. Supersedes the 6+ divergent
        // copies the v2 audit had to harden individually (esc / escHtml /
        // escapeHtml / _escHtml). null/undefined -> ''.
        escapeHtml: function (s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        // ── TIME HELPERS ────────────────────────────────────────────────────
        // Parse a time value to minutes-since-midnight.
        //   Accepts: number (returned as-is), Date, and "H:MM" / "H:MMam" /
        //   "H:MM PM" strings (case-insensitive, optional spaces around ":").
        //   Bare times WITHOUT am/pm are treated as LITERAL 24h ("14:30"->870,
        //   "01:30"->90) — i.e. NO "assume-PM" guessing.
        //   Returns null for unparseable input.
        // Equivalence note (proven via _consolidation_harness across an input
        // battery): for every VALID time string this is byte-identical to the
        // copies in app1 / facilities / rainy_day_manager / cloud_sync_helpers /
        // mobile_touch_drag / print_center / special_activities /
        // midday_rain_stacker / rotation_events. The only differences are that
        // this version ALSO accepts number/Date (a safe superset).
        // INTENTIONALLY NOT the home for the diverging variants — these keep
        // their own bodies: division_times_system & specialty_leagues (assume-PM
        // for afternoon hours), daily_adjustments (REQUIRES am/pm; bare->null),
        // master_schedule_builder (loose split parsing), and the solver canonical
        // SchedulerCoreUtils.parseTimeToMinutes (assume-PM 1-6 + warn).
        parseTimeToMinutes: function (v) {
            if (v == null) return null;
            if (typeof v === 'number') return v;
            if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
            if (typeof v !== 'string') return null;
            var s = v.trim().toLowerCase();
            var mer = null;
            if (s.endsWith('am') || s.endsWith('pm')) {
                mer = s.endsWith('am') ? 'am' : 'pm';
                s = s.replace(/am|pm/gi, '').trim();
            }
            var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
            if (!m) return null;
            var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
            // Reject out-of-range hours, and don't double-shift an already-24h hour that
            // also carries a redundant "pm" (e.g. "13:00pm" → 1 PM, not 25:00). This makes
            // the superset match app1.js's original validation exactly for string inputs;
            // for the other routed files it only changes clearly-malformed input ("25:00",
            // "13:00pm") which never occurs from a time picker — every VALID time is unchanged.
            if (isNaN(hh) || isNaN(mm) || hh > 23 || mm < 0 || mm > 59) return null;
            if (mer) { if (hh === 12) hh = mer === 'am' ? 0 : 12; else if (mer === 'pm' && hh < 12) hh += 12; }
            return hh * 60 + mm;
        },

        // Shared skeleton tile sanitizer — the SAME rules run as a pre-guard (tile
        // editors, on save) and a post-guard (generator, on entry), so corrupt tiles
        // can't enter storage and can't reach the solver if one ever slips through:
        //   • normalize bare times ("6:30" -> "6:30pm"; bare hours 1-6 -> PM, the camp
        //     afternoon heuristic) so no ambiguous time ever reaches the parsers;
        //   • DROP tiles whose times are unparseable or end <= start (e.g. a typo'd
        //     "5:10pm-4:50pm" that can't render but still gets scheduled);
        //   • DROP exact-duplicate tiles (same division + BUNK + activity + start),
        //     keeping the better-formed one. The bunk is part of the identity: an
        //     AUTO-mode skeleton carries one entry PER BUNK (_bunk), so a grade's
        //     shared walls (Davening/Swim/Lunch/Main…) legitimately repeat once per
        //     bunk at the same division+time — those are NOT duplicates. (A dedup
        //     that ignored _bunk silently dropped every bunk's wall but one at save
        //     time — 64 tiles/run live.) Manual tiles carry no _bunk, so their
        //     division-level dedup is byte-identical to before.
        // Already-am/pm times are left byte-identical. Returns
        // { tiles, dropped:[{division,event,startTime,endTime,reason}], normalized }.
        // Pure and defensive — never throws on bad input.
        sanitizeSkeletonTiles: function (skeleton) {
            if (!Array.isArray(skeleton)) return { tiles: skeleton, dropped: [], normalized: 0 };
            var toMin = function (t) {
                if (t == null) return null;
                if (typeof t === 'number') return t;
                var s = String(t).trim().toLowerCase(), mer = null;
                if (s.slice(-2) === 'am' || s.slice(-2) === 'pm') { mer = s.slice(-2); s = s.slice(0, -2).trim(); }
                var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
                if (!m) return null;
                var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
                if (isNaN(hh) || isNaN(mm) || hh > 23 || mm < 0 || mm > 59) return null;
                if (mer) { if (hh === 12) hh = (mer === 'am') ? 0 : 12; else if (mer === 'pm' && hh < 12) hh += 12; }
                else if (hh >= 1 && hh <= 6) hh += 12;
                return hh * 60 + mm;
            };
            var fmt = function (mins) {
                var h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'pm' : 'am', h12 = (h % 12) || 12;
                return h12 + ':' + (m < 10 ? '0' + m : '' + m) + ap;
            };
            var hasMer = function (t) { return /(am|pm)\s*$/i.test(String(t == null ? '' : t).trim()); };
            var norm = function (x) { return String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim(); };
            var seen = {}, tiles = [], dropped = [], normalized = 0;
            for (var i = 0; i < skeleton.length; i++) {
                var b = skeleton[i];
                if (!b) continue;
                var sM = toMin(b.startTime), eM = toMin(b.endTime);
                if (sM == null || eM == null || eM <= sM) {
                    dropped.push({ division: b.division, event: b.event, startTime: b.startTime, endTime: b.endTime, reason: (sM == null || eM == null) ? 'unparseable time' : 'end <= start' });
                    continue;
                }
                var wasWell = hasMer(b.startTime) && hasMer(b.endTime);
                var nb = b;
                if (!hasMer(b.startTime) || !hasMer(b.endTime)) {
                    nb = {};
                    for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) nb[k] = b[k]; }
                    if (!hasMer(b.startTime)) nb.startTime = fmt(sM);
                    if (!hasMer(b.endTime)) nb.endTime = fmt(eM);
                    normalized++;
                }
                if (!b.division) { tiles.push(nb); continue; }
                var key = b.division + '|' + (b._bunk != null ? String(b._bunk) + '|' : '') + norm(b.event) + '|' + sM;
                if (!Object.prototype.hasOwnProperty.call(seen, key)) {
                    seen[key] = { pos: tiles.length, well: wasWell };
                    tiles.push(nb);
                } else {
                    var prev = seen[key];
                    if (wasWell && !prev.well) {
                        var old = tiles[prev.pos];
                        dropped.push({ division: old.division, event: old.event, startTime: old.startTime, endTime: old.endTime, reason: 'duplicate' });
                        tiles[prev.pos] = nb;
                        prev.well = true;
                    } else {
                        dropped.push({ division: b.division, event: b.event, startTime: b.startTime, endTime: b.endTime, reason: 'duplicate' });
                    }
                }
            }
            if (dropped.length || normalized) {
                try {
                    console.warn('[Sanitize] ' + dropped.length + ' tile(s) dropped, ' + normalized + ' time(s) normalized'
                        + (dropped.length ? ' | ' + dropped.map(function (d) { return (d.division || '?') + ':"' + (d.event || '') + '" ' + d.startTime + '-' + d.endTime + ' (' + d.reason + ')'; }).join('; ') : ''));
                } catch (_) {}
            }
            return { tiles: tiles, dropped: dropped, normalized: normalized };
        },

        // Minutes -> "H:MM AM/PM" label (e.g. 540 -> "9:00 AM"). null/undefined/
        // NaN -> ''. Prefers the solver canonical when present so there is ONE
        // runtime implementation; the inline fallback is identical for valid input
        // and only used if SchedulerCoreUtils has not loaded (lighter pages).
        minutesToTimeLabel: function (mins) {
            if (mins == null || (typeof mins === 'number' && isNaN(mins))) return '';
            if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.minutesToTimeLabel) {
                return window.SchedulerCoreUtils.minutesToTimeLabel(mins);
            }
            var h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
        },

        // Minutes -> compact lowercase "h:mmap" (e.g. 870 -> "2:30pm"). This is a
        // DIFFERENT format from minutesToTimeLabel (no space, lowercase meridiem)
        // and is byte-identical to the copies in rainy_day_manager /
        // mobile_touch_drag / midday_rain_stacker / daily_adjustments /
        // master_schedule_builder / rotation_events. (schedule_calendar_views has
        // a same-named helper that actually emits "H:MM AM/PM" — that one is left
        // alone.) No null guard, to match the originals' exact behavior.
        minutesToTime: function (mins) {
            var h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'pm' : 'am';
            h = h % 12 || 12;
            return h + ':' + String(m).padStart(2, '0') + ap;
        }
    };

    // Expose. Never clobber a previously-installed instance (defensive against
    // double-load / load-order surprises).
    if (!window.CampUtils) window.CampUtils = CampUtils;
})();
