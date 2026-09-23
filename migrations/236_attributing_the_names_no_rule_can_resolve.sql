-- ============================================================================
-- 236 — attributing the names no rule can resolve
--
-- WHAT THIS IS FOR. verify_camper_ids() reports 510 rows naming a camper and 448
-- the roster cannot resolve. 223 gave every one of those tables a person_id, an
-- index and a stamping trigger, and they all work — the lookup simply finds
-- nothing, because the name in the row is not a name in the roster.
--
-- Most of those are campers who left, and there is nothing to attribute. But one
-- class is a child who IS on the roster under a spelling nobody can mechanically
-- connect to the one on the row:
--
--     canteen account   'Sara Schepansky'     $10.72
--     roster key        'Sara Schepasnky'
--
-- Two transposed letters. camp_person_by_name trims and folds case, which is as
-- far as a rule can honestly go: anything looser starts attributing one child's
-- money to another. So that $10.72 is stranded, and no migration can un-strand
-- it, because deciding those two spellings are one child is a judgement.
--
-- WHAT THIS FILE DOES, THEN, IS NOT A REPAIR. It is three tools:
--
--   1. camper_name_candidates()        — the pairs worth a human looking at.
--   2. attribute_camper_name()         — "this name means this child", applied
--                                        everywhere at once. DRY RUN by default.
--   3. purge_unattributable_canteen_accounts() — clears the accounts that are
--                                        genuinely nobody, and only the ones
--                                        holding no money.
--
-- HOW THE CANDIDATES ARE FOUND, AND WHAT IS DELIBERATELY NOT SUGGESTED. Two
-- signals, both on the letters alone:
--
--   'same letters'  — the two spellings are anagrams once case, spacing and
--                     punctuation are stripped. This is exactly the transposition
--                     class, and it is the one we have actually seen.
--   'one character' — same length, differing in exactly one position, or one
--                     insertion/deletion away. A slipped key.
--
-- What is NOT suggested: a shared surname. 'Sara Rosenfeld' and 'Chana
-- Rosenfeld' are two children, and a tool that offers them as the same one will
-- eventually be clicked through by somebody in a hurry. A candidate list is only
-- useful if everything on it is plausible.
--
-- WHICH COLUMNS COUNT AS A CAMPER'S NAME. camper_name, which is what 223 hung a
-- person_id on, and camp_canteen_accounts.account_key, which is what 217 keyed
-- that table on. Two more were in an earlier draft and are deliberately gone:
-- pickup_alert_recipients.recipient_name is a league captain or a staff member,
-- not a camper, and canteen_transactions.camper has no person_id to stamp. Both
-- matched nothing and only widened what a mistake could reach.
--
-- WHY attribute_camper_name TOUCHES EVERY TABLE AT ONCE. The same name appears in
-- a canteen account, a mail record, a pickup alert, a photo tag and a health
-- submission. Attributing it once per table is five decisions where there is one,
-- and five chances to do four of them.
--
-- AND WHY IT CAN REFUSE. camp_canteen_accounts has
--     UNIQUE (camp_id, person_id) WHERE person_id IS NOT NULL
-- so if the child already has an account under the current spelling, stamping a
-- second one raises. That means the child has money in two places, which is a
-- decision about money and not the same decision as "these are one child". The
-- function reports both balances and changes nothing. Merging them is not here
-- on purpose.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, and it
-- changes no data by itself — every tool it installs is read-only or dry-run by
-- default.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        RAISE EXCEPTION '236 needs camp_person_by_name — apply 223 first';
    END IF;
    IF to_regprocedure('public._camp_scoped_tables()') IS NULL THEN
        RAISE EXCEPTION '236 discovers tables the way 222 does — apply 222 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the letters, with nothing else ──────────────────────────────────────
-- Lowercased, letters and digits only, sorted. Two spellings that differ only by
-- the ORDER of their characters produce the same value, which is the whole
-- transposition class in one comparison.
CREATE OR REPLACE FUNCTION public._name_letters(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(string_agg(ch, '' ORDER BY ch), '')
      FROM regexp_split_to_table(
             lower(regexp_replace(COALESCE(p_name, ''), '[^[:alnum:]]', '', 'g')),
             '') AS ch
     WHERE ch <> ''
$$;
COMMENT ON FUNCTION public._name_letters(text) IS
    'A spelling reduced to its sorted letters, so two orderings of the same '
    'letters compare equal. 236.';


-- ─── 2. and whether they are one edit apart ─────────────────────────────────
-- fuzzystrmatch's levenshtein() is not installed and this file will not install
-- an extension to answer one question. Bounded at 1, which is all the candidate
-- report asks: is this a single slipped key.
CREATE OR REPLACE FUNCTION public._one_edit_apart(p_a text, p_b text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    a text := lower(btrim(COALESCE(p_a, '')));
    b text := lower(btrim(COALESCE(p_b, '')));
    la integer;
    lb integer;
    i  integer;
    d  integer := 0;
    sw text;
BEGIN
    IF a = b THEN RETURN false; END IF;      -- identical is not a candidate
    la := length(a); lb := length(b);
    IF abs(la - lb) > 1 THEN RETURN false; END IF;

    IF la = lb THEN
        -- One substitution: exactly one position differs.
        FOR i IN 1 .. la LOOP
            IF substr(a, i, 1) <> substr(b, i, 1) THEN
                d := d + 1;
                IF d > 1 THEN RETURN false; END IF;
            END IF;
        END LOOP;
        RETURN d = 1;
    END IF;

    -- One insertion or deletion: the shorter is the longer with one character
    -- removed. Walk to the first difference and compare the remainders.
    IF la > lb THEN
        -- swap so a is the shorter
        sw := a; a := b; b := sw;
        la := length(a); lb := length(b);
    END IF;
    FOR i IN 1 .. la + 1 LOOP
        IF i > la OR substr(a, i, 1) <> substr(b, i, 1) THEN
            RETURN substr(a, i) = substr(b, i + 1);
        END IF;
    END LOOP;
    RETURN false;
END;
$$;


-- ─── 3. the pairs worth looking at ──────────────────────────────────────────
-- Every camper name in the database that resolves to nobody, beside the roster
-- keys that might be the same child, with why. Read-only.
--
-- Scoped to one camp when asked, and to the caller's camps otherwise, because a
-- list of every camp's campers is not something any one office should read.
CREATE OR REPLACE FUNCTION public.camper_name_candidates(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_out  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NOT NULL AND NOT public._is_camp_admin(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    SELECT COALESCE(jsonb_agg(x.row ORDER BY x.balance DESC NULLS LAST, x.unresolved), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT u.camp_id, u.unresolved,
               COALESCE(sum(a.balance), 0) AS balance,
               jsonb_build_object(
                 'camp_id',    u.camp_id,
                 'unresolved', u.unresolved,
                 'balance',    COALESCE(sum(a.balance), 0),
                 'candidates', COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                                   'roster_key', c.source_key,
                                   'person_id',  c.person_id,
                                   'why', CASE
                                       WHEN public._name_letters(c.source_key)
                                            = public._name_letters(u.unresolved)
                                       THEN 'same letters, different order'
                                       ELSE 'one character apart' END))
                                 FILTER (WHERE c.person_id IS NOT NULL), '[]'::jsonb),
                 'to_attribute',
                     'SELECT public.attribute_camper_name(''' || u.camp_id
                     || '''::uuid, ' || quote_literal(u.unresolved)
                     || ', <person_id>, true);'
               ) AS row
          FROM (
            -- Every distinct unresolved camper name, from the one table that has
            -- all of them: the canteen. Other tables' names are handled by the
            -- same attribution once it is made.
            SELECT DISTINCT k.camp_id, k.account_key AS unresolved
              FROM public.camp_canteen_accounts k
             WHERE k.deleted_at IS NULL AND k.person_id IS NULL
               AND COALESCE(btrim(k.account_key), '') <> ''
               AND (p_camp_id IS NULL OR k.camp_id = p_camp_id)
          ) u
          LEFT JOIN public.camp_people c
                 ON c.camp_id = u.camp_id AND c.kind = 'camper'
                AND c.deleted_at IS NULL
                AND (public._name_letters(c.source_key) = public._name_letters(u.unresolved)
                     OR public._one_edit_apart(c.source_key, u.unresolved))
          LEFT JOIN public.camp_canteen_accounts a
                 ON a.camp_id = u.camp_id AND a.account_key = u.unresolved
                AND a.deleted_at IS NULL
         WHERE p_camp_id IS NOT NULL OR public._is_camp_admin(u.camp_id, caller)
         GROUP BY u.camp_id, u.unresolved
      ) x
     -- Only the ones a person can actually act on. A name with no candidate is a
     -- camper who left, and belongs in the purge below, not on a decision list.
     WHERE x.row -> 'candidates' <> '[]'::jsonb;

    RETURN jsonb_build_object('success', true, 'count', jsonb_array_length(v_out),
                              'names', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.camper_name_candidates(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camper_name_candidates(uuid) TO authenticated;


-- ─── 4. "this name means this child" ────────────────────────────────────────
-- Applied to every table 223 gave a person_id, discovered from the catalog so a
-- table added later is covered without anyone remembering this file exists.
--
-- DRY RUN BY DEFAULT. p_confirm false counts and changes nothing.
CREATE OR REPLACE FUNCTION public.attribute_camper_name(
    p_camp_id   uuid,
    p_name      text,
    p_person_id bigint,
    p_confirm   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    t         record;
    v_counts  jsonb := '{}'::jsonb;
    v_total   bigint := 0;
    v_n       bigint;
    v_clash   record;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR NOT public._is_camp_admin(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    IF COALESCE(btrim(p_name), '') = '' OR p_person_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = p_camp_id AND kind = 'camper'
                      AND person_id = p_person_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_camper');
    END IF;

    -- The refusal. The child already has a canteen account, so attributing this
    -- one would break uq_canteen_accounts_person — and that is not a constraint
    -- to work around, it is the question "which of these two balances is this
    -- child's?" arriving. Nothing is changed.
    SELECT a.account_key AS existing_key, a.balance AS existing_balance,
           b.balance AS this_balance
      INTO v_clash
      FROM public.camp_canteen_accounts a
      LEFT JOIN public.camp_canteen_accounts b
             ON b.camp_id = p_camp_id AND b.account_key = p_name AND b.deleted_at IS NULL
     WHERE a.camp_id = p_camp_id AND a.person_id = p_person_id AND a.deleted_at IS NULL
       AND a.account_key IS DISTINCT FROM p_name
     LIMIT 1;

    IF v_clash.existing_key IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'camper_already_has_a_canteen_account',
            'detail', 'This child holds two canteen accounts. Deciding which '
                   || 'balance is theirs is a separate decision and this function '
                   || 'will not make it.',
            'their_account', v_clash.existing_key,
            'their_balance', v_clash.existing_balance,
            'this_account', p_name,
            'this_balance', COALESCE(v_clash.this_balance, 0));
    END IF;

    -- Every ordinary public table with a camper_name and a person_id — the same
    -- discovery 223 used to add the column in the first place.
    FOR t IN
        SELECT DISTINCT ON (c.relname)
               c.relname::text AS table_name, a.attname::text AS name_col
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND a.attnum > 0 AND NOT a.attisdropped
           AND a.atttypid = 'text'::regtype
           AND a.attname IN ('camper_name', 'account_key')
           AND EXISTS (SELECT 1 FROM pg_attribute p WHERE p.attrelid = c.oid
                        AND p.attname = 'person_id' AND p.attnum > 0
                        AND NOT p.attisdropped)
           AND EXISTS (SELECT 1 FROM pg_attribute q WHERE q.attrelid = c.oid
                        AND q.attname = 'camp_id' AND q.attnum > 0
                        AND NOT q.attisdropped)
         -- ONE column per table, and account_key wins where both exist.
         --
         -- camp_canteen_accounts carries account_key AND camper_name, and the
         -- first version of this loop visited it once per column. Counting it
         -- twice was the visible symptom — 863 rows against 223's 488 for the
         -- same question. The real hazard was the second UPDATE: 227 keeps the
         -- account KEY fixed and lets the camper_name LABEL follow a rename, so
         -- the two columns can name different accounts, and stamping both with
         -- one person_id violates uq_canteen_accounts_person. The clash check
         -- above looks for an account already holding the id, not for two
         -- accounts arriving in one call, so it would not have caught it.
         --
         -- account_key is the right one: it is the identity 217 keyed the table
         -- on, and camper_name there is a display label.
         ORDER BY c.relname, CASE a.attname WHEN 'account_key' THEN 0 ELSE 1 END
    LOOP
        IF p_confirm THEN
            EXECUTE format(
                'UPDATE public.%I SET person_id = $1'
                || ' WHERE camp_id = $2 AND person_id IS NULL'
                || '   AND lower(btrim(%I)) = lower(btrim($3))',
                t.table_name, t.name_col)
              USING p_person_id, p_camp_id, p_name;
            GET DIAGNOSTICS v_n = ROW_COUNT;
        ELSE
            EXECUTE format(
                'SELECT count(*) FROM public.%I'
                || ' WHERE camp_id = $1 AND person_id IS NULL'
                || '   AND lower(btrim(%I)) = lower(btrim($2))',
                t.table_name, t.name_col)
              INTO v_n USING p_camp_id, p_name;
        END IF;

        IF v_n > 0 THEN
            v_total  := v_total + v_n;
            v_counts := jsonb_set(v_counts,
                            ARRAY[t.table_name || '.' || t.name_col], to_jsonb(v_n));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'dry_run', NOT p_confirm,
        'attributed', p_confirm,
        'camp_id', p_camp_id,
        'name', p_name,
        'person_id', p_person_id,
        'rows', v_total,
        'by_table', v_counts,
        'to_apply', CASE WHEN p_confirm THEN NULL ELSE
            'SELECT public.attribute_camper_name(''' || p_camp_id || '''::uuid, '
            || quote_literal(p_name) || ', ' || p_person_id || ', true);' END);
END;
$$;
REVOKE ALL ON FUNCTION public.attribute_camper_name(uuid, text, bigint, boolean)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.attribute_camper_name(uuid, text, bigint, boolean)
    TO authenticated;


-- ─── 5. and the accounts that are genuinely nobody ──────────────────────────
-- A canteen account whose name is on no roster and whose balance is zero. There
-- is nothing to attribute and nothing to lose.
--
-- ZERO BALANCE ONLY, and it is not a configurable threshold. An account with a
-- balance — positive or negative — is somebody's money or somebody's debt, and
-- deleting it to make a number go down is how a cleanup becomes an incident.
-- Those are reported instead.
CREATE OR REPLACE FUNCTION public.purge_unattributable_canteen_accounts(
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_gone     bigint := 0;
    v_kept     bigint;
    v_kept_amt numeric;
BEGIN
    SELECT count(*), COALESCE(sum(a.balance), 0)
      INTO v_kept, v_kept_amt
      FROM public.camp_canteen_accounts a
     WHERE a.deleted_at IS NULL AND a.person_id IS NULL
       AND COALESCE(a.balance, 0) <> 0;

    IF p_confirm THEN
        DELETE FROM public.camp_canteen_accounts
         WHERE person_id IS NULL
           AND COALESCE(balance, 0) = 0
           AND COALESCE(spent_today, 0) = 0;
        GET DIAGNOSTICS v_gone = ROW_COUNT;
    ELSE
        SELECT count(*) INTO v_gone
          FROM public.camp_canteen_accounts a
         WHERE a.person_id IS NULL
           AND COALESCE(a.balance, 0) = 0
           AND COALESCE(a.spent_today, 0) = 0;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'dry_run', NOT p_confirm,
        'deleted', p_confirm,
        'empty_accounts_with_no_camper', v_gone,
        -- The ones this will not touch, and the reason to look at them by hand.
        'accounts_holding_money_with_no_camper', v_kept,
        'money_on_them', v_kept_amt,
        'to_see_the_candidates', 'SELECT public.camper_name_candidates();',
        'to_delete_them', CASE WHEN p_confirm THEN NULL ELSE
            'SELECT public.purge_unattributable_canteen_accounts(true);' END);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_unattributable_canteen_accounts(boolean)
    FROM public, anon, authenticated;


-- ─── 6. the verifier ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_camper_attribution()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_named  bigint := 0;
    v_withid bigint := 0;
    t        record;
    v_a      bigint;
    v_b      bigint;
    v_cand   bigint;
    v_money  numeric;
BEGIN
    FOR t IN
        SELECT DISTINCT ON (c.relname)
               c.relname::text AS table_name, a.attname::text AS name_col
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND a.attnum > 0 AND NOT a.attisdropped
           AND a.atttypid = 'text'::regtype
           AND a.attname IN ('camper_name', 'account_key')
           AND EXISTS (SELECT 1 FROM pg_attribute p WHERE p.attrelid = c.oid
                        AND p.attname = 'person_id' AND p.attnum > 0 AND NOT p.attisdropped)
           AND EXISTS (SELECT 1 FROM pg_attribute q WHERE q.attrelid = c.oid
                        AND q.attname = 'camp_id' AND q.attnum > 0 AND NOT q.attisdropped)
         -- One column per table, same rule as attribute_camper_name. Counting a
         -- table once per matching column made this report 863 rows where 223's
         -- verifier reported 488, for the same question — two numbers that
         -- disagree are two numbers nobody trusts.
         ORDER BY c.relname, CASE a.attname WHEN 'account_key' THEN 0 ELSE 1 END
    LOOP
        EXECUTE format('SELECT count(*), count(person_id) FROM public.%I'
                       || ' WHERE COALESCE(btrim(%I), '''') <> ''''',
                       t.table_name, t.name_col)
          INTO v_a, v_b;
        v_named  := v_named + v_a;
        v_withid := v_withid + v_b;
    END LOOP;

    -- How many of the unresolved have a plausible roster match, i.e. how much of
    -- the remainder is a decision rather than a departed camper.
    SELECT count(*), COALESCE(sum(k.balance), 0)
      INTO v_cand, v_money
      FROM public.camp_canteen_accounts k
     WHERE k.deleted_at IS NULL AND k.person_id IS NULL
       AND EXISTS (SELECT 1 FROM public.camp_people c
                    WHERE c.camp_id = k.camp_id AND c.kind = 'camper'
                      AND c.deleted_at IS NULL
                      AND (public._name_letters(c.source_key) = public._name_letters(k.account_key)
                           OR public._one_edit_apart(c.source_key, k.account_key)));

    RETURN jsonb_build_object(
        'success', true,
        'rows_naming_a_camper', v_named,
        'rows_carrying_an_id', v_withid,
        'rows_the_roster_cannot_resolve', v_named - v_withid,
        -- The number that is actually actionable. The rest are campers who left.
        'unresolved_accounts_with_a_plausible_match', v_cand,
        'money_on_them', v_money,
        'to_see_them', 'SELECT public.camper_name_candidates();');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camper_attribution() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camper_attribution() TO authenticated;


-- ─── 7. the assertions ──────────────────────────────────────────────────────
DO $$
BEGIN
    -- The transposition this file exists for, checked on the actual spellings.
    IF public._name_letters('Sara Schepansky') IS DISTINCT FROM
       public._name_letters('Sara Schepasnky') THEN
        RAISE EXCEPTION '_name_letters does not see a transposition as the same letters';
    END IF;
    -- And two different children are NOT the same letters.
    IF public._name_letters('Sara Rosenfeld') = public._name_letters('Chana Rosenfeld') THEN
        RAISE EXCEPTION '_name_letters treats two different children as one';
    END IF;
    -- One edit apart, in all three shapes, and not more than one.
    IF NOT public._one_edit_apart('Levi Cohen', 'Levi Cohan') THEN
        RAISE EXCEPTION '_one_edit_apart misses a substitution';
    END IF;
    IF NOT public._one_edit_apart('Levi Cohen', 'Levi Cohe') THEN
        RAISE EXCEPTION '_one_edit_apart misses a deletion';
    END IF;
    IF NOT public._one_edit_apart('Levi Cohe', 'Levi Cohen') THEN
        RAISE EXCEPTION '_one_edit_apart misses an insertion';
    END IF;
    IF public._one_edit_apart('Levi Cohen', 'Dovid Stern') THEN
        RAISE EXCEPTION '_one_edit_apart matches two unrelated names';
    END IF;
    IF public._one_edit_apart('Levi Cohen', 'levi cohen') THEN
        RAISE EXCEPTION '_one_edit_apart offers a name that already resolves';
    END IF;

    -- Both destructive tools default to not being destructive.
    IF (public.purge_unattributable_canteen_accounts()->>'deleted')::boolean THEN
        RAISE EXCEPTION 'the purge deletes without being asked';
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- unresolved_accounts_with_a_plausible_match is the list to work through;
-- everything else in rows_the_roster_cannot_resolve is a camper who left.
SELECT 'migration 236 applied' AS status,
       public.verify_camper_attribution() AS attribution,
       public.purge_unattributable_canteen_accounts() AS empty_accounts;
