// node --test tests/billing_races.test.js
//
// BILLING CONCURRENCY. Not "is the arithmetic right" (tests/money_parity.test.js
// does that) but "can two writers at once lose money".
//
// THE RACE, which every one of the payment edge functions had:
//
//     cur = SELECT value            -- read the whole campistryMe blob
//     cur.finance.payments.push()   -- mutate in memory
//     UPSERT value = cur            -- write the whole blob back
//
// No lock, no version check. Two writers that overlap both read the same blob,
// both append their own payment, and the second write silently discards the
// first. The card was charged; Campistry has no record of it.
//
// The retry loop those functions carried does NOT help and is worth being
// precise about: it retried on a WRITE ERROR. A lost update is not an error —
// both writes succeed, and the loser is never told.
//
// A second bug lived in the same lines: the "have I already recorded this
// transaction?" check sat inside the same unlocked read-modify-write, so two
// deliveries of the SAME webhook (Stripe retries routinely) could both pass it
// and both append, crediting a family twice for one charge.
//
// The fix is migration 168: do the read, the dedupe and the write inside one
// SECURITY DEFINER function holding a row lock. The edge functions cannot take
// that lock themselves — they talk to PostgREST, one HTTP request per
// statement, so nothing spans their SELECT and their UPSERT.
//
// These tests model the interleavings and then assert the real files are wired
// to the atomic path, because the failure mode of this fix is silent: a
// function quietly left on the old path looks identical until money vanishes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fn = f => path.join(__dirname, '..', 'supabase', 'functions', f, 'index.ts');
const read = p => fs.readFileSync(p, 'utf8');

// ── 1. the race, and why the old retry loop did not cover it ──────────────

/** The old path: read, mutate a COPY, write it all back. */
function blindWriter(store, payment) {
    const snapshot = JSON.parse(JSON.stringify(store.value));      // read
    snapshot.finance = snapshot.finance || {};
    snapshot.finance.payments = snapshot.finance.payments || [];
    if (!snapshot.finance.payments.some(p => p.id === payment.id)) {
        snapshot.finance.payments.push(payment);                   // mutate
    }
    return () => { store.value = snapshot; };                      // write, later
}

/** The new path: one atomic step under a lock. */
function atomicAppend(store, payment, dedupeKey) {
    const pays = (store.value.finance && store.value.finance.payments) || [];
    if (dedupeKey && pays.some(p =>
        p.id === dedupeKey || p.reference === dedupeKey ||
        p.byopTransactionId === dedupeKey || p.stripePaymentIntentId === dedupeKey)) {
        return { alreadyRecorded: true };
    }
    store.value.finance = store.value.finance || {};
    store.value.finance.payments = pays.concat([payment]);
    return { alreadyRecorded: false };
}

const emptyStore = () => ({ value: { finance: { payments: [] } } });
const pay = (id, amount) => ({ id, amount, status: 'succeeded' });

test('TWO OVERLAPPING WRITERS LOSE A PAYMENT on the old path', () => {
    // Both read before either writes — the interleaving a webhook and the
    // nightly autopay run produce every time they overlap.
    const store = emptyStore();
    const commitA = blindWriter(store, pay('a', 100));
    const commitB = blindWriter(store, pay('b', 250));
    commitA();
    commitB();

    const ids = store.value.finance.payments.map(p => p.id);
    assert.deepStrictEqual(ids, ['b'], 'the fixture should demonstrate the loss');
    assert.ok(!ids.includes('a'), "payment 'a' was charged and then silently discarded");
});

test('the same two writers both survive on the atomic path', () => {
    // Serialised by the row lock: the second waits, then reads the first's row.
    const store = emptyStore();
    atomicAppend(store, pay('a', 100), 'a');
    atomicAppend(store, pay('b', 250), 'b');

    const ids = store.value.finance.payments.map(p => p.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b']);
    assert.strictEqual(store.value.finance.payments.reduce((s, p) => s + p.amount, 0), 350);
});

test('a retried webhook is recorded ONCE, not twice', () => {
    // The dedupe used to sit outside any lock, so two deliveries of one charge
    // could both pass it. Under the lock the second sees the first's row.
    const store = emptyStore();
    const first = atomicAppend(store, pay('txn_1', 100), 'txn_1');
    const second = atomicAppend(store, pay('txn_1', 100), 'txn_1');
    assert.strictEqual(first.alreadyRecorded, false);
    assert.strictEqual(second.alreadyRecorded, true);
    assert.strictEqual(store.value.finance.payments.length, 1);
});

test('the SAME webhook racing itself double-credits on the old path', () => {
    // Why the dedupe had to move inside the lock rather than just staying put.
    const store = emptyStore();
    const commitA = blindWriter(store, pay('txn_1', 100));
    const commitB = blindWriter(store, pay('txn_1', 100));
    commitA();
    commitB();
    // B read a blob that did not yet contain txn_1, so its check passed too.
    assert.strictEqual(store.value.finance.payments.length, 1,
        'this fixture models the last-write-wins overwrite');
    // The overwrite hides it here, but with two DIFFERENT ids it is a real
    // double credit — which is exactly the pair of bugs the lock removes.
});

test('a status transition patches the existing row, it does not add a second', () => {
    // Stripe sends pending, then succeeded or failed, for ONE intent. Appending
    // on each would bill the family two or three times for one charge.
    const store = emptyStore();
    atomicAppend(store, { id: 'pi_1', stripePaymentIntentId: 'pi_1', amount: 100, status: 'pending' }, 'pi_1');

    // p_update_on_match: patch in place.
    const pays = store.value.finance.payments;
    const hit = pays.find(p => p.stripePaymentIntentId === 'pi_1');
    Object.assign(hit, { status: 'succeeded' });

    assert.strictEqual(pays.length, 1);
    assert.strictEqual(pays[0].status, 'succeeded');
});

// ── 2. the RPC really is atomic and idempotent ────────────────────────────

test('migration 168 locks, dedupes and patches inside one transaction', () => {
    const sql = read(path.join(__dirname, '..', 'migrations', '168_atomic_payment_writes.sql'));
    const append = sql.slice(sql.indexOf('FUNCTION public.append_camp_payment'),
                             sql.indexOf('FUNCTION public.merge_camp_family_fields'));
    assert.ok(/FOR UPDATE/.test(append), 'no row lock — the lost update is still possible');
    assert.ok(append.includes('p_dedupe_key'), 'no dedupe — a retried webhook would double-credit');
    assert.ok(append.includes('p_update_on_match'),
        'no status-transition path — Stripe would append a row per event');
    // The dedupe must come AFTER the lock, or it proves nothing.
    assert.ok(append.indexOf('FOR UPDATE') < append.indexOf('p_dedupe_key IS NOT NULL'),
        'the dedupe check runs before the lock is taken');

    const merge = sql.slice(sql.indexOf('FUNCTION public.merge_camp_family_fields'));
    assert.ok(/FOR UPDATE/.test(merge), 'the family merge does not lock');
    // A shallow merge, so a webhook cannot clobber a name or a charge the
    // office edited while it was in flight.
    assert.ok(merge.includes('v_fam || p_fields'), 'the family merge is not a shallow merge');
});

test('settle_shop_order locks all three blobs, in a fixed order', () => {
    // The race I introduced in 167 and then fixed: read-modify-write on three
    // blobs with no lock. A settlement racing a POS sale lost a transaction,
    // and the canteen balance is RECOMPUTED from that ledger — so a lost
    // transaction is lost money.
    const sql = read(path.join(__dirname, '..', 'migrations', '167_settle_shop_orders.sql'));
    // Count STATEMENTS, not the word — the header explains the locking in
    // prose, and matching that would let the real locks be removed silently.
    const statements = sql.split('\n').filter(l => !l.trim().startsWith('--'));
    for (const key of ['campistryShop', 'campistrySnacks', 'campistryMe']) {
        const at = statements.findIndex(l => l.includes("key = '" + key + "'"));
        assert.ok(at >= 0, 'no SELECT for ' + key);
        assert.ok(/FOR UPDATE/.test(statements[at] + statements[at + 1]),
            key + ' is read without FOR UPDATE — the lost update is still possible');
    }
    // Lock ORDER is load-bearing: two functions taking the same locks in
    // opposite orders deadlock. This must match place_shop_order (122).
    const shop = sql.indexOf("key = 'campistryShop'");
    const snacks = sql.indexOf("key = 'campistrySnacks'");
    const me = sql.indexOf("key = 'campistryMe'");
    assert.ok(shop < snacks && snacks < me, 'lock order changed — deadlock risk');
});

// ── 3. the functions are actually wired to it ─────────────────────────────
//
// The failure mode of this fix is silent: a function left on the old path looks
// identical until money vanishes. So assert the wiring, per file.

const REWIRED = [
    'charge-saved-card',
    'payments-charge-nonce',
    'payments-checkout',
    'stripe-webhook',
];

test('the rewired functions record payments through the atomic RPC', () => {
    for (const f of REWIRED) {
        const src = read(fn(f));
        assert.ok(src.includes('append_camp_payment'),
            f + ' no longer uses the atomic append — it is racy again');
    }
});

test('the rewired functions no longer blind-upsert the payments blob', () => {
    // The specific shape that loses money: pushing onto finance.payments and
    // upserting the whole blob. Other camp_state_kv writes in these files (the
    // canteen, saved-card lists) are called out separately below.
    for (const f of REWIRED) {
        const src = read(fn(f));
        assert.ok(!/finance\.payments\.push\(/.test(src),
            f + ' still pushes onto finance.payments in memory');
        assert.ok(!/pays\.push\(/.test(src),
            f + ' still appends to a local payments array before upserting');
    }
});

test('payments-checkout saves the card through the locking merge', () => {
    // Losing these fields does not lose a payment — it silently stops autopay
    // for that family, which is worse because nobody notices for a month.
    const src = read(fn('payments-checkout'));
    assert.ok(src.includes('merge_camp_family_fields'),
        'card-on-file is written by a blind blob upsert again');
});

// ── 4. what is still on the old path ──────────────────────────────────────
//
// Pinned deliberately. These are known, listed in the handover, and each still
// works exactly as it does today — just racily. When one is rewired, delete it
// from this list; if the list ever grows, something regressed.

const STILL_BLIND = [
    'cardknox-webhook',
    'payments-hosted-complete',
    'charge-due-installments',
];

test('the known-remaining functions are exactly the ones we think they are', () => {
    for (const f of STILL_BLIND) {
        const src = read(fn(f));
        const racy = /finance\.payments\.push\(|pays\.push\(/.test(src);
        assert.ok(racy,
            f + ' looks rewired — if it is, remove it from STILL_BLIND so the ' +
            'list keeps meaning something');
    }
});

test('charge-due-installments holds the widest window of all of them', () => {
    // It reads EVERY camp's blob up front, charges cards for the whole run,
    // then writes each camp's blob at the end — so the blob is stale for the
    // length of the run, not for milliseconds. Anything that writes during it
    // is discarded, and its own charges are lost if the office saves.
    // Rewiring it needs a third RPC (mark an installment paid atomically),
    // which is why it is not in this pass.
    const src = read(fn('charge-due-installments'));
    const readAt = src.indexOf('.select("camp_id, value").eq("key", "campistryMe")');
    const writeAt = src.lastIndexOf('key: "campistryMe"');
    assert.ok(readAt > 0 && writeAt > readAt,
        'the read-then-write-much-later shape changed — re-check the window');
});
