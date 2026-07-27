// node --test tests/shop_core.test.js
// Validates the camp shop catalogue/pricing/stock rules:
//   • variant ids are derived, so editing a product doesn't orphan old orders
//   • per-size price uplift, discounts that can't go negative, tax after discount
//   • stock checks sum duplicate lines before comparing
//   • the size roll-up a camp uses to place a print run
const test = require('node:test');
const assert = require('node:assert');
const S = require('../campistry_shop_core.js');

const TEE = {
    id: 1, sku: 'TEE', name: 'Camp Tee', category: 'tees', price: 18,
    sizes: ['YM', 'AM', 'AXXL'], colors: ['Navy', 'White'],
    priceDeltas: { AXXL: 3 },
    stock: {}
};
function teeWithStock(stock) { return Object.assign({}, TEE, { stock: stock }); }
const vid = (size, color) => S.variantId(TEE, size, color);

test('variantId is derived from the option values, and is stable', () => {
    assert.strictEqual(vid('AM', 'Navy'), 'tee:am:navy');
    assert.strictEqual(vid('AM', 'Navy'), S.variantId(TEE, 'AM', 'Navy'));
    // Adding a size to the product must not change any other variant's id,
    // or every order already referencing them is orphaned.
    const grown = Object.assign({}, TEE, { sizes: ['YS', 'YM', 'AM', 'AXXL'] });
    assert.strictEqual(S.variantId(grown, 'AM', 'Navy'), 'tee:am:navy');
});

test('variantId handles a product with no sizes or colours', () => {
    assert.strictEqual(S.variantId({ sku: 'HAT' }, '', ''), 'hat:onesize:default');
});

test('variants: the full size x colour grid, with stock and price filled in', () => {
    const vs = S.variants(teeWithStock({ 'tee:am:navy': 12 }));
    assert.strictEqual(vs.length, 6);                     // 3 sizes × 2 colours
    const amNavy = vs.find(v => v.id === 'tee:am:navy');
    assert.strictEqual(amNavy.stock, 12);
    assert.strictEqual(amNavy.price, 18);
    // A variant with no stock entry reads as 0, never as unlimited.
    assert.strictEqual(vs.find(v => v.id === 'tee:am:white').stock, 0);
});

test('variants: a per-size uplift only touches that size', () => {
    const vs = S.variants(TEE);
    assert.strictEqual(vs.find(v => v.size === 'AXXL').price, 21);
    assert.strictEqual(vs.find(v => v.size === 'AM').price, 18);
});

test('variants: a product with no options still yields one sellable variant', () => {
    const vs = S.variants({ id: 9, sku: 'HAT', name: 'Cap', price: 15 });
    assert.strictEqual(vs.length, 1);
    assert.strictEqual(vs[0].label, 'One size');
});

test('totalStock and lowStockVariants', () => {
    const p = teeWithStock({ 'tee:am:navy': 12, 'tee:ym:navy': 3 });
    assert.strictEqual(S.totalStock(p), 15);
    const low = S.lowStockVariants(p, 5).map(v => v.id);
    assert.ok(low.includes('tee:ym:navy'));
    assert.ok(!low.includes('tee:am:navy'));
});

// ── order totals ────────────────────────────────────────────────────────────

const order = over => Object.assign({
    id: 'o1', camperName: 'Eli Katz', bunk: 'A1', status: 'placed',
    lines: [
        { productId: 1, name: 'Camp Tee', size: 'AM', color: 'Navy', qty: 2, unitPrice: 18 },
        { productId: 1, name: 'Camp Tee', size: 'AXXL', color: 'Navy', qty: 1, unitPrice: 21 }
    ]
}, over || {});

test('orderTotals: lines multiply out and sum', () => {
    const t = S.orderTotals(order(), [TEE]);
    assert.strictEqual(t.itemCount, 3);
    assert.strictEqual(t.subtotal, 57);      // 2×18 + 1×21
    assert.strictEqual(t.total, 57);
});

test('orderTotals: a line keeps its own price, so old orders do not re-price', () => {
    // The catalogue price changes; the recorded order must not move.
    const dearer = Object.assign({}, TEE, { price: 25 });
    const t = S.orderTotals(order(), [dearer]);
    assert.strictEqual(t.subtotal, 57);
});

test('orderTotals: a line with no recorded price falls back to the catalogue', () => {
    const o = { lines: [{ productId: 1, size: 'AXXL', qty: 2 }] };
    const t = S.orderTotals(o, [TEE]);
    assert.strictEqual(t.subtotal, 42);      // 2 × (18 + 3)
});

test('orderTotals: percentage and flat discounts both apply', () => {
    assert.strictEqual(S.orderTotals(order({ discountPct: 10 }), [TEE]).discount, 5.7);
    assert.strictEqual(S.orderTotals(order({ discountAmt: 7 }), [TEE]).discount, 7);
    assert.strictEqual(S.orderTotals(order({ discountPct: 10, discountAmt: 7 }), [TEE]).discount, 12.7);
});

test('orderTotals: a discount can never exceed the subtotal', () => {
    const t = S.orderTotals(order({ discountAmt: 500 }), [TEE]);
    assert.strictEqual(t.discount, 57);
    assert.strictEqual(t.total, 0);          // floored, never negative
});

test('orderTotals: tax applies after the discount, not before', () => {
    const t = S.orderTotals(order({ discountAmt: 7, taxRate: 0.1 }), [TEE]);
    assert.strictEqual(t.tax, 5);            // (57 − 7) × 0.1
    assert.strictEqual(t.total, 55);
});

test('orderTotals: a line for a deleted product is flagged, not dropped', () => {
    const t = S.orderTotals(order(), []);
    assert.strictEqual(t.lines.length, 2);
    assert.ok(t.lines.every(l => l.missing));
    assert.strictEqual(t.subtotal, 57);      // recorded prices still stand
});

test('orderTotals: an empty order is zeroes, not a throw', () => {
    const t = S.orderTotals({}, []);
    assert.strictEqual(t.subtotal, 0);
    assert.strictEqual(t.total, 0);
    assert.strictEqual(t.itemCount, 0);
});

// ── stock ───────────────────────────────────────────────────────────────────

test('checkStock: passes when every variant has enough', () => {
    const p = teeWithStock({ 'tee:am:navy': 5, 'tee:axxl:navy': 2 });
    assert.strictEqual(S.checkStock(order(), [p]).ok, true);
});

test('checkStock: reports the shortfall per variant', () => {
    const p = teeWithStock({ 'tee:am:navy': 1, 'tee:axxl:navy': 0 });
    const res = S.checkStock(order(), [p]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.shortfalls.length, 2);
    const am = res.shortfalls.find(s => s.size === 'AM');
    assert.strictEqual(am.wanted, 2);
    assert.strictEqual(am.available, 1);
    assert.strictEqual(am.shortBy, 1);
});

test('checkStock: two lines of the same variant are summed before checking', () => {
    // Each line of 2 would pass against a stock of 3; the pair must not.
    const o = { lines: [
        { productId: 1, size: 'AM', color: 'Navy', qty: 2 },
        { productId: 1, size: 'AM', color: 'Navy', qty: 2 }
    ] };
    const p = teeWithStock({ 'tee:am:navy': 3 });
    const res = S.checkStock(o, [p]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.shortfalls[0].wanted, 4);
    assert.strictEqual(res.shortfalls[0].shortBy, 1);
});

test('applyStock: fulfilling deducts, returning adds back, and nothing mutates', () => {
    const p = teeWithStock({ 'tee:am:navy': 5, 'tee:axxl:navy': 2 });
    const after = S.applyStock(p, order(), -1);
    assert.strictEqual(after['tee:am:navy'], 3);
    assert.strictEqual(after['tee:axxl:navy'], 1);
    assert.strictEqual(p.stock['tee:am:navy'], 5);      // original untouched

    const back = S.applyStock(Object.assign({}, p, { stock: after }), order(), 1);
    assert.strictEqual(back['tee:am:navy'], 5);
});

test('applyStock never drives a variant below zero', () => {
    const p = teeWithStock({ 'tee:am:navy': 1 });
    const after = S.applyStock(p, order(), -1);
    assert.strictEqual(after['tee:am:navy'], 0);
});

// ── reporting ───────────────────────────────────────────────────────────────

const ORDERS = [
    order({ id: 'a', paid: true }),
    order({ id: 'b', paid: false, lines: [{ productId: 1, name: 'Camp Tee', size: 'YM', qty: 4, unitPrice: 18 }] }),
    order({ id: 'c', status: 'cancelled', lines: [{ productId: 1, size: 'AM', qty: 99, unitPrice: 18 }] })
];

test('sizeBreakdown counts units per size, youth to adult, ignoring cancellations', () => {
    const rows = S.sizeBreakdown(ORDERS);
    assert.deepStrictEqual(rows.map(r => r.size), ['YM', 'AM', 'AXXL']);
    assert.deepStrictEqual(rows.map(r => r.qty), [4, 2, 1]);   // the 99 cancelled AM is gone
});

test('sizeBreakdown can scope to one product', () => {
    const rows = S.sizeBreakdown(ORDERS.concat([
        { status: 'placed', lines: [{ productId: 2, size: 'AL', qty: 3 }] }
    ]), { productId: 2 });
    assert.deepStrictEqual(rows.map(r => r.size), ['AL']);
});

test('topSellers ranks by units and sums revenue', () => {
    const rows = S.topSellers(ORDERS, [TEE]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].qty, 7);            // 2 + 1 + 4
    assert.strictEqual(rows[0].revenue, 129);      // 36 + 21 + 72
});

test('pickListByBunk groups orders, with Unassigned sorted last', () => {
    const rows = S.pickListByBunk([
        order({ id: 'x', bunk: 'A2' }),
        order({ id: 'y', bunk: '' }),
        order({ id: 'z', bunk: 'A10' }),
        order({ id: 'w', bunk: 'A2' })
    ]);
    // Natural sort, so A10 comes after A2 rather than before it.
    assert.deepStrictEqual(rows.map(r => r.bunk), ['A2', 'A10', 'Unassigned']);
    assert.strictEqual(rows[0].orders.length, 2);
    assert.strictEqual(rows[0].items, 6);
});

test('revenue splits collected from outstanding and skips cancellations', () => {
    const r = S.revenue(ORDERS, [TEE]);
    assert.strictEqual(r.orders, 2);
    assert.strictEqual(r.collected, 57);
    assert.strictEqual(r.outstanding, 72);
    assert.strictEqual(r.total, 129);
});
