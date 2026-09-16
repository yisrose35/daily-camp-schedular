-- ============================================================================
-- Migration 171: the family balance becomes a posted ledger, server-side too.
--
-- THE DEFECT THIS CLOSES. get_my_balance worked out what a family owed by
-- RE-DERIVING it: loop the enrollments, add tuition for the ones currently
-- marked 'enrolled' or 'accepted', subtract the payments. So a debt was a
-- CALCULATION, not a FACT — and a calculation stops being true when one of its
-- inputs disappears. Take the camper out of camp and the enrollment that
-- justified the charge is gone, so the charge is gone, so the debt is gone. The
-- camp is still owed the money and nothing says so. (TEST_FINDINGS.md D0 and the
-- delete case.)
--
-- campistry_billing_core.js now models the family account the way every general
-- ledger does: an append-only list of entries, never mutated, never deleted,
-- where
--
--     balance = Σ charges + Σ refunds − Σ credits − Σ payments
--
-- A withdrawal posts a CREDIT; the tuition charge stays on the record for ever.
-- This migration teaches the database the same arithmetic, because the parent's
-- number and the camp's number are two independent implementations and the only
-- thing keeping them honest is that they compute the same thing.
--
-- ── SCOPE: THIS FILE IS THE ARITHMETIC AND THE CONVERSION, NOT THE READERS ──
-- It adds family_ledger_balance, the conversion and the under-collection report.
-- It deliberately does NOT redefine get_my_balance — migration 173 does that,
-- by renaming 166's version aside and wrapping it. Applying 171 alone leaves the
-- parent portal on the derived number, which is why the two belong in the same
-- bundle and 173 must follow this file.
--
-- Both readers are TRANSITIONAL on purpose: they use the ledger when the family
-- has one and fall back to the derived path when it does not, so a camp can be
-- converted whenever it suits rather than at the instant the SQL lands. Once
-- convert_family_ledgers has run everywhere the fallback is dead code.
--
-- Idempotent.
-- ============================================================================

-- ─── 1. the balance, from the ledger ────────────────────────────────────────
-- A direct transliteration of BillingCore.balance(). Kept as its own function
-- so the report, the conversion and get_my_balance cannot drift from each
-- other — there is exactly one place that knows the signs.
CREATE OR REPLACE FUNCTION public.family_ledger_balance(p_fam jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(ROUND(SUM(
        CASE e->>'kind'
            WHEN 'charge'  THEN  COALESCE((e->>'amount')::numeric, 0)
            WHEN 'refund'  THEN  COALESCE((e->>'amount')::numeric, 0)
            WHEN 'credit'  THEN -COALESCE((e->>'amount')::numeric, 0)
            WHEN 'payment' THEN -COALESCE((e->>'amount')::numeric, 0)
            ELSE 0
        END
    ), 2), 0)
    FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_fam->'entries') = 'array'
             THEN p_fam->'entries' ELSE '[]'::jsonb END
    ) e;
$$;
REVOKE ALL ON FUNCTION public.family_ledger_balance(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.family_ledger_balance(jsonb) TO authenticated, service_role;

-- Does this family have a ledger at all? One place, so "converted?" means the
-- same thing everywhere.
CREATE OR REPLACE FUNCTION public.family_has_ledger(p_fam jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_typeof(p_fam->'entries') = 'array'
       AND jsonb_array_length(p_fam->'entries') > 0;
$$;
REVOKE ALL ON FUNCTION public.family_has_ledger(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.family_has_ledger(jsonb) TO authenticated, service_role;


-- ─── 2. converting a camp ───────────────────────────────────────────────────
-- Builds a ledger for every family that has none, from what is already true:
--
--   tuition   one charge per enrolled/accepted enrollment, plus a separate
--             credit for its discount (so gross and given-away stay apart)
--   charges   f.charges[]  -> charge entries
--   credits   f.credits[]  -> credit entries
--   payments  finance.payments[] matched to the family by familyKey
--   deposits  bank_deposits, which live outside the blob (migration 145)
--
-- WHY IT DOES NOT READ PLAN STATUSES. Existing plans carry instalment `status`
-- fields that D1 is known to have corrupted — instalments marked 'paid' that
-- were never charged. The payment ledger is append-only and trustworthy; the
-- plan's statuses are not. So the money side is rebuilt from payments only, and
-- any instalment that was wrongly marked paid simply shows up as the
-- outstanding balance it always really was.
--
-- p_dry_run defaults TRUE. Run it that way first and read what it says; it
-- reports the balance it would produce per family WITHOUT writing anything.
CREATE OR REPLACE FUNCTION public.convert_family_ledgers(
    p_camp_id uuid,
    p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    now_ts     timestamptz := now();
    v_me       jsonb;
    v_fams     jsonb;
    v_enr      jsonb;
    v_sess     jsonb;
    v_pays     jsonb;
    famRec     record;
    enrRec     record;
    v_fam      jsonb;
    v_entries  jsonb;
    v_camperIds jsonb;
    v_tuition  numeric;
    v_liveT    numeric;
    v_disc     numeric;
    v_seq      integer := 0;
    v_n_fams   integer := 0;
    v_report   jsonb := '[]'::jsonb;
    v_bal      numeric;
    e          jsonb;

    v_note text := 'converted from derived state by migration 171';
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = p_camp_id AND u.user_id = caller
                          AND u.role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_permitted');
    END IF;

    IF p_dry_run THEN
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    ELSE
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe'
         FOR UPDATE;
    END IF;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', true, 'families', 0, 'note', 'no camp data');
    END IF;

    v_fams := COALESCE(v_me->'families', '{}'::jsonb);
    v_enr  := COALESCE(v_me->'enrollments', '{}'::jsonb);
    v_sess := COALESCE(v_me->'sessions', '[]'::jsonb);
    v_pays := COALESCE(v_me->'finance'->'payments', '[]'::jsonb);

    FOR famRec IN SELECT key, value FROM jsonb_each(v_fams) LOOP
        v_fam := famRec.value;
        IF jsonb_typeof(v_fam) <> 'object' THEN CONTINUE; END IF;
        -- Already converted: never touch a real ledger.
        IF public.family_has_ledger(v_fam) THEN CONTINUE; END IF;

        v_entries := '[]'::jsonb;
        v_camperIds := CASE WHEN jsonb_typeof(v_fam->'camperIds') = 'array'
                            THEN v_fam->'camperIds' ELSE '[]'::jsonb END;

        -- ── tuition, one charge per live enrollment ──────────────────────
        FOR enrRec IN SELECT key, value FROM jsonb_each(v_enr) LOOP
            IF (enrRec.value->>'status') NOT IN ('enrolled', 'accepted') THEN CONTINUE; END IF;
            IF NOT (v_camperIds ? (enrRec.value->>'camperName')) THEN CONTINUE; END IF;

            v_liveT := (SELECT (s->>'tuition')::numeric
                          FROM jsonb_array_elements(v_sess) s
                         WHERE s->>'name' = enrRec.value->>'session' LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((enrRec.value->>'sessionTuition')::numeric, 0) END;
            IF v_tuition IS NULL OR v_tuition <= 0 THEN CONTINUE; END IF;

            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'charge', 'amount', ROUND(v_tuition, 2), 'reason', 'tuition',
                'date', COALESCE(enrRec.value->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', v_note, 'by', 'system',
                'source', jsonb_build_object(
                    'enrollmentId', enrRec.key,
                    'camperName', enrRec.value->>'camperName',
                    'camperId', enrRec.value->>'camperId',
                    'session', enrRec.value->>'session')
            ));

            v_disc := 0;
            IF enrRec.value->'discount' IS NOT NULL
               AND enrRec.value->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((enrRec.value->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((enrRec.value->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            IF v_disc > v_tuition THEN v_disc := v_tuition; END IF;
            IF v_disc > 0 THEN
                v_seq := v_seq + 1;
                v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                    'id', 'le_conv_' || famRec.key || '_' || v_seq,
                    'kind', 'credit', 'amount', ROUND(v_disc, 2), 'reason', 'discount',
                    'date', COALESCE(enrRec.value->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                    'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'note', v_note, 'by', 'system',
                    'source', jsonb_build_object('enrollmentId', enrRec.key)
                ));
            END IF;
        END LOOP;

        -- ── family charges and credits ────────────────────────────────────
        FOR e IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'charges') = 'array'
                          THEN v_fam->'charges' ELSE '[]'::jsonb END) LOOP
            IF COALESCE((e->>'amount')::numeric, 0) <= 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'charge', 'amount', ROUND((e->>'amount')::numeric, 2),
                'reason', 'fee',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'note', v_note), 'by', 'system',
                'source', '{}'::jsonb));
        END LOOP;

        FOR e IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'credits') = 'array'
                          THEN v_fam->'credits' ELSE '[]'::jsonb END) LOOP
            IF COALESCE((e->>'amount')::numeric, 0) <= 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'credit', 'amount', ROUND((e->>'amount')::numeric, 2),
                'reason', 'goodwill',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'note', v_note), 'by', 'system',
                'source', '{}'::jsonb));
        END LOOP;

        -- ── payments, by familyKey. A refund is stored as a negative payment
        -- today, so it converts to a refund entry with a positive amount —
        -- rule 3: the sign lives in the kind.
        FOR e IN SELECT * FROM jsonb_array_elements(v_pays) LOOP
            IF COALESCE(e->>'familyKey', '') <> famRec.key THEN CONTINUE; END IF;
            IF COALESCE(e->>'status', '') IN ('pending', 'failed') THEN CONTINUE; END IF;
            IF COALESCE((e->>'amount')::numeric, 0) = 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', CASE WHEN (e->>'amount')::numeric < 0 THEN 'refund' ELSE 'payment' END,
                'amount', ROUND(ABS((e->>'amount')::numeric), 2),
                'reason', 'card',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'notes', v_note), 'by', 'system',
                'source', jsonb_build_object('paymentId', e->>'id')));
        END LOOP;

        -- ── bank deposits (Zelle/ACH), which never lived in the blob ──────
        -- The deposit id is carried on the entry (source.depositId, and the
        -- entry id itself). It was left empty originally, which meant a
        -- converted deposit could not be told apart from an unconverted one —
        -- so migration 178's ongoing poster would have posted it a SECOND time
        -- and credited the family twice. Conversion and ongoing posting now
        -- produce the same id for the same deposit, which is what makes "has
        -- this been posted?" have one answer.
        FOR e IN SELECT jsonb_build_object(
                     'id', d.id::text,
                     'amount', (d.amount_cents::numeric / 100),
                     'rev', d.is_reversal,
                     'date', to_char(d.created_at, 'YYYY-MM-DD')) AS j
                   FROM bank_deposits d
                  WHERE d.camp_id = p_camp_id AND d.status = 'posted'
                    AND d.family_key = famRec.key
        LOOP
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_dep_' || (e->>'id'),
                'kind', CASE WHEN (e->>'rev')::boolean THEN 'refund' ELSE 'payment' END,
                'amount', ROUND(ABS((e->>'amount')::numeric), 2),
                'reason', 'zelle',
                'date', e->>'date',
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', 'bank deposit — ' || v_note, 'by', 'system',
                'source', jsonb_build_object('depositId', e->>'id')));
        END LOOP;

        IF jsonb_array_length(v_entries) = 0 THEN CONTINUE; END IF;

        v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
        v_bal := public.family_ledger_balance(v_fam);
        v_n_fams := v_n_fams + 1;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
            'famKey', famRec.key, 'name', v_fam->>'name',
            'entries', jsonb_array_length(v_entries), 'balance', v_bal));

        IF NOT p_dry_run THEN
            v_me := jsonb_set(v_me, ARRAY['families', famRec.key], v_fam, true);
        END IF;
    END LOOP;

    IF NOT p_dry_run AND v_n_fams > 0 THEN
        UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;

    RETURN jsonb_build_object('success', true, 'dryRun', p_dry_run,
        'families', v_n_fams, 'detail', v_report);
END;
$$;
REVOKE ALL ON FUNCTION public.convert_family_ledgers(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.convert_family_ledgers(uuid, boolean) TO authenticated, service_role;


-- ─── 3. what the old model already cost ─────────────────────────────────────
-- Read-only. Finds families whose payment plan claims instalments were paid
-- that no payment backs — the D1 shortfall — so an office can see the damage
-- before anything changes. Run this FIRST.
CREATE OR REPLACE FUNCTION public.report_plan_undercollection(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    v_me    jsonb;
    famRec  record;
    v_fam   jsonb;
    p       jsonb;
    i       jsonb;
    v_claimed numeric;
    v_paid    numeric;
    v_out   jsonb := '[]'::jsonb;
    v_total numeric := 0;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = p_camp_id AND u.user_id = caller
                          AND u.role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_permitted');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', true, 'families', 0);
    END IF;

    FOR famRec IN SELECT key, value FROM jsonb_each(COALESCE(v_me->'families', '{}'::jsonb)) LOOP
        v_fam := famRec.value;
        IF jsonb_typeof(v_fam) <> 'object' THEN CONTINUE; END IF;

        v_claimed := 0;
        FOR p IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'plans') = 'array' THEN v_fam->'plans'
                          WHEN jsonb_typeof(v_fam->'plan') = 'object'
                               THEN jsonb_build_array(v_fam->'plan')
                          ELSE '[]'::jsonb END) LOOP
            FOR i IN SELECT * FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(p->'installments') = 'array'
                              THEN p->'installments' ELSE '[]'::jsonb END) LOOP
                -- An instalment marked paid but carrying the waiver note was
                -- never charged: that note is the fingerprint of the defect.
                IF COALESCE(i->>'status', '') = 'paid'
                   AND COALESCE(i->>'note', '') LIKE 'Covered by an earlier payment%' THEN
                    v_claimed := v_claimed + COALESCE((i->>'amount')::numeric, 0);
                END IF;
            END LOOP;
        END LOOP;

        IF v_claimed > 0 THEN
            SELECT COALESCE(SUM((e->>'amount')::numeric), 0) INTO v_paid
              FROM jsonb_array_elements(COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) e
             WHERE e->>'familyKey' = famRec.key
               AND COALESCE(e->>'status', '') NOT IN ('pending', 'failed');

            v_total := v_total + v_claimed;
            v_out := v_out || jsonb_build_array(jsonb_build_object(
                'famKey', famRec.key, 'name', v_fam->>'name',
                'waivedNotCharged', ROUND(v_claimed, 2),
                'totalPaid', ROUND(v_paid, 2)));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true,
        'families', jsonb_array_length(v_out),
        'totalWaivedNotCharged', ROUND(v_total, 2),
        'detail', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.report_plan_undercollection(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_plan_undercollection(uuid) TO authenticated, service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
--   -- 1. what the old model cost, before changing anything:
--   select report_plan_undercollection('<camp>'::uuid);
--
--   -- 2. what conversion WOULD do (writes nothing):
--   select convert_family_ledgers('<camp>'::uuid, true);
--
--   -- 3. convert, then check the ledger agrees with the old derived number
--   --    for a family whose campers are all still enrolled (they must match):
--   select convert_family_ledgers('<camp>'::uuid, false);
--   select key, family_ledger_balance(value) FROM jsonb_each(
--       (select value->'families' from camp_state_kv
--         where camp_id='<camp>'::uuid and key='campistryMe'));
--
--   -- 4. the point of the whole exercise — remove a camper, and confirm the
--   --    balance is STILL there afterwards.
-- ============================================================================
