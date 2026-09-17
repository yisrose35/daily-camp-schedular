# Part 10 — Results template, SQL pack and console reference

Copy this file to `smoke_test/RESULTS_<date>.md` and fill it in as you go. It is
the deliverable — a run of this plan with no written result did not happen.

---

## Report header

```
Date:
Tester:
Camp name / UUID:
Second camp UUID:
Browser + version:
Device(s):

Payment processor:            stripe | banquest | cardknox | none
Telnyx SMS number:            yes | no
Camp contact email set:       yes | no
Timezone:
Sessions + dates:
Link Programs enabled:
Migrations missing (0.2):
npm test baseline:            pass | N failures beyond the known 14

Parts attempted:              0 1 2 3 4 5 6 7 8 9
Parts completed:
```

---

## Summary table

Fill one row per part.

| Part | Cards run | Passed | Failed | Skipped | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|---|---|
| 0 Pre-flight (9) | | | | | | | | |
| 1 Me roster/structure (53) | | | | | | | | |
| 2 Me registration/hiring (51) | | | | | | | | |
| 3 Me money (43) | | | | | | | | |
| 4 Me output (24) | | | | | | | | |
| 5 Link admin (45) | | | | | | | | |
| 6 Link parent (64) | | | | | | | | |
| 7 Snacks (49) | | | | | | | | |
| 8 Cross-app (40) | | | | | | | | |
| 9 Break it (50) | | | | | | | | |
| **Total (428)** | | | | | | | | |

---

## Findings

One block per finding. Keep them in severity order, worst first.

```
### F-01  ·  <one-line title>

Card:        ME-B-17
Severity:    S1
Repeatable:  yes | no | intermittent (N of M attempts)

What I did:
  1.
  2.

Expected:

Actually happened:

Evidence:
  console:
  network:   <request name> <status> <response body>
  sql:       <query and result>

Blast radius:   who is affected and how badly

Suspected file: campistry_me.js:NNNN / migration NNN
```

---

## The five hazards — verdict

Answer each in one sentence. These are the questions the whole plan exists to
answer.

| # | Hazard | Verdict | Evidence card |
|---|---|---|---|
| 1 | Stale-tab clobber of server-written money | | ME-B-17 / X-03 / BRK-11 |
| 2 | Two campers with one name sharing money | | ME-R-11 / SN-M-06 / BRK-16 |
| 3 | Canteen limits bypassed when the RPC is unavailable | | SN-P-05 / SN-P-06 / SN-P-07 |
| 4 | Broadcasts reaching fewer people than promised | | LK-A-10 / LK-A-12 / ME-A-21 |
| 5 | Editing live data while believing you are in a plan | | X-24 / X-25 / X-26 |

---

## Three-way parity, start and end

| Quantity | Start | After Part 3 | After Part 6 | After Part 7 | End |
|---|---|---|---|---|---|
| Family tuition balance (Me) | | | | | |
| Same, parent portal | | | | | |
| Same, `get_my_balance` | | | | | |
| Camper canteen balance (Snacks) | | | | | |
| Same, register | | | | | |
| Same, parent portal | | | | | |

Any row where the numbers ever diverge is an S1, regardless of whether they
converge again afterwards.

---

## Performance log

| Action | Data size | Time | Notes |
|---|---|---|---|
| Me page first paint | | | |
| Roster render | campers | | |
| Bunk auto-generate | campers | | |
| Billing page render | families | | |
| Cloud save (`campistryMe`) | KB | | |
| Link audience count | recipients | | |
| Bulk parent invite | families | | |
| Photo batch scan | photos | | |
| Snacks dashboard | transactions | | |
| POS charge round trip | | | |
| CSV import | rows | | |

Flag anything over 5 seconds.

---

## SQL verification pack

Paste these into the Supabase SQL Editor. Replace `<UUID>` with the camp id.

```sql
-- 1. What state exists, and when it last moved.
select key, pg_column_size(value) as bytes, updated_at
  from camp_state_kv
 where camp_id = '<UUID>'
 order by updated_at desc;

-- 2. Workspace routing: nothing financial may be copied into a plan. Expect 0.
select key from camp_state_kv
 where camp_id = '<UUID>'
   and key ~ '^ws:.*/(campistryMe|campistryMeFinance|campistryMePayroll|campistrySnacks|campistryShop|campistryLink)$';

-- 3. Which workspace each schedule/rotation row belongs to.
select 'daily_schedules' as src, workspace, count(*) from daily_schedules where camp_id='<UUID>' group by 2
union all
select 'rotation_counts', workspace, count(*) from rotation_counts where camp_id='<UUID>' group by 2;

-- 4. Parent invites: one claim per token, and who holds it.
select token, parent_email, claimed_by, claimed_at, created_at
  from link_parent_invites where camp_id = '<UUID>' order by created_at desc;

-- 5. Duplicate parent emails across families — the LK-A-27 / BRK-18 risk.
select parent_email, count(*) from link_parent_invites
 where camp_id = '<UUID>' group by 1 having count(*) > 1;

-- 6. Messages, newest first.
select id, created_at, direction, subject, read_at
  from link_messages where camp_id = '<UUID>' order by created_at desc limit 30;

-- 7. Pickup requests.
select id, camper_name, kind, request_date, status, created_at
  from parent_pickup_requests where camp_id = '<UUID>' order by created_at desc limit 30;

-- 8. Saved cards.
select id, family_key, brand, last4, exp_month, exp_year, is_default
  from saved_payment_methods where camp_id = '<UUID>';

-- 9. Entitlements.
select * from camp_entitlements where camp_id = '<UUID>';

-- 10. Lockouts (verification codes and the register PIN).
select * from account_lockouts order by created_at desc limit 20;

-- 11. Opt-outs and unsubscribes — why a broadcast under-delivered.
select 'sms' src, phone as addr, created_at from sms_opt_outs where camp_id='<UUID>'
union all
select 'email', email, created_at from email_unsubscribes where camp_id='<UUID>';

-- 12. Camp settings that everything downstream reads.
select id, name, timezone, contact_email, plan_status, trial_started_at
  from camps where id = '<UUID>';

-- 13. Bank deposits.
select id, received_at, amount, matched_family, status
  from bank_deposits where camp_id = '<UUID>' order by received_at desc limit 20;

-- 14. Workspaces.
select id, label, session, status, created_at from camp_workspaces where camp_id = '<UUID>';

-- 15. Who is on this camp and what they may open.
select user_id, role, product_access from camp_users where camp_id = '<UUID>';
```

### Canteen reconciliation (run this after Part 7)

The canteen is event-sourced, so this is the check that matters: **every balance
must equal the sum of its own transactions.**

```sql
-- Pull the blob and reconcile it by hand in the console instead — the ledger
-- lives inside camp_state_kv, not in its own table:
select value from camp_state_kv where camp_id='<UUID>' and key='campistrySnacks';
```

```js
// Paste into the console on any page of the camp. Reports any account whose
// stored balance disagrees with its ledger. Expect an empty array.
(function(){
  var s = JSON.parse(localStorage.campGlobalSettings_v1).campistrySnacks || {};
  var byId = {}, byNameNoId = {}, byName = {};
  (s.transactions||[]).forEach(function(t){
    if(!t) return;
    var amt = parseFloat(t.amount)||0, signed = (t.type==='credit'? amt : -amt);
    var hasId = (t.camperId != null && t.camperId !== '');
    if(hasId) byId[t.camperId] = (byId[t.camperId]||0) + signed;
    if(t.camper){ byName[t.camper]=(byName[t.camper]||0)+signed;
                  if(!hasId) byNameNoId[t.camper]=(byNameNoId[t.camper]||0)+signed; }
  });
  var bad = [];
  Object.keys(s.accounts||{}).forEach(function(n){
    var a = s.accounts[n]; if(!a) return;
    var expect = a.camperId != null
      ? (byId[a.camperId]||0) + (byNameNoId[n]||0)
      : (byName[n]||0);
    expect = Math.round(expect*100)/100;
    if (Math.abs((a.balance||0) - expect) > 0.005)
      bad.push({account:n, stored:a.balance, ledger:expect, camperId:a.camperId});
  });
  console.table(bad);
  return bad;
})();
```

---

## Console reference

```js
// Identity and camp
CampistryDB.getCampId(); CampistryDB.getUserId(); CampistryDB.getRole();
await CampistryDB.isOwner(); CampistryDB.isRoleVerified();

// The local cache
var G = JSON.parse(localStorage.campGlobalSettings_v1 || '{}'); Object.keys(G);

// Access
CampistrySections.level('me.billing');
CampistrySections.isUnrestricted();
CampistrySections.getAccess();
CampistrySections.entitlements();

// Presence
CampistryPresence.hasDates();
CampistryPresence.isHere('Second-Half Only');
CampistryPresence.asOfInfo();

// Link data bridge (admin page)
CampistryLink.data.getRoster().length;
CampistryLink.data.getParentDirectory().length;
CampistryLink.data.getCamperParentMap();

// Processor
await CampistryDB.getClient().rpc('get_camp_payment_processor_status',
  { p_camp_id: CampistryDB.getCampId() });

// Diagnostics
await CampistryDiag.quickCheck();
await CampistryDiag.expoAudit();
await CampistryDiag.tabWalkthrough();

// Blob diff around an action
window._before = JSON.stringify(JSON.parse(localStorage.campGlobalSettings_v1).campistryMe);
// … do the thing …
(function(){ var a=JSON.parse(window._before),
             b=JSON.parse(localStorage.campGlobalSettings_v1).campistryMe;
  return Object.keys({...a,...b}).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])); })();

// Me page save recorder — paste tests/me_page_recorder.js first
MeTestRecorder.report();
```

---

## Regression watch-list

Areas changed most recently, and therefore most likely to have moved under this
plan's feet. Re-check these first on any repeat run.

| Area | Why it is on the list |
|---|---|
| Session planning / workspaces | Newest feature; migrations 193–196; five regressions already found and fixed in `promote_workspace`. |
| Presence / session-aware campers | Changed what every roster, bunk list and print sheet counts. |
| Card capture before submit | Moved money collection to before the form submits. |
| Card fees / surcharge | New policy engine with legal constraints. |
| Registration deposit | New across the public form, the office and the ledger. |
| Tax statement | Brand new, and it goes on a parent's tax return. |
| Cancellation policy + sibling re-pricing | Replaced a once-at-enrollment calculation. |
| Session capacity | Was collected by the dashboard and read by nothing until recently. |
| Public form submission | Was silently failing for every real applicant; fixed twice. |
| Ledger / atomic writes / chargebacks / dunning | Migrations 168–182, all recent, all money. |
| Per-user key RLS | Migrations 160–164; a mistake here locks people out or leaks payroll. |

---

## Sign-off

```
Plan version:        SMOKE_TEST_ROADMAP.md as of <commit sha>
Total cards:         428 (156 marked CORE)
Cards run:
S1 findings open:
Safe to run a real camp on this build?   yes | no | with these caveats:
```
