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
// Tests marked FIXED assert the behaviour AFTER migrations 171/172 and the
// campistry_billing_core.js rewrite: the family record is a billing account, so
// a debt survives a camper being removed and survives the annual roster reset.
// Their earlier versions pinned the defect instead; they were rewritten when the
// fix landed, which is what these files are for.
//
// Tests still marked DEFECT are genuinely open — D2 (rescind deletes the audit
// record it promises) and D3/D4 (the canteen balance, which is the same
// principle not yet applied to campistrySnacks).

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

test('LEGACY PATH ONLY: re-enrolling after a parked spell leaves a gap', () => {
    // STILL TRUE for a plan that has not been converted by
    // convert_family_ledgers, which is why this stays pinned — but it is no
    // longer how a converted plan behaves. The ledger path derives the amount
    // from the balance and has no instalment status to write, so the equivalent
    // scenario collects in full; see "D1 FIXED" in tests/billing_core.test.js.
    //
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

test('FIXED: a rescinded application IS kept, marked Withdrawn', () => {
    // Was D2. The dialog promises "the application stays here marked Withdrawn
    // for the audit trail" and it did not: cascadeCamperDelete deletes every
    // enrollment matching the camper name, so the status flip that followed
    // mutated an object already detached from the map and save() never saw it.
    // rescindEnrollment now re-inserts the terminal copy.
    const src = read('campistry_me.js');

    // The cascade deletes unconditionally. Anchored FORWARD from the cascade —
    // `async function deleteCamper` also matches deleteCamperFromEdit earlier in
    // the file, which silently produced an empty slice and a passing test.
    const cascadeAtSrc = src.indexOf('function cascadeCamperDelete');
    assert.ok(cascadeAtSrc > 0, 'cascadeCamperDelete is gone — re-check this test');
    const cascade = src.slice(cascadeAtSrc,
                              src.indexOf('async function deleteCamper(n)', cascadeAtSrc));
    assert.ok(cascade.length > 0, 'empty slice — the anchors moved');
    // Re-anchored: the delete grew a tombstone beside it (see
    // tests/public_submission_clobber.test.js) so it is a block now, not one line.
    // What this test cares about is unchanged — the cascade still deletes, which is
    // why rescindEnrollment has to put the withdrawn record back.
    // The match is by camper number now (_enrIsFor), by name only for an
    // enrollment that has no number.
    assert.match(cascade, /if\((?:e&&e\.camperName===name|e&&_enrIsFor\(e,name\))\)\{\s*\n\s*delete enrollments\[eid\];/,
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

    // The re-insert is what makes the promise good.
    assert.match(rescind, /if\(!enrollments\[id\]\)enrollments\[id\]=e;/,
        'the withdrawn record is not put back — the audit trail is lost again');
    const reinsert = rescind.indexOf('if(!enrollments[id])enrollments[id]=e;');
    assert.ok(reinsert > flipAt, 'the re-insert must come after the status flip');

    // Model it end to end.
    const enrollments = { e1: { camperName: 'Malky Stein', status: 'enrolled' } };
    const id = 'e1';
    const e = enrollments[id];
    Object.keys(enrollments).forEach(k => {          // cascadeCamperDelete
        if (enrollments[k].camperName === 'Malky Stein') delete enrollments[k];
    });
    e.status = 'withdrawn';
    if (!enrollments[id]) enrollments[id] = e;        // the fix
    assert.deepStrictEqual(Object.keys(enrollments), ['e1'],
        'the audit record the dialog promises must survive');
    assert.strictEqual(enrollments.e1.status, 'withdrawn',
        'and must be terminal, so Billing’s charge scan skips it');
});

// ── 4. a hard delete drops the family record, and with it the card ─────────

test('FIXED: deleting the last camper KEEPS a family that owes money', () => {
    // cascadeCamperDelete used to delete a family the moment camperIds emptied,
    // because buildFamilyLedgers renders ANY families[] entry and an empty one
    // would sit in Billing forever as a $0 "Paid" card. That reason does not
    // apply to an account with a HISTORY, so the delete is now conditional.
    const d = steinDb();
    d.payments.push({ familyKey: 'f1', amount: 500, status: 'succeeded' });

    // cascadeCamperDelete('Malky Stein'), as it is now
    const hasMoney = f => !!(f && ((f.plans || []).length || f.cardOnFile ||
        (f.charges || []).length || (f.entries || []).length ||
        (f.savedPaymentMethods || []).length));
    Object.keys(d.families).forEach(fk => {
        const f = d.families[fk];
        f.camperIds = f.camperIds.filter(c => c !== 'Malky Stein');
        if (f.camperIds.length === 0 && !hasMoney(f)) { delete d.families[fk]; return; }
        if (f.camperIds.length === 0) f.formerCamper = true;
    });
    Object.keys(d.enrollments).forEach(id => {
        if (d.enrollments[id].camperName === 'Malky Stein') delete d.enrollments[id];
    });

    assert.ok(d.families.f1,
        'the family record must survive — it is a billing account, and the ' +
        'parent still owes money (migration 070 already keeps their portal login ' +
        'alive; before this it had nothing to resolve to)');
    assert.strictEqual(d.payments.length, 1, 'the payment record survives too');
    assert.ok(d.families[d.payments[0].familyKey],
        'and the payment still points at a family that exists');
});

test('FIXED: a hard delete no longer orphans the saved card', () => {
    // The token still lives on the family record, which is fine now that the
    // record is not deleted while it carries money — so a refund to the saved
    // method keeps working after the camper is gone.
    const d = steinDb();
    assert.ok(d.families.f1.savedPaymentMethods.length, 'card is on the family record');
    const src = read('campistry_me.js');
    assert.match(src, /if\(f\.camperIds\.length===0&&!_familyHasMoney\(f\)\)/,
        'the delete is unguarded again — the token would be orphaned');
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
        if (live.has(n)) { delete snacks.accounts[n].closed; continue; }
        const a = snacks.accounts[n];
        // Closed, not deleted, whenever it holds money — see canteen_identity.
        if (Math.abs(money(a.balance)) < 0.005) { delete snacks.accounts[n]; continue; }
        a.closed = true;
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

/** _reconcileBalances() as it is now: id first, unidentified-by-name as fallback. */
function reconcileById(snacks) {
    const byId = {}, byNameNoId = {};
    for (const t of (snacks.transactions || [])) {
        const amt = Number(t.amount) || 0;
        const signed = (t.type === 'credit' ? amt : -amt);
        const hasId = (t.camperId != null && t.camperId !== '');
        if (hasId) byId[t.camperId] = (byId[t.camperId] || 0) + signed;
        else if (t.camper) byNameNoId[t.camper] = (byNameNoId[t.camper] || 0) + signed;
    }
    for (const n of Object.keys(snacks.accounts || {})) {
        const a = snacks.accounts[n];
        const idSum = a.camperId != null ? byId[a.camperId] : undefined;
        const nameSum = a.camperId != null ? byNameNoId[n] : byNameNoId[n];
        if (idSum == null && nameSum == null) continue;
        a.balance = money((idSum || 0) + (nameSum || 0));
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

test('FIXED: a departed camper’s canteen money is closed, not deleted', () => {
    // Was D3. ensureAccountsForRoster deleted the account of anyone off the
    // roster, taking whatever money was on it, while the transactions stayed —
    // so canteen revenue still counted the parent's deposit and the balance owed
    // back to them stopped existing. It is now CLOSED and kept; the full
    // behaviour is covered in tests/canteen_identity.test.js.
    const snacks = syncCanteen({
        transactions: [{ camper: 'Malky Stein', type: 'credit', amount: 50 }],
    }, ['Malky Stein']);
    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 50);

    syncCanteen(snacks, []);                           // camper off the roster
    assert.ok(snacks.accounts['Malky Stein'],
        'the account must survive — the balance is the parent\u2019s money');
    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 50);
    assert.strictEqual(snacks.accounts['Malky Stein'].closed, true,
        'and be flagged closed so the office can refund or apply it');
    assert.strictEqual(snacks.transactions.length, 1, 'the ledger is untouched');
});

test('FIXED: a new camper with the same name no longer inherits the balance', () => {
    // Was D4. _reconcileBalances rebuilt balances from a ledger keyed by NAME, so
    // a fresh account for a reused name was immediately overwritten with the
    // deleted camper's balance. Transactions now carry camperId and an identified
    // account only counts its own id plus UNIDENTIFIED legacy rows — never
    // another camper's. Covered properly in tests/canteen_identity.test.js.
    // Identified history belonging to camper 101...
    const snacks = { accounts: {}, transactions: [
        { camper: 'Malky Stein', camperId: 101, type: 'credit', amount: 50 },
    ] };
    // ...and a DIFFERENT child, same name, arriving later.
    snacks.accounts['Malky Stein'] = { balance: 0, camperId: 777 };
    reconcileById(snacks);
    assert.strictEqual(snacks.accounts['Malky Stein'].balance, 0,
        'camper 777 must not inherit camper 101\u2019s 50 dollars');
});

test('the cloud merge UNIONS accounts, which is now the right thing', () => {
    // This used to compound D3/D4: the roster sync's delete never reached the
    // cloud while another device still held the account, so an orphan flickered
    // depending on which device saved last. Now that a funded account is closed
    // rather than deleted, a cloud-first union is exactly what should happen —
    // it can only ever preserve an account, never lose one.
    const src = read('campistry_snacks.js');
    assert.match(src, /merged\.accounts = Object\.assign\(\{\}, cloud\.accounts \|\| \{\}, data\.accounts \|\| \{\}\)/,
        'the accounts union changed — re-check that a closed account still survives a merge');
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
    // Mirrors campistry_me.js after the fix: a family that carries money is KEPT
    // as a billing account with its camper links cleared; only an empty one is
    // dropped. tests/billing_wiring.test.js asserts the real code does this.
    for (const fk of Object.keys(db.families)) {
        const f = db.families[fk];
        const hasMoney = !!(f && ((f.plans || []).length || f.cardOnFile ||
            (f.charges || []).length || (f.entries || []).length));
        if (!hasMoney) { delete db.families[fk]; continue; }
        f.camperIds = [];
        f.formerCamper = true;
    }
    db.bunkAsgn = {};
    // NOT wiped: enrollments, finance.payments.
    return db;
}

test('FIXED: the Replace wipe no longer clears families', () => {
    // This test used to assert `families={}` was IN the wipe list. It is not any
    // more: migrations 171/172 made the family record a billing account, and the
    // reset now keeps any account that carries money (see tests/billing_wiring).
    const src = read('campistry_me.js');
    const wipe = src.slice(src.indexOf('═══ WIPE EXISTING DATA'),
                           src.indexOf('nextPersonId is intentionally NOT reset'));
    assert.ok(wipe.length > 0, 'the wipe block moved — re-check this test');
    for (const k of ['roster={}', 'structure={}', 'bunkAsgn={}']) {
        assert.ok(wipe.includes(k), `the wipe no longer clears ${k}`);
    }
    // Anchored on a STATEMENT, not a substring — the surrounding comment
    // mentions `families={}` precisely to explain why it is gone, and matching
    // that comment is what made an earlier version of this test pass wrongly.
    assert.ok(!/^\s*families=\{\};\s*$/m.test(wipe),
        'families={} is back — the annual reset destroys every payment plan again');
    assert.ok(!/\benrollments\s*=\s*\{\}/.test(wipe),
        'enrollments is now wiped too — re-derive what Billing shows');
});

test('FIXED: clearing house KEEPS every plan, card and balance', () => {
    const d = steinDb();
    d.payments.push({ familyKey: 'f1', amount: 1000, status: 'succeeded' });
    assert.ok(d.families.f1.plans[0].installments.some(i => i.status === 'pending'),
        'four instalments still owed before the reset');

    replaceImportWipe(d);

    assert.deepStrictEqual(Object.keys(d.families), ['f1'],
        'a family that carries money must survive the annual reset');
    assert.ok(d.families.f1.plans.length, 'the payment plan survives');
    assert.ok(d.families.f1.cardOnFile, 'the saved card survives');
    assert.deepStrictEqual(d.families.f1.camperIds, [],
        'its camper links are cleared — it is a billing account now, not a roster row');
    assert.strictEqual(d.families.f1.formerCamper, true);
    assert.strictEqual(d.payments.length, 1, 'and the payment history is untouched');
});

test('FIXED: clearing house does not silently stop autopay', () => {
    // charge-due-installments iterates me.families. After the wipe there are
    // none, so it charges nobody — with no error and no log line, because the
    // loop body simply never runs. Every remaining instalment goes uncollected.
    const d = steinDb();
    assert.deepStrictEqual(autopayNight(d, 'f1', '2026-01-01').map(c => c.result),
        ['charged'], 'autopay works before the reset');

    replaceImportWipe(d);

    // The family record — and therefore the plan and the card — is still there,
    // so the runner can still find it. What it charges is now derived from the
    // posted ledger rather than a frozen instalment (migration 172), which
    // tests/billing_core.test.js covers directly.
    assert.ok(d.families.f1, 'the runner has a family to find');
    assert.ok(d.families.f1.plans[0].autopay, 'and a live plan on it');
    assert.ok(d.families.f1.cardOnFile, 'and a card to charge');
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
