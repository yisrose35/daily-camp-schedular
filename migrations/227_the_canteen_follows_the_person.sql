-- ============================================================================
-- 227 — the canteen follows the person, and a renamed camper can buy again
--
-- THE DEFECT, AND IT IS NOT A QUIET ONE. 217 put a UNIQUE index on
-- camp_canteen_accounts (camp_id, person_id) WHERE person_id IS NOT NULL — one
-- attributed account per child, which is right. 219 routed all thirteen canteen
-- writers through canteen_account_lock, which opens with:
--
--     INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, …)
--     VALUES (p_camp_id, p_key, public._attribute_canteen_account(p_camp_id, p_key), …)
--     ON CONFLICT (camp_id, account_key) DO NOTHING;
--
-- The ON CONFLICT target is (camp_id, account_key). The constraint that gets
-- violated after a rename is the OTHER one.
--
-- Camper 880's account was opened under 'Ayala Weiss'. The camp renames her to
-- 'Ayala Weiss-Katz' — 216 relabels the row, so her id does not move and the new
-- spelling resolves to 880. The till now shows the new name, so the next sale
-- calls canteen_account_lock with 'Ayala Weiss-Katz', and the INSERT tries to
-- create a SECOND row carrying person_id 880. ON CONFLICT (camp_id, account_key)
-- does not cover uq_canteen_accounts_person, so this is not a no-op:
--
--     ERROR: duplicate key value violates unique constraint "uq_canteen_accounts_person"
--
-- The exception aborts the transaction, so the purchase does not happen, the
-- deposit does not happen, and the limit change does not happen. EVERY canteen
-- operation for that child fails, for the rest of the season, until somebody
-- renames her back. Thirteen functions, all of them, because they all go through
-- the one lock.
--
-- THE FIX IS THE SAME SHAPE AS 226'S. One helper, in the one place every writer
-- already funnels through. canteen_account_key_for() answers "which account does
-- this name's money actually live on", and the lock, the save and the ledger post
-- all ask it before they touch anything. So the sale for 'Ayala Weiss-Katz' lands
-- on the account opened under 'Ayala Weiss', which is hers.
--
-- WHY THERE IS NO MERGE TOOL. uq_canteen_accounts_person is why: a child cannot
-- have two attributed accounts, because the second one has never been insertable.
-- There is no split balance to combine — the money is all on the one row, and
-- what was broken was reaching it. This is the rare case where a constraint doing
-- its job turned a silent data-splitting bug into a loud outage, and the loud
-- version is the one that leaves nothing to repair.
--
-- THE LABEL IS REFRESHED, THE KEY IS NOT. account_key is the primary key and it
-- is what canteen_transactions.camper holds for every historical sale, so moving
-- it would orphan the ledger. camper_name — the label column beside it — is
-- updated to the current roster key on the first sale after a rename, so reports
-- and print sheets show the child's name as it is now. Guarded by IS DISTINCT
-- FROM, for the reason 206 exists: an unconditional write per sale is how the
-- canteen decayed from 84 to 26 sales a second.
--
-- WHAT THIS FIXES AND WHAT IT DOES NOT. Every writer that reaches
-- canteen_account_lock is fixed, which is the till: submit_canteen_purchase, the
-- processor and Stripe credits, the refunds, update_canteen_autoreload_state,
-- merge_canteen_autoreload_card. Those are the loud ones — a register refusing
-- every sale for one child.
--
-- FIVE PARENT-FACING ONES ARE NOT FIXED HERE, because they never get as far as
-- the lock. submit_canteen_deposit, submit_shop_order, set_canteen_limits,
-- set_canteen_auto_reload and use_family_card_for_canteen_auto_reload each carry
-- their own copy of
--
--     IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name)
--
-- the same line 224 replaced and 225 found in three more places, so a renamed
-- camper's parent is refused with camper_not_on_invite before any account is
-- touched. Fixing them means restating five bodies that move money, so it is its
-- own file with its own money-equivalence tests rather than a rider on this one.
--
-- AND THE HISTORY FOLLOWS TOO. get_canteen_history scoped a parent to
-- v_mine ? ct.camper — their invite's camper NAMES against the ledger's account
-- key. Refresh the invite after a rename and a parent can no longer see their own
-- child's spending; refresh neither and the account is unreachable by the name
-- they see. It now scopes by person id, which canteen_transactions has carried
-- since 219.
--
-- PERFORMANCE. Two extra index probes per canteen operation: one on
-- camp_people (camp_id, kind, source_key), one on the unique index above. Worth
-- re-measuring with the load test's canteen phase, which last read 48 rps at 6
-- registers and 81 at 12.
--
-- HOW TO APPLY. Paste into the SQL Editor after 226. One transaction,
-- idempotent. Then read verify_canteen_identity():
-- `accounts_keyed_under_an_old_name` is how many children were affected. It does
-- not fall after the fix — the key is deliberately left alone — but every one of
-- them is reachable again.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'canteen_account_lock') THEN
        RAISE EXCEPTION 'canteen_account_lock is missing — apply migration 219 before this file';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                    WHERE schemaname = 'public' AND indexname = 'uq_canteen_accounts_person') THEN
        -- Without it a child CAN hold two attributed accounts, and then the
        -- translation below has to choose between two balances. This file is
        -- written on the assumption the constraint exists, so it says so.
        RAISE EXCEPTION 'uq_canteen_accounts_person is missing — apply migration 217 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. which account does this name's money live on ────────────────────────
-- The whole file, in one function. Every canteen writer reaches it through the
-- lock, the save and the ledger post.
--
-- It is deliberately NOT a heuristic. uq_canteen_accounts_person means a child
-- has at most one attributed account, so there is exactly one right answer and
-- one index probe finds it:
--
--   * the name does not resolve to anybody     → the name, unchanged. A till
--     showing a stale spelling still reaches the account opened under it, which
--     is what keeps this file from breaking the ordinary case.
--   * it resolves, and that child has an account → that account's key, whatever
--     spelling it was opened under. This is the fix.
--   * it resolves and they have no account yet   → the name, so the first
--     purchase opens one, exactly as before.
CREATE OR REPLACE FUNCTION public.canteen_account_key_for(p_camp_id uuid, p_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_person bigint;
    v_key    text;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(btrim(p_key), '') = '' THEN
        RETURN p_key;
    END IF;

    v_person := public.camp_person_by_name(p_camp_id, p_key);
    IF v_person IS NULL THEN
        RETURN p_key;
    END IF;

    SELECT a.account_key INTO v_key
      FROM camp_canteen_accounts a
     WHERE a.camp_id = p_camp_id AND a.person_id = v_person;

    RETURN COALESCE(v_key, p_key);
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_key_for(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_account_key_for(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.canteen_account_key_for(uuid, text) IS
    'The account_key a name''s money actually lives on. Returns the name unchanged when it resolves to nobody or to a child with no account yet.';


-- ─── 2. the lock ────────────────────────────────────────────────────────────
-- Byte-for-byte 219's function with the translation in front of it, so every
-- writer's money arithmetic is untouched. The two additions are the translated
-- key and the label refresh.
CREATE OR REPLACE FUNCTION public.canteen_account_lock(p_camp_id uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row   camp_canteen_accounts;
    v_key   text;
    v_label text;
BEGIN
    IF p_camp_id IS NULL OR p_key IS NULL OR btrim(p_key) = '' THEN
        RETURN NULL;
    END IF;

    -- The account this name's money is on, which after a rename is not this
    -- name. Without it the INSERT below violates uq_canteen_accounts_person and
    -- the whole sale is aborted.
    v_key := public.canteen_account_key_for(p_camp_id, p_key);

    INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, payload)
    VALUES (p_camp_id, v_key,
            public._attribute_canteen_account(p_camp_id, v_key),
            v_key, '{}'::jsonb)
    ON CONFLICT (camp_id, account_key) DO NOTHING;

    -- THE lock, and the whole point of 219: one camper's row, not the camp's
    -- document. Deleting `FOR UPDATE` here breaks no test and cannot — a row
    -- lock is invisible to a single connection, and the behaviour test runs in
    -- one. What a lost lock would cost: two registers ringing up the SAME
    -- camper at the same instant would both read the balance before either
    -- wrote, and one sale would be given away free.
    SELECT * INTO v_row FROM camp_canteen_accounts
     WHERE camp_id = p_camp_id AND account_key = v_key
     FOR UPDATE;

    IF NOT FOUND THEN RETURN NULL; END IF;

    -- A stamped account coming back to life: somebody is putting money on it
    -- again, so it is present again. Absence was recorded, not obeyed.
    IF v_row.deleted_at IS NOT NULL THEN
        UPDATE camp_canteen_accounts SET deleted_at = NULL, updated_at = now()
         WHERE camp_id = p_camp_id AND account_key = v_key;
    END IF;

    -- The label follows the rename even though the key cannot: account_key is
    -- the primary key and canteen_transactions.camper holds it for every
    -- historical sale. Guarded, because an unconditional write per sale is how
    -- 203's trigger decayed the canteen from 84 to 26 sales a second before 206.
    IF v_row.person_id IS NOT NULL THEN
        v_label := public.camp_person_label(p_camp_id, v_row.person_id);
        IF v_label IS NOT NULL AND v_row.camper_name IS DISTINCT FROM v_label THEN
            UPDATE camp_canteen_accounts SET camper_name = v_label, updated_at = now()
             WHERE camp_id = p_camp_id AND account_key = v_key;
            v_row.camper_name := v_label;
        END IF;
    END IF;

    RETURN public._canteen_account_json(v_row);
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_lock(uuid, text) FROM public, anon, authenticated;


-- ─── 3. the save ────────────────────────────────────────────────────────────
-- Must translate identically, or a writer that locked the account opened under
-- the old name would save to a new row under the new one — a lost write, which
-- is the shape this whole chain keeps finding.
CREATE OR REPLACE FUNCTION public.canteen_account_save(p_camp_id uuid, p_key text, p_acct jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    INSERT INTO camp_canteen_accounts AS a
        (camp_id, account_key, person_id, camper_name, balance, daily_limit,
         credit_limit, balance_floor, spent_today, spent_on, payload)
    SELECT
        p_camp_id, k.key,
        public._attribute_canteen_account(p_camp_id, k.key),
        COALESCE(public.camp_person_label(p_camp_id,
                     public._attribute_canteen_account(p_camp_id, k.key)), k.key),
        COALESCE(NULLIF(p_acct ->> 'balance', '')::numeric, 0),
        NULLIF(p_acct ->> 'dailyLimit',   '')::numeric,
        NULLIF(p_acct ->> 'creditLimit',  '')::numeric,
        NULLIF(p_acct ->> 'balanceFloor', '')::numeric,
        COALESCE(NULLIF(p_acct ->> 'spentToday', '')::numeric, 0),
        NULLIF(p_acct ->> 'lastSpendDate', '')::date,
        p_acct
      FROM (SELECT public.canteen_account_key_for(p_camp_id, p_key) AS key) k
    ON CONFLICT (camp_id, account_key) DO UPDATE SET
        balance       = COALESCE(NULLIF(p_acct ->> 'balance', '')::numeric, 0),
        daily_limit   = NULLIF(p_acct ->> 'dailyLimit',   '')::numeric,
        credit_limit  = NULLIF(p_acct ->> 'creditLimit',  '')::numeric,
        balance_floor = NULLIF(p_acct ->> 'balanceFloor', '')::numeric,
        spent_today   = COALESCE(NULLIF(p_acct ->> 'spentToday', '')::numeric, 0),
        spent_on      = NULLIF(p_acct ->> 'lastSpendDate', '')::date,
        payload       = p_acct,
        -- Saving to a stamped account revives it. Same rule as the lock.
        deleted_at    = NULL,
        updated_at    = now();
$$;
REVOKE ALL ON FUNCTION public.canteen_account_save(uuid, text, jsonb)
    FROM public, anon, authenticated;


-- ─── 4. the ledger post ─────────────────────────────────────────────────────
-- Same translation, so a sale's ledger row is filed under the same key as the
-- account it moved. Without it the account and its history part company at the
-- moment of a rename.
CREATE OR REPLACE FUNCTION public.canteen_post(
    p_camp_id uuid,
    p_key     text,
    p_tx      jsonb,
    p_sig     text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- The account this sale actually moved.
    v_key text := public.canteen_account_key_for(p_camp_id, p_key);
    -- md5(), not digest(): a core pg_catalog function, so it resolves under the
    -- pinned search_path this function deliberately sets. 219 used digest() from
    -- pgcrypto, which Supabase installs in the `extensions` schema, and every
    -- purchase failed at runtime — see migration 221.
    --
    -- clock_timestamp(), not now(): now() is the TRANSACTION clock, so two posts
    -- for the same camper and amount inside one transaction would hash
    -- identically and the second would be swallowed by ON CONFLICT DO NOTHING.
    -- A refund issued in the same transaction as the charge it reverses is
    -- exactly that case.
    v_sig text := COALESCE(p_sig,
        'row:' || md5(p_camp_id::text || '|' || v_key || '|' || p_tx::text
                      || '|' || clock_timestamp()::text));
BEGIN
    INSERT INTO canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    VALUES (
        p_camp_id, v_sig,
        v_key,
        (SELECT person_id::text FROM camp_canteen_accounts
          WHERE camp_id = p_camp_id AND account_key = v_key),
        COALESCE(p_tx ->> 'type', ''),
        COALESCE(NULLIF(p_tx ->> 'amount', '')::numeric, 0),
        COALESCE(p_tx ->> 'date', (now() AT TIME ZONE 'utc')::date::text),
        COALESCE(p_tx ->> 'time', ''),
        COALESCE(p_tx ->> 'items', ''),
        p_tx)
    ON CONFLICT (camp_id, sig) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_post(uuid, text, jsonb, text)
    FROM public, anon, authenticated;


-- ─── 5. a parent's campers, as ids ──────────────────────────────────────────
-- 218 worked this out inline, by resolving the invite's camper NAMES against the
-- roster. That breaks on exactly the case this file is about: after a rename the
-- invite still holds the old spelling, the roster no longer does, and the parent
-- resolves to no children at all.
--
-- So the STAMPED id comes first — 223 put a positional person_ids array on every
-- invite precisely so the id survives a rename — and the name is only re-resolved
-- for a slot that has no id yet, which is a camper added to the roster after the
-- invite was sent. Same two-step, same order, as 224's gate.
CREATE OR REPLACE FUNCTION public.camp_parent_camper_ids(p_camp_id uuid)
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(array_agg(DISTINCT x.pid), '{}')
      FROM link_parent_invites i
      CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                   THEN i.camper_names ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
      CROSS JOIN LATERAL (
              SELECT COALESCE(
                  NULLIF(i.person_ids -> (e.ord - 1)::int, 'null'::jsonb),
                  to_jsonb(public.camp_person_by_name(i.camp_id, e.value #>> '{}'))) AS slot) s
      CROSS JOIN LATERAL (
              SELECT CASE WHEN jsonb_typeof(s.slot) = 'number'
                          THEN (s.slot #>> '{}')::bigint END AS pid) x
     WHERE i.camp_id = p_camp_id
       AND i.user_id = auth.uid()
       AND (i.status = 'active' OR i.billing_access = true)
       AND (i.expires_at IS NULL OR i.expires_at > now())
       AND x.pid IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.camp_parent_camper_ids(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.camp_parent_camper_ids(uuid) TO authenticated, service_role;


-- ─── 6. the history ────────────────────────────────────────────────────────
-- Scoped by person, with the name kept as a fallback for a child the roster
-- cannot resolve — the same rule 218 used for accounts, and for the same reason:
-- a camper missing from the roster must not cost their parent sight of the
-- spending.
CREATE OR REPLACE FUNCTION public.get_canteen_history(
    p_camp_id uuid,
    p_camper  text    DEFAULT NULL,
    p_before  text    DEFAULT NULL,   -- tx_date upper bound (exclusive) for paging
    p_limit   integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_mine   jsonb;
    v_ids    bigint[];
    v_staff  boolean := public.camp_staff_member(p_camp_id);
    v_rows   jsonb;
    v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
    v_want   bigint;         -- the one camper asked for, as an id
    v_key    text;           -- and as the key their ledger rows carry
BEGIN
    IF NOT v_staff THEN
        v_mine := public.camp_parent_campers(p_camp_id);
        IF jsonb_array_length(v_mine) = 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
        END IF;
        v_ids := public.camp_parent_camper_ids(p_camp_id);

        -- A parent may only page their own children. A p_camper outside their
        -- family is a refusal, not a filter — and it is now judged by id, so a
        -- renamed child is still theirs whichever spelling either side holds.
        IF p_camper IS NOT NULL THEN
            v_want := public.camp_person_by_name(p_camp_id, p_camper);
            IF NOT ((v_want IS NOT NULL AND v_want = ANY (v_ids))
                    OR v_mine ? p_camper) THEN
                RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
            END IF;
        END IF;
    ELSIF p_camper IS NOT NULL THEN
        v_want := public.camp_person_by_name(p_camp_id, p_camper);
    END IF;

    IF p_camper IS NOT NULL THEN
        v_key := public.canteen_account_key_for(p_camp_id, p_camper);
    END IF;

    SELECT COALESCE(jsonb_agg(x.payload ORDER BY x.tx_date DESC, x.first_seen DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT ct.payload, ct.tx_date, ct.first_seen
          FROM public.canteen_transactions ct
         WHERE ct.camp_id = p_camp_id
           -- One camper: by id where the row carries one, by the translated key
           -- otherwise. The translation is what reaches rows written before the
           -- rename.
           AND (p_camper IS NULL
                OR (v_want IS NOT NULL AND ct.camper_id = v_want::text)
                OR ct.camper = v_key
                OR ct.camper = p_camper)
           -- The family scope. A row with an id is judged on the id; a row
           -- without one falls back to the name, which is the 353 case.
           AND (v_staff
                OR (ct.camper_id IS NOT NULL
                    AND ct.camper_id ~ '^[0-9]+$'
                    AND ct.camper_id::bigint = ANY (v_ids))
                OR (ct.camper_id IS NULL AND v_mine ? ct.camper))
           AND (p_before IS NULL OR ct.tx_date < p_before)
         ORDER BY ct.tx_date DESC, ct.first_seen DESC
         LIMIT v_limit
      ) x;

    RETURN jsonb_build_object('success', true, 'transactions', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.get_canteen_history(uuid, text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_canteen_history(uuid, text, text, integer)
    TO authenticated, service_role;


-- ─── 7. the verifier ────────────────────────────────────────────────────────
-- accounts_keyed_under_an_old_name is the count that matters. Each one was, until
-- this file, a child whose every canteen operation threw. The key itself stays
-- old on purpose — it is the primary key and the ledger holds it — so this count
-- does NOT fall after the fix. What changes is that the translation reaches them.
CREATE OR REPLACE FUNCTION public.verify_canteen_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_accounts    bigint;
    v_attributed  bigint;
    v_unattrib    bigint;
    v_unattrib_m  numeric;
    v_stale       bigint;
    v_stale_money numeric;
    v_labels      bigint;
    v_examples    jsonb;
BEGIN
    SELECT count(*), count(person_id), count(*) - count(person_id)
      INTO v_accounts, v_attributed, v_unattrib
      FROM camp_canteen_accounts WHERE deleted_at IS NULL;

    SELECT COALESCE(sum(balance), 0) INTO v_unattrib_m
      FROM camp_canteen_accounts WHERE deleted_at IS NULL AND person_id IS NULL;

    -- An attributed account whose key is no longer the camper's roster key. The
    -- rename already happened for these; the translation is what makes them
    -- reachable.
    SELECT count(*), COALESCE(sum(a.balance), 0)
      INTO v_stale, v_stale_money
      FROM camp_canteen_accounts a
      JOIN camp_people p ON p.camp_id = a.camp_id AND p.kind = 'camper'
                        AND p.person_id = a.person_id
     WHERE a.deleted_at IS NULL AND a.account_key IS DISTINCT FROM p.source_key;

    -- Labels that have not caught up yet. Harmless — the next sale fixes each
    -- one — but a non-zero count means print sheets are still showing old names.
    SELECT count(*) INTO v_labels
      FROM camp_canteen_accounts a
      JOIN camp_people p ON p.camp_id = a.camp_id AND p.kind = 'camper'
                        AND p.person_id = a.person_id
     WHERE a.deleted_at IS NULL AND a.camper_name IS DISTINCT FROM p.source_key;

    -- The LIMIT goes INSIDE the subquery. jsonb_agg with no GROUP BY yields one
    -- row, so a trailing LIMIT 20 would bound nothing and this list would carry
    -- every affected account in the database — which for a camp mid-season is not
    -- a sample, it is the table. tests/parent_poll_load.test.js caught this
    -- exact shape here.
    SELECT COALESCE(jsonb_agg(e.ex), '[]'::jsonb)
      INTO v_examples
      FROM (SELECT jsonb_build_object(
                     'camp_id', a.camp_id, 'account_key', a.account_key,
                     'roster_key', p.source_key, 'balance', a.balance) AS ex
              FROM camp_canteen_accounts a
              JOIN camp_people p ON p.camp_id = a.camp_id AND p.kind = 'camper'
                                AND p.person_id = a.person_id
             WHERE a.deleted_at IS NULL AND a.account_key IS DISTINCT FROM p.source_key
             ORDER BY a.balance DESC NULLS LAST
             LIMIT 20) e;

    RETURN jsonb_build_object(
        'success', true,
        'accounts', v_accounts,
        'accounts_carrying_a_camper_id', v_attributed,
        -- The 353. Still the number that does not go down by itself.
        'accounts_the_roster_cannot_resolve', v_unattrib,
        'money_on_unresolvable_accounts', v_unattrib_m,
        -- Until this file, each of these was a child whose every canteen
        -- operation raised a unique-violation. The count stays where it is after
        -- the fix — the key is deliberately not moved — but they are reachable.
        'accounts_keyed_under_an_old_name', v_stale,
        'money_on_them', v_stale_money,
        'labels_not_yet_caught_up', v_labels,
        'examples', v_examples);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_identity() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_identity() TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 227 applied'            AS status,
       public.verify_canteen_identity()   AS canteen_identity;
