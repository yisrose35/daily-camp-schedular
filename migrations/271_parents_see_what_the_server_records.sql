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
-- One family's catch-up, reading only that family (TED-099): the camp-wide
-- sync_family_ledger_payments rebuilt every family and every payment of the
-- camp for each family, so a first Billing save of 1,000 families took ~7.6 s.
-- Same entries, same ids, same "already on the ledger?" tests.
CREATE OR REPLACE FUNCTION public._catch_up_family_ledger(p_camp_id uuid, p_family_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_fam     jsonb;
    v_entries jsonb;
    v_entry   jsonb;
    v_n       integer := 0;
    e         jsonb;
    d         record;
BEGIN
    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN RETURN 0; END IF;
    v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array' THEN v_fam->'entries' ELSE '[]'::jsonb END;

    FOR e IN SELECT p.payload FROM public.camp_payments p
              WHERE p.camp_id = p_camp_id AND p.deleted_at IS NULL
                AND (p.family_key = p_family_key OR p.payload->>'familyKey' = p_family_key)
              ORDER BY p.ordinal LOOP
        IF COALESCE(e->>'familyKey', '') <> p_family_key THEN CONTINUE; END IF;
        IF public.family_covers_payment(jsonb_build_object('entries', v_entries), e) THEN CONTINUE; END IF;
        v_entry := public.payment_ledger_entry(e);
        IF v_entry IS NULL THEN CONTINUE; END IF;
        v_entries := v_entries || jsonb_build_array(v_entry);
        v_n := v_n + 1;
    END LOOP;

    FOR d IN SELECT id, amount_cents, is_reversal, to_char(created_at, 'YYYY-MM-DD') AS on_date
               FROM bank_deposits
              WHERE camp_id = p_camp_id AND status = 'posted' AND family_key = p_family_key LOOP
        IF public.family_covers_deposit(jsonb_build_object('entries', v_entries), d.id,
               ABS(d.amount_cents::numeric / 100), d.on_date) THEN
            CONTINUE;
        END IF;
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
            'id', 'le_dep_' || d.id::text,
            'kind', CASE WHEN d.is_reversal THEN 'refund' ELSE 'payment' END,
            'amount', ROUND(ABS(d.amount_cents::numeric / 100), 2),
            'reason', 'zelle', 'date', d.on_date,
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', CASE WHEN d.is_reversal THEN 'Bank deposit reversed' ELSE 'Bank deposit' END,
            'by', 'system', 'source', jsonb_build_object('depositId', d.id::text)));
        v_n := v_n + 1;
    END LOOP;

    IF v_n > 0 THEN
        PERFORM public.camp_family_save(p_camp_id, p_family_key, jsonb_set(v_fam, '{entries}', v_entries, true));
    END IF;
    RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._catch_up_family_ledger(uuid, text) FROM public, anon, authenticated;

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
       THEN
        PERFORM public._catch_up_family_ledger(NEW.camp_id, NEW.family_key);
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
-- How many card deposit charges an application copy records (NULL-safe).
CREATE OR REPLACE FUNCTION public._deposit_charge_count(p_enr jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN jsonb_typeof(p_enr->'depositCharges') = 'array' THEN jsonb_array_length(p_enr->'depositCharges')
                WHEN COALESCE(p_enr->>'depositReference', '') <> '' THEN 1 ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public._application_entry(p_camp_id uuid, p_enroll_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    -- Both copies can exist. The one holding MORE card deposit charges wins
    -- (TED-098): an office tab that absorbed the application before the parent
    -- paid saves the document copy without the payment, and must not make the
    -- deposit read unpaid again. Otherwise the office's copy, as before.
    WITH d AS (SELECT value #> ARRAY['enrollments', p_enroll_id] AS e FROM camp_state_kv
                WHERE camp_id = p_camp_id AND key = 'campistryMe'),
         a AS (SELECT payload AS e FROM camp_applications
                WHERE camp_id = p_camp_id AND kind = 'enrollments' AND entry_id = p_enroll_id)
    SELECT CASE
        WHEN (SELECT e FROM a) IS NOT NULL
             AND public._deposit_charge_count((SELECT e FROM a)) > public._deposit_charge_count((SELECT e FROM d))
            THEN (SELECT e FROM a)
        ELSE COALESCE((SELECT e FROM d), (SELECT e FROM a)) END;
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

-- Every card deposit charge the document copy and the camp_applications copy
-- record, once each (by reference).
CREATE OR REPLACE FUNCTION public._deposit_charges_union(p_camp_id uuid, p_enroll_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(c ORDER BY first_seen), '[]'::jsonb) FROM (
        SELECT DISTINCT ON (c->>'ref') c, ord AS first_seen
          FROM (
            SELECT x.c, x.o AS ord FROM camp_state_kv k,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(k.value #> ARRAY['enrollments', p_enroll_id, 'depositCharges']) = 'array'
                                             THEN k.value #> ARRAY['enrollments', p_enroll_id, 'depositCharges'] ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS x(c, o)
             WHERE k.camp_id = p_camp_id AND k.key = 'campistryMe'
            UNION ALL
            SELECT x.c, 1000 + x.o FROM camp_applications ap,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(ap.payload->'depositCharges') = 'array'
                                             THEN ap.payload->'depositCharges' ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS x(c, o)
             WHERE ap.camp_id = p_camp_id AND ap.kind = 'enrollments' AND ap.entry_id = p_enroll_id
          ) u
         WHERE COALESCE(c->>'ref', '') <> ''
         ORDER BY c->>'ref', ord
    ) q;
$$;
REVOKE ALL ON FUNCTION public._deposit_charges_union(uuid, text) FROM public, anon, authenticated;

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
    v_paid := GREATEST(COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0),
                       (SELECT COALESCE(sum((c->>'amount')::numeric), 0)
                          FROM jsonb_array_elements(public._deposit_charges_union(p_camp_id, p_enroll_id)) c))
              + GREATEST(p_amount, 0);
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
        -- every charge either copy knows of, never a shorter list (TED-098)
        'depositCharges', public._deposit_charges_union(p_camp_id, p_enroll_id)
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
