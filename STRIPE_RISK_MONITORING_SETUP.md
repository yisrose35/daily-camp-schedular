# Stripe Platform Risk Monitoring — Setup

## Why this exists

Every camp's charge is ultimately a **destination charge on Campistry's own
platform Stripe account** — a connected camp only ever *receives a transfer*
(`stripe-connect-onboard-camp` only requests `transfers`, never
`card_payments`). That means the actual charge volume from *every camp
combined* lands on one Stripe account: Campistry's.

Stripe's automated risk systems (and PayFac aggregator model in general) are
tuned to expect gradual, predictable growth. A sudden spike — several camps'
registration windows opening the same week, for example — can trigger an
automated fraud review or a **rolling reserve** (Stripe holding back a
percentage of volume for weeks) even when every charge is completely
legitimate. A reserve on the platform account would delay real payouts
reaching camps' own bank accounts, since the transfer step happens after the
charge.

Stripe's own guidance for avoiding this: keep dispute rates low, respond
fast to their information requests, and — for a *known* upcoming spike —
proactively tell them in advance. This feature is Campistry's early-warning
system for exactly that, so the platform team notices a spike (or a Radar
flag, review, dispute, or failed payout) fast enough to act on it, instead
of finding out only after Stripe has already reacted.

Two pieces, both alerting `campistryoffice@gmail.com`:

1. **Reactive event alerts** (`stripe-webhook`) — fires the moment Stripe
   itself flags something: an early fraud warning, a manual review, a
   dispute (chargeback), or a failed payout.
2. **Proactive volume monitor** (`stripe-risk-volume-monitor`, new function)
   — runs once a day, compares yesterday's total platform charge volume
   against the trailing week, and alerts if it looks like an unusual spike
   *before* Stripe's own systems necessarily would.

Neither of these touches any camp-facing UI or billing data — they're purely
an internal alerting layer for the platform operator.

## One-time setup (all via the Supabase Dashboard — no CLI needed)

### 1. Redeploy `stripe-webhook` with the new risk-alert code

Dashboard → **Edge Functions** → click **stripe-webhook** → open its code
editor → replace the contents with the current
`supabase/functions/stripe-webhook/index.ts` from this repo → **Deploy**.

This is the same function that already handles tuition/canteen/photo
payments — nothing about its existing behavior changes, it just gains a new
branch that fires on four new event types (see step 3).

### 2. Confirm `RESEND_API_KEY` is set

Dashboard → **Edge Functions** → **Secrets**. `RESEND_API_KEY` should
already be there (it's used by `send-invite-email` and others). If it's
missing, add it — the alert emails go out through the same Resend account
as every other Campistry email.

No new secret is needed for `stripe-webhook` itself — the alert address
(`campistryoffice@gmail.com`) is a constant in the code, not a secret.

### 3. Add the four risk events to your existing Stripe webhook endpoint

Stripe Dashboard → **Developers → Webhooks** → click the endpoint already
pointed at `.../functions/v1/stripe-webhook` → **Add events** (or edit the
event list) → add:
- `radar.early_fraud_warning.created`
- `review.opened`
- `charge.dispute.created`
- `payout.failed`

Save. No new endpoint, no new signing secret — this is the same webhook
that already delivers `payment_intent.*` and `setup_intent.succeeded`.

### 4. Create the new `stripe-risk-volume-monitor` function

Dashboard → **Edge Functions** → **Create a new function** → name it
exactly `stripe-risk-volume-monitor` → paste in the full contents of
`supabase/functions/stripe-risk-volume-monitor/index.ts` from this repo →
**Deploy**.

### 5. Set its cron secret

Dashboard → **Edge Functions** → **Secrets** → add a new secret:
```
RISK_MONITOR_CRON_SECRET = <a long random string you make up>
```
This gates the function the same way `INSTALLMENT_CRON_SECRET` already
gates `charge-due-installments` — only a caller who knows the secret can
trigger a run.

### 6. Schedule it with pg_cron

SQL Editor (enable the `pg_cron` and `pg_net` extensions first, in
**Database → Extensions**, if they aren't already on — `charge-due-installments`
likely already turned these on). Run, filling in your project ref and the
secret from step 5:

```sql
select cron.schedule(
  'campistry-risk-volume-monitor-daily',
  '0 12 * * *',                        -- 12:00 UTC daily (before the 13:00 autopay run)
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/stripe-risk-volume-monitor',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<RISK_MONITOR_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

## How to verify it's working

**Reactive alerts (`stripe-webhook`):** Stripe Dashboard → the webhook
endpoint → **Send test webhook** → pick `charge.dispute.created` (or any of
the other three) → Send. Within a minute or two, `campistryoffice@gmail.com`
should get an email titled "Stripe alert: A parent disputed a charge…". Check
the function's logs (Dashboard → Edge Functions → stripe-webhook → Logs) for
a line starting `[stripe-webhook] RISK EVENT:` either way.

**Proactive monitor (`stripe-risk-volume-monitor`):** you can trigger it
manually any time (not just via cron) by POSTing to it with the
`x-cron-secret` header — e.g. from a terminal with `curl`, or any HTTP
client:
```
POST https://<PROJECT_REF>.supabase.co/functions/v1/stripe-risk-volume-monitor
x-cron-secret: <RISK_MONITOR_CRON_SECRET>
```
It always returns a JSON summary (`yesterdayCents`, `baselineAvgCents`,
`spike`, `alertSent`, …) even on a quiet day — an email only goes out when
`spike: true`. Check `Dashboard → Edge Functions → stripe-risk-volume-monitor
→ Logs` to see the daily numbers it's tracking, spike or not.

## Tuning the thresholds

Both are single named constants near the top of each file — safe to change
without touching any other logic:

- `stripe-risk-volume-monitor/index.ts`:
  - `SPIKE_MULTIPLIER` (default `2.5`) — how many times the trailing
    7-day average counts as a spike.
  - `MIN_BASELINE_CENTS_FOR_RATIO` (default `$100`) — below this baseline,
    ratio comparisons are too noisy to trust, so only the absolute check
    applies.
  - `ABSOLUTE_SPIKE_CENTS` (default `$5,000`/day) — fires regardless of
    baseline; the floor to raise as the platform's normal volume grows,
    so this stays "unusual," not "an average Tuesday."
  - `BASELINE_DAYS` (default `7`) — how many prior days form the average.

## What this does NOT do

- It doesn't take any automatic action (pause payments, contact Stripe,
  etc.) — it's purely an alert so a human can decide what to do, since
  the right response (nothing / contact Stripe support / investigate a
  specific camp) depends on context this code can't see.
- It doesn't gate or slow down any camp's actual checkout flow — no
  camp-facing behavior changes at all.
- It reads only aggregate platform-wide charge totals from Stripe's API —
  it never touches `camp_state_kv` or any camp's own data.
