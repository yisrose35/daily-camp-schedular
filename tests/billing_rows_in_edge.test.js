// =============================================================================
// Money decisions in the edge functions are made from the family and payment
// ROWS, never from the campistryMe document's copies.
//
// WHY THIS EXISTS. Since 212/214 every server-side writer — the autopay's own
// record_autopay_installment, a parent saving a card or choosing a plan, the
// webhooks recording payments — writes camp_families / camp_payments. The
// document's families and payments are copies the Me page writes when somebody
// saves it, so they lag every one of those writes. Edge functions that decided
// money from the document:
//
//   charge-due-installments   an installment marked PAID in the row was still
//                             PENDING in the document the next night, so the
//                             card was charged again (and the write refused, so
//                             the second charge went unrecorded). It also read
//                             payments from me.finance.payments, gone since 158,
//                             so a family who paid early was charged anyway.
//   charge-saved-card         "no saved card" for a card the parent just saved
//   stripe-charge             refused a Stripe customer the webhook just saved
//   campOwnsFamily (×6)       "family not found" for a family not yet re-saved
//   cardknox-webhook          re-vaulted a token the row already had
//   deposit-inbox             could not match money to a family added since
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
                         .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
const read = (name) => code(fs.readFileSync(path.join(FN, name, 'index.ts'), 'utf8'));
function bodyOf(src, name) {
    const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) return null;
    let depth = 0;
    for (let j = src.indexOf('{', m.index); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
    }
    return src.slice(m.index);
}

test('autopay reads families and payments from the rows, and skips a camp it cannot read', () => {
    const src = read('charge-due-installments');
    assert.match(src, /rpc\(\s*"camp_families_object"/,
        'charge-due-installments decides who to charge from the document\'s families — an '
        + 'installment it marked paid last night is still pending there, and gets charged again');
    assert.match(src, /rpc\(\s*"camp_payments_array"/,
        'charge-due-installments does not read the payment rows — what a family has paid counts as nothing');
    assert.match(src, /me\.families\s*=\s*famRes\.data/, 'the row families are not what the loop uses');
    assert.match(src, /payments:\s*Array\.isArray\(payRes\.data\)/,
        'the row payments are not what computeFamilyBalance reads');
    // Unreadable rows must never fall back to charging from the stale copy.
    assert.match(src, /famRes\.error \|\| payRes\.error[\s\S]{0,400}continue;/,
        'a camp whose rows cannot be read is charged from the document instead of skipped');
});

test('charging a saved card reads the family row', () => {
    const src = read('charge-saved-card');
    assert.match(src, /rpc\(\s*"camp_family"/, 'charge-saved-card reads the family from the document');
    assert.doesNotMatch(src, /me\.families/, 'charge-saved-card still looks in me.families');
});

test('every family-existence check asks the rows', () => {
    const dirs = fs.readdirSync(FN).filter(d => fs.existsSync(path.join(FN, d, 'index.ts')));
    const withCheck = dirs.filter(d => /function\s+campOwnsFamily\s*\(/.test(read(d)));
    assert.ok(withCheck.length >= 6, 'expected campOwnsFamily in at least six functions, found ' + withCheck.length);
    for (const d of withCheck) {
        const body = bodyOf(read(d), 'campOwnsFamily');
        assert.match(body, /rpc\(\s*"camp_family"/, d + '\'s campOwnsFamily reads the document');
        assert.doesNotMatch(body, /camp_state_kv/, d + '\'s campOwnsFamily still reads camp_state_kv');
    }
    const nonce = bodyOf(read('payments-charge-nonce'), 'getFamily');
    assert.match(nonce, /rpc\(\s*"camp_family"/, 'payments-charge-nonce\'s getFamily reads the document');
});

test('the Stripe customer check and the Sola token check read the rows', () => {
    assert.match(read('stripe-charge'), /rpc\(\s*"camp_families_object"/,
        'stripe-charge checks customer ownership against the document\'s families');
    const hook = read('cardknox-webhook');
    assert.match(hook, /rpc\(\s*"camp_family"/,
        'cardknox-webhook decides whether a token is already vaulted from the document');
});

test('no edge function decides money from me.families or me.finance.payments', () => {
    // What may still read the document: display names for a receipt (cosmetic,
    // said so where they are), SMS contacts, and autopay's enrollments/sessions —
    // which the office alone writes. Anything that reads the family or payment
    // BRANCHES without overlaying the rows is a new instance of this defect.
    const dirs = fs.readdirSync(FN).filter(d => fs.existsSync(path.join(FN, d, 'index.ts')));
    const offenders = [];
    for (const d of dirs) {
        const src = read(d);
        if (!/"campistryMe"/.test(src)) continue;
        const readsBranch = /\.finance\??\.payments|me\.families\s*\?\.\s*\[|me\.families\s*\[|me\.families\)/.test(src);
        const overlays = /rpc\(\s*"camp_families_object"/.test(src) && /rpc\(\s*"camp_payments_array"/.test(src);
        if (readsBranch && !overlays) offenders.push(d);
    }
    assert.deepStrictEqual(offenders, [],
        'these read the document\'s family/payment branches for a decision:\n  ' + offenders.join('\n  '));
});
