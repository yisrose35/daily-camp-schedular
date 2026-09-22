-- ════════════════════════════════════════════════════════════════════════════
-- 211 — families get their own rows (the new home, kept true)
-- ════════════════════════════════════════════════════════════════════════════
--
-- A CORRECTION TO THE PLAN. 208 and 210 moved payments into rows and moved every
-- reader onto them, both verified on live data. The next step was supposed to be
-- flipping the payment writers so the camp-wide lock could go. It cannot go yet,
-- and the reason is worth writing down:
--
--   ALL SIXTEEN functions that lock campistryMe touch `families`.
--   Nine of them touch `finance.payments` as well; every one touches families.
--
-- The lock exists to serialise read-modify-write of the WHOLE document. While
-- families live inside that document, every one of those writers must serialise
-- camp-wide whatever else changes, so taking only the payments array out of them
-- buys exactly nothing. Families are the bottleneck, and payments were the
-- easier half done first.
--
-- Nor can it be narrowed to a per-family advisory lock while families stay in
-- the document: two different families would then UPDATE the same camp_state_kv
-- row concurrently, and a read-modify-write of one jsonb value needs
-- serialisation on the ROW, not on the family. Migration 200 could narrow its
-- lock to (camp, session) precisely because it moved the data it was protecting
-- out to camp_applications first. Same move, same order, here.
--
-- SO THE REVISED ORDER IS:
--   208 ✓  payments → rows, kept true          (22 camps inSync, 1566.67 = 1566.67)
--   210 ✓  payment readers → rows              (sameOrderAndContent, 18 = 18)
--   211    (here) families → rows, kept true
--   next   family readers → rows
--   then   the writers write rows only, and the camp-wide lock goes
--   last   the load test grows a payments phase, so the ceiling is measured
--
-- THIS FILE CHANGES NO BEHAVIOUR. Nothing reads camp_families yet. It is 208's
-- shape, for the same reasons, with one difference that matters.
--
-- ─── THE ONE DIFFERENCE: FAMILIES CAN BE DELETED ────────────────────────────
-- A payment is an event — it happened, and 208's rows are append-only because a
-- payment vanishing from the document is exactly the loss the rows exist to
-- survive. A family is a RECORD, and a record can legitimately be removed.
--
-- But a whole-object client save that has lost a family is indistinguishable
-- from a deliberate deletion, and the office saves this document wholesale from
-- possibly-stale local storage. Hard-deleting on a trigger would let a stale tab
-- destroy a real family's charges.
--
-- So absence is recorded, not obeyed: `deleted_at` is stamped for a family that
-- is missing from the new document and CLEARED for one that is present again.
-- Nothing is ever destroyed, readers filter on deleted_at IS NULL, a genuine
-- deletion disappears from readers immediately, and a stale save that dropped a
-- family is undone by the next good save. The verifier reports resurrections and
-- soft-deletes separately so neither hides in a count.
--
-- WHY A TRIGGER, WHY IT MERGES, AND WHY IT DIFFS: all three for the reasons 208
-- gives. A copy some writer forgets is a copy that drifts; the writer phase puts
-- rows here the document will not have; and 203's rebuild-everything trigger
-- cost O(history) per write on a growing table and decayed throughput 84 → 26
-- per second before 206 fixed it.
--
-- SAFE TO RE-RUN. IF NOT EXISTS / CREATE OR REPLACE, and the backfill is an
-- idempotent merge.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- You will get one confirmation row. Then:
--
--   SELECT c.id AS camp_id, public.verify_camp_families(c.id) AS result
--     FROM camps c
--    WHERE EXISTS (SELECT 1 FROM camp_state_kv k
--                   WHERE k.camp_id = c.id AND k.key = 'campistryMe');
--
-- Every row must read "inSync": true with "missingFromRows": 0 and
-- "staleRows": 0. That is what says the reader swap may proceed.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_state_kv') IS NULL THEN
        v_missing := v_missing || 'table camp_state_kv'::text;
    END IF;
    IF to_regclass('public.camps') IS NULL THEN
        v_missing := v_missing || 'table camps'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_reader') THEN
        v_missing := v_missing || 'camp_reader()  → apply migrations/183_lock_down_camp_scoped_readers.sql first'::text;
    END IF;
    IF to_regclass('public.camp_families') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'camp_families'
                          AND column_name = 'family_key') THEN
        v_missing := v_missing || 'a DIFFERENT public.camp_families already exists (no family_key column) — rename it before applying this'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 211 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;


-- ─── 1. the table ───────────────────────────────────────────────────────────
-- family_key is the document's own object key, so unlike payments there is no
-- identity to derive: it is already stable and already unique per camp.
--
-- No FK to camps: written by a trigger, and an FK violation there would abort
-- the original save — 200's first live paste died on exactly that (ERROR 23503).
CREATE TABLE IF NOT EXISTS public.camp_families (
    camp_id    uuid  NOT NULL,
    family_key text  NOT NULL,
    name       text  NOT NULL DEFAULT '',          -- payload->>'name'
    camper_ids jsonb NOT NULL DEFAULT '[]'::jsonb,  -- payload->'camperIds'
    payload    jsonb NOT NULL,
    -- Absence recorded, not obeyed. See the header: a stale whole-object save
    -- looks exactly like a deletion, so nothing is destroyed. NULL means present.
    deleted_at timestamptz,
    first_seen timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, family_key)
);

-- Which families hold one of this parent's campers. GIN over camperIds, so the
-- membership test is an index probe rather than a scan of every family — the
-- same index 205 put on its projection, for the same query.
CREATE INDEX IF NOT EXISTS idx_camp_families_campers
    ON public.camp_families USING gin (camper_ids jsonb_path_ops);
-- The balance matches payments to families by NAME as well as by key.
CREATE INDEX IF NOT EXISTS idx_camp_families_name
    ON public.camp_families (camp_id, name);
-- Live families only, which is every read the app makes.
CREATE INDEX IF NOT EXISTS idx_camp_families_live
    ON public.camp_families (camp_id) WHERE deleted_at IS NULL;

-- Deny-all, like every other money table here: reads go through gated
-- SECURITY DEFINER functions, and a curious authenticated SELECT sees nothing.
ALTER TABLE public.camp_families ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_families FROM anon, authenticated;


-- ─── 2. the trigger that keeps it true ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.project_camp_families()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_new jsonb;
    v_old jsonb;
BEGIN
    -- Any save that did not touch families costs one comparison. This document
    -- is saved constantly for reasons that have nothing to do with money.
    IF TG_OP <> 'INSERT'
       AND (NEW.value -> 'families') IS NOT DISTINCT FROM (OLD.value -> 'families') THEN
        RETURN NEW;
    END IF;

    v_new := CASE WHEN jsonb_typeof(NEW.value -> 'families') = 'object'
                  THEN NEW.value -> 'families' ELSE '{}'::jsonb END;
    v_old := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb
                  WHEN jsonb_typeof(OLD.value -> 'families') = 'object'
                  THEN OLD.value -> 'families' ELSE '{}'::jsonb END;

    -- Families are already keyed, so there is no reduce step and no duplicate
    -- question — the diff is a direct key-by-key comparison. `->` on a jsonb
    -- object is a binary search over sorted keys, so this is O(n log n); an array
    -- with `= ANY` would be a linear scan per candidate and would rebuild 203's
    -- growth curve one layer down.
    INSERT INTO public.camp_families
        (camp_id, family_key, name, camper_ids, payload, deleted_at)
    SELECT NEW.camp_id,
           n.key,
           COALESCE(n.value ->> 'name', ''),
           CASE WHEN jsonb_typeof(n.value -> 'camperIds') = 'array'
                THEN n.value -> 'camperIds' ELSE '[]'::jsonb END,
           n.value,
           NULL                     -- present in this save, so alive
      FROM jsonb_each(v_new) AS n
     WHERE jsonb_typeof(n.value) = 'object'
       -- Changed, new, or previously soft-deleted and now back.
       AND ((v_old -> n.key) IS DISTINCT FROM n.value
            OR EXISTS (SELECT 1 FROM public.camp_families f
                        WHERE f.camp_id = NEW.camp_id AND f.family_key = n.key
                          AND f.deleted_at IS NOT NULL))
    ON CONFLICT (camp_id, family_key) DO UPDATE
       SET name       = EXCLUDED.name,
           camper_ids = EXCLUDED.camper_ids,
           payload    = EXCLUDED.payload,
           deleted_at = NULL,       -- a family that is back is not deleted
           updated_at = now();

    -- Gone from this save: STAMPED, never removed. Only stamp rows that are
    -- currently live, so an already-soft-deleted family keeps its original time
    -- and repeated saves do not keep rewriting it.
    UPDATE public.camp_families f
       SET deleted_at = now(), updated_at = now()
     WHERE f.camp_id = NEW.camp_id
       AND f.deleted_at IS NULL
       AND NOT (v_new ? f.family_key);

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_families() FROM public, anon, authenticated;

-- No DELETE trigger: a camp row going away does not make its families untrue,
-- and cleaning up a deleted camp stays a deliberate act. Same as 208.
DROP TRIGGER IF EXISTS trg_project_camp_families ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_families
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.project_camp_families();


-- ─── 3. the backfill ────────────────────────────────────────────────────────
-- Scoped to camps that still exist, and an idempotent merge so re-running
-- converges. deleted_at is left alone on conflict: a family the document has
-- since dropped must not be resurrected by re-pasting this file.
INSERT INTO public.camp_families
    (camp_id, family_key, name, camper_ids, payload)
SELECT kv.camp_id,
       f.key,
       COALESCE(f.value ->> 'name', ''),
       CASE WHEN jsonb_typeof(f.value -> 'camperIds') = 'array'
            THEN f.value -> 'camperIds' ELSE '[]'::jsonb END,
       f.value
  FROM camp_state_kv kv
  CROSS JOIN LATERAL jsonb_each(
         CASE WHEN jsonb_typeof(kv.value -> 'families') = 'object'
              THEN kv.value -> 'families' ELSE '{}'::jsonb END) AS f(key, value)
 WHERE kv.key = 'campistryMe'
   AND jsonb_typeof(f.value) = 'object'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
ON CONFLICT (camp_id, family_key) DO UPDATE
   SET name       = EXCLUDED.name,
       camper_ids = EXCLUDED.camper_ids,
       payload    = EXCLUDED.payload,
       updated_at = now();


-- ─── 4. the verifier ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_camp_families(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims   text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_fams     jsonb;
    v_blobCount integer := 0;
    v_liveCount integer := 0;
    v_softCount integer := 0;
    v_missing  jsonb := '[]'::jsonb;
    v_differs  jsonb := '[]'::jsonb;
    v_zombies  jsonb := '[]'::jsonb;
    v_blobCharges numeric := 0;
    v_rowCharges  numeric := 0;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    -- Gated the way 202's verifier had to be fixed to be: the SQL Editor carries
    -- no JWT at all, so camp_reader() would refuse the legitimate owner.
    -- current_user is useless here — inside SECURITY DEFINER it is the function's
    -- owner for every caller alike.
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT CASE WHEN jsonb_typeof(value -> 'families') = 'object'
                THEN value -> 'families' ELSE '{}'::jsonb END
      INTO v_fams
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_fams IS NULL THEN v_fams := '{}'::jsonb; END IF;

    SELECT count(*)::integer INTO v_blobCount
      FROM jsonb_each(v_fams) AS f WHERE jsonb_typeof(f.value) = 'object';

    SELECT count(*) FILTER (WHERE deleted_at IS NULL),
           count(*) FILTER (WHERE deleted_at IS NOT NULL)
      INTO v_liveCount, v_softCount
      FROM public.camp_families WHERE camp_id = p_camp_id;

    -- In the document and NOT live in the rows: the failure that loses a family.
    SELECT COALESCE(jsonb_agg(f.key ORDER BY f.key), '[]'::jsonb) INTO v_missing
      FROM jsonb_each(v_fams) AS f
     WHERE jsonb_typeof(f.value) = 'object'
       AND NOT EXISTS (SELECT 1 FROM public.camp_families r
                        WHERE r.camp_id = p_camp_id AND r.family_key = f.key
                          AND r.deleted_at IS NULL);

    -- Live in both, but the row disagrees with the document.
    SELECT COALESCE(jsonb_agg(f.key ORDER BY f.key), '[]'::jsonb) INTO v_differs
      FROM jsonb_each(v_fams) AS f
      JOIN public.camp_families r
        ON r.camp_id = p_camp_id AND r.family_key = f.key AND r.deleted_at IS NULL
     WHERE jsonb_typeof(f.value) = 'object'
       AND r.payload IS DISTINCT FROM f.value;

    -- Live in the rows but gone from the document. NOT a failure by itself —
    -- the writer phase creates exactly this — but it must be visible, because
    -- before that phase it means the soft-delete stamp did not fire.
    SELECT COALESCE(jsonb_agg(r.family_key ORDER BY r.family_key), '[]'::jsonb) INTO v_zombies
      FROM public.camp_families r
     WHERE r.camp_id = p_camp_id AND r.deleted_at IS NULL
       AND NOT (v_fams ? r.family_key);

    -- The number a family would notice: what they have been charged.
    SELECT COALESCE(sum(COALESCE((ch ->> 'amount')::numeric, 0)), 0) INTO v_blobCharges
      FROM jsonb_each(v_fams) AS f
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(f.value -> 'charges') = 'array'
                  THEN f.value -> 'charges' ELSE '[]'::jsonb END) AS ch
     WHERE jsonb_typeof(f.value) = 'object';

    SELECT COALESCE(sum(COALESCE((ch ->> 'amount')::numeric, 0)), 0) INTO v_rowCharges
      FROM public.camp_families r
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(r.payload -> 'charges') = 'array'
                  THEN r.payload -> 'charges' ELSE '[]'::jsonb END) AS ch
     WHERE r.camp_id = p_camp_id AND r.deleted_at IS NULL;

    RETURN jsonb_build_object(
        'success', true,
        'inSync', (jsonb_array_length(v_missing) = 0
                   AND jsonb_array_length(v_differs) = 0
                   AND jsonb_array_length(v_zombies) = 0
                   AND v_blobCharges = v_rowCharges),
        'blobFamilies', v_blobCount,
        'liveRows', v_liveCount,
        'softDeletedRows', v_softCount,
        'missingFromRows', jsonb_array_length(v_missing),
        'missingKeys', v_missing,
        'staleRows', jsonb_array_length(v_differs),
        'staleKeys', v_differs,
        'liveRowsNotInDocument', jsonb_array_length(v_zombies),
        'notInDocumentKeys', v_zombies,
        'chargedInBlob', v_blobCharges,
        'chargedInRows', v_rowCharges,
        'note', 'softDeletedRows > 0 is normal once a family has been removed — '
             || 'absence is stamped, never destroyed, so a stale whole-object save '
             || 'cannot erase a real family. liveRowsNotInDocument should be 0 '
             || 'until the writer phase lands; before then it means the soft-delete '
             || 'stamp did not fire.',
        'repair', 're-paste migrations/211_families_into_rows.sql — its backfill converges');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_families(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_families(uuid) TO authenticated, service_role;


-- ─── what this file deliberately does NOT do ────────────────────────────────
--   * No reader moves. 205's camp_billing_families still feeds the parent's
--     slice; the office still reads the document.
--   * No writer moves. All sixteen still take the camp-wide lock. Nothing is
--     faster yet — this earns the right to change them.
--   * 205's camp_billing_families is left alone, so a rollback has somewhere to
--     land.


-- ─── did it work? ───────────────────────────────────────────────────────────
-- A statement, not a comment, and last: a rolled-back paste leaves nothing and
-- prints nothing, so the first sign of trouble used to be the NEXT query failing
-- on a function that "does not exist".
SELECT 'migration 211 applied'                                            AS status,
       to_regprocedure('public.verify_camp_families(uuid)') IS NOT NULL    AS verify_ready,
       (SELECT count(*) FROM public.camp_families WHERE deleted_at IS NULL) AS live_family_rows,
       (SELECT count(*) FROM public.camp_families WHERE deleted_at IS NOT NULL) AS soft_deleted_rows,
       (SELECT count(DISTINCT camp_id) FROM public.camp_families)          AS camps_with_families,
       (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'trg_project_camp_families' AND NOT tgisinternal)  AS triggers_installed;
