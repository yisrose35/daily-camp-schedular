# Part 7 — Campistry Snacks: canteen, register, shop, offline register

Covers `campistry_snacks.html` (the manager), `campistry_snacks_pos.html` (the
selling console at **snacks.campistry.org**), `campistry_snacks_pos_offline.html`
(the downloadable register), and the Camp Shop that lives inside Snacks.

**Files:** `campistry_snacks.js`, `campistry_snacks_pos.js`, `campistry_snacks_cash.js`,
`campistry_snacks_shop.js`, `campistry_shop_core.js`, `campistry_payments.js`,
`campistry_cloud_bootstrap.js`, `campistry_presence.js`.

**This part moves real money** in the same sense Part 3 does: a canteen balance is
a prepaid balance a camper can draw back out as cash.

---

## 7.0 — The canteen's model, in one paragraph

The canteen is **event-sourced**. An account's balance is always the sum of its
transactions, recomputed on every merge — it is never authoritative on its own.
*A balance edited without a matching transaction is erased by the next merge.* The
ledger joins on `camperId` where it has one, plus any **unidentified** transactions
under the same name (rows written before ids existed). It must never count a
transaction belonging to a **different** id — that is exactly how money used to
move between two children sharing a name.

Everything below is a consequence of that paragraph.

---

## 7.1 — The manager dashboard

#### SN-M-01 ★ CORE — Stats and metrics

| | |
|---|---|
| **Do** | Open Snacks. Read the five stat cards and the eight metric cards. |
| **Expect** | Accounts count matches the roster. Total balance equals the sum of account balances. "Sales Today" and "Cash Out Today" are **today in the camp's timezone**. Sell-through, margin and profit are arithmetically consistent with the inventory. |
| **Verify** | Console: `var s = JSON.parse(localStorage.campGlobalSettings_v1).campistrySnacks; Object.values(s.accounts).reduce((a,b)=>a+(b.balance||0),0)` — compare to the Total Balance tile. |
| **If it fails** | `renderStats` (489), `rAnalytics` (655), `todayStr` (505). |
| **Sev** | S2 |

#### SN-M-02 ★ CORE — Timezone boundary

| | |
|---|---|
| **Do** | Make a sale at 11:50 PM camp time (or shift the machine clock on a throwaway camp). Check "Sales Today" just before and just after midnight, and check whether **spent today** resets. |
| **Expect** | The day boundary follows the **camp's** timezone, not UTC and not the browser's. A sale at 11:59 PM belongs to that day; the daily limit resets at the camp's midnight. |
| **If it fails** | `todayStr` (505) in `campistry_snacks.js` and (213) in the POS, migration 063. |
| **Sev** | S1 — a limit that resets at the wrong hour lets a camper spend twice their cap. |

#### SN-M-03 — Charts and empty states

| | |
|---|---|
| **Do** | Look at Item Popularity, Revenue by Category, Best Margin, Most Profitable, Sales This Week, Top Spenders. Then open Snacks on a camp with zero transactions. |
| **Expect** | Real data; empty camp shows empty states, no `NaN`, no divide-by-zero percentages. |
| **Sev** | S3 |

#### SN-M-04 ★ CORE — Pre-hydration wipe

| | |
|---|---|
| **Do** | Open Snacks on a slow connection (DevTools → Network → Slow 3G) and watch the accounts list during the first two seconds. |
| **Expect** | Accounts must **not** briefly empty and then repopulate, and **nothing may auto-save during that window**. There was a real bug where an empty pre-hydration roster deleted every account as "orphaned" and saved that, wiping inventory counters a register had just written. |
| **Verify** | Console: no save log before `campistry-cloud-hydrated`. `_hydratedOnce` guards this. |
| **If it fails** | `ensureAccountsForRoster` (315), `_hydratedOnce`, `init` (458). |
| **Sev** | S1 |

---

## 7.2 — Accounts

#### SN-M-05 ★ CORE — Accounts mirror the roster

| | |
|---|---|
| **Do** | Add a camper in Me. Reload Snacks. Then delete a camper in Me and reload Snacks. |
| **Expect** | A new account is created with the default daily limit. A deleted camper's account is closed **but its ledger rows survive** — the money is not erased. |
| **Verify** | `G.campistrySnacks.transactions.filter(t => t.camper === '<deleted name>')` → still present. |
| **If it fails** | `ensureAccountsForRoster` (315). |
| **Sev** | S1 |

#### SN-M-06 ★ CORE — Two campers, one name (hazard #2)

| | |
|---|---|
| **Do** | Deposit $20 to the first `Malky Stein`. Check the second's balance. Then delete the first and create a **third** camper with the same name. |
| **Expect** | The second has $0. The third starts at $0 — the closed account is moved aside to its own key, keeps its money, and its pre-`camperId` ledger rows are stamped at that moment so the re-key cannot orphan them. |
| **Verify** | `G.campistrySnacks.accounts` — look for the moved-aside key. Every recent transaction carries a `camperId`. |
| **If it fails** | `_reconcileBalances` (214), `ensureAccountsForRoster` (315), `tests/canteen_identity.test.js`, `TEST_FINDINGS.md` D4. |
| **Sev** | S1 |

#### SN-M-07 ★ CORE — Deposits

| | |
|---|---|
| **Do** | **+ Add Deposit** $25 by cash with a note. Then try: $0; `-10`; `0.005`; `1,250` (with a comma); `1e5`; a blank camper; a payment method the camp has **not** accepted (edit the `<select>` option in DevTools to smuggle one in). |
| **Expect** | Valid deposits post and raise the balance. Zero/negative refused. The smuggled method is refused — "that payment method isn't accepted" — because it is re-validated at write time, not just in the dropdown. **Debit is deliberately never offered.** |
| **Verify** | A matching **transaction** exists, not just a changed balance. A balance without a transaction is erased by the next merge. |
| **If it fails** | `addDep` (1238), `getSettings` (419), `campistry_payments.js`. |
| **Sev** | S1 |

#### SN-M-08 ★ CORE — Cash out

| | |
|---|---|
| **Do** | Take out cash: a normal amount; more than the balance with "allow negative" **off** and then **on**; more than the per-day cash cap; with a reason required but blank; with the reason optional and blank. Use the quick chips and "All". |
| **Expect** | The available amount and "already taken today" are shown before you commit. Over-balance refused when negatives are off. Over-cap refused. A required reason is enforced. **`spentToday` is not touched** — the daily limit caps canteen *spending*, cash out has its own cap. |
| **Verify** | Re-validated at write time: open the modal, then make a POS sale from another device that changes the balance, then submit. It must re-check, not use the stale number. |
| **If it fails** | `cashOut` (1332), `cashPickCamper` (1283), `cashOutLimit` (444), `campistry_snacks_cash.js`, `tests/snacks_cash.test.js`. |
| **Sev** | S1 |

#### SN-M-09 ★ CORE — Refunds

| | |
|---|---|
| **Do** | Refund part of an **online** deposit. Then all of it. Then try to refund a **cash** deposit. Then refund more than was deposited online. Then use **Refund All**. |
| **Expect** | Only online deposits (Stripe `stripePaymentIntentId` or BYOP `byopTransactionId`) appear in the refundable list — a cash deposit has nothing for a gateway to refund and must not be offered. Over-refund refused. Refund All previews the total before committing. |
| **Verify** | The money actually returns on the processor side. Migrations 079/132; `payments-canteen-refund`, `payments-canteen-refund-all`, `stripe-canteen-refund`. |
| **If it fails** | `refundCanteenDeposit` (1492), `_onlineRefundCapacity` (1412), `refundAllCanteenDeposits` (1569), `_getSnacksProcessorKey` (1380). |
| **Sev** | S1 |

#### SN-M-10 — Refund All while a sale is in flight

| | |
|---|---|
| **Do** | Start Refund All, and while the preview is open make a POS sale from another device. Then commit. |
| **Expect** | The refund reflects the true balance at commit time, or refuses and asks you to re-open. Never refunds money the camper has since spent. |
| **Sev** | S1 |

#### SN-M-11 — Set daily limits

| | |
|---|---|
| **Do** | Set a limit for one camper and in bulk. Set `0` (meaning no limit? or no spending? — state which). Set a negative. Set a limit below what the camper already spent today. |
| **Expect** | Documented behaviour for `0`, refusal for negatives, and the below-spent case handled without the register going negative. |
| **If it fails** | `setLimit` (1636). |
| **Sev** | S2 |

#### SN-M-12 — Account history

| | |
|---|---|
| **Do** | Open a camper's transaction history. Filter it. Check a camper with 500 transactions. |
| **Expect** | Sorted newest first, filterable, and the running total equals the balance. |
| **If it fails** | `viewAccountHistory` (553), `_histSortKey` (546), `setHistoryFilter` (566). |
| **Sev** | S2 |

---

## 7.3 — Menu items

#### SN-M-13 — Add, edit, restock, delete

| | |
|---|---|
| **Do** | Add an item with name, category, price, stock and cost. Edit it. Restock `+24`. Then restock `-5`. Delete an item. |
| **Expect** | All work. Stock left blank means unlimited. Negative restock either refused or treated as a correction — say which. |
| **If it fails** | `openAddItem` (1685), `saveItem` (1711), `restock` (1753), `_readStockField` (1678). |
| **Sev** | S2 |

#### SN-M-14 ★ CORE — Delete an item that has been sold

| | |
|---|---|
| **Do** | Sell an item on the register, then delete it from the menu. Open today's transactions. |
| **Expect** | The historical transaction **still shows the item name**. History must not turn into blanks because the catalogue changed. |
| **Sev** | S2 |

#### SN-M-15 — Price and stock abuse

| | |
|---|---|
| **Do** | Price `0`; `-1`; `1.005`; `99999`. Stock `-5`; `0` then sell it; a stock of `1.5`. |
| **Expect** | Negative price refused. Three decimals rounded or refused. Selling at stock 0 is refused or flagged. |
| **Sev** | S2 |

#### SN-M-16 ★ CORE — Upload items

| | |
|---|---|
| **Do** | Download the template, fill it, upload. Then upload: 5,000 rows; duplicate names; a missing price; a price written `$1.50`; a price written `1,50`; a category with emoji; a blank stock cell; a `.csv` with a BOM; an `.xlsx`; a `.txt` renamed `.xlsx`. |
| **Expect** | A preview before import. Blank stock = unlimited. `$1.50` parsed or the row rejected by name — never imported as `0`. Duplicates handled explicitly. Invalid file refused. |
| **If it fails** | `handleUploadFile` (1807), `_processUploadRows` (1824), `confirmUploadImport` (1890), `downloadItemTemplate` (1795). |
| **Sev** | S1 — an item imported at price 0 is free stock all summer. |

---

## 7.4 — Settings

#### SN-M-17 — Deposits & cash defaults

| | |
|---|---|
| **Do** | Set the default daily limit, the per-day cash-out max (`0` = no cap), "cash out needs a reason", and "allow cash out below zero". Save. Reload. |
| **Expect** | Persist, and each one actually changes behaviour in SN-M-07/08. |
| **If it fails** | `rSettings` (814), `saveSettingsForm` (863), `getSettings` (419). |
| **Sev** | S2 |

#### SN-M-18 ★ CORE — The register PIN

| | |
|---|---|
| **Do** | Set a PIN of `4821`. Then try `123` (too short), `123456789` (too long), `abcd`, and blank. |
| **Expect** | 4–8 digits accepted; the rest refused. The status line states whether a PIN is set. |
| **If it fails** | `savePosPin` (953), `loadPosPinStatus` (896), migrations 100–104, `POS_PIN_LOGIN_SETUP.md`. |
| **Sev** | S2 |

#### SN-M-19 ★ CORE — PIN lockout

| | |
|---|---|
| **Do** | At the register, enter a wrong PIN **five** times. Then enter the correct one. Then unlock from Settings and try again. |
| **Expect** | Locked after 5 wrong attempts. **No time-based auto-unlock** — the correct PIN does not work until an owner unlocks it here. |
| **Verify** | `select * from account_lockouts …;` migration 101. |
| **If it fails** | `unlockPosPin` (928), `posPinUnlockBtn`. |
| **Sev** | S2 |

#### SN-M-20 ★ CORE — The PIN is not the account password

| | |
|---|---|
| **Do** | At `snacks.campistry.org`, sign in with the owner's email and the **PIN**. Then try the owner's **real password** in the PIN box. Then take that same session and navigate to `campistry_me.html` and `dashboard.html`. |
| **Expect** | The PIN opens the register only. The real password does **not** work in the PIN box. The register session cannot reach Me, the Dashboard, or anything else — it is a shadow account that can read what it needs and write only Snacks. |
| **Verify** | Migrations 099, 103, 104; `pos-pin-login` edge function. |
| **If it fails** | This is the security boundary of the whole feature. |
| **Sev** | S1 |

#### SN-M-21 — Accepted payment methods

| | |
|---|---|
| **Do** | Tick and untick methods. Confirm debit is not offered. |
| **Expect** | The deposit modal offers exactly the ticked set, and re-validates on submit (SN-M-07). |
| **Sev** | S2 |

#### SN-M-22 — Cash drawer

| | |
|---|---|
| **Do** | Read the Cash Drawer card after several deposits and cash-outs. |
| **Expect** | Today's cash in and out reconcile with the transactions. |
| **Sev** | S2 |

---

## 7.5 — The register (POS)

Open `campistry_snacks_pos.html` — ideally on a tablet, at
`snacks.campistry.org`.

#### SN-P-01 ★ CORE — The login gate fails closed

| | |
|---|---|
| **Do** | Open the register with no session at all. Watch the very first paint. |
| **Expect** | The PIN overlay, with **no flash of the selling console behind it**. The check runs synchronously in `<head>`. |
| **If it fails** | The `pos-locked` block in `campistry_snacks_pos.html`. Note the comment: this one deliberately fails **closed**, unlike the fail-open guards later in the file. |
| **Sev** | S1 |

#### SN-P-02 — Camper panel

| | |
|---|---|
| **Do** | Search a camper by first name, last name, apostrophe name (`O'Brien`), and Hebrew name. Use the **bunk filter** to limit to the bunks at the window. Toggle the drawer on a phone width. |
| **Expect** | Search finds everyone. The bunk filter's choices persist between sessions. |
| **If it fails** | `renderCampers` (296), `renderBunkFilter` (390), `loadSelectedBunks` (232). |
| **Sev** | S2 |

#### SN-P-03 ★ CORE — Who is in the list

| | |
|---|---|
| **Do** | On a day when `Second-Half Only` is not at camp, look for them in the register list. |
| **Expect** | The register shows **today's** campers. A camper who is not here cannot be sold to. |
| **Verify** | `_snacksPresenceGate` (105) / `getCamperList` (110) in `campistry_snacks.js`; the POS's own `getCamperList` (46). |
| **If it fails** | `campistry_presence.js`. |
| **Sev** | S2 |

#### SN-P-04 ★ CORE — A sale

| | |
|---|---|
| **Do** | Pick a camper, tap items (quick-push and all-items), change a quantity, clear one line, clear the cart, then charge. |
| **Expect** | The Charge button always states what is still needed ("Select a camper" / "Add items to charge" / "Charge $4.50 → Avi"). On success: the balance drops, stock decrements, the transaction is logged, the cart clears and focus returns to search. |
| **Verify** | The parent portal's canteen balance drops by the same amount. |
| **If it fails** | `charge` (599), `updateChargeBtn` (580), `renderCart` (549). |
| **Sev** | S1 |

#### SN-P-05 ★ CORE — The daily limit is enforced by the server

| | |
|---|---|
| **Do** | Set a $10 daily limit. Sell $8. Then try to sell $5. Then sell exactly $2. |
| **Expect** | The $5 sale is **blocked** with the remaining amount named. The $2 sale succeeds and brings them exactly to the cap. |
| **Verify** | Network tab: `submit_canteen_purchase` is called and is what refuses. The client pre-check is UX only. Migration 026. |
| **If it fails** | `charge` (599). |
| **Sev** | S1 |

#### SN-P-06 ★ CORE — Two registers race the same limit (hazard #3)

| | |
|---|---|
| **Do** | Two registers (two browsers), same camper, $10 limit, $6 already spent. Both ring up $3 and press Charge at the same moment. |
| **Expect** | **One** succeeds. The other is refused. The authority is `submit_canteen_purchase` under a row lock — if both succeed, the lock is not doing its job. |
| **Sev** | S1 |

#### SN-P-07 ★ CORE — The unenforced-charge warning

| | |
|---|---|
| **Do** | Go offline (DevTools → Offline) and make a sale. Then restore the network. Then simulate a camp without migration 026 if you can. |
| **Expect** | The sale **still goes through** — blocking sales on a wifi blip would be worse — but with a **visible warning** that the limit is not being enforced for this charge. Staff must know in the moment. The ledger reconciles when back online. |
| **Verify** | The transaction appears in the manager once reconnected, exactly once. |
| **If it fails** | `localCharge` inside `charge` (599). |
| **Sev** | S1 if the warning is missing — a silent bypass is indistinguishable from an enforced charge. |

#### SN-P-08 ★ CORE — The RPC path must not double-write

| | |
|---|---|
| **Do** | Make a normal online sale and watch the network calls. |
| **Expect** | `submit_canteen_purchase` writes the debit and the balance atomically; the client then calls **only** `record_canteen_sale_inventory` (migration 142) for stock and hourly counts. The client must **not** run its own accounts/transactions save on this path — that select-then-upsert cycle has no lock and has been observed erasing real charges that landed in the gap. |
| **If it fails** | `finish(viaRpc)` inside `charge` (599). |
| **Sev** | S1 |

#### SN-P-09 — Insufficient balance

| | |
|---|---|
| **Do** | Sell more than the camper's spendable amount. Then check whether a credit limit or balance floor is configured and test the edge of each. |
| **Expect** | Refused with the spendable amount named. |
| **Sev** | S1 |

#### SN-P-10 — Manager changes while the register is open

| | |
|---|---|
| **Do** | With the register open, change an item's price and a camper's daily limit in the manager. |
| **Expect** | The register picks them up on the `campistry-cloud-hydrated` event or on reload — and if it needs a reload, that must be obvious rather than silently selling at yesterday's price. |
| **If it fails** | `reinit` (815), `refreshAccountsFromCloud` (444), `_hydratePosRoster` (839). |
| **Sev** | S2 |

#### SN-P-11 — Lock the register

| | |
|---|---|
| **Do** | Press the lock button, then press browser Back. |
| **Expect** | Locked means locked — Back does not reveal the console. |
| **If it fails** | `posLockRegister` (801). |
| **Sev** | S2 |

#### SN-P-12 — Empty states

| | |
|---|---|
| **Do** | Open the register on a camp with zero items, and one with zero campers. |
| **Expect** | A clear empty state, not a blank grey panel. |
| **Sev** | S3 |

---

## 7.6 — The offline register

`campistry_snacks_pos_offline.html` — one downloadable file with accounts and
inventory baked in, IndexedDB storage, its own PIN, and a **180-day licence**.

#### SN-O-01 ★ CORE — Download and run offline

| | |
|---|---|
| **Do** | Snacks → Offline POS → **Download**. Move the file to another machine, **disconnect from the network**, open it, complete setup, and make a sale. |
| **Expect** | It runs with no internet. Campers and items are already there. The sale is recorded locally. |
| **If it fails** | `downloadOfflinePOS` (1051), `buildOfflineExportData` (994), `exportForOfflinePOS` (1085); offline page `init` (1837), `performImport` (1155). |
| **Sev** | S2 |

#### SN-O-02 — Licence expiry

| | |
|---|---|
| **Do** | Check the expiry badge. Then set the machine clock past the expiry (throwaway machine only) and reopen. Then re-import a fresh export. |
| **Expect** | A warning as it approaches, a full lock at expiry with an explanation, and a re-import extends it. There is also a hard cap that a re-import cannot push past — confirm it exists. |
| **If it fails** | `effectiveExpiryDate` (941), `checkExpiry` (950), `isHardCapReached` (956), `capExpiryDate` (973), `enforceExpiry` (1002). |
| **Sev** | S2 |

#### SN-O-03 ★ CORE — Sync back

| | |
|---|---|
| **Do** | Make 5 sales offline, export the JSON, and **Import Offline Transactions** in the manager. Then import the **same file again**. Then import a file you have hand-edited to change an amount. Then import a file exported *before* the camper's balance changed online. |
| **Expect** | The first import adds 5 transactions and balances reconcile. The second import is **deduped** — not 10 transactions. A hand-edited file is either rejected or imported as-is with the discrepancy visible; say which. An out-of-date export must not roll a balance backwards. |
| **Verify** | Count `G.campistrySnacks.transactions` before and after each import. |
| **If it fails** | `importOfflinePOSTransactions` (1150), `_txSig` (196), `_reconcileBalances` (214). |
| **Sev** | S1 — double-importing a day's sales charges every camper twice. |

#### SN-O-04 — Offline PIN

| | |
|---|---|
| **Do** | Set the offline PIN, get it wrong repeatedly, then clear all data. |
| **Expect** | Lockout behaviour is stated. "Clear All Data" asks for confirmation and really clears IndexedDB. |
| **If it fails** | `checkPin` (844), `updatePinLockout` (869), `idbClear` (772). |
| **Sev** | S2 |

---

## 7.7 — Camp Shop

#### SN-S-01 ★ CORE — Catalogue

| | |
|---|---|
| **Do** | Create a product with variants and sizes, a photo, a price, a cost and stock. Set the low-stock threshold and whether backorders are allowed. Edit it. Restock. |
| **Expect** | It appears in the parent portal's shop with the right options and stock. |
| **If it fails** | `shopEditProduct` (435), `shopSaveProduct` (528), `shopRestock` (569), `shopSetThreshold` (388), `campistry_shop_core.js`. |
| **Sev** | S2 |

#### SN-S-02 ★ CORE — Orders and fulfilment

| | |
|---|---|
| **Do** | After a parent orders (LK-P-43): open the order, advance it through fulfilment, then **settle** it. Then try to settle it again. Then create an order manually from the manager. Then delete an order. |
| **Expect** | Each stage saves. **Settling twice does not charge twice** (migration 167). Deleting an order restores stock or explains why not. |
| **If it fails** | `shopAdvance` (343), `settleOrder` (810), `finishUp` (811), `shopDeleteOrder` (876), `applyStockAcross` (869), `tests/canteen_shop_money.test.js`. |
| **Sev** | S1 |

#### SN-S-03 — Shop money reaches the right place

| | |
|---|---|
| **Do** | Place a paid order and check where the money lands: the camper's canteen balance, the family ledger, or the processor directly. |
| **Expect** | Whatever the design is, it is consistent and reconcilable — and the parent's balance and the manager's total agree. |
| **Sev** | S1 |

#### SN-S-04 — Shop reports and export

| | |
|---|---|
| **Do** | Open the shop reports and export CSV. |
| **Expect** | Totals match the orders. CSV escaping per ME-A-05. |
| **If it fails** | `renderReports` (394), `shopExportCSV` (907). |
| **Sev** | S2 |

#### SN-S-05 — Order abuse

| | |
|---|---|
| **Do** | An order with zero lines; a negative quantity; a quantity of 1,000 on a product with stock 3; a manual order for a camper who was deleted; a variant whose price differs from the product price. |
| **Expect** | Refused or handled with the price the parent actually saw honoured. |
| **If it fails** | `shopRecalc` (731), `shopSaveOrder` (759), `draftOrder` (709). |
| **Sev** | S1 |

---

## 7.8 — Sandbox and access

#### SN-M-23 ★ CORE — A plan cannot sell

| | |
|---|---|
| **Do** | Enter a session plan (Part 8). Open Snacks. Try to take a deposit, a cash out and a shop order. Then open the **register**. |
| **Expect** | The planning bar is on the manager, only that session's campers are listed, and **every money action is refused, naming live** — canteen and shop balances are real money shared by every workspace. The **register has no bar at all**, shows today's campers and sells normally: it is deliberately live-only, because it is held by somebody serving a queue. |
| **If it fails** | `SANDBOX_TEST_PLAN.md` R4; `campistry_workspace_ui.js`. |
| **Sev** | S1 |

#### SN-M-24 — Section access

| | |
|---|---|
| **Do** | As a user whose `snacks.accounts` is `view`, try to deposit. As one whose `snacks.menu` is `none`, look for the Menu Items nav. As the Canteen Staff preset, walk the whole app. |
| **Expect** | `view` shows the page with write controls disabled and refuses the action; `none` hides the nav and blocks the pane. Note that `_secEdit` is the **UX** gate — the real boundary is RLS and the edge functions. |
| **If it fails** | `_secEdit` (1927), `campistry_access_sections.js`, migrations 048/161/163. |
| **Sev** | S2 |

---

## 7.9 — Persistence and close-out

#### SN-M-25 ★ CORE — The parent-deposit clobber

| | |
|---|---|
| **Do** | Open the Snacks manager and leave it. From the parent portal, add funds. Now, in the still-open manager, edit an item price and save. |
| **Expect** | The parent's deposit is **still there**. The manager's save fetches the current cloud value, unions the transaction ledgers by signature, and recomputes balances from the union — so no deposit or purchase is lost regardless of write order. |
| **Verify** | Balance and transaction count before and after. |
| **If it fails** | `cloudSaveSnacks` (252). |
| **Sev** | S1 |

#### SN-M-26 — Inventory is not unioned

| | |
|---|---|
| **Do** | With the manager open, make sales on a register (which write inventory counters), then save an unrelated setting in the manager. |
| **Expect** | The register's `soldToday` / `totalSold` counters survive. The merge unions **transactions and accounts**, but **replaces inventory wholesale** — so a stale manager tab can overwrite counters. Report exactly what you observe. |
| **If it fails** | `cloudSaveSnacks` (252) — the `merged = Object.assign({}, cloud, data)` line. |
| **Sev** | S2 |

#### SN-M-27 — Full round trip

| | |
|---|---|
| **Do** | Reload, log out and in, second device. |
| **Expect** | Accounts, balances, transactions, inventory, settings, PIN status and shop data identical everywhere. |
| **Verify** | `select key, updated_at from camp_state_kv where camp_id='<UUID>' and key in ('campistrySnacks','campistryShop');` |
| **Sev** | S1 |

#### SN-M-28 ★ CORE — Three-way balance parity

| | |
|---|---|
| **Do** | For one camper: read the balance in the Snacks manager, on the register, and in the parent portal. |
| **Expect** | Three identical numbers. |
| **Sev** | S1 |
