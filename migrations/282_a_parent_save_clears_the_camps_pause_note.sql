-- ============================================================================
-- Migration 282: when a parent saves their child's auto-reload in Link, the
-- note "switched off when the camp refunded the canteen balance" goes.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it before reloading Link.
--
-- ── THE PROBLEM (TED-156) ──────────────────────────────────────────────────
-- A refund that empties a child's wallet (or the season close-out) switches
-- that child's auto-reload off and leaves a note saying why, which Link shows
-- the parent (TED-143). The note was never taken away: after the parent
-- switched auto-reload back on, and later turned it off themselves, Link still
-- said "the camp switched it off".
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- Any save the parent makes (set_canteen_auto_reload, migration 231) drops
-- the camp's note (disabledReason, disabledAt): from then on the setting is
-- the parent's own.
-- ============================================================================

DO $$
DECLARE
    d   text;
    old text := $o$    v_acct  := jsonb_set(v_acct, '{autoReload}', v_ar, true);$o$;
    new text := $n$    -- A parent's save: the camp's "why it was switched off" note goes (282).
    v_ar := (v_ar - 'disabledReason') - 'disabledAt';
    v_acct  := jsonb_set(v_acct, '{autoReload}', v_ar, true);$n$;
BEGIN
    -- Pasted from Windows the patterns carry CR LF; the function text has none.
    old := replace(old, chr(13), '');
    new := replace(new, chr(13), '');
    IF to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)') IS NULL THEN
        RAISE EXCEPTION '282 needs migration 231 — apply it first';
    END IF;
    d := replace(pg_get_functiondef('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)'::regprocedure), chr(13), '');
    IF position('disabledReason' IN d) > 0 THEN
        RAISE NOTICE '282: set_canteen_auto_reload already clears the note';
        RETURN;
    END IF;
    IF position(old IN d) = 0 THEN
        RAISE EXCEPTION '282: set_canteen_auto_reload does not look the way this file expects — send this message to the builder';
    END IF;
    EXECUTE replace(d, old, new);
END $$;
