// =============================================================================
// offline_register_once.test.js — TED-170 and TED-171, the offline register's
// own code (campistry_snacks_pos_offline.html).
//
// TED-170. A double tap on a slow tablet recorded two sales for one item: the
// charge waits on the tablet's storage before it clears the cart, and nothing
// stopped the second tap. Now one sale is charged at a time.
// TED-171. Exporting marked every sale exported the moment the download
// started, with no way to export them again — a lost file lost those sales.
// Now "Export all sales again" sends every sale (the office's import skips any
// it already has), and Clear All Data says what would be lost.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks_pos_offline.html'), 'utf8');
function slice(startMark, endMark) {
    const a = HTML.indexOf(startMark);
    assert.ok(a >= 0, startMark + ' is missing');
    const b = HTML.indexOf(endMark, a);
    assert.ok(b > a, endMark + ' is missing');
    return HTML.slice(a, b);
}

function tablet() {
    const toasts = [], saved = [], downloads = [];
    const btn = { disabled: false, textContent: '' };
    const ctx = {
        console, setTimeout, Promise, Math, JSON, Date, toasts, saved, downloads,
        toast: (m) => toasts.push(m),
        document: {
            getElementById: (id) => (id === 'chargeBtn' ? btn : null), querySelector: () => null,
            createElement: () => ({ click() { downloads.push(ctx.__lastBlob); } }), body: { appendChild() {}, removeChild() {} },
        },
        Blob: function (parts) { ctx.__lastBlob = JSON.parse(parts[0]); },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        // the tablet's storage answers later, as IndexedDB does
        saveAccount: () => new Promise(r => setTimeout(r, 20)),
        saveInventoryItem: () => new Promise(r => setTimeout(r, 5)),
        saveTransaction: (t) => new Promise(r => setTimeout(() => { saved.push(t.id); r(); }, 5)),
        todayStr: () => '2026-08-20', generateId: (() => { let n = 0; return () => 'tx' + (++n); })(),
        renderCart() {}, updateCamperBar() {},
    };
    vm.createContext(ctx);
    vm.runInContext(`var POS = { renderCampers() {}, renderItems() {} };
var sel = 'Avi', cart = [{ id: 1, qty: 1 }];
var inventory = [{ id: 1, name: 'Ices', price: 2.5, stock: 30 }];
var accounts = { Avi: { balance: 17.5, dailyLimit: 20, spentToday: 0, camperId: 7 } };
function getAccount(n) { return accounts[n]; }
var transactions = [], meta = { campName: 'Camp' };
` + slice('var _offlineCharging = false;', "document.getElementById('chargeBtn').addEventListener")
      + slice('POS.exportAllTransactions = function()', '// ─── Settings UI')
      + `\nthis.POS = POS; this.state = function () { return { bal: accounts.Avi.balance, sales: transactions.length, stock: inventory[0].stock }; };
this.tx = function () { return transactions; };`, ctx);
    return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 80));

test('TED-170: a double tap at the same instant records one sale, one debit, one item', async () => {
    const t = tablet();
    t.POS.charge(); t.POS.charge();
    await settle();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t.state())), { bal: 15, sales: 1, stock: 29 });
    assert.deepStrictEqual(t.toasts, ['Charged $2.50 to Avi']);
});

test('TED-171: after an export, "Export all sales again" sends every sale (the office import skips repeats)', async () => {
    const t = tablet();
    t.POS.charge(); await settle();
    t.POS.exportTransactions();
    await settle();
    assert.strictEqual(t.downloads[0].transactionCount, 1);
    t.POS.exportTransactions();                      // the old button: nothing new
    assert.strictEqual(t.downloads[1].transactionCount, 0);
    t.POS.exportAllTransactions();                   // the file was lost
    assert.strictEqual(t.downloads[2].transactionCount, 1, 'a lost file\'s sales could not be sent again');
    assert.strictEqual(t.downloads[2].transactions[0].camperId, 7);
});

test('TED-171: Clear All Data says what would be lost', () => {
    assert.match(HTML, /never been exported \\u2014 export first, or they are lost/);
    assert.match(HTML, /Check the office imported the exported file/);
    assert.match(HTML, /onclick="POS\.exportAllTransactions\(\)"/);
});
