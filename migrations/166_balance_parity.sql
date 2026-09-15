-- ============================================================================
-- Migration 166: make the parent's balance agree with the camp's.
--
-- There are two independent implementations of "what does this family owe":
--     get_my_balance()      — SQL, what the PARENT sees in Campistry Link
--     buildFamilyLedgers()  — JS in campistry_me.js, what the CAMP sees in Billing
--
-- They must produce the same number. Three places they did not. All three are
-- the same class of failure: money that one side counts and the other does not.
--
-- ── 1. ZELLE AND ACH DEPOSITS WERE INVISIBLE TO PARENTS ────────────────────
-- The headline bug, and it was a known one: migration 145 left this note above
-- get_camp_deposit_credits —
--
--     "NOTE for whoever wires the parent-facing side: get_my_balance still
--      reads only the kv blob, so a parent's own balance in Campistry Link
--      will not reflect an auto-posted deposit until that function adds the
--      same union."
--
-- It never got wired. Bank deposits deliberately live in `bank_deposits`
-- rather than in the campistryMe blob (145's header explains why: the blob has
-- one writer and a webhook appending to it would be clobbered by any stale
-- tab). buildFamilyLedgers unions them in at read time — get_my_balance did
-- not. So a family that paid its tuition by Zelle was settled on the camp's
-- screen and still owing on the parent's, forever, with no way for either side
-- to see why they disagreed.
--
-- This adds the same union, with the same rules: only `posted` rows, only rows
-- with a family_key, amount_cents/100, and is_reversal flipping the sign so a
-- returned/NSF deposit debits rather than credits.
--
-- ── 2. A PARENT WITH TWO FAMILY RECORDS SAW ONLY ONE ───────────────────────
-- Migration 152 fixed a real bug — charges were summed from EVERY family
-- record holding one of the parent's campers while only the first was returned
-- as familyKey, so the balance belonged to neither — by restricting everything
-- to the first family. That made the number self-consistent, but it means a
-- household genuinely split across two family records now has half its charges
-- missing from the parent's balance. Under-billing rather than over-billing,
-- but still the wrong number.
--
-- The correct answer for a parent portal showing ONE balance is the sum across
-- every family they belong to. So: collect all their family keys, sum charges
-- and credits across all of them, and match payments and deposits against any
-- of them. The primary family is still reported for the things that are
-- genuinely per-family — card on file, payment plans — because those cannot be
-- summed.
--
-- ── 3. A DISCOUNT LARGER THAN TUITION WENT NEGATIVE ────────────────────────
-- campistry_me.js caps it: `if(discAmt>tuition) discAmt=tuition;` — never
-- discount past free. get_my_balance had no cap, so a flat discount bigger
-- than the session price produced a negative charge on the parent's side and a
-- zero on the camp's. Capped here to match.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ───────────────────────────────────────
-- Canteen money. A canteen top-up is a separate wallet (campistrySnacks), and
-- no canteen path writes finance.payments — verified across
-- payments-canteen-checkout, canteen-auto-reload and
-- stripe-canteen-autoreload-setup. Tuition and canteen must not net against
-- each other, and they do not.
--
-- Idempotent. Requires 145 (bank_deposits) and 152.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    me        jsonb;
    enr       jsonb;
    fams      jsonb;
    pays      jsonb;
    sess_list jsonb;
    v_names   jsonb;
    rec       record;
    famRec    record;
    depRec    record;
    e         jsonb;
    p         jsonb;
    fam       jsonb;
    ch        jsonb;
    cr        jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_tuition numeric;
    v_liveT   numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
    v_belongs boolean;
    v_famKey  text := NULL;          -- the PRIMARY family (card on file, plans)
    v_famKeys text[] := ARRAY[]::text[];   -- EVERY family this parent belongs to
    v_famNames text[] := ARRAY[]::text[];
    v_famName text := '';
    v_fam     jsonb := NULL;
    v_myEnr   jsonb := '[]'::jsonb;
    v_plans   jsonb;
    v_chargeable  boolean := false;
    v_processorKey text := NULL;
    v_cardLabel   text := NULL;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    IF me IS NULL THEN me := '{}'::jsonb; END IF;
    enr       := COALESCE(me->'enrollments', '{}'::jsonb);
    fams      := COALESCE(me->'families', '{}'::jsonb);
    pays      := COALESCE(me->'finance'->'payments', '[]'::jsonb);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);

    -- ─── tuition ───────────────────────────────────────────────────────────
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_liveT := (SELECT (s->>'tuition')::numeric
                          FROM jsonb_array_elements(sess_list) s
                         WHERE s->>'name' = e->>'session'
                         LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            -- Never discount past free. campistry_me.js caps this; without the
            -- same cap here a flat discount bigger than the session price makes
            -- the parent's charge NEGATIVE while the camp's reads zero.
            IF v_disc > v_tuition THEN v_disc := v_tuition; END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
            v_myEnr := v_myEnr || jsonb_build_object(
                'id', rec.key, 'camperName', e->>'camperName',
                'session', e->>'session', 'net', v_tuition - v_disc
            );
        END IF;
    END LOOP;

    -- ─── which families are this parent's ──────────────────────────────────
    -- ALL of them, not just the first. A household split across two family
    -- records owes the sum of both; reporting one and hiding the other is how
    -- a parent ends up under-billed with no way to tell.
    FOR famRec IN SELECT key, value FROM jsonb_each(fams) ORDER BY key LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;

        v_famKeys := v_famKeys || famRec.key;
        IF COALESCE(fam->>'name', '') <> '' THEN
            v_famNames := v_famNames || (fam->>'name');
        END IF;

        -- The PRIMARY family is the first one, and is what card-on-file and
        -- payment plans are read from — those are per-family and cannot be
        -- summed. The BALANCE is the sum across all of them.
        IF v_famKey IS NULL THEN
            v_famKey  := famRec.key;
            v_fam     := fam;
            v_famName := COALESCE(fam->>'name', '');
        END IF;

        FOR ch IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) LOOP
            v_amt := COALESCE((ch->>'amount')::numeric, 0);
            v_billed := v_billed + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(ch->>'date', ''),
                'desc',   COALESCE(NULLIF(ch->>'description', ''), COALESCE(ch->>'category', 'Charge')),
                'amt',    v_amt,
                'status', 'charge'
            );
        END LOOP;

        FOR cr IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) LOOP
            v_amt := COALESCE((cr->>'amount')::numeric, 0);
            v_credits := v_credits + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(cr->>'date', ''),
                'desc',   COALESCE(NULLIF(cr->>'reason', ''), 'Credit'),
                'amt',    v_amt,
                'status', 'credit'
            );
        END LOOP;
    END LOOP;

    -- ─── payments from the blob ────────────────────────────────────────────
    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        -- Match on the stored familyKey first (authoritative — every payment
        -- written by the app carries one), then any of this parent's family
        -- names, keeping the camper-name and enrollmentId paths for autopay and
        -- for older rows that carry neither.
        IF (v_names ? v_family)
           OR (v_enrIds ? COALESCE(p->>'enrollmentId', ''))
           OR (COALESCE(p->>'familyKey', '') <> '' AND COALESCE(p->>'familyKey', '') = ANY (v_famKeys))
           OR (v_family <> '' AND v_family = ANY (v_famNames))
        THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            -- Same exclusion as buildFamilyLedgers' _notCollected.
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(p->>'date', ''),
                'desc',   COALESCE(NULLIF(p->>'notes', ''), COALESCE(p->>'method', 'Payment')),
                'amt',    v_amt,
                'status', CASE WHEN v_amt < 0 THEN 'refunded'
                               WHEN v_status = 'pending' THEN 'pending'
                               WHEN v_status = 'failed' THEN 'failed'
                               ELSE 'paid' END
            );
        END IF;
    END LOOP;

    -- ─── Zelle / ACH deposits ──────────────────────────────────────────────
    -- The union migration 145 asked for. Read straight from bank_deposits
    -- rather than through get_camp_deposit_credits, which is admin-gated —
    -- this function is SECURITY DEFINER and scopes to the caller's own family
    -- keys, so a parent can only ever see deposits posted to their own family.
    --
    -- Rules copied exactly from get_camp_deposit_credits so the two sides
    -- cannot drift: posted only, family_key required, cents to dollars, and
    -- is_reversal flips the sign — a returned/NSF deposit has to DEBIT, or a
    -- family whose ACH bounced reads as paid.
    IF array_length(v_famKeys, 1) > 0 THEN
        FOR depRec IN
            SELECT id, family_key, amount_cents, is_reversal, deposit_date,
                   kind, payer_name, memo_code, trace_id
              FROM bank_deposits
             WHERE camp_id = inv.camp_id
               AND status = 'posted'
               AND family_key IS NOT NULL
               AND family_key = ANY (v_famKeys)
             ORDER BY deposit_date DESC NULLS LAST
        LOOP
            v_amt := (CASE WHEN depRec.is_reversal THEN -1 ELSE 1 END)
                     * ROUND(depRec.amount_cents::numeric / 100, 2);
            v_paid := v_paid + v_amt;
            v_history := v_history || jsonb_build_object(
                'date',   COALESCE(depRec.deposit_date::text, ''),
                'desc',   CASE
                            WHEN depRec.is_reversal AND depRec.payer_name <> ''
                                 THEN 'Returned / NSF — ' || depRec.payer_name
                            WHEN depRec.is_reversal THEN 'Returned / NSF'
                            WHEN depRec.payer_name <> '' AND depRec.memo_code <> ''
                                 THEN 'Received from ' || depRec.payer_name
                                      || ' (memo ' || depRec.memo_code || ')'
                            WHEN depRec.payer_name <> ''
                                 THEN 'Received from ' || depRec.payer_name
                            ELSE 'Bank deposit' END,
                'amt',    v_amt,
                'status', CASE WHEN depRec.is_reversal THEN 'refunded' ELSE 'paid' END
            );
        END LOOP;
    END IF;

    -- ─── per-family extras (not summable) ──────────────────────────────────
    IF v_fam IS NOT NULL AND v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF v_fam IS NOT NULL AND v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_plans := jsonb_build_array((v_fam->'plan') || jsonb_build_object('enrollmentIds', NULL));
    ELSE
        v_plans := '[]'::jsonb;
    END IF;

    -- Same shape as campistry_me.js's _famChargeable(f): a real vaulted BYOP
    -- token always wins; otherwise a Stripe customer + the cardOnFile flag.
    -- Only ever tells the client YES/NO + which processor — never returns
    -- the token/customer id itself.
    IF v_fam IS NOT NULL THEN
        IF v_fam->>'byopCustomerRef' IS NOT NULL AND v_fam->>'byopCustomerRef' <> '' THEN
            v_chargeable := true;
            v_processorKey := COALESCE(v_fam->>'byopProcessor', 'cardknox');
        ELSIF v_fam->>'stripeCustomerId' IS NOT NULL AND v_fam->>'stripeCustomerId' <> ''
              AND COALESCE((v_fam->>'cardOnFile')::boolean, false) THEN
            v_chargeable := true;
            v_processorKey := 'stripe';
        END IF;
        v_cardLabel := v_fam->>'paymentMethodLabel';
    END IF;

    RETURN jsonb_build_object(
        'success',            true,
        'camp_id',            inv.camp_id,
        'familyName',         COALESCE(v_names->>0, inv.parent_name),
        'campers',            v_names,
        'billed',             v_billed,
        'paid',               v_paid,
        'credits',            v_credits,
        'balance',            v_billed - v_paid - v_credits,
        'payments',           v_history,
        'familyKey',          v_famKey,
        -- Every family this balance covers, so the portal can say so when
        -- there is more than one rather than looking like it lost a record.
        'familyKeys',         to_jsonb(v_famKeys),
        'cardOnFile',         COALESCE(v_fam->'cardOnFile', 'false'::jsonb)::boolean,
        'paymentMethodType',  v_fam->>'paymentMethodType',
        'paymentMethodLabel', v_fam->>'paymentMethodLabel',
        'plans',              v_plans,
        'enrollments',        v_myEnr,
        'allowParentPaymentPlans', COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false),
        'chargeable',         v_chargeable,
        'processorKey',       v_processorKey,
        'cardLabel',          v_cardLabel
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── Verifying this on a live camp ─────────────────────────────────────────
-- The point of the whole migration is that these two agree. For a family that
-- paid by Zelle:
--
--   -- what the camp sees (Billing): charges - payments - credits
--   select family_key, sum(amount_cents)/100.0 as zelle_posted
--     from bank_deposits
--    where camp_id = '<camp>'::uuid and status = 'posted' and not is_reversal
--    group by family_key;
--
--   -- what the parent now sees: sign in as that parent and call
--   select get_my_balance('<camp>'::uuid) -> 'paid';
--   -- the Zelle total above must be included in it
--
-- A returned deposit must DEBIT:
--   select get_my_balance('<camp>'::uuid) -> 'paid';   -- before
--   update bank_deposits set is_reversal = true where id = '<dep>';
--   select get_my_balance('<camp>'::uuid) -> 'paid';   -- lower by 2x the amount
--                                                      -- (the credit is gone
--                                                      --  AND a debit added)
--   -- ^ which is why a reversal is posted as its OWN row by the inbox, not by
--   --   flipping the original. Flipping an existing row double-counts.
-- ============================================================================
