# Ted's ledger

## Last commit checked
`6c28b3a` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-001 | 🟠 | A payment or refund sent by a departed camper's number lands on a current camper with the same name (248 wrappers and 242 offline import turn number → name → current child) | 2026-09-23 | Open |
| TED-002 | 🟡 | Camper-number transition is not complete: roster, families, enrollments, bunks, canteen account key, health log still keyed by name (by design, per `campistry_camper_identity.js`) | 2026-09-23 | Open |
| TED-003 | 🟡 | Campistry Lite never sends camper numbers (no roster lookup) and loads `supabase_client.js` without a `?v=` version | 2026-09-23 | Open |
| TED-004 | 🟡 | No test covers two campers sharing a name (departed + enrolled, or both enrolled); smoke test exercised only 3 camper calls | 2026-09-23 | Open |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); failing since at least 2026-09-09, and still failing at `c771c16~1` | 2026-09-23 | Open |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| (none yet) | | | |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-256, `campistry_camper_id_rpc.js`, parent portal ids, erase/merge) | 2026-09-23 |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing, payments, payroll | never |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never (touched only through camper numbers) |
| Health, Go, Live, Lite | never |
| Access control / roles / sections | never |
| Print center, calendar, analytics | never |

## Run history
| Date | Type | Commit | Tests (passed/failed) | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Audit: camper ID transition | 6c28b3a | unit 3249/14 · pg 45/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-transition.md) |
