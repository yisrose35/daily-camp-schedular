# Part 0 — Pre-flight

**Nothing below Part 0 gives a trustworthy answer until this is done.** The most
common cause of a false failure in this plan is a migration that was never run:
the UI fails soft almost everywhere, so an un-applied migration looks like a
feature that quietly does nothing rather than an error.

Budget 45 minutes. Do it once; it serves all ten parts.

---

## 0.1 — What you need before you touch anything

| | |
|---|---|
| **A throwaway camp** | Not a camp with real families. Parts 3, 6 and 7 move money. If the only camp available is real, run Parts 1, 2, 4, 5 and 8 only, and say so in the report. |
| **A second camp** | Same owner account. Used to prove camp isolation (BRK-30 onward). A Debug Copy (`camp_clone.js`) is the fastest way to make one. |
| **The owner login** | Full access. |
| **Two staff logins** | One you will make a *Division Head*, one a *Bookkeeper*. Created in Part 8; you only need two real email addresses you can receive mail at. |
| **One parent login** | A real mailbox. The portal sends a verification code. |
| **A phone that receives SMS** | For Link broadcasts and the SMS consent path. Optional — skip and mark those cards *skipped*. |
| **Supabase Dashboard access** | SQL Editor and Table Editor. Most verification steps are a SQL query. The user has **no Supabase CLI** — everything is Dashboard-only. |
| **Chrome or Edge** | DevTools Network + Application panels are used throughout. |
| **A second device or browser profile** | For every multi-device card. A private window on the same machine works. |

---

## 0.2 — Which migrations are applied

Run this in the **SQL Editor**. It answers "is the database actually at the same
version as this code" in one shot.

```sql
-- Functions the newest features depend on. Each missing row disables a feature
-- silently — the UI keeps working and just does less.
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     -- money / ledger
     'get_my_balance', 'post_ledger_entry', 'record_payment_atomic',
     'charge_saved_card_atomic', 'get_camp_payment_processor_status',
     -- canteen
     'submit_canteen_purchase', 'record_canteen_sale_inventory',
     'get_camp_canteen_stripe_status',
     -- access
     'get_my_access', 'get_camp_role_access', 'set_member_access',
     'camp_state_key_user_allowed',
     -- public forms
     'get_public_form_config', 'submit_public_application',
     'get_postaccept_bootstrap', 'get_posthire_bootstrap',
     'get_contract_offer', 'session_capacity_state',
     -- link
     'get_link_camp_forms', 'get_my_messages', 'get_staff_tip_account',
     'upsert_parent_invite',
     -- session planning
     'create_workspace', 'promote_workspace', 'list_workspaces',
     'workspace_operational_keys'
   )
 order by 1;
```

Then the tables:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('camp_state_kv','camps','camp_users','camp_entitlements',
                      'camp_workspaces','link_messages','link_photos',
                      'link_parent_invites','parent_pickup_requests',
                      'saved_payment_methods','bank_deposits','account_lockouts',
                      'push_tokens','sms_opt_outs','email_unsubscribes')
 order by 1;
```

**Write down what is missing.** Every check in this plan that depends on a
missing piece is a **skip**, not a fail. The migrations live in `migrations/`,
numbered; paste the file's whole contents into a new SQL Editor query and run it.
They are written to be idempotent.

| | |
|---|---|
| **PRE-01 Do** | Run both queries above. |
| **Expect** | Every function and table present. |
| **If it fails** | Note the gap and carry it into the report header. Re-run the matching `migrations/NNN_*.sql`. |
| **Sev** | S2 |

---

## 0.3 — Camp-level settings that everything downstream reads

These are set on **`dashboard.html`**, under Camp Setup. Getting them wrong makes
half of Parts 3, 5 and 6 behave strangely in ways that look like app bugs.

| | |
|---|---|
| **PRE-02 Do** | Dashboard → Camp Setup → **Sessions**. Create two non-overlapping sessions with real start and end dates, e.g. `1st Half 2026-06-28 → 2026-07-24` and `2nd Half 2026-07-26 → 2026-08-21`. |
| **Expect** | Both listed with their dates. |
| **Verify** | The Me page's Registration session picker offers both. |
| **If it fails** | `dashboard.js` `_dashSaveSessions` / `loadSessionsSection`. |
| **Sev** | S2 — a session with no dates makes every presence check fall back to "today", and Part 8's sandbox checks become meaningless. |

| | |
|---|---|
| **PRE-03 Do** | Dashboard → Camp Settings → **Language & Regional**, and confirm the camp's **timezone** is set. |
| **Expect** | Set to the camp's real timezone. |
| **Verify** | `select id, name, timezone from camps where id = '<CAMP UUID>';` |
| **If it fails** | migration `063_camp_timezone.sql` not applied, or never set. |
| **Sev** | S2 — "Sales today", "spent today", the daily-limit reset and scheduled broadcasts all resolve the day boundary through this. |

| | |
|---|---|
| **PRE-04 Do** | Dashboard → Camp Setup → **Emailing**: set the camp contact email. |
| **Expect** | Saved. |
| **Verify** | `select contact_email from camps where id = '<CAMP UUID>';` |
| **If it fails** | migration `074_camp_contact_email.sql`. |
| **Sev** | S2 — invites, acceptance letters and broadcast email all send *from* this. With it empty, the send paths fail soft and you will chase a Link bug that is a settings gap. |

| | |
|---|---|
| **PRE-05 Do** | Dashboard → Payment Processing → **Where tuition money lands** and **Payment processor**. Note which processor this camp is on: Stripe Connect, Banquest, Cardknox/Sola, or none. |
| **Expect** | You can state it in one word. |
| **Verify** | In the browser console on any app page: `await CampistryDB.getClient().rpc('get_camp_payment_processor_status', {p_camp_id: CampistryDB.getCampId()})` |
| **If it fails** | `dashboard.js`, `BYOP_SETUP.md`. |
| **Sev** | S2 — **write the answer at the top of your report.** Every money card in Parts 3, 6 and 7 branches on it, and "no processor" is a legitimate configuration with its own expected UI. |

| | |
|---|---|
| **PRE-06 Do** | Dashboard → Camp Setup → **Link Programs**. Turn every program ON for now (Photos, Canteen, Camp Shop, Tips, Camper Mail, Pickup & Arrival). |
| **Expect** | All on. |
| **If it fails** | `dashboard.js` `linkProgramsBox`, migration `108_merge_program_settings_into_link_features.sql`. |
| **Sev** | S3 — Part 6 turns them off again deliberately; start from all-on so a missing tile is a bug, not a setting. |

| | |
|---|---|
| **PRE-07 Do** | Confirm the camp is not on an expired trial: Dashboard should show no lockout and no red countdown. |
| **Expect** | Full access. |
| **Verify** | `select plan_status, trial_started_at from camps where id = '<CAMP UUID>';` |
| **If it fails** | `trial_guard.js`. |
| **Sev** | S2 — an expired trial puts a fullscreen lockout over everything and makes the whole plan un-runnable. |

---

## 0.4 — Seed data

Build this once. Parts 1 through 9 all refer to these names, so use them exactly.

**Structure — Me → Structure:**

| Division | Grades | Bunks |
|---|---|---|
| `Alpha` | `Junior` | `A1`, `A2` |
| `Alpha` | `Senior` | `A3` |
| `Beta` | `Junior` | `B1`, `B2` |
| `Gamma` | `Solo` | `G1` |

`Gamma`/`G1` exists to be deleted and renamed later. Do not put anything in it
you will miss.

**Campers — Me → Roster.** At minimum:

| Name | Division / Bunk | Why it exists |
|---|---|---|
| `Avi Klein` | Alpha / A1 | The ordinary case. Give them a parent email you can read. |
| `Malky Stein` | Alpha / A1 | Duplicate-name case, child one. |
| `Malky Stein` | Beta / B1 | **The same name again.** The second one must be accepted and must get its own key. If Me refuses to save it, that is finding **ME-R-09** and it is S1. |
| `Sara O'Brien` | Alpha / A2 | Apostrophe in the name — exercises every lookup, filter and export. |
| `Yossi Weiss-Cohen` | Beta / B2 | Hyphen. |
| `רחל לוי` | Beta / B2 | Non-Latin name — sorting, search, CSV, PDF. |
| `First-Half Only` | Alpha / A3 | Enrolled in **1st Half only**. |
| `Second-Half Only` | Alpha / A3 | Enrolled in **2nd Half only**. |
| `Both Halves` | Alpha / A3 | Enrolled in both. |

The last three are what make every presence, roster-slice and sandbox check in
Parts 1 and 8 mean anything. Write their names down.

**Families:** put `Avi Klein` and one `Malky Stein` in the *same* family with one
shared parent email. Sibling discount, family ledger and the parent portal's
multi-child view all key off this.

**Staff:** one hired staff member assigned as Counselor on `A1`, with an email you
can read. Tips, Lite invites and payroll all start here.

| | |
|---|---|
| **PRE-08 Do** | Build all of the above. |
| **Expect** | Every row saves. The second `Malky Stein` is accepted. |
| **Verify** | Console: `Object.keys(JSON.parse(localStorage.campGlobalSettings_v1).campistryMe.roster)` — you should see a suffixed key such as `Malky Stein #102` for the duplicate. |
| **If it fails** | `campistry_camper_identity.js`, `saveCamper` at `campistry_me.js:3359`. |
| **Sev** | S1 |

---

## 0.5 — The console toolkit

Keep these to hand. Every one of them is already shipped in the app; none of it
needs anything installed.

```js
// Who am I, and which camp am I in?
CampistryDB.getCampId(); CampistryDB.getUserId(); CampistryDB.getRole();
await CampistryDB.isOwner();

// The whole local cache, as the page sees it right now.
var G = JSON.parse(localStorage.campGlobalSettings_v1 || '{}'); Object.keys(G);

// The three app blobs.
G.campistryMe && Object.keys(G.campistryMe);     // roster, families, enrollments, finance…
G.campistrySnacks;                                // accounts, inventory, transactions
G.campistryShop;

// What my section access actually resolves to (Part 8 lives on this).
CampistrySections.level('me.billing');     // 'none' | 'view' | 'edit'
CampistrySections.isUnrestricted();        // true = never configured, full access
CampistrySections.getAccess();
CampistrySections.entitlements();

// Presence — is this camper here today?
CampistryPresence.hasDates(); CampistryPresence.isHere('First-Half Only');
CampistryPresence.asOfInfo();

// Full system audit (slow, ~14 categories).
await CampistryDiag.quickCheck();
await CampistryDiag.expoAudit();

// Read a cloud row directly, bypassing every cache.
await CampistryDB.getClient().from('camp_state_kv')
  .select('key, updated_at').eq('camp_id', CampistryDB.getCampId());
```

**The single most useful trick in this whole plan:** before and after any action
you suspect, snapshot the blob and diff it.

```js
window._before = JSON.stringify(JSON.parse(localStorage.campGlobalSettings_v1).campistryMe);
// … do the thing …
var a = JSON.parse(window._before), b = JSON.parse(localStorage.campGlobalSettings_v1).campistryMe;
Object.keys({...a,...b}).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
// → the list of top-level branches the action touched. Anything unexpected here is a finding.
```

There is also a purpose-built recorder for the Me page: paste
`tests/me_page_recorder.js` into the console on `campistry_me.html`, run through
Part 1, then call `MeTestRecorder.report()`. It logs every save with what changed.

---

## 0.6 — Known-benign console noise

Do not report these as findings.

| What you'll see | Why |
|---|---|
| `Cloud save failed: … does not exist` for a feature you haven't migrated | Fail-soft by design. It is a skip, not a bug. |
| `record_canteen_sale_inventory failed` on a camp without migration 142 | The register falls back to the full save path deliberately. |
| `PGRST202` / `could not find … in schema cache` | Same: an RPC that isn't there yet. Note which one. |
| `campistryMe finance merge failed` | **This one is NOT benign.** It means server-written money is about to be clobbered. S1. Report it. |
| `stored snapshot belonged to X, now in Y — dropped its operational keys` | The workspace scrub working out loud. Expected when switching between live and a plan. |
| Font / favicon 404s | Cosmetic. |

---

## 0.7 — Baseline: does the automated suite still pass?

Not a browser check, but run it first so you know the ground you're standing on.

```bash
npm test                      # node --test tests/*.test.js
```

| | |
|---|---|
| **PRE-09 Do** | Run it. |
| **Expect** | Everything green **except** 14 known pre-existing failures in `tests/auto_full_day.test.js` (scheduler layer floors — unrelated to these three apps). |
| **If it fails** | Any *other* failing suite is a finding before you have clicked anything. Record the suite name and assertion. |
| **Sev** | S2 |

---

## 0.8 — Report header

Start your results file (`smoke_test/10_RESULTS.md` has the template) with this
filled in. Every ambiguous result later is resolved by one of these lines.

```
Date:
Camp name / UUID:
Second camp UUID:
Browser + version:
Payment processor:            stripe | banquest | cardknox | none
Telnyx SMS number:            yes | no
Camp contact email set:       yes | no
Migrations missing:           (from 0.2)
Link Programs enabled:        (from PRE-06)
Sessions + dates:             (from PRE-02)
Timezone:
npm test baseline:            pass / N failures beyond the known 14
```

Now go to Part 1.
