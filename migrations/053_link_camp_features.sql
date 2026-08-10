-- ============================================================================
-- Migration 053: Per-camp Link feature entitlements.
--
-- Which parent-facing sections a camp gets is a billing fact, not a camp
-- preference — so the camp must not be able to switch one on. This table has
-- NO policy granting insert or update to authenticated users: RLS is on, and
-- the only way in is the service role (the Supabase dashboard, or an internal
-- tool). A camp owner querying it directly gets nothing back, and a write is
-- refused outright.
--
-- Reading is different: the parent app has to know what to show, so a
-- SECURITY DEFINER RPC returns the answer for the caller's own camps only.
--
-- Absence means ENABLED. A camp with no row keeps everything, so adding this
-- table cannot silently switch features off for existing camps; you opt a camp
-- OUT by writing a row that names the sections it does not get.
-- ============================================================================

CREATE TABLE IF NOT EXISTS link_camp_features (
    camp_id    uuid        NOT NULL,
    features   jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- { "tips": false, "shop": false }
    note       text,                                       -- why, for your own records
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id)
);

ALTER TABLE link_camp_features ENABLE ROW LEVEL SECURITY;

-- Deliberately no SELECT/INSERT/UPDATE policy for `authenticated`. With RLS on
-- and no policy, every ordinary client read returns zero rows and every write
-- fails. The service role bypasses RLS, which is exactly the intent: you set
-- it, nobody else can.

-- ── Read (parents) ───────────────────────────────────────────────────────────
-- Returns the union across the caller's active camps: a parent with children in
-- two camps sees a section if EITHER camp has it, because they genuinely need it
-- for that child. Per-camp detail is returned too, so the client can be more
-- precise later without another migration.
CREATE OR REPLACE FUNCTION public.get_my_link_features()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    v_row     link_camp_features;
    v_union   jsonb := '{}'::jsonb;
    v_by_camp jsonb := '{}'::jsonb;
    v_camp    jsonb;
    v_key     text;
    v_any     boolean := false;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    FOR inv IN
        SELECT * FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
    LOOP
        v_any := true;

        SELECT * INTO v_row FROM link_camp_features WHERE camp_id = inv.camp_id;
        v_camp := COALESCE(v_row.features, '{}'::jsonb);
        v_by_camp := jsonb_set(v_by_camp, ARRAY[inv.camp_id::text], v_camp, true);

        -- Union: a key is only false when EVERY camp says false. Seeding the
        -- union from each camp's own map means a key nobody mentions stays
        -- absent, and absent means enabled on the client.
        FOR v_key IN SELECT jsonb_object_keys(v_camp) LOOP
            IF COALESCE((v_camp->>v_key)::boolean, true) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'true'::jsonb, true);
            ELSIF NOT (v_union ? v_key) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'false'::jsonb, true);
            END IF;
        END LOOP;
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    RETURN jsonb_build_object('success', true, 'features', v_union, 'byCamp', v_by_camp);
EXCEPTION WHEN OTHERS THEN
    -- Never let this break the portal: an error here should mean "show
    -- everything", which the client treats as the default.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_link_features() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_link_features() TO authenticated;

-- ── How to switch a section off for a camp ───────────────────────────────────
-- Run as the service role (Supabase SQL editor is fine — it bypasses RLS):
--
--   INSERT INTO link_camp_features (camp_id, features, note)
--   VALUES ('<camp-uuid>', '{"tips": false, "shop": false}'::jsonb, 'Basic plan')
--   ON CONFLICT (camp_id) DO UPDATE
--     SET features = EXCLUDED.features, note = EXCLUDED.note, updated_at = now();
--
-- Valid keys are the parent-app sections: payments, canteen, shop, tips,
-- messages, mail, schedule, forms, lists, photos, pickup, health, emergency.
-- home, children and settings are structural and are always shown.
