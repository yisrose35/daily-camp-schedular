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

- **Migration `126_byop_processor_framework.sql`** — the extensible
  processor catalog, `camps.payment_processor_key`, the (Vault-backed,
  never-plaintext) credential storage table, and the processor-agnostic
  transaction log. Paste this into the Supabase SQL Editor.
  - If `CREATE EXTENSION supabase_vault` fails with a permissions error,
    enable it once via **Dashboard → Database → Extensions → search
    "supabase_vault" → Enable**, then re-run the migration.
- **A real, extensible adapter framework**
  (`supabase/functions/_shared/processor_adapter.ts`) — adding processor #4
  later means writing one new file that implements `ProcessorAdapter`
  (`charge`/`refund`/`testConnection`) and registering it in that file's
  `ADAPTERS` map, plus one `INSERT` into `payment_processor_catalog`. No
  other code changes, ever, for a new processor.
- **One reference adapter: Cardknox / Sola Payments**
  (`supabase/functions/_shared/adapters/cardknox_adapter.ts`) — written
  against Cardknox's long-documented gateway API shape.
  **⚠️ Not yet tested against a live account** — this environment has no
  Cardknox/Sola developer credentials. Before connecting a real camp: get a
  **sandbox** API key from Cardknox/Sola, run the test-connection step
  below against it, and do one real charge + refund round-trip before ever
  pointing this at a real camp's production key.
- **Three edge functions**: `payments-charge`, `payments-refund` (the BYOP
  equivalents of `stripe-charge`/`stripe-refund` — same auth model, camp
  always derived from the caller's own session, never a client-supplied
  campId), and `admin-connect-processor` (the human-assisted onboarding
  tool, see below).
- **Dashboard status card** ("Payment processor," next to the existing
  Stripe Connect card) — read-only, shows which processor a camp is on.

## What's deliberately NOT built yet (flagged, not silently skipped)

- **A hosted "Pay Link" equivalent** (`payments-checkout`, mirroring
  `stripe-checkout`). Stripe's version redirects to a Stripe-hosted page;
  Cardknox/most ISOs don't offer an equivalent generic hosted page the same
  way — the real path is a Campistry-hosted page embedding that processor's
  own tokenization widget (Cardknox calls theirs "iFields"). That's a new
  public HTML page, a materially bigger UI task than the charge/refund
  dispatchers — next phase, not this one.
- **A way for a family to have a saved BYOP payment method at all.** Until
  the tokenization page above exists, there's no `customerRef` for
  `payments-charge` to charge against for a BYOP camp — the office Billing
  page's "Charge Card" button will correctly say "No payment method on
  file" for a BYOP family until this ships, exactly like it does today for
  a Stripe family with no card on file. Nothing is broken; there's just no
  way yet to get a BYOP family INTO that state.
- **Canteen deposits/refunds and autopay installments** for BYOP camps —
  only tuition charge/refund are wired. Same "explicitly deferred" pattern.
- **Banquest and Accept Blue adapters** — the catalog/framework supports
  them the moment someone writes the adapter file; neither exists yet.
  Pick whichever the actual at-risk camp/prospect uses first.

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
    "processorKey": "cardknox",
    "credentials": { "apiKey": "<the camp'"'"'s Cardknox/Sola API key>" },
    "notes": "Confirmed via call with <name>, <date>"
  }'
```

The `SUPABASE_SERVICE_ROLE_KEY` is the same key already in **Supabase
Dashboard → Settings → API** — the same one cron jobs use internally. It's
the only thing authorized to call this function; nothing new to create or
distribute.

This call **tests the credential for real** against Cardknox's API before
storing anything — a bad/typo'd key is rejected immediately with a clear
error, never silently saved. On success, the camp's
`payment_processor_key` flips from `stripe` to `cardknox` and the Dashboard
status card updates on next load.

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
