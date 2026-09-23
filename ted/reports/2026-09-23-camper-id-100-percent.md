# Ted's report: are we 100% on the camper ID number? 2026-09-23 (fourth visit)

## Verdict: 🔴 Problems found

**No, we are not at 100%.** The builder fixed a lot this round, and I checked it myself. My two open findings from last time are fixed. All the test suites pass except the 14 scheduler tests you deferred. The new "each roster key belongs to one child" rule works in the cases its test covers. But I found five ways a record can still reach the wrong child. The worst one is live today: when a sibling leaves a family, the parent portal can put **the brother's or sister's camper number on the remaining child**. After that, anything the parent pays or submits for that child is filed under the sibling. The builder's count of "0 places decided by a name" also isn't a reliable measure. It's a text search, and it missed the problems below.

## The numbers
Tests run: 3,410 · Passed: 3,396 · Failed: 14 (real bugs: not yet sorted, all 14 are the auto-scheduler tests you deferred · out-of-date tests: 0 · my machine: 0)

- Unit tests (`npm test`): 3,284 run, 3,270 passed, **14 failed**. These are the same 14 auto-scheduler failures as before (TED-005, deferred).
- Database tests (`npm run test:pg`): 48 of 48 passed, against 83 migrations.
- New roster-key browser test (`npm run test:keys`): 13 of 13.
- Lite + Health browser test (`npm run test:lite`): 9 of 9.
- Smoke (`npm run test:smoke`): 32 of 32.
- 600-camper scale test (`npm run test:scale`): 24 of 24.

These match what the builder said.

## What's wrong (most serious first)

### TED-010 🔴 When a family's list of children changes, the parent portal can give a child their sibling's camper number
- **What a user would see:** A family has Avi (#2) and Moshe (#1). Avi withdraws. The office's normal save updates the family's parent invitation. From then on, the parent portal tells the parent's browser that **Moshe is #2**, Avi's number. Anything the parent does for Moshe goes to Avi's record. That includes a canteen deposit, a form, a pickup request or a photo purchase. The server agrees that the parent "owns" #2, so nothing stops it. The same thing happens when a sibling is added in front of an existing child: the new child gets the older child's number, and the parent can't act for the new child at all.
- **How sure I am:** Confirmed on a scratch database built from all 83 migrations.
- **Proof:**
  - **Cause.** The live `upsert_parent_invite` (`migrations/131_reconnect_on_reprovision.sql:78-84`) rewrites `camper_names` but leaves `person_ids` alone. The stamping trigger (`migrations/232_…sql:141-160`) only fills `person_ids` when it is empty. So the numbers stay in their old positions while the names move.
  - **What I did.** I set up the invite as `camper_names ["Avi Gold","Moshe Gold"]`, `person_ids [2,1]`. Then I re-sent the list without Avi, exactly as the upsert does.
  - **Result.** `person_ids` stayed `[2, 1]`. As the parent, `get_my_camper_ids` returned `{"name":"Moshe Gold","camperId":2}`, and `verify_my_camper(camp,'Moshe Gold',2)` returned **`t`**.
  - **The "sibling added in front" case:** the portal got `{"name":"Avi Gold","camperId":1}` (Moshe's number), and `_parent_owns_person(camp, 2)` (the new child) returned **`f`**.
  - **Why it happens in practice.** The office sends a new list every time the family changes. Unenrolled children are dropped from it (`campistry_me.js`, the invite family builder around line 14168: `!roster[cn].unenrolled`).
  - **Related:** when an invite is first written with no numbers, the server fills them in from the names. For a name held only by a departed child, it picks the **departed child** (`camp_person_by_name`, rank 3). So a new "Avi Katz" whose invite is written before the page adopts his own key "Avi Katz #11" is tied to the departed Avi.
- **What to ask the builder for:** "Fix upsert_parent_invite so person_ids is recalculated position by position whenever camper_names changes. Keep the number for any name that was already on the invite, and decide new names by the roster's camper number, never by camp_person_by_name's departed fallback. Add a pgtest where a sibling withdraws and the remaining child must keep their own number in get_my_camper_ids. Also give the office a repair query that finds invites where person_ids no longer lines up with camper_names."

### TED-011 🟠 The rename bug that 259 "fixes" has been live since 253, and campers it already hit are not repaired or even reported
- **What a user would see:** Any camper renamed since 253 went live was given a **new number**. Their canteen money, forms, health uploads and history stayed on the old number, and the old number is marked "departed". Applying 259 stops it happening again, but it does nothing for the children already affected. The office's new check reports everything as fine.
- **How sure I am:** Confirmed on a scratch database (the chain without 259, then 259 applied on top).
- **Proof:**
  - **Before 259.** "Ayala Weiss" (#1, canteen $50) was renamed "Ayala Weiss-Katz" with an upsert. Result: #1 departed, #2 live, and $50 on #1.
  - **After applying 259.** Unchanged: `camp_canteen_accounts` still showed `person_id 1, balance 50`.
  - **The check.** `verify_roster_keys()` returned `{"unrecorded_keys":0,"keys_shared_before_259":[],"keys_shown_by_the_wrong_child":[]}`, which is all clear. `scripts/verify_identity_chain.sql` has no row for this either.
- **What to ask the builder for:** "Write a read-only report (and then a repair) for campers split by the 253 rename bug: a departed camper and a live camper created at the same moment, with a different key, the same family/parent/birthday. Add it to verify_identity_chain.sql, and tell me before I apply 259 how many of my campers it finds."

### TED-012 🟠 Changing a camper's number leaves their records on the old number, which can then be given to another child
- **What a user would see:** The office types a new Camper ID for Avi on Edit Camper (1 → 7), which the page allows. Avi's records stored in the database tables move to #7. His records inside the saved documents do not: medication logs, sick visits, luggage, shop orders and so on stay under #1. Number 1 now belongs to nobody. If the office later gives #1 to a new child (Dina), **Avi's medication history appears as Dina's**. The pages match records by number first, so Avi also loses his own history from his screen straight away. This breaks your rule that a number is never re-used while the child's data exists.
- **How sure I am:** Confirmed on a scratch database.
- **Proof:**
  - **Setup.** Avi #1 had a health upload and a canteen account in the tables, and a `health` document holding `{"camperName":"Avi Katz","camperId":1,"med":"Tylenol"}`. The roster was then saved with Avi as #7.
  - **Tables moved.** The upload and the canteen account moved to #7.
  - **The document did not move.** It still said `"camperId": 1`.
  - **Re-use.** I saved a new child `"Dina Roth","camperId":1`, and the server accepted it. The Tylenol log now carries Dina's number.
  - **Nothing notices.** `verify_roster_keys()` still reported all clear.
- **What to ask the builder for:** "When a camper's number changes, rewrite camperId inside every saved document, or refuse the change. And never accept a number that saved documents still carry for someone else. Add a pgtest: renumber Avi 1→7, then give #1 to Dina, and no record of Avi's may end up carrying Dina's number."

### TED-013 🟠 Re-importing the same campers with the spreadsheet's "Replace" option gives every returning child a new number
- **What a user would see:** The office re-uploads its roster spreadsheet with **Replace** (the "clean house" option), and the file has no Camper ID column. Every returning child comes back as a **new camper**, with a new number and an internal key like "Avi Katz #7". Their canteen balance, forms and history stay on their old, now "departed", number. The screens show the plain name, so nobody notices until money or a form goes missing.
- **How sure I am:** The server side is confirmed. That the page's two saves arrive in this order is likely, from reading the code.
- **Proof:**
  - **The page.** Replace mode empties the roster and saves that to the cloud first (`campistry_me.js` `importRows`: `g.app1.camperRoster={}`, then `saveGlobalSettings('app1',…)`). It then gives rows without an ID `nextPersonId` (around line 22276).
  - **The server.** On the scratch database, Avi #1 had $40 in canteen. I saved an empty roster, then `{"Avi Katz":{"camperId":7}}`. The result was `{"Avi Katz #7":{"camperId":7,"displayName":"Avi Katz"}}`, with #1 departed and still holding $40.
  - **If the two saves merge into one**, the child is renumbered instead (see TED-012).
  - **With the ID column** (`camperId: 1`), the child correctly got his own number back.
- **What to ask the builder for:** "In CSV Replace, match returning children to their existing camper numbers before wiping (same name + same parent email or birthday), or refuse Replace without an ID column when campers already have numbers. Add a browser test that re-imports the same file with Replace and checks every child keeps their number."

### TED-014 🟠 The nurse's sick-visit and medication forms decide the child by whatever name is typed
- **What a user would see:** Two children are both called Avi Katz. The nurse types "Avi Katz" into the Health page's sick-visit or medication form and presses Save without clicking a suggestion. The visit or dose is recorded against **whichever Avi holds the plain name**, which may be the wrong child. If she does click the suggestion, the box shows the internal key "Avi Katz #11" to her.
- **How sure I am:** Confirmed in the code. I didn't click through it in a browser.
- **Proof:** `campistry_health.js:470-481` (sick visit) and `:491-495` (medication) save `camperId: camperIdOf(inp.value.trim())`, a roster lookup of the typed text. The suggestion list puts the raw key into the box (`:641`, `input.value=n`). The builder's inventory counts these as "carries a number", because the word `camperId` is on the line.
- **What to ask the builder for:** "In Health's sick-visit and medication forms, record the camper the nurse picked (keep their number from the suggestion) and refuse free-typed names that aren't picked. Show the plain name in the box, never the '#11' key. Check Lite, Snacks POS, Go and Live search boxes for the same pattern."

### TED-015 🟡 The "0 places decided by a name" figure is a text search, not a proof
- **What a user would see:** Nothing directly. It matters because it's the figure you're being asked to trust.
- **How sure I am:** Confirmed.
- **Proof:**
  - **Part A only finds lines with `camperName:` and no `camperId` within three lines** (`scripts/camper_name_inventory.js`, `KINDS[0]`). TED-014 passes that test and is still decided by a typed name.
  - **One exemption is mislabelled.** The Me line that decides which children still owe a required form (`campistry_me.js:21496`, `completed.has(name)`) is marked `// name-ok: the words of an email`, but it's a comparison that decides who gets a reminder.
  - **Part B doesn't count comparisons on the `camper` field.** At least 8 such lines are missing (parent portal 3341, 4634, 5429; Me 15122, 17898; Snacks 788; and others).
  - **The totals.** The regenerated document says B = **320**, not the 324 in the builder's summary.
  - **How the count got to 0.** Of last round's 589 places, about 265 really changed: 95 records, 130 edge-function lines, and about 40 others. The other ~310 (family lists, bunk lists and roster lookups) were moved from "by name" to "by roster key" because of 259's rule. That move is only honest if the rule has no holes, and TED-010 to TED-013 are holes in it.
- **What to ask the builder for:** "Treat the inventory as a to-do list, not a proof: count `.camper ===` comparisons in part B, remove the name-ok mark from the form-reminder line, and don't describe part A as zero until TED-010 to TED-014 are closed."

### TED-002 🟡 (still open) The move to camper numbers is not finished
- Narrowed. Part A is 0 by the builder's own measure, and part B is 320 roster-key places. The real remaining work is TED-010 to TED-015 above.

### TED-005 🟠 (still open, deferred by you) 14 auto-scheduler tests still fail
- The same 14 (`auto_full_day.test.js`). I didn't investigate them, as you asked.

## What I confirmed is working
- **TED-008 is fixed (closed).** On the scratch database, departed "Avi Katz" #10 and a new Avi, who got his own key "Avi Katz #892", with a parent linked only to #892: `verify_my_camper(camp,'Avi Katz',10)` = **f** and `(…, 892)` = **t**. 257 now includes `verify_my_camper` in its pin rewrite (`migrations/257_…sql:172`).
- **TED-009 is fixed (closed).** Me → Billing strips the "#number" in all four places I named (family list, detail, report, CSV: `.map(_lbl)` in the diff), and so do bill-line notes (`campistry_billing_core.js:355-360`). The browser test opens Me → Billing with two Rivka Sterns and finds no "#702" (`test:lite`, 9/9).
- **A new child whose name belongs to a departed child gets their own key.** "Avi Katz" became "Avi Katz #892", shown as "Avi Katz" (scratch database, separate saves, not one big transaction).
- **The 253 rename bug is real and 259 stops new cases.** I reproduced it without 259 (#1 departed and #2 created on rename). 259's test covers the upsert path.
- **A spreadsheet re-import that carries the ID column keeps each child's number** (scratch database).
- **Edge functions decide by the number when one is sent.** For example, `stripe-checkout` turns the number into the child's key through `camp_person_label` and only uses the name when there is no number (`index.ts:108-124`). The one place that sends a display name to the card processor (`payments-hosted-link:154`, `custom3`) is never read back.
- **`supabase_data_layer.js` (947 lines) was deleted.** Nothing in the project loads it.

## What I did NOT check (and why)
- **The live database.** I didn't connect to it. So I can't say how many of your campers were already split by the rename bug (TED-011) or how many invitations are already misaligned (TED-010).
- **The real `upsert_parent_invite` function on the scratch database.** The test chain doesn't include it. I read the live version (131) and ran its exact UPDATE by hand.
- **Whether Replace mode's two saves reach the cloud separately** (TED-013). I proved what the server does with each order, not the order itself.
- **Clicking through the Health forms in a browser** (TED-014): proven from the code only.
- **Two office tabs saving the roster at the same moment**, and Lite working offline then syncing. The key rule's behaviour with an out-of-date tab wasn't tested.
- **Bank-deposit matching.** It decides the family by memo code, parent names and aliases, not the camper. I didn't audit it.
- **Real card charges, a real parent login, a real phone.**

## Things only you can check (click-by-click)
1. **Don't apply 259 yet.** Ask the builder for the TED-011 report first, so you know how many campers were already split. 255-258 can go in now, in order: Supabase Dashboard → SQL Editor → New query → paste the file → Run.
2. **Look for TED-010 in your own data (read only):** Supabase Dashboard → SQL Editor → New query → paste `SELECT parent_email, camper_names, person_ids FROM link_parent_invites WHERE status='active' AND jsonb_typeof(person_ids)='array' AND jsonb_typeof(camper_names)='array' AND jsonb_array_length(person_ids) <> jsonb_array_length(camper_names);` → Run. Every row returned is a family whose numbers no longer line up with their children. Send the count to the builder. This only catches lists of different lengths. A family whose children were re-ordered won't show up here, which is why the builder needs to write the full repair check.
3. **Until TED-013 is fixed, don't use "Replace"** when re-uploading the camper spreadsheet unless the file has a Camper ID column filled in.
4. **Until TED-012 is fixed, don't change a camper's ID number** on Edit Camper, and don't give an old number to a new child.
5. **Nurses:** until TED-014 is fixed, ask them to always click the suggested name in Health's forms instead of typing it and pressing Save.
