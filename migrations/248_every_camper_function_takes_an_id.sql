-- ============================================================================
-- Migration 248: every function that names a camper also takes the camper's ID.
--
-- WHERE THINGS STOOD. Twenty-five functions accept p_camper_id. Twelve still take
-- only a name:
--
--   credit_canteen_balance_from_processor   credit_canteen_balance_from_stripe
--   refund_canteen_deposit_from_processor   refund_canteen_deposit_from_stripe
--   update_canteen_autoreload_state         merge_canteen_autoreload_card
--   get_canteen_history                     canteen_camper_known
--   verify_my_camper                        _camper_mail_record
--   _invite_covers_camper                   _parent_owns_camper
--
-- Each resolves the name safely (tests/camper_identity_ledger.test.js checks
-- how), but a caller holding the camper's ID still had to throw it away and
-- send a spelling. The payment webhooks, the auto-reload run and the refund
-- screens all hold one.
--
-- WHAT THIS DOES — the same thing to each of the twelve:
--
--   1. The existing function is RENAMED to _<name>__by_name (a name that
--      already starts with an underscore keeps just the one). Its body, its
--      security mode and its privileges are untouched: it is the same function
--      under another name.
--   2. A function with the ORIGINAL name and the original parameters, plus
--      `p_camper_id bigint DEFAULT NULL`, takes its place. Given an id, it
--      resolves it to the camper's CURRENT name (camp_person_label) and passes
--      that on — which, since 244, every canteen writer maps to that person's
--      account and no one else's. An id that is nobody is refused
--      (unknown_camper, or false for the yes/no checks). Given no id, it passes
--      the name through exactly as before.
--   3. The wrapper has the old function's security mode and exactly its grants,
--      so nothing becomes callable by anyone who could not call it yesterday.
--
-- Existing callers keep working unchanged: a call without p_camper_id matches
-- the one remaining signature. There is exactly one function per name
-- afterwards, so PostgREST never sees an ambiguous overload (PGRST203).
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent: a
-- function already wrapped is skipped. Touches no data.
--
-- IF YOU EVER RE-RUN AN OLDER MIGRATION that defines one of these twelve (none
-- needs it), do it in three steps, or the older file fails part-way — its own
-- functions cannot choose between its name-only signature and the wrapper:
--
--     SELECT public.unwrap_camper_id_functions();   -- the twelve as they were
--     -- paste the older migration
--     -- paste this file again
--
-- unwrap_camper_id_functions is callable from the SQL Editor only.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_person_label(uuid,bigint)') IS NULL THEN
        RAISE EXCEPTION '248 needs camp_person_label(uuid,bigint) — apply 223 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


CREATE OR REPLACE FUNCTION pg_temp.wrap_with_camper_id(
    p_name       text,   -- the function to wrap
    p_camper_arg text,   -- its camper-name parameter
    p_camp_expr  text)   -- SQL giving the camp's uuid, in terms of the parameters
RETURNS text
LANGUAGE plpgsql
AS $wrap$
DECLARE
    v_old     oid;
    v_new     text := CASE WHEN p_name LIKE '\_%' THEN p_name ELSE '_' || p_name END || '__by_name';
    v_args    text;        -- full parameter list, with defaults
    v_ident   text;        -- identity parameter list (types only), for GRANTs
    v_ret     text;
    v_secdef  boolean;
    v_names   text[];
    v_modes   "char"[];
    v_call    text := '';
    v_refuse  text;
    v_acl     aclitem[];
    v_item    aclitem;
    v_grantee text;
    i         int;
BEGIN
    -- The signature WITHOUT an id — the one to wrap.
    SELECT p.oid INTO v_old
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = p_name
       AND pg_get_function_identity_arguments(p.oid) !~ '\mp_camper_id\M';
    IF v_old IS NULL THEN
        IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_new) THEN
            RETURN p_name || ': already wrapped';
        END IF;
        RETURN p_name || ': not present on this database, skipped';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = p_name
           AND pg_get_function_identity_arguments(p.oid) !~ '\mp_camper_id\M') > 1 THEN
        RAISE EXCEPTION '248: % has more than one signature without an id — resolve that first', p_name;
    END IF;

    -- ALREADY WRAPPED, AND AN OLDER MIGRATION HAS BEEN RE-APPLIED since: it
    -- re-created the name-only signature beside the wrapper, and two overloads
    -- that differ by a defaulted argument are ambiguous to every caller. The
    -- re-created body is the newer one, so it becomes the wrapped body and the
    -- one it supersedes is dropped. The wrapper itself is left as it is.
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = p_name
                  AND pg_get_function_identity_arguments(p.oid) ~ '\mp_camper_id\M') THEN
        SELECT pg_get_function_identity_arguments(v_old) INTO v_ident;
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s)', v_new, v_ident);
        EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', p_name, v_ident, v_new);
        RETURN p_name || ': re-wrapped (an older migration had re-created it)';
    END IF;

    SELECT pg_get_function_arguments(p.oid), pg_get_function_identity_arguments(p.oid),
           pg_get_function_result(p.oid), p.prosecdef, p.proargnames, p.proargmodes, p.proacl
      INTO v_args, v_ident, v_ret, v_secdef, v_names, v_modes, v_acl
      FROM pg_proc p WHERE p.oid = v_old;

    IF v_args ~ '\mp_camper_id\M' THEN
        RETURN p_name || ': already takes p_camper_id';
    END IF;
    IF NOT (p_camper_arg = ANY (v_names)) THEN
        RAISE EXCEPTION '248: % has no parameter %', p_name, p_camper_arg;
    END IF;

    -- The call to the renamed body: every parameter by name, the camper's
    -- replaced with the resolved one.
    FOR i IN 1 .. array_length(v_names, 1) LOOP
        IF v_modes IS NOT NULL AND v_modes[i] NOT IN ('i', 'b') THEN CONTINUE; END IF;
        v_call := v_call || CASE WHEN v_call = '' THEN '' ELSE ', ' END
               || quote_ident(v_names[i]) || ' => '
               || CASE WHEN v_names[i] = p_camper_arg THEN 'v_camper' ELSE quote_ident(v_names[i]) END;
    END LOOP;

    v_refuse := CASE v_ret
        WHEN 'jsonb'   THEN $r$jsonb_build_object('success', false, 'error', 'unknown_camper')$r$
        WHEN 'boolean' THEN 'false'
        ELSE 'NULL' END;

    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', p_name, v_ident, v_new);

    EXECUTE format($f$
        CREATE FUNCTION public.%1$I(%2$s, p_camper_id bigint DEFAULT NULL)
        RETURNS %3$s
        LANGUAGE plpgsql
        %4$s
        SET search_path = public, pg_catalog
        AS $body$
        DECLARE
            v_camper text := %5$I;
        BEGIN
            -- 248: the camper's ID, when given, decides who this is. Resolved to
            -- their CURRENT name, which every writer maps to that person alone.
            IF p_camper_id IS NOT NULL THEN
                v_camper := public.camp_person_label((%6$s)::uuid, p_camper_id);
                IF v_camper IS NULL THEN
                    RETURN %7$s;
                END IF;
            END IF;
            RETURN public.%8$I(%9$s);
        END;
        $body$$f$,
        p_name, v_args, v_ret,
        CASE WHEN v_secdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END,
        p_camper_arg, p_camp_expr, v_refuse, v_new, v_call);

    -- Exactly the old function's grants — no more.
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s, bigint) FROM PUBLIC', p_name, v_ident);
    IF v_acl IS NULL THEN
        -- NULL means the default: EXECUTE for PUBLIC.
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s, bigint) TO PUBLIC', p_name, v_ident);
    ELSE
        FOREACH v_item IN ARRAY v_acl LOOP
            IF position('X' IN split_part(split_part(v_item::text, '=', 2), '/', 1)) = 0 THEN CONTINUE; END IF;
            v_grantee := split_part(v_item::text, '=', 1);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s, bigint) TO %s', p_name, v_ident,
                           CASE WHEN v_grantee = '' THEN 'PUBLIC' ELSE quote_ident(v_grantee) END);
        END LOOP;
    END IF;

    RETURN p_name || ': wrapped';
END;
$wrap$;


SELECT pg_temp.wrap_with_camper_id('credit_canteen_balance_from_processor', 'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('credit_canteen_balance_from_stripe',    'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('refund_canteen_deposit_from_processor', 'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('refund_canteen_deposit_from_stripe',    'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('update_canteen_autoreload_state',       'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('merge_canteen_autoreload_card',         'p_camper',      'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('get_canteen_history',                   'p_camper',      'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('canteen_camper_known',                  'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('verify_my_camper',                      'p_camper_name', 'NULLIF(p_camp_id, '''')') AS "248";
SELECT pg_temp.wrap_with_camper_id('_camper_mail_record',                   'p_camper_name', 'p_camp_id') AS "248";
SELECT pg_temp.wrap_with_camper_id('_invite_covers_camper',                 'p_camper_name',
       '(SELECT i.camp_id FROM link_parent_invites i WHERE i.id = p_invite)') AS "248";
SELECT pg_temp.wrap_with_camper_id('_parent_owns_camper',                   'p_camper_name', 'p_camp_id') AS "248";


-- ─── undoing it, for re-running an older migration ─────────────────────────
-- Drops each wrapper and gives the body back its own name. Nothing else.
CREATE OR REPLACE FUNCTION public.unwrap_camper_id_functions()
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $u$
DECLARE
    v_name  text;
    v_body  text;
    v_ident text;
    v_done  text := '';
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'credit_canteen_balance_from_processor', 'credit_canteen_balance_from_stripe',
        'refund_canteen_deposit_from_processor', 'refund_canteen_deposit_from_stripe',
        'update_canteen_autoreload_state', 'merge_canteen_autoreload_card',
        'get_canteen_history', 'canteen_camper_known', 'verify_my_camper',
        '_camper_mail_record', '_invite_covers_camper', '_parent_owns_camper'] LOOP
        v_body := CASE WHEN v_name LIKE '\_%' THEN v_name ELSE '_' || v_name END || '__by_name';
        SELECT pg_get_function_identity_arguments(p.oid) INTO v_ident
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_body;
        CONTINUE WHEN v_ident IS NULL;                   -- not wrapped here
        EXECUTE (SELECT format('DROP FUNCTION public.%I(%s)', v_name, pg_get_function_identity_arguments(p.oid))
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = v_name
                    AND pg_get_function_identity_arguments(p.oid) ~ '\mp_camper_id\M');
        EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', v_body, v_ident, v_name);
        v_done := v_done || v_name || ' ';
    END LOOP;
    RETURN 'unwrapped: ' || COALESCE(NULLIF(btrim(v_done), ''), 'nothing');
END;
$u$;
REVOKE ALL ON FUNCTION public.unwrap_camper_id_functions() FROM public, anon, authenticated, service_role;


-- ─── the check ──────────────────────────────────────────────────────────────
-- Functions that take a camper name and still no id. Should be [] — and stays
-- a live report: a new name-only function shows up here the day it is created.
CREATE OR REPLACE FUNCTION public.verify_every_camper_function_takes_an_id()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('name_only', COALESCE(jsonb_agg(p.proname ORDER BY p.proname), '[]'::jsonb))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_function_identity_arguments(p.oid) ~ '\mp_camper(_name)?\M'
       AND pg_get_function_identity_arguments(p.oid) !~ '(p_camper_id|p_person_id)'
       AND p.proname !~ '__by_name$'
$$;
REVOKE ALL ON FUNCTION public.verify_every_camper_function_takes_an_id() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_every_camper_function_takes_an_id() TO authenticated, service_role;

SELECT public.verify_every_camper_function_takes_an_id() AS "248 check — name_only should be []";
