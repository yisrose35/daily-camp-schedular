-- =============================================================================
-- 191 — a second-half child is not at camp in June
--
-- Campistry has one flag for whether a child is a camper: roster.unenrolled,
-- set by hand. So a family registered for the SECOND half opens Link in June and
-- gets the whole portal — schedules, messages, pickup, photos — for a child who
-- will not arrive for a month. A first-half family gets the same thing in
-- August, for a child who went home. Neither is a small cosmetic problem: it is
-- the parent app telling a parent things about a child who is not there.
--
-- Enrolled is a BILLING fact. Present is a DATE fact. This migration adds the
-- second one and lets it decide what Link serves.
--
-- WHAT THE PARENT GETS INSTEAD: THEIR BILL, AND NOT NOTHING
--
-- This has been tried once before and reverted. Migration 035 gated Link on an
-- accessStart/accessEnd pair stamped onto each camper; nothing kept those in
-- step with anything, and migration 039 tore it out because it locked families
-- out of their own accounts — leaving link_filter_active_campers as a
-- pass-through and a comment in campistry_me.js that says, in as many words,
-- "leave accessStart/accessEnd EMPTY".
--
-- Two things are different here.
--
--   IT IS DERIVED, NEVER STAMPED. Presence is computed from the session's own
--     startDate/endDate against the date asked about. Editing a session's dates
--     moves everybody on it at once and there is nothing to re-stamp, so it
--     cannot drift out of step the way 035 did.
--
--   OUT OF SESSION IS PAYMENTS-ONLY, NOT LOCKED OUT. A family with no child at
--     camp today keeps the portal, on the bill alone, and is told why. That is
--     the actual answer to 039's complaint: a second-half family in June has a
--     deposit schedule to look at and no business with today's schedule.
--     link_parent_invites.billing_access (migration 070) already exists for
--     precisely this and was already described as surviving a closed portal.
--
-- EVERY UNKNOWN RESOLVES TOWARDS ACCESS. A session with no dates cannot
-- date-gate anybody, so it reads as present, always. So does a camp with no
-- campistryMe document, a camper with no enrollment record, and a pair of dates
-- that make no sense. Wrongly saying "present" puts a name on a list; wrongly
-- saying "absent" locks a family out of their own child's account, and that
-- asymmetry decides every default below.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
-- Replaces the three entry points as defined in migration 124, faithfully:
-- every rule 124 and its predecessors put there is still here.
-- =============================================================================

-- ─── 1. where one camper stands on one date ───────────────────────────────────
/**
 * The state of every named camper at a camp on a date.
 *
 *   active    some live enrollment's session covers the date
 *   upcoming  enrolled, earliest session has not started
 *   ended     every session they are on has finished
 *   none      no live enrollment, or unenrolled by hand
 *
 * Returns { success, on, by_camper:{name:{state,…}}, active:[], upcoming:[],
 *           ended:[], none:[] }.
 *
 * Mirrors campistry_enrollment_window.js exactly, because the office page and
 * the parent gate disagreeing about who is at camp would be worse than either
 * answer on its own.
 */
CREATE OR REPLACE FUNCTION public.camper_presence(
    p_camp_id uuid,
    p_names   jsonb,
    p_on      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_doc      jsonb;
    v_on       date := COALESCE(p_on, current_date);
    v_name     text;
    v_state    text;
    v_reason   text;
    v_session  text;
    v_from     date;
    v_to       date;
    v_by       jsonb := '{}'::jsonb;
    v_active   jsonb := '[]'::jsonb;
    v_upcoming jsonb := '[]'::jsonb;
    v_ended    jsonb := '[]'::jsonb;
    v_none     jsonb := '[]'::jsonb;
    v_hit      record;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT value INTO v_doc
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    FOR v_name IN SELECT jsonb_array_elements_text(COALESCE(p_names, '[]'::jsonb)) LOOP
        v_state := NULL; v_reason := NULL; v_session := NULL; v_from := NULL; v_to := NULL;

        -- No document at all: nothing is known, so nothing is gated.
        IF v_doc IS NULL THEN
            v_state := 'active'; v_reason := 'no_camp_document';
        -- Unenrolled by hand beats the calendar: that flag is a decision
        -- somebody made, a date is only a circumstance.
        ELSIF COALESCE((v_doc #> ARRAY['roster', v_name] ->> 'unenrolled')::boolean, false) THEN
            v_state := 'none'; v_reason := 'unenrolled_by_office';
        ELSE
            -- ONE SPAN, not a set of windows. A camper's stay runs from the
            -- earliest start to the latest end of everything they are on, and
            -- the date is tested against THAT.
            --
            -- The difference shows up on the changeover: a camp's two halves have
            -- a day or two between them, and per-session coverage would make a
            -- child enrolled in BOTH halves vanish from the roster — and their
            -- family lose the portal — for those two days. They are the camp's
            -- camper for the whole summer; the gap is not a departure.
            --
            -- A start after an end is a typo, not a window. Such a session is
            -- nullified to undated here, exactly as campistry_enrollment_window.js
            -- does, so it gates nobody rather than gating on nonsense.
            SELECT count(*)                                        AS n,
                   bool_or(s_from IS NULL AND s_to IS NULL)         AS any_undated,
                   bool_or(s_from IS NULL)                          AS open_start,
                   bool_or(s_to   IS NULL)                          AS open_end,
                   min(s_from)                                      AS first_from,
                   max(s_to)                                        AS last_to,
                   (array_agg(session ORDER BY (s_from IS NOT NULL), s_from))[1] AS first_session,
                   (array_agg(session ORDER BY (s_to IS NOT NULL) DESC, s_to DESC))[1] AS last_session,
                   (array_agg(session ORDER BY (s_from IS NOT NULL), s_from)
                      FILTER (WHERE (s_from IS NULL OR s_from <= v_on)
                                AND (s_to   IS NULL OR s_to   >= v_on)))[1] AS covering
              INTO v_hit
              FROM (
                SELECT e.value ->> 'session' AS session,
                       CASE WHEN a.a IS NOT NULL AND a.b IS NOT NULL AND a.a > a.b
                            THEN NULL ELSE a.a END AS s_from,
                       CASE WHEN a.a IS NOT NULL AND a.b IS NOT NULL AND a.a > a.b
                            THEN NULL ELSE a.b END AS s_to
                  FROM jsonb_each(COALESCE(v_doc -> 'enrollments', '{}'::jsonb)) AS e(k, value)
                  LEFT JOIN LATERAL (
                        SELECT ss AS value
                          FROM jsonb_array_elements(COALESCE(v_doc -> 'sessions', '[]'::jsonb)) AS ss
                         WHERE ss ->> 'name' = e.value ->> 'session'
                         LIMIT 1
                  ) s ON true
                  CROSS JOIN LATERAL (
                        SELECT NULLIF(s.value ->> 'startDate', '')::date AS a,
                               NULLIF(s.value ->> 'endDate',   '')::date AS b
                  ) a
                 WHERE e.value ->> 'camperName' = v_name
                   AND COALESCE(e.value ->> 'status', '') IN ('enrolled', 'accepted')
              ) live;

            IF COALESCE(v_hit.n, 0) = 0 THEN
                -- No live enrollment for this name. A camper the camp keeps on
                -- the roster without an enrollment record is not gated — only an
                -- absent one whose enrollment says so.
                IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(v_doc -> 'enrollments', '{}'::jsonb)) AS e(k, value)
                            WHERE e.value ->> 'camperName' = v_name) THEN
                    v_state := 'none'; v_reason := 'no_live_enrollment';
                ELSE
                    v_state := 'active'; v_reason := 'no_enrollment_record';
                END IF;
            ELSIF v_hit.any_undated THEN
                -- One unconditional place at camp makes them present, always.
                v_state := 'active'; v_reason := 'session_has_no_dates';
                v_session := v_hit.first_session;
            ELSE
                -- An open-ended side stays open: one session with no start means
                -- the stay has no start.
                v_from := CASE WHEN v_hit.open_start THEN NULL ELSE v_hit.first_from END;
                v_to   := CASE WHEN v_hit.open_end   THEN NULL ELSE v_hit.last_to   END;
                IF (v_from IS NULL OR v_on >= v_from) AND (v_to IS NULL OR v_on <= v_to) THEN
                    v_state   := 'active';
                    v_reason  := CASE WHEN v_hit.covering IS NOT NULL
                                      THEN 'in_session' ELSE 'between_sessions' END;
                    v_session := COALESCE(v_hit.covering, v_hit.first_session);
                ELSIF v_from IS NOT NULL AND v_on < v_from THEN
                    v_state := 'upcoming'; v_reason := 'session_not_started';
                    v_session := v_hit.first_session;
                ELSE
                    v_state := 'ended'; v_reason := 'session_finished';
                    v_session := v_hit.last_session;
                END IF;
            END IF;
        END IF;

        v_by := v_by || jsonb_build_object(v_name, jsonb_build_object(
            'state', v_state, 'reason', v_reason, 'session', v_session,
            'from', v_from, 'to', v_to));

        IF    v_state = 'active'   THEN v_active   := v_active   || to_jsonb(v_name);
        ELSIF v_state = 'upcoming' THEN v_upcoming := v_upcoming || to_jsonb(v_name);
        ELSIF v_state = 'ended'    THEN v_ended    := v_ended    || to_jsonb(v_name);
        ELSE                            v_none     := v_none     || to_jsonb(v_name);
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'on', v_on,
        'by_camper', v_by, 'active', v_active, 'upcoming', v_upcoming,
        'ended', v_ended, 'none', v_none);
END;
$$;

-- Not anon: it takes a camp id and a list of names and says which of those
-- children are at camp. The parent entry points below call it internally as
-- SECURITY DEFINER, which is the only access anybody needs.
REVOKE ALL ON FUNCTION public.camper_presence(uuid, jsonb, date) FROM public, anon, authenticated;

-- ─── 2. the filter, made real again ──────────────────────────────────────────
/**
 * The campers on this invite who are at camp, with their presence attached.
 *
 * A camp-aware sibling of link_filter_active_campers rather than a replacement:
 * the two-argument pass-through that migration 039 left behind has other
 * callers, and quietly changing what they do is how the last attempt at this
 * went wrong.
 *
 * `absent` comes back as well as `names`, because a portal that simply omits a
 * child cannot tell the parent WHY — and "your second-half camper starts on
 * 13 July" is the whole difference between this and looking broken.
 */
CREATE OR REPLACE FUNCTION public.link_filter_present_campers(
    p_camp_id uuid,
    p_names   jsonb,
    p_data    jsonb,
    p_on      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pres   jsonb;
    v_names  jsonb := '[]'::jsonb;
    v_data   jsonb := '{}'::jsonb;
    v_absent jsonb := '[]'::jsonb;
    v_n      text;
    v_p      jsonb;
BEGIN
    v_pres := public.camper_presence(p_camp_id, COALESCE(p_names, '[]'::jsonb), p_on);
    IF COALESCE((v_pres ->> 'success')::boolean, false) IS NOT TRUE THEN
        -- Could not work it out. Hand back everything rather than nothing.
        RETURN jsonb_build_object('names', COALESCE(p_names, '[]'::jsonb),
                                  'data',  COALESCE(p_data,  '{}'::jsonb),
                                  'count', COALESCE(jsonb_array_length(p_names), 0),
                                  'absent', '[]'::jsonb);
    END IF;

    FOR v_n IN SELECT jsonb_array_elements_text(COALESCE(p_names, '[]'::jsonb)) LOOP
        v_p := v_pres #> ARRAY['by_camper', v_n];
        IF COALESCE(v_p ->> 'state', 'active') = 'active' THEN
            v_names := v_names || to_jsonb(v_n);
            IF p_data IS NOT NULL AND p_data ? v_n THEN
                -- The presence rides along on the camper's own record, so the
                -- portal can label a child without a second round trip.
                v_data := v_data || jsonb_build_object(v_n, (p_data -> v_n) || jsonb_build_object('presence', v_p));
            END IF;
        ELSE
            v_absent := v_absent || jsonb_build_object('name', v_n, 'presence', v_p);
        END IF;
    END LOOP;

    RETURN jsonb_build_object('names', v_names, 'data', v_data,
                              'count', jsonb_array_length(v_names),
                              'absent', v_absent);
END;
$$;

REVOKE ALL ON FUNCTION public.link_filter_present_campers(uuid, jsonb, jsonb, date) FROM public, anon, authenticated;

-- ─── 3. the three entry points Link actually reads ───────────────────────────
-- Replaces migration 124's definitions. Each keeps every rule it had — the
-- billing_access OR, the expiry check, the already-claimed guard, the
-- camp_connected passthrough — and adds presence.

CREATE OR REPLACE FUNCTION public.get_my_camps()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(x.row ORDER BY x.sort_name, x.created_at), '[]'::jsonb)
    INTO result
    FROM (
        SELECT coalesce(c.name, '')                     AS sort_name,
               i.created_at                             AS created_at,
               jsonb_build_object(
                   'camp_id',       i.camp_id,
                   'camp_name',     coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
                   'parent_name',   i.parent_name,
                   'parent_email',  i.parent_email,
                   'family_id',     i.family_id,
                   -- Only the children who are actually at camp today. A
                   -- second-half camper is on the invite, is enrolled, is billed
                   -- — and is not here, so the portal must not offer their
                   -- schedule, their pickup or their photos.
                   'camper_names',  f.names,
                   'camper_data',   f.data,
                   -- Who is missing and why, so the app can say "starts 13 July"
                   -- instead of showing a family a portal with nobody in it.
                   'campers_absent', f.absent,
                   'camp_dates',    cd.value,
                   'portal_active', (i.status = 'active'),
                   'camp_connected', i.camp_connected,
                   -- What this family may do here right now. 'payments_only' is
                   -- a real, correct state, not a degraded one.
                   'access',        CASE
                                      WHEN jsonb_array_length(f.names) > 0 THEN 'full'
                                      WHEN jsonb_array_length(f.absent) > 0 THEN 'payments_only'
                                      ELSE 'none'
                                    END
               ) AS row
        FROM link_parent_invites i
        LEFT JOIN camps c ON c.id = i.camp_id
        LEFT JOIN camp_state_kv cd ON cd.camp_id = i.camp_id AND cd.key = 'campDates'
        CROSS JOIN LATERAL (
            SELECT (v ->> 'count')::int AS count, v -> 'names' AS names,
                   v -> 'data' AS data, v -> 'absent' AS absent
            FROM public.link_filter_present_campers(i.camp_id, i.camper_names, i.camper_data, NULL) AS v
        ) f
        WHERE i.user_id = caller
          AND (i.status = 'active' OR i.billing_access = true)
          AND (i.expires_at IS NULL OR i.expires_at > now())
    ) x;

    RETURN jsonb_build_object('success', true, 'camps', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camps() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camps() TO authenticated;


CREATE OR REPLACE FUNCTION public.get_parent_data_by_user()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv      link_parent_invites;
    caller   uuid := auth.uid();
    filtered jsonb;
    v_access text;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_invite_found'); END IF;

    filtered := public.link_filter_present_campers(inv.camp_id, inv.camper_names, inv.camper_data, NULL);

    -- 124 returned 'no_active_session' here and the portal did not open. That is
    -- the behaviour 039 was reverted over, and it is wrong for the ordinary case
    -- this migration creates: a family whose child starts next month has a bill
    -- to look at. An invite with campers on it always succeeds; `access` says
    -- what they may do.
    v_access := CASE
                  WHEN (filtered->>'count')::int > 0 THEN 'full'
                  WHEN jsonb_array_length(filtered->'absent') > 0 THEN 'payments_only'
                  ELSE 'none'
                END;
    IF v_access = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',        true,
        'camp_id',        inv.camp_id,
        'parent_name',    inv.parent_name,
        'parent_email',   inv.parent_email,
        'family_id',      inv.family_id,
        'camper_names',   filtered->'names',
        'camper_data',    filtered->'data',
        'campers_absent', filtered->'absent',
        'access',         v_access,
        'camp_connected', inv.camp_connected
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_parent_data_by_user() FROM public;
GRANT EXECUTE ON FUNCTION public.get_parent_data_by_user() TO authenticated;


CREATE OR REPLACE FUNCTION public.claim_parent_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv      link_parent_invites;
    caller   uuid := auth.uid();
    filtered jsonb;
    v_access text;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE token = p_token AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_or_expired'); END IF;
    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    UPDATE link_parent_invites SET user_id = caller WHERE id = inv.id;

    filtered := public.link_filter_present_campers(inv.camp_id, inv.camper_names, inv.camper_data, NULL);

    -- A family must be able to CLAIM their invite in March for a July camper.
    -- Refusing the claim because nobody is at camp yet would mean the invite
    -- expired unused before the season it was for.
    v_access := CASE
                  WHEN (filtered->>'count')::int > 0 THEN 'full'
                  WHEN jsonb_array_length(filtered->'absent') > 0 THEN 'payments_only'
                  ELSE 'none'
                END;
    IF v_access = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',        true,
        'camp_id',        inv.camp_id,
        'parent_name',    inv.parent_name,
        'parent_email',   inv.parent_email,
        'family_id',      inv.family_id,
        'camper_names',   filtered->'names',
        'camper_data',    filtered->'data',
        'campers_absent', filtered->'absent',
        'access',         v_access,
        'camp_connected', inv.camp_connected
    );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_parent_invite(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_parent_invite(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Verify after running:
--   -- who is at camp today, for a camp you know:
--   select public.camper_presence('<camp uuid>',
--          (select jsonb_agg(k) from jsonb_object_keys(
--             (select value -> 'roster' from camp_state_kv
--               where camp_id = '<camp uuid>' and key = 'campistryMe')) k));
--
--   -- the same question on a date inside the second half: the first-half
--   -- campers should come back 'ended' and the second-half ones 'active'.
--   select public.camper_presence('<camp uuid>', '["<a 1st-half camper>"]'::jsonb,
--                                 '<a date in the 2nd half>');
--
--   -- a session with no startDate/endDate must NEVER gate anybody:
--   --   clear one session's dates in Sessions & Pricing and re-run the above;
--   --   its campers must read 'active' with reason 'session_has_no_dates'.
--
--   -- and as a parent whose only camper is second-half, during the first half:
--   select public.get_parent_data_by_user();
--   -- expect success:true, access:'payments_only', camper_names:[],
--   --        campers_absent:[{name:…, presence:{state:'upcoming', from:…}}]
