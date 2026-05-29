-- =============================================================================
-- CAMPISTRY SUPABASE SCHEMA
-- Apps: Live, Health, Snacks, Notes, Link (Messaging)
--
-- Run this in the Supabase SQL Editor to create all tables and RLS policies.
-- Existing core tables (daily_schedules, rotation_counts, camp_state_kv,
-- camps, camp_users) are NOT included here — they already exist.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HELPER: ensure the camp_id index helper function exists
-- ---------------------------------------------------------------------------
-- All RLS policies use get_user_camp_id() defined in your existing schema.
-- If it does not exist, uncomment and run this block first:
--
-- create or replace function get_user_camp_id()
-- returns uuid language sql stable security definer as $$
--   select coalesce(
--     (select camp_id from camp_users
--      where user_id = auth.uid() and accepted_at is not null
--      order by accepted_at desc limit 1),
--     (select id from camps where owner = auth.uid() limit 1)
--   );
-- $$;
-- ---------------------------------------------------------------------------


-- =============================================================================
-- LIVE APP
-- =============================================================================

-- Attendance / roll-call records (one row per bunk per day)
create table if not exists attendance_records (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    record_date     date not null,
    bunk_id         text not null,
    bunk_name       text not null,
    division_id     text,
    division_name   text,
    campers         jsonb not null default '[]',  -- [{name, present, note}]
    counselor_ids   text[],
    submitted_by    uuid references auth.users(id),
    submitted_at    timestamptz default now(),
    updated_at      timestamptz default now(),
    unique (camp_id, record_date, bunk_id)
);
alter table attendance_records enable row level security;

create policy "attendance_records: camp members can read"
    on attendance_records for select
    using (camp_id = get_user_camp_id());

create policy "attendance_records: staff can insert"
    on attendance_records for insert
    with check (camp_id = get_user_camp_id());

create policy "attendance_records: staff can update"
    on attendance_records for update
    using (camp_id = get_user_camp_id());


-- Early pickup / dismissal events (live, per-day log)
create table if not exists early_pickups (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    pickup_date     date not null,
    child_name      text not null,
    child_bunk      text,
    child_bunk_id   text,
    pickup_type     text not null check (pickup_type in ('early','change','friend','late')),
    pickup_time     text,           -- "2:30 PM"
    authorized_by   text,           -- name of person picking up
    notes           text,
    parent_request_id uuid,         -- links to parent_pickup_requests if originated from parent
    created_by      uuid references auth.users(id),
    created_at      timestamptz default now(),
    status          text default 'pending' check (status in ('pending','confirmed','completed','cancelled'))
);
alter table early_pickups enable row level security;

create policy "early_pickups: camp members can read"
    on early_pickups for select
    using (camp_id = get_user_camp_id());

create policy "early_pickups: staff can insert"
    on early_pickups for insert
    with check (camp_id = get_user_camp_id());

create policy "early_pickups: staff can update"
    on early_pickups for update
    using (camp_id = get_user_camp_id());


-- Parent-submitted pickup / arrival / dismissal requests
create table if not exists parent_pickup_requests (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    request_date    date not null,
    request_type    text not null check (request_type in ('early','change','friend','late')),
    child_name      text not null,
    child_bunk      text,
    parent_name     text,
    parent_email    text,
    parent_phone    text,
    pickup_time     text,
    authorized_by   text,
    notes           text,
    raw_fields      jsonb default '{}',     -- full form payload for flexibility
    status          text default 'pending' check (status in ('pending','confirmed','declined')),
    reviewed_by     uuid references auth.users(id),
    reviewed_at     timestamptz,
    created_at      timestamptz default now()
);
alter table parent_pickup_requests enable row level security;

-- Staff can read all requests for their camp
create policy "parent_pickup_requests: staff can read"
    on parent_pickup_requests for select
    using (camp_id = get_user_camp_id());

-- Staff can update status (confirm/decline)
create policy "parent_pickup_requests: staff can update"
    on parent_pickup_requests for update
    using (camp_id = get_user_camp_id());

-- Parents submit via a server-side function or with anon key + camp_id param
-- (the insert policy is intentionally permissive on camp_id so the parent
--  portal can write without being signed in — add a CAPTCHA/rate-limit at
--  the application layer or via a Supabase Edge Function)
create policy "parent_pickup_requests: anyone can insert"
    on parent_pickup_requests for insert
    with check (true);


-- =============================================================================
-- HEALTH APP
-- =============================================================================

-- Sick bay visits (nurse logs)
create table if not exists sick_visits (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    visit_date      date not null,
    visit_time      text,
    camper_name     text not null,
    camper_bunk     text,
    camper_bunk_id  text,
    complaint       text,
    treatment       text,
    temperature     numeric(4,1),   -- Fahrenheit
    sent_home       boolean default false,
    parent_notified boolean default false,
    follow_up_required boolean default false,
    notes           text,
    logged_by       uuid references auth.users(id),
    logged_at       timestamptz default now(),
    updated_at      timestamptz default now()
);
alter table sick_visits enable row level security;

create policy "sick_visits: camp members can read"
    on sick_visits for select
    using (camp_id = get_user_camp_id());

create policy "sick_visits: health staff can insert"
    on sick_visits for insert
    with check (camp_id = get_user_camp_id());

create policy "sick_visits: health staff can update"
    on sick_visits for update
    using (camp_id = get_user_camp_id());


-- Medication dispensing log (time + dose tracking)
create table if not exists medication_dispensing (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    dispense_date   date not null,
    dispense_time   text,
    camper_name     text not null,
    camper_bunk     text,
    camper_bunk_id  text,
    medication_name text not null,
    dosage          text,
    route           text,           -- oral, topical, inhaled, etc.
    prescribed_by   text,
    notes           text,
    dispensed_by    uuid references auth.users(id),
    dispensed_at    timestamptz default now()
);
alter table medication_dispensing enable row level security;

create policy "medication_dispensing: camp members can read"
    on medication_dispensing for select
    using (camp_id = get_user_camp_id());

create policy "medication_dispensing: health staff can insert"
    on medication_dispensing for insert
    with check (camp_id = get_user_camp_id());


-- Parent-uploaded health documents (forms, physicals, immunization records)
create table if not exists health_submissions (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    camper_name     text not null,
    camper_bunk     text,
    doc_type        text,           -- 'physical', 'immunization', 'allergy', 'emergency', 'other'
    file_name       text,
    file_ext        text,
    file_url        text,           -- Supabase Storage URL once uploaded
    file_size_bytes integer,
    status          text default 'pending' check (status in ('pending','approved','flagged','rejected')),
    review_notes    text,
    submitted_at    timestamptz default now(),
    reviewed_by     uuid references auth.users(id),
    reviewed_at     timestamptz
);
alter table health_submissions enable row level security;

create policy "health_submissions: staff can read"
    on health_submissions for select
    using (camp_id = get_user_camp_id());

create policy "health_submissions: staff can update"
    on health_submissions for update
    using (camp_id = get_user_camp_id());

-- Parents submit without auth (same pattern as parent_pickup_requests)
create policy "health_submissions: anyone can insert"
    on health_submissions for insert
    with check (true);


-- Camper medical forms (structured data, not just file uploads)
create table if not exists medical_forms (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    camper_name     text not null,
    camper_bunk     text,
    camper_bunk_id  text,
    date_of_birth   date,
    allergies       text[],
    medications     jsonb default '[]',  -- [{name, dose, frequency, prescriber}]
    conditions      text[],
    emergency_contacts jsonb default '[]',  -- [{name, phone, relation}]
    insurance_provider text,
    insurance_id    text,
    physician_name  text,
    physician_phone text,
    raw_form        jsonb default '{}',  -- full form for future fields
    created_at      timestamptz default now(),
    updated_at      timestamptz default now(),
    unique (camp_id, camper_name)   -- one form per camper per camp
);
alter table medical_forms enable row level security;

create policy "medical_forms: staff can read"
    on medical_forms for select
    using (camp_id = get_user_camp_id());

create policy "medical_forms: staff can insert"
    on medical_forms for insert
    with check (camp_id = get_user_camp_id());

create policy "medical_forms: staff can update"
    on medical_forms for update
    using (camp_id = get_user_camp_id());


-- =============================================================================
-- NOTES APP
-- =============================================================================

create table if not exists notes (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    title           text not null default 'Untitled',
    content         text default '',
    color           text default '#ffffff',     -- card background color
    tags            text[] default '{}',
    is_pinned       boolean default false,
    is_archived     boolean default false,
    is_trashed      boolean default false,
    author_id       uuid references auth.users(id),
    author_name     text,
    visibility      text default 'team' check (visibility in ('private','team')),
    attachments     jsonb default '[]',         -- [{name, url, type}]
    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);
alter table notes enable row level security;

-- Team-visible notes: any camp member can read
create policy "notes: team members can read team notes"
    on notes for select
    using (
        camp_id = get_user_camp_id()
        and (visibility = 'team' or author_id = auth.uid())
    );

-- Authors can insert their own notes
create policy "notes: members can insert"
    on notes for insert
    with check (camp_id = get_user_camp_id() and author_id = auth.uid());

-- Authors can update/delete their own; admins can update/delete any
create policy "notes: authors and admins can update"
    on notes for update
    using (
        camp_id = get_user_camp_id()
        and (
            author_id = auth.uid()
            or exists (
                select 1 from camp_users
                where user_id = auth.uid()
                  and camp_id = notes.camp_id
                  and role in ('owner','admin')
                  and accepted_at is not null
            )
            or exists (
                select 1 from camps
                where id = notes.camp_id and owner = auth.uid()
            )
        )
    );

create policy "notes: authors and admins can delete"
    on notes for delete
    using (
        camp_id = get_user_camp_id()
        and (
            author_id = auth.uid()
            or exists (
                select 1 from camp_users
                where user_id = auth.uid()
                  and camp_id = notes.camp_id
                  and role in ('owner','admin')
                  and accepted_at is not null
            )
            or exists (
                select 1 from camps
                where id = notes.camp_id and owner = auth.uid()
            )
        )
    );


-- =============================================================================
-- SNACKS / CANTEEN APP
-- =============================================================================

-- Camper canteen accounts (balance tracking)
create table if not exists canteen_accounts (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    camper_name     text not null,
    camper_bunk     text,
    camper_bunk_id  text,
    balance_cents   integer not null default 0,  -- stored in cents to avoid float rounding
    parent_email    text,
    notes           text,
    created_at      timestamptz default now(),
    updated_at      timestamptz default now(),
    unique (camp_id, camper_name)
);
alter table canteen_accounts enable row level security;

create policy "canteen_accounts: staff can read"
    on canteen_accounts for select
    using (camp_id = get_user_camp_id());

create policy "canteen_accounts: staff can insert"
    on canteen_accounts for insert
    with check (camp_id = get_user_camp_id());

create policy "canteen_accounts: staff can update"
    on canteen_accounts for update
    using (camp_id = get_user_camp_id());


-- Individual canteen transactions (purchases, deposits, refunds)
create table if not exists canteen_transactions (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    account_id      uuid references canteen_accounts(id) on delete cascade,
    camper_name     text not null,          -- denormalized for query speed
    transaction_date date not null,
    transaction_time text,
    type            text not null check (type in ('purchase','deposit','refund','adjustment')),
    amount_cents    integer not null,       -- positive = credit, negative = debit
    description     text,
    item_name       text,                   -- e.g. "Slushie", "Chips"
    balance_after_cents integer,            -- snapshot for easy audit
    processed_by    uuid references auth.users(id),
    created_at      timestamptz default now()
);
alter table canteen_transactions enable row level security;

create policy "canteen_transactions: staff can read"
    on canteen_transactions for select
    using (camp_id = get_user_camp_id());

create policy "canteen_transactions: staff can insert"
    on canteen_transactions for insert
    with check (camp_id = get_user_camp_id());

-- Transactions are append-only; corrections are done via 'adjustment' type
-- (no update or delete policies)


-- =============================================================================
-- LINK (MESSAGING APP)
-- =============================================================================

-- Conversations / threads (one per parent-camp pair, or group)
create table if not exists message_threads (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    thread_type     text not null check (thread_type in ('direct','group','announcement')),
    subject         text,
    participant_ids uuid[],     -- auth user IDs; includes camp staff + parent user IDs
    participant_meta jsonb default '{}',  -- {userId: {name, role, avatar}}
    camper_name     text,       -- if this thread is about a specific camper
    last_message_at timestamptz,
    last_message_preview text,
    created_by      uuid references auth.users(id),
    created_at      timestamptz default now(),
    archived        boolean default false
);
alter table message_threads enable row level security;

create policy "message_threads: participants can read"
    on message_threads for select
    using (
        camp_id = get_user_camp_id()
        or auth.uid() = any(participant_ids)
    );

create policy "message_threads: camp members can insert"
    on message_threads for insert
    with check (
        camp_id = get_user_camp_id()
        or auth.uid() = any(participant_ids)
    );

create policy "message_threads: participants can update"
    on message_threads for update
    using (
        camp_id = get_user_camp_id()
        or auth.uid() = any(participant_ids)
    );


-- Individual messages within a thread
create table if not exists messages (
    id              uuid primary key default gen_random_uuid(),
    camp_id         uuid not null,
    thread_id       uuid references message_threads(id) on delete cascade,
    sender_id       uuid references auth.users(id),
    sender_name     text not null,
    sender_role     text,       -- 'director','nurse','counselor','parent'
    body            text not null,
    attachments     jsonb default '[]',     -- [{name, url, type}]
    read_by         uuid[] default '{}',    -- list of user IDs who have read
    is_announcement boolean default false,
    sent_at         timestamptz default now(),
    edited_at       timestamptz,
    deleted_at      timestamptz             -- soft delete
);
alter table messages enable row level security;

create policy "messages: participants can read"
    on messages for select
    using (
        camp_id = get_user_camp_id()
        or exists (
            select 1 from message_threads t
            where t.id = messages.thread_id
              and auth.uid() = any(t.participant_ids)
        )
    );

create policy "messages: participants can insert"
    on messages for insert
    with check (
        sender_id = auth.uid()
        and (
            camp_id = get_user_camp_id()
            or exists (
                select 1 from message_threads t
                where t.id = messages.thread_id
                  and auth.uid() = any(t.participant_ids)
            )
        )
    );

-- Senders can soft-delete their own messages
create policy "messages: senders can update"
    on messages for update
    using (sender_id = auth.uid());


-- =============================================================================
-- REALTIME SUBSCRIPTIONS (enable per table in Supabase Dashboard)
-- =============================================================================
-- To enable realtime for a table, run in SQL Editor:
--   alter publication supabase_realtime add table <table_name>;
--
-- Recommended to enable realtime on:
--   messages, message_threads, parent_pickup_requests, health_submissions
--
-- Example:
-- alter publication supabase_realtime add table messages;
-- alter publication supabase_realtime add table message_threads;
-- alter publication supabase_realtime add table parent_pickup_requests;
-- alter publication supabase_realtime add table health_submissions;


-- =============================================================================
-- INDEXES (performance)
-- =============================================================================

create index if not exists idx_attendance_camp_date    on attendance_records(camp_id, record_date);
create index if not exists idx_early_pickups_camp_date on early_pickups(camp_id, pickup_date);
create index if not exists idx_parent_requests_camp    on parent_pickup_requests(camp_id, request_date, status);
create index if not exists idx_sick_visits_camp_date   on sick_visits(camp_id, visit_date);
create index if not exists idx_med_dispense_camp_date  on medication_dispensing(camp_id, dispense_date);
create index if not exists idx_health_subs_camp_status on health_submissions(camp_id, status);
create index if not exists idx_medical_forms_camp      on medical_forms(camp_id, camper_name);
create index if not exists idx_notes_camp              on notes(camp_id, is_trashed, is_archived);
create index if not exists idx_notes_tags              on notes using gin(tags);
create index if not exists idx_canteen_accounts_camp   on canteen_accounts(camp_id, camper_name);
create index if not exists idx_canteen_txns_account    on canteen_transactions(account_id, transaction_date);
create index if not exists idx_messages_thread         on messages(thread_id, sent_at);
create index if not exists idx_message_threads_camp    on message_threads(camp_id, last_message_at desc);
