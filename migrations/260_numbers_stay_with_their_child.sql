-- ============================================================================
-- Migration 260: a camper's number stays with that child — in a family's
-- invitation, through a renumber, after an erase, and after the 253 rename
-- bug.   (Ted TED-010, TED-011, TED-012, TED-016 … TED-021)
--
-- 1. MOVED NUMBERS. When the office types a new Camper ID (1 → 7), the
--    child's rows in the tables move to 7 (237). Now the move is also
--    WRITTEN DOWN (camp_person_renumbers), and from then on:
--      * every saved document is rewritten to 7 — right after the save that
--        made the change, never inside it (a save writes several documents
--        in one statement, and rewriting one of them from inside another's
--        trigger made the whole save fail: TED-016);
--      * a document saved LATER with the old number (a tab opened before the
--        change) is corrected as it is saved;
--      * every family invitation that says 1 now says 7 (TED-017);
--      * number 1 is never given to anybody else: it is not minted, and a
--        roster entry asking for it is either this child (then it gets 7) or
--        somebody else (then it gets a number of its own).
--
-- 2. INVITATIONS. Each slot's number is decided on every save, not only
--    when the names change (TED-010, TED-018):
--      * the number the office sent for that child (camper_data camperId);
--      * else the number the slot already had, carried through any move;
--      * else the enrolled camper who holds that roster key — only one who
--        was already there when the invitation was last decided (232);
--    and never a departed child found by name. The office's repair,
--    restamp_parent_invite, decides the same way (TED-019).
--
-- 3. RENAME + RENUMBER IN ONE EDIT (TED-020). The Me page tells the server
--    which number the child had ("renumberedFrom"); the child is renamed and
--    renumbered as ONE person. The hint is never stored.
--
-- 4. AN ERASED CHILD STAYS ERASED (TED-021). Erasing a child remembers their
--    number. A roster save that still carries them (a tab opened before the
--    erase) does not bring them back; a child added again on purpose — the
--    page stamps addedAt — does.
--
-- 5. THE 253 RENAME BUG (TED-011). split_renames() lists every child that
--    bug split in two (dry run). split_renames(true) puts each back together
--    on their original number — but only where nothing else could be that
--    child: a sibling removed in the same save, or an old record with no
--    birthday or email, leaves the child for a person to decide
--    ('needs_a_person').
--
-- Standalone. Paste into the Supabase SQL Editor after 259 and run. Safe to
-- run twice. Then run scripts/verify_identity_chain.sql and read the 260 row.
-- ============================================================================

SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- ─── 0. what is remembered ──────────────────────────────────────────────────
-- A number that was moved to another: from_id is never given out again while
-- the child it moved to exists. Chains are kept flat (1→7, then 7→9, is 1→9).
CREATE TABLE IF NOT EXISTS public.camp_person_renumbers (
    camp_id    uuid   NOT NULL,
    from_id    bigint NOT NULL,
    to_id      bigint NOT NULL,
    moved_at   timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    PRIMARY KEY (camp_id, from_id)
);
CREATE INDEX IF NOT EXISTS camp_person_renumbers_pending
    ON public.camp_person_renumbers (camp_id) WHERE applied_at IS NULL;
ALTER TABLE public.camp_person_renumbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_person_renumbers FROM anon, authenticated;

-- A child who was erased: their number is free for a NEW child, but a saved
-- copy of the erased child does not bring them back.
CREATE TABLE IF NOT EXISTS public.camp_erased_people (
    camp_id    uuid   NOT NULL,
    person_id  bigint NOT NULL,
    key        text,
    erased_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, person_id)
);
ALTER TABLE public.camp_erased_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_erased_people FROM anon, authenticated;

-- A roster key or a name as the pages show it, for comparing two names:
-- without the " #<number>" a shared name is filed under, case and spaces aside.
CREATE OR REPLACE FUNCTION public._name_base(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT lower(btrim(regexp_replace(COALESCE(p, ''), '\s#\d+(?:-\d+)?\s*$', '')))
$$;

-- The number a child has today, following any move.
CREATE OR REPLACE FUNCTION public._current_person_number(p_camp_id uuid, p_id bigint)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v bigint := p_id; v_to bigint; n int := 0;
BEGIN
    IF p_id IS NULL THEN RETURN NULL; END IF;
    LOOP
        SELECT to_id INTO v_to FROM camp_person_renumbers WHERE camp_id = p_camp_id AND from_id = v;
        EXIT WHEN NOT FOUND OR v_to = v;
        v := v_to; n := n + 1;
        EXIT WHEN n > 20;
    END LOOP;
    RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public._current_person_number(uuid, bigint) FROM public, anon, authenticated;

-- p_doc with every record's number that is a key of p_map ({"1": 7, …})
-- replaced by its value (camperId, personId, person_id, camper_id — as a
-- number or a string). ONE pass over the document, whatever the number of
-- moves (TED-024): each object is rebuilt with a single aggregate, and only
-- objects and arrays are descended into.
CREATE OR REPLACE FUNCTION public._json_renumber_map(p_doc jsonb, p_map jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE v_out jsonb;
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        SELECT COALESCE(jsonb_object_agg(e.key,
                 CASE
                   WHEN jsonb_typeof(e.value) IN ('object', 'array')
                     THEN public._json_renumber_map(e.value, p_map)
                   WHEN e.key IN ('camperId', '_camperId', 'personId', 'person_id', 'camper_id')
                        AND jsonb_typeof(e.value) IN ('number', 'string')
                        AND p_map ? COALESCE(public._stated_person_id(e.value #>> '{}')::text, '')
                     THEN CASE WHEN jsonb_typeof(e.value) = 'string'
                               THEN to_jsonb(p_map ->> public._stated_person_id(e.value #>> '{}')::text)
                               ELSE p_map -> public._stated_person_id(e.value #>> '{}')::text END
                   ELSE e.value
                 END), '{}'::jsonb)
          INTO v_out FROM jsonb_each(p_doc) e;
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(x.value) IN ('object', 'array')
                                       THEN public._json_renumber_map(x.value, p_map) ELSE x.value END
                                  ORDER BY x.ord), '[]'::jsonb)
          INTO v_out FROM jsonb_array_elements(p_doc) WITH ORDINALITY x(value, ord);
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;

-- One move: the same walk with a map of one.
CREATE OR REPLACE FUNCTION public._json_renumber(p_doc jsonb, p_from bigint, p_to bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT public._json_renumber_map(p_doc, jsonb_build_object(p_from::text, p_to))
$$;

-- p_doc with the number p_id taken off every record that carries it (the
-- record itself is kept). Used on money an erased child leaves behind: the
-- amounts stay in the books, but no longer point at a number that can be
-- given to a new child.
CREATE OR REPLACE FUNCTION public._detach_person_json(p_doc jsonb, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE v_out jsonb;
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        SELECT COALESCE(jsonb_object_agg(e.key,
                 CASE WHEN jsonb_typeof(e.value) IN ('object', 'array')
                      THEN public._detach_person_json(e.value, p_id) ELSE e.value END), '{}'::jsonb)
          INTO v_out FROM jsonb_each(p_doc) e
         WHERE NOT (e.key IN ('camperId', '_camperId', 'personId', 'person_id', 'camper_id')
                    AND jsonb_typeof(e.value) IN ('number', 'string')
                    AND public._stated_person_id(e.value #>> '{}') = p_id);
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(x.value) IN ('object', 'array')
                                       THEN public._detach_person_json(x.value, p_id) ELSE x.value END
                                  ORDER BY x.ord), '[]'::jsonb)
          INTO v_out FROM jsonb_array_elements(p_doc) WITH ORDINALITY x(value, ord);
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;

-- The same, for a number that has since been given to a NEW child: only a
-- record that carries the number AND names the erased child (camperName,
-- camper, name) loses the number — that is a stale copy of the erased child
-- (a tab opened before the erase), never the new child's own record (TED-021).
CREATE OR REPLACE FUNCTION public._detach_named_json(p_doc jsonb, p_id bigint, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
    v_own boolean;
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        v_own := COALESCE(p_name, '') <> '' AND EXISTS (
                   SELECT 1 FROM jsonb_each_text(p_doc) f
                    WHERE f.key IN ('camperName', 'camper', 'name', 'displayName')
                      AND public._name_base(f.value) = p_name)
                 AND EXISTS (
                   SELECT 1 FROM jsonb_each(p_doc) f
                    WHERE f.key IN ('camperId', '_camperId', 'personId', 'person_id', 'camper_id')
                      AND jsonb_typeof(f.value) IN ('number', 'string')
                      AND public._stated_person_id(f.value #>> '{}') = p_id);
        SELECT COALESCE(jsonb_object_agg(e.key,
                 CASE -- a record filed UNDER the erased child's name (Go's addresses)
                      WHEN jsonb_typeof(e.value) = 'object' AND COALESCE(p_name, '') <> ''
                           AND public._name_base(e.key) = p_name
                        THEN public._detach_person_json(e.value, p_id)
                      WHEN jsonb_typeof(e.value) IN ('object', 'array')
                        THEN public._detach_named_json(e.value, p_id, p_name)
                      ELSE e.value END), '{}'::jsonb)
          INTO v_out FROM jsonb_each(p_doc) e
         WHERE NOT (v_own AND e.key IN ('camperId', '_camperId', 'personId', 'person_id', 'camper_id')
                    AND jsonb_typeof(e.value) IN ('number', 'string')
                    AND public._stated_person_id(e.value #>> '{}') = p_id);
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(x.value) IN ('object', 'array')
                                       THEN public._detach_named_json(x.value, p_id, p_name) ELSE x.value END
                                  ORDER BY x.ord), '[]'::jsonb)
          INTO v_out FROM jsonb_array_elements(p_doc) WITH ORDINALITY x(value, ord);
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;

-- A saved document with the camp's numbers put right, in one pass:
--   * a number that MOVED is carried to where it went (TED-012/017);
--   * a number whose child was ERASED, and that nobody holds now, is taken
--     out: records filed under it go (as the erase removed them), and money
--     keeps its amounts but loses the number (TED-021) — so a copy saved by a
--     tab opened before the erase brings nothing back, and a new child later
--     given the freed number inherits nothing.
-- The roster inside app1 is left to the roster trigger, which knows which
-- child each entry is. Cheap when nothing matches: one text search.
CREATE OR REPLACE FUNCTION public._carry_moved_numbers(p_camp_id uuid, p_key text, p_doc jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_map  jsonb;
    v_body jsonb;
    v_seen bigint[];
    g      bigint;
    r      record;
BEGIN
    IF p_doc IS NULL OR jsonb_typeof(p_doc) NOT IN ('object', 'array') THEN RETURN p_doc; END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_person_renumbers WHERE camp_id = p_camp_id)
       AND NOT EXISTS (SELECT 1 FROM camp_erased_people WHERE camp_id = p_camp_id) THEN
        RETURN p_doc;
    END IF;
    v_body := CASE WHEN p_key = 'app1' AND jsonb_typeof(p_doc) = 'object' THEN p_doc - 'camperRoster' ELSE p_doc END;
    -- Every number the document's records carry, read once from its text.
    SELECT array_agg(DISTINCT public._stated_person_id(m[2])) INTO v_seen
      FROM regexp_matches(v_body::text, '"(_?camperId|personId|person_id|camper_id)": "?(\d{1,15})"?[,}\]]', 'g') m;
    IF v_seen IS NULL THEN RETURN p_doc; END IF;

    SELECT jsonb_object_agg(from_id::text, to_id) INTO v_map
      FROM camp_person_renumbers WHERE camp_id = p_camp_id AND from_id = ANY (v_seen);
    IF v_map IS NOT NULL THEN
        v_body := public._json_renumber_map(v_body, v_map);
    END IF;
    FOR g IN SELECT e.person_id FROM camp_erased_people e
              WHERE e.camp_id = p_camp_id AND e.person_id = ANY (v_seen)
                AND NOT EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = e.camp_id AND p.person_id = e.person_id)
    LOOP
        v_body := public._detach_person_json(public._scrub_person_json(v_body, g, NULL), g);
    END LOOP;
    -- …and once a NEW child holds it: only the erased child's own records,
    -- by number AND name, lose the number.
    FOR r IN SELECT e.person_id, public._name_base(e.key) AS base
               FROM camp_erased_people e
              WHERE e.camp_id = p_camp_id AND e.person_id = ANY (v_seen) AND COALESCE(e.key, '') <> ''
                AND EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = e.camp_id AND p.person_id = e.person_id
                                                          AND public._name_base(p.source_key) <> public._name_base(e.key))
    LOOP
        v_body := public._detach_named_json(v_body, r.person_id, r.base);
    END LOOP;

    IF p_key = 'app1' AND jsonb_typeof(p_doc) = 'object' AND p_doc ? 'camperRoster' THEN
        v_body := jsonb_set(v_body, '{camperRoster}', p_doc -> 'camperRoster', true);
    END IF;
    RETURN v_body;
END;
$$;
REVOKE ALL ON FUNCTION public._carry_moved_numbers(uuid, text, jsonb) FROM public, anon, authenticated;

-- An invitation's numbers carried through every move.
CREATE OR REPLACE FUNCTION public._carry_moved_ids(p_camp_id uuid, p_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN p_ids
                WHEN NOT EXISTS (SELECT 1 FROM camp_person_renumbers WHERE camp_id = p_camp_id) THEN p_ids
                ELSE (SELECT COALESCE(jsonb_agg(
                          CASE WHEN public._stated_person_id(x.value #>> '{}') IS NULL THEN x.value
                               ELSE to_jsonb(public._current_person_number(p_camp_id, public._stated_person_id(x.value #>> '{}')))
                          END ORDER BY x.ord), '[]'::jsonb)
                        FROM jsonb_array_elements(p_ids) WITH ORDINALITY x(value, ord))
           END
$$;
REVOKE ALL ON FUNCTION public._carry_moved_ids(uuid, jsonb) FROM public, anon, authenticated;

-- Write a move down. Its keys go with the child (259), a chain is kept flat,
-- and a number moved back to is somebody's again.
CREATE OR REPLACE FUNCTION public._record_renumber(p_camp_id uuid, p_from bigint, p_to bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN RETURN; END IF;
    INSERT INTO camp_person_renumbers (camp_id, from_id, to_id)
    VALUES (p_camp_id, p_from, p_to)
    ON CONFLICT (camp_id, from_id) DO UPDATE
       SET to_id = EXCLUDED.to_id, moved_at = now(), applied_at = NULL
     WHERE camp_person_renumbers.to_id IS DISTINCT FROM EXCLUDED.to_id;
    UPDATE camp_person_renumbers SET to_id = p_to, applied_at = NULL
     WHERE camp_id = p_camp_id AND to_id = p_from;
    DELETE FROM camp_person_renumbers WHERE camp_id = p_camp_id AND from_id = p_to;
    UPDATE camp_person_keys SET person_id = p_to
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_from;
END;
$$;
REVOKE ALL ON FUNCTION public._record_renumber(uuid, bigint, bigint) FROM public, anon, authenticated;

-- Carry every move not yet carried into the saved documents and the
-- invitations. Runs AFTER the statement that made the move (never inside
-- it), and from split_renames.
CREATE OR REPLACE FUNCTION public._apply_pending_renumbers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    c     uuid;
    d     record;
    v_new jsonb;
    n     int := 0;
BEGIN
    FOR c IN SELECT DISTINCT camp_id FROM camp_person_renumbers WHERE applied_at IS NULL LOOP
        UPDATE camp_person_renumbers SET applied_at = now() WHERE camp_id = c AND applied_at IS NULL;
        FOR d IN SELECT key, value FROM camp_state_kv WHERE camp_id = c FOR UPDATE LOOP
            v_new := public._carry_moved_numbers(c, d.key, d.value);
            IF v_new IS DISTINCT FROM d.value THEN
                UPDATE camp_state_kv SET value = v_new, updated_at = now() WHERE camp_id = c AND key = d.key;
                n := n + 1;
            END IF;
        END LOOP;
        UPDATE link_parent_invites i
           SET person_ids = public._carry_moved_ids(c, i.person_ids)
         WHERE i.camp_id = c AND jsonb_typeof(i.person_ids) = 'array'
           AND i.person_ids IS DISTINCT FROM public._carry_moved_ids(c, i.person_ids);
    END LOOP;
    RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public._apply_pending_renumbers() FROM public, anon, authenticated;

-- Every document, as it is saved: a moved number in it is carried.
CREATE OR REPLACE FUNCTION public.carry_moved_numbers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.value := public._carry_moved_numbers(NEW.camp_id, NEW.key, NEW.value);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.carry_moved_numbers() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS trg_yy_carry_moved_numbers ON public.camp_state_kv;
CREATE TRIGGER trg_yy_carry_moved_numbers
BEFORE INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW EXECUTE FUNCTION public.carry_moved_numbers();

CREATE OR REPLACE FUNCTION public.apply_moved_numbers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM camp_person_renumbers WHERE applied_at IS NULL) THEN
        PERFORM public._apply_pending_renumbers();
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_moved_numbers() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS trg_zz_apply_moved_numbers ON public.camp_state_kv;
CREATE TRIGGER trg_zz_apply_moved_numbers
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH STATEMENT EXECUTE FUNCTION public.apply_moved_numbers();

-- A moved number is never minted for anybody else.
CREATE OR REPLACE FUNCTION public.mint_person_id(p_camp_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id    bigint;
    v_guard integer := 0;
BEGIN
    INSERT INTO camp_person_seq (camp_id, next_id)
    VALUES (p_camp_id,
            COALESCE((SELECT max(person_id) + 1 FROM camp_people WHERE camp_id = p_camp_id), 1))
    ON CONFLICT (camp_id) DO UPDATE
       SET next_id = GREATEST(camp_person_seq.next_id, EXCLUDED.next_id);

    LOOP
        v_guard := v_guard + 1;
        IF v_guard > 100000 THEN
            RAISE EXCEPTION 'mint_person_id: no free id for camp % after % tries', p_camp_id, v_guard;
        END IF;

        UPDATE camp_person_seq
           SET next_id = next_id + 1
         WHERE camp_id = p_camp_id
        RETURNING next_id - 1 INTO v_id;

        EXIT WHEN NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = p_camp_id AND person_id = v_id)
              AND NOT EXISTS (SELECT 1 FROM camp_person_renumbers WHERE camp_id = p_camp_id AND from_id = v_id)
              -- an erased child's number is free, but only when a person
              -- gives it out on purpose — never by itself (TED-021)
              AND NOT EXISTS (SELECT 1 FROM camp_erased_people WHERE camp_id = p_camp_id AND person_id = v_id);
    END LOOP;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.mint_person_id(uuid) FROM public, anon, authenticated;

-- When a roster entry says a child was added (addedAt: epoch ms or a date).
CREATE OR REPLACE FUNCTION public._entry_added_at(p jsonb)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE v text := p ->> 'addedAt';
BEGIN
    IF COALESCE(v, '') = '' THEN RETURN NULL; END IF;
    IF v ~ '^\d{10,15}$' THEN RETURN to_timestamp(v::numeric / 1000); END IF;
    RETURN v::timestamptz;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;


-- ─── 1. the roster trigger (259), with moves, erases and rename+renumber ────
CREATE OR REPLACE FUNCTION public.number_camp_campers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old    jsonb := '{}'::jsonb;
    v_new    jsonb := '{}'::jsonb;
    v_all    boolean := COALESCE(current_setting('campistry.renumber_all', true), '') = 'on';
    v_ids    jsonb;
    e        record;
    v_holder bigint;
    v_back   record;
    v_key    text;
    v_entry  jsonb;
    v_id     bigint;
    v_prev   jsonb;
    v_to     bigint;
    v_when   timestamptz;
    v_from   bigint;
    v_was    bigint;
    v_hinted jsonb := '{}'::jsonb;
    v_stale  timestamptz;
    v_seen   bigint[];
BEGIN
    IF TG_OP = 'UPDATE' AND NOT v_all AND jsonb_typeof(OLD.value -> 'camperRoster') = 'object' THEN
        v_old := OLD.value -> 'camperRoster';
    END IF;
    IF jsonb_typeof(NEW.value -> 'camperRoster') = 'object' THEN
        v_new := NEW.value -> 'camperRoster';
    END IF;

    -- What is saved now. An upsert (INSERT … ON CONFLICT DO UPDATE, which is
    -- how the pages save) runs this trigger as an INSERT first, with no OLD.
    IF TG_OP = 'UPDATE' THEN
        v_prev := OLD.value -> 'camperRoster';
    ELSE
        SELECT value -> 'camperRoster' INTO v_prev FROM camp_state_kv
         WHERE camp_id = NEW.camp_id AND key = NEW.key;
    END IF;
    IF jsonb_typeof(v_prev) IS DISTINCT FROM 'object' THEN v_prev := '{}'::jsonb; END IF;
    -- …and the numbering compares against it too (259).
    IF TG_OP = 'INSERT' AND NOT v_all THEN
        v_old := v_prev;
    END IF;

    -- 0a. (260) Numbers that are no longer anybody's, stated by an entry.
    FOR e IN SELECT n.key, n.value FROM jsonb_each(v_new) n(key, value)
              WHERE jsonb_typeof(n.value) = 'object'
                AND public._stated_person_id(n.value ->> 'camperId') IS NOT NULL
    LOOP
        v_id := public._stated_person_id(e.value ->> 'camperId');
        -- An erased child: their number, under their name. A saved copy of
        -- them (a tab opened before the erase) does not bring them back —
        -- whether the number is still free or a NEW child holds it now (the
        -- stale copy never takes it over: TED-021). A child added again on
        -- purpose, after the erase (addedAt), does come back. A different
        -- child given the freed number is simply given it.
        SELECT erased_at INTO v_when FROM camp_erased_people x
         WHERE x.camp_id = NEW.camp_id AND x.person_id = v_id
           AND public._name_base(x.key) = public._name_base(COALESCE(NULLIF(e.value ->> 'displayName', ''), e.key))
           AND NOT EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = v_id
                                                        AND public._name_base(p.source_key) = public._name_base(x.key));
        IF FOUND THEN
            IF public._entry_added_at(e.value) > v_when THEN
                DELETE FROM camp_erased_people WHERE camp_id = NEW.camp_id AND person_id = v_id;
            ELSE
                v_new := v_new - e.key;
                -- This save comes from a tab opened before that erase: a child
                -- added since is not missing from it on purpose.
                v_stale := LEAST(COALESCE(v_stale, v_when), v_when);
                CONTINUE;
            END IF;
        END IF;
        CONTINUE WHEN EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = v_id);
        -- A number that moved: this entry is either that child (it gets their
        -- number today) or somebody else (who gets a number of their own).
        v_to := public._current_person_number(NEW.camp_id, v_id);
        -- The office putting the child BACK on a number they were moved off
        -- (the page says which number they have now): honoured — the move is
        -- simply undone below (TED-025).
        IF v_to IS DISTINCT FROM v_id
           AND public._stated_person_id(e.value ->> 'renumberedFrom') = v_to
           AND EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = v_to
                                                  AND p.kind = 'camper' AND p.deleted_at IS NULL
                                                  AND (p.source_key = e.key OR NOT (v_new ? p.source_key))) THEN
            CONTINUE;
        END IF;
        IF v_to IS DISTINCT FROM v_id THEN
            IF EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = v_to
                                                     AND p.kind = 'camper' AND p.source_key = e.key)
               OR public._roster_key_holder(NEW.camp_id, e.key) = v_to THEN
                v_new := jsonb_set(v_new, ARRAY[e.key, 'camperId'], to_jsonb(v_to), true);
            ELSE
                v_new := jsonb_set(v_new, ARRAY[e.key], e.value - 'camperId', true);
            END IF;
        END IF;
    END LOOP;

    -- A save from a tab opened before an erase never removes a child added
    -- after it (it could not have known them): they are kept as they were.
    IF v_stale IS NOT NULL THEN
        FOR e IN SELECT p.source_key AS key, p.payload AS value FROM camp_people p
                  WHERE p.camp_id = NEW.camp_id AND p.kind = 'camper' AND p.deleted_at IS NULL
                    AND p.first_seen >= v_stale AND jsonb_typeof(p.payload) = 'object'
                    AND NOT (v_new ? p.source_key)
        LOOP
            v_new := v_new || jsonb_build_object(e.key, COALESCE(v_prev -> e.key, e.value));
        END LOOP;
    END IF;

    -- A Me tab says which children it has ever had on screen (_rosterSeen,
    -- their numbers). A child it never saw is not missing from its save on
    -- purpose — the tab was opened (or asleep, or offline) before they were
    -- added — so they are kept as they were (TED-033). Never stored.
    IF jsonb_typeof(NEW.value -> '_rosterSeen') = 'array' THEN
        v_seen := ARRAY(SELECT public._current_person_number(NEW.camp_id, public._stated_person_id(x #>> '{}'))
                          FROM jsonb_array_elements(NEW.value -> '_rosterSeen') x);
        FOR e IN SELECT p.source_key AS key, p.payload AS value, p.person_id FROM camp_people p
                  WHERE p.camp_id = NEW.camp_id AND p.kind = 'camper' AND p.deleted_at IS NULL
                    AND jsonb_typeof(p.payload) = 'object'
                    AND NOT (v_new ? p.source_key)
                    AND NOT (p.person_id = ANY (v_seen))
                    AND NOT EXISTS (SELECT 1 FROM jsonb_each(v_new) n
                                     WHERE public._stated_person_id(n.value ->> 'camperId') = p.person_id)
        LOOP
            v_new := v_new || jsonb_build_object(e.key, COALESCE(v_prev -> e.key, e.value));
        END LOOP;
    END IF;

    -- 0b. (260) Renamed AND renumbered in one edit: the page says which number
    --     the child had. The child takes the new key first, so the numbering
    --     below sees one child renumbered, not a new one. Never stored.
    FOR e IN SELECT n.key, n.value FROM jsonb_each(v_new) n(key, value)
              WHERE jsonb_typeof(n.value) = 'object' AND n.value ? 'renumberedFrom'
    LOOP
        v_new := jsonb_set(v_new, ARRAY[e.key], e.value - 'renumberedFrom', true);
        v_from := public._stated_person_id(e.value ->> 'renumberedFrom');
        CONTINUE WHEN v_from IS NULL;
        -- Only the child who holds that number now, renamed in this very save
        -- (their old key was saved, and is gone from the roster now), is this
        -- entry. A leftover hint on anybody else is ignored (TED-027).
        SELECT p.source_key INTO v_key FROM camp_people p
         WHERE p.camp_id = NEW.camp_id AND p.person_id = v_from AND p.kind = 'camper' AND p.deleted_at IS NULL;
        CONTINUE WHEN NOT FOUND OR v_key = e.key OR (v_new ? v_key) OR NOT (v_prev ? v_key)
                   OR EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.kind = 'camper'
                                 AND p.deleted_at IS NULL AND p.source_key = e.key);
        UPDATE camp_people SET source_key = e.key, updated_at = now()
         WHERE camp_id = NEW.camp_id AND person_id = v_from;
        v_hinted := v_hinted || jsonb_build_object(e.key, v_from);
    END LOOP;

    -- 1. A page that has not yet adopted a key this trigger gave (259).
    FOR e IN SELECT n.key, n.value FROM jsonb_each(v_new) n(key, value)
              WHERE jsonb_typeof(n.value) = 'object'
                AND public._stated_person_id(n.value ->> 'camperId') IS NULL
    LOOP
        v_holder := public._roster_key_holder(NEW.camp_id, e.key);
        CONTINUE WHEN v_holder IS NULL
                   OR EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id
                               AND p.person_id = v_holder AND p.kind = 'camper'
                               AND p.deleted_at IS NULL AND p.source_key = e.key);
        SELECT p.person_id, p.source_key INTO v_back
          FROM camp_people p
         WHERE p.camp_id = NEW.camp_id AND p.kind = 'camper' AND p.deleted_at IS NULL
           AND p.person_id <> v_holder
           AND regexp_replace(p.source_key, '\s#\d+(?:-\d+)?$', '') = e.key
           AND ((v_prev ? p.source_key) OR p.updated_at = now())
           AND NOT (v_new ? p.source_key)
         ORDER BY p.updated_at DESC NULLS LAST
         LIMIT 1;
        IF FOUND THEN
            v_new := (v_new - e.key) || jsonb_build_object(v_back.source_key,
                       e.value || jsonb_build_object('camperId', v_back.person_id,
                                                     'displayName', COALESCE(NULLIF(e.value ->> 'displayName', ''), e.key)));
        END IF;
    END LOOP;

    v_ids := public._number_people(NEW.camp_id, 'camper', v_old, v_new, 'camperId', 'name', v_all);

    -- 2. Every entry looked at now carries exactly the number it holds, under
    --    a key that is its own (259) — and a number it moved off is written
    --    down, so everything else follows it (260).
    FOR e IN SELECT key, value FROM jsonb_each(v_ids) LOOP
        v_id := (e.value #>> '{}')::bigint;
        v_key := e.key;
        v_holder := public._roster_key_holder(NEW.camp_id, e.key);
        IF v_holder IS NOT NULL AND v_holder <> v_id THEN
            v_key := public._own_roster_key(NEW.camp_id, e.key, v_id, v_new);
            v_entry := (v_new -> e.key)
                       || jsonb_build_object('displayName',
                              COALESCE(NULLIF(v_new #>> ARRAY[e.key, 'displayName'], ''),
                                       NULLIF(v_new #>> ARRAY[e.key, 'name'], ''),
                                       regexp_replace(e.key, '\s#\d+(?:-\d+)?$', '')));
            v_new := (v_new - e.key) || jsonb_build_object(v_key, v_entry);
            UPDATE camp_people SET source_key = v_key, updated_at = now()
             WHERE camp_id = NEW.camp_id AND person_id = v_id AND kind = 'camper';
        END IF;
        IF (v_new #> ARRAY[v_key, 'camperId']) IS DISTINCT FROM to_jsonb(v_id) THEN
            v_new := jsonb_set(v_new, ARRAY[v_key, 'camperId'], to_jsonb(v_id), true);
        END IF;
        v_was := COALESCE(public._stated_person_id(v_hinted ->> e.key),
                          public._stated_person_id(v_prev #>> ARRAY[e.key, 'camperId']));
        IF v_was IS NOT NULL AND v_was <> v_id
           AND NOT EXISTS (SELECT 1 FROM camp_people p WHERE p.camp_id = NEW.camp_id AND p.person_id = v_was) THEN
            PERFORM public._record_renumber(NEW.camp_id, v_was, v_id);
        END IF;
        INSERT INTO camp_person_keys (camp_id, kind, key, person_id)
        VALUES (NEW.camp_id, 'camper', v_key, v_id)
        ON CONFLICT (camp_id, kind, key) DO UPDATE
           SET person_id = EXCLUDED.person_id, first_at = now()
         WHERE NOT EXISTS (SELECT 1 FROM camp_people p
                            WHERE p.camp_id = camp_person_keys.camp_id
                              AND p.person_id = camp_person_keys.person_id AND p.kind = 'camper');
    END LOOP;

    IF v_new IS DISTINCT FROM COALESCE(NEW.value -> 'camperRoster', '{}'::jsonb) THEN
        NEW.value := jsonb_set(NEW.value, '{camperRoster}', v_new, true);
    END IF;
    NEW.value := NEW.value - '_rosterSeen';
    -- The rest of this document follows any move now; the other documents
    -- and the invitations follow when this statement is done (apply_moved_numbers).
    NEW.value := public._carry_moved_numbers(NEW.camp_id, NEW.key, NEW.value);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.number_camp_campers() FROM public, anon, authenticated;

-- Numbers that moved, for the Me page: a moved number is taken.
CREATE OR REPLACE FUNCTION public.get_camper_numbers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    -- The camp's staff only (TED-034). camp_reader also lets in parents, who
    -- must not get every child's name and number.
    IF NOT public.camp_staff_member(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    RETURN jsonb_build_object(
        'success', true,
        'campers', COALESCE((SELECT jsonb_object_agg(source_key, person_id)
                               FROM camp_people
                              WHERE camp_id = p_camp_id AND kind = 'camper'
                                AND deleted_at IS NULL), '{}'::jsonb),
        -- The page hands this out to a new child by itself: never below an
        -- erased child's number (TED-021).
        'next', GREATEST(
                  COALESCE((SELECT max(person_id) + 1 FROM camp_people WHERE camp_id = p_camp_id), 1),
                  COALESCE((SELECT next_id FROM camp_person_seq WHERE camp_id = p_camp_id), 1),
                  COALESCE((SELECT max(person_id) + 1 FROM camp_erased_people WHERE camp_id = p_camp_id), 1),
                  COALESCE((SELECT max(from_id) + 1 FROM camp_person_renumbers WHERE camp_id = p_camp_id), 1)),
        -- Numbers of erased children (no names: nothing about them is kept):
        -- free, but the page warns before one is typed for a new child.
        'erased', COALESCE((SELECT jsonb_object_agg(person_id::text, true)
                              FROM camp_erased_people WHERE camp_id = p_camp_id), '{}'::jsonb),
        'departed', COALESCE((SELECT jsonb_object_agg(person_id::text, source_key)
                                FROM camp_people
                               WHERE camp_id = p_camp_id AND deleted_at IS NOT NULL), '{}'::jsonb),
        'held_keys', COALESCE((SELECT jsonb_object_agg(k.key, k.person_id)
                                 FROM camp_person_keys k
                                WHERE k.camp_id = p_camp_id AND k.kind = 'camper'
                                  AND EXISTS (SELECT 1 FROM camp_people p
                                               WHERE p.camp_id = k.camp_id AND p.person_id = k.person_id
                                                 AND p.kind = 'camper')
                                  AND NOT EXISTS (SELECT 1 FROM camp_people p
                                                   WHERE p.camp_id = k.camp_id AND p.person_id = k.person_id
                                                     AND p.kind = 'camper' AND p.deleted_at IS NULL
                                                     AND p.source_key = k.key)), '{}'::jsonb),
        -- {old number: the number that child has now}
        'moved', COALESCE((SELECT jsonb_object_agg(from_id::text, to_id)
                             FROM camp_person_renumbers WHERE camp_id = p_camp_id), '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camper_numbers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camper_numbers(uuid) TO authenticated, service_role;


-- ─── 2. erasing a child is remembered ───────────────────────────────────────
DO $$
BEGIN
    IF to_regprocedure('public._erase_camper_259(uuid,bigint,boolean)') IS NULL THEN
        ALTER FUNCTION public.erase_camper(uuid, bigint, boolean) RENAME TO _erase_camper_259;
    END IF;
    REVOKE ALL ON FUNCTION public._erase_camper_259(uuid, bigint, boolean) FROM public, anon, authenticated;
END $$;

CREATE OR REPLACE FUNCTION public.erase_camper(
    p_camp_id   uuid,
    p_person_id bigint,
    p_confirm   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key text;
    v     jsonb;
BEGIN
    SELECT source_key INTO v_key FROM camp_people
     WHERE camp_id = p_camp_id AND person_id = p_person_id AND kind = 'camper';
    v := public._erase_camper_259(p_camp_id, p_person_id, p_confirm);
    IF p_confirm AND (v ->> 'success')::boolean IS TRUE
       AND NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = p_camp_id AND person_id = p_person_id) THEN
        INSERT INTO camp_erased_people (camp_id, person_id, key, erased_at)
        VALUES (p_camp_id, p_person_id, v_key, now())
        ON CONFLICT (camp_id, person_id) DO UPDATE SET key = EXCLUDED.key, erased_at = now();
        -- the numbers this child moved off are free with theirs
        DELETE FROM camp_person_renumbers WHERE camp_id = p_camp_id AND to_id = p_person_id;
        -- The erase keeps money (254) — but not on this number, which is free
        -- now and may be given to a new child: the amounts stay, the number goes.
        UPDATE camp_state_kv s
           SET value = public._carry_moved_numbers(s.camp_id, s.key, s.value), updated_at = now()
         WHERE s.camp_id = p_camp_id
           AND s.value IS DISTINCT FROM public._carry_moved_numbers(s.camp_id, s.key, s.value);
    END IF;
    RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_camper(uuid, bigint, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.erase_camper(uuid, bigint, boolean) TO authenticated, service_role;


-- ─── 3. invitations: each slot decided on every save ────────────────────────
-- The number for one invitation slot. p_data is the invitation's camper_data
-- (the office's entries, keyed by roster key), p_old_names/p_old_ids the
-- invitation as it was, p_bound the latest arrival a slot may be given by
-- key (232: a camper enrolled after the invitation was decided is not who it
-- meant; restamp_parent_invite passes now()).
DROP FUNCTION IF EXISTS public._invite_slot_person(uuid, text, jsonb, jsonb, jsonb);
CREATE OR REPLACE FUNCTION public._invite_slot_person(
    p_camp_id uuid, p_name text, p_data jsonb, p_old_names jsonb, p_old_ids jsonb,
    p_bound timestamptz DEFAULT now())
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
    v_id := public._current_person_number(p_camp_id,
                public._stated_person_id(p_data #>> ARRAY[p_name, 'camperId']));
    IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM camp_people
                                     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = v_id) THEN
        RETURN v_id;
    END IF;

    -- The number this name had in the invitation before, wherever it moved.
    IF jsonb_typeof(p_old_names) = 'array' AND jsonb_typeof(p_old_ids) = 'array' THEN
        SELECT e.ord - 1 INTO v_pos
          FROM jsonb_array_elements(p_old_names) WITH ORDINALITY e(value, ord)
         WHERE e.value #>> '{}' = p_name
         LIMIT 1;
        IF v_pos IS NOT NULL THEN
            v_id := public._current_person_number(p_camp_id, public._stated_person_id(p_old_ids ->> v_pos));
            IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM camp_people
                                             WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = v_id) THEN
                RETURN v_id;
            END IF;
        END IF;
    END IF;

    -- The enrolled camper who holds that key, and was there by p_bound.
    -- Never a departed child.
    SELECT person_id INTO v_id
      FROM camp_people
     WHERE camp_id = p_camp_id AND kind = 'camper' AND deleted_at IS NULL AND source_key = p_name
       AND first_seen <= COALESCE(p_bound, now())
     LIMIT 1;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._invite_slot_person(uuid, text, jsonb, jsonb, jsonb, timestamptz) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stamp_invite_person_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old_names jsonb := NULL;
    v_old_ids   jsonb := NULL;
    v_bound     timestamptz := now();
BEGIN
    IF TG_OP = 'INSERT' OR NEW.camper_names IS DISTINCT FROM OLD.camper_names
       OR NEW.camper_data IS DISTINCT FROM OLD.camper_data THEN
        NEW.person_ids_resolved_at := now();
    END IF;
    IF NEW.camp_id IS NULL OR jsonb_typeof(NEW.camper_names) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;
    -- A caller that set the numbers itself is taken at its word — carried
    -- through any move.
    IF (TG_OP = 'INSERT' AND NEW.person_ids IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.person_ids IS DISTINCT FROM OLD.person_ids) THEN
        NEW.person_ids := public._carry_moved_ids(NEW.camp_id, NEW.person_ids);
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        v_old_names := OLD.camper_names;
        v_old_ids   := OLD.person_ids;
        v_bound     := COALESCE(OLD.person_ids_resolved_at, now());
    END IF;
    NEW.person_ids := (
        SELECT jsonb_agg(to_jsonb(public._invite_slot_person(
                   NEW.camp_id, e.value #>> '{}', NEW.camper_data, v_old_names, v_old_ids, v_bound))
               ORDER BY e.ord)
          FROM jsonb_array_elements(NEW.camper_names) WITH ORDINALITY AS e(value, ord));
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_invite_person_ids() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_invite_person_ids ON public.link_parent_invites;
CREATE TRIGGER trg_stamp_invite_person_ids
BEFORE INSERT OR UPDATE OF camper_names, camper_data, person_ids ON public.link_parent_invites
FOR EACH ROW EXECUTE FUNCTION public.stamp_invite_person_ids();

-- The office's deliberate repair of one invitation: every slot decided the
-- same way, with any enrolled key holder allowed (a person asked for it).
-- Never a departed child found by name (TED-019).
CREATE OR REPLACE FUNCTION public.restamp_parent_invite(p_invite uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    v_camp   uuid;
    v_names  jsonb;
    v_data   jsonb;
    v_before jsonb;
    v_after  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    SELECT i.camp_id, i.camper_names, i.camper_data, i.person_ids
      INTO v_camp, v_names, v_data, v_before
      FROM link_parent_invites i WHERE i.id = p_invite
       FOR UPDATE;
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invite_not_found');
    END IF;
    IF NOT public._is_camp_admin(v_camp, caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    IF jsonb_typeof(v_names) IS DISTINCT FROM 'array' OR jsonb_array_length(v_names) = 0 THEN
        UPDATE link_parent_invites SET person_ids_resolved_at = now() WHERE id = p_invite;
        RETURN jsonb_build_object('success', true, 'camp_wide', true, 'person_ids', v_before);
    END IF;

    SELECT jsonb_agg(to_jsonb(public._invite_slot_person(v_camp, e.value #>> '{}', v_data,
                                                         v_names, v_before, 'infinity')) ORDER BY e.ord)
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

-- The invitations whose numbers disagree with their names, or still carry a
-- number that moved.
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
        'slots_on_a_moved_number', (
            SELECT count(*) FROM link_parent_invites i
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.person_ids) = 'array'
                                                           THEN i.person_ids ELSE '[]'::jsonb END) x(value)
              JOIN camp_person_renumbers r ON r.camp_id = i.camp_id
                                          AND r.from_id = public._stated_person_id(x.value #>> '{}')),
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
                   to_jsonb(public._invite_slot_person(i.camp_id, e.value #>> '{}', i.camper_data, NULL, NULL,
                                                       i.person_ids_resolved_at)),
                   NULLIF(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb),
                   'null'::jsonb)
               ORDER BY e.ord)
          FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY e(value, ord))
 WHERE i.camp_id IS NOT NULL AND jsonb_typeof(i.camper_names) = 'array'
   AND jsonb_array_length(i.camper_names) > 0;

DROP FUNCTION IF EXISTS public._renumber_in_documents(uuid, bigint, bigint, text);


-- ─── 4. the children the 253 rename bug split in two ────────────────────────
-- The bug left a signature: in one roster save, the child's original number
-- was marked departed and a new number was minted, at the same instant, for
-- the same child under the new name. "The same child" is decided by what
-- does not change with a name, never by the name: the date of birth when both
-- records have one (siblings share an email, never a birthday); the parent's
-- email only when neither has a birthday.
CREATE OR REPLACE FUNCTION public._split_same_child(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE
        WHEN COALESCE(a ->> 'dob', '') <> '' AND COALESCE(b ->> 'dob', '') <> ''
            THEN a ->> 'dob' = b ->> 'dob'
        WHEN COALESCE(a ->> 'dob', '') = '' AND COALESCE(b ->> 'dob', '') = ''
            THEN COALESCE(lower(btrim(a ->> 'parent1Email')), '') <> ''
                 AND lower(btrim(a ->> 'parent1Email')) = lower(btrim(b ->> 'parent1Email'))
        ELSE false
    END
$$;
-- Only ONE of the two records has a birthday (it was filled in by the same
-- edit that renamed the child), and the parent's email matches: maybe the
-- same child — never repaired automatically, listed for a person (TED-026).
CREATE OR REPLACE FUNCTION public._split_maybe_same_child(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT (COALESCE(a ->> 'dob', '') = '') <> (COALESCE(b ->> 'dob', '') = '')
       AND COALESCE(lower(btrim(a ->> 'parent1Email')), '') <> ''
       AND lower(btrim(a ->> 'parent1Email')) = lower(btrim(b ->> 'parent1Email'))
$$;
-- A record with nothing to tell a child by: it could be anyone.
CREATE OR REPLACE FUNCTION public._split_unknown(a jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(a ->> 'dob', '') = '' AND COALESCE(btrim(a ->> 'parent1Email'), '') = ''
$$;

-- Every pairing the signature allows, and whether it is certain: exactly one
-- original could be this child, and this original could be exactly one child.
DROP FUNCTION IF EXISTS public._split_rename_pairs();
CREATE OR REPLACE FUNCTION public._split_rename_pairs()
RETURNS TABLE (camp_id uuid, original bigint, original_key text, split bigint, split_key text,
               how text, certain boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT o.camp_id, o.person_id, o.source_key, s.person_id, s.source_key,
           CASE WHEN COALESCE(o.payload ->> 'dob', '') <> '' AND COALESCE(s.payload ->> 'dob', '') <> ''
                THEN 'same date of birth' ELSE 'same parent email' END,
           -- certain only on a real match (a maybe-match is for a person)…
           public._split_same_child(o.payload, s.payload)
           -- …no other child who left at that instant could be this one…
           AND NOT EXISTS (SELECT 1 FROM camp_people o2
                        WHERE o2.camp_id = o.camp_id AND o2.kind = 'camper' AND o2.person_id <> o.person_id
                          AND o2.deleted_at = o.deleted_at
                          AND (public._split_same_child(o2.payload, s.payload) OR public._split_unknown(o2.payload)))
           -- …and no other child who arrived at that instant could be this original
           AND NOT EXISTS (SELECT 1 FROM camp_people s2
                            WHERE s2.camp_id = o.camp_id AND s2.kind = 'camper' AND s2.minted
                              AND s2.deleted_at IS NULL AND s2.person_id NOT IN (s.person_id, o.person_id)
                              AND s2.first_seen = o.deleted_at
                              AND (public._split_same_child(o.payload, s2.payload) OR public._split_unknown(s2.payload)))
      FROM camp_people o
      JOIN camp_people s
        ON s.camp_id = o.camp_id AND s.kind = 'camper' AND s.minted
       AND s.deleted_at IS NULL AND s.person_id <> o.person_id
       AND s.first_seen = o.deleted_at
     WHERE o.kind = 'camper' AND o.deleted_at IS NOT NULL
       AND (public._split_same_child(o.payload, s.payload) OR public._split_unknown(o.payload)
            OR public._split_maybe_same_child(o.payload, s.payload))
$$;
REVOKE ALL ON FUNCTION public._split_rename_pairs() FROM public, anon, authenticated;

-- Dry run by default: lists every split child, and those a person must look
-- at. With true, each certain one is put back together on the ORIGINAL
-- number (where their money and history are): the split number's rows move
-- onto it, the roster, the saved documents and the invitations show it, and
-- the split number is written down as moved (never given out again).
CREATE OR REPLACE FUNCTION public.split_renames(p_confirm boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r       record;
    v_list  jsonb := '[]'::jsonb;
    v_ask   jsonb := '[]'::jsonb;
    v_item  jsonb;
    n       int := 0;
BEGIN
    FOR r IN SELECT * FROM public._split_rename_pairs() ORDER BY camp_id, split, original LOOP
        v_item := jsonb_build_object('camp_id', r.camp_id, 'camper', r.split_key,
                                     'original_number', r.original, 'split_number', r.split,
                                     'matched_by', r.how);
        IF NOT r.certain OR public._split_unknown((SELECT payload FROM camp_people
                                                    WHERE camp_id = r.camp_id AND person_id = r.original)) THEN
            v_ask := v_ask || (v_item || jsonb_build_object('original_key', r.original_key));
            CONTINUE;
        END IF;
        IF NOT p_confirm THEN
            v_list := v_list || v_item;
            CONTINUE;
        END IF;
        BEGIN
            -- the rows in the tables (refused if both numbers hold a canteen
            -- account — that child is left for a person)…
            PERFORM public._move_person_references(r.camp_id, r.split, r.original);
            -- …the identity: the original number, under the current key…
            DELETE FROM camp_people WHERE camp_id = r.camp_id AND person_id = r.split;
            UPDATE camp_people
               SET source_key = r.split_key, deleted_at = NULL, updated_at = now()
             WHERE camp_id = r.camp_id AND person_id = r.original;
            PERFORM public._record_renumber(r.camp_id, r.split, r.original);
            -- …the roster entry…
            UPDATE camp_state_kv
               SET value = jsonb_set(value, ARRAY['camperRoster', r.split_key, 'camperId'], to_jsonb(r.original), true)
             WHERE camp_id = r.camp_id AND key = 'app1' AND (value -> 'camperRoster') ? r.split_key;
            -- …then every saved document and invitation.
            PERFORM public._apply_pending_renumbers();
            n := n + 1;
            v_list := v_list || v_item;
        EXCEPTION WHEN OTHERS THEN
            v_ask := v_ask || (v_item || jsonb_build_object('not_repaired', SQLERRM));
        END;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'dry_run', NOT p_confirm, 'split_children', v_list,
                              'repaired', n, 'needs_a_person', v_ask,
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
