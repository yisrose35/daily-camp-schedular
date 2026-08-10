-- ─────────────────────────────────────────────────────────────────────────────
-- 051 — Parent profile + preferences
--
-- Campistry Link's Settings page collected a parent's name, phone and
-- notification preferences and wrote them to localStorage and nowhere else. So
-- the camp never saw a corrected phone number, and the settings did not follow
-- the parent to a second device or from the browser to the app. The name field
-- was not even saved locally.
--
-- This gives that data a home. It is per-parent (not per-camp): a phone number
-- belongs to the person, and a parent with children in two camps should not
-- have to set it twice. Camp staff read it through the existing invite/roster
-- surfaces; this table is the parent's own copy of the truth.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS link_parent_profiles (
    user_id      uuid        NOT NULL,
    display_name text,
    phone        text,
    prefs        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)
);

ALTER TABLE link_parent_profiles ENABLE ROW LEVEL SECURITY;

-- A parent can see and edit exactly their own row and no one else's. The RPCs
-- below are the supported path; these policies mean a direct query cannot leak
-- another family's details even if one were attempted.
DROP POLICY IF EXISTS link_parent_profiles_self_select ON link_parent_profiles;
CREATE POLICY link_parent_profiles_self_select ON link_parent_profiles
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS link_parent_profiles_self_upsert ON link_parent_profiles;
CREATE POLICY link_parent_profiles_self_upsert ON link_parent_profiles
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS link_parent_profiles_self_update ON link_parent_profiles;
CREATE POLICY link_parent_profiles_self_update ON link_parent_profiles
    FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── Read ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_parent_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row link_parent_profiles%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_row FROM link_parent_profiles WHERE user_id = v_uid;

    -- No row yet is a normal state, not an error: the parent simply has not
    -- opened Settings. Return empty defaults so the client has nothing to
    -- special-case.
    RETURN jsonb_build_object(
        'success', true,
        'displayName', COALESCE(v_row.display_name, ''),
        'phone',       COALESCE(v_row.phone, ''),
        'prefs',       COALESCE(v_row.prefs, '{}'::jsonb)
    );
END;
$$;

-- ── Write ────────────────────────────────────────────────────────────────────
-- Every argument is optional so the client can save one field without having to
-- send (and risk clobbering) the others.
CREATE OR REPLACE FUNCTION public.save_my_parent_profile(
    p_display_name text  DEFAULT NULL,
    p_phone        text  DEFAULT NULL,
    p_prefs        jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    INSERT INTO link_parent_profiles AS p (user_id, display_name, phone, prefs, updated_at)
    VALUES (v_uid, p_display_name, p_phone, COALESCE(p_prefs, '{}'::jsonb), now())
    ON CONFLICT (user_id) DO UPDATE SET
        -- COALESCE keeps the stored value when an argument is omitted, so a
        -- partial save never wipes a field the client didn't send.
        display_name = COALESCE(EXCLUDED.display_name, p.display_name),
        phone        = COALESCE(EXCLUDED.phone,        p.phone),
        prefs        = CASE WHEN p_prefs IS NULL THEN p.prefs ELSE p_prefs END,
        updated_at   = now();

    RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_parent_profile()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_my_parent_profile(text, text, jsonb) TO authenticated;
