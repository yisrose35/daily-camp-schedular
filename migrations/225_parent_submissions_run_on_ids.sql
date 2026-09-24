-- ============================================================================
-- 225 — what a parent submits is filed against an id
--
-- 224 moved the two shared access gates onto ids. This file does the five
-- functions a parent actually submits things through, and it found two things
-- worse than the one it set out to fix.
--
-- FIRST: THREE OF THE FIVE NEVER USED THE SHARED GATE AT ALL. 224 fixed
-- _parent_owns_camper, but submit_pickup_request, submit_camper_mail and
-- submit_link_form_response each carry their own copy of the check:
--
--     IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name)
--
-- The same jsonb string match on a name, in three more places, untouched by
-- 224 because none of them calls the function 224 repaired. Two children with
-- one name, a rename, a trailing space — all three bugs, three more times.
--
-- They also each pick the parent's MOST RECENTLY CREATED invite and then check
-- the camper against that one, so a parent holding two invites in a camp gets
-- an answer about whichever is newer, and the invite_id filed on the row is not
-- necessarily the invite that covers the child.
--
-- SECOND: FIVE STALE OVERLOADS ARE STILL LIVE AND REACHABLE. Postgres keys a
-- function by (name, argument types), so a later migration that "replaced" one
-- of these with an extra parameter created a SECOND function and left the first
-- one running:
--
--     submit_camper_mail(text,text,text,text,text,text)              -- 015
--     submit_pickup_request(text,text,jsonb,text,uuid)               -- 025
--     submit_link_form_response(…12 args…)                           -- 013
--     submit_link_form_response(…13 args…)                           -- 041
--     submit_camper_headshot(uuid,text,text,jsonb)                   -- 028
--
-- The 015 camper-mail function has no camp scoping, no camp_connected check and
-- no program gate — every protection added between 015 and 122 is absent from a
-- function any caller can still reach by supplying six arguments. That is the
-- same class of mistake as 220, at a larger scale, and this file drops them.
--
-- WHAT THE CONVERSION IS. Each of the five now:
--
--   1. takes a camper id (as a new trailing p_camper_id bigint, except
--      submit_link_form_response which already had an unvalidated p_camper_id
--      text, and _camper_mail_record, which is inbound email and has no id to
--      be given);
--   2. derives the NAME from the id when an id is supplied, instead of trusting
--      the caller's name beside it — so a caller cannot file a row under one
--      child's id and another child's label;
--   3. authorises on the id, through 224's gate;
--   4. writes person_id on the row explicitly, so the row records the identity
--      the decision was actually made about rather than whatever a trigger
--      re-derives from a string later;
--   5. files it against the invite that COVERS the child, not the newest one.
--
-- THE p_camper_id LANDMINE, and why the parser is strict. submit_link_form_
-- response has taken a p_camper_id text since 013 and written it to
-- link_form_responses.camper_id without ever checking it. The parent portal
-- fills it from `child.id`, which is built as:
--
--     id: 'child_' + idx
--
-- an array index. So that column is full of 'child_0', 'child_1' — an id
-- recorded for years and read by nobody, which is fine right up to the moment
-- something starts reading it. Digit-extraction would turn 'child_3' into
-- camper 3, so _camper_id_arg accepts a value only when the WHOLE string is
-- digits. 'child_3' is treated as absent, and the name path is used, exactly as
-- today. Migration 226 makes the portal send the real id.
--
-- ONE RULE, TWO SCOPES. 224's gate is refactored so the per-invite question and
-- the per-camp question are the same code: _invite_covers_person is the rule,
-- and _parent_owns_person is EXISTS over the parent's active invites. That is
-- needed because _parent_invite_for has to find WHICH invite covers a child,
-- and writing a second copy of the rule to answer it is how two parts of a
-- system come to disagree about who a parent's children are. Behaviour is
-- unchanged, and 225's behaviour test re-proves 224's cases to say so.
--
-- HOW TO APPLY. Paste into the SQL Editor after 224. One transaction,
-- idempotent.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_parent_owns_person') THEN
        RAISE EXCEPTION '_parent_owns_person is missing — apply migration 224 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the rule, at the invite level ───────────────────────────────────────
-- 224's logic, moved down one scope so it can answer "does THIS invite cover
-- this child" as well as "does this parent". Word for word the same test.
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

                -- A null slot is "not known yet", not "not this child" — see 224.
                OR (jsonb_typeof(i.camper_names) = 'array' AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(i.camper_names) WITH ORDINALITY AS e(value, ord)
                      WHERE COALESCE(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb) = 'null'::jsonb
                        AND public.camp_person_by_name(i.camp_id, e.value #>> '{}') = p_person_id))
           )
    );
$$;
REVOKE ALL ON FUNCTION public._invite_covers_person(uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._invite_covers_person(uuid, bigint) TO authenticated, service_role;


-- The same question asked by name, with 224's three answers. Row-level, so
-- _parent_invite_for and _parent_owns_camper share it rather than each carrying
-- a copy.
CREATE OR REPLACE FUNCTION public._invite_covers_camper(p_invite uuid, p_camper_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp    uuid;
    v_names   jsonb;
    v_id      bigint;
    v_matches integer;
BEGIN
    IF COALESCE(btrim(p_camper_name), '') = '' THEN
        RETURN false;
    END IF;
    SELECT i.camp_id, i.camper_names INTO v_camp, v_names
      FROM link_parent_invites i WHERE i.id = p_invite;
    IF v_camp IS NULL THEN
        RETURN false;
    END IF;

    v_id := public.camp_person_by_name(v_camp, p_camper_name);
    IF v_id IS NOT NULL THEN
        RETURN public._invite_covers_person(p_invite, v_id);
    END IF;

    -- NULL means one of two things, and they do not get the same answer. See 224.
    SELECT count(DISTINCT person_id) INTO v_matches
      FROM camp_people
     WHERE camp_id = v_camp AND kind = 'camper'
       AND lower(btrim(source_key)) = lower(btrim(p_camper_name));

    IF v_matches > 1 THEN
        RETURN false;                       -- AMBIGUOUS: refuse, never guess
    END IF;
    RETURN v_names IS NULL OR (v_names ? p_camper_name);   -- UNKNOWN: the string
END;
$$;
REVOKE ALL ON FUNCTION public._invite_covers_camper(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._invite_covers_camper(uuid, text) TO authenticated, service_role;


-- ─── 2. the two camp-level gates, now one line each ─────────────────────────
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
           AND public._invite_covers_person(i.id, p_person_id));
$$;
REVOKE ALL ON FUNCTION public._parent_owns_person(uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._parent_owns_person(uuid, bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._parent_owns_camper(p_camp_id uuid, p_camper_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_camp_id IS NOT NULL AND COALESCE(btrim(p_camper_name), '') <> '' AND EXISTS (
        SELECT 1 FROM link_parent_invites i
         WHERE i.user_id = auth.uid()
           AND i.camp_id = p_camp_id
           AND i.status  = 'active'
           AND (i.expires_at IS NULL OR i.expires_at > now())
           AND public._invite_covers_camper(i.id, p_camper_name));
$$;
REVOKE ALL ON FUNCTION public._parent_owns_camper(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._parent_owns_camper(uuid, text) TO authenticated, service_role;


-- ─── 3. the two small helpers everything below leans on ─────────────────────
-- The camper's ROSTER KEY, which is what every name-keyed column in this system
-- actually holds. Not the display name: campistry_camper_identity.js gives a
-- second camper of the same name the key 'Malky Stein #102' and carries
-- displayName 'Malky Stein', and it is the key that appears in canteen
-- accounts, health submissions and print sheets. Returning the display name
-- here would file rows under a label that resolves to the OTHER child.
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
REVOKE ALL ON FUNCTION public.camp_person_label(uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_person_label(uuid, bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.camp_person_label(uuid, bigint) IS
    'The camper''s roster key for a person id, or NULL if no such camper. The key, not the display name — see campistry_camper_identity.js.';


-- A camper id arriving as TEXT, accepted only when the whole value is digits.
--
-- NOT _person_id(), which strips non-digits: that would read 'child_3' — the
-- array index the parent portal has been sending as p_camper_id since 013 — as
-- camper 3, and hand one family's form to another child. An id that is not
-- unambiguously an id is treated as absent.
CREATE OR REPLACE FUNCTION public._camper_id_arg(p_raw text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN btrim(COALESCE(p_raw, '')) ~ '^[0-9]+$'
                THEN NULLIF(btrim(p_raw)::numeric, 0)::bigint END
$$;
COMMENT ON FUNCTION public._camper_id_arg(text) IS
    'A camper id from a text argument, only if the whole string is digits. Deliberately stricter than _person_id: the portal has been sending "child_3" here.';


-- The parent's active invite that actually COVERS this child, preferring an
-- invite that names them over the camp-wide wildcard. The invite_id filed on a
-- row should be the one that granted it.
CREATE OR REPLACE FUNCTION public._parent_invite_for(
    p_camp_id     uuid,
    p_person_id   bigint,
    p_camper_name text)
RETURNS link_parent_invites
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE r link_parent_invites;
BEGIN
    SELECT i.* INTO r
      FROM link_parent_invites i
     WHERE i.user_id = auth.uid()
       AND i.status  = 'active'
       AND (i.expires_at IS NULL OR i.expires_at > now())
       AND (p_camp_id IS NULL OR i.camp_id = p_camp_id)
       AND CASE WHEN p_person_id IS NOT NULL
                THEN public._invite_covers_person(i.id, p_person_id)
                ELSE public._invite_covers_camper(i.id, p_camper_name) END
     -- A named invite beats the wildcard, then newest. Without the first term a
     -- parent who holds both would file everything against the wildcard.
     ORDER BY (i.camper_names IS NOT NULL) DESC, i.created_at DESC
     LIMIT 1;
    RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public._parent_invite_for(uuid, bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._parent_invite_for(uuid, bigint, text) TO authenticated, service_role;


-- ─── 4. submit_health_document ──────────────────────────────────────────────
-- The only one of the five that already used the shared gate, so this adds the
-- id argument, the derived label and the recorded person_id.
CREATE OR REPLACE FUNCTION public.submit_health_document(
    p_camp_id     uuid,
    p_camper_name text,
    p_file_name   text,
    p_file_type   text,
    p_file_data   text,
    p_note        text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    new_id uuid := gen_random_uuid();
    v_id   bigint;
    v_name text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    IF p_camper_id IS NOT NULL THEN
        v_id   := p_camper_id;
        -- The label comes from the roster, not from beside the id. A caller
        -- passing one child's id and another child's name must not be able to
        -- file the row under the wrong label.
        v_name := public.camp_person_label(p_camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
        IF NOT public._parent_owns_person(p_camp_id, v_id) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
    ELSE
        v_name := p_camper_name;
        IF NOT public._parent_owns_camper(p_camp_id, v_name) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        v_id := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    IF p_file_data IS NULL OR length(p_file_data) > 6000000 THEN   -- ~4.5MB base64
        RETURN jsonb_build_object('success', false, 'error', 'bad_file');
    END IF;

    INSERT INTO link_health_submissions
        (id, camp_id, camper_name, person_id, file_name, file_type, file_data, note)
    VALUES (new_id, p_camp_id, v_name, v_id,
            left(coalesce(p_file_name, ''), 200), left(coalesce(p_file_type, ''), 100),
            p_file_data, left(coalesce(p_note, ''), 1000));

    RETURN jsonb_build_object('success', true, 'id', new_id, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_health_document(uuid, text, text, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_health_document(uuid, text, text, text, text, text, bigint)
    TO authenticated;


-- ─── 5. submit_pickup_request ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_pickup_request(
    p_type          text,
    p_camper_name   text,
    p_details       jsonb  DEFAULT '{}'::jsonb,
    p_label         text   DEFAULT NULL,
    p_camp_id       uuid   DEFAULT NULL,
    p_request_date  date   DEFAULT NULL,
    p_camper_id     bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid := gen_random_uuid();
    v_id   bigint := p_camper_id;
    v_name text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_type IS NULL OR btrim(p_type) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_type');
    END IF;
    -- A request more than a year out is almost certainly a bad client-side date
    -- computation, not a real ask — reject rather than silently file it.
    IF p_request_date IS NOT NULL AND
       (p_request_date < (now() AT TIME ZONE 'utc')::date
        OR p_request_date > (now() AT TIME ZONE 'utc')::date + interval '1 year') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_request_date');
    END IF;

    -- The invite that covers this child, not merely the newest one this parent
    -- holds. With no camper named at all — a pickup request for the whole
    -- family — fall back to any active invite, as before.
    inv := public._parent_invite_for(p_camp_id, v_id, p_camper_name);
    IF inv.id IS NULL AND COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL THEN
        SELECT * INTO inv FROM link_parent_invites
         WHERE user_id = caller AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
           AND (p_camp_id IS NULL OR camp_id = p_camp_id)
         ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF inv.id IS NULL THEN
        -- Previously two different refusals: no_active_invite when the parent
        -- had none, camper_not_on_invite when the newest one did not name the
        -- child. Told apart here so a parent is not told to contact the camp
        -- about a missing invite they do have.
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (p_camp_id IS NULL OR camp_id = p_camp_id)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;

    INSERT INTO parent_pickup_requests (
        id, camp_id, request_date, type, label, camper_name, person_id, camper_bunk,
        parent_name, parent_email, details, status
    ) VALUES (
        new_id, inv.camp_id,
        coalesce(p_request_date, (now() AT TIME ZONE 'utc')::date),
        p_type, coalesce(p_label, p_type), v_name, v_id,
        coalesce(p_details ->> 'childBunk', ''),
        inv.parent_name, inv.parent_email, coalesce(p_details, '{}'::jsonb), 'Pending'
    );

    RETURN jsonb_build_object('success', true, 'id', new_id, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid, date, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_pickup_request(text, text, jsonb, text, uuid, date, bigint)
    TO authenticated;


-- ─── 6. submit_camper_mail ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_camper_mail(
    p_camper_name text,
    p_subject     text   DEFAULT '',
    p_body        text   DEFAULT '',
    p_division    text   DEFAULT NULL,
    p_grade       text   DEFAULT NULL,
    p_bunk        text   DEFAULT NULL,
    p_camp_id     text   DEFAULT NULL,
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    n_today integer;
    new_id  uuid;
    v_camp  uuid;
    v_id    bigint := p_camper_id;
    v_name  text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF (COALESCE(btrim(p_camper_name), '') = '' AND v_id IS NULL)
       OR p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;
    IF length(p_body) > 20000 OR length(coalesce(p_subject, '')) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_long');
    END IF;

    IF COALESCE(btrim(p_camp_id), '') <> '' THEN
        BEGIN
            v_camp := p_camp_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            -- Not a camp. Ignoring it would widen the search to every camp this
            -- parent belongs to, which is how a malformed argument becomes a
            -- wider grant.
            RETURN jsonb_build_object('success', false, 'error', 'bad_camp');
        END;
    END IF;

    inv := public._parent_invite_for(v_camp, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (v_camp IS NULL OR camp_id = v_camp)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;

    -- This parent's connection to the camp ended (122) — no new camper mail.
    IF NOT inv.camp_connected THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_disconnected');
    END IF;

    IF NOT public._link_program_enabled(inv.camp_id, 'camperMail') THEN
        RETURN jsonb_build_object('success', false, 'error', 'program_disabled');
    END IF;

    SELECT count(*) INTO n_today
      FROM link_camper_mail
     WHERE invite_id = inv.id
       AND created_at > now() - interval '24 hours';
    IF n_today >= 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_reached');
    END IF;

    INSERT INTO link_camper_mail (
        camp_id, invite_id, user_id, camper_name, person_id, division, grade, bunk,
        parent_name, parent_email, subject, body
    ) VALUES (
        inv.camp_id, inv.id, caller, v_name, v_id, p_division, p_grade, p_bunk,
        inv.parent_name, inv.parent_email, coalesce(p_subject, ''), p_body
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION
    public.submit_camper_mail(text, text, text, text, text, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION
    public.submit_camper_mail(text, text, text, text, text, text, text, bigint)
    TO authenticated;


-- ─── 7. submit_link_form_response ───────────────────────────────────────────
-- Keeps its fourteen arguments exactly: p_camper_id text has been there since
-- 013 and every caller already passes it. What changes is that it is now
-- CHECKED — and only believed when the whole value is digits, because for years
-- it has been receiving 'child_3'.
CREATE OR REPLACE FUNCTION public.submit_link_form_response(
    p_form_id          text,
    p_form_name        text,
    p_mode             text,
    p_camper_name      text,
    p_camper_id        text     DEFAULT NULL,
    p_answers          jsonb    DEFAULT '{}',
    p_signature        text     DEFAULT NULL,
    p_file_name        text     DEFAULT NULL,
    p_file_data        text     DEFAULT NULL,
    p_division         text     DEFAULT NULL,
    p_grade            text     DEFAULT NULL,
    p_bunk             text     DEFAULT NULL,
    p_camp_id          text     DEFAULT NULL,
    p_filled_pdf_path  text     DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
    v_camp uuid;
    v_id   bigint;
    v_name text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_form_id IS NULL OR p_form_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;

    v_id := public._camper_id_arg(p_camper_id);
    IF v_id IS NULL AND COALESCE(btrim(p_camper_name), '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;

    IF length(coalesce(p_answers::text, '')) > 262144 THEN
        RETURN jsonb_build_object('success', false, 'error', 'answers_too_large');
    END IF;
    IF length(coalesce(p_signature, '')) > 1048576 THEN
        RETURN jsonb_build_object('success', false, 'error', 'signature_too_large');
    END IF;
    IF length(coalesce(p_file_data, '')) > 6291456 THEN
        RETURN jsonb_build_object('success', false, 'error', 'file_too_large');
    END IF;
    IF length(coalesce(p_filled_pdf_path, '')) > 512 THEN
        RETURN jsonb_build_object('success', false, 'error', 'path_too_long');
    END IF;

    IF COALESCE(btrim(p_camp_id), '') <> '' THEN
        BEGIN
            v_camp := p_camp_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('success', false, 'error', 'bad_camp');
        END;
    END IF;

    inv := public._parent_invite_for(v_camp, v_id, p_camper_name);
    IF inv.id IS NULL THEN
        IF EXISTS (SELECT 1 FROM link_parent_invites
                    WHERE user_id = caller AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())
                      AND (v_camp IS NULL OR camp_id = v_camp)) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(inv.camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(inv.camp_id, v_name);
    END IF;

    -- One response per (invite, form, camper). Superseding by person_id as well
    -- as by name, so re-submitting a form after a rename replaces the old answer
    -- instead of leaving two rows the office has to choose between.
    DELETE FROM link_form_responses
     WHERE invite_id = inv.id
       AND form_id = p_form_id
       AND (camper_name = v_name
            OR (v_id IS NOT NULL AND person_id = v_id));

    INSERT INTO link_form_responses (
        camp_id, invite_id, user_id, form_id, form_name, mode,
        camper_name, camper_id, person_id, parent_name, parent_email,
        division, grade, bunk, answers, signature_data, file_name, file_data,
        filled_pdf_path
    ) VALUES (
        inv.camp_id, inv.id, caller, p_form_id, coalesce(p_form_name, ''),
        CASE WHEN p_mode = 'upload' THEN 'upload' ELSE 'digital' END,
        v_name,
        -- camper_id keeps taking whatever the caller sent, because
        -- campistry_link_admin.html selects it and a column that silently
        -- changes meaning is worse than a column that is junk. person_id beside
        -- it is the real one.
        p_camper_id,
        v_id, inv.parent_name, inv.parent_email,
        p_division, p_grade, p_bunk,
        coalesce(p_answers, '{}'::jsonb), p_signature, p_file_name, p_file_data,
        p_filled_pdf_path
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_link_form_response(
    text, text, text, text, text, jsonb, text, text, text, text, text, text, text, text)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_link_form_response(
    text, text, text, text, text, jsonb, text, text, text, text, text, text, text, text)
    TO authenticated;


-- ─── 8. _camper_mail_record — inbound email, so no id to be given ───────────
-- An email names a camper in its subject line; there is no id for the sender to
-- pass. What it can do is SAY whether the name was resolved, so an unattributed
-- letter is visible rather than filed under a string and forgotten. The office
-- sees it and can fix the name.
CREATE OR REPLACE FUNCTION public._camper_mail_record(
    p_camp_id      uuid,
    p_fingerprint  text,
    p_camper_name  text,
    p_division     text,
    p_grade        text,
    p_bunk         text,
    p_parent_name  text,
    p_parent_email text,
    p_subject      text,
    p_body         text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id     uuid;
    v_camper text   := COALESCE(NULLIF(btrim(p_camper_name), ''), '(unassigned)');
    v_person bigint;
BEGIN
    IF p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_body');
    END IF;

    IF v_camper <> '(unassigned)' THEN
        v_person := public.camp_person_by_name(p_camp_id, v_camper);
        -- Resolved: file it under the roster's own key, so a letter addressed
        -- to 'ayala weiss' lands with the same camper as one addressed to
        -- 'Ayala Weiss' instead of creating a second correspondent.
        IF v_person IS NOT NULL THEN
            v_camper := COALESCE(public.camp_person_label(p_camp_id, v_person), v_camper);
        END IF;
    END IF;

    INSERT INTO link_camper_mail (
        camp_id, camper_name, person_id, division, grade, bunk,
        parent_name, parent_email, subject, body,
        status, source, inbound_fingerprint
    ) VALUES (
        p_camp_id, v_camper, v_person,
        NULLIF(btrim(coalesce(p_division, '')), ''),
        NULLIF(btrim(coalesce(p_grade, '')), ''),
        NULLIF(btrim(coalesce(p_bunk, '')), ''),
        NULLIF(btrim(coalesce(p_parent_name, '')), ''),
        NULLIF(btrim(coalesce(p_parent_email, '')), ''),
        left(coalesce(p_subject, ''), 200),
        left(p_body, 20000),
        'new', 'email', NULLIF(btrim(coalesce(p_fingerprint, '')), '')
    )
    ON CONFLICT (camp_id, inbound_fingerprint)
        WHERE inbound_fingerprint IS NOT NULL
        DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'inserted', false, 'duplicate', true);
    END IF;
    RETURN jsonb_build_object('success', true, 'inserted', true, 'id', v_id,
                              'assigned', v_camper <> '(unassigned)',
                              -- NULL here means the letter names a child the
                              -- roster cannot find. That is the number to watch.
                              'camper_id', v_person);
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_record(
    uuid, text, text, text, text, text, text, text, text, text) FROM public, anon, authenticated;


-- ─── 9. the stale overloads go ──────────────────────────────────────────────
-- Postgres keys a function by (name, argument types), so every migration that
-- "replaced" one of these with an extra parameter left the previous one running.
-- submit_camper_mail's 015 version has no camp scoping, no camp_connected check
-- and no program gate — a caller supplying six arguments reaches a function with
-- every protection added since 2024 missing from it.
--
-- BY NAME FIRST, and then swept. Both, for the reason migration 192 taught this
-- project the hard way and tests/camp_scoped_rpc_auth.test.js now enforces: a
-- named drop is the one that cannot miss, and it is the one a reviewer can see.
-- The sweep below is the backstop for a signature nobody remembered, and it
-- asserts the result; neither half is sufficient alone.
DROP FUNCTION IF EXISTS public.submit_health_document(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.submit_pickup_request(text, text, jsonb, text, uuid);
DROP FUNCTION IF EXISTS public.submit_pickup_request(text, text, jsonb, text, uuid, date);
-- 015's six-argument camper mail: no camp scoping, no camp_connected check, no
-- program gate. Every protection added between 015 and 122 is missing from it,
-- and until this line it was reachable by anyone who supplied six arguments.
DROP FUNCTION IF EXISTS public.submit_camper_mail(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.submit_camper_mail(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.submit_link_form_response(
    text, text, text, text, text, jsonb, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.submit_link_form_response(
    text, text, text, text, text, jsonb, text, text, text, text, text, text, text);

-- Keeps exactly the signatures created above and drops every other overload of
-- those names. to_regprocedure returns NULL rather than erroring for a signature
-- that does not exist, so the NULL check below is what proves this file created
-- what it thinks it created before anything is dropped.
DO $$
DECLARE
    keep  oid[];
    names text[] := ARRAY['submit_health_document', 'submit_pickup_request',
                          'submit_camper_mail', 'submit_link_form_response',
                          '_camper_mail_record'];
    r     record;
    n     integer := 0;
BEGIN
    keep := ARRAY[
        to_regprocedure('public.submit_health_document(uuid,text,text,text,text,text,bigint)'),
        to_regprocedure('public.submit_pickup_request(text,text,jsonb,text,uuid,date,bigint)'),
        to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text,text,bigint)'),
        to_regprocedure('public.submit_link_form_response('
                        || 'text,text,text,text,text,jsonb,text,text,text,text,text,text,text,text)'),
        to_regprocedure('public._camper_mail_record(uuid,text,text,text,text,text,text,text,text,text)')
    ]::oid[];

    IF array_position(keep, NULL) IS NOT NULL THEN
        RAISE EXCEPTION '225 did not create one of the signatures it is about to keep — '
                        'dropping the old ones now would leave nothing at all';
    END IF;

    FOR r IN
        SELECT p.oid, p.proname, oidvectortypes(p.proargtypes) AS args
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.proname = ANY (names)
           AND NOT (p.oid = ANY (keep))
    LOOP
        EXECUTE format('DROP FUNCTION public.%I(%s)', r.proname, r.args);
        RAISE NOTICE '225: dropped stale overload public.%(%)', r.proname, r.args;
        n := n + 1;
    END LOOP;
    RAISE NOTICE '225: % stale overloads dropped', n;

    -- And exactly one of each remains, which is the claim worth asserting.
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = ANY (names)
         GROUP BY p.proname HAVING count(*) <> 1
    LOOP
        RAISE EXCEPTION 'public.% still has % overloads', r.proname, r.c;
    END LOOP;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 225 applied'                     AS status,
       public.verify_camper_ownership()            AS ownership,
       (SELECT jsonb_object_agg(p.proname, c)
          FROM (SELECT p.proname, count(*) AS c
                  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                 WHERE ns.nspname = 'public'
                   AND p.proname IN ('submit_health_document', 'submit_pickup_request',
                                     'submit_camper_mail', 'submit_link_form_response',
                                     '_camper_mail_record')
                 GROUP BY p.proname) p)             AS overloads_each;
