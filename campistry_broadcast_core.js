/**
 * campistry_broadcast_core.js
 * -----------------------------------------------------------------------------
 * Pure, side-effect-free helpers shared by Campistry Link's messaging layer
 * (campistry_link_data.js), the admin compose UI (campistry_link_admin.html),
 * and the scheduled-broadcast edge function.
 *
 * Kept dependency-free and UMD-wrapped so the exact same logic runs in the
 * browser AND under `node --test` — that's what makes scheduled sends and the
 * camp-name SMS prefix verifiable without a live Supabase session.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;      // node / tests
    if (root) root.CampistryBroadcastCore = api;                                     // browser
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Validate a requested "send later" time.
     * @param {string} scheduledForIso  ISO-8601 timestamp
     * @param {number} nowMs            current epoch ms (injected so callers/tests are deterministic)
     * @param {number} [minLeadMs=0]    minimum lead time in ms (e.g. 60_000 = at least a minute out)
     * @returns {{ok:boolean, error?:string, whenMs?:number}}
     */
    function validateScheduleTime(scheduledForIso, nowMs, minLeadMs) {
        minLeadMs = minLeadMs || 0;
        if (!scheduledForIso) return { ok: false, error: 'Pick a date and time.' };
        var whenMs = Date.parse(scheduledForIso);
        if (isNaN(whenMs)) return { ok: false, error: 'That date and time is not valid.' };
        if (whenMs <= nowMs) return { ok: false, error: 'That time is in the past — pick a future time.' };
        if (whenMs < nowMs + minLeadMs) {
            return { ok: false, error: 'Schedule at least ' + Math.round(minLeadMs / 60000) + ' minute(s) from now.' };
        }
        return { ok: true, whenMs: whenMs };
    }

    /**
     * Select the scheduled broadcasts that are now due to fire.
     * Only records with status 'scheduled' and a scheduledFor at or before `nowMs`.
     * @param {Array} scheduled  broadcast records
     * @param {number} nowMs
     * @returns {Array} due records, oldest-first
     */
    function selectDue(scheduled, nowMs) {
        if (!Array.isArray(scheduled)) return [];
        return scheduled
            .filter(function (b) {
                if (!b || b.status !== 'scheduled' || !b.scheduledFor) return false;
                var t = Date.parse(b.scheduledFor);
                return !isNaN(t) && t <= nowMs;
            })
            .sort(function (a, b) { return Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor); });
    }

    /**
     * Prefix an outgoing SMS with the camp's name so parents always know who's
     * reaching them — "Sunny Acres: Bus is running 10 min late."
     * Idempotent: never double-prefixes if the body already starts with the name.
     * @param {string} body
     * @param {string} campName
     * @param {object} [opts] { enabled?:boolean=true }
     * @returns {string}
     */
    function formatOutgoingSms(body, campName, opts) {
        body = (body == null ? '' : String(body));
        var enabled = !opts || opts.enabled !== false;
        var name = (campName || '').trim();
        if (!enabled || !name) return body;
        // Already prefixed (case-insensitive, tolerant of the ": " separator)?
        var head = body.slice(0, name.length + 2).toLowerCase();
        if (head === (name + ': ').toLowerCase() || head.slice(0, name.length) === name.toLowerCase()) {
            if (body.slice(0, name.length).toLowerCase() === name.toLowerCase()) return body;
        }
        return name + ': ' + body;
    }

    /**
     * Resolve Campistry Link merge tags against a recipient record.
     * Canonical implementation — the admin UI and the scheduler both delegate
     * here so a tag added in one place works everywhere.
     * @param {string} template
     * @param {object} d       recipient { camperName, parentName, bunk, division, grade, familyName }
     * @param {object} [busMap] camperName -> route name
     */
    function applyMergeTags(template, d, busMap) {
        template = (template == null ? '' : String(template));
        d = d || {};
        busMap = busMap || {};
        return template
            .replace(/\{\{child_name\}\}/gi,  d.camperName || '')
            .replace(/\{\{parent_name\}\}/gi, d.parentName || '')
            .replace(/\{\{bunk\}\}/gi,        d.bunk       || '(unassigned)')
            .replace(/\{\{division\}\}/gi,    d.division   || '')
            .replace(/\{\{grade\}\}/gi,       d.grade      || '')
            .replace(/\{\{family_name\}\}/gi, d.familyName || '')
            .replace(/\{\{bus_route\}\}/gi,   busMap[d.camperName] || '(see Go app)');
    }

    /**
     * Human-readable recipient summary for a scheduled/broadcast record.
     * @param {string} scope   'all' | 'division' | 'grade' | 'bunk' | 'individual' | 'staff'
     * @param {Array} values   selected scope values (division/grade/bunk names, or parent names)
     * @param {number} count   resolved recipient count
     */
    function summarizeRecipients(scope, values, count) {
        values = values || [];
        var who;
        switch (scope) {
            case 'all':        who = 'Everyone'; break;
            case 'staff':      who = 'All staff'; break;
            case 'division':   who = values.length ? values.join(', ') : 'Selected divisions'; break;
            case 'grade':      who = values.length ? values.join(', ') : 'Selected grades'; break;
            case 'bunk':       who = values.length ? values.join(', ') : 'Selected bunks'; break;
            case 'individual': who = values.length ? values.join(', ') : 'Selected recipients'; break;
            default:           who = 'Recipients';
        }
        if (typeof count === 'number' && count > 0) {
            who += ' · ' + count + ' recipient' + (count === 1 ? '' : 's');
        }
        return who;
    }

    /**
     * Collapse a raw enrollment status into a broadcast audience bucket.
     *   'approved' — accepted | enrolled (a family that's in)
     *   'pending'  — applied | waitlisted (not yet accepted)
     *   'out'      — declined | withdrawn
     *   'unknown'  — no/unrecognized status (treated as active, never dropped)
     * @param {string} status
     * @returns {'approved'|'pending'|'out'|'unknown'}
     */
    function classifyEnrollmentStatus(status) {
        switch (String(status || '').toLowerCase()) {
            case 'accepted':
            case 'enrolled':   return 'approved';
            case 'applied':
            case 'waitlisted': return 'pending';
            case 'declined':
            case 'withdrawn':  return 'out';
            default:           return 'unknown';
        }
    }

    /**
     * Does a camper's enrollment status belong in the chosen broadcast audience?
     *   audience 'approved' — only accepted/enrolled (the safe default: never
     *                          message families that haven't been accepted yet)
     *   audience 'active'   — everyone except declined/withdrawn (incl. pending)
     *   audience 'all'      — everyone, including out (reunions, early-bird, etc.)
     * Unknown status counts as active (conservative — a real camper with no
     * enrollment record is never silently dropped), but is excluded from the
     * strict 'approved' audience.
     * @param {string} status    raw enrollment status
     * @param {string} audience  'approved' | 'active' | 'all'
     * @returns {boolean}
     */
    function matchesAudience(status, audience) {
        var bucket = classifyEnrollmentStatus(status);
        switch (audience) {
            case 'all':      return true;
            case 'active':   return bucket !== 'out';
            case 'approved': return bucket === 'approved';
            default:         return bucket !== 'out'; // default to active
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RICH TEXT
    //
    // One broadcast goes out over three channels that render nothing alike:
    // email (HTML), the parent portal (HTML), and SMS (plain text, and billed
    // by the character). So the composer stores MARKUP, not HTML, and each
    // channel renders it its own way. A divider is a styled rule in an email
    // and a row of dashes in a text message; a colour is meaningless in SMS and
    // simply drops away.
    //
    // Storing markup rather than contentEditable's HTML also means nothing the
    // office pastes in can inject markup into a parent's inbox: the renderer
    // escapes first and only then applies its own small, closed tag set.
    //
    //   **bold**   _italic_   ~~strikethrough~~
    //   ---                        (alone on a line: a divider)
    //   [size=small|large|huge]…[/size]
    //   [color=red|orange|green|blue|purple|grey]…[/color]
    //
    // Colours are a fixed palette rather than free-form CSS — an arbitrary
    // value would be a style-injection hole, and half of them are unreadable
    // against an email client's background anyway.
    // ─────────────────────────────────────────────────────────────────────────

    var SIZES = { small: '0.85em', large: '1.25em', huge: '1.6em' };
    var COLORS = {
        red: '#DC2626', orange: '#EA580C', green: '#16A34A',
        blue: '#2563EB', purple: '#7C3AED', grey: '#6B7280', gray: '#6B7280'
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** The palette the composer offers. Exposed so the toolbar can't drift. */
    function richTextOptions() {
        return {
            sizes: Object.keys(SIZES),
            colors: ['red', 'orange', 'green', 'blue', 'purple', 'grey']
        };
    }

    function renderInline(escaped, asHtml) {
        // Order matters: ** before _ so bold isn't eaten by the italic rule.
        var out = escaped
            .replace(/\*\*([\s\S]+?)\*\*/g, asHtml ? '<strong>$1</strong>' : '$1')
            .replace(/~~([\s\S]+?)~~/g, asHtml ? '<s>$1</s>' : '$1')
            .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, asHtml ? '$1<em>$2</em>' : '$1$2');

        out = out.replace(/\[size=(small|large|huge)\]([\s\S]*?)\[\/size\]/gi, function (m, size, inner) {
            return asHtml ? '<span style="font-size:' + SIZES[size.toLowerCase()] + '">' + inner + '</span>' : inner;
        });
        out = out.replace(/\[color=([a-z]+)\]([\s\S]*?)\[\/color\]/gi, function (m, name, inner) {
            var hex = COLORS[name.toLowerCase()];
            if (!hex) return inner;                       // unknown colour: keep the text, drop the tag
            return asHtml ? '<span style="color:' + hex + '">' + inner + '</span>' : inner;
        });
        return out;
    }

    /**
     * Render composer markup for one channel.
     * @param {string} markup
     * @param {object} [opts] { format: 'html' | 'text' }  default 'html'
     * @returns {string}
     */
    function renderBroadcastBody(markup, opts) {
        var asHtml = !opts || opts.format !== 'text';
        var src = String(markup == null ? '' : markup);
        // Escape BEFORE the tag pass in HTML mode, so pasted angle brackets are
        // text and only our own markup can produce elements.
        var body = asHtml ? escapeHtml(src) : src;

        var lines = body.split(/\r?\n/);
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            // A divider is the whole line — three or more dashes, nothing else.
            if (/^\s*-{3,}\s*$/.test(lines[i])) {
                out.push(asHtml
                    ? '<hr style="border:none;border-top:1px solid #D1D5DB;margin:16px 0">'
                    : '------------------------');
                continue;
            }
            out.push(renderInline(lines[i], asHtml));
        }
        return asHtml ? out.join('<br>') : out.join('\n');
    }

    /** Convenience: the plain-text form, for SMS and for previews. */
    function broadcastPlainText(markup) {
        return renderBroadcastBody(markup, { format: 'text' });
    }

    /**
     * Wrap a rendered body in the styles an email client needs inline. Email
     * clients strip <style> blocks, so the container carries its own.
     */
    function wrapBroadcastEmail(bodyHtml, opts) {
        var subject = (opts && opts.subject) || '';
        return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;'
            + 'font-size:15px;line-height:1.6;color:#1F2937;max-width:600px">'
            + (subject ? '<h2 style="font-size:18px;font-weight:700;margin:0 0 12px">' + escapeHtml(subject) + '</h2>' : '')
            + bodyHtml + '</div>';
    }

    return {
        validateScheduleTime: validateScheduleTime,
        selectDue: selectDue,
        formatOutgoingSms: formatOutgoingSms,
        applyMergeTags: applyMergeTags,
        summarizeRecipients: summarizeRecipients,
        classifyEnrollmentStatus: classifyEnrollmentStatus,
        matchesAudience: matchesAudience,
        renderBroadcastBody: renderBroadcastBody,
        broadcastPlainText: broadcastPlainText,
        wrapBroadcastEmail: wrapBroadcastEmail,
        richTextOptions: richTextOptions,
        escapeHtml: escapeHtml
    };
});
