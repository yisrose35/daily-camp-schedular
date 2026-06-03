# Campistry — 40-Day Deep Adversarial Audit (v2)

**Mission:** Break it before summer does. v1 (the feature-verification audit) is COMPLETE and on `main`.
v2 is an **adversarial, exhaustive** sweep: every page, panel, control, function, branch, and state —
with the explicit goal of **finding real bugs**, not confirming happy paths. Assume something is wrong
on every surface until proven otherwise.

- **Stack:** vanilla JS, Supabase (RLS, `daily_schedules`, `rotation_counts`, `camp_state_kv`). No build step.
- **Working branch:** `Daily-Audit-Walkthrough` (kept in lock-step with `main`; push when the user says).
- **Surfaces:** `index.html` (auth/landing), `dashboard.html`, `campistry_me.html` (structure), `flow.html`
  (Setup, Facilities, Zones, Rules, Leagues, Specialty Leagues, Special Activities, Auto Builder, Manual
  Builder, Daily Adjustments, Daily Schedule View, Generate), Print Center, Calendar Views, Analytics/Report,
  Camper Locator.

## Audit doctrine (apply EVERY day)
1. **Adversarial first.** For each control/function ask: what input breaks it? empty, huge, negative,
   duplicate, unicode/emoji, whitespace, contradictory, mid-operation, rapid-repeat, out-of-order?
2. **Watch the console.** Capture every error/warning during each test. An uncaught throw = a finding.
3. **State integrity.** After every action, verify no cross-date / cross-division / cross-bunk bleed,
   no silent data loss, no double-booking, no orphaned/stale state, cloud == memory == localStorage.
4. **UI/UX.** Layout breakage, overflow/truncation, missing loading/empty/error states, misleading
   labels, dead controls, focus traps, unreadable contrast, mobile/narrow width, double-submit.
5. **Stress.** Large camps, rapid clicks, concurrent ops, slow/failed network, reload mid-operation.
6. **Verdict.** Each finding: severity (critical/high/med/low), exact repro, root cause, proposed fix.
   Fix critical/high immediately + live-verify; log med/low. Update MEMORY + this file's checkboxes.
7. **Verify the fix, then regression-check** the surrounding surface. Conservative, additive fixes.

---

## Phase 0 — Recon, Harness & Baseline `Days 1–2`

**Day 1 — Global recon + console-error baseline + surface inventory**
- [ ] Load every page (index, dashboard, me, flow + every flow panel, print, calendar, analytics, locator);
      capture ALL console errors/warnings on load and first interaction. Each one is a candidate finding.
- [ ] Inventory every interactive control per surface (buttons, inputs, selects, toggles, drag targets,
      modals) into a checklist the later days consume. Flag any dead/no-op control.
- [ ] Build a reusable **integrity scanner** (coverage/holes, double-booking on real fields, cross-date
      stamp coherence, cloud-vs-memory-vs-localStorage fingerprint) and a **console-capture hook**.
- [ ] Baseline current generated schedules; snapshot cloud state so later destructive tests can restore.
- Done when: every surface loads documented, console-error list captured, scanner + capture hook ready.

**Day 2 — Auth, session, routing, and global error handling**
- [ ] Auth/session: token expiry mid-session (flow→index bounce — confirm graceful, no data loss),
      reload while unauthenticated, deep-link to flow.html without auth, access-code path, sign-out.
- [ ] Routing/navigation between pages — back/forward, stale tab, two tabs same camp.
- [ ] Global error handling: force a failed cloud call (offline) on each major action; verify a clear
      user-facing message (not a silent failure or a raw stack), and recoverable state.
- [ ] `DEBUG` flags still false; no secret/PII in console or URL params.
- Done when: auth edge cases handled gracefully, no silent failures on the main actions.

---

## Phase 1 — Camp Structure & Setup `Days 3–7`

**Day 3 — Division/Grade/Bunk CRUD adversarial (`campistry_me.js`)**
- [ ] Create/edit/delete/reorder each level; duplicate names, empty names, whitespace-only, unicode/emoji,
      very long names, names colliding with reserved words ("Free", "Lunch", "League Game", "Swim").
- [ ] Delete a division/grade/bunk that is referenced by a schedule, league, access rule, or skeleton —
      verify references handled (cleaned or blocked), no orphans, no crash.
- [ ] Rapid create/delete; create 50+ bunks; reorder during save; double-click save.
- Done when: every CRUD path safe under adversarial input; no orphaned references; cloud-persisted.

**Day 4 — Structure persistence + cloud round-trip + cross-tab**
- [ ] Each structure change persists to `camp_state_kv`; reload + logout-proxy round-trip; offline edit → reconnect.
- [ ] Two tabs editing structure — last-writer behavior, no corruption, no lost grades.
- [ ] Malformed/partial `camp_state_kv` blob on load — does the app degrade gracefully or crash?
- Done when: structure survives reload/offline/cross-tab without loss or corruption.

**Day 5 — Structure-change-after-schedule corruption (the v1 Day-8 area, harder)**
- [ ] Generate a full schedule, then rename/add/remove divisions, grades, AND bunks; reload Flow.
- [ ] Verify the existing schedule is intact OR cleanly pruned (no half-renamed bunks, no orphan tiles,
      no stale rotation counts pointing at dead bunks, no print/analytics referencing ghosts).
- [ ] Re-generate after structural change — scope correctness, no resurrection of removed bunks.
- Done when: structural edits never corrupt or half-migrate an existing schedule.

**Day 6 — Builder-mode toggle + Me→Flow handoff + camp dates (dashboard)**
- [ ] Builder mode toggle persistence + mid-generation switch + rapid toggle; both modes see the same setup.
- [ ] Camp dates (start/half1End/half2Start/end): invalid orderings (end<start, half2<half1, overlapping),
      empty, far-future, single-day camp; persistence + read-only for scheduler role; the **two stores**
      (`camp_state_kv:campDates` vs the stale `app1.campDates`) — reconcile or document the live source.
- [ ] Me→Flow handoff: every configured division/bunk/activity/league present in Flow; add config in Me
      while Flow is open in another tab — does Flow pick it up / need reload / break?
- Done when: mode + camp dates persist and are honored; handoff complete; invalid dates rejected sanely.

**Day 7 — Setup panel + Zones/Travel + Rules**
- [ ] Flow "Setup (Bunks/Divisions)" panel — every control, empty camp, single bunk.
- [ ] Zones/travel time — assign zones, extreme travel minutes, zone deletion in use, travel honored in gen.
- [ ] Rules panel — every rule type, contradictory rules, empty, and that the solver actually reads them.
- Done when: setup/zones/rules panels behave under adversarial config and feed the solver correctly.

---

## Phase 2 — Facilities & Activity Config `Days 8–12`

**Day 8 — Fields CRUD + capacity + indoor/outdoor + per-day disable**
- [ ] Add/edit/delete fields; capacity 0 / negative / huge; duplicate field names; indoor/outdoor flags;
      Daily-Adjustments per-field/per-sport disable for a day — honored in gen, reversible, per-date.
- [ ] Delete a field referenced by a sport/special/league/skeleton — orphan handling.
- Done when: field config robust; per-day disable scoped + honored; no orphans.

**Day 9 — Field sharing rules (the core invariant)**
- [ ] Every `sharableWith.type`: not_sharable, same_division, cross_division (+ allowedPairs), custom
      (+ allowedDivisions), all. Per-grade `gradeShareRules` overrides. Capacity interplay.
- [ ] Adversarial: allowedPairs with self-pairs only, empty allowedPairs on cross_division, custom with
      empty divisions, gradeShareRules contradicting sharableWith. **Confirm "no 2 grades share unless
      turned on" holds in BOTH solvers + every post-pass (incl. the drop-refill guard shipped in v1).**
- Done when: sharing enforced exactly per config in auto + manual, every type, with 0 illegal co-locations.

**Day 10 — Access restrictions + time rules + combined fields + quality groups**
- [ ] accessRestrictions (enabled/divisions/per-bunk/usePriority/priorityList); enabled-but-empty edge.
- [ ] timeRules Available/Unavailable windows, division-filtered, boundary minutes, overlapping windows.
- [ ] Combined fields (fieldCombos) — mutual exclusion honored; quality groups / fieldGroup seniority.
- Done when: access + time + combos + quality all enforced as hard constraints in both solvers.

**Day 11 — Special Activities config (every dimension)**
- [ ] Every field: durations[] (multi), prepConfig (staggered/synced), multiPart (daysBetween),
      frequency (min/exact/max), frequencyDays cooldown, availableDays, rotationCohort, maxUsage per-grade,
      subcategory + caps, isIndoor, rainyDayOnly/Exclusive/Available, concurrency ("bunks at a time").
- [ ] Adversarial: contradictory combos (exact freq > available slots, prep room cap 1 with synced for
      many bunks, multiPart daysBetween > camp length), 0/negative values, name collisions.
- Done when: every special-config dimension is enforced or sanely rejected; no silent ignores.

**Day 12 — Leagues & Specialty Leagues config**
- [ ] League CRUD, teams, team↔bunk mapping (NEVER conflate — separate concepts), chinuch, indoor-court req,
      sports, divisions, color leagues, conferences/inter-conference (the latent specialty-league trap).
- [ ] Adversarial: odd team counts (byes), a team with no bunks, a bunk on two teams, deleting a team mid-season.
- Done when: league/specialty config robust; team/bunk separation never violated.

---

## Phase 3 — Auto Builder `Days 13–20`

**Day 13 — Layer editor (DAW grid) every operation + drag**
- [ ] Create/edit/delete/reorder layers + blocks; drag/resize blocks; overlapping blocks; zero-length;
      cross-division blocks; custom pinned layers ("connect to swim" adjacency); rapid edits; undo.
- [ ] Save/load/template round-trip; per-date layers vs template fallback; corrupt layer blob on load.
- Done when: layer editor reliable under adversarial editing; persistence exact; no data loss.

**Day 14 — Grid preview accuracy + large camp**
- [ ] `auto_schedule_grid.js` reflects layer state live (no stale render); empty/single/cross-division;
      large camp (7+ div / 35+ bunks) — overflow, truncation, perf; reload hydration from cloud not stale local.
- Done when: grid always matches state; large camp renders cleanly.

**Day 15 — Solver correctness under ADVERSARIAL configs**
- [ ] Over-constrained / near-infeasible / fully-infeasible configs — solver must not crash, infinite-loop,
      or silently produce illegal placements; it should degrade (Free + warning) gracefully.
- [ ] Every hard constraint re-verified on output: access, field conflict, capacity, sharing/allowedPairs,
      time rules, cooldown, combined-field exclusion. Scan EVERY field+time for violations.
- Done when: no crash/hang/illegal output across the adversarial config battery.

**Day 16 — Solver: rotation, frequency, fairness under stress**
- [ ] 7-consecutive-day generation; verify fairness, min/exact/max freq, frequencyDays, availableDays,
      cohort pooling, Per-Half reset at the boundary, escalation bonuses don't favor one bunk.
- [ ] rotation_counts cloud correctness across re-gen (no double-count, no reset, league games excluded — v1 fix).
- Done when: multi-day rotation is fair + every frequency rule holds + counts are exact.

**Day 17 — Specials & multi-period in the solver**
- [ ] Multi-period spanning (continuation _startMin/_endMin, capacity across spans, pinned preservation),
      period-boundary alignment (no unfillable gaps), multiPart ordering+daysBetween, prep reservation,
      durations best-fit, subcategory caps — all under a mixed-config stress day.
- Done when: every special variant places correctly with no double-book, no gap, no cap breach.

**Day 18 — Leagues in the auto solver**
- [ ] League games place for all participating bunks on a league-period day; opponents correct; back-to-back
      away games; chinuch bye lines; specialty leagues; multiple leagues same day. **Confirm leagues actually
      appear when the day's layer has a league period** (v1 Day-39 noted a fresh-date template had none).
- Done when: leagues place + render + persist correctly when configured for the day.

**Day 19 — Bunk override + generation scope picker + partial regen**
- [ ] Bunk override (authoritative + exclusive) in auto; min-players pairing partner copy; scope picker
      (select subset of divisions) — partial wipe only clears selected, others byte-identical, scope honored
      in fallback fill. Adversarial: override onto restricted/occupied field, scope = none, scope = all.
- Done when: overrides authoritative; partial regen never touches out-of-scope divisions.

**Day 20 — Auto cloud round-trip + warm-regen + stress**
- [ ] Generate → cloud save (all bunks, no truncation, _autoGenerated) → reload → exact hydrate (no Day-16b
      drop). Warm re-gen (regenerate over existing) — no stacking, no stale. Large-camp timing.
- Done when: full auto cloud round-trip is lossless incl. warm re-gen.

---

## Phase 4 — Manual Builder `Days 21–26`

**Day 21 — Skeleton editor: every tile type + drag/resize/merge**
- [ ] All 14 tile types create/drop/move/resize/delete; merge Swim+Elective; overlap reconciliation;
      column reorder; unique-id integrity; rapid drag; drop during date-change; displaced-tiles panel.
- Done when: skeleton editor reliable for every tile op; no silent overlap, no lost/dup tiles.

**Day 22 — Skeleton save/load + per-division isolation + templates**
- [ ] Save/load round-trip + cloud (`camp_state_kv`) + logout-proxy; per-division isolation (edit A ≠ touch B);
      template load onto a fresh date (the v1 fiddle — make it work); orphan-division tile prune; #10 recency.
- Done when: skeletons persist, isolate per division, templates load cleanly onto any date.

**Day 23 — Manual generation correctness**
- [ ] Field assignment, access, time rules, sharing, combined fields — all enforced; 0 holes on a complete
      skeleton; partial-day skeleton; single-bunk division; impossible slot handled without crash.
- Done when: manual gen output is constraint-clean and gap-correct.

**Day 24 — Post-edit: every edit path (incl. the v1 Bug-A area)**
- [ ] Click-edit modal (single/division/select scope + activity typeahead + CLEAR); drag-move + drag-resize
      on the auto per-bunk grid (`.asg-wrap`) — incl. the **drag-onto-fully-occupied revert** (v1 fix);
      multi-bunk edit; pinned/fixed blocks; undo. Verify base never corrupted, only target changes.
- Done when: every post-edit path is surgical, reversible, and cloud-safe; drag-onto-occupied reverts.

**Day 25 — Manual cloud save/load + re-generation safety**
- [ ] Save → reload → exact; re-gen after daily adjustments doesn't stack stale; multi-division gen;
      the expanded ~328-tile per-bunk skeleton re-save safety (v1 Day-32 flag).
- Done when: manual save/load/re-gen are lossless and stale-free.

**Day 26 — Manual leagues + edge cases**
- [ ] League slot in a skeleton → games placed + persisted; multi-division manual gen isolation;
      edge cases (single bunk, partial day, overlapping impossible restrictions).
- Done when: manual league + edge cases clean.

---

## Phase 5 — Rotation / Leagues / Specials runtime `Days 27–30`

**Day 27 — Rotation engine deep + analytics cross-check**
- [ ] Least-recent selection, escalation, cohort, Per-Half — trace the scoring on real multi-day data;
      analytics rotation report == `rotation_counts` table (the v1 stale-segment fix) across all divisions.
- Done when: rotation logic + report counts provably correct.

**Day 28 — Rainy day + mid-day mode**
- [ ] isIndoor fallback, rainyDayOnly/Exclusive/Available; auto-switch skeleton; mid-day rain activation
      mid-schedule (the long-standing TODO area) — does it corrupt or cleanly restructure the remaining day?
- Done when: rainy + mid-day modes behave correctly and reversibly.

**Day 29 — Leagues runtime: standings, results, fixtures**
- [ ] Enter game results → standings update; round-robin fairness; back-to-back away; fixture persistence
      across reload; deleting/editing a result; chinuch/bye handling; off-campus double-headers.
- Done when: league runtime (standings/fixtures/results) correct + persistent.

**Day 30 — Specialty leagues + trips + resources (Daily Adjustments)**
- [ ] Specialty league placement + the latent conference double-booking trap; Trips (input + future-date
      save + honored by both builders — FLAG #2); Resources panel inside DA (FLAG #1).
- Done when: specialty leagues, trips, and resources all correct under adversarial use.

---

## Phase 6 — Output & Consumption `Days 31–34`

**Day 31 — Print Center: every pack + preset + mode (the v1-skipped Day 37, in depth)**
- [ ] Director's Pack, Parent Handout, Per-Bunk Sheets, Counselor Pack; every style preset; auto (per-bunk)
      AND manual (slot) modes — all 35 bunks / 7 divisions across paginated sheets, no truncation/clipping;
      consecutive league games (fuzzy slot lookup); empty/partial schedule; actual print + Excel export.
- Done when: print produces correct, complete, unclipped output for every pack/mode/preset.

**Day 32 — Calendar views**
- [ ] Year/Month/Week/Day; date navigation loads correct day (no stale bleed — v1 fix); camp-date half /
      transition / start-end markers (v1 feature); division filter; cross-month nav; today; far dates.
- Done when: calendar navigation + markers correct across all views.

**Day 33 — Analytics / Report (every view)**
- [ ] Rotation report (counts == cloud), Availability report, Gantt; filters (division/type/bunk/search);
      empty data; canonicalization of activity-name variants; export. Adversarial filter combos.
- Done when: every analytics view is accurate and filter-robust.

**Day 34 — Camper Locator + cross-output consistency**
- [ ] Camper Locator search/lookup correctness; consistency between schedule view, print, calendar, analytics
      for the same date (same activities everywhere — no view disagrees).
- Done when: locator correct + all output surfaces agree.

---

## Phase 7 — Cloud, Reliability & Cross-Cutting `Days 35–39`

**Day 35 — Cloud save/load atomicity + the save guards**
- [ ] Every write to `daily_schedules` atomic + correct; the cross-date `_belongsToDate`/stamp guards
      (v1) under rapid date-nav; `cloud-unverified`-as-success path (deferred bug) — decide/fix;
      verifiedScheduleSave dedup correctness; partial/failed save recovery.
- Done when: no save path drops, mis-keys, or silently fails.

**Day 36 — Sync orchestration + offline + IndexedDB**
- [ ] supabase_sync race conditions, offline-queue replay (re-entrancy guard — v1), IndexedDB fallback +
      offline→online flush completeness; localStorage quota-exceeded prune; stale-local-wins (#10) twins.
- Done when: sync + offline + local cache are race-free and lossless.

**Day 37 — Realtime + multi-user + scheduler roles (NEEDS 2 ACCOUNTS)**
- [ ] Two sessions: simultaneous edits → no corruption; owner deletes a day while scheduler open → DELETE
      propagates; scheduler clears only their divisions (regen-scope fix — v1 #5); cross-scheduler
      `mergeSchedules` deleted-bunk **resurrection** bug (deferred from v1 hunt) — reproduce + fix;
      realtime merge stress (dedup, cloud-empty clear, no 60s guard).
- Done when: multi-user is corruption-free + the merge-resurrection bug is fixed (or precisely characterized).

**Day 38 — Access control / role enforcement**
- [ ] Scheduler `allowedDivisions` resolution (not stale), subdivision UUID + parent→child grade expansion;
      a scheduler cannot see/generate/delete outside their divisions; viewer is read-only everywhere;
      canSave/canEdit gates on EVERY write path (no bypass).
- Done when: role scoping is airtight on every read and write surface.

**Day 39 — Performance & load**
- [ ] Generation time (flagged ~18–21s — profile the hot path, identify the dominant cost, see if a safe
      win exists without changing behavior); cloud save/load latency; page-load + hydration; large-camp
      stress (memory, jank); rapid-action responsiveness. Flag anything >5s with the cause.
- Done when: perf characterized; any safe, behavior-preserving win applied; hot spots documented.

**Day 40 — Full adversarial E2E + final bug-bash**
- [ ] Fresh-session full Auto run + full Manual run, end to end, trying to break each step.
- [ ] Final fan-out bug-bash across any surface not yet adversarially hit; regression-check every v2 fix.
- [ ] Confirm `main` ⇄ `Daily-Audit-Walkthrough` in sync; MEMORY + this file fully updated.
- Done when: both flows survive an adversarial run and no open critical/high remains.

---

*v2 doctrine: assume bugs exist. Reproduce, root-cause, fix conservatively, live-verify, regression-check.
Two builders, cloud as source of truth, and a relentless eye for what breaks.*
