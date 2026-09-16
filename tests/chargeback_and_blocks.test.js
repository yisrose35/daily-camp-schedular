// node --test tests/chargeback_and_blocks.test.js
//
// Two gaps with the same shape: money stopped moving, or moved BACKWARDS, and
// nothing in the app said so.
//
//   CHARGEBACK. stripe-webhook handled charge.dispute.created by emailing
//     RISK_ALERT_EMAIL — the PLATFORM's address, not the camp's — and touched
//     neither the ledger nor finance.payments. So Stripe pulled the money out of
//     the camp's account while Campistry still showed the payment as 'succeeded'
//     and the family as having paid. The camp's books overstated collected cash.
//
//   COLLECTION STOPPED. A parent removing their last card clears cardOnFile but
//     nothing touches plans[].autopay, so the plan still reads active. The runner
//     skips the family BEFORE the plan loop, so the counter never advances — the
//     plan does not even run out, it stalls on the same instalment forever. A
//     decline was recorded honestly but told nobody.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../campistry_billing_core.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A later migration can CREATE OR REPLACE any of these functions — 177 replaces
// record_chargeback so a chargeback with no amount can still be posted. Reading
// 175's file alone would keep asserting against a definition the database no
// longer runs, and would go on passing while the live behaviour drifted away
// from it. So: the newest migration that defines each function wins, exactly as
// in Postgres.
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

/** The live source of one function: its last definition across all migrations. */
function liveFunction(name) {
    let body = '';
    for (const f of MIGRATIONS) {
        const sql = read('migrations/' + f);
        const at = sql.indexOf('FUNCTION public.' + name + '(');
        if (at < 0) continue;
        const end = sql.indexOf('\n$$;', at);
        if (end > at) body = sql.slice(at, end + 4);
    }
    return body;
}

const RECORD_CB = liveFunction('record_chargeback');
const RESOLVE_CB = liveFunction('resolve_chargeback');
const FLAG_PLAN = liveFunction('flag_plan_collection');
// What the assertions below read. Kept as one string so the existing tests are
// unchanged in meaning: they check the live definitions, whichever file those
// now live in.
const SQL = [RECORD_CB, RESOLVE_CB, FLAG_PLAN].join('\n');

test('the live chargeback functions were actually found', () => {
    // Every assertion in this file is vacuously true against an empty string.
    for (const [n, src] of [['record_chargeback', RECORD_CB],
                            ['resolve_chargeback', RESOLVE_CB],
                            ['flag_plan_collection', FLAG_PLAN]]) {
        assert.ok(src.length > 400, `${n} was not found in any migration`);
    }
});

// ── 1. a chargeback is a reversal of cash received ────────────────────────

test('a chargeback RAISES the balance and leaves the payment on the record', () => {
    const a = B.newAccount({ famKey: 'f1' });
    B.postTuition(a, { enrollmentId: 'e1', camperId: 101, tuition: 3000 });
    const pay = B.post(a, { kind: 'payment', amount: 250, reason: 'card' });
    assert.strictEqual(B.balance(a), 2750);

    // What record_chargeback posts.
    B.post(a, { kind: 'refund', amount: 250, reason: 'chargeback',
                note: 'Chargeback — fraudulent' });
    assert.strictEqual(B.balance(a), 3000, 'they owe it again');
    assert.ok(B.find(a, pay.entry.id), 'the original payment is still on the ledger');
    assert.strictEqual(B.find(a, pay.entry.id).kind, 'payment',
        'and is unchanged — a chargeback edits nothing');
});

test('chargeback is a distinct REASON from a refund the camp chose to give', () => {
    // Same effect on the balance, completely different things in a report: one
    // is a decision, the other is a loss.
    assert.ok(B.REASONS.includes('chargeback'), 'the reason is gone');
    const a = B.newAccount({ famKey: 'f1' });
    B.post(a, { kind: 'charge', amount: 100, reason: 'tuition' });
    const r = B.post(a, { kind: 'refund', amount: 40, reason: 'chargeback' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(B.summary(a).refunded, 40);
});

test('winning the dispute posts the payment back, keeping both entries', () => {
    const a = B.newAccount({ famKey: 'f1' });
    B.post(a, { kind: 'charge', amount: 1000, reason: 'tuition' });
    B.post(a, { kind: 'payment', amount: 250, reason: 'card' });
    B.post(a, { kind: 'refund', amount: 250, reason: 'chargeback' });
    assert.strictEqual(B.balance(a), 1000);
    B.post(a, { kind: 'payment', amount: 250, reason: 'chargeback',
                note: 'Chargeback reversed — the camp won the dispute' });
    assert.strictEqual(B.balance(a), 750, 'back where it started');
    assert.strictEqual(B.entriesOf(a).length, 4, 'all four entries remain');
});

// ── 2. the RPCs ───────────────────────────────────────────────────────────

test('record_chargeback is idempotent on the dispute id', () => {
    // Stripe redelivers webhooks. Reversing the same money twice would double it.
    assert.match(SQL, /v_entryId := 'le_cb_' \|\| p_dispute_id;/,
        'the entry id is no longer derived from the dispute id');
    assert.match(SQL, /WHERE e->>'id' = v_entryId[\s\S]{0,200}'alreadyRecorded', true/,
        'a redelivered dispute would post a second refund');
});

test('it matches the payment on a SET of references, not one field', () => {
    // A payment row carries stripePaymentIntentId or reference or
    // byopTransactionId depending on which path recorded it, and a Stripe dispute
    // gives the charge id and the payment_intent. Matching one field would fail
    // to find the payment.
    assert.match(SQL, /p_refs\s+text\[\]/, 'the refs argument is no longer a set');
    for (const f of ['stripePaymentIntentId', 'reference', 'byopTransactionId']) {
        assert.ok(SQL.includes("e->>'" + f + "' = ANY(p_refs)"),
            'no longer matches a payment by ' + f);
    }
});

test('it refuses to guess a family rather than post against the wrong one', () => {
    assert.match(SQL, /'error', 'family_not_found'/,
        'an unmatched chargeback is silently swallowed');
    assert.ok(!/LIMIT 1[\s\S]{0,80}v_famKey := famRec\.key;[\s\S]{0,80}ELSE/.test(SQL),
        'there is a fallback that picks an arbitrary family');
    // And the caller must say so loudly.
    const hook = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(hook, /overstate collected cash until this is reconciled by hand/,
        'a failed chargeback post is no longer logged as a books problem');
});

test('losing the dispute posts nothing — the refund already stands', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.resolve_chargeback'));
    assert.match(fn, /IF NOT COALESCE\(p_won, false\) THEN[\s\S]{0,300}'outcome', 'lost'/,
        'a lost dispute posts a second reversal, doubling it');
});

test('the camp is notified, not just the platform', () => {
    assert.match(SQL, /INSERT INTO notifications[\s\S]{0,200}'chargeback'/,
        'the camp still learns nothing about a chargeback');
    assert.match(SQL, /ON CONFLICT \(camp_id, source, source_id\) DO NOTHING/,
        'the notification is not deduped');
});

// ── 3. the plan that cannot collect ───────────────────────────────────────

test('flag_plan_collection sets, clears, and keeps the original `since`', () => {
    assert.match(SQL, /v_plan - 'collectionBlocked'/, 'a null reason no longer clears the flag');
    // `since` must not reset every night, or nobody can see how long a plan has
    // been stuck.
    assert.match(SQL, /v_plan->'collectionBlocked'->>'reason' = p_reason\s*\n?\s*THEN v_plan->'collectionBlocked'->>'since'/,
        'the since date resets on every run');
});

test('one notification per plan per reason, not one a night', () => {
    assert.match(SQL, /p_family_key \|\| ':' \|\| p_plan_id \|\| ':' \|\| p_reason/,
        'the notification key is no longer deterministic — it would fire nightly');
});

test('the runner flags every way collection stops, and clears on success', () => {
    const src = read('supabase/functions/charge-due-installments/index.ts');
    for (const reason of ['"no_card"', '"no_processor"', '"declined"']) {
        assert.ok(src.includes(reason), 'the runner no longer flags ' + reason);
    }
    // Cleared on a successful charge, with the same call.
    assert.match(src, /await flagPlan\(String\(row\.camp_id\), famKey, String\(plan\.id \|\| ""\), null\);/,
        'a successful charge no longer clears the block');
    // The no-card case is flagged BEFORE the skip, or nothing in the run ever
    // mentions that family again.
    const skip = src.indexOf('result: "skipped_no_chargeable_card"');
    const flag = src.lastIndexOf('"no_card"', skip);
    assert.ok(flag > 0 && flag < skip, 'the no-card flag is set after the family is skipped');
});

test('Billing shows the block — a notification alone is missed', () => {
    const ME = read('campistry_me.js');
    assert.match(ME, /l\.collectionBlocked=/,
        'the ledger no longer carries the block, so Billing cannot show it');
    assert.match(ME, /p&&p\.collectionBlocked\?/, 'it is not read off the plans');
});

test('the webhook handles dispute CLOSED as well as created', () => {
    const hook = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(hook, /"charge\.dispute\.closed"/,
        'a dispute the camp WINS never puts the money back');
    assert.match(hook, /const won = String\(obj\.status \|\| ""\) === "won";/,
        'the outcome is no longer read from the dispute status');
    // Ledger before email: if the mail provider is down the money must still be right.
    const ledger = hook.indexOf('await handleDisputeLedger(supabase, event)');
    const email = hook.indexOf('await handleRiskEvent(event)', ledger);
    assert.ok(ledger > 0 && email > ledger, 'the platform email runs before the ledger write');
});

test('a dispute with no campId is refused, not guessed', () => {
    const hook = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(hook, /cannot post it to a ledger; reconcile by hand/,
        'a dispute with no camp is silently dropped or guessed at');
});

// ── a chargeback that does not say how much ─────────────────────────────────
//
// 175 required an amount and refused with 'bad_amount' otherwise. The field
// picker in Sola/Cardknox's own Webhook Settings screen shows that assumption
// was wrong: its Transaction Fields carry no xAmount at all. Requiring one
// meant a dispute we could identify perfectly still went unrecorded — leaving
// the camp exactly where it started, money gone with nothing to show for it.

test('a chargeback with no amount uses the amount of the payment it disputes', () => {
    // The amount must be resolved AFTER the payment is matched, because the
    // matched payment is where it comes from. An early guard would refuse the
    // call before ever looking.
    const guard = RECORD_CB.indexOf("'bad_amount'");
    assert.strictEqual(guard, -1,
        'record_chargeback still refuses outright when no amount is supplied, so a ' +
        'Cardknox dispute — whose postback has no amount field — is never recorded');

    assert.match(RECORD_CB, /v_matched\s+numeric/,
        'nothing captures the matched payment’s own amount');
    assert.match(RECORD_CB, /CASE WHEN COALESCE\(p_amount, 0\) > 0\s*\n?\s*THEN p_amount ELSE COALESCE\(v_matched, 0\) END/,
        'a supplied amount no longer wins over the matched payment’s — which would ' +
        'silently turn every PARTIAL chargeback into a full one');

    // Both match paths must supply it, or the ledger path is a silent hole.
    const ledgerPath = RECORD_CB.slice(RECORD_CB.indexOf('FOR famRec'), RECORD_CB.indexOf('Not in a ledger'));
    assert.match(ledgerPath, /\(e->>'amount'\)::numeric INTO v_matched/,
        'a chargeback matched via the LEDGER never picks up an amount');
    const financePath = RECORD_CB.slice(RECORD_CB.indexOf('Not in a ledger'), RECORD_CB.indexOf('family_not_found'));
    assert.match(financePath, /\(e->>'amount'\)::numeric/,
        'a chargeback matched via finance.payments never picks up an amount');
});

test('matched but still amountless is refused, not posted as $0', () => {
    // A $0 refund entry reads as "handled" on every screen while moving nothing.
    assert.match(RECORD_CB, /'error', 'amount_unknown'/,
        'an unresolvable amount posts a zero entry instead of failing loudly');
    const at = RECORD_CB.indexOf("'amount_unknown'");
    const posted = RECORD_CB.indexOf("'kind', 'refund'");
    assert.ok(at > 0 && posted > at,
        'the amount check runs after the refund is already posted');
});

test('where the figure came from is recorded on the entry', () => {
    // "The processor said $450" and "the payment it disputed was $450" are
    // different claims, and a camp querying a chargeback deserves to know which.
    assert.match(RECORD_CB, /'amountSource'/,
        'nothing records whether the amount came from the processor or from our own payment');
    assert.match(RECORD_CB, /THEN 'processor' ELSE 'matched_payment' END/);
});

test('the dispute webhook no longer drops an amountless dispute', () => {
    const hook = read('supabase/functions/byop-dispute-webhook/index.ts');
    assert.ok(!/dispute \$\{d\.disputeId\} has no amount — not recorded/.test(hook),
        'the webhook still refuses a dispute that carries no amount');
    assert.match(hook, /p_amount: d\.amount > 0 \? d\.amount : null/,
        'the webhook does not pass null to let the payment supply the amount');
});

test('the Cardknox mapper reads the names the POSTBACK uses, not the API response', () => {
    // The API response calls the transaction reference xRefNum; the postback
    // spells the same value xResponseRefnum, with xGatewayRefNum alongside.
    // Reading only xRefNum — as this did at first — finds nothing at all, and
    // the endpoint logs "could not find a transaction reference" forever.
    const hook = read('supabase/functions/byop-dispute-webhook/index.ts');
    const ck = hook.slice(hook.indexOf('processor === "cardknox"'),
                          hook.indexOf('processor === "banquest"'));
    for (const f of ['xResponseRefnum', 'xGatewayRefNum']) {
        assert.ok(ck.includes('b.' + f),
            `the Cardknox mapper does not read ${f}, which is what the postback actually sends`);
    }
    assert.ok(ck.includes('b.xRefNum'),
        'the API-response spelling was dropped — harmless to keep and needed if a ' +
        'dispute ever arrives shaped like an API response');
});
