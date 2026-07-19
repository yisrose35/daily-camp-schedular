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
product color as a bottom accent. **Flow**, **Me**, **Live**, **Health** and
**Link** are live; the rest of the suite (Go, Snacks, Notes) show as dimmed
"Soon" tiles. Counselors
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
| **Head staff** — **Link Lite** | Messages · Compose | Parent communication on the go. **Messages:** the inbox as parent-threaded conversations (received + sent), tap a thread to read it and fire off a quick reply. **Compose:** search a camper → message their parent, and **attach an existing form or list** (created on the desktop) via a picker — Lite can attach them, never create them. Sends a real `link_messages` row the parent portal reads. Photos: next phase (needs a cloud photo store). |
| **Head staff** — **Health Lite** | Meds · Roster · Trip | Medications on the go. **Meds:** today's dispensing board — every camper on meds with allergy banners and a **live Given / Not-given** status; head staff tap **Give** to log it (writes to the cloud, everyone sees it live). **Roster:** allergy + medication reference, searchable. **Trip:** pick the group going out → the consolidated meds to pack, with give-status. The **first Lite app that writes** (gated to head staff for now). |
| **Head staff** — **Live Lite** | Roll Call · Changes | Attendance on the go. **Roll Call:** who's here today — Present / Absent / Left-early tallies, then every camper by bunk with a status pill (Here · Absent · Sick · Late · Left early), division-filterable, tap for full camper info. **Changes:** today's dismissal changes & late arrivals (early pickups with time + who, late arrivals with notes), searchable. Read-only; reads the office roll call synced to the cloud. |
| **Head staff** — **Me Lite** | Roster · Medical · Staff | Camp *people* on the go. **Roster:** searchable camp-wide roster with a headcount strip + birthdays, grouped by bunk with medical flags; tap a camper for **all their info** (medical, personal, school, placement, parents with tap-to-call/email, address, emergency, teams, notes). **Medical:** a camp-wide allergy/meds/dietary safety list, filterable, facts shown inline. **Staff:** a bunk→counselor contact directory with tap-to-call. Read-only. |
| **Counselor** (`counselor` role) | My Day · My Bunk · League | See their assigned bunk's daily schedule, bunk roster (contacts, allergies, dietary), and their league team + standings + today's matchup |
| **Viewer** | Schedule · Now · Locate · Reports | Same read-only Flow Lite view as head staff |

**Roster** (camper browse/search) belongs to **Me Lite** (see below) and has been
pulled out of Flow Lite's head-staff nav — counselors still get their bunk roster
via **My Bunk**. **Staff assignments** and **SMS Alerts** are parked out of Flow
Lite's nav (the code — `renderStaff`, `renderMessaging`, `send-sms` — is retained;
SMS is coming back soon).

### Me Lite tabs — `Roster · Medical · Staff` (amber `#F59E0B`)

The on-the-go version of the **Me** page for head staff — camp *people* in your
pocket. Three tabs, all **read-only** (reads `app1.camperRoster`,
`campStructure`, `liteStaffAssignments`; no writes).

- **Roster** — an **at-a-glance strip** on top (headcounts: campers / bunks /
  divisions / # with medical info) plus a **"Birthdays this week"** card (derived
  from `dob`, timezone-safe month/day match over the next 7 days). Below: a
  **search bar over the whole camp** (matches name, bunk, division, grade, school,
  or parent name) and a **By division** chip row (`All` + each parent division).
  No search → campers grouped by bunk (`Bunk A · 3`); searching → a flat ranked
  list of up to 60 hits, and the glance strip hides to give search room. Each
  camper is a big tap row showing name, `bunk · division`, and medical flags
  (**Allergy / Meds / Dietary**).
  - **Tap a camper → full detail sheet** (`camperDetailHTML` in a bottom sheet):
    **every field on file**, grouped — a highlighted **Medical** block first
    (allergies / medications / dietary), then **Personal** (preferred name, DOB +
    computed age, gender), **School** (school / grade / teacher), **Placement**
    (division / grade / bunk), **Parents & guardians** (both parents, with
    tap-to-call `tel:` and tap-to-email `mailto:` links), **Address**,
    **Emergency contact** (name · relationship · phone), **Teams** (per-league
    team membership), and **Notes**. Sections self-prune — a camper with no school
    info simply doesn't show a School block.
- **Medical** — a **camp-wide allergy / meds / dietary safety list** for quick
  field reference ("who has an EpiPen at the pool right now"). A segmented
  **All / Allergy / Meds / Dietary** filter + a **By division** chip row, then the
  matching campers grouped by bunk, with their medical facts shown **inline and
  color-coded** (allergy = red, meds = blue, dietary = amber) — no tap needed to
  read them. Tapping still opens the full camper sheet.
- **Staff** — a **bunk → counselor contact directory** (from `liteStaffAssignments`).
  Search by bunk or counselor name; results are bunk cards (in camp-structure
  order) listing each assigned counselor with a one-tap **Call** button
  (`tel:` link). Answers "who's on Bunk 7 and how do I reach them" instantly.
  Empty until the camp fills in staff assignments (Lite's Staff editor / full
  Campistry).

### Live Lite tabs — `Roll Call · Changes` (blue `#2563EB`)

The on-the-go window into the office **Live** attendance board — was the kid
here today, and any dismissal changes. Two tabs, **read-only**, with a date pill
so a head counselor can check any day.

- **Roll Call** — a **Present / Absent / Left-early** headcount strip, then every
  camper grouped by bunk (`Bunk A · 2/3 here`) with a status pill: **Here**
  (green), **Absent / Sick / Appointment** (red, reason shown), **Late / not in**
  (late arrival not yet marked in), or **Left early** (amber, logged as an early
  pickup). A **By division** chip row scopes it; tapping a camper opens the full
  camper detail sheet. Status mirrors the office logic (`liveStatusFor`).
- **Changes** — today's **dismissal changes & late arrivals**, searchable by
  camper. **Late arrivals** (from absences flagged `late`, with the note/time)
  and **Dismissal changes & early pickups** (from `earlyPickups`, with pickup
  time and who's collecting) in two grouped sections.

**How attendance reaches the phone.** The office Live app ("Office Mission
Control", `campistry_live.js/.html`) keeps the day's roll call — `attendance`,
`absences`, `earlyPickups` — in the localStorage blob `campistry_live_v1`, which
on its own never leaves that browser. A small **sync bridge** added to
`campistry_live.html` mirrors each day to a dedicated `camp_state_kv` row
**`liveDaily_<date>`** (newest-wins per day; pushes on local change, pulls other
devices' updates back). Live Lite reads that row on demand via `loadLiveDay()`.
The bridge writes only that new key, so it can't touch existing camp data.
_Confirmed parent-submitted dismissal/late requests are already folded into the
office `earlyPickups`/`absences` on confirmation, so they flow through the same
key; pending (unconfirmed) parent requests are not surfaced in Lite._

> **Office-app repair (prerequisite).** Wiring this up surfaced that
> `campistry_live.js` referenced a set of helpers that were never defined —
> `getRoster`, `getStructure`, `getCampName`, `readGlobal`, `getLive`,
> `saveLive`, `getTodayKey`, `getTodayData`, `saveTodayData`, `esc`, `toast`,
> and `openModal`/`closeModal`. The `openModal`/`closeModal` reference in the
> `window.CampistryLive` export threw at load, so the office Live app never
> initialized at all (attendance couldn't be recorded). These are now defined
> in `campistry_live.js`, mirroring the sibling products (Health/Go) and the
> app's own inline copies — the office Live board is functional again, which is
> what makes cloud sync (and therefore Live Lite) meaningful.

### Link Lite tabs — `Messages · Compose` (green `#2A7A35`)

The on-the-go version of **Link** (parent communication) for staff. Phase 1 —
**messaging + attach forms/lists**. Photos are a separate phase (see below).

- **Messages** — the message inbox as **parent-threaded conversations**, grouped
  by `thread_id` (received `in` + sent `out`), newest first, with an unread dot
  and a one-line preview (attachment tokens stripped). Tap a thread → the full
  conversation as bubbles (parent left, staff right; attachments shown as chips)
  and a **quick reply** box that sends straight back to that parent. Search
  across all threads. Reads `link_messages` directly (`camp_id`-scoped by RLS).
- **Compose** — search a **camper** → message their parent (`parent1Name` /
  `parent1Email` from the roster). Subject + body, then **Attach form / list**:
  a picker of the forms & lists that exist in `camp_state_kv` (`link_forms`,
  `link_lists`). Selecting one appends the desktop's own invisible body token —
  `[[form:<id>:<camper>]]` or `[[list:<id>]]` — which the parent portal renders
  as an "Open & fill" / "View list" button. **Lite attaches, never creates**
  forms/lists (matching the requirement).

**Sending** replicates the desktop's `link_messages` insert (`id` uuid,
`camp_id`, `thread_id`, `direction:'out'`, `parent_name/email`, `camper_name`,
`subject`, `body`, `channels`, `read`) — the parent portal reads that table, so
no edge function is needed (the desktop's email/SMS channels are best-effort
placeholders anyway). Compose subject/body are held in module state so they
survive the attach-picker re-render.

> **Photos — deferred, needs new infrastructure.** The Link photo system is a
> desktop **face-recognition engine** that stores camp photos as **base64
> `dataUrl` blobs in the desktop browser's localStorage** (`campistry_link_photos_v1`);
> the only thing that syncs to the cloud is the face-*index descriptors* (vectors
> via RPCs), **not the images**. There is **no Supabase Storage bucket anywhere
> in the repo**, so a phone has nothing to read or upload to. Putting pictures on
> mobile therefore requires building cloud photo infrastructure first — a Storage
> bucket + an index table + RLS (a migration) — with the face-recognition ML
> staying on the desktop (a phone uploads to / views the shared cloud store; the
> desktop keeps auto-tagging and running the "Photo Roundup"). That's the next
> phase and is tracked separately from this messaging slice.

### Health Lite tabs — `Meds · Roster · Trip` (purple `#6B21A8`)

The on-the-go version of **Health** for the nurse/health office. Reads
medications + allergies from the camper roster, and reads/writes the shared
health log. **This is the first Lite app that writes.**

- **Meds** — today's **medication dispensing board**. A `On meds / Given /
  Remaining` count strip, then every camper with meds grouped by bunk, each with
  an **allergy banner** (red, safety-first) and a row per medication showing a
  live status: **Given · <time>** (green) or a **Give** button. Tapping **Give**
  logs a dispensing (camper · med · nurse · time) to the cloud so everyone sees
  it live; the camper name opens the full detail sheet. Search by camper or
  medication; **By division** chip filter.
- **Roster** — allergy + medication + dietary reference for **every** camper
  (inline, color-coded), searchable and by-division; tap for full detail.
- **Trip** — "what meds to pack." Pick the group going out (**All / a division**)
  → a `N campers need M meds` summary and the consolidated per-bunk med list for
  that group, each med with the same live give-status (and Give buttons for head
  staff). Answers "we're taking Bunk A on a trip — what medication comes along."

**Who can mark meds.** Marking a med given writes to the cloud, so it's gated:
`canGiveMeds()` currently allows **owner / admin / scheduler** (they already have
camp_state_kv write); counselors/viewers see the board **read-only**. Give a
nurse an admin/scheduler login for now — swapping that one predicate for a
dedicated `nurse` role (migration + RLS) is the natural follow-up.

**Data + sync.** Health data (`dispensingLog`, `sickVisits`, …) lives in the
`camp_state_kv` key **`campistryHealth`** — the same slot the office Health app
and global settings use. Lite reads it via `loadHealth()` and appends a
dispensing with a **read-latest → append → upsert** so a concurrent write isn't
clobbered by a stale copy. Medications and allergies come straight from the
camper roster (`medications`, `allergies`). "Given today" = a `dispensingLog`
entry whose `date` matches today (UTC, matching the office's `todayISO`).

> **Office-app bridge.** The office Health app ("Health office", `campistry_health.js/.html`)
> stored its log **only in localStorage** on this page — it doesn't load the
> authoritative `saveGlobalSettings`, so desktop-marked meds never reached the
> cloud. A sync bridge added to `campistry_health.html` keeps the desktop and
> Lite in sync through `campistryHealth`. Because **both** surfaces write, it
> **merges** rather than overwrites: append-only logs are unioned (deduped by a
> stable per-entry key), `medicalForms` shallow-merged — no give-log entry from
> either side is ever lost, so a nurse marking on the desktop and another in Lite
> converge. (Unlike Live's office app, Health's was otherwise healthy — all its
> helpers were already defined.)

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
| `campistry_live.html` | Office Live app + the `liveDaily_<date>` cloud sync bridge |
| `campistry_live.js` | Office Live logic; now defines its own data/UI helpers (was crashing at load) |
| `campistry_health.html` | Office Health app + the `campistryHealth` merge sync bridge |
| `access_control.js` | `counselor` in ROLES; read-only gates via `isReadOnlyRole` |
| `invite.html`, `dashboard.js`, `dashboard.html`, `team_subdivisions_ui.js` | Counselor display names/colors, Lite tile, counselor→Lite redirects |
