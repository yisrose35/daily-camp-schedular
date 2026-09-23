# Ted's report: are we now complete with the move to camper numbers? 2026-09-23 (third visit)

## Verdict: 🟡 Mostly good, some issues

**No, the move isn't complete, and the builder's own count agrees: 589 places still identify a child by name.** What was fixed this round is real, and I proved it myself. The money mix-up I found last time (TED-006) is gone. No number gets added to a name any more. Lite now records medicine against the right child when two share a name, and a real browser test proves it. But I found two new problems. The office Billing screen still shows "Rivka Stern #702", which you asked never to happen. And one "is this your child?" check was missed by the fix, so it can answer "yes" about a child who has left and shares your child's name.

## The numbers
Tests run: 3,386 · Passed: 3,372 · Failed: 14 (real bugs: not yet sorted, all 14 are the auto-scheduler you asked to skip · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,276 run, 3,262 passed, **14 failed**. They're the same 14 auto-scheduler failures (TED-005, deferred by you).
- Database tests (`npm run test:pg`): 46 of 46 passed, against all 74 migrations.
- New Lite + Health browser test (`npm run test:lite`): 8 of 8 passed.
- Browser smoke test (`npm run test:smoke`): 32 of 32 passed.
- 600-camper scale test (`npm run test:scale`): 24 of 24 passed.

## What's wrong (most serious first)

### TED-008 🟠 One "is this your child?" check was missed, and says yes about a departed child with the same name
- **What a user would see:** Normally nothing. The risk: a child named Avi Katz has left camp and a new Avi Katz has enrolled. If a request asks "is the departed Avi (#10) mine?", the new Avi's parent gets **yes**. Two server functions rely on this answer:
  - **Photo checkout.** The parent would be sent to Stripe and charged for photo matching for a child who isn't theirs.
  - **PDF form upload.** The file gets stored before a second check correctly refuses the form, so an orphan file is left behind.

  The normal screens only offer a parent their own children, so this needs a crafted request plus a same-name departed child. It's unlikely, but it's the exact kind of mix-up this whole project exists to end. The builder's new safety check ("no number-taking function left unpinned") reports all clear, because it skips any function whose name starts with `verify_`, and this function is called `verify_my_camper`.
- **How sure I am:** Confirmed on a scratch database built from all 74 migrations.
- **Proof:** Departed "Avi Katz" #10 and enrolled "Avi Katz" #892, with a parent linked only to #892. As that parent:
  - `verify_my_camper(camp, 'Avi Katz', 10)` returned **`t`** (wrong).
  - The deeper check, `_parent_owns_camper(camp, 'Avi Katz', 10)`, returned `f` (right).
  - `submit_link_form_response(... 'Avi Katz', '10' ...)` returned `camper_not_on_invite` (right).
  - Cause: 257's list of functions to convert excludes `verify\_%` (`migrations/257_a_number_reaches_its_own_camper.sql`, `_functions_that_must_pin`). So `verify_my_camper` still calls the old `camp_person_label` and decides by the plain name. Called from `supabase/functions/link-photo-checkout/index.ts:118` and `supabase/functions/submit-pdf-form-response/index.ts:74`.
- **What to ask the builder for:** "In 257, make verify_my_camper pass the camper number through to _parent_owns_camper instead of turning it into a name, and stop the verify_ exclusion from hiding non-checker functions. Add a pgtest: departed Avi #10, enrolled Avi, the new Avi's parent asks verify_my_camper about #10 and must get false."

### TED-009 🟠 The office Billing screen still shows "#702" after a name
- **What a user would see:** A family with two children both called Rivka Stern shows in Billing as **"Rivka Stern, Rivka Stern #702"**. The same appears in the family's detail view, a billing report, and the CSV export (so the "#702" lands in the spreadsheet). Bill lines are written as "Tuition — <key>", so a line for the second Rivka probably reads "Tuition — Rivka Stern #702". I didn't confirm whether parents see that line.
- **How sure I am:** Confirmed on screen for the Billing list. Confirmed in code for the other three. Suspected for the bill-line text reaching parents.
- **Proof:** I opened the real pages in a browser against a test database with two enrolled Rivkas, then searched each screen's text for "#702".
  - **Me → Billing:** `SHOWS #702 … "Stern family Rivka Stern, Rivka Stern #702"`.
  - **Clean:** Me → Campers, Snacks (accounts, register, offline register), the stand-alone register, Live and Health all showed both Rivkas without "#702".
  - Lines that use the raw key: `campistry_me.js:17421` and `:17464` (family list and detail), `:20559` (report), `:21269` (CSV). Bill-line note: `campistry_billing_core.js:358`. By contrast, line 18216 and line 21282 in the same file do strip it, so the helper exists and was simply missed here.
- **What to ask the builder for:** "Strip the roster's ' #number' from every name shown or exported in Me → Billing (campistry_me.js 17421, 17464, 20559, 21269) and from bill-line notes (campistry_billing_core.js 358), and add Billing to the browser test that looks for '#702' on screen."

### TED-002 🟡 (still open, narrowed) The move to camper numbers is not finished
- **What a user would see:** Nothing in normal use. The risk remains a rename, two children sharing a name, or a record that arrives with only a name.
- **How sure I am:** Confirmed.
- **Proof:** `docs/CAMPER_NAME_INVENTORY.md`, regenerated by me, came out unchanged: **589 places**.
  - Pages: 95 records saved without a number, 44 enrollments, 73 family lists, 53 bunk lists, 190 roster lookups.
  - Server functions: 130 lines.
  - Database storage keyed by a name: 4 kinds (canteen accounts, parent invitations, family child lists, saved camp documents).

  The inventory now covers server functions and the database, which is what I asked for. One gap: it deliberately skips three retired payment functions, and one of them, `payments-canteen-checkout`, still credits a canteen account **by name only** (`index.ts:116-122`, no camper number anywhere). No page calls it now; see "Things only you can check" step 3.
- **What to ask the builder for:** "Keep working down CAMPER_NAME_INVENTORY.md in the order it gives, and delete the three retired payment functions from the repo so they can't be redeployed."

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- Same 14 as before (`auto_full_day.test.js`, tests 174-195). Not part of camper numbers; not investigated, as you asked.

## What I confirmed is working
- **TED-006 is fixed (closed).** I built a scratch database and ran my original case one call at a time, the way pages really call it. The builder's test runs everything as one call, which could hide problems.
  - Setup: "Sam Cohen" #2 and "Sam Cohen #2" #5.
  - Looking up the name "Sam Cohen #2" gives **5**, and "Sam Cohen" gives **2**.
  - Credits by name and by number all landed right: #5 = $9 + $20 + $4,000 = **4,029**, #2 = $300 + $1 = **301**. The $4,000 was sent with number 5 and the *wrong* name "Sam Cohen", and the number won.
  - Account labels stayed "Sam Cohen" and "Sam Cohen #2", with no "#2 #5".
  - The safety check returned all three lists empty.
- **No number is added to anyone's name by the server any more.** The builder's new test fails on the previous version ("a number was added to a name: Dov Stern #31") and passes now.
- **The pin design holds up under the checks I tried:**
  - Every rewritten function runs with owner rights, so parents and staff don't hit permission errors.
  - No database trigger pins.
  - The two functions that loop over many children (`get_my_shop_orders`, `parent_invites_needing_attention`) only pass names, so no pin leaks from one child to the next.
  - The one import that handles many campers clears pins for each row.
- **The Lite medicine bug is real and fixed.** Old code (`campistry_lite.js`, `{ name: n, ...c }`) let the display name overwrite the roster key, so both Rivkas became one. The new code keeps the key. The new browser test (8/8) presses Lite's real Give button, sends a Lite message and logs a Health dose for the second Rivka. It then reads the saved rows: `camperId: 702` and `person_id 702`. On the old Lite code the test fails. I searched the whole codebase for the same pattern and found none.
- **TED-007 is fixed (closed).** Lite and Health are now exercised in a real browser against a real database (`tests/lite_health_numbers.e2e.js`).
- **Parent-facing emails and receipts:** the six server functions changed for display strip "#number" only from text people read (email subjects and bodies, card descriptions, receipt "Camper" row). The name sent to the database is unchanged. For example, `auto-notify` uses the name only in email text (lines 98-148).
- **Browser caching:** every changed script got a new version number: the camper-number helper on all 23 pages, Health, Me, Snacks, and Lite's own bundle version (`LITE_ASSET_VERSION` 20260923-01 → -02).
- **Quick Fill spreadsheet upload** (new since last visit) only creates divisions, grades and bunks, never campers, so it has no effect on camper numbers.

## What I did NOT check (and why)
- **The live database.** I didn't connect to it. The builder says 255, 256 and 257 aren't applied yet.
- **Whether the parent portal shows "Tuition — Rivka Stern #702"** on a bill (TED-009, last bullet). That needs a parent login set up in the test harness, which I didn't build.
- **Printed schedules, bunk lists in the scheduler (Flow), Go and the parent-message screens with same-named children.** My test data didn't put Rivka on those screens (0 mentions), so their "clean" result proves nothing.
- **Whether the six changed server functions and the fixed 257 are deployed.** I can't see Supabase.
- **Real card charges**, photo checkout through Stripe, and Lite on a real phone.
- **Why the 14 scheduler tests fail**: deferred by you.

## Things only you can check (click-by-click)
1. **Hold 257 until TED-008 is fixed**; it's a small change to the same file. 255 and 256 can go in now, in order: Supabase Dashboard → SQL Editor → New query → paste `migrations/255_a_parents_family_is_found_by_camper_number.sql` → Run, then the same for `256_…`.
2. **After 257 is applied:** SQL Editor → New query → paste the whole of `scripts/verify_identity_chain.sql` → Run. Every line should say `ok`.
3. **Check whether the three retired payment functions are still live:** Supabase Dashboard → Edge Functions. If `payments-canteen-checkout`, `payments-checkout` or `payments-charge` appear in the list, tell the builder. The builder should confirm nothing uses them, and then you can delete each one from its function page (⋯ menu → Delete).
4. **Redeploy the six changed server functions** once the builder confirms they're final: Supabase Dashboard → Edge Functions → for each of `auto-notify`, `canteen-auto-reload`, `charge-saved-card`, `payments-charge-nonce`, `stripe-checkout`, `send-payment-receipt`, open it and deploy the new code the way the builder walks you through.
5. **See TED-009 yourself:** open Me → Billing for any family with two children of the same name. If you see "#" and a number after a child's name, that's this bug.
