// node --test tests/deposit_policy.test.js
//
// A registration deposit is money a camp takes before it has a relationship
// with the family, so the two ways to get it wrong are both expensive: asking
// for more than is owed, and letting a place be held for nothing. Every camp
// words its rule differently, so the rule itself is data — and these pin the
// arithmetic every consumer shares.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_deposit_policy.js');

test('no policy means no deposit', () => {
    assert.strictEqual(P.amountFor({}, [{ tuition: 1000 }]).total, 0);
    assert.strictEqual(P.amountFor({ enabled: false, basis: 'flat', amount: 250 }, [{ tuition: 1000 }]).total, 0);
    assert.strictEqual(P.blocksSubmission({ enabled: false, timing: 'now' }, 250), false);
    assert.strictEqual(P.describe({ enabled: false }, { total: 0 }), '');
});

test('a flat deposit is per camper unless the camp says per family', () => {
    const flat = { enabled: true, basis: 'flat', amount: 250 };
    const three = [{ tuition: 1000 }, { tuition: 1000 }, { tuition: 1000 }];
    assert.strictEqual(P.amountFor(flat, three).total, 750);
    assert.strictEqual(P.amountFor({ ...flat, per: 'family' }, three).total, 250);
});

test('a percentage reads each camper’s own tuition', () => {
    const pct = { enabled: true, basis: 'percent', percent: 25 };
    const r = P.amountFor(pct, [{ tuition: 1250 }, { tuition: 400 }]);
    assert.deepStrictEqual(r.each, [312.5, 100]);
    assert.strictEqual(r.total, 412.5);
});

test('per family takes the largest camper, not the first', () => {
    // Otherwise the price depends on the order siblings were typed in, which
    // is a thing a parent could change on purpose and an office could never
    // explain.
    const pol = { enabled: true, basis: 'percent', percent: 25, per: 'family' };
    const season = { tuition: 1250 }, taster = { tuition: 400 };
    assert.strictEqual(P.amountFor(pol, [season, taster]).total, 312.5);
    assert.strictEqual(P.amountFor(pol, [taster, season]).total, 312.5);
});

test('a session’s own deposit wins, and falls back rather than to zero', () => {
    const pol = { enabled: true, basis: 'session', percent: 20 };
    assert.strictEqual(P.amountFor(pol, [{ session: { depositAmount: 300 }, tuition: 1000 }]).total, 300);
    // A session nobody set one on must not quietly ask for nothing — turning
    // the policy on would then do visibly nothing at all.
    assert.strictEqual(P.amountFor(pol, [{ session: {}, tuition: 1000 }]).total, 200);
});

test('a deposit never exceeds the tuition it is part of', () => {
    // A flat $250 on a $180 taster week would ask for more than is owed and
    // leave the camp holding a credit it has to refund.
    const pol = { enabled: true, basis: 'flat', amount: 250 };
    assert.strictEqual(P.amountFor(pol, [{ tuition: 180 }]).total, 180);
    // 100% is the ceiling; a typo of 250% must not bill two and a half
    // tuitions up front.
    const silly = { enabled: true, basis: 'percent', percent: 250 };
    assert.strictEqual(P.amountFor(silly, [{ tuition: 1000 }]).total, 1000);
});

test('pay-now blocks the form, pay-later does not', () => {
    const now = { enabled: true, basis: 'flat', amount: 250, timing: 'now' };
    const later = { ...now, timing: 'later', dueDays: 14 };
    assert.strictEqual(P.blocksSubmission(now, 250), true);
    assert.strictEqual(P.blocksSubmission(later, 250), false);
    // Nothing owed blocks nothing, whatever the timing says.
    assert.strictEqual(P.blocksSubmission(now, 0), false);
});

test('a pay-later deposit gets a real due date', () => {
    const later = { enabled: true, basis: 'flat', amount: 250, timing: 'later', dueDays: 14 };
    assert.strictEqual(P.dueDate(later, '2026-06-01'), '2026-06-15');
    // Pay-now has no future due date to give.
    assert.strictEqual(P.dueDate({ ...later, timing: 'now' }, '2026-06-01'), '');
});

test('what gets stamped on an application keeps required and paid apart', () => {
    // A camp that raises its deposit mid-season must not make last month's
    // applications look short, and one that turns the policy off must not
    // erase what an applicant already owed.
    const pol = { enabled: true, basis: 'flat', amount: 250, timing: 'later', dueDays: 10, refundable: true };
    const r = P.amountFor(pol, [{ tuition: 1000 }]);
    const stamp = P.stampFor(pol, r, '2026-06-01T09:00:00Z');
    assert.strictEqual(stamp.depositRequired, 250);
    assert.strictEqual(stamp.depositPaid, 0);
    assert.strictEqual(stamp.depositDue, '2026-06-11');
    assert.strictEqual(stamp.depositRefundable, true);

    // Outstanding is derived from the pair, so a part payment is visible.
    assert.strictEqual(P.outstanding({ depositRequired: 250, depositPaid: 0 }), 250);
    assert.strictEqual(P.outstanding({ depositRequired: 250, depositPaid: 100 }), 150);
    assert.strictEqual(P.outstanding({ depositRequired: 250, depositPaid: 250 }), 0);
    // Overpaid is not negative — it must never read as a credit here.
    assert.strictEqual(P.outstanding({ depositRequired: 250, depositPaid: 400 }), 0);
    assert.strictEqual(P.outstanding({}), 0);
});

test('the parent is told the amount, not the rule', () => {
    const pol = { enabled: true, basis: 'percent', percent: 25, per: 'family', timing: 'now' };
    const r = P.amountFor(pol, [{ tuition: 1250 }, { tuition: 400 }]);
    const said = P.describe(pol, r);
    assert.match(said, /\$312\.50/, 'the number they owe');
    assert.match(said, /for the family/);
    assert.match(said, /due now/);
    assert.match(said, /counts toward tuition/, 'a deposit is never an extra charge');
    assert.match(said, /not refundable/);
    // And the office gets the rule behind it.
    assert.match(P.explain(pol, r), /25% of tuition, once per family/);
});

test('a bad policy normalizes instead of throwing', () => {
    const n = P.normalize({ basis: 'nonsense', amount: -5, percent: 'x', per: 'zzz', timing: 'maybe', dueDays: -3 });
    assert.strictEqual(n.basis, 'flat');
    assert.strictEqual(n.amount, 0);
    assert.strictEqual(n.percent, 25);
    assert.strictEqual(n.per, 'camper');
    assert.strictEqual(n.timing, 'now');
    assert.strictEqual(n.dueDays, 14);
    assert.strictEqual(n.label, 'Registration deposit');
});

// ── the wiring ──────────────────────────────────────────────────────────────
//
// The policy can be exactly right and reach nobody: the public form is
// anonymous, so everything it knows arrives through one RPC, and a setting
// that saves but never crosses that line looks to a camp like a broken
// feature rather than a missing column.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('the public form is actually told the rule', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/164_public_deposit_policy.sql'), 'utf8');
    assert.match(sql, /'depositPolicy', coalesce\(kv_value #> '\{enrollSettings,depositPolicy\}'/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_form_config\(uuid, text\) TO anon/);
    assert.match(sql, /NOTIFY pgrst/);
    // Only the rule crosses to an anonymous page — never any family's standing
    // against it.
    assert.ok(!/families|finance|payments/i.test(sql.split('RETURN jsonb_build_object')[1] || ''),
        'the public payload must not carry family data');

    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /d\.depositPolicy/, 'the form never reads it out of the payload');
    assert.match(reg, /campistry_deposit_policy\.js\?v=/, 'the form never loads the module');
    assert.match(reg, /_regDepositStamp/, 'nothing is stamped on the application');
    // The amount is a share of the price, so it has to move when the price does.
    assert.match(reg, /_regRenderDeposit\(\)/);
});

test('the office can set it and see who has not paid', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /function openDepositPolicy/);
    assert.match(me, /openDepositPolicy:openDepositPolicy/, 'not exposed, so no button reaches it');
    assert.match(me, /markDepositPaid:markDepositPaid/);
    assert.match(me, /enrollSettings\.depositPolicy=pol/, 'the policy is never saved');
    // A deposit is a payment toward tuition. Recording it here AND in Billing
    // would halve the balance, so this must not invent a payment row.
    const fn = me.slice(me.indexOf('async function markDepositPaid'), me.indexOf('function openDepositPolicy'));
    assert.ok(!/finPayments\.push/.test(fn), 'marking a deposit paid must not create a payment');
});

// ── the form builder ────────────────────────────────────────────────────────
test('the field catalog covers what the form actually asks', () => {
    // A field on the form with no catalog entry cannot be renamed, hidden or
    // made required — it is simply outside the camp's control, which is what
    // "the advanced tab is missing a lot" means in practice.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    const mapBlock = reg.slice(reg.indexOf('var FIELD_ELEMENT_MAP={'),
                               reg.indexOf('var FIELD_DEFAULT_LABEL='));
    const formFields = [...mapBlock.matchAll(/(\w+)\s*:\s*'r\w+'/g)].map((m) => m[1]);
    const catalog = me.slice(me.indexOf('var FC_FIELD_CATALOG={'), me.indexOf('function getFormConfig'));

    const missing = formFields.filter((f) => !new RegExp("id:'" + f + "'").test(catalog));
    assert.deepStrictEqual(missing, [], 'these form fields are not configurable: ' + missing.join(', '));

    // And the other way: Other Parent's Address was a section toggle with no
    // fields behind it, so a camp could show it without choosing what it asked.
    assert.match(catalog, /otherParent:\s*\[/);
    ['opStreet', 'opCity', 'opState', 'opZip'].forEach((f) => {
        assert.match(catalog, new RegExp("id:'" + f + "'"), f + ' is not configurable');
    });
});

test('a field a camp has not asked for stays off', () => {
    // Both sides have to agree, or a field added to the catalog appears on
    // every camp's live form the day it ships.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    const catalog = me.slice(me.indexOf('var FC_FIELD_CATALOG={'), me.indexOf('function getFormConfig'));
    const offInCatalog = [...catalog.matchAll(/id:'(\w+)'[^}]*off:true/g)].map((m) => m[1]);

    assert.ok(offInCatalog.includes('bunkmate') && offInCatalog.includes('separate'),
        'bunk requests must default off — a request on a form is a promise a parent hears');

    const offOnForm = reg.slice(reg.indexOf('var FIELD_DEFAULT_OFF={'), reg.indexOf('function applyFieldConfig'));
    offInCatalog.forEach((f) => {
        assert.match(offOnForm, new RegExp(f + ':\\s*true'), f + ' is off in the catalog but shows on the form');
    });
    // And the renderer must read the flag at all.
    assert.match(me, /cfg\.enabled!=null\?cfg\.enabled!==false:!f\.off/);
});

test('required documents default off and are named, not hinted', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    assert.match(me, /\{key:'documents',label:'Required Documents'[^}]*default:false\}/,
        'the documents section must default off');
    // Each document needs a stable id, or renaming one orphans every file
    // already filed under it.
    assert.match(me, /var id=el\.dataset\.id\|\|\('doc_'/);
    assert.match(me, /required:!!el\.querySelector\('\.fcDocReq'\)/);
    // The form lists them by name and blocks on the required ones.
    assert.match(reg, /_regRenderRequiredDocs/);
    assert.match(reg, /_regMissingDocs/);
    assert.match(reg, /Still needed: /);
});

test('the post-acceptance form carries documents, payment and the deposit', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const pa = fs.readFileSync(path.join(ROOT, 'campistry_postaccept.html'), 'utf8');

    const paf = me.slice(me.indexOf('var PAF_SECTIONS='), me.indexOf('var PAF_FIELD_CATALOG='));
    assert.match(paf, /key:'documents'[^}]*default:false/, 'must default off — this form was choices-only');
    assert.match(paf, /key:'payment'[^}]*default:false/);

    assert.match(pa, /id="docCard"/);
    assert.match(pa, /id="payCard"/);
    assert.match(pa, /id="depositBox"/);
    assert.match(pa, /_paMissingDocs/, 'required documents must block here too');
    assert.match(pa, /campistry_deposit_policy\.js/, 'the deposit module is never loaded');
    // One document list, shared. Two would drift the moment one was edited.
    assert.match(me, /documents:\(\(getFormConfig\(\)\|\|\{\}\)\.documents\)\|\|\[\]/);
});

test('the deposit screen says when the public form cannot see it', () => {
    // The one failure a camp will actually hit, and the one they cannot
    // diagnose: the policy saves, and parents are never shown it.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /async function _dpCheckReach/);
    assert.match(me, /rpc\('get_public_form_config'/);
    assert.match(me, /hasOwnProperty\.call\(d,'depositPolicy'\)/);
    assert.match(me, /164_public_deposit_policy\.sql/, 'it must name the migration to apply');
});
