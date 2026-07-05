/**
 * Tests for: cloud_sync_helpers.js dedupeSpecialsByName + saveGlobalSpecialActivities
 *
 * Run with:  node --test tests/special_dedupe_save.test.js
 *
 * Why this exists: a camp's config carried two rows for the same special
 * differing only by case ("Sushi" / "sushi"). The lowercase one was a phantom
 * default with NO access restriction, and it defeated the user's "shut off for
 * first grade" restriction. The save path used to de-dupe by EXACT name, so
 * both rows survived every save. It now de-dupes case-insensitively, preferring
 * the row that actually carries the restriction so the stray self-heals.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadHelpers() {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'cloud_sync_helpers.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'cloud_sync_helpers.js' });
    return win;
}

const restricted = {
    name: 'Sushi', location: 'Kitchen',
    accessRestrictions: { enabled: true, divisions: { 'Second Grade': [] } }
};
const phantom = { name: 'sushi', accessRestrictions: { enabled: false, divisions: {} } };

describe('dedupeSpecialsByName', () => {
    it('collapses case-variant rows to one, keeping the restricted copy', () => {
        const win = loadHelpers();
        for (const input of [[restricted, phantom], [phantom, restricted]]) {
            const out = win.dedupeSpecialsByName(input);
            assert.equal(out.length, 1, 'duplicate cased rows must collapse to one');
            assert.equal(out[0].name, 'Sushi', 'the restricted/real row must win regardless of order');
            assert.ok(out[0].accessRestrictions.enabled, 'kept row must carry the restriction');
        }
    });

    it('leaves distinct specials untouched', () => {
        const win = loadHelpers();
        const out = win.dedupeSpecialsByName([{ name: 'Sushi' }, { name: 'Pizza' }, { name: 'Ramen' }]);
        assert.equal(out.length, 3);
    });

    it('prefers the row with a location when neither is restricted', () => {
        const win = loadHelpers();
        const out = win.dedupeSpecialsByName([
            { name: 'taco' },
            { name: 'Taco', location: 'Mess Hall' }
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0].location, 'Mess Hall');
    });

    it('ignores rows with no name and tolerates non-arrays', () => {
        const win = loadHelpers();
        assert.deepEqual(win.dedupeSpecialsByName(null), []);
        assert.equal(win.dedupeSpecialsByName([{ name: '' }, null, { name: 'OK' }]).length, 1);
    });
});

describe('saveGlobalSpecialActivities — heals duplicates before persisting', () => {
    it('writes a de-duplicated list to both storage keys', () => {
        const win = loadHelpers();
        const store = {};
        win.loadGlobalSettings = () => ({ app1: {} });
        win.saveGlobalSettings = (key, val) => { store[key] = val; };

        win.saveGlobalSpecialActivities([restricted, phantom]);

        assert.equal(store.specialActivities.length, 1, 'root-level list must be de-duplicated');
        assert.equal(store.specialActivities[0].name, 'Sushi');
        assert.equal(store.app1.specialActivities.length, 1, 'app1 list must be de-duplicated');
        assert.equal(store.app1.specialActivities[0].name, 'Sushi');
    });
});
