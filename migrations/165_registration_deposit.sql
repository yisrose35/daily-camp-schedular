-- =============================================================================
-- 165 — take the registration deposit on the form
--
-- A camp can require money to hold a place (migration 164). Until now the form
-- could only SAY so: the parent read the amount, submitted, and the office
-- chased them. This is the paying half.
--
-- SHAPE: the application is saved FIRST, then the parent pays against it.
-- Nothing a family typed is ever lost to a failed or abandoned payment, and an
-- unpaid application is a real, correct state -- "awaiting deposit" -- that the
-- office already sees. A form that refused to submit until a card cleared
-- would throw away twenty minutes of typing on a declined card.
--
-- WHY THE WRITE IS jsonb_set AND NOT READ-MODIFY-WRITE
--
-- campistryMe is one row that the browser rewrites whole. A webhook that read
-- it, changed one field and wrote it back would lose anything saved in
-- between -- the exact defect that erased autopay charges (see
-- campistry_finance_merge.js). jsonb_set touches one path inside the document
-- server-side, so a concurrent browser save cannot straddle it.
--
-- Idempotent -- safe to re-run. Requires 149 (banquest_pending_links) and 164.
-- =============================================================================

-- ─── 1. a pending Banquest link can belong to an application ─────────────────
-- Existing links belong to a family or a camper. A registration deposit has
-- neither yet: the family record does not exist until the office accepts.
ALTER TABLE public.banquest_pending_links
    ADD COLUMN IF NOT EXISTS enrollment_id text;

-- ─── 2. what an application still owes ───────────────────────────────────────
-- Service role only. The amount charged is decided HERE, from what the camp
-- stamped on the application, never from anything the browser sends -- an
-- anonymous page must not be able to name its own price, in either direction.
CREATE OR REPLACE FUNCTION public._registration_deposit_owed(
    p_camp_id   uuid,
    p_enroll_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_enr    jsonb;
    v_req    numeric;
    v_paid   numeric;
BEGIN
    SELECT value #> ARRAY['enrollments', p_enroll_id]
      INTO v_enr
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_enr IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    v_req  := COALESCE(NULLIF(v_enr->>'depositRequired', '')::numeric, 0);
    v_paid := COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0);

    RETURN jsonb_build_object(
        'success',     true,
        'owed',        GREATEST(v_req - v_paid, 0),
        'required',    v_req,
        'paid',        v_paid,
        'label',       COALESCE(v_enr->>'depositLabel', 'Registration deposit'),
        'camperName',  COALESCE(v_enr->>'camperName', ''),
        'parentName',  COALESCE(v_enr->>'parentName', ''),
        'parentEmail', COALESCE(v_enr->>'parentEmail', '')
    );
END;
$$;

REVOKE ALL ON FUNCTION public._registration_deposit_owed(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._registration_deposit_owed(uuid, text) TO service_role;

-- ─── 3. record that it arrived ───────────────────────────────────────────────
-- Called only by a processor webhook, after the money actually moved.
-- Idempotent on the reference: a processor that retries its webhook, or sends
-- both a session and an intent event for one payment, must not credit twice.
CREATE OR REPLACE FUNCTION public._record_registration_deposit(
    p_camp_id   uuid,
    p_enroll_id text,
    p_amount    numeric,
    p_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_enr  jsonb;
    v_paid numeric;
BEGIN
    SELECT value #> ARRAY['enrollments', p_enroll_id]
      INTO v_enr
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_enr IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    IF COALESCE(v_enr->>'depositReference', '') = p_reference AND p_reference <> '' THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true);
    END IF;

    v_paid := COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0) + GREATEST(p_amount, 0);

    -- One path, set in place. A read-modify-write of the whole document here
    -- would lose whatever the office saved while the parent was on the
    -- processor's page.
    UPDATE camp_state_kv
       SET value = jsonb_set(
               jsonb_set(
                   jsonb_set(
                       jsonb_set(value,
                           ARRAY['enrollments', p_enroll_id, 'depositPaid'], to_jsonb(v_paid), true),
                       ARRAY['enrollments', p_enroll_id, 'depositPaidDate'],
                       to_jsonb(to_char(now(), 'YYYY-MM-DD')), true),
                   ARRAY['enrollments', p_enroll_id, 'depositReference'], to_jsonb(p_reference), true),
               ARRAY['enrollments', p_enroll_id, 'depositStatus'], to_jsonb('paid'::text), true),
           updated_at = now()
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'paid', v_paid);
END;
$$;

REVOKE ALL ON FUNCTION public._record_registration_deposit(uuid, text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_registration_deposit(uuid, text, numeric, text) TO service_role;

-- ─── 4. tell the public form whether paying online is even possible ──────────
-- So it can offer "Pay now" only when there is something behind the button.
-- A camp with no processor connected gets the same deposit, stated the same
-- way, and collects it however it already does.
CREATE OR REPLACE FUNCTION public.get_public_pay_ability(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key      text;
    v_stripe   boolean := false;
BEGIN
    SELECT payment_processor_key,
           COALESCE(stripe_charges_enabled, false) AND stripe_account_id IS NOT NULL
      INTO v_key, v_stripe
      FROM camps WHERE id = p_camp_id;

    -- Deliberately says only WHETHER, and which rail by name. No account ids,
    -- no keys, nothing an anonymous page has any business holding.
    RETURN jsonb_build_object(
        'success', true,
        'canPayOnline', (v_key IN ('banquest') OR (v_key IS NULL AND v_stripe) OR (v_key = 'stripe' AND v_stripe)),
        'processor', COALESCE(v_key, CASE WHEN v_stripe THEN 'stripe' ELSE '' END)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_pay_ability(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_pay_ability(uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
