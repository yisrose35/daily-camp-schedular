-- ============================================================================
-- Migration 105: password lockout for the main Campistry login
--
-- Why: signInWithPassword() was called directly from the browser
-- (index.html/landing.js, invite.html) with nothing standing between a
-- client and GoTrue — no attempt limit, no lockout, unlimited password
-- guessing against any real account. This closes that gap the same way
-- migrations 100/101 closed it for the Snacks POS PIN: every password
-- check now has to go through a table this migration adds, enforced by a
-- new secure-login edge function (never by the client itself, which could
-- just skip the check).
--
-- Rule, exactly as asked for: 5 wrong attempts on ONE email within a
-- rolling 24-hour window locks just that email, pending a self-service
-- "reopen" link sent to it. If failures on that same email keep
-- accumulating and hit 10 within that SAME 24-hour window, it escalates —
-- and the escalation is camp-wide: every login at that camp (the owner
-- plus every accepted team member) gets office-only locked, not just the
-- one email that was being guessed at. No more self-service unlock token
-- is issued for any of them — someone has to clear it by hand in the SQL
-- Editor, see the sanity-check block at the bottom. This is intentional:
-- 5 failed guesses on one login is routine (forgotten password), but 10 in
-- a day is treated as a real attack on the camp, worth pausing everyone's
-- access until a human confirms it's safe to reopen — rather than leaving
-- other staff logins reachable while one is clearly under attack.
--
-- The 24h window is a real rolling window, not a counter that resets on a
-- timer: login_failed_events is an append-only event log, and every check
-- recomputes "how many failures for this email in the last 24 hours"
-- straight from it. Reopening an email-locked account via the emailed link
-- clears its lock_level so login attempts can happen again, but it does
-- NOT clear that rolling count — one more wrong guess after reopening
-- re-locks immediately (self-service, until the 10-in-24h threshold is
-- hit), which is deliberate: a real attacker doesn't get a free reset out
-- of the email-unlock step.
--
-- Same convention as every other secret-bearing table in this app: RLS
-- enabled, ZERO client-facing policies, every access funneled through a
-- SECURITY DEFINER RPC. Three of the four RPCs here are service_role-only
-- (callable only by the secure-login edge function's service-role key,
-- never reachable from a browser); the fourth (unlock_account_via_token)
-- is deliberately anon-callable, because the person clicking the unlock
-- link isn't authenticated yet — that's the whole point of it.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 1. login_failed_events ─────────────────────────────────────────────────
-- Append-only. One row per failed password attempt. Never updated, never
-- deleted by the app (old rows simply age out of every rolling-window
-- query on their own) — a periodic cleanup of rows older than a few days
-- is a reasonable fast-follow if this table's size ever becomes a concern,
-- not needed to ship this.
CREATE TABLE IF NOT EXISTS login_failed_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email        text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_failed_events_email_time_idx
    ON login_failed_events (email, attempted_at);

ALTER TABLE login_failed_events ENABLE ROW LEVEL SECURITY;
-- No client-side policies — every access goes through the RPCs below.


-- ─── 2. account_lockouts ────────────────────────────────────────────────────
-- One row per email, created only once a lock is actually triggered (no
-- row = never locked). lock_level is NULL (unlocked) | 'email' (self-
-- service reopen) | 'office' (Campistry office must clear it by hand).
CREATE TABLE IF NOT EXISTS account_lockouts (
    email                    text PRIMARY KEY,
    lock_level               text,
    locked_at                timestamptz,
    unlock_token             text,
    unlock_token_expires_at  timestamptz,
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT account_lockouts_lock_level_check
        CHECK (lock_level IS NULL OR lock_level IN ('email', 'office'))
);

ALTER TABLE account_lockouts ENABLE ROW LEVEL SECURITY;
-- No client-side policies — every access goes through the RPCs below.

COMMENT ON TABLE account_lockouts IS
    'Password-attempt lockout for the main Campistry login. lock_level=email is self-service (unlock_token emailed to the account) and only ever affects that one email. lock_level=office requires a manual clear in the SQL Editor and is applied camp-wide (every login at the camp, not just the one that triggered it). RLS-locked; access only via RPC.';


-- ─── 2b. _camp_lock_emails ──────────────────────────────────────────────────
-- Given the email that just crossed the 10-in-24h threshold, returns every
-- email that should be office-locked alongside it: the camp owner (camps.
-- owner) plus every accepted camp_users row for that same camp_id. Looks up
-- the triggering email's own camp membership first (owner, else camp_users)
-- to find camp_id, then expands back out to every email in it.
--
-- Falls back to just the triggering email alone if it can't be resolved to
-- any camp (e.g. a stale/deleted account) — never errors, never returns an
-- empty set, so record_login_failure below always has at least one email to
-- lock.
CREATE OR REPLACE FUNCTION public._camp_lock_emails(p_email text)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_catalog
AS $$
DECLARE
    v_email   text := lower(p_email);
    v_user_id uuid;
    v_camp_id uuid;
BEGIN
    SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = v_email;
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT v_email;
        RETURN;
    END IF;

    SELECT id INTO v_camp_id FROM camps WHERE owner = v_user_id;
    IF v_camp_id IS NULL THEN
        SELECT camp_id INTO v_camp_id FROM camp_users WHERE user_id = v_user_id LIMIT 1;
    END IF;

    IF v_camp_id IS NULL THEN
        RETURN QUERY SELECT v_email;
        RETURN;
    END IF;

    RETURN QUERY
        SELECT lower(u.email)
        FROM camps c
        JOIN auth.users u ON u.id = c.owner
        WHERE c.id = v_camp_id
        UNION
        SELECT lower(u.email)
        FROM camp_users cu
        JOIN auth.users u ON u.id = cu.user_id
        WHERE cu.camp_id = v_camp_id AND cu.accepted_at IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._camp_lock_emails(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._camp_lock_emails(text) TO service_role;


-- ─── 3. check_login_lock_status ─────────────────────────────────────────────
-- service_role ONLY — called by secure-login BEFORE it ever attempts the
-- real password check, so a locked account never even reaches GoTrue.
CREATE OR REPLACE FUNCTION public.check_login_lock_status(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row account_lockouts%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM account_lockouts WHERE email = lower(p_email);

    IF NOT FOUND OR v_row.lock_level IS NULL THEN
        RETURN jsonb_build_object('locked', false);
    END IF;

    RETURN jsonb_build_object('locked', true, 'lockLevel', v_row.lock_level);
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_lock_status(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_lock_status(text) TO service_role;


-- ─── 4. record_login_failure ────────────────────────────────────────────────
-- service_role ONLY. Logs the failure, recomputes the rolling 24h count,
-- and escalates lock_level when a threshold is newly crossed. Only ever
-- called by secure-login for an account that just failed check_login_lock_
-- status (i.e. wasn't already locked) — so v_prev_level read here will
-- almost always be NULL; the DISTINCT FROM check below is what makes this
-- safe to call even if that assumption is ever wrong (e.g. two requests
-- racing right at the threshold — worst case is one extra logged failure,
-- not a stuck or double-sent unlock email).
CREATE OR REPLACE FUNCTION public.record_login_failure(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_email       text := lower(p_email);
    v_count_24h   integer;
    v_prev_level  text;
    v_new_level   text;
    v_token       text;
    v_just_locked boolean := false;
    v_camp_emails text[];
BEGIN
    INSERT INTO login_failed_events (email) VALUES (v_email);

    SELECT count(*) INTO v_count_24h
    FROM login_failed_events
    WHERE email = v_email AND attempted_at > now() - interval '24 hours';

    SELECT lock_level INTO v_prev_level FROM account_lockouts WHERE email = v_email;

    v_new_level := v_prev_level;
    IF v_count_24h >= 10 THEN
        v_new_level := 'office';
    ELSIF v_count_24h >= 5 AND COALESCE(v_prev_level, '') <> 'office' THEN
        v_new_level := 'email';
    END IF;

    IF v_new_level IS DISTINCT FROM v_prev_level THEN
        v_just_locked := true;

        IF v_new_level = 'office' THEN
            -- Escalation is camp-wide: lock every login at this camp, not
            -- just the one email that hit 10. No token for this tier —
            -- office has to clear it by hand. Captured into an array (not
            -- just inserted straight from the SETOF) so the same list can
            -- also go out in the return value — secure-login uses it to
            -- send the office its own heads-up alert, separate from the
            -- "contact the office" message shown to whoever was locked out.
            SELECT array_agg(camp_email) INTO v_camp_emails
            FROM public._camp_lock_emails(v_email) AS camp_email;

            INSERT INTO account_lockouts (email, lock_level, locked_at, unlock_token, unlock_token_expires_at, updated_at)
            SELECT unnest(v_camp_emails), 'office', now(), NULL, NULL, now()
            ON CONFLICT (email) DO UPDATE
                SET lock_level              = 'office',
                    locked_at               = now(),
                    unlock_token            = NULL,
                    unlock_token_expires_at = NULL,
                    updated_at              = now();
        ELSE
            v_token := encode(gen_random_bytes(24), 'hex');

            INSERT INTO account_lockouts (email, lock_level, locked_at, unlock_token, unlock_token_expires_at, updated_at)
            VALUES (v_email, v_new_level, now(), v_token, now() + interval '24 hours', now())
            ON CONFLICT (email) DO UPDATE
                SET lock_level              = EXCLUDED.lock_level,
                    locked_at               = EXCLUDED.locked_at,
                    unlock_token            = EXCLUDED.unlock_token,
                    unlock_token_expires_at = EXCLUDED.unlock_token_expires_at,
                    updated_at              = now();
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'lockLevel', v_new_level,
        'justLocked', v_just_locked,
        'unlockToken', CASE WHEN v_just_locked AND v_new_level = 'email' THEN v_token ELSE NULL END,
        'campEmails', CASE WHEN v_just_locked AND v_new_level = 'office' THEN to_jsonb(v_camp_emails) ELSE NULL END,
        'attemptsRemaining', GREATEST(0, 5 - v_count_24h)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_login_failure(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_failure(text) TO service_role;


-- ─── 5. clear_login_failures ────────────────────────────────────────────────
-- service_role ONLY. Called by secure-login right after a genuinely
-- successful password check — a correct password is a much stronger
-- signal than clicking an emailed link, so (unlike the email-unlock path,
-- which deliberately does NOT reset the rolling count) a real successful
-- sign-in clears the slate. A locked account can never reach this call in
-- the first place (secure-login rejects it before ever checking the
-- password), so this never undermines the office-only escalation.
CREATE OR REPLACE FUNCTION public.clear_login_failures(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email text := lower(p_email);
BEGIN
    DELETE FROM login_failed_events WHERE email = v_email;
    DELETE FROM account_lockouts WHERE email = v_email;
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_login_failures(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_login_failures(text) TO service_role;


-- ─── 6. unlock_account_via_token ────────────────────────────────────────────
-- Deliberately anon-callable — the person clicking the "Reopen my account"
-- link in the email isn't signed in yet. Only ever unlocks a lock_level =
-- 'email' row (an 'office' lock is never issued a token to begin with, but
-- the explicit check here is defense in depth against that ever changing).
-- Locks the row FOR UPDATE so two clicks on the same link can't race.
CREATE OR REPLACE FUNCTION public.unlock_account_via_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row account_lockouts%ROWTYPE;
BEGIN
    IF p_token IS NULL OR length(p_token) < 10 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_token');
    END IF;

    SELECT * INTO v_row FROM account_lockouts
     WHERE unlock_token = p_token
       AND lock_level = 'email'
       AND unlock_token_expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_or_expired');
    END IF;

    UPDATE account_lockouts
       SET lock_level = NULL, unlock_token = NULL, unlock_token_expires_at = NULL, updated_at = now()
     WHERE email = v_row.email;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_account_via_token(text) FROM public;
GRANT EXECUTE ON FUNCTION public.unlock_account_via_token(text) TO anon, authenticated;


-- ─── Manually clearing a lock (Campistry office action) ───────────────────
-- There is no self-service or in-app path for an office-only lock, on
-- purpose — run this directly in the Supabase SQL Editor once you've
-- verified with the camp owner that it's really them.
--
-- An office-only lock is camp-wide (see migration header), so clear it for
-- every login at that camp in one go — pass ANY email from that camp, it
-- resolves the rest on its own:
--
--   UPDATE account_lockouts SET lock_level = NULL, unlock_token = NULL,
--       unlock_token_expires_at = NULL, updated_at = now()
--     WHERE email IN (SELECT public._camp_lock_emails('any-email-from-that-camp@example.com'));
--
-- To check who's currently locked and at what level before clearing anything:
--
--   SELECT * FROM account_lockouts
--    WHERE email IN (SELECT public._camp_lock_emails('any-email-from-that-camp@example.com'));
--
-- (A single email-tier lock — reached one person at 5 fails, camp never hit
-- 10 — can still be cleared for just that one row the same way as before:
-- UPDATE account_lockouts SET lock_level = NULL, ... WHERE email = 'x@example.com';
-- though in practice that tier is meant to self-clear via the emailed link.)


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT proname, proacl FROM pg_proc
--   WHERE proname IN ('check_login_lock_status','record_login_failure',
--                      'clear_login_failures','unlock_account_via_token',
--                      '_camp_lock_emails');
--   -- expect: check_login_lock_status + record_login_failure +
--   -- clear_login_failures + _camp_lock_emails grant to service_role only;
--   -- unlock_account_via_token grants to anon + authenticated.
--
--   SELECT * FROM pg_policies WHERE tablename IN ('login_failed_events','account_lockouts');
--   -- expect ZERO rows — no client-facing policy exists on either table.
-- ============================================================================
