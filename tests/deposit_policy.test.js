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
    // The public form is anonymous, so everything it knows arrives through
    // this one RPC. Without the policy here the form cannot state an amount,
    // and the setting would save and then appear to do nothing.
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/164_public_deposit_policy.sql'), 'utf8');
    assert.match(sql, /'depositPolicy', coalesce\(kv_value #> '\{enrollSettings,depositPolicy\}'/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_form_config\(uuid, text\) TO anon/);
    assert.match(sql, /NOTIFY pgrst/);
    // Only the rule crosses to an anonymous page — never any family's
    // standing against it.
    assert.ok(!/families|finance|payments/i.test(sql.split('RETURN jsonb_build_object')[1] || ''),
        'the public payload must not carry family data');
});

// The public form's share of this is deliberately small. The deposit box, the
// module, the rule arriving from migration 164, and the stamp on the
// application — and nothing else from the work that was rolled back after the
// form broke: no document checklist, no alternate-name/physician/insurance
// fields. Those stay out until they are re-landed on their own.
//
// What actually broke the form was never in this file. It was a
// MutationObserver loop in campistry_me.js (see the tests further down), which
// is why reverting this file twice did not help.

test('the office can set it and see who has not paid', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');

    // One place to set it: the card in the Registration form builder. The
    // standalone button was a second door to the same room.
    assert.match(me, /function _dpCardHtml/);
    assert.match(me, /_accCard\('Deposit to Register'/);
    assert.ok(!/openDepositPolicy/.test(me),
        'the standalone editor is gone \u2014 no dead code, no second entry point');

    assert.match(me, /markDepositPaid:markDepositPaid/);
    assert.match(me, /enrollSettings\.depositPolicy=_dpNew/, 'the policy is never saved');
    // Switched on and set to zero would announce a deposit and then let
    // everyone through, so that combination is refused — but the rest of the
    // form config still saves.
    assert.match(me, /switched on but set to zero/);
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

test('a field a camp has not asked for stays off', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const catalog = me.slice(me.indexOf('var FC_FIELD_CATALOG={'), me.indexOf('function getFormConfig'));
    const offInCatalog = [...catalog.matchAll(/id:'(\w+)'[^}]*off:true/g)].map((m) => m[1]);

    assert.ok(offInCatalog.includes('bunkmate') && offInCatalog.includes('separate'),
        'bunk requests must default off \u2014 a request on a form is a promise a parent hears');
    // The builder must read the flag, or a camp opening it sees every new
    // field already ticked.
    assert.match(me, /cfg\.enabled!=null\?cfg\.enabled!==false:!f\.off/);
});

test('required documents default off and carry stable ids', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /\{key:'documents',label:'Required Documents'[^}]*default:false\}/,
        'the documents section must default off');
    // A stable id, or renaming a document orphans every file already filed
    // under it.
    assert.match(me, /var id=el\.dataset\.id\|\|\('doc_'/);
    assert.match(me, /required:!!el\.querySelector\('\.fcDocReq'\)/);
});

// NOTE — the public registration form's half of the above (the named
// checklist, the per-upload "what is this?" picker, and the new
// camper/medical/other-parent fields) was ROLLED BACK after it rendered a
// blank page in the browser. The cause is not identified: the markup
// balances, both inline script blocks parse, and a stubbed-DOM run reaches
// the end without throwing — so the failure is something none of those
// catch. campistry_register.html is back at 6b47425, which keeps the
// deposit work and drops the rest. Re-land only with the cause in hand and
// a check that would have caught it; shipping it again on the same evidence
// would break the form a second time.

test('a preview that does not load says so', () => {
    // A 404, a frame the browser refused, and a page whose script died on
    // load are indistinguishable from the builder, and all three leave the
    // same silent grey box with a broken-document icon. That is what turned a
    // one-line problem into a day of guessing.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'campistry_me.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'campistry_me.css'), 'utf8');

    assert.match(html, /id="fbPreviewFail"/, 'nowhere to report the failure');
    assert.match(css, /\.fb-preview-fail\{/);
    assert.match(me, /function _fbWatchPreview/);
    assert.match(me, /The preview did not load/);
    // The page announces itself; the absence of that is the only signal that
    // catches all three causes.
    assert.match(me, /if\(fromIframe\)_fbPreviewOk\(\)/, 'a loaded preview must clear the warning');
    // And the office needs a way out that does not depend on the frame.
    assert.match(me, /Open it in a new tab/);
    assert.match(me, /_fbRetryPreview:_fbRetryPreview/, 'the retry button is not reachable');
    // The timer must not outlive the overlay.
    assert.match(me, /if\(_fbPreviewTimer\)\{clearTimeout\(_fbPreviewTimer\);_fbPreviewTimer=null;\}\n    _fbPreviewWin=null/);
});

// ── the bug that hung the tab ───────────────────────────────────────────────
//
// The form builder watches its panel with a MutationObserver and drives its
// live preview from the callback. The deposit card sits INSIDE that panel, so
// every innerHTML write it makes is a subtree mutation. Routing the card's
// refresh through the same handler fed the observer with its own output: an
// unbounded microtask loop that starved the event loop and left the tab white.
//
// It never threw. Nothing was logged, no exception guard could catch it, and
// balanced markup / parsing scripts / a stubbed-DOM run all passed while the
// real browser locked up. So this is tested by SIMULATING the feedback cycle,
// which is the only thing that would have caught it.
function extract(...names) {
    const src = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    return names.map((name) => {
        const i = src.indexOf('function ' + name + '(');
        assert.ok(i >= 0, 'missing ' + name);
        let depth = 0, k = src.indexOf('{', i);
        for (; k < src.length; k++) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}' && --depth === 0) break;
        }
        return src.slice(i, k + 1);
    }).join('\n');
}

test('refreshing the deposit preview twice writes once', () => {
    // The loop-breaker. Even if something re-enters the refresh, the second
    // pass computes the same string and writes nothing, so the mutation that
    // would feed the next pass never happens.
    let writes = 0, held = '';
    const out = { get innerHTML() { return held; }, set innerHTML(v) { writes++; held = v; } };
    const sandbox = {
        esc: (s) => String(s == null ? '' : s),
        fm: (n) => '$' + (Number(n) || 0),
        enrollSettings: {},
        sessions: [{ name: 'Full Season', tuition: 1250 }],
        _depPolicyAPI: () => P,
        _dpRead: () => ({ enabled: true, basis: 'percent', percent: 25, per: 'camper', timing: 'now' }),
        document: { getElementById: (id) => (id === 'dpPreview' ? out : null) }
    };
    const names = Object.keys(sandbox);
    const run = new Function(...names, extract('_dpPreview', '_dpSetHtml') + '\nreturn _dpPreview;');
    const dpPreview = run(...names.map((n) => sandbox[n]));

    dpPreview();
    assert.strictEqual(writes, 1, 'the first refresh must render');
    dpPreview();
    dpPreview();
    assert.strictEqual(writes, 1, 'an unchanged refresh must not write — a write here is the loop');
    assert.match(held, /\$312\.50/, 'and it must still be showing the right number');
});

test('the deposit refresh is not wired to the observer’s handler', () => {
    // _fbPushPreview is the MutationObserver callback. Anything in it that
    // writes into the panel feeds the observer its own output.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const push = me.slice(me.indexOf('function _fbPushPreview()'),
                          me.indexOf('\nfunction ', me.indexOf('function _fbPushPreview()') + 10));
    assert.ok(!/_dpRefreshCard|_dpOnPanelEdit/.test(push),
        'the deposit refresh must not run from the MutationObserver callback');
    // It gets its own listeners instead, which the observer does not feed.
    assert.match(me, /panel\.addEventListener\('input',_dpOnPanelEdit\)/);
    assert.match(me, /panel\.addEventListener\('change',_dpOnPanelEdit\)/);
    // Bound once, or every re-open stacks another handler.
    assert.match(me, /if\(!panel\._dpWired\)/);
});

test('every write the deposit editor makes is compared first', () => {
    // One missed spot is enough to restart the loop, so no raw assignment is
    // allowed anywhere in the editor.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    ['_dpPreview', '_dpCheckReach'].forEach((fn) => {
        const body = extract(fn);
        assert.ok(!/\.innerHTML\s*=/.test(body),
            fn + ' assigns innerHTML directly — use _dpSetHtml so an unchanged refresh writes nothing');
    });
});

test('what the card offers is what _dpRead understands', () => {
    // The card's dropdowns and _dpRead are two lists of the same strings in
    // different places. Reword one and the other silently falls through to its
    // default — a camp picks "a share of the tuition", saves, and gets a flat
    // $0 deposit with nothing on screen to say why.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const card = me.slice(me.indexOf('function _dpCardHtml('), me.indexOf('function _dpBuilderCardHtml('));
    const read = me.slice(me.indexOf('function _dpRead('), me.indexOf('function _dpPreview('));

    const options = (id) => {
        const m = card.match(new RegExp("'" + id + "'[\\s\\S]{0,200}?'select',\\[([^\\]]+)\\]"));
        assert.ok(m, 'no options found for ' + id);
        return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    // Every non-default option must appear verbatim in the reader.
    ['dpBasis', 'dpPer', 'dpTiming'].forEach((id) => {
        const opts = options(id);
        assert.ok(opts.length >= 2, id + ' should offer a choice');
        const matched = opts.filter((o) => read.includes("'" + o + "'"));
        assert.ok(matched.length >= opts.length - 1,
            id + ': _dpRead does not recognise ' + JSON.stringify(opts.filter((o) => !read.includes("'" + o + "'"))));
    });
});

test('only the field that applies is on screen', () => {
    // Two amount boxes side by side, where only one counts, is what made this
    // feel like a puzzle. _dpToggle owns the swap.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const toggle = me.slice(me.indexOf('function _dpToggle('), me.indexOf('/** Read the form into a policy'));
    ['dpBody', 'dpAmountWrap', 'dpPercentWrap', 'dpDueWrap'].forEach((id) => {
        assert.ok(toggle.includes("'" + id + "'"), id + ' is never shown or hidden');
    });
    // And every edit runs it, or the card would only update on the on/off box.
    assert.match(me, /try\{ _dpToggle\(\); \}catch/);
});

test('the public form states the deposit, minimally and without gating', () => {
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    assert.match(reg, /id="depositBox"/);
    assert.match(reg, /campistry_deposit_policy\.js\?v=/);
    assert.match(reg, /_depositPolicy=d\.depositPolicy\|\|null/, 'the rule never arrives from the cloud');
    assert.match(reg, /_regDepositStamp/, 'nothing is recorded on the application');
    // The amount can be a share of tuition, so it has to move with the price.
    assert.match(reg, /try\{ _regRenderDeposit\(\); \}catch/);

    // Same write discipline as the builder card, even though this page has no
    // MutationObserver today — the habit is what stops the loop coming back.
    assert.match(reg, /function _regSetHtml/);
    const render = reg.slice(reg.indexOf('function _regRenderDeposit('), reg.indexOf('/** What the camp required'));
    assert.ok(!/\.innerHTML\s*=/.test(render), 'assign through _regSetHtml, not directly');

    // A deposit must never stop an application going through.
    assert.match(reg, /deposit stamp skipped/, 'the stamp must be guarded');

    // The rolled-back work stays rolled back.
    ['_regRenderRequiredDocs', 'campistry_finance_merge.js', 'rAltF', 'rDocN'].forEach((m) => {
        assert.ok(!reg.includes(m), m + ' is back in the public form — that part is still reverted');
    });
});

test('the post-acceptance form carries it too', () => {
    const pa = fs.readFileSync(path.join(ROOT, 'campistry_postaccept.html'), 'utf8');
    assert.match(pa, /id="depositBox"/);
    assert.match(pa, /function _paRenderDeposit/);
    assert.match(pa, /campistry_deposit_policy\.js/);
    // Read off the enrollment, not recomputed: what was owed is frozen at what
    // the policy said the day they applied, so a camp that raised its deposit
    // since does not present this family with the new number.
    const fn = pa.slice(pa.indexOf('function _paRenderDeposit('), pa.indexOf('// Which built-in sections'));
    assert.match(fn, /e\.depositRequired/);
    assert.ok(!/amountFor/.test(fn), 'the post-acceptance form must not recompute the amount');
});

// ── siblings on their own sessions ──────────────────────────────────────────
test('each camper is priced for the session they picked', () => {
    // Multiplying one price by the head count was right only while everyone
    // came for the same weeks. With a sibling on a different session it
    // quietly over- or under-charged, and the parent could not see which.
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    assert.match(reg, /function _sibSessionSelect/, 'siblings have no session picker');
    assert.match(reg, /Same as Camper 1/, 'the common case must stay zero clicks');
    assert.match(reg, /class="fs sib-ses"/);
    assert.match(reg, /siblings\[i\]\.session=el\.value/, 'the choice is never read back');

    // One resolver, so the price, the deposit and the saved application cannot
    // disagree about which weeks a sibling is coming for.
    assert.match(reg, /function _sessionFor/);
    const price = reg.slice(reg.indexOf('function updatePrice('), reg.indexOf('// ─── DEPOSIT TO REGISTER'));
    assert.match(price, /_sessionFor\(sib\)/, 'the total ignores a sibling’s own session');
    assert.ok(!/fm\(total\*\(perCamper\)\)/.test(price),
        'the total must be a sum of what each camper picked, not one price times a head count');

    // And the record has to carry it, or Billing charges for the wrong weeks.
    assert.match(reg, /var _camSession=_sessionFor\(cam\)/);
    assert.match(reg, /session:_camSession\.name\|\|selSess/);
    assert.match(reg, /sessionTuition:Number\(_camSession\.tuition\)\|\|0/);

    // The deposit counts each camper's own session too.
    const due = reg.slice(reg.indexOf('function _regDepositDue('), reg.indexOf('/** Write only when it changes'));
    assert.match(due, /_sessionFor\(sib\)/);
});

test('a missing deposit box says which kind of missing it is', () => {
    // Configured-but-absent and never-set-up look identical on a parent's
    // screen, and that ambiguity cost days. Four causes, four messages.
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /did not load/);
    assert.match(reg, /migration 164 not applied/);
    assert.match(reg, /switched off/);
    assert.match(reg, /works out to \$0/);
    // Once, not once per keystroke — updatePrice runs on every edit.
    assert.match(reg, /_depDiagSaid/);
});

// ── the deposit before a session is picked ──────────────────────────────────
//
// _regRenderDeposit used to hang off the end of updatePrice, which returns
// early when no session is selected — so on every first view of the form, and
// throughout the builder's preview, it never ran. Not the box, not even the
// diagnostic line that was supposed to explain the box's absence.
function runDeposit({ policy, sessions, selected }) {
    const src = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    const body = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])[1];
    const grab = (name) => {
        const i = body.indexOf('function ' + name + '(');
        assert.ok(i >= 0, 'missing ' + name);
        let depth = 0, k = body.indexOf('{', i);
        for (; k < body.length; k++) {
            if (body[k] === '{') depth++;
            else if (body[k] === '}' && --depth === 0) break;
        }
        return body.slice(i, k + 1);
    };
    let held = '';
    const logs = [];
    const box = { style: {}, get innerHTML() { return held; }, set innerHTML(v) { held = v; } };
    const sandbox = {
        esc: (s) => String(s == null ? '' : s), fm: (n) => '$' + (Number(n) || 0),
        _pickerItems: () => sessions, selSess: selected, selSessKind: 'session', siblings: [],
        _depositPolicy: policy, _depDiagSaid: false,
        console: { log: (m) => logs.push(m), warn() {} },
        document: { getElementById: (id) => (id === 'depositBox' ? box : null) },
        window: { CampistryDepositPolicy: P }
    };
    const code = grab('_pickerSelected') + grab('_regDepositDue') + grab('_regSetHtml') + grab('_regRenderDeposit');
    const names = Object.keys(sandbox);
    new Function(...names, code + '\n_regRenderDeposit();')(...names.map((n) => sandbox[n]));
    return { html: held, logs };
}

const ONE_SESSION = [{ name: '1st Half', kind: 'session', tuition: 2300 }];

test('a required deposit is mentioned before a session is picked', () => {
    // A deposit that only appears at the end is a surprise at the worst
    // moment, and "nothing there" is indistinguishable from "not set up".
    const pct = runDeposit({ policy: { enabled: true, basis: 'percent', percent: 25 }, sessions: ONE_SESSION, selected: '' });
    assert.match(pct.html, /Choose a session/, 'must say what the amount depends on');

    // A flat amount does not depend on the session, so it is stated at once.
    const flat = runDeposit({ policy: { enabled: true, basis: 'flat', amount: 250 }, sessions: ONE_SESSION, selected: '' });
    assert.match(flat.html, /\$250/);
});

test('with a session picked it shows the real number', () => {
    const r = runDeposit({ policy: { enabled: true, basis: 'percent', percent: 25 }, sessions: ONE_SESSION, selected: '1st Half' });
    assert.match(r.html, /\$575/, '25% of $2,300');
});

test('and when there is nothing to show it says which nothing', () => {
    const none = runDeposit({ policy: null, sessions: ONE_SESSION, selected: '1st Half' });
    assert.match(none.logs[0] || '', /migration 164 not applied/);
    assert.strictEqual(none.html, '', 'nothing is drawn for a camp with no deposit');

    const off = runDeposit({ policy: { enabled: false }, sessions: ONE_SESSION, selected: '1st Half' });
    assert.match(off.logs[0] || '', /switched off/);
});

test('the deposit renders on every path that draws the form', () => {
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    // updatePrice's early return, the session list, and the builder's pushed
    // draft. Miss any one and it is invisible in a state somebody will hit.
    assert.match(reg, /el\.innerHTML='';try\{_regRenderDeposit\(\);\}catch/);
    assert.match(reg, /setTimeout\(function\(\)\{try\{_regRenderDeposit\(\);\}catch\(e\)\{\}\},0\)/);
    const apply = reg.slice(reg.indexOf('function applyFormConfig('), reg.indexOf('// ─── SIBLINGS'));
    assert.match(apply, /_regRenderDeposit/, 'the builder preview never refreshes it');
});

// ── the camp's own terms ────────────────────────────────────────────────────
test('a deposit can be charged on top of tuition instead of counting toward it', () => {
    // Most camps take it off the tuition. Some charge a holding fee on top,
    // and telling a family it "counts toward tuition" when it does not is a
    // promise the camp has to walk back.
    const on = { enabled: true, basis: 'flat', amount: 250, timing: 'now' };
    const off = { ...on, countsTowardTuition: false };
    const r = P.amountFor(on, [{ tuition: 1000 }]);

    assert.match(P.describe(on, r), /counts toward tuition/);
    assert.match(P.describe(off, r), /charged on top of tuition/);
    // Frozen on the application, like everything else about the deposit.
    assert.strictEqual(P.stampFor(off, r, '2026-06-01').depositCountsTowardTuition, false);
    assert.strictEqual(P.stampFor(on, r, '2026-06-01').depositCountsTowardTuition, true);
    // A camp that never saw this setting keeps the behaviour it had.
    assert.strictEqual(P.normalize({}).countsTowardTuition, true);

    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /id="dpCounts"/, 'no way to change it');
    assert.match(me, /countsTowardTuition:ck\('dpCounts'\)/, 'the change is never read back');
});

test('the camp chooses which payment methods families are offered', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    assert.match(me, /function _pmBuilderCardHtml/);
    assert.match(me, /_accCard\('How families can pay'/);
    // Stored in formConfig, which the public RPC already sends — no migration,
    // and no second delivery path to keep in step.
    assert.match(me, /paymentMethods:payMethods/);
    // Null, not [], when the card never rendered: a save from a page where the
    // payments module failed to load must not wipe the camp's choice.
    assert.match(me, /var payMethods=null/);

    assert.match(reg, /function _regRenderPayOpts/);
    assert.match(reg, /_payMethods=\(d\.formConfig\|\|\{\}\)\.paymentMethods\|\|null/,
        'the choice never arrives from the cloud');
    // A method the camp has since stopped taking must not stay selected.
    assert.match(reg, /if\(selPM&&!box\.querySelector/);
    // The form's ids predate the shared catalogue and applications already
    // carry them, so they are mapped rather than renamed.
    assert.match(reg, /var PAY_ID_MAP=/);
});

test('paying and signing are always the last thing on the form', () => {
    // With Siblings below Payment, adding a child grew the page underneath the
    // part a parent had already filled in, so Payment drifted up the screen
    // and the submit button stopped being the thing at the end.
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /var PINNED_LAST=\['payment','signature'\]/);
    assert.match(reg, /order\.filter\(function\(k\)\{return PINNED_LAST\.indexOf\(k\)<0;\}\)\.concat\(PINNED_LAST\)/,
        'a saved order must not be able to put payment anywhere but last');
    // Custom questions are still the parent's to fill in, so they go above.
    assert.match(reg, /var before=pay\|\|sig/);

    // And the builder must not offer a drag the form will ignore.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /_ORDER_PINNED_LAST=\{fc:\['payment','signature'\]\}/);
    assert.match(me, /always last/);
});

// ── taking the deposit on the form ──────────────────────────────────────────
//
// Money, on an anonymous page, so the properties that matter are about who
// decides the amount and what happens when something goes wrong.
test('the amount charged is never the caller’s to name', () => {
    const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/registration-deposit-checkout/index.ts'), 'utf8');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/185_registration_deposit.sql'), 'utf8');

    // The page asking is anonymous by design. If it could send an amount it
    // could name its own price — in either direction.
    assert.match(fn, /_registration_deposit_owed/);
    const body = fn.slice(fn.indexOf('const { campId, enrollmentId, returnUrl }'), fn.indexOf('// ── Banquest'));
    assert.ok(!/\bamount\b\s*[,}]/.test(body.split('await req.json()')[0] || ''),
        'the request body must not carry an amount');
    assert.match(fn, /const owed = Number\(owedRes\.owed\)/);

    // The lookup and the write are service-role only — an anonymous caller
    // must not be able to reach either directly.
    assert.match(sql, /REVOKE ALL ON FUNCTION public\._registration_deposit_owed[\s\S]*?FROM public, anon, authenticated/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\._record_registration_deposit[\s\S]*?FROM public, anon, authenticated/);
    // Only whether-you-can-pay is public, and it carries no keys or account ids.
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_pay_ability\(uuid\) TO anon/);
    const ability = sql.slice(sql.indexOf('get_public_pay_ability'));
    assert.ok(!/stripe_account_id'|account_id',/.test(ability), 'the public answer must not leak an account id');

    // An open redirect would turn the camp's payment page into a phishing hop.
    assert.match(fn, /returnUrl must be an https URL/);
});

test('a deposit is recorded once, and on the application', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/185_registration_deposit.sql'), 'utf8');

    // There is no family record yet, so the application is what gets credited.
    assert.match(sql, /ARRAY\['enrollments', p_enroll_id, 'depositPaid'\]/);
    assert.match(sql, /'depositStatus'\], to_jsonb\('paid'::text\)/);
    // jsonb_set, not read-modify-write: a webhook that rewrote the whole
    // document would lose whatever the office saved while the parent was on
    // the processor's page — the defect that erased autopay charges.
    assert.match(sql, /jsonb_set/);
    assert.ok(!/SELECT value[\s\S]{0,400}UPDATE camp_state_kv\s+SET value = \$?\d/.test(sql),
        'the whole document must never be written back');
    // Processors retry webhooks. Crediting twice is real money.
    assert.match(sql, /depositReference', ''\) = p_reference/);
    assert.match(sql, /'duplicate', true/);
});

test('both rails mark it, and neither does so quietly on failure', () => {
    const hosted = fs.readFileSync(path.join(ROOT, 'supabase/functions/payments-hosted-complete/index.ts'), 'utf8');
    const stripe = fs.readFileSync(path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');

    assert.match(hosted, /pending\.purpose === "registration_deposit"/);
    assert.match(stripe, /source === "registration_deposit"/);
    assert.match(stripe, /function handleRegistrationDeposit/);

    // Only settled money holds a place. A processing ACH must not.
    assert.match(stripe, /if \(status !== "succeeded"\)/);

    // If the money moved and the mark failed, that has to be loud: a silent
    // success leaves a paid family sitting in a list of unpaid ones.
    assert.match(hosted, /could not mark it on your application/);
    assert.match(stripe, /could not mark registration deposit/);
});

test('the form offers paying only when something is behind the button', () => {
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');

    assert.match(reg, /id="paySeat"/);
    assert.match(reg, /registration-deposit-checkout/);
    assert.match(reg, /get_public_pay_ability/);
    // A camp with no processor still gets the amount stated — a parent told
    // nothing assumes nothing is owed.
    assert.match(reg, /The camp will be in touch with how to pay it/);
    // Pay-later is already tracked as owed; chasing it on the thank-you screen
    // would be noise.
    assert.match(reg, /_regDepStamp\.depositTiming!=='later'/);
    // The application is saved before any of this, so an abandoned payment
    // costs the family nothing.
    // Compare against the CALL SITE, not the first mention — the function is
    // named in a comment near the top of the file.
    const callAt = reg.indexOf('_regOfferDepositPayment(_resolvedCampId');
    assert.ok(callAt > 0, 'the pay step is never offered');
    assert.ok(reg.indexOf('recordSubmission();') < callAt,
        'the application must be saved before the parent is sent to pay');
});

// ── going to the processor, and keeping the card ────────────────────────────
test('picking card or ACH always says what happens next', () => {
    // A parent who ticks "Credit Card" expects to type a card. They cannot yet
    // — there is nothing to charge until the application exists — so the form
    // says what will happen, where they picked it, rather than letting them
    // find out after submitting. The first version of this went SILENT
    // whenever pay-ability was unknown (an unapplied migration, an offline
    // load), which looked exactly like a broken form: a parent ticked the card
    // and nothing appeared at all. Every branch now says something.
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /function _regIsOnlineMethod/);
    assert.match(reg, /id="payMethodNote"/);
    // Named by rail, not generically — "Stripe's secure checkout" is a thing a
    // parent recognises and trusts.
    assert.match(reg, /Stripe\\u2019s secure checkout/);
    assert.match(reg, /camp\\u2019s secure payment page/);
    assert.match(reg, /never touch this form/);

    const fn = reg.slice(reg.indexOf('function _regPayMethodNote()'),
                         reg.indexOf('function _regSyncSubmitLabel('));
    // The ONLY way out without rendering anything is "this is not an online
    // method" — every other path falls through to the render at the bottom.
    const blanks = fn.match(/_regSetHtml\(box,''\)/g) || [];
    assert.strictEqual(blanks.length, 1,
        'the note may only go blank for a method that never reaches a processor');
    assert.ok(fn.indexOf("if(!_regIsOnlineMethod(selPM)){") < fn.indexOf("_regSetHtml(box,'')"),
        'the one blank branch must be the non-online one');

    // Unknown ability is not silence — it is the honest sentence.
    assert.match(fn, /You will be shown how to pay the/);
    // A camp that cannot take cards says so here, not on the confirmation.
    assert.match(fn, /does not take '\+kind\+' through this form/);
    // A deposit due later still explains why a card was asked for.
    assert.match(fn, /Nothing is charged now/);
    // Save-the-card is only offered where a card is actually entered.
    assert.ok(fn.indexOf('saveCard=true') > 0 && /\(saveCard\?/.test(fn),
        'the save-card tick only appears on the branch that reaches a processor');
});

test('the button they press to reach the processor says so', () => {
    // The complaint that started this: "nothing opens to allow to tell the
    // user to input or click on this link to open". There is no link to open
    // before the application is saved — so the submit button itself names the
    // payment step instead of leaving a parent hunting for one.
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /id="submitAppBtn"/);
    const fn = reg.slice(reg.indexOf('function _regSyncSubmitLabel('));
    assert.match(fn.slice(0, 900), /Submit & pay '\+money\(amount\)/);
    // Never promises a payment step the camp cannot actually run.
    assert.match(fn.slice(0, 900), /_payAbility&&_payAbility\.canPayOnline/);
    // A submit already in flight owns the label; this must not fight it.
    assert.match(fn.slice(0, 900), /if\(!b\|\|b\.disabled\)return/);
    // Kept in step with the amount, not set once.
    assert.ok(/_regSyncSubmitLabel\(payNow&&_regIsOnlineMethod\(selPM\)\?due\.total:0\)/.test(reg),
        'the label follows the deposit that is actually due');
});

test('choosing a card takes them there rather than to a second button', () => {
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    assert.match(reg, /if\(_regIsOnlineMethod\(selPM\)&&_payAbility&&_payAbility\.canPayOnline\)/);
    assert.match(reg, /_regPayDeposit\(_resolvedCampId\|\|campIdParam,appIds\[0\]\)/);
    // The step stays on screen behind the redirect, so someone who comes back
    // has a way to finish.
    const callAt = reg.indexOf('_regOfferDepositPayment(_resolvedCampId');
    assert.ok(callAt > 0 && callAt < reg.indexOf('if(_regIsOnlineMethod(selPM)&&_payAbility'),
        'the pay step must be rendered before the redirect fires');
});

test('a parent can keep the card they just typed', () => {
    const reg = fs.readFileSync(path.join(ROOT, 'campistry_register.html'), 'utf8');
    const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/registration-deposit-checkout/index.ts'), 'utf8');
    const stripe = fs.readFileSync(path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
    const hosted = fs.readFileSync(path.join(ROOT, 'supabase/functions/payments-hosted-complete/index.ts'), 'utf8');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/186_registration_saved_card.sql'), 'utf8');

    assert.match(reg, /id="paySaveCard"/);
    assert.match(reg, /saveCard:!!_saveCard/, 'the choice never reaches the server');

    // Only ever because the parent asked.
    assert.match(fn, /if \(saveCard\)/);
    assert.match(fn, /setup_future_usage/, 'a plan needs a method chargeable off-session');
    assert.match(fn, /saveCard \? "registration_deposit_save" : "registration_deposit"/);
    assert.match(hosted, /registration_deposit_save/);

    // Both rails record it; neither treats a failure as fatal, because the
    // money is already in and a lost card just means typing it again.
    assert.match(stripe, /_record_registration_card/);
    assert.match(hosted, /_record_registration_card/);
    assert.match(stripe, /card not saved for/);

    // Never a card number — only the processor's own references and last four.
    assert.ok(!/card_number|cardNumber|p_pan/i.test(sql), 'no card number may be stored');
    assert.match(sql, /savedCardLast4/);
    assert.match(sql, /jsonb_set/, 'written in place, like the deposit itself');
});

test('the saved card reaches the family when the office accepts', () => {
    // It waits on the application because there is no family until acceptance.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    const fn = me.slice(me.indexOf('function enrollCamper('), me.indexOf('// Generate payment plan'));
    assert.match(fn, /e\.savedCardCustomer/);
    assert.match(fn, /stripeCustomerId/);
    assert.match(fn, /byopCustomerRef/);
    // A card the office already has was chosen deliberately and may be the one
    // autopay runs on — it must not be overwritten by a registration card.
    assert.match(fn, /if\(!_f\.cardOnFile\)/);
});

// ── Cardknox / Sola ─────────────────────────────────────────────────────────
//
// I first said this rail had no hosted page. It does: a real Sola checkout at
// secure.cardknox.com/<slug> with a per-transaction amount, an intent row for
// correlation, a webhook, and card saving through cc:save. Nothing had to be
// invented — only taught about applications.
test('a Cardknox camp can take the deposit too', () => {
    const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/registration-deposit-checkout/index.ts'), 'utf8');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/187_cardknox_registration_deposit.sql'), 'utf8');
    const ability = fs.readFileSync(path.join(ROOT, 'migrations/185_registration_deposit.sql'), 'utf8');

    assert.match(fn, /processorKey === "cardknox"/);
    assert.match(fn, /secure\.cardknox\.com/);
    assert.match(fn, /xAmount=/, 'the hosted page needs a real per-transaction amount');
    assert.match(fn, /xInvoice=/, 'and our own reference to correlate on');
    assert.match(fn, /create_cardknox_registration_intent/);
    // The form must offer the button at all for these camps.
    assert.match(ability, /v_key IN \('banquest', 'cardknox'\)/);

    // An intent belongs to a family or a camper today; this one belongs to an
    // application, which exists before either does.
    assert.match(sql, /ADD COLUMN IF NOT EXISTS enrollment_id text/);
    assert.match(sql, /'registration_deposit'\)\)/, 'the kind constraint must allow it');
    // A new signature rather than a changed one, so the existing callers in
    // cardknox-checkout-start keep working while this ships.
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_cardknox_registration_intent/);
});

test('the application survives Sola not echoing our reference', () => {
    // Live testing in this repo established that Sola's hosted-checkout webhook
    // never sends xInvoice back — it correlates by amount instead. That makes
    // the amount-matched fallback the NORMAL path, and it used to build its
    // intent object by hand, field by field. Leaving enrollment_id out of that
    // list would resolve a registration deposit to an intent with no
    // application to credit, and the money would land nowhere.
    const hook = fs.readFileSync(path.join(ROOT, 'supabase/functions/cardknox-webhook/index.ts'), 'utf8');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/187_cardknox_registration_deposit.sql'), 'utf8');

    const fallback = hook.slice(hook.indexOf('if (candidates && candidates.length === 1)'),
                                hook.indexOf('} else if (candidates'));
    assert.match(fallback, /enrollmentId: row\.enrollment_id/,
        'the amount-matched fallback must carry the application through');
    // And the by-reference path needs it from the RPC.
    assert.match(sql, /'enrollmentId', i\.enrollment_id/);
    assert.match(hook, /enrollmentId\?: string/, 'the type must allow it');
});

test('the Cardknox branch credits the application and can keep the card', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'supabase/functions/cardknox-webhook/index.ts'), 'utf8');
    const branch = hook.slice(hook.indexOf('if (intent.kind === "registration_deposit")'),
                              hook.indexOf('// A card save (Sola'));

    assert.match(branch, /_record_registration_deposit/);
    assert.match(branch, /record_processor_transaction/,
        'a charge must be visible to the reconciliation tool even if the next step fails');
    // xToken only comes back when the checkout was told to save a card.
    assert.match(branch, /vaultCardknoxToken/);
    assert.match(branch, /_record_registration_card/);
    // Money moved and the mark failed → ask Sola to retry, never a silent ok.
    assert.match(branch, /return text\("Could not record deposit", 500\)/);
    // It must run BEFORE the family-scoped paths, which look for a familyKey
    // that does not exist yet.
    assert.ok(hook.indexOf('if (intent.kind === "registration_deposit")') <
              hook.indexOf('if (intent.kind === "card_save")'),
        'the application branch must come before the family-scoped ones');
});
