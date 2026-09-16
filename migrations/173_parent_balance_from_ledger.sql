-- ============================================================================
-- Migration 173: the PARENT's balance comes from the posted ledger too.
--
-- 171 gave the database the ledger arithmetic and said in its own header that
-- get_my_balance would read it. It did not — 171 added the helpers and the
-- conversion but never touched get_my_balance, so until this migration the camp
-- saw a posted balance while the parent still saw a derived one. That gap is
-- exactly the drift this whole sequence exists to remove, and it is the half the
-- parent actually looks at: a family whose child has left would still read $0
-- owed in the portal.
--
-- ── HOW, WITHOUT DUPLICATING 250 LINES ─────────────────────────────────────
-- get_my_balance does a lot more than compute a number: it resolves the invite,
-- decides whether the family is chargeable, and returns the cards, plans and
-- enrollment list the portal renders. Copying all of that into a second
-- definition would guarantee the two drift.
--
-- So 166's function is RENAMED to get_my_balance_derived and a thin wrapper
-- takes its name. The wrapper calls it, then overrides the four money fields
-- from the ledger when every family the invite covers has one. A family that
-- has not been converted yet gets the derived answer, unchanged — so this is
-- safe to apply before running convert_family_ledgers, and a camp converts when
-- it suits.
--
-- ── WHY THE RENAME IS GUARDED ──────────────────────────────────────────────
-- Re-running this file must not rename the WRAPPER to get_my_balance_derived
-- and then create a wrapper that calls itself — that is an infinite recursion
-- that would take the parent portal down. The DO block below refuses to rename
-- anything already carrying the LEDGER_WRAPPER_V173 marker, so the file is
-- idempotent on its own AND inside APPLY_BUNDLE (where 166 recreates the
-- derived version first, correctly making it the rename target again).
--
-- Idempotent.
-- ============================================================================

-- ─── 1. the per-family summary, mirroring BillingCore.summary() ─────────────
CREATE OR REPLACE FUNCTION public.family_ledger_summary(p_fam jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    WITH e AS (
        SELECT x->>'kind' AS kind,
               COALESCE((x->>'amount')::numeric, 0) AS amount
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p_fam->'entries') = 'array'
                      THEN p_fam->'entries' ELSE '[]'::jsonb END) x
    )
    SELECT jsonb_build_object(
        -- `billed` is GROSS charges, and `credits` carries every credit —
        -- discounts, withdrawals, corrections, reversals — because that is the
        -- shape get_my_balance already returns and the portal already renders
        -- (billed − paid − credits). Keeping the shape means no client change.
        'billed',  COALESCE(ROUND(SUM(CASE WHEN kind = 'charge'  THEN amount ELSE 0 END), 2), 0),
        'paid',    COALESCE(ROUND(SUM(CASE WHEN kind = 'payment' THEN amount
                                           WHEN kind = 'refund'  THEN -amount
                                           ELSE 0 END), 2), 0),
        'credits', COALESCE(ROUND(SUM(CASE WHEN kind = 'credit'  THEN amount ELSE 0 END), 2), 0)
    ) FROM e;
$$;
REVOKE ALL ON FUNCTION public.family_ledger_summary(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.family_ledger_summary(jsonb) TO authenticated, service_role;


-- ─── 2. move 166's function aside, once and only once ───────────────────────
DO $rename$
BEGIN
    -- Already wrapped? Then get_my_balance IS the wrapper and must not be
    -- renamed — doing so would make the new wrapper call itself.
    IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_my_balance'
           AND p.prosrc LIKE '%LEDGER_WRAPPER_V173%'
    ) THEN
        RAISE NOTICE '173: get_my_balance is already the ledger wrapper — leaving it alone';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_my_balance'
    ) THEN
        RAISE EXCEPTION '173 needs migration 166 applied first (get_my_balance is missing)';
    END IF;

    -- A stale alias from a previous run of this file; 166 has since recreated
    -- the real derived function, so the old copy is what should go.
    DROP FUNCTION IF EXISTS public.get_my_balance_derived(uuid);
    ALTER FUNCTION public.get_my_balance(uuid) RENAME TO get_my_balance_derived;
END
$rename$;

REVOKE ALL ON FUNCTION public.get_my_balance_derived(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance_derived(uuid) TO authenticated;


-- ─── 3. the wrapper ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- LEDGER_WRAPPER_V173 — the marker the rename guard above looks for. Do not
    -- remove it: without it, re-running 173 renames this function to
    -- get_my_balance_derived and the replacement calls itself forever.
    v_base    jsonb;
    v_me      jsonb;
    v_keys    jsonb;
    v_fam     jsonb;
    v_sum     jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_allHave boolean := true;
    k         text;
BEGIN
    v_base := public.get_my_balance_derived(p_camp_id);
    IF v_base IS NULL OR COALESCE((v_base->>'success')::boolean, false) = false THEN
        RETURN v_base;
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = (v_base->>'camp_id')::uuid AND key = 'campistryMe';
    IF v_me IS NULL THEN RETURN v_base; END IF;

    v_keys := COALESCE(v_base->'familyKeys', '[]'::jsonb);
    IF jsonb_typeof(v_keys) <> 'array' OR jsonb_array_length(v_keys) = 0 THEN
        RETURN v_base;
    END IF;

    FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
        v_fam := v_me #> ARRAY['families', k];
        IF v_fam IS NULL OR NOT public.family_has_ledger(v_fam) THEN
            v_allHave := false;
            EXIT;
        END IF;
        v_sum := public.family_ledger_summary(v_fam);
        v_billed  := v_billed  + COALESCE((v_sum->>'billed')::numeric, 0);
        v_paid    := v_paid    + COALESCE((v_sum->>'paid')::numeric, 0);
        v_credits := v_credits + COALESCE((v_sum->>'credits')::numeric, 0);
    END LOOP;

    -- Not converted yet: hand back the derived answer untouched. Mixing the two
    -- — some families posted, some derived — is the one thing that must not
    -- happen, because the total would be neither.
    IF NOT v_allHave THEN
        RETURN v_base || jsonb_build_object('ledger', false);
    END IF;

    -- Converted. The ledger is the balance. Note this deliberately does NOT
    -- re-add bank deposits: 171's conversion posts them as payment entries, so
    -- counting them here as well would credit a Zelle payment twice.
    RETURN v_base || jsonb_build_object(
        'ledger',  true,
        'billed',  ROUND(v_billed, 2),
        'paid',    ROUND(v_paid, 2),
        'credits', ROUND(v_credits, 2),
        'balance', ROUND(v_billed - v_paid - v_credits, 2)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;


-- ─── Checking it ───────────────────────────────────────────────────────────
-- The whole point, in four statements. Against a throwaway camp:
--
--   -- 1. convert, and note the balance
--   select convert_family_ledgers('<camp>'::uuid, false);
--   select key, family_ledger_balance(value) from jsonb_each(
--       (select value->'families' from camp_state_kv
--         where camp_id='<camp>'::uuid and key='campistryMe'));
--
--   -- 2. as the PARENT (their session), the same number, with ledger:true
--   select get_my_balance('<camp>'::uuid);
--
--   -- 3. now remove their camper in the app.
--
--   -- 4. run 2 again. The balance MUST be unchanged. Before this sequence it
--   --    would have read 0, because the charge was re-derived from an
--   --    enrollment that no longer existed.
--
-- And the guard, which protects the portal from an infinite recursion:
--   select proname from pg_proc where prosrc like '%LEDGER_WRAPPER_V173%';
--   -- must return exactly one row, get_my_balance. Re-running this file must
--   -- still return exactly one row.
-- ============================================================================
