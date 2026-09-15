// node --test tests/canteen_shop_money.test.js
//
// The canteen wallet and the Camp Shop.
//
// THE CANTEEN INVARIANT, which is the whole safety property of that system:
//
//     account.balance  ===  Σ transactions  (credit +, anything else −)
//
// The canteen is event-sourced on purpose. _reconcileBalances() in
// campistry_snacks.js RECOMPUTES every balance from the append-only
// transaction ledger, and cloudSaveSnacks() unions two devices' ledgers and
// recomputes — which is what stops a stale POS tab from erasing a parent's
// deposit. The consequence that is easy to miss: a code path that adjusts a
// balance WITHOUT appending a matching transaction is not merely inconsistent,
// it is a no-op that gets silently erased by the next merge. Money appears,
// then vanishes.
//
// THE SHOP DEFECT this pins: the admin shop's order form offered "Charge to
// canteen account" and "Charge to camp bill", stored the choice, displayed it,
// exported it to CSV — and settled neither. The camp handed over a sweatshirt
// and the money was recorded nowhere. The parent-facing shop (migration 122)
// had always debited the wallet correctly, which is how we know what the admin
// path was supposed to do.
//
// Migration 167 adds settle_shop_order. The model below mirrors it, because the
// hard part is not taking the money once — it is an order that gets EDITED.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SC = require('../campistry_shop_core.js');

const money = n => Math.round((Number(n) || 0) * 100) / 100;

// ── the canteen ledger ─────────────────────────────────────────────────────

/** _reconcileBalances: balance is DERIVED, never stored independently. */
function reconcile(snacks) {
    const byCamper = {};
    (snacks.transactions || []).forEach(t => {
        if (!t || !t.camper) return;
        const amt = parseFloat(t.amount) || 0;
        byCamper[t.camper] = (byCamper[t.camper] || 0) + (t.type === 'credit' ? amt : -amt);
    });
    Object.keys(snacks.accounts || {}).forEach(name => {
        if (byCamper[name] != null) snacks.accounts[name].balance = money(byCamper[name]);
    });
    return snacks;
}

function ledgerTotal(snacks, camper) {
    return money((snacks.transactions || [])
        .filter(t => t.camper === camper)
        .reduce((s, t) => s + (t.type === 'credit' ? 1 : -1) * (parseFloat(t.amount) || 0), 0));
}

/** The invariant, asserted directly. */
function assertLedgerHolds(snacks, camper, what) {
    const stored = money(snacks.accounts[camper].balance);
    const derived = ledgerTotal(snacks, camper);
    assert.strictEqual(stored, derived,
        `${what}: stored balance ${stored} but the ledger sums to ${derived}`);
}

function wallet(startingCredit) {
    const s = { accounts: { 'Malky Stein': { balance: 0, dailyLimit: 10, spentToday: 0 } },
                transactions: [] };
    if (startingCredit) {
        s.transactions.unshift({ camper: 'Malky Stein', amount: startingCredit,
                                 type: 'credit', kind: 'deposit', items: 'Deposit' });
    }
    return reconcile(s);
}

test('a deposit credits, a purchase debits, and the ledger stays the truth', () => {
    const s = wallet(50);
    assertLedgerHolds(s, 'Malky Stein', 'after deposit');
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50);

    s.transactions.unshift({ camper: 'Malky Stein', amount: 12.5, type: 'debit', items: 'Snacks' });
    reconcile(s);
    assertLedgerHolds(s, 'Malky Stein', 'after purchase');
    assert.strictEqual(s.accounts['Malky Stein'].balance, 37.5);
});

test('a balance moved WITHOUT a transaction is erased by the next reconcile', () => {
    // Not a hypothetical — this is why every mutation site in campistry_snacks.js
    // pushes a transaction next to the balance change. Anything that forgets
    // produces money that appears and then silently vanishes on the next merge.
    const s = wallet(50);
    s.accounts['Malky Stein'].balance = 500;        // a "gift" with no ledger row
    reconcile(s);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50, 'the phantom credit survived');
});

test('cash out is a debit, not a credit', () => {
    // buildTransaction in campistry_snacks_cash.js sets type:'debit'. If that
    // were 'credit', paying a camper cash would ADD to their balance.
    const s = wallet(50);
    s.transactions.unshift({ camper: 'Malky Stein', amount: 20, type: 'debit',
                             kind: 'cash_out', items: 'Cash out' });
    reconcile(s);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 30);
});

test('a canteen refund debits — the money left the wallet and went to the card', () => {
    // refund_canteen_deposit_from_processor writes type:'debit', kind:'refund'.
    // A 'credit' here would refund the card AND leave the balance, paying twice.
    const s = wallet(50);
    s.transactions.unshift({ camper: 'Malky Stein', amount: 50, type: 'debit',
                             kind: 'refund', items: 'Refund — deposit reversed' });
    reconcile(s);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 0);
    assertLedgerHolds(s, 'Malky Stein', 'after refund');
});

test('the same deposit arriving twice is only counted once', () => {
    // The processor RPCs guard on an external id before applying. Modelled here
    // as the dedupe the merge path also does by signature.
    const s = wallet(0);
    const row = { camper: 'Malky Stein', amount: 25, type: 'credit', kind: 'deposit',
                  date: '2026-07-01', time: '9:00 AM', items: 'Deposit', byopRefundId: 'x1' };
    const sig = t => [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|');
    [row, Object.assign({}, row)].forEach(t => {
        if ((s.transactions || []).some(e => sig(e) === sig(t))) return;
        s.transactions.unshift(t);
    });
    reconcile(s);
    assert.strictEqual(s.transactions.length, 1);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 25);
});

// ── shop order totals ──────────────────────────────────────────────────────

const CATALOGUE = [{ id: 1, name: 'Camp Tee', price: 20, priceDeltas: { XL: 2 } }];
const order = over => Object.assign({
    lines: [{ productId: 1, qty: 2, unitPrice: 20 }], taxRate: 0,
}, over || {});

test('shop totals: qty x unit, then discount, then tax', () => {
    const t = SC.orderTotals(order({ discountAmt: 5, taxRate: 0.1 }), CATALOGUE);
    assert.strictEqual(t.subtotal, 40);
    assert.strictEqual(t.discount, 5);
    assert.strictEqual(t.tax, money(35 * 0.1));
    assert.strictEqual(t.total, money(35 + 3.5));
});

test('shop discounts are additive and clamped, like tuition discounts', () => {
    const t = SC.orderTotals(order({ discountAmt: 5, discountPct: 10 }), CATALOGUE);
    assert.strictEqual(t.discount, 9);            // 5 + 10% of 40
    assert.strictEqual(t.total, 31);

    const over = SC.orderTotals(order({ discountAmt: 500 }), CATALOGUE);
    assert.strictEqual(over.discount, 40, 'a discount must stop at the subtotal');
    assert.strictEqual(over.total, 0, 'an order total must never go negative');
});

test('a line keeps its own frozen price when the catalogue changes', () => {
    const t = SC.orderTotals(order(), [{ id: 1, name: 'Camp Tee', price: 99 }]);
    assert.strictEqual(t.subtotal, 40, 'an old order silently re-priced');
});

// ── shop settlement — mirrors migration 167 ────────────────────────────────
//
// The hard part is not taking the money once. It is an order that gets edited:
// a size changes, the method switches, it is cancelled. A naive "charge on
// save" double-charges on the second save.

function settle(state, order, payMethod, total, cancelled) {
    const newMethod = cancelled ? 'none' : (payMethod || 'none');
    const newAmt = cancelled ? 0 : money(total);
    const cur = order.settlement || { method: 'none', amount: 0 };

    if (cur.method === newMethod && money(cur.amount) === newAmt) return 'unchanged';

    // canteen: append-only delta, because the balance is derived from the ledger
    const delta = (newMethod === 'canteen' ? newAmt : 0) -
                  (cur.method === 'canteen' ? money(cur.amount) : 0);
    if (delta !== 0) {
        state.snacks.transactions.unshift({
            camper: order.camperName, amount: Math.abs(delta),
            type: delta > 0 ? 'debit' : 'credit', kind: 'shop',
            items: delta > 0 ? 'Camp Shop order' : 'Camp Shop order — reversed',
            shopOrderId: order.id,
        });
        reconcile(state.snacks);
    }

    // bill: a SET of one charge keyed to the order — re-settling replaces
    if (cur.method === 'bill' || newMethod === 'bill') {
        const fam = state.families[order.familyKey];
        fam.charges = (fam.charges || []).filter(c => c.id !== 'shop_' + order.id);
        if (newMethod === 'bill' && newAmt > 0) {
            fam.charges.push({ id: 'shop_' + order.id, category: 'Camp Shop',
                               amount: newAmt, shopOrderId: order.id });
        }
    }

    order.settlement = { method: newMethod, amount: newAmt };
    order.paid = (newMethod === 'canteen' || newMethod === 'bill') ? true : !!order.paid;
    return 'settled';
}

function shopState() {
    return {
        snacks: wallet(100),
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'], charges: [] } },
    };
}
const newOrder = () => ({ id: 'ord_1', camperName: 'Malky Stein', familyKey: 'f1' });

test('charging an order to the canteen actually takes the money', () => {
    // The defect: this did nothing at all.
    const st = shopState(), o = newOrder();
    settle(st, o, 'canteen', 40);
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 60);
    assertLedgerHolds(st.snacks, 'Malky Stein', 'canteen shop order');
    assert.strictEqual(o.paid, true);
});

test('charging an order to the camp bill posts one charge the parent will see', () => {
    const st = shopState(), o = newOrder();
    settle(st, o, 'bill', 40);
    assert.strictEqual(st.families.f1.charges.length, 1);
    assert.strictEqual(st.families.f1.charges[0].amount, 40);
    // The canteen is untouched — the two must never both take the money.
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 100);
});

test('RE-SAVING AN UNCHANGED ORDER TAKES NOTHING MORE', () => {
    // The double-charge every naive implementation has.
    const st = shopState(), o = newOrder();
    settle(st, o, 'canteen', 40);
    assert.strictEqual(settle(st, o, 'canteen', 40), 'unchanged');
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 60);
    assert.strictEqual(st.snacks.transactions.filter(t => t.kind === 'shop').length, 1);
});

test('editing the total posts only the difference', () => {
    const st = shopState(), o = newOrder();
    settle(st, o, 'canteen', 40);
    settle(st, o, 'canteen', 55);
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 45);   // 100 - 55
    assertLedgerHolds(st.snacks, 'Malky Stein', 'after increase');

    settle(st, o, 'canteen', 25);
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 75);   // 100 - 25
    assertLedgerHolds(st.snacks, 'Malky Stein', 'after decrease');
});

test('switching canteen -> camp bill gives the wallet back and bills once', () => {
    const st = shopState(), o = newOrder();
    settle(st, o, 'canteen', 40);
    settle(st, o, 'bill', 40);
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 100, 'the wallet was not refunded');
    assert.strictEqual(st.families.f1.charges.length, 1);
    assertLedgerHolds(st.snacks, 'Malky Stein', 'after switching to bill');
});

test('switching camp bill -> canteen removes the charge and debits the wallet', () => {
    const st = shopState(), o = newOrder();
    settle(st, o, 'bill', 40);
    settle(st, o, 'canteen', 40);
    assert.strictEqual(st.families.f1.charges.length, 0, 'the family is still billed');
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 60);
});

test('switching to cash reverses whatever was taken and posts nothing', () => {
    // Cash is collected outside Campistry. The important half is the reversal:
    // otherwise the camp holds the cash AND the camper's wallet is still down.
    for (const method of ['cash', 'check', 'credit']) {
        const st = shopState(), o = newOrder();
        settle(st, o, 'canteen', 40);
        settle(st, o, method, 40);
        assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 100,
            'switching to ' + method + ' did not return the canteen money');
        assert.strictEqual(st.families.f1.charges.length, 0);
    }
});

test('cancelling an order gives everything back', () => {
    for (const method of ['canteen', 'bill']) {
        const st = shopState(), o = newOrder();
        settle(st, o, method, 40);
        settle(st, o, method, 40, true);
        assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 100);
        assert.strictEqual(st.families.f1.charges.length, 0);
        assertLedgerHolds(st.snacks, 'Malky Stein', 'after cancelling a ' + method + ' order');
    }
});

test('two different orders both settle, independently', () => {
    const st = shopState();
    const a = { id: 'ord_a', camperName: 'Malky Stein', familyKey: 'f1' };
    const b = { id: 'ord_b', camperName: 'Malky Stein', familyKey: 'f1' };
    settle(st, a, 'bill', 30);
    settle(st, b, 'bill', 15);
    assert.strictEqual(st.families.f1.charges.length, 2);
    settle(st, a, 'bill', 30, true);                    // cancel only A
    assert.strictEqual(st.families.f1.charges.length, 1);
    assert.strictEqual(st.families.f1.charges[0].amount, 15);
});

test('a long edit history still lands on the right number', () => {
    const st = shopState(), o = newOrder();
    settle(st, o, 'canteen', 10);
    settle(st, o, 'bill', 10);
    settle(st, o, 'canteen', 35);
    settle(st, o, 'canteen', 35);      // no-op
    settle(st, o, 'cash', 35);
    settle(st, o, 'canteen', 20);
    assert.strictEqual(st.snacks.accounts['Malky Stein'].balance, 80);   // 100 - 20
    assert.strictEqual(st.families.f1.charges.length, 0);
    assertLedgerHolds(st.snacks, 'Malky Stein', 'after a long edit history');
});

// ── the migration really does this ─────────────────────────────────────────

test('migration 167 settles both methods, idempotently', () => {
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '167_settle_shop_orders.sql'), 'utf8');
    assert.ok(sql.includes('v_cur_method = v_new_method AND v_cur_amt = v_new_amt'),
        'no idempotency check — a re-save would charge twice');
    assert.ok(/'type',\s*CASE WHEN v_delta > 0 THEN 'debit' ELSE 'credit' END/.test(sql),
        'the canteen adjustment does not post a signed transaction');
    assert.ok(sql.includes("'kind',   'shop'"), 'the transaction is not tagged as a shop charge');
    assert.ok(sql.includes('no_family_for_camper'),
        'a camper with no family would silently lose the charge');
    assert.ok(sql.includes('not_authorized_for_billing'),
        'any counselor could post to a family bill');
});

test('the shop UI actually calls the settlement', () => {
    // The defect was a dropdown wired to nothing. If this call disappears, it
    // is that bug again.
    const js = fs.readFileSync(
        path.join(__dirname, '..', 'campistry_snacks_shop.js'), 'utf8');
    assert.ok(js.includes("rpc('settle_shop_order'"), 'the shop no longer settles orders');
    assert.ok(js.includes('settleOrder(rec'), 'saving an order does not settle it');
    // Deleting must reverse BEFORE the row is gone, or the server cannot find
    // the order to reverse against.
    const del = js.slice(js.indexOf('window.shopDeleteOrder'));
    assert.ok(del.indexOf('settleOrder(o, true') < del.indexOf('removeLocally();\n    });'),
        'deletion does not reverse the money before removing the order');
});
