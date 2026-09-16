// node --test tests/dunning_and_expiry.test.js
//
// Two gaps left over from the payments audit, both about a card that stops
// working.
//
//   NO DUNNING. 175 flagged a declined plan and raised one notification. After
//     that, nothing: the same dead card was charged on every instalment date,
//     declined again, and told nobody again — the notification is deduped on
//     (family, plan, reason), which is right for not nagging nightly and wrong
//     for a plan that has now failed six times. Three consequences: nobody knew
//     it was getting worse, every attempt cost an authorisation fee, and the
//     plan quietly ran its counter to the end with the balance untouched.
//
//   NO EXPIRY WARNING. A card expires on a date known the day it is saved.
//     Autopay simply started declining mid-summer and fell into the dunning
//     above — correct handling of a problem that did not need to happen.
//
// And the part that made the first one invisible: Billing COMPUTED
// collectionBlocked and no screen ever rendered it. The code said "show it — a
// notification alone is missed" directly above a value nothing used.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M179 = read('migrations/179_dunning_and_card_expiry.sql');
const ME = read('campistry_me.js');
const RUNNER = read('supabase/functions/charge-due-installments/index.ts');

// ── 1. a decline gets louder, and cheaper, the longer it goes on ────────────

test('retries back off instead of running on every due date', () => {
    // Most processors bill for an authorisation whether it approves or
    // declines, so retrying a closed account on schedule is a charge for
    // nothing. The schedule lives in a function so the runner, the UI and this
    // test all read the same numbers.
    assert.match(M179, /FUNCTION public\.collection_retry_days/);
    const fn = M179.slice(M179.indexOf('FUNCTION public.collection_retry_days'),
                          M179.indexOf('REVOKE ALL ON FUNCTION public.collection_retry_days'));
    // Strictly increasing — a backoff that does not back off is just a delay.
    const days = [...fn.matchAll(/THEN (\d+)\s*$/gm)].map(m => Number(m[1]));
    const all = days.concat([...fn.matchAll(/ELSE (\d+)/g)].map(m => Number(m[1])));
    assert.ok(all.length >= 4, `expected a schedule of at least 4 steps, saw ${all.length}`);
    for (let i = 1; i < all.length; i++) {
        assert.ok(all[i] > all[i - 1],
            `the retry schedule does not increase: ${all.join(', ')}`);
    }
});

test('the attempt count only grows for the SAME problem', () => {
    // "Declined three times" is a dead card. Declined, then no_processor, then
    // declined is three different nights, and escalating on it would cry wolf.
    const fn = M179.slice(M179.indexOf('FUNCTION public.flag_plan_collection'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /v_same := v_had AND v_prev->>'reason' = p_reason;/);
    assert.match(body, /v_att := CASE WHEN v_same[\s\S]{0,120}\+ 1[\s\S]{0,40}ELSE 1 END;/,
        'a new kind of failure inherits the old count');
});

test('the third failure escalates, once, under its own key', () => {
    const fn = M179.slice(M179.indexOf('FUNCTION public.flag_plan_collection'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /v_esc := v_att >= public\.collection_escalate_after\(\);/);

    // The first notification is deduped on (family, plan, reason). Without a
    // DIFFERENT source_id the escalation — the message that actually matters —
    // would be swallowed by the one that no longer does.
    assert.match(body, /p_reason \|\| ':escalated'/,
        'the escalation reuses the first notification key, so it is never delivered');
    // ...and only on the attempt that crosses the line, not every night after.
    assert.match(body, /IF v_esc AND NOT v_was THEN/,
        'the escalation fires again on every subsequent failure');
    assert.match(body, /v_was := v_same AND COALESCE\(\(v_prev->>'escalated'\)::boolean, false\);/);
});

test('collecting clears the block, the count and the schedule together', () => {
    // A parent who fixes their own card must not need anyone to dismiss
    // anything. This is 175's behaviour and it has to survive the rewrite.
    const fn = M179.slice(M179.indexOf('FUNCTION public.flag_plan_collection'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /IF COALESCE\(p_reason, ''\) = '' THEN[\s\S]{0,400}v_plan := v_plan - 'collectionBlocked';/,
        'clearing no longer removes the whole block');
    // The runner still clears on a successful charge.
    assert.match(RUNNER, /flagPlan\(String\(row\.camp_id\), famKey, String\(plan\.id \|\| ""\), null\)/);
});

test('`since` still survives a repeat so the office sees how long', () => {
    const fn = M179.slice(M179.indexOf('FUNCTION public.flag_plan_collection'));
    assert.match(fn, /'since', CASE WHEN v_same THEN v_prev->>'since'/,
        'the "stuck since" date resets every night again');
});

// ── 2. the runner holds off before touching the gateway ─────────────────────

test('a plan waiting to retry is skipped BEFORE the gateway is called', () => {
    assert.match(RUNNER, /waiting_to_retry/, 'the runner never honours the retry schedule');
    const at = RUNNER.indexOf('waiting_to_retry');
    // It has to come before the charge, or the authorisation (and its fee) has
    // already happened and the backoff saved nothing.
    const charge = RUNNER.indexOf('const res = processorKey === "cardknox"', at);
    assert.ok(charge > at,
        'the retry gate sits after the charge, so a dead card is still billed for');
    assert.match(RUNNER, /blocked\.nextRetryAt && String\(blocked\.nextRetryAt\) > today/);
});

test('plan_collection_ready fails OPEN, never closed', () => {
    // A missing or unparseable schedule must cost an extra attempt, never stop
    // collection. Getting this backwards would silently stop charging a camp.
    const fn = M179.slice(M179.indexOf('FUNCTION public.plan_collection_ready'),
                          M179.indexOf('REVOKE ALL ON FUNCTION public.plan_collection_ready'));
    assert.match(fn, /NOT \(p_plan \? 'collectionBlocked'\) THEN true/,
        'an unblocked plan is not automatically ready');
    assert.match(fn, /nextRetryAt', ''\) = '' THEN true/,
        'a block with no schedule is treated as not ready, which stops collection');
});

// ── 3. the warning before the failure ───────────────────────────────────────

test('a card is good until the END of its expiry month', () => {
    // The classic off-by-one. A 09/2026 card works all through September; a
    // check against the 1st declares it dead a month early and sends the camp
    // chasing a card that is fine.
    const fn = M179.slice(M179.indexOf('FUNCTION public.card_expiry_status'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /make_date\(v_y, v_m, 1\) \+ interval '1 month'/,
        'expiry is measured from the first of the month, killing a card a month early');
    assert.match(body, /IF v_y < 100 THEN v_y := 2000 \+ v_y; END IF;/,
        "a two-digit year ('27') is read as year 27 AD");
});

test('a card with no expiry captured is unknown, and is NOT warned about', () => {
    // The BYOP adapters return a brand and last four and no expiry at all. A
    // warning nobody can act on is worse than silence, and pretending to have
    // checked is worse still.
    const fn = M179.slice(M179.indexOf('FUNCTION public.card_expiry_status'));
    const body = fn.slice(0, fn.indexOf('\n$$;'));
    assert.match(body, /RETURN 'unknown';/);
    const flag = M179.slice(M179.indexOf('FUNCTION public.flag_expiring_cards'));
    assert.match(flag, /v_status IN \('expired', 'expiring'\)/,
        "an 'unknown' card is treated as a problem to chase");
});

test('only the card autopay will actually charge decides', () => {
    // A spare card expiring is not what stops collection, and warning about it
    // trains the office to ignore the warning.
    const flag = M179.slice(M179.indexOf('FUNCTION public.flag_expiring_cards'));
    assert.match(flag, /COALESCE\(\(m->>'default'\)::boolean, false\) OR jsonb_array_length\(v_methods\) = 1/);
    // ...and only for a family that is actually on autopay.
    assert.match(flag, /IF NOT v_autopay THEN CONTINUE; END IF;/);
});

test('the warning is said once a month, not once a night', () => {
    const flag = M179.slice(M179.indexOf('FUNCTION public.flag_expiring_cards'));
    assert.match(flag, /to_char\(v_as_of, 'YYYY-MM'\)/,
        'the expiry notification is keyed per night, so it arrives every night');
    assert.match(flag, /ON CONFLICT \(camp_id, source, source_id\) DO NOTHING/);
    // A replaced card clears the flag rather than leaving a stale warning.
    assert.match(flag, /IF v_fam \? 'cardExpiry' THEN[\s\S]{0,120}v_fam - 'cardExpiry'/);
});

test('the expiry Stripe hands us is actually stored', () => {
    // stripe-webhook already fetched the PaymentMethod for a label and threw
    // exp_month/exp_year away, so there was nothing to check against.
    const hook = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(hook, /pmExpMonth = Number\(pm\.card\.exp_month\)/);
    assert.match(hook, /expMonth: pmExpMonth, expYear: pmExpYear/,
        'the expiry is read but never written onto the saved method');
    // A bank account has no expiry, and must not get a fabricated one.
    assert.match(hook, /pmExpMonth && pmExpYear \?/,
        'a method with no expiry would be stored with nulls rather than omitted');
});

test('the check runs where the nightly job already is', () => {
    assert.match(RUNNER, /flag_expiring_cards/, 'nothing ever calls the expiry check');
    // Best-effort: a failed expiry check must never stop the camp being charged.
    const at = RUNNER.indexOf('flag_expiring_cards');
    const block = RUNNER.slice(at - 400, at + 700);
    assert.match(block, /try \{/, 'the expiry check can throw and abort the whole run');
    assert.match(block, /console\.warn/);
});

// ── 4. the half that makes any of it visible ────────────────────────────────

test('Billing actually renders the block it has always computed', () => {
    // The original defect underneath the defect: the value existed, the comment
    // said to show it, and no screen did.
    assert.match(ME, /function _collectionWarning\(l\)/,
        'nothing turns a collection block into something on screen');
    const calls = (ME.match(/_collectionWarning\(l\)/g) || []).length;
    assert.ok(calls >= 3,
        `the warning is built but rendered in ${calls - 1} place(s); expected the ` +
        `billing list row and the family detail header`);
});

test('an escalated block reads as an error, not another warning', () => {
    const fn = ME.slice(ME.indexOf('function _collectionWarning'),
                        ME.indexOf('function _flatStatus'));
    assert.match(fn, /b\.escalated\?'err':'warn'/,
        'three consecutive failures look the same as one bad night');
    assert.match(fn, /'Not collecting — '/);
    assert.match(fn, /b\.nextRetryAt/, 'the office cannot see when it will next be tried');
    assert.match(fn, /n>1\)label\+=' ×'\+n/, 'the attempt count is not shown');
});

test('an expiring card shows up next to the family it belongs to', () => {
    assert.match(ME, /l\.cardExpiry=l\.family\.cardExpiry\|\|null;/);
    const fn = ME.slice(ME.indexOf('function _collectionWarning'),
                        ME.indexOf('function _flatStatus'));
    assert.match(fn, /cardExpiry\.status==='expired'[\s\S]{0,160}'err'/);
    assert.match(fn, /cardExpiry\.status==='expiring'[\s\S]{0,160}'warn'/);
});
