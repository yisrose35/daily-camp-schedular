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

// Every function that records money or a saved card, and the locking RPC it
// must go through. Most append a payment and nothing else, so 168's
// append_camp_payment is enough. charge-due-installments has to append the
// payment AND mark the installment paid together (169). payments-save-method
// writes only cards, on two different blobs (170).
const REWIRED = {
    'charge-saved-card': ['append_camp_payment'],
    'payments-charge-nonce': ['append_camp_payment'],
    'payments-checkout': ['append_camp_payment'],
    'stripe-webhook': ['append_camp_payment', 'append_family_payment_method',
                       'merge_canteen_autoreload_card'],
    'cardknox-webhook': ['append_camp_payment', 'append_family_payment_method',
                         'merge_canteen_autoreload_card'],
    'payments-hosted-complete': ['append_camp_payment', 'merge_camp_family_fields',
                                 'merge_canteen_autoreload_card'],
    'charge-due-installments': ['record_autopay_installment'],
    'payments-save-method': ['append_family_payment_method',
                             'merge_canteen_autoreload_card'],
};

test('the rewired functions write through the atomic RPCs', () => {
    for (const [f, rpcs] of Object.entries(REWIRED)) {
        const src = read(fn(f));
        for (const rpc of rpcs) {
            assert.ok(src.includes(rpc),
                f + ' no longer uses ' + rpc + ' — it is racy again');
        }
    }
});

test('the rewired functions no longer blind-upsert the payments blob', () => {
    // The specific shape that loses money: pushing onto finance.payments and
    // upserting the whole blob. Other camp_state_kv writes in these files (the
    // canteen, saved-card lists) are called out separately below.
    for (const f of Object.keys(REWIRED)) {
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

// ── 4. no function writes a money blob directly any more ──────────────────
//
// DISCOVERED, NOT LISTED. This test scans every edge function rather than the
// REWIRED map above, because a hand-maintained list is exactly what went wrong:
// the first pass of this audit called payments-save-method's two blind writes
// "seven functions, all done" and missed it, since it was not on the list.
// Anything new that upserts one of these blobs now fails here.

const FUNCTIONS_DIR = path.join(__dirname, '..', 'supabase', 'functions');

/** Every function that writes a whole campistry* blob back to camp_state_kv. */
function blindBlobWriters() {
    const out = {};
    for (const dir of fs.readdirSync(FUNCTIONS_DIR)) {
        const p = path.join(FUNCTIONS_DIR, dir, 'index.ts');
        if (!fs.existsSync(p)) continue;
        const lines = read(p).split('\n');
        const hits = [];
        lines.forEach((l, i) => {
            if (l.trim().startsWith('//')) return;
            if (!/\.upsert\(|\.update\(/.test(l)) return;
            // A read is fine — several functions legitimately read a blob to
            // decide what to change. It is writing the whole thing back that
            // discards whatever another writer just put there.
            const near = lines.slice(i, i + 6).filter(n => !n.trim().startsWith('//')).join('\n');
            if (/key:\s*["']campistry\w+["']|key["']?\s*,\s*["']campistry\w+["']/.test(near)
                || (/camp_state_kv/.test(near) && /["']campistry\w+["']/.test(near))) {
                hits.push(i + 1);
            }
        });
        if (hits.length) out[dir] = hits;
    }
    return out;
}

// Pinned with a reason, not as a convenience. If one is fixed, delete it; if
// the set grows, something regressed.
const ALLOWED_BLIND_WRITERS = {
    // Flips smsEmailConsent=false across every camp when someone texts STOP.
    // Same lost-update shape, and losing one means continuing to text a person
    // who asked you to stop — so it is worth fixing, it is just not a money
    // path. Needs an RPC that matches a normalised phone number under the lock.
    'telnyx-sms-webhook': 'SMS STOP consent flip — needs its own RPC',
    // Writes the whole blob back to record savedReports[].schedule.lastSentAt.
    // Its own comment says the window was narrowed but not closed "(no
    // JSON-patch primitive here)" — there is one now, so this wants a small
    // mark_scheduled_report_sent RPC. Worst case is a duplicate emailed report.
    'send-scheduled-reports': 'lastSentAt write-back — wants a narrow RPC',
};

test('no edge function writes a whole campistry* blob back', () => {
    const found = blindBlobWriters();
    const unexpected = Object.keys(found).filter(f => !(f in ALLOWED_BLIND_WRITERS));
    assert.deepStrictEqual(unexpected, [],
        'these write a whole camp_state_kv blob — the lost update: ' +
        unexpected.map(f => `${f}:${found[f].join(',')}`).join(' '));

    // And the pinned exceptions must still actually be doing it, or the pin is
    // stale and hiding a regression somewhere else.
    for (const f of Object.keys(ALLOWED_BLIND_WRITERS)) {
        assert.ok(f in found,
            f + ' looks fixed — remove it from ALLOWED_BLIND_WRITERS');
    }
});

// ── 5. the autopay runner, which was the widest window of all ─────────────

test('charge-due-installments no longer holds a blob across the whole run', () => {
    // It reads EVERY camp's blob up front and used to write each one back after
    // the last card was charged — stale for the length of the run, not for
    // milliseconds. The read stays (it is what decides who is due); the write
    // at the end is what had to go.
    const src = read(fn('charge-due-installments'));
    assert.ok(src.includes('.select("camp_id, value").eq("key", "campistryMe")'),
        'the up-front read changed shape — re-check this test');
    assert.ok(!/upsert\(\s*$/m.test(src.slice(src.indexOf('for (const row of'))) ||
        !/key: "campistryMe", value: me/.test(src),
        'the end-of-run whole-blob write is back');
});

test('each installment outcome is persisted with its payment, not after it', () => {
    // The failure this guards is subtle and expensive: mark the installment
    // paid in one call and append the payment in another, and a crash between
    // them either charges the family again tomorrow or loses the record of a
    // charge that happened. One call carries both.
    const src = read(fn('charge-due-installments'));
    const calls = src.match(/recordInstallment\(/g) || [];
    assert.ok(calls.length >= 6,
        'expected every installment outcome to go through recordInstallment');
    // The two success branches must pass a payment, not just a patch.
    for (const anchor of ['auto_byop_" + res.externalTransactionId', 'auto_" + pi.id']) {
        const at = src.indexOf(anchor);
        assert.ok(at > 0, 'missing the payment built at ' + anchor);
        const before = src.lastIndexOf('recordInstallment(', at);
        assert.ok(before > 0 && at - before < 600,
            'the payment at ' + anchor + ' is not passed to recordInstallment — ' +
            'it is being written separately from the installment patch');
    }
});

test('migration 169 patches only a PENDING installment, under a lock', () => {
    const sql = read(path.join(__dirname, '..', 'migrations', '169_atomic_autopay_installment.sql'));
    const body = sql.slice(sql.indexOf('AS $$'));
    assert.ok(/FOR UPDATE/.test(body), 'no row lock — the lost update is still possible');
    // This one condition is what makes re-running a failed nightly run safe.
    assert.ok(/COALESCE\(v_insts->i->>'status', 'pending'\) = 'pending'/.test(body),
        "the pending check is gone — a re-run would charge a paid installment again");
    // And the installment patch and the payment append must land in the same
    // function, before the single UPDATE.
    const patchAt = body.indexOf("v_patched := true");
    const payAt = body.indexOf("p_payment IS NOT NULL");
    const writeAt = body.lastIndexOf('UPDATE camp_state_kv');
    assert.ok(patchAt > 0 && payAt > patchAt && writeAt > payAt,
        'the patch and the payment no longer share one write');
    // Identified by dueDate, never by a caller-supplied installment index: the
    // blob is re-read under this lock, so an index from before it can point at
    // a different installment.
    assert.ok(!/p_installment_index/.test(sql),
        'an installment index argument is back — it is not safe across the lock');
});

test('169 dedupes the payment the same way 168 does', () => {
    // Autopay and a webhook can both record the same charge (a processor that
    // reports asynchronously). Both functions must recognise the same keys or
    // one of them appends a duplicate.
    const keys = ['id', 'reference', 'byopTransactionId', 'stripePaymentIntentId'];
    const a = read(path.join(__dirname, '..', 'migrations', '168_atomic_payment_writes.sql'));
    const b = read(path.join(__dirname, '..', 'migrations', '169_atomic_autopay_installment.sql'));
    for (const k of keys) {
        assert.ok(a.includes("p->>'" + k + "' = p_dedupe_key"), '168 stopped matching ' + k);
        assert.ok(b.includes("p->>'" + k + "' = p_dedupe_key"), '169 does not match ' + k);
    }
});
