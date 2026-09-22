-- ============================================================================
-- 228 — four money RPCs PostgREST cannot choose between
--
-- ⚠ APPLY THIS NOW, AND BEFORE 227 IF YOU ARE ONLY APPLYING ONE. It is
--   independent of every other file in this chain.
--
-- WHAT IS BROKEN RIGHT NOW. PostgREST resolves an RPC by ARGUMENT NAME. If two
-- overloads of a function can both satisfy the keys a caller sends, Postgres
-- refuses to choose and the call fails with
--
--     PGRST203  Could not choose the best candidate function between …
--
-- Four canteen money functions are in that state:
--
--     credit_canteen_balance_from_processor   arities 5 and 6
--     submit_canteen_deposit                  arities 2 and 3
--     submit_shop_order                       arities 4 and 5
--     use_family_card_for_canteen_auto_reload arities 2 and 3
--
-- In each case the wider form's extra parameter has a DEFAULT, so a caller
-- sending the narrower key set matches both.
--
-- WHAT IT COSTS, CONCRETELY. Three edge functions send exactly five keys to
-- credit_canteen_balance_from_processor and no p_source:
-- cardknox-webhook, charge-saved-card and payments-canteen-checkout. Each one
-- runs AFTER the processor has already taken the parent's money. The charge
-- succeeds, the credit returns PGRST203, and the child's canteen balance does
-- not move. Money taken, nothing credited.
--
-- HOW IT HAPPENED, AND IT WAS THIS CHAIN. Migrations 024, 052, 139 and 145 each
-- dropped a narrow signature deliberately, for exactly this reason. Migration
-- 220 — written to fix "the four overloads 219 missed" — re-created all four of
-- them, with correct row-based bodies, believing the narrow ones were the live
-- ones. They were not; they had been dropped years earlier. So 220 did not
-- convert four missed functions, it resurrected four retired ones, and left every
-- one of them ambiguous against the form that was actually in use.
-- (submit_shop_order's pair is older: 107 revived the 4-argument form that 052
-- had dropped, and it has been ambiguous since.)
--
-- WHY THE TEST DID NOT CATCH IT. tests/camp_scoped_rpc_auth.test.js was written
-- after migration 192 caused precisely this failure, and it checks precisely this
-- rule. It collected every DROP across all migrations into one set and treated a
-- dropped arity as gone for good — so 220's re-creations read as "already
-- dropped" and the pair looked resolved. A create after a drop REVIVES the
-- arity. The test now replays drops and creates in order, and with that one
-- change it reports all four.
--
-- That is the same defect shape as everything else this chain has been unpicking:
-- a guard that looks like a guard and bounds nothing.
--
-- WHICH ONE SURVIVES. The wider form in every case — the one the dropping
-- migration intended to keep, and the one callers actually send to. Every wider
-- form already has a row-based body (219 and 214 converted them), so nothing
-- goes back onto the whole-document lock:
--
--     keep credit_canteen_balance_from_processor(uuid,text,numeric,text,text,text)   -- 145/219
--     keep submit_canteen_deposit(text,numeric,uuid)                                 -- 024/219
--     keep submit_shop_order(text,jsonb,text,text,text)                              -- 052/220
--     keep use_family_card_for_canteen_auto_reload(uuid,text,text)                    -- 139/214
--
-- A caller sending the narrow key set now resolves to the wider form with its
-- default applied, which is what 024, 052, 139 and 145 designed.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, and it
-- only drops functions — no data is touched.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. the survivors must exist before anything is dropped ─────────────────
-- to_regprocedure returns NULL for a signature that is absent rather than
-- erroring, so this is the check that stops this file leaving nothing at all.
DO $$
DECLARE
    keep text[] := ARRAY[
        'public.credit_canteen_balance_from_processor(uuid,text,numeric,text,text,text)',
        'public.submit_canteen_deposit(text,numeric,uuid)',
        'public.submit_shop_order(text,jsonb,text,text,text)',
        'public.use_family_card_for_canteen_auto_reload(uuid,text,text)'
    ];
    sig text;
BEGIN
    FOREACH sig IN ARRAY keep LOOP
        IF to_regprocedure(sig) IS NULL THEN
            RAISE EXCEPTION 'the signature this file means to KEEP does not exist: % — apply '
                            '219 and 220 before this file', sig;
        END IF;
    END LOOP;
END $$;


-- ─── 1. the four narrow forms go ────────────────────────────────────────────
-- By name, so a reviewer can see exactly what is removed and
-- camp_scoped_rpc_auth.test.js can see it too.
DROP FUNCTION IF EXISTS public.credit_canteen_balance_from_processor(
    uuid, text, numeric, text, text);
DROP FUNCTION IF EXISTS public.submit_canteen_deposit(text, numeric);
DROP FUNCTION IF EXISTS public.submit_shop_order(text, jsonb, text, text);
DROP FUNCTION IF EXISTS public.use_family_card_for_canteen_auto_reload(uuid, text);


-- ─── 2. and nothing else in the canteen is ambiguous ────────────────────────
-- The narrow four are what this file knows about. This asks the catalog the
-- other question — is ANY function left with two overloads where the wider one's
-- extra arguments all default — because a list is only as good as the check
-- beside it.
DO $$
DECLARE
    r       record;
    v_bad   text := NULL;
BEGIN
    SELECT string_agg(x.proname || ' (' || x.arities || ')', ', ')
      INTO v_bad
      FROM (
        SELECT p.proname,
               string_agg(DISTINCT p.pronargs::text, ' and ' ORDER BY p.pronargs::text) AS arities,
               count(DISTINCT p.pronargs) AS shapes,
               -- Does any form carry a default? Without one, two arities cannot
               -- both satisfy the same key set.
               bool_or(p.pronargdefaults > 0) AS has_default
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND (p.proname LIKE '%canteen%' OR p.proname LIKE '%shop_order%')
         GROUP BY p.proname
        HAVING count(DISTINCT p.pronargs) > 1 AND bool_or(p.pronargdefaults > 0)
      ) x;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'still ambiguous to PostgREST: %', v_bad;
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- One row per function, and every count must be 1.
SELECT 'migration 228 applied' AS status,
       jsonb_object_agg(p.proname, p.n) AS overloads_each
  FROM (SELECT pr.proname, count(*) AS n
          FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
         WHERE ns.nspname = 'public'
           AND pr.proname IN ('credit_canteen_balance_from_processor',
                              'submit_canteen_deposit',
                              'submit_shop_order',
                              'use_family_card_for_canteen_auto_reload')
         GROUP BY pr.proname) p;
