// node --test tests/withdrawal_lifecycle.test.js
//
// WHAT HAPPENS TO MONEY WHEN A CHILD IS TAKEN OUT OF CAMP.
//
// tests/money_parity.test.js covers the BALANCE question — a non-billable
// status stops the tuition on both sides, and a family who already paid ends up
// with a credit rather than a zero. All of that holds.
//
// This file covers the LIFECYCLE around it, which does not: what happens to the
// payment plan, the autopay schedule, the saved card, the canteen balance and
// the audit trail. The office has three different ways to take a camper out and
// they are not the same operation:
//
//   unenrollCamper()    parks the camper, flips live enrollments to
//                       'unenrolled'. Reversible via reenrollCamper(). Family,
//                       payments, plan, saved card, canteen account all stay.
//   rescindEnrollment() calls cascadeCamperDelete, then intends to leave the
//                       application marked 'withdrawn' for the audit trail.
//   deleteCamper()      permanent. cascadeCamperDelete deletes the enrollment
//                       rows outright, and deletes the FAMILY record once it
//                       has no campers left. Payments deliberately stay.
//
// Three defects are pinned below, each marked DEFECT. They assert the CURRENT
// behaviour so the suite stays honest and green — when one is fixed its test
// fails and gets rewritten. None of them loses money silently on the day a
// camper leaves; all three lose money or an audit record later.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const money = n => Math.round((Number(n) || 0) * 100) / 100;

// ── the billable-status rule, in one place ────────────────────────────────
const BILLABLE = new Set(['enrolled', 'accepted']);

/** computeFamilyBalance() from charge-due-installments, for one family. */
function familyBalance(db, famKey) {
    const f = db.families[famKey];
    if (!f) return 0;                      // no family record => nothing owed
    const mine = f.camperIds || [];
    let billed = 0;
    for (const e of Object.values(db.enrollments)) {
        if (!mine.includes(e.camperName)) continue;
        if (!BILLABLE.has(e.status)) continue;
        billed += Number(e.tuition) || 0;
    }
    for (const c of (f.charges || [])) billed += Number(c.amount) || 0;
    let credits = 0;
    for (const c of (f.credits || [])) credits += Number(c.amount) || 0;
    let paid = 0;
    for (const p of db.payments) {
        if (p.familyKey !== famKey) continue;
        if (p.status === 'pending' || p.status === 'failed') continue;
        paid += Number(p.amount) || 0;
    }
    return money(billed - paid - credits);
}

/**
 * One night of charge-due-installments for one family, transliterated from
 * supabase/functions/charge-due-installments/index.ts. Returns what was
 * charged. Mutates the plan the way the real run does.
 */
function autopayNight(db, famKey, today, charge = () => ({ ok: true })) {
    const f = db.families[famKey];
    if (!f) return [];                              // family gone => no autopay
    const plans = Array.isArray(f.plans) ? f.plans
                : (f.plan && Array.isArray(f.plan.installments) ? [f.plan] : []);
    if (!plans.some(p => p && p.autopay)) return [];
    if (!f.cardOnFile) return [];
    let remaining = familyBalance(db, famKey);
    const charged = [];
    for (const plan of plans) {
        if (!plan || !plan.autopay) continue;
        for (const inst of plan.installments) {
            if (inst.status !== 'pending') continue;
            if (!inst.dueDate || inst.dueDate > today) continue;   // not due yet
            const scheduled = Number(inst.amount) || 0;
            if (scheduled <= 0) { inst.status = 'paid'; continue; }
            if (remaining <= 0.005) {
                inst.status = 'paid';
                inst.paidDate = today;
                inst.note = 'Covered by an earlier payment — not charged';
                charged.push({ dueDate: inst.dueDate, amount: 0, result: 'waived' });
                continue;
            }
            const amount = Math.min(scheduled, remaining);
            const res = charge(amount);
            if (!res.ok) { inst.status = 'failed'; continue; }
            inst.status = 'paid';
            inst.paidDate = today;
            db.payments.push({ familyKey: famKey, amount, status: 'succeeded' });
            remaining = money(remaining - amount);
            charged.push({ dueDate: inst.dueDate, amount, result: 'charged' });
        }
    }
    return charged;
}

function sixMonthPlan() {
    return {
        id: 'plan_1', autopay: true,
        installments: ['01', '02', '03', '04', '05', '06'].map(m => ({
            dueDate: `2026-${m}-01`, amount: 500, status: 'pending',
        })),
    };
}

function steinDb() {
    return {
        enrollments: { e1: { camperName: 'Malky Stein', tuition: 3000, status: 'enrolled' } },
        families: {
            f1: {
                name: 'Stein Family', camperIds: ['Malky Stein'],
                cardOnFile: true, stripeCustomerId: 'cus_1',
                stripePaymentMethodId: 'pm_1',
                savedPaymentMethods: [{ id: 'pm_a', token: 'pm_1', isDefault: true }],
                plans: [sixMonthPlan()],
            },
        },
        payments: [],
    };
}

// ── 1. unenroll: autopay stops, and stops for the right reason ────────────

test('autopay stops charging a parked camper', () => {
    const d = steinDb();
    assert.deepStrictEqual(
        autopayNight(d, 'f1', '2026-01-01').map(c => c.amount), [500],
        'January should charge normally while enrolled');

    d.enrollments.e1.status = 'unenrolled';           // unenrollCamper()
    const feb = autopayNight(d, 'f1', '2026-02-01');
    assert.deepStrictEqual(feb.map(c => c.result), ['waived'],
        'February must not charge a card for a camper who has left');
    assert.strictEqual(money(d.payments.reduce((s, p) => s + p.amount, 0)), 500,
        'only the January charge should ever have been taken');
});

test('the parked family is owed back what they paid', () => {
    const d = steinDb();
    autopayNight(d, 'f1', '2026-01-01');              // +500
    d.enrollments.e1.status = 'unenrolled';
    assert.strictEqual(familyBalance(d, 'f1'), -500,
        'a credit is owed — never clamped to zero, or the refund is invisible');
});

test('a sibling still enrolled keeps being charged', () => {
    const d = steinDb();
    d.enrollments.e2 = { camperName: 'Shaya Stein', tuition: 3000, status: 'enrolled' };
    d.families.f1.camperIds.push('Shaya Stein');
    d.enrollments.e1.status = 'unenrolled';           // only Malky leaves
    const jan = autopayNight(d, 'f1', '2026-01-01');
    assert.deepStrictEqual(jan.map(c => c.result), ['charged'],
        'the sibling’s tuition is still owed, so autopay must still run');
});

// ── 2. DEFECT: parking a camper permanently burns the instalments that
//       come due while they are parked ──────────────────────────────────────

test('DEFECT: re-enrolling after a parked spell leaves an uncollectable gap', () => {
    // While the balance is <= 0, every instalment that comes DUE is marked
    // 'paid' with "Covered by an earlier payment — not charged". That is right
    // while the camper is gone. It is not reversible: reenrollCamper() restores
    // the enrollment status but nothing reopens those instalments, so the plan
    // reads fully paid while the family still owes the money, and autopay has
    // nothing pending left to charge.
    const d = steinDb();
    autopayNight(d, 'f1', '2026-01-01');              // charged 500
    autopayNight(d, 'f1', '2026-02-01');              // charged 500

    d.enrollments.e1.status = 'unenrolled';           // parked 1 Mar
    autopayNight(d, 'f1', '2026-03-01');              // waived
    autopayNight(d, 'f1', '2026-04-01');              // waived
    autopayNight(d, 'f1', '2026-05-01');              // waived

    d.enrollments.e1.status = 'enrolled';             // reenrollCamper(), 1 Jun
    autopayNight(d, 'f1', '2026-06-01');              // charges the last 500

    const collected = money(d.payments.reduce((s, p) => s + p.amount, 0));
    const insts = d.families.f1.plans[0].installments;

    // Every instalment reads settled...
    assert.ok(insts.every(i => i.status === 'paid'),
        'the plan presents as fully paid');
    // ...but only 3 of 6 were ever charged.
    assert.strictEqual(collected, 1500, 'only three instalments were taken');
    assert.strictEqual(familyBalance(d, 'f1'), 1500,
        'the family still owes 1500 with no pending instalment left to collect it');

    // The three burned instalments still carry the misleading note, which is
    // the only clue an office would have.
    const waived = insts.filter(i => i.note && i.note.startsWith('Covered by'));
    assert.strictEqual(waived.length, 3);
    assert.match(waived[0].note, /Covered by an earlier payment/,
        'the note blames an earlier payment — it should say the camper was not enrolled');
});

// ── 3. DEFECT: rescindEnrollment promises an audit record it then deletes ──

test('DEFECT: a rescinded application is deleted, not kept as Withdrawn', () => {
    // The confirm dialog tells the office: "The application stays here marked
    // Withdrawn for the audit trail." It does not. cascadeCamperDelete deletes
    // every enrollment matching the camper name, and the status flip that
    // follows mutates an object already detached from the map.
    const src = read('campistry_me.js');

    // The cascade deletes unconditionally. Anchored FORWARD from the cascade —
    // `async function deleteCamper` also matches deleteCamperFromEdit earlier in
    // the file, which silently produced an empty slice and a passing test.
    const cascadeAtSrc = src.indexOf('function cascadeCamperDelete');
    assert.ok(cascadeAtSrc > 0, 'cascadeCamperDelete is gone — re-check this test');
    const cascade = src.slice(cascadeAtSrc,
                              src.indexOf('async function deleteCamper(n)', cascadeAtSrc));
    assert.ok(cascade.length > 0, 'empty slice — the anchors moved');
    assert.match(cascade, /if\(e&&e\.camperName===name\)delete enrollments\[eid\]/,
        'cascadeCamperDelete no longer deletes enrollments — re-check this test');

    // ...and rescindEnrollment calls it BEFORE setting the status.
    const rescind = src.slice(src.indexOf('async function rescindEnrollment'),
                              src.indexOf('async function deleteApplication'));
    const cascadeAt = rescind.indexOf('cascadeCamperDelete(e.camperName)');
    const flipAt = rescind.indexOf("e.status='withdrawn'");
    assert.ok(cascadeAt > 0 && flipAt > cascadeAt,
        'the status flip no longer follows the cascade — re-check this test');

    // The dialog still promises the record survives.
    assert.match(rescind, /application stays here marked <strong>Withdrawn<\/strong>/,
        'the promise text changed — if it was corrected, delete this test');

    // Model it: the flip lands on an orphan.
    const enrollments = { e1: { camperName: 'Malky Stein', status: 'enrolled' } };
    const e = enrollments.e1;
    Object.keys(enrollments).forEach(id => {
        if (enrollments[id].camperName === 'Malky Stein') delete enrollments[id];
    });
    e.status = 'withdrawn';
    assert.deepStrictEqual(Object.keys(enrollments), [],
        'the audit record the dialog promised is gone from the saved data');
    assert.strictEqual(e.status, 'withdrawn', 'the flip only touched a detached object');
});

// ── 4. a hard delete drops the family record, and with it the card ─────────

test('deleting the last camper deletes the family record', () => {
    // cascadeCamperDelete deletes a family once camperIds is empty, because
    // buildFamilyLedgers renders ANY families[] entry and an empty one would
    // sit there forever as a $0 "Paid" card.
    const d = steinDb();
    d.payments.push({ familyKey: 'f1', amount: 500, status: 'succeeded' });

    // cascadeCamperDelete('Malky Stein')
    Object.keys(d.families).forEach(fk => {
        const f = d.families[fk];
        f.camperIds = f.camperIds.filter(c => c !== 'Malky Stein');
        if (f.camperIds.length === 0) delete d.families[fk];
    });
    Object.keys(d.enrollments).forEach(id => {
        if (d.enrollments[id].camperName === 'Malky Stein') delete d.enrollments[id];
    });

    assert.deepStrictEqual(Object.keys(d.families), [], 'the family record is gone');
    // Payments deliberately stay — erasing billing history is worse.
    assert.strictEqual(d.payments.length, 1, 'the payment record must survive the delete');
    // But it now belongs to no family, so no ledger renders it.
    assert.strictEqual(d.families[d.payments[0].familyKey], undefined,
        'the surviving payment points at a family that no longer exists');
    // And autopay correctly cannot run.
    assert.deepStrictEqual(autopayNight(d, 'f1', '2026-02-01'), [],
        'autopay must not run against a deleted family');
});

test('a hard delete takes the saved card with it', () => {
    // byopCustomerRef / stripeCustomerId / savedPaymentMethods all live ON the
    // family record, so deleting it orphans the token at the processor. A
    // refund by transaction id still works; a refund to the saved method does
    // not. Worth knowing before deleting a camper who paid by card.
    const d = steinDb();
    assert.ok(d.families.f1.savedPaymentMethods.length, 'card is on the family record');
    delete d.families.f1;
    assert.strictEqual(d.families.f1, undefined,
        'the card-on-file went with the family — nothing else holds the token');
});

// ── 5. DEFECT: the canteen balance outlives the camper, by name ────────────

/** ensureAccountsForRoster() + _reconcileBalances(), from campistry_snacks.js. */
function syncCanteen(snacks, rosterNames) {
    snacks.accounts = snacks.accounts || {};
    for (const n of rosterNames) {
        if (!snacks.accounts[n]) snacks.accounts[n] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    }
    const live = new Set(rosterNames);
    for (const n of Object.keys(snacks.accounts)) {
        if (!live.has(n)) delete snacks.accounts[n];
    }
    // _reconcileBalances: balance := the ledger, for accounts that exist.
    const byCamper = {};
    for (const t of (snacks.transactions || [])) {
        if (!t || !t.camper) continue;
        const amt = Number(t.amount) || 0;
        byCamper[t.camper] = (byCamper[t.camper] || 0) + (t.type === 'credit' ? amt : -amt);
    }
    for (const n of Object.keys(snacks.accounts)) {
        if (byCamper[n] != null) snacks.accounts[n].balance = money(byCamper[n]);
    }
    return snacks;
}

test('a parked camper keeps their canteen balance', () => {
    // getCamperList() reads every roster entry and does NOT filter on
    // `unenrolled`, so parking a camper leaves their canteen money alone. That
    // is the right call — the money is the parent's and the park is reversible.
    const snacks = syncCanteen({
        transactions: [{ camper: 'Malky Stein', type: 'credit', amount: 50 }],
    }, ['Malky Stein']);
    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 50);

    const src = read('campistry_snacks.js');
    const list = src.slice(src.indexOf('function getCamperList'),
                           src.indexOf('function loadSnacksData'));
    assert.ok(!/unenrolled/.test(list),
        'getCamperList now filters unenrolled campers — a parked camper would ' +
        'have their canteen account, and its balance, deleted by the roster sync');
});

test('DEFECT: a deleted camper’s canteen money vanishes with no record', () => {
    // The account is deleted by the roster sync. The TRANSACTIONS are not, so
    // canteen revenue still counts the deposit while the balance owed back to
    // the parent simply stops existing. Nothing flags that money was left on a
    // closed account.
    const snacks = syncCanteen({
        transactions: [{ camper: 'Malky Stein', type: 'credit', amount: 50 }],
    }, ['Malky Stein']);
    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 50);

    syncCanteen(snacks, []);                           // camper deleted
    assert.strictEqual(snacks.accounts['Malky Stein'], undefined,
        'the account is gone');
    assert.strictEqual(snacks.transactions.length, 1,
        'but the 50 dollars is still in the ledger, belonging to nobody');
});

test('DEFECT: a new camper with the same name inherits the old balance', () => {
    // Because _reconcileBalances rebuilds every balance from the transaction
    // ledger and the ledger is keyed by NAME, a fresh account for a reused name
    // is immediately overwritten with the deleted camper's balance. Two
    // unrelated children called "Malky Stein" across two summers is not exotic.
    const snacks = syncCanteen({
        transactions: [{ camper: 'Malky Stein', type: 'credit', amount: 50 }],
    }, ['Malky Stein']);
    syncCanteen(snacks, []);                           // deleted
    syncCanteen(snacks, ['Malky Stein']);              // a DIFFERENT child, same name

    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 50,
        'the new camper starts with 50 dollars of someone else’s money');
});

test('DEFECT: the cloud merge resurrects a locally-deleted account anyway', () => {
    // cloudSaveSnacks unions accounts (cloud first, local second), so the
    // roster sync's delete never reaches the cloud while another device still
    // has the account. The two defects above therefore persist rather than
    // settling either way.
    const src = read('campistry_snacks.js');
    assert.match(src, /merged\.accounts = Object\.assign\(\{\}, cloud\.accounts \|\| \{\}, data\.accounts \|\| \{\}\)/,
        'the accounts union changed — re-check whether a delete now propagates');
});

// ── 6. the note autopay leaves is the only clue an office gets ─────────────

test('the waiver note does not mention the camper leaving', () => {
    // Pinning the wording because it is load-bearing: it is the only thing an
    // office sees on a plan row that was silently closed out, and it currently
    // blames "an earlier payment" even when the real reason is that the camper
    // is no longer enrolled.
    const src = read('supabase/functions/charge-due-installments/index.ts');
    assert.match(src, /Covered by an earlier payment — not charged/,
        'the waiver note changed — if it now distinguishes a withdrawal, ' +
        'update the DEFECT test above too');
});

// ── 7. CLEARING HOUSE FOR A NEW SUMMER ────────────────────────────────────
//
// The scenario that matters most, because it is ANNUAL and ROUTINE rather than
// an edge case: the camp resets the roster for a new season while families are
// still part-way through last season's payment plan.
//
// The reset is a CSV import in REPLACE mode — importRows()'s own comment calls
// it "the only 'start fresh' action this app has". It wipes four things:
//
//     roster={}; structure={}; families={}; bunkAsgn={};
//
// `families={}` is the one that costs money. Every payment plan, every saved
// card and every family charge/credit lives ON the family record.
//
// The confirm dialog says it will "wipe all current campers, divisions, grades,
// bunks, and families". An office reads "families" as contact records. Nothing
// in the dialog mentions payment plans, saved cards or outstanding balances,
// and the archive offered in the same dialog saves none of them.

/** importRows(rows, 'replace') — the wipe, exactly as campistry_me.js does it. */
function replaceImportWipe(db) {
    db.roster = {};
    db.structure = {};
    db.families = {};          // plans, saved cards, charges, credits — all of it
    db.bunkAsgn = {};
    // NOT wiped: enrollments, finance.payments.
    return db;
}

test('the Replace wipe is exactly these four, and enrollments is not one', () => {
    const src = read('campistry_me.js');
    const wipe = src.slice(src.indexOf('═══ WIPE EXISTING DATA'),
                           src.indexOf('nextPersonId is intentionally NOT reset'));
    assert.ok(wipe.length > 0, 'the wipe block moved — re-check this test');
    for (const k of ['roster={}', 'structure={}', 'families={}', 'bunkAsgn={}']) {
        assert.ok(wipe.includes(k), `the wipe no longer clears ${k}`);
    }
    // If enrollments ever joins the wipe, the orphaned-charge behaviour below
    // changes completely and these tests need rewriting.
    assert.ok(!/\benrollments\s*=\s*\{\}/.test(wipe),
        'enrollments is now wiped too — re-derive what Billing shows');
});

test('CLEARING HOUSE: every payment plan and saved card is destroyed', () => {
    const d = steinDb();
    d.payments.push({ familyKey: 'f1', amount: 1000, status: 'succeeded' });
    assert.ok(d.families.f1.plans[0].installments.some(i => i.status === 'pending'),
        'four instalments still owed before the reset');

    replaceImportWipe(d);

    assert.deepStrictEqual(Object.keys(d.families), [],
        'the plan, the card and the balance all lived on the family record');
    // The payment history survives — see the next test for why that is load-bearing.
    assert.strictEqual(d.payments.length, 1);
});

test('CLEARING HOUSE: autopay silently stops for everyone', () => {
    // charge-due-installments iterates me.families. After the wipe there are
    // none, so it charges nobody — with no error and no log line, because the
    // loop body simply never runs. Every remaining instalment goes uncollected.
    const d = steinDb();
    assert.deepStrictEqual(autopayNight(d, 'f1', '2026-01-01').map(c => c.result),
        ['charged'], 'autopay works before the reset');

    replaceImportWipe(d);

    assert.deepStrictEqual(autopayNight(d, 'f1', '2026-02-01'), [],
        'autopay is dead — and says nothing');
    assert.deepStrictEqual(autopayNight(d, 'f1', '2026-06-01'), [],
        'and stays dead for every remaining instalment');
});

test('CLEARING HOUSE: the payment HISTORY survives the cloud write', () => {
    // The wipe also pushes campistryMe to the cloud. The lite localStorage
    // snapshot has `finance` stripped from it (integration_hooks.js:553), so a
    // naive wholesale upsert would delete every payment the camp ever took.
    // It does not, because the sync layer fetch-merges campistryMe: absent
    // top-level branches are preserved from the cloud value, and `families` is
    // overwritten only because the wipe sets it explicitly to {}.
    const hooks = read('integration_hooks.js');
    assert.ok(hooks.includes("const FETCH_MERGE_KEYS = ['app1', 'campistryMe']"),
        'the fetch-merge guard is gone — a Replace import would now wipe the ' +
        'entire payment history along with the families');
    assert.ok(hooks.includes('{ ...cur.value, ...changesToSync[mergeKey] }'),
        'the shallow merge changed shape');
    assert.ok(hooks.includes('delete lite.campistryMe.finance'),
        'finance is no longer stripped from the lite snapshot — if that is ' +
        'deliberate the guard above matters less, but re-check both together');
});

test('CLEARING HOUSE: last season’s charge reappears on a synthetic ledger', () => {
    // enrollments is NOT wiped, so last season's 'enrolled' rows survive with
    // no camper and no family behind them. buildFamilyLedgers does not drop
    // them — _resolveFamilyKeyExact finds no family, so each one lands on an
    // ephemeral `pending_<lastname>_<eid>` ledger instead.
    //
    // The PAYMENTS do not follow: a payment is matched by
    // `(p.familyKey && families[p.familyKey]) ? p.familyKey : _payFamilyByName(p)`,
    // and after the wipe neither branch resolves to that synthetic key. So the
    // charge shows on one ledger and the money shows as unmatched — the family
    // reads as owing the whole tuition again.
    const src = read('campistry_me.js');
    const build = src.slice(src.indexOf('function buildFamilyLedgers'));

    assert.ok(build.includes("fk='pending_'+lastName.toLowerCase()"),
        'the synthetic pending ledger is gone — an orphaned charge would now ' +
        'vanish from Billing entirely');
    assert.ok(build.includes('var fk=(p.familyKey&&families[p.familyKey])?p.familyKey:_payFamilyByName(p)'),
        'payment matching changed — re-check whether payments can now reach a ' +
        'synthetic ledger');
});

test('CLEARING HOUSE: the season archive saves nothing financial', () => {
    // archive_camp_season is offered in the same dialog as the wipe, which
    // reads as "your history is safe". It snapshots attendance and
    // demographics only.
    const sql = read('migrations/088_camp_person_seasons.sql');
    const fn = sql.slice(sql.indexOf('archive_camp_season'));
    for (const field of ['division', 'grade', 'bunk', 'parentEmail']) {
        assert.ok(fn.includes(`'${field}'`), `the archive no longer saves ${field}`);
    }
    for (const money of ['plans', 'balance', 'installments', 'cardOnFile', 'payments']) {
        assert.ok(!fn.includes(`'${money}'`),
            `the archive now saves ${money} — if season rollover was fixed, ` +
            `rewrite these tests`);
    }
});
