// node --test tests/payment_ledger.test.js
//
// The defect: after 171-174 the parent portal answers from the posted ledger
// whenever that ledger is "complete", but only autopay (172) and a won
// chargeback (175) ever posted a `payment` entry. A parent paying online, an
// office recording a check, a Zelle deposit matched after conversion — all of
// those landed in finance.payments and nowhere else.
//
// And "complete" only ever asked whether every ENROLLMENT had a tuition charge.
// Payments were never part of that test. So a family who had just paid $2,500
// had a ledger that passed, the ledger won, and the parent was told they still
// owed it.
//
// Same shape as the bug 174 was written to prevent, through the other door:
// 174 stopped the ledger understating a debt, 178 stops it overstating one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../campistry_billing_core.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M178 = read('migrations/178_every_payment_posts_to_the_ledger.sql');
const ME = read('campistry_me.js');

// ── 1. the arithmetic ───────────────────────────────────────────────────────

test('a payment on the ledger lowers what the family owes', () => {
    const a = B.newAccount({ famKey: 'f1' });
    B.postTuition(a, { enrollmentId: 'e1', camperId: 101, tuition: 2500 });
    assert.strictEqual(B.balance(a), 2500);
    B.post(a, { id: 'le_pay_pi_abc', kind: 'payment', amount: 2500, reason: 'card',
                source: { paymentId: 'pi_abc' } });
    assert.strictEqual(B.balance(a), 0, 'the parent was still being shown the full tuition');
});

test('a refund raises it again — the credit is gone', () => {
    const a = B.newAccount({ famKey: 'f1' });
    B.postTuition(a, { enrollmentId: 'e1', camperId: 101, tuition: 1000 });
    B.post(a, { kind: 'payment', amount: 1000, reason: 'card' });
    assert.strictEqual(B.balance(a), 0);
    B.post(a, { kind: 'refund', amount: 400, reason: 'refund' });
    assert.strictEqual(B.balance(a), 400, 'the family kept a credit they no longer had');
});

test('the three ways money comes BACK are distinguishable', () => {
    // All raise the balance identically; only one is a decision anybody made,
    // and a camp reading a statement has to be able to tell them apart.
    for (const r of ['refund', 'chargeback', 'reversal']) {
        assert.ok(B.REASONS.includes(r), `the '${r}' reason is gone`);
        const a = B.newAccount({ famKey: 'f' });
        assert.strictEqual(B.post(a, { kind: 'refund', amount: 10, reason: r }).ok, true);
    }
});

// ── 2. posted once, whichever path gets there first ─────────────────────────

test('the client keys a processor payment on the PROCESSOR id, not its own', () => {
    // Billing's "charge card on file" writes a row the moment the charge
    // returns; the webhook writes one whenever Stripe gets round to it. Their
    // local ids never match ('pay_<clock>' vs 'pi_<intent>'), so keying on those
    // posts the payment TWICE whenever the webhook wins the race.
    const refOf = extractFn('_paymentRefOf');
    assert.strictEqual(refOf({ id: 'pay_1', stripePaymentIntentId: 'pi_x' }), 'pi_x',
        'the local id wins over the intent id, so the webhook would double-post');
    assert.strictEqual(refOf({ id: 'pay_1', byopTransactionId: 'ck_9' }), 'ck_9');
    assert.strictEqual(refOf({ id: 'pay_1' }), 'pay_1', 'an office payment still has a key');
    assert.strictEqual(refOf({ id: 'r1', stripeRefundId: 'rf_7', stripePaymentIntentId: 'pi_x' }),
        'rf_7', 'a refund row must key on the REFUND, not the payment it refunds');
    assert.strictEqual(refOf({ id: 'r1', byopRefundId: 'ckr_3' }), 'ckr_3',
        'a BYOP refund shares no key with the one payments-refund posts server-side, ' +
        'so the same refund lands on the ledger twice');
});

test('"already posted?" accepts any identifier a row carries', () => {
    // Entries written before 178 carry whichever reference their writer used:
    // 171's conversion stored the row id, autopay (172) stored the processor
    // transaction id. Matching only the canonical one re-posts both.
    const refsOf = extractFn('_paymentRefsOf');
    const refs = refsOf({ id: 'pay_1', stripePaymentIntentId: 'pi_x' });
    assert.deepStrictEqual(refs.slice().sort(), ['pay_1', 'pi_x']);

    // A typed check number is NOT an identity: two cheques can share one, and
    // treating that as "already posted" silently swallows the second payment.
    assert.deepStrictEqual(refsOf({ id: 'pay_1', reference: '1234' }), ['pay_1']);
    assert.deepStrictEqual(refsOf({ reference: '1234' }), ['1234'],
        'a row with nothing else must still have some key');
});

test('SQL and the client agree on both rules', () => {
    // They write the same ledger and the id is what stops double-crediting, so
    // a difference between them is a family credited twice.
    const canonical = M178.slice(M178.indexOf('FUNCTION public.payment_ref_of'),
                                 M178.indexOf('FUNCTION public.payment_refs_of'));
    assert.ok(canonical.indexOf("'stripeRefundId'") < canonical.indexOf("'stripePaymentIntentId'"),
        'SQL does not put the refund id first the way the client does');
    assert.ok(canonical.indexOf("'stripePaymentIntentId'") < canonical.indexOf("'id'"),
        'SQL still prefers the local id over the processor id');

    const set = M178.slice(M178.indexOf('FUNCTION public.payment_refs_of'),
                           M178.indexOf('REVOKE ALL ON FUNCTION public.payment_refs_of'));
    assert.ok(!/unnest\(ARRAY\[[\s\S]*?'reference'[\s\S]*?\]\)/.test(set),
        'SQL puts a typed reference in the identity set; the client does not');

    // And the entry id scheme itself.
    assert.match(M178, /'le_pay_' \|\| v_ref/);
    assert.match(ME, /var id='le_pay_'\+ref;/);
});

test('an office payment posts, a pending or failed one does not', () => {
    const entry = extractFn('_postPaymentEntry');
    assert.ok(entry, '_postPaymentEntry is gone');
    // The statuses are asserted against the SQL, which is the authority both
    // sides copy — see the next test for the pairing.
    for (const st of ['pending', 'failed', 'processing', 'canceled', 'cancelled']) {
        assert.ok(M178.includes(`'${st}'`), `SQL no longer excludes a ${st} payment`);
        assert.ok(ME.includes(`st==='${st}'`), `the client no longer excludes a ${st} payment`);
    }
});

// ── 3. the half that survives a path nobody wired up ────────────────────────

test('a ledger missing a payment is INCOMPLETE, not trusted', () => {
    // This is the part that matters more than the posting. Posting is correct
    // until someone adds a seventh way to take money; this turns that from a
    // wrong balance into a fallback.
    assert.match(M178, /FUNCTION public\.family_payments_all_posted/);
    const wrapper = M178.slice(M178.indexOf('FUNCTION public.get_my_balance('));
    assert.match(wrapper, /family_payments_all_posted/,
        'get_my_balance still declares a ledger complete without checking payments');
    assert.match(wrapper, /v_complete := false;[\s\S]{0,200}v_unpaid/,
        'an unposted payment does not mark the ledger incomplete');
    assert.match(wrapper, /'unpostedPaymentFamilies'/,
        'the portal cannot say WHICH families are behind');

    // The marker 173's rename guard looks for must survive the replacement, or
    // re-running 173 turns this function into its own callee.
    assert.match(wrapper, /LEDGER_WRAPPER_V173/);
});

test('money that moved but cannot be keyed counts as MISSING, not excused', () => {
    // The subtle one. A row with no identifier cannot be posted — there is no
    // key to dedupe it by — but it must not therefore be ignored: that would
    // make it invisible to both the poster and the completeness test, which is
    // the exact silent hole this migration exists to close.
    assert.match(M178, /FUNCTION public\.payment_moved_money/);
    const complete = M178.slice(M178.indexOf('FUNCTION public.family_payments_all_posted'),
                                M178.indexOf('REVOKE ALL ON FUNCTION public.family_payments_all_posted'));
    assert.match(complete, /payment_moved_money\(e\)/,
        'completeness asks whether a row is POSTABLE rather than whether money moved, ' +
        'so an unkeyable payment is silently excused');
    assert.ok(!/payment_ledger_entry\(e\) IS NOT NULL/.test(complete),
        'completeness is still gated on postability');

    const covers = M178.slice(M178.indexOf('FUNCTION public.family_covers_payment'),
                              M178.indexOf('REVOKE ALL ON FUNCTION public.family_covers_payment'));
    assert.match(covers, /cardinality\(public\.payment_refs_of\(p_pay\)\) > 0/,
        'a row with no identifier reports itself as already covered');
});

// ── 4. where the money moves ────────────────────────────────────────────────

test('append_camp_payment posts the entry in its own locked write', () => {
    const fn = M178.slice(M178.indexOf('FUNCTION public.append_camp_payment'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /FOR UPDATE/, 'the lock is gone');
    // Both write paths, not just the append: Stripe sends pending and THEN
    // succeeded for one intent, so an entry that only appears on first sight
    // never appears at all for a card payment.
    const posts = body.match(/payment_ledger_entry\(/g) || [];
    assert.ok(posts.length >= 2,
        `only ${posts.length} of the two write paths posts a ledger entry`);
});

test('a payment that later fails is REVERSED, not deleted', () => {
    // An ACH debit can settle and be returned days later. The ledger is
    // append-only, and the camp needs to see that it happened.
    const fn = M178.slice(M178.indexOf('FUNCTION public.append_camp_payment'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /le_payrev_/, 'a returned payment leaves the ledger claiming it was paid');
    assert.match(body, /'reason',\s*'reversal'/);
    assert.ok(!/DELETE|jsonb_array_elements[\s\S]{0,80}NOT.*le_pay_/.test(body),
        'entries are being removed rather than reversed');
});

test('a refund taken at the processor reaches the books', () => {
    // A director refunding from the Stripe dashboard produced nothing here at
    // all — no entry, no payment row. charge.refunded simply was not handled.
    assert.match(M178, /FUNCTION public\.record_external_refund/);
    const hook = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(hook, /"charge\.refunded"/, 'the event is still unhandled');
    assert.match(hook, /record_external_refund/);
    // Partial refunds: Stripe re-sends the whole charge each time, so posting
    // the charge once would miss every refund after the first.
    assert.match(hook, /charge\.refunds\?\.data/,
        'it posts the charge rather than each refund, so a second partial refund is lost');

    // Same key as Billing's own refund action, so an in-app refund echoed back
    // by the webhook is recorded once.
    assert.match(M178, /v_entryId := 'le_pay_' \|\| p_refund_id;/);
});

test('the BYOP refund path posts server-side, not only in the browser', () => {
    const fn = read('supabase/functions/payments-refund/index.ts');
    assert.match(fn, /record_external_refund/,
        'a BYOP refund still only reaches the ledger if the browser survives to save');
    assert.match(fn, /credit they no longer have/,
        'a failed ledger post is not logged as a books problem');
});

test('every client payment row is posted as it is written', () => {
    // The four family-billing sites. The Finance page's own log (which has no
    // familyKey at all) is a camp-level list and deliberately not included.
    const calls = ME.match(/_postPaymentEntry\(/g) || [];
    assert.ok(calls.length >= 5,
        `only ${calls.length - 1} client site(s) post to the ledger; expected the ` +
        `Record Payment, card refund, offline refund and charge-on-file paths`);
    // and each push is paired with a post
    const pushes = (ME.match(/finPayments\.push\(_\w+Row\)/g) || []).length;
    assert.ok(pushes >= 4, `only ${pushes} payment rows are captured for posting`);
});

// ── 5. it must not double-post what is already there ────────────────────────

test('autopay and conversion entries are recognised as covering a payment', () => {
    // 172 keys its entry on the processor transaction id; 171's conversion keys
    // on the row id. Both live in source.paymentId, and missing either re-posts
    // money that is already on the ledger.
    const covers = M178.slice(M178.indexOf('FUNCTION public.family_covers_payment'),
                              M178.indexOf('REVOKE ALL ON FUNCTION public.family_covers_payment'));
    assert.match(covers, /e->'source'->>'paymentId' = r/);
    assert.match(covers, /e->>'id' = 'le_pay_' \|\| r/);
    assert.ok(ME.includes("e.source.paymentId"), 'the client ignores entries autopay posted');
});

test('a converted deposit carries its deposit id', () => {
    // 171 posted deposits with an empty source, so a converted deposit could not
    // be told from an unconverted one and 178's sync would have credited it
    // twice. Conversion and ongoing posting now produce the same id.
    const m171 = read('migrations/171_posted_ledger.sql');
    assert.match(m171, /'le_dep_' \|\| \(e->>'id'\)/,
        'converted deposits still carry a sequence id nothing can match');
    assert.match(m171, /'depositId', e->>'id'/);
    assert.match(M178, /'le_dep_' \|\| d\.id::text/);
    // and the belt-and-braces match for camps converted before that change
    assert.match(M178, /e->>'reason' = 'zelle'[\s\S]{0,200}e->>'date' = p_date/);
});

test('sync posts only what is missing and can be re-run', () => {
    assert.match(M178, /FUNCTION public\.sync_family_ledger_payments/);
    const fn = M178.slice(M178.indexOf('FUNCTION public.sync_family_ledger_payments'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /FOR UPDATE/, 'the sync reads and writes without a lock');
    assert.match(body, /family_covers_payment/);
    assert.match(body, /family_covers_deposit/);
    assert.match(body, /p_dry_run/, 'there is no way to see what it would do first');
});

// ── helper: run a function out of campistry_me.js without loading the page ──

function extractFn(name) {
    const at = ME.indexOf('function ' + name + '(');
    if (at < 0) return null;
    // Balance braces from the first one after the signature.
    let i = ME.indexOf('{', at), depth = 0, end = -1;
    for (let j = i; j < ME.length; j++) {
        if (ME[j] === '{') depth++;
        else if (ME[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) return null;
    const src = ME.slice(at, end);
    // today() is the only app global these two touch.
    return new Function('today', src + '; return ' + name + ';')(() => '2026-01-01');
}
