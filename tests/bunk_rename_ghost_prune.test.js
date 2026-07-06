/**
 * Regression test for the renamed-bunk GHOST prune (supabase_schedules.js).
 *
 * BUG: When a bunk is RENAMED in Campistry Me, the schedule keeps its data under
 *      the OLD name. The generation wipe keys by the current roster name, so it
 *      never clears the old-named entry — the ghost survives inside the single
 *      cloud row, reloads every session, and blanks the renamed division on render
 *      (the grid looks up the new name, finds an empty husk). Live repro: a camp
 *      renamed its 7th/8th-grade bunks; the schedule accumulated 26 keys (14 real
 *      + 12 old-named ghosts) and those two grades rendered blank while 6th (never
 *      renamed) was fine.
 *
 * FIX: pruneOrphanBunks() drops any bunk key not in the FULL camp structure
 *      (app1.divisions). It runs on the load-side merge (#V2-25, single-row too)
 *      AND on the save-side payload (defense in depth), so ghosts can't render,
 *      re-persist, or be physically written. GUARDED: a no-op when the structure
 *      isn't definitively loaded, so an early/racing load is never wiped.
 *
 * Copies the REAL pruneOrphanBunks verbatim (supabase_schedules.js). Keep in sync.
 *
 * Run with: node --test tests/bunk_rename_ghost_prune.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
global.console = { log() {}, warn() {}, error() {} };

// ── VERBATIM: pruneOrphanBunks (supabase_schedules.js) ──
function pruneOrphanBunks(assignmentsObj) {
    if (!assignmentsObj || typeof assignmentsObj !== 'object') return 0;
    let gs = null;
    try { gs = window.loadGlobalSettings ? window.loadGlobalSettings() : null; } catch (_) { return 0; }
    const divs = (gs && gs.app1 && gs.app1.divisions) || null;
    if (!divs || Object.keys(divs).length === 0) return 0;
    const valid = new Set();
    Object.values(divs).forEach(d => { if (d && Array.isArray(d.bunks)) d.bunks.forEach(b => valid.add(String(b))); });
    if (valid.size === 0) return 0;
    let pruned = 0;
    Object.keys(assignmentsObj).forEach(b => {
        if (!valid.has(String(b))) { delete assignmentsObj[b]; pruned++; }
    });
    return pruned;
}

// Current roster (post-rename): 6th unchanged, 7th/8th renamed off "N.x Name" prefixes.
const ROSTER = {
    app1: {
        divisions: {
            '6th Grade': { bunks: ['Shimon שמעון', 'Levi  לוי'] },
            '7th Grade': { bunks: ['Yissocher יששכר', 'זבולן', 'דן'] },
            '8th Grade': { bunks: ['משה', 'אהרן'] }
        }
    }
};

beforeEach(() => {
    window.loadGlobalSettings = () => ROSTER;
});

describe('pruneOrphanBunks — drops renamed-bunk ghosts', () => {
    it('removes old-named ghost keys, keeps every current roster bunk', () => {
        // The live repro shape: real (new-named) entries + old-named ghosts.
        const sa = {
            'Shimon שמעון': [{ _activity: 'Basketball' }],
            'Levi  לוי': [{ _activity: 'Volleyball' }],
            'Yissocher יששכר': [{ _activity: 'Lake' }],
            'זבולן': [{ _activity: 'Hockey' }],
            'דן': [{ _activity: 'Soccer' }],
            'משה': [{ _activity: 'Baseball' }],
            'אהרן': [{ _activity: 'Football' }],
            // ghosts (old names, no longer in the roster):
            '7.1 Yissocher  יששכר': [{ _activity: 'Lake' }],
            '7.2 Zevulan זבולן': [{ _activity: 'Hockey' }],
            '8.1 Moshe משה': [{ _activity: 'Baseball' }]
        };
        const pruned = pruneOrphanBunks(sa);
        assert.equal(pruned, 3, 'three ghosts dropped');
        assert.deepEqual(Object.keys(sa).sort(), [
            'Levi  לוי', 'Shimon שמעון', 'Yissocher יששכר', 'אהרן', 'דן', 'זבולן', 'משה'
        ].sort(), 'only the 7 current roster bunks remain');
        assert.ok(sa['Yissocher יששכר'], 'renamed bunk keeps its data under the new name');
    });

    it('is a no-op when there are no ghosts', () => {
        const sa = { 'Shimon שמעון': [{}], 'Levi  לוי': [{}], 'משה': [{}], 'אהרן': [{}] };
        assert.equal(pruneOrphanBunks(sa), 0);
        assert.equal(Object.keys(sa).length, 4);
    });
});

describe('pruneOrphanBunks — guards never wipe a legit schedule', () => {
    it('does nothing when the structure is not loaded (null)', () => {
        window.loadGlobalSettings = () => null;
        const sa = { '7.1 Yissocher  יששכר': [{ _activity: 'Lake' }] };
        assert.equal(pruneOrphanBunks(sa), 0, 'no prune without structure');
        assert.ok(sa['7.1 Yissocher  יששכר'], 'entry preserved during an unloaded/racing state');
    });

    it('does nothing when the structure has no divisions', () => {
        window.loadGlobalSettings = () => ({ app1: { divisions: {} } });
        const sa = { 'anything': [{}] };
        assert.equal(pruneOrphanBunks(sa), 0);
        assert.ok(sa['anything']);
    });

    it('does nothing when divisions yield zero valid bunks', () => {
        window.loadGlobalSettings = () => ({ app1: { divisions: { '6th Grade': { bunks: [] } } } });
        const sa = { 'Shimon שמעון': [{}] };
        assert.equal(pruneOrphanBunks(sa), 0, 'empty valid set is treated as "not loaded"');
        assert.ok(sa['Shimon שמעון']);
    });

    it('survives a thrown loadGlobalSettings without pruning', () => {
        window.loadGlobalSettings = () => { throw new Error('boom'); };
        const sa = { 'Shimon שמעון': [{}] };
        assert.equal(pruneOrphanBunks(sa), 0);
        assert.ok(sa['Shimon שמעון']);
    });

    it('handles a non-object argument', () => {
        assert.equal(pruneOrphanBunks(null), 0);
        assert.equal(pruneOrphanBunks(undefined), 0);
    });
});
