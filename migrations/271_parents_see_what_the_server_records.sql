-- ============================================================================
-- Migration 271: parents see what the server records; money that arrived
-- early reaches the ledger; a deposit can be paid straight after applying.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying registration-deposit-checkout.
--
-- ── THE PROBLEMS ───────────────────────────────────────────────────────────
-- TED-088  A parent's balance in Link read the ledger from a copy
--          (family_ledger_projection) that only the office's save of the
--          settings document refreshes. Autopay, the payment webhooks, the shop
--          and bank deposits write the family's ROW (camp_families, 211/213) —
--          so after a $400 Zelle payment the office saw $600 and the parent
--          still saw $1,000, and "Pay now" offered the old figure.
-- TED-077  A family's ledger starts the first time Billing posts to it. A
--          Zelle payment or a recorded payment that arrived before then was
--          never added, so the ledger was short for good. And the parent-side
--          "is every payment on the ledger?" check read a list that has been
--          empty since payments moved out of the document (158), so it always
--          said yes.
-- TED-089  New applications live in camp_applications (200) until the office
--          opens Me. The deposit functions only looked in the settings
--          document, so paying the deposit on the form straight after applying
--          failed "We could not find that application".
-- TED-090  (with the Me page) A deposit charged by card is recorded on the
--          application; this also records which processor took it, so Billing
--          can turn it into a refundable payment on the family.
--
-- ── THE CHANGES ────────────────────────────────────────────────────────────
-- 1. projected_family_ledger reads the family's live row (the copy only when
--    there is no row); projected_family_payments reads the payment rows.
-- 2. When a family's ledger starts (its entries go from none to some), every
--    earlier payment and posted bank deposit for it is posted, once — by the
--    same sync_family_ledger_payments the office can run, which never posts
--    anything twice.
-- 3. The deposit functions find an application in the document OR in
--    camp_applications, and record on whichever holds it (both, when both do).
-- ============================================================================

-- ── 1. the parent reads the rows ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.projected_family_ledger(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('entries', COALESCE(
        (SELECT CASE WHEN jsonb_typeof(f.payload->'entries') = 'array' THEN f.payload->'entries' ELSE '[]'::jsonb END
           FROM public.camp_families f
          WHERE f.camp_id = p_camp_id AND f.family_key = p_family_key AND f.deleted_at IS NULL),
        (SELECT entries FROM public.family_ledger_projection
          WHERE camp_id = p_camp_id AND family_key = p_family_key),
        '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.projected_family_ledger(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.projected_family_ledger(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.projected_family_payments(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(p.payload ORDER BY p.ordinal), '[]'::jsonb)
      FROM public.camp_payments p
     WHERE p.camp_id = p_camp_id AND p.deleted_at IS NULL
       AND COALESCE(p.payload->>'familyKey', '') = p_family_key;
$$;
REVOKE ALL ON FUNCTION public.projected_family_payments(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.projected_family_payments(uuid, text) TO authenticated, service_role;


-- ── 2. a ledger that starts takes in the money that came before it ─────────
CREATE OR REPLACE FUNCTION public._ledger_started_catch_up()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.deleted_at IS NULL
       AND jsonb_typeof(NEW.payload->'entries') = 'array'
       AND jsonb_array_length(NEW.payload->'entries') > 0
       AND (TG_OP = 'INSERT'
            OR COALESCE(jsonb_typeof(OLD.payload->'entries'), '') <> 'array'
            OR jsonb_array_length(OLD.payload->'entries') = 0
            OR OLD.deleted_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM camp_state_kv WHERE camp_id = NEW.camp_id AND key = 'campistryMe') THEN
        PERFORM public.sync_family_ledger_payments(NEW.camp_id, NEW.family_key, false);
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._ledger_started_catch_up() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ledger_started_catch_up ON public.camp_families;
CREATE TRIGGER trg_ledger_started_catch_up
AFTER INSERT OR UPDATE OF payload, deleted_at ON public.camp_families
FOR EACH ROW EXECUTE FUNCTION public._ledger_started_catch_up();

-- Families whose ledger already started short: once, now.
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT DISTINCT f.camp_id FROM public.camp_families f
              WHERE f.deleted_at IS NULL AND jsonb_typeof(f.payload->'entries') = 'array'
                AND jsonb_array_length(f.payload->'entries') > 0
                AND EXISTS (SELECT 1 FROM camp_state_kv k WHERE k.camp_id = f.camp_id AND k.key = 'campistryMe') LOOP
        PERFORM public.sync_family_ledger_payments(r.camp_id, NULL, false);
    END LOOP;
END $$;


-- ── 3. an application is wherever it is ────────────────────────────────────
CREATE OR REPLACE FUNCTION public._application_entry(p_camp_id uuid, p_enroll_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT value #> ARRAY['enrollments', p_enroll_id] FROM camp_state_kv
          WHERE camp_id = p_camp_id AND key = 'campistryMe'),
        (SELECT payload FROM camp_applications
          WHERE camp_id = p_camp_id AND kind = 'enrollments' AND entry_id = p_enroll_id));
$$;
REVOKE ALL ON FUNCTION public._application_entry(uuid, text) FROM public, anon, authenticated;

-- Sets the given fields on the application, in place, wherever it is held.
CREATE OR REPLACE FUNCTION public._application_patch(p_camp_id uuid, p_enroll_id text, p_patch jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_any boolean := false;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, ARRAY['enrollments', p_enroll_id],
                             (value #> ARRAY['enrollments', p_enroll_id]) || p_patch, false),
           updated_at = now()
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
       AND jsonb_typeof(value #> ARRAY['enrollments', p_enroll_id]) = 'object';
    v_any := FOUND;
    UPDATE camp_applications
       SET payload = payload || p_patch, updated_at = now()
     WHERE camp_id = p_camp_id AND kind = 'enrollments' AND entry_id = p_enroll_id;
    RETURN v_any OR FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public._application_patch(uuid, text, jsonb) FROM public, anon, authenticated;

-- 190's, reading either place.
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
    v_enr := public._application_entry(p_camp_id, p_enroll_id);
    IF v_enr IS NULL OR jsonb_typeof(v_enr) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;
    -- On the waitlist: there is no place to hold, so there is nothing to pay for.
    IF COALESCE(v_enr->>'status', '') = 'waitlisted' THEN
        RETURN jsonb_build_object('success', true, 'owed', 0, 'required', 0, 'paid', 0,
                                  'reason', 'waitlisted');
    END IF;
    v_req  := COALESCE(NULLIF(v_enr->>'depositRequired', '')::numeric, 0);
    v_paid := COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0);
    RETURN jsonb_build_object('success', true, 'required', v_req, 'paid', v_paid,
                              'owed', greatest(0, v_req - v_paid),
                              'camperName', v_enr->>'camperName');
END;
$$;
REVOKE ALL ON FUNCTION public._registration_deposit_owed(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._registration_deposit_owed(uuid, text) TO service_role;

-- 185's, recording on either place, and which processor took it (TED-090).
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
    v_proc text;
BEGIN
    v_enr := public._application_entry(p_camp_id, p_enroll_id);
    IF v_enr IS NULL OR jsonb_typeof(v_enr) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;
    IF p_reference <> '' AND (COALESCE(v_enr->>'depositReference', '') = p_reference
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_enr->'depositCharges') = 'array'
                                                          THEN v_enr->'depositCharges' ELSE '[]'::jsonb END) x
                   WHERE x->>'ref' = p_reference)) THEN
        RETURN jsonb_build_object('success', true, 'duplicate', true);
    END IF;
    v_paid := COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0) + GREATEST(p_amount, 0);
    SELECT CASE WHEN p_reference LIKE 'pi\_%' THEN 'stripe'
                ELSE COALESCE(NULLIF(c.payment_processor_key, ''), 'stripe') END
      INTO v_proc FROM camps c WHERE c.id = p_camp_id;
    PERFORM public._application_patch(p_camp_id, p_enroll_id, jsonb_build_object(
        'depositPaid', v_paid,
        'depositPaidDate', to_char(now(), 'YYYY-MM-DD'),
        'depositReference', p_reference,
        'depositProcessor', COALESCE(v_proc, ''),
        'depositStatus', 'paid',
        -- Each card charge, so Billing can make each one a refundable payment
        -- on the family, once (TED-090).
        'depositCharges', (CASE WHEN jsonb_typeof(v_enr->'depositCharges') = 'array'
                                THEN v_enr->'depositCharges' ELSE '[]'::jsonb END)
                          || jsonb_build_array(jsonb_build_object(
                               'ref', p_reference, 'amount', ROUND(GREATEST(p_amount, 0), 2),
                               'date', to_char(now(), 'YYYY-MM-DD'), 'processor', COALESCE(v_proc, '')))));
    RETURN jsonb_build_object('success', true, 'paid', v_paid);
END;
$$;
REVOKE ALL ON FUNCTION public._record_registration_deposit(uuid, text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_registration_deposit(uuid, text, numeric, text) TO service_role;

-- 186's, recording on either place.
CREATE OR REPLACE FUNCTION public._record_registration_card(
    p_camp_id    uuid,
    p_enroll_id  text,
    p_processor  text,
    p_customer   text,
    p_method     text,
    p_last4      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT public._application_patch(p_camp_id, p_enroll_id, jsonb_build_object(
        'savedCardProcessor', COALESCE(p_processor, ''),
        'savedCardCustomer',  COALESCE(p_customer, ''),
        'savedCardMethod',    COALESCE(p_method, ''),
        'savedCardLast4',     COALESCE(p_last4, ''))) THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public._record_registration_card(uuid, text, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_registration_card(uuid, text, text, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';
