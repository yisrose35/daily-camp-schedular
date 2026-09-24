-- ============================================================================
-- Migration 284: a register sale made by mistake can be voided — the money
-- goes back on the child's canteen balance as the reversal of THAT sale, and
-- the items go back in stock. Not as a deposit.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE reloading Snacks.
--
-- ── THE PROBLEM (TED-175) ──────────────────────────────────────────────────
-- A child charged by mistake — the wrong child, the wrong item, a double tap —
-- could only be given the money back with Add Deposit, which records "$2.50
-- paid in by cash" (or card). The cash drawer, the day's takings and the
-- deposit reports then showed money that never came in, and the mistaken sale
-- still counted as a sale.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- canteen_void_sale(camp, sale, items to restock, note): for staff who can edit
-- Snacks accounts (the same rule as the desk's other writes, 240). It finds the
-- sale by its row (every ledger row the page reads carries its `sig`), under
-- the child's wallet lock:
--   • only a register sale (in person or imported from the offline register)
--     — not a deposit, a refund, a cash-out, a close-out or a Shop order (the
--     Shop refunds its own orders);
--   • once: a second void of the same sale is refused ("already voided");
--   • puts the amount back on the balance, and back on today's spending if the
--     sale was today, so the child's daily limit is freed too;
--   • posts one line, kind 'void', a credit that names the sale it reverses
--     (voidOf) — with no payment method, so it is never cash or card taken in;
--   • puts the items the office ticked back in stock (and off "sold") — never
--     more of an item than the sale had (TED-184): by item id where the
--     register recorded them (289, TED-192), by the sale's item line otherwise.
-- The page leaves a voided sale out of sales and revenue.
--
-- get_canteen_history now carries each row's `sig` too, so a sale from the
-- archive, or one re-read after a desk write, can be voided as well.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL
       OR to_regprocedure('public.canteen_account_save(uuid,text,jsonb)') IS NULL
       OR to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL
       OR to_regprocedure('public._canteen_office_may_edit(uuid)') IS NULL
       OR COALESCE(to_regprocedure('public._get_canteen_history__by_name(uuid,text,text,integer)'),
                   to_regprocedure('public.get_canteen_history(uuid,text,text,integer)')) IS NULL THEN
        RAISE EXCEPTION '284 needs migrations 227 and 240 — apply those first';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.canteen_void_sale(
    p_camp_id uuid,
    p_sig     text,
    p_restock jsonb DEFAULT '[]'::jsonb,   -- [{"id": <inventory id>, "qty": n}]
    p_note    text  DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_sig    text := NULLIF(btrim(COALESCE(p_sig, '')), '');
    t        canteen_transactions%ROWTYPE;
    v_kind   text;
    v_acct   jsonb;
    v_bal    numeric;
    v_spent  numeric;
    v_amt    numeric;
    v_today  text := (now() AT TIME ZONE 'utc')::date::text;
    v_note   text := NULLIF(btrim(COALESCE(p_note, '')), '');
    v_back   integer := 0;
    v_sold_today boolean;
    now_ts   timestamptz := now();
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated', 'message', 'Not signed in.');
    END IF;
    IF NOT public._canteen_office_may_edit(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized',
                                  'message', 'Only someone who can edit Snacks accounts can void a sale.');
    END IF;
    IF v_sig IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'sale_not_found', 'message', 'Which sale?');
    END IF;

    SELECT * INTO t FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = v_sig;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'sale_not_found',
                                  'message', 'That sale is not on this camp''s ledger.');
    END IF;
    v_kind := COALESCE(t.payload ->> 'kind', '');
    IF t.tx_type <> 'debit' OR v_kind NOT IN ('', 'sale', 'offline_sale') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_sale',
            'message', CASE WHEN v_kind = 'shop' THEN 'That is a Shop order — refund it from the Shop.'
                            ELSE 'Only a register sale can be voided.' END);
    END IF;
    v_amt := round(COALESCE(t.amount, 0), 2);
    IF v_amt <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_sale', 'message', 'Only a register sale can be voided.');
    END IF;

    -- The child's wallet lock: two voids of the same sale wait here, and the
    -- second finds the first one's line.
    v_acct := public.canteen_account_lock(p_camp_id, t.camper);
    IF v_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_canteen_account',
                                  'message', 'This child has no canteen account.');
    END IF;
    IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = 'void:' || v_sig) THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_voided',
                                  'message', 'That sale was already voided — the money is back on the balance.');
    END IF;

    v_bal := round(COALESCE(NULLIF(v_acct ->> 'balance', '')::numeric, 0) + v_amt, 2);
    v_acct := v_acct || jsonb_build_object('balance', v_bal);
    -- A sale from today also comes off today's spending, so the daily limit it
    -- used is free again.
    IF t.tx_date = COALESCE(v_acct ->> 'lastSpendDate', '') THEN
        v_spent := GREATEST(0, round(COALESCE(NULLIF(v_acct ->> 'spentToday', '')::numeric, 0) - v_amt, 2));
        v_acct := v_acct || jsonb_build_object('spentToday', v_spent);
    END IF;
    PERFORM public.canteen_account_save(p_camp_id, t.camper, v_acct);

    PERFORM public.canteen_post(p_camp_id, t.camper,
        jsonb_build_object(
            'time',    to_char(now_ts, 'HH12:MI AM'),
            'camper',  COALESCE(NULLIF(t.payload ->> 'camper', ''), t.camper),
            'items',   'Sale voided: ' || COALESCE(NULLIF(t.items, ''), 'purchase') || ' (' || t.tx_date || ')',
            'amount',  v_amt,
            'type',    'credit',
            'kind',    'void',
            'voidOf',  v_sig,
            'saleDate', t.tx_date,
            'note',    COALESCE(v_note, 'Charged by mistake'),
            'by',      'office (void)',
            'date',    v_today,
            'timestamp', (extract(epoch FROM now_ts) * 1000)::bigint)
        || CASE WHEN t.camper_id IS NOT NULL AND t.camper_id ~ '^[0-9]+$'
                THEN jsonb_build_object('camperId', t.camper_id::bigint) ELSE '{}'::jsonb END,
        'void:' || v_sig);

    -- The items back in stock, and off "sold" (off "sold today" only for a
    -- sale made today). One UPDATE computed from the row it writes — no lock
    -- held on the camp's whole Snacks document (219's rule: every register
    -- would queue behind it).
    IF jsonb_typeof(p_restock) = 'array' AND jsonb_array_length(p_restock) > 0 THEN
        v_sold_today := t.tx_date = v_today;
        -- Never more than the sale had (TED-184): what was sold, from the
        -- sale's own line ("Ices ×2, Chips"), by item name; what the page asks
        -- to restock is capped at that, item by item.
        WITH sale_items AS (
            SELECT lower(btrim(COALESCE(m[1], part))) AS name,
                   sum(COALESCE(m[2]::numeric, 1)) AS qty
              FROM (SELECT btrim(p) AS part FROM regexp_split_to_table(COALESCE(t.items, ''), ',') AS p) parts
              LEFT JOIN LATERAL (SELECT regexp_match(parts.part, '^(.*?)\s*[×x]\s*([0-9]+)$') AS m) mm ON true
             WHERE parts.part <> ''
             GROUP BY 1),
        asked AS (
            SELECT it ->> 'id' AS id, sum(floor((it ->> 'qty')::numeric)) AS qty
              FROM jsonb_array_elements(p_restock) it
             WHERE jsonb_typeof(it) = 'object' AND it ->> 'id' IS NOT NULL
               AND jsonb_typeof(it -> 'qty') = 'number'
               AND floor((it ->> 'qty')::numeric) BETWEEN 1 AND 100
             GROUP BY 1),
        -- What the register recorded it sold, by item id (289, TED-192): that
        -- when the sale has it; the item line by name for older sales.
        sold_by_id AS (
            SELECT x ->> 'id' AS id, sum(COALESCE(NULLIF(x ->> 'qty', '')::numeric, 0)) AS qty
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.payload -> 'soldItems') = 'array'
                                             THEN t.payload -> 'soldItems' ELSE '[]'::jsonb END) x
             WHERE jsonb_typeof(x) = 'object'
             GROUP BY 1),
        back AS (
            SELECT a.id, LEAST(a.qty, COALESCE(
                       CASE WHEN jsonb_typeof(t.payload -> 'soldItems') = 'array'
                            THEN (SELECT sb.qty FROM sold_by_id sb WHERE sb.id = a.id)
                            ELSE (SELECT si.qty
                                    FROM camp_state_kv kv0
                                    JOIN LATERAL (SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(kv0.value -> 'inventory') = 'array'
                                                                                          THEN kv0.value -> 'inventory' ELSE '[]'::jsonb END) e
                                                   WHERE e ->> 'id' = a.id LIMIT 1) inv ON true
                                    JOIN sale_items si ON si.name = lower(btrim(COALESCE(inv.e ->> 'name', '')))
                                   WHERE kv0.camp_id = p_camp_id AND kv0.key = 'campistrySnacks') END, 0)) AS qty
              FROM asked a)
        UPDATE camp_state_kv kv
           SET value = jsonb_set(kv.value, '{inventory}', (
                   SELECT COALESCE(jsonb_agg(
                       CASE WHEN b.qty IS NOT NULL THEN
                           e || jsonb_build_object(
                               'stock', CASE WHEN jsonb_typeof(e -> 'stock') = 'number'
                                             THEN to_jsonb((e ->> 'stock')::numeric + b.qty)
                                             ELSE e -> 'stock' END,
                               'soldToday', CASE WHEN v_sold_today
                                                 THEN to_jsonb(GREATEST(0, COALESCE(NULLIF(e ->> 'soldToday', '')::numeric, 0) - b.qty))
                                                 ELSE COALESCE(e -> 'soldToday', '0'::jsonb) END,
                               'totalSold', to_jsonb(GREATEST(0, COALESCE(NULLIF(e ->> 'totalSold', '')::numeric, 0) - b.qty)))
                       ELSE e END ORDER BY x.ord), '[]'::jsonb)
                     FROM jsonb_array_elements(kv.value -> 'inventory') WITH ORDINALITY AS x(e, ord)
                     LEFT JOIN back b ON b.id = x.e ->> 'id'), true),
               updated_at = now_ts
         WHERE kv.camp_id = p_camp_id AND kv.key = 'campistrySnacks'
           AND jsonb_typeof(kv.value -> 'inventory') = 'array'
        RETURNING (SELECT COALESCE(sum(b.qty), 0)::integer
                     FROM back b
                    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(kv.value -> 'inventory') e WHERE e ->> 'id' = b.id))
          INTO v_back;
        v_back := COALESCE(v_back, 0);
    END IF;

    RETURN jsonb_build_object('success', true, 'balance', v_bal, 'amount', v_amt,
        'camper', COALESCE(NULLIF(t.payload ->> 'camper', ''), t.camper),
        'camperId', t.camper_id, 'restocked', v_back,
        'spentToday', v_acct -> 'spentToday', 'dailyLimit', v_acct -> 'dailyLimit');
END $$;
REVOKE ALL ON FUNCTION public.canteen_void_sale(uuid, text, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_void_sale(uuid, text, jsonb, text) TO authenticated;

-- get_canteen_history: each row with its sig, as get_canteen_accounts (245)
-- already gives it, so any row the page shows can be named to the server.
-- Since 248 its body lives in _get_canteen_history__by_name (the public name
-- is the wrapper that also takes a camper id); a camp that unwrapped 248 has
-- it under the public name.
DO $$
DECLARE
    f   regprocedure := COALESCE(to_regprocedure('public._get_canteen_history__by_name(uuid,text,text,integer)'),
                                 to_regprocedure('public.get_canteen_history(uuid,text,text,integer)'));
    d   text;
    a1  text := 'jsonb_agg(x.payload ORDER BY x.tx_date DESC, x.first_seen DESC)';
    b1  text := 'jsonb_agg(x.payload || jsonb_build_object(''sig'', x.sig) ORDER BY x.tx_date DESC, x.first_seen DESC)';
    a2  text := 'SELECT ct.payload, ct.tx_date, ct.first_seen';
    b2  text := 'SELECT ct.payload, ct.sig, ct.tx_date, ct.first_seen';
BEGIN
    d := pg_get_functiondef(f);
    IF position('''sig'', x.sig' IN d) > 0 THEN
        RAISE NOTICE '284: get_canteen_history already carries sig';
        RETURN;
    END IF;
    IF position(a1 IN d) = 0 OR position(a2 IN d) = 0 THEN
        RAISE EXCEPTION '284: get_canteen_history does not look the way this file expects — send this message to the builder';
    END IF;
    EXECUTE replace(replace(d, a1, b1), a2, b2);
END $$;
