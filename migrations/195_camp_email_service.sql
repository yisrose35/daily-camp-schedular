-- =============================================================================
-- Migration 195: the emailing service, as a thing a camp pays for.
--
-- Campistry can send a camp's parents mail (acceptance letters, the
-- post-acceptance form, receipts, broadcasts) and that costs the platform real
-- money per message. Until now there was no per-camp gate at all -- one
-- platform-wide Resend key, and anyone who pressed a button sent mail.
--
-- WHY ITS OWN TABLE rather than a key inside link_camp_features (053): that
-- table's whole convention is "absence means ENABLED", which is right for
-- switching a camp OUT of a feature it already has. A paid add-on is the other
-- way round, and putting two opposite defaults in one jsonb blob is how you
-- get a camp billed for something it was never granted, or a camp silently cut
-- off. One table, one meaning: a row with enabled = true, or nothing.
--
-- HOW A CAMP GETS IT: the service role writes a row. RLS is on with no policy
-- for authenticated users at all, so a camp owner cannot grant it to
-- themselves, cannot see other camps' rows, and cannot flip their own. Same
-- shape as 053 and camp_processor_credentials.
--
-- EXISTING CAMPS ARE GRANTED IT. Every camp that exists when this is applied
-- gets a row, because the automatic portal invite already ships ON and
-- switching it off for every live camp the moment this lands would be a
-- regression dressed as a feature. The gate is real from here forward: a camp
-- created after this has no row and does not send automatically until granted.
--
-- Idempotent -- safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS camp_email_service (
    camp_id     uuid PRIMARY KEY REFERENCES camps(id) ON DELETE CASCADE,
    enabled     boolean     NOT NULL DEFAULT true,
    -- Why, for your own records: "on the Growth plan", "trial until June".
    note        text,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camp_email_service ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy for authenticated. With RLS on and no policy, every
-- ordinary client read returns nothing and every write is refused. Reading
-- happens through the RPC below; granting happens through the service role.

-- ─── grandfather every camp that already exists ─────────────────────────────
-- ON CONFLICT DO NOTHING so re-running never re-grants a camp that was
-- deliberately switched off afterwards.
INSERT INTO camp_email_service (camp_id, enabled, note)
SELECT c.id, true, 'granted automatically when the email gate was introduced (195)'
  FROM camps c
ON CONFLICT (camp_id) DO NOTHING;

-- ─── can this camp send automatically? ──────────────────────────────────────
-- Answers only for the CALLER's own camp. Returns false for a camp with no
-- row, which is the whole point of the gate.
CREATE OR REPLACE FUNCTION public.get_camp_email_service()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp uuid := public.get_user_camp_id();
    v_on   boolean;
BEGIN
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', true, 'enabled', false, 'reason', 'no_camp');
    END IF;

    SELECT enabled INTO v_on FROM camp_email_service WHERE camp_id = v_camp;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', COALESCE(v_on, false),
        'reason', CASE WHEN v_on IS NULL THEN 'not_granted'
                       WHEN v_on THEN 'granted'
                       ELSE 'switched_off' END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_email_service() FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_email_service() TO authenticated;

-- ─── the server-side check, for edge functions ──────────────────────────────
-- The RPC above is what the OFFICE UI asks so it can explain itself. This one
-- takes a camp id and is for the send path, which must not trust a browser's
-- word that a camp is allowed to send.
CREATE OR REPLACE FUNCTION public._camp_may_send_email(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE((SELECT enabled FROM camp_email_service WHERE camp_id = p_camp_id), false);
$$;

REVOKE ALL ON FUNCTION public._camp_may_send_email(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._camp_may_send_email(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─── Granting a camp the emailing service (Supabase SQL Editor) ─────────────
--   INSERT INTO camp_email_service (camp_id, enabled, note)
--   VALUES ('<camp uuid>', true, 'paid — Growth plan')
--   ON CONFLICT (camp_id) DO UPDATE SET enabled = true, note = EXCLUDED.note, updated_at = now();
--
-- Taking it away:
--   UPDATE camp_email_service SET enabled = false, updated_at = now() WHERE camp_id = '<camp uuid>';
--
-- Who has it:
--   SELECT c.name, e.enabled, e.note FROM camps c
--     LEFT JOIN camp_email_service e ON e.camp_id = c.id ORDER BY c.name;
-- =============================================================================
