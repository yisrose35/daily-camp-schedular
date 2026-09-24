-- ════════════════════════════════════════════════════════════════════════════
-- 212 — everything that READS families reads the rows
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHERE WE ARE.
--   208 ✓  payments → rows           (22 camps inSync, 1566.67 = 1566.67)
--   210 ✓  payment readers → rows    (sameOrderAndContent, 18 = 18)
--   211 ✓  families → rows           (65 live rows / 5 camps, 2000 = 2000)
--   212    (here) family readers → rows
--   next   the writers write rows only, and the camp-wide lock goes
--   last   the load test grows a payments phase, so the ceiling is measured
--
-- WHY READERS MOVE BEFORE WRITERS, again. The moment a writer stops maintaining
-- the document's families branch, that branch is stale. Everything below reads
-- it today. Moving them while both homes still agree — which 211's verifier
-- proved on live data — is what makes the writer change safe. The other order
-- shows the office and the parents a frozen ledger, with no error.
--
-- BEHAVIOUR IS UNCHANGED BY THIS PASTE. The rows and the branch hold the same
-- families. What changes is which one is load-bearing.
--
-- ─── HOW THE FIVE READERS WERE CHANGED ──────────────────────────────────────
-- Not rewritten. Each function's body was extracted VERBATIM from the migration
-- that last defined it and one expression substituted — the place families come
-- from. Everything else is byte-identical, and tests/families_read_from_rows.test.js
-- asserts that against those source files directly, line by line, so a silent
-- transcription error in a money function cannot pass.
--
--   get_my_saved_payment_methods (139)  1 line   me->'families' → camp_families_object
--   plan_due_for                 (172)  1 line   v_me #> families,key → camp_family
--   report_plan_undercollection  (171)  1 line   v_me->'families' → camp_families_object
--   receipt_recipient            (188)  4 lines  same two accessors
--   parent_billing_slice         (210)  1 query  camp_billing_families → camp_families
--
-- Each still reads the document for the branches that are NOT moving (sessions,
-- enrollSettings, plans on the camp). So nothing here gets faster: this phase
-- buys correctness of source, and the lock is what buys speed.
--
-- ─── THE ACCESSORS ARE NOT CALLABLE BY USERS ────────────────────────────────
-- camp_families_object and camp_family take a camp id and return that camp's
-- families. Granting them to `authenticated` would let any signed-in user read
-- ANY camp's families — so they are granted to nobody. They are called only from
-- SECURITY DEFINER functions, which execute as the owner and therefore may call
-- them, and each of those callers does its own scoping first. A test asserts the
-- absent grant, because that is the whole of the protection.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only; reads nothing, writes nothing.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
--   1. Paste this file. You will get one confirmation row.
--   2. SELECT c.id, public.verify_families_read_swap(c.id) FROM camps c
--        WHERE EXISTS (SELECT 1 FROM camp_families f WHERE f.camp_id = c.id);
--      Want sameFamilies true and chargedOld = chargedNew on every row.
--   3. Deploy the site (campistry_me.js ships the office half).
--   4. Open Billing and a family's detail — both should be exactly as before.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_families') IS NULL THEN
        v_missing := v_missing || 'table camp_families  → apply migrations/211_families_into_rows.sql first'::text;
    END IF;
    IF to_regclass('public.camp_payments') IS NULL THEN
        v_missing := v_missing || 'table camp_payments  → apply migrations/208_payments_into_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_reader') THEN
        v_missing := v_missing || 'camp_reader()  → apply migrations/183_lock_down_camp_scoped_readers.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'receipt_recipient') THEN
        v_missing := v_missing || 'receipt_recipient()  → apply migrations/188_payment_receipts.sql first'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 212 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;


-- ─── 1. the accessors ───────────────────────────────────────────────────────
-- The document's families branch, rebuilt from live rows, in exactly the shape
-- the branch had: {family_key: payload}. A soft-deleted row is absent, which is
-- what every reader means by "this family is gone".
CREATE OR REPLACE FUNCTION public.camp_families_object(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb)
      FROM public.camp_families
     WHERE camp_id = p_camp_id AND deleted_at IS NULL;
$$;
-- Granted to NOBODY. See the header: this takes a camp id, so any grant to
-- `authenticated` is a cross-camp read of every family in the database.
REVOKE ALL ON FUNCTION public.camp_families_object(uuid) FROM public, anon, authenticated;

-- One family by key, for the readers that want exactly one. NULL when absent or
-- soft-deleted, which is what `v_me #> ARRAY['families', key]` returned before.
CREATE OR REPLACE FUNCTION public.camp_family(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT payload
      FROM public.camp_families
     WHERE camp_id = p_camp_id AND family_key = p_family_key AND deleted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.camp_family(uuid, text) FROM public, anon, authenticated;


-- ─── 2. the parent's saved cards (139, one line) ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_saved_payment_methods(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_names  jsonb;
    me       jsonb;
    fams     jsonb;
    famRec   record;
    v_famKey text := NULL;
    v_fam    jsonb := NULL;
    v_pm     jsonb;
    v_out    jsonb := '[]'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    -- ★ 212: live family ROWS, not the document's families branch.
    fams := public.camp_families_object(inv.camp_id);

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(famRec.value->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        ) THEN
            v_famKey := famRec.key;
            v_fam := famRec.value;
            EXIT;
        END IF;
    END LOOP;

    IF v_fam IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            v_out := v_out || jsonb_build_object(
                'id',        v_pm->>'id',
                'type',      COALESCE(v_pm->>'type', 'card'),
                'processor', v_pm->>'processor',
                'last4',     v_pm->>'last4',
                'label',     v_pm->>'label',
                'addedDate', v_pm->>'addedDate',
                'isDefault', COALESCE((v_pm->>'isDefault')::boolean, false)
            );
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey, 'methods', v_out);
END;
$$;


-- ─── 3. is an installment due (172, one line) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.plan_due_for(
    p_camp_id    uuid,
    p_family_key text,
    p_plan_id    text,
    p_as_of      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me   jsonb;
    v_fam  jsonb;
    v_plan jsonb;
    i      integer;
BEGIN
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN RETURN NULL; END IF;

    -- ★ 212: one live family row, by key.
    v_fam := public.camp_family(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN RETURN NULL; END IF;

    FOR i IN 0 .. GREATEST(jsonb_array_length(
                 CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                      THEN v_fam->'plans' ELSE '[]'::jsonb END) - 1, -1) LOOP
        IF v_fam->'plans'->i->>'id' = p_plan_id THEN
            v_plan := v_fam->'plans'->i;
            EXIT;
        END IF;
    END LOOP;
    IF v_plan IS NULL THEN RETURN NULL; END IF;

    RETURN public.plan_due(v_fam, v_plan, p_as_of);
END;
$$;


-- ─── 4. the under-collection report (171, one line) ─────────────────────────
CREATE OR REPLACE FUNCTION public.report_plan_undercollection(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_me    jsonb;
    famRec  record;
    v_fam   jsonb;
    p       jsonb;
    i       jsonb;
    v_claimed numeric;
    v_paid    numeric;
    v_out   jsonb := '[]'::jsonb;
    v_total numeric := 0;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = p_camp_id AND u.user_id = caller
                          AND u.role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_permitted');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', true, 'families', 0);
    END IF;

    -- ★ 212: live family rows, in the same {key: payload} shape.
    FOR famRec IN SELECT key, value FROM jsonb_each(public.camp_families_object(p_camp_id)) LOOP
        v_fam := famRec.value;
        IF jsonb_typeof(v_fam) <> 'object' THEN CONTINUE; END IF;

        v_claimed := 0;
        FOR p IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'plans') = 'array' THEN v_fam->'plans'
                          WHEN jsonb_typeof(v_fam->'plan') = 'object'
                               THEN jsonb_build_array(v_fam->'plan')
                          ELSE '[]'::jsonb END) LOOP
            FOR i IN SELECT * FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(p->'installments') = 'array'
                              THEN p->'installments' ELSE '[]'::jsonb END) LOOP
                -- An instalment marked paid but carrying the waiver note was
                -- never charged: that note is the fingerprint of the defect.
                IF COALESCE(i->>'status', '') = 'paid'
                   AND COALESCE(i->>'note', '') LIKE 'Covered by an earlier payment%' THEN
                    v_claimed := v_claimed + COALESCE((i->>'amount')::numeric, 0);
                END IF;
            END LOOP;
        END LOOP;

        IF v_claimed > 0 THEN
            SELECT COALESCE(SUM((e->>'amount')::numeric), 0) INTO v_paid
              FROM jsonb_array_elements(COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) e
             WHERE e->>'familyKey' = famRec.key
               AND COALESCE(e->>'status', '') NOT IN ('pending', 'failed');

            v_total := v_total + v_claimed;
            v_out := v_out || jsonb_build_array(jsonb_build_object(
                'famKey', famRec.key, 'name', v_fam->>'name',
                'waivedNotCharged', ROUND(v_claimed, 2),
                'totalPaid', ROUND(v_paid, 2)));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true,
        'families', jsonb_array_length(v_out),
        'totalWaivedNotCharged', ROUND(v_total, 2),
        'detail', v_out);
END;
$$;


-- ─── 5. who a receipt goes to (188, four lines) ─────────────────────────────
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
            v_fam := public.camp_family(p_camp_id, v_famkey);
        END IF;

        -- by camper: the family whose camperIds contains them
        IF v_fam IS NULL AND v_camper IS NOT NULL THEN
            FOR v_k IN SELECT jsonb_object_keys(public.camp_families_object(p_camp_id)) LOOP
                IF (public.camp_family(p_camp_id, v_k) -> 'camperIds') @> to_jsonb(v_camper) THEN
                    v_fam := public.camp_family(p_camp_id, v_k);
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


-- ─── 6. the parent's slice (210, one query) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.parent_billing_slice(p_camp_id uuid, p_names jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_names    text[];
    v_enr      jsonb := '{}'::jsonb;
    v_enrIds   text[] := ARRAY[]::text[];
    v_fams     jsonb := '{}'::jsonb;
    v_famKeys  text[] := ARRAY[]::text[];
    v_famNames text[] := ARRAY[]::text[];
    v_pays     jsonb := '[]'::jsonb;
    v_sessions jsonb := '[]'::jsonb;
    v_settings jsonb := '{}'::jsonb;
BEGIN
    SELECT ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_names) = 'array' THEN p_names ELSE '[]'::jsonb END))
      INTO v_names;

    -- this parent's campers' enrollments (the loop's own test: v_names ? camperName)
    SELECT COALESCE(jsonb_object_agg(entry_id, payload), '{}'::jsonb),
           COALESCE(array_agg(entry_id), ARRAY[]::text[])
      INTO v_enr, v_enrIds
      FROM public.camp_billing_enrollments
     WHERE camp_id = p_camp_id AND camper_name = ANY (v_names);

    -- families holding any of those campers (the loop's own camperIds test)
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb),
           COALESCE(array_agg(family_key), ARRAY[]::text[]),
           COALESCE(array_agg(payload ->> 'name') FILTER (WHERE COALESCE(payload ->> 'name', '') <> ''),
                    ARRAY[]::text[])
      INTO v_fams, v_famKeys, v_famNames
    -- ★ 212: live family ROWS. Same GIN-backed membership test, plus the
    -- soft-delete filter — a family the office removed must stop counting
    -- towards a parent's balance immediately.
      FROM public.camp_families
     WHERE camp_id = p_camp_id
       AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(camper_ids) ci
                    WHERE ci = ANY (v_names));

    -- ★ 210: from camp_payments, which 208 made the second home and phase 2b
    -- makes the only one. Ordered by `ordinal` — the array's own order, set once
    -- at first sight and never updated, so a status transition does not move a
    -- payment in the family's history. Predicates unchanged from 205.
    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_payments
     WHERE camp_id = p_camp_id
       AND (family_name = ANY (v_names)
            OR (enrollment_id <> '' AND enrollment_id = ANY (v_enrIds))
            OR (family_key <> '' AND family_key = ANY (v_famKeys))
            OR (family_name <> '' AND family_name = ANY (v_famNames)));

    SELECT sessions, enroll_settings INTO v_sessions, v_settings
      FROM public.camp_billing_config WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'enrollments',    v_enr,
        'families',       v_fams,
        'finance',        jsonb_build_object('payments', v_pays),
        'sessions',       COALESCE(v_sessions, '[]'::jsonb),
        'enrollSettings', COALESCE(v_settings, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.parent_billing_slice(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.parent_billing_slice(uuid, jsonb) TO authenticated, service_role;


-- ─── 7. the office's read ───────────────────────────────────────────────────
-- Gated on me.billing, like 210's get_camp_payments and for the same reason: the
-- ledger was deliberately left in campistryMe when 158 moved finance out, so a
-- user with billing:edit and finance:none can still work on it.
CREATE OR REPLACE FUNCTION public.get_camp_families(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fams jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF public.user_section_level(p_camp_id, 'me.billing') = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_fams := public.camp_families_object(p_camp_id);
    RETURN jsonb_build_object(
        'success',  true,
        'families', COALESCE(v_fams, '{}'::jsonb),
        'count',    (SELECT count(*) FROM jsonb_object_keys(COALESCE(v_fams, '{}'::jsonb))));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_families(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_families(uuid) TO authenticated, service_role;


-- ─── 8. the verifier for this swap ──────────────────────────────────────────
-- 211's verifier answers "are the two homes in sync". This answers the narrower
-- question the swap raises: do the readers now see the same families, with the
-- same charges, as they saw from the document.
CREATE OR REPLACE FUNCTION public.verify_families_read_swap(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_docFams jsonb;
    v_rowFams jsonb;
    v_docCharged numeric := 0;
    v_rowCharged numeric := 0;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(
             (SELECT jsonb_object_agg(f.key, f.value)
                FROM jsonb_each(CASE WHEN jsonb_typeof(value -> 'families') = 'object'
                                     THEN value -> 'families' ELSE '{}'::jsonb END) AS f
               WHERE jsonb_typeof(f.value) = 'object'),
             '{}'::jsonb)
      INTO v_docFams
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_docFams IS NULL THEN v_docFams := '{}'::jsonb; END IF;

    v_rowFams := public.camp_families_object(p_camp_id);

    SELECT COALESCE(sum(COALESCE((ch ->> 'amount')::numeric, 0)), 0) INTO v_docCharged
      FROM jsonb_each(v_docFams) AS f
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(f.value -> 'charges') = 'array'
                  THEN f.value -> 'charges' ELSE '[]'::jsonb END) AS ch;

    SELECT COALESCE(sum(COALESCE((ch ->> 'amount')::numeric, 0)), 0) INTO v_rowCharged
      FROM jsonb_each(v_rowFams) AS f
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(f.value -> 'charges') = 'array'
                  THEN f.value -> 'charges' ELSE '[]'::jsonb END) AS ch;

    RETURN jsonb_build_object(
        'success', true,
        'sameFamilies', v_docFams = v_rowFams,
        'docFamilies', (SELECT count(*) FROM jsonb_object_keys(v_docFams)),
        'rowFamilies', (SELECT count(*) FROM jsonb_object_keys(v_rowFams)),
        'chargedOld', v_docCharged,
        'chargedNew', v_rowCharged,
        'note', 'sameFamilies true means every reader sees exactly what it saw '
             || 'before the swap. Once the writer phase lands this goes false by '
             || 'design — the rows will be ahead of the document — and chargedNew '
             || 'becomes the only number that matters.');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_families_read_swap(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_families_read_swap(uuid) TO authenticated, service_role;


-- ─── what this file deliberately does NOT do ────────────────────────────────
--   * No writer moves. All nineteen still take the camp-wide lock, so nothing
--     is faster yet. This earns the right to change them.
--   * 205's camp_billing_families and its trigger stay, so a rollback has
--     somewhere to land.


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 212 applied'                                                AS status,
       to_regprocedure('public.camp_families_object(uuid)') IS NOT NULL        AS accessor_ready,
       to_regprocedure('public.get_camp_families(uuid)') IS NOT NULL           AS office_read_ready,
       to_regprocedure('public.verify_families_read_swap(uuid)') IS NOT NULL   AS verify_ready,
       -- Proof each reader was really replaced, not merely re-created.
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('get_my_saved_payment_methods','plan_due_for',
                             'report_plan_undercollection','receipt_recipient',
                             'parent_billing_slice')
           AND pg_get_functiondef(p.oid) LIKE '%camp_famil%')                  AS readers_on_rows,
       -- And that the accessors are callable by nobody.
       has_function_privilege('authenticated', 'public.camp_families_object(uuid)', 'EXECUTE')
                                                                               AS accessor_leaks;
