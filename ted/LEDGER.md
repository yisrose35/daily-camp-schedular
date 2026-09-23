# Ted's ledger

## Last commit checked
`2330ff9` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-016 | 🔴 | After a Camper ID is changed on Edit Camper, every Me-page cloud save fails ("ON CONFLICT DO UPDATE command cannot affect row a second time"): 260's trigger rewrites `campistryMe` inside the page's one-statement upsert. Page still says "Synced". Regression from 260 | 2026-09-23 | Open |
| TED-017 | 🔴 | Renumber (237/260) and `split_renames(true)` don't update `link_parent_invites.person_ids`; the parent stays on the old number and owns whoever is given it next (scratch: parent owns Dina #1, not Moshe #7) | 2026-09-23 | Open |
| TED-011 | 🟠 | `split_renames` can pair a split child with a sibling removed in the same save (shared parent email): the repair aborts camp-wide on a unique-key error, or silently moves the child onto the sibling's number and money when the child's old record has no dob/email; it also leaves invites on the deleted number | 2026-09-23 | Open (changed) |
| TED-018 | 🟠 | An invite written before the child is enrolled keeps a `null` slot for ever: 260's trigger ignores re-saves with the same names; Me's invite data carries no camperId | 2026-09-23 | Open |
| TED-019 | 🟠 | `restamp_parent_invite` (the repair that verify_identity_chain points to) still decides slots by name and gives a departed child's number | 2026-09-23 | Open |
| TED-020 | 🟠 | Rename + new Camper ID in one save splits the child (old number departed with records, new person minted) | 2026-09-23 | Open |
| TED-021 | 🟠 | A stale office tab's roster save brings an erased camper back under their freed number | 2026-09-23 | Open |
| TED-012 | 🟠 | Renumber leaves records on the old number. Server now moves documents (single-row save), but the real page save fails (TED-016) and invites don't move (TED-017) | 2026-09-23 | Open (superseded by TED-016/017) |
| TED-022 | 🟡 | CSV Update mode without an ID column matches only the child holding the plain-name key; a "#11" child's row creates a third camper | 2026-09-23 | Open (likely, code read) |
| TED-002 | 🟡 | Camper-number transition not complete. Page inventory A = 0, B = 323; the real remaining work is server-side (TED-011, TED-016..021) | 2026-09-23 | Open |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 2330ff9. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

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
| TED-010 | Invite `person_ids` slid onto a sibling when `camper_names` changed | 2026-09-23 | At 2330ff9: pgtest 260 (withdraw → [1], added in front → [5,1], departed-only → [null]) passes in my `npm run test:pg` (49/0). Follow-on gaps filed as TED-017/018/019. |
| TED-013 | CSV Replace without ID gave returning children new numbers | 2026-09-23 | At 2330ff9: `npm run test:keys` 17/17; step 5, Leah keeps #20, key and $30. `_returningCamper` requires one dob/email/address match. |
| TED-014 | Health sick-visit/medication forms decided the child by typed text | 2026-09-23 | At 2330ff9: `pickedCamper()` in both forms (`campistry_health.js:475-510`); `npm run test:lite` 12/12, shared typed name refused, pick records #702. |
| TED-015 | Name inventory was a loose regex; mislabelled name-ok | 2026-09-23 | At 2330ff9: reminder and missing list by number (diff); counter lists `.camper` comparisons (11); regenerating the inventory produced no diff. |

## Areas audited
| Area | Last deep audit |
|------|-----------------|
| Camper ID / camper number model (migrations 223-260, roster trigger, renumber, erase/merge, split repair, roster keys, invites, CSV import, Health entry) | 2026-09-23 (fifth pass) |
| Parent invitations (`link_parent_invites`, `upsert_parent_invite`, stamp trigger, `restamp_parent_invite`) | 2026-09-23 (numbers only) |
| Me page cloud save (`integration_hooks.js` batch upsert) | 2026-09-23 (only against the renumber trigger) |
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
| 2026-09-23 | Re-check TED-010..015 + hunt | 2330ff9 | unit 3270/14 · pg 49/0 · keys 17/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-recheck.md) |
