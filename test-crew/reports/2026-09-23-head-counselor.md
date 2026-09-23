# Test report: Head Counselor (Rachel), 2026-09-23

## How it went: 🔴 Couldn't do my job

I logged in fine and the site looks great, but I could not do the one thing I actually
need every morning: get a real schedule onto the board. "Generate Schedule" told me it
worked, twice, and even under my rainy-day plan — but every single bunk came back
totally blank. When I tried to just type one activity into one box by hand instead, it
threw an error at me. On top of that, while I was in there I noticed I could see and
even touch the camp's payroll, billing and Stripe/payment settings, which I was told
I'm not supposed to have anything to do with. I got Print, Notes and the camper finder
working, so those are solid — but the core job didn't happen today.

## My missions
| Mission | Result | Minutes | Notes |
|---|---|---|---|
| 1. Log in, find today | ✅ Done | ~3 | Got there, but had to discover the collapsed side menu first |
| 2. Build tomorrow's schedule | ❌ Couldn't | ~25 | Camp had zero setup (no fields, no periods) so I built a minimal one myself, then Generate produced an empty schedule every time |
| 3. Rain plan (Mid-Day Mode) | ⚠️ Done with trouble | ~8 | Found and activated the feature fine; couldn't tell if it actually protects a real morning because there was no real morning to protect |
| 4. Swap one bunk's activity | ❌ Couldn't | ~5 | Picking "Basketball" and hitting Save Changes threw "Error: Could not find time slots." Nothing saved |
| 5. Print (camp + one bunk) | ✅ Done | ~5 | Clean, readable, correct page counts — just nothing to print since the schedule is empty |
| 6. Find a camper | ✅ Done | ~2 | Worked correctly; camp has no campers loaded yet so it politely said "not found" |
| 7. Check my limits (billing/payroll) | ❌ Couldn't — should have been blocked | ~6 | I was NOT blocked. Full access to Payment, Payroll, Billing, Finance, and editable tuition pricing |
| 8. Leave a staff note | ✅ Done | ~3 | Saved, and was still there after a full reload |

## Broken (most serious first)

### 🔴 I can see and touch the camp's money — payroll, billing, Stripe, tuition prices
- **What I did:** From the Dashboard, opened **Camp Setup → Payment**. Separately, opened
  **Me → Payroll**, **Me → Billing**, **Me → Finance**, and **Dashboard → Dates & Pricing**.
- **What I expected:** As a head counselor I should be blocked from all of this — the
  job description says "no billing, payroll or finance." I expected a locked page or for
  these links to not even show up.
- **What happened:** Every one of them opened fully, with real controls:
  - **Payment** tab shows "Connected to your own Cardknox / Sola Payments account since
    9/22/2026" with a live **"Disconnect & use Stripe instead"** button, plus a
    **"Connect your Stripe account"** button. (I did not press either — I didn't want to
    actually touch the camp's real payment processor.)
  - **Payroll** page opened with staff pay, timesheets, Youth Corps, Pay Runs, Tip
    Payments tabs and an "+ Add Staff" button.
  - **Billing** page opened with "Record Payment," "Bank Deposits," and an aging report.
  - **Finance** page opened showing Net Income, Revenue, Payroll, Expenses, Budget, and
    a "QuickBooks" export button.
  - **Dates & Pricing** let me see (and it looked editable) the actual tuition prices for
    both halves ($2,200 / $2,400) and the full-summer bundle ($4,500), with Edit/Delete
    buttons on each session.
- **Screenshot:** `test-crew/shots/1790186453539-BUG-payment-tab-accessible.png`,
  `test-crew/shots/1790186624957-BUG-finance-accessible.png`,
  `test-crew/shots/1790186550074-payroll-nav-check.png`
- **Checked twice?** Yes — I checked Payment, Payroll, Billing, and Finance separately,
  all four opened the same way. I did not click anything that would change real money
  settings.

### 🔴 "Generate Schedule" says it worked, but every bunk's day is empty
- **What I did:** Camp Setup → Auto Builder → set tomorrow's date (9/24) → built a basic
  day (Sport + Special Activity + Dismissal, copied to all 3 grades — the camp had
  nothing configured at all when I arrived, not even a field, so I had to add two test
  fields, a pool and an arts room myself first) → Daily Adjustments → **Generate Schedule**.
- **What I expected:** A full day for all 26 bunks — sports, swim/arts, dismissal — with
  no blank periods.
- **What happened:** A green "✅ Schedule Generated!" popup appeared. But the actual
  Daily Schedule (View) page shows every single bunk, in all 3 grades, completely
  blank all day — just an empty grid with "+ Add" prompts, and a fixed "Cleanup" block
  at 3:35 PM. I ran it a second time (same empty result), and again after switching on
  my rainy-day plan (same empty result — see next item). The "Validate" checker says
  "✅ All Clear — no conflicts," which is technically true since there's nothing there
  to conflict with each other; it doesn't seem to know the day is empty.
  I also caught a real error in the background the moment the page reloaded:
  *"📅 [ScheduleDB] ERROR: Save failed: TypeError: Failed to fetch"* trying to write to
  the schedule database — so on top of nothing being placed, what little there is isn't
  reliably reaching the cloud either.
- **Screenshot:** `test-crew/shots/1790185594439-look.png` (first empty result),
  `test-crew/shots/1790185625716-gen-empty-2.png` (scrolled, all 3 grades),
  `test-crew/shots/1790186114711-rain-generate-result.png` (same result under rain mode)
- **Checked twice?** Yes — reproduced 3 separate times (regular generate ×2, rainy-day
  generate ×1), including once with no page reload in between, so it's not a
  refresh/caching fluke.

### 🔴 Hand-editing one bunk's activity also fails
- **What I did:** On the empty 9/24 schedule, clicked "+ Add" on 1st Grade bunk א,
  10:00–10:30 AM, picked "Basketball" from the suggested list (fields and activities
  all showed up correctly here — Basketball, Soccer, Baseball, Swim, Arts and Crafts
  were all there to choose from), then clicked "Save Changes."
- **What I expected:** Basketball to appear in that box.
- **What happened:** A raw popup: **"Error: Could not find time slots."** The modal
  closed and nothing was saved — the box is still blank.
- **Screenshot:** `test-crew/shots/1790186221284-look.png` (still blank after the error)
- **Checked twice?** Tried once; didn't retry a second time since the error message
  itself was specific and the result (nothing saved) was clear. This feels connected to
  the empty-generation bug above — like the day's time-slot structure never actually
  got created for 9/24, so both the auto-generator and the manual editor have nothing
  to hang an activity on.

### 🟠 Auto/Manual mode and the working date forget themselves on refresh
- **What I did:** Set Auto Builder + tomorrow's date (9/24), did work, then reloaded the
  page fresh (as if I'd refreshed my browser mid-shift).
- **What I expected:** To come back to where I left off, or at least a clear reminder of
  what I was working on.
- **What happened:** It silently reset to **Manual Builder** and **today's date**, with
  no warning. My layer setup for 9/24 was still saved underneath (good), but if I
  hadn't been paying close attention, I could easily have hit Generate thinking it was
  for tomorrow in Auto mode, when it was actually about to run for today in Manual mode.
- **Screenshot:** `test-crew/shots/1790185660802-look.png`
- **Checked twice?** Yes, saw the same reset after two different full reloads.

### 🟡 Realtime connection kept failing in the background
- **What I did:** Nothing in particular — this showed up on almost every page.
- **What happened:** The browser console showed a repeating
  `WebSocket connection to '...supabase.co/realtime/...' failed (500)` on nearly every
  page load. I couldn't confirm a visible effect on my single browser tab, but it means
  I could not properly test "does the other counselor's screen update live" — see
  **What I couldn't test**. I'm flagging it because, unlike the Cloudflare bot-check
  domain I was told to ignore, this is Campistry's own database connection failing, not
  a font or unrelated script.

### 🟡 Side menu starts collapsed with no obvious hint
- **What I did:** Logged in, clicked FLOW, tried to click "Daily Schedule (View)" from
  the text I could see on the page.
- **What happened:** The click silently failed — the menu items are technically on the
  page but hidden until you click the small hamburger icon (☰) in the top-left corner
  first. It's a small thing but cost me a minute the first time.

## Confusing: where I got lost or unsure
- Under the rain banner, there's a big orange **"Mid-Day Mode"** bar (which is the
  actual "turn it on" button) with a much smaller **"Settings"** link right underneath
  it. I clicked "Settings" first, assuming that's how you'd turn it on — it actually
  only opens a template-picker, and the real activation button is the big bar itself.
- The rain panel says **"0 Indoor Fields, 2 Special Activities"** — I originally read
  this as "nothing works indoors," which worried me. After poking around I think
  "Indoor Fields" only counts sports fields marked indoor (like an indoor gym), and my
  pool/arts room count separately under "Special Activities" — but it's not obvious at
  a glance, and I couldn't fully confirm because there was no real schedule to check it
  against.
- I unlocked a "First Schedule" achievement badge on the Dashboard even though the
  schedule that triggered it was completely empty — a little misleading.
- The footer "Billing & Pricing" link (bottom of every page) doesn't seem to do
  anything when clicked. Not sure if that's intentional or broken.

## Ideas to make it better (most valuable first)
- **Warn me if Generate produces nothing.** If the solver places zero activities, don't
  show a cheerful green "Schedule Generated!" — tell me plainly ("no activities could
  be placed — check your setup") so I'm not fooled into thinking the board is ready.
- **Actually hide Payroll/Billing/Finance/Payment for my role**, not just from the
  Dashboard's own homepage tiles — I could reach every one of them directly from the
  Me app's side menu and the Dashboard's own settings tabs.
- **Remember what I was doing.** Keep my builder mode and working date after a refresh,
  or at least show a banner ("You're viewing today in Manual mode") so I don't generate
  the wrong day by mistake.
- **Open the side menu by default** on Flow, or make it obvious there's a hidden menu,
  so a brand-new user doesn't lose their first minute hunting for it.

## What worked well
- **Print Center** — both the whole-camp view and the per-bunk view are clean, clearly
  labeled with the date and page counts, and easy to read. No cut-off text.
- **Facilities setup** — quick and clear to add a field/pool/room and tell it which
  sports or specials it hosts.
- **The single-slot editor's design** — when it wasn't erroring out, it showed exactly
  what I'd want as a head counselor: suggested activities, whether the bunk had done it
  before, which fields are open right now. Really nice when it works.
- **Camper Locator** — gave a clear, friendly message ("Camper 'a' not found — make
  sure the camper has been added in Campistry Me") instead of just breaking.
- **Notes (Shift+N)** — instant, saved correctly, and was still there after a full
  reload.
- **Mid-Day Rain modal** — the explanation ("everything before stays, everything after
  is cleared") and the live Keep/Cut/Clear preview counts are exactly the kind of
  clarity I'd want in the middle of a real rainstorm.

## What I couldn't test, and why
- **Whether the schedule is actually fair** (no repeats too soon, activities spread out,
  multi-period activities placed sensibly) — impossible to judge since Generate never
  placed anything at all.
- **Whether Mid-Day Rain mode really protects the morning and only changes the
  afternoon** — there was no real morning schedule to protect, so I could only confirm
  the on/off mechanics, not the actual behavior.
- **Two people editing at once / live updates between tabs** — my test tool only
  drives one browser tab, and the realtime connection was failing anyway (see above),
  so I couldn't watch a second "viewer" see my changes land live.
- **League games** — no leagues were set up in this camp, and since the base
  generator isn't placing anything, it wasn't worth configuring one to test on top of
  a broken foundation.
- **Camper Locator with a real result** — this test camp has no campers loaded, so I
  could only confirm the "not found" path, not a real "found in Basketball at Field A"
  result.

## Note on today's test camp
This camp had nothing configured at all when I logged in — no fields, no daily
periods, no facilities. Since building tomorrow's schedule was my main mission, I set
up a small test configuration myself (fields named "TEST Field A/B," "TEST Pool,"
"TEST Arts Room," and day layers for all 3 grades) so there was something for the
solver to work with. Everything I added is clearly named "TEST" and I didn't touch or
delete anything that was already there. I also left a real staff note in Notes titled
"TEST Rachel - Rain Plan Thu 9/24" as part of mission 8.
