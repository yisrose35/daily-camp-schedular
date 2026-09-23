# Ted's ledger

## Last commit checked
`19cb120` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-023 | 🔴 | Any logged-in account can make itself a parent of any child at any camp: `upsert_parent_invite` (131) has no camp check and lets the caller pick the token. Before 260: by name, or every child with no names. 260 adds: by number alone (`camper_data.camperId`) | 2026-09-23 | Open (pre-existing; 260 widens it) |
| TED-024 | 🟠 | 260's document carry walks each whole document once per recorded renumber: 200 renumbers in one save took 18.1 s (0.43 s without the new step); an old tab's save after 30 renumbers 2.9 s. Likely over Supabase's statement timeout, so the save fails and repeats | 2026-09-23 | Open |
| TED-021 | 🟠 | Erased child: the roster entry is now dropped, but an old tab's save brings back his enrollments and payments; a new child given the freed number shows the erased child's $900 payment | 2026-09-23 | Open (changed) |
| TED-025 | 🟡 | A renumber can never be undone: the page refuses the child's own old number and the server turns it back | 2026-09-23 | Open |
| TED-026 | 🟡 | `split_renames` does not list a split child whose birthday was filled in during the rename edit (old record: email, no dob); the check says ok | 2026-09-23 | Open |
| TED-027 | 🟡 | The server trusts a `renumberedFrom` hint on any entry; a leftover hint on another child re-points the old number to them (no page path found) | 2026-09-23 | Open (safety net) |
| TED-002 | 🟡 | Camper-number transition not complete. Page inventory A = 0 (`--check` up to date). Remaining: TED-021/023/024; Go's `_camperId` is not carried by a renumber (Go-only camps) | 2026-09-23 | Open |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 19cb120. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
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

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-260, roster trigger, renumber, erase/merge, split repair, roster keys, invites, CSV import, Health entry) | 2026-09-23 (sixth pass) |
| Parent invitations (`link_parent_invites`, `upsert_parent_invite`, claim functions, stamp trigger, `restamp_parent_invite`) | 2026-09-23 (numbers + who may write them) |
| Me page cloud save (`integration_hooks.js` batch upsert) | 2026-09-23 (only against the renumber trigger) |
| Auto Builder (solver, layers, grid) | never (only test results seen) |
| Manual Builder | never |
| Cloud sync / schedules / rotation | never |
| Billing, payments, payroll | never (camper numbers and "#number" display only) |
| Bank deposit matching | never |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never in a browser (database-level invite ownership checked 2026-09-23) |
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
| 2026-09-23 | Re-check TED-010..015 + hunt | 2330ff9 | unit 3270/14 · pg 49/0 · keys 17/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-recheck.md) |
| 2026-09-23 | Check my work: reworked 260 (TED-011, 016-022) | 19cb120 | unit 3270/14 · pg 49/0 · keys 29/0 (×4) · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-reworked-260.md) |
