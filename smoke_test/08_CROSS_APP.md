# Part 8 — Cross-app: sync, access, entitlements, sandbox, realtime

Everything the three apps share. Most of the worst bugs in this codebase have
lived here rather than in any one app, because this is where two writers meet.

**Files:** `integration_hooks.js`, `cloud_sync_helpers.js`, `local_cache_idb.js`,
`campistry_cloud_bootstrap.js`, `campistry_finance_merge.js`, `supabase_client.js`,
`access_control.js`, `campistry_capabilities.js`, `campistry_access_sections.js`,
`campistry_access_settings.js`, `product_access_guard.js`, `parent_lockout_guard.js`,
`trial_guard.js`, `plan_limits.js`, `campistry_workspace*.js`, `campistry_presence.js`,
`campistry_control.html`, `campistry_team_access.html`, `team_access_setup.html`,
`invite.html`, `demo_mode.js`, `camp_clone.js`.

---

## 8.1 — The cloud sync contract

### What lives where

| Key | Written by | Read by | Scope | Notes |
|---|---|---|---|---|
| `campistryMe` | Me | Me, Link | camp-wide, per-user RLS (164) | Roster, families, enrollments, ledger, forms, reports, print sheets. **Rewritten whole on every save.** |
| `campistryMePayroll` | Me | Me | per-user RLS (158/160) | Split out so payroll is gated separately. |
| `campistryMeFinance` | Me | Me | per-user RLS (158/160) | Same. |
| `campStructure` | Me, Flow | all | workspace-scoped | Divisions, grades, bunks. |
| `app1` | Me, Flow, daily adjustments | all | workspace-scoped | **Multi-writer sub-keys.** Me owns `camperRoster`; Flow owns bunks/divisions/specials; adjustments own `dailySkeletons`. Fetch-merged. |
| `bunkMetaData` | Me, Flow | all | workspace-scoped | |
| `campistrySnacks` | Snacks manager, POS, **parent deposits (SECURITY DEFINER)** | Snacks, Link | per-user RLS (161) | Event-sourced; merged by transaction signature. |
| `campistryShop` | Snacks shop | Snacks, Link | per-user RLS (163) | |
| `campistryLink`, `link_forms`, `link_lists`, `link_sent_forms` | Link admin | Link | camp-wide | |

### The checks

#### X-01 ★ CORE — A save actually reaches the cloud

| | |
|---|---|
| **Do** | Make one change in each app. Watch the sync badge. Then query the cloud directly. |
| **Expect** | `updated_at` moves for the right key and no others. |
| **Verify** | `select key, updated_at from camp_state_kv where camp_id='<UUID>' order by updated_at desc limit 10;` |
| **Sev** | S1 |

#### X-02 ★ CORE — The `app1` multi-writer merge

| | |
|---|---|
| **Do** | In Flow, set up layers or a skeleton. Then in Me, change the roster and save. Reload Flow. |
| **Expect** | Flow's layers, specials and skeletons are **still there**. A wholesale replacement of `app1` by Me's partial payload would drop them. |
| **If it fails** | The `FETCH_MERGE_KEYS` block at `integration_hooks.js:878`. |
| **Sev** | S1 |

#### X-03 ★ CORE — The shallow-merge gap (hazard #1)

This is the documented weak point of the whole sync layer. The `app1`/`campistryMe`
fetch-merge is a **shallow spread**: it protects top-level branches and nothing
inside them. `finance` and `families` are therefore still replaced wholesale by
whatever the tab had in memory, and five server-side functions write into exactly
those two branches. `campistry_finance_merge.js` exists to put the server's writes
back.

| | |
|---|---|
| **Do** | Repeat ME-B-17 from Part 3, then extend it: with Tab A open on Me, have the **parent portal** save a new card on file, and separately have an installment marked paid. Then make any edit in Tab A. |
| **Expect** | The console in Tab A logs `kept server-written money out of the clobber — N payment(s), N paid installment(s), N card field(s)`. After reload: the payment exists, the installment is still paid, and the card fields autopay needs are intact. |
| **If it fails** | `campistry_finance_merge.js`, `tests/finance_merge.test.js`. Consequence if broken: the family owes the charge again **and** the cron charges the same card the next night. |
| **Sev** | S1 |

#### X-04 — Retry and backoff

| | |
|---|---|
| **Do** | Throttle the network to offline mid-save, then restore it. |
| **Expect** | The save retries with backoff and eventually lands; the badge reflects the state honestly rather than showing Synced while queued. |
| **If it fails** | `cloud_sync_helpers.js`. |
| **Sev** | S2 |

#### X-05 ★ CORE — Offline queue

| | |
|---|---|
| **Do** | Go offline. Make five distinct edits across Me and Snacks. Close the tab. Reopen it, still offline. Then go online. |
| **Expect** | The edits survive the close (IndexedDB), and **all five** reach the cloud on reconnect — not just the last one. |
| **Verify** | DevTools → Application → IndexedDB before reconnecting; then the cloud row afterwards. |
| **If it fails** | `local_cache_idb.js`. |
| **Sev** | S1 |

#### X-06 ★ CORE — Two tabs, same key

| | |
|---|---|
| **Do** | Open Me in two tabs. In Tab A add camper `X`. In Tab B (opened **before** that) add camper `Y` and save. |
| **Expect** | Both campers exist. If one is lost, that is the stale-tab clobber in its simplest form. |
| **Sev** | S1 |

#### X-07 — Two devices, same key

| | |
|---|---|
| **Do** | Same as X-06 but on two devices, with a reload in between on one of them. |
| **Expect** | Both edits survive. |
| **Sev** | S1 |

#### X-08 — A big blob

| | |
|---|---|
| **Do** | Build a camp with 2,000 campers, 500 families and a long ledger (BRK-01). Measure the size of `campistryMe` and the time to save. |
| **Verify** | Console: `JSON.stringify(G.campistryMe).length`. SQL: `select pg_column_size(value) from camp_state_kv where key='campistryMe' and camp_id='<UUID>';` |
| **Expect** | It saves. Note the size and the latency; flag anything over 5 seconds or approaching a row-size limit. |
| **Sev** | S2 |

---

## 8.2 — Roles and per-section access

### The model

Three layers stack:

1. **Product access** (migration 027) — which apps you get at all.
2. **Section access** (migration 048) — `<app>.<section>` at `none` / `view` / `edit`.
3. **Entitlements** (155–157) — what the camp has *bought*, enforced in the database.

**The backward-compatibility rule:** a user with **no preset and no overrides** is
UNCONFIGURED and gets `edit` on every section their product access already allows.
Gating begins only once an owner deliberately assigns something. Getting this
backwards locks every existing staff member out of everything.

#### X-09 ★ CORE — Unconfigured means unrestricted

| | |
|---|---|
| **Do** | Invite a brand-new staff member and give them product access but **no** preset. Sign in as them. |
| **Expect** | Full use of the apps they were granted. |
| **Verify** | Console: `CampistrySections.isUnrestricted()` → `true`. |
| **If it fails** | `resolve()` in `campistry_capabilities.js`. |
| **Sev** | S1 — this failing locks out an entire camp's staff. |

#### X-10 ★ CORE — Apply each preset

Assign each preset in turn (Staff & Access → the matrix) and walk the three apps.

| Preset | Must be able to | Must NOT be able to |
|---|---|---|
| **Division Head** | Bunk Builder (edit), print sheets, Live | Billing, Payroll, Finance, Registration |
| **Head Counselor** | all of Flow, Bunk Builder, Live | Billing, Payroll, Registration |
| **Office / Registrar** | Roster (edit), Registration, Billing, all of Link | Payroll, Finance |
| **Bookkeeper** | Billing, Payroll, Finance (view), Snacks transactions + accounts (**view**) | the Snacks **POS** (explicitly `none`) |
| **Nurse** | all of Health, roster (view) | everything else |
| **Canteen Staff** | all of Snacks, roster (view) | Me billing, Link |
| **Bunk Counselor** | Live, Notes, schedule (view), roster (view) | everything else |
| **Read-only** | see everything they have | change anything |

| | |
|---|---|
| **Expect** | For `none`: the nav item is hidden **and** the pane is blocked if deep-linked. For `view`: the page renders read-only with write controls disabled and the action refused. |
| **Verify** | Console as that user: `CampistrySections.level('me.billing')`, `CampistrySections.getAccess()`. |
| **If it fails** | `campistry_access_sections.js` — `gateNav` (222), `gateOpenSection` (356), `markViewOnlyPanes`, `PANE_SELECTORS` (259). **Note the comment at line 259:** a missing pane selector silently disables the gate, so Save/Delete stay live in a `view` section. Check every pane in all three apps. |
| **Sev** | S1 |

#### X-11 ★ CORE — Revoke while they are using it

| | |
|---|---|
| **Do** | With a staff member sitting on Me → Billing, revoke `me.billing` from the owner account. Have them keep working without reloading, then reload. |
| **Expect** | After reload they are blocked. Before reload, any **write** they attempt is refused by the server even though the button is still on screen. Hiding the button is not the enforcement. |
| **Verify** | The write fails at RLS, not just in the UI. |
| **Sev** | S1 |

#### X-12 — Scrub and preserve

| | |
|---|---|
| **Do** | As a restricted user, inspect the cached blob in the console. |
| **Expect** | Data for sections they cannot see is **scrubbed** from the cache, and — critically — the next save from that user must not write the scrubbed emptiness back over the real data. |
| **If it fails** | `campistry_access_sections.js` scrub/preserve (point 5 of its header). |
| **Sev** | S1 — a restricted user silently deleting payroll by opening the roster is the worst shape of this bug. |

#### X-13 — Delete the user mid-session

| | |
|---|---|
| **Do** | Remove a staff member from the camp while they have Me open. Have them save. |
| **Expect** | Refused cleanly and they are signed out or told. Not a silent write with a stale token. |
| **Sev** | S1 |

#### X-14 — Team & Access setup pages

| | |
|---|---|
| **Do** | Walk `campistry_team_access.html`, `team_access_setup.html` and `invite.html`: invite a member, set their role and access group and divisions, resend an invite, revoke one, accept an invite in a private window. |
| **Expect** | Each step works; an accepted invite yields exactly the configured access. |
| **Verify** | `get_my_access`, `get_camp_role_access`, `set_member_access`; migrations 097, 098, 159, 165. |
| **If it fails** | `campistry_access_settings.js`. |
| **Sev** | S2 |

#### X-15 — Invite abuse

| | |
|---|---|
| **Do** | Accept the same invite twice; accept an invite after it was revoked; open an invite token from the other camp; sign up with an email that already has an account. |
| **Expect** | Each refused clearly. `email_has_account` (migration 125) drives the right branch. |
| **Sev** | S1 |

#### X-16 ★ CORE — Scheduler division scoping

| | |
|---|---|
| **Do** | Give a scheduler account only `Alpha`. Open Me and Flow as them. |
| **Expect** | They see and generate only for `Alpha`. Subdivision UUIDs resolve; parent→child grade expansion works; `allowedDivisions` is not stale after a reload. |
| **If it fails** | `access_control.js` — there is a history of stale-resolution fixes here. |
| **Sev** | S1 |

---

## 8.3 — Entitlements

Set on the super-admin page `campistry_control.html`, enforced in the database.
Keys seen in the migrations: `me`, `snacks`, `shop`, `health`, `go`, `luggage`,
`notes`, `billing`, plus the per-key `camp_state_kv` gate covering `campistryMe`,
`campistryMePayroll`, `campistryMeFinance`, `campistrySnacks`, `campistryShop`,
`campistryHealth`, `campistryLuggage`.

#### X-17 ★ CORE — Turn one off

| | |
|---|---|
| **Do** | On the **throwaway** camp, use Control to restrict one entitlement (start with `shop`). Reload Snacks and the parent portal. |
| **Expect** | The Camp Shop disappears from both, and a direct write to `campistryShop` is refused by RLS. |
| **Verify** | `select * from camp_entitlements where camp_id='<UUID>';`; console: `CampistrySections.entitlements()`. |
| **If it fails** | `campistry_control_matrix.js`, migrations 155/156/157, `tests/entitlements.test.js`, `ENTITLEMENTS_DESIGN.md`. |
| **Sev** | S2 |

#### X-18 ★ CORE — Do not lock out the owner

| | |
|---|---|
| **Do** | Restrict, then **unrestrict**, an entitlement on the throwaway camp. |
| **Expect** | Restoring it fully restores access, owner included. |
| **Warning** | `TEST_PLAN_ENTITLEMENTS_MONEY.md` is explicit: an entitlement set wrong locks that key **for everyone including the owner**. Never test this against your only owner account. |
| **Sev** | S1 |

#### X-19 — Entitlement vs section access precedence

| | |
|---|---|
| **Do** | Grant a user `edit` on `snacks.shop` while the camp's `shop` entitlement is restricted. |
| **Expect** | Entitlement wins — `resolve()` returns `none` regardless of the grant. |
| **Sev** | S2 |

#### X-20 — Super-admin gate

| | |
|---|---|
| **Do** | Open `campistry_control.html` as a **non**-super-admin. |
| **Expect** | Refused. `am_i_super_admin` is the gate. |
| **Sev** | S1 |

---

## 8.4 — Trial and plan limits

#### X-21 — Trial countdown and lockout

| | |
|---|---|
| **Do** | On a throwaway camp, set `plan_status='trial'` with a `trial_started_at` inside the window, then outside it. Reload each app. |
| **Expect** | Inside: a countdown banner, full access. Outside: a fullscreen lockout on **every** app page, with a way to pay. |
| **Verify** | `update camps set plan_status='trial', trial_started_at = now() - interval '60 days' where id='<THROWAWAY UUID>';` |
| **If it fails** | `trial_guard.js`. |
| **Sev** | S2 |

#### X-22 — Plan caps

| | |
|---|---|
| **Do** | Read `plan_limits.js` for the Starter caps, then exceed one (e.g. campers) by import. |
| **Expect** | The cap is enforced **in the database too**, not only in the browser — `plan_limits.js` says the SQL functions hardcode the same numbers. Exceeding it gives a clear upgrade message, not a silent truncation. |
| **Sev** | S1 if the server does not enforce it; S2 for the message. |

#### X-23 — Trial expiry mid-save

| | |
|---|---|
| **Do** | With a long form open, expire the trial, then save. |
| **Expect** | Refused with an explanation. The typed work is not silently discarded without telling the user. |
| **Sev** | S2 |

---

## 8.5 — Session planning (the sandbox)

`SANDBOX_TEST_PLAN.md` is the full plan for this feature and should be run in
full at least once. These are the cards that matter for **Me, Link and Snacks**
specifically.

#### X-24 ★ CORE — Money is never copied into a plan

Create a plan, then run this in the SQL Editor:

```sql
select key from camp_state_kv
 where camp_id = '<UUID>'
   and key ~ '^ws:.*/(campistryMe|campistryMeFinance|campistryMePayroll|campistrySnacks|campistryShop|campistryLink)$';
```

| | |
|---|---|
| **Do** | Create a plan. Run the query above. |
| **Expect** | **0 rows.** Campers, families, the ledger, payroll and till balances are never copied — there is no such thing as a draft payment. Any row here is the most serious failure in this plan. Stop and report. |
| **Sev** | S1 |

#### X-25 ★ CORE — Money refuses at the door

| | |
|---|---|
| **Do** | Inside a plan, open Me → Billing. Click Add Charge, Record Payment, Issue Credit. Then the same three from a single family's `⋯` menu. Then try a Snacks deposit and a shop order. |
| **Expect** | An amber strip saying Billing is always the live camp, and **each action refuses immediately with no form opening** — including the row-level menu routes, which used to skip the check entirely. |
| **If it fails** | `SANDBOX_TEST_PLAN.md` R2; `_liveOnlyEdit` (`campistry_me.js:1409`). |
| **Sev** | S1 |

#### X-26 ★ CORE — You always know where you are

| | |
|---|---|
| **Do** | Enter a plan and visit Me, Snacks, Link, Flow, Live and Go. |
| **Expect** | The striped planning bar on every one, naming the plan and the session. Leaving returns you to live with **no leftover gap** at the top. The register (`campistry_snacks_pos.html`) deliberately has **no** bar and is always live. |
| **Sev** | S1 |

#### X-27 ★ CORE — A plan remembers it is a plan

| | |
|---|---|
| **Do** | In a plan, add a division. Reload twice. Switch to live. Switch back. |
| **Expect** | The division persists in the plan, is **absent** in live, and returns on switching back. The console logs *"stored snapshot belonged to X, now in Y — dropped its operational keys"*. |
| **If it fails** | `_scrubForeignWorkspace` and the boot scrub in `integration_hooks.js`. |
| **Sev** | S1 |

#### X-28 — The roster shows the plan's session

| | |
|---|---|
| **Do** | In a 2nd-Half plan, open Me → Roster and Snacks. |
| **Expect** | 2nd Half's campers. A plan that cannot resolve a date shows **today's** campers — that is deliberate, not a failure. |
| **Sev** | S2 |

#### X-29 — Two users, two plans

| | |
|---|---|
| **Do** | One user in plan A, another in plan B, a third in live. All three edit bunks. |
| **Expect** | Three independent sets of bunks. Nothing crosses. |
| **Sev** | S1 |

#### X-30 — Make official

| | |
|---|---|
| **Do** | In a plan, add a division, then **Make official**. |
| **Expect** | The confirm button is visibly disabled until `MAKE OFFICIAL` is typed exactly (case-sensitive on purpose). Afterwards live has the division and the archive holds what live had before. |
| **Sev** | S1 |

---

## 8.6 — Realtime

#### X-31 ★ CORE — What updates live, per app

Fill this table in by observation. Leave each page open and make the change
elsewhere.

| Change | Me | Link admin | Link parent | Snacks mgr | POS |
|---|---|---|---|---|---|
| Camper added in Me | — | ? | ? | ? | ? |
| Parent sends a message | ? | ? | — | — | — |
| Parent adds canteen funds | ? | — | — | ? | ? |
| POS sale | — | — | ? | ? | — |
| Payment recorded in Me | — | — | ? | — | — |
| Bunk renamed in Me | — | ? | ? | ? | ? |
| Owner deletes a day's schedule | ? | — | ? | — | — |

| | |
|---|---|
| **Expect** | Anything that says "needs a manual refresh" is acceptable **if the stale data cannot cause a wrong action**. A register selling at yesterday's price, or an office replying to a message that was already answered, is not acceptable. |
| **Sev** | S2 |

#### X-32 — DELETE propagation

| | |
|---|---|
| **Do** | The owner deletes a day while a scheduler has it open. Then a scheduler clears their own divisions. |
| **Expect** | The delete propagates via realtime. A scheduler clearing their divisions does **not** clear the owner's. |
| **Sev** | S1 |

---

## 8.7 — Demo mode, debug copies, and camp isolation

#### X-33 ★ CORE — Demo mode writes nothing real

| | |
|---|---|
| **Do** | Open any app with `?demo=true`. Create campers, take payments, ring up sales. Then exit demo mode and check the real camp. |
| **Expect** | Nothing from the demo reached Supabase. The mock client intercepts every cloud operation. |
| **Verify** | `select updated_at from camp_state_kv where camp_id='<UUID>';` — unchanged. |
| **If it fails** | `demo_mode.js`, `offline_data.js`. |
| **Sev** | S1 |

#### X-34 — Debug copy

| | |
|---|---|
| **Do** | As a super-admin, clone a camp. Edit the copy heavily. |
| **Expect** | The **original is never written** — the database forbids super-admin writes to camps the user does not own. |
| **Verify** | The original's `updated_at` values do not move. Migration 010, `DEBUG_COPY_SETUP.md`. |
| **Sev** | S1 |

#### X-35 ★ CORE — Two camps in one browser

| | |
|---|---|
| **Do** | Switch between the two camps repeatedly without clearing storage. Check the roster, canteen balances and Billing after each switch. |
| **Expect** | No bleed. `campGlobalSettings_v1` is a single local cache name — confirm it is re-scoped on switch and that camp A's roster never shows under camp B. |
| **Verify** | After switching, `CampistryDB.getCampId()` and the blob's contents must agree. |
| **Sev** | S1 |

#### X-36 — Camp-scoped RPC authorisation

| | |
|---|---|
| **Do** | In the console of the parent portal, call a parent RPC with **another camp's** UUID. |
| **Expect** | Refused. Migration `183_lock_down_camp_scoped_readers.sql`, `024_parent_rpcs_camp_scoped.sql`, `tests/camp_scoped_rpc_auth.test.js`. |
| **Sev** | S1 |

---

## 8.8 — Camp-level settings that ripple

#### X-37 — Change the timezone after transactions exist

| | |
|---|---|
| **Do** | Change the camp timezone by several hours. Reopen Snacks and the register. |
| **Expect** | "Today" shifts consistently everywhere. Existing transactions are not re-dated in a way that double-counts or erases a day's sales. |
| **Sev** | S1 |

#### X-38 — Delete a session that is in use

| | |
|---|---|
| **Do** | Delete a session that has enrollments, an auto-reload preset pointing at it, and a session plan bound to it. |
| **Expect** | Warned, and the dependents are handled explicitly. A plan bound to a deleted session must not silently become "today". |
| **Sev** | S1 |

#### X-39 — Rename the camp

| | |
|---|---|
| **Do** | Rename the camp. Check message branding, the acceptance letter, SMS prefixes and print headers. |
| **Expect** | The new name everywhere. |
| **Sev** | S3 |

---

## 8.9 — Diagnostics sweep

#### X-40 — Run the built-in audit

| | |
|---|---|
| **Do** | On each app page: `await CampistryDiag.quickCheck()` then `await CampistryDiag.expoAudit()`. |
| **Expect** | Module loading, auth/RBAC, data integrity and the rest all clean. Record anything it flags — it checks things this plan does not. |
| **If it fails** | `campistry_diagnostics.js`, `rbac_diagnostics.js`. |
| **Sev** | Depends on what it finds. |
