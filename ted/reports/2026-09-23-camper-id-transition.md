# Ted's report: has Campistry fully moved to camper numbers? 2026-09-23

## Verdict: 🟡 Mostly good, some issues

The answer to "have we completely moved to camper numbers?" is **no, not completely, and the code says so itself**. What was built works as described in most places: every database action that takes a camper's name now also takes their number, pages send the number, and all four test suites for this area pass. But under the surface the app still decides who a camper is mostly by **name**. I found one real bug where that shows through: a payment meant for a child who has left can land on a different child who now has the same name.

## The numbers
Tests run: 3,364 · Passed: 3,350 · Failed: 14 (real bugs: 14 in the auto-scheduler, not related to camper numbers · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,263 run, 3,249 passed, **14 failed**. All 14 are in the auto-scheduler (`auto_full_day.test.js`). They fail the same way on the commit before the camper-number work started, so this work did not cause them. They are still failures, and the owner should know the scheduler has 14 broken checks.
- Database tests (`npm run test:pg`): 45 of 45 passed, against a real Postgres.
- Browser smoke test (`npm run test:smoke`): 32 of 32 passed.
- 600-camper scale test (`npm run test:scale`): 24 of 24 passed.

## What's wrong (most serious first)

### TED-001 🟠 Money for a child who has left can go to a new child with the same name
- **What a user would see:** A child (say "Avi Katz", camper #10) leaves camp with money still in his canteen account. Later a different child also called "Avi Katz" enrols and gets a new number (#11). If a payment or refund for the first Avi arrives afterwards (a late card payment, a refund of his old deposit), it is added to or taken from **the new Avi's** account, even though it carries the first Avi's number. The old family loses money and the new family gains it, or the other way round.
- **How sure I am:** Confirmed. I reproduced it on a test database built from the project's own migrations.
- **Proof:** I set up camp → roster `{"Avi Katz": #10}` → removed him → enrolled a new "Avi Katz" (the server gave him #11). Then I called `credit_canteen_balance_from_stripe(camp, 'Avi Katz', 25, 'pi_ted_1', p_camper_id => 10)`. Result: `camp_canteen_accounts` showed **person_id 11, balance 25.00**. Cause: the number-aware functions added in migration 248 turn the number back into a name and then look the name up again (`migrations/248_every_camper_function_takes_an_id.sql`, the wrapper body: `v_camper := public.camp_person_label(...)`). `camp_person_label` (`migrations/225_parent_submissions_run_on_ids.sql:219-228`) does not skip campers who have left, and the name lookup (`migrations/223_every_camper_reference_gets_an_id.sql:97-123`) prefers the child who is enrolled now. The same number → name → person step is in all 12 functions wrapped by 248. It is also in the offline-register import (`migrations/242_...sql`, the `camp_person_label` then `canteen_account_lock(p_camp_id, v_name)` lines). This can't be cleared by deleting the first child: the erase is refused while his canteen account still holds money (`campistry_me.js` `_runCamperErases`, the `canteen_balance` branch). So this is exactly the case where his number record stays around.
- **What to ask the builder for:** "When a camper number is given, make the 248 wrappers and the offline import act on that exact person, not on whoever currently holds their name. Include children who have left. Add a pgtest where a departed child and a new child share a name and a payment arrives by the departed child's number."

### TED-002 🟡 "Completely moved to camper numbers" is not true yet, by design
- **What a user would see:** Nothing today in normal use. The risk shows up when two campers share a name, when a camper is renamed, or when a record arrives with only a name. The app's own notes say most of it still runs on names.
- **How sure I am:** Confirmed (the code and the project's own design note say so).
- **Proof:** The design note at `campistry_camper_identity.js:8-35` says the roster, families, enrollments, bunk assignments, canteen, Go addresses, health records and print sheets are keyed by name, in "around 1,200 references". It calls re-keying by number "the right endpoint and the wrong next step". I counted 257 `roster[...]` name lookups across 17 app files, and 766 uses of `camperName` against 462 of `camperId`. 22 edge functions still work with `camper_name` columns. The Me page's delete code finds a camper's family and bunk by name (`campistry_me.js` around 6343-6356: `camperIds.indexOf(n)`, `bunkAsgn[...].indexOf(n)`, `enrollments[..].camperName===n`). Canteen accounts are still stored under a name (`camp_canteen_accounts.account_key`). After a rename in my test, the account still read `Avi` while the camper was `Avi Katz`. The number-aware database functions are wrappers that convert the number back into a name (see TED-001). The builder's claims list admits part of this ("the saved roster is still keyed by name").
- **What to ask the builder for:** "Write down, in one list, every place a camper is still identified by name (roster, families, enrollments, bunks, canteen account key, health log, Go), with a plan and an order for moving each to the camper number. Stop calling the transition complete until that list is empty."

### TED-003 🟡 Campistry Lite (the phone app) never sends camper numbers
- **What a user would see:** Nothing visible. Messages sent to parents from Lite go out with only the camper's name. The server then guesses the number from the name, and leaves it blank if two campers share it.
- **How sure I am:** Confirmed by reading the code.
- **Proof:** The staff lookup reads the roster through `window.loadGlobalSettings` (`supabase_client.js:36-43`). Lite never defines or loads that (`grep loadGlobalSettings campistry_lite.js` finds nothing), so the lookup always returns "unknown". Lite's `sendLinkMessage` writes `link_messages` with `camper_name` only (`campistry_lite.js:668-679`). Lite also records medication given by name only (`campistry_lite.js:605-617`). Also, Lite loads `supabase_client.js` with no `?v=` version number (`campistry_lite.html:146-178`), so phones and browsers can keep running an old copy after an update.
- **What to ask the builder for:** "Give Campistry Lite a way to look up camper numbers (and send them on messages and medication records), and add a version number to the scripts Lite loads."

### TED-004 🟡 The tests don't cover the risky cases
- **What a user would see:** Nothing directly. It means the next change could break name-sharing cases and no test would notice.
- **How sure I am:** Confirmed.
- **Proof:** The browser smoke test's camper-number check covered only **3** calls that named a camper (`npm run test:smoke` output: "every call that named a camper also sent the camper id → 3 calls named a camper"). No test anywhere has a departed camper and a new camper sharing a name (TED-001 passes every suite). The database check `verify_every_camper_function_takes_an_id()` returns `[]`. It only checks that a function *has* a number argument, not that the number is what decides.
- **What to ask the builder for:** "Add tests where two campers share a name (one enrolled, one departed, and both enrolled) and push money, forms and face data through each path by number."

### TED-005 🟠 14 auto-scheduler tests are failing (not caused by this work)
- **What a user would see:** Possibly gaps or misplaced blocks in some auto-built daily schedules (the failing checks are about full, gapless days, lunch and swim placement, and minimum counts). I didn't confirm the effect in the app.
- **How sure I am:** Confirmed that the tests fail. Not confirmed whether the product or the tests are wrong. That is outside today's area.
- **Proof:** `npm test` → `# fail 14`, all in `tests/auto_full_day.test.js` (tests 174-195). The same 14 fail at `c771c16~1`, before any camper-number work. `tests/README.md` has called them "pre-existing" since commit `3626183` (2026-09-09). Being known doesn't make them pass.
- **What to ask the builder for:** "Find out for each of the 14 auto_full_day failures whether the scheduler or the test is wrong, and fix it."

## What I confirmed is working
- Every database function that takes a camper name also takes the number: on a database built from all 72 migrations the tests use, a query of all functions found none with a camper-name argument and no `p_camper_id` (only two results, both output columns). `verify_every_camper_function_takes_an_id()` returned `{"name_only": []}`.
- The page wrapper adds the camper number to database calls, direct table writes and edge-function calls: `tests/every_camper_call_sends_an_id.test.js` passes, and I read `campistry_camper_id_rpc.js` in full. I also checked that the bundled Supabase library looks up `fetch` each time a call is made (`supabase-js@2.js`: `resolveFetch … (...e)=>fetch(...e)`), so edge calls made through `functions.invoke` really do go through the wrapper.
- Every page that uses the staff database client loads the wrapper, all on the same version (`campistry_camper_id_rpc.js?v=20260923-02` on 23 pages). The four pages that create their own client (link_staff, reset, invite, contract) make no camper calls.
- The parent portal's names line up: invites store the same roster key the portal later sends back (`campistry_me.js:14311-14335`, `campistry_link_parent.html` `_applyData`), so `get_my_camper_ids` matches correctly even for a second child with the same name ("Name #102").
- The server gives a new child a new number, not a departed child's number, even when the names are the same. My test on the scratch database: departed Avi Katz kept #10, and the new Avi Katz got #12 (or #13 when typed with no number).
- Canteen money follows a camper through a rename when paid by number. My test: balance 20 → rename → +5 by number → +1 by old name = 26 on person #10.
- Deleting a camper: the confirmation says clearly that everything tied to their number is permanently deleted. The Undo button shows for 6 seconds, the erase fires at 8, and Undo cancels it (`campistry_me.js:6327, 6369, 6383`, `toast` at 1432).
- Migrations 248-256 each have a passing database test (`npm run test:pg`: 45/45).
- The 14 scheduler failures are older than this work: same 9 pass / 14 fail at commit `c771c16~1` (checked in a temporary git worktree, since removed).

## What I did NOT check (and why)
- **The live database.** I did not connect to it. I can't confirm that 248-254 are really applied there, or that 255 and 256 are not.
- Whether real camper data already has departed and enrolled campers sharing a name (which would make TED-001 live today).
- The edge functions running on Supabase (only their source code and source-scanning tests).
- Real card payments, webhooks and refunds from the payment processors.
- The phone app (Capacitor builds) and its over-the-air update path.
- Every one of the ~50 page calls in a real browser: the smoke test exercised only 3 that named a camper.
- `erase-camper-files` deleting real stored files, and whether deleting the medical and health records of departed campers meets the camp's record-keeping duties (a policy question, not a code question).

## Things only you can check (click-by-click)
1. **See whether TED-001 could already affect you.** Supabase Dashboard → SQL Editor → New query → paste and Run:
   ```sql
   select camp_id, source_key, count(*) as how_many,
          count(*) filter (where deleted_at is null) as enrolled_now
     from camp_people where kind = 'camper'
    group by camp_id, source_key
   having count(*) > 1 and count(*) filter (where deleted_at is null) >= 1;
   ```
   Any row means a departed child and a current child share a name, and payments for the departed child could land on the current one. Send the result to the builder.
2. **Confirm what is applied.** SQL Editor → run `select public.verify_every_camper_function_takes_an_id();` It should show `{"name_only": []}`. Then run `select public.verify_parent_matching_on_numbers();` and `select public.verify_rows_matched_by_number();`. If these say "function does not exist", then 255/256 are not applied (the builder says they are not yet).
3. **Before applying 255 and 256:** ask the builder about TED-001 first. Those two migrations don't fix it, and applying them doesn't make it worse.
