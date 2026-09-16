// node --test tests/payment_receipts.test.js
//
// A parent pays this camp and hears nothing back. `receipt_email` appeared
// nowhere in the codebase, Stripe's own receipts are not switched on, and
// because these are destination charges anything Stripe did send would be
// branded as the platform rather than the camp.
//
// That is the other half of the descriptor problem. A parent with no receipt
// who does not recognise a charge has two options: telephone the camp, or
// dispute it — and the camp gets both. Every product in this category sends
// receipts for exactly this reason; the industry pitch for it is literally
// "fewer 'did you get my form?' calls to your office".
//
// What is asserted here: the receipt goes out from every charge path, it goes
// out AT MOST once per payment, and it can never fail or retry a charge.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

const FN = read('supabase/functions/send-payment-receipt/index.ts');
const SQL = read('migrations/188_payment_receipts.sql');
const SQL_CODE = stripComments(SQL);

// ── the sender exists and is reachable ─────────────────────────────────────

test('the receipt function exists and is self-contained', () => {
    assert.ok(FN.length > 1000);
    assert.ok(!/from\s+["']\.\.\/_shared/.test(FN),
        'a relative _shared import cannot be pasted into the Dashboard as one file');
});

test('it is dispatched from every charge path', () => {
    const paths = {
        // One call here covers every Stripe charge in the product — pay link,
        // registration deposit, canteen top-up, autopay, office charge.
        'supabase/functions/stripe-webhook/index.ts': 1,
        // Sola's hosted checkout: its own confirmation page, then the parent leaves.
        'supabase/functions/cardknox-webhook/index.ts': 2,
        // The BYOP paths, which have no webhook of their own.
        'supabase/functions/charge-due-installments/index.ts': 1,
        'supabase/functions/charge-saved-card/index.ts': 1,
        'supabase/functions/canteen-auto-reload/index.ts': 1,
    };
    Object.entries(paths).forEach(([file, atLeast]) => {
        const src = stripComments(read(file));
        const calls = (src.match(/await sendReceipt\(/g) || []).length;
        assert.ok(calls >= atLeast, file + ' dispatches ' + calls + ' receipts, wanted >= ' + atLeast);
        assert.match(src, /async function sendReceipt\(/, file + ' has no dispatcher');
    });
});

test('every dispatcher passes a reference, or the send cannot be deduplicated', () => {
    ['stripe-webhook', 'cardknox-webhook', 'charge-due-installments',
     'charge-saved-card', 'canteen-auto-reload'].forEach(fn => {
        const src = stripComments(read('supabase/functions/' + fn + '/index.ts'));
        // Each sendReceipt({...}) literal must name ref and amount.
        const calls = src.split('await sendReceipt(').slice(1);
        assert.ok(calls.length > 0, fn);
        calls.forEach((c, i) => {
            const body = c.slice(0, c.indexOf('});') + 1);
            // Shorthand (`amount,`) counts — it is the same property.
            assert.match(body, /\bref:/, fn + ' call ' + i + ' passes no ref');
            assert.match(body, /\bamount[:,]/, fn + ' call ' + i + ' passes no amount');
            assert.match(body, /campId/, fn + ' call ' + i + ' passes no campId');
        });
    });
});

// ── at most once per payment ───────────────────────────────────────────────

test('the claim is an INSERT that one caller wins, not a read-then-write', () => {
    assert.match(SQL_CODE, /INSERT INTO payment_receipts[\s\S]{0,400}ON CONFLICT \(camp_id, ref\) DO NOTHING/,
        'two concurrent webhook deliveries both pass a SELECT and both then send');
    assert.match(SQL_CODE, /PRIMARY KEY \(camp_id, ref\)/);
});

test('a payment with no reference gets no receipt at all', () => {
    // Without a stable reference there is no way to tell a redelivery from a
    // second payment. A missing receipt is a phone call; a duplicate receipt is
    // a parent concluding they were billed twice, which is the dispute this
    // whole thing exists to prevent.
    assert.match(SQL_CODE, /IF p_camp_id IS NULL OR v_ref IS NULL THEN\s*\n\s*RETURN false;/);
    assert.match(FN, /if \(!ref\) return json\(\{ error: "ref_required" \}, 400\);/);
});

test('the send happens only after the claim is won', () => {
    const claimAt = FN.indexOf('claim_payment_receipt');
    const sendAt = FN.indexOf('https://api.resend.com/emails');
    assert.ok(claimAt > 0 && sendAt > 0);
    assert.ok(claimAt < sendAt, 'claiming after sending permits two emails for one payment');
    assert.match(FN, /if \(won !== true\) return json\(\{ sent: false, reason: "already_sent" \}, 200\);/);
});

test('a failed send gives the claim back', () => {
    // Otherwise one bad minute at the mail provider silences that payment's
    // receipt permanently — the claim is meant to stop duplicates, not to eat
    // a receipt because of an outage.
    assert.match(SQL_CODE, /CREATE OR REPLACE FUNCTION public\.release_payment_receipt/);
    const fail = FN.slice(FN.indexOf('if (!resp.ok)'));
    assert.match(fail.slice(0, 500), /release_payment_receipt/);
});

// ── a receipt can never fail a charge ──────────────────────────────────────

test('once the receipt is in play, every answer is a 200', () => {
    // The money is already taken before this function is called, so nothing
    // from the recipient lookup onwards may look like a failure a caller might
    // react to. The pre-flight rejections above it (405/401/403/400) are the
    // request being wrong, not the payment.
    const at = FN.indexOf('const { data: rcp }');
    assert.ok(at > 0);
    const after = [...FN.slice(at).matchAll(/return json\([^;]*?,\s*(\d{3})\)/gs)].map(m => Number(m[1]));
    assert.ok(after.length >= 4, 'expected several returns after the lookup, saw ' + after.length);
    after.forEach(s => assert.strictEqual(s, 200,
        'a status ' + s + ' after the money is taken invites a charge retry'));
});

test('an unexpected throw is still a 200', () => {
    const c = FN.slice(FN.indexOf('} catch (err) {'));
    assert.match(c, /reason: "error"[\s\S]{0,80}\}, 200\)/);
});

test('the dispatchers never let a receipt throw into a charge path', () => {
    ['stripe-webhook', 'cardknox-webhook', 'charge-due-installments',
     'charge-saved-card', 'canteen-auto-reload'].forEach(fn => {
        const src = read('supabase/functions/' + fn + '/index.ts');
        const d = src.slice(src.indexOf('async function sendReceipt('));
        const body = d.slice(0, d.indexOf('\n}\n'));
        assert.match(body, /try \{/, fn + ': the dispatcher must swallow its own failures');
        assert.match(body, /catch \(e\)/, fn);
        assert.ok(!/throw/.test(body), fn + ': the dispatcher must never rethrow');
    });
});

test('no email on file is reported, not treated as a failure', () => {
    assert.match(FN, /no_email_on_file/);
    assert.match(FN, /console\.warn\(`\[receipt\][^`]*no email on file/,
        'the log has to name the payments nobody was told about');
});

// ── who it goes to, and who can ask ────────────────────────────────────────

test('the recipient lookup lives in one place, not in five callers', () => {
    assert.match(SQL_CODE, /CREATE OR REPLACE FUNCTION public\.receipt_recipient/);
    assert.match(FN, /rpc\("receipt_recipient"/);
    // Callers pass what they have; none of them resolves an email itself.
    ['charge-due-installments', 'canteen-auto-reload', 'cardknox-webhook'].forEach(fn => {
        const src = stripComments(read('supabase/functions/' + fn + '/index.ts'));
        const calls = src.split('await sendReceipt(').slice(1);
        calls.forEach(c => {
            const body = c.slice(0, c.indexOf('});') + 1);
            assert.ok(!/\bemail:/.test(body), fn + ' resolves an email itself instead of letting the RPC do it');
        });
    });
});

test('the lookup falls back from family to camper to application', () => {
    // A canteen reload knows a camper, not a family. A registration deposit
    // knows neither — there is no family record until the office accepts.
    assert.match(SQL_CODE, /p_family_key/);
    assert.match(SQL_CODE, /camperIds'\] \) @> to_jsonb\(v_camper\)|camperIds'\]\) @> to_jsonb\(v_camper\)/);
    assert.match(SQL_CODE, /'enrollments', v_enroll, 'parentEmail'/);
});

test('it prefers the billing-contact household', () => {
    assert.match(SQL_CODE, /billingContact'\)::boolean IS TRUE/);
});

test('neither RPC is callable from a browser', () => {
    // receipt_recipient takes a camp id and returns a parent's email address.
    // An authenticated grant would hand any signed-in user another camp's
    // address book — the mistake migration 183 had to undo elsewhere.
    ['claim_payment_receipt', 'release_payment_receipt', 'receipt_recipient'].forEach(f => {
        const re = new RegExp('REVOKE ALL ON FUNCTION public\\.' + f + '\\([^)]*\\) FROM public, anon, authenticated;');
        assert.match(SQL_CODE, re, f + ' is not revoked from the browser');
    });
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.(claim_payment_receipt|release_payment_receipt|receipt_recipient)/.test(SQL_CODE),
        'nothing may be granted back');
});

test('the receipts table is not readable by anyone but the service role', () => {
    assert.match(SQL_CODE, /ALTER TABLE public\.payment_receipts ENABLE ROW LEVEL SECURITY;/);
    assert.match(SQL_CODE, /REVOKE ALL ON TABLE public\.payment_receipts FROM anon, authenticated;/);
    assert.ok(!/CREATE POLICY[\s\S]{0,200}payment_receipts/.test(SQL_CODE),
        'RLS on with no policy is the point — a policy would open it');
});

test('a user token can only send for a camp they belong to', () => {
    const a = FN.slice(FN.indexOf('async function authorize'));
    const body = a.slice(0, a.indexOf('\nfunction receiptHtml'));
    assert.match(body, /if \(token === SUPABASE_SERVICE_KEY\)/);
    assert.match(body, /if \(!ids\.has\(String\(bodyCampId\)\)\) return \{ error: "not_authorized", status: 403 \}/,
        'anyone with a login could otherwise email themselves another camp’s payment details');
});

// ── what the email says ────────────────────────────────────────────────────

test('the receipt names the camp, not us', () => {
    assert.match(FN, /\$\{esc\(o\.campName \|\| "Your camp"\)\}/);
    assert.match(FN, /subject: `\$\{campName \|\| "Camp"\} — receipt for/);
    assert.match(FN, /will appear on your statement from/,
        'saying which name to look for on the statement is the whole point');
});

test('a reply reaches the camp office, not a no-reply address', () => {
    // The one person who can fix a wrong charge has to hear about it — that is
    // the difference between a phone call and a chargeback.
    assert.match(FN, /if \(replyTo\) payload\.reply_to = replyTo;/);
    assert.match(SQL_CODE, /'reply_to',\s*NULLIF\(btrim\(COALESCE\(v_camp\.contact_email/);
    assert.match(FN, /before disputing the charge with your bank/);
});

test('it never states a balance it was not told', () => {
    // A guessed balance reads as a demand.
    assert.match(FN, /if \(o\.balanceAfter != null\)/);
    assert.match(FN, /balanceAfter: body\.balanceAfter == null \? null :/);
});

test('an autopay receipt does carry the balance, because that path knows it', () => {
    const src = read('supabase/functions/charge-due-installments/index.ts');
    const call = src.slice(src.indexOf('await sendReceipt('));
    assert.match(call.slice(0, 400), /balanceAfter: rec\.data\?\.balance/);
});

test('every camp- or family-supplied string in the email is escaped', () => {
    // A camper named <script> must not become markup in a parent's inbox. Each
    // of these fields is data a camp or a parent typed, so every USE of one has
    // to be esc()-wrapped — the only exceptions being the truthiness guards
    // that decide whether to render a row at all.
    const html = FN.slice(FN.indexOf('function receiptHtml'), FN.indexOf('Deno.serve'));
    const FIELDS = ['campName', 'campAddress', 'toName', 'what', 'camperName',
                    'familyName', 'method', 'ref'];
    FIELDS.forEach(field => {
        const re = new RegExp('o\\.' + field + '\\b', 'g');
        const hits = [...html.matchAll(re)];
        assert.ok(hits.length > 0, 'o.' + field + ' is never used in the template');
        hits.forEach(m => {
            const before = html.slice(Math.max(0, m.index - 5), m.index);
            const after = html.slice(m.index + m[0].length, m.index + m[0].length + 4);
            const escaped = before.endsWith('esc(');
            // `if (o.x)` / `o.x ? … : …` / `o.x || "…"` only decide whether a
            // row is rendered; the value itself still goes through esc().
            const guard = /\?\s*$|^\s*\?|^\s*\|\||^\s*\)/.test(after) || /\(\s*$/.test(before);
            assert.ok(escaped || guard,
                'o.' + field + ' used unescaped near: ' + html.slice(Math.max(0, m.index - 40), m.index + 40));
        });
    });
    // The row() helper is handed ready-made HTML, so every call site must
    // already have escaped its value.
    const rows = [...html.matchAll(/\brow\(("[^"]+"),\s*([\s\S]*?)\)\);/g)].map(m => m[2]);
    assert.ok(rows.length >= 4, 'expected several row() calls, saw ' + rows.length);
    rows.forEach(r => assert.ok(/esc\(|^"[^"]*"$/.test(r), 'row() value not escaped: ' + r));
});

test('the migration parses as SQL', () => {
    // pglast is what every other migration in this repo is checked with; if it
    // is not installed here, the check is skipped rather than faked.
    const { execFileSync } = require('node:child_process');
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import pglast,sys;pglast.parse_sql(open(sys.argv[1]).read());print("ok")',
            path.join(ROOT, 'migrations/188_payment_receipts.sql')], { encoding: 'utf8' });
    } catch (e) {
        if (/ModuleNotFoundError/.test(String(e.stderr || ''))) return;
        throw e;
    }
    assert.match(out, /ok/);
});
