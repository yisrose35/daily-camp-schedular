-- ============================================================================
-- 238 — the canteen ledger moves with the person
--
-- A GAP IN 237, FOUND AN HOUR AFTER SHIPPING IT. _move_person_references
-- discovers its work from the catalog: every table with a column literally named
-- person_id. That is the rule 223 established and it is the right rule for
-- everything 223 touched.
--
-- canteen_transactions is not one of those tables. It has no person_id. What it
-- has is
--
--     camper_id  text
--
-- and 227's canteen_post fills it with
--
--     (SELECT person_id::text FROM camp_canteen_accounts
--       WHERE camp_id = p_camp_id AND account_key = v_key)
--
-- so it IS a person reference — the same number, under a different name, as
-- text. 237's cascade never sees it. So a hand renumber, or a camper_returns_as
-- merge, moved the camper's ACCOUNT and left their entire LEDGER behind.
--
-- WHY THAT IS MONEY AND NOT BOOKKEEPING. The canteen balance is not authoritative
-- in the account row alone — settle_shop_order's own comment says
-- _reconcileBalances rebuilds every balance FROM THIS LEDGER. A ledger whose rows
-- point at a person who no longer holds the account is a balance that can be
-- recomputed to the wrong number. And get_canteen_history matches
-- ct.camper_id = <id>, so the id path silently stops finding the rows and falls
-- back to matching on the account key — the name path the whole chain exists to
-- stop relying on.
--
-- AND TWO MORE COLUMNS THAT ARE NOT MOVED, DELIBERATELY. Three tables in this
-- database have a camper_id column that is not person_id:
--
--     canteen_transactions.camper_id   text      person_id::text — proven above
--     link_outbox.camper_id            integer   "roster camperId for parent
--                                                 linkage" (007)
--     link_form_responses.camper_id    text      caller-supplied (013)
--
-- Since 216 the roster's camperId IS the person_id, so the second and third
-- probably hold one too. PROBABLY is not enough to move a row on. Both of those
-- tables ALSO carry 223's person_id, so they have two id columns that should
-- agree and nothing has ever checked that they do — which is the real finding
-- there. This file reports the disagreement and moves neither, because writing
-- to a column whose meaning I am inferring is how the transform in 214 produced
-- 233.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent. It
-- rewrites two functions and moves no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF to_regprocedure('public._move_person_references(uuid,bigint,bigint)') IS NULL THEN
        RAISE EXCEPTION '238 extends _move_person_references — apply 237 first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'canteen_transactions'
                      AND column_name = 'camper_id') THEN
        RAISE EXCEPTION '238 needs canteen_transactions.camper_id — apply 203 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. every column that holds a person reference ──────────────────────────
-- Discovered where it can be, NAMED where it cannot. The named part is a list,
-- and a list is only as good as the check beside it — tests/person_reference_
-- columns.test.js fails on a new camper_id-shaped column that is not classified
-- here, so this cannot silently fall behind the schema.
CREATE OR REPLACE FUNCTION public._person_reference_columns()
RETURNS TABLE (table_name text, column_name text, is_text boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    -- Everything 223 stamped: a real person_id, alongside a camp_id.
    SELECT c.relname::text, a.attname::text, false
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname <> 'camp_people'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = 'person_id'
       AND EXISTS (SELECT 1 FROM pg_attribute q WHERE q.attrelid = c.oid
                    AND q.attname = 'camp_id' AND q.attnum > 0 AND NOT q.attisdropped)
    UNION ALL
    -- And the one person reference stored under another name, as text. Named,
    -- because nothing in the catalog distinguishes it from link_outbox.camper_id
    -- — only 227's INSERT does, by writing person_id::text into it.
    SELECT 'canteen_transactions', 'camper_id', true
     WHERE EXISTS (SELECT 1 FROM pg_attribute a
                     JOIN pg_class c ON c.oid = a.attrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'canteen_transactions'
                      AND a.attname = 'camper_id' AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY 1, 2
$$;
COMMENT ON FUNCTION public._person_reference_columns() IS
    'Every column that points at a camp_people person: discovered person_id '
    'columns, plus canteen_transactions.camper_id which holds person_id::text. '
    'See 238.';


-- ─── 2. and the move carries all of them ────────────────────────────────────
CREATE OR REPLACE FUNCTION public._move_person_references(
    p_camp_id uuid,
    p_from    bigint,
    p_to      bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t        record;
    v_counts jsonb := '{}'::jsonb;
    v_total  bigint := 0;
    v_n      bigint;
BEGIN
    IF p_camp_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
        RETURN jsonb_build_object('moved', 0, 'by_table', '{}'::jsonb);
    END IF;

    -- REFUSE, do not collide. camp_canteen_accounts is UNIQUE (camp_id,
    -- person_id) WHERE person_id IS NOT NULL, so if both identities hold an
    -- account this raises partway through — after some tables have moved and
    -- others have not. A camper's history half-moved is worse than not moved,
    -- and "which of these two balances is theirs" is a question for a person.
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = p_camp_id AND person_id = p_to AND deleted_at IS NULL)
       AND EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = p_camp_id AND person_id = p_from AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'cannot move person % onto % in camp %: both hold a canteen '
                        'account, and deciding which balance is theirs is not this '
                        'function''s to make', p_from, p_to, p_camp_id;
    END IF;

    FOR t IN SELECT * FROM public._person_reference_columns() LOOP
        -- 238: the text-typed reference is compared and written as text. Casting
        -- the COLUMN to bigint instead would fail on any row holding something
        -- that is not a number, and canteen_transactions.camper_id is nullable
        -- free text as far as the schema is concerned.
        IF t.is_text THEN
            EXECUTE format('UPDATE public.%I SET %I = $1::text'
                           || ' WHERE camp_id = $2 AND %I = $3::text',
                           t.table_name, t.column_name, t.column_name)
              USING p_to, p_camp_id, p_from;
        ELSE
            EXECUTE format('UPDATE public.%I SET %I = $1'
                           || ' WHERE camp_id = $2 AND %I = $3',
                           t.table_name, t.column_name, t.column_name)
              USING p_to, p_camp_id, p_from;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
            v_total  := v_total + v_n;
            v_counts := jsonb_set(v_counts,
                            ARRAY[t.table_name || '.' || t.column_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('moved', v_total, 'by_table', v_counts,
                              'from', p_from, 'to', p_to);
END;
$$;
REVOKE ALL ON FUNCTION public._move_person_references(uuid, bigint, bigint)
    FROM public, anon, authenticated;


-- ─── 3. and the verifier sees the ledger, and the disagreements ─────────────
CREATE OR REPLACE FUNCTION public.verify_person_references()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t         record;
    v_counts  jsonb := '{}'::jsonb;
    v_total   bigint := 0;
    v_n       bigint;
    v_money   numeric;
    v_dis     jsonb := '{}'::jsonb;
BEGIN
    FOR t IN SELECT * FROM public._person_reference_columns() LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I x'
            || ' WHERE x.%I IS NOT NULL'
            -- A text column can hold something that is not a number at all; that
            -- is not a dangling id, it is a different kind of problem and this
            -- counter would lie about it.
            || CASE WHEN t.is_text THEN ' AND x.' || quote_ident(t.column_name)
                                        || ' ~ ''^[0-9]+$'''
                    ELSE '' END
            || '   AND NOT EXISTS (SELECT 1 FROM public.camp_people p'
            || '                    WHERE p.camp_id = x.camp_id'
            || '                      AND p.person_id = x.%I' || CASE WHEN t.is_text
                                        THEN '::bigint' ELSE '' END || ')',
            t.table_name, t.column_name, t.column_name)
          INTO v_n;
        IF v_n > 0 THEN
            v_total  := v_total + v_n;
            v_counts := jsonb_set(v_counts,
                            ARRAY[t.table_name || '.' || t.column_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    SELECT COALESCE(sum(a.balance), 0) INTO v_money
      FROM camp_canteen_accounts a
     WHERE a.person_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM camp_people p
                        WHERE p.camp_id = a.camp_id AND p.person_id = a.person_id);

    -- 238: the two tables carrying BOTH a roster camper_id and 223's person_id.
    -- Nothing has ever checked they agree. This file will not move them — their
    -- meaning is inferred, not proven — so the only honest thing is to report it.
    FOR t IN
        SELECT c.relname::text AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname <> 'canteen_transactions'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'camper_id' AND a.attnum > 0 AND NOT a.attisdropped)
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'person_id' AND a.attnum > 0 AND NOT a.attisdropped)
         ORDER BY c.relname
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I x'
            || ' WHERE x.person_id IS NOT NULL AND x.camper_id IS NOT NULL'
            || '   AND x.camper_id::text ~ ''^[0-9]+$'''
            || '   AND x.camper_id::text::bigint <> x.person_id', t.table_name)
          INTO v_n;
        IF v_n > 0 THEN
            v_dis := jsonb_set(v_dis, ARRAY[t.table_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        -- Must be 0. A row attached to a person who does not exist, which every
        -- other verifier counts as healthy.
        'rows_pointing_at_nobody', v_total,
        'by_table', v_counts,
        'money_on_a_dangling_id', COALESCE(v_money, 0),
        -- Should be {}. Two id columns on one row naming two different children.
        'rows_whose_two_id_columns_disagree', v_dis,
        'live_campers', (SELECT count(*) FROM camp_people
                          WHERE kind = 'camper' AND deleted_at IS NULL),
        'departed_campers', (SELECT count(*) FROM camp_people
                              WHERE kind = 'camper' AND deleted_at IS NOT NULL),
        'spellings_reused_after_a_departure',
            (SELECT count(*) FROM camp_people g
              WHERE g.kind = 'camper' AND g.deleted_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM camp_people l
                             WHERE l.camp_id = g.camp_id AND l.kind = 'camper'
                               AND l.deleted_at IS NULL
                               AND lower(btrim(l.source_key)) = lower(btrim(g.source_key))
                               AND l.person_id <> g.person_id)));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_person_references() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_person_references() TO authenticated;


-- ─── 4. the assertions ──────────────────────────────────────────────────────
DO $$
DECLARE
    v_n integer;
BEGIN
    -- The ledger column is in the set, or 237's cascade still misses it.
    IF NOT EXISTS (SELECT 1 FROM public._person_reference_columns()
                    WHERE table_name = 'canteen_transactions' AND column_name = 'camper_id'
                      AND is_text) THEN
        RAISE EXCEPTION 'canteen_transactions.camper_id is not a person reference here, so '
                        'a renumber still leaves the canteen ledger behind';
    END IF;

    -- And the discovered half did not get lost while adding the named half.
    SELECT count(*) INTO v_n FROM public._person_reference_columns()
     WHERE NOT is_text;
    IF v_n < 10 THEN
        RAISE EXCEPTION 'only % discovered person_id column(s) — 223 stamped far more than '
                        'that, so the discovery half is broken', v_n;
    END IF;

    -- camp_people itself is never in the set: the caller moves that row, and
    -- including it here would renumber the person mid-move.
    IF EXISTS (SELECT 1 FROM public._person_reference_columns()
                WHERE table_name = 'camp_people') THEN
        RAISE EXCEPTION 'camp_people is in the reference set, which would make a move '
                        'renumber the person it is moving';
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- rows_pointing_at_nobody must be 0, and rows_whose_two_id_columns_disagree {}.
-- A non-empty disagreement is not caused by this file; it is a row where the
-- roster's number and 223's stamp name two different children, and it needs a
-- person to look at it.
SELECT 'migration 238 applied' AS status,
       (SELECT count(*) FROM public._person_reference_columns()) AS person_reference_columns,
       public.verify_person_references() AS person_references;
