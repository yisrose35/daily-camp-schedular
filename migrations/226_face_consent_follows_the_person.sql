-- ============================================================================
-- 226 — face consent follows the child, not the spelling of their name
--
-- THE DEFECT. set_camper_face_consent(camp, name, false) is how a parent
-- withdraws consent for facial recognition. It purges like this:
--
--     DELETE FROM link_photo_tags              WHERE camp_id = … AND camper_name = p_camper_name;
--     DELETE FROM link_camper_face_descriptors WHERE camp_id = … AND camper_name = p_camper_name;
--
-- and link_camper_faces is keyed PRIMARY KEY (camp_id, camper_name).
--
-- So after the camp renames a camper — 'Ayala Weiss' becomes 'Ayala Weiss-Katz',
-- an ordinary thing that happens every season — the parent's portal shows the new
-- name, the withdrawal is filed under the new name, and:
--
--   * link_camper_faces gains a SECOND row: consent false, descriptor null. The
--     first row keeps consent = true and keeps the 128-float face descriptor.
--   * the descriptor DELETE matches nothing, so every parent-uploaded and
--     confirmed descriptor survives under the old name.
--   * the photo-tag DELETE matches nothing, so every tag of that child survives.
--
-- The function returns {"success": true, "consent": false}. Recognition keeps
-- running on the child's face. The parent has been told their withdrawal
-- succeeded, and it did nothing. That is biometric data retained after an
-- explicit withdrawal, and it is not a bookkeeping problem.
--
-- The same crack runs the other way: promote_confirmed_face refuses with
-- 'no_consent' when the consent row is under a different spelling, so
-- recognition silently stops learning — and it ACCEPTS when an old row still
-- says true after the parent revoked under the new name.
--
-- THE RULE THIS FILE INSTALLS. A person's effective consent is the consent on
-- their most recently updated face row, whatever name that row is filed under.
-- That is the parent's most recent instruction, and nothing else is. When it is
-- false, every piece of that child's biometric data goes — across every name
-- they have ever been filed under.
--
-- REPAIRING WHAT IS ALREADY THERE. purge_revoked_face_data() finds children
-- whose latest instruction was "no" and who still have descriptors, face rows or
-- tags under another name, and removes them. DRY RUN BY DEFAULT: called with no
-- argument it counts. Deleting biometric data is exactly what was asked for, and
-- still worth looking at before it happens.
--
-- ALSO CONVERTED, because they are the rest of this surface: submit_camper_
-- headshot, promote_confirmed_face, resolve_photo_tag, record_link_photo_
-- purchase and submit_link_tip. submit_link_tip carried its own copy of the
-- name-containment check, like the three 225 found, so it had 224's bug too.
--
-- AND THREE MORE STALE OVERLOADS GO: submit_camper_headshot(uuid,text,text,jsonb)
-- from 028 and submit_link_tip(text,text,numeric,text) from 016 and 017 are still
-- live. The 028 headshot function predates every descriptor check in 029 — no
-- model validation, no dimension check.
--
-- HOW TO APPLY. Paste into the SQL Editor after 225. One transaction,
-- idempotent. Then read verify_face_consent() and, if `leaked_*` is not zero,
-- run purge_revoked_face_data() and then purge_revoked_face_data(true).
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_person_label') THEN
        RAISE EXCEPTION 'camp_person_label is missing — apply migration 225 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. every name a child's face data has ever been filed under ────────────
-- The set this file's purges have to cover. A child may appear under their
-- current roster key, under last season's, and under a mis-typed one, and a
-- withdrawal that only reaches the spelling the parent happened to see is the
-- defect in the header.
--
-- Returns the person's names from camp_people AND any name already on a face row
-- that resolves to them, because a row can be filed under a spelling the roster
-- no longer has.
CREATE OR REPLACE FUNCTION public._camper_face_names(p_camp_id uuid, p_person_id bigint)
RETURNS TABLE (camper_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT DISTINCT nm FROM (
        SELECT p.source_key AS nm FROM camp_people p
         WHERE p.camp_id = p_camp_id AND p.kind = 'camper' AND p.person_id = p_person_id
        UNION ALL
        SELECT f.camper_name FROM link_camper_faces f
         WHERE f.camp_id = p_camp_id
           AND (f.person_id = p_person_id
                OR public.camp_person_by_name(p_camp_id, f.camper_name) = p_person_id)
        UNION ALL
        SELECT d.camper_name FROM link_camper_face_descriptors d
         WHERE d.camp_id = p_camp_id
           AND (d.person_id = p_person_id
                OR public.camp_person_by_name(p_camp_id, d.camper_name) = p_person_id)
        UNION ALL
        SELECT t.camper_name FROM link_photo_tags t
         WHERE t.camp_id = p_camp_id
           AND (t.person_id = p_person_id
                OR public.camp_person_by_name(p_camp_id, t.camper_name) = p_person_id)
    ) a(nm) WHERE nm IS NOT NULL AND p_person_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public._camper_face_names(uuid, bigint) FROM public, anon, authenticated;


-- A person's effective consent: the consent on their most recently updated face
-- row, under any name. NULL when they have no face row at all, which is not the
-- same as "no" — nobody has been asked.
CREATE OR REPLACE FUNCTION public.camper_face_consent(p_camp_id uuid, p_person_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT f.consent
      FROM link_camper_faces f
     WHERE f.camp_id = p_camp_id
       AND f.camper_name IN (SELECT camper_name FROM public._camper_face_names(p_camp_id, p_person_id))
     ORDER BY f.updated_at DESC
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.camper_face_consent(uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camper_face_consent(uuid, bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.camper_face_consent(uuid, bigint) IS
    'A camper''s effective facial-recognition consent: the latest instruction across every name their face rows are filed under. NULL means never asked.';


-- Removes every trace of a person's biometric data, under every name. One place,
-- because a withdrawal that reaches three tables out of four is the defect.
CREATE OR REPLACE FUNCTION public._purge_camper_face_data(p_camp_id uuid, p_person_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_names text[];
    v_desc  bigint;
    v_tags  bigint;
    v_faces bigint;
BEGIN
    IF p_person_id IS NULL THEN
        RETURN jsonb_build_object('error', 'no_person');
    END IF;
    SELECT array_agg(camper_name) INTO v_names
      FROM public._camper_face_names(p_camp_id, p_person_id);
    IF v_names IS NULL THEN
        v_names := ARRAY[]::text[];
    END IF;

    DELETE FROM link_camper_face_descriptors
     WHERE camp_id = p_camp_id
       AND (person_id = p_person_id OR camper_name = ANY (v_names));
    GET DIAGNOSTICS v_desc = ROW_COUNT;

    DELETE FROM link_photo_tags
     WHERE camp_id = p_camp_id
       AND (person_id = p_person_id OR camper_name = ANY (v_names));
    GET DIAGNOSTICS v_tags = ROW_COUNT;

    -- The face rows are kept, not deleted: the consent DECISION is a record the
    -- camp needs — it is the evidence that the parent said no. Only the
    -- biometric payload goes, and every row for the person is stamped, not just
    -- the one the caller named.
    UPDATE link_camper_faces
       SET descriptor = NULL, headshot_data = NULL,
           consent = false, consent_at = NULL, updated_at = now()
     WHERE camp_id = p_camp_id
       AND (person_id = p_person_id OR camper_name = ANY (v_names));
    GET DIAGNOSTICS v_faces = ROW_COUNT;

    RETURN jsonb_build_object('descriptors', v_desc, 'tags', v_tags, 'face_rows', v_faces,
                              'names', to_jsonb(v_names));
END;
$$;
REVOKE ALL ON FUNCTION public._purge_camper_face_data(uuid, bigint)
    FROM public, anon, authenticated;


-- ─── 2. set_camper_face_consent ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_camper_face_consent(
    p_camp_id     uuid,
    p_camper_name text,
    p_consent     boolean,
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_id   bigint := p_camper_id;
    v_name text;
    v_purged jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    IF v_id IS NOT NULL THEN
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

    IF NOT p_consent THEN
        -- WITHDRAWAL. Everything for this child, under every name. When the
        -- child cannot be resolved to a person at all there is no set of names
        -- to sweep, so it falls back to the one the caller gave — which is what
        -- the old code did for everybody.
        IF v_id IS NOT NULL THEN
            v_purged := public._purge_camper_face_data(p_camp_id, v_id);
        ELSE
            DELETE FROM link_photo_tags
             WHERE camp_id = p_camp_id AND camper_name = v_name;
            DELETE FROM link_camper_face_descriptors
             WHERE camp_id = p_camp_id AND camper_name = v_name;
            v_purged := jsonb_build_object('names', jsonb_build_array(v_name));
        END IF;

        -- And a row for the CURRENT name, so a later read under the name the
        -- parent is looking at finds the refusal rather than nothing.
        INSERT INTO link_camper_faces
            (camp_id, camper_name, person_id, consent, consent_by, consent_at, updated_at)
        VALUES (p_camp_id, v_name, v_id, false, caller, NULL, now())
        ON CONFLICT (camp_id, camper_name) DO UPDATE
            SET consent = false, consent_by = caller, consent_at = NULL,
                person_id = COALESCE(link_camper_faces.person_id, EXCLUDED.person_id),
                descriptor = NULL, headshot_data = NULL, updated_at = now();

        RETURN jsonb_build_object('success', true, 'consent', false, 'purged', v_purged);
    END IF;

    -- GRANTING. Filed under the current roster key and stamped with the id, so
    -- the next rename does not strand it.
    INSERT INTO link_camper_faces
        (camp_id, camper_name, person_id, consent, consent_by, consent_at, updated_at)
    VALUES (p_camp_id, v_name, v_id, true, caller, now(), now())
    ON CONFLICT (camp_id, camper_name) DO UPDATE
        SET consent = true, consent_by = caller, consent_at = now(),
            person_id = COALESCE(link_camper_faces.person_id, EXCLUDED.person_id),
            updated_at = now();

    RETURN jsonb_build_object('success', true, 'consent', true, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.set_camper_face_consent(uuid, text, boolean, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_camper_face_consent(uuid, text, boolean, bigint)
    TO authenticated;


-- ─── 3. submit_camper_headshot ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_camper_headshot(
    p_camp_id       uuid,
    p_camper_name   text,
    p_headshot_data text,
    p_descriptor    jsonb,
    p_pose          text   DEFAULT 'front',
    p_model         text   DEFAULT 'faceapi-128',
    p_camper_id     bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    want_dims int;
    v_id      bigint := p_camper_id;
    v_name    text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    IF v_id IS NOT NULL THEN
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

    IF p_pose NOT IN ('front', 'left', 'right', 'extra') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_pose');
    END IF;
    want_dims := CASE p_model WHEN 'faceapi-128' THEN 128 WHEN 'arc-512' THEN 512 ELSE NULL END;
    IF want_dims IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_model');
    END IF;
    IF p_descriptor IS NULL OR jsonb_array_length(p_descriptor) <> want_dims THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_descriptor');
    END IF;
    IF p_headshot_data IS NOT NULL AND length(p_headshot_data) > 1500000 THEN   -- ~1.1MB base64
        RETURN jsonb_build_object('success', false, 'error', 'bad_headshot');
    END IF;

    -- Uploading a reference photo IS opting in. The FRONT pose's 128-D
    -- descriptor also lands on the legacy column for back-compat.
    INSERT INTO link_camper_faces
        (camp_id, camper_name, person_id, descriptor, headshot_data,
         consent, consent_by, consent_at, updated_at)
    VALUES (p_camp_id, v_name, v_id,
            CASE WHEN p_pose = 'front' AND p_model = 'faceapi-128' THEN p_descriptor END,
            CASE WHEN p_pose = 'front' THEN p_headshot_data END,
            true, caller, now(), now())
    ON CONFLICT (camp_id, camper_name) DO UPDATE
        SET descriptor    = CASE WHEN p_pose = 'front' AND p_model = 'faceapi-128'
                                 THEN EXCLUDED.descriptor ELSE link_camper_faces.descriptor END,
            headshot_data = CASE WHEN p_pose = 'front' AND EXCLUDED.headshot_data IS NOT NULL
                                 THEN EXCLUDED.headshot_data ELSE link_camper_faces.headshot_data END,
            person_id     = COALESCE(link_camper_faces.person_id, EXCLUDED.person_id),
            consent       = true,
            consent_by    = caller,
            consent_at    = COALESCE(link_camper_faces.consent_at, now()),
            updated_at    = now();

    -- Replace the same (model, pose) parent upload. Matched by person as well as
    -- by name, so a re-upload after a rename replaces the old descriptor instead
    -- of leaving two reference faces for one child.
    DELETE FROM link_camper_face_descriptors
     WHERE camp_id = p_camp_id
       AND model = p_model AND pose = p_pose AND source = 'parent'
       AND (camper_name = v_name OR (v_id IS NOT NULL AND person_id = v_id));
    INSERT INTO link_camper_face_descriptors
        (camp_id, camper_name, person_id, model, pose, source, descriptor, created_by)
    VALUES (p_camp_id, v_name, v_id, p_model, p_pose, 'parent', p_descriptor, caller);

    RETURN jsonb_build_object('success', true, 'pose', p_pose, 'model', p_model,
                              'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb, text, text, bigint)
    TO authenticated;


-- ─── 4. promote_confirmed_face ──────────────────────────────────────────────
-- Staff-side, so the camp-membership check stays. What changes is that consent
-- is read per PERSON: previously a consent row under a different spelling read
-- as no_consent and recognition stopped learning, while an old row still saying
-- true let it keep learning after the parent had said no.
CREATE OR REPLACE FUNCTION public.promote_confirmed_face(
    p_camp_id     uuid,
    p_camper_name text,
    p_descriptor  jsonb,
    p_model       text   DEFAULT 'faceapi-128',
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller      uuid := auth.uid();
    want_dims   int;
    n_confirmed int;
    v_id        bigint := p_camper_id;
    v_name      text;
    v_consent   boolean;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(p_camp_id, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    IF v_id IS NOT NULL THEN
        v_consent := public.camper_face_consent(p_camp_id, v_id);
    ELSE
        SELECT f.consent INTO v_consent FROM link_camper_faces f
         WHERE f.camp_id = p_camp_id AND f.camper_name = v_name;
    END IF;
    IF v_consent IS DISTINCT FROM true THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_consent');
    END IF;

    want_dims := CASE p_model WHEN 'faceapi-128' THEN 128 WHEN 'arc-512' THEN 512 ELSE NULL END;
    IF want_dims IS NULL OR p_descriptor IS NULL
       OR jsonb_array_length(p_descriptor) <> want_dims THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_descriptor');
    END IF;

    INSERT INTO link_camper_face_descriptors
        (camp_id, camper_name, person_id, model, pose, source, descriptor, created_by)
    VALUES (p_camp_id, v_name, v_id, p_model, 'confirmed', 'confirmed', p_descriptor, caller);

    -- Evict the oldest confirmed rows beyond the cap — counted per PERSON, so a
    -- child whose rows are spread over two names is capped at ten faces in
    -- total rather than ten per spelling.
    SELECT count(*) INTO n_confirmed
      FROM link_camper_face_descriptors
     WHERE camp_id = p_camp_id AND model = p_model AND source = 'confirmed'
       AND (camper_name = v_name OR (v_id IS NOT NULL AND person_id = v_id));
    IF n_confirmed > 10 THEN
        DELETE FROM link_camper_face_descriptors
         WHERE id IN (
            SELECT id FROM link_camper_face_descriptors
             WHERE camp_id = p_camp_id AND model = p_model AND source = 'confirmed'
               AND (camper_name = v_name OR (v_id IS NOT NULL AND person_id = v_id))
             ORDER BY created_at ASC
             LIMIT n_confirmed - 10);
    END IF;

    RETURN jsonb_build_object('success', true, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.promote_confirmed_face(uuid, text, jsonb, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.promote_confirmed_face(uuid, text, jsonb, text, bigint)
    TO authenticated;


-- ─── 5. resolve_photo_tag ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_photo_tag(
    p_photo_id    uuid,
    p_camper_name text,
    p_approve     boolean,
    p_camper_id   bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_camp uuid;
    v_id   bigint := p_camper_id;
    v_name text;
    v_n    bigint;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    SELECT camp_id INTO v_camp FROM link_photos WHERE id = p_photo_id;
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'photo_not_found');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = v_camp AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = v_camp AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    IF v_id IS NOT NULL THEN
        v_name := public.camp_person_label(v_camp, v_id);
        IF v_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'unknown_camper');
        END IF;
    ELSE
        v_name := p_camper_name;
        v_id   := public.camp_person_by_name(v_camp, v_name);
    END IF;

    IF p_approve THEN
        UPDATE link_photo_tags SET pending = false,
               person_id = COALESCE(person_id, v_id)
         WHERE photo_id = p_photo_id
           AND (camper_name = v_name OR (v_id IS NOT NULL AND person_id = v_id));
    ELSE
        -- A rejection has to reach the tag whatever name it was written under,
        -- or the office rejects it and it stays.
        DELETE FROM link_photo_tags
         WHERE photo_id = p_photo_id AND pending = true
           AND (camper_name = v_name OR (v_id IS NOT NULL AND person_id = v_id));
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'rows', v_n, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_photo_tag(uuid, text, boolean, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_photo_tag(uuid, text, boolean, bigint) TO authenticated;


-- ─── 6. record_link_photo_purchase ──────────────────────────────────────────
-- Service-side, called from the Stripe webhook with whatever name the checkout
-- carried. It gets an optional id and always stamps person_id, so a purchase
-- survives a rename — a parent who paid for facial recognition and then saw
-- their child renamed should not lose what they bought.
--
-- The ON CONFLICT target is unchanged: it is a real unique index on
-- (stripe_payment_intent_id, kind, COALESCE(camper_name,''), COALESCE(photo_id,…))
-- and changing it would need the index rebuilt. The idempotency key is the
-- payment intent, which is the part that matters.
CREATE OR REPLACE FUNCTION public.record_link_photo_purchase(
    p_camp_id           uuid,
    p_parent_user_id    uuid,
    p_kind              text,
    p_camper_name       text,
    p_photo_id          uuid,
    p_amount_cents      integer,
    p_payment_intent_id text,
    p_camper_id         bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id   bigint := p_camper_id;
    v_name text   := p_camper_name;
BEGIN
    IF v_id IS NOT NULL THEN
        -- A label that cannot be resolved does NOT refuse here. This is a
        -- webhook: the money has already moved, and refusing would lose the
        -- record of a payment that happened.
        v_name := COALESCE(public.camp_person_label(p_camp_id, v_id), v_name);
    ELSIF COALESCE(btrim(v_name), '') <> '' THEN
        v_id := public.camp_person_by_name(p_camp_id, v_name);
    END IF;

    INSERT INTO link_photo_purchases
        (camp_id, parent_user_id, kind, camper_name, person_id, photo_id,
         amount_paid_cents, stripe_payment_intent_id)
    VALUES
        (p_camp_id, p_parent_user_id, p_kind, v_name, v_id, p_photo_id,
         p_amount_cents, p_payment_intent_id)
    ON CONFLICT (stripe_payment_intent_id, kind, (COALESCE(camper_name, '')),
                 (COALESCE(photo_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    DO NOTHING;

    RETURN jsonb_build_object('success', true, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.record_link_photo_purchase(
    uuid, uuid, text, text, uuid, integer, text, bigint) FROM public, anon, authenticated;


-- ─── 7. submit_link_tip ─────────────────────────────────────────────────────
-- Carried its own copy of the name-containment check, like the three 225 found.
CREATE OR REPLACE FUNCTION public.submit_link_tip(
    p_recipient_name text,
    p_recipient_role text    DEFAULT '',
    p_amount         numeric DEFAULT 0,
    p_camper_name    text    DEFAULT NULL,
    p_camp_id        text    DEFAULT NULL,
    p_camper_id      bigint  DEFAULT NULL)
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
    v_id   bigint := p_camper_id;
    v_name text;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_recipient_name IS NULL OR btrim(p_recipient_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_recipient');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    IF COALESCE(btrim(p_camp_id), '') <> '' THEN
        BEGIN
            v_camp := p_camp_id::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('success', false, 'error', 'bad_camp');
        END;
    END IF;

    -- A tip may name no camper at all — thanking a counsellor is not about one
    -- child. In that case any active invite will do, as before.
    IF v_id IS NOT NULL OR COALESCE(btrim(p_camper_name), '') <> '' THEN
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
    ELSE
        SELECT * INTO inv FROM link_parent_invites
         WHERE user_id = caller AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
           AND (v_camp IS NULL OR camp_id = v_camp)
         ORDER BY created_at DESC LIMIT 1;
        IF inv.id IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
        END IF;
    END IF;

    INSERT INTO link_tips (
        camp_id, invite_id, user_id, camper_name, person_id,
        parent_name, parent_email, recipient_name, recipient_role, amount
    ) VALUES (
        inv.camp_id, inv.id, caller, v_name, v_id,
        inv.parent_name, inv.parent_email,
        btrim(p_recipient_name), coalesce(p_recipient_role, ''), round(p_amount, 2)
    )
    RETURNING id INTO new_id;

    -- Credit the recipient's account in the SAME camp as the resolved invite.
    -- Staff are still keyed by name here: camp_people holds them, but nothing
    -- reads staff ids yet and moving the tip ledger is its own piece of work.
    INSERT INTO link_staff_accounts (camp_id, staff_name, role, balance, total_earned)
    VALUES (inv.camp_id, btrim(p_recipient_name), coalesce(p_recipient_role, ''),
            round(p_amount, 2), round(p_amount, 2))
    ON CONFLICT (camp_id, lower(staff_name)) DO UPDATE
       SET balance      = link_staff_accounts.balance      + EXCLUDED.balance,
           total_earned = link_staff_accounts.total_earned + EXCLUDED.total_earned,
           role         = CASE WHEN link_staff_accounts.role = ''
                               THEN EXCLUDED.role ELSE link_staff_accounts.role END,
           updated_at   = now();

    RETURN jsonb_build_object('success', true, 'id', new_id, 'camper_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_link_tip(text, text, numeric, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.submit_link_tip(text, text, numeric, text, text, bigint)
    TO authenticated;


-- ─── 8. repairing the leak that is already there ────────────────────────────
-- Children whose latest instruction was "no" and who still have biometric data
-- under another name. DRY RUN unless confirmed.
CREATE OR REPLACE FUNCTION public.purge_revoked_face_data(p_confirm boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r        record;
    v_people bigint := 0;
    v_desc   bigint := 0;
    v_tags   bigint := 0;
    v_res    jsonb;
BEGIN
    FOR r IN
        -- Every person with a face row anywhere, judged on their latest
        -- instruction, who still has data they should not.
        SELECT DISTINCT p.camp_id, p.person_id
          FROM camp_people p
         WHERE p.kind = 'camper'
           AND public.camper_face_consent(p.camp_id, p.person_id) IS FALSE
           AND (EXISTS (SELECT 1 FROM link_camper_face_descriptors d
                         WHERE d.camp_id = p.camp_id
                           AND (d.person_id = p.person_id
                                OR d.camper_name IN (SELECT camper_name
                                     FROM public._camper_face_names(p.camp_id, p.person_id))))
             OR EXISTS (SELECT 1 FROM link_photo_tags t
                         WHERE t.camp_id = p.camp_id
                           AND (t.person_id = p.person_id
                                OR t.camper_name IN (SELECT camper_name
                                     FROM public._camper_face_names(p.camp_id, p.person_id))))
             OR EXISTS (SELECT 1 FROM link_camper_faces f
                         WHERE f.camp_id = p.camp_id
                           AND f.descriptor IS NOT NULL
                           AND f.camper_name IN (SELECT camper_name
                                FROM public._camper_face_names(p.camp_id, p.person_id))))
    LOOP
        v_people := v_people + 1;
        IF p_confirm THEN
            v_res  := public._purge_camper_face_data(r.camp_id, r.person_id);
            v_desc := v_desc + COALESCE((v_res ->> 'descriptors')::bigint, 0);
            v_tags := v_tags + COALESCE((v_res ->> 'tags')::bigint, 0);
        END IF;
    END LOOP;

    IF NOT p_confirm THEN
        RETURN jsonb_build_object(
            'dry_run', true, 'deleted', false,
            'campers_whose_withdrawal_was_not_honoured', v_people,
            'to_purge_them', 'SELECT public.purge_revoked_face_data(true);');
    END IF;
    RETURN jsonb_build_object(
        'dry_run', false, 'deleted', true,
        'campers_purged', v_people, 'descriptors_deleted', v_desc, 'tags_deleted', v_tags);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_revoked_face_data(boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_revoked_face_data(boolean) TO service_role;


-- ─── 9. the verifier ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_face_consent()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_rows      bigint;
    v_with_id   bigint;
    v_split     bigint;
    v_leaked    bigint;
    v_disagree  bigint;
BEGIN
    SELECT count(*), count(person_id) INTO v_rows, v_with_id FROM link_camper_faces;

    -- One child, face rows under more than one name. Every one of these is a
    -- rename that the old code would have split a withdrawal across.
    SELECT count(*) INTO v_split FROM (
        SELECT f.camp_id, COALESCE(f.person_id,
                                   public.camp_person_by_name(f.camp_id, f.camper_name)) AS pid
          FROM link_camper_faces f
         WHERE COALESCE(f.person_id,
                        public.camp_person_by_name(f.camp_id, f.camper_name)) IS NOT NULL
         GROUP BY 1, 2 HAVING count(*) > 1) a;

    -- Two rows for one child that disagree about consent. The later one is the
    -- parent's instruction; the earlier one is what the old code left behind.
    SELECT count(*) INTO v_disagree FROM (
        SELECT f.camp_id, COALESCE(f.person_id,
                                   public.camp_person_by_name(f.camp_id, f.camper_name)) AS pid
          FROM link_camper_faces f
         WHERE COALESCE(f.person_id,
                        public.camp_person_by_name(f.camp_id, f.camper_name)) IS NOT NULL
         GROUP BY 1, 2 HAVING count(DISTINCT f.consent) > 1) b;

    -- The number that matters: children who said no and whose biometric data is
    -- still there. Asked of the dry run, so the count and the repair can never
    -- disagree about what qualifies.
    v_leaked := COALESCE((public.purge_revoked_face_data()
                          ->> 'campers_whose_withdrawal_was_not_honoured')::bigint, 0);

    RETURN jsonb_build_object(
        'success', true,
        'face_rows', v_rows,
        'face_rows_carrying_an_id', v_with_id,
        'campers_with_face_rows_under_two_names', v_split,
        'campers_whose_two_rows_disagree_about_consent', v_disagree,
        -- Non-zero means a withdrawal that was reported as successful and was not.
        'campers_whose_withdrawal_was_not_honoured', v_leaked,
        'repair', CASE WHEN v_leaked > 0
                       THEN 'SELECT public.purge_revoked_face_data();  -- then (true)'
                       ELSE 'nothing to repair' END);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_face_consent() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_face_consent() TO authenticated, service_role;


-- ─── 10. the stale overloads go ─────────────────────────────────────────────
-- 028's headshot function predates every descriptor check 029 added: no model
-- validation, no dimension check, and it is still reachable by a four-argument
-- call. 016's and 017's tips likewise.
DROP FUNCTION IF EXISTS public.submit_camper_headshot(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.submit_camper_headshot(uuid, text, text, jsonb, text, text);
DROP FUNCTION IF EXISTS public.set_camper_face_consent(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.resolve_photo_tag(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.promote_confirmed_face(uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.submit_link_tip(text, text, numeric, text);
DROP FUNCTION IF EXISTS public.submit_link_tip(text, text, numeric, text, text);
DROP FUNCTION IF EXISTS public.record_link_photo_purchase(uuid, uuid, text, text, uuid, integer, text);

DO $$
DECLARE
    keep  oid[];
    names text[] := ARRAY['set_camper_face_consent', 'submit_camper_headshot',
                          'promote_confirmed_face', 'resolve_photo_tag',
                          'record_link_photo_purchase', 'submit_link_tip'];
    r     record;
BEGIN
    keep := ARRAY[
        to_regprocedure('public.set_camper_face_consent(uuid,text,boolean,bigint)'),
        to_regprocedure('public.submit_camper_headshot(uuid,text,text,jsonb,text,text,bigint)'),
        to_regprocedure('public.promote_confirmed_face(uuid,text,jsonb,text,bigint)'),
        to_regprocedure('public.resolve_photo_tag(uuid,text,boolean,bigint)'),
        to_regprocedure('public.record_link_photo_purchase(uuid,uuid,text,text,uuid,integer,text,bigint)'),
        to_regprocedure('public.submit_link_tip(text,text,numeric,text,text,bigint)')
    ]::oid[];
    IF array_position(keep, NULL) IS NOT NULL THEN
        RAISE EXCEPTION '226 did not create one of the signatures it is about to keep';
    END IF;

    FOR r IN
        SELECT p.oid, p.proname, oidvectortypes(p.proargtypes) AS args
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = ANY (names)
           AND NOT (p.oid = ANY (keep))
    LOOP
        EXECUTE format('DROP FUNCTION public.%I(%s)', r.proname, r.args);
        RAISE NOTICE '226: dropped stale overload public.%(%)', r.proname, r.args;
    END LOOP;

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
SELECT 'migration 226 applied'          AS status,
       public.verify_face_consent()     AS face_consent;
