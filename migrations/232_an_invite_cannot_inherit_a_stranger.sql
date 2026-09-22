-- ============================================================================
-- 232 — an invite cannot inherit a stranger
--
-- WHAT IS BROKEN RIGHT NOW, AND I WROTE IT. 225's _invite_covers_person ends
-- with a null-slot re-resolution:
--
--     OR (jsonb_typeof(i.camper_names) = 'array' AND EXISTS (
--          SELECT 1 FROM jsonb_array_elements(i.camper_names)
--                         WITH ORDINALITY AS e(value, ord)
--           WHERE COALESCE(i.person_ids -> (e.ord - 1)::int, 'null') = 'null'
--             AND public.camp_person_by_name(i.camp_id, e.value #>> '{}')
--                 = p_person_id))
--
-- The comment beside it says "a null slot is 'not known yet', not 'not this
-- child'", and for the case it was written for that is right: an invite may
-- name a camper who is not on the roster yet, and when that camper is finally
-- enrolled the parent should be able to act for them.
--
-- But the rule as written does not say "the camper this invite meant". It says
-- "whoever holds this name now". So:
--
--   1. An invite is written naming "QATest QACamper".
--   2. That camper leaves, or was never enrolled. The slot stays null.
--   3. A DIFFERENT child is enrolled later under the same name.
--   4. camp_person_by_name now returns the new child's id, the null slot
--      matches it, and the first parent can submit health documents, pickup
--      requests, mail and canteen instructions for a child who is not theirs.
--
-- Step 3 is not exotic. It is two siblings a year apart, a family returning, or
-- the same name typed twice. This is the exact failure the whole id programme
-- exists to prevent, sitting inside the function that was supposed to prevent
-- it: a name is not an identity, and I used one as an identity in the fallback.
--
-- THERE ARE FIVE OF THESE LIVE. verify_camper_ownership() reports 12 camper
-- entries with a null id slot. Seven belong to camps that no longer exist and
-- go when the orphan purge runs. The other five are active invites in a camp
-- with a 21-camper roster, naming campers who are not in it. Every one of those
-- five is a slot waiting to be inherited. (They are test campers — this is not
-- an incident report, it is the shape.)
--
-- WHY A TIMESTAMP AND NOT AN ENROLMENT DATE. The obvious bound is "the camper
-- existed when the invite was written", but the camp's roster is a name-keyed
-- object in app1.camperRoster with no join date, and camp_people.first_seen is
-- when the row was PROJECTED — for most campers, the moment 216's backfill ran,
-- which is after almost every invite. So a bound against the invite's
-- created_at would deny every existing parent.
--
-- What we can trust is a fact we create ourselves: the moment this file last
-- looked at an invite and wrote down what it found. A camper whose row is older
-- than that moment was visible when we looked and was not chosen. A camper
-- whose row is newer arrived afterwards and cannot be who the invite meant.
-- That is the bound, and it needs nothing from the camp's data.
--
-- WHAT THIS COSTS, SAID PLAINLY. The workflow 223 protected — invite the
-- parent, enrol the camper afterwards — no longer resolves by itself. After
-- this file, a camper who arrives later does not silently attach to a waiting
-- invite. Somebody has to say so. That is the point: the silent guess becomes a
-- visible decision, made by someone who can tell the two children apart.
--
-- So this file also ships the two things that makes tolerable:
--
--   * restamp_parent_invite(uuid) — an owner/admin re-resolves ONE invite and
--     advances its mark. One call, and the newly enrolled camper attaches.
--   * parent_invites_needing_attention(uuid) — the list to act on: every active
--     invite naming a camper it is not stamped for. Without this the office
--     cannot know a restamp is needed, and a fail-closed gate nobody can see is
--     just a broken feature.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent. It adds
-- a column, rewrites two functions and one trigger, and stamps existing rows;
-- it deletes nothing.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'link_parent_invites'
                      AND column_name = 'person_ids') THEN
        RAISE EXCEPTION '232 needs link_parent_invites.person_ids — apply 223 first';
    END IF;
    IF to_regprocedure('public._invite_covers_person(uuid,bigint)') IS NULL THEN
        RAISE EXCEPTION '232 rewrites _invite_covers_person — apply 225 first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'camp_people'
                      AND column_name = 'first_seen') THEN
        RAISE EXCEPTION '232 bounds re-resolution on camp_people.first_seen — apply 216 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the mark ────────────────────────────────────────────────────────────
-- When this invite's slots were last deliberately resolved. Nullable only for
-- the instant between the ALTER and the UPDATE below; after this file no row
-- has it null, and the gate treats null as "refuse" rather than "allow",
-- because a fallback that opens when it cannot tell is how we got here.
ALTER TABLE public.link_parent_invites
    ADD COLUMN IF NOT EXISTS person_ids_resolved_at timestamptz;

COMMENT ON COLUMN public.link_parent_invites.person_ids_resolved_at IS
    'When person_ids was last resolved against the roster. A camper whose '
    'camp_people row is newer than this cannot be claimed by a null slot — see 232.';


-- ─── 2. resolve every slot once, and write down when ────────────────────────
-- Null slots that resolve NOW get their id, so every parent whose camper is on
-- the roster today keeps working without a restamp. Slots that still do not
-- resolve stay null and are reported by section 5.
--
-- The 223 trigger fires on INSERT OR UPDATE OF camper_names, so writing
-- person_ids here does not re-enter it.
UPDATE public.link_parent_invites i
   SET person_ids = CASE
           WHEN jsonb_typeof(i.camper_names) = 'array'
                AND jsonb_array_length(i.camper_names) > 0
           THEN (SELECT jsonb_agg(
                          -- Keep a slot that is already decided. -> on a null
                          -- element yields the jsonb literal 'null', and on an
                          -- absent index yields SQL NULL; NULLIF turns the first
                          -- into the second so COALESCE handles both the same.
                          COALESCE(
                            NULLIF(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb),
                            to_jsonb(public.camp_person_by_name(i.camp_id, e.value #>> '{}')))
                          ORDER BY e.ord)
                   FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord))
           ELSE i.person_ids
       END,
       person_ids_resolved_at = now();


-- ─── 3. and every future invite carries the mark from birth ─────────────────
-- 223's trigger returns early when person_ids is supplied by the caller, which
-- would leave the mark null on exactly the rows a caller controls. So the mark
-- is set BEFORE that early return — it is a fact about when the row was
-- written, not about what the body did.
CREATE OR REPLACE FUNCTION public.stamp_invite_person_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    -- Unconditional, and first. Everything below may return early.
    NEW.person_ids_resolved_at := now();

    IF NEW.person_ids IS NOT NULL OR NEW.camp_id IS NULL
       OR jsonb_typeof(NEW.camper_names) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;
    NEW.person_ids := (
        SELECT jsonb_agg(to_jsonb(public.camp_person_by_name(NEW.camp_id, e.value #>> '{}'))
                         ORDER BY e.ord)
          FROM jsonb_array_elements(NEW.camper_names) WITH ORDINALITY AS e(value, ord));
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_invite_person_ids() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_invite_person_ids ON public.link_parent_invites;
CREATE TRIGGER trg_stamp_invite_person_ids
BEFORE INSERT OR UPDATE OF camper_names ON public.link_parent_invites
FOR EACH ROW EXECUTE FUNCTION public.stamp_invite_person_ids();


-- ─── 4. the gate, bounded ───────────────────────────────────────────────────
-- Three ways an invite covers a person, unchanged except for the third:
--
--   * it names no campers at all           → it covers the camp
--   * this id is stamped on it             → decided, and decided on an id
--   * a null slot whose name resolves here → only if that camper was already
--                                            visible when we last looked
--
-- The join to camp_people is what makes the third clause answerable: without
-- the row we have no first_seen to compare, and "no row" must not mean "allow".
CREATE OR REPLACE FUNCTION public._invite_covers_person(p_invite uuid, p_person_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_person_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM link_parent_invites i
         WHERE i.id = p_invite
           AND (
                -- An invite naming no campers covers the camp.
                i.camper_names IS NULL

                -- @> and not ?, because these are jsonb NUMBERS: '[880]' ? '880'
                -- is false, which would make this silently always-false.
                OR i.person_ids @> to_jsonb(p_person_id)

                -- A null slot is "not known yet" — but only for a camper who
                -- was already there the last time we looked. A camper enrolled
                -- AFTER that cannot be who this invite meant, and letting one
                -- claim the slot is how a parent reaches somebody else's child.
                -- 232. Restamp the invite to attach a later arrival on purpose.
                OR (jsonb_typeof(i.camper_names) = 'array'
                    AND i.person_ids_resolved_at IS NOT NULL
                    AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord)
                       JOIN camp_people p
                         ON p.camp_id = i.camp_id AND p.kind = 'camper'
                        AND p.person_id = p_person_id
                      WHERE COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) = 'null'::jsonb
                        AND public.camp_person_by_name(i.camp_id, e.value #>> '{}') = p_person_id
                        AND p.first_seen <= i.person_ids_resolved_at))
           )
    );
$$;
REVOKE ALL ON FUNCTION public._invite_covers_person(uuid, bigint) FROM public, anon, authenticated;

-- _invite_covers_camper needs no change and this says why, so nobody "fixes" it
-- later. Its UNKNOWN branch is reached only when camp_person_by_name returned
-- NULL, i.e. when NO camper of that name exists (one match returns the id;
-- two or more are refused above it). Falling back to the string there cannot
-- reach a child, because there is no child of that name — and the moment one
-- exists, the call goes down the id path into the bounded clause above.
COMMENT ON FUNCTION public._invite_covers_camper(uuid, text) IS
    'Name-shaped wrapper over _invite_covers_person. Its string fallback is '
    'reachable only when no camper holds the name; once one does, 232''s bound '
    'in _invite_covers_person decides.';


-- ─── 5. what the office has to be able to see ───────────────────────────────
-- A fail-closed gate nobody can see is a broken feature. This is the list:
-- every active invite naming a camper it is not stamped for, with why.
CREATE OR REPLACE FUNCTION public.parent_invites_needing_attention(p_camp_id uuid DEFAULT NULL)
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

    SELECT COALESCE(jsonb_agg(x.row ORDER BY x.camp_id, x.name), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT i.camp_id, e.value #>> '{}' AS name,
               jsonb_build_object(
                 'invite_id',   i.id,
                 'camp_id',     i.camp_id,
                 'parent',      i.parent_email,
                 'camper_name', e.value #>> '{}',
                 'reason',
                 CASE
                   WHEN public.camp_person_by_name(i.camp_id, e.value #>> '{}') IS NULL
                        AND EXISTS (SELECT 1 FROM camp_people p
                                     WHERE p.camp_id = i.camp_id AND p.kind = 'camper'
                                       AND lower(btrim(p.source_key)) = lower(btrim(e.value #>> '{}')))
                        THEN 'two campers share this name — refused, never guessed'
                   WHEN public.camp_person_by_name(i.camp_id, e.value #>> '{}') IS NULL
                        THEN 'no camper of this name on the roster'
                   ELSE 'this camper was enrolled after the invite was last resolved — '
                        || 'restamp to attach them'
                 END,
                 'to_fix', 'SELECT public.parent_invites_needing_attention(''' || i.camp_id
                           || '''::uuid);  then  SELECT public.restamp_parent_invite('''
                           || i.id || '''::uuid);'
               ) AS row
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                   THEN i.camper_names ELSE '[]'::jsonb END) AS e(value)
         WHERE i.status = 'active'
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND (p_camp_id IS NULL OR i.camp_id = p_camp_id)
           AND (p_camp_id IS NOT NULL OR public._is_camp_admin(i.camp_id, caller))
           -- Not covered: either nothing resolves, or what resolves is not
           -- reachable through the bounded clause.
           AND NOT public._invite_covers_camper(i.id, e.value #>> '{}')
      ) x;

    RETURN jsonb_build_object('success', true, 'invites', v_out,
                              'count', jsonb_array_length(v_out));
END;
$$;
REVOKE ALL ON FUNCTION public.parent_invites_needing_attention(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.parent_invites_needing_attention(uuid) TO authenticated;


-- ─── 6. and the deliberate decision ─────────────────────────────────────────
-- One invite, re-resolved against the roster as it is now, mark advanced. This
-- is the only way a later arrival attaches to a waiting slot, and it is gated
-- on owner/admin because deciding that two spellings are one child is a
-- judgement a person makes, not a lookup.
CREATE OR REPLACE FUNCTION public.restamp_parent_invite(p_invite uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_camp  uuid;
    v_names jsonb;
    v_before jsonb;
    v_after  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT i.camp_id, i.camper_names, i.person_ids
      INTO v_camp, v_names, v_before
      FROM link_parent_invites i WHERE i.id = p_invite
       FOR UPDATE;
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invite_not_found');
    END IF;
    IF NOT public._is_camp_admin(v_camp, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    IF jsonb_typeof(v_names) IS DISTINCT FROM 'array' OR jsonb_array_length(v_names) = 0 THEN
        -- An invite naming no campers covers the camp; there is nothing to
        -- resolve, but the mark still moves so the row is not left behind.
        UPDATE link_parent_invites SET person_ids_resolved_at = now() WHERE id = p_invite;
        RETURN jsonb_build_object('success', true, 'camp_wide', true, 'person_ids', v_before);
    END IF;

    -- Re-resolve EVERY slot, not only the null ones. A slot stamped with an id
    -- that no longer exists in the roster is exactly as stale as a null one.
    SELECT jsonb_agg(to_jsonb(public.camp_person_by_name(v_camp, e.value #>> '{}')) ORDER BY e.ord)
      INTO v_after
      FROM jsonb_array_elements(v_names) WITH ORDINALITY AS e(value, ord);

    UPDATE link_parent_invites
       SET person_ids = COALESCE(v_after, person_ids),
           person_ids_resolved_at = now()
     WHERE id = p_invite;

    RETURN jsonb_build_object(
        'success', true,
        'camp_id', v_camp,
        'was', COALESCE(v_before, 'null'::jsonb),
        'now', COALESCE(v_after, 'null'::jsonb),
        'still_unresolved',
            (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_after, '[]'::jsonb)) AS s(v)
              WHERE s.v = 'null'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.restamp_parent_invite(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.restamp_parent_invite(uuid) TO authenticated;


-- ─── 7. the verifier ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_parent_invite_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_invites   bigint;
    v_unmarked  bigint;
    v_entries   bigint;
    v_null      bigint;
    v_claimable bigint;
    v_queue     bigint;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE person_ids_resolved_at IS NULL)
      INTO v_invites, v_unmarked
      FROM link_parent_invites
     WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now());

    SELECT count(*), count(*) FILTER (
             WHERE COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) = 'null'::jsonb)
      INTO v_entries, v_null
      FROM link_parent_invites i
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(i.camper_names) = 'array'
               THEN i.camper_names ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
     WHERE i.status = 'active' AND (i.expires_at IS NULL OR i.expires_at > now());

    -- TWO DIFFERENT QUESTIONS, and the first version of this verifier conflated
    -- them — it re-derived the dangerous CONDITION and reported the fix as
    -- failing while the gate was correctly refusing. 232's own behaviour test
    -- caught that. A verifier that restates the rule instead of exercising it
    -- proves only that it can restate the rule.
    --
    -- 1. THE ASSERTION. Does the gate actually refuse? Asked by calling the
    --    gate, not by rewriting its WHERE clause. Must be 0.
    -- 2. THE QUEUE. How many null slots name a camper who arrived later, and so
    --    need an admin to say whether it is the same child? Expected non-zero,
    --    and worked through with restamp_parent_invite.
    WITH later_arrivals AS (
        SELECT i.id AS invite_id, p.person_id
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                   THEN i.camper_names ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
          JOIN camp_people p
            ON p.camp_id = i.camp_id AND p.kind = 'camper'
           AND p.person_id = public.camp_person_by_name(i.camp_id, e.value #>> '{}')
         WHERE i.status = 'active' AND (i.expires_at IS NULL OR i.expires_at > now())
           AND COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) = 'null'::jsonb
           AND (i.person_ids_resolved_at IS NULL OR p.first_seen > i.person_ids_resolved_at)
    )
    SELECT count(*) FILTER (WHERE public._invite_covers_person(invite_id, person_id)),
           count(*)
      INTO v_claimable, v_queue
      FROM later_arrivals;

    RETURN jsonb_build_object(
        'success', true,
        'active_invites', v_invites,
        'invites_without_a_resolution_mark', v_unmarked,
        'camper_entries', v_entries,
        'entries_with_a_null_id_slot', v_null,
        -- Must be 0. Anything here is a parent who can reach a child that is
        -- not theirs.
        'slots_a_later_arrival_could_claim', v_claimable,
        -- Expected non-zero. Each one is a decision, not a defect.
        'slots_awaiting_a_decision', v_queue,
        'to_see_what_needs_a_person',
            'SELECT public.parent_invites_needing_attention();');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_parent_invite_identity() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_parent_invite_identity() TO authenticated;


-- ─── 8. the assertions ──────────────────────────────────────────────────────
DO $$
DECLARE
    v_n bigint;
BEGIN
    -- Every active invite carries a mark, or the bound has nothing to compare.
    SELECT count(*) INTO v_n FROM link_parent_invites WHERE person_ids_resolved_at IS NULL;
    IF v_n > 0 THEN
        RAISE EXCEPTION '232 left % invite(s) without a resolution mark', v_n;
    END IF;

    -- The gate actually carries the bound. Asked of the catalog, because a
    -- later edit that drops the clause is exactly the regression this file is.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_invite_covers_person'
                      AND p.prosrc ~ 'person_ids_resolved_at'
                      AND p.prosrc ~ 'first_seen') THEN
        RAISE EXCEPTION '_invite_covers_person does not bound its null-slot fallback';
    END IF;

    -- One overload each: PostgREST resolves by argument name, and a defaulted
    -- wider twin makes every call from an edge function ambiguous.
    FOR v_n IN
        SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('_invite_covers_person', 'restamp_parent_invite',
                             'parent_invites_needing_attention', 'verify_parent_invite_identity')
         GROUP BY p.proname
    LOOP
        IF v_n <> 1 THEN
            RAISE EXCEPTION '232 left a function with % overloads', v_n;
        END IF;
    END LOOP;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- slots_a_later_arrival_could_claim must be 0. Anything in
-- parent_invites_needing_attention is a decision for the office, not a bug.
SELECT 'migration 232 applied' AS status,
       public.verify_parent_invite_identity() AS invite_identity;
