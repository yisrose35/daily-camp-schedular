# Codebase Cleanup — dead code + de-duplication

**Goal:** remove unneeded code across the ~98-file / ~156k-line codebase (10 months of
re-iterations → dead code + the same logic re-implemented in many files).
**Mode chosen by user:** *Phased & careful* — recon → remove provably-dead code → consolidate
duplicated helpers one-at-a-time into shared utils, each with live verification + a check-in
before risky merges.
**Doctrine (same as the v2 audit):** prove-before-remove · consolidate-only-after-diffing ·
verify-after-each-change (syntax + live smoke) · commit incrementally so anything is revertible ·
never break the live app.

---

## Phase 0 — Recon (DONE 2026-06-04)
- **98 JS files, ~155,939 lines.** Largest: scheduler_core_auto.js (23.3k), campistry_go.js (8.4k),
  daily_adjustments.js (7.9k), unified_schedule_system.js (7.3k), print_center.js (5.0k).
- **Retired engines already clean:** no `scheduler_core_solver_v2` / `solverVersion` /
  `solver_version_switch` remnants (the 2-engine retirement was thorough).
- **Within-file dead code = modest:** ~5 `if(false)` guards (some INTENTIONAL — e.g.
  scheduler_core_auto.js:5470 `if (false) { // dead code guard — keeps JS parser happy }`),
  ~29 "deprecated/unused/legacy" comment markers. Addressed per-file during Phase 2.
- **DEBUG flags:** none left `=true` in prod (only a manual `DEBUG_ON()` toggle in
  unified_schedule_system.js — fine).

### Orphan files (loaded by NO html + dynamically imported by NO js) → Phase 1
| File | Lines | What | Status |
|---|---|---|---|
| `audit_diagnostic.js` | 572 | "paste into browser console" audit-slice validator | DEAD — remove |
| `temp_diagnostic.js` | 77 | "copy, paste into browser console" temp probe | DEAD — remove |

### Duplicated helpers (same name, defined in N files — the de-dup targets) → Phase 2
**CRITICAL: these have DIVERGED — they are NOT identical copies.** e.g. `parseTimeToMinutes`:
print_center accepts string+number+Date; daily_adjustments is string-only; analytics already
DELEGATES to `SchedulerCoreUtils.parseTimeToMinutes` w/ a local fallback; scheduler_core_utils
holds the canonical. ⇒ consolidation needs a SUPERSET canonical + per-call-site migration + verify.

| Helper | # files | Notes |
|---|---|---|
| `parseTimeToMinutes` | 17 | diverged (string vs string+num+Date); canonical in SchedulerCoreUtils |
| `escapeHtml` | 13 | diverged (some escape quotes `&<>"'`, some only `&<>`, some textContent-trick) — the v2 audit hardened several individually; consolidating = one fix covers all |
| `minutesToTimeLabel` / `minutesToTime` | 7 each | time formatting |
| `getCampId`, `getClient`, `uid`, `parseTime`, `formatTime`, `timesOverlap`, `getDivisionForBunk`, `getCurrentDateKey`, `getDivisions`, `isFieldAvailable`, `getFieldCapacity` | 3-7 | mix of pure utils + some that read globals |

**NOT consolidation targets (coincidental same-name, different bodies per module):**
`init`, `render`, `log`, `logError`, `debugLog`, `loadData`, `saveData`, `renderMasterList`,
`renderDetailPane`, `makeEditable`, `section`, `injectStyles`, `setupTabListeners`, `closeModal`,
`canEditDivision`/`canEditBunk` (some are real AccessControl delegations, some local) — verify each
before assuming.

---

## Phase 1 — Remove provably-dead orphan files (low risk)
- [ ] Remove `audit_diagnostic.js` + `temp_diagnostic.js` (0 references, console-paste dev tools).
- [ ] Live smoke: app still loads, schedule renders, 0 new console errors.

## Phase 2 — Consolidate duplicated helpers (one at a time)
### ✅ Helper #1: HTML escapers → `window.CampUtils.escapeHtml` (DONE)
- Created `campistry_utils.js` (`window.CampUtils`, canonical complete escaper `&<>"'`); loaded FIRST on flow/me/dashboard/go/index (anchored before campistry_security.js). Wiring verified: every page loading a converted file also loads the util (0 gaps).
- **18 escaper copies** (named `esc`/`escHtml`/`escapeHtml`/`_escHtml`) replaced with a 1-line delegation: analytics, camper_locator, daily_adjustments, coverage_warning, playoff_hub, playoff_mode, print_center, app1, auto_schedule_grid, facilities, leagues, rotation_events, rules, specialty_leagues, unified_schedule_system, zones, special_activities, schedule_calendar_views.
- **SECURITY BONUS:** ~10 of those were the incomplete `textContent`-trick / `&<>"`-partial escapers (didn't escape quotes) → the same attribute-breakout class fixed in the v2 audit. Delegating UPGRADES them to the complete `&<>"'`. Notably print_center.escHtml was `textContent`-only and used in `data-*` attributes → latent gap now closed.
- **Deliberately NOT consolidated (landmines):** `campistry_me.esc` (its sibling `je()` depends on `esc` leaving `'` raw → must not escape quotes), `campistry_security.escapeHtml` (escapes MORE — `&<>"'/\`` OWASP-hardened; delegating would be a downgrade). False positives skipped: `auto_validator`/`post_edit_system` `function esc(e)` = Escape-KEY handlers, not escapers.
- node --check: 19/19 OK. **LIVE-VERIFIED on rebuilt preview (`10bdca04`):** CampUtils loaded; escapeHtml complete (`A<b>"x'&/` → `A&lt;b&gt;&quot;x&#39;&amp;/`); delegated escaper neutralizes body+attribute XSS; **49 DA tiles rendered via the delegated `_escHtml` with 0 runtime errors**; schedule data intact (06-03+06-04 = 175 blocks each, no loss); all 5 outputs present; all escaper modules loaded clean. Result: ~80 lines of duplicated logic removed + a security upgrade (the incomplete escapers now complete).

### Remaining helper candidates (NEXT pass — RISKIER, touch scheduling logic → careful)
- **`parseTimeToMinutes` (17 files):** DIVERGED (string-only vs string+number+Date). A canonical exists in `SchedulerCoreUtils` (analytics already delegate-with-fallback). Consolidating needs a SUPERSET canonical (handle string/number/Date/am-pm) + per-call-site migration + live re-verify of BOTH builders, because this parses every schedule time — a regression here corrupts scheduling. Do as its own focused pass.
- **Time formatters `minutesToTimeLabel`/`minutesToTime` (7 each):** SchedulerCoreUtils canonical; many already delegate-with-fallback. Lower risk; pairs naturally with the parseTimeToMinutes pass.
- **NOT targets (confirmed):** `uid` (per-subsystem prefix), `timesOverlap` (different signatures), and the per-module `log`/`init`/`render`/`loadData`/etc. (coincidental same-names).

### Remaining helper candidates (later passes)

Decision needed (Phase 2 kickoff): shared-util HOME + load order —
  (a) extend existing `SchedulerCoreUtils` (already canonical for parseTimeToMinutes), or
  (b) new `campistry_utils.js` loaded FIRST in every html.
Per helper: diff all N impls → build superset canonical → expose on window → migrate call sites to
delegate (keep a thin local fallback where load-order is uncertain) → syntax + live verify → commit.
Suggested order (safest → riskiest): `escapeHtml` → time formatters → `parseTimeToMinutes` → the rest.

## Phase 3 — Final regression
Both builders generate clean (auto + manual), all outputs render, cloud round-trip, 0 console errors.
