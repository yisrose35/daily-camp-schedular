-- ============================================================================
-- Migration 201: the reads every parent repeats, twice a minute, forever.
--
-- The parent portal has two 30-second pollers per open tab (messages and
-- pickup statuses) on top of its realtime sockets. That is the app's single
-- highest-frequency read path by a wide margin: one office user saving the
-- camp costs one query, but four hundred families with the portal open cost
-- 400 × 2 queries every 30 seconds whether or not anything changed. Nothing
-- here is a wrong answer — every one of these RPCs returns correct data. They
-- just each do an unbounded amount of work to do it, and the work grows with
-- the camp's history, so the app gets slower every week it is used and worst
-- in the busiest camp.
--
-- ── DEFECT 1: A `LIMIT` THAT LIMITS NOTHING ────────────────────────────────
-- Both get_camp_broadcasts (183) and get_staff_messages (027) end like this:
--
--     SELECT coalesce(jsonb_agg(...) ORDER BY created_at DESC), '[]')
--       INTO result
--       FROM link_broadcasts b
--      WHERE b.camp_id = p_camp_id
--      LIMIT 100;                 -- <- does nothing
--
-- jsonb_agg with no GROUP BY collapses the whole scan into exactly ONE output
-- row, so `LIMIT 100` caps a one-row result at one row. The cap reads like a
-- guard and is not one: every broadcast the camp has ever sent, body and all,
-- is aggregated into a single JSON value and handed to every parent on every
-- poll. A camp two seasons in with a couple of thousand broadcasts ships
-- megabytes per parent per 30 seconds to display the newest few.
--
-- The fix is to cap the ROWS before aggregating them, which is what the
-- original clearly intended. The parent portal merges by id into its local
-- store and never removes what it already has, so an older broadcast a parent
-- has already seen stays visible; the cap only bounds how far back a fresh
-- device back-fills.
--
-- ── DEFECT 2: A PREDICATE NO INDEX CAN SERVE ───────────────────────────────
-- get_my_messages (038) is correctly scoped to one family:
--
--     WHERE m.camp_id = inv.camp_id
--       AND lower(m.parent_email) = lower(inv.parent_email)
--
-- but link_messages' index is on (camp_id, parent_email) — the raw column. The
-- lower() makes it unusable, so Postgres reads EVERY message row in the camp
-- and filters. The result is small and correct; the work behind it is the
-- whole camp's message history, per parent, per poll. 400 parents against a
-- camp with 50,000 messages is ~20 million rows scanned every 30 seconds to
-- return a few dozen.
--
-- A functional index on (camp_id, lower(parent_email)) matches the predicate
-- exactly and turns that into a probe. The same expression is what migration
-- 023's parent Realtime policy compares on, and Realtime evaluates that policy
-- once per subscriber per change, so the index pays for itself twice.
--
-- ── WHY NOT JUST POLL LESS OFTEN ───────────────────────────────────────────
-- Because the poll is the safety net for a dropped websocket, and halving its
-- rate halves a cost that should not be linear in the camp's history in the
-- first place. Fix the per-call cost and the poll stops mattering.
--
-- Every function here keeps its exact signature and its exact return shape, so
-- no client or edge function needs redeploying alongside it. Idempotent; safe
-- to re-run.
--
-- The client half of this (the unfiltered realtime subscription, the
-- undebounced re-read, and the pickup poller that selected the camp's whole
-- request table) is in campistry_link_parent.html.
-- ============================================================================

-- ─── 1. Indexes for the predicates that actually run ────────────────────────
-- Plain CREATE INDEX, not CONCURRENTLY: the Supabase SQL Editor runs a pasted
-- script in a transaction and CONCURRENTLY cannot run inside one. These tables
-- are small enough that the brief lock is not worth working around.

-- get_my_messages' WHERE clause, and migration 023's link_messages_parent_select
-- policy, character for character.
CREATE INDEX IF NOT EXISTS idx_link_messages_camp_parent_lower
    ON public.link_messages (camp_id, lower(parent_email));

-- The invite lookup inside every parent-facing policy on link_messages and
-- parent_pickup_requests. user_id alone already narrowed this to a handful of
-- rows; including the rest of the predicate makes it a single probe, which
-- matters because Realtime re-runs it per subscriber per change.
CREATE INDEX IF NOT EXISTS idx_link_parent_invites_user_camp_lower
    ON public.link_parent_invites (user_id, camp_id, lower(parent_email));

-- ppr_parent_read joins invites on the RAW parent_email (no lower() on that
-- one), so this index is on the raw column deliberately — it must match the
-- policy as written, not as it perhaps should have been.
CREATE INDEX IF NOT EXISTS idx_ppr_camp_parent
    ON public.parent_pickup_requests (camp_id, parent_email);


-- ─── 2. get_camp_broadcasts — cap the rows, not the aggregate ───────────────
-- Same signature, same return shape, same authorization check (camp_reader,
-- migration 183). The only change is that the newest 100 broadcasts are chosen
-- BEFORE jsonb_agg sees them, so the cap that was always meant to be there
-- takes effect. idx_link_broadcasts_camp_created (camp_id, created_at DESC)
-- already exists, so this becomes an index scan that stops after 100 rows.
CREATE OR REPLACE FUNCTION public.get_camp_broadcasts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    result jsonb;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'subject', b.subject, 'body', b.body, 'created_at', b.created_at
    ) ORDER BY b.created_at DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT b2.id, b2.subject, b2.body, b2.created_at
          FROM link_broadcasts b2
         WHERE b2.camp_id = p_camp_id
         ORDER BY b2.created_at DESC
         LIMIT 100
    ) b;

    RETURN jsonb_build_object('success', true, 'broadcasts', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_broadcasts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_broadcasts(uuid) TO authenticated, service_role;


-- ─── 3. get_staff_messages — the same broken cap, staff side ────────────────
-- 027's LIMIT 300 sits after a bare jsonb_agg too. Fewer clients poll this
-- than poll the parent side, but the defect and the fix are identical, and
-- leaving one of two instances fixed is how a fix stops being a fix.
CREATE OR REPLACE FUNCTION public.get_staff_messages(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'thread_id', m.thread_id, 'subject', m.subject, 'body', m.body,
        'parent_name', m.parent_name, 'parent_email', m.parent_email,
        'recipient_label', m.recipient_label, 'read', m.read, 'created_at', m.created_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT m2.id, m2.thread_id, m2.subject, m2.body, m2.parent_name,
               m2.parent_email, m2.recipient_label, m2.read, m2.created_at
          FROM link_messages m2
         WHERE m2.camp_id = p_camp_id
           AND m2.recipient_user_id = caller
           AND m2.direction = 'in'
         ORDER BY m2.created_at DESC
         LIMIT 300
    ) m;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_staff_messages(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_staff_messages(uuid) TO authenticated;


-- ─── 4. get_my_messages — bounded, and by WHOLE THREADS ────────────────────
-- 038's version has no cap at all. Adding one row-wise would be wrong here in
-- a way it is not for broadcasts: the portal groups these into threads, so
-- cutting at the 200th MESSAGE can hand a parent a reply whose original is
-- missing, which reads as the camp having lost their message.
--
-- So the cap is on THREADS, newest activity first, and every message in a kept
-- thread comes back. A thread is whole or absent, never half.
--
-- Everything else is 038 unchanged: the same active-invite resolution, the
-- same DISTINCT ON dedupe of a group message's per-recipient copies, the same
-- case-insensitive email match, the same fields in the same order.
CREATE OR REPLACE FUNCTION public.get_my_messages(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    WITH mine AS (
        SELECT m.id, m.thread_id, m.direction, m.subject, m.body, m.read,
               m.archived_for_parent, m.camper_name, m.recipient_label, m.created_at
          FROM link_messages m
         WHERE m.camp_id = inv.camp_id
           AND lower(m.parent_email) = lower(inv.parent_email)
           AND m.hidden_for_parent = false
    ),
    recent_threads AS (
        SELECT thread_id
          FROM mine
         GROUP BY thread_id
         ORDER BY max(created_at) DESC
         LIMIT 200
    ),
    deduped AS (
        SELECT DISTINCT ON (mi.thread_id, mi.direction, mi.created_at)
               mi.id, mi.thread_id, mi.direction, mi.subject, mi.body, mi.read,
               mi.archived_for_parent, mi.camper_name, mi.recipient_label, mi.created_at
          FROM mine mi
          JOIN recent_threads rt ON rt.thread_id = mi.thread_id
         ORDER BY mi.thread_id, mi.direction, mi.created_at, mi.id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',         id,
        'thread_id',  thread_id,
        'direction',  direction,
        'subject',    subject,
        'body',       body,
        'read',       read,
        'archived',   archived_for_parent,
        'camper',     camper_name,
        'to',         recipient_label,
        'created_at', created_at
    ) ORDER BY created_at DESC), '[]'::jsonb)
    INTO result FROM deduped;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_messages(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_messages(uuid) TO authenticated;


-- ─── 5. retry_failed_tip_transfers — the third one, and the one that bites ──
-- Found by running the audit over every function rather than just the two this
-- migration set out to fix. Same shape, worse consequence: this one's dead cap
-- is the function's ONLY parameter.
--
--     retry_failed_tip_transfers(p_limit integer DEFAULT 50)
--       ... COALESCE(jsonb_agg(...), '[]')
--       FROM link_tip_cart_items i WHERE ...
--      LIMIT GREATEST(COALESCE(p_limit, 50), 1);
--
-- p_limit is a BATCH SIZE. The nightly runner asks for 50 failed tip transfers,
-- gets every one from the last 90 days, and tries to push them all through
-- Stripe in a single invocation. Ask for 50, get 900, time out, and the staff
-- whose tips failed stay unpaid — while the caller's logs say it asked for a
-- batch of 50, so nothing looks wrong at the call site.
--
-- The 90-day window was doing all the bounding anyone thought they had.
-- Signature, return shape, filters and grant are otherwise untouched.
CREATE OR REPLACE FUNCTION public.retry_failed_tip_transfers(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', i.id,
               'campId', i.camp_id,
               'cartId', i.cart_id,
               'staffName', i.staff_name,
               'staffAccountId', i.staff_account_id,
               'tipCents', i.tip_cents,
               'feeCents', i.fee_cents,
               'error', i.transfer_error)), '[]'::jsonb)
      FROM (
        SELECT i2.id, i2.camp_id, i2.cart_id, i2.staff_name, i2.staff_account_id,
               i2.tip_cents, i2.fee_cents, i2.transfer_error
          FROM link_tip_cart_items i2
         WHERE i2.processed_at IS NULL
           AND COALESCE(i2.transfer_error, '') <> ''
           AND i2.staff_account_id IS NOT NULL
           AND i2.created_at > now() - interval '90 days'
         -- Oldest first: a staff member who has been waiting longest gets
         -- retried first, and the batch walks forward instead of re-trying the
         -- same newest 50 on every run while the backlog never clears.
         ORDER BY i2.created_at
         LIMIT GREATEST(COALESCE(p_limit, 50), 1)
      ) i;
$$;
REVOKE ALL ON FUNCTION public.retry_failed_tip_transfers(integer)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_tip_transfers(integer) TO service_role;


-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- Confirm the caps are now inside a subquery rather than after the aggregate:
--   SELECT proname FROM pg_proc
--    WHERE proname IN ('get_camp_broadcasts','get_staff_messages')
--      AND prosrc ~ 'LIMIT\s+(100|300)\s*\)';        -- expect both rows
--
-- Confirm the functional index is there and matches the policy's expression:
--   SELECT indexdef FROM pg_indexes
--    WHERE indexname = 'idx_link_messages_camp_parent_lower';
--
-- And that the planner will actually use it (expect an Index Scan, not a Seq
-- Scan, once the table has enough rows to be worth it):
--   EXPLAIN SELECT 1 FROM link_messages
--    WHERE camp_id = '00000000-0000-0000-0000-000000000000'
--      AND lower(parent_email) = 'someone@example.com';
