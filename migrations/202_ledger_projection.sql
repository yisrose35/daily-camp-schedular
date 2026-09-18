-- ============================================================================
-- Migration 202: the family ledger gets a second home the database keeps.
--
-- Stage 1 of moving payments off the campistryMe blob. The blob REMAINS the
-- single source of truth — no writer changes in this file, which is the whole
-- point of doing it this way.
--
-- ── THE PROBLEM BEING STAGED ────────────────────────────────────────────────
-- get_my_balance is called by every parent, on page load and before every
-- payment. Its wrapper (178) read the ENTIRE campistryMe value a second time
-- (get_my_balance_derived already read it once), then for each of the family's
-- keys scanned EVERY payment the camp has ever recorded to test ledger
-- completeness — O(families × all payments), on top of two full detoasts of a
-- multi-megabyte jsonb, per call, per parent.
--
-- The write side (append_camp_payment and friends rewriting the whole value
-- under one camp-wide row lock) is stage 2/3 and is deliberately NOT touched
-- here. Migration 158's header records why: those functions are fed by edge
-- functions deployed one at a time by Dashboard paste, and any change that
-- moves WHERE money is recorded needs the readers proven first. This file
-- proves the readers.
--
-- ── WHY A TRIGGER-MAINTAINED PROJECTION, NOT A SECOND HOME WRITERS FILL ────
-- The blob has many writers: six payment RPCs, sync_family_ledger_payments,
-- and the office client saving campistryMe wholesale from Billing. Teaching
-- each one to also write tables is the design that has already failed twice in
-- this project — a copy some writer forgets is a copy that drifts (the
-- migrations 035/039 lesson: derived, never stamped). A trigger on
-- camp_state_kv fires on EVERY write to the blob no matter who made it, in the
-- same transaction, so the projection cannot lag and cannot be forgotten by a
-- writer that does not know it exists.
--
-- Two projections, both one row per family, both holding the family's slice
-- as jsonb:
--
--   family_ledger_projection    families[k].entries   (the posted ledger)
--   family_payments_projection  finance.payments, bucketed by familyKey
--
-- Per-family jsonb rather than per-entry rows on purpose: the four helpers the
-- balance math runs on (family_has_ledger, family_ledger_summary,
-- family_has_tuition_entry, family_covers_payment) all take the family's
-- entries as jsonb. Feeding them a projected copy of exactly that shape means
-- the balance logic is bit-for-bit the logic already shipped and audited —
-- nothing is re-derived, so nothing can drift in translation. What changes is
-- only WHERE the jsonb comes from: an indexed few-KB row instead of a slice of
-- a multi-MB detoast.
--
-- ── THE FAIL-SAFE ALREADY IN PLACE ─────────────────────────────────────────
-- If the projection were ever wrong despite all this, 174/178's completeness
-- test turns that into "ledger incomplete", and the parent gets the DERIVED
-- figure — the one that is never short. A projection failure degrades to
-- today's answer, not to a wrong number.
--
-- ── NO FOREIGN KEY, DELIBERATELY ───────────────────────────────────────────
-- 200's first paste failed on an orphaned camp_state_kv row (a deleted camp's
-- leftovers) violating its FK to camps. Here an FK would be worse than a
-- failed paste: this table is written by a TRIGGER on camp_state_kv, so an FK
-- violation would abort the ORIGINAL blob save. A stale session writing a
-- deleted camp's row must not start failing writes it has always been allowed
-- to make. Lifecycle follows camp_state_kv instead: the DELETE trigger clears
-- a camp's projection when its blob row goes.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own.
-- Idempotent; the backfill also HEALS (re-running converges the projection
-- onto the blob, so it doubles as the repair tool if one is ever needed).
-- Requires 171/173/174/178 (the ledger, the wrapper and its helpers).
-- ============================================================================

-- ─── 1. the projections ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.family_ledger_projection (
    camp_id    uuid        NOT NULL,
    family_key text        NOT NULL,
    entries    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, family_key)
);

CREATE TABLE IF NOT EXISTS public.family_payments_projection (
    camp_id    uuid        NOT NULL,
    family_key text        NOT NULL,   -- '' is the bucket for payments with no familyKey
    payments   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, family_key)
);

-- RLS on, no policies: nobody reads these directly. The SECURITY DEFINER
-- balance functions read them as the table owner, and a curious authenticated
-- user selecting from them gets zero rows, not an error and not data.
ALTER TABLE public.family_ledger_projection   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_payments_projection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.family_ledger_projection   FROM anon;
REVOKE ALL ON public.family_payments_projection FROM anon;
GRANT SELECT ON public.family_ledger_projection   TO authenticated;
GRANT SELECT ON public.family_payments_projection TO authenticated;


-- ─── 2. the trigger that keeps them true ────────────────────────────────────
-- AFTER row trigger on camp_state_kv, campistryMe rows only. Each branch is
-- guarded by IS DISTINCT FROM so a save that did not touch families or
-- payments costs two jsonb comparisons and nothing else, and the upserts carry
-- the same guard per row so an unchanged family costs an index probe, not a
-- dead tuple.
--
-- SECURITY DEFINER because the writer of the blob (an office user under RLS)
-- has no rights on the projection tables — the trigger writes them as owner.
--
-- Bucket aggregation uses WITH ORDINALITY so re-aggregating an unchanged
-- payments array produces byte-identical jsonb — without it, the per-row
-- IS DISTINCT FROM guard would see phantom changes whenever aggregation order
-- wobbled, and rewrite every bucket on every save.
CREATE OR REPLACE FUNCTION public.project_campistry_me()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fams jsonb;
    v_pays jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.family_ledger_projection   WHERE camp_id = OLD.camp_id;
        DELETE FROM public.family_payments_projection WHERE camp_id = OLD.camp_id;
        RETURN OLD;
    END IF;

    -- families[k].entries → family_ledger_projection
    IF TG_OP = 'INSERT'
       OR (NEW.value -> 'families') IS DISTINCT FROM (OLD.value -> 'families') THEN
        v_fams := CASE WHEN jsonb_typeof(NEW.value -> 'families') = 'object'
                       THEN NEW.value -> 'families' ELSE '{}'::jsonb END;

        INSERT INTO public.family_ledger_projection (camp_id, family_key, entries, updated_at)
        SELECT NEW.camp_id, f.key,
               CASE WHEN jsonb_typeof(f.value -> 'entries') = 'array'
                    THEN f.value -> 'entries' ELSE '[]'::jsonb END,
               now()
          FROM jsonb_each(v_fams) AS f(key, value)
        ON CONFLICT (camp_id, family_key) DO UPDATE
           SET entries = EXCLUDED.entries, updated_at = EXCLUDED.updated_at
         WHERE public.family_ledger_projection.entries IS DISTINCT FROM EXCLUDED.entries;

        -- A family removed from the blob leaves the projection too. The office
        -- deleting a family is rare and deliberate; a projection row it left
        -- behind would resurrect that family's ledger in the balance math.
        DELETE FROM public.family_ledger_projection p
         WHERE p.camp_id = NEW.camp_id
           AND NOT v_fams ? p.family_key;
    END IF;

    -- finance.payments → family_payments_projection, bucketed by familyKey
    IF TG_OP = 'INSERT'
       OR (NEW.value -> 'finance' -> 'payments')
          IS DISTINCT FROM (OLD.value -> 'finance' -> 'payments') THEN
        v_pays := CASE WHEN jsonb_typeof(NEW.value -> 'finance' -> 'payments') = 'array'
                       THEN NEW.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END;

        INSERT INTO public.family_payments_projection (camp_id, family_key, payments, updated_at)
        SELECT NEW.camp_id, b.fk, b.pays, now()
          FROM (SELECT COALESCE(e.value ->> 'familyKey', '') AS fk,
                       jsonb_agg(e.value ORDER BY e.ord)     AS pays
                  FROM jsonb_array_elements(v_pays) WITH ORDINALITY AS e(value, ord)
                 GROUP BY COALESCE(e.value ->> 'familyKey', '')) AS b
        ON CONFLICT (camp_id, family_key) DO UPDATE
           SET payments = EXCLUDED.payments, updated_at = EXCLUDED.updated_at
         WHERE public.family_payments_projection.payments IS DISTINCT FROM EXCLUDED.payments;

        -- A bucket with no payments left (every payment re-keyed or removed)
        -- must go, or its family keeps checking completeness against payments
        -- that no longer exist.
        DELETE FROM public.family_payments_projection p
         WHERE p.camp_id = NEW.camp_id
           AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_pays) e
                 WHERE COALESCE(e ->> 'familyKey', '') = p.family_key);
    END IF;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_campistry_me() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_campistry_me ON public.camp_state_kv;
CREATE TRIGGER trg_project_campistry_me
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.project_campistry_me();

DROP TRIGGER IF EXISTS trg_project_campistry_me_del ON public.camp_state_kv;
CREATE TRIGGER trg_project_campistry_me_del
AFTER DELETE ON public.camp_state_kv
FOR EACH ROW
WHEN (OLD.key = 'campistryMe')
EXECUTE FUNCTION public.project_campistry_me();


-- ─── 3. the projected reads ─────────────────────────────────────────────────
-- Each returns the family's slice in the exact shape the existing helpers
-- take, so the balance math below is the shipped math. A missing row comes
-- back as an empty ledger, which family_has_ledger already treats the same as
-- a family that was never converted — that is 171's own definition of "has a
-- ledger" (a non-empty entries array), reproduced rather than reinterpreted.
CREATE OR REPLACE FUNCTION public.projected_family_ledger(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object('entries', COALESCE(
        (SELECT entries FROM public.family_ledger_projection
          WHERE camp_id = p_camp_id AND family_key = p_family_key),
        '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.projected_family_ledger(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.projected_family_ledger(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.projected_family_payments(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT payments FROM public.family_payments_projection
          WHERE camp_id = p_camp_id AND family_key = p_family_key),
        '[]'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.projected_family_payments(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.projected_family_payments(uuid, text) TO authenticated, service_role;


-- ─── 4. backfill — and the repair tool, same statement ──────────────────────
-- Scoped to camps that still exist (200's first-paste lesson: deleted camps
-- leave orphaned campistryMe rows behind, and the whole paste is one
-- transaction). The per-row IS DISTINCT FROM guards make a re-run converge on
-- the blob rather than churn, so this section IS the repair procedure: if the
-- projection is ever suspected wrong, re-paste this file.
INSERT INTO public.family_ledger_projection (camp_id, family_key, entries, updated_at)
SELECT kv.camp_id, f.key,
       CASE WHEN jsonb_typeof(f.value -> 'entries') = 'array'
            THEN f.value -> 'entries' ELSE '[]'::jsonb END,
       now()
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(kv.value -> 'families') = 'object'
             THEN kv.value -> 'families' ELSE '{}'::jsonb END) AS f(key, value)
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
ON CONFLICT (camp_id, family_key) DO UPDATE
   SET entries = EXCLUDED.entries, updated_at = now()
 WHERE public.family_ledger_projection.entries IS DISTINCT FROM EXCLUDED.entries;

INSERT INTO public.family_payments_projection (camp_id, family_key, payments, updated_at)
SELECT kv.camp_id,
       COALESCE(e.value ->> 'familyKey', ''),
       jsonb_agg(e.value ORDER BY e.ord),
       now()
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(kv.value -> 'finance' -> 'payments') = 'array'
             THEN kv.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
        WITH ORDINALITY AS e(value, ord)
 WHERE kv.key = 'campistryMe'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
 GROUP BY kv.camp_id, COALESCE(e.value ->> 'familyKey', '')
ON CONFLICT (camp_id, family_key) DO UPDATE
   SET payments = EXCLUDED.payments, updated_at = now()
 WHERE public.family_payments_projection.payments IS DISTINCT FROM EXCLUDED.payments;


-- ─── 5. the wrapper stops reading the blob ──────────────────────────────────
-- 178's get_my_balance, with exactly two things changed:
--
--   * the second whole-blob read (`SELECT value INTO v_me FROM camp_state_kv`)
--     is GONE — every `v_me #> ['families', k]` becomes an indexed few-KB read
--     through projected_family_ledger;
--   * the completeness pass stops scanning the camp's entire payments array
--     per family — each family checks only its own projected bucket, which is
--     the same set family_payments_all_posted's own familyKey filter selected
--     out of the full array (a payment with no familyKey never matched a real
--     key, and the '' bucket keeps those out of every real family's check).
--
-- Every judgement in it — the completeness tests, the fallback to derived, the
-- return shape, the marker 173's rename guard looks for — is 178's, verbatim.
-- get_my_balance_derived still reads the blob once for identity and config;
-- that read is stage 2's problem, and honesty about it beats pretending this
-- file removed it.
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
    v_camp    uuid;
    v_keys    jsonb;
    v_fams    jsonb := '{}'::jsonb;
    v_fam     jsonb;
    v_sum     jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_allHave boolean := true;
    v_complete boolean := true;
    v_missing jsonb := '[]'::jsonb;
    v_unpaid  jsonb := '[]'::jsonb;
    k         text;
    enr       jsonb;
    v_found   boolean;
BEGIN
    v_base := public.get_my_balance_derived(p_camp_id);
    IF v_base IS NULL OR COALESCE((v_base->>'success')::boolean, false) = false THEN
        RETURN v_base;
    END IF;

    v_camp := (v_base->>'camp_id')::uuid;
    v_keys := COALESCE(v_base->'familyKeys', '[]'::jsonb);
    IF jsonb_typeof(v_keys) <> 'array' OR jsonb_array_length(v_keys) = 0 THEN
        RETURN v_base;
    END IF;

    -- One projected read per family key, cached for the completeness pass.
    FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
        v_fam := public.projected_family_ledger(v_camp, k);
        v_fams := jsonb_set(v_fams, ARRAY[k], v_fam, true);
        IF NOT public.family_has_ledger(v_fam) THEN
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
                IF public.family_has_tuition_entry(v_fams -> k, enr->>'id') THEN
                    v_found := true;
                    EXIT;
                END IF;
            END LOOP;
            IF NOT v_found THEN
                v_complete := false;
                v_missing := v_missing || jsonb_build_array(enr->>'id');
            END IF;
        END LOOP;

        -- ── and every payment (migration 178) ────────────────────────────
        -- 174 asked only whether every enrollment had a tuition CHARGE, so a
        -- ledger missing every payment a family ever made was still declared
        -- complete — and the parent was shown money they had already paid.
        -- Asking the same question of payments is what closes that.
        FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
            IF NOT public.family_payments_all_posted(
                   v_fams -> k,
                   public.projected_family_payments(v_camp, k),
                   k) THEN
                v_complete := false;
                v_unpaid := v_unpaid || jsonb_build_array(k);
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
            'unpostedEnrollments', v_missing,
            'unpostedPaymentFamilies', v_unpaid);
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
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated, service_role;


-- ─── 6. the verifier ────────────────────────────────────────────────────────
-- Answers one question per camp: does the projection match the blob, family by
-- family and bucket by bucket? Run it after pasting this file, and any time
-- the projection is doubted. It reports WHICH keys disagree and never any
-- amounts, so it is safe to read over someone's shoulder.
--
--   SELECT public.verify_ledger_projection('<camp id>');
CREATE OR REPLACE FUNCTION public.verify_ledger_projection(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_me         jsonb;
    v_fams       jsonb;
    v_pays       jsonb;
    v_fam_bad    jsonb := '[]'::jsonb;
    v_pay_bad    jsonb := '[]'::jsonb;
    v_fam_n      integer := 0;
    v_pay_n      integer := 0;
    r            record;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    v_fams := CASE WHEN jsonb_typeof(v_me -> 'families') = 'object'
                   THEN v_me -> 'families' ELSE '{}'::jsonb END;
    v_pays := CASE WHEN jsonb_typeof(v_me -> 'finance' -> 'payments') = 'array'
                   THEN v_me -> 'finance' -> 'payments' ELSE '[]'::jsonb END;

    -- Ledger: every blob family's entries must equal its projected row, and no
    -- projected row may exist without a blob family. FULL JOIN so a miss on
    -- either side is a mismatch, not a skip.
    FOR r IN
        SELECT COALESCE(f.key, p.family_key) AS fk,
               CASE WHEN jsonb_typeof(f.value -> 'entries') = 'array'
                    THEN f.value -> 'entries'
                    WHEN f.key IS NOT NULL THEN '[]'::jsonb END AS blob_entries,
               p.entries AS proj_entries
          FROM jsonb_each(v_fams) AS f(key, value)
          FULL JOIN (SELECT family_key, entries FROM public.family_ledger_projection
                      WHERE camp_id = p_camp_id) p
            ON p.family_key = f.key
    LOOP
        v_fam_n := v_fam_n + 1;
        IF r.blob_entries IS DISTINCT FROM r.proj_entries THEN
            v_fam_bad := v_fam_bad || jsonb_build_array(r.fk);
        END IF;
    END LOOP;

    -- Payments: bucket the blob the same way the trigger does and compare.
    FOR r IN
        WITH b AS (
            SELECT COALESCE(e.value ->> 'familyKey', '') AS fk,
                   jsonb_agg(e.value ORDER BY e.ord)     AS pays
              FROM jsonb_array_elements(v_pays) WITH ORDINALITY AS e(value, ord)
             GROUP BY COALESCE(e.value ->> 'familyKey', '')
        )
        SELECT COALESCE(b.fk, p.family_key) AS fk,
               b.pays AS blob_pays,
               p.payments AS proj_pays
          FROM b
          FULL JOIN (SELECT family_key, payments FROM public.family_payments_projection
                      WHERE camp_id = p_camp_id) p
            ON p.family_key = b.fk
    LOOP
        v_pay_n := v_pay_n + 1;
        IF r.blob_pays IS DISTINCT FROM r.proj_pays THEN
            v_pay_bad := v_pay_bad || jsonb_build_array(r.fk);
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'inSync', jsonb_array_length(v_fam_bad) = 0 AND jsonb_array_length(v_pay_bad) = 0,
        'familiesChecked', v_fam_n,
        'familiesMismatched', v_fam_bad,
        'paymentBucketsChecked', v_pay_n,
        'paymentBucketsMismatched', v_pay_bad,
        'repair', 're-paste migrations/202_ledger_projection.sql — its backfill converges the projection onto the blob');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_ledger_projection(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_ledger_projection(uuid) TO authenticated, service_role;


-- ─── Sanity checks ──────────────────────────────────────────────────────────
-- The triggers are installed:
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.camp_state_kv'::regclass AND NOT tgisinternal;
--   -- expect trg_project_campistry_me and trg_project_campistry_me_del
--
-- The projection matches the blob for a camp:
--   SELECT public.verify_ledger_projection('<camp id>');   -- inSync: true
--
-- The wrapper no longer reads the blob (its only camp_state_kv read is gone):
--   SELECT prosrc LIKE '%camp_state_kv%' FROM pg_proc
--    WHERE proname = 'get_my_balance';                     -- expect f
