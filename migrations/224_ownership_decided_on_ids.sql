-- ============================================================================
-- 224 — which children a parent may see is decided on ids
--
-- WHY THIS ONE FIRST. Of the thirty functions still speaking names, two decide
-- ACCESS: _parent_owns_camper gates a child's photos, face data, health
-- documents and mail, and verify_my_camper gates PDF form submissions and photo
-- checkout. Both ask the same question, and both ask it like this:
--
--     AND (i.camper_names IS NULL OR i.camper_names ? p_camper_name)
--
-- A jsonb string match on a NAME. Three consequences, all of them live:
--
--   1. TWO CAMPERS, ONE NAME. Two children called Chaim Katz in one camp, and
--      each one's parent is granted access to the other's health documents,
--      face descriptor and camper mail. Nothing in the system notices. This is
--      not a hypothetical: camps run families, cousins and repeated names, and
--      216 exists because the app only ever checked uniqueness of NUMBERS.
--   2. A RENAME LOCKS A PARENT OUT of their own child — the invite still says
--      'Ayala Weiss', the roster now says 'Ayala Weiss-Katz', and `?` is exact.
--   3. A TRAILING SPACE does the same thing, invisibly.
--
-- 223 gave link_parent_invites a positional person_ids array beside
-- camper_names, so the question can now be asked about a person instead of a
-- string. This file asks it that way.
--
-- THE THREE ANSWERS, because there are three situations and answering them the
-- same way is what the old rule did:
--
--   RESOLVED — the name means exactly one camper. Decided on the id. A rename
--     is now invisible to access control, which is the entire point.
--   UNKNOWN — nobody in camp_people answers to the name at all, because the
--     camper was typed onto an invite before being added to the roster. There is
--     no id to compare, so the invite's own list is still the only thing there
--     is to check. Falls back to the name, and the verifier counts it.
--   AMBIGUOUS — two campers answer to it. This REFUSES. Guessing is what the
--     old rule did, and it guessed in the direction of showing one child's
--     medical forms to another child's parent. verify_camper_ownership() names
--     every collision so the camp can disambiguate its roster, which is work
--     only the camp can do.
--
-- SELF-HEALING, or this migration locks people out. 223 stamped person_ids
-- positionally, with null where a name did not resolve AT THAT MOMENT. A camper
-- added to the roster a week after the invite was sent would have a permanent
-- null, and an id-only check would refuse their own parent forever. So a null
-- slot means "not known yet", not "not this child": it is re-resolved against
-- camp_people at check time. Invites written before 223 have no person_ids at
-- all, and are handled by the same rule.
--
-- WHAT DOES NOT CHANGE. Both functions keep their exact signatures, so all
-- eleven call sites and every RLS policy that references them keep working
-- untouched. The camp-wide wildcard — an invite naming no campers covers the
-- whole camp — is unchanged.
--
-- ONE THING GETS STRICTER BY ACCIDENT OF BEING CORRECT: verify_my_camper used
-- to load the single most recent active invite and check only that one, so a
-- parent holding two invites in one camp was answered from whichever was newer.
-- It now asks about all of the parent's active invites for the camp, like
-- _parent_owns_camper always did.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent. Run
-- verify_camper_ownership() afterwards and read `ambiguous_names` — anything
-- there is a parent who can no longer reach their child until the roster
-- distinguishes them, and it is also a parent who could previously reach
-- somebody else's.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_person_by_name') THEN
        RAISE EXCEPTION 'camp_person_by_name is missing — apply migration 223 before this file';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'link_parent_invites'
                      AND column_name = 'person_ids') THEN
        RAISE EXCEPTION 'link_parent_invites.person_ids is missing — apply migration 223 first';
    END IF;
END $$;


-- ─── 1. does this parent's invite cover this PERSON ─────────────────────────
-- The new gate. Everything else in this file is a way of getting a name to it.
CREATE OR REPLACE FUNCTION public._parent_owns_person(p_camp_id uuid, p_person_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_person_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM link_parent_invites i
         WHERE i.user_id = auth.uid()
           AND i.camp_id = p_camp_id
           AND i.status  = 'active'
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND (
                -- Unchanged: an invite that names no campers covers the camp.
                i.camper_names IS NULL

                -- @> and not ?, because these are jsonb NUMBERS. `?` tests for a
                -- string element, so '[880]' ? '880' is false — the kind of
                -- silent always-false that would have made this whole file a
                -- lockout rather than a fix.
                OR i.person_ids @> to_jsonb(p_person_id)

                -- A null slot is "not known yet", not "not this child".
                -- Re-resolved here so a camper added to the roster after the
                -- invite was sent does not lock out their own parent — and so
                -- invites written before 223, which have no person_ids at all,
                -- keep working.
                OR (jsonb_typeof(i.camper_names) = 'array' AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord)
                      WHERE COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) = 'null'::jsonb
                        AND public.camp_person_by_name(i.camp_id, e.value #>> '{}') = p_person_id))
           )
    );
$$;
REVOKE ALL ON FUNCTION public._parent_owns_person(uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._parent_owns_person(uuid, bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public._parent_owns_person(uuid, bigint) IS
    'Whether an active invite of the calling parent covers this camper id. Null slots in person_ids are re-resolved, so a camper added after the invite was sent still reaches their parent.';


-- ─── 2. the name-taking gate, now id-first ──────────────────────────────────
-- Same signature, same grants, same callers. What changed is which question it
-- asks when it can ask a better one. See the header for the three answers.
CREATE OR REPLACE FUNCTION public._parent_owns_camper(p_camp_id uuid, p_camper_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id      bigint;
    v_matches integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(btrim(p_camper_name), '') = '' THEN
        RETURN false;
    END IF;

    v_id := public.camp_person_by_name(p_camp_id, p_camper_name);
    IF v_id IS NOT NULL THEN
        RETURN public._parent_owns_person(p_camp_id, v_id);
    END IF;

    -- camp_person_by_name returns NULL for two different reasons and they must
    -- not get the same answer. Ask which one it was.
    SELECT count(DISTINCT person_id) INTO v_matches
      FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper'
       AND lower(btrim(source_key)) = lower(btrim(p_camper_name));

    IF v_matches > 1 THEN
        -- AMBIGUOUS. Refused. Under the old rule both parents were granted
        -- access to both children.
        RETURN false;
    END IF;

    -- UNKNOWN. No id exists to compare, so the invite's own list is all there
    -- is. This is the one remaining path that trusts a string, and
    -- verify_camper_ownership() counts it.
    RETURN EXISTS (
        SELECT 1 FROM link_parent_invites i
         WHERE i.user_id = auth.uid()
           AND i.camp_id = p_camp_id
           AND i.status  = 'active'
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND (i.camper_names IS NULL OR i.camper_names ? p_camper_name));
END;
$$;
REVOKE ALL ON FUNCTION public._parent_owns_camper(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._parent_owns_camper(uuid, text) TO authenticated, service_role;


-- ─── 3. verify_my_camper, on the same rule ──────────────────────────────────
-- Two callers, both edge functions: submit-pdf-form-response and
-- link-photo-checkout. Its camp id arrives as TEXT and may be blank, meaning
-- "any camp this parent has an invite for", which is why it cannot simply be an
-- alias for _parent_owns_camper.
CREATE OR REPLACE FUNCTION public.verify_my_camper(p_camp_id text, p_camper_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_camp uuid;
BEGIN
    IF caller IS NULL OR COALESCE(btrim(p_camper_name), '') = '' THEN
        RETURN false;
    END IF;

    IF COALESCE(btrim(p_camp_id), '') <> '' THEN
        BEGIN
            v_camp := p_camp_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            -- A camp id that is not a uuid is not a camp. Silently ignoring it
            -- would widen the check to every camp this parent belongs to.
            RETURN false;
        END;
        RETURN public._parent_owns_camper(v_camp, p_camper_name);
    END IF;

    -- No camp given: ask every camp this parent holds an active invite for.
    -- The old version took only the most recently created invite, so a parent
    -- with two was answered from whichever happened to be newer.
    RETURN EXISTS (
        SELECT 1
          FROM (SELECT DISTINCT camp_id FROM link_parent_invites
                 WHERE user_id = caller AND status = 'active'
                   AND (expires_at IS NULL OR expires_at > now())) c
         WHERE public._parent_owns_camper(c.camp_id, p_camper_name));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_my_camper(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_my_camper(text, text) TO authenticated, service_role;


-- ─── 4. the verifier ────────────────────────────────────────────────────────
-- Camp-wide, and the numbers that matter are the last two.
--
-- ambiguous_names is the list of collisions this file now refuses. Each one is
-- simultaneously a parent who has just lost access to their own child AND a
-- parent who until today could reach somebody else's — so it is a list to act
-- on, not a score. Only the camp can fix it, by making the two roster entries
-- distinguishable.
--
-- names_with_no_camper is the remaining name-trusting path: invite entries for
-- children who are not on the roster at all.
CREATE OR REPLACE FUNCTION public.verify_camper_ownership()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_invites    bigint;
    v_wildcard   bigint;
    v_named      bigint;
    v_resolved   bigint;
    v_unknown    bigint;
    v_ambiguous  bigint;
    v_null_slots bigint;
    v_amb_list   jsonb;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE camper_names IS NULL)
      INTO v_invites, v_wildcard
      FROM link_parent_invites
     WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now());

    -- One row per (invite, named camper), which is the unit access is decided
    -- in. An invite listing three children is three decisions.
    WITH entries AS (
        SELECT i.camp_id, e.value #>> '{}' AS nm,
               COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) AS slot
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord)
         WHERE i.status = 'active' AND (i.expires_at IS NULL OR i.expires_at > now())
           AND jsonb_typeof(i.camper_names) = 'array'
    ),
    judged AS (
        SELECT en.*,
               (SELECT count(DISTINCT p.person_id) FROM camp_people p
                 WHERE p.camp_id = en.camp_id AND p.kind = 'camper'
                   AND lower(btrim(p.source_key)) = lower(btrim(en.nm))) AS matches
          FROM entries en
    )
    SELECT count(*),
           count(*) FILTER (WHERE matches = 1),
           count(*) FILTER (WHERE matches = 0),
           count(*) FILTER (WHERE matches > 1),
           count(*) FILTER (WHERE slot = 'null'::jsonb)
      INTO v_named, v_resolved, v_unknown, v_ambiguous, v_null_slots
      FROM judged;

    SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('camp_id', camp_id, 'name', nm)), '[]'::jsonb)
      INTO v_amb_list
      FROM (
        SELECT i.camp_id, e.value #>> '{}' AS nm
          FROM link_parent_invites i
          CROSS JOIN LATERAL jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord)
         WHERE i.status = 'active' AND (i.expires_at IS NULL OR i.expires_at > now())
           AND jsonb_typeof(i.camper_names) = 'array'
           AND (SELECT count(DISTINCT p.person_id) FROM camp_people p
                 WHERE p.camp_id = i.camp_id AND p.kind = 'camper'
                   AND lower(btrim(p.source_key)) = lower(btrim(e.value #>> '{}'))) > 1) a;

    RETURN jsonb_build_object(
        'success', true,
        'active_invites', v_invites,
        'camp_wide_invites', v_wildcard,
        'camper_entries', v_named,
        'decided_on_an_id', v_resolved,
        -- Re-resolved at check time rather than refused. Not a problem; a count
        -- worth seeing, because it is how many decisions depend on the healing.
        'entries_with_a_null_id_slot', v_null_slots,
        -- The remaining name-trusting path.
        'names_with_no_camper', v_unknown,
        -- The hole this file closes, and the work only the camp can do.
        'names_matching_two_campers', v_ambiguous,
        'ambiguous_names', v_amb_list);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camper_ownership() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camper_ownership() TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 224 applied'             AS status,
       public.verify_camper_ownership()    AS ownership;
