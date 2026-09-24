// =============================================================================
// snacks_void_sale.test.js — TED-175, the Snacks page's own code.
//
// A child charged by mistake could only be given the money back with Add
// Deposit, which records cash or card that nobody paid in, and the mistaken
// sale still counted as a sale. Now a sale in a child's history has "Void":
// the server (migration 284, pgtest 284) reverses THAT sale; here, the page
// offers it only for register sales, sends which sale and which items go back
// in stock, sends it once, and leaves a voided sale out of sales.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SN = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.html'), 'utf8');
function cut(name) {
    const at = SN.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = SN.indexOf('{', at), d = 0;
    for (; i < SN.length; i++) { if (SN[i] === '{') d++; else if (SN[i] === '}' && --d === 0) break; }
    return SN.slice(at, i + 1);
}
function win(name) {
    const at = SN.indexOf('window.' + name + ' = function');
    assert.ok(at >= 0, name + ' is missing');
    let i = SN.indexOf('{', at), d = 0;
    for (; i < SN.length; i++) { if (SN[i] === '{') d++; else if (SN[i] === '}' && --d === 0) break; }
    return SN.slice(at, i + 2);
}

function page(opts) {
    opts = opts || {};
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, textContent: '', innerHTML: '', value: '', disabled: false,
        querySelectorAll: () => (els.__boxes || []), getAttribute() {} });
    const sent = [], toasts = [];
    let answer = opts.answer || ((args) => Promise.resolve({ data: { success: true, amount: 5, balance: 10, restocked: args.p_restock.reduce((s, r) => s + r.qty, 0) } }));
    const today = '2026-08-20';
    const ctx = {
        console, Promise, Math, Number, String, JSON, Object,
        document: { getElementById: el },
        esc: (s) => String(s), toast: (m, e) => toasts.push((e ? '!' : '') + m), todayStr: () => today,
        _secEdit: () => opts.edit !== false, openM() {}, closeM() {}, _deskMessage: (r, d, f) => f + (d && d.error ? ': ' + d.error : ''),
        _deskRefresh: (done) => done && done(), viewAccountHistory() {},
        _deskRpc: () => ({ campId: 'c1', client: { rpc: (fn, args) => { sent.push([fn, JSON.parse(JSON.stringify(args))]); return answer(args); } } }),
        _histCamper: 'Avi',
        window: { CampistrySections: { canEdit: () => opts.edit !== false } },
        sent, toasts, els,
    };
    vm.createContext(ctx);
    vm.runInContext('var window = this.window; var _voidRows = [], _voidCache = { arr: null, len: -1, set: {} }, _voidTarget = null, _voidBusy = false;\n'
        + ['_voidedSigs', '_canVoid', '_mayEditAccounts', '_saleItemsToRestock', '_isSale', '_histRowHtml'].map(cut).join('\n')
        + '\n' + win('openVoidSale') + '\n' + win('confirmVoidSale')
        + '\nthis.row = _histRowHtml; this.isSale = _isSale; this.open = window.openVoidSale; this.confirm = window.confirmVoidSale;'
        + '\nthis.rows = function () { return _voidRows; }; this.restock = _saleItemsToRestock;', ctx);
    ctx.snacks = { inventory: [{ id: 1, name: 'Ices', price: 2.5, stock: 10, soldToday: 2, totalSold: 5 },
                                { id: 2, name: 'Chips', price: 1, stock: null }],
        transactions: [
            { sig: 's1', date: today, time: '10:00 AM', type: 'debit', amount: 5, items: 'Ices ×2, Chips, Old Candy', camper: 'Avi' },
            { sig: 's2', date: today, type: 'debit', kind: 'shop', amount: 12, items: 'Hoodie', camper: 'Avi' },
            { sig: 's3', date: today, type: 'credit', amount: 20, method: 'cash', camper: 'Avi' },
            { sig: 's4', date: today, type: 'debit', kind: 'offline_sale', amount: 1, items: 'Chips', camper: 'Avi' },
        ] };
    return ctx;
}
// the checkboxes openVoidSale draws, as the browser would give them back
function boxes(ctx, checked) {
    const html = ctx.els.voidItems.innerHTML;
    ctx.els.__boxes = [...html.matchAll(/data-void-item="(\d+)"/g)].map(m => ({
        checked: checked(Number(m[1])), getAttribute: () => m[1] }));
}

test('TED-175: "Void" is offered on register sales only, and only to someone who can edit accounts', () => {
    const P = page();
    const html = P.snacks.transactions.map(P.row);
    assert.match(html[0], /openVoidSale\(0\)/);
    assert.doesNotMatch(html[1], /Void</, 'a Shop order (the Shop refunds its own)');
    assert.doesNotMatch(html[2], /Void</, 'a deposit');
    assert.match(html[3], /openVoidSale\(1\)/, 'a sale from the offline register');
    const V = page({ edit: false });
    assert.doesNotMatch(V.snacks.transactions.map(V.row).join(''), />Void</, 'view-only staff');
    assert.doesNotMatch(V.row({ type: 'debit', amount: 1, items: 'x' }), />Void</, 'a row the server gave no sig');
});

test('TED-175: the office voids the sale — which sale, which items back in stock; one request for a double click', async () => {
    const P = page();
    P.snacks.transactions.map(P.row);
    P.open(0);
    assert.match(P.els.voidSummary.innerHTML, /not as a deposit/);
    assert.match(P.els.voidItems.innerHTML, /Put 2 × Ices back in stock/);
    assert.match(P.els.voidItems.innerHTML, /Chips — stock is not counted/);
    assert.match(P.els.voidItems.innerHTML, /Old Candy — not on the item list any more/);
    boxes(P, () => true);
    P.confirm(); P.confirm();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(P.sent.length, 1, 'a double click voided twice');
    assert.deepStrictEqual(P.sent[0], ['canteen_void_sale', { p_camp_id: 'c1', p_sig: 's1', p_restock: [{ id: 1, qty: 2 }], p_note: null }]);
    assert.strictEqual(P.snacks.inventory[0].stock, 12);
    assert.match(P.toasts[0], /^Voided — \$5\.00 back on Avi’s balance and 2 items back in stock/);
});

test('TED-175: an item the child kept is not restocked; a refusal says why', async () => {
    const P = page({ answer: () => Promise.resolve({ data: { success: false, error: 'already_voided', message: 'That sale was already voided — the money is back on the balance.' } }) });
    P.snacks.transactions.map(P.row);
    P.open(0);
    boxes(P, () => false);
    P.confirm();
    await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual(P.sent[0][1].p_restock, []);
    assert.deepStrictEqual(P.toasts, ['!That sale was already voided — the money is back on the balance.']);
    assert.strictEqual(P.snacks.inventory[0].stock, 10, 'stock moved on a refused void');
});

test('TED-175: a voided sale is no longer a sale, and cannot be voided again', () => {
    const P = page();
    assert.strictEqual(P.isSale(P.snacks.transactions[0]), true);
    P.snacks.transactions.push({ sig: 'void:s1', type: 'credit', kind: 'void', voidOf: 's1', amount: 5, items: 'Sale voided: Ices ×2', camper: 'Avi' });
    assert.strictEqual(P.isSale(P.snacks.transactions[0]), false, 'the voided sale still counts in Sales today');
    const html = P.row(P.snacks.transactions[0]);
    assert.match(html, /Voided/);
    assert.doesNotMatch(html, />Void</);
    assert.match(P.row(P.snacks.transactions[4]), /Sale voided: Ices ×2.*\+\$5\.00/s);
});

test('TED-175: the dialog is on the page', () => {
    assert.match(HTML, /id="m-void"/);
    assert.match(HTML, /onclick="confirmVoidSale\(\)"/);
    assert.match(HTML, /id="voidItems"/);
});

test('TED-192: a sale that kept its items by id offers exactly those back — names with commas or numbers included', () => {
    const P = page();
    P.snacks.inventory.push({ id: 3, name: 'Chips, BBQ', price: 1, stock: 4 }, { id: 4, name: 'Trail Mix 2', price: 2, stock: 4 });
    const list = P.restock('Trail Mix 2 ×2, Chips, BBQ', [{ id: 4, qty: 2 }, { id: 3, qty: 1 }]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(list)), [
        { id: 4, name: 'Trail Mix 2', qty: 2, tracked: true }, { id: 3, name: 'Chips, BBQ', qty: 1, tracked: true }]);
    // an older sale with no ids still goes by its line
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P.restock('Ices ×2').map(x => [x.id, x.qty]))), [[1, 2]]);
});
