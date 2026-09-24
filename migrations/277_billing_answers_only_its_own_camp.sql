-- ============================================================================
-- Migration 277: a camp's billing answers only that camp's own office.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Nothing to redeploy: the page and the edge functions call
-- the same functions as before.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
-- Anyone with a Campistry login — a parent from Link, anyone who signed up —
-- could read and change ANY camp's billing, given that camp's id:
--
--   * get_camp_families / get_camp_payments (every family, every payment) and
--     sync_camp_billing (the page's Billing save: add, change or delete
--     families and payments) asked only the access-section resolver. That
--     resolver answers "edit" for a caller who is not in the camp at all — on
--     purpose, because every RLS policy that uses it also checks the camp
--     (migration 160's note). These three functions did not.
--   * append_camp_payment (add a payment, posted to the family's ledger),
--     record_autopay_installment (mark an instalment paid, with a payment),
--     sync_family_ledger_payments (post payments; its report lists families
--     and amounts) and parent_billing_slice (a family's billing, by camper
--     names the CALLER supplies) could be called by any signed-in user with
--     no check at all. Only the server ever calls them: the payment webhooks,
--     the nightly autopay run, get_my_balance.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
--   1. The three office functions also require a member of THAT camp — its
--      owner or an accepted staff member (camp_staff_member, 183) — before
--      the section check. A NULL from the resolver is "no", never "yes".
--   2. The four server-only functions can no longer be called from a browser.
--      The server (service role) and the functions that call them are
--      unaffected.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.camp_staff_member(uuid)') IS NULL THEN
        RAISE EXCEPTION '277 needs camp_staff_member (migration 183) — apply it first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';

-- 1. the office's own billing functions: a member of this camp first
DO $$
DECLARE
    f     text;
    d     text;
    o     text;
    n     text;
    fixes text[][] := ARRAY[
        ARRAY['public.sync_camp_billing(uuid,jsonb,jsonb,jsonb,jsonb)',
              $o$IF public.user_section_level(p_camp_id, 'me.billing') <> 'edit' THEN$o$,
              $n$IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN$n$],
        ARRAY['public.get_camp_payments(uuid)',
              $o$IF public.user_section_level(p_camp_id, 'me.billing') = 'none' THEN$o$,
              $n$IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') = 'none' THEN$n$],
        ARRAY['public.get_camp_families(uuid)',
              $o$IF public.user_section_level(p_camp_id, 'me.billing') = 'none' THEN$o$,
              $n$IF NOT public.camp_staff_member(p_camp_id)
       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') = 'none' THEN$n$]];
    i int;
BEGIN
    FOR i IN 1 .. array_length(fixes, 1) LOOP
        f := fixes[i][1]; o := fixes[i][2]; n := fixes[i][3];
        IF to_regprocedure(f) IS NULL THEN
            RAISE NOTICE '277: % is not on this database — skipped', f;
            CONTINUE;
        END IF;
        d := pg_get_functiondef(to_regprocedure(f));
        IF position('camp_staff_member(p_camp_id)' IN d) > 0 THEN
            RAISE NOTICE '277: % already checks the camp', f;
            CONTINUE;
        END IF;
        IF position(o IN d) = 0 THEN
            RAISE EXCEPTION '277: % does not look the way this file expects — send this message to the builder', f;
        END IF;
        EXECUTE replace(d, o, n);
    END LOOP;
END $$;

-- 2. the server's own writers and readers: not for browsers
DO $$
DECLARE
    f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.append_camp_payment(uuid,jsonb,text,jsonb)',
        'public.record_autopay_installment(uuid,text,text,integer,text,jsonb,jsonb,text)',
        'public.sync_family_ledger_payments(uuid,text,boolean)',
        'public.parent_billing_slice(uuid,jsonb,jsonb)'] LOOP
        IF to_regprocedure(f) IS NULL THEN CONTINUE; END IF;
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END LOOP;
END $$;
