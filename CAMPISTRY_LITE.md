# Campistry Lite — Mobile Companion

Campistry Lite (`campistry_lite.html`) is a mobile-first companion app with two
experiences on one page, branched by role:

| Audience | Tabs | What they can do |
|---|---|---|
| **Head staff** (owner / admin / scheduler) | Today · Roster · Staff · Alerts | Browse any division/bunk's schedule for any date, search the camper roster, manage counselor↔bunk assignments + invites, configure and send daily SMS blasts |
| **Counselor** (new `counselor` role) | My Day · My Bunk · League | See their assigned bunk's daily schedule, bunk roster (contacts, allergies, dietary), and their league team + standings + today's matchup |
| **Viewer** | Today · Roster* | Schedule browsing only (*roster requires `camp_state_kv` read, which viewers don't have) |

It is installable as a PWA ("Add to Home Screen") via `manifest_lite.webmanifest`
— standalone display, portrait, warm coral theme (`#EE6A53`, ramp defined in
`campistry_lite.css` as `--coral-50…700`; the counselor role badge across the
main app uses the same coral).

## Architecture

- **No new tables.** Schedules come from `daily_schedules` via the existing
  `ScheduleDB.loadSchedule(dateKey)` multi-scheduler merge. Camp structure,
  camper roster and leagues are read directly from `camp_state_kv`
  (`app1`, `campStructure`, `leaguesByName`, `specialtyLeagues`).
- **Two new `camp_state_kv` keys**, written only by head staff:
  - `liteStaffAssignments` — `{ "<email>": { name, phone, bunks: [..], smsOptIn } }`
    The counselor↔bunk mapping (didn't exist anywhere in Campistry before).
    Counselors are matched to their record by their login email.
  - `liteSmsSettings` — `{ enabled, audience: 'counselors'|'parents'|'both', footer }`
    The camp-level SMS opt-in.
- **League team per counselor** is derived, not stored: team membership lives
  on camper records (`camperRoster[name].teams[leagueName]`), so a bunk's team
  is the majority vote across its campers, and a counselor inherits their
  bunk's team.
- **Counselors are read-only everywhere**: client-side via
  `access_control.js` (`isReadOnlyRole` — counselor is treated like viewer in
  every edit gate and in `isViewer()`), and server-side via RLS (they are in
  no INSERT/UPDATE/DELETE policy).

## One-time setup

### 1. Run the migration

Apply `migrations/018_counselor_role_campistry_lite.sql` in the Supabase SQL
editor. It:

- adds `'counselor'` to the `camp_users_role_check` CHECK constraint
- adds `'counselor'` to the `camp_state_kv` SELECT policy (they need to read
  structure/roster/leagues/their assignment; `daily_schedules` SELECT was
  already role-agnostic)

### 2. (Optional) Configure SMS — Twilio

The daily-text feature uses a new Supabase Edge Function,
`supabase/functions/send-sms/index.ts` (modeled on `send-invite-email`).

```bash
supabase functions deploy send-sms
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=xxxxxxxx
supabase secrets set TWILIO_FROM_NUMBER=+15551234567
# or, instead of a from number:
supabase secrets set TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxx
```

Security properties:

- Twilio credentials live only in Supabase secrets (never in `config.js`).
- The function verifies the caller's JWT (Supabase default) **and**
  re-checks the caller's camp role server-side via the `get_user_role()` RPC —
  only owner/admin/scheduler can send. Counselors/viewers get 403.
- Batch capped at 200 messages per invocation; the client chunks at 100.

## Day-to-day flows

### Inviting a counselor

1. Open **Campistry Lite → Staff → Add counselor** (any head staff can create
   the assignment; only the **owner** can send the actual invite, matching the
   existing `canInviteUsers()` policy).
2. Enter name, email, phone, tap their bunk(s), toggle SMS.
3. On save (as owner) an invite is created through the standard
   `AccessControl.inviteTeamMember(email, 'counselor', ...)` path, the invite
   email goes out via `send-invite-email`, and the invite link is copied to
   the clipboard as a fallback.
4. The counselor accepts at `invite.html` (unchanged flow) and is redirected
   to `campistry_lite.html`. If they ever land on `dashboard.html`, they are
   redirected to Lite automatically.

Counselors can also be invited from the existing team management UI
(`team_subdivisions_ui.js` now has a Counselor role option) — but bunk
assignment only exists in Lite's Staff tab.

### Daily SMS blast

1. **Alerts tab → flip "Camp opted in to SMS"** (stored in `liteSmsSettings`;
   the whole feature is inert until a camp opts in).
2. Choose the audience:
   - **Counselors** — staff with a phone number *and* their per-person
     "Receives daily schedule texts" toggle on (double opt-in).
   - **Parents** — camper `parent1Phone` from the Me-page roster; one text per
     parent per bunk (siblings in the same bunk share one message).
3. Review the recipient count + previews, then **Send**. Each person gets a
   personalized message listing that day's activities for their bunk, with
   their league matchup called out.
4. A **Test message** card lets you send a single text to yourself first.

Note: there is no scheduled/automatic send in v1 — a head-staff member taps
Send. (A pg_cron → Edge Function pipeline is the natural v2 if wanted.)

## Files

| File | Role |
|---|---|
| `campistry_lite.html` | App shell, PWA meta, script loader chain |
| `campistry_lite.js` | All Lite logic (views, data, SMS composition) |
| `campistry_lite.css` | Mobile-first styles on `campistry-unified.css` tokens |
| `manifest_lite.webmanifest` | PWA manifest |
| `supabase/functions/send-sms/index.ts` | Twilio send Edge Function |
| `migrations/018_counselor_role_campistry_lite.sql` | Counselor role + RLS |
| `access_control.js` | `counselor` in ROLES; read-only gates via `isReadOnlyRole` |
| `invite.html`, `dashboard.js`, `dashboard.html`, `team_subdivisions_ui.js` | Counselor display names/colors, Lite tile, counselor→Lite redirects |
