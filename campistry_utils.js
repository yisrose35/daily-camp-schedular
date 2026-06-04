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
            if (isNaN(hh) || isNaN(mm) || mm < 0 || mm > 59) return null;
            if (mer) { if (hh === 12) hh = mer === 'am' ? 0 : 12; else if (mer === 'pm') hh += 12; }
            return hh * 60 + mm;
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
