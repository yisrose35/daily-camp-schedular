# Ted's ledger

## Last commit checked
`4ce2489` (2026-09-23)

## Open findings
| ID | Severity | Description | Found | Status |
|----|----------|-------------|-------|--------|
| TED-050 | 🟡 | No automated test checks that the Me page sends camper numbers (`p_roster_ids`) to the family switch-off, or that it falls back only on PGRST202; a regression would silently return to by-name | 2026-09-23 | Open |
| TED-005 | 🟠 | 14 auto-scheduler tests fail (`auto_full_day.test.js`); still 14 at 4ce2489. Owner deferred. | 2026-09-23 | Open (deferred by owner) |

## Closed findings
| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
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
| Billing, payments, payroll | never (camper numbers and "#number" display only) |
| Bank deposit matching | never |
| Canteen / Snacks / Shop / POS | never (touched only through camper numbers) |
| Parent portal (Link) | never in a browser (database-level invite ownership checked 2026-09-23; Parents-page refusal wording run in isolation 2026-09-23) |
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
| 2026-09-23 | Check my work: TED-037..041 fixes | 50f96f6 | unit 3270/14 · pg 50/0 · keys 37/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-eleventh-recheck.md) |
| 2026-09-23 | Check my work: TED-040, 042, 043 fixes | 70cd931 | unit 3270/14 · pg 50/0 · keys 41/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-twelfth-recheck.md) |
| 2026-09-23 | Check my work: TED-044, 045 fixes | b6115a4 | unit 3276/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-thirteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-046 fix | 678e3a2 | unit 3277/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟢 | [report](reports/2026-09-23-camper-id-fourteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-047 fix | d049454 | unit 3277/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟡 | [report](reports/2026-09-23-camper-id-fifteenth-recheck.md) |
| 2026-09-23 | Check my work: TED-048, 049 fixes + Parents page wording | 4ce2489 | unit 3280/14 · pg 50/0 · keys 42/0 · lite 12/0 · smoke 32/0 · scale 24/0 | 🟢 | [report](reports/2026-09-23-camper-id-sixteenth-recheck.md) |
