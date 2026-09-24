# Ted's ledger

## Last commit checked
`031534e` (2026-09-24, billing eighth pass)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-109 | 🟡 | Two same-key canteen refund requests at the same moment (Snacks button re-enables when the amount is retyped) refund twice for a child with 2 top-ups ($50+$50 → $40), both processors; other shapes answer "Refund failed." though it went. New on Stripe (was merged by Stripe's key) | 2026-09-24 | Open |
| TED-101 | 🟡 | Tax year, undated session: Sept–Dec charges now guessed as next year with a warning; July/Aug re-enrolment for next summer still counted in the charge year, silently | 2026-09-24 | Open (narrowed again at 031534e) |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 031534e. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| TED-105 | Canteen refund retry after a lost answer sent twice with several top-ups; Cardknox said "Refund failed." | 2026-09-24 | At 031534e: probes/…-8/canteen_retry_realistic (shared claims table) lost/netlost/partfail × one/two/small → money moved once, answers $20 (66a65df: Cardknox 2/3 refunds, Stripe 3); refund_lost_answer 4/18 fail on old. Race residual → TED-109 |
| TED-106 | deposit_review hold rode the card-decline path | 2026-09-24 | At 031534e: unchanged probes/…-7/after_answer_night → 1 charge (was 0); probes/…-8/deposit_hold_db: old flag cleared (attempts 0), notice 1 row (nights 2–3 refused by unique key), money notice; autopay_runner 2/20 fail on old |
| TED-107 | Refunded cancellation shown as claimable | 2026-09-24 | At 031534e: probes/…-7/tax_care_year C → 0 (was 500); probes/…-8/tax_edges F → 0, G → 2200; tax_statement 3/36 fail on old |
| TED-108 | Record Payment accepted a negative amount | 2026-09-24 | At 031534e: unchanged probes/…-7/negative_payment → refused, balance 1000 (was 1500); both forms :16044/:18196; test runs real save buttons, fails on old |
| TED-100 | Camp could refund Campistry's SMS fees | 2026-09-24 | At 66a65df: unchanged probes/…-6/platform_fee_refund → 403, 0 refunds (was 200, 1); all Stripe payment creators checked (telnyx purpose stamped; deposits source-stamped; Link Pay Now customerless) |
| TED-102 | Typed deposit not card-refundable; sibling questions shared a payment | 2026-09-24 | At 66a65df: probes/…-7/ref_link_refundable → pi / byop+processor set, 750; sibling_review → pi_A→pay_h1, pi_B→pay_h2, 1500 in all cases |
| TED-103 | Open deposit question → autopay collected | 2026-09-24 | At 66a65df: runner result waiting_for_deposit_review, 0 charges (test fails on old); Billing notice raised. Residual TED-106 |
| TED-104 | Check script passed old 270/271 | 2026-09-24 | At 66a65df: old_270_271_verify → apply 270 / apply 271; probes/…-7/old_268_272_verify → apply 268 / apply 272 on old copies, 19/19 ok after re-paste and on fresh chain |
| TED-095 | Hand-typed card deposit counted twice | 2026-09-24 | At 3390aba: unchanged probes/…-5/deposit_twice → 750 both cases, 1 row (was 500); tests 3/10 fail on old. Residuals TED-102/103 |
| TED-096 | Stripe deposit refund 403 | 2026-09-24 | At 3390aba: unchanged deposit_refund → 3/3 HTTP 200, 1 refund. Side effect TED-100 |
| TED-093 | Refund-all refunded twice; young claim releasable | 2026-09-24 | At 3390aba: unchanged refund_all_lost (body {}) → 1 gateway refund (was 2); pgtest 273; refund_lost_answer 5/9 fail on old |
| TED-097 | 2nd same-amount Stripe canteen refund sent nothing | 2026-09-24 | At 3390aba: unchanged canteen_second_refund → re_1 then re_2, keys include remaining. Side effect TED-105 |
| TED-098 | Stale tab made deposit owed again | 2026-09-24 | At 3390aba: unchanged regdep_cycle step 5 → owed 0; 2nd charge keeps [9001,9002] |
| TED-099 | Ledger-start trigger quadratic | 2026-09-24 | At 3390aba: ledger_start_scale 600 → 592 ms (was 3,012), 1,000 → 1,280 ms (was 7,561), 2,500 → 5,308 ms; all posted once |
| TED-094 | Money notices visible to all staff | 2026-09-24 | At 3390aba: is_money_notice includes autopay_setup; pgtest 270; all notice writers checked. Check-script gap TED-104 |
| TED-088 | Parent's Link balance read a document-only copy | 2026-09-24 | At 25378b1: unchanged probes/…-4/parent_balance.js office=parent 600/300; probes/…-5/parent_live.js shop/cancel/Zelle/autopay/webhook row/refund all equal with no office save |
| TED-089 | Deposit couldn't be paid right after applying | 2026-09-24 | At 25378b1: regdep_new_app.js paid 250; probes/…-5/regdep_cycle.js owed 250→0, repeat = duplicate; tests 2/11 fail on old. Residual TED-098 |
| TED-090 | Card deposit never became a family payment | 2026-09-24 | At 25378b1: deposits_reach_the_family 7/7 (6 fail on old): one refundable row, balance 750, idempotent. Residuals TED-095/096 |
| TED-091 | Stale tab dropped/cancelled shop charges | 2026-09-24 | At 25378b1: unchanged stale_shop.js → charges c10+shop_o1, catch-up 0, balance 1050 |
| TED-077 | Money before a ledger started never posted | 2026-09-24 | At 25378b1: unchanged deposit_before_ledger 600 / payment_before_ledger 700; probes/…-5/rerun.js one-off 1000→700, stable on 2 re-pastes; 1,000 families posted once |
| TED-092 | Stale deposit claim retaken twice | 2026-09-24 | At 25378b1: unchanged stale_twice.js click 2 → in_progress; pgtest 268 + function test check the charge_unconfirmed notice |
| TED-076 | Two billing tests text-only | 2026-09-24 | At f3d38a9: tests run the real save buttons; removing Add Charge's >0 check fails TED-062 test (close-out still text) |
| TED-078 | Stale tab wiped the bank-debit hold | 2026-09-24 | At f3d38a9: unchanged probes/…-3/stale_hold.js keeps pendingCharge through both save paths. Residual TED-091 |
| TED-079 | Declined fixed-amount instalment skipped | 2026-09-24 | At f3d38a9: code read runner :812-830; TED-079 test fails with guard removed |
| TED-080 | Link showed even-split amounts | 2026-09-24 | At f3d38a9: link_plan_view.js → [1000,200,200]; test fails on old Link page |
| TED-081 | Merge dropped charges[] | 2026-09-24 | At f3d38a9: merge.js → catch-up posts 0, A owes 1025; test fails on old code |
| TED-082 | Converted shop charge re-priced/cancelled wrong | 2026-09-24 | At f3d38a9: conv_shop.js → 55.00 then 0.00; dup_recheck 625; 2 tests fail on old |
| TED-083 | Cut-off deposit "already paid" forever | 2026-09-24 | At f3d38a9: pgtest 268 states; deposit tests 4/10 fail on old. Residual TED-092 |
| TED-084 | Legacy/id-less plan not held | 2026-09-24 | At f3d38a9: probes/…-4/legacy_hold.js hold+flag on #0 kept through stale save; runner tests fail on old. Residual TED-094 |
| TED-085 | Idempotency keys replayed declines | 2026-09-24 | At f3d38a9: deposit :a<n> (pgtest 268), reload :f<n>; tests fail on old |
| TED-086 | processor_transactions kind check | 2026-09-24 | At f3d38a9: ptx_kind.js → registration_deposit / card_capture accepted |
| TED-087 | Billing loose ends | 2026-09-24 | At f3d38a9: ted087 tests 4/4 fail on old; probes/…-4/bundle.js → bundle stops at guard, nothing changed. Notice gaps → TED-094 |
| TED-063 | Link Pay Now credited no family, settled to platform | 2026-09-24 | At 79ed2a0: probes/…-3/recheck_harness: signed-in parent → own family + acct_CAMP; no login + unknown family → 400; test file 4/5 fail on old |
| TED-064 | ACH autopay debited nightly | 2026-09-24 | At 79ed2a0: hold carried across 3 harness nights → 1 debit, recorded on clear; 5 runner tests fail on old. Residuals TED-078/084 |
| TED-065 | Catch-up re-posted converted charges | 2026-09-24 | At 79ed2a0: probes/…-3/dup_recheck (real conversion) → posted [0,0], 625 in JS and SQL. Residual TED-082 |
| TED-066 | Cancelled shop order stayed billed | 2026-09-24 | At 79ed2a0: unchanged probes/2026-09-24-billing/shop.js → balance 0.00; pgtest 263. Residuals TED-081/082 |
| TED-067 | Close-out billed canteen money / roll_forward consumed credit | 2026-09-24 | At 79ed2a0: unchanged closeout.js → no charge posted; test file 3/4 fail on old |
| TED-068 | Office plan amounts ignored | 2026-09-24 | At 79ed2a0: unchanged plan.js → 1000/200/200, 300+300; pgtest 264. Residuals TED-079/080 |
| TED-069 | officeCharge no login / no claim | 2026-09-24 | At 79ed2a0: unchanged regdep.test.js → 403, 0 charges; builder test double request → 1 charge (fails on old). Residuals TED-083/085 |
| TED-070 | Banquest deposit keys / gateway | 2026-09-24 | At 79ed2a0: registration_deposit_charge 5/6 fail on old; code read :83-89, :451 |
| TED-071 | Sola amount matching | 2026-09-24 | At 79ed2a0: unchanged ck.test.js → unknown-xInvoice sale not recorded; notice test; 5/7 fail on old |
| TED-072 | Hosted return took newest txn | 2026-09-24 | At 79ed2a0: unchanged hosted.test.js → pending, nothing recorded |
| TED-073 | Tip retry wrong destination / short | 2026-09-24 | At 79ed2a0: code read charge-due-installments:1069-1135; runner tip tests fail on old. Residual in TED-087 |
| TED-074 | Plan setting pointed at removed Link builder | 2026-09-24 | At 79ed2a0: campistry_me.js:13179 button always shown; test TED-074 |
| TED-075 | Canteen auto-reload twice | 2026-09-24 | At 79ed2a0: recheck_harness with insert-if-absent claim → 1 charge; test 2/2 fail on old. Residual TED-085 |
| TED-051 | Autopay skipped parent-built (dueDates) plans | 2026-09-24 | At 10e0758: autopay_runner.test.js test 1 passes; all 3 runner tests fail against 32c9f59's runner (scratch worktree) |
| TED-052 | stripe-refund had no caller check | 2026-09-24 | At 10e0758: 4 refund tests in stripe_refund_and_charge.test.js pass, fail on old code (8/9 of file fail on old); code read stripe-refund/index.ts:129-199. Residual in TED-076 |
| TED-053 | Late fees/surcharges/charges never reached the ledger | 2026-09-24 | At 10e0758: charges_reach_the_ledger.test.js passes (fails on old); pgtest 215 billing block 600→625. Side effects filed as TED-065/066/067 |
| TED-054 | payments-charge imported a missing file | 2026-09-24 | At 10e0758: byop_charge.test.js 7/7 pass, 7/7 fail on old; no local imports |
| TED-055 | Declined installments[] instalment dropped | 2026-09-24 | At 10e0758: runner tests 2-3 pass (fail on old); pgtest 215: pending + flagged + notified, retry pays and clears |
| TED-056 | Two plan models; office wrote old plans | 2026-09-24 | At 10e0758: office_plan_is_ledger_plan.test.js passes (fails on old). Amount side effect filed as TED-068 |
| TED-057 | stripe-webhook accepted unsigned events / no age check | 2026-09-24 | At 10e0758: stripe_webhooks_fail_closed.test.js 6/6 (3 fail on old); connect webhook checks age too. Owner must set secrets |
| TED-058 | stripe-charge charged another camp's customer; no idempotency | 2026-09-24 | At 10e0758: 3 charge tests pass, fail on old |
| TED-059 | Batch charge always reported 0 failed | 2026-09-24 | At 10e0758: batch_charge_counts_failures.test.js 3/3, fail on old |
| TED-060 | Test DB lacked billing migrations | 2026-09-24 | At 10e0758: chain 109 migrations, pg 50/50; my scratch DBs from the chain ran convert_family_ledgers, settle_shop_order, get_my_balance |
| TED-061 | stripe-setup open to anyone | 2026-09-24 | At 10e0758: harness → HTTP 410, 0 outside calls |
| TED-062 | Negative credit accepted | 2026-09-24 | At 10e0758: campistry_me.js:17999 and :18412 refuse ≤0 (code read; its test is text-only) |
| TED-050 | No test for camper numbers in the family sweep | 2026-09-24 | At 10e0758: sweep_sends_camper_numbers.test.js fails with p_roster_ids dropped (1 fail) and with fallback-on-any-error (1 fail); passes unchanged |
| TED-048 | Verify script said "261 ok" on an earlier copy of 261 | 2026-09-23 | At 4ce2489, scratch DB: real 261 from d049454 and from b92dcdc → "run 261 again", then ok after re-running today's 261; today's 261 twice more → ok; pgtest 261 fails with d049454's verify script and with only the camp_people half removed. |
| TED-049 | By-number family switch-off could cut off a family with an enrolled child (null sibling slot, stale page number, `[null]` list) | 2026-09-23 | At 4ce2489: pgtest 261 fails with each of the 3 fixes undone (no DB roster / no null-slot rule / item count), passes unchanged; my real-save scenario (`v16/real.sql`): removed + unenrolled children's families off, TED-047 case off, wrong page number (99 for #4) stays on. |
| TED-047 | Family "still at camp" switch compared names, not numbers | 2026-09-23 | At d049454, scratch DB: my t047 scenario (departed Avi #1, new Avi Katz #3) → `revoked: 1`, Katz invite off (old 2-arg by name: 0); pgtest 261 fails with the number branch disabled, passes with it; page probe sends `p_roster_ids` and falls back only on PGRST202. |
| TED-046 | Staff call naming a child by name only was sent before the erase check | 2026-09-23 | At 678e3a2: my unchanged real supabase-js probe (`v13/probe.e2e.js`) P5 → sent 0, reload (b6115a4: sent 1); `v13/probe_name.js` → 0 sent; `erase_guard.test.js` test 7 fails against b6115a4's `supabase_client.js`, passes at HEAD. |
| TED-044 | Own erase in flight masked another computer's erase; a save slipped through | 2026-09-23 | At b6115a4, real supabase-js (`v13/probe.e2e.js`): P2 stale save sent 0 (70cd931: 1), reload after answer; P3 own erase alone: save waits, then sent, no reload. Mutations of `erase_guard.test.js`: old tab+own → tests 3,6 fail; no wait → 3; no recheck → 2,6; own before check → 5. |
| TED-045 | No test guarded fresh checks on ordinary-table writes | 2026-09-23 | At b6115a4: `erase_guard.test.js` test 4 fails with the 15 s table rule put back; file runs under `npm test`. |
| TED-040 | Other tables and camper-naming RPCs checked at most every 15 s | 2026-09-23 | At 70cd931, real supabase-js (`v12/probe.e2e.js`): canteen_transactions insert after erase elsewhere → 0 sent, reload; nested `camperId` RPC → not sent, reload; test:keys fails with RPC rule at 15 s. Calls with other argument names (e.g. `p_roster_names`) still 15 s. |
| TED-042 | Several erases sent at once made the erasing page reload itself | 2026-09-23 | At 70cd931: test:keys fails with `Promise.all` back (reloads 1) and with the in-flight count removed (reloads 2); probe P3 own erase + save → no reload. Side effect filed as TED-044. |
| TED-043 | URL-object write passed the fetch guard | 2026-09-23 | At 70cd931: probe P4 → 409, 0 requests; test:keys fails with the old line. |
| TED-037 | A page forced to reload still sent its old copy on the way out (beforeunload keepalive) | 2026-09-23 | At 50f96f6: my unchanged `v10/leak2.e2e.js` (network-layer recorder, real erase) → 0 requests past the guard, database unchanged; leaving 0/100/300 ms after save (`v11/leak3.e2e.js`) → 0; test:keys fails with the fix removed (1 of 37). |
| TED-038 | Lite never loaded the guarded supabase_client.js | 2026-09-23 | At 50f96f6: `campistry_lite.html:137` `LITE_ASSET_VERSION = '20260923-08'`; Lite's saveKV goes through `window.supabase`; test:lite 12/12. Native Capacitor build is an owner step. |
| TED-039 | Verify script said 260 ok on an earlier copy of 260 | 2026-09-23 | At 50f96f6 (`v11/v39.js`): full → ok; 260 from 189d36b and from b92dcdc → "run 260 again"; no 260 → "apply 260". |
| TED-041 | Erasing page skipped the reload for another computer's erase (Math.max) | 2026-09-23 | At 50f96f6: test:keys fails with Math.max put back ("timed out waiting for the erasing page to reload"); real supabase-js run: 1 then 2 → no reload. Out-of-order follow-up filed as TED-042. |
| TED-035 | Erased number reused + stale save could land a number-only record on the new child | 2026-09-23 | Under the owner's rule (reload with cleared cache; numbers reusable; money unlinked): TED-037/038 leaks closed with the proof above; residual 15 s window tracked under TED-040. |
| TED-033 | A Me tab opened earlier removed children added since | 2026-09-23 | At 10f4461, scratch DB (`v10/t33.sql`): tab that saw only #1 saves → Sara #2 kept, edit kept, list not stored; added-before-erase case keeps Sara #3, Avi not back; seen-and-removed still removed; old page unchanged. |
| TED-034 | Any parent could read every child's name + number via `get_camper_numbers` | 2026-09-23 | At 10f4461, scratch DB (`v10/tpar.sql`): parent → `{"success":false,"error":"not_authorized"}`; owner's erased list `{"2": true}`, no name. |
| TED-036 | Verify 261 table check only looked for "scheduler" in one rule | 2026-09-23 | At 10f4461 (`v10/t36.js`): RLS off, extra `USING(camp_id = get_user_camp_id())` rule, opened parent rule → "run 261 again"; full build → ok. |
| TED-021 | Erase → new child auto-given the erased number → stale tab brought the erased child back on it, owned by the new child's parent | 2026-09-23 | At b92dcdc: my unchanged `t031.sql` → Sara auto #3, Avi not back, `_parent_owns_person(camp,2)` = f; pgtest 260 fails with the mint skip or the put-back step removed. |
| TED-028 | Schedulers could read access codes from `link_parent_invites` | 2026-09-23 | At b92dcdc, scratch DB as `authenticated`: scheduler 0 rows, counselor 0, manager 1, owner 1; scheduler UPDATE 0 rows; pgtest 261 fails with scheduler put back. |
| TED-031 | Check script said 261 ok when the invite functions were ungated | 2026-09-23 | At b92dcdc: 032's list function put back → "run 261 again"; 261 re-run twice ok → ok. |
| TED-032 | Non-office staff got silent failure on parent email / "No invite" in Link admin | 2026-09-23 | At b92dcdc (code read): `campistry_me.js:5911`, `campistry_link_admin.html:4253-4263`. Leftovers noted in the report (badges, bulk "N failed", join request raw code). |
| TED-002 | Camper-number transition not complete | 2026-09-23 | At b92dcdc: inventory part A = 0, `--check` up to date; the remaining items TED-021/028 are closed. |
| TED-001 | A payment/refund carrying a departed camper's number landed on an enrolled camper with the same name | 2026-09-23 | pgtest 257 fails without the fix; `npm run test:pg` passes. |
| TED-003 | Campistry Lite sent no camper numbers; loaded scripts without `?v=` | 2026-09-23 | `campistry_lite.html:29` loads the wrapper first; Lite chain versioned. |
| TED-004 | No test covered two campers sharing a name | 2026-09-23 | `scripts/pgtests/257_…sql` covers it and fails without the fix. |
| TED-006 | 257's "Name #number" rule beat an exact name match | 2026-09-23 | Scratch DB, separate statements: credits landed correctly. |
| TED-007 | Lite/Health tests only matched source text | 2026-09-23 | `npm run test:lite` drives real Lite/Health in a browser. |
| TED-008 | `verify_my_camper` said yes about a departed same-named child | 2026-09-23 | At 81ace85, scratch DB: `verify_my_camper(…,'Avi Katz',10)` = f, `(…,892)` = t. |
| TED-009 | Me → Billing showed "Rivka Stern #702" | 2026-09-23 | `.map(_lbl)` in all four places; `npm run test:lite` Billing check ok. |
| TED-010 | Invite `person_ids` slid onto a sibling when `camper_names` changed | 2026-09-23 | At 2330ff9: pgtest 260 passes (49/0). |
| TED-013 | CSV Replace without ID gave returning children new numbers | 2026-09-23 | At 2330ff9: `npm run test:keys` step 5. |
| TED-014 | Health sick-visit/medication forms decided the child by typed text | 2026-09-23 | At 2330ff9: `pickedCamper()`; `npm run test:lite` 12/12. |
| TED-015 | Name inventory was a loose regex; mislabelled name-ok | 2026-09-23 | At 2330ff9: regenerated inventory, no diff. |
| TED-016 | After a renumber every Me-page cloud save failed (trigger rewrote a row twice in one upsert) | 2026-09-23 | At 19cb120: two-row upsert renumber succeeded on scratch DB; test:keys 4b 29/29 in 4 of 4 runs; same test against the old 260 fails at the renumber step. |
| TED-017 | Renumber / split repair left invites on the old number; next child given it was owned by the parent | 2026-09-23 | At 19cb120, scratch DB: invite [1]→[7]; Dina typed #1 got #8; parent owns 7 = t, Dina = f. Split repair moved invite [3]→[2]. |
| TED-012 | Renumber left records on the old number | 2026-09-23 | At 19cb120: documents and invites follow via the after-save step; an old tab's document with #1 was corrected to 7 on save. |
| TED-018 | An invite written before enrollment kept a null slot forever | 2026-09-23 | At 19cb120, scratch DB: `[null]` → `[1]` after the page-style re-save with camperId; the page sends camperId. |
| TED-019 | `restamp_parent_invite` gave a departed child's number by name | 2026-09-23 | At 19cb120, scratch DB: restamp of a "Ghost Kid" invite → `now [null]`, not #3. |
| TED-020 | Rename + renumber in one save split the child | 2026-09-23 | At 19cb120, scratch DB: one child #9, no departed #1, records moved, hint not stored; test:keys 4c passes. |
| TED-011 | `split_renames` could pair a child with a removed sibling / abort camp-wide | 2026-09-23 | At 19cb120, scratch DB: sibling case repaired only the child; empty-record and twin cases went to needs_a_person. New gap filed as TED-026. |
| TED-022 | CSV Update without ID matched only the plain-name key | 2026-09-23 | At 19cb120: test:keys 4d passes (no third Avi, his own key and number). |
| TED-023 | Any logged-in account could write + claim an invitation for any child at any camp (`upsert_parent_invite`) | 2026-09-23 | At bd61488: 261 refuses non-office (stranger and counselor → `not_camp_office`); pgtest 261 fails with the 131 function swapped back in; 261 applies with and without 260, twice; 260 re-applied keeps the check. |
| TED-024 | 260's document carry walked each document once per renumber (18.1 s save) | 2026-09-23 | At bd61488, my machine: 200 renumbers in one save 1.86 s, stale save 0.24 s (pgtest 260 §9). |
| TED-025 | A renumber could not be undone | 2026-09-23 | At bd61488, scratch DB: 1→7→1 leaves one child #1, moves table `7→1`, records back on 1, a new "#7" child gets #3; test:keys 4e passes. |
| TED-026 | `split_renames` missed a child whose birthday was entered in the rename edit | 2026-09-23 | At bd61488: pgtest 260 §11 (same shape as my case) passes: listed under needs_a_person, not repaired. |
| TED-027 | A leftover `renumberedFrom` hint re-pointed the old number | 2026-09-23 | At bd61488: pgtest 260 §10 passes (Tova's hint moved nothing; `1→7` kept). |
| TED-029 | Check script crashed when 261 was applied before 260 | 2026-09-23 | At 0909cee, scratch DB without 260: "apply 260" / "ok", no error; with both: ok / ok. |
| TED-030 | Scheduler got "unknown. Run migration 011" on invite | 2026-09-23 | At 0909cee: `campistry_me.js:14445`, `:14466` show "Only the camp office (owner, admin or manager) can invite parents." (code read; not seen in browser). |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-260, roster trigger, renumber, erase/merge, split repair, roster keys, invites, CSV import, Health entry) | 2026-09-23 (twelfth pass) |
| Erase reload guard (`supabase_client.js` `_withEraseGuard`, fetch guard, camp_cache_epoch) | 2026-09-23 (fourteenth pass: guard below the ID layer; probes P1-P5 re-run; old-code run of erase_guard.test.js) |
| Parent invitations (`link_parent_invites`, `upsert_parent_invite`, claim functions, stamp trigger, `restamp_parent_invite`, `revoke_orphaned_parent_invites`) | 2026-09-23 (numbers; who may write them; staff access to codes; leaving sweep by number + DB roster re-checked at 4ce2489, TED-048/049 closed) |
| Me page cloud save (`integration_hooks.js` batch upsert) | 2026-09-23 (only against the renumber trigger) |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing & payments (edge functions, autopay runner, refunds, late fees/surcharges/credits, plans, parent balance) | 2026-09-24 (eighth pass: TED-101/105..108 re-checked; canteen refund retries with a shared claims table incl. lost answer / no answer / part-declined / same-key race; deposit hold notice + old-flag clear on real DB; every typed money-in path's sign; not browser, not live processors) |
| Payroll | never |
| Tax statement (`campistry_tax_statement.js`) | 2026-09-24 (8th pass): care-year logic with Me's real resolveCharge, dated/undated sessions (Aug re-enrolment, fall programme), full/partial refunds after a carried deposit, printed Total (TED-101/107); classification rules never |
| Bank deposit matching (`deposit-inbox`) | 2026-09-24: only what happens after a match (TED-077); parser/matcher never |
| Canteen / Snacks / Shop / POS | canteen auto-reload, shop bill-to-family, canteen refunds (single/all, Stripe/BYOP) 2026-09-24; POS maths never |
| Parent portal (Link) | balance RPC (get_my_balance) re-traced 2026-09-24 fifth pass (TED-088 closed); never in a browser (database-level invite ownership checked 2026-09-23; Parents-page refusal wording run in isolation 2026-09-23) |
| Health, Go, Live, Lite | never (touched only through camper numbers) |
| Access control / roles / sections | never (open question from 2026-09-24: a custom Role now always sets the 'manager' account type underneath — does that widen Billing access?) |
| Print center, calendar, analytics | never |
| Me → Quick Fill CSV structure upload | glanced 2026-09-23 |

## Run history
| Date | Type | Commit | Tests (passed/failed) | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Audit: camper ID transition | 6c28b3a | unit 3249/14 · pg 45/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-transition.md) |
| 2026-09-23 | Audit: camper IDs go/no-go | 5cdbd49 | unit 3258/14 · pg 46/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-ids-go-no-go.md) |
| 2026-09-23 | Audit: is the camper-number move complete? | f829847 | unit 3262/14 · pg 46/0 · lite 8/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-complete.md) |
| 2026-09-23 | Audit: are we 100% on the camper ID number? | 81ace85 | unit 3270/14 · pg 48/0 · keys 13/0 · lite 9/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-100-percent.md) |
| 2026-09-23 | Re-check TED-010..015 + hunt | 2330ff9 | unit 3270/14 · pg 49/0 · keys 17/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-recheck.md) |
| 2026-09-23 | Check my work: reworked 260 (TED-011, 016-022) | 19cb120 | unit 3270/14 · pg 49/0 · keys 29/0 (×4) · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-reworked-260.md) |
| 2026-09-23 | Check my work: 261 + 260 repairs (TED-021, 023-027) | bd61488 | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-261-recheck.md) |
| 2026-09-23 | Check my work: TED-021, 028-030 fixes | 0909cee | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-ted028-recheck.md) |
| 2026-09-23 | Check my work: TED-021, 028, 031, 032 fixes | b92dcdc | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-ninth-recheck.md) |
| 2026-09-23 | Check my work: TED-033..036 fixes + erase reload rule | 10f4461 | unit 3270/14 · pg 50/0 · keys 34/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-tenth-recheck.md) |
| 2026-09-23 | Check my work: TED-037..041 fixes | 50f96f6 | unit 3270/14 · pg 50/0 · keys 37/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-eleventh-recheck.md) |
| 2026-09-23 | Check my work: TED-040, 042, 043 fixes | 70cd931 | unit 3270/14 · pg 50/0 · keys 41/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-twelfth-recheck.md) |
| 2026-09-23 | Check my work: TED-044, 045 fixes | b6115a4 | unit 3276/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-thirteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-046 fix | 678e3a2 | unit 3277/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟢 | [report](reports/2026-09-23-camper-id-fourteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-047 fix | d049454 | unit 3277/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-fifteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-048, 049 fixes + Parents page wording | 4ce2489 | unit 3280/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟢 | [report](reports/2026-09-23-camper-id-sixteenth-recheck.md) |
| 2026-09-23 | Audit: billing | 32c9f59 | unit 3280/14 · pg 50/0 · smoke 32/0 · own harness 5 runs | 🔴 | [report](reports/2026-09-23-billing-audit.md) |
| 2026-09-24 | Check my work + billing deep pass | 10e0758 | unit 3323/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 8 new tests · 3 scratch DB + 8 harness probes | 🔴 | [report](reports/2026-09-24-billing-recheck.md) |
| 2026-09-24 | Check my work: TED-063..076 fixes + billing hunt | 79ed2a0 (HEAD 6e9a2a7) | unit 3365/14 · pg 53/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 9 new test files · 7 scratch DB + 3 harness + 3 real-code probes | 🔴 | [report](reports/2026-09-24-billing-third-pass.md) |
| 2026-09-24 | Check my work: TED-076..087 fixes + billing hunt (4th pass) | f3d38a9 | unit 3393/14 · pg 59/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 6 test files · 11 scratch DB + 1 harness probes | 🔴 | [report](reports/2026-09-24-billing-fourth-pass.md) |
| 2026-09-24 | Check my work: TED-077, 088..094 fixes + billing hunt (5th pass) | 25378b1 | unit 3407/14 · pg 61/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 6 test files · 5 scratch DB + 4 harness + 1 real-code probes, 10 4th-pass probes re-run | 🔴 | [report](reports/2026-09-24-billing-fifth-pass.md) |
| 2026-09-24 | Check my work: TED-093..099 fixes + billing hunt (6th pass) | 3390aba | unit 3415/14 · pg 62/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 3 test files · 9 5th-pass probes re-run · 8 new probes | 🟡 | [report](reports/2026-09-24-billing-sixth-pass.md) |
| 2026-09-24 | Check my work: TED-100..105 fixes + billing hunt (7th pass) | 66a65df | unit 3426/14 · pg 62/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 5 test files · 6th-pass probes re-run · 8 new probes | 🟡 | [report](reports/2026-09-24-billing-seventh-pass.md) |
| 2026-09-24 | Check my work: TED-101, 105..108 fixes + billing hunt (8th pass) | 031534e | unit 3437/14 · pg 62/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 · old-code runs of 5 test files · 7th-pass probes re-run · 4 new probes | 🟡 | [report](reports/2026-09-24-billing-eighth-pass.md) |
