# Attendance History — Setup

**New feature.** Both the camper and staff full-page profiles now have an
**Attendance History** card: which seasons this person was at camp, what
bunk/division (campers) or position (staff) they had each season, whether
they were ever the same real person on both sides (a counselor who was a
camper here years ago, auto-suggested for confirmation), and a manual
"Other Camps Attended" list for camps entirely outside Campistry.

## Why this needed a real migration

Campistry has never had a season/year concept — `camp_id` is permanent,
and the whole camp's data (`roster`, `staffApplications`, `structure`,
etc.) lives in one mutable `camp_state_kv` row that gets overwritten in
place. The only "start fresh" action that existed, CSV re-import, wiped
that row with zero archive kept. So a durable per-season history needed a
real, separate, append-only table — not a field inside the roster blob
that would just get wiped along with everything else.

## 1. Run the migration

```
088_camp_person_seasons.sql
```

Paste into the Supabase SQL Editor. Adds two new tables
(`camp_person_seasons`, `camp_person_links`) and four RPCs
(`archive_camp_season`, `get_person_history`, `get_possible_person_links`,
`confirm_person_link`), same "RLS enabled, zero client policies,
staff-membership-checked RPC" pattern as everything else in this app.
Safe to re-run.

## 2. No edge function changes

Pure SQL plus client-side changes — nothing to redeploy on the Edge
Functions side.

## 3. How it works

- **`camp_person_seasons`** — one row per (camp, person, season). `person_id`
  is the shared Staff-ID/Camper-ID sequence (`nextPersonId` in
  `campistry_me.js`) already unified across campers and staff — the same
  stable number identifies a person whether they were ever a camper,
  staff, or both over the years.
- **Archiving** happens two ways, both calling the same
  `archive_camp_season(camp_id, season_label)` RPC, which reads the
  current roster/hired-staff directly from `camp_state_kv` server-side (no
  client payload needed, so it works from any page):
  - **Automatic** — the CSV re-import confirm dialog (Camp Structure →
    Import CSV) now includes a season-label field, pre-filled from Camp
    Dates' year, that archives the CURRENT roster right before the import
    wipes it. Clear the field to skip archiving for a plain
    data-correction re-import.
  - **Manual** — Dashboard → Summer Schedule now has an "Attendance
    History" card with its own "Archive Current Season" button, for camps
    that reset a different way or just want a mid-summer/end-of-summer
    snapshot without wiping anything.
  - Archiving is idempotent — running it twice under the same season label
    just updates the snapshot, never duplicates a row.
- **Viewing history** — every camper's and hired staff member's profile
  page shows an "Attendance History" card listing their archived seasons,
  newest first.
- **Camper↔staff linking** — when viewing someone with no confirmed link
  yet, the page automatically checks for a same-name match on the
  opposite side (a hired counselor gets checked against archived campers,
  and vice versa). A match with a known, matching date of birth on both
  sides shows as **high confidence**; a name-only match shows as
  **medium**. A DOB conflict (both sides known, and different) excludes
  the candidate entirely. Confirming a suggestion merges both sides'
  seasons into one shared history from then on; dismissing hides it
  (client-side only, same as the existing family-merge suggestion
  banner — it can reappear in a different browser).
- **Other Camps Attended** — a simple manual add/remove list on both
  profiles, for camps that aren't in Campistry at all. Nothing to
  auto-detect here by design; this is free-text (camp name + years).

## 4. Verify end to end

1. On a test camp with a real roster and at least one hired staff member,
   go to Dashboard → Summer Schedule → Attendance History, type a season
   label, click Archive Current Season — confirm the success message
   shows the right count.
2. Open a camper's profile — confirm the Attendance History card shows
   that season with the right division/grade/bunk.
3. Open a hired staff member's profile — confirm their season shows with
   the right position.
4. Re-run the archive with the SAME label — confirm the count doesn't
   double (idempotent).
5. On the CSV import screen, upload a file and click Import & Replace —
   confirm the season-label field is pre-filled, confirm archiving runs
   before the wipe, confirm the roster still gets replaced as before.
   Clear the label and re-import — confirm archiving is skipped that
   time.
6. Add a "Previous Camp" entry (name + years) on a camper's profile —
   confirm it saves, reloads, and can be removed.
7. Set up a real test case: archive a camper named "Test Person" with a
   known DOB under one season. Then create/hire a staff application with
   the SAME name and DOB. Open the staff profile — confirm the link
   suggestion banner appears as **high confidence**. Click Confirm —
   confirm the camper's archived season now appears in the staff
   member's Attendance History too. Try Dismiss on a different
   suggestion — confirm it disappears and doesn't reappear on reload
   (same browser).

## What's NOT in this pass

- **No backfill** for camps that already had multiple real seasons of
  data before this shipped — there's nothing to backfill from (prior CSV
  re-imports already discarded that data with no archive). History starts
  accumulating from the first archive going forward.
- **No "unlink" action** — confirming a link is permanent for now; a fast
  follow if a bad match ever gets confirmed by mistake.
- **Season label formatting isn't validated** — free text, camps can
  label seasons however they want (not enforced as "Summer YYYY").

## Migration SQL

See `migrations/088_camp_person_seasons.sql` for the full, commented SQL —
not duplicated here to avoid the two copies drifting apart.
