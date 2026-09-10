# Canteen Auto-Reload — Setup

Turns the parent portal's "Auto-Reload" button (Link → Canteen) from a
decorative no-op into a real recurring/threshold top-up, reusing the same
off-session-charge infrastructure already built for tuition autopay
(`stripe-setup-checkout` + `charge-due-installments`, see
`BILLING_PAYMENTS_SETUP.md`) and the same destination-charge / balance model
already built for one-time canteen deposits (`CANTEEN_STRIPE_DEPOSITS_SETUP.md`).

A parent can turn on either or both:
- **Threshold**: "reload $Y whenever the balance drops below $X"
- **Schedule**: "reload $Y every week/month"

Both triggers optionally respect a **start/stop date window** (e.g. just the
camp season) — added by migration 135, see step 1.

Charges are off-session against a saved card, routed to the camp's own
connected Stripe account (no platform fee, same as every other canteen/tuition
charge). A card that fails 3 times in a row auto-disables auto-reload so it
doesn't keep retrying a dead card — the parent portal shows "Auto-reload
paused" and offers to update the card.

**Instant trigger (migration 140):** the recurring `pg_cron` job below is
still the only *scheduled* check, but the POS register (`campistry_snacks_pos.js`)
now also fires an immediate, single-camper check the moment a sale pushes a
balance under threshold — no more waiting up to 30 minutes for the next cron
tick. This needs BOTH the new migration below and a redeploy of
`canteen-auto-reload` with its current code (step 2) — without the redeploy,
the instant call is simply rejected as unauthorized and the cron remains the
only path (same safe fallback either way, just slower).

## One-time setup (all via the Supabase Dashboard — no CLI needed)

### 1. Run the migration

Dashboard → **SQL Editor** → paste the full contents of
`migrations/109_canteen_auto_reload.sql` from this repo → **Run**. Then do
the same with `migrations/135_canteen_auto_reload_date_range.sql` (if 109
was already run previously, 135 is the only new one you need — it just
extends the same RPC to also accept an optional `startDate`/`stopDate`).

Adds `set_canteen_auto_reload()` — the parent-facing RPC that saves the
trigger config (threshold/schedule amounts, plus the optional active-date
window) onto `camp_state_kv.campistrySnacks.accounts[camperName].autoReload`.
It only ever touches the parent-editable trigger fields; card/attempt bookkeeping
(`cardOnFile`, `lastChargedDate`, `consecutiveFailures`, ...) is written
exclusively by the webhook/cron below.

Then paste and run `migrations/140_canteen_instant_autoreload_flag.sql`,
followed by `migrations/141_canteen_instant_autoreload_utc_fix.sql` — 140
enables the instant-trigger feature above, 141 fixes a same-day timezone
bug in it (the client's local date vs. the UTC date `lastChargedDate` is
actually written in — confirmed live, it silently made the pre-check think
"already charged today" a few hours early/late depending on the POS's local
timezone). If you already ran 140 before 141 existed, just run 141 on top —
both are `CREATE OR REPLACE` of the same function, safe to re-run even on a
camp already taking live POS sales.

Also run `migrations/143_canteen_auto_reload_frequency_cap.sql` (parent
"up to N reloads every M days" cap) and `migrations/144_canteen_autoreload_state_atomic.sql`.
144 is REQUIRED for Cardknox auto-reload to credit at all — without it, the
edge function's own end-of-run blob write erased the balance credit it had
just committed (the money left the card, the deposit never appeared in the
camper's balance). Redeploy `canteen-auto-reload` (step 2) after running 144.

### 2. Create the two new Edge Functions

If you already deployed `canteen-auto-reload` before (pre-135), just
redeploy it with the current `supabase/functions/canteen-auto-reload/index.ts` —
Dashboard → **Edge Functions** → click **canteen-auto-reload** → open its
code editor → replace the contents → **Deploy**. That's what actually
enforces the new start/stop window; the migration above only stores it.

Dashboard → **Edge Functions** → **Create a new function** → name it exactly
`stripe-canteen-autoreload-setup` → paste in the full contents of
`supabase/functions/stripe-canteen-autoreload-setup/index.ts` from this repo
→ **Deploy**. Hosted Stripe page (mode `setup`) to save a card/bank account
for a specific camper's auto-reload — the canteen analog of
`stripe-setup-checkout` (tuition), keyed by `camperName` instead of
`familyKey`.

Repeat: **Create a new function** → name it exactly `canteen-auto-reload` →
paste in the full contents of `supabase/functions/canteen-auto-reload/index.ts`
→ **Deploy**. This is the cron-triggered charge runner — scans every camp's
canteen accounts for `autoReload.enabled && cardOnFile` and charges whichever
trigger (threshold or schedule) is due, at most once per camper per day.

### 3. Redeploy `stripe-webhook`

Dashboard → **Edge Functions** → click **stripe-webhook** → open its code
editor → replace the contents with the current
`supabase/functions/stripe-webhook/index.ts` from this repo → **Deploy**.

`setup_intent.succeeded` now branches on `metadata.source`:
`campistry-canteen-autoreload-setup` routes to the new
`handleCanteenAutoReloadSetup`, which writes the saved card onto the
camper's `autoReload` object. Everything else (tuition autopay setup,
canteen deposits, photo purchases, risk events) is unchanged. No new webhook
event registration needed in Stripe — `setup_intent.succeeded` is already
registered from the tuition autopay setup (see `BILLING_PAYMENTS_SETUP.md`).

### 4. Set the cron secret

Dashboard → **Edge Functions** → **Secrets** → add a new secret:
```
CANTEEN_AUTORELOAD_CRON_SECRET = <a long random string you make up>
```
Kept separate from tuition's `INSTALLMENT_CRON_SECRET` so the two recurring
jobs can be rotated/disabled independently. `STRIPE_SECRET_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` should already be set from prior
work — nothing new needed there.

### 5. Schedule the charge runner with pg_cron

SQL Editor (enable the `pg_cron` and `pg_net` extensions first, in
**Database → Extensions**, if they aren't already on — `charge-due-installments`
likely already turned these on). Every 30 minutes during camp hours is the
suggested cadence — a low balance should resolve same-day, not wait for a
once-a-day job like tuition's. The per-camper `lastChargedDate` guard caps it
at one successful charge per camper per day regardless of how often the cron
fires, so a tighter interval is safe. Run, filling in your project ref and
the secret from step 4 (adjust the hours — `7-18` = 7am-6pm UTC, convert to
the camp's local office hours — or interval to taste):

```sql
select cron.schedule(
  'campistry-canteen-autoreload',
  '*/30 7-18 * * *',                   -- every 30 min, 7am-6pm UTC
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/canteen-auto-reload',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CANTEEN_AUTORELOAD_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

## How to verify it's working

Use Stripe **test mode**. You can trigger the runner manually at any time
(not just via cron) by POSTing to it with the `x-cron-secret` header — e.g.
from PowerShell:
```powershell
Invoke-RestMethod -Method Post -Uri 'https://<PROJECT_REF>.supabase.co/functions/v1/canteen-auto-reload' -Headers @{ 'x-cron-secret' = '<CANTEEN_AUTORELOAD_CRON_SECRET>' }
```
It always returns a JSON summary (`charged`, `failed`, `details[]`) even when
nothing was due. Check `Dashboard → Edge Functions → canteen-auto-reload →
Logs` to see what it saw on each run.

1. As a parent in Link → Canteen, scroll to the new **Auto-Reload** card.
   Turn on "Reload when balance drops below a threshold", set threshold $5 /
   reload $20, Save — since no card is on file yet, this immediately opens
   Stripe Checkout (mode `setup`); complete it with a test card
   (`4242 4242 4242 4242`). Confirm you land back on Canteen with "Auto-reload
   is on" and the card's brand/last4 shown.
2. Manually drop the test camper's balance below $5 (spend it at the POS, or
   edit the balance in the Snacks admin Accounts tab), then trigger the
   runner manually (the PowerShell command above). Confirm the response shows
   one `"result":"charged"` entry for that camper.
3. Within moments, confirm the balance increased by $20 in both Link and the
   Snacks admin dashboard, and a transaction with method "stripe"/kind
   "deposit" appears — this is the *existing* `handleCanteenDeposit` webhook
   path crediting it, proving the metadata-based reuse works.
4. Trigger the cron function again immediately — confirm the same camper is
   NOT charged again (already reloaded today).
5. Switch the test card to a guaranteed-decline test card
   (`4000 0000 0000 0002`) via "Update card", then force the threshold
   condition again and trigger the cron 3 times (on 3 different simulated
   days, or by manually clearing `lastChargedDate` between runs) — confirm
   `consecutiveFailures` reaches 3 and `autoReload.enabled` flips to `false`,
   and the parent portal shows "Auto-reload paused — your card was declined."
6. Confirm "Turn off" disables auto-reload without losing the saved
   threshold/schedule amounts (re-enabling later shouldn't require
   re-entering them).
7. Confirm the pre-existing "Add Funds" manual deposit flow is unaffected.
8. **Date window (135):** set "Active dates" → Stop to yesterday, Save.
   Force the threshold condition and trigger the cron — confirm the response
   has no entry for that camper (silently skipped, not failed) and the
   portal shows "window ended ... — update the dates to resume". Change Stop
   to a future date (or clear both fields) and trigger again — confirm it
   charges normally. Also confirm Start in the future behaves the same way
   ("starts <date>", no charge yet).
