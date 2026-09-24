-- ============================================================================
-- Migration 255: a parent's family, enrollments and billing are found by
-- camper NUMBER.
--
-- WHAT WAS LEFT. Everything a parent does with money asks one question first:
-- which of this camp's families and enrollments are MINE? Six functions
-- answered it by comparing child NAMES — the names on the parent's invitation
-- against the names on each family (camperIds, which despite its name holds
-- names) and on each enrollment (camperName):
--
--     get_my_balance_derived        (the balance the portal shows)
--     parent_billing_slice          (its fast path)
--     get_my_saved_payment_methods, remove_payment_method,
--     set_default_payment_method    (the parent's saved cards)
--     set_my_payment_plan           (the payment plan)
--
-- Two children with the same name in one camp, and each parent saw — and could
-- pay, re-plan and change the card of — the other family's bill. And a child
-- renamed on the roster fell out of their own parent's balance.
--
-- Both sides already carry the numbers: the invitation's person_ids (223, one
-- per name, same order), each family's person_ids (234), and each enrollment's
-- person_id (223).
--
-- THE RULE, the same one used everywhere else now: when both sides know the
-- child's number, the NUMBER decides — equal numbers match, different numbers
-- never do, whatever the names say. A name is compared only where one side
-- has no number (a child the roster cannot resolve).
--
-- HOW. Two helpers hold the rule. The six functions are rewritten in place
-- (their deployed text, as 246 did): only the one comparison changes.
--
-- HOW TO APPLY. Paste into the SQL Editor after 254. Changes no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

SET LOCAL lock_timeout = '15s';


-- The invitation's children: name and stamped number, position by position.
CREATE OR REPLACE FUNCTION public._invite_slots(p_names jsonb, p_ids jsonb)
RETURNS TABLE (nm text, pid bigint)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT e.value #>> '{}',
           CASE WHEN jsonb_typeof(p_ids -> (e.ord - 1)::int) = 'number'
                THEN (p_ids ->> (e.ord - 1)::int)::bigint END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_names) = 'array'
                                     THEN p_names ELSE '[]'::jsonb END) WITH ORDINALITY e(value, ord)
$$;


-- Is this family one of the invitation's? By number where both know it; by
-- name only where one side does not.
CREATE OR REPLACE FUNCTION public._family_is_parents(
    p_camp_id uuid, p_family_key text, p_family jsonb, p_names jsonb, p_ids jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH s AS (SELECT * FROM public._invite_slots(p_names, p_ids)),
         f AS (SELECT COALESCE((SELECT person_ids FROM camp_families
                                 WHERE camp_id = p_camp_id AND family_key = p_family_key), '[]'::jsonb) AS ids)
    SELECT EXISTS (SELECT 1 FROM s, f WHERE s.pid IS NOT NULL AND f.ids @> to_jsonb(s.pid))
        OR EXISTS (
            SELECT 1
              FROM s
              JOIN jsonb_array_elements_text(COALESCE(p_family -> 'camperIds', '[]'::jsonb)) ci(nm)
                ON ci.nm = s.nm
              CROSS JOIN LATERAL (SELECT public.camp_person_by_name(p_camp_id, ci.nm) AS r) x
             WHERE s.pid IS NULL OR x.r IS NULL OR x.r = s.pid)
$$;
REVOKE ALL ON FUNCTION public._family_is_parents(uuid, text, jsonb, jsonb, jsonb) FROM public, anon, authenticated;


-- Is this enrollment one of the invitation's children? The enrollment row's
-- stamped number (or the camperId on the entry) against the invitation's.
CREATE OR REPLACE FUNCTION public._enrollment_is_parents(
    p_camp_id uuid, p_entry_id text, p_entry jsonb, p_names jsonb, p_ids jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH s AS (SELECT * FROM public._invite_slots(p_names, p_ids)),
         e AS (SELECT COALESCE(
                   (SELECT person_id FROM camp_billing_enrollments
                     WHERE camp_id = p_camp_id AND entry_id = p_entry_id),
                   public._stated_person_id(p_entry ->> 'camperId')) AS pid,
                   p_entry ->> 'camperName' AS nm)
    SELECT EXISTS (
        SELECT 1 FROM s, e
         WHERE (e.pid IS NOT NULL AND s.pid = e.pid)
            OR (s.nm = e.nm AND (e.pid IS NULL OR s.pid IS NULL)))
$$;
REVOKE ALL ON FUNCTION public._enrollment_is_parents(uuid, text, jsonb, jsonb, jsonb) FROM public, anon, authenticated;


-- ─── the parent's billing slice, on the same rule ───────────────────────────
-- Unchanged from 212 except the three camper tests, and it now takes the
-- invitation's numbers. One signature (a second, differing only by a defaulted
-- argument, would be ambiguous to PostgREST).
DROP FUNCTION IF EXISTS public.parent_billing_slice(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.parent_billing_slice(p_camp_id uuid, p_names jsonb, p_ids jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_names    text[];
    v_ids      bigint[];
    v_loose    text[];      -- names on the invitation with no number
    v_enr      jsonb := '{}'::jsonb;
    v_enrIds   text[] := ARRAY[]::text[];
    v_fams     jsonb := '{}'::jsonb;
    v_famKeys  text[] := ARRAY[]::text[];
    v_famNames text[] := ARRAY[]::text[];
    v_pays     jsonb := '[]'::jsonb;
    v_sessions jsonb := '[]'::jsonb;
    v_settings jsonb := '{}'::jsonb;
BEGIN
    SELECT COALESCE(array_agg(nm), '{}'), COALESCE(array_agg(pid) FILTER (WHERE pid IS NOT NULL), '{}'),
           COALESCE(array_agg(nm) FILTER (WHERE pid IS NULL), '{}')
      INTO v_names, v_ids, v_loose
      FROM public._invite_slots(p_names, p_ids);

    -- this parent's campers' enrollments: by number; by name only where a
    -- side has none
    SELECT COALESCE(jsonb_object_agg(entry_id, payload), '{}'::jsonb),
           COALESCE(array_agg(entry_id), ARRAY[]::text[])
      INTO v_enr, v_enrIds
      FROM public.camp_billing_enrollments
     WHERE camp_id = p_camp_id
       AND ((person_id IS NOT NULL AND person_id = ANY (v_ids))
            OR (camper_name = ANY (v_loose))
            OR (person_id IS NULL AND camper_name = ANY (v_names)));

    -- families holding any of those campers
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb),
           COALESCE(array_agg(family_key), ARRAY[]::text[]),
           COALESCE(array_agg(payload ->> 'name') FILTER (WHERE COALESCE(payload ->> 'name', '') <> ''),
                    ARRAY[]::text[])
      INTO v_fams, v_famKeys, v_famNames
      FROM public.camp_families
     WHERE camp_id = p_camp_id
       AND deleted_at IS NULL
       AND public._family_is_parents(p_camp_id, family_key, payload, p_names, p_ids);

    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_payments
     WHERE camp_id = p_camp_id
       AND (family_name = ANY (v_loose)
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
REVOKE ALL ON FUNCTION public.parent_billing_slice(uuid, jsonb, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.parent_billing_slice(uuid, jsonb, jsonb) TO authenticated, service_role;


-- ─── the five functions: one comparison each, rewritten in place ────────────
-- Every overload of each name. A pattern that is not found is fine only if the
-- replacement is already there (re-applying this file); otherwise it raises and
-- nothing changes.
CREATE OR REPLACE FUNCTION pg_temp.rewrite_re(p_name text, p_pairs text[][])
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    f      oid;
    v_def  text;
    v_new  text;
    v_out  text := '';
    i      int;
    v_any  boolean := false;
BEGIN
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = p_name LOOP
        v_any := true;
        v_def := pg_get_functiondef(f);
        v_new := v_def;
        FOR i IN 1 .. array_length(p_pairs, 1) LOOP
            IF v_new ~ p_pairs[i][1] THEN
                v_new := regexp_replace(v_new, p_pairs[i][1], p_pairs[i][2], 'g');
            ELSIF position(p_pairs[i][3] IN v_new) = 0 THEN
                RAISE EXCEPTION '255: % — the comparison to replace was not found (%), nothing was changed',
                                p_name, p_pairs[i][1];
            END IF;
        END LOOP;
        IF v_new <> v_def THEN
            EXECUTE v_new;
            v_out := v_out || p_name || ': rewritten; ';
        ELSE
            v_out := v_out || p_name || ': already applied; ';
        END IF;
    END LOOP;
    IF NOT v_any THEN RETURN p_name || ': not on this database'; END IF;
    RETURN v_out;
END;
$$;

-- family: "SELECT 1 FROM jsonb_array_elements_text(COALESCE(<fam>->'camperIds', …)) ci WHERE v_names ? ci"
-- enrollment: "(v_names ? (e->>'camperName'))"
SELECT pg_temp.rewrite_re(fn, ARRAY[
    ARRAY[$p$SELECT 1 FROM jsonb_array_elements_text\(COALESCE\((famRec\.value|fam)->'camperIds', '\[\]'::jsonb\)\) ci\s+WHERE v_names \? ci$p$,
          $r$SELECT 1 WHERE public._family_is_parents(inv.camp_id, famRec.key, \1, v_names, inv.person_ids)$r$,
          '_family_is_parents('],
    ARRAY[$p$\(v_names \? \(e->>'camperName'\)\)$p$,
          $r$public._enrollment_is_parents(inv.camp_id, rec.key, e, v_names, inv.person_ids)$r$,
          CASE WHEN fn IN ('get_my_balance_derived', 'set_my_payment_plan')
               THEN '_enrollment_is_parents(' ELSE '' END],
    ARRAY[$p$parent_billing_slice\(inv\.camp_id, v_names\)$p$,
          $r$parent_billing_slice(inv.camp_id, v_names, inv.person_ids)$r$,
          CASE WHEN fn = 'get_my_balance_derived' THEN 'v_names, inv.person_ids)' ELSE '' END]
]) AS "255"
  FROM unnest(ARRAY['get_my_balance_derived', 'get_my_saved_payment_methods', 'remove_payment_method',
                    'set_default_payment_method', 'set_my_payment_plan']) fn;


-- ─── the check ──────────────────────────────────────────────────────────────
-- Functions a PARENT reaches that still compare a family's or enrollment's
-- child names with the invitation's. Empty when this file has done its job.
CREATE OR REPLACE FUNCTION public.verify_parent_matching_on_numbers()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('still_matching_children_by_name', COALESCE((
        SELECT jsonb_agg(DISTINCT p.proname ORDER BY p.proname)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname NOT LIKE 'verify\_%'
           AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
               ~ '(WHERE v_names \? ci|v_names \? \(e->>''camperName''\)|parent_billing_slice\(inv\.camp_id, v_names\))'
    ), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.verify_parent_matching_on_numbers() FROM public, anon, authenticated;
