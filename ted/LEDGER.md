# Ted's ledger

## Last commit checked
`5cdbd49` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-002 | 🟡 | Camper-number transition not complete: 457 page places still identify campers by name (`docs/CAMPER_NAME_INVENTORY.md`), and that inventory leaves out 29 edge functions and name-keyed DB columns (e.g. canteen `account_key`) | 2026-09-23 | Open (inventory added 5cdbd49; undercounts) |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); failing since at least 2026-09-09; still 14 at 5cdbd49 | 2026-09-23 | Open |
| TED-006 | 🟠 | Migration 257's "Name #number" rule beats an exact name match: a camper stored as "Sam Cohen #2" (#5) is resolved to a different Sam Cohen who is #2, by name-only calls; `verify_number_round_trip()` doesn't detect it; number path saves account key "Sam Cohen #2 #5" | 2026-09-23 | Open (257 not yet applied live) |
| TED-007 | 🟡 | New Lite/Health tests mostly match source text; the smoke test still exercises only 3 camper-naming calls, none from Lite or Health | 2026-09-23 | Open |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| TED-001 | A payment/refund carrying a departed camper's number landed on an enrolled camper with the same name | 2026-09-23 | pgtest 257 on the chain without 257: fails `a Stripe credit for #10: expected #10 = 30 and #11 = 0, got #10 = 5.00 and #11 = 25.00`; with 257: `npm run test:pg` 46/46 incl. 257. (Live DB: 257 not applied yet, and see TED-006 before applying.) |
| TED-003 | Campistry Lite sent no camper numbers; loaded scripts without `?v=` | 2026-09-23 | `campistry_lite.html:29` loads wrapper first; `supabase_client.js:41-55` resolver reads `window.__camperIdRoster`, set at `campistry_lite.js:417`; resolver unit test (executes the function) passes; Lite chain versioned at `campistry_lite.html:180-184`. Not run on a phone. |
| TED-004 | No test covered two campers sharing a name | 2026-09-23 | `scripts/pgtests/257_a_number_reaches_its_own_camper.sql` covers departed+enrolled money paths and enrolled look-alikes through forms/faces/health/limits/verify_my_camper; fails without the fix (see TED-001 proof). |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-257, `campistry_camper_id_rpc.js`, parent portal ids, erase/merge, Lite/Health numbers) | 2026-09-23 (second pass) |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing, payments, payroll | never (money edge functions checked only for passing camper numbers) |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never (touched only through camper numbers) |
| Health, Go, Live, Lite | never (touched only through camper numbers) |
| Access control / roles / sections | never |
| Print center, calendar, analytics | never |

## Run history
| Date | Type | Commit | Tests (passed/failed) | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Audit: camper ID transition | 6c28b3a | unit 3249/14 · pg 45/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-transition.md) |
| 2026-09-23 | Audit: camper IDs go/no-go (re-check of TED-001..004) | 5cdbd49 | unit 3258/14 · pg 46/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-ids-go-no-go.md) |
