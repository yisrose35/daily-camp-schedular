# Camp Self-Serve SMS Number Provisioning — Setup

Lets a camp owner request their own dedicated Telnyx SMS number and 10DLC
campaign registration directly from their Dashboard, paying for it
themselves — no manual work per camp from the platform owner. See
`/root/.claude/plans/bubbly-jingling-kite.md` (this session) for the full
design writeup.

**Read this before enabling it for real camps**: the exact Telnyx 10DLC
brand/campaign API endpoint and field names in `telnyx-number-request` and
`telnyx-check-registration-status` were written from Telnyx's documented
API shape but have not been exercised against a live Telnyx account from
this environment. Verify them against
https://developers.telnyx.com/api/messaging/10dlc before processing a real
charge — if a field/endpoint name is wrong, the Telnyx call fails, which
triggers the built-in refund path (a camp is never left having paid for a
number that didn't provision), but you'll want to fix the real issue before
every request fails that way.

## 1. Run the migration

```
076_camp_telnyx_provisioning.sql
```

(SQL is below — same as always, paste into the Supabase SQL Editor.)

Safe to re-run.

## 2. Deploy the four new edge functions

- `telnyx-number-setup` — JWT verification **on** (default). Called by a
  signed-in camp owner/admin.
- `telnyx-number-request` — JWT verification **on** (default). Same caller.
- `telnyx-check-registration-status` — JWT verification **off** (cron,
  shared-secret gated).
- `telnyx-charge-monthly-fees` — JWT verification **off** (cron,
  shared-secret gated).

## 3. Set secrets

```
supabase secrets set TELNYX_CRON_SECRET=$(openssl rand -hex 32)
```

`TELNYX_API_KEY`, `STRIPE_SECRET_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` should already be set from prior work.

## 4. Schedule the two cron functions

Set these up the same way any other scheduled function in this codebase is
triggered (pg_cron + `net.http_post`, or your external scheduler) —
matching `charge-due-installments`'s existing convention:

- **`telnyx-check-registration-status`** — every few hours (e.g. every 4
  hours). Header: `x-cron-secret: <TELNYX_CRON_SECRET>`.
- **`telnyx-charge-monthly-fees`** — once daily. Same header. It only
  actually charges rows whose `next_charge_at` is due, so running it daily
  (not monthly) is correct and matches `charge-due-installments`'s pattern.

## 5. Confirm real Telnyx pricing before launch

`telnyx-number-request/index.ts` has two placeholder constants:
`REGISTRATION_FEE_CENTS` (currently $15) and `MONTHLY_FEE_CENTS` (currently
$3). Check Telnyx's current number + 10DLC campaign pricing and update
these two numbers before any camp is charged for real.

## 6. Verify end to end

1. As a camp owner on the Dashboard, click **"Get a texting number"** on
   the new Texting Number card.
2. Fill in the business info (legal name, EIN, address, email, phone),
   continue to payment, enter a real test card.
3. Confirm: the Stripe charge succeeds, the status card flips to "Setting
   up your number... 3-7 business days," and `camp_telnyx_provisioning`
   has a row with `status='pending_carrier_review'` and
   `telnyx_phone_number`/`telnyx_brand_id`/`telnyx_campaign_id` populated.
4. Manually flip that row's `status` to `'active'` in the SQL editor (or
   wait for real carrier approval + the cron to pick it up) and confirm
   `camps.telnyx_from_number` gets populated, and the Dashboard status card
   shows the live number.
5. Send a real broadcast from that camp (see
   `SMS_EMAIL_BROADCAST_SETUP.md`) and confirm it goes out from the new
   number, not the shared platform one.
6. Deliberately break something (e.g. an invalid EIN format) after a
   successful charge — confirm the refund fires and the row lands in
   `failed` with a visible reason on the Dashboard, not a silently-charged
   state.
7. Manually run `telnyx-charge-monthly-fees` against a test row with
   `next_charge_at` in the past — confirm it charges and advances
   `next_charge_at` by a month.

## What's NOT in this pass

- **Sole Proprietor registration** (Telnyx's no-EIN alternative) — this
  flow requires an EIN. A camp without one can't use it yet.
- **Auto-suspending SMS sending on repeated payment failure** — a failed
  monthly charge is recorded but the number stays active either way.
- **A number picker** — the flow auto-selects the first available number
  near the camp's address rather than showing a list to choose from.
- **Migrating a camp already using the manually-pasted-in shared number
  workaround from before this feature existed** — they just go through this
  same request flow whenever they're ready.

## Migration SQL

```sql
CREATE TABLE IF NOT EXISTS camp_telnyx_provisioning (
    camp_id                   uuid        PRIMARY KEY,
    status                    text        NOT NULL DEFAULT 'pending_payment',
    business_legal_name       text,
    ein                       text,
    business_address          text,
    business_email            text,
    business_phone            text,
    is_nonprofit              boolean     NOT NULL DEFAULT false,
    stripe_customer_id        text,
    stripe_payment_method_id  text,
    telnyx_phone_number       text,
    telnyx_number_id          text,
    telnyx_brand_id           text,
    telnyx_campaign_id        text,
    registration_fee_cents    integer,
    monthly_fee_cents         integer,
    next_charge_at            date,
    last_charged_at           timestamptz,
    error_message             text,
    requested_at              timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE camp_telnyx_provisioning ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.get_camp_telnyx_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_data camp_telnyx_provisioning;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT * INTO row_data FROM camp_telnyx_provisioning WHERE camp_id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', true, 'exists', false);
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'exists', true,
        'status', row_data.status,
        'phone_number', row_data.telnyx_phone_number,
        'business_legal_name', row_data.business_legal_name,
        'business_address', row_data.business_address,
        'error_message', row_data.error_message,
        'requested_at', row_data.requested_at,
        'registration_fee_cents', row_data.registration_fee_cents,
        'monthly_fee_cents', row_data.monthly_fee_cents
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_telnyx_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_telnyx_status(uuid) TO authenticated;
```
