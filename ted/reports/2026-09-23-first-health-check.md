# Ted's report: first health check, 2026-09-23

## Verdict: 🔴 Problems found

I ran every automated check the project has. Almost all pass. One real
scheduler bug has been showing up in the checks for over two months, and a note
in the test docs was treating it as "known" instead of fixing it. The other
failures are small: one missed step, and a few tests that are out of date while
the site itself looks fine.

## The numbers
Checks run: 3,217 · Passed: 3,198 · Failed: 19
(real bugs: 14 checks, all one bug · missed step: 1 · out-of-date tests: 4)
Three more failed at first only because my machine lacked a tool (`pglast`).
After installing it they passed, so they're not counted above.

## What's wrong (most serious first)

### TED-001 🔴 The Auto Builder loses the name of custom blocks
- **What a camp would see:** When you add a custom block such as "Main
  Activity" to the Auto Builder, the generated schedule labels it **"Custom"**
  for every bunk instead of the name you gave it. The block is at the right
  time; only the name is lost.
- **How sure I am:** Confirmed in the project's own simulated camp. Not yet seen
  on the live site; the click-by-click at the bottom will tell you.
- **Proof:** `node --test tests/auto_full_day.test.js` gives 14 failures, every
  bunk "Main Activity count = 0". Dumping bunk "Auto 1" shows the 9:20–9:40 slot
  holds `"Custom"` (type custom, field "Custom"). The same test **passed** on
  2026-06-16 (commit `dd14ed8d`) and fails at every version checked from
  2026-07-12 onward. `tests/README.md` → "Known failures" calls these
  "pre-existing … unrelated". They're not unrelated; this is the core product.
- **What to ask the builder for:** "Auto Builder custom blocks are being labelled
  'Custom' instead of their name. `tests/auto_full_day.test.js` has been failing
  since July. Find the commit between June 16 and July 12 that broke it, fix the
  cause, get all 14 checks green, and remove the 'Known failures' note."

### TED-002 🟡 A version number wasn't bumped
- **What a camp would see:** Probably nothing today. But the dashboard and its
  setup checklist are meant to update together, and they're out of step. The
  next checklist change could reach some users late.
- **How sure I am:** Confirmed.
- **Proof:** `dashboard.html:941` loads `dashboard.js?v=20260922-08`, but
  `dashboard.html:942` loads `campistry_setup_checklist.js?v=20260922-07`. The
  test `tests/setup_checklist.test.js` requires them to match.
- **What to ask the builder for:** "Bump the setup checklist's ?v= in
  dashboard.html to match dashboard.js."

### TED-003 🟡 Deposit tests on the registration page are out of date (likely)
- **What a camp would see:** Nothing, as far as I can tell. The deposit code is
  still on the page. The danger is that these checks can't currently catch a
  real deposit bug.
- **How sure I am:** Likely, not confirmed.
- **Proof:** `tests/deposit_policy.test.js` fails with "missing _pickerSelected",
  but that function exists at `campistry_register.html:1871`. The test looks for
  it in "the second script on the page", and today's translation change
  (`35abc727`) edited that page, most likely shifting the scripts.
- **What to ask the builder for:** "Fix tests/deposit_policy.test.js so it finds
  the deposit functions wherever they are on the page, and confirm the 3 checks
  pass for the right reason."

### TED-004 🟡 Installment-plan test is out of date
- **What a camp would see:** Nothing. The payment-plan maths does use the shared
  rule.
- **How sure I am:** Confirmed.
- **Proof:** `campistry_me.js:14793` does `if(R)return R.build(...)`, which is the
  correct behaviour. The test only reads the first 900 characters of the
  function, and a long comment added on 2026-09-22 pushed that line past the
  cut-off.
- **What to ask the builder for:** "Make tests/installments.test.js read the
  whole _buildInstallmentSchedule function instead of the first 900 characters."

## What I confirmed is working
- About 3,200 automated checks across billing, payments, refunds, leagues,
  rotation, access and roles, cloud sync, buses and more pass: `npm test`.
- SQL migration checks pass once the `pglast` tool is installed.

## What I did NOT check (and why)
- **Anything in a real browser with a real login.** This was an automated-checks
  pass only.
- **Whether the checks themselves are good.** A passing check only means what it
  tests is right. I haven't yet looked for important behaviour with no check at
  all. That's what the area audits are for.
- **Live Supabase data, payments, SMS or email.** By design, Ted never touches
  them.

## Things only you can check (click-by-click)
1. Open the Flow page in **Auto Builder** mode.
2. Add a custom block and name it something distinctive, e.g. "Ted Test".
3. Generate a schedule.
4. Look at any bunk. If the block says **"Custom"** instead of "Ted Test", you've
   seen TED-001 with your own eyes.
