# Ted's ledger

## Last commit checked
`f829847` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-002 | 🟡 | Camper-number transition not complete: 589 places still identify campers by name (`docs/CAMPER_NAME_INVENTORY.md`: pages 455, edge functions 130, DB name-keys 4). Inventory now covers edge functions + DB; skips 3 retired payment functions, one of which (`payments-canteen-checkout`) credits canteen by name only | 2026-09-23 | Open (inventory fixed f829847; migration work remains) |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); failing since at least 2026-09-09; still 14 at f829847. Owner deferred. | 2026-09-23 | Open (deferred by owner) |
| TED-008 | 🟠 | `verify_my_camper` was left out of 257's pin rewrite (excluded by the `verify\_%` filter); it answers yes to a parent about a departed look-alike's number → photo checkout could charge for another child; PDF upload stores file before refusal. `verify_number_round_trip` doesn't notice | 2026-09-23 | Open |
| TED-009 | 🟠 | Me → Billing shows the internal key "Rivka Stern #702" (campistry_me.js 17421, 17464, 20559, 21269 CSV); bill-line notes "Tuition — <key>" (campistry_billing_core.js:358) likely reach parents | 2026-09-23 | Open |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| TED-001 | A payment/refund carrying a departed camper's number landed on an enrolled camper with the same name | 2026-09-23 | pgtest 257 on the chain without 257: fails `a Stripe credit for #10: expected #10 = 30 and #11 = 0, got #10 = 5.00 and #11 = 25.00`; with 257: `npm run test:pg` 46/46 incl. 257. (Live DB: 257 not applied yet.) |
| TED-003 | Campistry Lite sent no camper numbers; loaded scripts without `?v=` | 2026-09-23 | `campistry_lite.html:29` loads wrapper first; resolver reads `window.__camperIdRoster`; Lite chain versioned. Not run on a phone. |
| TED-004 | No test covered two campers sharing a name | 2026-09-23 | `scripts/pgtests/257_a_number_reaches_its_own_camper.sql` covers departed+enrolled money paths and enrolled look-alikes; fails without the fix. |
| TED-006 | 257's "Name #number" rule beat an exact name match, sending "Sam Cohen #2" (#5) money to Sam Cohen #2 | 2026-09-23 | At f829847, scratch DB, separate statements: by_name("Sam Cohen #2")=5, ("Sam Cohen")=2; credits → #5 = 4029 (incl. $4000 by number with mismatched name), #2 = 301; keys unchanged; verify_number_round_trip all lists empty. New pgtest fails on old 257 ("a number was added to a name: Dov Stern #31"). |
| TED-007 | Lite/Health tests only matched source text | 2026-09-23 | `npm run test:lite` 8/8: real browser presses Lite Give, sends Lite message, logs Health dose; rows carry 702. Fails on pre-fix `campistry_lite.js`. |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-257, `campistry_camper_id_rpc.js`, parent portal ids, erase/merge, Lite/Health numbers, display-name stripping) | 2026-09-23 (third pass) |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing, payments, payroll | never (money edge functions checked only for camper numbers; Billing screen checked only for "#number" display) |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never (touched only through camper numbers) |
| Health, Go, Live, Lite | never (touched only through camper numbers) |
| Access control / roles / sections | never |
| Print center, calendar, analytics | never |
| Me → Quick Fill CSV structure upload | glanced 2026-09-23 (creates structure only, no campers) |

## Run history
| Date | Type | Commit | Tests (passed/failed) | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Audit: camper ID transition | 6c28b3a | unit 3249/14 · pg 45/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-transition.md) |
| 2026-09-23 | Audit: camper IDs go/no-go (re-check of TED-001..004) | 5cdbd49 | unit 3258/14 · pg 46/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-ids-go-no-go.md) |
| 2026-09-23 | Audit: is the camper-number move complete? | f829847 | unit 3262/14 · pg 46/0 · lite 8/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-complete.md) |
