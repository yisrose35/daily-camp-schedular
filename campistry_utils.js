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
        }
    };

    // Expose. Never clobber a previously-installed instance (defensive against
    // double-load / load-order surprises).
    if (!window.CampUtils) window.CampUtils = CampUtils;
})();
