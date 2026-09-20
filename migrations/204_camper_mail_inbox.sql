-- ============================================================================
-- Migration 204: inbound Camper Mail — parents email a letter, it lands in Live
--
-- Families already write letters inside Campistry Link (migration 015) and the
-- office prints them from Live's Camper Mail page. This adds the OTHER way in:
-- a parent sends a plain email from Gmail (or anywhere) to the camp's own
-- inbound address and it drops into the exact same queue, ready to print.
--
-- SHAPE MIRRORS THE DEPOSIT INBOX (migration 145) on purpose — the two are the
-- same problem (a public address that turns real email into rows) and share the
-- same three-check security stance in the edge function:
--   1. Svix signature over the raw body — proves Resend sent it.
--   2. A per-camp routing token in the To: address — proves which camp.
--   3. The From: address matched against the camp's own parent list — proves a
--      real family sent it, and is what pins the letter to the right camper.
--
-- The address is  letters+<inbound_token>@<inbound domain> . The token is a
-- bearer secret in the sense that anyone who knows the address can post to it,
-- but unlike the deposit token it is SHARED WITH PARENTS by design — they are
-- the senders. The known-parents gate below, not secrecy, is what keeps spam
-- out; the token only says which camp.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. settings (one row per camp; token minted on first admin read) ────────
CREATE TABLE IF NOT EXISTS camp_camper_mail_settings (
    camp_id             uuid PRIMARY KEY REFERENCES camps(id) ON DELETE CASCADE,
    enabled             boolean NOT NULL DEFAULT true,
    inbound_token       text    NOT NULL UNIQUE,
    -- The anti-spam gate. When true (default), only mail whose From address is
    -- a known parent email for this camp is accepted; anything else is dropped
    -- by the edge function without ever creating a row. A public inbound
    -- address otherwise fills the print queue with junk. A camp can turn this
    -- off briefly while testing, when it wants to see anything at all arrive.
    known_parents_only  boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camp_camper_mail_settings ENABLE ROW LEVEL SECURITY;
-- No client-facing policies — every read/write goes through the RPCs below,
-- same as camp_deposit_settings.

-- ─── 2. link_camper_mail additions ──────────────────────────────────────────
-- `source` distinguishes a letter typed in Link from one that arrived by email
-- (the UI can badge it and offer "Assign" only where it is needed). `parent_email`
-- already exists (migration 015). `inbound_fingerprint` is the whole duplicate
-- defence: Resend retries a webhook on any non-2xx, and a retried letter is a
-- duplicate letter, so the same delivery collapses onto one row.
ALTER TABLE link_camper_mail
    ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'link',
    ADD COLUMN IF NOT EXISTS inbound_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_link_camper_mail_inbound_fp
    ON link_camper_mail (camp_id, inbound_fingerprint)
    WHERE inbound_fingerprint IS NOT NULL;

-- ─── 3. admin gate (mirrors _deposit_can_admin) ─────────────────────────────
CREATE OR REPLACE FUNCTION public._camper_mail_can_admin(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = auth.uid()
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = auth.uid()
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    );
$$;

-- ─── 4. get settings (owner/admin) — mints the token on first use ────────────
CREATE OR REPLACE FUNCTION public.get_camper_mail_inbox_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_camper_mail_settings;
BEGIN
    IF NOT _camper_mail_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_camper_mail_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    SELECT * INTO v_row FROM camp_camper_mail_settings WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_row.enabled,
        'inboundToken', v_row.inbound_token,
        'knownParentsOnly', v_row.known_parents_only
    );
END;
$$;

-- ─── 5. set settings (owner/admin) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_camper_mail_inbox_settings(
    p_camp_id            uuid,
    p_enabled            boolean DEFAULT NULL,
    p_known_parents_only boolean DEFAULT NULL,
    p_rotate_token       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _camper_mail_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_camper_mail_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    UPDATE camp_camper_mail_settings SET
        enabled            = COALESCE(p_enabled, enabled),
        known_parents_only = COALESCE(p_known_parents_only, known_parents_only),
        inbound_token      = CASE WHEN p_rotate_token
                                  THEN replace(gen_random_uuid()::text, '-', '')
                                  ELSE inbound_token END,
        updated_at         = now()
     WHERE camp_id = p_camp_id;

    RETURN get_camper_mail_inbox_settings(p_camp_id);
END;
$$;

-- ─── 6. parent-facing address ───────────────────────────────────────────────
-- Parents are the senders, so they need to see the address. This returns ONLY
-- the address (never the settings), and only to a caller who holds an active
-- invite in that camp — the same trust boundary submit_camper_mail() uses.
-- Returns not_available (not an error) when the camp has not set the feature
-- up yet, so the Link page can simply hide the panel.
CREATE OR REPLACE FUNCTION public.get_camper_mail_inbox_address(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_token text;
    v_on    boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM link_parent_invites
         WHERE user_id = auth.uid()
           AND camp_id = p_camp_id
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT inbound_token, enabled INTO v_token, v_on
      FROM camp_camper_mail_settings WHERE camp_id = p_camp_id;

    IF v_token IS NULL OR v_on IS NOT TRUE THEN
        RETURN jsonb_build_object('success', true, 'available', false);
    END IF;

    RETURN jsonb_build_object('success', true, 'available', true, 'inboundToken', v_token);
END;
$$;

-- ─── 7. token → camp (service role only) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public._camper_mail_camp_for_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_camper_mail_settings;
BEGIN
    SELECT * INTO v_row FROM camp_camper_mail_settings
     WHERE inbound_token = p_token AND enabled = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_token');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campId', v_row.camp_id,
        'knownParentsOnly', v_row.known_parents_only
    );
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_camp_for_token(text) FROM public, anon, authenticated;

-- ─── 8. which campers does this sender's email cover? (service role only) ─────
-- The From: address is matched against parent emails on the camp's invites.
-- Each invite carries camper_names and camper_data{ name -> {division,grade,
-- bunk} }, so one sender can legitimately resolve to several children. The
-- edge function decides: one candidate auto-assigns; several, it disambiguates
-- by the name the parent wrote in the subject/body, else leaves it to a human.
CREATE OR REPLACE FUNCTION public._camper_mail_candidates(
    p_camp_id      uuid,
    p_sender_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email     text := lower(btrim(coalesce(p_sender_email, '')));
    v_cands     jsonb := '[]'::jsonb;
    v_seen      jsonb := '{}'::jsonb;
    inv         RECORD;
    nm          text;
    cd          jsonb;
BEGIN
    IF v_email = '' THEN
        RETURN jsonb_build_object('success', true, 'candidates', v_cands);
    END IF;

    FOR inv IN
        SELECT camper_names, camper_data
          FROM link_parent_invites
         WHERE camp_id = p_camp_id
           AND lower(btrim(parent_email)) = v_email
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
    LOOP
        IF inv.camper_names IS NULL THEN CONTINUE; END IF;
        FOR nm IN SELECT jsonb_array_elements_text(inv.camper_names)
        LOOP
            IF v_seen ? nm THEN CONTINUE; END IF;
            v_seen := v_seen || jsonb_build_object(nm, true);
            cd := COALESCE(inv.camper_data -> nm, '{}'::jsonb);
            v_cands := v_cands || jsonb_build_array(jsonb_build_object(
                'name',     nm,
                'division', COALESCE(cd ->> 'division', ''),
                'grade',    COALESCE(cd ->> 'grade', ''),
                'bunk',     COALESCE(cd ->> 'bunk', '')
            ));
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'candidates', v_cands);
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_candidates(uuid, text) FROM public, anon, authenticated;

-- ─── 9. store the letter (service role only) ─────────────────────────────────
-- One row per delivered email. camper_name is NOT NULL, so an email that could
-- not be pinned to a child is stored as '(unassigned)' — the office assigns it
-- in Live with one click. The fingerprint makes a Resend retry a no-op.
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
    p_body         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id      uuid;
    v_camper  text := COALESCE(NULLIF(btrim(p_camper_name), ''), '(unassigned)');
BEGIN
    IF p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_body');
    END IF;

    INSERT INTO link_camper_mail (
        camp_id, camper_name, division, grade, bunk,
        parent_name, parent_email, subject, body,
        status, source, inbound_fingerprint
    ) VALUES (
        p_camp_id, v_camper,
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
                              'assigned', v_camper <> '(unassigned)');
END;
$$;
REVOKE ALL ON FUNCTION public._camper_mail_record(uuid, text, text, text, text, text, text, text, text, text)
    FROM public, anon, authenticated;

-- Grant the caller-facing RPCs to authenticated (SECURITY DEFINER bodies do
-- their own gating). The service-role RPCs above are revoked from everyone but
-- the service role.
GRANT EXECUTE ON FUNCTION public.get_camper_mail_inbox_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_camper_mail_inbox_settings(uuid, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_camper_mail_inbox_address(uuid) TO authenticated;
