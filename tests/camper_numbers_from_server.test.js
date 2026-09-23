// =============================================================================
// The Me page keeps to the server's camper numbers, and deleting a camper
// erases them on the server (migrations 253/254).
//
// The helpers are lifted out of campistry_me.js as they are and run against a
// fake roster and a fake database client.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const start = SRC.indexOf("// ── Camper numbers are the server's");
const end = SRC.indexOf('function _eraseStoredFiles');
const BLOCK = SRC.slice(start, end);
const NORMALIZE = SRC.slice(SRC.indexOf('function normalizePersonId'), SRC.indexOf('/** Roster key of the camper holding this id'));

function load({ roster, next = 1, reply, enrollments = {} }) {
    const store = {};
    const calls = [];
    const ctx = {
        roster, enrollments, nextPersonId: next, _saveLockUntil: 0, curPage: 'campers',
        saved: 0, toasts: [],
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        setTimeout: () => 0, clearTimeout: () => {},
        console: { warn() {}, log() {} },
        Promise, JSON, Object, Number, String, Array, Date,
        window: {
            CampistryDB: {
                getCampId: () => 'c1',
                getClient: () => ({ rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply(fn, args) }); } }),
            },
        },
    };
    ctx._lbl = k => k; ctx._fmtMoney = n => '$' + n;
    ctx.save = () => { ctx.saved++; };
    ctx.render = () => {};
    ctx.toast = (m) => { ctx.toasts.push(m); };
    vm.createContext(ctx);
    vm.runInContext(NORMALIZE + '\n' + BLOCK + '\nfunction _eraseStoredFiles(){}', ctx);
    return { ctx, calls, store };
}
const tick = () => new Promise(r => setImmediate(r));

test('a duplicate, a missing number and a departed camper\'s number are replaced by the server\'s', async () => {
    const roster = {
        Avi: { camperId: 10 }, Bina: { camperId: 10 }, Chana: {}, Dov: { camperId: 7 }, Eli: { camperId: 55 },
    };
    const { ctx } = load({ roster, next: 12, reply: () => ({
        success: true, next: 40,
        campers: { Avi: 10, Bina: 12, Chana: 13, Dov: 14, Eli: 20 },
        departed: { 7: 'Old Dov' },
    }) });
    ctx._reconcileCamperNumbers();
    await tick(); await tick();
    assert.strictEqual(roster.Bina.camperId, 12, 'the duplicate took the server\'s number');
    assert.strictEqual(roster.Chana.camperId, 13, 'the missing number was filled');
    assert.strictEqual(roster.Dov.camperId, 14, 'a departed camper\'s number was not kept');
    assert.strictEqual(roster.Avi.camperId, 10);
    assert.strictEqual(roster.Eli.camperId, 55, 'a number typed here and not yet saved is left alone');
    assert.ok(ctx.nextPersonId >= 40, 'the next number is above everything the server says is held');
    assert.strictEqual(ctx.saved, 1);
    assert.match(ctx.toasts[0], /already taken/);
});

test('nothing to fix: no save, no message', async () => {
    const roster = { Avi: { camperId: 10 } };
    const { ctx } = load({ roster, reply: () => ({ success: true, next: 11, campers: { Avi: 10 }, departed: {} }) });
    ctx._reconcileCamperNumbers();
    await tick(); await tick();
    assert.strictEqual(ctx.saved, 0);
    assert.strictEqual(ctx.toasts.length, 0);
});

test('a departed-but-held number reads as taken in the ID field', () => {
    const { ctx } = load({ roster: {}, reply: () => ({}) });
    ctx._serverHeldNumbers = { 7: 'Old Dov' };
    assert.ok(/_serverHeldNumbers\[want\]/.test(SRC.slice(SRC.indexOf('function personIdHolder'), SRC.indexOf('function reservePersonId'))),
        'personIdHolder does not consult the numbers departed campers still hold');
});

test('a deleted camper is erased; Undo cancels; the camper still on the roster is not', async () => {
    const roster = { Bina: { camperId: 11 } };
    const { ctx, calls } = load({ roster, reply: (fn) => ({ success: true, erased: true }) });
    ctx._queueCamperErase(10, 'Avi');
    ctx._queueCamperErase(11, 'Bina');          // still on the roster (re-added): must not erase
    ctx._queueCamperErase(12, 'Chana');
    ctx._cancelCamperErase(12);                 // Undo
    ctx._runCamperErases();
    await tick(); await tick(); await tick();
    assert.deepStrictEqual(calls.map(c => [c.fn, c.args.p_person_id, c.args.p_confirm]), [['erase_camper', 10, true]]);
});

test('an erase the server is not ready for is retried; one refused for money is reported, not retried', async () => {
    const answers = { 10: { success: false, error: 'still_enrolled' }, 20: { success: false, error: 'canteen_balance', balance: 4.5 } };
    const { ctx, store } = load({ roster: {}, reply: (fn, a) => answers[a.p_person_id] });
    ctx._queueCamperErase(10, 'Avi');
    ctx._queueCamperErase(20, 'Gil');
    ctx._runCamperErases();
    await tick(); await tick(); await tick();
    const q = JSON.parse(store.campistry_camper_erase_queue);
    assert.deepStrictEqual(q.map(x => x.id), [10], 'only the not-yet-saved delete stays queued');
    assert.match(ctx.toasts.join(' '), /canteen account still holds \$4\.5/);
});

test('a merge moves the duplicate onto the camper who stays', async () => {
    const { ctx, calls } = load({ roster: { Eli: { camperId: 30 } }, reply: () => ({ success: true }) });
    ctx._queueCamperErase(31, 'Eli S', 'merge', 30);
    ctx._runCamperErases();
    await tick(); await tick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0])), { fn: 'merge_campers', args: { p_camp_id: 'c1', p_keep: 30, p_gone: 31 } });
});

test('the Me page wires it: delete, Undo, rescind, merge, save and load', () => {
    const del = SRC.slice(SRC.indexOf('async function deleteCamper('), SRC.indexOf('// Unenroll: keep the camper'));
    assert.match(del, /_queueCamperErase\(_erasedId/, 'deleting a camper does not erase them');
    assert.match(del, /onAction:function\(\)\{\s*if\(_erasedId\)_cancelCamperErase\(_erasedId\)/, 'Undo does not cancel the erase');
    assert.match(SRC, /_rid=normalizePersonId\(roster\[e\.camperName\]\.camperId\);\s*if\(_rid\)\{_queueCamperErase/, 'rescinding does not erase');
    assert.match(SRC, /_queueCamperErase\(_gone,_lbl\(keyB\),'merge',_keep\)/, 'merging does not move the duplicate\'s history');
    assert.match(SRC, /_scheduleNumberReconcile\(7000\)/, 'save does not pick up the server\'s numbers');
    assert.match(SRC, /_scheduleNumberReconcile\(3000\);\s*setTimeout\(_runCamperErases,5000\)/, 'load does not finish queued erases');
});

test('when the server corrects a camper\'s number, their enrollments move with it', async () => {
    const roster = { Avi: { camperId: 10 }, Bina: { camperId: 10 } };
    const enrollments = { e1: { camperName: 'Bina', camperId: 10 }, e2: { camperName: 'Avi', camperId: 10 }, e3: { camperName: 'Bina' } };
    const { ctx } = load({ roster, enrollments, reply: () => ({ success: true, next: 20, campers: { Avi: 10, Bina: 12 }, departed: {} }) });
    ctx._reconcileCamperNumbers();
    await tick(); await tick();
    assert.strictEqual(enrollments.e1.camperId, 12, 'Bina\'s enrollment kept her old number');
    assert.strictEqual(enrollments.e3.camperId, 12, 'an enrollment with no number gets hers');
    assert.strictEqual(enrollments.e2.camperId, 10, 'Avi\'s enrollment must not move');
});

test('an enrollment belongs to a camper by number; by name only when it has none', () => {
    const start = SRC.indexOf('// The camper number for a roster key, or null.');
    const end = SRC.indexOf('function _lbl(k)');
    const ctx = { roster: { 'Rivka Stern': { camperId: 701 }, 'Rivka Stern #702': { camperId: 702 }, 'Old': {} }, String };
    vm.runInNewContext(SRC.slice(start, end), ctx);
    const is = ctx._enrIsFor;
    assert.strictEqual(is({ camperName: 'Rivka Stern', camperId: 702 }, 'Rivka Stern'), false,
        'an enrollment for #702 matched the other Rivka by name');
    assert.strictEqual(is({ camperName: 'Rivka Stern', camperId: 702 }, 'Rivka Stern #702'), true, 'a renamed key still matches by number');
    assert.strictEqual(is({ camperName: 'Rivka Stern' }, 'Rivka Stern'), true, 'an old enrollment with no number matches by name');
    assert.strictEqual(is({ camperName: 'Old', camperId: 5 }, 'Old'), true, 'a camper with no number falls back to the name');
    assert.strictEqual(is(null, 'x'), false);
});
