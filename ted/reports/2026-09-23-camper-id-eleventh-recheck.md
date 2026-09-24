# Ted's report: camper ID number, check of the TED-037..041 fixes, 2026-09-23 (eleventh visit)

## Verdict: 🟡 Mostly good, some issues

I checked the builder's one new commit (`50f96f6`) and re-tested every open finding myself. Your rule is now true on the normal paths: once a page learns that a camper was erased elsewhere, it reloads, and none of its old copy leaves it. That includes the "save on the way out" that leaked last time.

I closed five findings with my own proof:
- TED-035
- TED-037
- TED-038
- TED-039
- TED-041

What's left is small:
- **A 15-second window:** some saves other than camp documents can still slip through in the seconds after an erase.
- **Several erases at once:** the page doing the erasing can reload itself if it erases several children together.
- **A gap in the safety net:** one kind of request address gets past the new guard.

No family can become the wrong child's parent through any of this.

## The numbers
Tests run: 3,439 · Passed: 3,425 · Failed: 14 (real bugs: not sorted, all 14 are the auto-scheduler tests you deferred (TED-005) · out-of-date tests: 0 · my machine: 0)

| Suite | Run | Passed | Failed |
|---|---|---|---|
| Unit (`npm test`) | 3,284 | 3,270 | **14** (`auto_full_day.test.js` 174-195, the same 14 as every visit) |
| Database (`npm run test:pg`) | 50 | 50 | 0 (against 89 migrations) |
| Roster keys (`npm run test:keys`) | 37 | 37 | 0 |
| Lite + Health (`npm run test:lite`) | 12 | 12 | 0 |
| Smoke (`npm run test:smoke`) | 32 | 32 | 0 |
| 600-camper scale (`npm run test:scale`) | 24 | 24 | 0 |

These match the builder's numbers exactly.

## What's wrong (most serious first)

### TED-040 🟡 (still open, narrowed) Other saves can still slip through in the 15 seconds after a check
- **What's fixed:** calls to the server's own functions, such as a canteen refund or auto-reload, are now covered. I tested this with the real Supabase library (details below).
- **What's left:** other saves still only ask "has anything been erased?" once every 15 seconds. This covers tables other than camp documents, and server requests like canteen sales, which carry a camper's number.
- **What a user would see:** almost certainly nothing. It could only matter like this:
  1. A busy page, such as a Snacks till, checked a few seconds before an erase on another computer.
  2. Within 15 seconds, the erased number is given to a new child.
  3. The till then records a sale on that number, so it lands on the new child.

  Step 2 has to happen within those seconds, which is very unlikely. But it's the last place where "a page opened before an erase can't save anything" isn't strictly true.
- **How sure I am:** Confirmed by reading the code. I didn't run it.
- **Proof:** `supabase_client.js`, in `_withEraseGuard`:
  - `const maxAge = table === 'camp_state_kv' ? 0 : 15000;`
  - `client.rpc` → `guardThen(b, 15000)`
- **What to ask the builder for:** "For RPCs that carry a camperId (canteen sales, payments, health), check the cache version afresh instead of the 15-second one, or tell me why the 15 s window is safe."

### TED-042 🟡 (new) The page doing the erasing can reload itself when it erases several children at once
- **What a user would see:**
  1. The office removes two or more campers together.
  2. About 8 seconds later, the Me page erases them all at the same moment.
  3. If the server's answers come back in a different order than they were done, the office's own page shows "A camper was erased on another computer. Reloading…" and reloads, although nobody else erased anything.
  4. Anything typed in the last half-second before the reload is dropped.

  No child's data goes to the wrong child. The erases themselves finish, because they were already sent.
- **How sure I am:**
  - **Confirmed:** the page reloads when two answers arrive out of order.
  - **Likely rare:** how often answers actually arrive out of order on a real connection. I couldn't measure that here.
- **Proof:**
  - The Me page sends every queued erase at once and hands each answer to the guard as it arrives (`campistry_me.js:442-452`, `q.map(...)`).
  - The new rule accepts only "exactly one more than last time" (`supabase_client.js`, `_eraseGuardAdvance`: `if (_EG.tab !== null && n !== _EG.tab + 1) { _egReload(camp, n); return; }`).
  - My browser run (`v11/t41.e2e.js`, real supabase-js):
    - answers 1 then 2 → `reloaded: false`
    - answers 4 then 3 → `reloaded: true`
- **What to ask the builder for:** "When the Me page runs several erases or merges at once, send them one after another (or let __campistryEraseGuardAdvance accept a batch of its own erases in any order), so the office's own page doesn't reload itself."

### TED-043 🟡 (new) The new "no writes while reloading" guard misses one kind of request
- **What a user would see:** nothing today. This is a missing safety net.
  - The builder said the guard returns a refusal for **any** write request to the camp's server while the page is reloading.
  - That's true when the address is written as text, and for the other ways I tried.
  - A write whose address is given as a URL object still goes out.
  - No page in the app writes to the server that way today, so nothing leaks now. A future change could open it without anyone noticing.
- **How sure I am:** Confirmed in a browser.
- **Proof:** my run `v11/realjs.e2e.js`. With the page flagged as reloading:

  | How the write was sent | Result |
  |---|---|
  | text address (including `keepalive`) | refused, `409` |
  | `new Request(...)` | refused, `409` |
  | method written as `'post'` | refused, `409` |
  | client upsert | blocked |
  | `fetch(new URL(...), {method:'POST'})` | **`200`, reached the server** |

  The cause: `_installEraseGuardFetch` reads the address as `typeof input === 'string' ? input : input.url`, and a URL object has no `.url`.
- **What to ask the builder for:** "In _installEraseGuardFetch, read the address with String(input.url || input) so a URL-object request is guarded too, and add that case to the test."

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14 tests. I didn't investigate them.

## What I confirmed is working

### TED-037: an old page's copy no longer leaves as it reloads (closed)
- **My own browser test from last visit, re-run unchanged at `50f96f6`** (`v11/leak2.e2e.js`). It runs the real Me page on a scratch database, with Avi #2 really erased and Sara given #2. The old page edits Leah and saves:

  | What I looked for | Result |
  |---|---|
  | Requests to the database that got past the guard | **0** (last visit: 1, carrying the stale edit) |
  | Leah's school in the database | not changed |
  | Reloads of the old page | 1 |

  This recorder sits at the network layer, below all of the app's code.
- **A harder version:** the old page saves and the office leaves the page right away. I tried leaving after 0, 100 and 300 ms (`v11/leak3.e2e.js`). Every time, nothing reached the database and the page reloaded once.
- **The builder's new check really catches the leak.** In a throwaway copy, I put back last round's `integration_hooks.js` and removed the new request guard. test:keys then fails `nothing of its out-of-date copy left the page` with the leaked `POST …/rest/v1/camp_state_kv` → `1 of 37 check(s) failed`.
- **There are two separate protections.** With only the `integration_hooks.js` fix removed, the request guard alone still stopped it: 37/37.

### TED-035: a leftover number-only record landing on a new child after an erase (closed under your rule)
- The two leaks that kept this open (TED-037, TED-038) are closed. The normal save, the save on the way out, and the local cache refill are all blocked on an out-of-date page. Proof is above.
- The remaining 15-second window is tracked under TED-040.
- Your decisions are respected:
  - The erased number was free to reuse: Sara got #2.
  - The erase answered `number_is_free: true` and `detached_money: {}`.

### TED-038: Lite now loads the guarded file (closed for the web version)
- `campistry_lite.html:137` now has `LITE_ASSET_VERSION = '20260923-08'` (was `-06`), and `supabase_client.js` is first in its load list.
- Lite saves camp documents through the guarded client: `saveKV` → `window.supabase.from('camp_state_kv').upsert` (`campistry_lite.js:478-486`).
- `campistry_lite_login.html` is bumped to `supabase_client.js?v=20260923-04`.
- The phone app (Capacitor) is a separate build; see "Things only you can check".

### TED-039: the check script now spots an old copy of 260 (closed)
On scratch databases, running `scripts/verify_identity_chain.sql` (`v11/v39.js`):

| Database | 260 row says |
|---|---|
| full chain | `ok` |
| 260 from `189d36b` (the builder's test) | `run 260 again — this database has an earlier copy of 260` |
| 260 from `b92dcdc` (my test from last visit) | `run 260 again — this database has an earlier copy of 260` |
| 261 but no 260 | `apply 260` (no crash) |

With neither 260 nor 261, the script stops at the 261 row. That happens because my scratch chain doesn't include migration 131's `upsert_parent_invite`, which your real database has. The same stop happens with last round's script. This is my machine, not a bug.

### TED-041: the erasing page now reloads when someone else erased in between (closed as asked)
- In a throwaway copy with the old `Math.max` put back, test:keys fails: `timed out waiting for the erasing page to reload`.
- In my browser run, answers 1 then 2 → no reload, as expected.
- The out-of-order case is new, and filed as TED-042.

### TED-040's main part: server-function calls from an out-of-date page are stopped
Tested with the **real** Supabase library (`supabase-js@2.js`), not the test stand-in, using my run `v11/realjs.e2e.js`:
- **Current page:** a check goes first, then the call: `POST /functions/v1/canteen-auto-reload {"campId":"c1","camperId":2}`.
- **After an erase elsewhere:**
  - `functions.invoke('canteen-auto-reload', …)` → only the version check went out, no function call, and the page reloaded.
  - A plain `fetch(…/functions/v1/stripe-canteen-refund, POST)` → same: only the check, and the page reloaded.
- **The library point:** the builder said supabase-js makes a new functions client every time the page reaches for it. That's true (`functions === functions` → false), and the guard still covers it.
- **About the test:** in test:keys, the check "no /functions/v1/ request leaves it" can't fail, because the test stand-in never sends function calls at all. Its reload check is the part that really tests the fix. My real-library run covers the rest.

### Browser caching
- `supabase_client.js?v=20260923-04` is on all 21 pages that load it with a tag. The only page without a tag is Lite, which builds the address in code with `-08`.
- `integration_hooks.js?v=20260923-22` is on all 11 pages.
- No other page or script loads either file.

### Leftovers
- The code changes add no TODO, FIXME, debug switch or new logging. The only `console.log` lines in the diff are existing error handlers on script tags that were re-versioned.

## What I did NOT check (and why)
- **The live database.** I didn't connect, so I don't know whether the current 260 and 261 have been run there. The check script now tells you (TED-039 closed).
- **A real phone and the native Lite app.** I tested Lite's web loader by reading its code, and test:lite passed in a browser.
- **The real edge functions and real money.** For TED-040, I checked with fake server answers only. No real refund or auto-reload was sent.
- **Two real computers on a real network.** My "other computer" was a second browser page, or my database commands. So I couldn't measure how often TED-042's out-of-order answers happen.
- **Pages other than Me for the "leave right after saving" case.** Flow, Health and the rest save through the same code, but I only drove the Me page.
- **The 14 auto-scheduler failures** (deferred by you).

## Things only you can check (click-by-click)
1. **Make sure your database has the current 260 and 261.**
   1. Supabase Dashboard → SQL Editor → New query → paste all of `scripts/verify_identity_chain.sql` → Run.
   2. Look at the rows starting `260` and `261`. Both should say `ok`.
   3. If the 260 row says "run 260 again" or "apply 260": New query → paste all of `migrations/260_numbers_stay_with_their_child.sql` → Run. Then do the same with `migrations/261_only_the_camp_office_writes_parent_invites.sql`.
   4. Run the check again.
2. **After the new code is live, reload every office computer once.** A page opened before the update still runs the old code. On counselors' phones, fully close Lite and re-open it.
3. **The phone app (Capacitor build).** Lite's phone app carries its own copy of the files. Publish a new app build (or live update) through whatever you normally use to ship the phone app, so phones get the new `supabase_client.js`. If you don't know how that's done, ask the builder: "How do I ship the Lite phone app update that includes supabase_client.js v20260923-04?"
4. **Two-computer check.**
   1. Open Me on two computers.
   2. On computer 1, delete a test camper and wait about 10 seconds.
   3. On computer 2, edit a different camper and press Save.
   4. Computer 2 should say "A camper was erased on another computer. Reloading…" and reload.
   5. After the reload, the edit from computer 2 should **not** be there.
5. **Several-at-once check (TED-042).**
   1. On one computer, delete three test campers quickly, one after another.
   2. Wait about 15 seconds and watch that same page.
   3. If it says "A camper was erased on another computer. Reloading…" even though nobody else was working, that is TED-042 happening on your connection.
