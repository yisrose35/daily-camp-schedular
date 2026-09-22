-- ============================================================================
-- Migration 205: the parent's balance stops reading the whole camp.
--
-- ── THE MEASUREMENT ────────────────────────────────────────────────────────
-- A load test against a real project (scripts/load_test.mjs) found one
-- bottleneck and it was not subtle:
--
--     get_my_balance        828ms at 5 concurrent parents, 3575ms at 32
--     everything else       150-765ms at 32, flat
--
-- Five to ten times every other portal read, and the only one that degraded
-- with concurrency. get_my_balance's WRAPPER was taken off the blob by
-- migration 202; its header said the derived half was "stage 2's problem, and
-- honesty about it beats pretending this file removed it". This is stage 2.
--
-- ── WHY IT WAS SLOW, WHICH IS NOT WHAT IT LOOKS LIKE ──────────────────────
-- get_my_balance_derived (created by 166, renamed by 173) loops over every
-- enrollment, every family and every payment in the camp to find the handful
-- belonging to ONE family. Narrowing those loops alone would not have fixed
-- it, because the real cost is the line above them:
--
--     SELECT value INTO me FROM camp_state_kv WHERE ... key = 'campistryMe';
--
-- jsonb has no partial read. Touching ANY field of that value detoasts and
-- parses the whole multi-megabyte thing, so the floor was the camp's size per
-- parent per call no matter how tight the loops got. The blob read had to go.
--
-- ── THE CHANGE IS ONE LINE, DELIBERATELY ──────────────────────────────────
-- This is parent-facing money. The ledger path in 202 could afford a rewrite
-- because its completeness test falls back to the derived figure when anything
-- looks wrong — but DERIVED IS THAT FALLBACK. It has none of its own, so it
-- gets no rewrite: `me` is assembled from indexed projections into the same
-- shape, and every line after that is byte-identical to 166. The loops still
-- re-apply their own filters over the narrowed slice, so a slice that is too
-- GENEROUS changes nothing; only one that omits something could, and the
-- slice's predicates are the loops' predicates.
--
-- A test asserts that byte-identity rather than trusting this paragraph.
--
-- ── THE FALLBACK, AND WHY IT IS EXACT ─────────────────────────────────────
-- camp_billing_config stores the blob's own updated_at as the stamp the
-- projection was built from. Selecting ONLY updated_at from camp_state_kv does
-- not fetch the TOASTed value, so the probe is cheap. Stamps equal means the
-- trigger has projected this exact blob. Anything else — a camp never saved
-- since this migration, a restored backup, a write that bypassed the trigger —
-- reads the blob exactly as before. Degrading to yesterday's performance is
-- the correct failure; degrading to a wrong balance is not available.
--
-- ── WHAT IS PROJECTED, AND WHY EACH ONE ───────────────────────────────────
-- The derived function reads exactly five things out of the blob (verified by
-- enumerating every `me->` in its body):
--
--     enrollments                            -> camp_billing_enrollments
--     families                               -> camp_billing_families
--     finance.payments                       -> camp_billing_payments
--     sessions                               -> camp_billing_config.sessions
--     enrollSettings.allowParentPaymentPlans -> camp_billing_config.enroll_settings
--
-- Payments get their three match keys as indexed COLUMNS (family, familyKey,
-- enrollmentId) because the loop matches on any of them, and 202's existing
-- payments projection buckets only by familyKey — a payment carrying another
-- family's key but this parent's camper name would have been missed, and the
-- old code counted it.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own.
-- Idempotent; the backfill converges and doubles as the repair tool.
-- Requires 166 (the derived body), 173 (the rename) and 202 (the ledger
-- projections this sits beside).
-- ============================================================================

-- ─── 1. the projections ─────────────────────────────────────────────────────
-- No FK to camps, same reasoning as 202 and 203: these are written by a
-- TRIGGER, and an FK violation there would abort the original blob save.

CREATE TABLE IF NOT EXISTS public.camp_billing_config (
    camp_id          uuid        NOT NULL PRIMARY KEY,
    sessions         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    enroll_settings  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- The blob's own updated_at. This is the freshness contract; see the header.
    blob_updated_at  timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.camp_billing_enrollments (
    camp_id     uuid  NOT NULL,
    entry_id    text  NOT NULL,
    camper_name text  NOT NULL DEFAULT '',
    payload     jsonb NOT NULL,
    PRIMARY KEY (camp_id, entry_id)
);
-- The lookup: this parent's campers, by name, which is what the invite carries.
CREATE INDEX IF NOT EXISTS idx_camp_billing_enr_camper
    ON public.camp_billing_enrollments (camp_id, camper_name);

CREATE TABLE IF NOT EXISTS public.camp_billing_families (
    camp_id    uuid  NOT NULL,
    family_key text  NOT NULL,
    camper_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload    jsonb NOT NULL,
    PRIMARY KEY (camp_id, family_key)
);
-- Which families hold one of this parent's campers. GIN over the camperIds
-- array, so the membership test is an index probe rather than a scan of every
-- family in the camp.
CREATE INDEX IF NOT EXISTS idx_camp_billing_fam_campers
    ON public.camp_billing_families USING gin (camper_ids jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public.camp_billing_payments (
    camp_id       uuid  NOT NULL,
    seq           integer NOT NULL,          -- position in the original array
    family_name   text  NOT NULL DEFAULT '', -- payload->>'family'
    family_key    text  NOT NULL DEFAULT '', -- payload->>'familyKey'
    enrollment_id text  NOT NULL DEFAULT '', -- payload->>'enrollmentId'
    payload       jsonb NOT NULL,
    PRIMARY KEY (camp_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_camp_billing_pay_famkey
    ON public.camp_billing_payments (camp_id, family_key);
CREATE INDEX IF NOT EXISTS idx_camp_billing_pay_famname
    ON public.camp_billing_payments (camp_id, family_name);
CREATE INDEX IF NOT EXISTS idx_camp_billing_pay_enr
    ON public.camp_billing_payments (camp_id, enrollment_id);

-- Deny-all: every read goes through the SECURITY DEFINER functions below, which
-- scope to the caller's own campers. A curious authenticated SELECT sees zero
-- rows rather than the camp's billing.
ALTER TABLE public.camp_billing_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camp_billing_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camp_billing_families    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camp_billing_payments    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_billing_config      FROM anon, authenticated;
REVOKE ALL ON public.camp_billing_enrollments FROM anon, authenticated;
REVOKE ALL ON public.camp_billing_families    FROM anon, authenticated;
REVOKE ALL ON public.camp_billing_payments    FROM anon, authenticated;


-- ─── 2. the trigger that keeps them true ────────────────────────────────────
-- Fires on every campistryMe write, whoever made it, in the same transaction —
-- the same reason 202 used a trigger rather than teaching each writer about a
-- second home: a copy some writer forgets is a copy that drifts.
--
-- The stamp is written on EVERY save even when nothing else changed, because it
-- is what the balance function trusts. Each branch re-projects only when its own
-- source changed, so an inventory-shaped save costs three jsonb comparisons.
CREATE OR REPLACE FUNCTION public.project_camp_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.camp_billing_enrollments WHERE camp_id = OLD.camp_id;
        DELETE FROM public.camp_billing_families    WHERE camp_id = OLD.camp_id;
        DELETE FROM public.camp_billing_payments    WHERE camp_id = OLD.camp_id;
        DELETE FROM public.camp_billing_config      WHERE camp_id = OLD.camp_id;
        RETURN OLD;
    END IF;

    -- enrollments
    IF TG_OP = 'INSERT'
       OR (NEW.value -> 'enrollments') IS DISTINCT FROM (OLD.value -> 'enrollments') THEN
        DELETE FROM public.camp_billing_enrollments WHERE camp_id = NEW.camp_id;
        INSERT INTO public.camp_billing_enrollments (camp_id, entry_id, camper_name, payload)
        SELECT NEW.camp_id, e.key, COALESCE(e.value ->> 'camperName', ''), e.value
          FROM jsonb_each(CASE WHEN jsonb_typeof(NEW.value -> 'enrollments') = 'object'
                               THEN NEW.value -> 'enrollments' ELSE '{}'::jsonb END) AS e(key, value)
         WHERE jsonb_typeof(e.value) = 'object';
    END IF;

    -- families
    IF TG_OP = 'INSERT'
       OR (NEW.value -> 'families') IS DISTINCT FROM (OLD.value -> 'families') THEN
        DELETE FROM public.camp_billing_families WHERE camp_id = NEW.camp_id;
        INSERT INTO public.camp_billing_families (camp_id, family_key, camper_ids, payload)
        SELECT NEW.camp_id, f.key,
               CASE WHEN jsonb_typeof(f.value -> 'camperIds') = 'array'
                    THEN f.value -> 'camperIds' ELSE '[]'::jsonb END,
               f.value
          FROM jsonb_each(CASE WHEN jsonb_typeof(NEW.value -> 'families') = 'object'
                               THEN NEW.value -> 'families' ELSE '{}'::jsonb END) AS f(key, value)
         WHERE jsonb_typeof(f.value) = 'object';
    END IF;

    -- finance.payments, with the three keys the balance loop matches on
    IF TG_OP = 'INSERT'
       OR (NEW.value -> 'finance' -> 'payments')
          IS DISTINCT FROM (OLD.value -> 'finance' -> 'payments') THEN
        DELETE FROM public.camp_billing_payments WHERE camp_id = NEW.camp_id;
        INSERT INTO public.camp_billing_payments
            (camp_id, seq, family_name, family_key, enrollment_id, payload)
        SELECT NEW.camp_id, p.ord::integer,
               COALESCE(p.value ->> 'family', ''),
               COALESCE(p.value ->> 'familyKey', ''),
               COALESCE(p.value ->> 'enrollmentId', ''),
               p.value
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(NEW.value -> 'finance' -> 'payments') = 'array'
                      THEN NEW.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
               WITH ORDINALITY AS p(value, ord)
         WHERE jsonb_typeof(p.value) = 'object';
    END IF;

    -- config + the freshness stamp, always
    INSERT INTO public.camp_billing_config (camp_id, sessions, enroll_settings, blob_updated_at, updated_at)
    VALUES (NEW.camp_id,
            CASE WHEN jsonb_typeof(NEW.value -> 'sessions') = 'array'
                 THEN NEW.value -> 'sessions' ELSE '[]'::jsonb END,
            CASE WHEN jsonb_typeof(NEW.value -> 'enrollSettings') = 'object'
                 THEN NEW.value -> 'enrollSettings' ELSE '{}'::jsonb END,
            NEW.updated_at, now())
    ON CONFLICT (camp_id) DO UPDATE
       SET sessions = EXCLUDED.sessions,
           enroll_settings = EXCLUDED.enroll_settings,
           blob_updated_at = EXCLUDED.blob_updated_at,
           updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_billing() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_camp_billing ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_billing
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.project_camp_billing();

DROP TRIGGER IF EXISTS trg_project_camp_billing_del ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_billing_del
AFTER DELETE ON public.camp_state_kv
FOR EACH ROW
WHEN (OLD.key = 'campistryMe')
EXECUTE FUNCTION public.project_camp_billing();


-- ─── 3. the slice ───────────────────────────────────────────────────────────
-- Returns the same SHAPE the blob had, holding only what this parent's balance
-- can possibly depend on. Each predicate below is the matching loop's own
-- predicate in get_my_balance_derived, so the slice is exact; and because the
-- loops re-apply their filters anyway, being generous here could only cost a
-- little work, never a wrong number.
CREATE OR REPLACE FUNCTION public.parent_billing_slice(p_camp_id uuid, p_names jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_names    text[];
    v_enr      jsonb := '{}'::jsonb;
    v_enrIds   text[] := ARRAY[]::text[];
    v_fams     jsonb := '{}'::jsonb;
    v_famKeys  text[] := ARRAY[]::text[];
    v_famNames text[] := ARRAY[]::text[];
    v_pays     jsonb := '[]'::jsonb;
    v_sessions jsonb := '[]'::jsonb;
    v_settings jsonb := '{}'::jsonb;
BEGIN
    SELECT ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_names) = 'array' THEN p_names ELSE '[]'::jsonb END))
      INTO v_names;

    -- this parent's campers' enrollments (the loop's own test: v_names ? camperName)
    SELECT COALESCE(jsonb_object_agg(entry_id, payload), '{}'::jsonb),
           COALESCE(array_agg(entry_id), ARRAY[]::text[])
      INTO v_enr, v_enrIds
      FROM public.camp_billing_enrollments
     WHERE camp_id = p_camp_id AND camper_name = ANY (v_names);

    -- families holding any of those campers (the loop's own camperIds test)
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb),
           COALESCE(array_agg(family_key), ARRAY[]::text[]),
           COALESCE(array_agg(payload ->> 'name') FILTER (WHERE COALESCE(payload ->> 'name', '') <> ''),
                    ARRAY[]::text[])
      INTO v_fams, v_famKeys, v_famNames
      FROM public.camp_billing_families
     WHERE camp_id = p_camp_id
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(camper_ids) ci
                    WHERE ci = ANY (v_names));

    -- payments matching ANY of the four things the loop matches on, in the
    -- original array order so the returned history reads the same as before
    SELECT COALESCE(jsonb_agg(payload ORDER BY seq), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_billing_payments
     WHERE camp_id = p_camp_id
       AND (family_name = ANY (v_names)
            OR (enrollment_id <> '' AND enrollment_id = ANY (v_enrIds))
            OR (family_key <> '' AND family_key = ANY (v_famKeys))
            OR (family_name <> '' AND family_name = ANY (v_famNames)));

    SELECT sessions, enroll_settings INTO v_sessions, v_settings
      FROM public.camp_billing_config WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'enrollments',    v_enr,
        'families',       v_fams,
        'finance',        jsonb_build_object('payments', v_pays),
        'sessions',       COALESCE(v_sessions, '[]'::jsonb),
        'enrollSettings', COALESCE(v_settings, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.parent_billing_slice(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.parent_billing_slice(uuid, jsonb) TO authenticated, service_role;


-- ─── 4. the balance, reading the slice ──────────────────────────────────────
-- 166's function, with TWO changes and nothing else: two DECLARE lines for the
-- freshness probe, and where `me` comes from. Everything after that block is
-- byte-identical, which a test asserts against 166 directly.
CREATE OR REPLACE FUNCTION public.get_my_balance_derived(p_camp_id uuid DEFAULT NULL)
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
    v_blobStamp   timestamptz;   -- 205: the blob row's updated_at (cheap: no TOAST fetch)
    v_projStamp   timestamptz;   -- 205: what the projection was built from
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

    -- ★ 205: `me` is the same shape, assembled from indexed projections instead
    -- of the camp's whole jsonb value. Reading ANY field of campistryMe forces
    -- Postgres to detoast and parse the entire multi-megabyte value, so the cost
    -- was the camp's size on every parent's every balance check — measured at
    -- 828ms with 5 concurrent parents and 3575ms with 32, while every other
    -- portal read stayed under a second.
    --
    -- Selecting only updated_at does NOT fetch the TOASTed value, so the
    -- freshness probe is cheap. Stamps equal means the trigger has projected
    -- this exact blob; anything else (a camp never saved since this migration,
    -- a restored backup, a write that somehow bypassed the trigger) falls back
    -- to reading the blob, which is this function's own previous behaviour.
    -- Everything below this block is byte-identical to migration 166.
    SELECT updated_at INTO v_blobStamp FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    SELECT blob_updated_at INTO v_projStamp FROM camp_billing_config
    WHERE camp_id = inv.camp_id;

    IF v_blobStamp IS NOT NULL AND v_projStamp IS NOT NULL AND v_projStamp = v_blobStamp THEN
        me := public.parent_billing_slice(inv.camp_id, v_names);
    ELSE
        SELECT value INTO me FROM camp_state_kv
        WHERE camp_id = inv.camp_id AND key = 'campistryMe';
    END IF;
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
REVOKE ALL ON FUNCTION public.get_my_balance_derived(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_balance_derived(uuid) TO authenticated, service_role;


-- ─── 5. backfill — and the repair tool, same statements ─────────────────────
-- Scoped to camps that still exist (migration 200's first paste failed on an
-- orphaned campistryMe row whose camp was gone). Re-pasting this file
-- re-projects every camp and re-stamps it, so it IS the repair procedure.
DELETE FROM public.camp_billing_enrollments
 WHERE camp_id IN (SELECT camp_id FROM camp_state_kv kv WHERE kv.key = 'campistryMe'
                    AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id));
INSERT INTO public.camp_billing_enrollments (camp_id, entry_id, camper_name, payload)
SELECT kv.camp_id, e.key, COALESCE(e.value ->> 'camperName', ''), e.value
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(kv.value -> 'enrollments') = 'object'
                                    THEN kv.value -> 'enrollments' ELSE '{}'::jsonb END) AS e(key, value)
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
   AND jsonb_typeof(e.value) = 'object'
ON CONFLICT (camp_id, entry_id) DO UPDATE
   SET camper_name = EXCLUDED.camper_name, payload = EXCLUDED.payload;

DELETE FROM public.camp_billing_families
 WHERE camp_id IN (SELECT camp_id FROM camp_state_kv kv WHERE kv.key = 'campistryMe'
                    AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id));
INSERT INTO public.camp_billing_families (camp_id, family_key, camper_ids, payload)
SELECT kv.camp_id, f.key,
       CASE WHEN jsonb_typeof(f.value -> 'camperIds') = 'array'
            THEN f.value -> 'camperIds' ELSE '[]'::jsonb END,
       f.value
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(kv.value -> 'families') = 'object'
                                    THEN kv.value -> 'families' ELSE '{}'::jsonb END) AS f(key, value)
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
   AND jsonb_typeof(f.value) = 'object'
ON CONFLICT (camp_id, family_key) DO UPDATE
   SET camper_ids = EXCLUDED.camper_ids, payload = EXCLUDED.payload;

DELETE FROM public.camp_billing_payments
 WHERE camp_id IN (SELECT camp_id FROM camp_state_kv kv WHERE kv.key = 'campistryMe'
                    AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id));
INSERT INTO public.camp_billing_payments
    (camp_id, seq, family_name, family_key, enrollment_id, payload)
SELECT kv.camp_id, p.ord::integer,
       COALESCE(p.value ->> 'family', ''),
       COALESCE(p.value ->> 'familyKey', ''),
       COALESCE(p.value ->> 'enrollmentId', ''),
       p.value
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(kv.value -> 'finance' -> 'payments') = 'array'
             THEN kv.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
        WITH ORDINALITY AS p(value, ord)
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
   AND jsonb_typeof(p.value) = 'object'
ON CONFLICT (camp_id, seq) DO UPDATE
   SET family_name = EXCLUDED.family_name, family_key = EXCLUDED.family_key,
       enrollment_id = EXCLUDED.enrollment_id, payload = EXCLUDED.payload;

-- The stamp goes LAST, so a backfill interrupted part way leaves the camp
-- unstamped and therefore still reading the blob — correct, not half-projected.
INSERT INTO public.camp_billing_config (camp_id, sessions, enroll_settings, blob_updated_at, updated_at)
SELECT kv.camp_id,
       CASE WHEN jsonb_typeof(kv.value -> 'sessions') = 'array'
            THEN kv.value -> 'sessions' ELSE '[]'::jsonb END,
       CASE WHEN jsonb_typeof(kv.value -> 'enrollSettings') = 'object'
            THEN kv.value -> 'enrollSettings' ELSE '{}'::jsonb END,
       kv.updated_at, now()
  FROM camp_state_kv kv
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
ON CONFLICT (camp_id) DO UPDATE
   SET sessions = EXCLUDED.sessions, enroll_settings = EXCLUDED.enroll_settings,
       blob_updated_at = EXCLUDED.blob_updated_at, updated_at = EXCLUDED.updated_at;


-- ─── 6. the verifier ────────────────────────────────────────────────────────
-- Does the projection match the blob for this camp, and is the camp on the fast
-- path at all? Reports counts and the stamp state, never anybody's money.
-- Gated like 202's and 203's verifiers, including for a direct database session:
-- the SQL Editor carries no JWT, and "no claims at all" can only be a direct
-- session, never an API caller.
CREATE OR REPLACE FUNCTION public.verify_camp_billing_projection(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims  text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_me      jsonb;
    v_stamp   timestamptz;
    v_proj    timestamptz;
    v_bEnr    integer; v_pEnr integer;
    v_bFam    integer; v_pFam integer;
    v_bPay    integer; v_pPay integer;
    v_cfgOk   boolean;
BEGIN
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value, updated_at INTO v_me, v_stamp FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    SELECT blob_updated_at INTO v_proj FROM public.camp_billing_config WHERE camp_id = p_camp_id;

    SELECT count(*)::integer INTO v_bEnr FROM jsonb_each(
        CASE WHEN jsonb_typeof(v_me -> 'enrollments') = 'object' THEN v_me -> 'enrollments' ELSE '{}'::jsonb END) e
      WHERE jsonb_typeof(e.value) = 'object';
    SELECT count(*)::integer INTO v_bFam FROM jsonb_each(
        CASE WHEN jsonb_typeof(v_me -> 'families') = 'object' THEN v_me -> 'families' ELSE '{}'::jsonb END) f
      WHERE jsonb_typeof(f.value) = 'object';
    SELECT count(*)::integer INTO v_bPay FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_me -> 'finance' -> 'payments') = 'array'
             THEN v_me -> 'finance' -> 'payments' ELSE '[]'::jsonb END) p
      WHERE jsonb_typeof(p.value) = 'object';

    SELECT count(*)::integer INTO v_pEnr FROM public.camp_billing_enrollments WHERE camp_id = p_camp_id;
    SELECT count(*)::integer INTO v_pFam FROM public.camp_billing_families    WHERE camp_id = p_camp_id;
    SELECT count(*)::integer INTO v_pPay FROM public.camp_billing_payments    WHERE camp_id = p_camp_id;

    SELECT COALESCE(sessions, '[]'::jsonb) IS NOT DISTINCT FROM
           COALESCE(CASE WHEN jsonb_typeof(v_me -> 'sessions') = 'array'
                         THEN v_me -> 'sessions' ELSE '[]'::jsonb END, '[]'::jsonb)
      INTO v_cfgOk FROM public.camp_billing_config WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'onFastPath', (v_stamp IS NOT NULL AND v_proj IS NOT NULL AND v_proj = v_stamp),
        'inSync', (v_bEnr = COALESCE(v_pEnr, -1) AND v_bFam = COALESCE(v_pFam, -1)
                   AND v_bPay = COALESCE(v_pPay, -1) AND COALESCE(v_cfgOk, false)),
        'enrollments', jsonb_build_object('blob', v_bEnr, 'projected', v_pEnr),
        'families',    jsonb_build_object('blob', v_bFam, 'projected', v_pFam),
        'payments',    jsonb_build_object('blob', v_bPay, 'projected', v_pPay),
        'sessionsMatch', COALESCE(v_cfgOk, false),
        'note', 'onFastPath false is SAFE — the balance falls back to reading the blob, which is its pre-205 behaviour',
        'repair', 're-paste migrations/205_parent_balance_off_the_blob.sql, or save Camp Dates once to re-fire the trigger');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_billing_projection(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_billing_projection(uuid) TO authenticated, service_role;


-- ─── Sanity checks ──────────────────────────────────────────────────────────
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.camp_state_kv'::regclass AND NOT tgisinternal;
--   -- expect trg_project_camp_billing(+_del) beside 202's and 203's
--
--   SELECT public.verify_camp_billing_projection('<camp id>');
--   -- expect onFastPath: true, inSync: true
--
--   -- and the balance itself, as a parent would get it:
--   SELECT public.get_my_balance('<camp id>');
