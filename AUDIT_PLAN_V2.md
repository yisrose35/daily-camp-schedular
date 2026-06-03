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

**Day 2 — Auth/session + refresh-token + global error handling**
- [ ] Chase **#V2-3**: does the Supabase client auto-refresh the JWT? Why does it expire to a hard re-login?
      Token expiry mid-action, reload unauth, deep-link unauth, access-code path, sign-out, two-tab session.
- [ ] Force-fail a cloud call on each major action → clear message, recoverable (no silent fail / raw stack).
- [ ] No secrets/PII in console or URL.

**Day 3 — Campers CRUD (adversarial) + the #V2-4 fix**
- [ ] Add/Edit/Delete camper with the full doctrine input battery; **fix #V2-4** (required-field validation +
      visible feedback); division→grade→bunk cascade correctness (stale/empty/wrong-filtered options);
      duplicate camper; orphan camper (no bunk); delete a camper in a bunk/family/billing.
- [ ] Global search, filters, sort, pagination over ~347 records; rapid add/delete; double-submit Save.

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

*Doctrine: assume bugs exist. Reproduce → root-cause → fix conservatively → live-verify → regression-check.*
