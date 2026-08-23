# Real Stripe Payments for Campistry Canteen — Setup

Lets a parent's "Add Funds" click become a real charge that lands in the
camp's own bank account, instead of the previous fake system (a parent
could inflate their own kid's canteen balance for free — no payment was
ever collected). See `/root/.claude/plans/bubbly-jingling-kite.md` (this
session) for the full design writeup.

Reuses the same per-camp Stripe Connect account already built for tuition
(`CAMP_STRIPE_CONNECT_SETUP.md`) — a camp connects Stripe **once**, shared
across tuition and canteen alike. **No platform fee** (camp keeps 100%).
Refunds are owner+admin only, cap at whatever's still unspent in the
wallet, and block with a clear message if it's already fully spent.

## 1. Run the migration

```
079_canteen_stripe_deposits.sql
```

Paste into the Supabase SQL Editor. Safe to re-run except for the
`REVOKE EXECUTE ... FROM authenticated` line on `submit_canteen_deposit` —
that's the point of this migration (closing the free-money bug), don't
skip it or re-grant it back afterward.

## 2. Deploy the new + changed edge functions

New:
- `stripe-canteen-refund` — JWT verification **on** (default). Called by a
  signed-in owner/admin from the Snacks Accounts tab.

Changed (redeploy):
- `stripe-checkout` — now accepts canteen deposits (`source:
  'campistry-canteen-deposit'`, `camperName`) alongside the existing
  tuition Pay Link shape. A canteen deposit with no matching camper on the
  roster, or for a camp that hasn't connected Stripe, is now a hard
  rejection (400) — deliberately stricter than the tuition path, since a
  canteen credit landing on the wrong camper's name (or with nowhere real
  to route to) is a ledger-integrity problem, not just a routing one.
- `stripe-webhook` — now branches on `metadata.source`: a canteen deposit
  credits `campistrySnacks` via the new `credit_canteen_balance_from_stripe`
  RPC instead of writing into the tuition ledger (`campistryMe.finance.payments`).
  Either/or, never both.

## 3. Secrets

No new secrets — reuses `STRIPE_SECRET_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, all already set from
prior work.

## 4. No new webhook registration needed

`stripe-webhook` is the same existing endpoint tuition already uses — a
canteen deposit's PaymentIntent fires the identical `payment_intent.*`
events on the platform account (it's still a destination charge created on
the platform, same as tuition). Nothing new to register in Stripe.

## 5. Verify end to end

Use Stripe **test mode**.

1. As a camp owner, confirm the camp shows "Connected" on the Dashboard's
   Stripe Connect card (`CAMP_STRIPE_CONNECT_SETUP.md`) — canteen deposits
   are hidden/disabled in Link until this is true.
2. As a parent in Link → Canteen, confirm "Add Funds" is enabled (greyed
   out with a tooltip if the camp hasn't connected — test that state too
   by trying this on an unconnected test camp first).
3. Pick an amount, click Add Funds → redirected to Stripe Checkout → pay
   with a test card (`4242 4242 4242 4242`) → redirected to the thanks
   page (should say "Your canteen funds are on their way").
4. Within moments, confirm the camper's canteen balance in Link increased
   by exactly the paid amount, and a transaction with method "stripe"/kind
   "deposit" shows up. In the Snacks admin dashboard (Accounts tab), the
   same balance change should be visible.
5. In Stripe's test dashboard, confirm the charge shows a transfer to the
   camp's connected test account, not the platform balance.
6. Resend the same webhook event from Stripe's dashboard (or trigger a
   genuine retry) — confirm the balance does NOT get credited twice.
7. Spend part of the deposit at the POS terminal (`campistry_snacks_pos.js`
   or the desk order flow), then in the Accounts tab click **Refund** for
   that camper, pick the Stripe deposit → confirm it caps at what's left
   unspent, shows "(capped to what was left)" if applicable, and the
   Stripe test dashboard shows the connected account's balance debited
   back. Then try refunding a deposit that's been fully spent — confirm
   the "already spent" block.
8. Confirm the office's manual **+ Deposit** button (cash/check/Zelle
   handed over at the desk) still works exactly as before, regardless of
   whether the camp has connected Stripe — it never touches Stripe.

## What's NOT in this pass

- **Camp Shop / swag store payments** — a separate feature
  (`campistryShop`), not touched here. Its "Charge to camp bill" and
  "Charge to canteen balance" pay methods still work exactly as before
  (the latter now draws from a canteen balance that's finally backed by
  real money, which is a strict improvement, but the Shop's own order flow
  itself wasn't changed).
- **Link photo purchases** — a separate, not-yet-built feature (next up
  after this).
- **Auto-Reload** — the canteen page's "Auto-Reload" button is still a
  decorative no-op (`toast('Auto-reload enabled!')` and nothing else) —
  pre-existing, not addressed by this pass.

## Migration SQL

See `migrations/079_canteen_stripe_deposits.sql` for the full, commented
SQL — not duplicated here to avoid the two copies drifting apart.
