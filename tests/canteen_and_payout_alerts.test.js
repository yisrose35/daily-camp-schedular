// node --test tests/canteen_and_payout_alerts.test.js
//
// Three ways money stopped moving without anyone being told, found by auditing
// the money systems outside tuition billing.
//
//   CANTEEN AUTO-RELOAD SWITCHED ITSELF OFF IN SILENCE. canteen-auto-reload
//     already did the sensible thing with a failing card — three declines and
//     enabled:false, rather than burning an authorisation fee a night. It just
//     never told anyone. There is not one insert into `notifications` in that
//     whole function. The first anyone learns of it is a child being declined
//     at the counter, and the camp cannot explain it because nothing told them
//     either.
//
//   SEASON-END "REFUND ALL" WAS STRIPE-ONLY. The button called
//     stripe-canteen-refund-all unconditionally. On a Cardknox or Banquest camp
//     that function looks for Stripe charges the camp never had, finds nothing
//     refundable, and reports success — having returned nobody's money. What
//     makes it an oversight rather than a decision is that the PER-CAMPER
//     refund was carefully made processor-aware; only the bulk path was left.
//
//   A CAMP'S OWN PAYOUT FAILED AND NOTHING SAID SO. stripe-connect-webhook
//     handled exactly three events, none of them a payout. A camp with a closed
//     bank account saw money collected, saw none arrive, and found nothing here
//     that explained the gap.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

const M180 = read('migrations/180_canteen_autoreload_and_payout_alerts.sql');
const SNACKS = read('campistry_snacks.js');
const CONNECT_HOOK = read('supabase/functions/stripe-connect-webhook/index.ts');
const RELOAD = read('supabase/functions/canteen-auto-reload/index.ts');

// ── 1. auto-reload says something when it gives up ──────────────────────────

test('the edge function still disables a card after three failures', () => {
    // The behaviour being announced. If this ever goes, the notification below
    // is announcing something that no longer happens.
    assert.match(RELOAD, /consecutiveFailures >= 3\) ar\.enabled = false/,
        'auto-reload no longer stops retrying a dead card');
});

test('switching off raises a notification', () => {
    const fn = M180.slice(M180.indexOf('FUNCTION public.update_canteen_autoreload_state'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /INSERT INTO notifications/,
        'auto-reload still turns itself off in total silence');
    assert.match(body, /'canteen_autoreload_off'/);
    // The message has to say what happens NEXT, not just what happened — the
    // point is that the office acts before a child is declined at the register.
    assert.match(body, /declined at the register/);
});

test('it speaks on the TRANSITION, not on every write', () => {
    // This RPC is called on every success and every failure. Notifying on
    // "enabled is false" rather than "enabled just became false" would send a
    // message every night for every card anyone ever switched off.
    const fn = M180.slice(M180.indexOf('FUNCTION public.update_canteen_autoreload_state'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /v_notify := v_was_on AND NOT v_now_on AND v_fails >= 3;/,
        'the notification does not depend on the card having just been switched off');
    // The previous state has to be read from the row this function already
    // locked; reading it any other way is a race with the next writer.
    assert.match(body, /FOR UPDATE/);
    const prevAt = body.indexOf("v_prev   := v_value");
    const lockAt = body.indexOf('FOR UPDATE');
    assert.ok(lockAt > 0 && prevAt > lockAt,
        'the previous state is read before the lock is taken');
});

test('it is deduped per switch-off, not per night', () => {
    const fn = M180.slice(M180.indexOf('FUNCTION public.update_canteen_autoreload_state'));
    assert.match(fn, /p_camper_name \|\| ':' \|\| to_char\(now_ts, 'YYYY-MM-DD'\)/,
        'the notification key does not include the day, so a re-enabled card ' +
        'failing again weeks later would be swallowed as a duplicate');
    assert.match(fn, /ON CONFLICT \(camp_id, source, source_id\) DO NOTHING/);
});

test('the reason outlives the notification', () => {
    // A notification gets dismissed. The account itself has to be able to
    // explain why auto-reload is off, or the next person to look has no idea.
    const fn = M180.slice(M180.indexOf('FUNCTION public.update_canteen_autoreload_state'));
    assert.match(fn, /'disabledAt'/);
    assert.match(fn, /'disabledReason'/);
});

test('the balance and transactions are still left alone', () => {
    // 144's whole reason for existing: credit_canteen_balance_from_processor
    // may have just committed a balance to this row, and a full-blob write of
    // the pre-credit snapshot erases it. Only the autoReload sub-key is set.
    const fn = M180.slice(M180.indexOf('FUNCTION public.update_canteen_autoreload_state'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    const code = body.replace(/--[^\n]*/g, '');           // statements, not prose
    const sets = [...code.matchAll(/jsonb_set\(v_value,\s*ARRAY\[([^\]]+)\]/g)].map(m => m[1]);
    assert.ok(sets.length > 0, 'nothing is written at all — the slice is wrong');
    for (const s of sets) {
        // The one wide write 144 already had is creating a MISSING account from
        // a default shape, which is guarded by IS NULL and cannot erase
        // anything. Everything else must target the autoReload sub-key.
        const creatingAccount = /'accounts',\s*p_camper_name\s*$/.test(s.trim());
        assert.ok(creatingAccount || /'autoReload'/.test(s),
            `this migration writes ARRAY[${s}] — 144 only ever writes the autoReload ` +
            `sub-key, and a wider write can erase a balance that ` +
            `credit_canteen_balance_from_processor committed moments earlier`);
    }
    // And nothing anywhere near balance or transactions.
    assert.ok(!/jsonb_set\(v_value[^)]*'(balance|transactions)'/.test(code),
        'this migration writes balance or transactions, which it must never touch');
    // The account-creation default must still be exactly 144's.
    assert.match(code, /\{"balance":0,"dailyLimit":10,"spentToday":0\}/);
});

// ── 2. the season-end refund reaches BYOP camps ─────────────────────────────

test('a bulk BYOP refund function exists at all', () => {
    assert.ok(exists('supabase/functions/payments-canteen-refund-all/index.ts'),
        'there is still no way to return leftover canteen money in bulk on a ' +
        'non-Stripe camp');
});

test('the button routes by processor instead of assuming Stripe', () => {
    const at = SNACKS.indexOf('canteen-refund-all');
    const block = SNACKS.slice(at - 900, at + 400);
    assert.match(block, /_getSnacksProcessorKey\(\)/,
        'Refund All never asks which processor the camp is on');
    assert.match(block, /processorKey === 'stripe' \? 'stripe-canteen-refund-all' : 'payments-canteen-refund-all'/,
        'Refund All still calls one function regardless of processor');
});

test('each bulk function refuses the other one’s camps', () => {
    // Belt and braces for the client routing: if that ever regresses, the
    // function says so rather than quietly refunding nothing.
    const byop = read('supabase/functions/payments-canteen-refund-all/index.ts');
    assert.match(byop, /This camp is on Stripe — use stripe-canteen-refund-all instead/);
    assert.match(byop, /processorKey !== "cardknox" && processorKey !== "banquest"/);
});

test('a camper is capped by BOTH their wallet and what their deposits can give back', () => {
    // Refunding more than the camper's own online deposits would push money
    // onto a card that never paid it — and refunding more than the wallet holds
    // would hand back money already spent on snacks.
    const byop = read('supabase/functions/payments-canteen-refund-all/index.ts');
    assert.match(byop, /Math\.min\(walletAvailable, processorCapacity\)/);
    // Deposits from a processor the camp has SINCE LEFT must not be drawn on:
    // that transaction id means nothing to the gateway being called.
    assert.match(byop, /t\.method === processorKey && t\.byopTransactionId/);
    // Already-refunded amounts come off each deposit's remaining capacity.
    assert.match(byop, /kind === "refund" && t\.byopTransactionId === dep\.byopTransactionId/);
});

test('a chunk that fails keeps the chunks that already moved money', () => {
    const byop = read('supabase/functions/payments-canteen-refund-all/index.ts');
    // The result names the camper by number too (camperId), so the office sees
    // which of two same-named children a partial failure belongs to.
    assert.match(byop, /return \{ camperId, camperName, refunded, error: \(chunkErr as Error\)\.message \};/,
        'a mid-camper failure discards refunds that already succeeded');
    // And a camper with nothing refundable is a SKIP, not a failure — otherwise
    // every cash-only camper reads as an error and the real ones are lost.
    assert.match(byop, /skipped: processorCapacity <= 0/);
});

test('the bulk function trusts the caller’s session, not a supplied campId', () => {
    const byop = read('supabase/functions/payments-canteen-refund-all/index.ts');
    assert.match(byop, /async function callerCampId/);
    assert.match(byop, /const authedCampId = await callerCampId\(req\);/);
    assert.ok(!/body\.campId|campId \} = await req\.json/.test(byop),
        'the camp is taken from the request body, so any caller could refund ' +
        'another camp’s canteen balances');
});

// ── 3. a camp learns its own payout failed ──────────────────────────────────

test('the connected-account webhook handles payout.failed', () => {
    assert.match(CONNECT_HOOK, /event\.type === "payout\.failed"/,
        'a camp whose bank details are wrong still gets no warning here');
    assert.match(CONNECT_HOOK, /record_payout_failure/);
    // event.account is the only thing that says WHOSE payout it was.
    assert.match(CONNECT_HOOK, /p_stripe_account_id: acct/);
    assert.match(CONNECT_HOOK, /const acct = String\(event\.account \|\| ""\);/);
});

test('it resolves the camp and refuses to guess one', () => {
    const fn = M180.slice(M180.indexOf('FUNCTION public.record_payout_failure'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /FROM camps WHERE stripe_account_id = p_stripe_account_id/);
    assert.match(body, /'error', 'camp_not_found'/,
        'an unrecognised account is attached to some camp anyway');
    const guess = body.indexOf("'camp_not_found'");
    const insert = body.indexOf('INSERT INTO notifications');
    assert.ok(guess > 0 && insert > guess,
        'the notification is written before the camp is known to be real');
});

test('the message says the money is not lost, and what to do', () => {
    // "A payout failed" with no more than that sends an office into a panic
    // about money that is sitting safely at Stripe.
    const fn = M180.slice(M180.indexOf('FUNCTION public.record_payout_failure'));
    assert.match(fn, /still with Stripe, not lost/);
    assert.match(fn, /bank details are corrected/);
    assert.match(fn, /ON CONFLICT \(camp_id, source, source_id\) DO NOTHING/,
        'Stripe retries webhooks, so the same payout would notify repeatedly');
});

test('a failure to record one is logged as money the camp cannot see', () => {
    assert.match(CONNECT_HOOK, /money sitting at Stripe with nothing here to say so/,
        'a failed write is logged as a routine warning rather than a money problem');
});

test('the registration instructions name the new event', () => {
    // This function must be registered twice, and payout.failed only arrives on
    // the Connected-accounts endpoint. Shipping the code without that line means
    // the branch never runs and nobody can tell why.
    const header = CONNECT_HOOK.slice(0, CONNECT_HOOK.indexOf('import '));
    assert.match(header, /payout\.failed/,
        'the header never mentions payout.failed, so nobody knows to register it');
    assert.match(header, /payout\.failed[\s\S]{0,300}Connected accounts/,
        'the header does not say which endpoint payout.failed has to be ticked on');
});
