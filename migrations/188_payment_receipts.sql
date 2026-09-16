-- =============================================================================
-- 188 — receipts for money taken
--
-- A parent pays this camp and hears nothing back. Not for a card payment on
-- the registration form, not for an autopay instalment taken off a stored card
-- at 3am, not for a canteen auto-reload, not for a charge the office puts
-- through while the parent is at work. Nothing in this codebase has ever sent
-- a receipt: `receipt_email` appears nowhere, and Stripe's own receipts are not
-- switched on (and would be branded as the platform, not the camp, since these
-- are destination charges).
--
-- That is the other half of the descriptor problem. A parent with no receipt
-- has two options when a charge they do not recognise turns up: telephone the
-- camp, or dispute it. The camp gets the calls it should not be getting, and
-- the chargebacks it should not be getting. Every product in this category
-- sends receipts for exactly this reason.
--
-- THIS MIGRATION IS THE TWO THINGS A RECEIPT SENDER NEEDS FROM THE DATABASE.
--
--   1. claim_payment_receipt() — the send has to happen AT MOST ONCE per
--      payment. Webhooks are redelivered; a nightly sweep can be run twice.
--      Emailing a parent two receipts for one charge is how a parent concludes
--      they were billed twice, which is the very dispute this is meant to
--      prevent. So the claim is an INSERT that either wins or does not: the
--      primary key does the arbitration, not a read-then-write that two
--      concurrent deliveries can both pass.
--
--   2. receipt_recipient() — one place that knows how to find the parent to
--      email. Every caller then passes only what it already has (a family key
--      or a camper name) instead of each of them re-learning the shape of the
--      campistryMe document.
--
-- Service role only, both of them. A receipt sender runs server-side; nothing
-- in a browser has any business asking this database for a parent's address,
-- and an anon-callable "give me the email for family X" is an address book.
--
-- Paste this whole file into the Supabase SQL Editor and run it. Idempotent.
-- =============================================================================

-- ─── 1. one receipt per payment, ever ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_receipts (
    camp_id     uuid NOT NULL,
    ref         text NOT NULL,          -- the payment's own id (gateway txn id)
    sent_to     text,
    amount      numeric,
    sent_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, ref)
);

ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
-- No policies: RLS on with no policy means no row is visible to anon or
-- authenticated at all. The service role bypasses RLS, which is the only
-- caller there should ever be.
REVOKE ALL ON TABLE public.payment_receipts FROM anon, authenticated;

COMMENT ON TABLE public.payment_receipts IS
    'One row per payment we have emailed a receipt for. The primary key is the '
    'idempotency guard: a redelivered webhook loses the insert and sends nothing.';

/**
 * Claim the right to send the receipt for one payment.
 *
 * Returns true to exactly one caller and false to every other, including a
 * second delivery of the same webhook arriving at the same moment. The caller
 * sends only on true.
 *
 * ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT: two concurrent
 * deliveries both pass a SELECT, and both then send.
 */
CREATE OR REPLACE FUNCTION public.claim_payment_receipt(
    p_camp_id uuid,
    p_ref     text,
    p_email   text DEFAULT NULL,
    p_amount  numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ref text := NULLIF(btrim(COALESCE(p_ref, '')), '');
    v_won boolean := false;
BEGIN
    IF p_camp_id IS NULL OR v_ref IS NULL THEN
        -- No stable reference means no way to tell a redelivery from a new
        -- payment. Refuse rather than send a receipt we cannot deduplicate.
        RETURN false;
    END IF;

    INSERT INTO payment_receipts (camp_id, ref, sent_to, amount)
    VALUES (p_camp_id, v_ref, NULLIF(btrim(COALESCE(p_email, '')), ''), p_amount)
    ON CONFLICT (camp_id, ref) DO NOTHING;

    v_won := FOUND;
    RETURN v_won;
END;
$$;

/**
 * Give back the receipt for a payment (so a failed send can be retried).
 *
 * A send that throws after the claim would otherwise silence that payment's
 * receipt for ever — the claim is meant to stop duplicates, not to swallow a
 * receipt because Resend was down for a second.
 */
CREATE OR REPLACE FUNCTION public.release_payment_receipt(
    p_camp_id uuid,
    p_ref     text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    DELETE FROM payment_receipts
     WHERE camp_id = p_camp_id
       AND ref = NULLIF(btrim(COALESCE(p_ref, '')), '');
    RETURN FOUND;
END;
$$;

-- ─── 2. who to email, and how to address them ────────────────────────────────
/**
 * The billing contact for a family, plus the camp's own details for the
 * letterhead and the reply-to.
 *
 * Resolution order, and it matters:
 *   - a family key, if the caller has one (autopay, a pay link, the office);
 *   - otherwise the family that owns the named camper (canteen reloads and
 *     shop orders know a camper, not a family);
 *   - otherwise the application the enrollment id belongs to, which is the
 *     registration-deposit case: there is no family record yet at all.
 *
 * The camp's own contact email comes back as reply_to so a parent's reply
 * reaches the camp's office rather than a no-reply address nobody reads. That
 * is not cosmetic: "I do not recognise this" going to the camp instead of
 * nowhere is the difference between a phone call and a chargeback.
 */
CREATE OR REPLACE FUNCTION public.receipt_recipient(
    p_camp_id     uuid,
    p_family_key  text DEFAULT NULL,
    p_camper_name text DEFAULT NULL,
    p_enroll_id   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_doc     jsonb;
    v_fam     jsonb;
    v_famkey  text := NULLIF(btrim(COALESCE(p_family_key, '')), '');
    v_camper  text := NULLIF(btrim(COALESCE(p_camper_name, '')), '');
    v_enroll  text := NULLIF(btrim(COALESCE(p_enroll_id, '')), '');
    v_email   text;
    v_to_name text;
    v_famname text;
    v_camp    record;
    v_k       text;
    v_hh      jsonb;
    v_p       jsonb;
BEGIN
    SELECT c.name, c.address, c.contact_email
      INTO v_camp
      FROM camps c
     WHERE c.id = p_camp_id;

    SELECT value INTO v_doc
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_doc IS NOT NULL THEN
        -- by family key
        IF v_famkey IS NOT NULL THEN
            v_fam := v_doc #> ARRAY['families', v_famkey];
        END IF;

        -- by camper: the family whose camperIds contains them
        IF v_fam IS NULL AND v_camper IS NOT NULL THEN
            FOR v_k IN SELECT jsonb_object_keys(COALESCE(v_doc->'families', '{}'::jsonb)) LOOP
                IF (v_doc #> ARRAY['families', v_k, 'camperIds']) @> to_jsonb(v_camper) THEN
                    v_fam := v_doc #> ARRAY['families', v_k];
                    v_famkey := v_k;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_fam IS NOT NULL THEN
            v_famname := NULLIF(btrim(COALESCE(v_fam->>'name', '')), '');
            -- The billing-contact household first, then the first household.
            SELECT hh INTO v_hh
              FROM jsonb_array_elements(COALESCE(v_fam->'households', '[]'::jsonb)) AS hh
             WHERE (hh->>'billingContact')::boolean IS TRUE
             LIMIT 1;
            IF v_hh IS NULL THEN
                v_hh := (v_fam->'households') -> 0;
            END IF;
            SELECT pp INTO v_p
              FROM jsonb_array_elements(COALESCE(v_hh->'parents', '[]'::jsonb)) AS pp
             WHERE NULLIF(btrim(COALESCE(pp->>'email', '')), '') IS NOT NULL
             LIMIT 1;
            IF v_p IS NOT NULL THEN
                v_email   := btrim(v_p->>'email');
                v_to_name := NULLIF(btrim(COALESCE(v_p->>'name', '')), '');
            END IF;
        END IF;

        -- No family: an application, which is where a registration deposit
        -- lands. The parent's address is on the application itself.
        IF v_email IS NULL AND v_enroll IS NOT NULL THEN
            v_email := NULLIF(btrim(COALESCE(v_doc #>> ARRAY['enrollments', v_enroll, 'parentEmail'], '')), '');
            v_to_name := NULLIF(btrim(COALESCE(v_doc #>> ARRAY['enrollments', v_enroll, 'parentName'], '')), '');
            IF v_camper IS NULL THEN
                v_camper := NULLIF(btrim(COALESCE(v_doc #>> ARRAY['enrollments', v_enroll, 'camperName'], '')), '');
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success',     v_email IS NOT NULL,
        'error',       CASE WHEN v_email IS NULL THEN 'no_email_on_file' ELSE NULL END,
        'email',       v_email,
        'to_name',     v_to_name,
        'family_key',  v_famkey,
        'family_name', v_famname,
        'camper_name', v_camper,
        'camp_name',   NULLIF(btrim(COALESCE(v_camp.name, '')), ''),
        'camp_address', NULLIF(btrim(COALESCE(v_camp.address, '')), ''),
        'reply_to',    NULLIF(btrim(COALESCE(v_camp.contact_email, '')), '')
    );
END;
$$;

-- Service role only. These are called from edge functions, never a browser:
-- receipt_recipient() takes a camp id and returns a parent's email address, so
-- an authenticated grant would hand any signed-in user another camp's address
-- book (the same mistake migration 183 had to undo elsewhere).
REVOKE ALL ON FUNCTION public.claim_payment_receipt(uuid, text, text, numeric) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_payment_receipt(uuid, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.receipt_recipient(uuid, text, text, text) FROM public, anon, authenticated;

-- Verify after running:
--   -- the claim wins once and only once:
--   select public.claim_payment_receipt('<camp uuid>', 'test_ref_1');   -- t
--   select public.claim_payment_receipt('<camp uuid>', 'test_ref_1');   -- f
--   select public.release_payment_receipt('<camp uuid>', 'test_ref_1'); -- t
--   select public.claim_payment_receipt('<camp uuid>', 'test_ref_1');   -- t again
--   delete from public.payment_receipts where ref = 'test_ref_1';
--
--   -- no reference means no receipt (nothing to deduplicate on):
--   select public.claim_payment_receipt('<camp uuid>', '');             -- f
--
--   -- the recipient lookup finds a real parent:
--   select public.receipt_recipient('<camp uuid>', '<family key>');
--
--   -- and is NOT callable from the browser (run via the app's own client,
--   -- not the SQL Editor, which is a superuser and unaffected):
--   --   await supabase.rpc('receipt_recipient', { p_camp_id: campId })
--   --   → permission denied for function receipt_recipient
