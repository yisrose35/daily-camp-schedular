-- ============================================================================
-- Migration 243: the payment edge functions read canteen accounts from the ROWS.
--
-- THE DEFECT. 219 made camp_canteen_accounts the truth, and campistry_snacks.js
-- strips `accounts` from every campistrySnacks document write. Four edge
-- functions still read campistrySnacks.accounts out of that document:
--
--   canteen-auto-reload    walks snacks.accounts to find who needs a top-up.
--                          After a camp's first save there is nothing to walk,
--                          so the nightly run charges nobody — every parent who
--                          switched auto-reload on is told it is on, and their
--                          child is declined at the register when it runs out.
--
--   payments-charge-nonce  campHasCamper(): "is this name an account in the
--   payments-hosted-link   document?" Against a stripped document the answer is
--   payments-save-method   always no, so a parent's card deposit to the canteen
--                          is REFUSED as an unknown camper, and saving a card for
--                          canteen auto-reload is refused the same way.
--
-- Same shape as 240 and 242: writers moved to rows, readers did not.
--
-- THE FIX, WITHOUT CHANGING A SINGLE SIGNATURE THE EDGE FUNCTIONS CALL. Every
-- canteen writer already resolves a camper's CURRENT NAME to their person and
-- from there to their account (227's canteen_account_key_for) — the name the
-- roster shows today is an exact handle on the person. What the four functions
-- lack is a correct way to FIND that name. So two service-only reads:
--
--   canteen_autoreload_accounts(camp)  every live account with auto-reload on,
--                                      carrying the camper's current name and id
--   canteen_camper_known(camp, name)   is this a real camper or account here?
--
-- The account key is NOT the name to hand on: after a rename it is the OLD
-- spelling, and if a different child now carries that spelling, the key resolves
-- to them. canteen_autoreload_accounts hands on the current label instead, and
-- flags the one case where no name can be trusted.
--
-- HOW TO APPLY. Paste into the SQL Editor. Then redeploy four edge functions
-- (Dashboard → Edge Functions → each one → paste its index.ts → Deploy):
-- canteen-auto-reload, payments-charge-nonce, payments-hosted-link,
-- payments-save-method. Order does not matter: until a function is redeployed it
-- keeps its current (broken) behaviour, and nothing here changes what the old
-- code calls.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
DECLARE missing text := '';
BEGIN
    IF to_regclass('public.camp_canteen_accounts') IS NULL THEN
        missing := missing || ' camp_canteen_accounts'; END IF;
    IF to_regprocedure('public._canteen_account_json(camp_canteen_accounts)') IS NULL THEN
        missing := missing || ' _canteen_account_json'; END IF;
    IF to_regprocedure('public.camp_person_label(uuid,bigint)') IS NULL THEN
        missing := missing || ' camp_person_label(uuid,bigint)'; END IF;
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        missing := missing || ' camp_person_by_name(uuid,text)'; END IF;
    IF missing <> '' THEN
        RAISE EXCEPTION '243 needs:% — apply 219 and 227 first', missing;
    END IF;
END $$;


-- ─── 1. who the nightly run should look at ──────────────────────────────────
-- One row per live account whose autoReload is enabled. camper_name is the
-- name to pass to every canteen writer:
--
--   attributed account   → the person's CURRENT label (resolves to them, and
--                          only them, through canteen_account_key_for)
--   unattributed account → its key, which is the only name it has — UNLESS a
--                          live person now answers to that spelling, in which
--                          case the key would resolve to THEM. `resolvable` is
--                          false and the caller must skip it rather than charge
--                          a card and credit a stranger.
CREATE OR REPLACE FUNCTION public.canteen_autoreload_accounts(p_camp_id uuid DEFAULT NULL)
RETURNS TABLE (
    camp_id     uuid,
    account_key text,
    person_id   bigint,
    camper_name text,
    resolvable  boolean,
    account     jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT a.camp_id,
           a.account_key,
           a.person_id,
           COALESCE(CASE WHEN a.person_id IS NOT NULL
                         THEN public.camp_person_label(a.camp_id, a.person_id) END,
                    a.account_key) AS camper_name,
           CASE WHEN a.person_id IS NOT NULL
                THEN public.camp_person_label(a.camp_id, a.person_id) IS NOT NULL
                ELSE public.camp_person_by_name(a.camp_id, a.account_key) IS NULL
           END AS resolvable,
           public._canteen_account_json(a) AS account
      FROM camp_canteen_accounts a
     WHERE a.deleted_at IS NULL
       AND (p_camp_id IS NULL OR a.camp_id = p_camp_id)
       AND COALESCE((a.payload -> 'autoReload' ->> 'enabled')::boolean, false)
$$;

REVOKE ALL ON FUNCTION public.canteen_autoreload_accounts(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canteen_autoreload_accounts(uuid) TO service_role;


-- ─── 2. is this a camper the canteen can take money for? ────────────────────
-- What campHasCamper() meant: the name is someone on the roster, or an account
-- that exists. A roster camper with no account yet is a yes — their first
-- deposit is what opens it (canteen_account_lock creates it).
CREATE OR REPLACE FUNCTION public.canteen_camper_known(p_camp_id uuid, p_camper_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT p_camp_id IS NOT NULL
       AND COALESCE(btrim(p_camper_name), '') <> ''
       AND (public.camp_person_by_name(p_camp_id, p_camper_name) IS NOT NULL
            OR EXISTS (SELECT 1 FROM camp_canteen_accounts a
                        WHERE a.camp_id = p_camp_id
                          AND a.account_key = p_camper_name
                          AND a.deleted_at IS NULL))
$$;

REVOKE ALL ON FUNCTION public.canteen_camper_known(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canteen_camper_known(uuid, text) TO service_role;


-- ─── 3. the check ───────────────────────────────────────────────────────────
-- Also reports the service-only money functions' grants, because the chain this
-- repo tests against does not contain the migrations that revoked them (079,
-- 132, 145). If any of these is executable by a signed-in user, that user can
-- credit any camper at any camp with a made-up transaction id.
CREATE OR REPLACE FUNCTION public.verify_canteen_rows_for_edge()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'autoreload_reader',  to_regprocedure('public.canteen_autoreload_accounts(uuid)') IS NOT NULL,
        -- By name: 248 adds p_camper_id to its signature.
        'camper_check',       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'canteen_camper_known'),
        'accounts_with_autoreload_on', (SELECT count(*) FROM camp_canteen_accounts
            WHERE deleted_at IS NULL
              AND COALESCE((payload -> 'autoReload' ->> 'enabled')::boolean, false)),
        'service_only_functions_open_to_users', COALESCE((
            SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY 1)
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('credit_canteen_balance_from_processor',
                                 'credit_canteen_balance_from_stripe',
                                 'update_canteen_autoreload_state',
                                 'canteen_autoreload_accounts',
                                 'canteen_camper_known')
               AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    OR has_function_privilege('anon', p.oid, 'EXECUTE'))), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_rows_for_edge() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_rows_for_edge() TO authenticated, service_role;

SELECT public.verify_canteen_rows_for_edge()
       AS "243 check — service_only_functions_open_to_users must be []";
