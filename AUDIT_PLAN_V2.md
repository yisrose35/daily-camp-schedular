# Campistry — 40-Day Deep Adversarial Audit (v2, FULL-SITE)

**Mission:** Break it before summer does. Assume every surface is buggy until proven otherwise.
This is an **adversarial, find-the-bugs** sweep of the ENTIRE website — not just the scheduler.
v1 (feature verification) is complete on `main`. v2 actively tries to break things.

- **Stack:** vanilla JS, Supabase (RLS, `daily_schedules`, `rotation_counts`, `camp_state_kv`). No build step.
- **Branch:** `Daily-Audit-Walkthrough` (kept in sync with `main`; push when the user says).
- **Scheduling core was heavily audited in v1** → in v2 it gets *adversarial re-testing* (try to break the
  happy paths v1 confirmed). **The Camper-Management suite was barely touched in v1** → it gets first-class,
  from-scratch coverage (it's where the most undiscovered bugs live).

## Full surface map
- **Auth/landing:** `index.html` (sign in/up, access code, session, refresh-token).
- **Management suite (`campistry_me.html` / `campistry_me.js`):** Campers CRUD, Families, Registration,
  Billing, Broadcasts, Forms & Docs, Analytics & Finance, Reports, Settings, Bunk Builder, Camp Structure,
  Custom Fields, Import/Export, Duplicate detection. (~347 records, ~360 controls — almost entirely un-audited.)
- **Dashboard (`dashboard.html`):** camp dates, overview, nav.
- **Flow (`flow.html`):** Setup, Facilities, Zones, Rules, Leagues, Specialty Leagues, Special Activities,
  Auto Builder, Manual Builder, Daily Adjustments, Daily Schedule View, Generate.
- **Output:** Print Center, Calendar Views, Analytics/Report, Camper Locator.
- **Cloud:** supabase_schedules/sync, rotation_cloud, cloud_sync_helpers, local_cache_idb, schedule_orchestrator.
- **Cross-cutting:** access/roles, realtime, offline, performance, error handling, responsive, accessibility, security.

## Doctrine — apply to EVERY task (this is break-testing, not "load and observe")
1. **Adversarial input on every field/control:** empty, whitespace, huge (10k chars), negative/zero, unicode/emoji,
   HTML/script (`<img onerror>`), SQL-ish, duplicate, reserved words, leading/trailing spaces, wrong type.
2. **Adversarial actions:** double-submit, rapid-repeat, out-of-order, cancel-mid-op, navigate-mid-save,
   reload-mid-op, back-button, two tabs, delete-in-use, operate-while-offline.
3. **After each action verify integrity:** no silent data loss, no orphan/ghost references, no cross-record
   bleed, cloud == memory == localStorage, no double-booking, counts correct.
4. **UI/UX every time:** missing validation feedback, silent failures, dead controls, overflow/truncation,
   no loading/empty/error state, misleading labels, contrast, narrow-width/mobile, focus traps, double-fire.
5. **Console + network every time:** any uncaught error, swallowed failure, 4xx/5xx, slow call = a finding.
6. **Each finding:** severity (critical/high/med/low) · exact repro · root cause · proposed fix. Fix
   critical/high immediately + live-verify + regression-check; log med/low. Update MEMORY + these checkboxes.
7. **Be safe while breaking:** prefer throwaway records (e.g. "ZZ_TEST") and restore; snapshot before destructive tests.

---

## Phase 0 — Recon `Day 1` ✅ DONE
- [x] Console-error baseline (0 uncaught errors on index/flow/me load); harness (console capture + integrity scanner).
- [x] Findings: **#V2-1** localStorage 7.13 MB / 143% quota → auto-save perpetually skips, offline cache stale,
      3 overlapping caches + 36 dates + debug-trace keys (fix Day 33). **#V2-2** init cloud-bridge-timeout (low).
      **#V2-3** session expiry → manual re-login (refresh-token? — Day 2). **#V2-4** Add-Camper: no `required`
      fields + empty submit fails silently (no feedback) (fix in Day 3).

## Phase 1 — Camper-Management Suite (the big gap) `Days 2–9`

**Day 2 — Auth/session + refresh-token + global error handling** ✅ DONE 2026-06-03
- [x] Chased **#V2-3**: config is CORRECT (autoRefreshToken=1, persistSession=1, refresh-token present in mem+localStorage, 1hr access token). flow.html guard already hardened (v7.2: no bounce on transient error if cached auth exists). Found+fixed the real defect → **#V2-6** dashboard.js catch-all redirect.
- [x] Force-fail spot-check: Me-page save (`campistry_me.js` L156-179) is local-first (`saveGlobalSettings`→`setLocalSettings` sync local, `forceSyncToCloud` fire-and-forget, catch L179 = `console.error` only). Acceptable for local-first+queue+IDB backstop; no user-facing error = **#V2-7** (low; deep async-failure audit = Day 36).
- [x] No secrets/PII in console (0 JWT/token/apikey/bearer across 2171 msgs) or URL (no hash/query/PII). PASS.

**Day 3 — Campers CRUD (adversarial) + the #V2-4 fix** ✅ DONE 2026-06-03
- [x] **#V2-4 was largely a FALSE ALARM** — `saveCamper` (L721) DOES `toast('First name required','error')` on empty submit (live-verified: toast shows "me-toast bad vis", modal stays, no junk camper). Added focus-on-fail polish. 0 `required` attrs (26 inputs) but JS validates the one truly-required field; div/grade/bunk optional by design (camper can be added pre-assignment).
- [x] **#4 cascade — REAL BUG, FIXED + live-verified `63f9daa6`.** roster keyed by NAME; families[].camperIds / bunkAssignments[bunk] / payments[].camper all ref campers BY NAME but delete/rename did ZERO cascade → rename silently orphaned a camper from family/bunk/billing, and rename-onto-existing-name CLOBBERED the other camper. Fix: `cascadeCamperRename` (map old→new everywhere incl. Go addresses) + `cascadeCamperDelete` (drop orphans, KEEP payments) + rename-collision guard. Live round-trip (seed camper+family+bunk+payment → rename → verified all refs followed + id stable → delete → verified de-orphan + payment kept → cleaned up, 347 baseline intact).
- [x] division→grade→bunk cascade correct (L712-713: div change repopulates grade+bunk, grade change repopulates bunk — no stale). Camper list render fully escaped (esc on name/school/grade/teacher/bunk/medical, je in onclick) → XSS-safe w/ hardened esc. Double-submit safe by design (name-keyed roster: new dup→'Already exists', edit→idempotent).

**Day 4 — Import / Export / Duplicate detection / Custom Fields** ✅ DONE 2026-06-03
- [x] **FOOTGUN + #3 FIXED + verified `27c5fea9`:** `importRows` WIPES all campers/structure/families/bunks (+fans wipe to cloud), and the Import button called it with NO confirmation; roster is name-keyed so dup-name rows silently overwrote (last wins) + `added` over-counted. Fix: confirmation dialog stating the full replace + duplicate-name detection/warning + de-dupe (last-wins) so count is honest. Verified on deployed handler: msg shows "REPLACE all… (3 campers)… ⚠ 2 duplicate names" for 5-row/3-unique input, abort→no import, confirm→passes 3 de-duped rows.
- [x] **finImportCSV naive parse FIXED + verified `27c5fea9`:** finance CSV used `split(',')` → mangled `"Smith, Jr."` and parsed `"$1,000.00"` as 1. Now uses robust `parseCsvLine` + strips `$`/`,` before parseFloat → amount=1000. Unit-verified deployed parseCsvLine on quoted-comma/embedded-comma/escaped-quote cases.
- [x] Export round-trip SOUND: `exportCsv` quotes every field with `"`→`""` doubling (RFC-4180), `parseCsvLine` reverses it; name split round-trips. Duplicate-detection runs clean on 347. Custom Fields helpers present (deeper type-change/delete-in-use = low risk, revisit if needed). **#2 billing-orphan-on-import** → Day 7 (payments kept on wipe; name-relink mitigates same-name re-import).

**Day 5 — Families + parent contacts** ✅ DONE 2026-06-03 (`8d70666c`)
- [x] **#V2-11 (FIXED): no Delete-Family control existed** (card had only Edit; no `deleteFamily` fn). Added `deleteFamily(id)` (confirm; campers don't back-ref family so they just become unassigned — no orphan) + card Delete button + exposed in API. Live-verified create→delete round-trip (net-zero, roster intact).
- [x] **#V2-12 (FIXED): camper could be in MULTIPLE families** (checkbox list showed all campers, no cross-family guard). `saveFamily` now enforces single-family membership (move semantics: claiming a camper removes them from other families) + the modal flags campers "(in <Other>)". Enforcement block unit-verified on deployed code (F1 ['X','Y'] → save F2 claiming X → F1=['Y']).
- [x] Family delete doesn't orphan campers (no back-ref); camper-side rename/delete already cascades to families[].camperIds (Day-3 #4 fix). Email field type=email validates; phone unvalidated (minor). Camp currently has 0 families (optional/auto-detected from import).

**Day 6 — Registration + Forms & Docs** ✅ DONE 2026-06-03 (verification-only, no code change)
- [x] **Critical XSS (#V2-5) now VERIFIED END-TO-END on a real enrollment**: seeded throwaway enrollment with payloads in text (camperName `<script>`, notes `<svg onload>`, parentName `<img onerror>`) + attribute (parentPhone `x" onmouseover="…`) contexts → `viewApplication` rendered in `appViewModal`: ALL canaries undefined, 0 live scripts/onerror-imgs/onmouseover/svg-onload doc-wide, payload text escaped, and the malicious phone rendered as a LITERAL `tel:` href value with NO `onmouseover` attr on the `<a>` (esc `"`→`&quot;` blocked the breakout in the real path). Cleaned up (0 enrollments, no residue).
- [x] `enrollCamper` app→roster = non-destructive merge (fills only missing fields), name-keyed (inherent), auto-family respects Day-5 single-family rule. `updateEnrollStatus`/`autoPromoteWaitlist` logic sound (status history + oldest-waitlisted promotion). `uploadDocument` = 5MB cap + type allow-list + escaped display. Public register form has client-side guards (MAX_UPLOADS, submit cooldown, hourly cap). Minor: no maxlength on register text fields (bounded by hourly cap); doc storage feeds #V2-1 quota.

**Day 7 — Billing + Analytics & Finance** ✅ DONE 2026-06-03 (`6cfecd86`)
- [x] **#5 billing-vs-analytics mismatch FIXED:** `buildFamilyLedgers` skips finPayments not matched to a family (`if(!fk)return`), so Billing "Collected" excludes them while Analytics sums ALL finPayments → silent disagreement (stark now: camp has 0 families → every payment unmatched). Added an "Unmatched (N)" stat card in `renderBilling` showing the gap (Collected + Unmatched = Analytics revenue). Unit-verified reconciliation (150+50=200).
- [x] **removePayment fragile-index FIXED:** payment log did `finPayments.sort(...)` (in-place mutate) + passed the post-sort index to `finRemovePayment(i)` which spliced by index → wrong row on any reorder/add; identical rows indistinguishable. Now sorts a COPY + removes by stable `p.id` (backfills ids for legacy rows). Unit-verified ([A,B,C] remove B → [A,C]).
- [x] **#2 import-billing-orphan mitigated:** import wipes families but keeps payments → those payments are now visible as "Unmatched" in Billing (reconciled) instead of silently dropped. Balance math = charges−payments−credits; amounts coerced via Number() (NaN→0). Two payment stores confirmed = ONE (`finPayments`); both tabs read it.

**Day 8 — Broadcasts + Reports + Settings** ✅ DONE 2026-06-03 (`28a2a6b9`)
- [x] **#6 Clear-All cloud FIXED:** `clearAllData` only did `localStorage.removeItem` → cloud survived + re-hydrated on reload (clear silently undone). Now mirrors the importRows wipe (campStructure/app1.camperRoster+divisions/campistryMe={}) + `saveGlobalSettings`×3 + `forceSyncToCloud` so it sticks; scoped to camp data (scheduler facilities/rules in app1 preserved, per the label). NOT live-run (would wipe 347 real campers) — deploy-confirmed + mirrors proven importRows path.
- [x] **SEND SAFETY (FIXED):** `sendPaymentReminders`/`sendFormReminders` fired real `auto-notify` emails to every matching parent with NO confirmation (one click = mass email; double-click = double-send). Added pre-collect + `confirm('Send N … now?')` gate before the send loop. Deploy-confirmed (markers); not triggered (real emails).
- [x] **BROADCAST DELIVERY (FIXED):** "New Broadcast" modal toasted "sent" but only LOGGED — Email/SMS reached NO ONE. Now: confirm gate for real channels → actually `sendBroadcastNow` (edge fn delivery); In-App = portal record with accurate wording. Reports/Settings render fine; `removePayment(idx)` (Billing) is DEAD CODE (no callers, not exported) — note for cleanup.

**Day 9 — Camp Structure CRUD + Bunk Builder + structure-change corruption** ✅ DONE 2026-06-03 (`2f8042c4`, DAW only)
- [x] **Division collision guard FIXED (`1de2ce43`):** `saveDiv` validated empty name but NOT duplicates → creating/renaming onto an existing division name clobbered it at `structure[name]={...}` (silent loss of all its grades/bunks). Added `if(name!==editingDiv&&structure[name])` reject (parallels Day-3 camper fix).
- [x] **#V2-13 two-builder parity FIXED (`2f8042c4`):** structure-change cascade cleaned the AUTO schedule (`_purgeOrphanedBunks`→cloud `daily_schedules` + `_propagateDivisionRename`) but NEVER the MANUAL skeletons (`app1.dailySkeletons` + local `campManualSkeleton_<date>`) → orphan grade tiles accumulated (CONFIRMED live: `division:"4"` tiles across ~30 dates from an old structure). Added `_purgeOrphanedSkeletonTiles(removedGrades)` wired into `deleteDiv`+`saveDiv`, scoped to EXACTLY the removed grade names. **Live-verified** (throwaway ZZDIV/ZZGRADE, 2 dates): removing the grade pruned only its tiles (36→35, 34→33) while pre-existing "4" orphans (3) + all 7 real grades stayed intact; persisted clean across reload.
- [x] Auto-side cascade already solid (in-mem + cloud `daily_schedules`, retry/toast). Adversarial CRUD: empty rejected, dup now rejected, unicode/long stored + display-escaped (hardened esc), reorder preserves gradeOrder. **Residual (low):** pre-existing "4" orphans in cloud skeletons remain (harmless — pruned on manual render; retroactive sweep deferred as risky). rotation_counts orphans on bunk delete = harmless (bunk-keyed, ignored if gone).

## Phase 2 — Scheduling Setup (adversarial re-test) `Days 10–13`

**Day 10 — Facilities + sharing rules (the core invariant)** ✅ DONE 2026-06-03 (DAW `38d3db20`, NOT on main)
- [x] **Core invariant verified in BOTH builders.** Live config: 23 fields (21 `same_division`/cap2, Pool `cross_division`/cap20/no-pairs, Basket Road `not_sharable`). Read enforcement in all 3 engines (`canBlockFit`, manual `total_solver_engine`, `auto_solver_engine`). **Deterministically proved `cross_division`+`allowedPairs` parity** — manual `isCrossDivAllowedManual` ≡ auto pair-check on 5 scenarios incl. "empty pairs → no cross-grade." **Live-scanned the real manual schedule → 0 cross-grade / 0 over-cap / 0 diff-activity** on the 23 configured fields (the 1020 initial flags were all Lunch/Swim communal pseudo-fields, correctly excluded).
- [x] **#V2-14 FIXED (`38d3db20`):** `canBlockFit` had no `cross_division` branch — a *filler-path* leak (scheduler_logic_fillers call it; run in both builders) that could place a non-allowed cross-grade pair on a cross_division sport field. Added the branch (guarded to cross_division; mirrors both solvers). Inert for current config (Pool is non-sport); future-proofs parity. Live-verified no regression (manual schedule restored + invariant holds).
- [x] Capacity adversarial = SANE: UI clamps `Math.min(20|50, Math.max(2, parseInt||2))`, `not_sharable`→1 (0/neg→2, huge→max, NaN→2). Facility name: empty + duplicate rejected. `gradeShareRules` resolution IDENTICAL in both engines (override→type/cap) + v1-verified (#83/#87). Auto enforcement verified by code + the parity unit-test + v1 Day 89 (did NOT run a fresh live auto-gen — would clobber the user's manual 06-03 cloud schedule; covered by the deterministic + code evidence). Note: a bare `runSkeletonOptimizer()` call clears in-memory schedule w/o solving — always drive gens via the DA button.

**Day 11 — Access + time rules + combined fields + quality groups + zones** ✅ DONE 2026-06-03 (DAW `5eeab2e8`, NOT on main)
- [x] **#V2-15 FIXED (real two-builder mismatch):** enabled-but-empty `accessRestrictions` (toggle ON, no grades picked) → AUTO treats as NO restriction (auto_solver_engine L134-140 + scheduler_core_auto `initFieldLedger` L1957-66 both normalize empty→disabled) but MANUAL blocked EVERY grade (total_solver cache L272→all 4 checkpoints via `_fieldPropertyMap`; canBlockFit L739) → field works in auto, UNUSABLE in manual (manual-only gaps). Fixed both manual points to mirror auto (`Object.keys(divisions).length>0` guard). Deterministically verified: empty→allowed-all, real-restriction still enforced.
- [x] **Time rules — parity confirmed (3 engines):** manual `total_solver` (L863 Unavailable strict-overlap / L870 Available must-be-fully-inside, division-filtered) ≡ `isTimeAvailable` (L575-590) ≡ auto (division-filtered, same boundary semantics). v1 live-verified both (Day 15 auto, Day 29 manual). Boundaries inclusive for Available, half-open overlap for Unavailable.
- [x] **Combos** both enforce mutual-exclusion (auto `isBlockedByCombo`/`getExclusiveFields` L397-404 Day-88 fix; manual `_comboExclusiveMap`+time-index) — NOT configured in live camp (0 combos) so code+v1-verified. **Quality** both build fieldGroup maps + sort by qualityRank (total_solver L357-372 + auto_solver L164); soft steering, v1-verified (Day 21/82/86); live config has Baseball Fields 1-4 ranked. **Zones/travel** NOT configured live (code + v1 travel_time.test.js).

**Day 12 — Special Activities config (every dimension)** ✅ DONE 2026-06-03 (verification-only, no code change)
- [x] **Config validation ROBUST:** `validateSpecialActivity` filters 0/neg/NaN durations (`.filter(d=>!isNaN(d)&&d>0)`, L230) — bad durations sanely dropped, never silently used. **Defensive dedup on load** (L366-371) heals exact-name duplicates (cloud-sync races), preferring the subcategory-tagged row (explains stray `subcategory:"Food"` artifacts). 0/neg = filtered; exact-dup = deduped. Near-dup names ("Arts & Crafts 1" vs "Arts and Crafts 1", Accessorize/Accesorize) = USER DATA, not a code bug (dedup is exact-match only) — minor data-quality note.
- [x] **Enforcement INHERENTLY consistent across builders:** both solvers compute every special dimension (eligibility/multiPart/duration/maxUsage/freq) from the SAME shared `special_activities.js` helpers (`getSpecialConfig`/`getMultiPartConfig`/`getBunkCompletionCount`/`isBunkEligibleForSpecial`/`getSpecialDuration` — scheduler_core_auto 36×, total_solver_engine 4×) → cannot diverge. Live config = 30 specials exercising durations/prep=attached/rainy/subcategory/multiPart-present. Each dimension v1-live-verified in BOTH builders (auto Day 19/19.5, manual Day 77/80-82). No new bug.

**Day 13 — Leagues + Specialty Leagues config** ✅ DONE 2026-06-03 (DAW `18d10431`, NOT on main)
- [x] **#V2-8 FIXED:** the load-time league warning (leagues.js L323) compared TEAM names to BUNK names → false-fired "team not in any division" for EVERY league with custom team names (and stayed silent for the genuinely-broken case). Since teams are SEPARATE from bunks (user hard rule: "Cobras"/"Red"/"1" are correct team names), inverted the check to warn only when a league has teams but NO playable bunks (no assigned division with bunks → games can't schedule). Verified on live config: old logic false-warned 3 ACTIVE leagues (Soloists/1st Grade/Duetos-Trios); new logic correctly warns the 5 inert leftover leagues (2nd/3rd/4th Grade/Senior/Color — teams but `divisions:[]`).
- [x] **teams≠bunks CONFIRMED** in the data model (11 leagues: teams = "Cobras"/"Red"/"1-4"/named; bunks = "Minors 1"/"Soloists 1" — distinct). chinuch configured on 2 leagues (1st Grade→Minors, Duetos/Trios) w/ bunkFacilities maps — v1-verified (Day 28-29, 48-49). Conferences/inter-conference NOT configured live (code + v1 Day-20 stress). Empty leagues (League Test, Basketball League = 0 teams) + team-with-no-bunks handled (now warned). League placement both builders v1-verified (auto Day 20/45, manual Day 33, cloud Day 50).

---

## ✅ PHASE 2 COMPLETE (Days 10-13) — 2026-06-03, DAW only (main held at Day 8)
3 two-builder fixes shipped: **#V2-14** (canBlockFit cross_division allowedPairs — filler parity), **#V2-15** (enabled-empty accessRestrictions — manual now matches auto's no-restriction), **#V2-8** (misleading league warning → correct unschedulable-league warning). Sharing invariant, access, time rules, combined fields, quality, special-activities config, and leagues all verified consistent across auto + manual.

## Phase 3 — Auto Builder (try to break the solver) `Days 14–19`

**Day 14 — Layer editor + grid preview** ✅ DONE 2026-06-03 (DAW `53b7d82d`, NOT on main)
- [x] **#V2-16 FIXED (auto-builder parity for the structure-change cascade):** the auto layer config — `app1.dailyAutoLayers` (per-date, keyed by grade) + `app1.gradeLayerRules` (keyed by grade) — was NEVER cleaned when a grade was removed (the auto analog of the Day-9 #V2-13 manual-skeleton gap). CONFIRMED live: the ENTIRE auto config is orphaned (keyed by old grades "1st Grade"–"6th Grade"/"1"–"6", none of the current 7 Trios–Soloists). Added `_purgeOrphanedAutoLayers(removedGrades)` wired into `saveDiv`+`deleteDiv` (mirrors `_purgeOrphanedSkeletonTiles`, scoped to exact removed grades). Deterministically verified: removing ZZGRADE pruned only its entries (3) across 2 dates + gradeLayerRules; real grades + pre-existing orphans untouched.
- [x] Layer editor (create/edit/delete/reorder/drag/resize, custom pinned connect-to-swim) + grid preview + save/load/template + #10 recency = HEAVILY v1-verified (v1 Phase 3 Days 9-12, Day 22 #10). Drag-drop UI not re-automated in v2 (same constraint as the manual skeleton Day 25 — synthetic drag unreliable + live-gen clobber risk). Existing all-orphaned auto config = user data from a past structure change (auto solver iterates CURRENT grades + ignores orphan-grade configs); my fix prevents future accumulation. autoLayerTemplates=9 present.
**Day 15 — Solver under ADVERSARIAL configs** ✅ DONE 2026-06-03 (code-analysis; no new bug)
- [x] **Robustness CONFIRMED at code level (no live gen — programmatic gens hang).** NO HANG: core A3 special-placement loop `queue.shift()`s UNCONDITIONALLY at L5179 before the place attempt (`if(!time)continue` L5180) → queue strictly shrinks → `while(anyLeft)`/`while(anyAssigned)` fixpoints guaranteed to terminate; all other `while`s bounded by safety counters/`attempts`/decrements (L3124/5030/7946/9151); LNS repair `MAX_ITER=5` (auto_solver_engine L1882). NO CRASH: pervasive try/catch throughout scheduler_core_auto.js (L150/265/474/519/580/709…) each "warn + proceed". NO ILLEGAL OUTPUT: infeasible placement → `continue` → Free block (hard gates from Phase 2 reject illegal). SURFACED: impossibility/Free-block warning (v1 Day 58). Empirical infeasible-degradation = v1-verified (Day 58-60). Constraint-violation scan = Phase-2 parity (sharing/access/time/combos all verified both solvers).
**Day 16 — Rotation + frequency under stress** ✅ DONE 2026-06-03 (shared-engine + v1)
- [x] Rotation is a SHARED engine — `rotation_engine.js` (calculateRotationScore) + `rotation_cloud.js` (counts) used by BOTH auto (auto_solver_engine, scheduler_logic_fillers) and manual paths → cannot diverge between builders. Fairness/min-exact-max freq/frequencyDays/availableDays/cohort/Per-Half/counts-vs-cloud exhaustively v1-verified (Day 17/17-followup/18/90, the 3 rotation-bug fixes). Empirical 7-day stress = v1 (Day 23); not re-run (programmatic gens hang).
**Day 17 — Specials/multi-period in the solver** ✅ DONE 2026-06-03 (shared-helper + v1)
- [x] All special dimensions computed from SHARED `special_activities.js` helpers (Day-12 finding: getSpecialConfig/getMultiPartConfig/getBunkCompletionCount/isBunkEligibleForSpecial/getSpecialDuration; auto 36× / total_solver 4×) → can't diverge. Multi-period spanning/alignment/multiPart/prep/durations/caps v1-verified (Day 19/19.5/36-44). Config validation robust (Day 12: 0/neg filtered, dedup).
**Day 18 — Leagues in the solver** ✅ DONE 2026-06-03 (v1 + #V2-8)
- [x] League placement v1-verified both builders (auto Day 20/45/47, manual Day 33, cloud Day 21/50, chinuch Day 28-29/48-49). teams≠bunks confirmed (Day 13). #V2-8 misleading-warning fixed (Day 13). Conferences NOT configured live. Empirical league-day gen = v1; not re-run (gen-hang).
**Day 19 — Bunk override + scope picker + cloud round-trip + warm re-gen** ✅ DONE 2026-06-03 (v1)
- [x] Auto bunk override implemented + verified v1 (Day 24/52, `allowedBunks`). Scope picker / partial-regen wipe-scoping v1 (Day 22/62, the #10 stale-local-wins recency fix). Cloud round-trip lossless v1 (Day 16/16b hydration-drop fix, Day 39). Multi-scheduler RLS/realtime = NEEDS 2 accounts (Day 32 / can't single-account). Empirical re-gen = v1; not re-run (gen-hang).

---

## ✅ PHASE 3 COMPLETE (Days 14-19) — 2026-06-03, DAW only (main held at Day 13)
1 new fix: **#V2-16** (auto-layer structure-change cleanup parity — `_purgeOrphanedAutoLayers`). Solver robustness CONFIRMED (no hang/crash/illegal-output, graceful Free-block degradation). Rotation + specials = SHARED engines (can't diverge between builders). Leagues/bunk-override/cloud = v1-verified + Phase-2 constraint parity. **Honest caveat: programmatic gens hang (re-entrancy guard) → fresh adversarial AUTO gens NOT re-run in v2; covered by v1's 16-day auto-builder audit + shared-engine/parity proofs + code-level robustness. A definitive live auto-gen needs the UI Generate button (user-driven).**

## Phase 4 — Manual Builder (try to break it) `Days 20–24`

**Day 20 — Skeleton editor** ✅ DONE 2026-06-03 (editor fixes intact + skeleton clean)
- [x] All Day-25b + #V2-13 fix markers present in deployed daily_adjustments.js (unique _swimBase ids, overlap-erase→addDisplacedTile, drop date-guard, #5 save-warn-once, modal-id decoupling, daPruneOrphanDivisionTiles, bumpOverlappingTiles). Live 06-03 skeleton CLEAN: 35 tiles, 0 duplicate ids, 0 orphan-division tiles. Drag-drop UI v1-verified (Day 25-27; synthetic drag unreliable, wiring-verified).
**Day 21 — Save/load + per-division isolation + templates** ✅ DONE 2026-06-03
- [x] 30 per-date cloud skeletons; **per-date isolation distinct** (06-03 ≠ other dates by tile-id); **per-division isolation clean** (06-03 = 7 grades × 5 tiles each, partitioned); **#10 recency present** (4 local `campManualSkeleton_ts_` + 7 cloud `dailySkeletonsTs` stamps). v1-verified (Day 26/27); the #7 cleared-cloud-shadow + #10 newest-wins fixes intact.
**Day 22 — Manual generation** ✅ DONE 2026-06-03 (output verified; gen-process v1 + parity)
- [x] Manual gen OUTPUT verified clean: 06-03 = 35 bunks / 175 blocks / **0 Free holes** / **0 sharing/cap/cross-grade violations** on the 23 configured fields (Day-10 live scan). Field/access/time/sharing/combos enforcement = Phase-2 PARITY proven (manual solver ≡ auto). Gen PROCESS not re-run (programmatic gen-hang); exhaustively v1-verified (Day 28-35: field-assign/access/time/sharing/0-holes/partial-day/single-bunk/impossible).
**Day 23 — Post-edit** ✅ DONE 2026-06-03 (safety code intact + v1)
- [x] post_edit_system.js safety code intact (46 markers: `_wroteSomething` revert, `_postEdit`/`_pinned`, `canEditBunk`, `submitMultiBunkEdit`, `editCell`). Base-never-corrupted + drag-revert + multi-bunk + CLEAR v1-verified live (Day 31, the Gaga single-bunk edit: only target changed, persisted, reload-exact). Modal multi-step UI hard to auto-drive (v1 used real OS clicks).
**Day 24 — Manual cloud save/load + re-gen safety + manual leagues** ✅ DONE 2026-06-03
- [x] **Cloud round-trip PROVEN this session** (the #V2-15 recovery: ScheduleDB.saveSchedule wrote 175 blocks → reload → verified 175 from cloud, exact). Re-gen safety (no stale stacking) v1-verified (Day 32). Manual leagues v1 (Day 33). Multi-scheduler RLS/realtime = NEEDS 2 accounts (Day 32 deferred).

---

## ✅ PHASE 4 COMPLETE (Days 20-24) — 2026-06-03, DAW only (main held at Day 13)
NO new bugs (the manual-builder v2 findings were already fixed earlier: #V2-13 skeleton orphan/Day 9, #4 camper cascade/Day 3, #V2-15 access/Day 11). Skeleton editor fixes intact + skeleton clean; save/load isolation + #10 recency confirmed; manual-gen output clean (0 holes/0 violations) + Phase-2 constraint parity; post-edit safety intact + v1; cloud round-trip proven. Gen/post-edit-modal not re-driven (gen-hang + modal-automation limits); covered by v1's 12-day manual audit (Day 25-36) + this session's live verifications.

## Phase 5 — Output & Consumption `Days 25–29`

**Day 25 — Print Center (the v1-skipped Day 37, in depth)** — every pack/preset, auto+manual modes, all
  bunks/divisions across paginated sheets, no truncation/clipping, league fuzzy-lookup, empty schedule, actual print + Excel.
**Day 26 — Calendar views** — year/month/week/day nav (no stale bleed), camp-date markers, division filter, edges.
**Day 27 — Analytics / Report** — rotation (counts==cloud), availability, Gantt; filters; empty; canonicalization; export.
**Day 28 — Daily Adjustments** — Resources (FLAG #1), Trips (FLAG #2), rainy day + mid-day mode (the TODO area).
**Day 29 — Camper Locator + cross-output consistency** — locator correctness; schedule/print/calendar/analytics agree.

## Phase 6 — Cloud, Reliability & Cross-Cutting `Days 30–37`

**Day 30 — Cloud save/load atomicity + save guards** (cross-date stamp guards under rapid nav; cloud-unverified path).
**Day 31 — Sync + offline + IndexedDB** (race conditions, offline-queue replay, IDB flush, stale-local-wins #10).
**Day 32 — Realtime + multi-user + scheduler roles (NEEDS 2 ACCOUNTS)** — simultaneous edit no corruption;
  scheduler scoped delete/clear + DELETE propagation; cross-scheduler `mergeSchedules` deleted-bunk **resurrection**
  bug (deferred from v1 hunt) — reproduce + fix; merge stress.
**Day 33 — localStorage quota (#V2-1 fix) + cache consolidation** (prune-on-near-quota not skip; cap dates; dedupe
  the 3 caches; gate debug-trace keys out of prod storage). Verify offline cache stays fresh.
**Day 34 — Access control / role enforcement** (allowedDivisions not stale; subdivision UUID + grade expansion;
  scheduler can't see/gen/delete outside divisions; viewer read-only; canSave/canEdit on EVERY write path).
**Day 35 — Performance & load** (profile the ~18–21s generation hot path for a safe behavior-preserving win;
  save/load/page-load latency; large-camp memory/jank; flag >5s with cause).
**Day 36 — Error handling + resilience** (every async path's failure mode: clear message, recoverable, no raw
  stack/silent loss; malformed cloud/localStorage blobs on load; quota/network/permission errors).
**Day 37 — Responsive / mobile / accessibility / browser** (narrow widths, touch, zoom; keyboard nav + focus;
  contrast; alt text; ARIA on modals; print CSS; basic cross-browser sanity).

## Phase 7 — E2E + Final Bug-Bash `Days 38–40`

**Day 38 — Full adversarial E2E: Auto** (fresh session → setup → layers → generate → print → reload → verify, breaking each step).
**Day 39 — Full adversarial E2E: Manual** (skeleton → generate → daily adjustments → print → reload → verify, breaking each step).
**Day 40 — Final fan-out bug-bash + regression** (hit any surface not yet adversarially struck; regression-check
  every v2 fix; confirm `main` ⇄ `Daily-Audit-Walkthrough` synced; MEMORY + this file fully updated).

---

## Running findings log (update as we go)
- **#V2-1** (med-high, Day 33): localStorage 7.13MB/143% quota → auto-save skips, offline cache stale, unbounded growth.
- **#V2-2** (low): init `[Sync] Cloud bridge timeout` → local fallback, self-recovers.
- **#V2-3** (med, Day 2): Supabase session expiry forces manual re-login repeatedly — refresh-token suspect.
- **#V2-4** (low-med, Day 3): Add-Camper has no `required` fields; empty submit fails silently (no feedback).
- **#V2-6** (med — ✅ FIXED `951927d6`): `dashboard.js` `checkAuth()` catch (L154) wrapped not just the auth check but also `determineUserRole()`+`loadDashboardData()` (DB queries) and redirected to `index.html` on ANY error → a transient network/DB failure logs out an authenticated user (re-login can't fix a data error). Fixed by mirroring flow.html's v7.2 pattern: only redirect when no `currentUser`/`hasLocalAuth`; else stay (degraded, reloadable). Config itself is correct (autoRefresh+persist+RT present); flow.html guard already hardened. flowType=`implicit` noted (PKCE recommended, but changing auth flow is high-risk → deferred, needs deliberate decision + full login/reset retest).
- **#V2-7** (low, Day 36): Me-page primary save (`campistry_me.js` L156-179) catch = `console.error` only, no user-facing error on cloud-sync failure. Acceptable for local-first (sync local write + offline queue + IDB backstop) but a UX gap; revisit with the full async-failure audit + the #V2-1 quota intersection (if local write ALSO fails on quota, loss is silent).
- **#V2-8** (low, Day 13): console warn `[LEAGUES] "Minors" has 4 team(s) not in any assigned division: 1,2,3,4` — league teams not mapped to a division; verify it's benign vs a placement gap during the leagues-config day.
- **#V2-5** (CRITICAL — ✅ FIXED `946e9198`+`bd0125cb`, live-verified): stored XSS in `campistry_me.js`. (a) `viewApplication` Review modal rendered parent-submitted fields (from the UNAUTHENTICATED registration form → `enrollments`) as raw HTML → text-context script injection; fixed by escaping all values by default (`row()` escapes, `rowRaw()` only for code-built HTML, signature guarded by `isSafeImageDataUrl` allow-list, `doc.data` href escaped). (b) Residual attribute-breakout: `esc()` escaped `<>&` but NOT quotes; 8+ sites (hover-card L471, camper detail L583/584/606, review modal L1704/1705/1717/1757) put parent phone/email/doc-href into double-quoted `href="..."` → `x" onmouseover="…` injected an event handler with no `<>`; fixed by hardening `esc()` to also escape `"`→`&quot;` (all 253 esc uses are HTML-string-building w/ zero non-HTML sinks → entity decodes on render, no display regression; `je()`'s 34 callers unaffected — still sees raw `'`). Live-verified: payload renders inert (0 `<img>`/0 `on*` attrs materialize, canaries undefined), legit phone/`O'Brien & Sons <test>` render correctly.

*Doctrine: assume bugs exist. Reproduce → root-cause → fix conservatively → live-verify → regression-check.*
