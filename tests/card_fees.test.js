// node --test tests/card_fees.test.js
//
// Passing card processing costs to families. Camps ask for it constantly, and it
// is three different things with three different rule books:
//
//   SURCHARGE — a percentage on CREDIT cards. Lesser of the camp's cost of
//     acceptance and 3%. Never on debit, prepaid, FSA, HSA or Medicare Flex.
//     Banned in CT, MA, ME and Puerto Rico, and Louisiana from 1 Aug 2026.
//     30 days' written notice to the processor first. Refunded proportionally.
//
//   CONVENIENCE FEE — a FLAT amount for a channel. Applies to debit and ACH too.
//     Visa and Amex require a fixed amount; "2.9% convenience fee" is a
//     surcharge wearing the wrong name.
//
//   CASH DISCOUNT — the card price is the posted price. Legal everywhere.
//
// The guard that matters most: every card-saving path in this codebase recorded
// the BRAND and the last four digits and threw the FUNDING TYPE away, so there
// was no way to tell a debit card from a credit one. A surcharge is therefore
// refused whenever funding is not known to be 'credit' — as the answer, not as a
// default to override.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = p => read(p).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');

const F = require(path.join(ROOT, 'campistry_card_fees.js'));
const SQL = code('migrations/192_card_fee_policy.sql');
const ME = read('campistry_me.js');
const REG = read('campistry_register.html');

// A fully-cleared camp: state known, processor notified.
const LIVE = { mode: 'surcharge', surchargePct: 3, state: 'NY', processorNotifiedOn: '2026-01-01' };
const q = (pol, o) => F.quote(pol, Object.assign({ amount: 100, method: 'card', channel: 'online' }, o || {}));

// ── the debit guard ────────────────────────────────────────────────────────

test('a credit card is surcharged', () => {
    const r = q(LIVE, { funding: 'credit' });
    assert.strictEqual(r.fee, 3);
    assert.strictEqual(r.reason, 'surcharge');
});

test('a debit card is never surcharged', () => {
    ['debit', 'prepaid'].forEach(f => {
        const r = q(LIVE, { funding: f });
        assert.strictEqual(r.fee, 0, f);
        assert.strictEqual(r.reason, 'not_credit');
    });
});

test('an UNKNOWN funding type is not surcharged either', () => {
    // The whole point. Guessing 'credit' would surcharge debit cards, which is a
    // card-brand violation; guessing wrong the other way costs a rounding error.
    ['', 'unknown', undefined, null].forEach(f => {
        const r = q(LIVE, { funding: f });
        assert.strictEqual(r.fee, 0, String(f));
        assert.strictEqual(r.reason, 'funding_unknown');
    });
});

test('only "credit" is surchargeable, and it is the sole entry in the list', () => {
    assert.deepStrictEqual(Object.keys(F.SURCHARGEABLE_FUNDING), ['credit']);
});

test('the reason says WHICH problem, so a camp collecting nothing learns why', () => {
    assert.strictEqual(q(LIVE, { funding: 'debit' }).label,
        'Debit and prepaid cards are never surcharged');
    assert.strictEqual(q(LIVE, { funding: '' }).label,
        'Card type unknown — no surcharge applied');
});

// ── the caps ──────────────────────────────────────────────────────────────

test('the surcharge is capped at 3% however large the setting', () => {
    assert.strictEqual(F.MAX_SURCHARGE_PCT, 3);
    assert.strictEqual(F.effectivePct({ mode: 'surcharge', surchargePct: 10 }), 3);
    assert.strictEqual(q(Object.assign({}, LIVE, { surchargePct: 10 }), { funding: 'credit' }).fee, 3);
});

test('and at the camp’s own cost of acceptance when that is lower', () => {
    // The brands allow the LESSER of the two, so a camp paying 2.6% may not
    // charge 3%.
    const pol = Object.assign({}, LIVE, { surchargePct: 3, costOfAcceptancePct: 2.6 });
    assert.strictEqual(F.effectivePct(pol), 2.6);
    assert.strictEqual(q(pol, { funding: 'credit' }).fee, 2.6);
});

test('a cost of acceptance of zero means "not stated", not "charge nothing"', () => {
    assert.strictEqual(F.effectivePct({ mode: 'surcharge', surchargePct: 3, costOfAcceptancePct: 0 }), 3);
});

test('the clamp is in normalize, so a policy edited in the cloud cannot exceed it', () => {
    assert.strictEqual(F.normalize({ mode: 'surcharge', surchargePct: 99 }).surchargePct, 3);
    assert.strictEqual(F.normalize({ mode: 'surcharge', surchargePct: -5 }).surchargePct, 0);
});

test('and again server-side, in the save RPC', () => {
    assert.match(SQL, /least\(3, greatest\(0, COALESCE\(NULLIF\(p_policy->>'surchargePct',''\)::numeric, 0\)\)\)/);
});

// ── where it is not allowed at all ────────────────────────────────────────

test('a surcharge is refused in every state that bans it', () => {
    ['CT', 'MA', 'ME', 'PR'].forEach(st => {
        const r = q(Object.assign({}, LIVE, { state: st }), { funding: 'credit' });
        assert.strictEqual(r.fee, 0, st);
        assert.strictEqual(r.reason, 'banned_in_state', st);
        assert.strictEqual(r.permitted, false, st);
    });
});

test('Louisiana’s ban starts on its own date, not before and not after', () => {
    const la = Object.assign({}, LIVE, { state: 'LA' });
    assert.strictEqual(q(la, { funding: 'credit', onDate: '2026-07-31' }).fee, 3);
    assert.strictEqual(q(la, { funding: 'credit', onDate: '2026-08-01' }).reason, 'banned_in_state');
});

test('not knowing the state is not permission', () => {
    const r = q(Object.assign({}, LIVE, { state: '' }), { funding: 'credit' });
    assert.strictEqual(r.fee, 0);
    assert.strictEqual(r.reason, 'state_unknown');
    assert.strictEqual(r.permitted, false);
});

test('no surcharge until the processor has been told', () => {
    // Visa requires 30 days' written notice. A camp that has not given it is not
    // allowed to surcharge, whatever this app's settings say.
    const r = q(Object.assign({}, LIVE, { processorNotifiedOn: '' }), { funding: 'credit' });
    assert.strictEqual(r.fee, 0);
    assert.strictEqual(r.reason, 'processor_not_notified');
});

test('a surcharge never touches a payment that is not a card', () => {
    ['ach', 'cash', 'check', 'other'].forEach(m =>
        assert.strictEqual(q(LIVE, { funding: 'credit', method: m }).reason, 'not_a_card', m));
});

// ── the convenience fee is a different animal ─────────────────────────────

const CONV = { mode: 'convenience', convenienceFlat: 3.5 };

test('a convenience fee is flat and indifferent to card type', () => {
    ['credit', 'debit', 'prepaid', '', 'unknown'].forEach(f =>
        assert.strictEqual(q(CONV, { funding: f }).fee, 3.5, f));
    assert.strictEqual(q(CONV, { method: 'ach' }).fee, 3.5);
});

test('it needs no state, no notice and no funding type', () => {
    const r = q(CONV, { funding: '' });
    assert.strictEqual(r.permitted, true);
    assert.strictEqual(r.reason, 'convenience');
});

test('there is nowhere to put a percentage, because that would be a surcharge', () => {
    const p = F.normalize({ mode: 'convenience', convenienceFlat: 3, conveniencePct: 2.9 });
    assert.strictEqual(p.conveniencePct, undefined);
    assert.strictEqual(p.convenienceFlat, 3);
    // And the save RPC coerces the flat amount rather than accepting a rate.
    assert.match(SQL, /'convenienceFlat',\s*\n?\s*greatest\(0, COALESCE\(NULLIF\(p_policy->>'convenienceFlat',''\)::numeric, 0\)\)/);
});

test('cash and cheques are not charged an electronic-payment fee', () => {
    ['cash', 'check'].forEach(m =>
        assert.strictEqual(q(CONV, { method: m }).reason, 'not_an_electronic_payment', m));
});

test('an online-only fee does not apply at the office door', () => {
    assert.strictEqual(q(CONV, { channel: 'office' }).reason, 'not_online');
    assert.strictEqual(q(Object.assign({}, CONV, { onlineOnly: false }), { channel: 'office' }).fee, 3.5);
});

test('the fee never exceeds the payment it is on', () => {
    assert.strictEqual(q(Object.assign({}, CONV, { convenienceFlat: 50 }), { amount: 20 }).fee, 20);
});

// ── cash discount ─────────────────────────────────────────────────────────

const CASH = { mode: 'cash_discount', cashDiscountPct: 3 };

test('a cash discount charges nobody and discounts the non-card payer', () => {
    assert.strictEqual(q(CASH, { funding: 'credit' }).fee, 0);
    assert.strictEqual(q(CASH, { funding: 'credit' }).reason, 'card_pays_posted_price');
    const r = q(CASH, { method: 'check' });
    assert.strictEqual(r.discount, 3);
    assert.strictEqual(r.fee, 0);
});

test('the discount cannot exceed the payment', () => {
    assert.strictEqual(q({ mode: 'cash_discount', cashDiscountFlat: 500 }, { method: 'check', amount: 100 }).discount, 100);
});

// ── off, and the defaults ─────────────────────────────────────────────────

test('an unset policy charges nothing', () => {
    assert.strictEqual(F.normalize(undefined).mode, 'off');
    assert.strictEqual(F.normalize({ mode: 'nonsense' }).mode, 'off');
    assert.strictEqual(q(undefined, { funding: 'credit' }).fee, 0);
    assert.strictEqual(q({}, { funding: 'credit' }).fee, 0);
});

test('nothing is charged on a zero payment', () => {
    assert.strictEqual(q(LIVE, { funding: 'credit', amount: 0 }).reason, 'nothing_to_charge');
});

// ── refunds ───────────────────────────────────────────────────────────────

test('a surcharge is returned in proportion, which the brands require', () => {
    const r = F.refundShare(LIVE, { feeCharged: 3, paymentAmount: 100, refundAmount: 50 });
    assert.strictEqual(r.fee, 1.5);
    assert.strictEqual(r.reason, 'proportional');
});

test('a whole reversal returns the whole surcharge', () => {
    assert.strictEqual(F.refundShare(LIVE, { feeCharged: 3, paymentAmount: 100, refundAmount: 100 }).fee, 3);
});

test('a convenience fee is not prorated, but a whole reversal returns it', () => {
    // It paid for a service already rendered — unless the payment itself should
    // never have happened.
    assert.strictEqual(F.refundShare(CONV, { feeCharged: 3.5, paymentAmount: 100, refundAmount: 40 }).fee, 0);
    assert.strictEqual(F.refundShare(CONV, { feeCharged: 3.5, paymentAmount: 100, refundAmount: 100 }).fee, 3.5);
});

test('nothing is returned when nothing was charged', () => {
    assert.strictEqual(F.refundShare(LIVE, { feeCharged: 0, paymentAmount: 100, refundAmount: 100 }).fee, 0);
});

// ── disclosure, which is a rule and not a courtesy ────────────────────────

test('every live mode produces a sentence a parent can read', () => {
    assert.match(F.disclosure(LIVE), /3% fee.*Debit cards.*not charged it/s);
    assert.match(F.disclosure(CONV), /\$3\.50 fee per payment/);
    assert.match(F.disclosure(CASH), /cheque or bank transfer takes 3% off/);
    assert.strictEqual(F.disclosure({ mode: 'off' }), '');
});

test('a mode with nothing set discloses nothing', () => {
    // Announcing a fee that will not be charged is its own kind of wrong.
    assert.strictEqual(F.disclosure({ mode: 'surcharge', surchargePct: 0 }), '');
    assert.strictEqual(F.disclosure({ mode: 'convenience', convenienceFlat: 0 }), '');
});

test('explain names every blocker an owner has to clear', () => {
    const x = F.explain({ mode: 'surcharge', surchargePct: 3 });
    const all = x.blockers.join(' ');
    assert.match(all, /state/i);
    assert.match(all, /processor/i);
    const clean = F.explain(LIVE);
    assert.deepStrictEqual(clean.blockers, []);
    assert.match(clean.notes.join(' '), /Debit, prepaid, FSA, HSA and Medicare Flex/);
    assert.match(clean.notes.join(' '), /Refunds return the surcharge in proportion/);
});

test('explain warns that a processor which hides funding collects nothing', () => {
    assert.match(F.explain(LIVE).notes.join(' '),
        /card whose type we cannot read is not surcharged/);
});

test('the convenience notes say a percentage is not permitted', () => {
    assert.match(F.explain(CONV).notes.join(' '), /must be a FLAT amount/);
});

// ── the funding type is actually captured now ─────────────────────────────

test('stripe-webhook records the funding type at both card-saving sites', () => {
    const src = read('supabase/functions/stripe-webhook/index.ts');
    assert.match(src, /funding = pm\.card\.funding \|\| null;/, 'card capture');
    assert.match(src, /pmFunding = pm\.card\.funding \|\| null;/, 'saved method');
    assert.match(src, /p_funding: funding/, 'not passed to the capture RPC');
    assert.match(src, /\.\.\.\(pmFunding \? \{ funding: pmFunding \} : \{\}\)/,
        'absent must mean absent, not an empty string that reads as a value');
});

test('the capture table and RPC carry it, and never widen a known value', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS funding text;/);
    assert.match(SQL, /funding\s+= COALESCE\(NULLIF\(btrim\(COALESCE\(p_funding, ''\)\), ''\), funding\)/,
        'a retry without a funding type must not erase one we have');
});

test("189's own guards survive the RPC rewrite", () => {
    assert.match(SQL, /IF p_status NOT IN \('completed', 'failed'\) THEN/);
    assert.match(SQL, /WHERE reference = p_reference FOR UPDATE;/);
    assert.match(SQL, /IF v_current = 'completed' THEN/);
});

// ── the policy is stored, gated and disclosed ────────────────────────────

test('only the camp owner may read or write the policy', () => {
    ['get_card_fee_policy', 'set_card_fee_policy'].forEach(fn => {
        const at = SQL.indexOf('FUNCTION public.' + fn);
        assert.ok(at > 0, fn);
        const body = SQL.slice(at, at + 2200);
        assert.match(body, /c\.owner = caller/, fn + ' does not check ownership');
        assert.match(body, /'not_owner'/, fn);
    });
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.set_card_fee_policy\(uuid, jsonb\) FROM public, anon;/);
});

test('the save is a one-path jsonb_set, not a read-modify-write', () => {
    // campistryMe has one writer; a read-modify-write from here loses whatever
    // the browser saved in between.
    const at = SQL.indexOf('FUNCTION public.set_card_fee_policy');
    const body = SQL.slice(at, SQL.indexOf('REVOKE ALL ON FUNCTION public.get_card_fee_policy'));
    assert.match(body, /jsonb_set\(\s*\n?\s*camp_state_kv\.value,\s*\n?\s*ARRAY\['enrollSettings', 'cardFeePolicy'\]/);
});

test('a bad mode is refused rather than stored', () => {
    assert.match(SQL, /IF v_mode NOT IN \('off', 'surcharge', 'convenience', 'cash_discount'\) THEN/);
});

test('the camp address is a hint, not a parsed state code', () => {
    // Guessing a two-letter code out of one free-text line would be wrong often
    // enough to matter, and this code decides whether a fee is lawful.
    assert.match(SQL, /'camp_address'/);
    // 'camp_state' as a RETURNED KEY, not the camp_state_kv table it shares a
    // prefix with.
    assert.ok(!/'camp_state'/.test(SQL));
});

test('the public form is told the rule, and 164’s other fields all survive', () => {
    const at = SQL.indexOf('FUNCTION public.get_public_form_config');
    const body = SQL.slice(at);
    assert.match(body, /'cardFeePolicy', coalesce\(kv_value #> '\{enrollSettings,cardFeePolicy\}'/);
    ['formConfig', 'sessions', 'sessionBundles', 'promoCodes', 'schoolGrades',
     'allowParentPaymentPlans', 'depositPolicy', 'staffFormConfig'].forEach(f =>
        assert.ok(body.includes("'" + f + "'"), 'get_public_form_config lost ' + f));
});

// ── the office screen and the parent form ────────────────────────────────

test('the settings card offers all four modes and reads them back', () => {
    assert.match(ME, /function _cfCardHtml\(pol\)/);
    ['off', 'surcharge', 'convenience', 'cash_discount'].forEach(m =>
        assert.ok(ME.includes("['" + m + "',"), 'no ' + m + ' option'));
    assert.match(ME, /function _cfRead\(\)/);
    assert.match(ME, /_cfToggle:_cfToggle/, 'the radios cannot call their own handler');
});

test('the card is on the page, beside the cancellation policy', () => {
    assert.match(ME, /_cpCardSafe\(\)\s*\n\s*\+ _cfCardSafe\(\);/);
});

test('the badge distinguishes "on" from "configured but not live"', () => {
    // A camp that thinks surcharging is switched on and is collecting nothing
    // needs to be told which.
    const fn = ME.slice(ME.indexOf('function _cfCardSafe()'));
    assert.match(fn.slice(0, 900), /not yet live/);
});

test('the save goes through the clamping RPC, not only into the blob', () => {
    assert.match(ME, /rpc\('set_card_fee_policy',\{p_camp_id:_cfCampId,p_policy:_cfPol\}\)/);
    assert.match(ME, /enrollSettings\.cardFeePolicy=_cfAPI\(\)\.normalize\(d\.policy\)/,
        'the screen must show the number the server clamped to');
});

test('the register form discloses the fee BEFORE the method is chosen', () => {
    assert.match(REG, /id="cardFeeNote"/);
    const optsAt = REG.indexOf('<div id="payOpts">');
    const noteAt = REG.indexOf('id="cardFeeNote"');
    assert.ok(noteAt > 0 && noteAt < optsAt,
        'disclosure after the choice is not disclosure');
    assert.match(REG, /_cardFeePolicy=d\.cardFeePolicy\|\|null;/);
    assert.match(REG, /campistry_card_fees\.js/);
});

test('the form says nothing when the policy would charge nothing', () => {
    const fn = REG.slice(REG.indexOf('function _regRenderCardFee()'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    assert.match(body, /if\(!line\|\|\(x\.blockers&&x\.blockers\.length\)\)/,
        'announcing a fee that will not be charged is its own kind of wrong');
    assert.match(body, /if\(!F\|\|!_cardFeePolicy\)/, 'a null policy must disclose nothing');
});

// ── a card fee is not a childcare expense ────────────────────────────────

test('the year-end tax statement excludes card fees from care', () => {
    // A cost of PAYING is not a cost of care, so it is not a Form 2441 expense.
    const T = require(path.join(ROOT, 'campistry_tax_statement.js'));
    ['Credit-card surcharge', '3% credit-card surcharge', 'Online payment fee',
     'Card processing fee', 'Convenience fee', 'Service fee'].forEach(d =>
        assert.strictEqual(T.classifyCharge({ category: 'Fee', desc: d }).verdict, 'no', d));
    // And the things that ARE care still are.
    ['Tuition', 'Camp fee', 'Extended Day', 'Bus — round trip'].forEach(d =>
        assert.strictEqual(T.classifyCharge({ category: 'Tuition', desc: d }).verdict, 'yes', d));
});

test('the migration parses as SQL', () => {
    const { execFileSync } = require('node:child_process');
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import pglast,sys;pglast.parse_sql(open(sys.argv[1]).read());print("ok")',
            path.join(ROOT, 'migrations/192_card_fee_policy.sql')], { encoding: 'utf8' });
    } catch (e) {
        if (/ModuleNotFoundError/.test(String(e.stderr || ''))) return;
        throw e;
    }
    assert.match(out, /ok/);
});

// ───────────────────────────────────────────────────────────────────────────
// AND IT CAN NOW REACH A BILL.
//
// The policy, the 3% brand cap, the credit-only rule and the state bans have existed
// since this module and migration 192 — but nothing applied one. A camp could
// configure surcharging in full and collect nothing.
// ───────────────────────────────────────────────────────────────────────────

const _fs = require('node:fs');
const ME_SUR = _fs.readFileSync(
    require('node:path').join(__dirname, '..', 'campistry_me.js'), 'utf8');

test('the fee is computed by the RULE, never recalculated at the call site', () => {
    // The cap and the state bans live in quote(). A second arithmetic path would be a
    // second place for the 3% ceiling to be got wrong.
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    const body = fn.slice(0, 4200);
    // with the family's OWN card type — never assumed credit (TED-140)
    assert.match(body, /F\.quote\(pol,\{amount:base,method:'card',funding:_familyCardFunding\(f\)/);
    assert.doesNotMatch(body, /funding:'credit'/);
    assert.ok(!/\*\s*0?\.?03|\/\s*100\s*\*\s*base|base\s*\*\s*pct/.test(body),
        'no percentage arithmetic may happen here');
});

test('three things refuse the charge outright', () => {
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    const body = fn.slice(0, 4200);
    // Off: configure it first rather than guessing a mode.
    assert.match(body, /if\(pol\.mode==='off'\)\{/);
    assert.match(body, /Card fees are switched off/);
    // Anything the rule reports as blocking — a state ban, a missing requirement.
    assert.match(body, /if\(x&&x\.blockers&&x\.blockers\.length\)\{/);
    // And a quote that says not permitted, whatever the reason.
    assert.match(body, /if\(!q\|\|!q\.permitted\)\{/);
});

test('the disclosure IS the charge description', () => {
    // The brands require the family to be told. A surcharge line reading only
    // "Card fee" is the version that gets a camp in trouble.
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    assert.match(fn.slice(0, 4200), /description:F\.disclosure\(pol,\{fmt:fm\}\)\|\|'Card fee'/);
});

test('a zero fee is not posted as a charge', () => {
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    assert.match(fn.slice(0, 4200), /if\(!\(q\.fee>0\)\)\{toast\('That works out to no fee'/);
});

test('the charge records what it was a fee ON, and increases the balance', () => {
    // Without the base, a 3% line on a statement cannot be checked by anyone. And the
    // sign: a fee the family owes must raise the balance, not lower it.
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    const body = fn.slice(0, 4200);
    assert.match(body, /cardFee:\{mode:q\.mode,base:Math\.round\(base\*100\)\/100,reason:q\.reason,funding:_familyCardFunding\(f\)\}/);
    assert.match(body, /f\.balance=\(f\.balance\|\|0\)\+Math\.round\(q\.fee\*100\)\/100;/);
    assert.ok(!/f\.balance=\(f\.balance\|\|0\)-Math\.round\(q\.fee/.test(body),
        'a fee the family owes must not reduce what they owe');
});

test('surcharging is gated and reachable', () => {
    const fn = ME_SUR.slice(ME_SUR.indexOf('function addCardSurcharge(famKey)'));
    assert.match(fn.slice(0, 400), /_secEdit\('billing'/);
    assert.match(ME_SUR, /addCardSurcharge:addCardSurcharge,_surchargePreview:_surchargePreview,/);
    assert.match(ME_SUR, /CampistryMe\.addCardSurcharge\(/);
});

test('the office sees the fee before agreeing to it', () => {
    assert.match(ME_SUR, /function _surchargePreview\(\)/);
    const fn = ME_SUR.slice(ME_SUR.indexOf('function _surchargePreview()'));
    const body = fn.slice(0, 1600);
    assert.match(body, /F\.quote\(pol,/, 'the preview must use the same rule as the save');
    assert.match(body, /total with fee/);
    // A refused quote shows why rather than an empty box.
    assert.match(body, /!q\.permitted\|\|!\(q\.fee>0\)/);
});
