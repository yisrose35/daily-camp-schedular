-- ============================================================================
-- Migration 257: a camper number reaches THAT camper, even one who has left
-- while a new child has their name.            (Ted's audit, TED-001)
--
-- THE DEFECT. "Avi Katz" #10 leaves with money on his canteen account. A new
-- "Avi Katz" enrols and is #11. A late card payment or refund for the first
-- Avi arrives carrying #10 — and lands in the new Avi's account.
--
-- Why: 35 functions accept a camper number and then work by name. They turn
-- the number into the camper's name (camp_person_label), then, deeper down,
-- turn the name back into a person (camp_person_by_name). The second step
-- prefers the child enrolled NOW, so #10 → "Avi Katz" → #11.
--
-- THE FIX, in the two functions every one of those paths goes through, so
-- all 35 are fixed at once:
--
--   camp_person_label(camp, #10): the plain name when that name leads back to
--     #10 — which is every ordinary case — and otherwise the name with the
--     number, "Avi Katz #10": when an enrolled child now has the name, when
--     two children's names differ only in capitals or spacing, when two
--     departed children share one.
--
--   camp_person_by_name(camp, "Avi Katz #10"): a name ending in "#<number>"
--     belonging to that person means exactly that person, enrolled or not.
--     This is the same "Name #number" form the canteen already uses for
--     account keys (244), so a key and a label agree.
--
-- The round trip number → name → number is now exact everywhere.
--
-- HOW TO APPLY. Paste into the SQL Editor after 256. Changes no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.camp_person_label(p_camp_id uuid, p_person_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    -- The plain key when it leads back to this very person; otherwise the key
    -- with their number, which always does. That is the whole rule, so the
    -- round trip is exact by construction.
    SELECT CASE WHEN public.camp_person_by_name(p.camp_id, p.source_key) = p.person_id
                THEN p.source_key
                ELSE p.source_key || ' #' || p.person_id END
      FROM camp_people p
     WHERE p.camp_id = p_camp_id AND p.kind = 'camper' AND p.person_id = p_person_id
$$;
COMMENT ON FUNCTION public.camp_person_label(uuid, bigint) IS
    'The camper''s roster key for a person id, or NULL. The plain key when camp_person_by_name leads back to this person, else "<key> #<id>", which always does (257).';


CREATE OR REPLACE FUNCTION public.camp_person_by_name(p_camp_id uuid, p_name text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        -- 257: "<name> #<number>" naming that very person means that person,
        -- enrolled or departed.
        (SELECT p.person_id
           FROM camp_people p
          WHERE p_name ~ ' #[0-9]{1,15}$'
            AND p.camp_id = p_camp_id AND p.kind = 'camper'
            AND p.person_id = substring(p_name FROM ' #([0-9]{1,15})$')::bigint
            AND (p.source_key = p_name
                 OR lower(btrim(p.source_key)) = lower(btrim(regexp_replace(p_name, ' #[0-9]{1,15}$', ''))))
          LIMIT 1),
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
    'The one name-to-camper-id matcher. "<name> #<id>" naming that person → that person (257). Otherwise exact key, then case/space-insensitive, then including departed campers; ambiguous → NULL.';


-- ─── the check: does every camper's number come back to them? ───────────────
-- For every camper, enrolled or departed, in every camp: number → label →
-- number. Anyone for whom that does not come back to themselves is a camper a
-- payment, form or record sent with their number could miss. Empty when right.
CREATE OR REPLACE FUNCTION public.verify_number_round_trip()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'campers_checked', (SELECT count(*) FROM camp_people WHERE kind = 'camper'),
        'numbers_that_miss_their_camper', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('camp_id', p.camp_id, 'camperId', p.person_id,
                                                'name', p.source_key, 'reaches', r.got))
              FROM camp_people p
              CROSS JOIN LATERAL (SELECT public.camp_person_by_name(p.camp_id,
                                         public.camp_person_label(p.camp_id, p.person_id)) AS got) r
             WHERE p.kind = 'camper' AND r.got IS DISTINCT FROM p.person_id), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.verify_number_round_trip() FROM public, anon, authenticated;
