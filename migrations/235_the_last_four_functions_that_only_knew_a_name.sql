-- ============================================================================
-- 235 — the last four functions that only knew a name
--
-- The camper-identity ledger listed 32 functions still taking a name. Reading
-- all of them, most are name-SHAPED but id-CORRECT: every canteen writer goes
-- through canteen_account_lock, which translates the name through
-- canteen_account_key_for before it touches a row, so a rename loses nothing.
-- get_canteen_history and _camper_mail_record resolve the name themselves.
-- Rewriting those would be churn, and churn on a working money path is how this
-- chain produced half the defects it has since fixed.
--
-- Four were real, and two of those were live defects.
--
-- 1. A RENAMED CAMPER'S RECEIPT WENT NOWHERE. receipt_recipient found the
--    family by looping every family and testing
--
--        (camp_family(camp, k) -> 'camperIds') @> to_jsonb(camper_name)
--
--    which is the name-only family match 234 replaced in settle_shop_order, with
--    the same cause: camperIds is a snapshot and is not rewritten when a camp
--    corrects a spelling. So the receipt for a renamed child found no family,
--    then no billing-contact household, then no email — and returned
--    no_email_on_file, or fell through to the enrollment address, which is the
--    application's parent and not necessarily who pays. It was also one
--    camp_family() call per family per receipt.
--
-- 2. LEAGUE CAPTAINS WERE NEVER TOLD. add_pickup_alert_league_recipients finds
--    the alert with
--
--        WHERE camp_id = … AND camper_name = p_camper_name
--
--    — exact string equality, so not only a rename but a trailing space or a
--    changed capital defeats it. It then returns no_matching_alert and no
--    captain is added to the alert.
--
-- 3. AND ONE OF THEM SAID IT WORKED. mark_pickup_alert_league_checked has the
--    same lookup inside an UPDATE, and returns
--
--        jsonb_build_object('success', true)
--
--    unconditionally — without looking at how many rows it changed. For a
--    renamed camper it updates nothing and reports success, so the alert sits at
--    its old league_check_state forever and the UI shows it as handled. That is
--    the defect shape this whole chain exists to unpick: something recorded
--    somewhere and read by nobody, reported as done.
--
-- 4. create_cardknox_checkout_intent records the camper's name into
--    cardknox_checkout_intents, and 223's trigger stamps person_id when the name
--    resolves. So nothing is lost — but the caller (payments-cardknox-checkout)
--    usually knows the id already and had no way to pass it. This is the
--    improvement, not the repair.
--
-- WHAT THIS DOES NOT CHANGE. The four name-shaped wrappers — _invite_covers_camper,
-- _parent_owns_camper, _parent_invite_for, verify_my_camper — are the translation
-- layer on purpose. They exist so a name-shaped caller can be answered by the id
-- rule. They go when their callers send ids, and removing them now would mean
-- editing every parent-facing function again for no behaviour change.
--
-- EVERY NEW ARGUMENT IS LAST AND DEFAULTED, and every narrow form is DROPPED by
-- name below. A defaulted wider twin beside a surviving narrow one is what made
-- four money RPCs unresolvable to PostgREST in 228; adding one without the drop
-- would do it again.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, touches
-- no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text := '';
BEGIN
    IF to_regprocedure('public.camp_family_key_for_person(uuid,bigint,text)') IS NULL THEN
        v_missing := v_missing || 'camp_family_key_for_person (apply 234); ';
    END IF;
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        v_missing := v_missing || 'camp_person_by_name (apply 223); ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'pickup_alerts'
                      AND column_name = 'person_id') THEN
        v_missing := v_missing || 'pickup_alerts.person_id (apply 223); ';
    END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION '235 cannot be applied yet. Missing: %', v_missing;
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. a receipt reaches whoever pays ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.receipt_recipient(
    p_camp_id     uuid,
    p_family_key  text DEFAULT NULL,
    p_camper_name text DEFAULT NULL,
    p_enroll_id   text DEFAULT NULL,
    -- 235. Last, defaulted, so every existing caller keeps working; the narrow
    -- form is dropped below so PostgREST is never asked to choose.
    p_camper_id   bigint DEFAULT NULL
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
            v_fam := public.camp_family(p_camp_id, v_famkey);
        END IF;

        -- by camper: the family this child belongs to, on 234's shared rule.
        --
        -- This used to loop every family and test
        --     (camp_family(camp, k) -> 'camperIds') @> to_jsonb(v_camper)
        -- which is the same name-only family match 234 replaced in
        -- settle_shop_order, with the same consequence: camperIds is a snapshot
        -- and is not rewritten when a camp corrects a spelling, so the receipt
        -- for a renamed camper found no family and went to whatever the fallback
        -- could find — or nowhere, as no_email_on_file.
        --
        -- It was also one camp_family() call PER FAMILY, plus one more for the
        -- hit. camp_family_key_for_person is an index probe on person_ids.
        IF v_fam IS NULL AND v_camper IS NOT NULL THEN
            v_famkey := public.camp_family_key_for_person(
                            p_camp_id,
                            COALESCE(p_camper_id,
                                     public.camp_person_by_name(p_camp_id, v_camper)),
                            v_camper);
            IF v_famkey IS NOT NULL THEN
                v_fam := public.camp_family(p_camp_id, v_famkey);
            END IF;
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
        'camper_id',   COALESCE(p_camper_id,
                                public.camp_person_by_name(p_camp_id, v_camper)),
        'camp_name',   NULLIF(btrim(COALESCE(v_camp.name, '')), ''),
        'camp_address', NULLIF(btrim(COALESCE(v_camp.address, '')), ''),
        'reply_to',    NULLIF(btrim(COALESCE(v_camp.contact_email, '')), '')
    );
END;
$$;
DROP FUNCTION IF EXISTS public.receipt_recipient(uuid, text, text, text);

REVOKE ALL ON FUNCTION public.receipt_recipient(uuid, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.receipt_recipient(uuid, text, text, text, bigint)
    TO authenticated, service_role;


-- ─── 2. the alert is found by WHO, not by what they were called ─────────────
-- One helper, because both functions ask the same question and two copies of a
-- lookup is how the two halves of _admin_clear_stale_byop_cards drifted apart.
--
-- Three ways, in the order they can be trusted: the stamped id, the id the name
-- resolves to now, and the name itself — which is the only thing that answers
-- for an alert whose camper is not on the roster at all.
CREATE OR REPLACE FUNCTION public._latest_pickup_alert(
    p_camp_id     uuid,
    p_camper_name text,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH want AS (
        SELECT COALESCE(p_camper_id,
                        public.camp_person_by_name(p_camp_id, p_camper_name)) AS pid
    )
    SELECT a.id
      FROM pickup_alerts a, want w
     WHERE a.camp_id = p_camp_id
       AND ((w.pid IS NOT NULL AND a.person_id = w.pid)
            -- btrim and lower, because exact equality is what made a trailing
            -- space enough to lose an alert.
            OR lower(btrim(a.camper_name)) = lower(btrim(COALESCE(p_camper_name, ''))))
       AND COALESCE(btrim(p_camper_name), '') <> ''
     ORDER BY a.created_at DESC
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._latest_pickup_alert(uuid, text, bigint)
    FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.add_pickup_alert_league_recipients(
    p_camp_id     uuid,
    p_camper_name text,
    p_captain_ids text[],
    p_league_name text,
    p_team        text,
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_role     text := get_user_role();
    v_alert_id uuid;
    v_id       text;
    v_email    text;
    v_name     text;
    v_added    integer := 0;
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id
       OR v_role NOT IN ('owner','admin','manager','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    v_alert_id := public._latest_pickup_alert(p_camp_id, p_camper_name, p_camper_id);
    IF v_alert_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_matching_alert');
    END IF;

    FOREACH v_id IN ARRAY coalesce(p_captain_ids, ARRAY[]::text[]) LOOP
        IF v_id LIKE '%@%' THEN
            v_email := lower(v_id);
            v_name  := NULL;
        ELSE
            v_email := '';
            v_name  := split_part(v_id, '|', 1);
        END IF;
        IF v_email <> '' THEN
            INSERT INTO pickup_alert_recipients
                (alert_id, camp_id, recipient_role, recipient_name, recipient_email)
            VALUES (v_alert_id, p_camp_id, 'league_captain', v_name, v_email)
            ON CONFLICT (alert_id, recipient_email) DO NOTHING;
            v_added := v_added + 1;
        END IF;
    END LOOP;

    UPDATE pickup_alerts SET league_check_state = 'checked_match' WHERE id = v_alert_id;
    RETURN jsonb_build_object('success', true, 'alertId', v_alert_id,
                              'recipients', v_added);
END;
$$;

DROP FUNCTION IF EXISTS public.add_pickup_alert_league_recipients(uuid, text, text[], text, text);

REVOKE ALL ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text, bigint)
    TO authenticated;


-- ─── 3. and it stops claiming success for nothing ───────────────────────────
CREATE OR REPLACE FUNCTION public.mark_pickup_alert_league_checked(
    p_camp_id     uuid,
    p_camper_name text,
    p_state       text DEFAULT 'checked_no_match',
    p_camper_id   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_alert_id uuid;
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id
       OR get_user_role() NOT IN ('owner','admin','manager','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    v_alert_id := public._latest_pickup_alert(p_camp_id, p_camper_name, p_camper_id);
    -- The whole point. This used to UPDATE on a name match and then return
    -- success unconditionally, so for a renamed camper it changed nothing and
    -- said it had — leaving the alert at its old state and the UI showing it as
    -- handled.
    IF v_alert_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_matching_alert');
    END IF;

    UPDATE pickup_alerts
       SET league_check_state = coalesce(p_state, 'checked_no_match')
     WHERE id = v_alert_id;

    RETURN jsonb_build_object('success', true, 'alertId', v_alert_id);
END;
$$;

DROP FUNCTION IF EXISTS public.mark_pickup_alert_league_checked(uuid, text, text);

REVOKE ALL ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text, bigint)
    TO authenticated;


-- ─── 4. a checkout intent can carry the id its caller already has ───────────
CREATE OR REPLACE FUNCTION public.create_cardknox_checkout_intent(
    p_camp_id      uuid,
    p_reference    text,
    p_kind         text,
    p_family_key   text,
    p_family_name  text,
    p_camper_name  text,
    p_amount_cents integer,
    p_description  text,
    p_camper_id    bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO cardknox_checkout_intents
        (camp_id, reference, kind, family_key, family_name, camper_name,
         amount_cents, description, person_id)
    VALUES
        (p_camp_id, p_reference, p_kind, p_family_key, p_family_name, p_camper_name,
         p_amount_cents, p_description,
         -- Only what the caller knows. 223's stamping trigger on this table
         -- resolves the name when this is NULL and leaves a non-null value
         -- alone, so a COALESCE here would be a second copy of the same rule —
         -- and a mutation test proved it: removing it changed nothing, because
         -- the trigger was doing the work either way. Two mechanisms for one
         -- outcome is how the halves of _admin_clear_stale_byop_cards drifted
         -- apart.
         p_camper_id);
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_already_used');
END;
$$;

DROP FUNCTION IF EXISTS public.create_cardknox_checkout_intent(
    uuid, text, text, text, text, text, integer, text);

REVOKE ALL ON FUNCTION public.create_cardknox_checkout_intent(
    uuid, text, text, text, text, text, integer, text, bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_cardknox_checkout_intent(
    uuid, text, text, text, text, text, integer, text, bigint) TO service_role;


-- ─── 5. the assertions ──────────────────────────────────────────────────────
DO $$
DECLARE
    r record;
BEGIN
    -- One overload each. PostgREST resolves by argument NAME, so a narrow form
    -- surviving beside a defaulted wider one makes every call ambiguous — 228.
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('receipt_recipient', 'add_pickup_alert_league_recipients',
                             'mark_pickup_alert_league_checked',
                             'create_cardknox_checkout_intent', '_latest_pickup_alert')
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads — PostgREST cannot choose',
                            r.proname, r.c;
        END IF;
    END LOOP;

    -- Neither pickup-alert function matches camper_name by hand any more.
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('add_pickup_alert_league_recipients',
                                    'mark_pickup_alert_league_checked')
                  AND p.prosrc ~ $re$camper_name\s*=\s*p_camper_name$re$) THEN
        RAISE EXCEPTION 'a pickup-alert function still matches camper_name by hand';
    END IF;

    -- And the one that used to lie about it now has something to lie with:
    -- it must be able to return no_matching_alert.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public'
                      AND p.proname = 'mark_pickup_alert_league_checked'
                      AND p.prosrc ~ 'no_matching_alert') THEN
        RAISE EXCEPTION 'mark_pickup_alert_league_checked can still only say success';
    END IF;

    -- receipt_recipient is on the shared family rule.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'receipt_recipient'
                      AND p.prosrc ~ 'camp_family_key_for_person') THEN
        RAISE EXCEPTION 'receipt_recipient does not use the shared family rule';
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 235 applied' AS status,
       jsonb_object_agg(x.proname, x.args) AS signatures
  FROM (SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('receipt_recipient', 'add_pickup_alert_league_recipients',
                             'mark_pickup_alert_league_checked',
                             'create_cardknox_checkout_intent')) x;
