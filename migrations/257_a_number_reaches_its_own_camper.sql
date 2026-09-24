-- ============================================================================
-- Migration 257: a camper number reaches THAT camper, even one who has left
-- while a new child has their name.                (Ted's audit, TED-001/006)
--
-- THE DEFECT. "Avi Katz" #10 leaves with money on his canteen account. A new
-- "Avi Katz" enrols and is #11. A late card payment or refund for the first
-- Avi arrives carrying #10 — and lands in the new Avi's account.
--
-- Why: about 35 functions accept a camper number and then work by name. They
-- turn the number into the camper's name (camp_person_label), and deeper down
-- turn the name back into a person (camp_person_by_name) — which prefers the
-- child enrolled NOW. #10 → "Avi Katz" → #11.
--
-- THE FIX. Names are never changed: two children may share a name, and no
-- number is ever added to one. Instead, when one of those functions turns a
-- number into a name, it PINS the pair for the rest of that call: within the
-- call, that name means that number. camp_person_by_name answers from the pin
-- first. So #10 → "Avi Katz" → #10.
--
--   * camp_person_name_for(camp, number) — the name, plus the pin. Every one of
--     those functions is switched from camp_person_label to it below (their
--     deployed text is rewritten in place; only that call changes).
--   * The pin lasts for that one call only: it is stamped with the start of
--     the statement that set it and ignored by any other statement. The one
--     function that handles many campers in one call — the offline register's
--     import — clears it at the start of every row.
--   * camp_person_label itself stays a plain read that never adds a number,
--     so lists and reports never pin anybody.
--
-- An earlier draft of this file added the number to the name ("Avi Katz #10").
-- Ted found a case where that sent money to the wrong child (TED-006), and the
-- camp does not want numbers after names. This version adds nothing to any name.
--
-- HOW TO APPLY. Paste into the SQL Editor after 256. Changes no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

SET LOCAL lock_timeout = '15s';

-- ─── the pin ────────────────────────────────────────────────────────────────
-- Pins belong to ONE call: they are stamped with the start time of the
-- statement that made them, and ignored by any later statement — so a pin can
-- never reach past the call from the page (or the line in the SQL Editor)
-- that set it, even inside a longer transaction.
CREATE OR REPLACE FUNCTION public._person_pins()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN v ->> 'at' = statement_timestamp()::text THEN COALESCE(v -> 'map', '{}'::jsonb)
                ELSE '{}'::jsonb END
      FROM (SELECT COALESCE(NULLIF(current_setting('campistry.person_pins', true), '')::jsonb, '{}'::jsonb) AS v) x
$$;

CREATE OR REPLACE FUNCTION public._person_pin_key(p_camp_id uuid, p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT p_camp_id::text || '|' || lower(btrim(COALESCE(p_name, ''))) $$;

CREATE OR REPLACE FUNCTION public.clear_person_pins()
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    PERFORM set_config('campistry.person_pins', '', true);
END;
$$;

-- The camper's name for a number — and, for the rest of this call, that name
-- means that number.
CREATE OR REPLACE FUNCTION public.camp_person_name_for(p_camp_id uuid, p_person_id bigint)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_name text;
BEGIN
    SELECT source_key INTO v_name FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_person_id;
    IF v_name IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM set_config('campistry.person_pins',
        jsonb_build_object('at', statement_timestamp()::text,
                           'map', public._person_pins()
                                  || jsonb_build_object(public._person_pin_key(p_camp_id, v_name), p_person_id))::text,
        true);
    RETURN v_name;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_person_name_for(uuid, bigint) FROM public, anon, authenticated;


-- ─── the label and the lookup ───────────────────────────────────────────────
-- The label is the plain roster key. (If an earlier draft of this file was
-- applied, this puts it back.)
CREATE OR REPLACE FUNCTION public.camp_person_label(p_camp_id uuid, p_person_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT source_key FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_person_id
$$;
COMMENT ON FUNCTION public.camp_person_label(uuid, bigint) IS
    'The camper''s roster key for a person id, or NULL. A plain read: it never pins. Functions that go on to work by name use camp_person_name_for (257).';

CREATE OR REPLACE FUNCTION public.camp_person_by_name(p_camp_id uuid, p_name text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        -- 257: inside a call that started from a camper number, that number.
        (public._person_pins() ->> public._person_pin_key(p_camp_id, p_name))::bigint,
        -- Otherwise exactly as 223: exact key, then case/space-insensitive,
        -- then including departed campers; ambiguous at the matched rank → NULL.
        (WITH ranked AS (
            SELECT person_id, 1 AS rank FROM camp_people
             WHERE camp_id = p_camp_id AND kind = 'camper'
               AND deleted_at IS NULL AND source_key = p_name
            UNION ALL
            SELECT person_id, 2 FROM camp_people
             WHERE camp_id = p_camp_id AND kind = 'camper'
               AND deleted_at IS NULL AND lower(btrim(source_key)) = lower(btrim(p_name))
            UNION ALL
            SELECT person_id, 3 FROM camp_people
             WHERE camp_id = p_camp_id AND kind = 'camper'
               AND lower(btrim(source_key)) = lower(btrim(p_name))
         ),
         best AS (SELECT min(rank) AS rank FROM ranked)
         SELECT CASE WHEN count(DISTINCT r.person_id) = 1 THEN min(r.person_id) END
           FROM ranked r JOIN best b ON r.rank = b.rank
          WHERE NULLIF(btrim(COALESCE(p_name, '')), '') IS NOT NULL))
$$;
COMMENT ON FUNCTION public.camp_person_by_name(uuid, text) IS
    'The one name-to-camper-id matcher. Inside a call that started from a camper number, that number (257). Otherwise exact key, then case/space-insensitive, then including departed campers; ambiguous → NULL.';


-- ─── every function that starts from a number now pins ──────────────────────
-- Found in the catalog: every function whose body turns a number into a name
-- with camp_person_label, except the few that only READ (they must never pin),
-- and the lock/save pair, which refresh an account's label and must not change
-- which person later lookups in the same call mean.
CREATE OR REPLACE FUNCTION public._functions_that_must_pin()
RETURNS SETOF oid
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT p.oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~ 'camp_person_label\('
       AND p.proname NOT IN ('camp_person_label', 'camp_person_name_for',
                             'canteen_account_lock', 'canteen_account_save',
                             'canteen_autoreload_accounts', 'canteen_refund_view')
       -- The database's self-checks (verify_*) only report. verify_my_camper
       -- is not one of them: it answers a parent "is this my child?", and
       -- must decide by the number like everything else (Ted, TED-008).
       AND (p.proname NOT LIKE 'verify\_%' OR p.proname = 'verify_my_camper')
$$;

DO $$
DECLARE
    f      oid;
    v_def  text;
    v_n    int := 0;
BEGIN
    FOR f IN SELECT * FROM public._functions_that_must_pin() LOOP
        v_def := pg_get_functiondef(f);
        v_def := regexp_replace(v_def, '(public\.)?camp_person_label\(', 'public.camp_person_name_for(', 'g');
        EXECUTE v_def;
        v_n := v_n + 1;
    END LOOP;
    RAISE NOTICE '257: % functions now pin the camper they start from', v_n;
END $$;

-- The offline import handles many campers in one call: each row starts clean.
DO $$
DECLARE
    f     oid;
    v_def text;
BEGIN
    FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'canteen_office_import_offline' LOOP
        v_def := pg_get_functiondef(f);
        IF position('clear_person_pins()' IN v_def) = 0 THEN
            v_def := regexp_replace(v_def,
                '(FOR r IN SELECT value FROM jsonb_array_elements\(p_rows\) LOOP)',
                E'\\1\n        PERFORM public.clear_person_pins();   -- 257: each row starts clean');
            IF position('clear_person_pins()' IN v_def) = 0 THEN
                RAISE EXCEPTION '257: could not find the row loop in canteen_office_import_offline';
            END IF;
            EXECUTE v_def;
        END IF;
    END LOOP;
END $$;


-- 242's own check looked for camp_person_label in the import; it now uses the
-- pinning form, which resolves by id just the same.
DO $$
DECLARE v_def text;
BEGIN
    IF to_regprocedure('public.verify_offline_import()') IS NOT NULL THEN
        v_def := pg_get_functiondef('public.verify_offline_import()'::regprocedure);
        IF position('camp_person_(label|name_for)' IN v_def) = 0 THEN
            EXECUTE replace(v_def, $q$~ 'camp_person_label'$q$, $q$~ 'camp_person_(label|name_for)'$q$);
        END IF;
    END IF;
END $$;


-- ─── the check ──────────────────────────────────────────────────────────────
-- For every camper, enrolled or departed: a call starting from their number
-- reaches them. For every ENROLLED camper: their stored name alone reaches
-- them. And no function that starts from a number still reads the name
-- without pinning it. Empty lists when right.
CREATE OR REPLACE FUNCTION public.verify_number_round_trip()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    c         record;
    v_got     bigint;
    v_misses  jsonb := '[]'::jsonb;
    v_names   jsonb := '[]'::jsonb;
    v_n       bigint := 0;
BEGIN
    FOR c IN SELECT camp_id, person_id, source_key, deleted_at FROM camp_people WHERE kind = 'camper' LOOP
        v_n := v_n + 1;
        PERFORM public.clear_person_pins();
        v_got := public.camp_person_by_name(c.camp_id, public.camp_person_name_for(c.camp_id, c.person_id));
        IF v_got IS DISTINCT FROM c.person_id THEN
            v_misses := v_misses || jsonb_build_object('camp_id', c.camp_id, 'camperId', c.person_id,
                                                       'name', c.source_key, 'reaches', v_got);
        END IF;
        PERFORM public.clear_person_pins();
        IF c.deleted_at IS NULL THEN
            v_got := public.camp_person_by_name(c.camp_id, c.source_key);
            IF v_got IS DISTINCT FROM c.person_id THEN
                v_names := v_names || jsonb_build_object('camp_id', c.camp_id, 'camperId', c.person_id,
                                                         'name', c.source_key, 'reaches', v_got);
            END IF;
        END IF;
    END LOOP;
    PERFORM public.clear_person_pins();
    RETURN jsonb_build_object(
        'campers_checked', v_n,
        'numbers_that_miss_their_camper', v_misses,
        'enrolled_names_that_miss_their_camper', v_names,
        'functions_that_do_not_pin', COALESCE((
            SELECT jsonb_agg(p.proname ORDER BY p.proname)
              FROM pg_proc p
             WHERE p.oid IN (SELECT * FROM public._functions_that_must_pin())), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_number_round_trip() FROM public, anon, authenticated;
