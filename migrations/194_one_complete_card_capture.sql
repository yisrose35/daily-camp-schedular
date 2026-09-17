-- =============================================================================
-- Migration 194: there can only be one complete_card_capture.
--
-- THE BUG THIS FIXES, as a parent saw it:
--
--     "Your card was accepted but we could not save it — please try again."
--
-- The card was fine. The gateway approved it and handed back a vault
-- reference. What failed was the very next line: recording that on the
-- capture row.
--
-- Migration 192 added an 8-argument complete_card_capture (the 7 from 189 plus
-- p_funding, with a DEFAULT) and deliberately kept 189's 7-argument version,
-- reasoning that "a default-valued 8th parameter cannot be reached by a
-- positional 7-arg call". That is true of SQL, and irrelevant here: PostgREST
-- does not call positionally. An edge function sends a JSON object of NAMED
-- arguments, and Postgres then has two equally valid candidates for a body
-- carrying the original seven names -- the 7-arg function, and the 8-arg one
-- with p_funding defaulted. So it refuses to choose:
--
--     PGRST203  Could not choose the best candidate function between:
--               public.complete_card_capture(p_reference => text, ... 7),
--               public.complete_card_capture(p_reference => text, ... 8)
--
-- Every caller broke, not just the one that wanted funding: card-capture-start
-- (Banquest) and cardknox-webhook both send the original seven names. The
-- Banquest path is the one that fails in front of a parent, because it is the
-- only rail that records the result inside the request the parent is waiting
-- on.
--
-- The fix is to have ONE function. The 8-argument form from 192 is kept, with
-- its default, so a 7-name caller still resolves -- to the only candidate
-- there is.
--
-- Idempotent -- safe to re-run. Requires 189 and 192.
-- =============================================================================

DROP FUNCTION IF EXISTS public.complete_card_capture(text, text, text, text, text, text, text);

-- Not recreated here: 192 owns the surviving definition, and duplicating it
-- would be a second place to keep in step. This migration only removes the
-- overload that made it unreachable.
--
-- If 192 has not been applied yet, apply it first -- otherwise this drops the
-- only version there is and nothing can record a capture at all.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'complete_card_capture'
    ) THEN
        RAISE EXCEPTION
            'complete_card_capture is now missing — apply migration 192 (which defines the 8-argument form), then re-run this one';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ─── Sanity checks (run manually after applying) ────────────────────────────
--   SELECT p.oid::regprocedure
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'complete_card_capture';
--   -- expect EXACTLY ONE row, the 8-argument form.
-- =============================================================================
