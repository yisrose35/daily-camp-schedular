// node --test tests/refund_idempotency.test.js
//
// record_external_refund is idempotent — on the PROCESSOR's refund id, which does
// not exist until the processor call has already succeeded. So a repeat of a refund
// request went:
//
//     call the processor -> refund R1 -> ledger entry for R1
//     call it again      -> refund R2 -> ledger entry for R2
//
// Both entries correct, the family refunded twice in real money. The bookkeeping
// was protected; the money was not. A claim has to be taken BEFORE the irreversible
// call, on a key the caller controls and repeats.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = p => read(p).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');

const SQL = code('migrations/198_refund_intents.sql');
const REFUND = read('supabase/functions/payments-refund/index.ts');
const CANTEEN = read('supabase/functions/payments-canteen-refund/index.ts');
const CANTEEN_ALL = read('supabase/functions/payments-canteen-refund-all/index.ts');
const TELNYX = read('supabase/functions/telnyx-charge-monthly-fees/index.ts');

// ── the claim table ────────────────────────────────────────────────────────

test('the claim is a primary key, which is what makes it a claim', () => {
    // Two concurrent requests both inserting is resolved by the database, not by
    // application timing. ON CONFLICT DO NOTHING plus FOUND is the whole mechanism.
    assert.match(SQL, /PRIMARY KEY \(camp_id, key\)/);
    assert.match(SQL, /ON CONFLICT \(camp_id, key\) DO NOTHING/);
    assert.match(SQL, /IF FOUND THEN\s*\n\s*RETURN jsonb_build_object\('claimed', true/);
});

test('nothing but the service role can read what a family was refunded', () => {
    assert.match(SQL, /ALTER TABLE public\.refund_intents ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /REVOKE ALL ON TABLE public\.refund_intents FROM anon, authenticated/);
    ['claim_refund_intent', 'settle_refund_intent', 'release_refund_intent'].forEach(fn =>
        assert.ok(new RegExp('REVOKE ALL ON FUNCTION public\\.' + fn
            + '[\\s\\S]{0,120}FROM public, anon, authenticated').test(SQL),
            fn + ' must not be callable from a browser'));
});

test('a missing key proceeds UNGUARDED rather than blocking the refund', () => {
    // The safe direction here is the opposite of most gates. Refusing to claim
    // would stop an office issuing money because a header was absent, which is a
    // worse failure than the duplicate it prevents.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.claim_refund_intent'));
    const body = fn.slice(0, fn.indexOf('END $$'));
    assert.match(body, /IF p_camp_id IS NULL OR v_key IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('claimed', true, 'unguarded', true\)/);
});

test('a SETTLED claim is never released', () => {
    // That one really did move money. Handing it back would authorise a second
    // refund of the same amount.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.release_refund_intent'));
    const body = fn.slice(0, fn.indexOf('END $$'));
    assert.match(body, /AND settled_at IS NULL/);
});

test('a failed call gives the claim back, or the refund is locked out for good', () => {
    // Without this the office retries, is told it already happened, and the family
    // never sees their money.
    assert.match(SQL, /FUNCTION public\.release_refund_intent/);
    [['payments-refund', REFUND], ['payments-canteen-refund', CANTEEN],
     ['payments-canteen-refund-all', CANTEEN_ALL]].forEach(([name, src]) => {
        assert.match(src, /release_refund_intent/, name + ' must release on failure');
    });
});

// ── the ordering that is the whole point ───────────────────────────────────

test('every refund function claims BEFORE it calls the processor', () => {
    [['payments-refund', REFUND, 'cardknoxRefund(credResult'],
     ['payments-canteen-refund', CANTEEN, 'cardknoxRefund(credResult'],
     ['payments-canteen-refund-all', CANTEEN_ALL, 'cardknoxRefund(credentials']
    ].forEach(([name, src, processorCall]) => {
        const claim = src.indexOf('claim_refund_intent');
        const call = src.indexOf(processorCall);
        assert.ok(claim > 0, name + ' must claim at all');
        assert.ok(call > 0, name + ': processor call not found — anchor moved');
        assert.ok(claim < call,
            name + ' claims AFTER the processor call, which protects nothing');
    });
});

test('the claim key is DERIVED FROM THE REQUEST, not a constant', () => {
    // The ordering test below compares where `claim_refund_intent` appears, which
    // stays green on a version where claimKey is hardcoded null and the claim never
    // runs at all. Pin where the key comes from too.
    assert.match(REFUND, /const claimKey = typeof idempotencyKey === "string" && idempotencyKey\.trim\(\)/);
    // The single canteen refund is claimed on every request: on the page's key
    // for this refund when it sends one (TED-105), else on the deposit and what
    // is left on it (TED-093).
    // (one part per top-up per refund; behaviour in tests/refund_lost_answer.test.js)
    // (the amount part is the reserved amount, 275)
    assert.match(CANTEEN, /\? `canteen:\$\{reqKey\}:\$\{dep\.externalTransactionId\}`\s*: `canteen:\$\{dep\.externalTransactionId\}:\$\{Math\.round\(dep\.remaining \* 100\)\}:\$\{Math\.round\(amt \* 100\)\}`;/);
    assert.match(CANTEEN, /const chunkKey = holdKey;/);
    assert.match(CANTEEN_ALL, /typeof body\.idempotencyKey === "string" && body\.idempotencyKey\.trim\(\)/);
    // And the claim is actually gated on having one, not skipped outright.
    assert.match(REFUND, /if \(claimKey\) \{[\s\S]{0,200}claim_refund_intent/);
});

test('a claim that loses replays the first answer instead of refunding again', () => {
    assert.match(REFUND, /if \(claim && claim\.claimed === false\)/);
    assert.match(REFUND, /replayed: true/);
    // The canteen loops skip the chunk rather than returning, because the other
    // chunks in the batch may still need doing.
    // ...but only a SETTLED one (TED-093); one never confirmed stops instead.
    // The settled one is COUNTED toward this refund first (TED-109), so the
    // loop never goes on to refund the same money from the next top-up.
    assert.match(CANTEEN, /if \(claim && claim\.claimed === false\) \{\s*if \(claim\.previous && claim\.previous\.externalTransactionId\) \{[\s\S]{0,1000}remainingToRefund = round2\(remainingToRefund - doneAmt\);\s*continue;/);
    assert.match(CANTEEN_ALL, /if \(claim && claim\.claimed === false\) \{[\s\S]{0,700}continue;/);
});

test('the claim records the answer so a retry has something to replay', () => {
    [['payments-refund', REFUND], ['payments-canteen-refund', CANTEEN],
     ['payments-canteen-refund-all', CANTEEN_ALL]].forEach(([name, src]) =>
        assert.match(src, /settle_refund_intent/, name + ' must settle on success'));
});

test('the canteen keys are per CHUNK, not per request', () => {
    // Each chunk is its own processor call against its own deposit, so a resumed
    // run has to be able to skip exactly what it finished.
    assert.match(CANTEEN, /\$\{dep\.externalTransactionId\}:\$\{Math\.round\(dep\.remaining \* 100\)\}:\$\{Math\.round\(amt \* 100\)\}/);
    // The camper part is their NUMBER when the account has one: two children who
    // share a name must not share a claim (the second would be skipped as
    // "already settled"). The name only for an account with no number.
    // Refund-all uses the SAME per-money key as the single refund (TED-093):
    // Snacks sends no key, and a deposit id is unique however children are named.
    assert.match(CANTEEN_ALL, /const keyFor = \(amt: number\) => `canteen:\$\{dep\.externalTransactionId\}:\$\{Math\.round\(dep\.remaining \* 100\)\}:\$\{Math\.round\(amt \* 100\)\}`;/);
    assert.match(CANTEEN_ALL, /const chunkKey = holdKey;/);
});

test('refund-all can still be called with no body at all', () => {
    // It never parsed one before. A missing or unparsable body means no key and an
    // unguarded run, not an error.
    assert.match(CANTEEN_ALL, /try \{ body = \(await req\.json\(\)\) \|\| \{\}; \} catch \{ body = \{\}; \}/);
});

// ── the client half ────────────────────────────────────────────────────────

test('the browser keys each chunk on its payment, what is left on it and the amount (TED-093)', () => {
    const ME = read('campistry_me.js');
    // The same refund on a later click meets its first attempt; a refund that
    // was recorded changes what is left, so a deliberate second refund differs.
    assert.match(ME, /var _chunkKey=function\(p,left,amt\)\{/);
    assert.match(ME, /idempotencyKey:_chunkKey\(p,chunks\[ci\]\.remaining,chunk\)/);
    assert.ok(!/_refundKey\+'_'\+Date\.now\(\)|'rfnd_'\+fk\+'_'\+Date\.now\(\)/.test(ME), 'a per-click key is back');
});

// ── the recurring charge's crash window ────────────────────────────────────

test('the monthly fee carries a Stripe idempotency key for its period', () => {
    // next_charge_at already stops a re-run, but not a crash BETWEEN the charge
    // and the date advance. The key makes the retry return the first intent.
    assert.match(TELNYX, /if \(idemKey\) headers\["Idempotency-Key"\] = idemKey;/);
    assert.match(TELNYX, /`telnyx_fee_\$\{row\.camp_id\}_\$\{row\.next_charge_at\}`/,
        'camp plus period: same key on a retry of this month, different next month');
});

test('the migration is a standalone paste and parses inside its bodies', () => {
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('198_refund_intents'));
    const { execFileSync } = require('node:child_process');
    execFileSync('python3', [path.join(ROOT, 'scripts/check_plpgsql_bodies.py'),
                             path.join(ROOT, 'migrations/198_refund_intents.sql')],
                 { encoding: 'utf8' });
});
