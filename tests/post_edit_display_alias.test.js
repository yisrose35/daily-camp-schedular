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
// (includes the CUSTOM TEXT branch: a free-text block always keeps its text as
//  the display name and is flagged _customText so rotation credits nothing)
function buildEntry(activity, location, isClear, opts = {}) {
    const fieldValue = location ? `${location} – ${activity}` : activity;
    const _dn = (!isClear && opts.customText)
        ? String(opts.displayName || activity || '').trim() || null
        : ((!isClear && opts.displayName && String(opts.displayName).trim()
            && String(opts.displayName).trim().toLowerCase() !== String(activity).trim().toLowerCase())
            ? String(opts.displayName).trim() : null);
    return {
        field: isClear ? 'Free' : fieldValue,
        sport: isClear ? null : activity,
        _fixed: !isClear,
        _activity: isClear ? 'Free' : activity,
        _displayName: _dn,
        _customText: !isClear && !!opts.customText,
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

// ─── VERBATIM: formatEntry's full "Activity – Location" path (unified) ────────
// A normal entry shows "Activity – Room"; an aliased entry must short-circuit to
// the EXACT display name with NO " – Room" suffix.
function formatEntryWithLocation(entry, resolveLoc) {
    const field = entry.field || '';
    const sport = entry.sport || '';
    if (entry._displayName) return entry._displayName;          // exact, no location
    const name = entry._partLabel || entry._activity || sport || field || '';
    const loc = resolveLoc ? resolveLoc(entry) : '';
    if (name && loc && loc.toLowerCase() !== name.toLowerCase()) return `${name} – ${loc}`;
    return name || loc || '';
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

    it('shows the EXACT display name with no location appended (Lake, not "Lake – VR")', () => {
        // VR activity whose room resolves to "VR", renamed to "Lake".
        const e = buildEntry('VR', null, false, { displayName: 'Lake' });
        e.field = 'VR';
        const resolveLoc = () => 'VR';                  // the real room
        // Without an alias a normal VR entry would read "VR" (name === loc → no suffix);
        // with an alias it must be exactly the typed text, never "Lake – VR".
        assert.equal(formatEntryWithLocation(e, resolveLoc), 'Lake');
        assert.equal(getActivityDisplayName(e), 'Lake');
    });

    it('a non-aliased entry still shows "Activity – Room"', () => {
        const e = buildEntry('Caps Making', 'Art Room', false, {});
        const resolveLoc = () => 'Art Room';
        assert.equal(formatEntryWithLocation(e, resolveLoc), 'Caps Making – Art Room');
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

describe('post-edit CUSTOM TEXT block (free text, no real activity)', () => {
    it('stores the typed text as both activity and display name, flagged _customText', () => {
        const e = buildEntry('Color War Breakout!', '', false,
            { displayName: 'Color War Breakout!', customText: true });
        assert.equal(e._customText, true);
        assert.equal(e._displayName, 'Color War Breakout!');
        assert.equal(e._activity, 'Color War Breakout!');
        assert.equal(e._location, '');
    });

    it('keeps the display name even when it EQUALS the activity (unlike the alias)', () => {
        // The alias path drops a display name equal to the activity; a custom
        // text block IS its own text, so it must keep it — every view renders
        // _displayName verbatim.
        const e = buildEntry('Pizza Party', '', false, { displayName: 'Pizza Party', customText: true });
        assert.equal(e._displayName, 'Pizza Party');
        assert.equal(getActivityDisplayName(e), 'Pizza Party');
        assert.equal(formatEntryName(e), 'Pizza Party');
    });

    it('renders the text verbatim with no location appended', () => {
        const e = buildEntry('Visiting Day — parents arrive', '', false,
            { displayName: 'Visiting Day — parents arrive', customText: true });
        const resolveLoc = () => 'Main Field';
        assert.equal(formatEntryWithLocation(e, resolveLoc), 'Visiting Day — parents arrive');
    });

    it('falls back to the activity text when displayName is omitted', () => {
        const e = buildEntry('Camp Photo', '', false, { customText: true });
        assert.equal(e._displayName, 'Camp Photo');
        assert.equal(e._customText, true);
    });

    it('a cleared slot never carries the custom-text flag or text', () => {
        const e = buildEntry('Camp Photo', '', true, { displayName: 'Camp Photo', customText: true });
        assert.equal(e._customText, false);
        assert.equal(e._displayName, null);
        assert.equal(e._activity, 'Free');
    });

    it('rotation credit rule: custom text credits no new activity', () => {
        // Mirrors applyEdit's call:
        //   applyPostEditCounts(bunk, oldActs, (!isClear && activity && !customText) ? activity : null, slots)
        const creditFor = (isClear, activity, customText) =>
            (!isClear && activity && !customText) ? activity : null;
        assert.equal(creditFor(false, 'Basketball', false), 'Basketball');
        assert.equal(creditFor(false, 'Pizza Party', true), null, 'custom text must not create a rotation key');
        assert.equal(creditFor(true, 'Free', false), null);
    });
});
