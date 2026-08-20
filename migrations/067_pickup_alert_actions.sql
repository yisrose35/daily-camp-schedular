-- ============================================================================
-- Migration 067: pickup-alert actions — acknowledge, snooze, league-captain
--
-- Three SECURITY DEFINER RPCs, all callable by 'authenticated':
--
--   ack_pickup_alert(p_recipient_id)             — "Saw it"
--   snooze_pickup_alert(p_recipient_id, p_minutes)  — "Remind me later"
--   add_pickup_alert_league_recipients(...)       — called from Live's
--       confirm handler after it finds a live league game overlapping the
--       pickup time (campistry_live_locator.js's matching logic, client-side
--       — see 065's header comment for why this isn't a DB trigger).
--
-- ack/snooze both check the caller owns the recipient row (by email) rather
-- than trusting the id alone — same "no client UPDATE policy, RPC-only"
-- convention as parent_pickup_requests.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ack_pickup_alert(p_recipient_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
BEGIN
    IF v_email = '' THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    UPDATE pickup_alert_recipients
       SET ack_state = 'acknowledged', acknowledged_at = now(), snoozed_until = NULL
     WHERE id = p_recipient_id AND lower(recipient_email) = v_email;

    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.snooze_pickup_alert(p_recipient_id uuid, p_minutes int DEFAULT 15)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
    v_mins  int := greatest(1, least(coalesce(p_minutes, 15), 120));
BEGIN
    IF v_email = '' THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    UPDATE pickup_alert_recipients
       SET ack_state = 'snoozed', snoozed_until = now() + make_interval(mins => v_mins)
     WHERE id = p_recipient_id AND lower(recipient_email) = v_email;

    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
    RETURN jsonb_build_object('success', true, 'snoozedUntil', (now() + make_interval(mins => v_mins)));
END;
$$;

REVOKE ALL ON FUNCTION public.ack_pickup_alert(uuid) FROM public;
REVOKE ALL ON FUNCTION public.ack_pickup_alert(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ack_pickup_alert(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.snooze_pickup_alert(uuid, int) FROM public;
REVOKE ALL ON FUNCTION public.snooze_pickup_alert(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.snooze_pickup_alert(uuid, int) TO authenticated;

-- ─── League-captain recipients ───────────────────────────────────────────────
-- p_captain_ids matches leagues.js's teamCaptains storage format: each entry
-- is either a lowercased email, or a "name|role" fallback key for a captain
-- with no login (see leagues.js:256-259). Staff-only — any signed-in staff
-- member of the camp may call this (it's invoked from Live's own confirm
-- handler, a staff session, not a parent one).
CREATE OR REPLACE FUNCTION public.add_pickup_alert_league_recipients(
    p_camp_id     uuid,
    p_camper_name text,
    p_captain_ids text[],
    p_league_name text,
    p_team        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_role     text := get_user_role();
    v_alert_id uuid;
    v_id       text;
    v_email    text;
    v_name     text;
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id OR v_role NOT IN ('owner','admin','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    SELECT id INTO v_alert_id FROM pickup_alerts
     WHERE camp_id = p_camp_id AND camper_name = p_camper_name
     ORDER BY created_at DESC LIMIT 1;
    IF v_alert_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_matching_alert');
    END IF;

    FOREACH v_id IN ARRAY coalesce(p_captain_ids, ARRAY[]::text[]) LOOP
        IF v_id LIKE '%@%' THEN
            v_email := lower(v_id);
            v_name  := NULL;
        ELSE
            -- "name|role" fallback key (leagues.js:256-259) — no login, so no
            -- email to notify by; still recorded as a recipient for the
            -- office/division dashboard's visibility, just not pushed to.
            v_email := '';
            v_name  := split_part(v_id, '|', 1);
        END IF;
        IF v_email <> '' THEN
            INSERT INTO pickup_alert_recipients (alert_id, camp_id, recipient_role, recipient_name, recipient_email)
            VALUES (v_alert_id, p_camp_id, 'league_captain', v_name, v_email)
            ON CONFLICT (alert_id, recipient_email) DO NOTHING;
        END IF;
    END LOOP;

    UPDATE pickup_alerts SET league_check_state = 'checked_match' WHERE id = v_alert_id;
    RETURN jsonb_build_object('success', true, 'alertId', v_alert_id);
END;
$$;

REVOKE ALL ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) FROM public;
REVOKE ALL ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_pickup_alert_league_recipients(uuid, text, text[], text, text) TO authenticated;

-- A confirm that found NO league match still needs to flip league_check_state
-- so the dashboard doesn't show "pending" forever — called from the same
-- client-side check when no game is found.
CREATE OR REPLACE FUNCTION public.mark_pickup_alert_league_checked(
    p_camp_id     uuid,
    p_camper_name text,
    p_state       text DEFAULT 'checked_no_match'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF get_user_camp_id() IS DISTINCT FROM p_camp_id OR get_user_role() NOT IN ('owner','admin','scheduler') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    UPDATE pickup_alerts SET league_check_state = coalesce(p_state, 'checked_no_match')
     WHERE camp_id = p_camp_id AND camper_name = p_camper_name
       AND id = (SELECT id FROM pickup_alerts WHERE camp_id = p_camp_id AND camper_name = p_camper_name
                 ORDER BY created_at DESC LIMIT 1);
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) FROM public;
REVOKE ALL ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_pickup_alert_league_checked(uuid, text, text) TO authenticated;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT ack_pickup_alert('<some pickup_alert_recipients.id>');
--   SELECT * FROM pickup_alert_recipients WHERE id = '<same id>';
