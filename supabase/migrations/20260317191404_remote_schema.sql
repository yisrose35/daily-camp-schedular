drop extension if exists "pg_net";


  create table "public"."camp_owners" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid not null,
    "camp_id" uuid not null,
    "email" text not null,
    "name" text,
    "phone" text,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now(),
    "camp_name" text,
    "access_status" text default 'unknown'::text
      );


alter table "public"."camp_owners" enable row level security;


  create table "public"."camp_state" (
    "camp_id" uuid not null,
    "owner_id" uuid,
    "divisions" jsonb default '{}'::jsonb,
    "bunks" jsonb default '[]'::jsonb,
    "activities" jsonb default '[]'::jsonb,
    "skeleton" jsonb default '[]'::jsonb,
    "settings" jsonb default '{}'::jsonb,
    "state" jsonb default '{}'::jsonb,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now(),
    "last_modified_by" text,
    "version" integer not null default 1
      );


alter table "public"."camp_state" enable row level security;


  create table "public"."camp_users" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "user_id" uuid,
    "email" text not null,
    "name" text,
    "role" text not null default 'viewer'::text,
    "subdivision_ids" uuid[] default '{}'::uuid[],
    "assigned_divisions" text[] default '{}'::text[],
    "invited_at" timestamp with time zone default now(),
    "accepted_at" timestamp with time zone,
    "invite_token" uuid default gen_random_uuid(),
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now(),
    "invited_by" uuid
      );


alter table "public"."camp_users" enable row level security;


  create table "public"."campistry_config" (
    "key" text not null,
    "value" text not null,
    "updated_at" timestamp with time zone default now()
      );


alter table "public"."campistry_config" enable row level security;


  create table "public"."camps" (
    "id" uuid not null default gen_random_uuid(),
    "owner" uuid not null,
    "name" text not null,
    "address" text,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now(),
    "trial_started_at" timestamp with time zone,
    "plan_status" text default 'active'::text,
    "trial_hours" integer default 48
      );


alter table "public"."camps" enable row level security;


  create table "public"."daily_schedules" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "date_key" date not null,
    "scheduler_id" uuid,
    "scheduler_name" text,
    "divisions" text[] default '{}'::text[],
    "schedule_data" jsonb not null default '{}'::jsonb,
    "unified_times" jsonb default '[]'::jsonb,
    "is_rainy_day" boolean default false,
    "version" integer default 1,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now()
      );


alter table "public"."daily_schedules" enable row level security;


  create table "public"."field_locks" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "schedule_date" text not null,
    "locks" jsonb default '{}'::jsonb,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now()
      );


alter table "public"."field_locks" enable row level security;


  create table "public"."notifications" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "user_id" uuid not null,
    "type" text not null,
    "title" text not null,
    "message" text,
    "metadata" jsonb default '{}'::jsonb,
    "read" boolean default false,
    "created_at" timestamp with time zone default now()
      );


alter table "public"."notifications" enable row level security;


  create table "public"."promo_codes" (
    "id" uuid not null default gen_random_uuid(),
    "code" text not null,
    "is_active" boolean default true,
    "code_type" text not null default 'trial'::text,
    "trial_hours" integer default 48,
    "max_uses" integer,
    "times_used" integer default 0,
    "created_at" timestamp with time zone default now(),
    "expires_at" timestamp with time zone,
    "description" text
      );


alter table "public"."promo_codes" enable row level security;


  create table "public"."schedule_proposals" (
    "id" text not null,
    "type" text not null default 'multi_bunk_edit'::text,
    "status" text not null default 'pending'::text,
    "created_at" timestamp with time zone default now(),
    "created_by" uuid,
    "camp_id" uuid,
    "date_key" text not null,
    "claim" jsonb not null,
    "reassignments" jsonb not null default '[]'::jsonb,
    "affected_divisions" text[] not null default '{}'::text[],
    "approvals" jsonb not null default '{}'::jsonb,
    "applied" boolean default false,
    "applied_at" timestamp with time zone
      );


alter table "public"."schedule_proposals" enable row level security;


  create table "public"."schedule_versions" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "date_key" date not null,
    "name" text not null,
    "schedule_data" jsonb not null default '{}'::jsonb,
    "created_by" uuid,
    "created_at" timestamp with time zone default now()
      );


alter table "public"."schedule_versions" enable row level security;


  create table "public"."subdivisions" (
    "id" uuid not null default gen_random_uuid(),
    "camp_id" uuid not null,
    "name" text not null,
    "divisions" text[] default '{}'::text[],
    "description" text,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now(),
    "color" text default '#6B7280'::text
      );


alter table "public"."subdivisions" enable row level security;

CREATE UNIQUE INDEX camp_owners_camp_id_key ON public.camp_owners USING btree (camp_id);

CREATE UNIQUE INDEX camp_owners_pkey ON public.camp_owners USING btree (id);

CREATE UNIQUE INDEX camp_owners_user_id_key ON public.camp_owners USING btree (user_id);

CREATE UNIQUE INDEX camp_state_pkey ON public.camp_state USING btree (camp_id);

CREATE UNIQUE INDEX camp_users_camp_id_email_key ON public.camp_users USING btree (camp_id, email);

CREATE UNIQUE INDEX camp_users_pkey ON public.camp_users USING btree (id);

CREATE UNIQUE INDEX campistry_config_pkey ON public.campistry_config USING btree (key);

CREATE UNIQUE INDEX camps_owner_key ON public.camps USING btree (owner);

CREATE UNIQUE INDEX camps_pkey ON public.camps USING btree (id);

CREATE UNIQUE INDEX daily_schedules_camp_id_date_key_scheduler_id_key ON public.daily_schedules USING btree (camp_id, date_key, scheduler_id);

CREATE UNIQUE INDEX daily_schedules_pkey ON public.daily_schedules USING btree (id);

CREATE UNIQUE INDEX field_locks_camp_id_schedule_date_key ON public.field_locks USING btree (camp_id, schedule_date);

CREATE UNIQUE INDEX field_locks_pkey ON public.field_locks USING btree (id);

CREATE INDEX idx_camp_owners_camp_id ON public.camp_owners USING btree (camp_id);

CREATE INDEX idx_camp_owners_user_id ON public.camp_owners USING btree (user_id);

CREATE INDEX idx_camp_users_camp ON public.camp_users USING btree (camp_id);

CREATE INDEX idx_camp_users_token ON public.camp_users USING btree (invite_token);

CREATE INDEX idx_camp_users_user ON public.camp_users USING btree (user_id);

CREATE INDEX idx_camps_owner ON public.camps USING btree (owner);

CREATE INDEX idx_camps_plan_status ON public.camps USING btree (plan_status);

CREATE INDEX idx_daily_schedules_camp_date ON public.daily_schedules USING btree (camp_id, date_key);

CREATE INDEX idx_daily_schedules_date_range ON public.daily_schedules USING btree (camp_id, date_key DESC);

CREATE INDEX idx_daily_schedules_scheduler ON public.daily_schedules USING btree (camp_id, scheduler_id);

CREATE INDEX idx_notifications_camp ON public.notifications USING btree (camp_id);

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);

CREATE INDEX idx_proposals_affected_divisions ON public.schedule_proposals USING gin (affected_divisions);

CREATE INDEX idx_proposals_camp_status ON public.schedule_proposals USING btree (camp_id, status);

CREATE INDEX idx_proposals_date ON public.schedule_proposals USING btree (date_key);

CREATE INDEX idx_schedule_versions_camp_date ON public.schedule_versions USING btree (camp_id, date_key);

CREATE INDEX idx_subdivisions_camp ON public.subdivisions USING btree (camp_id);

CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id);

CREATE UNIQUE INDEX promo_codes_code_key ON public.promo_codes USING btree (code);

CREATE UNIQUE INDEX promo_codes_pkey ON public.promo_codes USING btree (id);

CREATE UNIQUE INDEX schedule_proposals_pkey ON public.schedule_proposals USING btree (id);

CREATE UNIQUE INDEX schedule_versions_camp_id_date_key_name_key ON public.schedule_versions USING btree (camp_id, date_key, name);

CREATE UNIQUE INDEX schedule_versions_pkey ON public.schedule_versions USING btree (id);

CREATE UNIQUE INDEX subdivisions_camp_id_name_key ON public.subdivisions USING btree (camp_id, name);

CREATE UNIQUE INDEX subdivisions_pkey ON public.subdivisions USING btree (id);

alter table "public"."camp_owners" add constraint "camp_owners_pkey" PRIMARY KEY using index "camp_owners_pkey";

alter table "public"."camp_state" add constraint "camp_state_pkey" PRIMARY KEY using index "camp_state_pkey";

alter table "public"."camp_users" add constraint "camp_users_pkey" PRIMARY KEY using index "camp_users_pkey";

alter table "public"."campistry_config" add constraint "campistry_config_pkey" PRIMARY KEY using index "campistry_config_pkey";

alter table "public"."camps" add constraint "camps_pkey" PRIMARY KEY using index "camps_pkey";

alter table "public"."daily_schedules" add constraint "daily_schedules_pkey" PRIMARY KEY using index "daily_schedules_pkey";

alter table "public"."field_locks" add constraint "field_locks_pkey" PRIMARY KEY using index "field_locks_pkey";

alter table "public"."notifications" add constraint "notifications_pkey" PRIMARY KEY using index "notifications_pkey";

alter table "public"."promo_codes" add constraint "promo_codes_pkey" PRIMARY KEY using index "promo_codes_pkey";

alter table "public"."schedule_proposals" add constraint "schedule_proposals_pkey" PRIMARY KEY using index "schedule_proposals_pkey";

alter table "public"."schedule_versions" add constraint "schedule_versions_pkey" PRIMARY KEY using index "schedule_versions_pkey";

alter table "public"."subdivisions" add constraint "subdivisions_pkey" PRIMARY KEY using index "subdivisions_pkey";

alter table "public"."camp_owners" add constraint "camp_owners_camp_id_fkey" FOREIGN KEY (camp_id) REFERENCES public.camps(id) ON DELETE CASCADE not valid;

alter table "public"."camp_owners" validate constraint "camp_owners_camp_id_fkey";

alter table "public"."camp_owners" add constraint "camp_owners_camp_id_key" UNIQUE using index "camp_owners_camp_id_key";

alter table "public"."camp_owners" add constraint "camp_owners_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."camp_owners" validate constraint "camp_owners_user_id_fkey";

alter table "public"."camp_owners" add constraint "camp_owners_user_id_key" UNIQUE using index "camp_owners_user_id_key";

alter table "public"."camp_users" add constraint "camp_users_camp_id_email_key" UNIQUE using index "camp_users_camp_id_email_key";

alter table "public"."camp_users" add constraint "camp_users_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id) not valid;

alter table "public"."camp_users" validate constraint "camp_users_invited_by_fkey";

alter table "public"."camp_users" add constraint "camp_users_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'scheduler'::text, 'viewer'::text]))) not valid;

alter table "public"."camp_users" validate constraint "camp_users_role_check";

alter table "public"."camp_users" add constraint "camp_users_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."camp_users" validate constraint "camp_users_user_id_fkey";

alter table "public"."camps" add constraint "camps_owner_fkey" FOREIGN KEY (owner) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."camps" validate constraint "camps_owner_fkey";

alter table "public"."camps" add constraint "camps_owner_key" UNIQUE using index "camps_owner_key";

alter table "public"."camps" add constraint "camps_plan_status_check" CHECK ((plan_status = ANY (ARRAY['trial'::text, 'active'::text, 'paid'::text, 'founding_member'::text, 'expired'::text]))) not valid;

alter table "public"."camps" validate constraint "camps_plan_status_check";

alter table "public"."daily_schedules" add constraint "daily_schedules_camp_id_date_key_scheduler_id_key" UNIQUE using index "daily_schedules_camp_id_date_key_scheduler_id_key";

alter table "public"."field_locks" add constraint "field_locks_camp_id_schedule_date_key" UNIQUE using index "field_locks_camp_id_schedule_date_key";

alter table "public"."notifications" add constraint "notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."notifications" validate constraint "notifications_user_id_fkey";

alter table "public"."promo_codes" add constraint "promo_codes_code_key" UNIQUE using index "promo_codes_code_key";

alter table "public"."promo_codes" add constraint "promo_codes_code_type_check" CHECK ((code_type = ANY (ARRAY['trial'::text, 'full_access'::text]))) not valid;

alter table "public"."promo_codes" validate constraint "promo_codes_code_type_check";

alter table "public"."schedule_proposals" add constraint "schedule_proposals_camp_id_fkey" FOREIGN KEY (camp_id) REFERENCES public.camps(id) not valid;

alter table "public"."schedule_proposals" validate constraint "schedule_proposals_camp_id_fkey";

alter table "public"."schedule_proposals" add constraint "schedule_proposals_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;

alter table "public"."schedule_proposals" validate constraint "schedule_proposals_created_by_fkey";

alter table "public"."schedule_versions" add constraint "schedule_versions_camp_id_date_key_name_key" UNIQUE using index "schedule_versions_camp_id_date_key_name_key";

alter table "public"."subdivisions" add constraint "subdivisions_camp_id_name_key" UNIQUE using index "subdivisions_camp_id_name_key";

set check_function_bodies = off;

create or replace view "public"."camp_state_with_name" as  SELECT cs.camp_id,
    cs.owner_id,
    cs.divisions,
    cs.bunks,
    cs.activities,
    cs.skeleton,
    cs.settings,
    cs.state,
    cs.created_at,
    cs.updated_at,
    cs.last_modified_by,
    cs.version,
    c.name AS camp_name
   FROM (public.camp_state cs
     JOIN public.camps c ON ((c.id = cs.camp_id)));


CREATE OR REPLACE FUNCTION public.can_access_camp(check_camp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT (
        public.is_camp_owner(check_camp_id)
        OR
        public.is_camp_member(check_camp_id)
    );
$function$
;

CREATE OR REPLACE FUNCTION public.can_edit_division(p_camp_id uuid, p_user_id uuid, p_division text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_role TEXT;
    v_subdivision_ids UUID[];
    v_can_edit BOOLEAN := FALSE;
BEGIN
    -- Get user's role and subdivision access
    SELECT role, subdivision_ids INTO v_role, v_subdivision_ids
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = p_user_id;
    
    -- Owner and admin can edit everything
    IF v_role IN ('owner', 'admin') THEN
        RETURN TRUE;
    END IF;
    
    -- Viewer can't edit anything
    IF v_role = 'viewer' OR v_role IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Scheduler: check if division is in their subdivisions
    IF v_role = 'scheduler' THEN
        -- If no subdivision restriction, can edit all
        IF v_subdivision_ids IS NULL OR array_length(v_subdivision_ids, 1) IS NULL THEN
            RETURN TRUE;
        END IF;
        
        -- Check if division belongs to any of their subdivisions
        SELECT EXISTS (
            SELECT 1 FROM subdivisions
            WHERE id = ANY(v_subdivision_ids)
            AND p_division = ANY(divisions)
        ) INTO v_can_edit;
        
        RETURN v_can_edit;
    END IF;
    
    RETURN FALSE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.can_manage_camp(check_camp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(
        public.get_camp_role(check_camp_id) IN ('owner', 'admin'),
        false
    );
$function$
;

CREATE OR REPLACE FUNCTION public.can_write_camp(check_camp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(
        public.get_camp_role(check_camp_id) IN ('owner', 'admin', 'scheduler'),
        false
    );
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_field_locks()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Only run if expires_at column exists
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'field_locks' AND column_name = 'expires_at') THEN
        DELETE FROM field_locks 
        WHERE expires_at IS NOT NULL AND expires_at < NOW();
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_team_member_full(member_row_id uuid, requesting_camp_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    member_record RECORD;
BEGIN
    -- 1. Find the camp_users row and verify it belongs to the requesting camp
    SELECT id, email, user_id, camp_id
    INTO member_record
    FROM camp_users
    WHERE id = member_row_id AND camp_id = requesting_camp_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Member not found in your camp');
    END IF;

    -- 2. Delete from auth.identities (if they had an auth account)
    IF member_record.user_id IS NOT NULL THEN
        DELETE FROM auth.identities WHERE user_id = member_record.user_id;
        DELETE FROM auth.users WHERE id = member_record.user_id;
    END IF;

    -- 3. Delete the camp_users row
    DELETE FROM camp_users WHERE id = member_row_id AND camp_id = requesting_camp_id;

    RETURN jsonb_build_object('success', true, 'email', member_record.email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_single_active_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- If setting this version to active, deactivate others for same camp/date
    IF NEW.is_active = true THEN
        UPDATE schedule_versions 
        SET is_active = false 
        WHERE camp_id = NEW.camp_id 
        AND date = NEW.date 
        AND id != NEW.id
        AND is_active = true;
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_camp_role(check_camp_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- Check if owner first
    SELECT CASE
        WHEN EXISTS (
            SELECT 1 FROM camps WHERE id = check_camp_id AND owner = auth.uid()
        ) THEN 'owner'
        ELSE (
            SELECT role FROM camp_users
            WHERE camp_id = check_camp_id
              AND user_id = auth.uid()
              AND accepted_at IS NOT NULL
            LIMIT 1
        )
    END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_editable_divisions(p_camp_id uuid, p_user_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_role TEXT;
    v_subdivision_ids UUID[];
    v_divisions TEXT[] := '{}';
BEGIN
    -- Check if user is the camp owner
    IF p_camp_id = p_user_id THEN
        -- Return all divisions from camp_state
        SELECT COALESCE(array_agg(div), '{}')
        INTO v_divisions
        FROM (
            SELECT jsonb_object_keys(state->'divisions') as div
            FROM camp_state
            WHERE camp_id = p_camp_id
        ) subq;
        RETURN v_divisions;
    END IF;
    
    -- Get user's role and subdivision access
    SELECT role, subdivision_ids INTO v_role, v_subdivision_ids
    FROM camp_users
    WHERE camp_id = p_camp_id AND user_id = p_user_id;
    
    -- Owner and admin can edit all divisions
    IF v_role IN ('owner', 'admin') THEN
        SELECT COALESCE(array_agg(div), '{}')
        INTO v_divisions
        FROM (
            SELECT jsonb_object_keys(state->'divisions') as div
            FROM camp_state
            WHERE camp_id = p_camp_id
        ) subq;
        RETURN v_divisions;
    END IF;
    
    -- Viewer can't edit anything
    IF v_role = 'viewer' OR v_role IS NULL THEN
        RETURN '{}';
    END IF;
    
    -- Scheduler: return divisions from their subdivisions
    IF v_role = 'scheduler' THEN
        IF v_subdivision_ids IS NULL OR array_length(v_subdivision_ids, 1) IS NULL THEN
            -- No restriction, return all
            SELECT COALESCE(array_agg(div), '{}')
            INTO v_divisions
            FROM (
                SELECT jsonb_object_keys(state->'divisions') as div
                FROM camp_state
                WHERE camp_id = p_camp_id
            ) subq;
        ELSE
            -- Return only divisions in their subdivisions
            SELECT COALESCE(array_agg(DISTINCT d), '{}')
            INTO v_divisions
            FROM subdivisions s, unnest(s.divisions) d
            WHERE s.id = ANY(v_subdivision_ids);
        END IF;
        RETURN v_divisions;
    END IF;
    
    RETURN '{}';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_camp_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    camp uuid;
BEGIN
    -- Check team membership first (most users are team members)
    SELECT camp_id INTO camp
    FROM camp_users
    WHERE user_id = auth.uid()
      AND accepted_at IS NOT NULL
    LIMIT 1;
    
    IF camp IS NOT NULL THEN
        RETURN camp;
    END IF;
    
    -- Check camp ownership (camp.owner = user.id)
    -- In Campistry, owner stores the user's auth UUID
    SELECT id INTO camp
    FROM camps
    WHERE owner = auth.uid()
    LIMIT 1;
    
    RETURN camp;  -- NULL if user has no camp
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_role()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    user_role text;
BEGIN
    -- Team member role
    SELECT role INTO user_role
    FROM camp_users
    WHERE user_id = auth.uid()
      AND accepted_at IS NOT NULL
    LIMIT 1;
    
    IF user_role IS NOT NULL THEN
        RETURN user_role;
    END IF;
    
    -- Camp owner
    IF EXISTS (SELECT 1 FROM camps WHERE owner = auth.uid()) THEN
        RETURN 'owner';
    END IF;
    
    RETURN 'viewer';  -- Safe default
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_camp_member(check_camp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM camp_users
        WHERE camp_id = check_camp_id
          AND user_id = auth.uid()
          AND accepted_at IS NOT NULL
    );
$function$
;

CREATE OR REPLACE FUNCTION public.is_camp_owner(check_camp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM camps
        WHERE id = check_camp_id
          AND owner = auth.uid()
    );
$function$
;

CREATE OR REPLACE FUNCTION public.lookup_invite(token_value text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    result json;
BEGIN
    SELECT json_build_object(
        'camp_id', cu.camp_id,
        'email', cu.email,
        'role', cu.role,
        'name', cu.name,
        'subdivision_ids', cu.subdivision_ids,
        'accepted_at', cu.accepted_at,
        'created_at', cu.created_at,
        'camp_name', COALESCE(c.name, 'Your Camp')
    ) INTO result
    FROM camp_users cu
    LEFT JOIN camps c ON c.id = cu.camp_id
    WHERE cu.invite_token = token_value::uuid
    LIMIT 1;
    
    RETURN result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_camp_state(p_camp_id text, p_partial_state jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_current RECORD;
    v_merged  JSONB;
    v_now     TIMESTAMPTZ := now();
BEGIN
    -- Lock the row for this camp (or create it)
    SELECT state, version INTO v_current
    FROM camp_state
    WHERE camp_id = p_camp_id
    FOR UPDATE;

    -- Optimistic lock check: if caller expects a specific version, reject stale writes
    IF p_expected_version IS NOT NULL
       AND v_current.version IS NOT NULL
       AND v_current.version != p_expected_version THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'version_conflict',
            'server_version', v_current.version,
            'your_version', p_expected_version
        );
    END IF;

    IF v_current IS NULL THEN
        -- First write for this camp
        v_merged := p_partial_state || jsonb_build_object('updated_at', v_now);

        INSERT INTO camp_state (camp_id, state, version, updated_at)
        VALUES (p_camp_id, v_merged, 1, v_now);

        RETURN jsonb_build_object('ok', true, 'version', 1);
    ELSE
        -- Deep-merge: top-level keys from partial overwrite current,
        -- but app1 is deep-merged to preserve skeletons/sports/etc.
        v_merged := v_current.state || p_partial_state;

        -- Deep-merge app1 specifically
        IF p_partial_state ? 'app1' AND v_current.state ? 'app1' THEN
            v_merged := jsonb_set(
                v_merged,
                '{app1}',
                (v_current.state->'app1') || (p_partial_state->'app1')
            );
        END IF;

        v_merged := jsonb_set(v_merged, '{updated_at}', to_jsonb(v_now));

        UPDATE camp_state
        SET state = v_merged,
            version = v_current.version + 1,
            updated_at = v_now
        WHERE camp_id = p_camp_id;

        RETURN jsonb_build_object('ok', true, 'version', v_current.version + 1);
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.save_schedule_filtered(p_camp_id uuid, p_date_key text, p_scheduler_id uuid, p_scheduler_name text, p_divisions text[], p_schedule_data jsonb, p_unified_times jsonb DEFAULT '[]'::jsonb, p_is_rainy_day boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_role text;
    v_allowed_divisions text[];
    v_requested_divisions text[];
    v_unauthorized text[];
BEGIN
    -- 1. Verify the caller has write access
    v_role := public.get_camp_role(p_camp_id);

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Access denied: not a member of this camp';
    END IF;

    IF v_role = 'viewer' THEN
        RAISE EXCEPTION 'Access denied: viewers cannot write schedules';
    END IF;

    -- 2. Schedulers can only write their own record
    IF v_role = 'scheduler' AND p_scheduler_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: schedulers can only save their own schedule';
    END IF;

    -- 3. For schedulers, verify division scope
    IF v_role = 'scheduler' THEN
        -- Get scheduler's allowed divisions from their membership
        SELECT COALESCE(cu.assigned_divisions, '{}')
        INTO v_allowed_divisions
        FROM camp_users cu
        WHERE cu.camp_id = p_camp_id
          AND cu.user_id = auth.uid()
          AND cu.accepted_at IS NOT NULL
        LIMIT 1;

        -- Also check subdivision-based assignments
        -- (divisions assigned via subdivisions)
        SELECT ARRAY(
            SELECT DISTINCT unnest(cs.divisions)
            FROM subdivisions cs
            WHERE cs.camp_id = p_camp_id
              AND cs.id = ANY(
                  SELECT unnest(cu2.subdivision_ids)
                  FROM camp_users cu2
                  WHERE cu2.camp_id = p_camp_id
                    AND cu2.user_id = auth.uid()
                    AND cu2.accepted_at IS NOT NULL
              )
        ) INTO v_allowed_divisions
        WHERE v_allowed_divisions = '{}' OR v_allowed_divisions IS NULL;

        -- Check if requested divisions are within allowed set
        v_requested_divisions := p_divisions;
        v_unauthorized := ARRAY(
            SELECT unnest(v_requested_divisions)
            EXCEPT
            SELECT unnest(v_allowed_divisions)
        );

        IF array_length(v_unauthorized, 1) > 0 THEN
            RAISE EXCEPTION 'Access denied: scheduler not authorized for divisions: %',
                array_to_string(v_unauthorized, ', ');
        END IF;
    END IF;

    -- 4. Perform the upsert
    INSERT INTO daily_schedules (
        camp_id, date_key, scheduler_id, scheduler_name,
        divisions, schedule_data, unified_times, is_rainy_day, updated_at
    ) VALUES (
        p_camp_id, p_date_key, p_scheduler_id, p_scheduler_name,
        p_divisions, p_schedule_data, p_unified_times, p_is_rainy_day,
        now()
    )
    ON CONFLICT (camp_id, date_key, scheduler_id)
    DO UPDATE SET
        scheduler_name = EXCLUDED.scheduler_name,
        divisions      = EXCLUDED.divisions,
        schedule_data  = EXCLUDED.schedule_data,
        unified_times  = EXCLUDED.unified_times,
        is_rainy_day   = EXCLUDED.is_rainy_day,
        updated_at     = now();

    RETURN jsonb_build_object(
        'success', true,
        'role', v_role,
        'camp_id', p_camp_id,
        'date_key', p_date_key
    );
END;
$function$
;

create or replace view "public"."trial_camps" as  SELECT c.id AS camp_id,
    c.name AS camp_name,
    u.email AS owner_email,
    c.trial_started_at,
    (c.trial_started_at + ('01:00:00'::interval * (COALESCE(c.trial_hours, 48))::double precision)) AS trial_ends_at,
        CASE
            WHEN (c.plan_status = ANY (ARRAY['active'::text, 'paid'::text, 'founding_member'::text])) THEN 'Upgraded'::text
            WHEN ((c.trial_started_at + ('01:00:00'::interval * (COALESCE(c.trial_hours, 48))::double precision)) > now()) THEN 'Active'::text
            ELSE 'Expired'::text
        END AS status,
    c.trial_hours,
    c.plan_status
   FROM (public.camps c
     JOIN auth.users u ON ((u.id = c.owner)))
  WHERE (c.trial_started_at IS NOT NULL)
  ORDER BY c.trial_started_at DESC;


CREATE OR REPLACE FUNCTION public.update_schedule_version_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_camp_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    valid_code TEXT;
    provided_code TEXT;
BEGIN
    SELECT value INTO valid_code FROM campistry_config WHERE key = 'access_code';
    
    IF valid_code IS NULL THEN
        RETURN NEW;
    END IF;
    
    SELECT raw_user_meta_data->>'access_code' INTO provided_code
    FROM auth.users
    WHERE id = NEW.owner;
    
    -- Check normal access code
    IF provided_code IS NOT NULL AND provided_code = valid_code THEN
        RETURN NEW;
    END IF;
    
    -- Check promo codes table
    IF provided_code IS NOT NULL AND EXISTS(
        SELECT 1 FROM promo_codes 
        WHERE UPPER(code) = UPPER(provided_code)
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR times_used < max_uses)
    ) THEN
        RETURN NEW;
    END IF;
    
    RAISE EXCEPTION 'Invalid access code. Contact campistryoffice@gmail.com for access.'
        USING ERRCODE = 'P0001';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_promo_code(input_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    promo RECORD;
BEGIN
    SELECT * INTO promo
    FROM promo_codes
    WHERE UPPER(code) = UPPER(input_code);

    IF NOT FOUND THEN
        RETURN json_build_object('valid', false, 'error', 'not_promo');
    END IF;

    IF NOT promo.is_active THEN
        RETURN json_build_object('valid', false, 'error', 'This promo code is no longer active');
    END IF;

    IF promo.expires_at IS NOT NULL AND promo.expires_at < NOW() THEN
        RETURN json_build_object('valid', false, 'error', 'This promo code has expired');
    END IF;

    IF promo.max_uses IS NOT NULL AND promo.times_used >= promo.max_uses THEN
        RETURN json_build_object('valid', false, 'error', 'This promo code has reached its usage limit');
    END IF;

    UPDATE promo_codes SET times_used = times_used + 1 WHERE id = promo.id;

    RETURN json_build_object(
        'valid', true,
        'code_type', promo.code_type,
        'trial_hours', promo.trial_hours
    );
END;
$function$
;

grant delete on table "public"."camp_owners" to "anon";

grant insert on table "public"."camp_owners" to "anon";

grant references on table "public"."camp_owners" to "anon";

grant select on table "public"."camp_owners" to "anon";

grant trigger on table "public"."camp_owners" to "anon";

grant truncate on table "public"."camp_owners" to "anon";

grant update on table "public"."camp_owners" to "anon";

grant delete on table "public"."camp_owners" to "authenticated";

grant insert on table "public"."camp_owners" to "authenticated";

grant references on table "public"."camp_owners" to "authenticated";

grant select on table "public"."camp_owners" to "authenticated";

grant trigger on table "public"."camp_owners" to "authenticated";

grant truncate on table "public"."camp_owners" to "authenticated";

grant update on table "public"."camp_owners" to "authenticated";

grant delete on table "public"."camp_owners" to "service_role";

grant insert on table "public"."camp_owners" to "service_role";

grant references on table "public"."camp_owners" to "service_role";

grant select on table "public"."camp_owners" to "service_role";

grant trigger on table "public"."camp_owners" to "service_role";

grant truncate on table "public"."camp_owners" to "service_role";

grant update on table "public"."camp_owners" to "service_role";

grant delete on table "public"."camp_state" to "anon";

grant insert on table "public"."camp_state" to "anon";

grant references on table "public"."camp_state" to "anon";

grant select on table "public"."camp_state" to "anon";

grant trigger on table "public"."camp_state" to "anon";

grant truncate on table "public"."camp_state" to "anon";

grant update on table "public"."camp_state" to "anon";

grant delete on table "public"."camp_state" to "authenticated";

grant insert on table "public"."camp_state" to "authenticated";

grant references on table "public"."camp_state" to "authenticated";

grant select on table "public"."camp_state" to "authenticated";

grant trigger on table "public"."camp_state" to "authenticated";

grant truncate on table "public"."camp_state" to "authenticated";

grant update on table "public"."camp_state" to "authenticated";

grant delete on table "public"."camp_state" to "service_role";

grant insert on table "public"."camp_state" to "service_role";

grant references on table "public"."camp_state" to "service_role";

grant select on table "public"."camp_state" to "service_role";

grant trigger on table "public"."camp_state" to "service_role";

grant truncate on table "public"."camp_state" to "service_role";

grant update on table "public"."camp_state" to "service_role";

grant delete on table "public"."camp_users" to "anon";

grant insert on table "public"."camp_users" to "anon";

grant references on table "public"."camp_users" to "anon";

grant select on table "public"."camp_users" to "anon";

grant trigger on table "public"."camp_users" to "anon";

grant truncate on table "public"."camp_users" to "anon";

grant update on table "public"."camp_users" to "anon";

grant delete on table "public"."camp_users" to "authenticated";

grant insert on table "public"."camp_users" to "authenticated";

grant references on table "public"."camp_users" to "authenticated";

grant select on table "public"."camp_users" to "authenticated";

grant trigger on table "public"."camp_users" to "authenticated";

grant truncate on table "public"."camp_users" to "authenticated";

grant update on table "public"."camp_users" to "authenticated";

grant delete on table "public"."camp_users" to "service_role";

grant insert on table "public"."camp_users" to "service_role";

grant references on table "public"."camp_users" to "service_role";

grant select on table "public"."camp_users" to "service_role";

grant trigger on table "public"."camp_users" to "service_role";

grant truncate on table "public"."camp_users" to "service_role";

grant update on table "public"."camp_users" to "service_role";

grant delete on table "public"."campistry_config" to "anon";

grant insert on table "public"."campistry_config" to "anon";

grant references on table "public"."campistry_config" to "anon";

grant select on table "public"."campistry_config" to "anon";

grant trigger on table "public"."campistry_config" to "anon";

grant truncate on table "public"."campistry_config" to "anon";

grant update on table "public"."campistry_config" to "anon";

grant delete on table "public"."campistry_config" to "authenticated";

grant insert on table "public"."campistry_config" to "authenticated";

grant references on table "public"."campistry_config" to "authenticated";

grant select on table "public"."campistry_config" to "authenticated";

grant trigger on table "public"."campistry_config" to "authenticated";

grant truncate on table "public"."campistry_config" to "authenticated";

grant update on table "public"."campistry_config" to "authenticated";

grant delete on table "public"."campistry_config" to "service_role";

grant insert on table "public"."campistry_config" to "service_role";

grant references on table "public"."campistry_config" to "service_role";

grant select on table "public"."campistry_config" to "service_role";

grant trigger on table "public"."campistry_config" to "service_role";

grant truncate on table "public"."campistry_config" to "service_role";

grant update on table "public"."campistry_config" to "service_role";

grant delete on table "public"."camps" to "anon";

grant insert on table "public"."camps" to "anon";

grant references on table "public"."camps" to "anon";

grant select on table "public"."camps" to "anon";

grant trigger on table "public"."camps" to "anon";

grant truncate on table "public"."camps" to "anon";

grant update on table "public"."camps" to "anon";

grant delete on table "public"."camps" to "authenticated";

grant insert on table "public"."camps" to "authenticated";

grant references on table "public"."camps" to "authenticated";

grant select on table "public"."camps" to "authenticated";

grant trigger on table "public"."camps" to "authenticated";

grant truncate on table "public"."camps" to "authenticated";

grant update on table "public"."camps" to "authenticated";

grant delete on table "public"."camps" to "service_role";

grant insert on table "public"."camps" to "service_role";

grant references on table "public"."camps" to "service_role";

grant select on table "public"."camps" to "service_role";

grant trigger on table "public"."camps" to "service_role";

grant truncate on table "public"."camps" to "service_role";

grant update on table "public"."camps" to "service_role";

grant delete on table "public"."daily_schedules" to "anon";

grant insert on table "public"."daily_schedules" to "anon";

grant references on table "public"."daily_schedules" to "anon";

grant select on table "public"."daily_schedules" to "anon";

grant trigger on table "public"."daily_schedules" to "anon";

grant truncate on table "public"."daily_schedules" to "anon";

grant update on table "public"."daily_schedules" to "anon";

grant delete on table "public"."daily_schedules" to "authenticated";

grant insert on table "public"."daily_schedules" to "authenticated";

grant references on table "public"."daily_schedules" to "authenticated";

grant select on table "public"."daily_schedules" to "authenticated";

grant trigger on table "public"."daily_schedules" to "authenticated";

grant truncate on table "public"."daily_schedules" to "authenticated";

grant update on table "public"."daily_schedules" to "authenticated";

grant delete on table "public"."daily_schedules" to "service_role";

grant insert on table "public"."daily_schedules" to "service_role";

grant references on table "public"."daily_schedules" to "service_role";

grant select on table "public"."daily_schedules" to "service_role";

grant trigger on table "public"."daily_schedules" to "service_role";

grant truncate on table "public"."daily_schedules" to "service_role";

grant update on table "public"."daily_schedules" to "service_role";

grant delete on table "public"."field_locks" to "anon";

grant insert on table "public"."field_locks" to "anon";

grant references on table "public"."field_locks" to "anon";

grant select on table "public"."field_locks" to "anon";

grant trigger on table "public"."field_locks" to "anon";

grant truncate on table "public"."field_locks" to "anon";

grant update on table "public"."field_locks" to "anon";

grant delete on table "public"."field_locks" to "authenticated";

grant insert on table "public"."field_locks" to "authenticated";

grant references on table "public"."field_locks" to "authenticated";

grant select on table "public"."field_locks" to "authenticated";

grant trigger on table "public"."field_locks" to "authenticated";

grant truncate on table "public"."field_locks" to "authenticated";

grant update on table "public"."field_locks" to "authenticated";

grant delete on table "public"."field_locks" to "service_role";

grant insert on table "public"."field_locks" to "service_role";

grant references on table "public"."field_locks" to "service_role";

grant select on table "public"."field_locks" to "service_role";

grant trigger on table "public"."field_locks" to "service_role";

grant truncate on table "public"."field_locks" to "service_role";

grant update on table "public"."field_locks" to "service_role";

grant delete on table "public"."notifications" to "anon";

grant insert on table "public"."notifications" to "anon";

grant references on table "public"."notifications" to "anon";

grant select on table "public"."notifications" to "anon";

grant trigger on table "public"."notifications" to "anon";

grant truncate on table "public"."notifications" to "anon";

grant update on table "public"."notifications" to "anon";

grant delete on table "public"."notifications" to "authenticated";

grant insert on table "public"."notifications" to "authenticated";

grant references on table "public"."notifications" to "authenticated";

grant select on table "public"."notifications" to "authenticated";

grant trigger on table "public"."notifications" to "authenticated";

grant truncate on table "public"."notifications" to "authenticated";

grant update on table "public"."notifications" to "authenticated";

grant delete on table "public"."notifications" to "service_role";

grant insert on table "public"."notifications" to "service_role";

grant references on table "public"."notifications" to "service_role";

grant select on table "public"."notifications" to "service_role";

grant trigger on table "public"."notifications" to "service_role";

grant truncate on table "public"."notifications" to "service_role";

grant update on table "public"."notifications" to "service_role";

grant delete on table "public"."promo_codes" to "anon";

grant insert on table "public"."promo_codes" to "anon";

grant references on table "public"."promo_codes" to "anon";

grant select on table "public"."promo_codes" to "anon";

grant trigger on table "public"."promo_codes" to "anon";

grant truncate on table "public"."promo_codes" to "anon";

grant update on table "public"."promo_codes" to "anon";

grant delete on table "public"."promo_codes" to "authenticated";

grant insert on table "public"."promo_codes" to "authenticated";

grant references on table "public"."promo_codes" to "authenticated";

grant select on table "public"."promo_codes" to "authenticated";

grant trigger on table "public"."promo_codes" to "authenticated";

grant truncate on table "public"."promo_codes" to "authenticated";

grant update on table "public"."promo_codes" to "authenticated";

grant delete on table "public"."promo_codes" to "service_role";

grant insert on table "public"."promo_codes" to "service_role";

grant references on table "public"."promo_codes" to "service_role";

grant select on table "public"."promo_codes" to "service_role";

grant trigger on table "public"."promo_codes" to "service_role";

grant truncate on table "public"."promo_codes" to "service_role";

grant update on table "public"."promo_codes" to "service_role";

grant delete on table "public"."schedule_proposals" to "anon";

grant insert on table "public"."schedule_proposals" to "anon";

grant references on table "public"."schedule_proposals" to "anon";

grant select on table "public"."schedule_proposals" to "anon";

grant trigger on table "public"."schedule_proposals" to "anon";

grant truncate on table "public"."schedule_proposals" to "anon";

grant update on table "public"."schedule_proposals" to "anon";

grant delete on table "public"."schedule_proposals" to "authenticated";

grant insert on table "public"."schedule_proposals" to "authenticated";

grant references on table "public"."schedule_proposals" to "authenticated";

grant select on table "public"."schedule_proposals" to "authenticated";

grant trigger on table "public"."schedule_proposals" to "authenticated";

grant truncate on table "public"."schedule_proposals" to "authenticated";

grant update on table "public"."schedule_proposals" to "authenticated";

grant delete on table "public"."schedule_proposals" to "service_role";

grant insert on table "public"."schedule_proposals" to "service_role";

grant references on table "public"."schedule_proposals" to "service_role";

grant select on table "public"."schedule_proposals" to "service_role";

grant trigger on table "public"."schedule_proposals" to "service_role";

grant truncate on table "public"."schedule_proposals" to "service_role";

grant update on table "public"."schedule_proposals" to "service_role";

grant delete on table "public"."schedule_versions" to "anon";

grant insert on table "public"."schedule_versions" to "anon";

grant references on table "public"."schedule_versions" to "anon";

grant select on table "public"."schedule_versions" to "anon";

grant trigger on table "public"."schedule_versions" to "anon";

grant truncate on table "public"."schedule_versions" to "anon";

grant update on table "public"."schedule_versions" to "anon";

grant delete on table "public"."schedule_versions" to "authenticated";

grant insert on table "public"."schedule_versions" to "authenticated";

grant references on table "public"."schedule_versions" to "authenticated";

grant select on table "public"."schedule_versions" to "authenticated";

grant trigger on table "public"."schedule_versions" to "authenticated";

grant truncate on table "public"."schedule_versions" to "authenticated";

grant update on table "public"."schedule_versions" to "authenticated";

grant delete on table "public"."schedule_versions" to "service_role";

grant insert on table "public"."schedule_versions" to "service_role";

grant references on table "public"."schedule_versions" to "service_role";

grant select on table "public"."schedule_versions" to "service_role";

grant trigger on table "public"."schedule_versions" to "service_role";

grant truncate on table "public"."schedule_versions" to "service_role";

grant update on table "public"."schedule_versions" to "service_role";

grant delete on table "public"."subdivisions" to "anon";

grant insert on table "public"."subdivisions" to "anon";

grant references on table "public"."subdivisions" to "anon";

grant select on table "public"."subdivisions" to "anon";

grant trigger on table "public"."subdivisions" to "anon";

grant truncate on table "public"."subdivisions" to "anon";

grant update on table "public"."subdivisions" to "anon";

grant delete on table "public"."subdivisions" to "authenticated";

grant insert on table "public"."subdivisions" to "authenticated";

grant references on table "public"."subdivisions" to "authenticated";

grant select on table "public"."subdivisions" to "authenticated";

grant trigger on table "public"."subdivisions" to "authenticated";

grant truncate on table "public"."subdivisions" to "authenticated";

grant update on table "public"."subdivisions" to "authenticated";

grant delete on table "public"."subdivisions" to "service_role";

grant insert on table "public"."subdivisions" to "service_role";

grant references on table "public"."subdivisions" to "service_role";

grant select on table "public"."subdivisions" to "service_role";

grant trigger on table "public"."subdivisions" to "service_role";

grant truncate on table "public"."subdivisions" to "service_role";

grant update on table "public"."subdivisions" to "service_role";


  create policy "Owners can update own record"
  on "public"."camp_owners"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Owners can view own record"
  on "public"."camp_owners"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "camp_state_delete"
  on "public"."camp_state"
  as permissive
  for delete
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = 'owner'::text)));



  create policy "camp_state_insert"
  on "public"."camp_state"
  as permissive
  for insert
  to public
with check (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))));



  create policy "camp_state_select"
  on "public"."camp_state"
  as permissive
  for select
  to public
using ((camp_id = public.get_user_camp_id()));



  create policy "camp_state_update"
  on "public"."camp_state"
  as permissive
  for update
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))));



  create policy "Camp owners can delete team members"
  on "public"."camp_users"
  as permissive
  for delete
  to public
using ((camp_id IN ( SELECT camps.id
   FROM public.camps
  WHERE (camps.owner = auth.uid()))));



  create policy "camp_users_delete_owner"
  on "public"."camp_users"
  as permissive
  for delete
  to public
using ((camp_id = auth.uid()));



  create policy "camp_users_insert_owner"
  on "public"."camp_users"
  as permissive
  for insert
  to public
with check ((camp_id = auth.uid()));



  create policy "camp_users_select_invite"
  on "public"."camp_users"
  as permissive
  for select
  to public
using ((lower(email) = lower(auth.email())));



  create policy "camp_users_select_owner"
  on "public"."camp_users"
  as permissive
  for select
  to public
using ((camp_id = auth.uid()));



  create policy "camp_users_select_self"
  on "public"."camp_users"
  as permissive
  for select
  to public
using ((user_id = auth.uid()));



  create policy "camp_users_update_owner"
  on "public"."camp_users"
  as permissive
  for update
  to public
using ((camp_id = auth.uid()));



  create policy "camp_users_update_self"
  on "public"."camp_users"
  as permissive
  for update
  to public
using (((user_id = auth.uid()) OR (lower(email) = lower(auth.email()))));



  create policy "camps_delete_own"
  on "public"."camps"
  as permissive
  for delete
  to public
using ((owner = auth.uid()));



  create policy "camps_insert_own"
  on "public"."camps"
  as permissive
  for insert
  to public
with check ((owner = auth.uid()));



  create policy "camps_select_owner"
  on "public"."camps"
  as permissive
  for select
  to public
using ((owner = auth.uid()));



  create policy "camps_select_team_member"
  on "public"."camps"
  as permissive
  for select
  to public
using ((id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL)))));



  create policy "camps_update_own"
  on "public"."camps"
  as permissive
  for update
  to public
using ((owner = auth.uid()))
with check ((owner = auth.uid()));



  create policy "schedules_delete"
  on "public"."daily_schedules"
  as permissive
  for delete
  to public
using (((camp_id = public.get_user_camp_id()) AND ((public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((public.get_user_role() = 'scheduler'::text) AND (scheduler_id = auth.uid())))));



  create policy "schedules_insert"
  on "public"."daily_schedules"
  as permissive
  for insert
  to public
with check (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text]))));



  create policy "schedules_select"
  on "public"."daily_schedules"
  as permissive
  for select
  to public
using ((camp_id = public.get_user_camp_id()));



  create policy "schedules_update"
  on "public"."daily_schedules"
  as permissive
  for update
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text]))));



  create policy "field_locks_delete"
  on "public"."field_locks"
  as permissive
  for delete
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))));



  create policy "field_locks_insert"
  on "public"."field_locks"
  as permissive
  for insert
  to public
with check (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text]))));



  create policy "field_locks_select"
  on "public"."field_locks"
  as permissive
  for select
  to public
using ((camp_id = public.get_user_camp_id()));



  create policy "field_locks_update"
  on "public"."field_locks"
  as permissive
  for update
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text]))));



  create policy "notifications_delete_own"
  on "public"."notifications"
  as permissive
  for delete
  to public
using ((user_id = auth.uid()));



  create policy "notifications_insert_camp"
  on "public"."notifications"
  as permissive
  for insert
  to public
with check (((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL))))));



  create policy "notifications_select_own"
  on "public"."notifications"
  as permissive
  for select
  to public
using ((user_id = auth.uid()));



  create policy "notifications_update_own"
  on "public"."notifications"
  as permissive
  for update
  to public
using ((user_id = auth.uid()));



  create policy "Anyone can read promo codes"
  on "public"."promo_codes"
  as permissive
  for select
  to public
using (true);



  create policy "Users can create proposals"
  on "public"."schedule_proposals"
  as permissive
  for insert
  to public
with check (((created_by = auth.uid()) AND ((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL)))))));



  create policy "Users can update proposals for their camp"
  on "public"."schedule_proposals"
  as permissive
  for update
  to public
using (((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL))))));



  create policy "Users can view proposals for their camp"
  on "public"."schedule_proposals"
  as permissive
  for select
  to public
using (((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL))))));



  create policy "Camp members can create versions"
  on "public"."schedule_versions"
  as permissive
  for insert
  to public
with check (((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL) AND (camp_users.role = ANY (ARRAY['admin'::text, 'scheduler'::text])))))));



  create policy "Camp members can view versions"
  on "public"."schedule_versions"
  as permissive
  for select
  to public
using (((camp_id = auth.uid()) OR (camp_id IN ( SELECT camp_users.camp_id
   FROM public.camp_users
  WHERE ((camp_users.user_id = auth.uid()) AND (camp_users.accepted_at IS NOT NULL))))));



  create policy "Camp owners can delete versions"
  on "public"."schedule_versions"
  as permissive
  for delete
  to public
using ((camp_id = auth.uid()));



  create policy "versions_delete"
  on "public"."schedule_versions"
  as permissive
  for delete
  to public
using ((public.can_manage_camp(camp_id) OR (created_by = auth.uid())));



  create policy "versions_insert"
  on "public"."schedule_versions"
  as permissive
  for insert
  to public
with check (public.can_write_camp(camp_id));



  create policy "versions_select"
  on "public"."schedule_versions"
  as permissive
  for select
  to public
using (public.can_access_camp(camp_id));



  create policy "versions_update"
  on "public"."schedule_versions"
  as permissive
  for update
  to public
using ((public.can_manage_camp(camp_id) OR (created_by = auth.uid())))
with check ((public.can_manage_camp(camp_id) OR (created_by = auth.uid())));



  create policy "subdivisions_delete"
  on "public"."subdivisions"
  as permissive
  for delete
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = 'owner'::text)));



  create policy "subdivisions_insert"
  on "public"."subdivisions"
  as permissive
  for insert
  to public
with check (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))));



  create policy "subdivisions_select"
  on "public"."subdivisions"
  as permissive
  for select
  to public
using ((camp_id = public.get_user_camp_id()));



  create policy "subdivisions_update"
  on "public"."subdivisions"
  as permissive
  for update
  to public
using (((camp_id = public.get_user_camp_id()) AND (public.get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))));


CREATE TRIGGER update_camp_state_updated_at BEFORE UPDATE ON public.camp_state FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_camp_users_updated_at BEFORE UPDATE ON public.camp_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER check_access_code_on_camp_create BEFORE INSERT ON public.camps FOR EACH ROW EXECUTE FUNCTION public.validate_camp_creation();

CREATE TRIGGER update_camps_updated_at BEFORE UPDATE ON public.camps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_daily_schedules_updated_at BEFORE UPDATE ON public.daily_schedules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_subdivisions_updated_at BEFORE UPDATE ON public.subdivisions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


