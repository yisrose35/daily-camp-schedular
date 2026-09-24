# BYOP (Bring-Your-Own Processor) — Setup & Status

## What this is

Some camps already run tuition/canteen billing through their own negotiated
merchant account (Banquest, Cardknox/Sola Payments, etc.) — often paired
with a cash-discount or surcharge program that nets them close to $0 in
processing fees. Forcing those camps onto Campistry's Stripe Connect setup
would mean giving that up, which is a real reason a prospect could walk.

BYOP lets a camp keep their own processor. It is **not** Stripe Connect's
model — Campistry never becomes a payment facilitator for Banquest/
Cardknox/etc. A camp that wants this already has their own merchant account
and contract with that processor, entirely independent of Campistry. The
integration is just: Campistry's edge functions call that processor's API
using that camp's own credentials, instead of Stripe's.

**Every existing camp is unaffected.** Every camp defaults to `stripe` and
nothing changes unless a camp is explicitly walked through the setup below.

## What's built right now

- **Migrations `126_byop_processor_framework.sql` and
  `127_add_banquest_processor.sql`** — the extensible processor catalog,
  `camps.payment_processor_key`, the (Vault-backed, never-plaintext)
  credential storage table, the processor-agnostic transaction log, and the
  catalog row registering Banquest. Paste both into the Supabase SQL
  Editor, in order.
  - If `CREATE EXTENSION supabase_vault` (in 126) fails with a permissions
    error, enable it once via **Dashboard → Database → Extensions →
    search "supabase_vault" → Enable**, then re-run that migration.
- **A real, extensible adapter framework**
  (`supabase/functions/_shared/processor_adapter.ts`) — adding processor #4
  later means writing one new file that implements `ProcessorAdapter`
  (`charge`/`refund`/`testConnection`) and registering it in that file's
  `ADAPTERS` map, plus one `INSERT` into `payment_processor_catalog`. No
  other code changes, ever, for a new processor.
- **Two adapters: Cardknox / Sola Payments, and Banquest**
  (`supabase/functions/_shared/adapters/cardknox_adapter.ts` and
  `banquest_adapter.ts`) — written against each gateway's documented API
  shape (Cardknox's own xWeb API; Banquest's underlying NMI gateway's
  classic Direct Post/Query API — Banquest is a white-label reseller on
  NMI, confirmed this session).
  **⚠️ Neither is tested against a live account yet** — this environment
  has no Cardknox/Sola or Banquest/NMI developer credentials. Before
  connecting a real camp: get a **sandbox** credential from that
  processor, run the test-connection step below against it, and do one
  real charge + refund round-trip before ever pointing either adapter at a
  real camp's production key. Banquest specifically: white-label NMI
  resellers often issue their own branded gateway hostname rather than
  using `secure.nmi.com` directly — the adapter's `gatewayUrl` credential
  field is exactly for that; confirm the real one with Banquest/the camp
  during onboarding rather than assuming the default.
- **Five edge functions**: `payments-charge`, `payments-refund` (the BYOP
  equivalents of `stripe-charge`/`stripe-refund` — same auth model, camp
  always derived from the caller's own session, never a client-supplied
  campId), `payments-save-method` (turns a client-side tokenization result
  into a durable saved payment method on a family's record — see below),
  `payments-checkout` (the "Pay Link" equivalent — no session, since the
  parent has none; tokenizes+saves+charges in one call and records the
  result into `campistryMe.finance.payments`, the exact same array
  `stripe-webhook` writes Stripe online payments into, so Billing's balance
  math is identical regardless of processor), and `admin-connect-processor`
  (the human-assisted onboarding tool, see further down).
- **A real saved-payment-method AND pay-now flow for Banquest**:
  `campistry_card_setup.html` is a public page that loads NMI's Collect.js
  (Banquest's client-side card tokenizer — raw card numbers never reach
  Campistry's servers, same PCI-scope role Stripe.js already plays),
  tokenizes the card, and posts the resulting token to either
  `payments-save-method` (default — saves a card for later) or
  `payments-checkout` (when the URL carries an `amount` — a one-time
  payment link, the BYOP equivalent of a Stripe Checkout session; the
  token still gets saved along the way as a free bonus, same
  `family.byopCustomerRef`/`family.cardOnFile` write). The office Billing
  page's "Get Card"/"Charge Card"/"Send Payment Link" buttons
  (`requestCardSetup()`/`chargeStoredCard()`/`sendPayLink()` in
  `campistry_me.js`) all check the camp's processor and route to this page
  (or `payments-charge`) automatically for a BYOP camp — completely
  unchanged for a Stripe camp. A new anon-safe RPC,
  `get_camp_public_tokenization_key` (migration 128), lets that public page
  fetch ONLY the non-secret public tokenization key needed by Collect.js —
  the private security key never leaves the server.
- **The office "Issue Credit/Refund" modal** (`issueCreditForFamily()` in
  `campistry_me.js`) now recognizes a payment tagged `byopTransactionId`
  the same way it already recognized `stripePaymentIntentId` — "Direct
  Refund" on a BYOP-charged payment calls `payments-refund` (authenticated,
  owner/admin session) instead of `stripe-refund`.
- **⚠️ SUPERSEDED, kept for history only — do not follow this bullet.**
  Cardknox/Sola card entry does NOT use the embedded iFields widget
  described below any more. `campistry_card_setup.html`'s own comment says
  so directly: *"Nothing routes a Sola camp here"* — `renderCardknoxForm`
  was removed from the file entirely. Every Cardknox/Sola camp collects
  cards on Sola's own hosted checkout page instead (see the "Cardknox/Sola's
  real hosted checkout page" bullet further down, and `cardknox-checkout-start`).
  `ifieldsKey` is consequently DEAD — nothing reads it anywhere in the live
  code — and is not a required credential. Do not add it when connecting a
  camp; the admin tool (`admin_connect_processor.html`) no longer asks for it.
- **Cardknox/Sola's own client-side tokenizer (iFields)** — historical, see
  the superseded notice just above — alongside Banquest's Collect.js —
  `campistry_card_setup.html` used to render a real form for either
  processor (`renderCardknoxForm`/`renderBanquestForm`, picked by
  `get_camp_public_tokenization_key`'s `processorKey`).
  **⚠️ TOKENIZE→SAVE ROUND-TRIP NOT YET VERIFIED AGAINST A LIVE SANDBOX** —
  written from Cardknox's own published sample
  (`github.com/Cardknox/cardknox-ifields-sample`; each sensitive field is
  its own hosted iframe; `ifields.min.js` wires them up and `getTokens()`
  returns each field's Secure Usage Token). Live testing caught one real
  bug already: the card-number iframe was missing its `src` attribute
  entirely (Cardknox's field page lives at `.../ifield.htm`, a different
  path than the `ifields.min.js` library) — without it the iframe never
  loaded Cardknox's field page and was just a blank, non-interactive box.
  Fixed, pinned to `2.5.1905.0801` (the exact version in Cardknox's own
  sample, both for the script and the iframe `src` — they must match) for
  both the script and iframe. Run one real
  tokenize→save round-trip before relying on it for a real camp — same
  disclaimer the Banquest widget already carried before it shipped.
  **A camp connected to Cardknox/Sola BEFORE migration 133 needs one more
  `admin-connect-processor` run** with `ifieldsKey` added to its
  `credentials` (see the curl example below) — without it, this widget
  shows "This camp hasn't finished setting up online payments yet." even
  though the camp is genuinely connected and verified; the private `apiKey`
  alone was never enough to power a client-side tokenizer.
- **Canteen deposits ("Add Funds") and refunds**, mirroring the tuition
  pay-link/refund pattern exactly: `payments-canteen-checkout` (parent-
  facing, no session — tokenizes+saves+charges in one call, credits
  `camp_state_kv.campistrySnacks` via `credit_canteen_balance_from_processor`,
  migration 132) and `payments-canteen-refund` (owner/admin session,
  apportions one requested dollar amount across as many of a camper's
  BYOP-backed deposits as needed, mirroring `stripe-canteen-refund`'s own
  multi-deposit logic). `addFunds()` in `campistry_link_parent.html` and
  `refundCanteenDeposit()` in `campistry_snacks.js` both now check the
  camp's processor and route accordingly — completely unchanged for a
  Stripe camp. `get_camp_canteen_stripe_status` (despite its Stripe-era
  name, kept rather than adding a second RPC) now returns `connected:true`
  for EITHER a charges-enabled Stripe account OR a verified BYOP
  credential, plus `processorKey`.
- **Dashboard status card** ("Payment processor," next to the existing
  Stripe Connect card) — read-only, shows which processor a camp is on.
- **Cardknox/Sola's real hosted checkout page** (their own product —
  confirmed live at `https://secure.cardknox.com/<slug>`, and separately
  configurable as "PaymentSITE"/"Sola Checkout" in their dashboard) for
  tuition pay links and canteen deposits — used INSTEAD of the embedded
  iFields widget for `payment_processor_key = 'cardknox'` specifically
  (Banquest still uses the embedded Collect.js widget; it has no known
  hosted-checkout equivalent). `cardknox-checkout-start` (no session, same
  ownership checks as `payments-checkout`/`payments-canteen-checkout`)
  mints a link to that page with the amount pre-filled (`?xAmount=`) and a
  fresh reference passed as `?xInvoice=`; `cardknox-webhook` (public,
  PIN-verified) is the actual source of truth — it receives Sola's async
  notification once the parent completes payment on Sola's own page and
  verifies the `ck-signature` header per Sola's documented algorithm
  (`docs.solapayments.com/products/webhooks`).
  **⚠️ Live-tested 2026-09-08, found a real gap**: `ck-signature`
  verification works correctly (confirmed against a real payment), but
  Sola's HOSTED CHECKOUT webhook does not echo `xInvoice` back at all — its
  payload is a fixed small set of fields (`xAmount`/`xEnteredDate`/
  `xMaskedCardNumber`/`xRefNum`/`xRequestAmount`/`xResponseResult`/
  `xToken`), unlike what Sola's Direct API docs describe for a merchant
  reference field. `cardknox-webhook` now falls back to matching the single
  still-pending intent for that camp at the same dollar amount (within a
  7-day lookback) when no `xInvoice` comes through — the only correlation
  left, since Sola's hosted checkout doesn't carry anything else through.
  Two pending intents at the same amount for the same camp is the one case
  this can't resolve automatically; it's logged as ambiguous and left
  pending for manual reconciliation rather than guessed at. Then credits
  the SAME downstream ledgers the synchronous iFields path already writes
  to (canteen: `credit_canteen_balance_from_processor`; tuition:
  `campistryMe.finance.payments`) — idempotent on `xRefNum`, same as every
  other BYOP transaction id. The browser redirect (Sola's "Redirect on
  success/error" dashboard fields) is cosmetic UX only, never the thing
  that credits money — see the **per-camp webhook setup** section below,
  this needs real configuration in each Cardknox-connected camp's own Sola
  dashboard, not just Campistry's side.
  **⚠️ Verified signature + amount-fallback crediting path is live-tested;
  NOT yet verified with two simultaneous same-amount pending intents for
  one camp** (the ambiguous case) — that's a rare enough real-world
  scenario that it wasn't worth manufacturing in this session, but worth
  knowing about if it ever comes up.

## Edge Function JWT verification settings (the step that's easy to miss)

Every BYOP edge function that's called with **no session** (a parent/office
page has nothing to authenticate with beyond the plain anon key) needs
**JWT verification OFF** in the Supabase Dashboard, or the request never
reaches the function's own code at all — Supabase's gateway-level JWT check
rejects it first, including the browser's CORS preflight (`OPTIONS`)
request, which has no way to carry a real bearer token either. This is
exactly the failure this session hit live: `cardknox-checkout-start` was
deployed with JWT verification still on (Supabase's default), so every
preflight came back 401 with no CORS headers on it, and Chrome reported it
as a generic "has been blocked by CORS policy... does not have HTTP ok
status" — not an actual CORS bug, just JWT verification silently eating
the request before CORS ever entered the picture. Same root cause and same
fix as `pos-pin-login`/`secure-login` elsewhere in this codebase.

Turn **JWT verification OFF** for each of these (Dashboard → Edge Functions
→ `<name>` → Settings → toggle off "Enforce JWT Verification" → redeploy;
on a first-time deploy there's usually the same toggle right on the
create/deploy screen instead):
- `payments-checkout`
- `payments-canteen-checkout`
- `payments-save-method`
- `cardknox-checkout-start`
- `cardknox-webhook` (Cardknox's own servers call this directly with no
  Supabase auth at all — PIN verification inside the function is the real
  security check here, same shape as `telnyx-sms-webhook`)
- `charge-due-installments` (not BYOP-specific — the shared daily autopay
  runner, Stripe and BYOP alike — but hit live this session: pg_cron's
  `net.http_post` call only ever sends the `x-cron-secret` header per
  `BILLING_PAYMENTS_SETUP.md`, never a Supabase `Authorization` header, so
  with JWT verification on, the gateway 401s it before the function's own
  secret check runs at all — same failure mode as `pos-pin-login`, just
  discovered from the cron side instead of a browser CORS error. If this
  was ever on, the daily autopay job has likely been silently 401'ing since
  it was built; check for a run of successful invocations in this
  function's own Logs tab after fixing it, not just the next one)

Leave JWT verification **ON (the default)** for everything else in this
feature — `payments-charge`, `payments-refund`, and
`admin-connect-processor` are all called with a real owner/admin session
(or the service-role key), and turning it off there would be a real
security regression, not a fix.

Turning it off for the functions above is safe: none of them trust the
caller's JWT for anything — the real checks (does this camp own this
family/camper, is the processor connected and verified, does the
`ck-signature`/PIN check out) all run against the service-role client and
the request body, completely independent of whatever's in the
Authorization header.

## What's built, but only for Cardknox/Sola so far

- **Autopay installments (`charge-due-installments`)** — a family's saved
  card (`byopCustomerRef`, vaulted via `cardknox-webhook`'s card_save/
  tuition-payment branches or `payments-save-method`) is charged with a
  direct `cc:sale` gateway call, no webhook round trip needed since the
  charge is synchronous. Live-tested end to end with a real $5 charge —
  see `record_processor_transaction`/`me.finance.payments` for how it's
  recorded. Banquest camps fall through to `skipped_no_processor` (stays
  pending, retries next run) rather than erroring or guessing.
- **Canteen auto-reload (`canteen-auto-reload`)** — same two-path shape as
  every other canteen money-mover: a Stripe-saved card
  (`autoReload.stripeCustomerId`) still goes through Stripe Checkout
  (setup mode) + the async webhook credit; a Cardknox-saved card
  (`autoReload.byopCustomerRef`, saved via `cardknox-checkout-start`'s
  `canteen_autoreload_setup` kind — migration 136 — instead of
  `stripe-canteen-autoreload-setup`) is charged directly and CREDITED
  DIRECTLY by this function itself (`credit_canteen_balance_from_processor`),
  since there's no webhook for a direct gateway charge to wait on. Both
  "Add a card"/"Update card" (parent-initiated) and the threshold/schedule
  cron trigger go through this — a Cardknox camp's parents were previously
  silently routed to Stripe's setup page regardless of what the camp
  actually connected, and the cron had no Cardknox branch at all. Fixed
  together since neither half is useful without the other.
  **⚠️ Requires `cardknox-checkout-start` to be redeployed** if the version
  live on Supabase predates this feature — its `canteen_autoreload_setup`
  kind (exempt from the "amount required" check, since saving a card
  charges nothing) was added in the same commit as this section. Live-hit
  symptom, straight from a phone: routing correctly goes to Cardknox now,
  but saving still fails with **"Could not start setup: campId, kind, and
  amount are required"** — that exact message means the deployed function
  is stale, not that anything in this repo is broken. Redeploy the current
  `supabase/functions/cardknox-checkout-start/index.ts` via the Dashboard
  to fix it; no code change needed.

## "Charge my card on file" — one-off tuition/canteen shortcut

Neither tuition's Pay Now nor canteen's Add Funds ever reused a saved card
for a manual, one-off payment before this — only the fully-automatic paths
above (autopay installments, canteen auto-reload) did. A parent who already
has a card on file (Stripe or BYOP) still had to re-enter payment details
through hosted Checkout every time they wanted to pay something themselves.

- **Migration `137_saved_card_charge.sql`** — re-extends `get_my_balance`
  (originally migration 118) with three new fields: `chargeable` (mirrors
  the office-side `_famChargeable(f)` check in `campistry_me.js` —
  `byopCustomerRef` truthy, OR `stripeCustomerId` + `cardOnFile`),
  `processorKey`, and `cardLabel`. Also adds `saved_card_charge_locks` (an
  idempotency-lock table keyed on a client-supplied `idempotency_key`,
  pruned by `_prune_saved_card_charge_locks`, service-role only).
- **Edge function `supabase/functions/charge-saved-card/index.ts`** — the
  one function both surfaces call. Unlike every anon-key checkout-starting
  function elsewhere in this codebase, this one **requires the caller's
  real session JWT** (same `asUser` pattern as `get-photo-urls`) since it
  moves money with no hosted checkout page in front of it at all. Verifies
  ownership via `get_my_balance`, takes the idempotency lock, re-reads the
  family's actual saved-card fields from `camp_state_kv`, branches on
  `processorKey` (Cardknox direct `cc:sale` vs. Stripe off-session charge),
  then records the result via `record_processor_transaction` (canteen: also
  `credit_canteen_balance_from_processor`; tuition: appends into
  `me.finance.payments` with an optimistic-retry upsert loop).
- **`campistry_link_parent.html`** — a "Charge {card label} instead" row
  appears next to tuition's Pay Now amount field (`#lkPayChargeSavedRow`)
  and canteen's Add Funds buttons (`#canteenChargeSavedRow`), only when
  `get_my_balance`'s `chargeable` flag is true for that family. Both go
  through a dedicated in-app confirm overlay (`lkChargeConfirm` —
  deliberately separate from the existing delete-confirm overlay, with no
  "don't ask again" opt-out, since this moves real money) rather than
  `window.confirm()`, which this app's Capacitor WebView doesn't reliably
  support (see the comment above `payNow()`). Canteen reuses the exact
  same `_balByCamp[campId]` data tuition already fetches — a family's saved
  card is shared across both, so no separate RPC call was needed there.
- **Deploy steps (manual, per this project's no-CLI rule)**: paste migration
  137 into the SQL Editor, then deploy `charge-saved-card` as a new Edge
  Function via the Dashboard (Edge Functions → Deploy → paste the file's
  full contents — same env vars as every other Stripe/Cardknox function:
  `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`). Leave **JWT verification ON** (the default,
  same as `payments-charge`/`payments-refund` above) — do NOT add it to the
  JWT-off list in the section above; this function deliberately requires
  the caller's real identity, unlike every anon-key checkout-starting
  function elsewhere in this doc. Untested against a live account in this
  environment (no Cardknox/Stripe test credentials here) — run one real
  test charge against a sandbox card on file before relying on it for a
  live camp.

## What's deliberately NOT built yet (flagged, not silently skipped)

- **Accept Blue adapter** — the catalog/framework supports it the moment
  someone writes the adapter file; not built yet (Banquest and Cardknox/
  Sola were prioritized since those are what the actual at-risk camp uses).

## How to connect a camp (human-assisted, on purpose)

### The required checklist — every camp, every time

A camp is not onboarded when it can take money. It's onboarded when it can
also give money back and be told when someone takes money back. Work through
all of these:

| # | Step | Skipping it means |
|---|------|-------------------|
| 1 | `admin-connect-processor` call (below) | Nothing works — this one is obvious |
| 2 | **Dispute webhook in the camp's processor dashboard** | A chargeback pulls money out of the camp's bank account and Campistry keeps showing the payment as collected. **Silent.** |
| 3 | **One real test dispute, then read the logs** | The dispute mapping is unproven for that processor |
| 4 | Cardknox only: Postback URL + PIN | Hosted-checkout payments never reach Campistry |
| 5 | Cardknox only: success/error redirects | Parents finish on Sola and never come back to the app |
| 6 | If this is the **2nd+** camp on that processor: go back and add `&camp=` to the earlier camps' dispute URLs | Their disputes silently stop being recorded |

**You don't have to remember this table.** Step 1 returns the rest in a
`remainingSetup` array with the real URLs already filled in for that camp —
including whether `&camp=` is needed, which it works out by counting rather
than by anyone remembering, and including step 6 with the affected camp ids
listed. Read what the connect call hands back and do what it says. This table
is here so the shape of the job is visible before you start.

Steps 2 and 3 are the ones worth being stubborn about. Everything else on this
list fails loudly on the first attempt — a wrong PIN, a broken redirect, a
camp that can't take a payment all get noticed the same day. A missing dispute
webhook shows no symptom at all until months later, when the books turn out to
have been overstating collected cash the whole time.

### The connect call

This is intentionally not a self-serve Dashboard form — a live processor
API key can move real money out of a camp's own account if mishandled, so
a Campistry staffer verifies the camp (by call/support channel) before
ever entering it. Once verified, from a terminal (or any HTTP client):

```bash
curl -X POST "https://<your-project>.supabase.co/functions/v1/admin-connect-processor" \
  -H "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "campId": "<the camp'"'"'s id>",
    "processorKey": "banquest",
    "credentials": { "sourceKey": "<the camp'"'"'s Banquest source key>", "pin": "<the camp'"'"'s Banquest pin>", "tokenizationKey": "<the camp'"'"'s Banquest tokenization key, for the Collect.js card widget>" },
    "notes": "Confirmed via call with <name>, <date>"
  }'
```

(Banquest runs on the AffiniPay/8am gateway, not NMI — an earlier version of
this doc and of `banquest_adapter.ts` wrongly assumed NMI's "security key"
model; corrected against a live sandbox. The real credential shape, matching
`admin-connect-processor`'s and `banquest_adapter.ts`'s own code, is
`sourceKey` + `pin` for HTTP Basic auth on server-side charge/refund calls,
plus `tokenizationKey` for the client-side Collect.js widget. A stored
`gatewayUrl`/`tokenizationUrl` is optional, only needed if Banquest gave the
camp environment-specific hostnames instead of the shared default.)

(For Cardknox/Sola instead: `"processorKey": "cardknox"`,
`"credentials": { "apiKey": "<the camp's private xKey>", "checkoutSlug":
"<the camp's secure.cardknox.com/ URL slug>", "webhookPin": "<a fresh 15+
character alphanumeric PIN you generate>" }` — `apiKey` for server-side
charge/refund calls, `checkoutSlug` + `webhookPin` for the hosted-checkout
flow (migration 134, see the **per-camp webhook setup** section below —
`webhookPin` must be the EXACT same value you also paste into that camp's
own Sola dashboard). `ifieldsKey` is NOT needed — see the superseded notice
above; card entry happens on Sola's own hosted page, not an embedded
widget, so there is no client-side tokenizer key to store. If
Banquest gave the camp their own branded gateway hostname rather than the
shared NMI one, add it as `"gatewayUrl": "https://secure.example.com"`
inside `credentials`.)

### Per-camp webhook setup (Cardknox/Sola only — required for hosted checkout)

Beyond the `admin-connect-processor` call above, each Cardknox-connected
camp's OWN Sola dashboard needs three things configured by hand (their
account, not Campistry's — walk the office through this, or do it together
on a call):

1. **Portal Settings → Gateway Settings → Webhook Settings** — set
   **Postback URL** to:
   `https://<your-project>.supabase.co/functions/v1/cardknox-webhook?campId=<the camp's id>`
   and **PIN** to the exact same `webhookPin` value stored in `credentials`
   above (15+ alphanumeric characters, no symbols — Sola's own rule).
2. **Gateway Settings → Sola Checkout (or PaymentSITE)** — note the URL
   slug shown (e.g. `secure.cardknox.com/campistrydev` → slug is
   `campistrydev`) — that's the `checkoutSlug` value above.
3. Same screen, **Redirect on success** / **Redirect on error** — set both
   to `https://link.campistry.org/campistry_link_parent.html` (a single
   static URL, not dynamic per-transaction — the actual crediting happens
   via the webhook above regardless of what this redirect does; it only
   brings the parent back into the app after they finish on Sola's page).

The `SUPABASE_SERVICE_ROLE_KEY` is the same key already in **Supabase
Dashboard → Settings → API** — the same one cron jobs use internally. It's
the only thing authorized to call this function; nothing new to create or
distribute.

This call **tests the credential for real** against the processor's own
API before storing anything — a bad/typo'd key is rejected immediately with
a clear error, never silently saved. On success, the camp's
`payment_processor_key` flips from `stripe` to `banquest` (or `cardknox`)
and the Dashboard status card updates on next load.

To disconnect a camp, run in the SQL Editor. Note the target is `'none'`, not
`'stripe'` — since migration 153 Stripe is one choice among several rather
than the default, so sending a camp back to `'stripe'` would claim it chose
Stripe and route its tuition through a Connect account it may not have:

```sql
UPDATE camps SET payment_processor_key = 'none' WHERE id = '<camp id>';
DELETE FROM camp_processor_credentials WHERE camp_id = '<camp id>';
-- (the underlying Vault secret is orphaned, not deleted, by this alone —
--  acceptable for now given how rarely this runs; a follow-up RPC can
--  clean it up properly if this becomes a frequent action)
```

### Per-camp dispute webhook (every non-Stripe processor — required)

This is the one that was missing, and it was missing silently. When a parent
disputes a charge, the processor pulls the money back out of the camp's bank
account. Stripe told us (`stripe-webhook` handles `charge.dispute.*`);
Cardknox and Banquest had nowhere to tell us, so Campistry went on showing
the payment as collected and the family as paid. Nothing errored — the
camp's books were just wrong, and stayed wrong.

`byop-dispute-webhook` is one endpoint for every BYOP processor. In the
camp's own processor dashboard, point the chargeback / dispute notification
at:

```
https://<your-project>.supabase.co/functions/v1/byop-dispute-webhook?processor=cardknox
https://<your-project>.supabase.co/functions/v1/byop-dispute-webhook?processor=banquest
```

* `?processor=` is **required**. Nothing is guessed from the body — a
  mis-detected processor would read the wrong fields and post a chargeback
  against the wrong payment.
* Add `&camp=<camp id>` when **more than one camp uses that processor**.
  With one camp the function resolves it from `camp_processor_credentials`;
  with several it refuses to guess and logs exactly that, because putting a
  chargeback on the wrong camp's books is worse than not recording it.
* **`BYOP_DISPUTE_SECRET` is required.** Without it the endpoint refuses
  every notification (and says so in its logs: "REFUSING ALL REQUESTS"), so
  no chargeback is ever recorded and the family's card is never paused.
  Set it once for the whole project:
  1. Make up a long random value (40+ letters and numbers, no symbols).
  2. Supabase Dashboard → **Edge Functions** → **Secrets** → **Add new
     secret** → Name `BYOP_DISPUTE_SECRET`, Value: that string → **Save**.
  3. Give it to the processor, one of two ways:
     - **As a header** (if the processor's dispute notification screen has
       "custom headers"): name `x-webhook-secret`, value the secret.
     - **On the URL** (if it has no header option): add `&key=<the secret>`
       to the end of the webhook URL above, e.g.
       `…/byop-dispute-webhook?processor=banquest&key=<the secret>`.
  4. `byop-dispute-webhook` → **Settings** → **Enforce JWT Verification**
     **OFF** (the processor calls it without a Supabase login; the secret is
     what keeps strangers out).

* **Only chargeback messages are booked.** A message counts as a chargeback
  only when it says so: a chargeback/dispute/case id field, or "chargeback",
  "dispute" or "retrieval" in its status, command or event. Anything else — an
  ordinary "Approved" sale, a refund, a void — is logged ("not a chargeback
  message … ignored") and left alone. "Chargeback Reversal" (or "reversed" /
  "won") is read as the camp winning: the payment goes back on the family's
  bill and their card pause lifts. So point **the processor's chargeback /
  dispute notification** here — not its general transaction postback (that is
  `cardknox-webhook`'s). If a processor only has the one transaction postback,
  leave the dispute address unset and tell the builder.
* A disputed **canteen top-up** is handled too: it comes off the child's
  wallet (back on if the camp wins), that child's auto-reload switches off,
  and the family's card is paused like any other disputed payment.

**Send one real test dispute from the processor's dashboard after wiring it
up.** The function logs the entire body when it can't find a reference; read
that log line once and tighten the mapping in `normalise()` to what actually
arrives. Until you've done that for a processor, treat its chargeback
handling as plumbed but unproven.

#### Which fields to tick on Sola/Cardknox's Webhook Settings screen

That screen's field picker is grouped (Billing / Shipping / Transaction /
Order / Custom / Other). **Do not "Select All"** — it makes the body harder
to read in the logs without adding anything we use. Tick these:

| Group | Fields | Used for |
|-------|--------|----------|
| Transaction | `xResponseRefnum`, `xGatewayRefNum` | **The one that matters.** How we find the payment being disputed. |
| Transaction | `xInvoice` | Our own reference, a second way to match |
| Transaction | `xStatus`, `xStatusReason` | Whether this is a chargeback and why |
| Transaction | `xCommand`, `xResponseError` | Distinguishing event types while we learn the shape |
| Transaction | `xCardLastFour`, `xAuthCode` | Human reconciliation when a match fails |
| Order | `xSubtotal` | A rough amount if one is ever needed by hand |

Two things that picker taught us, both now handled in code:

* **The postback does not call the reference `xRefNum`.** The API *response*
  does — that's what `cardknox_adapter.charge()` returns and what we store —
  but the postback spells the same value **`xResponseRefnum`**, with
  `xGatewayRefNum` alongside. The dispute webhook read only `xRefNum` at
  first and would have matched nothing at all.
* **There is no amount field anywhere in it.** No `xAmount` under
  Transaction; only `xSubtotal`/`xTip`/`xTax`/`xShipAmount` under Order,
  which are order lines rather than what was captured. Migration 177 takes
  the amount from the payment being disputed instead — our own record of
  what we actually charged — and a processor-supplied amount still wins when
  there is one, because only the processor knows about a *partial*
  chargeback.

**And the thing that picker did not have:** no chargeback id, no case
number, no dispute reason. That is good evidence this screen is Cardknox's
**transaction** postback and not a dispute feed — so it may never fire for a
chargeback at all. The cheapest way to find out is to look at the
`cardknox-webhook` logs after a real one. If nothing arrives, the answer is
to poll their Reporting API (`https://x1.cardknox.com/report`) on a schedule
and feed the same `record_chargeback` path, rather than to keep adjusting
field names on an endpoint that is never called.

## Adding a new processor later (the "versatile" part)

A processor is not "added" when it can take money. It's added when it can
also give money back and tell us when someone takes money back. Migration
176 enforces that: `camp_processor_credentials` has a trigger that **refuses
to connect a camp** to a processor whose catalog row doesn't declare all
five required capabilities, and the error names the ones you skipped.

1. Add one row to `payment_processor_catalog` (key, label,
   credential_fields, capabilities) — a plain INSERT, no schema change.
   `capabilities` must declare all five as boolean `true`:
   `charge`, `refund`, `tokenization`, `recurring`, `chargeback`. A prose
   note is **not** a yes — `processor_conformance()` compares against the
   literal string `true`, deliberately, because Banquest's row carried the
   note *"not yet wired into charge-due-installments"* long after it had
   been wired. Don't declare one until it's real; the gate is the point.
2. Write `supabase/functions/_shared/adapters/<name>_adapter.ts`
   implementing `ProcessorAdapter` (`charge`, `refund`, `testConnection`).
3. Register it in `processor_adapter.ts`'s `ADAPTERS` map.
4. Add a branch to `normalise()` in
   `supabase/functions/byop-dispute-webhook/index.ts`, and add the key to
   that function's accepted-processor guard. Map the processor's dispute
   body onto `{disputeId, refs, amount, reason, status, closed, won}`.
5. Add a branch to `charge-due-installments` if you declared `recurring` —
   its gateway calls are inlined on purpose (Dashboard-pasted functions
   can't bundle relative imports), so an adapter alone doesn't make autopay
   work.
6. Run `node --test tests/processor_conformance.test.js`. It reads the
   migrations to work out what each processor *declares*, then reads the
   edge functions to check something *implements* each claim. The database
   can only check the declaration; this checks the other half. If you skip
   step 4 or 5, this is what tells you.

Check any processor from the SQL Editor:

```sql
SELECT key, processor_conformance(key) FROM payment_processor_catalog WHERE active;
-- every row should read "ok": true, "missing": []
```
