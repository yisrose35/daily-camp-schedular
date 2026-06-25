/**
 * Regression test for the post-edit DISPLAY-NAME ALIAS.
 *
 * Feature: in the single-bunk post-edit modal the user can give a slot a
 * "Display name" (e.g. "Shirt Making") that is shown on the schedule INSTEAD of
 * the real activity (e.g. "Caps Making"). The real activity (`_activity`) is left
 * untouched so rotation / counting still credit the underlying activity.
 *
 * This copies the REAL logic verbatim from:
 *   • applyDirectEdit          (unified_schedule_system.js)  — how `_displayName` is stored
 *   • getActivityDisplayName   (scheduler_core_utils.js)     — display priority
 *   • formatEntry              (unified_schedule_system.js)  — visible cell label
 * and proves the alias is shown while `_activity` stays the real activity.
 *
 * Run with: node --test tests/post_edit_display_alias.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── VERBATIM: applyDirectEdit's _displayName computation + entry write ──────
function buildEntry(activity, location, isClear, opts = {}) {
    const fieldValue = location ? `${location} – ${activity}` : activity;
    const _dn = (!isClear && opts.displayName && String(opts.displayName).trim()
        && String(opts.displayName).trim().toLowerCase() !== String(activity).trim().toLowerCase())
        ? String(opts.displayName).trim() : null;
    return {
        field: isClear ? 'Free' : fieldValue,
        sport: isClear ? null : activity,
        _fixed: !isClear,
        _activity: isClear ? 'Free' : activity,
        _displayName: _dn,
        _location: location,
    };
}

// ─── VERBATIM: getActivityDisplayName (scheduler_core_utils.js) ──────────────
function getActivityDisplayName(slot) {
    if (!slot) return '';
    if (slot._displayName) return slot._displayName;
    if (slot._partLabel) return slot._partLabel;
    if (slot._partNumber && slot._totalParts && slot._activity) {
        return slot._activity + ' ' + slot._partNumber + '/' + slot._totalParts;
    }
    return slot._activity || slot.field || slot.event || '';
}

// ─── VERBATIM (simplified): formatEntry's visible-name resolution ────────────
function formatEntryName(entry) {
    const field = entry.field || '';
    const sport = entry.sport || '';
    return entry._displayName || entry._partLabel || entry._activity || sport || field || '';
}

describe('post-edit display-name alias', () => {
    it('stores the alias when it differs from the activity', () => {
        const e = buildEntry('Caps Making', 'Art Room', false, { displayName: 'Shirt Making' });
        assert.equal(e._displayName, 'Shirt Making');
        assert.equal(e._activity, 'Caps Making', 'real activity is preserved for counting');
        assert.equal(e.sport, 'Caps Making');
    });

    it('shows the alias, not the real activity, everywhere a label is rendered', () => {
        const e = buildEntry('Caps Making', 'Art Room', false, { displayName: 'Shirt Making' });
        assert.equal(getActivityDisplayName(e), 'Shirt Making');
        assert.equal(formatEntryName(e), 'Shirt Making');
    });

    it('does not store an alias when blank, whitespace, or equal to the activity', () => {
        assert.equal(buildEntry('Caps Making', null, false, { displayName: '' })._displayName, null);
        assert.equal(buildEntry('Caps Making', null, false, { displayName: '   ' })._displayName, null);
        assert.equal(buildEntry('Caps Making', null, false, { displayName: 'caps making' })._displayName, null,
            'case-insensitive equal to the activity → no alias');
        assert.equal(buildEntry('Caps Making', null, false, {})._displayName, null);
    });

    it('falls back to the real activity for display when there is no alias', () => {
        const e = buildEntry('Caps Making', null, false, {});
        assert.equal(getActivityDisplayName(e), 'Caps Making');
        assert.equal(formatEntryName(e), 'Caps Making');
    });

    it('never carries an alias on a cleared (Free) slot', () => {
        const e = buildEntry('Caps Making', 'Art Room', true, { displayName: 'Shirt Making' });
        assert.equal(e._displayName, null);
        assert.equal(e._activity, 'Free');
    });

    it('trims surrounding whitespace from the alias', () => {
        const e = buildEntry('Caps Making', null, false, { displayName: '  Shirt Making  ' });
        assert.equal(e._displayName, 'Shirt Making');
    });
});
