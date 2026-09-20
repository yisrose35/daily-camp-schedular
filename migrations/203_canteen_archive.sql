-- ============================================================================
-- Migration 203: every canteen transaction that reaches the cloud survives it.
--
-- ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
-- campistrySnacks is one jsonb blob per camp holding every account and an
-- UNBOUNDED, prepend-only transactions array. Every writer — the POS register,
-- the office manager, a parent deposit, the shop, auto-reload — rewrites the
-- whole value, and several of them are CLIENTS doing read-merge-write from
-- possibly-stale local storage. cloudSaveSnacks' own comment names the risk:
-- "a naive full-blob upsert here can clobber a parent deposit". The merge
-- defends the happy path, but a clobber that slips through loses MONEY HISTORY
-- irrecoverably, because the blob is the only copy — and balances are
-- event-sourced from that very array, so lost rows are lost dollars.
--
-- This file gives the ledger a second, append-only home in rows:
-- canteen_transactions, filled by a trigger on camp_state_kv. Whatever writes
-- the blob — RPC, office tab, POS register, stale client — the transactions it
-- lands are archived in the same transaction. From then on a clobbered blob
-- costs the SCREEN some history, never the ledger.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: cap or trim the blob's array. The
-- clients recompute every account balance as the SUM of that array
-- (_reconcileBalances in campistry_snacks.js and campistry_snacks_pos.js,
-- with camperId-then-name attribution). Truncate the array server-side and the
-- next office save silently rewrites every balance in the camp — wrong by
-- exactly the trimmed rows. Compaction therefore has to be a CLIENT feature
-- (the office's own reconcile math folding old rows into a carried-forward
-- figure, with this archive as the floor under it), not a trigger's judgement.
-- Anyone tempted to add a cap here: that is the landmine, step around it.
--
-- ── IDENTITY: THE SIGNATURE, NOT AN ID ─────────────────────────────────────
-- Canteen transactions carry no ids. The entire client fleet already dedupes
-- them by one content signature (_txSig, identical in both files):
--
--     [date, time, camper, type, amount, items].join('|')
--
-- with null/undefined rendering as ''. That signature IS the app's definition
-- of "the same transaction" — every merge collapses signature-equal rows to
-- one. So the archive keys on the same signature, computed the same way, and
-- is thereby exactly as granular as the app itself: two truly identical
-- purchases in the same displayed minute collapse in every client merge
-- already, and collapse here the same way. Inventing ids instead would DESYNC
-- from the fleet: the merge keeps whichever copy it saw first, so a
-- server-stamped id gets dropped by the next stale save and re-stamped
-- differently — one transaction, many archive rows.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own.
-- Idempotent; the backfill converges and doubles as the repair tool.
-- ============================================================================

-- ─── 1. the archive ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.canteen_transactions (
    camp_id    uuid        NOT NULL,
    sig        text        NOT NULL,
    camper     text        NOT NULL DEFAULT '',
    camper_id  text,
    tx_type    text        NOT NULL DEFAULT '',
    amount     numeric     NOT NULL DEFAULT 0,
    tx_date    text        NOT NULL DEFAULT '',   -- as the app stores it (YYYY-MM-DD)
    tx_time    text        NOT NULL DEFAULT '',   -- as the app stores it ('3:41 PM')
    items      text        NOT NULL DEFAULT '',
    payload    jsonb       NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, sig)
    -- No FK to camps, same reasoning as 202: this table is written by a
    -- trigger, and an FK violation there aborts the ORIGINAL blob save.
);

CREATE INDEX IF NOT EXISTS idx_canteen_tx_camp_camper
    ON public.canteen_transactions (camp_id, camper, tx_date DESC);

-- Deny-all, like 202's projections: reads go through the gated RPC below, and
-- a curious authenticated SELECT sees zero rows rather than a camp's ledger.
ALTER TABLE public.canteen_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.canteen_transactions FROM anon;
GRANT SELECT ON public.canteen_transactions TO authenticated;

-- The signature, byte-for-byte the client's _txSig. JS Array.join renders
-- null/undefined as '' and numbers without trailing zeros — ->> renders JSON
-- values the same way, and COALESCE supplies the ''.
CREATE OR REPLACE FUNCTION public.canteen_tx_sig(p_tx jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT concat_ws('|',
        COALESCE(p_tx ->> 'date',   ''),
        COALESCE(p_tx ->> 'time',   ''),
        COALESCE(p_tx ->> 'camper', ''),
        COALESCE(p_tx ->> 'type',   ''),
        COALESCE(p_tx ->> 'amount', ''),
        COALESCE(p_tx ->> 'items',  ''));
$$;
REVOKE ALL ON FUNCTION public.canteen_tx_sig(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_tx_sig(jsonb) TO authenticated, service_role;


-- amount can be anything a client ever wrote into a jsonb array. One malformed
-- value must cost that one field its precision, not the save its life — a
-- trigger throw here would abort a REAL purchase at the register.
CREATE OR REPLACE FUNCTION public._num_or_null(p text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN p::numeric;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._num_or_null(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._num_or_null(text) TO authenticated, service_role;


-- ─── 2. the trigger ─────────────────────────────────────────────────────────
-- AFTER, row-level, campistrySnacks only, and only when the transactions
-- branch actually changed — an inventory or config save costs one comparison.
-- SECURITY DEFINER because the blob's writers (office tabs under RLS) have no
-- rights on the archive.
--
-- APPEND-ONLY ON PURPOSE: rows are never updated and never deleted here. A
-- transaction vanishing from the blob is exactly the loss this table exists
-- to survive, so the archive must not follow deletions — which also means a
-- deleted camp's rows stay until cleaned up deliberately, and that is the
-- right trade for a money ledger.
CREATE OR REPLACE FUNCTION public.archive_canteen_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_txs jsonb;
BEGIN
    IF TG_OP <> 'INSERT'
       AND (NEW.value -> 'transactions') IS NOT DISTINCT FROM (OLD.value -> 'transactions') THEN
        RETURN NEW;
    END IF;

    v_txs := CASE WHEN jsonb_typeof(NEW.value -> 'transactions') = 'array'
                  THEN NEW.value -> 'transactions' ELSE '[]'::jsonb END;

    INSERT INTO public.canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    SELECT DISTINCT ON (public.canteen_tx_sig(t))
           NEW.camp_id,
           public.canteen_tx_sig(t),
           COALESCE(t ->> 'camper', ''),
           NULLIF(t ->> 'camperId', ''),
           COALESCE(t ->> 'type', ''),
           COALESCE(public._num_or_null(t ->> 'amount'), 0),
           COALESCE(t ->> 'date', ''),
           COALESCE(t ->> 'time', ''),
           COALESCE(t ->> 'items', ''),
           t
      FROM jsonb_array_elements(v_txs) AS t
     WHERE jsonb_typeof(t) = 'object'
    ON CONFLICT (camp_id, sig) DO NOTHING;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.archive_canteen_transactions() FROM public, anon, authenticated;


DROP TRIGGER IF EXISTS trg_archive_canteen_tx ON public.camp_state_kv;
CREATE TRIGGER trg_archive_canteen_tx
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistrySnacks')
EXECUTE FUNCTION public.archive_canteen_transactions();


-- ─── 3. backfill — everything already in the blobs ──────────────────────────
-- Scoped to camps that still exist (200's first-paste lesson). ON CONFLICT DO
-- NOTHING keeps a re-run convergent, so re-pasting this file is the repair.
INSERT INTO public.canteen_transactions
    (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
SELECT DISTINCT ON (kv.camp_id, public.canteen_tx_sig(t))
       kv.camp_id,
       public.canteen_tx_sig(t),
       COALESCE(t ->> 'camper', ''),
       NULLIF(t ->> 'camperId', ''),
       COALESCE(t ->> 'type', ''),
       COALESCE(public._num_or_null(t ->> 'amount'), 0),
       COALESCE(t ->> 'date', ''),
       COALESCE(t ->> 'time', ''),
       COALESCE(t ->> 'items', ''),
       t
  FROM camp_state_kv kv
 CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(kv.value -> 'transactions') = 'array'
             THEN kv.value -> 'transactions' ELSE '[]'::jsonb END) AS t
 WHERE kv.key = 'campistrySnacks'
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
   AND jsonb_typeof(t) = 'object'
ON CONFLICT (camp_id, sig) DO NOTHING;


-- ─── 4. the history read, for when the clients want it ──────────────────────
-- The archive's read path, gated the way get_canteen_accounts (183) gates the
-- blob: staff see the camp, a parent sees only their own children, anyone else
-- sees a refusal. Newest first, capped in the subquery — never after the
-- aggregate (the migration-201 defect).
CREATE OR REPLACE FUNCTION public.get_canteen_history(
    p_camp_id uuid,
    p_camper  text DEFAULT NULL,
    p_before  text DEFAULT NULL,   -- tx_date upper bound (exclusive) for paging
    p_limit   integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_mine   jsonb;
    v_staff  boolean := public.camp_staff_member(p_camp_id);
    v_rows   jsonb;
    v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
BEGIN
    IF NOT v_staff THEN
        v_mine := public.camp_parent_campers(p_camp_id);
        IF jsonb_array_length(v_mine) = 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
        END IF;
        -- A parent may only page their own children. No p_camper means all of
        -- theirs; a p_camper outside their family is a refusal, not a filter.
        IF p_camper IS NOT NULL AND NOT v_mine ? p_camper THEN
            RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
        END IF;
    END IF;

    SELECT COALESCE(jsonb_agg(x.payload ORDER BY x.tx_date DESC, x.first_seen DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT ct.payload, ct.tx_date, ct.first_seen
          FROM public.canteen_transactions ct
         WHERE ct.camp_id = p_camp_id
           AND (p_camper IS NULL OR ct.camper = p_camper)
           AND (v_staff OR v_mine ? ct.camper)
           AND (p_before IS NULL OR ct.tx_date < p_before)
         ORDER BY ct.tx_date DESC, ct.first_seen DESC
         LIMIT v_limit
      ) x;

    RETURN jsonb_build_object('success', true, 'transactions', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.get_canteen_history(uuid, text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_canteen_history(uuid, text, text, integer) TO authenticated, service_role;


-- ─── 5. the verifier ────────────────────────────────────────────────────────
-- One question: is every transaction currently in the blob archived? (Blob ⊆
-- archive. Never the reverse — the archive OUTLIVING the blob is its purpose.)
-- Gated like 202's verifier, including for a direct database session: the SQL
-- Editor carries no JWT, and "no claims at all" can only be a direct session,
-- never an API caller.
CREATE OR REPLACE FUNCTION public.verify_canteen_archive(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value    jsonb;
    v_total    integer := 0;
    v_missing  integer := 0;
    v_archived integer;
    v_claims   text := NULLIF(current_setting('request.jwt.claims', true), '');
    t          jsonb;
BEGIN
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value INTO v_value FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    FOR t IN SELECT * FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(v_value -> 'transactions') = 'array'
                      THEN v_value -> 'transactions' ELSE '[]'::jsonb END) LOOP
        IF jsonb_typeof(t) <> 'object' THEN CONTINUE; END IF;
        v_total := v_total + 1;
        IF NOT EXISTS (SELECT 1 FROM public.canteen_transactions ct
                        WHERE ct.camp_id = p_camp_id
                          AND ct.sig = public.canteen_tx_sig(t)) THEN
            v_missing := v_missing + 1;
        END IF;
    END LOOP;

    SELECT count(*)::integer INTO v_archived
      FROM public.canteen_transactions WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'inSync', v_missing = 0,
        'blobTransactions', v_total,
        'missingFromArchive', v_missing,
        'archivedTotal', v_archived,
        'note', 'archivedTotal may exceed blobTransactions — the archive keeps what the blob has lost, which is the point',
        'repair', 're-paste migrations/203_canteen_archive.sql — its backfill converges');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_archive(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_archive(uuid) TO authenticated, service_role;


-- ─── Sanity checks ──────────────────────────────────────────────────────────
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.camp_state_kv'::regclass AND NOT tgisinternal;
--   -- expect trg_archive_canteen_tx alongside 202's two projection triggers
--
--   SELECT public.verify_canteen_archive('<camp id>');   -- inSync: true
