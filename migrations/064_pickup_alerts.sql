-- ============================================================================
-- Migration 064: pickup_alerts + pickup_alert_recipients
--
-- New, dedicated tables for the pickup-alert routing feature. Deliberately
-- NOT reusing the existing `notifications`/`notification_reads` tables:
-- 007_notifications_rls.sql documents that `notifications` was created by
-- hand in the Supabase dashboard with one column set (user_id, type, title,
-- message, metadata, read); 056_notifications.sql's `CREATE TABLE IF NOT
-- EXISTS` used a DIFFERENT column set (camp_id, source, source_id, title,
-- body, link_target) — since the table already existed, that CREATE almost
-- certainly no-op'd, meaning 056's own trigger may be inserting into columns
-- that don't exist on the live table. 056's SELECT policy also explicitly
-- excludes the counselor role, who this feature must reach. Clean slate
-- avoids all of that rather than trying to untangle it blind.
--
-- pickup_alert_recipients is a JOIN TABLE, not an array column on the
-- parent row: acknowledge/snooze needs to be a single-row UPDATE per person
-- (a division head and a bunk counselor can tap "Saw it" seconds apart —
-- an array column would mean a read-modify-write race), and both RLS and
-- realtime filtering need a per-row `recipient_email`, which only a real
-- column (not one element inside a jsonb array) can express.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pickup_alerts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id            uuid NOT NULL,
    pickup_request_id  uuid NOT NULL REFERENCES public.parent_pickup_requests(id) ON DELETE CASCADE,
    camper_name        text NOT NULL,
    camper_bunk        text,
    camper_division    text,
    camper_grade       text,
    pickup_time        text NOT NULL,        -- "HH:MM" wall-clock as submitted, camp-local
    pickup_at          timestamptz,          -- resolved absolute instant (camp timezone applied)
    request_date       date NOT NULL,
    league_check_state text NOT NULL DEFAULT 'pending',  -- 'pending' | 'checked_no_match' | 'checked_match'
    reminder_fired_at  timestamptz,          -- cron idempotency: NULL until the T-5 push fires
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid,
    UNIQUE (pickup_request_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_camp_pending
    ON public.pickup_alerts (camp_id, reminder_fired_at) WHERE reminder_fired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.pickup_alert_recipients (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id          uuid NOT NULL REFERENCES public.pickup_alerts(id) ON DELETE CASCADE,
    camp_id           uuid NOT NULL,          -- denormalized: RLS/index without a join
    recipient_role    text NOT NULL,          -- 'division_head' | 'bunk_staff' | 'league_captain'
    recipient_name    text,
    recipient_email   text NOT NULL DEFAULT '',
    ack_state         text NOT NULL DEFAULT 'unseen',   -- 'unseen' | 'acknowledged' | 'snoozed'
    acknowledged_at   timestamptz,
    snoozed_until     timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alert_id, recipient_email)
);

CREATE INDEX IF NOT EXISTS idx_par_alert ON public.pickup_alert_recipients (alert_id);
CREATE INDEX IF NOT EXISTS idx_par_email ON public.pickup_alert_recipients (camp_id, lower(recipient_email));

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.pickup_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_office_select ON public.pickup_alerts;
CREATE POLICY pa_office_select ON public.pickup_alerts FOR SELECT USING (
    camp_id = get_user_camp_id() AND get_user_role() = ANY (ARRAY['owner','admin','scheduler'])
);

DROP POLICY IF EXISTS pa_counselor_select ON public.pickup_alerts;
CREATE POLICY pa_counselor_select ON public.pickup_alerts FOR SELECT USING (
    camp_id = get_user_camp_id() AND get_user_role() = 'counselor'
    AND EXISTS (
        SELECT 1 FROM public.pickup_alert_recipients r
        WHERE r.alert_id = pickup_alerts.id
          AND lower(r.recipient_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
);
-- No client INSERT/UPDATE/DELETE policy: only the routing trigger (next
-- migration) and the ack/snooze RPCs (a later migration) write here, both
-- SECURITY DEFINER — same convention parent_pickup_requests already uses
-- (submit_pickup_request is its only INSERT path).

ALTER TABLE public.pickup_alert_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS par_office_select ON public.pickup_alert_recipients;
CREATE POLICY par_office_select ON public.pickup_alert_recipients FOR SELECT USING (
    camp_id = get_user_camp_id() AND get_user_role() = ANY (ARRAY['owner','admin','scheduler'])
);

DROP POLICY IF EXISTS par_self_select ON public.pickup_alert_recipients;
CREATE POLICY par_self_select ON public.pickup_alert_recipients FOR SELECT USING (
    lower(recipient_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

-- ─── Realtime ───────────────────────────────────────────────────────────────
-- REPLICA IDENTITY FULL on the recipients table: the realtime filter needs
-- to key off recipient_email/camp_id, not just the primary key.
ALTER TABLE public.pickup_alerts ENABLE REPLICA IDENTITY FULL;
ALTER TABLE public.pickup_alert_recipients ENABLE REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.pickup_alerts;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.pickup_alert_recipients;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ─── Sanity checks ──────────────────────────────────────────────────────────
--   SELECT policyname, cmd, qual FROM pg_policies
--    WHERE tablename IN ('pickup_alerts','pickup_alert_recipients') ORDER BY tablename, policyname;
