# Session Planning (Sandbox) — Test Plan

Hand this file to Claude: **"Read `SANDBOX_TEST_PLAN.md` and walk me through it."**

It tests two things that ship together:

1. **Session planning** — a named copy of the camp's operational state you build
   ahead of time, then make official on the day.
2. **Session-aware campers** — a plan for 2nd Half shows 2nd Half's children, not
   whoever is at camp today.

---

## How to read this file

Every check is written as **Do / Expect / If it fails**. The "if it fails" line
names the file to look in, so a failure is a starting point rather than a dead
end.

**Report honestly.** If a step can't be done, say which and why rather than
marking it passed. A partial pass with the gap named is worth more than a clean
sheet that isn't true.

**Two things that are not bugs:**

- **Live shows no bar and no banner.** That's deliberate — a camp that never uses
  this feature must not be able to tell it exists. Absence of UI in live is a
  pass, not a missing feature.
- **A plan that can't resolve a date shows *today's* campers.** Not a failure.
  The rule is: when we can't tell, show everyone. A missing child on a bunk list
  is a child nobody counts at pickup; a spare name is one somebody crosses off.

---

## Step 0 — Prerequisites (nothing works without these)

### 0a. Run the migration

The code is pushed; the database function is not. Until this is done the card
either shows an amber "Not switched on yet" notice or nothing at all.

1. Open the **Supabase Dashboard → SQL Editor → New query**.
2. Paste the **entire** contents of `migrations/193_session_workspaces.sql`.
3. Run it. It's idempotent — safe to run twice.

> Only 193. `194_one_complete_card_capture.sql` is a different, unrelated change.

Verify it took:

```sql
select proname from pg_proc
 where proname in ('create_workspace','promote_workspace','list_workspaces',
                   'select_workspace','delete_workspace','workspace_key',
                   'parse_workspace_key','workspace_operational_keys')
 order by proname;
```

**Expect 8 rows.** Fewer means the paste was truncated — re-run the whole file.

### 0b. Give your sessions dates

**This is the step most likely to be missed, and almost everything below depends
on it.** A session with no dates cannot move the as-of date, so every camper
check silently falls back to "today" and looks like a bug.

On the **Me** page, each session needs a **name, a start date and an end date**.
Two that don't overlap, e.g. `1st Half 2026-06-28 → 2026-07-24` and
`2nd Half 2026-07-26 → 2026-08-21`.

### 0c. Have campers on each side

You need at least:

- one camper enrolled in **1st Half only**
- one camper enrolled in **2nd Half only**
- ideally one enrolled in **both**

Write their names down — the checks below refer to them as **ONE**, **TWO** and
**BOTH**.

### 0d. Hard-reload

`Cmd/Ctrl + Shift + R`. The script versions were bumped, but an old tab will
still be running the old files.

---

## Step 1 — The card appears, and only for the right people

| | |
|---|---|
| **Do** | Open **dashboard.html** as the camp owner. Find the **Session Planning** card. |
| **Expect** | The card is visible, with a **"Start planning a session"** button (or a list of plans if any exist). |
| **If it fails** | Amber "Not switched on yet" notice → Step 0a didn't take. Card missing entirely → `campistry_workspace_admin.js`, `A.render()`; check the browser console for a `list_workspaces` error. |

| | |
|---|---|
| **Do** | Log in as a **scheduler** (not the owner) and open the dashboard. |
| **Expect** | They can *see* the card and which plan they're in, but there is **no** "New Plan", "Make official" or "Delete" button. |
| **If it fails** | `canManage` in `campistry_workspace_admin.js`. Note that the buttons are only *hidden* — the real check is server-side in `_workspace_is_owner`, which Step 7 tests. |

---

## Step 2 — Creating a plan

| | |
|---|---|
| **Do** | Click **Start planning a session**. |
| **Expect** | An in-app modal (not a browser `prompt` box) with a name field **and** a "This plan is for" dropdown listing your sessions with their dates. |
| **If it fails** | Browser prompt appearing → stale cached JS, re-do Step 0d. Dropdown empty or sessions greyed out → Step 0b; a session with no dates is deliberately shown disabled. |

| | |
|---|---|
| **Do** | Name it `2nd Half Draft` — deliberately **not** the session's exact name — and pick **2nd Half** in the dropdown. Create it. |
| **Expect** | A message like *"2nd Half Draft created — N things copied, showing 2nd Half's campers."* The plan appears in the list with a sub-line reading **"2nd Half's campers"**. |
| **If it fails** | `A.newSandbox` in `campistry_workspace_admin.js`. The mismatched name is the point: the session link used to be guessed from the label, so an exact-match name would hide the bug. |

Verify the copy happened server-side:

```sql
-- Your plan, and the session it is tied to.
select id, label, session, status, created_at
  from camp_workspaces
 where camp_id = '<YOUR CAMP UUID>';

-- What got copied. Keys are prefixed 'ws:<id>/'.
select key from camp_state_kv
 where camp_id = '<YOUR CAMP UUID>'
   and key like 'ws:%'
 order by key;
```

**Expect** `session` = `2nd Half` (not `2nd Half Draft`), and prefixed copies of
the operational keys: `app1`, `campStructure`, `bunkMetaData`, `fields`,
`campPeriods`, `campistryGo`, rotation history, league setup.

**Critically — expect NO prefixed copy of any of these:**

```sql
select key from camp_state_kv
 where camp_id = '<YOUR CAMP UUID>'
   and key ~ '^ws:.*/(campistryMe|campistryMeFinance|campistryMePayroll|campistrySnacks|campistryShop|campistryLink)$';
```

**Expect 0 rows.** Campers, families, the ledger, payroll and till balances are
never copied — there is no such thing as a draft payment. **Any row here is the
most serious failure in this plan.** Stop and report it.

---

## Step 3 — You always know where you are

| | |
|---|---|
| **Do** | Click **Open** on the plan. |
| **Expect** | The page reloads. A full-width **amber/brown striped bar** is pinned to the top of *every* page, reading `PLANNING: 2ND HALF DRAFT`, a chip reading **"Campers: 2nd Half"**, a session dropdown and a button back to live. The page content is pushed down, not hidden behind it. |
| **If it fails** | `campistry_workspace_ui.js`, `render()`. Content hidden behind the bar → the measured `bar.offsetHeight` / `padding-top`. |

| | |
|---|---|
| **Do** | While in the plan, navigate to **flow**, **Me**, **Live** and **Go**. |
| **Expect** | The bar is on every one of them, with the same text. |
| **If it fails** | That page is missing `campistry_workspace_ui.js`. The bar self-mounts, so there is nothing a page can forget to call — only a missing script tag. |

| | |
|---|---|
| **Do** | Click the button back to **Live camp**. |
| **Expect** | Reload, and the bar is **completely gone** — no bar, no leftover gap at the top. |
| **If it fails** | The `removeProperty` calls in `render()`. |

---

## Step 4 — The plan is a real copy (the isolation test)

This is the core promise. Do it carefully.

| | |
|---|---|
| **Do** | In **live**, note a bunk's name and its campers. Switch into the plan. Rename that bunk, add a new bunk, move a camper between bunks. |
| **Expect** | The edits save (watch the sync indicator). |

| | |
|---|---|
| **Do** | Switch back to **live** and look at that bunk. |
| **Expect** | **Live is completely untouched** — original name, original campers, no extra bunk. |
| **If it fails** | This is the feature's central failure. `campistry_workspace.js` (`keyFor`) and the write path in `integration_hooks.js`. Report immediately. |

| | |
|---|---|
| **Do** | Switch into the plan again. |
| **Expect** | Your planned edits are all still there. |
| **If it fails** | The plan is being read from the wrong key — `wsKey()` in `integration_hooks.js`, or `campistry_cloud_bootstrap.js` on the read path. |

| | |
|---|---|
| **Do** | In the plan, open the **Me** page and try to edit something financial — post a charge, or change a payment setting. |
| **Expect** | It is **refused**, with a message that it's live-only. It must not silently save, and must not silently save *to live* either. |
| **If it fails** | `canWrite` in `campistry_workspace.js` and the refusal path in `integration_hooks.js`. Silently routing a sandbox edit to live is behaviour indistinguishable from a bug, which is why it refuses instead. |

---

## Step 5 — The campers are the right ones

This is the part you specifically asked for.

| | |
|---|---|
| **Do** | In **live**, during 1st Half, open **Me → Roster → Enrolled**. |
| **Expect** | A **"Showing"** dropdown offering *In camp today · 1st Half · 2nd Half · Everyone enrolled*, defaulting to **In camp today**. **ONE** (1st Half) is listed; **TWO** (2nd Half) is not; a note says how many are hidden. |
| **If it fails** | No dropdown at all → Step 0b. If you see an amber "give your sessions start and end dates" note instead, that's the picker correctly telling you Step 0b is incomplete. |

| | |
|---|---|
| **Do** | Switch into the **2nd Half** plan. Open **Me → Roster**. |
| **Expect** | The "Showing" picker has **opened on 2nd Half by itself**. **TWO** is listed, **ONE** is not, **BOTH** is. |
| **If it fails** | `_rosterWhenDefault()` in `campistry_me.js`, and `P.asOfInfo()` in `campistry_presence.js`. |

| | |
|---|---|
| **Do** | Still in the plan, change the picker to **In camp today**. |
| **Expect** | It obeys you and shows today's campers. An explicit choice must beat the plan's default. |
| **If it fails** | `_rosterWhenTouched` in `campistry_me.js`. |

Now the same question everywhere else. **In the plan**, check each of these shows
**TWO and BOTH but not ONE**:

- **flow** — the bunk lists used for generating
- **Live** — roll call / head count
- **Health** — the medication and allergy sheet
- **Snacks** — the till's camper list
- **Print** — a printed bunk roster

| | |
|---|---|
| **If any of them fails** | That page's camper enumeration isn't going through `CampistryPresence`. Check the page loads both `campistry_enrollment_window.js` and `campistry_presence.js`, and that its roster read is filtered. |

The reverse direction, which is the "look back" case:

| | |
|---|---|
| **Do** | Make a plan tied to **1st Half** and open it. |
| **Expect** | **ONE** and **BOTH** are listed, **TWO** is not — even though today is in the middle of 1st Half or later. |

And the fallback:

| | |
|---|---|
| **Do** | Make a plan with the dropdown set to **"Not tied to a session"**. Open it. |
| **Expect** | The bar shows **no** "Campers:" chip, and every list shows **today's** campers. This is correct, not a bug. |

### Go, specifically

Go is currently behind a **maintenance overlay** (`#go-coming-soon` in
`campistry_go.html`). To test Go's camper lists you must temporarily remove that
block — and put it back afterwards. If you'd rather not, **say so and skip this
section** rather than reporting it as passed.

| | |
|---|---|
| **Do** | In the 2nd Half plan, open **Go → Addresses**, and build a route. |
| **Expect** | Only **TWO** and **BOTH** appear. Bus routes you build here are part of the plan and don't touch live's routes. |
| **If it fails** | `_presentOnly` / `getRoster()` in `campistry_go.js`. |

| | |
|---|---|
| **Do** | Turn on Go's **standalone mode** and import a CSV roster. |
| **Expect** | **Every** imported name appears — standalone is deliberately its own world, with no enrollments behind it to be absent from. |
| **If it fails** | The standalone branch of `getRoster()` is being filtered when it shouldn't be. |

---

## Step 6 — Making it official

Do this **last**. It changes what live is.

| | |
|---|---|
| **Do** | As the owner, click **Make official** on the 2nd Half plan. |
| **Expect** | **One** in-app modal that states what will happen, says the current session is kept, says campers/families/payments are unaffected, **and** contains the "type MAKE OFFICIAL" box — all on screen together. The confirm button stays disabled until you type it correctly. |
| **If it fails** | `A.promote` and `_dialog` in `campistry_workspace_admin.js`. Three stacked browser dialogs → stale cache, Step 0d. |

| | |
|---|---|
| **Do** | Type it, name the outgoing session (e.g. `1st Half 2026`), and confirm. |
| **Expect** | Reload. **The bar is gone** — you are in live. Live now shows the bunks, routes and periods you planned. The old live state is listed as a **past session** you can open. |
| **If it fails** | `promote_workspace` in the migration. Check the SQL below before concluding anything. |

```sql
-- After promotion: the promoted plan is gone from the registry, and the
-- outgoing session is there as 'archived'.
select id, label, session, status, promoted_at, retired_at
  from camp_workspaces
 where camp_id = '<YOUR CAMP UUID>'
 order by created_at;

-- The bare keys are now the plan's. No 'ws:<promoted id>/' keys should remain.
select key from camp_state_kv
 where camp_id = '<YOUR CAMP UUID>' and key like 'ws:%'
 order by key;
```

| | |
|---|---|
| **Do** | Open the archived past session. |
| **Expect** | The bar comes back naming it, and it shows the **old** bunks and routes — your 1st Half setup, intact. |

| | |
|---|---|
| **Do** | Check the money. Open **Me → Billing** in live. |
| **Expect** | Every balance, charge and payment is **exactly** as it was before the promotion. |
| **If it fails** | Stop and report immediately. Promotion must not be able to touch money. |

---

## Step 7 — The things most likely to be broken

These are the edge cases worth deliberately trying.

| | |
|---|---|
| **Do** | Open the same plan in **two browser tabs**. In tab 1, switch to live. Then use tab 2 (still showing the plan's bar) to edit a bunk. |
| **Expect** | Tab 2 notices it's been moved to live on its next refresh and follows, rather than continuing to write to a plan the server no longer has it in. |
| **If it fails** | `U.refresh` in `campistry_workspace_ui.js` — the server's answer is meant to win. |

| | |
|---|---|
| **Do** | Be in a plan, then **delete that plan** from another tab. Go back to the first tab and try to edit. |
| **Expect** | It should not write to keys nothing owns any more. |

| | |
|---|---|
| **Do** | As a **scheduler** (not owner), open the browser console in a plan and call `promote_workspace` directly. |
| **Expect** | `not_owner`. Hiding the buttons is a convenience; this is the actual check. |
| **If it fails** | `_workspace_is_owner` in the migration. Serious — report it. |

| | |
|---|---|
| **Do** | Try to create a plan named exactly `live`. |
| **Expect** | **Accepted**, but stored under the id `ws_live`, not `live`. `live` is the *absence* of a prefix, so the id must not collide — but the label is harmless. Confirm with `select id, label from camp_workspaces` → `ws_live` / `live`. |
| **If it fails** | If the id comes back as literally `live`, that's serious: report it. |

| | |
|---|---|
| **Do** | Create a plan, then create another with the **same name**. |
| **Expect** | *"A plan called that already exists."* |

| | |
|---|---|
| **Do** | Point a plan at a session, then go to **Me** and **change that session's dates**. Return to the plan. |
| **Expect** | The camper list follows the new dates. |
| **If it fails** | The `asOf` memo isn't being dropped — `P.refresh()` in `campistry_presence.js`. |

| | |
|---|---|
| **Do** | In a plan, **generate a schedule**. Then switch to live and open the rotation/fairness report. |
| **Expect** | Live's rotation counts are **unchanged**. Generating writes rotation history as a side effect, which is why that history is sandboxed. |
| **If it fails** | The rotation keys in `OPERATIONAL` in `campistry_workspace.js`. |

### The fresh-browser case — test this one carefully

This found a real bug, now fixed. It's the most valuable check in this file.

| | |
|---|---|
| **Do** | While in a plan, **close the browser entirely** (not just the tab). Reopen it and go to the dashboard. Watch what happens for the first few seconds. |
| **Expect** | You end up **back in the plan**, with the bar. The page may reload itself once on the way — that is the fix working, not a glitch. |
| **If it fails** | The failure to look for is specific and quiet: **the plan's bar sitting on top of live's data.** If the bar says `PLANNING: …` but the bunks and routes on screen are live's, that's the bug. `U.refresh` in `campistry_workspace_ui.js`. |

Why: the selection is stored **per user on the server**, so it outlives the
browser — but a tab reads it from `sessionStorage`, which a fresh browser hasn't
got. So the page used to boot on **live's** keys and then get the plan's bar
drawn over it, and a save from that page would have written live's bunks into the
plan. It now reloads once so the data matches the label.

**Verify it did not just loop:** the page should reload **exactly once**, not
repeatedly. If it reload-loops, say so immediately.

| | |
|---|---|
| **Do** | Repeat the above in a **private/incognito window**, where site data may be blocked. |
| **Expect** | No reload loop. You may get a toast saying you're seeing the wrong session's data and should reload — that's the deliberate degraded path, not a failure. |

> **A design question for you, not a test.** Coming back into the plan you left
> is one reasonable behaviour; landing in live every time is the other. Right now
> it returns you to the plan, and the bar is what stops you mistaking it for
> live. If you'd rather a fresh browser always started in live, say so — it's a
> small change to `select_workspace`.

---

## What to report back

For each step: **pass**, **fail**, or **skipped (why)**.

For any failure, the useful details are:

- what you did, what you expected, what happened
- anything in the **browser console**
- the output of the relevant **SQL** above
- whether a **hard reload** changes it (that means caching, not logic)

Flag these as **serious**, above anything else:

1. Any `ws:` prefixed copy of `campistryMe`, finance, payroll, snacks or shop.
2. A plan edit that changes live, or a live edit that changes a plan.
3. Any change to a balance or payment after a promotion.
4. A non-owner successfully promoting or deleting a plan.
