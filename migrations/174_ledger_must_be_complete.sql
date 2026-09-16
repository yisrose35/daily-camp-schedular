-- ============================================================================
-- Migration 174: the parent's balance only trusts a COMPLETE ledger.
--
-- THE BUG THIS FIXES, reported from a live camp: a child was registered and
-- given a session with $2,500 tuition. Campistry Me's Billing page showed the
-- $2,500. The parent's portal showed nothing.
--
-- Migration 173 made get_my_balance prefer the posted ledger whenever every
-- family the invite covers HAS one. That test — "has a ledger" — is too weak. A
-- family can have a ledger that is real but BEHIND: it holds last season's
-- charges and payments while a charge posted seconds ago has not reached it yet.
-- 173 then reported the ledger as authoritative and the new tuition simply was
-- not in it.
--
-- Two things caused the gap on the client side (both fixed there too):
--
--   * An ACCEPTED registration has no families[].camperIds entry — enrollCamper
--     is the only thing that creates one — so the exact family matcher found
--     nothing and the tuition was never posted. Billing still displayed it via a
--     fuzzy match and a synthetic 'pending_' ledger, which is exactly why the two
--     screens disagreed.
--   * buildFamilyLedgers is a READ, called by search, analytics, finance and
--     Billing. Posting there without saving left the charge in memory only.
--
-- But fixing those is not enough, and this migration is the reason why: ANY
-- future path that bills a family without posting to the ledger would silently
-- under-report to the parent again. Under-reporting a balance is the worst
-- direction for this to fail in — a parent is told they owe less than they do,
-- pays it, and believes they are settled.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
-- The ledger is authoritative only when it accounts for EVERY BILLABLE
-- ENROLLMENT the caller has. get_my_balance_derived already returns that list
-- (`enrollments`, one row per enrolled/accepted enrollment it billed), so the
-- check is exact rather than a comparison of totals: for each of those
-- enrollment ids there must be a posted tuition charge carrying it in
-- `source.enrollmentId`. One missing charge and the whole answer falls back to
-- the derived figure, which is never short.
--
-- Comparing TOTALS instead would not work, and it is worth saying why: a
-- withdrawal legitimately makes the derived total smaller than the ledger's
-- (the derived drops the tuition, the ledger keeps the charge and adds a
-- credit), so "ledger > derived" is normal and "ledger < derived" is not the
-- only failure. Per-enrollment presence is the only test that means anything.
--
-- Idempotent. Replaces 173's wrapper in place; the rename guard in 173 is
-- untouched and still the thing that keeps get_my_balance_derived intact.
-- ============================================================================

-- Does this family's ledger carry a posted tuition charge for this enrollment?
CREATE OR REPLACE FUNCTION public.family_has_tuition_entry(p_fam jsonb, p_enr_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p_fam->'entries') = 'array'
                      THEN p_fam->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'kind' = 'charge'
           AND e->>'reason' = 'tuition'
           AND e->'source'->>'enrollmentId' = p_enr_id
    );
$$;
REVOKE ALL ON FUNCTION public.family_has_tuition_entry(jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.family_has_tuition_entry(jsonb, text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- LEDGER_WRAPPER_V173 — the marker migration 173's rename guard looks for.
    -- Do not remove it: without it, re-running 173 renames THIS function to
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
    v_complete boolean := true;
    v_missing jsonb := '[]'::jsonb;
    k         text;
    enr       jsonb;
    v_found   boolean;
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

    -- ── completeness ─────────────────────────────────────────────────────
    -- Every enrollment the derived figure billed must have a posted tuition
    -- charge somewhere in these families' ledgers. A charge that exists on the
    -- camp's screen and not in the ledger is what made a parent's balance read
    -- $0 on a $2,500 registration.
    IF v_allHave THEN
        FOR enr IN SELECT * FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(v_base->'enrollments') = 'array'
                            THEN v_base->'enrollments' ELSE '[]'::jsonb END) LOOP
            v_found := false;
            FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
                IF public.family_has_tuition_entry(
                       v_me #> ARRAY['families', k], enr->>'id') THEN
                    v_found := true;
                    EXIT;
                END IF;
            END LOOP;
            IF NOT v_found THEN
                v_complete := false;
                v_missing := v_missing || jsonb_build_array(enr->>'id');
            END IF;
        END LOOP;
    END IF;

    -- Not converted, or converted but behind: hand back the DERIVED answer,
    -- which is never short. `ledger` says which number the caller is looking at
    -- and `ledgerIncomplete` says why, so this is diagnosable from the portal
    -- rather than only from the database.
    IF NOT v_allHave THEN
        RETURN v_base || jsonb_build_object('ledger', false);
    END IF;
    IF NOT v_complete THEN
        RETURN v_base || jsonb_build_object(
            'ledger', false,
            'ledgerIncomplete', true,
            'unpostedEnrollments', v_missing);
    END IF;

    -- Complete. The ledger is the balance. It deliberately does NOT re-add bank
    -- deposits: 171's conversion posts them as payment entries, so counting them
    -- here as well would credit a Zelle payment twice.
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
-- The reported case, end to end. Register a camper on a $2,500 session, then as
-- that parent:
--
--   select get_my_balance('<camp>'::uuid) -> 'balance',
--          get_my_balance('<camp>'::uuid) -> 'ledger',
--          get_my_balance('<camp>'::uuid) -> 'unpostedEnrollments';
--
--   -- BEFORE the charge is posted: balance 2500, ledger false,
--   --   unpostedEnrollments lists the enrollment. The parent sees the right
--   --   number from the derived path, and the gap is visible.
--   -- AFTER Billing has posted it: balance 2500, ledger true, no missing list.
--
-- The number the parent sees must be 2500 in BOTH states. That is the whole
-- point: the fallback exists so the parent is never told they owe less than
-- they do.
-- ============================================================================
