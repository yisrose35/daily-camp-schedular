-- ============================================================================
-- 237 — a departed camper's number is not handed to the next arrival
--
-- WHAT IS BROKEN RIGHT NOW. 216's _project_people ends with this promise:
--
--     Gone from the document → stamped, never destroyed. The id stays spoken
--     for, so a deleted camper's number is not handed to the next arrival and
--     their canteen history cannot silently reattach to a stranger.
--
-- That is the intent. It is not the behaviour, because one lookup in the same
-- function asks for a person by name WITHOUT excluding the departed:
--
--     SELECT person_id INTO v_have FROM camp_people
--      WHERE camp_id = … AND kind = … AND source_key = r.k;
--
-- Reproduced on a real server, both ways round:
--
--   1. ROSTER ENTRY WITH NO camperId. John Smith leaves with $40 on his canteen
--      account; his row is soft-deleted, source_key intact. A DIFFERENT child,
--      also John Smith, is added. v_have finds the departed row, v_id becomes
--      his number, the row is un-deleted and repurposed — and the new child is
--      now holding the old child's $40, ledger, pickup alerts, medical
--      submissions, photo tags, and their parent's invite, which covers them
--      because the id genuinely matches. 232's bound does not apply: that
--      guards the NULL-slot path, and this comes in through the stamped one.
--
--   2. ROSTER ENTRY WITH A camperId — the production path, since campistry_me.js
--      assigns one to every entry before saving. The departed row is instead
--      RENUMBERED onto the new child's id by the branch commented "the camp
--      renumbered this person by hand". So there is no theft — there is
--      DETACHMENT: every row that pointed at the old number now points at a
--      person who does not exist.
--
-- The second is worse to find, because nothing anywhere checks that a person_id
-- RESOLVES. verify_camper_ids() counts a row carrying an id as healthy whether
-- or not that id belongs to anybody, so all fifteen migrations from 222 to 236
-- reported green over the top of this.
--
-- AND THE RENUMBER ORPHANS HISTORY EVEN WHEN IT IS LEGITIMATE. A camp editing a
-- camper's ID field by hand is a real, deliberate act. That branch moved
-- camp_people.person_id and nothing else, so the canteen account, the ledger,
-- the alerts and the billing enrolment were all left behind. That is the fourth
-- defect here and fixing it is what makes fixing the first three safe.
--
-- WHY KEYING THE WHOLE SYSTEM ON IDS WOULD NOT HAVE HELPED. app1.camperRoster is
-- keyed by camper NAME at the source, so the first act of identity assignment
-- reads a name and decides who it is. An id-keyed system propagates a wrong
-- decision perfectly. The id programme is only ever as good as this one moment,
-- and this one moment is this one function.
--
-- WHAT THIS FILE CHANGES
--
--   1. uq_camp_people_source becomes PARTIAL on deleted_at IS NULL. It has to:
--      once the lookup skips departed rows, a new arrival sharing a departed
--      camper's spelling INSERTS — and against a total index that is a unique
--      violation inside a projection trigger, which aborts the camp's roster
--      save. The honest rule is "one LIVE person per spelling", which is also
--      the only rule anybody could state out loud.
--
--   2. The lookup sees live people only, so a reused name MINTS a new identity.
--      A departed camper keeps their number and their history.
--
--   3. _move_person_references carries every row with a person_id when that
--      person_id legitimately moves, and REFUSES when the destination already
--      holds a canteen account rather than colliding on
--      uq_canteen_accounts_person halfway through.
--
--   4. camper_returns_as() is the deliberate merge, for when the office says a
--      new arrival IS the departed child. Because the ROSTER DOCUMENT wins on
--      the next save, it writes camperId back into the document too — otherwise
--      the next Me-page save splits them apart again.
--
--   5. verify_person_references() reports DANGLING ids, per table. That absence
--      is what let all of this hide.
--
-- WHAT IT COSTS, SAID PLAINLY. A returning camper typed in by hand gets a new
-- number and does not inherit last season's canteen balance or history until
-- somebody says they are the same child. I would argue that is more correct for
-- money than the alternative — last year's balance following a child into a new
-- season silently is its own bug — and a rollover that carries camperIds is
-- unaffected either way.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction. It rebuilds one
-- index and rewrites one projection function; it moves no data by itself.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_dupes bigint;
BEGIN
    IF to_regprocedure('public._project_people(uuid,text,jsonb,jsonb,text,text)') IS NULL THEN
        RAISE EXCEPTION '237 rewrites _project_people — apply 216 first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'camp_people'
                      AND column_name = 'deleted_at') THEN
        RAISE EXCEPTION '237 needs camp_people.deleted_at — apply 216 first';
    END IF;

    -- Making the index partial can only ever succeed (a partial index is weaker
    -- than the total one it replaces), but the reverse is not true, so record
    -- whether anything would block going back.
    SELECT count(*) INTO v_dupes
      FROM (SELECT camp_id, kind, source_key
              FROM camp_people WHERE deleted_at IS NULL
             GROUP BY camp_id, kind, source_key HAVING count(*) > 1) d;
    IF v_dupes > 0 THEN
        RAISE EXCEPTION '237: % live spelling collision(s) already exist, which should be '
                        'impossible under the total index — investigate before proceeding',
                        v_dupes;
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. one LIVE person per spelling ────────────────────────────────────────
-- A departed camper and a new arrival may share a spelling; two enrolled campers
-- may not. Dropped and recreated rather than altered, because a unique index's
-- predicate cannot be changed in place.
--
-- camp_person_by_name is unaffected: its ranks 1 and 2 filter deleted_at IS NULL
-- and so find the live person uniquely; rank 3 (which ignores deleted_at) is only
-- reached when no live row matches at all.
DROP INDEX IF EXISTS public.uq_camp_people_source;
CREATE UNIQUE INDEX IF NOT EXISTS uq_camp_people_source
    ON public.camp_people (camp_id, kind, source_key)
    WHERE deleted_at IS NULL;

COMMENT ON INDEX public.uq_camp_people_source IS
    'One LIVE person per spelling per camp. Partial since 237: a departed '
    'camper keeps their source_key, and must not block a new arrival who '
    'happens to share it.';


-- ─── 2. when a number moves, everything pointing at it moves ────────────────
-- Discovered from the catalog, never listed, so a table added next year is
-- carried without anyone remembering this file exists. The same discovery 236
-- uses, and the same reason: one rule in one place.
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
    -- person_id) WHERE person_id IS NOT NULL, so if the destination already has
    -- an account this UPDATE raises partway through — after some tables have
    -- moved and others have not. A camper's history half-moved is worse than
    -- not moved, and "which of these two balances is theirs" is a question for a
    -- person, exactly as in 236.
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = p_camp_id AND person_id = p_to AND deleted_at IS NULL)
       AND EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = p_camp_id AND person_id = p_from AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'cannot move person % onto % in camp %: both hold a canteen '
                        'account, and deciding which balance is theirs is not this '
                        'function''s to make', p_from, p_to, p_camp_id;
    END IF;

    FOR t IN
        SELECT DISTINCT ON (c.relname) c.relname::text AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname <> 'camp_people'          -- the row itself, moved by the caller
           AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname = 'person_id'
           AND EXISTS (SELECT 1 FROM pg_attribute q WHERE q.attrelid = c.oid
                        AND q.attname = 'camp_id' AND q.attnum > 0 AND NOT q.attisdropped)
         ORDER BY c.relname
    LOOP
        EXECUTE format('UPDATE public.%I SET person_id = $1'
                       || ' WHERE camp_id = $2 AND person_id = $3', t.table_name)
          USING p_to, p_camp_id, p_from;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
            v_total  := v_total + v_n;
            v_counts := jsonb_set(v_counts, ARRAY[t.table_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('moved', v_total, 'by_table', v_counts,
                              'from', p_from, 'to', p_to);
END;
$$;
REVOKE ALL ON FUNCTION public._move_person_references(uuid, bigint, bigint)
    FROM public, anon, authenticated;


-- ─── 3. the projection, with the lookup and the renumber fixed ──────────────
CREATE OR REPLACE FUNCTION public._project_people(
    p_camp_id uuid,
    p_kind    text,
    p_old     jsonb,
    p_new     jsonb,
    p_id_field text,
    p_name_field text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r        record;
    v_stated bigint;
    v_have   bigint;
    v_holder text;
    v_holder_kind text;
    v_name   text;
    v_id     bigint;
BEGIN
    -- Only entries that actually CHANGED. A roster save rewrites every camper,
    -- and re-deriving all of them per save is the decay 206 had to undo.
    FOR r IN
        SELECT n.key AS k, n.value AS v
          FROM jsonb_each(p_new) AS n(key, value)
         WHERE jsonb_typeof(n.value) = 'object'
           AND (p_old -> n.key) IS DISTINCT FROM n.value
    LOOP
        v_stated := public._person_id(r.v ->> p_id_field);
        v_name   := COALESCE(NULLIF(r.v ->> p_name_field, ''), r.k);

        -- This person under their CURRENT label, and whoever holds the number
        -- the document is asking for. They are usually the same row; the
        -- interesting cases are when they are not.
        -- 237: a LIVE person only. Without `deleted_at IS NULL` this found a
        -- DEPARTED camper who happened to share the spelling, and then handed
        -- their number to the new arrival — the exact thing the comment at the
        -- bottom of this function promises does not happen. Two siblings a year
        -- apart is enough: the new child inherited the old child's canteen
        -- balance, ledger, alerts, medical submissions and their parent's access.
        SELECT person_id INTO v_have
          FROM camp_people
         WHERE camp_id = p_camp_id AND kind = p_kind AND source_key = r.k
           AND deleted_at IS NULL;

        v_holder := NULL; v_holder_kind := NULL;
        IF v_stated IS NOT NULL THEN
            SELECT source_key, kind INTO v_holder, v_holder_kind
              FROM camp_people
             WHERE camp_id = p_camp_id AND person_id = v_stated;
        END IF;

        IF v_stated IS NOT NULL AND v_holder IS NOT NULL AND v_holder IS DISTINCT FROM r.k THEN
            -- Somebody else's row carries the number. Two very different
            -- situations look identical in the document, and getting them the
            -- wrong way round either loses a camper's history or steals it:
            --
            --   a RENAME — the roster is keyed by name, so "Rivka Stern" →
            --   "Rivka Stein" arrives as a new key carrying the same id, and
            --   the old key is simultaneously gone from the document. The id
            --   IS the person, so that row is this camper under a stale
            --   label: repoint it and keep every row that points at the
            --   number — canteen, Shop, billing — attached to the right child.
            --
            --   a CONFLICT — the holder is still present in the document, so
            --   two live people want one number (two browsers minting at once,
            --   the race this table ends). Skip the stated id, keep or mint
            --   this person's own, and let verify_camp_people() report it.
            --   Never resolved by guesswork.
            -- p_new is ONE branch of the document — this kind's. So "is the
            -- holder still in the document?" can only be asked of a holder of
            -- the SAME kind: a camper's name is not in the staff list, and
            -- reading its absence as a rename turned a camper into a counselor
            -- on the first run of this test. A number held by the other kind
            -- is always a conflict; that is the invariant, not an edge case.
            IF v_holder_kind IS DISTINCT FROM p_kind
               OR (p_new ? v_holder)
               OR v_have IS NOT NULL THEN
                v_stated := NULL;                      -- conflict, or ambiguous merge
            ELSE
                UPDATE camp_people
                   SET source_key = r.k, name = v_name, payload = r.v,
                       deleted_at = NULL, updated_at = now()
                 WHERE camp_id = p_camp_id AND person_id = v_stated;
                CONTINUE;                              -- rename handled
            END IF;
        END IF;

        v_id := COALESCE(v_stated, v_have);

        IF v_id IS NULL THEN
            v_id := public.mint_person_id(p_camp_id);
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, true, r.v)
            ON CONFLICT (camp_id, person_id) DO NOTHING;
        ELSIF v_have IS NOT NULL AND v_id IS DISTINCT FROM v_have THEN
            -- The camp renumbered this person by hand onto a free number.
            --
            -- 237: AND EVERY ROW THAT POINTS AT THEM COMES TOO. This used to move
            -- camp_people.person_id alone, leaving the canteen account, the
            -- ledger, the alerts, the mail, the medical submissions and the
            -- billing enrolment all pointing at a number that now belongs to
            -- nobody. Nothing checked for that — verify_camper_ids counts a row
            -- WITH an id as healthy whether or not the id resolves — so a
            -- deliberate renumber silently detached a camper's entire history
            -- and every verifier read green.
            --
            -- Moved BEFORE the row, because the destination must be free of a
            -- conflicting canteen account and _move_person_references is what
            -- knows how to refuse.
            PERFORM public._move_person_references(p_camp_id, v_have, v_id);
            UPDATE camp_people
               SET person_id = v_id, name = v_name, payload = r.v,
                   minted = false, deleted_at = NULL, updated_at = now()
             WHERE camp_id = p_camp_id AND kind = p_kind AND source_key = r.k
               AND deleted_at IS NULL;
        ELSE
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, v_stated IS NULL, r.v)
            ON CONFLICT (camp_id, person_id) DO UPDATE
               SET source_key = EXCLUDED.source_key,
                   name       = EXCLUDED.name,
                   payload    = EXCLUDED.payload,
                   deleted_at = NULL,
                   updated_at = now();
        END IF;
    END LOOP;

    -- Gone from the document → stamped, never destroyed. The id stays spoken
    -- for, so a deleted camper's number is not handed to the next arrival and
    -- their canteen history cannot silently reattach to a stranger.
    --
    -- 237: that was the INTENT and not the behaviour. The lookup above found
    -- departed rows, so the number WAS handed over. It is now true.
    UPDATE camp_people p
       SET deleted_at = now(), updated_at = now()
     WHERE p.camp_id = p_camp_id
       AND p.kind    = p_kind
       AND p.deleted_at IS NULL
       AND NOT (p_new ? p.source_key);
END;
$$;
REVOKE ALL ON FUNCTION public._project_people(uuid, text, jsonb, jsonb, text, text)
    FROM public, anon, authenticated;


-- ─── 4. and when the office says it IS the same child ───────────────────────
-- The deliberate merge. A new arrival was minted their own number; the office
-- recognises them as a camper who was here before. Attach them to the identity
-- they already have, and move their new rows onto it.
--
-- THE DOCUMENT HAS TO AGREE. app1.camperRoster is the source of truth and its
-- entry carries a camperId; if only the table were changed, the next Me-page save
-- would project the entry back onto the new number and split them apart again.
-- So this writes camperId into the document too, which is the one thing that
-- makes the merge stick.
CREATE OR REPLACE FUNCTION public.camper_returns_as(
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
    caller  uuid := auth.uid();
    v_live  bigint;
    v_key   text;
    v_gone  record;
    v_moved jsonb;
    v_doc   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR NOT public._is_camp_admin(p_camp_id, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    -- The person enrolled under that spelling right now.
    SELECT person_id, source_key INTO v_live, v_key
      FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND deleted_at IS NULL
       AND lower(btrim(source_key)) = lower(btrim(COALESCE(p_name, '')))
     LIMIT 1;
    IF v_live IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_live_camper_of_that_name');
    END IF;

    -- And the departed person they are said to be.
    SELECT person_id, source_key, deleted_at INTO v_gone
      FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_person_id;
    IF v_gone.person_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_camper');
    END IF;
    IF v_gone.deleted_at IS NULL THEN
        -- Both enrolled. That is not a return, it is two children, and merging
        -- them would destroy one.
        RETURN jsonb_build_object('success', false, 'error', 'that_camper_is_still_enrolled',
            'detail', 'Person ' || p_person_id || ' (' || v_gone.source_key || ') is on the '
                   || 'roster now. A return means attaching to somebody who has LEFT.');
    END IF;
    IF v_live = p_person_id THEN
        RETURN jsonb_build_object('success', true, 'already', true, 'person_id', v_live);
    END IF;

    IF NOT p_confirm THEN
        RETURN jsonb_build_object(
            'success', true, 'dry_run', true,
            'would_merge', jsonb_build_object(
                'the_new_row', v_live, 'onto_the_returning_identity', p_person_id,
                'rows_that_would_move',
                    (SELECT count(*) FROM camp_canteen_accounts
                      WHERE camp_id = p_camp_id AND person_id = v_live)),
            'to_apply', 'SELECT public.camper_returns_as(''' || p_camp_id || '''::uuid, '
                     || quote_literal(p_name) || ', ' || p_person_id || ', true);');
    END IF;

    -- Move the new arrival's rows onto the identity they are returning to. This
    -- raises rather than half-moving if both hold a canteen account.
    v_moved := public._move_person_references(p_camp_id, v_live, p_person_id);

    -- One row for one person: the freshly minted one goes, and the returning one
    -- comes back under the spelling in use now.
    DELETE FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = v_live;

    UPDATE camp_people
       SET source_key = v_key, name = v_key, deleted_at = NULL, updated_at = now()
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_person_id;

    -- And the document, or the next save undoes all of it.
    SELECT value INTO v_doc FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'app1' FOR UPDATE;
    IF v_doc IS NOT NULL
       AND jsonb_typeof(v_doc #> ARRAY['camperRoster', v_key]) = 'object' THEN
        UPDATE camp_state_kv
           SET value = jsonb_set(v_doc,
                         ARRAY['camperRoster', v_key, 'camperId'],
                         to_jsonb(p_person_id), true),
               updated_at = now()
         WHERE camp_id = p_camp_id AND key = 'app1';
    END IF;

    RETURN jsonb_build_object('success', true, 'merged', true,
                              'person_id', p_person_id, 'retired_row', v_live,
                              'references_moved', v_moved,
                              'document_updated', v_doc IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.camper_returns_as(uuid, text, bigint, boolean)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camper_returns_as(uuid, text, bigint, boolean)
    TO authenticated;


-- ─── 5. and the question nobody was asking ──────────────────────────────────
-- Does every person_id in the database belong to somebody? Nothing asked that,
-- which is why a renumber could detach a camper's whole history and every
-- verifier still reported green. A stamped id that resolves to nobody is a
-- silent #REF!.
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
    v_money   numeric := 0;
    v_m       numeric;
BEGIN
    FOR t IN
        SELECT DISTINCT ON (c.relname) c.relname::text AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname <> 'camp_people'
           AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname = 'person_id'
           AND EXISTS (SELECT 1 FROM pg_attribute q WHERE q.attrelid = c.oid
                        AND q.attname = 'camp_id' AND q.attnum > 0 AND NOT q.attisdropped)
         ORDER BY c.relname
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM public.%I x'
            || ' WHERE x.person_id IS NOT NULL'
            || '   AND NOT EXISTS (SELECT 1 FROM public.camp_people p'
            || '                    WHERE p.camp_id = x.camp_id'
            || '                      AND p.person_id = x.person_id)', t.table_name)
          INTO v_n;
        IF v_n > 0 THEN
            v_total  := v_total + v_n;
            v_counts := jsonb_set(v_counts, ARRAY[t.table_name], to_jsonb(v_n));
        END IF;
    END LOOP;

    -- And how much money is on a dangling id, because that is the number that
    -- decides whether this is tidying or an incident.
    SELECT COALESCE(sum(a.balance), 0) INTO v_m
      FROM camp_canteen_accounts a
     WHERE a.person_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM camp_people p
                        WHERE p.camp_id = a.camp_id AND p.person_id = a.person_id);
    v_money := COALESCE(v_m, 0);

    RETURN jsonb_build_object(
        'success', true,
        -- Must be 0. Anything here is a row attached to a person who does not
        -- exist, which every other verifier counts as healthy.
        'rows_pointing_at_nobody', v_total,
        'by_table', v_counts,
        'money_on_a_dangling_id', v_money,
        'live_campers', (SELECT count(*) FROM camp_people
                          WHERE kind = 'camper' AND deleted_at IS NULL),
        'departed_campers', (SELECT count(*) FROM camp_people
                              WHERE kind = 'camper' AND deleted_at IS NOT NULL),
        -- A departed camper whose spelling a live camper now uses. Before 237
        -- these two were the SAME row.
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


-- ─── 6. the assertions ──────────────────────────────────────────────────────
DO $$
DECLARE
    v_pred text;
BEGIN
    -- The index is partial, and on the right predicate. Checked because a later
    -- "cleanup" that restores the total index silently reopens all of this.
    SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'uq_camp_people_source';
    IF v_pred IS NULL OR v_pred !~ 'deleted_at IS NULL' THEN
        RAISE EXCEPTION 'uq_camp_people_source is not partial on deleted_at IS NULL (%), '
                        'so a departed camper still blocks a new arrival',
                        COALESCE(v_pred, 'no predicate');
    END IF;

    -- The lookup excludes the departed.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_project_people'
                      AND p.prosrc ~ 'source_key = r\.k[^;]*deleted_at IS NULL') THEN
        RAISE EXCEPTION '_project_people still looks up a person by name without excluding '
                        'the departed — the number can still be handed over';
    END IF;

    -- And the renumber carries the references.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_project_people'
                      AND p.prosrc ~ '_move_person_references') THEN
        RAISE EXCEPTION '_project_people renumbers a person without moving what points at them';
    END IF;

    -- One overload each.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'camper_returns_as') <> 1 THEN
        RAISE EXCEPTION 'camper_returns_as has more than one overload';
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- rows_pointing_at_nobody must be 0. If it is not, this file did not cause it —
-- a renumber before today did, and _move_person_references is what repairs it:
--     SELECT public._move_person_references('<camp>'::uuid, <dangling id>, <real id>);
SELECT 'migration 237 applied' AS status,
       public.verify_person_references() AS person_references;
