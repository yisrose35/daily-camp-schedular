# Ted's report: are we good to go with the new camper numbers? 2026-09-23 (second visit)

## Verdict: 🟡 Mostly good, some issues

**Not completely.** The builder fixed three of my four earlier findings properly, and I proved it myself. A payment for a child who has left now reaches that child, not a new child with the same name. Campistry Lite now sends camper numbers. All the database, browser and 600-camper tests pass. But the fix for the money bug added a new, rarer way for money to reach the wrong child. The live database doesn't have migrations 255, 256 or 257 yet. And the app still identifies campers by name in about 457 places on the pages, plus the server-side functions that list doesn't count. So don't apply 257 yet (see TED-006), and don't treat the move to camper numbers as finished.

## The numbers
Tests run: 3,374 · Passed: 3,360 · Failed: 14 (all 14 in the auto-scheduler, outside this area, cause not yet sorted · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,272 run, 3,258 passed, **14 failed**. They're the same 14 auto-scheduler failures as last time (TED-005).
- Database tests (`npm run test:pg`): 46 of 46 passed, against all 73 migrations.
- Browser smoke test (`npm run test:smoke`): 32 of 32 passed.
- 600-camper scale test (`npm run test:scale`): 24 of 24 passed.

## What's wrong (most serious first)

### TED-006 🟠 The fix for the money bug can send money to the wrong child in a rarer case
- **What a user would see:** A camp has two children called Sam Cohen. The second one's record is stored as "Sam Cohen #2". If the first Sam Cohen happens to *be* camper number 2, any payment, credit or form that arrives with only the name "Sam Cohen #2" now goes to the **first** Sam. The office desk, older phone app versions, anything that sends a name without a number are all affected. Before this change it went to the right child. The new safety check the builder added ("does every number come back to its camper?") says everything is fine, so nobody would be warned. When the number *is* sent, the money goes to the right child, but that child's canteen account gets saved under an odd label, "Sam Cohen #2 #5".
- **How sure I am:** Confirmed that it happens. I don't know how often real data ends up like this. It needs a record whose "#number" belongs to a different child with the same name. That can happen when the page makes up a "#number" label and the server later gives that camper a different number, or when the "#2, #3…" counter fallback is used.
- **Proof:** On a scratch database built from all the migrations, with roster `{"Sam Cohen": #2, "Sam Cohen #2": #5}`:
  - Without 257: looking up "Sam Cohen #2" gives **5** (right). An office credit of $9 by that name lands on person **5**.
  - With 257: looking up "Sam Cohen #2" gives **2** (wrong). The same $9 credit lands on person **2**. `verify_number_round_trip()` returns `"numbers_that_miss_their_camper": []`.
  - Cause: `migrations/257_a_number_reaches_its_own_camper.sql`, `camp_person_by_name`. The new "ends in #number" rule runs *before* the exact-name match, so it wins even when another child's stored name is exactly "Sam Cohen #2". Where these labels come from: `campistry_camper_identity.js:99-107` (`uniqueKey`, which uses a counter when needed) and `campistry_me.js:5705`. The server can later change the camper's number without changing the label (migration 253's header, point 1).
- **What to ask the builder for:** "In 257's camp_person_by_name, an exact match on a camper's stored name must win before the 'Name #number' rule. Add a pgtest where 'Sam Cohen' is #2 and 'Sam Cohen #2' is #5, paid both by name and by number. Also make verify_number_round_trip check every roster key reaches its own camper, not only every number."

### TED-002 🟡 (still open) The move to camper numbers is not finished, and the new to-do list undercounts
- **What a user would see:** Nothing in normal use. The risk is still two children sharing a name, a rename, or a record that arrives with only a name.
- **How sure I am:** Confirmed.
- **Proof:** The builder's new list `docs/CAMPER_NAME_INVENTORY.md` is honest that **457 places** on the pages still identify a camper by name. Its test passes 4/4, and it will fail if anyone adds more. But the counting script only looks at the page files in the top folder (`scripts/camper_name_inventory.js:47-48`, `.js`/`.html` in the repo root). It doesn't count the **29 server functions** under `supabase/functions/` that still handle `camper_name` or `camperName` (`grep -rlE "camper_name|camperName" supabase/functions --include=*.ts | wc -l` → 29). It also doesn't count the database's own name-based storage, such as canteen accounts stored under a name (`account_key`). So "finished when every number here is zero" (line 5 of the doc) would not really mean finished. Good news: I checked the money server functions (Stripe, Cardknox, hosted checkout, auto-reload, both canteen refunds), and each one passes the camper number to the database.
- **What to ask the builder for:** "Extend the camper-name inventory to cover supabase/functions and the name-keyed database columns, so zero really means done."

### TED-007 🟡 Most of the new Lite and Health tests read the code's text instead of running it
- **What a user would see:** Nothing today. A later change could break Lite's camper numbers and these tests might still pass.
- **How sure I am:** Confirmed.
- **Proof:** `tests/every_camper_call_sends_an_id.test.js`, the last five tests. One of them really runs the camper-number lookup, and it passes. The others only check that certain text is present, e.g. `assert.match(lite, /window\.__camperIdRoster = camp\.roster;/)` and `assert.match(h, /camperId:camperIdOf\(/)`. The browser smoke test still exercises only **3** calls that name a camper ("every call that named a camper also sent the camper id → 3 calls named a camper"). Lite and Health aren't among them.
- **What to ask the builder for:** "Add a browser test that opens Campistry Lite and Health against the test database, sends a parent message and logs a medication, and checks the saved rows carry the camper number."

### TED-005 🟠 (still open) 14 auto-scheduler tests still fail
- **What a user would see:** Possibly gaps or misplaced blocks in some auto-built schedules. Not related to camper numbers.
- **How sure I am:** Confirmed that the tests fail. I haven't looked into why; that's outside today's area.
- **Proof:** `npm test` → `# fail 14`, all in `auto_full_day.test.js` (tests 174-195). The list is the same as last visit.
- **What to ask the builder for:** "Find out for each of the 14 auto_full_day failures whether the scheduler or the test is wrong, and fix it."

## What I confirmed is working
- **TED-001 is fixed (closed).** A late payment for departed Avi #10 now reaches #10 and not the new Avi #11. I checked with the builder's new test (`scripts/pgtests/257_…sql`) in both directions:
  - Without 257 on a scratch database, the test fails exactly where it should: `a Stripe credit for #10: expected #10 = 30 and #11 = 0, got #10 = 5.00 and #11 = 25.00`.
  - With 257, it passes (`npm run test:pg`: `ok 257_a_number_reaches_its_own_camper`).
- **TED-004 is fixed (closed).** That same test covers a departed and an enrolled child sharing a name through Stripe and processor credits, a Stripe refund, the office desk, cash-out, the register, the offline import and history. It also covers two enrolled look-alikes through forms, face consent, headshots, health documents, canteen limits and "is this my child". It checks that parent B can't reach parent A's child by sending A's number. It fails without the fix (above).
- **TED-003 is fixed (closed).**
  - Lite loads the number-adding wrapper first (`campistry_lite.html:29`). The database client then wraps itself with a lookup (`supabase_client.js:51-55`) that now also reads the roster Lite registers (`supabase_client.js:41-45`, `campistry_lite.js:417`). The unit test that runs that lookup passes.
  - Lite's medication records and the Health page's records now carry `camperId` (`campistry_lite.js:614-618`, `campistry_health.js:457, 471, 485`).
  - Health's camper search fills in the exact stored name, not the name as shown on screen (`campistry_health.js:631`), so a second child with the same name gets their own number.
  - Every Lite script of our own now carries `?v=` (`campistry_lite.html:180-184`).
- **Every changed script got a new version number.** Since my last visit: `supabase_client.js` -01→-02 on 21 pages (plus Lite's own versioning), `campistry_health.js` -01→-02, `campistry_snacks.js` -04→-05, `campistry_me.js` -06→-07.
- **Snacks shows a renamed camper's account under their new name.** `_accountsUnderCurrentNames` (`campistry_snacks.js:370-389`) is exercised by a test that runs it. That test passes.
- **The money server functions send the camper number:** `stripe-webhook/index.ts:237`, `cardknox-webhook/index.ts:507`, `payments-hosted-complete/index.ts:254`, `canteen-auto-reload/index.ts:470`, `stripe-canteen-refund/index.ts:229`, `payments-canteen-refund/index.ts:302`.
- **The live check script got a 257 line** (`scripts/verify_identity_chain.sql`), but see TED-006 for what it misses.

## What I did NOT check (and why)
- **The live database.** I didn't connect to it. The builder says 255, 256 and 257 aren't applied there yet, and I can't confirm that.
- **Whether your real data has a record like "Sam Cohen #2" whose number belongs to another Sam Cohen** (TED-006). Step 2 below shows how to find out.
- **Campistry Lite on a real phone**, including the app-store build and its live-update path. I only read the code and ran the lookup in a test.
- **Whether earlier rounds' server-function updates were actually deployed** to Supabase.
- **Real card payments, webhooks and refunds** with the payment companies.
- **Why the 14 scheduler tests fail.** That's outside today's area.

## Things only you can check (click-by-click)
1. **Don't apply 257 yet.** Ask the builder to fix TED-006 first. 255 and 256 can go in now, in order: Supabase Dashboard → SQL Editor → New query → paste `migrations/255_a_parents_family_is_found_by_camper_number.sql` → Run, then the same for 256.
2. **Check whether TED-006 could affect your real data.** This is read-only. SQL Editor → New query → paste and Run:
   ```sql
   select p.camp_id, p.person_id, p.source_key as stored_name, q.person_id as number_in_name_belongs_to
     from camp_people p
     join camp_people q
       on q.camp_id = p.camp_id and q.kind = 'camper'
      and q.person_id = substring(p.source_key from ' #([0-9]{1,15})$')::bigint
      and q.person_id <> p.person_id
      and lower(btrim(q.source_key)) = lower(btrim(regexp_replace(p.source_key, ' #[0-9]{1,15}$', '')))
    where p.kind = 'camper' and p.source_key ~ ' #[0-9]{1,15}$';
   ```
   No rows means TED-006 can't happen with today's data. Any row: send it to the builder before applying 257.
3. **After 257 (fixed) is applied:** SQL Editor → paste the whole of `scripts/verify_identity_chain.sql` → Run. Every line should say `ok`.
4. **Lite on a phone:** open Campistry Lite, send a parent a message about a camper, and log a medication. Then in Supabase Dashboard → Table Editor → `link_messages`, find your message: the `person_id` column should have the camper's number, not be empty.
