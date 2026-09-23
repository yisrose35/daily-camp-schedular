-- ============================================================================
-- Migration 260: a camper's number stays with that child — in a family's
-- invitation, through a renumber, and after the 253 rename bug.   (Ted
-- TED-010, TED-011, TED-012)
--
-- 1. INVITATIONS (TED-010). A parent invitation lists its children twice:
--    camper_names (roster keys) and person_ids (numbers), position by
--    position. When the office's save rewrote camper_names — a sibling
--    withdrew, or was added in front — person_ids was left as it was, so the
--    numbers slid onto the wrong children: the remaining child was sent to
--    the parent's browser under the sibling's number, and deposits, forms,
--    pickups and photos for them were filed on the sibling. Now, whenever
--    camper_names changes, every slot is decided again:
--      * the number the office sent for that child (camper_data), if any;
--      * else the number that name had in this invitation before;
--      * else the ENROLLED camper who holds that key today —
--    and never a departed child found by name (the old fallback).
--    Every invitation already written is realigned the same way.
--
-- 2. RENUMBERS (TED-012). Typing a new Camper ID moved the child's rows in
--    the tables to the new number (237) but not the records inside the saved
--    documents (health logs, luggage, orders…), which kept the OLD number — a
--    number that could then be given to another child, who would inherit
--    them. Now a renumber rewrites the number inside every saved document too.
--
-- 3. THE 253 RENAME BUG (TED-011). Before 259, renaming a camper gave them a
--    new number and left their money and history on the old one, marked
--    departed. split_renames() lists every child that happened to (dry run;
--    it changes nothing); split_renames(true) puts each back together on
--    their ORIGINAL number — the one their money and history are on.
--
-- Standalone. Paste into the Supabase SQL Editor after 259 and run. Then run
-- scripts/verify_identity_chain.sql and read the 260 row: it shows how many
-- renamed children were split, and the exact line to repair them.
-- ============================================================================


-- ─── 1. invitations: each slot's number is decided again when names change ──
-- The number for one invitation slot. p_data is the invitation's camper_data
-- (the office's roster entries, keyed by roster key), p_old_names/p_old_ids
-- the invitation as it was.
CREATE OR REPLACE FUNCTION public._invite_slot_person(
    p_camp_id uuid, p_name text, p_data jsonb, p_old_names jsonb, p_old_ids jsonb)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id  bigint;
    v_pos int;
BEGIN
    IF COALESCE(btrim(p_name), '') = '' THEN RETURN NULL; END IF;

    -- The number the office sent for this child — if it is a camper here.
    v_id := public._stated_person_id(p_data #>> ARRAY[p_name, 'camperId']);
    IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM camp_people
                                     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = v_id) THEN
        RETURN v_id;
    END IF;

    -- The number this name had in the invitation before.
    IF jsonb_typeof(p_old_names) = 'array' AND jsonb_typeof(p_old_ids) = 'array' THEN
        SELECT e.ord - 1 INTO v_pos
          FROM jsonb_array_elements(p_old_names) WITH ORDINALITY e(value, ord)
         WHERE e.value #>> '{}' = p_name
         LIMIT 1;
        IF v_pos IS NOT NULL THEN
            v_id := public._stated_person_id(p_old_ids ->> v_pos);
            IF v_id IS NOT NULL THEN RETURN v_id; END IF;
        END IF;
    END IF;

    -- The enrolled camper who holds that key today. Never a departed child.
    SELECT person_id INTO v_id
      FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND deleted_at IS NULL AND source_key = p_name
     LIMIT 1;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._invite_slot_person(uuid, text, jsonb, jsonb, jsonb) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stamp_invite_person_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old_names jsonb := NULL;
    v_old_ids   jsonb := NULL;
BEGIN
    NEW.person_ids_resolved_at := now();
    IF NEW.camp_id IS NULL OR jsonb_typeof(NEW.camper_names) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- A caller that set the numbers itself, with the names, is taken at
        -- its word; so is a save that did not change the names.
        IF NEW.person_ids IS DISTINCT FROM OLD.person_ids
           OR NEW.camper_names IS NOT DISTINCT FROM OLD.camper_names THEN
            RETURN NEW;
        END IF;
        v_old_names := OLD.camper_names;
        v_old_ids   := OLD.person_ids;
    ELSIF NEW.person_ids IS NOT NULL THEN
        RETURN NEW;
    END IF;
    NEW.person_ids := (
        SELECT jsonb_agg(to_jsonb(public._invite_slot_person(
                   NEW.camp_id, e.value #>> '{}', NEW.camper_data, v_old_names, v_old_ids))
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

-- The invitations whose numbers disagree with their names: a slot whose
-- number is not the enrolled holder of that name's key, while one exists.
CREATE OR REPLACE FUNCTION public.verify_invite_numbers()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'slots_on_the_wrong_child', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('invite', i.id, 'name', e.value #>> '{}',
                                                'has', i.person_ids -> (e.ord - 1)::int,
                                                'should_have', p.person_id))
              FROM link_parent_invites i
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                                                           THEN i.camper_names ELSE '[]'::jsonb END)
                         WITH ORDINALITY e(value, ord)
              JOIN camp_people p ON p.camp_id = i.camp_id AND p.kind = 'camper'
                                AND p.deleted_at IS NULL AND p.source_key = e.value #>> '{}'
             WHERE public._stated_person_id(i.person_ids ->> (e.ord - 1)::int) IS DISTINCT FROM p.person_id),
            '[]'::jsonb),
        'lists_of_different_lengths', (
            SELECT count(*) FROM link_parent_invites
             WHERE jsonb_typeof(person_ids) = 'array' AND jsonb_typeof(camper_names) = 'array'
               AND jsonb_array_length(person_ids) <> jsonb_array_length(camper_names)));
$$;
REVOKE ALL ON FUNCTION public.verify_invite_numbers() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_invite_numbers() TO authenticated, service_role;

-- Realign every invitation written before this file: each slot decided from
-- the office's data, then the enrolled key holder; a slot nothing can decide
-- keeps what it had (an erased or departed child's slot, which grants nothing
-- to anyone else).
UPDATE public.link_parent_invites i
   SET person_ids = (
        SELECT jsonb_agg(COALESCE(
                   to_jsonb(public._invite_slot_person(i.camp_id, e.value #>> '{}', i.camper_data, NULL, NULL)),
                   NULLIF(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb),
                   'null'::jsonb)
               ORDER BY e.ord)
          FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY e(value, ord))
 WHERE i.camp_id IS NOT NULL AND jsonb_typeof(i.camper_names) = 'array'
   AND jsonb_array_length(i.camper_names) > 0;


-- ─── 2. a renumber carries the records inside saved documents too ───────────
-- p_doc with every record's number p_from replaced by p_to (camperId,
-- personId, person_id, camper_id — as a number or a string).
CREATE OR REPLACE FUNCTION public._json_renumber(p_doc jsonb, p_from bigint, p_to bigint)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
    e     record;
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        v_out := '{}'::jsonb;
        FOR e IN SELECT key, value FROM jsonb_each(p_doc) LOOP
            IF e.key IN ('camperId', 'personId', 'person_id', 'camper_id')
               AND jsonb_typeof(e.value) IN ('number', 'string')
               AND public._stated_person_id(e.value #>> '{}') = p_from THEN
                v_out := v_out || jsonb_build_object(e.key,
                           CASE WHEN jsonb_typeof(e.value) = 'string' THEN to_jsonb(p_to::text) ELSE to_jsonb(p_to) END);
            ELSE
                v_out := v_out || jsonb_build_object(e.key, public._json_renumber(e.value, p_from, p_to));
            END IF;
        END LOOP;
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        SELECT COALESCE(jsonb_agg(public._json_renumber(x.value, p_from, p_to) ORDER BY x.ord), '[]'::jsonb)
          INTO v_out FROM jsonb_array_elements(p_doc) WITH ORDINALITY x(value, ord);
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;

-- Every saved document of the camp but one (the roster save in progress, which
-- the trigger rewrites in place).
CREATE OR REPLACE FUNCTION public._renumber_in_documents(
    p_camp_id uuid, p_from bigint, p_to bigint, p_skip_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE d record; v_new jsonb; n int := 0;
BEGIN
    FOR d IN SELECT key, value FROM camp_state_kv
              WHERE camp_id = p_camp_id AND key IS DISTINCT FROM p_skip_key FOR UPDATE LOOP
        v_new := public._json_renumber(d.value, p_from, p_to);
        IF v_new IS DISTINCT FROM d.value THEN
            UPDATE camp_state_kv SET value = v_new, updated_at = now()
             WHERE camp_id = p_camp_id AND key = d.key;
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public._renumber_in_documents(uuid, bigint, bigint, text) FROM public, anon, authenticated;

-- The roster trigger (259), plus: when a camper's number changed in this save
-- and the old number was moved (nobody holds it any more), every saved
-- document follows.
DO $$
DECLARE d text; n text;
BEGIN
    SELECT pg_get_functiondef('public.number_camp_campers()'::regprocedure) INTO d;
    IF d ~ '_renumber_in_documents' THEN RETURN; END IF;           -- already applied
    n := regexp_replace(d,
        '(    IF v_new IS DISTINCT FROM COALESCE\(NEW\.value -> ''camperRoster'', ''\{\}''::jsonb\) THEN)',
        '    -- 260: a camper renumbered in this save takes the records inside the
    -- saved documents with them (the tables moved already, 237).
    FOR e IN SELECT k.key AS rkey, public._stated_person_id(k.value ->> ''camperId'') AS old_id
               FROM jsonb_each(v_prev) k(key, value) WHERE jsonb_typeof(k.value) = ''object'' LOOP
        v_id := public._stated_person_id(v_new #>> ARRAY[e.rkey, ''camperId'']);
        IF e.old_id IS NOT NULL AND v_id IS NOT NULL AND v_id <> e.old_id
           AND NOT EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = e.old_id) THEN
            PERFORM public._renumber_in_documents(NEW.camp_id, e.old_id, v_id, NEW.key);
            NEW.value := jsonb_set(public._json_renumber(NEW.value - ''camperRoster'', e.old_id, v_id),
                                   ''{camperRoster}'', COALESCE(NEW.value -> ''camperRoster'', ''{}''::jsonb), true);
        END IF;
    END LOOP;

\1');
    IF n = d THEN RAISE EXCEPTION '260: number_camp_campers is not the 259 text this expects — send this message to the builder'; END IF;
    EXECUTE n;
END $$;


-- ─── 3. the children the 253 rename bug split in two ────────────────────────
-- The bug left a signature: in one roster save, the child's original number
-- was marked departed and a new number was minted, at the same instant, for
-- the same child under the new name. "The same child" is decided by what
-- does not change with a name — a date of birth, or a parent's email — never
-- by the name.
CREATE OR REPLACE FUNCTION public._split_rename_pairs()
RETURNS TABLE (camp_id uuid, original bigint, original_key text, split bigint, split_key text, how text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT o.camp_id, o.person_id, o.source_key, s.person_id, s.source_key,
           CASE WHEN COALESCE(o.payload ->> 'dob', '') <> '' AND o.payload ->> 'dob' = s.payload ->> 'dob'
                THEN 'same date of birth' ELSE 'same parent email' END
      FROM camp_people o
      JOIN camp_people s
        ON s.camp_id = o.camp_id AND s.kind = 'camper' AND s.minted
       AND s.deleted_at IS NULL AND s.person_id <> o.person_id
       AND s.first_seen = o.deleted_at
     WHERE o.kind = 'camper' AND o.deleted_at IS NOT NULL
       AND ((COALESCE(o.payload ->> 'dob', '') <> '' AND o.payload ->> 'dob' = s.payload ->> 'dob')
         OR (COALESCE(lower(btrim(o.payload ->> 'parent1Email')), '') <> ''
             AND lower(btrim(o.payload ->> 'parent1Email')) = lower(btrim(s.payload ->> 'parent1Email'))))
       -- exactly one match each way: anything ambiguous is left to a person
       AND (SELECT count(*) FROM camp_people s2
             WHERE s2.camp_id = o.camp_id AND s2.kind = 'camper' AND s2.minted
               AND s2.deleted_at IS NULL AND s2.first_seen = o.deleted_at AND s2.person_id <> o.person_id
               AND ((COALESCE(o.payload ->> 'dob', '') <> '' AND o.payload ->> 'dob' = s2.payload ->> 'dob')
                 OR (COALESCE(lower(btrim(o.payload ->> 'parent1Email')), '') <> ''
                     AND lower(btrim(o.payload ->> 'parent1Email')) = lower(btrim(s2.payload ->> 'parent1Email'))))) = 1
$$;
REVOKE ALL ON FUNCTION public._split_rename_pairs() FROM public, anon, authenticated;

-- Dry run by default: lists every split child. With true, each is put back
-- together on the ORIGINAL number (where their money and history are): the
-- split number's rows and document records move onto it, the roster entry
-- shows it, and the split number is gone.
CREATE OR REPLACE FUNCTION public.split_renames(p_confirm boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r      record;
    v_list jsonb := '[]'::jsonb;
    v_doc  jsonb;
    n      int := 0;
BEGIN
    FOR r IN SELECT * FROM public._split_rename_pairs() ORDER BY camp_id, original LOOP
        v_list := v_list || jsonb_build_object('camp_id', r.camp_id, 'camper', r.split_key,
                                               'original_number', r.original, 'split_number', r.split,
                                               'matched_by', r.how);
        CONTINUE WHEN NOT p_confirm;
        BEGIN
            -- the rows in the tables (refused if both numbers hold a canteen
            -- account — that child is listed and left for a person)…
            PERFORM public._move_person_references(r.camp_id, r.split, r.original);
            -- …the identity: the original number, under the current key…
            DELETE FROM camp_people WHERE camp_id = r.camp_id AND person_id = r.split;
            UPDATE camp_people
               SET source_key = r.split_key, deleted_at = NULL, updated_at = now()
             WHERE camp_id = r.camp_id AND person_id = r.original;
            -- …then the records in the saved documents, the roster included.
            PERFORM public._renumber_in_documents(r.camp_id, r.split, r.original, NULL);
            n := n + 1;
        EXCEPTION WHEN raise_exception THEN
            v_list := jsonb_set(v_list, ARRAY[(jsonb_array_length(v_list) - 1)::text, 'not_repaired'], to_jsonb(SQLERRM));
        END;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'dry_run', NOT p_confirm, 'split_children', v_list,
                              'repaired', n,
                              'to_repair', CASE WHEN NOT p_confirm AND jsonb_array_length(v_list) > 0
                                                THEN 'SELECT public.split_renames(true);' END);
END;
$$;
REVOKE ALL ON FUNCTION public.split_renames(boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.split_renames(boolean) TO service_role;


-- ─── a parent's photos carry the child's number ─────────────────────────────
-- get_my_camper_photos (081, gated by number since 258) returned each photo's
-- camper by name only, so the portal filed photos under a child by name. It
-- returns the number too. Rewritten in place: one line added.
DO $$
DECLARE d text; n text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'get_my_camper_photos';
    IF d IS NULL OR d ~ '''camper_id'',\s*t\.person_id' THEN RETURN; END IF;
    n := regexp_replace(d, '''camper'',\s*t\.camper_name', '''camper'',     t.camper_name,
            ''camper_id'',  t.person_id');
    IF n = d THEN RAISE EXCEPTION '260: get_my_camper_photos is not the text this expects — send this message to the builder'; END IF;
    EXECUTE n;
END $$;
