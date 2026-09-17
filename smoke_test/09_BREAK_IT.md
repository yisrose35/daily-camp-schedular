# Part 9 — Break it

The adversarial suite. Everything here is designed to **find a failure**, not to
confirm a success. If a card in this part passes, that is genuine information.

Run it last, on the throwaway camp, after Parts 0–8 have left real data behind.
Several cards are destructive; each says so.

**How to report:** for every card, write the ID, what you did, what you expected,
what actually happened, and the console + network evidence. "Seems fine" is not a
result — say what you observed.

---

## 9.1 — Scale

#### BRK-01 — 2,000 campers

| | |
|---|---|
| **Do** | Import a CSV with 2,000 campers across 8 divisions and 60 bunks. Then walk: Roster (page through), Bunk Builder, the bunk generator, Billing, Analytics, a print sheet, a report, Link's audience count, Snacks accounts, the register camper list. |
| **Measure** | Time each one. Note memory (DevTools → Performance monitor). |
| **Expect** | Everything completes. Flag anything over **5 seconds**, anything that freezes the tab, and anything that silently truncates (a list that stops at 500 without saying so). |
| **Sev** | S2 |

#### BRK-02 — A long ledger

| | |
|---|---|
| **Do** | On one family, create 300 charges and 300 payments (script it in the console against the throwaway camp). Open their detail page, print a statement, print a tax statement. |
| **Expect** | It renders and the arithmetic is still right. Note the time. |
| **Sev** | S2 |

#### BRK-03 — A huge blob

| | |
|---|---|
| **Do** | After BRK-01 and BRK-02, measure `campistryMe`. |
| **Verify** | `select pg_column_size(value), length(value::text) from camp_state_kv where key='campistryMe' and camp_id='<UUID>';` |
| **Expect** | It still saves. Report the size — this is one row rewritten on every keystroke-triggered save, so this number is the app's ceiling. |
| **Sev** | S2 |

#### BRK-04 — 300 photos and 500 transactions

| | |
|---|---|
| **Do** | Upload 300 photos to Link. Ring up 500 POS transactions. |
| **Expect** | The face worker pool does not lock the tab; the Snacks dashboard still renders; the transaction list pages. |
| **Sev** | S2 |

---

## 9.2 — Concurrency and races

Each of these needs two browsers (or a browser plus a private window) side by
side. Do the two actions **at the same moment**, not one after the other.

#### BRK-05 ★ — The last seat

| | |
|---|---|
| **Do** | One seat left in a session. Accept two different applications simultaneously. |
| **Expect** | One succeeds, one is refused. |
| **Sev** | S1 |

#### BRK-06 ★ — The last unit of stock

| | |
|---|---|
| **Do** | Shop variant with stock 1. Two parents order it simultaneously. |
| **Expect** | One order, or an explicit backorder. |
| **Sev** | S1 |

#### BRK-07 ★ — Two registers, one limit

| | |
|---|---|
| **Do** | SN-P-06. Both registers charge the same camper past their cap at once. |
| **Expect** | One refused by the row lock. |
| **Sev** | S1 |

#### BRK-08 ★ — Cash out vs POS sale

| | |
|---|---|
| **Do** | Open the cash-out modal for a camper with exactly $20. On another device, sell them $15 of snacks. Now submit a $20 cash out. |
| **Expect** | Re-validated at write time and refused — the modal's number was stale. |
| **Sev** | S1 |

#### BRK-09 ★ — Refund vs sale

| | |
|---|---|
| **Do** | Open Refund All. On another device, make a sale. Commit the refund. |
| **Expect** | The refund reflects the true balance, or refuses. |
| **Sev** | S1 |

#### BRK-10 ★ — The form builder clobber

| | |
|---|---|
| **Do** | Open the registration form builder in Tab A and leave it. In Tab B, add three campers. Now save the form config in Tab A. |
| **Expect** | The three campers survive — form config lives inside `campistryMe` alongside the roster. |
| **Sev** | S1 |

#### BRK-11 ★ — Autopay vs a stale tab

| | |
|---|---|
| **Do** | Simulate the documented failure: with Me open, have a server-side function write a payment into `finance` (take a payment from the parent portal). Then save from the stale tab. |
| **Expect** | The finance merge restores it and logs that it did. |
| **Sev** | S1 |

#### BRK-12 ★ — Two payments at once

| | |
|---|---|
| **Do** | The office records a $100 payment in Me while the parent pays $100 in the portal, simultaneously, on the same family. |
| **Expect** | Both land. The balance drops by exactly $200. Neither is lost. |
| **Sev** | S1 |

#### BRK-13 — Two admins, one message

| | |
|---|---|
| **Do** | Two admins reply to the same parent message at the same moment. Then one deletes it while the other is typing. |
| **Expect** | No lost reply, no crash. |
| **Sev** | S2 |

#### BRK-14 — Scheduled broadcast vs cancel

| | |
|---|---|
| **Do** | Schedule a broadcast for 60 seconds out. Cancel it at the 55-second mark. |
| **Expect** | Either cleanly cancelled or cleanly sent — never sent **and** shown as cancelled. |
| **Sev** | S2 |

#### BRK-15 — Enroll and delete at once

| | |
|---|---|
| **Do** | Enroll a camper in Tab A while deleting the same application in Tab B. |
| **Expect** | One coherent outcome. Not a roster camper with no enrollment and a ledger charge nobody can see. |
| **Sev** | S1 |

---

## 9.3 — Identity and collisions

#### BRK-16 ★ — Three campers, one name

| | |
|---|---|
| **Do** | Create three campers all called `Malky Stein`, in three different bunks. Give each a different canteen balance and a different family. Then rename one. Then delete one. Then run a report and a print sheet. |
| **Expect** | Three distinct records throughout. Money never crosses. Exports distinguish them. |
| **Sev** | S1 |

#### BRK-17 — Name that looks like a key

| | |
|---|---|
| **Do** | Create a camper literally named `Malky Stein #102` (matching the disambiguation format). |
| **Expect** | Handled — either refused or given its own distinct key. It must not collide with the generated key of a real duplicate. |
| **Sev** | S1 |

#### BRK-18 — One parent email, two families

| | |
|---|---|
| **Do** | Two unrelated families share one parent email. Run Sync Parent Portals. Sign in as that parent. |
| **Expect** | State exactly which children appear. Anything beyond their own is S1. |
| **Sev** | S1 |

#### BRK-19 — Same person as staff and camper

| | |
|---|---|
| **Do** | A former camper is now a counselor with the same name. Confirm the person link. Then check payroll, tips, the roster and the canteen. |
| **Expect** | One person, two roles, no crossed money. |
| **Sev** | S1 |

#### BRK-20 — Whitespace and case

| | |
|---|---|
| **Do** | Create `avi klein`, `Avi Klein`, `Avi  Klein` (two spaces) and ` Avi Klein `. |
| **Expect** | Documented behaviour. Trailing spaces trimmed. Case treated consistently between the roster, the canteen and Link's audiences — a camper who is one person in Me and two in Snacks is S1. |
| **Sev** | S1 |

---

## 9.4 — Hostile input

Run this string set through **every** free-text field you can reach: camper name,
bunk name, division name, note, message body, item name, category, list item,
form question, report name, print-sheet header, tip note, cash-out reason.

```
<script>alert(document.domain)</script>
<img src=x onerror=alert(1)>
<svg/onload=alert(1)>
"><iframe src=javascript:alert(1)>
{{child_name}}
${7*7}
=HYPERLINK("http://evil","click")
+1234
'); DROP TABLE camps;--
../../etc/passwd
%00
👨‍👩‍👧‍👦🏴󠁧󠁢󠁳󠁣󠁴󠁿
اختبار عربي
"'`;\
(a 5,000-character string)
```

#### BRK-21 ★ — Stored XSS sweep

| | |
|---|---|
| **Do** | Put the script payloads into every field above, then view each one **everywhere it is displayed** — including the Link admin inbox, the parent portal, the register, print output, PDFs and CSV exports. |
| **Expect** | Rendered as literal text every time. Nothing executes. |
| **If it fails** | `esc` (`campistry_me.js:975`), `_escHtml`, `_sanitizeRichHtml` (9265), `campistry_security.js`. |
| **Sev** | S1 |

#### BRK-22 ★ — CSV / formula injection

| | |
|---|---|
| **Do** | Put `=HYPERLINK(...)`, `+1234`, `-1+1` and `@SUM(1)` into names and notes. Export every CSV and XLSX in all three apps. Open each in Excel and in Google Sheets. |
| **Expect** | Literal text. No formula prompt. |
| **Sev** | S1 |

#### BRK-23 — Merge-tag injection

| | |
|---|---|
| **Do** | Name a camper `{{parent_name}}`. Send a broadcast containing `{{child_name}}`. |
| **Expect** | The camper's name is not re-expanded as a tag. One substitution pass, not recursive. |
| **Sev** | S2 |

#### BRK-24 — Length

| | |
|---|---|
| **Do** | 5,000-character values in a name, a bunk name, a message and a list item. |
| **Expect** | Capped with a counter, or stored and displayed without destroying the layout. Never a request that 500s. |
| **Sev** | S3 |

#### BRK-25 — Unicode and direction

| | |
|---|---|
| **Do** | Emoji ZWJ sequences, RTL Hebrew and Arabic, combining characters, and a right-to-left override character in a name. |
| **Expect** | Correct display and sort; the RTL override must not reverse surrounding interface text. |
| **Sev** | S3 |

---

## 9.5 — Money edge cases

#### BRK-26 ★ — Rounding

| | |
|---|---|
| **Do** | A $100 balance split into 3 installments. A 33% sibling discount on $1,000. A 2.9% + 30c card fee on $10.00. A refund of one third of a $10 payment, three times. |
| **Expect** | Every total reconciles to the cent. The third refund of a third must not leave or remove a stray cent. |
| **Sev** | S1 |

#### BRK-27 ★ — Amount parsing

| | |
|---|---|
| **Do** | In every amount field in all three apps enter: `0`, `-1`, `0.001`, `1.005`, `1,234.56`, `$50`, `1e3`, `Infinity`, `NaN`, `--5`, `5.`, `.5`, a very long number, and an empty string. |
| **Expect** | Consistent behaviour across all three apps. `1,234.56` must never be read as `1`. |
| **Sev** | S1 |

#### BRK-28 ★ — The free-money check

| | |
|---|---|
| **Do** | As a parent, try to raise a canteen balance without paying: submit the add-funds flow and abandon the checkout; replay the return URL with `status=success`; call the deposit RPC directly from the console with an arbitrary amount. |
| **Expect** | The balance rises **only** when money was actually taken. This exact hole existed before the real-payments work. |
| **Sev** | S1 |

#### BRK-29 ★ — The debt that must not vanish

| | |
|---|---|
| **Do** | A family owes $500. Now try every way to make it disappear: delete the camper; unenroll; rescind; delete the family; import a CSV without them; remove the payment that created the charge; archive the season. |
| **Expect** | The debt survives all of them, or is explicitly credited with an audit trail. |
| **Sev** | S1 |

#### BRK-30 — Cross-camp money

| | |
|---|---|
| **Do** | With two camps, pay camp A's balance while camp B is the active camp. Add funds to a camper in camp A from a portal switched to camp B. |
| **Expect** | The money lands in camp A only. |
| **Sev** | S1 |

---

## 9.6 — The clock

#### BRK-31 ★ — Midnight

| | |
|---|---|
| **Do** | At 11:58 PM camp time: make a POS sale, take a deposit, submit a pickup request, and let a daily limit reset. Watch across midnight. |
| **Expect** | Everything lands on the correct day, consistently, in the **camp's** timezone. |
| **Sev** | S1 |

#### BRK-32 — Daylight saving

| | |
|---|---|
| **Do** | Set the machine clock to a DST transition (throwaway machine). Open a payroll week that spans it, a schedule, and a scheduled broadcast set for the missing hour. |
| **Expect** | The week still has 7 days. A broadcast scheduled for a non-existent hour fires once, at a sensible time. |
| **Sev** | S2 |

#### BRK-33 — Clock skew

| | |
|---|---|
| **Do** | Set the browser clock 3 hours ahead, then 3 hours behind. Make edits in each state. |
| **Expect** | Server timestamps rule. A skewed client must not win a last-writer-wins merge and erase a newer edit. |
| **Sev** | S1 |

#### BRK-34 — Year boundary

| | |
|---|---|
| **Do** | A tax statement across 31 Dec / 1 Jan. A season archived and a new one started. |
| **Expect** | Payments land in the right tax year. |
| **Sev** | S2 |

---

## 9.7 — Network and session

#### BRK-35 ★ — Offline everything

| | |
|---|---|
| **Do** | Go offline. In each app, make edits, submit forms, ring up sales, send messages. Then reconnect. |
| **Expect** | Either it clearly failed, or it queued and syncs. Never "looks saved, is gone". |
| **Sev** | S1 |

#### BRK-36 — Flaky network

| | |
|---|---|
| **Do** | DevTools → Slow 3G with occasional offline toggles. Do a payment, a POS sale, and a form submission. |
| **Expect** | Retries or a clear failure. Never a duplicate charge. |
| **Sev** | S1 |

#### BRK-37 ★ — Token expiry mid-action

| | |
|---|---|
| **Do** | Sign in, leave the tab for long enough for the access token to expire (or clear the auth token from Application → Local Storage), then submit a long form and take a payment. |
| **Expect** | Refreshed silently, or a clean "please sign in again" that **preserves the typed work**. Not a silent discard. |
| **Sev** | S2 |

#### BRK-38 — Refresh mid-save

| | |
|---|---|
| **Do** | Hit reload during the sync badge's in-flight state, in each app. |
| **Expect** | Either the change landed or it did not — never a half-written blob. |
| **Sev** | S1 |

#### BRK-39 — Disk full / storage quota

| | |
|---|---|
| **Do** | Fill localStorage (`try{for(let i=0;;i++)localStorage.setItem('x'+i,'y'.repeat(100000))}catch(e){console.log(e.name)}`) on a throwaway profile, then use the app. |
| **Expect** | A quota error is caught and the app still works against the cloud. Clear the junk afterwards. |
| **Sev** | S2 |

#### BRK-40 — Two sessions, one account

| | |
|---|---|
| **Do** | Sign in as the same user in three tabs. Sign out in one. |
| **Expect** | The others notice, rather than continuing to write with a dead session. |
| **Sev** | S2 |

---

## 9.8 — Authorisation probes

These are **authorised** probes against your own throwaway camp, from the browser
console. They test that the database — not the interface — is the boundary.

#### BRK-41 ★ — Write to another camp

| | |
|---|---|
| **Do** | As a signed-in staff user of camp A, from the console: `await CampistryDB.getClient().from('camp_state_kv').upsert({camp_id:'<CAMP B UUID>', key:'campistryMe', value:{}})`. |
| **Expect** | Refused by RLS. |
| **Sev** | S1 |

#### BRK-42 ★ — Read a gated key

| | |
|---|---|
| **Do** | As a user whose `me.payroll` is `none`, from the console: `await CampistryDB.getClient().from('camp_state_kv').select('value').eq('key','campistryMePayroll')`. |
| **Expect** | No rows. Migrations 158/160/164 gate it per user. |
| **Sev** | S1 |

#### BRK-43 ★ — Parent RPC with a foreign camp

| | |
|---|---|
| **Do** | From the parent portal console, call `get_my_balance` and the canteen RPCs with another camp's UUID. |
| **Expect** | Refused or empty. |
| **Sev** | S1 |

#### BRK-44 ★ — Anon write to a public form table

| | |
|---|---|
| **Do** | In a signed-out private window, from the console with the anon key, try to write directly into `camp_state_kv`. |
| **Expect** | Refused. Public submissions must go through `submit_public_application`, which creates a record and **cannot replace one** (migration 184). |
| **Sev** | S1 |

#### BRK-45 ★ — The POS shadow account's reach

| | |
|---|---|
| **Do** | Sign in at the register with email + PIN. From that session's console, try to read `campistryMe`, `campistryMePayroll` and another camp's data, and try to write `campistryMe`. |
| **Expect** | Reads limited to what the register needs; writes limited to Snacks. Migrations 099/103/104. |
| **Sev** | S1 |

#### BRK-46 — Guess a token

| | |
|---|---|
| **Do** | Try sequential or guessed values for: a parent invite token, a contract offer id, a post-acceptance form id, a staff tip access code. |
| **Expect** | No hit. Note the entropy of each — a short code with no rate limit is a finding on its own. |
| **Sev** | S1 |

---

## 9.9 — Destructive finale

**Do these last.** They are irreversible on the throwaway camp.

#### BRK-47 — Delete a division that everything depends on

| | |
|---|---|
| **Do** | Delete `Alpha` after it has campers, bunk staff, a schedule, canteen balances, Link lists scoped to its bunks, and a scheduled broadcast targeting it. |
| **Expect** | A clear warning. Afterwards: no ghost bunks anywhere, no crash in Link or Snacks, and the money still reachable. |
| **Sev** | S1 |

#### BRK-48 — CSV over the top

| | |
|---|---|
| **Do** | Import a roster CSV that omits half the camp, on a camp with balances and ledgers. |
| **Expect** | A loud warning first. Afterwards, state precisely what happened to the omitted campers' canteen money and family debts. |
| **Sev** | S1 |

#### BRK-49 — Season close-out

| | |
|---|---|
| **Do** | Run Link's **Delete All Face Data** with the gallery box ticked. |
| **Expect** | Every descriptor and reference photo actually gone from the database, not just hidden. |
| **Verify** | Count the rows. |
| **Sev** | S1 |

#### BRK-50 — Archive the season

| | |
|---|---|
| **Do** | Archive the current season and start fresh. |
| **Expect** | Historical data is retrievable, money history is intact, and the new season starts clean without inheriting balances that should have closed. |
| **If it fails** | `archiveCurrentSeason` (`campistry_me.js:18697`); `TEST_FINDINGS.md` defect D0 was a season-rollover bug. |
| **Sev** | S1 |

---

## 9.10 — What to do with what you find

1. **S1 → stop.** Write it up immediately with reproduction steps and evidence.
   Do not keep testing on that camp.
2. **S2/S3 → log and continue.**
3. For anything involving money, always include: the family, the amounts before
   and after, the ledger rows, and the processor's own record.
4. For anything involving delivery, always include: the intended audience count,
   the reach bar's numbers, and what actually arrived.
5. For anything involving sync, always include: which tabs/devices were open, in
   what order, and the console log lines from `integration_hooks.js`.

Then fill in `smoke_test/10_RESULTS.md`.
