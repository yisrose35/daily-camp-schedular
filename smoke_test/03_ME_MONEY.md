# Part 3 — Campistry Me: Billing, Payroll & Finance

**This part moves real money.** Run it on a throwaway camp, with a processor in
test mode where one exists, and with small amounts. Do not hand-trigger
`charge-due-installments` — it runs against every camp in the Supabase project.

Covers: the family ledger, charges, credits and refunds, payments, statements and
tax statements, A/R aging, cards on file, pay links, payment plans and autopay,
registration deposits, card fees and surcharges, the Zelle/ACH bank-deposit inbox,
chargebacks and collection blocks, dunning, Payroll (staff, timesheets, Youth
Corps, pay runs, tip payments), and Finance (expenses, budget, exports).

**Files:** `campistry_me.js`, `campistry_billing_core.js`, `campistry_payments.js`,
`campistry_deposit_policy.js`, `campistry_cancellation_policy.js`,
`campistry_sibling_discount.js`, `campistry_tax_statement.js`, `campistry_card_fees.js`,
`campistry_card_capture.js`, `campistry_deposit_parser.js`, `campistry_deposit_match.js`,
`campistry_deposit_template.js`, `campistry_deposit_teach_pdf.js`, `campistry_deposits_ui.js`,
`campistry_payroll_core.js`, `campistry_finance_merge.js`.

**Read first:** `BILLING_OUTLIVES_ENROLLMENT_DESIGN.md`, `BYOP_SETUP.md`,
`TEST_PLAN_ENTITLEMENTS_MONEY.md` (an earlier plan — its Part B is still open and
overlaps here; cite it rather than duplicating it).

---

## 3.0 — The invariants everything else is measured against

Every card in this part exists to defend one of these. Check them at the start,
and again at the end of the part.

| # | Invariant | How to prove it |
|---|---|---|
| **I1** | **The ledger is append-only.** A posted charge is a fact. Nothing removes it; a reversal is a new credit entry. | Post a charge, then try to make it disappear (delete camper, rescind, unenroll). The charge must still be there with a credit beside it. |
| **I2** | **Every payment posts to the ledger.** No payment on any path — office entry, pay link, autopay, hosted checkout, saved card, Zelle — exists outside it. | `select count(*) from …` compare payment rows to ledger rows. Migration `178_every_payment_posts_to_the_ledger.sql`. |
| **I3** | **Balance parity.** What Me shows a family owes equals what the parent portal shows. | Me → Billing → family balance, vs the parent portal's Payments screen, vs `select get_my_balance(...)`. Migration `166_balance_parity.sql`. |
| **I4** | **Writes are atomic.** Two simultaneous payments cannot lose one. | BRK-12 in Part 9. Migrations 168/169/170. |
| **I5** | **Money is never sandboxed.** Every money action inside a session plan refuses at the door, before a form opens. | Part 8, and R2 of `SANDBOX_TEST_PLAN.md`. |
| **I6** | **Billing outlives enrollment.** A family who owes money can always be reached and can always pay. | ME-R-15 in Part 1. |

| | |
|---|---|
| **ME-B-00 ★ CORE Do** | Before touching anything, record for one seed family: the balance in Me, the balance in the parent portal, and `get_my_balance`'s answer. |
| **Expect** | Three identical numbers. |
| **Sev** | S1 |

---

## 3.1 — The Billing page

#### ME-B-01 ★ CORE — The family list

| | |
|---|---|
| **Do** | Me → Billing. Filter All / Outstanding / Paid / Overdue. Search a family. Page through. |
| **Expect** | Every enrolled family has a card. Totals add up. An empty household with no money does **not** appear as a $0 "Paid" card. |
| **If it fails** | `renderBilling` (14191), `buildFamilyLedgers` (12731), `setBillFilter` (14542). |
| **Sev** | S2 |

#### ME-B-02 — The family detail page

| | |
|---|---|
| **Do** | Open one family. Read every section: charges, credits, payments, installment schedule, card on file, autopay state, collection warning. |
| **Expect** | Each entry has a date, description and amount. The running balance is arithmetically correct — add the column yourself. |
| **If it fails** | `renderFamilyDetailPage` (14341), `_installmentTableHtml` (14520), `_collectionWarning` (14130). |
| **Sev** | S1 if the arithmetic is wrong. |

#### ME-B-03 ★ CORE — Add a charge

| | |
|---|---|
| **Do** | Add a $100 charge with a description. Then try: $0, `-50`, `1.005`, `1,234.56`, `1e6`, `abc`, and an empty description. |
| **Expect** | $100 posts. Zero and negative refused (a negative charge is a credit and has its own button). Three decimals rounded or refused — say which. A comma-formatted number either parsed or refused, never read as `1`. |
| **Verify** | The posted ledger entry, and that the parent portal's balance moves by exactly $100. |
| **If it fails** | `addCharge` (14608), `addChargeForFamily` (14611), `campistry_billing_core.js`. |
| **Sev** | S1 |

#### ME-B-04 ★ CORE — Record a payment

| | |
|---|---|
| **Do** | Record a $60 payment by cheque with a reference. Then by cash. Then by a method the camp has **not** ticked as accepted. |
| **Expect** | The balance drops by $60. The disallowed method is refused. A cheque is stored the way it was written (see commit *"A CHECK is not stored the way it was written"*). |
| **Verify** | I2 — the payment exists in the posted ledger, not only in the payments list. |
| **If it fails** | `openPaymentModal` (14552), `_postPaymentEntry` (3785), `campistry_payments.js`. |
| **Sev** | S1 |

#### ME-B-05 — Remove a payment

| | |
|---|---|
| **Do** | Remove a recorded payment. |
| **Expect** | Confirmation. The ledger shows a reversal, not a hole — I1. Balance corrects. |
| **If it fails** | `removePayment` (15206). |
| **Sev** | S1 |

#### ME-B-06 ★ CORE — Credits and refunds

| | |
|---|---|
| **Do** | Issue each of the three types (credit / refund-to-card / write-off — the modal names them). Refund $20 of a $60 card payment. Then try to refund $100 of it. Then refund the remaining $40. Then try again. |
| **Expect** | Partial refunds allowed and tracked. Over-refund refused with the remaining amount named. The second full refund exhausts it; a third is refused. |
| **Verify** | Refunds appear on the processor side too, not just in Campistry. |
| **If it fails** | `issueCredit` (14881), `_famRefundablePayments` (14651), `_crUpdateRefundSummary` (14733). |
| **Sev** | S1 |

#### ME-B-07 ★ CORE — The 120-day refund window

| | |
|---|---|
| **Do** | Find (or fabricate, by editing a payment's date in the blob on a throwaway camp) a card payment older than 120 days, and one at ~105 days. Try to refund each. |
| **Expect** | The 105-day one is refundable **with a warning** (the warn threshold is 100 days). The 120+ day one is **excluded from the refundable pool entirely** and reported separately, telling the office to send a cheque — not offered and then rejected by the gateway in front of a family. |
| **Expect also** | A multi-payment refund draws **newest first**, deliberately the opposite of how a payment applies to charges (oldest first), so the remaining refund window is not burned on charges that would have worked. |
| **If it fails** | `REFUND_WINDOW_DAYS` (~14663), `_famRefundableOnline` (14693), `_famRefundExpired` (14713). |
| **Sev** | S1 |

#### ME-B-08 — Statements

| | |
|---|---|
| **Do** | Print a statement for a family with charges, payments, credits and a plan. Print one for a family with nothing. |
| **Expect** | A readable statement whose closing balance matches Billing. The empty one does not crash. |
| **If it fails** | `printStatement` (15034). |
| **Sev** | S3 |

#### ME-B-09 ★ CORE — Tax statement

| | |
|---|---|
| **Do** | Print the tax statement for a family whose payments **span two calendar years**, with two children, some of it non-qualifying. |
| **Expect** | Only the selected year's payments. Split per child. Qualifying vs non-qualifying separated. The camp's name, address and EIN present. |
| **Verify** | `select tax_id from camps where id='<UUID>';` — migrations 119/121. |
| **If it fails** | `printTaxStatement` (15106), `campistry_tax_statement.js`, `tests/tax_statement.test.js`. |
| **Sev** | S2 — a wrong number here goes on a parent's IRS Form 2441. |

#### ME-B-10 — A/R aging

| | |
|---|---|
| **Do** | Open the aging view with invoices of various ages. |
| **Expect** | Buckets by age, and the bucket totals sum to total outstanding. |
| **If it fails** | A/R AGING block (12052). |
| **Sev** | S3 |

---

## 3.2 — Cards, pay links, plans and autopay

Branch on the camp's processor (PRE-05). Run the branch that applies and mark the
others *not applicable*.

#### ME-B-11 ★ CORE — Request a card on file

| | |
|---|---|
| **Do** | **Request card setup** for a family. Open the link the parent gets, in a private window. Save a test card. |
| **Expect** | Stripe → Stripe's own hosted page. Banquest / Cardknox → Campistry's card page (`campistry_card_setup.html`), never a card field rendered by Campistry for Banquest. No processor → the button is not offered, or says so. |
| **Verify** | `select * from saved_payment_methods where camp_id='<UUID>';` and the card shows on the family card in Me. |
| **If it fails** | `requestCardSetup` (15321), `card-capture-start` / `payments-save-method`, `campistry_card_setup.html`, `get_camp_public_tokenization_key`, migrations 128/136/139/151. |
| **Sev** | S1 |

#### ME-B-12 ★ CORE — Charge the stored card

| | |
|---|---|
| **Do** | **Charge stored card** for $25. Then double-click it. Then charge a family with **no** card. Then charge a card you have deliberately expired. |
| **Expect** | One charge, one ledger entry, one receipt. The double-click does **not** produce two charges. No card → refused clearly. Expired card → the gateway's decline is shown in plain language, and dunning records it. |
| **Verify** | The processor's dashboard: exactly one charge. Migration `170_atomic_card_on_file_writes.sql`, `179_dunning_and_card_expiry.sql`. |
| **If it fails** | `chargeStoredCard` (15386), `charge-saved-card`. |
| **Sev** | S1 |

#### ME-B-13 — Batch charge

| | |
|---|---|
| **Do** | Batch-charge several families at once, where one of them has no card and one has a collection block. |
| **Expect** | The ones that can be charged are; the others are reported individually with the reason. No partial silent failure. |
| **If it fails** | `batchCharge` (15475), `175_chargebacks_and_collection_blocks.sql`. |
| **Sev** | S1 |

#### ME-B-14 ★ CORE — Pay link

| | |
|---|---|
| **Do** | **Send pay link** to a family. Open it as the parent in a private window and pay. Then open the same link again and try to pay a second time. |
| **Expect** | The first payment posts and the balance drops. The second attempt either reflects the now-zero balance or refuses. A paid link must not silently take money twice. |
| **If it fails** | `sendPayLink` (15526), `payments-hosted-link` / `payments-hosted-complete`. |
| **Sev** | S1 |

#### ME-B-15 ★ CORE — Build a payment plan

| | |
|---|---|
| **Do** | Create a monthly plan on a $1,000 balance over 3 installments. Then over 7 (so it does not divide evenly). Then weekly. Then biweekly. Then with a start date in the past. |
| **Expect** | Installments sum **exactly** to the balance — the rounding remainder lands on one installment, not lost or duplicated. Weekly/biweekly step by exact days; monthly steps by month. A past start date is handled explicitly. |
| **Verify** | Add the installment column. It must equal the balance to the cent. |
| **If it fails** | `monthlyPlan` (15761), `_mpGenRows` (15656), `_mpStepDate` (15647), `_buildInstallmentSchedule` (11814), migrations 115-118, 181. |
| **Sev** | S1 |

#### ME-B-16 ★ CORE — Autopay

| | |
|---|---|
| **Do** | Turn on autopay for a family with a card and a plan. |
| **Expect** | The parent portal shows autopay on. The next installment is marked for automatic collection. |
| **Verify** | `select * from …` the plan rows; migration `169_atomic_autopay_installment.sql`, `172_autopay_posts_to_ledger.sql`. |
| **If it fails** | `toggleFamilyAutopay` (15896), `charge-due-installments`. |
| **Sev** | S1 |

#### ME-B-17 ★ CORE — The stale-tab clobber (hazard #1)

This is the single most important card in Part 3.

| | |
|---|---|
| **Do** | Open Me → Billing in **Tab A** and leave it open. In **Tab B** (or via the parent portal), take a payment against the same family. Now, in **Tab A**, without reloading, make an unrelated edit — rename a camper, add a note — and let it save. |
| **Expect** | The payment made in Tab B is **still there** after Tab A's save. The console in Tab A logs `campistryMe: kept server-written money out of the clobber — 1 payment(s)…`. |
| **Verify** | Reload both tabs. The payment exists, the installment is still marked paid, and the card-on-file fields are intact. |
| **If it fails** | `campistry_finance_merge.js`, and the ★ comment at `integration_hooks.js:897`. A missing merge means a family is charged again the next night. |
| **Sev** | S1 |

#### ME-B-18 — Cancel a plan mid-run

| | |
|---|---|
| **Do** | Cancel a plan after one installment has been paid. |
| **Expect** | Paid installments stay paid. Remaining ones are cancelled, not deleted from history. The balance still reflects what is genuinely owed. |
| **If it fails** | `cancelMonthlyPlan` (15905). |
| **Sev** | S1 |

#### ME-B-19 — Chargebacks and collection blocks

| | |
|---|---|
| **Do** | If the processor supports it, trigger a test dispute. Otherwise inspect the UI for a family flagged with a chargeback. |
| **Expect** | The disputed amount comes off the balance correctly (migration `177_chargeback_amount_from_payment.sql`), a collection block appears, and charging that family is refused with the reason. |
| **If it fails** | `byop-dispute-webhook`, `stripe-connect-webhook`, migration 175, `tests/chargeback_and_blocks.test.js`. |
| **Sev** | S1 |

#### ME-B-20 — Card fees / surcharge / cash discount

| | |
|---|---|
| **Do** | Configure each of the three modes in turn. Then take a card payment and a cheque payment. |
| **Expect** | The fee is shown to the parent **before** they pay, computed on the right base, and posted as its own ledger line. A cash-discount camp shows the discount, not a surcharge. |
| **If it fails** | `campistry_card_fees.js`, `_cfCardHtml` (16203), `tests/card_fees.test.js`, migration `192_card_fee_policy.sql`. |
| **Sev** | S1 — these are card-brand rules, not preferences. |

#### ME-B-21 — Sibling discount re-pricing

| | |
|---|---|
| **Do** | Family with three children, sibling discount configured. Withdraw the middle one. Then add a fourth. |
| **Expect** | The discount is recomputed from the family **as it is now** — not granted once at enrollment and never revisited. |
| **If it fails** | `_resyncSiblingDiscounts` (3632), `campistry_sibling_discount.js`, `tests/cancellation_and_sibling.test.js`. |
| **Sev** | S1 |

#### ME-B-22 — Scholarships and financial aid

| | |
|---|---|
| **Do** | Award a scholarship to a camper and check the family balance. |
| **Expect** | The aid reaches the ledger — it is not merely displayed on screen while the family is billed the full amount (that was a real defect: commit *"Aid was awarded, shown on screen, and billed for anyway"*). |
| **If it fails** | `addScholarship` (18344), `tests/aid_and_credits_reach_the_ledger.test.js`. |
| **Sev** | S1 |

---

## 3.3 — Registration deposits

#### ME-B-23 — Deposit policy

| | |
|---|---|
| **Do** | Configure a deposit as flat, then as a percentage, then as a per-session amount. Set "won't look at the application until paid" on and off. |
| **Expect** | All three shapes compute correctly on the public form (Part 2), and the gate behaves. |
| **If it fails** | `campistry_deposit_policy.js`, `_depPolicy` (15989), `tests/deposit_policy.test.js`, migration `164_public_deposit_policy.sql`. |
| **Sev** | S2 |

#### ME-B-24 — Mark paid / charge now

| | |
|---|---|
| **Do** | On an application with a deposit due: **Mark Deposit Paid** (manual), then on another, **Charge Deposit Now** (card). |
| **Expect** | Both post to the ledger. Marking paid by hand is an audited manual entry — see commit *"A card deposit is collected, not ticked off by hand"* for why the card path exists. |
| **If it fails** | `markDepositPaid` (16025), `chargeDepositNow` (16057). |
| **Sev** | S1 |

---

## 3.4 — The bank deposit inbox (Zelle / ACH)

Needs migrations 145, 145a, 146, 147, 148, 150, 151, 163. Skip cleanly if absent.

#### ME-B-25 ★ CORE — The deposit address

| | |
|---|---|
| **Do** | Billing → Bank Deposits → Deposit Settings. Read the address the camp is told to use. |
| **Expect** | `deposits+<token>@inbound.campistry.org`. |
| **Verify** | That the domain matches what Resend Inbound actually receives on — it is hard-coded as `window.CAMPISTRY_INBOUND_DOMAIN` in `campistry_me.html`. **A wrong value here hands every camp an address that silently receives nothing.** |
| **Sev** | S1 |

#### ME-B-26 — Parse and match

| | |
|---|---|
| **Do** | Forward a real bank alert to the address. Then forward: the same alert twice; a **quoted/forwarded** alert with `>` prefixes; one whose amount matches two different families; one from a bank with no learned template; a scanned-image PDF with no text layer. |
| **Expect** | A real alert is parsed and matched to a family, previewed before posting. Duplicates deduped. Ambiguous amounts held for a human. An unknown bank goes to "unparsed" with an offer to **teach** the layout. A scanned PDF fails with a message, not a hang. |
| **If it fails** | `campistry_deposit_parser.js`, `campistry_deposit_match.js`, `campistry_deposit_template.js`, `deposit-inbox`, `tests/deposit_*.test.js`, `ZELLE_ACH_DEPOSITS_SETUP.md`. |
| **Sev** | S1 |

#### ME-B-27 — Teach a template

| | |
|---|---|
| **Do** | Teach a layout from a printed email PDF, then forward another alert from the same bank. |
| **Expect** | The second one parses automatically. |
| **If it fails** | `campistry_deposit_teach_pdf.js`, migrations 147/148/150. |
| **Sev** | S3 |

#### ME-B-28 — Unmatched payments

| | |
|---|---|
| **Do** | Open **Unmatched Payments** and assign one to a family. |
| **Expect** | It posts to that family's ledger and leaves the unmatched list. |
| **If it fails** | `openUnmatchedPaymentsModal` (14812). |
| **Sev** | S2 |

---

## 3.5 — Payroll

#### ME-P-01 ★ CORE — Payroll is its own key

| | |
|---|---|
| **Do** | Make a payroll edit. Check the cloud. |
| **Expect** | It writes to **`campistryMePayroll`**, not `campistryMe` (split by migration 158). |
| **Verify** | `select key, updated_at from camp_state_kv where camp_id='<UUID>' and key like 'campistryMe%';` |
| **If it fails** | `save` (566) — the load-flag guards `_loadedPayroll` / `_loadedFinance` exist so an absent key is never overwritten with defaults. If payroll ever vanishes after a Me save, this is why. `tests/key_split_payroll_finance.test.js`. |
| **Sev** | S1 |

#### ME-P-02 — Staff records

| | |
|---|---|
| **Do** | Payroll → Staff. Edit a record: pay type (hourly/salary/stipend), rate, address, documents, summer-only toggle, Youth Corps toggle. Remove one. |
| **Expect** | Saves. The pay-type hint explains each. |
| **If it fails** | `prEditStaff` (13643), `prToggleYc` (13762), `prPayTypeHint` (13766). |
| **Sev** | S2 |

#### ME-P-03 ★ CORE — Timesheets

| | |
|---|---|
| **Do** | Open a week. Enter hours. Step back and forward a week. Jump to today. Sign a sheet. Change its status. Then enter: 25 hours in one day; negative hours; `8.5`; `8:30`; a week that **crosses a daylight-saving change**. |
| **Expect** | Normal hours save. 25 in a day refused or flagged. Negative refused. A DST week still has 7 days and the right dates. |
| **If it fails** | `_prTimesheetsTab` (13801), `prSetHours` (13857), `_prWeekStart` (13111), `_prShiftWeek` (13117). |
| **Sev** | S2 |

#### ME-P-04 ★ CORE — Youth Corps hour caps

| | |
|---|---|
| **Do** | Set up the Youth Corps program. Enter hours for a minor that exceed the daily and weekly caps. |
| **Expect** | The over-hours condition is flagged clearly. These are youth-employment rules, not preferences. |
| **If it fails** | `campistry_payroll_core.js`, `_prYouthTab` (13894), `tests/payroll_core.test.js`. |
| **Sev** | S1 — this is a compliance control. |

#### ME-P-05 — Pay runs

| | |
|---|---|
| **Do** | Create a pay run. Export it. Delete it after exporting. |
| **Expect** | The run totals match the timesheets. Deleting after export warns that the export is already out. |
| **If it fails** | `prNewRun` (14036), `prExportCSV` (14076), `prDeleteRun` (14063). |
| **Sev** | S2 |

#### ME-P-06 ★ CORE — Tip payments

| | |
|---|---|
| **Do** | Payroll → Tip Payments. Connect a staff member to Stripe Connect. Copy their access code link. Upload the staff-payment CSV template. Pay out a balance. Remove an account. |
| **Expect** | Connect onboarding completes and the status cell updates on return. The staff member can open `campistry_link_staff.html`, enter their code, and see the balance. Payout reduces it. |
| **Verify** | `select * from …` tip accounts; the staff page's `get_staff_tip_account` returns the same numbers. Migrations 016, 017, 043, 057, 060, 078, 182. |
| **If it fails** | `ptConnectStripe` (13300), `ptPayout` (13350), `_ptCheckStripeReturn` (13321), `TIPPING_SETUP.md`. |
| **Sev** | S1 |

#### ME-P-07 — Tip payment abuse

| | |
|---|---|
| **Do** | Upload a CSV with a duplicate staff row, a row for a person who doesn't exist, an empty handle, and a Venmo handle of `@` alone. Pay out more than the balance. Pay out $0. |
| **Expect** | Each refused with a message naming the row. Over-payout refused. |
| **If it fails** | `_ptParseCsv` (13468), `ptUploadTemplate` (13481), `ptPayout` (13350). |
| **Sev** | S1 |

---

## 3.6 — Finance

#### ME-F-01 — Tabs and totals

| | |
|---|---|
| **Do** | Finance → each tab. Add an expense, a payment, a staff cost. Set the budget and the overdue threshold. |
| **Expect** | Totals and the budget comparison update. It writes to **`campistryMeFinance`**. |
| **If it fails** | `renderFinance` (11909), `finSetTab` (12304), `finSetBudget` (12526). |
| **Sev** | S2 |

#### ME-F-02 ★ CORE — Reconcile processor charges

| | |
|---|---|
| **Do** | **Reconcile Charges** after taking a few card payments. |
| **Expect** | Campistry's records and the processor's agree, and anything that doesn't is listed individually. |
| **If it fails** | `finReconcileCharges` (12315), migration `162_reconcile_processor_charges.sql`. |
| **Sev** | S1 |

#### ME-F-03 — Exports

| | |
|---|---|
| **Do** | Export CSV, QuickBooks, IIF, Xero and the journal. Open each in its target (or at least in a text editor). |
| **Expect** | Valid format. Dates in the format each tool expects. Amounts to two decimals. Descriptions with commas and quotes escaped. A leading `=` escaped. |
| **If it fails** | `finExportCSV` (12541) through `finExportJournal` (12625), `fmtIIFDate` (12687). |
| **Sev** | S2 |

#### ME-F-04 — Finance CSV import

| | |
|---|---|
| **Do** | Import a finance CSV. Then import the **same file again**. |
| **Expect** | The second import is deduped or clearly warns that it will duplicate. Doubling a camp's expenses by re-importing is a real failure mode. |
| **If it fails** | `finImportCSV` (12652). |
| **Sev** | S1 |

---

## 3.7 — Close-out for Part 3

| | |
|---|---|
| **ME-B-29 ★ CORE Do** | Re-run ME-B-00: compare the family balance in Me, in the parent portal, and from `get_my_balance`. |
| **Expect** | Still three identical numbers after everything above. |
| **Sev** | S1 |

| | |
|---|---|
| **ME-B-30 Do** | Reload, log out and in, and open on a second device. |
| **Expect** | Every ledger entry, plan, card, payroll record and finance row identical. |
| **Verify** | `select key, updated_at from camp_state_kv where camp_id='<UUID>' and key in ('campistryMe','campistryMePayroll','campistryMeFinance');` |
| **Sev** | S1 |

| | |
|---|---|
| **ME-B-31 Do** | Total every charge, credit and payment you created in this part by hand on paper. Compare to what Billing says. |
| **Expect** | Equal to the cent. |
| **Sev** | S1 — if these differ, stop testing and report. Nothing else in this plan matters more. |
