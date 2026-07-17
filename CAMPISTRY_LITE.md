# Campistry Lite — Mobile Companion

**Campistry Lite is a *family* of per-product mobile companions** — each the
on-the-go, phone-first version of its full Campistry product (Flow Lite, Me Lite,
…). They live on one page (`campistry_lite.html`) today, branched by role, and
will split into per-product apps as they grow. Everything is built mobile-first:
big tap targets, no horizontal scroll, thumb-reachable bottom nav, glanceable
while standing in the middle of camp.

**Home launcher.** Lite opens to a home screen (`renderHome` → `#view-home`) with
**no top nav bar** — the coral hero card is the top element and carries the
account/settings button in its top-right corner (`#liteHeroMenuBtn`, opens the
same menu the in-app header avatar does). The sticky header only appears once
you're inside an app (back-chevron · app title · avatar). The camp name is
resolved by `resolveCampName()` from the first trustworthy source
(`AccessControl.getCampName()` → `camp_state_kv.camp_name` → `camps.name` →
signup metadata) so the hero reads the real camp name rather than the "Your Camp"
placeholder. Below the hero sits a compact grid of **product tiles
using each product's real logo** (`Flow_clean.png`, `Me_clean.png`, …) with the
product color as a bottom accent. **Flow** and **Me** are live; the rest of the
suite (Go, Health, Live, Snacks, Link, Notes) show as dimmed "Soon" tiles. Counselors
get a single prominent **My Camp** hero tile. Tapping an available tile opens
that app (`openApp`) with its own bottom tab bar; the header back-chevron returns
to the launcher (`goHome`). The app config lives in `LITE_APPS` in
`campistry_lite.js` — add an entry (id, name, logo, color, roles, status, tabs)
to surface a new Lite app.

**Design.** The **Lite shell is coral** (`#EE6A53`) — home launcher, hero card,
avatar, splash. **Each app is themed in its own product color internally**: open
Flow and the tabs/accents/card-headers turn teal, Me → amber, Go → sky, etc.
This is driven by `applyTheme(app)`, which sets `--accent`/`--accent-dark`/
`--accent-tint` on `#liteApp` from the app's `theme` in `LITE_APPS`; `goHome`
clears them back to coral. The home **hero card** mirrors the website dashboard
(greeting · "Welcome back, [Camp]!" · live clock · Open-Meteo weather) in a coral
gradient. Fraunces display type, DM Sans body, soft layered shadows, translucent
blurred header/tab bar, safe-area-aware. Tokens live at the top of
`campistry_lite.css`.

| Audience | Tabs | What they can do |
|---|---|---|
| **Head staff** (owner / admin / scheduler) — **Flow Lite** | Schedule · Now · Locate · Reports | A comprehensive, **read-only** window into all of Flow: the full schedule for any division/bunk/date, a live **whole-camp "Now" board** (what every bunk is doing right now, grouped by division or by field), a **camper locator** (where's this kid right now / at any time), and **Bunk Rotation & Usage** reports. No generating, no printing, no setup. |
| **Head staff** — **Me Lite** | Roster | The full camper roster, searchable across the whole camp, grouped by bunk with medical flags. Tap any camper for **all their info** (medical, personal, school, placement, parents with tap-to-call/email, address, emergency, teams, notes). Read-only. |
| **Counselor** (`counselor` role) | My Day · My Bunk · League | See their assigned bunk's daily schedule, bunk roster (contacts, allergies, dietary), and their league team + standings + today's matchup |
| **Viewer** | Schedule · Now · Locate · Reports | Same read-only Flow Lite view as head staff |

**Roster** (camper browse/search) belongs to **Me Lite** (see below) and has been
pulled out of Flow Lite's head-staff nav — counselors still get their bunk roster
via **My Bunk**. **Staff assignments** and **SMS Alerts** are parked out of Flow
Lite's nav (the code — `renderStaff`, `renderMessaging`, `send-sms` — is retained;
SMS is coming back soon).

### Me Lite tabs — `Roster` (amber `#F59E0B`)

The on-the-go version of the **Me** page for head staff — the full camper roster
in your pocket. One tab today: **Roster**.

- **Roster** — a **search bar over the whole camp** (matches name, bunk, division,
  grade, school, or parent name) plus a **By division** chip row (`All` +
  each parent division). No search → campers are grouped by bunk (`Bunk A · 3`);
  searching → a flat ranked list of up to 60 hits. Each camper is a big tap row
  showing name, `bunk · division`, and medical flags (**Allergy / Meds / Dietary**).
- **Tap a camper → full detail sheet** (`camperDetailHTML` in a bottom sheet):
  **every field on file**, grouped — a highlighted **Medical** block first
  (allergies / medications / dietary), then **Personal** (preferred name, DOB +
  computed age, gender), **School** (school / grade / teacher), **Placement**
  (division / grade / bunk), **Parents & guardians** (both parents, with
  tap-to-call `tel:` and tap-to-email `mailto:` links), **Address**,
  **Emergency contact** (name · relationship · phone), **Teams** (per-league
  team membership), and **Notes**. Sections self-prune — a camper with no school
  info simply doesn't show a School block. Reads `app1.camperRoster`; no writes
  (Me Lite is read-only, same as Flow Lite).

### Flow Lite tabs — `Schedule · Locate · Reports`

In-app there is **no top bar at all** — no back button or avatar; you return to
the launcher with the phone's **swipe/back gesture** (native-app feel). This is
wired via the History API: `openApp` pushes a history entry and a `popstate`
handler calls `goHome`, so the hardware/browser back returns to the dashboard
instead of leaving the site. Account/settings live on the home hero. The date
control is a pill (date + a "Today" badge) flanked by prev/next chevrons.

- **Schedule** — read-only schedule, date pill, with a **By division / By grade / By facility** scope toggle, a search box (bunks, or facilities under the facility scope), and a **Schedule / Now** mode toggle (division/grade scopes only). "Now" is the folded-in whole-camp snapshot — every bunk's current activity grouped by division/grade. **By facility** shows who's using **what facility, when, and by whom** (per-facility booking cards, current booking highlighted) — this replaces the former standalone Facilities tab. Lite can never generate.
- **Locate** — search any camper → their bunk, current activity, field, and time window (or where they'll be at a chosen time). Reads `app1.camperRoster` + the schedule.
- **Reports** — two views via a toggle:
  - **Rotation & Usage** — each bunk's activity tallies with usage bars (from `RotationCloud.load()` / `rotation_counts`), with the same **By division / By grade** scope toggle and **bunk search** as Schedule.
  - **Availability** — the on-the-go "what's free now / at a time" tool. Pick a time (defaults to **now**, with ±15 steppers or tap to jump straight to, say, 1 PM) and it splits every facility into **Free at [time]** (green, with "free until X") and **In use** (with who's there and when it "opens"). A facility search answers "need a basketball court at 1 PM?" instantly. Facility list = the day's bookings ∪ configured `fields`.

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
