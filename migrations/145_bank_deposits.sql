-- =============================================================================
-- Migration 145: Zelle / ACH deposit capture + payer aliases
--
-- Tuition paid by Zelle or ACH has, until now, been a manual-entry method: the
-- money lands in the camp's bank account, somebody reads the statement, and
-- retypes it into Billing -> Record Payment. Neither rail has a merchant API
-- (Zelle is bank-to-bank with no merchant layer; a plain ACH credit has no
-- callback), so the only things that can report a deposit are the bank's alert
-- email and the statement descriptor. This migration is where those land.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY DEPOSITS ARE NOT WRITTEN INTO camp_state_kv
--
-- Every other finance record in this app lives inside the campistryMe blob in
-- camp_state_kv (finance.payments). Deposits deliberately do NOT.
--
-- The blob has exactly one writer today: the browser, which reads the whole
-- object, mutates it in memory, and writes the whole thing back. That is safe
-- only while a single writer exists. The moment a webhook also appends to it,
-- an office tab that loaded the blob five minutes earlier will overwrite the
-- webhook's payment on its next save -- silently, with no error, and nobody
-- notices until a family disputes a statement.
--
-- So the boundary is drawn by OWNERSHIP instead of by locking:
--     camp_state_kv  -> written only by the browser  (unchanged)
--     bank_deposits  -> written only by the server    (new)
-- and the Billing ledger UNIONS the two at read time (get_camp_deposit_credits
-- below). A posted deposit IS the ledger entry; it is never copied into the
-- blob. No shared row, therefore no race, therefore no lost tuition.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Idempotent -- safe to re-run.
-- =============================================================================


-- ─── 1. camp_deposit_settings ────────────────────────────────────────────────
-- Per-camp configuration for the automatic path, including the routing token
-- that appears in the camp's inbound email address.
--
-- inbound_token is a bearer secret: anyone who knows the address can post an
-- email at the inbox. It is therefore random, per-camp, rotatable, and the
-- edge function ALSO verifies the Resend webhook signature and the sending
-- bank's domain before trusting anything. Three independent checks, because
-- the consequence of a forged deposit is a family credited for money that
-- never arrived.
CREATE TABLE IF NOT EXISTS camp_deposit_settings (
    camp_id          uuid PRIMARY KEY REFERENCES camps(id) ON DELETE CASCADE,
    enabled          boolean NOT NULL DEFAULT true,
    inbound_token    text NOT NULL UNIQUE,
    -- Only mail actually FROM the bank is trusted. Empty array = accept any
    -- sender, which is only sane while a camp is still testing.
    sender_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[],
    -- Matching thresholds. Mirrors campistry_deposit_match.js DEFAULTS so the
    -- browser preview and the server decision cannot drift apart.
    auto_post_at     integer NOT NULL DEFAULT 90  CHECK (auto_post_at BETWEEN 0 AND 100),
    suggest_at       integer NOT NULL DEFAULT 40  CHECK (suggest_at BETWEEN 0 AND 100),
    ambiguous_gap    integer NOT NULL DEFAULT 5   CHECK (ambiguous_gap >= 0),
    -- Dry run matches and explains but posts nothing. Camps should sit here for
    -- the first couple of weeks and watch it be right before trusting it; that
    -- is what makes this adoptable at all.
    dry_run          boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camp_deposit_settings ENABLE ROW LEVEL SECURITY;
-- No client-facing policies — all access through the RPCs below.


-- ─── 2. payer_aliases ────────────────────────────────────────────────────────
-- "SHIMON'S HARDWARE LLC is the Klein family."
--
-- This table is the actual fix for the problem this feature exists to solve.
-- The name on a Zelle payment is regularly not the name on the family record --
-- a father's business, a mother's maiden name, a grandparent, a second parent
-- who never changed their surname. Resolving one costs the office a click; this
-- table means it costs them that click EXACTLY ONCE, ever.
--
-- Uniqueness is (camp_id, family_key, normalized) and NOT (camp_id, normalized)
-- on purpose: one business legitimately pays for two households (cousins,
-- a grandparent covering several families). Two aliases with the same payer
-- name pointing at different families is a valid state -- the matcher scores
-- both, sees a tie, and routes to a human, which is the correct outcome.
CREATE TABLE IF NOT EXISTS payer_aliases (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id      uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    family_key   text NOT NULL,
    kind         text NOT NULL DEFAULT 'ach' CHECK (kind IN ('zelle', 'ach', 'wire', 'other')),
    display_name text NOT NULL DEFAULT '',      -- as the bank prints it
    normalized   text NOT NULL DEFAULT '',      -- campistry_deposit_match.normalize()
    handle       text NOT NULL DEFAULT '',      -- Zelle email/phone, normalized
    -- declared = parent told us at registration, before any money moved
    -- confirmed = staff entered it deliberately
    -- learned   = produced by resolving a deposit in the inbox
    source       text NOT NULL DEFAULT 'learned' CHECK (source IN ('declared', 'confirmed', 'learned')),
    note         text NOT NULL DEFAULT '',
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payer_aliases_name_uq
    ON payer_aliases (camp_id, family_key, normalized) WHERE normalized <> '';
CREATE UNIQUE INDEX IF NOT EXISTS payer_aliases_handle_uq
    ON payer_aliases (camp_id, family_key, handle) WHERE handle <> '';
CREATE INDEX IF NOT EXISTS payer_aliases_camp_idx ON payer_aliases (camp_id);

ALTER TABLE payer_aliases ENABLE ROW LEVEL SECURITY;


-- ─── 3. bank_deposits ────────────────────────────────────────────────────────
-- One row per real movement of money into the camp's account.
--
-- fingerprint is the idempotency key and the whole reason two independent
-- feeds can run at once. It is computed from (date, amount, payer, trace) and
-- deliberately EXCLUDES the source, so the same $850 seen by both the alert
-- email and the bank feed collapses onto one row instead of crediting the
-- family twice. See campistry_deposit_parser.fingerprint().
CREATE TABLE IF NOT EXISTS bank_deposits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id         uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    fingerprint     text NOT NULL,

    amount_cents    integer NOT NULL,          -- always positive; see is_reversal
    is_reversal     boolean NOT NULL DEFAULT false,
    deposit_date    date,
    payer_name      text NOT NULL DEFAULT '',
    payer_handle    text NOT NULL DEFAULT '',
    memo            text NOT NULL DEFAULT '',
    memo_code       text NOT NULL DEFAULT '',
    kind            text NOT NULL DEFAULT 'ach' CHECK (kind IN ('zelle', 'ach', 'wire', 'other')),
    trace_id        text NOT NULL DEFAULT '',
    bank            text NOT NULL DEFAULT '',
    source          text NOT NULL DEFAULT 'email' CHECK (source IN ('email', 'feed', 'import', 'manual')),
    raw_subject     text NOT NULL DEFAULT '',

    -- posted    = counted in the family ledger right now
    -- review    = matched, but a guardrail wants a human (see guardrail)
    -- unmatched = no confident candidate
    -- ignored   = real money, deliberately not tuition (canteen, donation, …)
    status          text NOT NULL DEFAULT 'unmatched'
        CHECK (status IN ('posted', 'review', 'unmatched', 'ignored')),
    family_key      text,
    match_confidence integer NOT NULL DEFAULT 0,
    match_reasons   jsonb NOT NULL DEFAULT '[]'::jsonb,
    candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Why this did not post by itself. The office's first question, so it is a
    -- column on the row rather than a line in a log.
    guardrail       text NOT NULL DEFAULT '',
    matched_by      text NOT NULL DEFAULT 'auto' CHECK (matched_by IN ('auto', 'staff')),

    resolved_by     uuid,
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bank_deposits_amount_positive CHECK (amount_cents > 0),
    CONSTRAINT bank_deposits_posted_needs_family
        CHECK (status <> 'posted' OR family_key IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_deposits_fingerprint_uq
    ON bank_deposits (camp_id, fingerprint);
CREATE INDEX IF NOT EXISTS bank_deposits_camp_status_idx
    ON bank_deposits (camp_id, status, deposit_date DESC);
CREATE INDEX IF NOT EXISTS bank_deposits_family_idx
    ON bank_deposits (camp_id, family_key) WHERE family_key IS NOT NULL;

ALTER TABLE bank_deposits ENABLE ROW LEVEL SECURITY;


-- ─── 4. authorization helper ─────────────────────────────────────────────────
-- Same owner/admin rule every other finance RPC in this codebase uses
-- (migration 126's get_camp_payment_processor_status). Kept in one place so
-- the deposit RPCs cannot drift from it.
CREATE OR REPLACE FUNCTION public._deposit_can_admin(p_camp_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = auth.uid()
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = auth.uid()
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    );
$$;


-- ─── 5. settings: read / write ───────────────────────────────────────────────
-- Reading creates the row on first use, so a camp never has to "enable" the
-- feature before it can be configured. The token is minted here and only here.
CREATE OR REPLACE FUNCTION public.get_camp_deposit_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_deposit_settings;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_deposit_settings (camp_id, inbound_token)
    VALUES (p_camp_id, encode(gen_random_bytes(16), 'hex'))
    ON CONFLICT (camp_id) DO NOTHING;

    SELECT * INTO v_row FROM camp_deposit_settings WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_row.enabled,
        'inboundToken', v_row.inbound_token,
        'senderAllowlist', to_jsonb(v_row.sender_allowlist),
        'autoPostAt', v_row.auto_post_at,
        'suggestAt', v_row.suggest_at,
        'ambiguousGap', v_row.ambiguous_gap,
        'dryRun', v_row.dry_run
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_camp_deposit_settings(
    p_camp_id          uuid,
    p_enabled          boolean DEFAULT NULL,
    p_dry_run          boolean DEFAULT NULL,
    p_auto_post_at     integer DEFAULT NULL,
    p_suggest_at       integer DEFAULT NULL,
    p_ambiguous_gap    integer DEFAULT NULL,
    p_sender_allowlist text[]  DEFAULT NULL,
    p_rotate_token     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_deposit_settings (camp_id, inbound_token)
    VALUES (p_camp_id, encode(gen_random_bytes(16), 'hex'))
    ON CONFLICT (camp_id) DO NOTHING;

    UPDATE camp_deposit_settings SET
        enabled          = COALESCE(p_enabled, enabled),
        dry_run          = COALESCE(p_dry_run, dry_run),
        auto_post_at     = COALESCE(p_auto_post_at, auto_post_at),
        suggest_at       = COALESCE(p_suggest_at, suggest_at),
        ambiguous_gap    = COALESCE(p_ambiguous_gap, ambiguous_gap),
        sender_allowlist = COALESCE(p_sender_allowlist, sender_allowlist),
        inbound_token    = CASE WHEN p_rotate_token
                                THEN encode(gen_random_bytes(16), 'hex')
                                ELSE inbound_token END,
        updated_at       = now()
     WHERE camp_id = p_camp_id;

    RETURN get_camp_deposit_settings(p_camp_id);
END;
$$;


-- ─── 6. _deposit_record (service role only) ──────────────────────────────────
-- The write path for the deposit-inbox edge function and any feed importer.
--
-- ON CONFLICT DO NOTHING on the fingerprint is the entire duplicate defence:
-- an inbound webhook that Resend retries, an overlapping CSV re-import, and the
-- bank feed confirming a deposit the alert email already reported all collapse
-- here. The function reports which happened so the caller can log it.
--
-- Deliberately NOT granted to authenticated — the edge function uses the
-- service role. A client that could call this could invent tuition payments.
CREATE OR REPLACE FUNCTION public._deposit_record(
    p_camp_id      uuid,
    p_fingerprint  text,
    p_amount_cents integer,
    p_deposit      jsonb,
    p_decision     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       uuid;
    v_status   text := COALESCE(p_decision->>'decision', 'unmatched');
    v_family   text := NULLIF(p_decision->>'familyKey', '');
BEGIN
    -- 'auto' is the matcher's verdict; 'posted' is the ledger's word for it.
    IF v_status = 'auto' THEN v_status := 'posted'; END IF;
    IF v_status NOT IN ('posted', 'review', 'unmatched', 'ignored') THEN
        v_status := 'unmatched';
    END IF;
    -- A posted row without a family would violate the table constraint; demote
    -- rather than fail, so a malformed decision never drops real money.
    IF v_status = 'posted' AND v_family IS NULL THEN
        v_status := 'review';
    END IF;

    INSERT INTO bank_deposits (
        camp_id, fingerprint, amount_cents, is_reversal, deposit_date,
        payer_name, payer_handle, memo, memo_code, kind, trace_id, bank,
        source, raw_subject, status, family_key, match_confidence,
        match_reasons, candidates, guardrail, matched_by,
        resolved_at
    ) VALUES (
        p_camp_id,
        p_fingerprint,
        abs(p_amount_cents),
        COALESCE((p_deposit->>'isReversal')::boolean, false),
        NULLIF(p_deposit->>'date', '')::date,
        COALESCE(p_deposit->>'payerName', ''),
        COALESCE(p_deposit->>'payerHandle', ''),
        COALESCE(p_deposit->>'memo', ''),
        COALESCE(p_deposit->>'memoCode', ''),
        COALESCE(NULLIF(p_deposit->>'kind', ''), 'ach'),
        COALESCE(p_deposit->>'traceId', ''),
        COALESCE(p_deposit->>'bank', ''),
        COALESCE(NULLIF(p_deposit->>'source', ''), 'email'),
        COALESCE(p_deposit->>'rawSubject', ''),
        v_status,
        v_family,
        COALESCE((p_decision->>'confidence')::integer, 0),
        COALESCE(p_decision->'reasons', '[]'::jsonb),
        COALESCE(p_decision->'candidates', '[]'::jsonb),
        COALESCE(p_decision->>'guardrail', ''),
        'auto',
        CASE WHEN v_status = 'posted' THEN now() ELSE NULL END
    )
    ON CONFLICT (camp_id, fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM bank_deposits
         WHERE camp_id = p_camp_id AND fingerprint = p_fingerprint;
        RETURN jsonb_build_object('success', true, 'duplicate', true, 'depositId', v_id);
    END IF;

    RETURN jsonb_build_object('success', true, 'duplicate', false,
                              'depositId', v_id, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_record(uuid, text, integer, jsonb, jsonb) FROM public, anon, authenticated;


-- ─── 7. _deposit_camp_for_token (service role only) ──────────────────────────
-- Resolves the routing token in the inbound address to a camp, and hands back
-- the settings the edge function needs to make its decision.
CREATE OR REPLACE FUNCTION public._deposit_camp_for_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_deposit_settings;
BEGIN
    SELECT * INTO v_row FROM camp_deposit_settings
     WHERE inbound_token = p_token AND enabled = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_token');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campId', v_row.camp_id,
        'senderAllowlist', to_jsonb(v_row.sender_allowlist),
        'autoPostAt', v_row.auto_post_at,
        'suggestAt', v_row.suggest_at,
        'ambiguousGap', v_row.ambiguous_gap,
        'dryRun', v_row.dry_run
    );
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_camp_for_token(text) FROM public, anon, authenticated;


-- ─── 8. reading the inbox ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_bank_deposits(
    p_camp_id uuid,
    p_status  text DEFAULT NULL,
    p_limit   integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(d)::jsonb ORDER BY d.deposit_date DESC NULLS LAST, d.created_at DESC), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT id, fingerprint, amount_cents, is_reversal, deposit_date,
               payer_name, payer_handle, memo, memo_code, kind, trace_id,
               bank, source, raw_subject, status, family_key, match_confidence,
               match_reasons, candidates, guardrail, matched_by,
               resolved_by, resolved_at, created_at
          FROM bank_deposits
         WHERE camp_id = p_camp_id
           AND (p_status IS NULL OR status = p_status)
         ORDER BY deposit_date DESC NULLS LAST, created_at DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
      ) d;

    RETURN jsonb_build_object('success', true, 'deposits', v_out);
END;
$$;


-- ─── 9. get_camp_deposit_credits ─────────────────────────────────────────────
-- The union point described in the header: every POSTED deposit, grouped by
-- family, for the Billing ledger to add to what it reads out of camp_state_kv.
--
-- NOTE for whoever wires the parent-facing side: get_my_balance (migrations
-- 046/096/118) still reads only the kv blob, so a parent's own balance in
-- Campistry Link will not reflect an auto-posted deposit until that function
-- adds the same union. That is a deliberate, contained follow-up rather than a
-- blind edit to a large existing function in this migration.
CREATE OR REPLACE FUNCTION public.get_camp_deposit_credits(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_object_agg(family_key, entries), '{}'::jsonb) INTO v_out
      FROM (
        SELECT family_key,
               jsonb_agg(jsonb_build_object(
                   'id', 'dep_' || id::text,
                   'depositId', id,
                   -- A return/NSF is money moving OUT of the ledger. amount_cents
                   -- is stored positive (the table CHECKs it), so the sign has to
                   -- be applied here -- without this a bounced ACH would CREDIT
                   -- the family for the payment that just failed, and the account
                   -- would read as paid.
                   'amount', CASE WHEN is_reversal THEN -1 ELSE 1 END
                             * round(amount_cents::numeric / 100, 2),
                   'isReversal', is_reversal,
                   'date', deposit_date,
                   'method', kind,
                   'reference', COALESCE(NULLIF(trace_id, ''), memo_code),
                   'payerName', payer_name,
                   'notes', CASE WHEN is_reversal AND payer_name <> ''
                                 THEN 'Returned / NSF — ' || payer_name
                                 WHEN is_reversal
                                 THEN 'Returned / NSF'
                                 WHEN payer_name <> '' AND memo_code <> ''
                                 THEN 'Received from ' || payer_name || ' (memo ' || memo_code || ')'
                                 WHEN payer_name <> ''
                                 THEN 'Received from ' || payer_name
                                 ELSE 'Bank deposit' END,
                   'matchedBy', matched_by,
                   'confidence', match_confidence
               ) ORDER BY deposit_date DESC NULLS LAST) AS entries
          FROM bank_deposits
         WHERE camp_id = p_camp_id AND status = 'posted' AND family_key IS NOT NULL
         GROUP BY family_key
      ) g;

    RETURN jsonb_build_object('success', true, 'credits', v_out);
END;
$$;


-- ─── 10. resolving a deposit by hand ─────────────────────────────────────────
-- The office's one click. Assigning the family optionally creates the alias
-- that stops this payer ever needing a human again — that learning loop is
-- what makes the whole feature pay for itself.
CREATE OR REPLACE FUNCTION public.resolve_bank_deposit(
    p_camp_id      uuid,
    p_deposit_id   uuid,
    p_family_key   text,
    p_create_alias boolean DEFAULT true,
    p_alias_normalized text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_dep bank_deposits;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT * INTO v_dep FROM bank_deposits
     WHERE id = p_deposit_id AND camp_id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    UPDATE bank_deposits SET
        status      = 'posted',
        family_key  = p_family_key,
        matched_by  = 'staff',
        guardrail   = '',
        resolved_by = auth.uid(),
        resolved_at = now(),
        updated_at  = now()
     WHERE id = p_deposit_id;

    IF p_create_alias AND (COALESCE(p_alias_normalized, '') <> '' OR v_dep.payer_handle <> '') THEN
        INSERT INTO payer_aliases (camp_id, family_key, kind, display_name, normalized, handle, source, created_by)
        VALUES (p_camp_id, p_family_key, v_dep.kind, v_dep.payer_name,
                COALESCE(p_alias_normalized, ''), v_dep.payer_handle, 'learned', auth.uid())
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Real money that is deliberately not tuition (a canteen top-up, a donation, a
-- staff reimbursement). It stops nagging without being force-fit onto a family.
CREATE OR REPLACE FUNCTION public.ignore_bank_deposit(
    p_camp_id    uuid,
    p_deposit_id uuid,
    p_note       text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    UPDATE bank_deposits SET
        status      = 'ignored',
        family_key  = NULL,
        guardrail   = COALESCE(NULLIF(p_note, ''), 'Marked not tuition'),
        matched_by  = 'staff',
        resolved_by = auth.uid(),
        resolved_at = now(),
        updated_at  = now()
     WHERE id = p_deposit_id AND camp_id = p_camp_id;

    RETURN jsonb_build_object('success', FOUND);
END;
$$;

-- Undo. An auto-posted deposit must always be reversible, or the office cannot
-- trust the automatic path at all.
CREATE OR REPLACE FUNCTION public.unmatch_bank_deposit(
    p_camp_id    uuid,
    p_deposit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    UPDATE bank_deposits SET
        status      = 'review',
        family_key  = NULL,
        guardrail   = 'Unmatched by staff',
        matched_by  = 'staff',
        resolved_by = auth.uid(),
        resolved_at = now(),
        updated_at  = now()
     WHERE id = p_deposit_id AND camp_id = p_camp_id;

    RETURN jsonb_build_object('success', FOUND);
END;
$$;


-- ─── 11. aliases: read / add / delete ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_payer_aliases(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', id, 'familyKey', family_key, 'kind', kind,
               'displayName', display_name, 'normalized', normalized,
               'handle', handle, 'source', source, 'note', note,
               'createdAt', created_at
           ) ORDER BY display_name), '[]'::jsonb)
      INTO v_out FROM payer_aliases WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'aliases', v_out);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_payer_alias(
    p_camp_id      uuid,
    p_family_key   text,
    p_display_name text,
    p_normalized   text,
    p_handle       text DEFAULT '',
    p_kind         text DEFAULT 'zelle',
    p_source       text DEFAULT 'confirmed',
    p_note         text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF COALESCE(p_normalized, '') = '' AND COALESCE(p_handle, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'need_name_or_handle');
    END IF;

    INSERT INTO payer_aliases (camp_id, family_key, kind, display_name, normalized, handle, source, note, created_by)
    VALUES (p_camp_id, p_family_key, p_kind, COALESCE(p_display_name, ''),
            COALESCE(p_normalized, ''), COALESCE(p_handle, ''), p_source, COALESCE(p_note, ''), auth.uid())
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'aliasId', v_id,
                              'duplicate', v_id IS NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_payer_alias(p_camp_id uuid, p_alias_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    DELETE FROM payer_aliases WHERE id = p_alias_id AND camp_id = p_camp_id;
    RETURN jsonb_build_object('success', FOUND);
END;
$$;


-- ─── 12. family_balance_snapshots ────────────────────────────────────────────
-- The overpay guardrail ("this deposit is bigger than the family owes, so
-- confirm it") needs a balance. The authoritative balance comes from
-- buildFamilyLedgers() in campistry_me.js, which resolves enrollment tuition,
-- accepted-but-not-enrolled applications, credits and refunds -- roughly 200
-- lines that also depend on `sessions` and `enrollments` being freshly
-- hydrated. Re-implementing that in Deno would drift from the browser within a
-- release or two, and a guardrail that silently disagrees with Billing is
-- worse than no guardrail.
--
-- So the browser PUBLISHES what it already computed, and the edge function
-- reads the snapshot. Staleness is safe by construction: the snapshot is only
-- ever used to decide whether to auto-post or ask a human. It never becomes a
-- ledger figure, and it is never shown to anyone as a balance.
--
-- A missing snapshot is fine too -- the matcher simply skips the overpay check
-- (see campistry_deposit_match.decide), so a camp that has never opened
-- Billing still gets every other guardrail.
CREATE TABLE IF NOT EXISTS family_balance_snapshots (
    camp_id       uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    family_key    text NOT NULL,
    balance_cents integer NOT NULL DEFAULT 0,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, family_key)
);

ALTER TABLE family_balance_snapshots ENABLE ROW LEVEL SECURITY;

-- Replaces the whole snapshot for a camp in one statement. p_balances is
-- {"famKey": <dollars>, ...} exactly as buildFamilyLedgers() produces it.
CREATE OR REPLACE FUNCTION public.set_family_balance_snapshot(
    p_camp_id  uuid,
    p_balances jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_n integer := 0;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO family_balance_snapshots (camp_id, family_key, balance_cents, computed_at)
    SELECT p_camp_id, key, round((value#>>'{}')::numeric * 100)::integer, now()
      FROM jsonb_each(COALESCE(p_balances, '{}'::jsonb))
    ON CONFLICT (camp_id, family_key) DO UPDATE
        SET balance_cents = EXCLUDED.balance_cents,
            computed_at   = EXCLUDED.computed_at;

    GET DIAGNOSTICS v_n = ROW_COUNT;

    -- Families that vanished from the blob (deleted/merged households) must not
    -- leave a stale balance behind for the guardrail to read.
    DELETE FROM family_balance_snapshots
     WHERE camp_id = p_camp_id
       AND NOT (COALESCE(p_balances, '{}'::jsonb) ? family_key);

    RETURN jsonb_build_object('success', true, 'count', v_n);
END;
$$;


-- ─── 12. grants ──────────────────────────────────────────────────────────────
-- Every one of these re-checks _deposit_can_admin internally; the grant only
-- lets a signed-in user attempt the call.
GRANT EXECUTE ON FUNCTION public.get_camp_deposit_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_camp_deposit_settings(uuid, boolean, boolean, integer, integer, integer, text[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_bank_deposits(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_camp_deposit_credits(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_bank_deposit(uuid, uuid, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_bank_deposit(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_deposit(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_payer_aliases(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_payer_alias(uuid, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_payer_alias(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_family_balance_snapshot(uuid, jsonb) TO authenticated;
