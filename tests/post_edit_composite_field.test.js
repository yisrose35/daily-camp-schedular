/**
 * Regression test for the DUPLICATED-ACTIVITY display bug:
 *   a tile rendered as "Basketball – Dunk Courts – Basketball"
 *   instead of "Basketball – Dunk Courts".
 *
 * Root cause: the post-edit write path (applyDirectEdit, unified_schedule_system.js)
 * stores entry.field as a COMPOSITE "Location – Activity" (and _location as the
 * plain location). resolveEntryLocation deliberately trusts entry.field over
 * _location (FQ-reopt freshness) but returned the composite WHOLE, so formatEntry
 * prepended the activity → "Activity – Location – Activity".
 *
 * These copy the REAL logic verbatim from:
 *   • applyDirectEdit         (unified_schedule_system.js) — composite field write
 *   • resolveEntryLocation    (unified_schedule_system.js) — FIXED: strips the tail
 *   • formatEntry (name–loc)  (unified_schedule_system.js)
 *   • Utils.formatEntry       (scheduler_core_utils.js)    — FIXED: no re-append
 *
 * Run with: node --test tests/post_edit_composite_field.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fieldLabel = (f) => (typeof f === 'string' ? f : (f && f.name) || '');

// ─── VERBATIM: applyDirectEdit's composite field write ──────────────────────
function buildEntry(activity, location) {
    const fieldValue = location ? `${location} – ${activity}` : activity;
    return { field: fieldValue, sport: activity, _activity: activity, _location: location };
}

// ─── VERBATIM (fixed): resolveEntryLocation (unified_schedule_system.js) ─────
function resolveEntryLocation(entry) {
    if (!entry) return '';
    const name = entry._activity || entry.sport || '';
    let _fieldReal = fieldLabel(entry.field);
    if (_fieldReal && name && _fieldReal.indexOf(' – ') !== -1) {
        const _parts = _fieldReal.split(' – ');
        if (_parts[_parts.length - 1].trim().toLowerCase() === String(name).toLowerCase()) {
            _fieldReal = _parts.slice(0, -1).join(' – ').trim();
        }
    }
    if (_fieldReal && _fieldReal !== 'Free' && _fieldReal.toLowerCase() !== String(name).toLowerCase()) {
        return _fieldReal;
    }
    let loc = entry._specialLocation || entry._customField || entry._location || entry._partLocation || '';
    if (!loc) { const f = fieldLabel(entry.field); if (f && f !== 'Free') loc = f; }
    if (!loc || loc === 'Free') return '';
    return loc;
}

// ─── VERBATIM: formatEntry's "Activity – Location" path (unified) ────────────
function formatEntry(entry) {
    if (entry._displayName) return entry._displayName;
    const field = fieldLabel(entry.field);
    const sport = entry.sport || '';
    const name = entry._partLabel || entry._activity || sport || field || '';
    const loc = resolveEntryLocation(entry);
    if (name && loc && loc.toLowerCase() !== name.toLowerCase()) return `${name} – ${loc}`;
    return name || loc || '';
}

// ─── VERBATIM (fixed): Utils.formatEntry (scheduler_core_utils.js) ───────────
function utilsFormatEntry(entry) {
    if (!entry) return '';
    if (entry._displayName) return entry._displayName;
    const activity = entry._activity || entry.sport || '';
    const field = fieldLabel(entry.field) || '';
    if (field && activity && field.indexOf(' – ') !== -1) {
        const _p = field.split(' – ');
        if (_p[_p.length - 1].trim().toLowerCase() === String(activity).toLowerCase()) return field;
    }
    if (activity && field && activity !== field) return `${field} – ${activity}`;
    return activity || field || '';
}

describe('composite-field duplicated-activity display bug', () => {
    it('resolveEntryLocation returns ONLY the location from a composite field', () => {
        const e = buildEntry('Basketball', 'Dunk Courts');       // field = "Dunk Courts – Basketball"
        assert.equal(e.field, 'Dunk Courts – Basketball', 'precondition: composite field stored');
        assert.equal(resolveEntryLocation(e), 'Dunk Courts');
    });

    it('formatEntry (activity-first) shows "Activity – Location", NOT the triple', () => {
        const e = buildEntry('Basketball', 'Dunk Courts');
        assert.equal(formatEntry(e), 'Basketball – Dunk Courts');
    });

    it('Utils.formatEntry (location-first) shows "Location – Activity", NOT the triple', () => {
        const e = buildEntry('Basketball', 'Dunk Courts');
        assert.equal(utilsFormatEntry(e), 'Dunk Courts – Basketball');
    });

    it('handles the reported cases verbatim', () => {
        assert.equal(formatEntry(buildEntry('Soccer with Rabbi H.', 'Touchdown Park')),
            'Soccer with Rabbi H. – Touchdown Park');
        assert.equal(formatEntry(buildEntry('Baseball', 'The Clubhouse')), 'Baseball – The Clubhouse');
    });

    it('a plain (non-composite) field is unchanged', () => {
        const e = { field: 'Senior Hill Red', sport: 'Volleyball', _activity: 'Volleyball', _location: 'Senior Hill Red' };
        assert.equal(resolveEntryLocation(e), 'Senior Hill Red');
        assert.equal(formatEntry(e), 'Volleyball – Senior Hill Red');
    });

    it('does NOT truncate a real field name that legitimately contains " – "', () => {
        // A field literally named with a dash, activity is something else → keep whole.
        const e = { field: 'Court A – B', sport: 'Basketball', _activity: 'Basketball', _location: 'Court A – B' };
        assert.equal(resolveEntryLocation(e), 'Court A – B', 'tail "B" != activity "Basketball" → not stripped');
        assert.equal(formatEntry(e), 'Basketball – Court A – B');
    });

    it('does not append a location when the field is just the activity name', () => {
        const e = buildEntry('Woodworking', null);              // field = "Woodworking"
        assert.equal(formatEntry(e), 'Woodworking');
    });
});
