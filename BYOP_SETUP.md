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
- **Cardknox/Sola's own client-side tokenizer (iFields)**, alongside
  Banquest's Collect.js — `campistry_card_setup.html` now renders a real
  form for either processor (`renderCardknoxForm`/`renderBanquestForm`,
  picked by `get_camp_public_tokenization_key`'s `processorKey`).
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

## What's deliberately NOT built yet (flagged, not silently skipped)

- **Autopay installments (`charge-due-installments`)** for BYOP camps —
  tuition charge/refund/pay-link, canteen deposits/refunds, and card setup
  are all wired; a BYOP family's autopay schedule still has nowhere to
  charge until this is built. Flagged explicitly, not silently broken.
- **Accept Blue adapter** — the catalog/framework supports it the moment
  someone writes the adapter file; not built yet (Banquest and Cardknox/
  Sola were prioritized since those are what the actual at-risk camp uses).

## How to connect a camp (human-assisted, on purpose)

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
    "credentials": { "securityKey": "<the camp'"'"'s Banquest security key>" },
    "notes": "Confirmed via call with <name>, <date>"
  }'
```

(For Cardknox/Sola instead: `"processorKey": "cardknox"`,
`"credentials": { "apiKey": "<the camp's private xKey>", "ifieldsKey":
"<the camp's public iFields key>", "checkoutSlug": "<the camp's
secure.cardknox.com/ URL slug>", "webhookPin": "<a fresh 15+ character
alphanumeric PIN you generate>" }` — `apiKey` for server-side charge/refund
calls, `ifieldsKey` for the embedded card-entry widget (migration 133),
`checkoutSlug` + `webhookPin` for the hosted-checkout flow (migration 134,
see the **per-camp webhook setup** section below — `webhookPin` must be the
EXACT same value you also paste into that camp's own Sola dashboard). If
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

To disconnect a camp back to Stripe, run in the SQL Editor:

```sql
UPDATE camps SET payment_processor_key = 'stripe' WHERE id = '<camp id>';
DELETE FROM camp_processor_credentials WHERE camp_id = '<camp id>';
-- (the underlying Vault secret is orphaned, not deleted, by this alone —
--  acceptable for now given how rarely this runs; a follow-up RPC can
--  clean it up properly if this becomes a frequent action)
```

## Adding a new processor later (the "versatile" part)

1. Add one row to `payment_processor_catalog` (key, label,
   credential_fields, capabilities) — no migration needed, a plain INSERT.
2. Write `supabase/functions/_shared/adapters/<name>_adapter.ts`
   implementing `ProcessorAdapter` (`charge`, `refund`, `testConnection`).
3. Register it in `processor_adapter.ts`'s `ADAPTERS` map.
4. Nothing else changes — `payments-charge`, `payments-refund`, and
   `admin-connect-processor` are already generic over any processor in the
   catalog with a matching adapter.
