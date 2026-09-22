-- ============================================================================
-- 218 — the canteen reader moves onto the rows
--
-- 217 built camp_canteen_accounts and a trigger keeps it true. This points the
-- one gated reader at it. The blob is still the truth and every writer still
-- takes the camp-wide lock; 219 does that. Reading first is the same order
-- 208 → 210 → 213 used for payments, and for the same reason: if reads and
-- writes move together and something breaks, there is no way to tell which
-- half did it.
--
-- THE OUTPUT SHAPE DOES NOT CHANGE. campistry_snacks.js consumes
-- { success, accounts: { "<camper name>": {...} }, transactions: [...] }
-- and this returns exactly that, keyed the same way. The rows are an
-- implementation detail of where the numbers come from.
--
-- TWO THINGS THAT WOULD SILENTLY BREAK PARENTS, AND WHAT IS DONE ABOUT THEM:
--
--   1. 353 of this project's 373 accounts are UNATTRIBUTED — person_id NULL,
--      because the season reset cleared the roster that explained them. A
--      reader that matched only on person_id would show those parents nothing
--      at all, and a blank canteen balance reads as "no money", not as "we
--      lost track of your child". So the match is person_id OR, where the row
--      has no person_id, the account key. The name path is the fallback, not
--      the rule, and it disappears on its own as attribution is repaired.
--
--   2. camp_parent_campers() returns camper NAMES, so a parent whose child was
--      renamed cannot see their own child's balance today. Resolving those
--      names through camp_people to person_ids fixes that as a side effect:
--      the id follows a rename, the name does not.
--
-- TRANSACTIONS STILL COME FROM THE BLOB. 203's canteen_transactions is the
-- ledger and is the right long-term source, but moving accounts and the ledger
-- in one file would again leave two suspects for one failure. 219 moves it
-- with the writers that populate it.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction; idempotent.
-- Requires 216 and 217.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_canteen_accounts') THEN
        RAISE EXCEPTION 'camp_canteen_accounts is missing — apply 217 before this file';
    END IF;
END $$;

-- No LOCK TABLE here: this file creates no trigger and takes no DDL lock on a
-- projection table, so it cannot form the cycle 216 hit. See 216 section 0b.


-- ─── 1. one account, rendered the way the client expects it ─────────────────
-- The columns are authoritative — they are what 219 will write — but the
-- payload carries fields this migration knows nothing about (autoReload
-- config, byop card handles, whatever a later feature adds). Rebuilding the
-- object from columns alone would quietly drop them, which is how a canteen
-- auto-reload stops working with no error anywhere.
--
-- So: payload first, columns layered on top. Unknown fields survive, known
-- fields are the row's.
CREATE OR REPLACE FUNCTION public._canteen_account_json(p_row public.camp_canteen_accounts)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(p_row.payload, '{}'::jsonb)
           || jsonb_build_object('balance', p_row.balance)
           || CASE WHEN p_row.daily_limit   IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('dailyLimit',   p_row.daily_limit)   END
           || CASE WHEN p_row.credit_limit  IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('creditLimit',  p_row.credit_limit)  END
           || CASE WHEN p_row.balance_floor IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('balanceFloor', p_row.balance_floor) END
           || jsonb_build_object('spentToday', p_row.spent_today)
           || CASE WHEN p_row.spent_on IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('spentOn', p_row.spent_on::text) END
$$;
REVOKE ALL ON FUNCTION public._canteen_account_json(public.camp_canteen_accounts)
    FROM public, anon, authenticated;


-- ─── 2. the reader ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_canteen_accounts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value jsonb;
    v_mine  jsonb;
    v_ids   bigint[];
    v_accts jsonb := '{}'::jsonb;
    v_txs   jsonb;
BEGIN
    -- Staff first: the POS and the Snacks dashboard need the whole camp, and a
    -- staff member who is also a parent here should not be cut down to their
    -- own child. Unchanged from 183 — only the source of the numbers moved.
    IF public.camp_staff_member(p_camp_id) THEN
        SELECT COALESCE(jsonb_object_agg(a.account_key, public._canteen_account_json(a)), '{}'::jsonb)
          INTO v_accts
          FROM camp_canteen_accounts a
         WHERE a.camp_id = p_camp_id AND a.deleted_at IS NULL;

        SELECT value INTO v_value FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

        RETURN jsonb_build_object(
            'success', true,
            'accounts', v_accts,
            'transactions', COALESCE(v_value->'transactions', '[]'::jsonb));
    END IF;

    v_mine := public.camp_parent_campers(p_camp_id);
    IF jsonb_array_length(v_mine) = 0 THEN
        -- No relationship with this camp at all. This used to return the lot.
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- The parent's campers as IDS. A name that resolves to a person carries
    -- through a rename; one that does not is still matched by key below, so a
    -- camper missing from the roster does not cost their parent the balance.
    SELECT COALESCE(array_agg(DISTINCT p.person_id), '{}')
      INTO v_ids
      FROM jsonb_array_elements_text(v_mine) AS mine(nm)
      JOIN camp_people p
        ON p.camp_id = p_camp_id AND p.kind = 'camper'
       AND lower(btrim(p.source_key)) = lower(btrim(mine.nm));

    SELECT COALESCE(jsonb_object_agg(a.account_key, public._canteen_account_json(a)), '{}'::jsonb)
      INTO v_accts
      FROM camp_canteen_accounts a
     WHERE a.camp_id = p_camp_id
       AND a.deleted_at IS NULL
       AND (
            (a.person_id IS NOT NULL AND a.person_id = ANY (v_ids))
            -- The fallback, and the reason 353 parents still see a balance.
            -- Deliberately only for rows with no id: once an account belongs
            -- to a child, a matching NAME must not grant anybody else sight of
            -- it — that is how a renamed camper's balance would leak to the
            -- family that inherited the name.
            OR (a.person_id IS NULL AND v_mine ? a.account_key)
       );

    -- ...and only their transactions. A canteen ledger is a list of what other
    -- people's children bought, which is nobody else's business. Still read
    -- from the blob: 219 moves the ledger with the writers that fill it.
    SELECT value INTO v_value FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistrySnacks';

    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_txs
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(v_value->'transactions') = 'array'
                  THEN v_value->'transactions' ELSE '[]'::jsonb END) t
     WHERE v_mine ? COALESCE(t->>'camper', '');

    RETURN jsonb_build_object('success', true, 'accounts', v_accts,
                              'transactions', v_txs, 'scope', 'parent');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_canteen_accounts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_canteen_accounts(uuid) TO authenticated, service_role;


-- ─── 3. the verifier ────────────────────────────────────────────────────────
-- Compares what the rows would serve a STAFF member against what the blob
-- holds, account by account. The parent branch cannot be checked this way —
-- it depends on who is asking — so what is asserted for it instead is the
-- property that matters: every account a parent could previously see, they can
-- still see.
CREATE OR REPLACE FUNCTION public.verify_canteen_read_swap(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_blob  jsonb;
    v_diff  jsonb;
    v_lost  jsonb;
BEGIN
    -- Gated the way 202's verifier had to be fixed to be, and 211's after it:
    -- the SQL Editor carries no JWT at all, so camp_reader() refuses the
    -- legitimate owner running this by hand — which is the ONLY way anyone
    -- runs it. current_user is useless here: inside SECURITY DEFINER it is the
    -- function's owner for every caller alike.
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('error', 'not_your_camp');
    END IF;

    SELECT CASE WHEN jsonb_typeof(value -> 'accounts') = 'object'
                THEN value -> 'accounts' ELSE '{}'::jsonb END
      INTO v_blob FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    v_blob := COALESCE(v_blob, '{}'::jsonb);

    -- Every number the client actually uses, from both sides, compared as
    -- NUMBERS rather than as jsonb — the blob stores 5 and 5.00 and "5"
    -- interchangeably, and none of those is a discrepancy.
    --
    -- ABSENT MEANS DIFFERENT THINGS FOR DIFFERENT FIELDS, which is the whole
    -- reason this is two cases and not one:
    --
    --   balance, spentToday — counters. Absent is 0. The blob omits
    --     spentToday until a camper spends something, and a row that says 0
    --     agrees with it; calling that a difference reported three phantom
    --     discrepancies on the first run of this verifier.
    --
    --   dailyLimit, creditLimit, balanceFloor — limits. Absent means NO
    --     limit; 0 means no spending at all. Coalescing these to 0 would call
    --     an unlimited account identical to a frozen one, and would do it
    --     silently, in the direction of refusing a child at the register.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account', e.key,
               'field',   f.field,
               'inBlob',  e.value -> f.field,
               'inRow',   public._canteen_account_json(a) -> f.field)), '[]'::jsonb)
      INTO v_diff
      FROM jsonb_each(v_blob) e
      JOIN camp_canteen_accounts a
        ON a.camp_id = p_camp_id AND a.account_key = e.key AND a.deleted_at IS NULL
      CROSS JOIN LATERAL (VALUES ('balance', true), ('spentToday', true),
                                 ('dailyLimit', false), ('creditLimit', false),
                                 ('balanceFloor', false)) AS f(field, is_counter)
     WHERE (CASE WHEN f.is_counter
                 THEN COALESCE(NULLIF(e.value ->> f.field, '')::numeric, 0)
                 ELSE NULLIF(e.value ->> f.field, '')::numeric END)
           IS DISTINCT FROM
           (CASE WHEN f.is_counter
                 THEN COALESCE(NULLIF(public._canteen_account_json(a) ->> f.field, '')::numeric, 0)
                 ELSE NULLIF(public._canteen_account_json(a) ->> f.field, '')::numeric END);

    -- An account in the blob that the rows cannot serve is a parent staring at
    -- a blank balance. Named, because which one matters.
    SELECT COALESCE(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb)
      INTO v_lost
      FROM jsonb_each(v_blob) e
     WHERE jsonb_typeof(e.value) = 'object'
       AND NOT EXISTS (SELECT 1 FROM camp_canteen_accounts a
                        WHERE a.camp_id = p_camp_id AND a.account_key = e.key
                          AND a.deleted_at IS NULL);

    RETURN jsonb_build_object(
        'accountsInBlob',  (SELECT count(*) FROM jsonb_each(v_blob) e
                             WHERE jsonb_typeof(e.value) = 'object'),
        'accountsServed',  (SELECT count(*) FROM camp_canteen_accounts
                             WHERE camp_id = p_camp_id AND deleted_at IS NULL),
        'sameValues',      (v_diff = '[]'::jsonb),
        'differences',     v_diff,
        'nobodyLosesSight', (v_lost = '[]'::jsonb),
        'accountsLost',    v_lost,
        'servedByName',    (SELECT count(*) FROM camp_canteen_accounts
                             WHERE camp_id = p_camp_id AND deleted_at IS NULL
                               AND person_id IS NULL),
        'servedById',      (SELECT count(*) FROM camp_canteen_accounts
                             WHERE camp_id = p_camp_id AND deleted_at IS NULL
                               AND person_id IS NOT NULL)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_read_swap(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_read_swap(uuid) TO authenticated, service_role;


-- ─── what this file deliberately does NOT do ────────────────────────────────
-- * No writer moves. Every sale still takes the camp-wide lock on the whole
--   snacks document, and the ~42/second ceiling is still there. 219.
-- * The staff client still reads camp_state_kv DIRECTLY
--   (campistry_snacks.js:306, :1668) and writes the whole blob back with a
--   compare-and-set (:1773). That is correct while the blob is the truth, and
--   it is why 219 cannot simply stop writing it — the client has to move in
--   the same release, or the POS will read balances frozen at the deploy.
-- * Transactions still come from the blob, for both branches.


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 218 applied'                                              AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname = 'get_canteen_accounts'
           AND pg_get_functiondef(p.oid) ~ 'camp_canteen_accounts')         AS reader_on_rows,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname = 'get_canteen_accounts'
           AND pg_get_functiondef(p.oid) ~ 'camp_people')                   AS renames_followed,
       (SELECT count(*) FROM camp_canteen_accounts
         WHERE deleted_at IS NULL AND person_id IS NULL)                    AS still_served_by_name;
