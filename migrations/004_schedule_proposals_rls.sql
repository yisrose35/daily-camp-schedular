-- ============================================================================
-- Migration: enforce RLS on schedule_proposals
--
-- Why: The audit found no migration in this repo for schedule_proposals
--      even though unified_schedule_system.js reads/writes it. Bringing
--      the policy into version control.
--
-- Idempotent. Schema columns inferred from unified_schedule_system.js:
--   id, camp_id, date_key, division, proposed_by, proposed_at,
--   payload jsonb, status, applied_at
-- ============================================================================

ALTER TABLE IF EXISTS schedule_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedule_proposals_select ON schedule_proposals;
CREATE POLICY schedule_proposals_select ON schedule_proposals
    FOR SELECT
    USING (camp_id = get_user_camp_id());

-- Any active role can create a proposal — proposals are review requests,
-- not schedule mutations. The downstream apply step is gated by the
-- daily_schedules UPDATE policy.
DROP POLICY IF EXISTS schedule_proposals_insert ON schedule_proposals;
CREATE POLICY schedule_proposals_insert ON schedule_proposals
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS schedule_proposals_update ON schedule_proposals;
CREATE POLICY schedule_proposals_update ON schedule_proposals
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS schedule_proposals_delete ON schedule_proposals;
CREATE POLICY schedule_proposals_delete ON schedule_proposals
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE schedule_proposals;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;
