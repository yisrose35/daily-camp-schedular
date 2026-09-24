// =============================================================================
// pos_charge_once.test.js — TED-159, the register's own Charge code, with the
// server answering LATER (as supabase-js does), not in the same tick.
//
// A second tap while the first charge was on its way charged the child twice
// (and said "charged to null"); a lost answer said "Charge failed" although the
// server had charged, so the counselor tapped again — twice. Now one charge is
// in flight at a time, each sale carries a key the server (migration 283)
// answers a repeat of with the first result, and no answer reads "could not
// confirm", never "failed".
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const POS_NOW = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks_pos.js'), 'utf8');
function chargeCode(src) {
    const a = src.indexOf('function updateChargeBtn() {');
    const endMark = "localCharge('⚠ Offline — spending limits not checked, will reconcile when back online');\n};";
    const b = src.indexOf(endMark, a);
    assert.ok(a >= 0 && b > a, 'the charge code moved');
    return src.slice(a, b + endMark.length);
}

// A server that charges like submit_canteen_purchase (+ 283's key when asked),
// answering on a later tick. `lose` = which request numbers lose their answer
// after the server has done its work.
function register({ lose = [], noOnce = false, refuse = false } = {}) {
    const db = { balance: 10, debits: 0, keys: {}, calls: [] };
    const toasts = [];
    const btn = { disabled: false, textContent: '' };
    const ctx = {
        console, setTimeout, Promise, Math, Date, JSON, Number, String, Object,
        toasts, db, btn,
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: (id) => (id === 'chargeBtn' ? btn : null), querySelector: () => null },
        toast: (m, bad) => toasts.push([m, !!bad]),
        renderCampers() {}, renderItems() {}, renderCart() {}, updateCamperBar() {}, saveSnacksData() {}, _dbg() {},
        todayStr: () => '2026-08-20', STORE_KEY: 'k', SNACKS_LOCAL_KEY: 'k2',
    };
    let n = 0;
    const charge = (args) => {
        if (refuse) return { success: false, error: 'insufficient_balance', spendable: 0 };
        db.balance = Math.round((db.balance - args.p_amount) * 100) / 100; db.debits++;
        return { success: true, balance: db.balance, spentToday: 10 - db.balance, camper: 'Avi' };
    };
    ctx.window = { CampistryDB: { getCampId: () => 'camp1', getClient: () => ({
        functions: { invoke: () => Promise.resolve({}) },
        rpc: (fn, args) => new Promise((resolve) => setTimeout(() => {
            const i = ++n;
            db.calls.push(fn);
            let out;
            if (fn === 'submit_canteen_purchase_once' && noOnce) out = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
            else if (fn === 'submit_canteen_purchase_once') {
                const k = args.p_sale_key;
                if (db.keys[k]) out = { data: Object.assign({}, db.keys[k], { replayed: true }), error: null };
                else { const r = charge(args); if (r.success) db.keys[k] = r; out = { data: r, error: null }; }
            } else if (fn === 'submit_canteen_purchase') out = { data: charge(args), error: null };
            else out = { data: {}, error: null };
            if (lose.includes(i)) out = { data: null, error: { message: 'TypeError: Failed to fetch' } };
            resolve(out);
        }, 5)),
    }) } };
    vm.createContext(ctx);
    vm.runInContext(`var sel = 'Avi', cart = [{ id: 1, qty: 1 }];
var snacks = { inventory: [{ id: 1, name: 'Chips', price: 2.5, stock: 10 }], transactions: [], accounts: { Avi: { balance: 10, dailyLimit: 10, spentToday: 0 } } };
var campers = [{ name: 'Avi', camperId: 7 }];
function getAccount(n) { return snacks.accounts[n]; }
` + chargeCode(POS_NOW) + `
this.tap = function () { window.charge(); };
this.reset = function () { sel = 'Avi'; cart = [{ id: 1, qty: 1 }]; };
this.state = function () { return { sel: sel, cart: cart.length }; };`, ctx);
    return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 40));

test('TED-159: two taps while the charge is on its way — one request, one charge', async () => {
    const r = register();
    r.tap(); r.tap();
    assert.strictEqual(r.btn.disabled, true, 'the button stayed live while charging');
    await settle();
    assert.strictEqual(r.db.debits, 1, 'charged ' + r.db.debits + ' times');
    assert.deepStrictEqual(r.db.calls.filter(c => c.startsWith('submit_canteen')), ['submit_canteen_purchase_once']);
    assert.ok(r.toasts.some(([m]) => m === '✓ $2.50 charged to Avi'), JSON.stringify(r.toasts));
    assert.ok(!r.toasts.some(([m]) => /null/.test(m)));
});

test('TED-159: the answer is lost after the server charged — "could not confirm", and a second tap charges nothing more', async () => {
    const r = register({ lose: [1] });
    r.tap();
    await settle();
    assert.strictEqual(r.db.debits, 1);
    assert.ok(!r.toasts.some(([m]) => /Charge failed/.test(m)), 'told "failed": ' + JSON.stringify(r.toasts));
    assert.match(r.toasts[r.toasts.length - 1][0], /Could not confirm the charge to Avi — it may have gone through/);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.state())), { sel: 'Avi', cart: 1 }, 'the sale is still on the screen to retry');
    r.tap();                                   // the counselor tries again
    await settle();
    assert.strictEqual(r.db.debits, 1, 'the retry charged the child again');
    assert.ok(r.toasts.some(([m]) => m === '✓ $2.50 charged to Avi'));
});

test('TED-159: after a sale is answered, the next sale is a new one (a new key) and is charged', async () => {
    const r = register();
    r.tap(); await settle();
    r.reset(); r.tap(); await settle();
    assert.strictEqual(r.db.debits, 2, 'a second, real sale was taken for a repeat');
});

test('TED-159: a refusal is final for that sale — nothing charged, the next tap is a new try', async () => {
    const r = register({ refuse: true });
    r.tap(); await settle();
    assert.strictEqual(r.db.debits, 0);
    assert.match(r.toasts[r.toasts.length - 1][0], /insufficient balance/);
    assert.strictEqual(r.btn.disabled, false, 'the button stayed locked after the answer');
});

test('TED-159: before migration 283 is pasted the register still charges (once per tap, as before)', async () => {
    const r = register({ noOnce: true });
    r.tap(); await settle();
    assert.strictEqual(r.db.debits, 1);
    assert.deepStrictEqual(r.db.calls.filter(c => c.startsWith('submit_canteen')), ['submit_canteen_purchase_once', 'submit_canteen_purchase']);
});
