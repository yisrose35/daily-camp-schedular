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

**Day 4 — Import / Export / Duplicate detection / Custom Fields**
- [ ] Import: malformed CSV, wrong columns, dup rows, huge file, unicode, injection cells, partial/abort,
      re-import (idempotent?). Export round-trips (export→import == identity?). Duplicate-detection accuracy
      (false pos/neg). Custom Fields: add/edit/delete, type changes, field used-in-data deletion.

**Day 5 — Families + parent contacts**
- [ ] Family CRUD, link/unlink campers, a camper in two families, delete a family with campers, contact
      validation (phone/email), sibling grouping; cascade to camper records; persistence + cloud.

**Day 6 — Registration + Forms & Docs**
- [ ] Registration flow/states, status transitions, required vs optional, partial submit, re-submit;
      Forms & Docs: create/assign/fill/upload, file-type/size limits, missing-file, completion tracking.

**Day 7 — Billing + Analytics & Finance**
- [ ] Billing: charges/discounts/payments, negative/zero/huge amounts, currency/rounding, refund, balance
      math correctness, delete-in-use; Analytics&Finance numbers reconcile with underlying records.

**Day 8 — Broadcasts + Reports + Settings**
- [ ] Broadcasts: compose/recipients/send (DON'T actually send to real recipients — verify the gate),
      empty recipients, huge body; Reports: every report renders + numbers correct + export; Settings:
      every toggle persists + takes effect, invalid values rejected.

**Day 9 — Camp Structure CRUD + Bunk Builder + structure-change corruption**
- [ ] Division/Grade/Bunk CRUD adversarial (dup/empty/unicode/reserved/long/reorder/delete-in-use); Bunk
      Builder drag/assign; **generate a schedule then mutate structure** → verify no half-migrated/orphaned
      schedule, skeleton, or rotation-count state (the v1 Day-8 area, harder). Persistence + cross-tab.

## Phase 2 — Scheduling Setup (adversarial re-test) `Days 10–13`

**Day 10 — Facilities + sharing rules (the core invariant)**
- [ ] Fields CRUD + capacity (0/neg/huge) + indoor/outdoor + per-day disable; EVERY `sharableWith` type +
      `gradeShareRules` + allowedPairs/allowedDivisions; adversarial/contradictory configs. Re-confirm
      "no 2 grades share unless turned on" holds in both solvers + every post-pass.

**Day 11 — Access + time rules + combined fields + quality groups + zones**
- [ ] accessRestrictions (incl. enabled-but-empty), timeRules (Available/Unavailable, boundaries, overlaps),
      fieldCombos mutual-exclusion, quality/seniority, zones/travel extremes — all hard-enforced in both solvers.

**Day 12 — Special Activities config (every dimension)**
- [ ] durations[], prep (staggered/synced), multiPart (daysBetween), freq (min/exact/max), frequencyDays,
      availableDays, cohort, maxUsage, subcategory+caps, isIndoor, rainy variants, concurrency. Contradictory
      combos, 0/neg, name collisions → enforced or sanely rejected, never silently ignored.

**Day 13 — Leagues + Specialty Leagues config**
- [ ] League/team CRUD, team↔bunk mapping (NEVER conflate), chinuch, indoor-court req, color leagues,
      conferences/inter-conference (the latent double-booking trap), odd team counts/byes, team with no bunks.

## Phase 3 — Auto Builder (try to break the solver) `Days 14–19`

**Day 14 — Layer editor + grid preview**
- [ ] Layer/block create/edit/delete/reorder/drag/resize, overlapping/zero-length/cross-division, custom
      pinned (connect-to-swim), save/load/template, corrupt-blob load; grid live-accuracy + large camp.
**Day 15 — Solver under ADVERSARIAL configs**
- [ ] Over-constrained / near-infeasible / infeasible → no crash/hang/illegal output; degrade gracefully.
      Scan every field+time for access/conflict/capacity/sharing/time/cooldown/combo violations.
**Day 16 — Rotation + frequency under stress** (7-day gen; fairness; every freq rule; Per-Half; counts vs cloud).
**Day 17 — Specials/multi-period in the solver** (spanning, alignment, multiPart, prep, durations, caps).
**Day 18 — Leagues in the solver** (placement for all bunks on a league-period day; opponents; back-to-back; specialty).
**Day 19 — Bunk override + scope picker + cloud round-trip + warm re-gen** (authoritative override; partial wipe; lossless).

## Phase 4 — Manual Builder (try to break it) `Days 20–24`

**Day 20 — Skeleton editor** (every tile type create/drop/move/resize/delete/merge; overlap; column reorder; ids).
**Day 21 — Save/load + per-division isolation + templates** (round-trip, isolation, template-onto-fresh-date, #10).
**Day 22 — Manual generation** (field/access/time/sharing/combos enforced; 0 holes; partial-day; single-bunk; impossible).
**Day 23 — Post-edit (every path incl. v1 Bug-A)** (click-edit modal scopes + typeahead + CLEAR; drag-move/resize;
  drag-onto-occupied revert; multi-bunk; pinned; undo; base never corrupted).
**Day 24 — Manual cloud save/load + re-gen safety + manual leagues** (lossless; no stale stacking; league slots).

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
