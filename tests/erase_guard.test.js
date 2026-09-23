// =============================================================================
// erase_guard.test.js — the owner's rule, "when a child is erased we force a
// reload that clears the cache", at the level of the one file every office
// page shares (supabase_client.js). The real file runs against a pretend
// Supabase client whose answers this test controls, so the timings that are
// hard to produce in a browser — an answer still on its way, another
// computer erasing in between — are exact here.
//
//   TED-044  while this page's own erase is waiting for its answer and another
//            computer erases too, a save waits — then the page reloads; the
//            save never goes out.
//   TED-045  a write to an ORDINARY table (not the camp documents) right after
//            a check still checks afresh: after an erase elsewhere it never
//            goes out, and the page reloads.
//   also     this page's own erase alone: a save in between waits for the
//            answer, then goes out, and the page does not reload.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'supabase_client.js'), 'utf8');
const CAMP = 'c0000000-0000-0000-0000-000000000001';

// A deferred promise: the test decides when an answer arrives.
function later() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));

function boot() {
    const store = { campistry_camp_id: CAMP };
    const localStorage = {
        getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }, key: i => Object.keys(store)[i], get length() { return Object.keys(store).length; },
    };
    const server = { epoch: 0 };
    const sent = [];                 // every request that actually went out (not the version check)
    const held = {};                 // rpc name -> deferred answer, when the test wants to hold one
    function builder(kind, name, args) {
        return {
            then(ok, err) {
                sent.push({ kind, name, args });
                if (held[name]) return held[name].p.then(ok, err);
                return Promise.resolve({ data: { success: true }, error: null }).then(ok, err);
            },
        };
    }
    const client = {
        auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
                getSession: async () => ({ data: { session: null } }) },
        from(table) {
            const qb = {};
            ['insert', 'upsert', 'update', 'delete'].forEach(m => { qb[m] = (row) => builder('write', table, row); });
            return qb;
        },
        rpc(fn, args) {
            if (fn === 'get_camp_cache_epoch') return Promise.resolve({ data: server.epoch, error: null });
            return builder('rpc', fn, args);
        },
    };
    const win = {
        __CAMPISTRY_SUPABASE__: { url: 'https://x.supabase.co', anonKey: 'k' },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        reloads: 0,
    };
    win.location = { reload() { win.reloads++; }, href: 'https://x/' };
    const ctx = {
        window: win, localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
        document: { addEventListener() {}, visibilityState: 'visible' },
        setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {},
        Promise, URL, JSON, Math, Date, Object, Array, String, Number, isFinite,
        CustomEvent: function () {}, Response: function (b, o) { this.status = o && o.status; },
        supabase: { createClient: () => client }, location: win.location,
    };
    win.localStorage = localStorage; win.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return { win, supa: win.supabase, server, sent, held, store };
}

test('the page loads with the guard on its shared client', () => {
    const t = boot();
    assert.ok(t.supa && t.supa.__eraseGuarded, 'window.supabase is not guarded');
});

test('TED-044: another computer erases while this page\'s own erase is waiting — a save waits, never goes out, and the page reloads', async () => {
    const t = boot();
    await t.supa.rpc('get_camper_numbers', { p_camp_id: CAMP });        // first check: this page is at version 0
    t.held.erase_camper = later();
    const erase = t.supa.rpc('erase_camper', { p_camp_id: CAMP, p_person_id: 2, p_confirm: true });
    const eraseDone = erase.then(r => { if (r && r.data && r.data.cache_epoch != null) t.win.__campistryEraseGuardAdvance(r.data.cache_epoch); return r; });
    await tick(20);
    t.server.epoch = 2;                        // this page's erase (1) AND another computer's (2)
    const before = t.sent.length;
    const save = t.supa.from('camp_state_kv').upsert({ camp_id: CAMP, key: 'app1', value: { stale: true } });
    const saveDone = save.then(r => r);
    await tick(80);
    assert.strictEqual(t.sent.length, before, 'the save went out while this page\'s own erase was still waiting');
    t.held.erase_camper.resolve({ data: { success: true, cache_epoch: 1 }, error: null });   // this page's erase was #1
    await eraseDone;
    const r = await saveDone;
    assert.ok(!t.sent.slice(before).some(x => x.name === 'camp_state_kv'), 'the out-of-date save was sent');
    assert.ok(r && r.error, 'the save did not report that it was stopped');
    await tick(700);
    assert.ok(t.win.reloads >= 1, 'the page did not reload');
});

test('this page\'s own erase alone: a save in between waits for the answer, then goes out — no reload', async () => {
    const t = boot();
    await t.supa.rpc('get_camper_numbers', { p_camp_id: CAMP });
    t.held.erase_camper = later();
    const erase = t.supa.rpc('erase_camper', { p_camp_id: CAMP, p_person_id: 2, p_confirm: true })
        .then(r => { t.win.__campistryEraseGuardAdvance(r.data.cache_epoch); return r; });
    await tick(20);
    t.server.epoch = 1;                        // only this page's erase
    const save = t.supa.from('camp_state_kv').upsert({ camp_id: CAMP, key: 'app1', value: { fresh: true } }).then(r => r);
    await tick(80);
    assert.ok(!t.sent.some(x => x.name === 'camp_state_kv'), 'the save did not wait for the erase\'s answer');
    t.held.erase_camper.resolve({ data: { success: true, cache_epoch: 1 }, error: null });
    await erase;
    const r = await save;
    assert.ok(t.sent.some(x => x.name === 'camp_state_kv'), 'the save never went out');
    assert.ok(!(r && r.error), 'the save was refused');
    await tick(700);
    assert.strictEqual(t.win.reloads, 0, 'the page reloaded after its own erase');
});

test('TED-045: a write to an ordinary table right after a check still checks afresh — after an erase elsewhere it never goes out', async () => {
    const t = boot();
    await t.supa.rpc('get_camper_numbers', { p_camp_id: CAMP });        // a check just now
    await t.supa.from('canteen_transactions').insert({ camper_id: 5, amount: 1 });  // fine, current
    const before = t.sent.length;
    t.server.epoch = 1;                        // another computer erases
    const r = await t.supa.from('canteen_transactions').insert({ camper_id: 5, amount: 2 }).then(x => x);
    assert.strictEqual(t.sent.length, before, 'the write went out after an erase elsewhere');
    assert.ok(r && r.error, 'the write did not report that it was stopped');
    await tick(700);
    assert.ok(t.win.reloads >= 1, 'the page did not reload');
});

test('another computer erased first: this page\'s own erase is not sent, and the page reloads at once (it does not wait on itself)', async () => {
    const t = boot();
    await t.supa.rpc('get_camper_numbers', { p_camp_id: CAMP });
    t.server.epoch = 1;                        // another computer erased
    const before = t.sent.length;
    const started = Date.now();
    const r = await t.supa.rpc('erase_camper', { p_camp_id: CAMP, p_person_id: 2, p_confirm: true }).then(x => x);
    assert.ok(Date.now() - started < 2000, 'the erase waited on itself');
    assert.strictEqual(t.sent.length, before, 'the erase was sent from an out-of-date page');
    assert.ok(r && r.error, 'the erase did not report that it was stopped');
    await tick(700);
    assert.ok(t.win.reloads >= 1, 'the page did not reload');
});

test('TED-044 (Ted\'s case): another computer erases before this page\'s own erase reaches the server — a save in between never goes out; the page reloads', async () => {
    const t = boot();
    await t.supa.rpc('get_camper_numbers', { p_camp_id: CAMP });        // this page is at version 0
    t.held.erase_camper = later();
    const erase = t.supa.rpc('erase_camper', { p_camp_id: CAMP, p_person_id: 2, p_confirm: true })
        .then(r => { if (r && r.data && r.data.cache_epoch != null) t.win.__campistryEraseGuardAdvance(r.data.cache_epoch); return r; });
    await tick(20);
    t.server.epoch = 1;                        // ANOTHER computer's erase; this page's has not reached the server yet
    const before = t.sent.length;
    const save = t.supa.from('camp_state_kv').upsert({ camp_id: CAMP, key: 'app1', value: { stale: true } }).then(r => r);
    await tick(80);
    assert.ok(!t.sent.slice(before).some(x => x.name === 'camp_state_kv'), 'the out-of-date save went out while this page\'s erase was waiting');
    t.server.epoch = 2;                        // now this page's erase lands: #2
    t.held.erase_camper.resolve({ data: { success: true, cache_epoch: 2 }, error: null });
    await erase;
    const r = await save;
    assert.ok(!t.sent.slice(before).some(x => x.name === 'camp_state_kv'), 'the out-of-date save was sent');
    assert.ok(r && r.error, 'the save did not report that it was stopped');
    await tick(700);
    assert.ok(t.win.reloads >= 1, 'the page did not reload');
});
