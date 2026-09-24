// =============================================================================
// sweep_sends_camper_numbers.test.js — TED-050. "Is this family still at
// camp?" is decided by camper NUMBER (261, TED-047). The Me page's real
// _sweepOrphanedParentInvites runs here: it must send the enrolled campers'
// numbers, and fall back to the old by-name call ONLY when the database does
// not have the by-number version yet (PGRST202 / function not found).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = ME.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

function run(firstAnswer) {
    const calls = [];
    const ctx = {
        console: { log() {} },
        roster: {
            'Avi Gold': { camperId: 4 },
            'Sara Gold': { camperId: '#6' },
            'Old Timer': { camperId: 9, unenrolled: true },
            'No Number': {},
        },
        normalizePersonId: (v) => { const n = parseInt(String(v == null ? '' : v).replace(/^#/, ''), 10); return n > 0 ? n : null; },
        window: { CampistryDB: { getClient: () => ({ rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve(calls.length === 1 ? firstAnswer : { data: { success: true, revoked: 0 } }); } }), getCampId: () => 'camp1' } },
        Object, Promise,
    };
    vm.createContext(ctx);
    vm.runInContext(cut('_sweepOrphanedParentInvites') + '\nthis.sweep=_sweepOrphanedParentInvites;', ctx);
    ctx.sweep();
    return new Promise(r => setTimeout(() => r(calls), 20));
}

test('TED-050: the sweep sends the numbers of every enrolled camper, and never an unenrolled one', async () => {
    const calls = await run({ data: { success: true, revoked: 0 } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].fn, 'revoke_orphaned_parent_invites');
    assert.deepStrictEqual(Array.from(calls[0].args.p_roster_ids).sort(), [4, 6]);
    assert.ok(!Array.from(calls[0].args.p_roster_names).includes('Old Timer'));
});

test('TED-050: a database without the by-number version gets the old call, once', async () => {
    for (const err of [{ code: 'PGRST202', message: 'PGRST202' }, { message: 'Could not find the function public.revoke_orphaned_parent_invites(p_camp_id, p_roster_ids, p_roster_names)' }]) {
        const calls = await run({ data: null, error: err });
        assert.strictEqual(calls.length, 2, 'no fallback for ' + err.message);
        assert.ok(!('p_roster_ids' in calls[1].args), 'the fallback still sent numbers');
    }
});

test('TED-050: any other answer — an office refusal, a network error — is NOT retried by name', async () => {
    for (const ans of [{ data: { success: false, error: 'not_camp_office' } }, { data: null, error: { message: 'Failed to fetch' } }]) {
        const calls = await run(ans);
        assert.strictEqual(calls.length, 1, 'fell back to deciding by name on: ' + JSON.stringify(ans));
    }
});
