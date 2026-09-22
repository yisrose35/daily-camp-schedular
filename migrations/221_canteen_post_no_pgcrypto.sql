-- ============================================================================
-- 221 — canteen_post must not depend on pgcrypto
--
-- ⚠ APPLY THIS NOW IF 219 IS APPLIED. Until it is, EVERY canteen purchase
--   fails: submit_canteen_purchase calls canteen_post, canteen_post calls
--   digest(), and digest() cannot be resolved. A live camp would have a
--   register that refuses every sale.
--
-- WHAT WENT WRONG. 219's canteen_post built its ledger signature with
--
--     encode(digest(… , 'sha256'), 'hex')
--
-- digest() comes from pgcrypto, and on Supabase pgcrypto is installed in the
-- `extensions` schema — not `public`. Every function in this chain carries
-- SET search_path = public, pg_catalog, deliberately, so that a caller cannot
-- change what a SECURITY DEFINER function resolves. That same protection means
-- digest() is not on the path, and the call fails at RUNTIME rather than at
-- CREATE time, because PL/pgSQL resolves function names when the line first
-- executes.
--
-- So 219 applied cleanly, its confirmation reported success, its behaviour
-- tests passed, and the first real purchase failed with
-- "function digest(text, unknown) does not exist".
--
-- WHY THE TESTS DID NOT CATCH IT. scripts/try_migration.sh stubs Supabase, and
-- its stub does `CREATE EXTENSION IF NOT EXISTS pgcrypto` with no schema — so
-- pgcrypto landed in public, digest() resolved, and every test passed against
-- a database shaped differently from the real one. The harness has been
-- changed to install it the way Supabase does, so this class of mistake fails
-- there from now on.
--
-- THE FIX. md5() is a core function in pg_catalog: no extension, nothing to
-- resolve, on the search_path by definition. The signature here is a dedupe
-- key for rows this function wrote itself, not a security primitive — it needs
-- to be unique and stable, not collision-proof against an adversary. The
-- primary key on (camp_id, sig) is what actually makes a double-post
-- impossible; the hash only has to avoid accidental collisions.
--
-- Nothing else in 219 changes, and no data needs repairing: the failing calls
-- never wrote anything, because the exception aborted the whole transaction —
-- balance and ledger together.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction; idempotent.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'canteen_post') THEN
        RAISE EXCEPTION 'canteen_post is missing — apply 219 before this file';
    END IF;
END $$;


CREATE OR REPLACE FUNCTION public.canteen_post(
    p_camp_id uuid,
    p_key     text,
    p_tx      jsonb,
    p_sig     text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- md5(), not digest(): a core pg_catalog function, so it resolves under the
    -- pinned search_path this function deliberately sets. See the header.
    --
    -- clock_timestamp(), not now(): now() is the TRANSACTION clock, so two
    -- posts for the same camper and amount inside one transaction would hash
    -- identically and the second would be swallowed by ON CONFLICT DO NOTHING.
    -- A refund issued in the same transaction as the charge it reverses is
    -- exactly that case.
    v_sig text := COALESCE(p_sig,
        'row:' || md5(p_camp_id::text || '|' || p_key || '|' || p_tx::text
                      || '|' || clock_timestamp()::text));
BEGIN
    INSERT INTO canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    VALUES (
        p_camp_id, v_sig,
        p_key,
        (SELECT person_id::text FROM camp_canteen_accounts
          WHERE camp_id = p_camp_id AND account_key = p_key),
        COALESCE(p_tx ->> 'type', ''),
        COALESCE(NULLIF(p_tx ->> 'amount', '')::numeric, 0),
        COALESCE(p_tx ->> 'date', (now() AT TIME ZONE 'utc')::date::text),
        COALESCE(p_tx ->> 'time', ''),
        COALESCE(p_tx ->> 'items', ''),
        p_tx)
    ON CONFLICT (camp_id, sig) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_post(uuid, text, jsonb, text) FROM public, anon, authenticated;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- Proves the function RUNS, not merely that it exists — the whole point is
-- that 219's version existed, compiled, and threw on first execution.
DO $$
DECLARE v_camp uuid;
BEGIN
    SELECT id INTO v_camp FROM camps LIMIT 1;
    IF v_camp IS NULL THEN
        RAISE NOTICE 'no camps to test against — skipping the live call';
        RETURN;
    END IF;
    PERFORM public.canteen_post(v_camp, '__221_selftest__',
        jsonb_build_object('type', 'debit', 'amount', 0, 'items', '221 self test'));
    DELETE FROM canteen_transactions
     WHERE camp_id = v_camp AND camper = '__221_selftest__';
    RAISE NOTICE 'canteen_post ran and its row was removed';
END $$;

SELECT 'migration 221 applied'                                              AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'canteen_post'
           AND pg_get_functiondef(p.oid) ~ 'md5\(')                         AS uses_md5,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ '\mdigest\(')                    AS still_using_digest;
