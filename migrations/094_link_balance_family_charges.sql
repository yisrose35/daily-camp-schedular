-- =============================================================================
-- Migration 094: get_my_balance was missing family-ledger charges/credits
--
-- Root cause of "I added a manual charge in Me → Billing and the parent
-- never sees it": get_my_balance (migration 070) computes `billed` from
-- ONLY campistryMe.enrollments (sessionTuition - discount). Me's own
-- Billing page has never worked that way alone — buildFamilyLedgers()
-- (campistry_me.js) is the real, complete per-family ledger, and it adds
-- TWO more sources on top of enrollment tuition:
--   - campistryMe.families[famKey].charges[]  — "Add Charge" (trip fees,
--     add-ons, late fees, etc. — addChargeForFamily())
--   - campistryMe.families[famKey].credits[]  — "Issue Credit"
--     (issueCreditForFamily())
-- get_my_balance never read families{} at all, so neither ever reached
-- the parent's balance no matter how many times they refreshed — this
-- was a real gap in what the RPC computes, not a caching/redirect issue.
--
-- Matching a family record to the calling parent: families[famKey] has no
-- direct link to link_parent_invites, but it does carry camperIds[] — the
-- same camper full names buildFamilyLedgers() itself matches payments by,
-- and the same shape as link_parent_invites.camper_names. A family record
-- belongs to this parent if any of its camperIds appears in the parent's
-- own camper_names.
--
-- Charges/credits are also folded into the `payments` history array
-- (v_history) so the balance change is visible, not just a number that
-- moved with no explanation — status:'charge' is a NEW value Link's
-- _renderPayHistory needs a badge for (paired frontend fix, same commit).
-- =============================================================================

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
    v_names   jsonb;
    rec       record;
    e         jsonb;
    p         jsonb;
    fam       jsonb;
    ch        jsonb;
    cr        jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_tuition numeric;
    v_disc    numeric;
    v_amt     numeric;
    v_status  text;
    v_family  text;
    v_enrIds  jsonb := '[]'::jsonb;
    v_history jsonb := '[]'::jsonb;
    v_belongs boolean;
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
    enr  := COALESCE(me->'enrollments', '{}'::jsonb);
    fams := COALESCE(me->'families', '{}'::jsonb);
    pays := COALESCE(me->'finance'->'payments', '[]'::jsonb);

    -- Net tuition for the parent's enrolled campers.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_tuition := COALESCE((e->>'sessionTuition')::numeric, 0);
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
        END IF;
    END LOOP;

    -- Manual family-ledger charges and credits (Me → Billing → Add Charge /
    -- Issue Credit) — matched by camperIds overlap, the same key
    -- buildFamilyLedgers() itself uses.
    FOR fam IN SELECT value FROM jsonb_each(fams) LOOP
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;

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

    -- Payments matched to those campers (by family name or enrollmentId).
    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN
                v_paid := v_paid + v_amt;
            END IF;
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

    RETURN jsonb_build_object(
        'success',    true,
        'camp_id',    inv.camp_id,
        'familyName', COALESCE(v_names->>0, inv.parent_name),
        'campers',    v_names,
        'billed',     v_billed,
        'paid',       v_paid,
        'credits',    v_credits,
        'balance',    v_billed - v_paid - v_credits,
        'payments',   v_history
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   1. In Me → Billing, "Add Charge" $25 to a family whose camper has a
--      Link parent invite.
--   2. select get_my_balance('<that camp id>'::uuid) from that parent's
--      own session (or via the app) — balance should be $25 higher, and
--      the payments array should include one entry with status:'charge'.
-- =============================================================================
