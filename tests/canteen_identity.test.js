// node --test tests/canteen_identity.test.js
//
// The canteen half of "money must not disappear when a child leaves camp".
//
// campistry_billing_core.js fixed tuition. The canteen had the same disease in a
// different blob, and two distinct symptoms (TEST_FINDINGS.md D3 and D4):
//
//   D3  ensureAccountsForRoster() DELETED the account of anyone no longer on the
//       roster — with whatever money was on it. The transactions stayed, so
//       canteen revenue still counted the parent's deposit while the balance
//       owed back to them stopped existing, and nothing flagged it.
//
//   D4  balances are rebuilt from a ledger keyed by camper NAME, so a new camper
//       reusing a deleted camper's name inherited their balance. Two children
//       called the same thing across two summers is not exotic.
//
// The canteen is event-sourced — `balance === Σ transactions`, recomputed rather
// than stored — which is what made D4 possible: the recompute was the thing that
// handed the new account the old money.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const money = n => Math.round((Number(n) || 0) * 100) / 100;

// ── the two functions under test, transliterated ──────────────────────────
// Kept as a faithful model rather than importing: both live inside browser IIFEs
// with no export surface. The source-text tests at the bottom are what stop this
// model drifting from the real thing.

/** _reconcileBalances() — prefers camperId, falls back to name. */
function reconcile(data) {
    if (!data || !data.accounts) return data;
    const byId = {}, byNameNoId = {}, byName = {};
    (data.transactions || []).forEach(t => {
        if (!t) return;
        const amt = parseFloat(t.amount) || 0;
        const signed = (t.type === 'credit' ? amt : -amt);
        const hasId = (t.camperId != null && t.camperId !== '');
        if (hasId) byId[t.camperId] = (byId[t.camperId] || 0) + signed;
        if (t.camper) {
            byName[t.camper] = (byName[t.camper] || 0) + signed;
            if (!hasId) byNameNoId[t.camper] = (byNameNoId[t.camper] || 0) + signed;
        }
    });
    Object.keys(data.accounts).forEach(name => {
        const a = data.accounts[name];
        if (!a) return;
        let idSum, nameSum;
        if (a.camperId != null) { idSum = byId[a.camperId]; nameSum = byNameNoId[name]; }
        else { nameSum = byName[name]; }
        if (idSum == null && nameSum == null) return;
        a.balance = money((idSum || 0) + (nameSum || 0));
    });
    return data;
}

/** ensureAccountsForRoster() — creates, stamps, and CLOSES rather than deletes. */
function syncRoster(snacks, roster) {
    snacks.accounts = snacks.accounts || {};
    roster.forEach(c => {
        if (!snacks.accounts[c.name]) snacks.accounts[c.name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
        const a = snacks.accounts[c.name];
        if (c.camperId != null && a.camperId !== c.camperId) a.camperId = c.camperId;
        if (a.closed) { delete a.closed; delete a.closedAt; }
    });
    const live = new Set(roster.map(c => c.name));
    Object.keys(snacks.accounts).forEach(name => {
        if (live.has(name)) return;
        const a = snacks.accounts[name] || {};
        const bal = money(a.balance);
        const hasCard = !!(a.autoReload && (a.autoReload.cardOnFile ||
            a.autoReload.byopCustomerRef || a.autoReload.stripeCustomerId));
        if (Math.abs(bal) < 0.005 && !hasCard) { delete snacks.accounts[name]; return; }
        if (!a.closed) { a.closed = true; a.closedAt = '2026-09-16T00:00:00Z'; }
    });
    return reconcile(snacks);
}

const MALKY = { name: 'Malky Stein', camperId: 101 };

// ── D3: money on a closed account survives ────────────────────────────────

test('D3 FIXED: a departed camper’s canteen money is kept, not deleted', () => {
    let s = syncRoster({ transactions: [
        { camper: 'Malky Stein', camperId: 101, type: 'credit', amount: 50 },
    ] }, [MALKY]);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50);

    s = syncRoster(s, []);                       // camper removed from the roster
    assert.ok(s.accounts['Malky Stein'], 'the account must survive — the money is the parent’s');
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50, 'and so must the balance');
    assert.strictEqual(s.accounts['Malky Stein'].closed, true, 'flagged closed so it can be refunded');
});

test('an EMPTY account is still cleaned up — no clutter regression', () => {
    let s = syncRoster({ transactions: [] }, [MALKY, { name: 'Shaya Stein', camperId: 102 }]);
    assert.strictEqual(Object.keys(s.accounts).length, 2);
    s = syncRoster(s, [MALKY]);
    assert.deepStrictEqual(Object.keys(s.accounts), ['Malky Stein'],
        'a zero-balance account with no card is dropped, as before');
});

test('a closed account holding only a saved card is kept too', () => {
    // Losing the card is not losing money today, but it silently stops
    // auto-reload, which nobody notices for a month.
    let s = { accounts: { 'Malky Stein': { balance: 0, autoReload: { cardOnFile: true } } }, transactions: [] };
    s = syncRoster(s, []);
    assert.ok(s.accounts['Malky Stein'], 'the saved card keeps the account alive');
    assert.strictEqual(s.accounts['Malky Stein'].closed, true);
});

test('a NEGATIVE balance is kept as well — the camp is owed it', () => {
    let s = syncRoster({ transactions: [
        { camper: 'Malky Stein', camperId: 101, type: 'debit', amount: 12.5 },
    ] }, [MALKY]);
    assert.strictEqual(s.accounts['Malky Stein'].balance, -12.5);
    s = syncRoster(s, []);
    assert.ok(s.accounts['Malky Stein'], 'an overspent account is a debt, not clutter');
    assert.strictEqual(s.accounts['Malky Stein'].balance, -12.5);
});

test('re-adding the camper reopens the same account and its money', () => {
    let s = syncRoster({ transactions: [
        { camper: 'Malky Stein', camperId: 101, type: 'credit', amount: 50 },
    ] }, [MALKY]);
    s = syncRoster(s, []);
    assert.strictEqual(s.accounts['Malky Stein'].closed, true);
    s = syncRoster(s, [MALKY]);                  // back next summer, same id
    assert.ok(!s.accounts['Malky Stein'].closed, 'reopened');
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50, 'their money followed them');
});

// ── D4: identity is the id, not the name ──────────────────────────────────

test('D4 FIXED: a different camper reusing the name does NOT inherit the money', () => {
    // The old recompute keyed on name alone, so the fresh account was
    // immediately overwritten with the deleted camper's balance.
    let s = syncRoster({ transactions: [
        { camper: 'Malky Stein', camperId: 101, type: 'credit', amount: 50 },
    ] }, [MALKY]);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 50);

    // A DIFFERENT child, same name, two summers later.
    s.accounts = {};                                   // the old account was cleared
    s = syncRoster(s, [{ name: 'Malky Stein', camperId: 777 }]);
    assert.strictEqual(s.accounts['Malky Stein'].camperId, 777);
    assert.strictEqual(s.accounts['Malky Stein'].balance, 0,
        'the new camper must start at zero, not with 50 dollars of someone else’s money');
});

test('the SAME camper’s history follows their id, not their spelling', () => {
    const s = reconcile({
        accounts: { 'Malky Stein': { camperId: 101, balance: 0 } },
        transactions: [
            { camper: 'Malky Stien', camperId: 101, type: 'credit', amount: 30 },  // typo fixed later
            { camper: 'Malky Stein', camperId: 101, type: 'debit', amount: 10 },
        ],
    });
    assert.strictEqual(s.accounts['Malky Stein'].balance, 20,
        'both transactions belong to camper 101 however the name was spelled');
});

test('pre-existing transactions with no id still reconcile by name', () => {
    // Every transaction written before this change has no camperId. If an
    // identified account ignored them its balance would silently drop to zero,
    // which would be the same bug pointed the other way.
    const s = reconcile({
        accounts: { 'Malky Stein': { camperId: 101, balance: 0 } },
        transactions: [{ camper: 'Malky Stein', type: 'credit', amount: 40 }],
    });
    assert.strictEqual(s.accounts['Malky Stein'].balance, 40,
        'legacy name-only history must still count');
});

test('an id-keyed total wins over a name collision', () => {
    const s = reconcile({
        accounts: { 'Malky Stein': { camperId: 101, balance: 0 } },
        transactions: [
            { camper: 'Malky Stein', camperId: 101, type: 'credit', amount: 25 },
            { camper: 'Malky Stein', camperId: 777, type: 'credit', amount: 999 },
        ],
    });
    assert.strictEqual(s.accounts['Malky Stein'].balance, 25,
        'only camper 101’s own transactions count towards camper 101’s balance');
});

// ── the model above must match the real source ─────────────────────────────

test('both copies of _reconcileBalances agree', () => {
    // Two copies exist because the POS register loads without the manager. They
    // are the balance of every canteen account; a difference between them is a
    // difference in what two screens believe a camper has.
    const norm = src => {
        const a = src.indexOf('function _reconcileBalances(data) {');
        assert.ok(a > 0, 'cannot find _reconcileBalances');
        const b = src.indexOf('\n}', a);
        return src.slice(a, b)
            .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
            .replace(/\s+/g, ' ').trim();
    };
    assert.strictEqual(norm(read('campistry_snacks.js')), norm(read('campistry_snacks_pos.js')),
        'the manager and the POS now compute balances differently');
});

test('the real sync closes instead of deleting, and stamps the id', () => {
    const src = read('campistry_snacks.js');
    const fn = src.slice(src.indexOf('function ensureAccountsForRoster() {'),
                         src.indexOf('function getAccount(name)'));
    assert.ok(fn.length > 0, 're-anchor this test');

    // The line that deleted a funded account.
    assert.ok(!/if \(!rosterNames\.has\(name\)\) \{ delete snacks\.accounts\[name\]; changed = true; \}/.test(fn),
        'the unconditional account delete is BACK — a departed camper’s canteen money vanishes again');
    assert.match(fn, /a\.closed = true;/, 'accounts are no longer closed');
    assert.match(fn, /if \(Math\.abs\(bal\) < 0\.005 && !hasCard\) \{ delete snacks\.accounts\[name\]/,
        'only genuinely empty accounts may be deleted');
    assert.match(fn, /a\.camperId = c\.camperId/, 'the stable id is no longer stamped');
    assert.match(fn, /closed canteen account/, 'nothing tells the office money is sitting on a closed account');
});

test('the roster feed carries camperId, or nothing can be stamped', () => {
    const src = read('campistry_snacks.js');
    const fn = src.slice(src.indexOf('function getCamperList() {'),
                         src.indexOf('function loadSnacksData()'));
    assert.match(fn, /camperId: data\.camperId/,
        'getCamperList dropped camperId — every account would fall back to name');
});

test('new transactions are stamped with the camper id', () => {
    for (const f of ['campistry_snacks.js', 'campistry_snacks_pos.js']) {
        assert.match(read(f), /camperId: \(snacks(\.accounts|\s*&&\s*snacks\.accounts)/,
            f + ' writes transactions with no camperId — D4 would return for new data');
    }
});
