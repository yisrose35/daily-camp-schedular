-- ════════════════════════════════════════════════════════════════════════════
-- pgstubs.sql — the SHAPE of everything a migration expects to already exist.
--
-- Extracted from try_migration.sh so the browser end-to-end harness
-- (tests/e2e/db.js) boots the SAME database the migration tries run against.
-- Two copies of this would drift, and a drifting stub is a test that proves
-- something about a schema nobody has.
--
-- Supabase's roles, its auth schema, and the shape of the tables migrations
-- reference. Deliberately minimal: shape, not behaviour. A green result against
-- these stubs does NOT prove a migration is correct against live data; that is
-- what each migration's own verify_* function is for.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

-- Supabase installs extensions into an `extensions` schema, NOT public. Every
-- function in these migrations pins SET search_path = public, pg_catalog, so
-- an extension function is NOT on the path there — and PL/pgSQL resolves
-- function names at first EXECUTION, so the failure arrives at the first real
-- call, long after the migration applied and its tests passed.
--
-- This stub used to do a bare CREATE EXTENSION, which puts pgcrypto in public.
-- 219's canteen_post called digest() and passed every test here, then failed
-- on the first live purchase with "function digest(text, unknown) does not
-- exist". Shaped the way the real thing is shaped, that fails here instead.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

-- address and contact_email are read by receipt_recipient (212), which builds
-- the camp's own details into every receipt.
CREATE TABLE IF NOT EXISTS public.camps      (id uuid PRIMARY KEY, owner uuid, name text,
    address text, contact_email text);
-- camp_users is created by a migration older than any bundle, so the shape here
-- is inferred from what reads it. The columns beyond (camp_id, user_id, role)
-- are not decoration: supabase_client.js resolves the signed-in user's camp with
--   .select('camp_id, role, name, subdivision_ids, assigned_divisions, accepted_at')
--     .eq('user_id', …).not('accepted_at','is',null)
-- and a stub missing accepted_at fails that query, which sends the client down
-- its "no camp at all" path. The end-to-end harness needs that query to answer.
CREATE TABLE IF NOT EXISTS public.camp_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id uuid, user_id uuid, role text,
    email text, name text,
    accepted_at timestamptz,
    assigned_divisions jsonb, subdivision_ids jsonb,
    product_access jsonb, access_group_id uuid,
    access_preset text, section_access jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.camp_state_kv (
    camp_id uuid NOT NULL, key text NOT NULL, value jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, key));
-- 145's columns, so a chain that includes 145 (tests/e2e/db.js does) gets the
-- table it expects: CREATE TABLE IF NOT EXISTS there skips over this one, and a
-- stub missing `fingerprint` failed 145's unique index. Its constraints are left
-- off and fingerprint defaults, so a test inserting a bare deposit still can.
CREATE TABLE IF NOT EXISTS public.bank_deposits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid,
    fingerprint text NOT NULL DEFAULT gen_random_uuid()::text,
    amount_cents bigint, is_reversal boolean NOT NULL DEFAULT false, deposit_date date,
    payer_name text NOT NULL DEFAULT '', payer_handle text NOT NULL DEFAULT '',
    memo text NOT NULL DEFAULT '', memo_code text NOT NULL DEFAULT '',
    kind text NOT NULL DEFAULT 'ach', trace_id text NOT NULL DEFAULT '',
    bank text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'email',
    raw_subject text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'unmatched',
    family_key text, match_confidence integer NOT NULL DEFAULT 0,
    match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb, candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    guardrail text NOT NULL DEFAULT '', matched_by text NOT NULL DEFAULT 'auto',
    resolved_by uuid, resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid, source text,
    source_id text, title text, body text, link_target text,
    -- The columns the dashboard's own bell reads:
    --   .select('id, source, source_id, title, body, message, link_target,
    --            created_at, type, user_id, metadata, read')
    -- Not decoration either — see camp_users above.
    user_id uuid, type text, message text, metadata jsonb,
    read boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now(), read_at timestamptz,
    UNIQUE (camp_id, source, source_id));

-- The pre-camp_state_kv home for a camp's whole state. integration_hooks.js still
-- falls back to it when the kv read finds nothing, so without it every page load
-- logs a hydration failure that has nothing to do with the test.
CREATE TABLE IF NOT EXISTS public.camp_state (
    camp_id uuid PRIMARY KEY, state jsonb,
    updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_parent_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid, user_id uuid,
    token text, parent_name text, parent_email text, camper_names jsonb,
    camper_data jsonb, camp_connected boolean NOT NULL DEFAULT true,
    status text, billing_access boolean DEFAULT false,
    expires_at timestamptz, created_at timestamptz DEFAULT now());

-- The three tables a parent submits INTO, so 225's conversions have somewhere
-- to write and its behaviour test can read the row back.
CREATE TABLE IF NOT EXISTS public.parent_pickup_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    request_date date, type text, label text, camper_name text NOT NULL,
    camper_bunk text, parent_name text, parent_email text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb, status text,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_camper_mail (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    invite_id uuid, user_id uuid, camper_name text NOT NULL,
    division text, grade text, bunk text, parent_name text, parent_email text,
    subject text, body text, status text NOT NULL DEFAULT 'new',
    source text NOT NULL DEFAULT 'portal', inbound_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_camper_mail_inbound
    ON public.link_camper_mail (camp_id, inbound_fingerprint)
 WHERE inbound_fingerprint IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.link_form_responses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    invite_id uuid, user_id uuid, form_id text, form_name text, mode text,
    camper_name text NOT NULL, camper_id text, parent_name text, parent_email text,
    division text, grade text, bunk text, answers jsonb, signature_data text,
    file_name text, file_data text, filled_pdf_path text,
    created_at timestamptz NOT NULL DEFAULT now());

-- 028/029's facial-recognition tables, 081's photo purchases and 017's staff
-- tip accounts, so 226 has the whole consent surface to work on.
CREATE TABLE IF NOT EXISTS public.link_photos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    image_data text, file_name text, week text, uploaded_by uuid,
    faces_found int NOT NULL DEFAULT 0, sent boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_photo_tags (
    photo_id uuid NOT NULL REFERENCES public.link_photos(id) ON DELETE CASCADE,
    camp_id uuid NOT NULL, camper_name text NOT NULL,
    confidence real, manual boolean NOT NULL DEFAULT false,
    pending boolean NOT NULL DEFAULT false,
    PRIMARY KEY (photo_id, camper_name));
CREATE TABLE IF NOT EXISTS public.link_camper_faces (
    camp_id uuid NOT NULL, camper_name text NOT NULL,
    descriptor jsonb, headshot_data text,
    consent boolean NOT NULL DEFAULT false, consent_by uuid, consent_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, camper_name));
CREATE TABLE IF NOT EXISTS public.link_camper_face_descriptors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    camper_name text NOT NULL, model text NOT NULL DEFAULT 'faceapi-128',
    pose text NOT NULL DEFAULT 'front', source text NOT NULL DEFAULT 'parent',
    descriptor jsonb NOT NULL, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_photo_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id uuid NOT NULL REFERENCES public.camps(id),
    parent_user_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('facial_recognition', 'hd_photo')),
    camper_name text, photo_id uuid REFERENCES public.link_photos(id),
    amount_paid_cents integer NOT NULL, stripe_payment_intent_id text NOT NULL,
    purchased_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_photo_purchase
    ON public.link_photo_purchases (stripe_payment_intent_id, kind,
        (COALESCE(camper_name, '')),
        (COALESCE(photo_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE TABLE IF NOT EXISTS public.link_staff_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    staff_name text NOT NULL, role text NOT NULL DEFAULT '',
    access_code text NOT NULL DEFAULT 'TEST-0000',
    balance numeric(10,2) NOT NULL DEFAULT 0,
    total_earned numeric(10,2) NOT NULL DEFAULT 0,
    total_paid_out numeric(10,2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_staff_accounts
    ON public.link_staff_accounts (camp_id, lower(staff_name));

-- 106's camp-wide "does this camp run Camper Mail" gate.
CREATE OR REPLACE FUNCTION public._link_program_enabled(p_camp_id uuid, p_program text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$ SELECT true $$;

-- Helpers earlier migrations define, stubbed so a later file can be tried on
-- its own. A migration that defines them itself just replaces these.
CREATE OR REPLACE FUNCTION public._num_or_null(p text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $$
BEGIN RETURN p::numeric; EXCEPTION WHEN OTHERS THEN RETURN NULL; END; $$;

CREATE OR REPLACE FUNCTION public._ts_or_null(p text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $$
BEGIN RETURN p::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN NULL; END; $$;

-- 097's admin gate, copied verbatim rather than simplified: 232 refuses a
-- restamp from anyone who is not an owner or admin, and a stub that always said
-- yes would make that refusal untestable — which is how a gate ships open.
CREATE OR REPLACE FUNCTION public._is_camp_admin(p_camp_id uuid, p_caller uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = p_caller)
        OR EXISTS (SELECT 1 FROM camp_users
                   WHERE camp_id = p_camp_id AND user_id = p_caller AND role IN ('owner', 'admin'));
$$;

-- 183's staff gate, copied verbatim for the same reason _is_camp_admin is: 200's
-- get_camp_applications refuses through it, and a stub that always said yes would
-- make that refusal untestable. 183 itself cannot be applied on these stubs (it
-- re-grants flag_expiring_cards, from a migration older than any bundle).
CREATE OR REPLACE FUNCTION public.camp_staff_member(p_camp_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
    SELECT p_camp_id IS NOT NULL AND auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = auth.uid()
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = auth.uid()
           AND accepted_at IS NOT NULL
    );
$$;

-- 183's parent side, verbatim, and its camp_reader built from the two. Before
-- these were here every reader's PARENT branch failed on the stubs with
-- "function does not exist" and was caught by its own EXCEPTION handler — so
-- no test in this repo had ever exercised what a parent is shown.
CREATE OR REPLACE FUNCTION public.camp_parent_campers(p_camp_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
    SELECT COALESCE(
        (SELECT jsonb_agg(DISTINCT n)
           FROM link_parent_invites i,
                LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                         THEN i.camper_names ELSE '[]'::jsonb END) n
          WHERE i.camp_id = p_camp_id
            AND i.user_id = auth.uid()
            AND (i.status = 'active' OR i.billing_access = true)
            AND (i.expires_at IS NULL OR i.expires_at > now())),
        '[]'::jsonb);
$$;
CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
    SELECT public.camp_staff_member(p_camp_id)
        OR jsonb_array_length(public.camp_parent_campers(p_camp_id)) > 0;
$$;

CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$ SELECT 'edit'::text $$;

-- 010's active camp and the two resolvers that read it, copied VERBATIM.
--
-- These used to be `SELECT 'owner'` and nothing. That is fine for a migration
-- try, where the question is only whether a file applies — and wrong for
-- anything that asks what a CALLER may do: settle_shop_order's first line is
-- `p_camp_id <> get_user_camp_id()` and its second is `get_user_role()`, so a
-- stub that answered 'owner' to everyone made both refusals untestable. Same
-- reason _is_camp_admin and camp_staff_member are verbatim.
CREATE TABLE IF NOT EXISTS public.active_camp_selection (
    user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    camp_id    uuid        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now());

CREATE OR REPLACE FUNCTION public.get_user_camp_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
    SELECT COALESCE(
        (SELECT acs.camp_id
           FROM active_camp_selection acs
          WHERE acs.user_id = auth.uid()
            AND (
                EXISTS (SELECT 1 FROM camps c
                         WHERE c.id = acs.camp_id AND c.owner = auth.uid())
                OR EXISTS (SELECT 1 FROM camp_users cu
                            WHERE cu.user_id = auth.uid()
                              AND cu.camp_id = acs.camp_id
                              AND cu.accepted_at IS NOT NULL)
            )
          LIMIT 1),
        (SELECT cu.camp_id
           FROM camp_users cu
          WHERE cu.user_id = auth.uid()
            AND cu.accepted_at IS NOT NULL
          ORDER BY cu.accepted_at DESC
          LIMIT 1),
        (SELECT c.id
           FROM camps c
          WHERE c.owner = auth.uid()
          ORDER BY (c.id = auth.uid()) DESC
          LIMIT 1)
    )
$$;

CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
    SELECT COALESCE(
        (SELECT cu.role
           FROM camp_users cu
          WHERE cu.user_id = auth.uid()
            AND cu.camp_id = public.get_user_camp_id()
            AND cu.accepted_at IS NOT NULL
          LIMIT 1),
        (SELECT 'owner'::text
           FROM camps c
          WHERE c.id = public.get_user_camp_id()
            AND c.owner = auth.uid()
          LIMIT 1),
        'viewer'
    )
$$;

-- 205's projections, so a later migration that reads them can be tried alone.
CREATE TABLE IF NOT EXISTS public.camp_billing_config (
    camp_id uuid PRIMARY KEY, sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
    enroll_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.camp_billing_enrollments (
    camp_id uuid NOT NULL, entry_id text NOT NULL,
    camper_name text NOT NULL DEFAULT '', payload jsonb NOT NULL,
    PRIMARY KEY (camp_id, entry_id));
-- 211's families rows, which 212's camp_families_object reads and 214's
-- use_family_card_for_canteen_auto_reload reaches through it.
-- The FULL 211 shape, name and camper_ids included. An abbreviated stub is
-- worse than none here: 211 creates this table with CREATE TABLE IF NOT EXISTS,
-- so a short stub wins and then 211's own index on camper_ids fails, which makes
-- 211 impossible to try even though it is correct.
CREATE TABLE IF NOT EXISTS public.camp_families (
    camp_id uuid NOT NULL, family_key text NOT NULL,
    name text NOT NULL DEFAULT '',
    camper_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at timestamptz,
    first_seen timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, family_key));
CREATE TABLE IF NOT EXISTS public.camp_billing_families (
    camp_id uuid NOT NULL, family_key text NOT NULL,
    camper_ids jsonb NOT NULL DEFAULT '[]'::jsonb, payload jsonb NOT NULL,
    PRIMARY KEY (camp_id, family_key));
-- 203's canteen ledger, shape-for-shape, so a later migration that posts to it
-- can be tried without dragging in 203's own prerequisites. The PK is what
-- makes a double-post impossible, so it is not optional here.
CREATE TABLE IF NOT EXISTS public.canteen_transactions (
    camp_id    uuid        NOT NULL,
    sig        text        NOT NULL,
    camper     text        NOT NULL DEFAULT '',
    camper_id  text,
    tx_type    text        NOT NULL DEFAULT '',
    amount     numeric     NOT NULL DEFAULT 0,
    tx_date    text        NOT NULL DEFAULT '',
    tx_time    text        NOT NULL DEFAULT '',
    items      text        NOT NULL DEFAULT '',
    payload    jsonb       NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, sig));

CREATE TABLE IF NOT EXISTS public.camp_billing_payments (
    camp_id uuid NOT NULL, seq integer NOT NULL,
    family_name text NOT NULL DEFAULT '', family_key text NOT NULL DEFAULT '',
    enrollment_id text NOT NULL DEFAULT '', payload jsonb NOT NULL,
    PRIMARY KEY (camp_id, seq));

-- Four of the twenty tables that identify a camper by NAME, so 223 has real
-- tables to give a person_id to and a behaviour test can prove the stamp works.
-- Chosen for their shapes rather than at random: one safety table, one with a
-- name in its PRIMARY KEY (so a later file that moves the key has something to
-- move), one health table, one money table.
CREATE TABLE IF NOT EXISTS public.pickup_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    camper_name text NOT NULL, camper_bunk text, camper_division text,
    camper_grade text, status text NOT NULL DEFAULT 'open',
    -- 064's column, and 235's whole subject: the two league functions read and
    -- write it, and one of them used to report success without touching it.
    league_check_state text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now());
-- 064's recipients, with the UNIQUE that makes the ON CONFLICT in 235's
-- add_pickup_alert_league_recipients a no-op rather than an error.
CREATE TABLE IF NOT EXISTS public.pickup_alert_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id uuid NOT NULL REFERENCES public.pickup_alerts(id) ON DELETE CASCADE,
    camp_id uuid NOT NULL, recipient_role text NOT NULL,
    recipient_name text, recipient_email text NOT NULL DEFAULT '',
    ack_state text NOT NULL DEFAULT 'unseen',
    acknowledged_at timestamptz, snoozed_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alert_id, recipient_email));
-- 134's hosted-checkout intents. camper_name is what 223 hangs a person_id on.
CREATE TABLE IF NOT EXISTS public.cardknox_checkout_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    reference text NOT NULL UNIQUE, kind text NOT NULL,
    family_key text, family_name text, camper_name text,
    amount_cents integer NOT NULL, description text,
    status text NOT NULL DEFAULT 'pending', xref_num text,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_photo_tags (
    photo_id uuid NOT NULL, camper_name text NOT NULL, camp_id uuid NOT NULL,
    source text, confidence numeric,
    PRIMARY KEY (photo_id, camper_name));
CREATE TABLE IF NOT EXISTS public.link_health_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    camper_name text NOT NULL, file_name text, file_type text, file_data text,
    note text, status text NOT NULL DEFAULT 'pending',
    reviewed_by uuid, reviewed_at timestamptz, review_notes text,
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.link_tips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid NOT NULL,
    invite_id uuid, user_id uuid, camper_name text,
    parent_name text, parent_email text,
    recipient_name text NOT NULL, recipient_role text,
    amount numeric(8,2) NOT NULL, status text NOT NULL DEFAULT 'recorded',
    payment_method text NOT NULL DEFAULT 'manual',
    stripe_payment_intent_id text, fee_amount numeric(8,2),
    staff_account_id uuid, stripe_transfer_id text,
    created_at timestamptz NOT NULL DEFAULT now());
