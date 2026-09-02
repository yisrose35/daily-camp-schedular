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

Charges are off-session against a saved card, routed to the camp's own
connected Stripe account (no platform fee, same as every other canteen/tuition
charge). A card that fails 3 times in a row auto-disables auto-reload so it
doesn't keep retrying a dead card — the parent portal shows "Auto-reload
paused" and offers to update the card.

## 1. Run the migration

```
migrations/109_canteen_auto_reload.sql
```

Paste into the Supabase SQL Editor. Adds `set_canteen_auto_reload()` — the
parent-facing RPC that saves the trigger config (threshold/schedule amounts)
onto `camp_state_kv.campistrySnacks.accounts[camperName].autoReload`. It only
ever touches the parent-editable trigger fields; card/attempt bookkeeping
(`cardOnFile`, `lastChargedDate`, `consecutiveFailures`, ...) is written
exclusively by the webhook/cron below.

## 2. Deploy the new Edge Functions

New:
- `stripe-canteen-autoreload-setup` — hosted Stripe page (mode `setup`) to
  save a card/bank account for a specific camper's auto-reload. The canteen
  analog of `stripe-setup-checkout` (tuition), keyed by `camperName` instead
  of `familyKey`.
- `canteen-auto-reload` — the cron-triggered charge runner. Scans every
  camp's canteen accounts for `autoReload.enabled && cardOnFile` and charges
  whichever trigger (threshold or schedule) is due, at most once per
  camper per day.

Changed (redeploy):
- `stripe-webhook` — `setup_intent.succeeded` now branches on
  `metadata.source`: `campistry-canteen-autoreload-setup` routes to the new
  `handleCanteenAutoReloadSetup`, which writes the saved card onto the
  camper's `autoReload` object. Everything else (tuition autopay setup,
  canteen deposits, photo purchases, risk events) is unchanged.

```bash
supabase functions deploy stripe-canteen-autoreload-setup
supabase functions deploy canteen-auto-reload
supabase functions deploy stripe-webhook
```

(No new webhook event registration needed — `setup_intent.succeeded` is
already registered from the tuition autopay setup, see
`BILLING_PAYMENTS_SETUP.md`.)

## 3. Secrets

One new secret, separate from tuition's `INSTALLMENT_CRON_SECRET` so the two
recurring jobs can be rotated/disabled independently:

```bash
supabase secrets set CANTEEN_AUTORELOAD_CRON_SECRET=<a-long-random-string>
```

Reuses `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — all
already set from prior work.

## 4. Schedule the charge runner with pg_cron

Every 30 minutes during camp hours is the suggested cadence — a low balance
should resolve same-day, not wait for a once-a-day job like tuition's. The
per-camper `lastChargedDate` guard caps it at one successful charge per
camper per day regardless of how often the cron fires, so a tighter interval
is safe. Adjust the hours (`7-18` = 7am-6pm UTC — convert to the camp's local
office hours) or interval to taste.

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

You can trigger a run manually (e.g. to verify before waiting for the
schedule) by POSTing to the function with the `x-cron-secret` header:

```bash
curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/canteen-auto-reload' \
  -H 'x-cron-secret: <CANTEEN_AUTORELOAD_CRON_SECRET>'
```

## 5. Verify end to end

Use Stripe **test mode**.

1. As a parent in Link → Canteen, scroll to the new **Auto-Reload** card.
   Turn on "Reload when balance drops below a threshold", set threshold $5 /
   reload $20, Save — since no card is on file yet, this immediately opens
   Stripe Checkout (mode `setup`); complete it with a test card
   (`4242 4242 4242 4242`). Confirm you land back on Canteen with "Auto-reload
   is on" and the card's brand/last4 shown.
2. Manually drop the test camper's balance below $5 (spend it at the POS, or
   edit the balance in the Snacks admin Accounts tab), then trigger the cron
   function manually (step 4's `curl`). Confirm the response shows one
   `"result":"charged"` entry for that camper.
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
