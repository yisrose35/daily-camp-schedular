# Session Changelog — May 5, 2026

Branch: `Manual-Pipeline-Audit` → PR to `main`

---

## 1. Rotation Cloud Sync

**Files:** `rotation_cloud.js` (new), `migrations/002_rotation_counts.sql` (new), `unified_schedule_system.js`, `scheduler_core_main.js`, `analytics.js`, `calendar.js`, `flow.html`

- Created `window.RotationCloud` module with save/load/deleteDate/clearAll/invalidateCache methods
- Supabase `rotation_counts` table stores per-bunk per-activity counts and lastDone dates
- `saveSchedule()` now calls `RotationCloud.save()` after incrementing historical counts
- Auto-builder calls `RotationCloud.save()` after rebuilding counts
- Rotation report loads from cloud first, falls back to localStorage
- Reset flows (reset activity history, new half, erase all) now clear the cloud table

---

## 2. Back-to-Back Away League Games Cleanup

**Files:** `scheduler_core_leagues.js`, `leagues.js`, `daily_adjustments.js`, `master_schedule_builder.js`

- Removed `getAwayDoubleheaderMatchups()` and all `awayDoubleheader` fixed-group logic
- Kept only the fairness-driven `offCampus` selection (smart shuffling based on trip counts)
- Simplified the Away Games UI in `leagues.js` — clean toggle with inline sentence config
- Added auto-detection of consecutive league slots: program recognizes back-to-back games automatically
- Added "AWAY PAIR" badge in both Master Builder and Daily Adjustments tiles
- Removed manual Link Away/Unlink Away buttons (no longer needed)

---

## 3. Print Center Fix for Consecutive League Games

**File:** `print_center.js`

- `buildLeagueMatchups` fuzzy slot lookup now sorts candidates by proximity (distance from expected slot index)
- Previously just used `allSlotEntries[0]` which could grab the wrong game's matchups
- Game 1 and Game 2 now correctly show their distinct matchups (e.g., 1v2/3v4 then 1v3/2v4)

---

## 4. Loading Screen Animations

**Files:** `flow.html`, `campistry_me.html`, `campistry_me.js`

### Flow (clip-path reveal)
- Replaced spinner/text loading with the actual Flow logo PNG
- Logo reveals left-to-right using `clip-path: inset()` animation
- Uses `requestAnimationFrame` for smooth 60fps animation over 2 seconds
- Minimum display time: 4.5 seconds before fade-out

### Campistry Me (opacity fade)
- Replaced spinner/text with the Me logo PNG at 220px
- Logo starts at 15% opacity, fades to 100% over 2 seconds using eased steps
- Minimum display time: 2 seconds after animation start

---

## 5. Auto-Scheduler Crash Fix

**File:** `scheduler_core_auto.js`

- Line 685: `config.fields` referenced an undefined variable `config`
- `fields` (the fallback) wasn't defined until line 1112
- Fixed by replacing `(config.fields || fields || [])` with `(getFields(globalSettings) || [])`
- `globalSettings` was already in scope; `getFields()` is the canonical accessor used elsewhere

---

## Quick Reference: Commits This Session

| Commit | Description |
|--------|-------------|
| `f056ec4` | Fix crash: config is not defined in auto-scheduler |
| `04b5cfe` | Use requestAnimationFrame for smooth Flow loading |
| `dbca1b8` | Set Flow loading minimum to 4.5 seconds |
| `4bcaee3` | Increase Me loading logo to 220px |
| `dee2a44` | Me loading: logo fades from light to full, no spinner |
| `8ab16a7` | Reduce loading minimum to 2s for ~4s total |
| `423f2cd` | Set loading animation to 2 seconds |
| `97074d8` | Use actual logo with clip-path reveal |
| `08dd9eb` | Loading: draw Flow letter by letter |
| `ec9ca35` | Loading: animate Flow logo like handwriting |
| `f11e83e` | Fix print center proximity sort for back-to-back games |
| `f68cc9a` | Clear rotation_counts on reset/new half |
| `ec3a52c` | Auto-detect back-to-back away, show AWAY PAIR badge |
| `c92e3a1` | Remove awayDoubleheader, keep offCampus |
| `c27c875` | Add rotation cloud sync via Supabase |
| `9874244` | Rotation: use historicalCounts as primary source |
