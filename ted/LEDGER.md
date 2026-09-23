# Ted's ledger

## Last commit checked
`10f4461` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-037 | 🟠 | A page forced to reload by the erase rule still sends its blocked save on the way out (beforeunload keepalive fetch to /rest/v1/camp_state_kv goes around the guard); test:keys step 6 can't see it (CSP blocks the fake URL) | 2026-09-23 | Open |
| TED-038 | 🟠 | Campistry Lite's LITE_ASSET_VERSION not bumped: phones keep the old supabase_client.js with no erase guard, and Lite saves camp documents | 2026-09-23 | Open |
| TED-039 | 🟠 | Verify script says 260 ok with last round's 260 (no cache version, parent-readable numbers, no _rosterSeen); the guard then silently does nothing | 2026-09-23 | Open |
| TED-035 | 🟡 | Erased #2 reused on purpose + stale save: a record with only `camperId: 2` lands on the new child. Owner's rule (forced reload) built for the normal save; still reachable via TED-037/038 | 2026-09-23 | Open (depends on TED-037/038) |
| TED-040 | 🟡 | Erase guard doesn't cover edge-function calls (canteen refund / auto-reload carry camperId) and allows other writes for up to 15 s | 2026-09-23 | Open (suspected) |
| TED-041 | 🟡 | The erasing page's advance jumps to the newest version with Math.max, so it can skip the reload for another computer's erase a few seconds earlier | 2026-09-23 | Open (likely, code read) |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 10f4461. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
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
| Camper ID / camper number model (migrations 223-260, roster trigger, renumber, erase/merge, split repair, roster keys, invites, CSV import, Health entry) | 2026-09-23 (tenth pass) |
| Erase reload guard (`supabase_client.js` `_withEraseGuard`, camp_cache_epoch) | 2026-09-23 (browser run on scratch DB; Lite and edge functions by code read only) |
| Parent invitations (`link_parent_invites`, `upsert_parent_invite`, claim functions, stamp trigger, `restamp_parent_invite`) | 2026-09-23 (numbers; who may write them; staff access to codes via RPC and table policy, re-checked as `authenticated` at b92dcdc) |
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
| 2026-09-23 | Check my work: 261 + 260 repairs (TED-021, 023-027) | bd61488 | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-261-recheck.md) |
| 2026-09-23 | Check my work: TED-021, 028-030 fixes | 0909cee | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🔴 | [report](reports/2026-09-23-camper-id-ted028-recheck.md) |
| 2026-09-23 | Check my work: TED-021, 028, 031, 032 fixes | b92dcdc | unit 3270/14 · pg 50/0 · keys 31/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-ninth-recheck.md) |
| 2026-09-23 | Check my work: TED-033..036 fixes + erase reload rule | 10f4461 | unit 3270/14 · pg 50/0 · keys 34/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-tenth-recheck.md) |
