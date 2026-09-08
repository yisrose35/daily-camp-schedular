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
  **⚠️ NOT YET VERIFIED AGAINST A LIVE SANDBOX** — written from Cardknox's
  published iFields sample/docs (each sensitive field is its own hosted
  iframe; `ifields.min.js` wires them up and `getTokens()` returns each
  field's Secure Usage Token), not tested against a real iFields key in
  this environment. Confirm the pinned CDN version
  (`cdn.cardknox.com/ifields/2.6.2006.0102/ifields.min.js`) against
  `https://cdn.cardknox.com/ifields/versions.htm` and run one real
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
"<the camp's public iFields key>" }` — BOTH are needed: `apiKey` for the
server-side charge/refund calls, `ifieldsKey` for the client-side card-entry
widget (migration 133). If Banquest gave the camp their own branded gateway
hostname rather than the shared NMI one, add it as `"gatewayUrl":
"https://secure.example.com"` inside `credentials`.)

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
