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
- **Four edge functions**: `payments-charge`, `payments-refund` (the BYOP
  equivalents of `stripe-charge`/`stripe-refund` — same auth model, camp
  always derived from the caller's own session, never a client-supplied
  campId), `payments-save-method` (turns a client-side tokenization result
  into a durable saved payment method on a family's record — see below),
  and `admin-connect-processor` (the human-assisted onboarding tool, see
  further down).
- **A real saved-payment-method flow for Banquest**: `campistry_card_setup
  .html` is a new public page that loads NMI's Collect.js (Banquest's
  client-side card tokenizer — raw card numbers never reach Campistry's
  servers, same PCI-scope role Stripe.js already plays), tokenizes the
  card, and posts the resulting token to `payments-save-method`, which
  exchanges it for a permanent NMI Customer Vault id and writes it onto the
  family record (`family.byopCustomerRef`, `family.cardOnFile`). The office
  Billing page's "Get Card"/"Charge Card" buttons
  (`requestCardSetup()`/`chargeStoredCard()` in `campistry_me.js`) now
  check the camp's processor and route to this page (or `payments-charge`)
  automatically for a BYOP camp — completely unchanged for a Stripe camp.
  A new anon-safe RPC, `get_camp_public_tokenization_key` (migration 128),
  lets that public page fetch ONLY the non-secret public tokenization key
  needed by Collect.js — the private security key never leaves the server.
- **Dashboard status card** ("Payment processor," next to the existing
  Stripe Connect card) — read-only, shows which processor a camp is on.

## What's deliberately NOT built yet (flagged, not silently skipped)

- **A hosted "Pay Link" equivalent** (`payments-checkout`, mirroring
  `stripe-checkout`'s emailed/shareable payment link for a ONE-TIME
  balance payment). What's built (`campistry_card_setup.html`) covers
  SAVING a card for later auto-charges, not a one-off pay-now link — that's
  still a gap, just a narrower one than before.
- **Cardknox/iFields client-side tokenization page.** The adapter's
  `saveMethod()` is implemented (via `cc:save`), but
  `campistry_card_setup.html` only renders the Banquest/Collect.js variant
  today — opening it for a Cardknox-connected camp shows a clear "not
  available yet" message rather than a broken form. Banquest was the
  priority since that's what the actual at-risk camp uses.
- **The office "Issue Credit/Refund" modal doesn't know about BYOP
  payments yet.** `payments-refund` (the API-level piece) is fully built
  and callable; charged BYOP payments are tagged with `byopTransactionId`/
  `byopProcessor` for exactly this reason, but the modal's own
  gateway-refund path in `campistry_me.js` still only checks
  `stripePaymentIntentId` — refunding a BYOP charge through that specific
  UI isn't wired up yet, only charging one is.
- **Canteen deposits/refunds and autopay installments** for BYOP camps —
  only tuition charge/refund + card setup are wired. Same "explicitly
  deferred" pattern.
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
`"credentials": { "apiKey": "..." }`. If Banquest gave the camp their own
branded gateway hostname rather than the shared NMI one, add it as
`"gatewayUrl": "https://secure.example.com"` inside `credentials`.)

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
