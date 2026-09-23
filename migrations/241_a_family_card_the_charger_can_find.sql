-- ============================================================================
-- Migration 241: a family card attached for auto-reload is a card the charger
-- can find.
--
-- ⚠ APPLY AFTER 239 and 240.
--
-- THE DEFECT, AND IT IS MINE. Migration 234 moved
-- use_family_card_for_canteen_auto_reload onto camp_family_key_for_person — which
-- was the right change, and it was supposed to change only HOW THE FAMILY IS
-- FOUND. It also replaced everything after that: the card selection, the write to
-- the camper's account, and the return value.
--
-- What it wrote instead of 231's token fields was
--
--     'paymentMethodId', v_picked->>'id',
--     'last4', …, 'brand', …, 'source', 'family'
--
-- and supabase/functions/canteen-auto-reload does not read any of that. Its own
-- line is
--
--     if (!ar.stripeCustomerId && !ar.byopCustomerRef) continue;
--         // enabled but no card saved through either flow yet
--
-- so from 234 onwards a parent attached their family card, the call answered
-- success, the screen said the card was on file — and the nightly run skipped that
-- camper for want of a card. The camper's balance runs out and nothing reloads it.
--
-- 231's header names this exact failure as the thing it was written to fix: "the
-- card was written where no reader looks, so auto-reload has never found a card on
-- file for anyone who attached one this way." 234 put it back.
--
-- AND A SECOND ONE BESIDE IT. 234 refuses with no_saved_card whenever
-- savedPaymentMethods is absent. A family whose card sits in the LEGACY
-- single-slot fields (byopCustomerRef, or stripeCustomerId with cardOnFile) has no
-- array entry to pick, and 138's behaviour — which 231 kept deliberately — reads
-- those fields directly. Those families could not attach a card at all.
--
-- HOW IT WAS FOUND. scripts/pgtests/231 still asserts both, and nobody had run it
-- against a chain that included 234. tests/e2e/db.js applies 167-240 in one server,
-- so running the pgtests against that chain is now a thing one can do — and 231's
-- was the file that said no.
--
-- WHAT THIS FILE DOES. Re-creates the function with 234's family lookup (all three
-- ways, unchanged) and 231's card handling restored verbatim: pick the named method
-- or the family's current default, write the token the charger reads, clear the
-- OTHER processor's stale token so a camper never holds two, stamp cardSavedDate,
-- and reset the failure counters that stop a dead card being retried forever.
--
-- WHAT IT DOES NOT DO. It does not go looking for parents who attached a card
-- between 234 and now and have been silently un-reloaded. Re-attaching is one
-- click and the function is idempotent; a backfill guessing at which autoReload
-- blocks were written by 234 would be a guess about money.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, touches no
-- data — one CREATE OR REPLACE, the grants it already had, and a check.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $preflight$
BEGIN
    IF to_regprocedure('public.use_family_card_for_canteen_auto_reload(uuid,text,text,bigint)') IS NULL THEN
        RAISE EXCEPTION '241 replaces use_family_card_for_canteen_auto_reload — apply 231 and 234 first';
    END IF;
    IF to_regprocedure('public.camp_family_key_for_person(uuid,bigint,text)') IS NULL THEN
        RAISE EXCEPTION '241 keeps 234''s family lookup — apply 234 first';
    END IF;
END $preflight$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the function ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id            uuid,
    p_camper_name        text,
    p_payment_method_id  text DEFAULT NULL,
    p_camper_id          bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_id     bigint;
    v_name   text;
    v_famKey text;
    v_fam    jsonb;
    v_pm     jsonb;
    v_picked jsonb := NULL;
    v_acct   jsonb;
    -- Restored with the card selection below: 234 dropped these and wrote a
    -- paymentMethodId the charger does not read.
    v_ar             jsonb;
    v_processorKey   text;
    v_cardLabel      text;
    v_token          text;
    v_stripeCustomerId text;
    now_ts           timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
      FROM link_parent_invites
     WHERE user_id = caller AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (p_camp_id IS NULL OR camp_id = p_camp_id)
     ORDER BY created_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The shared gate decides whose child this is; this function never asks the
    -- camper question itself.
    v_id := COALESCE(p_camper_id, public.camp_person_by_name(inv.camp_id, p_camper_name));
    IF v_id IS NOT NULL THEN
        IF NOT public._invite_covers_person(inv.id, v_id) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
    ELSIF NOT public._invite_covers_camper(inv.id, p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    v_name := COALESCE(public.camp_person_label(inv.camp_id, v_id), p_camper_name);

    -- 233: two of 231's three comparisons, in one place.
    v_famKey := public.camp_family_key_for_person(inv.camp_id, v_id, v_name);

    -- The third. An invite and a family snapshot are produced by the same office
    -- sync from the same roster keys, so they are the same vintage: when
    -- camperIds holds a spelling the roster has since dropped, the invite holds
    -- it too, and 223 stamped that slot with the id. Nothing else can bridge
    -- that, which is why it is still here and why it is last.
    IF v_famKey IS NULL AND v_id IS NOT NULL
       AND jsonb_typeof(inv.camper_names) = 'array' THEN
        SELECT f.family_key INTO v_famKey
          FROM public.camp_families f
         WHERE f.camp_id = inv.camp_id AND f.deleted_at IS NULL
           AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(f.camper_ids) AS ci
                 CROSS JOIN LATERAL jsonb_array_elements(inv.camper_names)
                            WITH ORDINALITY AS e(value, ord)
                WHERE e.value #>> '{}' = ci
                  AND COALESCE(inv.person_ids -> (e.ord - 1)::int, 'null'::jsonb)
                      = to_jsonb(v_id))
         ORDER BY f.family_key
         LIMIT 1;
    END IF;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    SELECT f.payload INTO v_fam
      FROM public.camp_families f
     WHERE f.camp_id = inv.camp_id AND f.family_key = v_famKey;

    -- ── THE CARD, RESTORED FROM 231 ────────────────────────────────────────
    -- 234 replaced everything from here to the RETURN with a much thinner write:
    --
    --     'paymentMethodId', v_picked->>'id', 'last4', …, 'brand', …, 'source','family'
    --
    -- and a refusal of no_saved_card whenever savedPaymentMethods was absent. Both
    -- halves of that were wrong.
    --
    --   * THE CHARGER DOES NOT READ paymentMethodId. canteen-auto-reload skips a
    --     camper on `if (!ar.stripeCustomerId && !ar.byopCustomerRef) continue`, so
    --     after 234 a parent attached their family card, the call answered success,
    --     and the nightly run found no card on file and moved on. That is the exact
    --     defect 231 was written to fix — "the card was written where no reader
    --     looks" — put back by the file that was only supposed to change how the
    --     FAMILY is found.
    --   * A family whose card is in the LEGACY single-slot fields has no
    --     savedPaymentMethods entry to pick. 138's behaviour, which 231 kept, reads
    --     byopCustomerRef / stripeCustomerId directly; 234 answered no_saved_card.
    --
    -- So this is 231's block verbatim: it picks the named method or the family's
    -- current default, writes the token the charger actually reads, CLEARS the other
    -- processor's stale token (or a camper ends up with two), stamps cardSavedDate,
    -- and resets the failure counters that stopped the last card being retried.
    IF p_payment_method_id IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            IF v_pm->>'id' = p_payment_method_id THEN v_picked := v_pm; EXIT; END IF;
        END LOOP;
        IF v_picked IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'method_not_found');
        END IF;
        v_processorKey := v_picked->>'processor';
        v_cardLabel := v_picked->>'label';
        v_token := v_picked->>'token';
        v_stripeCustomerId := v_picked->>'stripeCustomerId';
    ELSE
        -- Original migration 138 behavior — the family's current default.
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
            v_token := v_fam->>'byopCustomerRef';
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_processorKey := 'stripe';
            v_token := v_fam->>'stripePaymentMethodId';
            v_stripeCustomerId := v_fam->>'stripeCustomerId';
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'no_card_on_file');
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
    END IF;

    -- THE SECOND DEFECT IN THIS FUNCTION, and the one with teeth. 219 moved the
    -- canteen off the campistrySnacks document onto camp_canteen_accounts rows,
    -- and converted the TWO-argument version of this function. The
    -- three-argument version from 214 — the one that is actually live — was
    -- never converted. It has been reading and writing the document ever since,
    -- and since 219 nothing reads that document: the card was written where no
    -- reader looks, so auto-reload has never found a card on file for anyone who
    -- attached one this way. It also took a camp-wide lock on campistrySnacks,
    -- which is the contention 219 existed to remove.
    v_acct := COALESCE(public.canteen_account_lock(inv.camp_id, v_name),
                       '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    IF jsonb_typeof(v_acct) <> 'object' OR v_acct = '{}'::jsonb THEN
        v_acct := '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb;
    END IF;
    v_ar   := COALESCE(v_acct->'autoReload', '{}'::jsonb);

    IF v_processorKey = 'cardknox' THEN
        v_ar := (v_ar - 'stripeCustomerId') - 'stripePaymentMethodId';
        v_ar := v_ar || jsonb_build_object(
            'byopProcessor', v_processorKey,
            'byopCustomerRef', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    ELSE
        v_ar := (v_ar - 'byopCustomerRef') - 'byopProcessor';
        v_ar := v_ar || jsonb_build_object(
            'stripeCustomerId', v_stripeCustomerId,
            'stripePaymentMethodId', v_token,
            'cardOnFile', true,
            'paymentMethodType', 'card'
        );
    END IF;
    IF v_cardLabel IS NOT NULL THEN
        v_ar := jsonb_set(v_ar, '{paymentMethodLabel}', to_jsonb(v_cardLabel), true);
    END IF;
    v_ar := jsonb_set(v_ar, '{cardSavedDate}', to_jsonb(now_ts), true);
    v_ar := (v_ar - 'lastFailureDate') - 'lastFailureReason';
    v_ar := jsonb_set(v_ar, '{consecutiveFailures}', '0'::jsonb, true);

    v_acct   := jsonb_set(v_acct, '{autoReload}', v_ar, true);
    PERFORM public.canteen_account_save(inv.camp_id, v_name, v_acct);

    RETURN jsonb_build_object(
        'success', true,
        'processorKey', v_processorKey,
        'cardLabel', v_cardLabel,
        'autoReload', v_ar
    );
END;
$$;

REVOKE ALL ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    TO authenticated;


-- ─── 2. did it take ─────────────────────────────────────────────────────────
-- The two halves, each named by what the charger needs. Read through
-- _prosrc_code (239) so the prose above, which quotes the fields 234 wrote, is not
-- mistaken for the code.
DO $check$
DECLARE v_src text;
BEGIN
    v_src := public._prosrc_code('use_family_card_for_canteen_auto_reload');
    IF v_src IS NULL THEN
        RAISE EXCEPTION '241 did not take: the function is gone';
    END IF;
    IF v_src !~ 'byopCustomerRef' OR v_src !~ 'stripeCustomerId' THEN
        RAISE EXCEPTION '241 did not take: the function does not write the token '
                        'canteen-auto-reload reads';
    END IF;
    IF v_src !~ 'camp_family_key_for_person' THEN
        RAISE EXCEPTION '241 did not take: 234''s family lookup was lost';
    END IF;
    IF v_src !~ 'consecutiveFailures' THEN
        RAISE EXCEPTION '241 did not take: attaching a new card does not clear the '
                        'failure counter, so a camper whose old card died stays dead';
    END IF;
END $check$;


-- ─── 3. the verifier ────────────────────────────────────────────────────────
-- Per camp: how many campers have auto-reload ON with a card the charger can
-- actually use, and how many have one it cannot. The second number is what 234
-- produced, and it is the one to look at after applying this.
CREATE OR REPLACE FUNCTION public.verify_family_card_autoreload(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
    SELECT jsonb_build_object(
        'writes_a_usable_token',
            COALESCE(public._prosrc_code('use_family_card_for_canteen_auto_reload')
                     ~ 'byopCustomerRef', false),

        'autoreload_on', (SELECT count(*) FROM camp_canteen_accounts
                           WHERE camp_id = p_camp_id AND deleted_at IS NULL
                             AND COALESCE((payload -> 'autoReload' ->> 'enabled')::boolean, false)),

        -- What canteen-auto-reload's own test is, in SQL.
        'autoreload_on_with_a_card', (SELECT count(*) FROM camp_canteen_accounts
                           WHERE camp_id = p_camp_id AND deleted_at IS NULL
                             AND COALESCE((payload -> 'autoReload' ->> 'enabled')::boolean, false)
                             AND (COALESCE(payload -> 'autoReload' ->> 'byopCustomerRef', '') <> ''
                               OR COALESCE(payload -> 'autoReload' ->> 'stripeCustomerId', '') <> '')),

        -- The 234 shape: a paymentMethodId and no token. Every one of these is a
        -- camper whose parent believes a card is attached and whose account will
        -- never reload.
        'autoreload_on_with_only_a_method_id', (SELECT count(*) FROM camp_canteen_accounts
                           WHERE camp_id = p_camp_id AND deleted_at IS NULL
                             AND COALESCE((payload -> 'autoReload' ->> 'enabled')::boolean, false)
                             AND COALESCE(payload -> 'autoReload' ->> 'paymentMethodId', '') <> ''
                             AND COALESCE(payload -> 'autoReload' ->> 'byopCustomerRef', '') = ''
                             AND COALESCE(payload -> 'autoReload' ->> 'stripeCustomerId', '') = '')
    )
$fn$;

REVOKE ALL ON FUNCTION public.verify_family_card_autoreload(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_family_card_autoreload(uuid) TO authenticated, service_role;
