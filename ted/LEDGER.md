# Ted's ledger

## Last commit checked
`81ace85` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-010 | 🔴 | Parent invite `person_ids` are not recalculated when `camper_names` changes (`upsert_parent_invite` 131 + stamp trigger 232): after a sibling withdraws or is added in front, the portal gets the sibling's number (`get_my_camper_ids` → Moshe = #2) and `verify_my_camper` says yes. Name-only stamping falls back to a departed child | 2026-09-23 | Open |
| TED-011 | 🟠 | 253's rename bug (rename via upsert → new number, old one departed with the money) is live; 259 stops new cases but neither repairs nor reports campers already split (`verify_roster_keys` all clear) | 2026-09-23 | Open |
| TED-012 | 🟠 | Renumbering a camper moves table rows but leaves saved-document records (health logs etc.) on the old number, which is then free and was accepted for a new child | 2026-09-23 | Open |
| TED-013 | 🟠 | CSV Replace without an ID column: returning children get new numbers + "#N" keys; history stays on the departed old number (server confirmed; page save order likely) | 2026-09-23 | Open |
| TED-014 | 🟠 | Health sick-visit/medication forms decide the child from the typed text (`campistry_health.js:470-495`); the picker puts the raw "#11" key in the box | 2026-09-23 | Open |
| TED-015 | 🟡 | Inventory "A = 0" is a regex count: misses TED-014, mislabelled `name-ok` at `campistry_me.js:21496`, part B ignores `.camper ===` comparisons; doc says B = 320 (builder said 324) | 2026-09-23 | Open |
| TED-002 | 🟡 | Camper-number transition not complete. Inventory now A = 0 (by its own regex), B = 320 roster-key places; real remaining work is TED-010..015 | 2026-09-23 | Open |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 81ace85. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| TED-001 | A payment/refund carrying a departed camper's number landed on an enrolled camper with the same name | 2026-09-23 | pgtest 257 fails without the fix; `npm run test:pg` passes. |
| TED-003 | Campistry Lite sent no camper numbers; loaded scripts without `?v=` | 2026-09-23 | `campistry_lite.html:29` loads the wrapper first; Lite chain versioned. |
| TED-004 | No test covered two campers sharing a name | 2026-09-23 | `scripts/pgtests/257_…sql` covers it and fails without the fix. |
| TED-006 | 257's "Name #number" rule beat an exact name match | 2026-09-23 | Scratch DB, separate statements: credits landed correctly. |
| TED-007 | Lite/Health tests only matched source text | 2026-09-23 | `npm run test:lite` drives real Lite/Health in a browser. |
| TED-008 | `verify_my_camper` said yes about a departed same-named child | 2026-09-23 | At 81ace85, scratch DB (83 migrations): departed Avi #10, live Avi #892 (key "Avi Katz #892"), parent of #892: `verify_my_camper(…,'Avi Katz',10)` = f, `(…,892)` = t. `migrations/257_…sql:172` includes it. |
| TED-009 | Me → Billing showed "Rivka Stern #702" | 2026-09-23 | Diff 01f075b adds `.map(_lbl)` to family list, detail, report and CSV; `campistry_billing_core.js:355-360` strips the suffix; `npm run test:lite` "Billing shows both children, and no internal number" ok. |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-259, `campistry_camper_id_rpc.js`, parent portal ids, erase/merge, roster keys, invites, CSV import, Health entry) | 2026-09-23 (fourth pass) |
| Parent invitations (`link_parent_invites`, `upsert_parent_invite`) | 2026-09-23 (numbers only) |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing, payments, payroll | never (camper numbers and "#number" display only) |
| Bank deposit matching | never |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never (touched only through camper numbers) |
| Health, Go, Live, Lite | never (touched only through camper numbers) |
| Access control / roles / sections | never |
| Print center, calendar, analytics | never |
| Me → Quick Fill CSV structure upload | glanced 2026-09-23 |

## Run history
| Date | Type | Commit | Tests (passed/failed) | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Audit: camper ID transition | 6c28b3a | unit 3249/14 · pg 45/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-transition.md) |
| 2026-09-23 | Audit: camper IDs go/no-go | 5cdbd49 | unit 3258/14 · pg 46/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-ids-go-no-go.md) |
| 2026-09-23 | Audit: is the camper-number move complete? | f829847 | unit 3262/14 · pg 46/0 · lite 8/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-complete.md) |
| 2026-09-23 | Audit: are we 100% on the camper ID number? | 81ace85 | unit 3270/14 · pg 48/0 · keys 13/0 · lite 9/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-100-percent.md) |
