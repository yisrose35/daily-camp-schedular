/**
 * Regression test for the auto-mode edit modal's ACTIVITY DROPDOWN.
 *
 * BUG: After clicking "+ Add" on a gap, the modal's activity dropdown was empty
 *      / non-functional. Two causes:
 *   (1) getAllLocations() read specials ONLY from app1.specialActivities. When the
 *       specials lived in another copy (the live list / top-level key) that array
 *       was empty, so the activity <datalist> (built from getAllLocations) had no
 *       options — nothing to choose from.
 *   (2) showEditModal pre-filled the activity box by calling findSlotsForRange
 *       WITHOUT the bunk, which (auto mode) fell through to division-level slots and
 *       resolved a foreign entry — pre-filling the box with a stale value that then
 *       filtered the dropdown to nothing. (Covered by the per-bunk resolution in
 *       gap_add_editor.test.js; here we lock the dropdown-population half.)
 *
 * This copies the REAL getAllLocations (unified_schedule_system.js) verbatim and
 * proves the activity list is populated from whichever copy holds the specials.
 *
 * Run with: node --test tests/edit_modal_activity_dropdown.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

global.window = global;

// =====================================================================
// VERBATIM COPY: getAllLocations (unified_schedule_system.js:1329)
// =====================================================================
function getAllLocations() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    const locations = [];
    (app1.fields || []).forEach(f => {
        if (f.name && f.available !== false) locations.push({
            name: f.name, type: 'field',
            capacity: f.sharableWith?.capacity || 1,
            activities: f.activities || []
        });
    });
    let specials = (Array.isArray(app1.specialActivities) && app1.specialActivities.length)
        ? app1.specialActivities : null;
    if (!specials) {
        try {
            if (typeof window.getAllSpecialActivities === 'function') {
                const live = window.getAllSpecialActivities();
                if (Array.isArray(live) && live.length) specials = live;
            }
        } catch (e) { /* fall through */ }
    }
    if (!specials) specials = settings.specialActivities || window.specialActivities || [];
    (specials || []).forEach(s => {
        if (s && s.name) locations.push({
            name: s.name, type: 'special',
            capacity: s.sharableWith?.capacity || 1,
            activities: [s.name]
        });
    });
    return locations;
}

// The datalist <option> set the modal builds from getAllLocations().
function activityOptions() {
    return [...new Set(getAllLocations().flatMap(l => l.activities || []))].sort();
}

afterEach(() => {
    delete window.loadGlobalSettings;
    delete window.getAllSpecialActivities;
    delete window.specialActivities;
});

describe('edit-modal activity dropdown population', () => {
    it('uses app1.specialActivities when present', () => {
        window.loadGlobalSettings = () => ({
            app1: {
                fields: [{ name: 'Court 1', activities: ['Basketball', 'Hockey'] }],
                specialActivities: [{ name: 'Baking' }, { name: 'Gymnastics' }]
            }
        });
        const opts = activityOptions();
        assert.deepEqual(opts, ['Baking', 'Basketball', 'Gymnastics', 'Hockey']);
    });

    it('FIX: falls back to the live list when app1.specialActivities is empty', () => {
        window.loadGlobalSettings = () => ({
            app1: { fields: [{ name: 'Court 1', activities: ['Basketball'] }], specialActivities: [] }
        });
        window.getAllSpecialActivities = () => [{ name: 'Baking' }, { name: 'Slush' }];
        const opts = activityOptions();
        assert.ok(opts.includes('Baking') && opts.includes('Slush'),
            'specials from the live list appear in the dropdown');
        assert.ok(opts.includes('Basketball'), 'field sports still appear');
    });

    it('FIX: falls back to window.specialActivities when nothing else has them', () => {
        window.loadGlobalSettings = () => ({ app1: { fields: [], specialActivities: [] } });
        window.specialActivities = [{ name: 'Popcorn' }, { name: 'Art Shoppes' }];
        const opts = activityOptions();
        assert.deepEqual(opts, ['Art Shoppes', 'Popcorn']);
    });

    it('never throws and returns [] when no config is loaded', () => {
        window.loadGlobalSettings = () => ({});
        assert.deepEqual(activityOptions(), []);
    });

    it('the dropdown is non-empty whenever specials exist somewhere', () => {
        // The core guarantee: a user with specials configured always gets choices.
        window.loadGlobalSettings = () => ({ app1: {} });           // app1 has nothing
        window.specialActivities = [{ name: 'Baking' }];           // but the live copy does
        assert.ok(activityOptions().length > 0, 'dropdown has at least one activity');
    });
});
