-- ============================================================================
-- Migration 259: a roster key belongs to ONE child, for as long as anything
-- about that child exists.
--
-- WHY. The pages keep every camper under a roster key — usually the camper's
-- name ("Avi Katz"; a second child with the same name is "Avi Katz #11" and
-- shows as "Avi Katz"). Records saved over the years reach a camper through
-- that key: bunk lists, families, Go addresses, health logs, luggage, orders.
-- Since 248-258 every such record also carries the camper NUMBER, and every
-- database function decides by the number. But a record written before its
-- number, or a page looking a saved key up in the roster, still goes by the
-- key — and until now a key could pass from one child to another:
--
--   * Avi Katz #10 leaves (his records are kept: money, history). A new Avi
--     Katz enrols and is numbered #11 — under the SAME key "Avi Katz". Every
--     record saved under "Avi Katz" now reaches the new child.
--   * Ayala Weiss is renamed Ayala Weiss-Katz. A new Ayala Weiss enrols under
--     the key "Ayala Weiss" — and reaches everything saved under Ayala's
--     old name.
--
-- THE RULE THIS FILE INSTALLS. A roster key belongs to the first child who
-- held it, until that child is erased (254). camp_person_keys remembers every
-- key each child has held. A save that gives a key to a DIFFERENT child — a
-- new camper, or a stated number — is not refused (a roster save must never
-- fail); the new child is filed under their own key instead:
--
--     "Avi Katz"  →  "Avi Katz #11"   (displayName "Avi Katz", camperId 11)
--
-- so no saved key can ever reach a child it was not written for. The Me page
-- adopts the new key on its next check (and picks it itself up front when it
-- can see the key is held: get_camper_numbers now lists held keys).
--
-- Erasing a child (254) deletes their rows here with everything else — the
-- key is free again only when nothing about them is left. Merging two
-- campers (254) moves the gone camper's keys to the one kept.
--
-- EXISTING DATA. Every child's current key is recorded. Where a key is today
-- shared by a live child and a departed one, it is given to the live child
-- (that is who the pages mean by it now); verify_roster_keys() reports those
-- camps so the office can look at the departed child's old records.
--
-- Standalone. Paste into the Supabase SQL Editor after 258 and run. Safe to
-- run twice. NOT part of APPLY_BUNDLE.sql. Then run
-- scripts/verify_identity_chain.sql: the 259 row should read ok.
-- ============================================================================

SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.camp_person_keys (
    camp_id    uuid   NOT NULL,
    kind       text   NOT NULL DEFAULT 'camper',
    key        text   NOT NULL,
    person_id  bigint NOT NULL,
    first_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, kind, key)
);
CREATE INDEX IF NOT EXISTS camp_person_keys_person ON public.camp_person_keys (camp_id, person_id);
ALTER TABLE public.camp_person_keys ENABLE ROW LEVEL SECURITY;
-- Read and written only by the functions below (SECURITY DEFINER).
REVOKE ALL ON public.camp_person_keys FROM anon, authenticated;

-- Every key held today: live children first, so a key shared today by a live
-- child and a departed one goes to the live child.
INSERT INTO public.camp_person_keys (camp_id, kind, key, person_id)
SELECT DISTINCT ON (camp_id, source_key) camp_id, 'camper', source_key, person_id
  FROM public.camp_people
 WHERE kind = 'camper' AND source_key IS NOT NULL AND source_key <> ''
 ORDER BY camp_id, source_key, (deleted_at IS NULL) DESC, updated_at DESC NULLS LAST
ON CONFLICT DO NOTHING;


-- The key a child must be filed under instead of p_key, which belongs to
-- somebody else: "<key> #<number>", or "<key> #<number>-2"… if even that is
-- taken. The trailing " #<number>" is what every page strips for display.
CREATE OR REPLACE FUNCTION public._own_roster_key(
    p_camp_id uuid, p_key text, p_person_id bigint, p_doc jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_base text := regexp_replace(p_key, '\s#\d+(?:-\d+)?$', '');
    v_try  text;
    n      int := 1;
BEGIN
    LOOP
        v_try := v_base || ' #' || p_person_id || CASE WHEN n > 1 THEN '-' || n ELSE '' END;
        EXIT WHEN NOT (COALESCE(p_doc, '{}'::jsonb) ? v_try)
              AND NOT EXISTS (SELECT 1 FROM camp_person_keys
                               WHERE camp_id = p_camp_id AND kind = 'camper'
                                 AND key = v_try AND person_id <> p_person_id);
        n := n + 1;
        IF n > 50 THEN RETURN v_base || ' #' || p_person_id || '-' || md5(random()::text); END IF;
    END LOOP;
    RETURN v_try;
END;
$$;
REVOKE ALL ON FUNCTION public._own_roster_key(uuid, text, bigint, jsonb) FROM public, anon, authenticated;


-- Who holds a key: the child it was first given to, while anything about
-- them exists. A holder whose identity row is gone (erased by code older than
-- this file) holds nothing.
CREATE OR REPLACE FUNCTION public._roster_key_holder(p_camp_id uuid, p_key text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT k.person_id
      FROM camp_person_keys k
     WHERE k.camp_id = p_camp_id AND k.kind = 'camper' AND k.key = p_key
       AND EXISTS (SELECT 1 FROM camp_people p
                    WHERE p.camp_id = k.camp_id AND p.person_id = k.person_id AND p.kind = 'camper')
$$;
REVOKE ALL ON FUNCTION public._roster_key_holder(uuid, text) FROM public, anon, authenticated;


-- ─── the trigger: number, then file each child under a key that is theirs ───
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
    -- …and the numbering compares against it too. Before this, the INSERT
    -- run compared against nothing, so a RENAME (the same number under a new
    -- key) looked like a stranger claiming a number: the camper was given a
    -- new one, and their old number — with their money and history — was
    -- marked departed.
    IF TG_OP = 'INSERT' AND NOT v_all THEN
        v_old := v_prev;
    END IF;

    -- 1. A page that has not yet adopted a key this trigger gave (it still
    --    saves the child under the key it typed, and without the number) is
    --    put back under that child's own key before numbering — otherwise
    --    every such save would number a "new" child.
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
           -- saved under that key before, or filed so a moment ago by this
           -- same save (an upsert runs this trigger twice)
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
    --    a key that is its own.
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
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.number_camp_campers() FROM public, anon, authenticated;


-- ─── what the Me page asks: also, which keys a new child may not have ───────
CREATE OR REPLACE FUNCTION public.get_camper_numbers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    RETURN jsonb_build_object(
        'success', true,
        'campers', COALESCE((SELECT jsonb_object_agg(source_key, person_id)
                               FROM camp_people
                              WHERE camp_id = p_camp_id AND kind = 'camper'
                                AND deleted_at IS NULL), '{}'::jsonb),
        'next', GREATEST(
                  COALESCE((SELECT max(person_id) + 1 FROM camp_people WHERE camp_id = p_camp_id), 1),
                  COALESCE((SELECT next_id FROM camp_person_seq WHERE camp_id = p_camp_id), 1)),
        'departed', COALESCE((SELECT jsonb_object_agg(person_id::text, source_key)
                                FROM camp_people
                               WHERE camp_id = p_camp_id AND deleted_at IS NOT NULL), '{}'::jsonb),
        -- Keys that belong to a child other than whoever shows them today (a
        -- departed child, or a renamed child's old name): a NEW child may not
        -- be filed under one. {key: number of the child it belongs to}
        'held_keys', COALESCE((SELECT jsonb_object_agg(k.key, k.person_id)
                                 FROM camp_person_keys k
                                WHERE k.camp_id = p_camp_id AND k.kind = 'camper'
                                  AND EXISTS (SELECT 1 FROM camp_people p
                                               WHERE p.camp_id = k.camp_id AND p.person_id = k.person_id
                                                 AND p.kind = 'camper')
                                  AND NOT EXISTS (SELECT 1 FROM camp_people p
                                                   WHERE p.camp_id = k.camp_id AND p.person_id = k.person_id
                                                     AND p.kind = 'camper' AND p.deleted_at IS NULL
                                                     AND p.source_key = k.key)), '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camper_numbers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camper_numbers(uuid) TO authenticated, service_role;


-- ─── the invariant, as a question anyone can ask ────────────────────────────
-- keys_shown_by_the_wrong_child must be []: a roster entry whose key belongs
-- to another child. keys_shared_before_259 lists camps where, before this
-- file, a key was held by a live child and a departed one at once — the
-- departed child's older records may be filed under the live child's key.
CREATE OR REPLACE FUNCTION public.verify_roster_keys()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'keys_shown_by_the_wrong_child', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('camp_id', s.camp_id, 'key', e.key,
                                                'shows', public._stated_person_id(e.value ->> 'camperId'),
                                                'belongs_to', public._roster_key_holder(s.camp_id, e.key)))
              FROM camp_state_kv s
              CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.value -> 'camperRoster') = 'object'
                                                 THEN s.value -> 'camperRoster' ELSE '{}'::jsonb END) e
             WHERE s.key = 'app1' AND jsonb_typeof(e.value) = 'object'
               AND public._roster_key_holder(s.camp_id, e.key) IS DISTINCT FROM
                   public._stated_person_id(e.value ->> 'camperId')), '[]'::jsonb),
        'keys_shared_before_259', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('camp_id', a.camp_id, 'key', a.source_key,
                                                'live', a.person_id, 'departed', b.person_id))
              FROM camp_people a JOIN camp_people b
                ON b.camp_id = a.camp_id AND b.kind = 'camper' AND b.source_key = a.source_key
               AND b.deleted_at IS NOT NULL
             WHERE a.kind = 'camper' AND a.deleted_at IS NULL), '[]'::jsonb),
        'unrecorded_keys', (SELECT count(*) FROM camp_people p
                             WHERE p.kind = 'camper' AND p.source_key IS NOT NULL
                               AND NOT EXISTS (SELECT 1 FROM camp_person_keys k
                                                WHERE k.camp_id = p.camp_id AND k.kind = 'camper'
                                                  AND k.key = p.source_key)));
$$;
REVOKE ALL ON FUNCTION public.verify_roster_keys() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_roster_keys() TO authenticated, service_role;


-- ─── erasing a child clears every key they held ─────────────────────────────
-- 254's erase clears saved documents of the child's NUMBER, and of their
-- current key only when no enrolled camper shares their name — a shared name
-- could be somebody else's. Since this file a key is one child's, so every
-- key the child ever held (their current one and any older name) can be
-- cleared safely: nobody else can be filed under it. Without this, a key
-- freed by the erase could be given to a new child and reach a record the
-- erase left behind under it.
--
-- The erase itself is 254's, unchanged, renamed _erase_camper_254 and called
-- from here. Keys a live camper shows today are never touched, and a record
-- that carries ANOTHER child's number is never touched, whatever it is named.

-- The number a saved record carries, if any.
CREATE OR REPLACE FUNCTION public._json_person_id(p jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN
        COALESCE(public._stated_person_id(p ->> 'camperId'),  public._stated_person_id(p ->> 'personId'),
                 public._stated_person_id(p ->> 'person_id'), public._stated_person_id(p ->> 'camper_id'))
    END
$$;

-- Everything in a saved document filed under p_key — a map entry keyed by it,
-- a list item that is it, a record naming it — removed, unless the thing
-- carries a different child's number. Money subtrees are left alone (254).
CREATE OR REPLACE FUNCTION public._scrub_key_json(p_doc jsonb, p_id bigint, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out  jsonb;
    e      record;
    v_pid  bigint;
    v_keep text[] := public._erase_keeps_money_keys();
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        v_out := '{}'::jsonb;
        FOR e IN SELECT key, value FROM jsonb_each(p_doc) LOOP
            v_pid := public._json_person_id(e.value);
            IF e.key = p_key AND (v_pid IS NULL OR v_pid = p_id) THEN
                CONTINUE;
            ELSIF e.key = ANY (v_keep) THEN
                v_out := v_out || jsonb_build_object(e.key, e.value);
            ELSE
                v_out := v_out || jsonb_build_object(e.key, public._scrub_key_json(e.value, p_id, p_key));
            END IF;
        END LOOP;
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        v_out := '[]'::jsonb;
        FOR e IN SELECT value FROM jsonb_array_elements(p_doc) LOOP
            v_pid := public._json_person_id(e.value);
            IF jsonb_typeof(e.value) = 'object'
               AND (e.value ->> 'camperName' = p_key OR e.value ->> 'camper' = p_key)
               AND (v_pid IS NULL OR v_pid = p_id) THEN
                CONTINUE;
            ELSIF jsonb_typeof(e.value) = 'string' AND e.value #>> '{}' = p_key THEN
                CONTINUE;
            END IF;
            v_out := v_out || jsonb_build_array(public._scrub_key_json(e.value, p_id, p_key));
        END LOOP;
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;
DO $$
BEGIN
    IF to_regprocedure('public._erase_camper_254(uuid,bigint,boolean)') IS NULL THEN
        ALTER FUNCTION public.erase_camper(uuid, bigint, boolean) RENAME TO _erase_camper_254;
    END IF;
    REVOKE ALL ON FUNCTION public._erase_camper_254(uuid, bigint, boolean) FROM public, anon, authenticated;
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
    v_keys  text[];
    v       jsonb;
    d       record;
    k       text;
    v_new   jsonb;
    v_docs  text[] := '{}';
BEGIN
    SELECT array_agg(key ORDER BY key) INTO v_keys
      FROM camp_person_keys
     WHERE camp_id = p_camp_id AND kind = 'camper' AND person_id = p_person_id;

    v := public._erase_camper_254(p_camp_id, p_person_id, p_confirm);
    IF (v ->> 'success')::boolean IS NOT TRUE OR v_keys IS NULL THEN
        RETURN v;
    END IF;

    FOR d IN
        SELECT key, value FROM camp_state_kv
         WHERE camp_id = p_camp_id
           AND key NOT IN ('campistryMeFinance', 'campistryMePayroll')
         FOR UPDATE
    LOOP
        v_new := d.value;
        FOREACH k IN ARRAY v_keys LOOP
            CONTINUE WHEN EXISTS (SELECT 1 FROM camp_people q
                                   WHERE q.camp_id = p_camp_id AND q.kind = 'camper'
                                     AND q.deleted_at IS NULL AND q.source_key = k
                                     AND q.person_id <> p_person_id);
            v_new := public._scrub_key_json(v_new, p_person_id, k);
        END LOOP;
        IF v_new IS DISTINCT FROM d.value THEN
            v_docs := v_docs || d.key;
            IF p_confirm THEN
                UPDATE camp_state_kv SET value = v_new, updated_at = now()
                 WHERE camp_id = p_camp_id AND key = d.key;
            END IF;
        END IF;
    END LOOP;

    RETURN v || jsonb_build_object('keys_released', to_jsonb(v_keys),
                                   'documents_cleared_by_key', to_jsonb(v_docs));
END;
$$;
REVOKE ALL ON FUNCTION public.erase_camper(uuid, bigint, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.erase_camper(uuid, bigint, boolean) TO authenticated, service_role;


-- ─── a parent's form submissions carry the child's number ───────────────────
-- The parent portal decides "has this form been sent for this child?" from
-- get_my_form_responses (013), which returned only the name. It returns the
-- number too, and the portal matches by it.
CREATE OR REPLACE FUNCTION public.get_my_form_responses()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',          r.id,
        'form_id',     r.form_id,
        'form_name',   r.form_name,
        'mode',        r.mode,
        'camper_name', r.camper_name,
        'person_id',   r.person_id,
        'created_at',  r.created_at
    ) ORDER BY r.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_form_responses r
    WHERE r.user_id = caller;

    RETURN jsonb_build_object('success', true, 'responses', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_form_responses() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_form_responses() TO authenticated;
