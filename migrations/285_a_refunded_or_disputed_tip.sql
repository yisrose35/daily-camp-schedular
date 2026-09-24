-- ============================================================================
-- Migration 285: a staff tip the parent got back — refunded in Stripe, or
-- disputed with their bank — is marked on the tip, comes off the staff
-- member's total, and the platform is told once what to do next.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE deploying stripe-connect-webhook.
--
-- ── THE PROBLEM (TED-176) ──────────────────────────────────────────────────
-- A tip is charged on Campistry's own Stripe account and the tip part is sent
-- on to the staff member's Stripe account (a destination charge, or one
-- transfer per staff member for a cart of tips). When a tip was refunded, or a
-- parent disputed it, nothing in Campistry noticed: the tip stayed on the staff
-- member's record and total, and Stripe took the refund or the chargeback (and
-- its dispute fee) from Campistry's balance, with no one asking for the tip back.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- link_tips gains:
--   refunded_amount     this tip's share of what Stripe refunded to the parent
--   dispute_status      open | won | lost (null: never disputed)
--   clawed_back_amount  how much of the transfer to the staff member has been
--                       reversed (taken back from their Stripe account)
--   reversal_note       what could not be done automatically, in words
--   reversal_alerted    the state the platform was last emailed about
--
-- record_tip_reversal(tip, refunded, dispute status, clawed back, note): for
-- stripe-connect-webhook only (service role). Under the tip's row lock it
-- records the new state — refunds and clawbacks only ever go up — and takes
-- the change in what the staff member lost off their total_earned (the whole
-- tip while a dispute is open or lost; the refunded share otherwise), so a
-- repeated delivery of the same event changes nothing. It answers with the
-- state the platform should be told about, and whether it already was.
--
-- mark_tip_reversal_alerted(tip, state): the webhook marks the state once the
-- email went, so an email that failed is sent again on Stripe's retry.
-- ============================================================================

DO $$
BEGIN
    IF to_regclass('public.link_tips') IS NULL OR to_regclass('public.link_staff_accounts') IS NULL THEN
        RAISE EXCEPTION '285 needs migrations 016 and 057 (tips and staff accounts) — apply those first';
    END IF;
END $$;

ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS refunded_amount    numeric(8,2) NOT NULL DEFAULT 0;
ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS dispute_status     text;
ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS clawed_back_amount numeric(8,2) NOT NULL DEFAULT 0;
ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS reversal_note      text;
ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS reversal_alerted   text;
ALTER TABLE public.link_tips ADD COLUMN IF NOT EXISTS reversal_at        timestamptz;

CREATE OR REPLACE FUNCTION public.record_tip_reversal(
    p_tip_id         uuid,
    p_refunded       numeric,
    p_dispute_status text    DEFAULT NULL,
    p_clawed_back    numeric DEFAULT NULL,
    p_note           text    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    t        link_tips%ROWTYPE;
    v_ref    numeric;
    v_disp   text;
    v_claw   numeric;
    v_lost0  numeric;
    v_lost1  numeric;
    v_state  text;
    v_note   text;
BEGIN
    SELECT * INTO t FROM link_tips WHERE id = p_tip_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'tip_not_found'); END IF;
    IF p_dispute_status IS NOT NULL AND p_dispute_status NOT IN ('open', 'won', 'lost') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_dispute_status');
    END IF;

    -- Only ever up: a late, older event must not undo a newer one.
    v_ref  := LEAST(t.amount, GREATEST(COALESCE(t.refunded_amount, 0), round(COALESCE(p_refunded, 0), 2)));
    v_disp := COALESCE(p_dispute_status, t.dispute_status);
    -- a closed dispute stays closed; a new "open" for it does not reopen it
    IF t.dispute_status IN ('won', 'lost') AND p_dispute_status = 'open' THEN v_disp := t.dispute_status; END IF;
    v_claw := LEAST(t.amount, GREATEST(COALESCE(t.clawed_back_amount, 0), round(COALESCE(p_clawed_back, 0), 2)));

    -- What the staff member has lost of this tip, before and after.
    v_lost0 := GREATEST(COALESCE(t.refunded_amount, 0),
                        CASE WHEN t.dispute_status IN ('open', 'lost') THEN t.amount ELSE 0 END);
    v_lost1 := GREATEST(v_ref, CASE WHEN v_disp IN ('open', 'lost') THEN t.amount ELSE 0 END);

    UPDATE link_tips SET
        refunded_amount    = v_ref,
        dispute_status     = v_disp,
        clawed_back_amount = v_claw,
        reversal_note      = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), CASE WHEN v_claw >= v_lost1 THEN NULL ELSE reversal_note END),
        reversal_at        = CASE WHEN v_lost1 <> v_lost0 OR v_disp IS DISTINCT FROM t.dispute_status OR v_claw <> t.clawed_back_amount
                                  THEN now() ELSE reversal_at END
     WHERE id = p_tip_id
    RETURNING reversal_note INTO v_note;

    IF v_lost1 <> v_lost0 AND t.staff_account_id IS NOT NULL THEN
        UPDATE link_staff_accounts
           SET total_earned = total_earned - (v_lost1 - v_lost0), updated_at = now()
         WHERE id = t.staff_account_id;
    END IF;

    v_state := 'refunded=' || v_ref || ';dispute=' || COALESCE(v_disp, '-') || ';clawed=' || v_claw;
    RETURN jsonb_build_object('success', true,
        'tipId', t.id, 'campId', t.camp_id, 'staffName', t.recipient_name, 'amount', t.amount,
        'refunded', v_ref, 'disputeStatus', v_disp, 'clawedBack', v_claw,
        'lost', v_lost1, 'change', v_lost1 - v_lost0, 'note', v_note,
        'state', v_state, 'alerted', t.reversal_alerted IS NOT DISTINCT FROM v_state
                                    OR (v_lost1 = 0 AND v_disp IS NULL AND t.reversal_alerted IS NULL));
END $$;
REVOKE ALL ON FUNCTION public.record_tip_reversal(uuid, numeric, text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_tip_reversal(uuid, numeric, text, numeric, text) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_tip_reversal_alerted(p_tip_id uuid, p_state text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE link_tips SET reversal_alerted = p_state WHERE id = p_tip_id RETURNING true;
$$;
REVOKE ALL ON FUNCTION public.mark_tip_reversal_alerted(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tip_reversal_alerted(uuid, text) TO service_role;
