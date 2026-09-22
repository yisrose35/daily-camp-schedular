-- ============================================================================
-- 216 — camp_people: the camper/staff id becomes a real identity
--
-- WHY THIS EXISTS. Everything in this app identifies a camper by NAME. The
-- roster is an object keyed by name (app1 → camperRoster → "Chaim Katz"), the
-- canteen keys accounts by name, Shop and the 14 canteen writers all take
-- p_camper_name, and families carry a `camperIds` array that — despite its
-- name — holds names too. A name is not an identity: two campers can share
-- one, a rename orphans the history, and a trailing space makes a second
-- person. 354 of this project's 803 canteen accounts already point at a name
-- the roster cannot resolve.
--
-- An id already exists — roster[name].camperId — but it is not yet an
-- identity, for two reasons:
--
--   1. It is minted in the BROWSER. campistry_me.js computes nextPersonId from
--      the max it can currently see, so two staff adding campers at the same
--      moment mint the same number. Nothing has ever stopped that but luck.
--   2. Nothing enforces it. Uniqueness is checked client-side by
--      personIdHolder(), across campers AND staff — camps do not want one
--      number on two badges. A constraint on a campers table alone would not
--      express that rule, which is why this table holds BOTH kinds and the
--      primary key is (camp_id, person_id).
--
-- The rule this table enforces, and the app only hoped for: within one camp, a
-- number belongs to exactly one person, camper or staff, forever.
--
-- THE ID IS NOT ALWAYS OURS TO CHOOSE. campistry_me.js:256 is explicit that
-- the sequence is a FALLBACK: camps arrive with their own numbers, often four
-- digits, printed on forms and written on bank memos years before Campistry
-- existed, and renumbering a camp is not something software gets to ask for.
-- So this migration NEVER renumbers anyone who already has an id. It mints
-- only into the gaps — 890 of this project's 4,602 campers — and a number the
-- document later states by hand wins over one we minted.
--
-- WHY THE TRIGGER DIFFS. Migration 203's canteen trigger re-derived the whole
-- history on every sale, and throughput decayed 84 → 26 rps as the blob grew
-- until 206 fixed it by diffing against OLD. A roster save rewrites every
-- camper, so the same trap is here in a worse form. This trigger therefore
-- compares NEW against OLD and touches only entries that actually changed.
--
-- WHAT IT DOES NOT DO. Nothing reads this table yet. No function signature
-- changes, no writer moves off the blob, no name stops working. This file only
-- establishes the identity; 217-221 move the canteen, Shop and billing onto
-- it. A migration that both created an identity and re-pointed the money at it
-- would leave no way to tell which half went wrong.
--
-- HOW TO APPLY. Paste the whole file into the Supabase SQL Editor and run it.
-- It is one transaction: any error rolls back everything, so a complaint that
-- the last statement "does not exist" means something EARLIER failed. It is
-- idempotent — re-running converges and doubles as the repair tool.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
-- The roster lives under its own key, not inside campistryMe. Getting this
-- wrong is silent: jsonb_each of a missing branch yields no rows, so the
-- backfill would report success having projected nothing. It cost one round
-- trip to discover, so it is asserted here rather than assumed.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_state_kv') THEN
        RAISE EXCEPTION 'camp_state_kv is missing — apply the earlier migrations first';
    END IF;
END $$;

-- ─── 0b. lock ordering, or this file deadlocks against the running app ──────
-- The first live paste of this migration died with:
--   ERROR: 40P01: deadlock detected
-- because two lock orders are exactly opposite. Once this file's trigger
-- exists — from an earlier paste, or a second paste running at the same time —
-- an ordinary roster save takes camp_state_kv first and then needs camp_people
-- to run the trigger, while this file takes camp_people first (CREATE INDEX,
-- ALTER TABLE, REVOKE all want AccessExclusive on it) and then needs
-- camp_state_kv for DROP TRIGGER. Neither can go on.
--
-- Taking camp_state_kv up front, in the strongest mode this file will ever
-- need, removes the cycle: every other writer must already hold camp_state_kv
-- before it can want camp_people, so there is only one order left. It also
-- prevents a lock UPGRADE part-way through, which can deadlock the same way
-- against a third session that is merely waiting.
--
-- This BLOCKS reads and writes of camp_state_kv for as long as the file runs —
-- seconds, mostly the minting loop. That is a real if brief outage, which is
-- the price of applying it while the app is up. lock_timeout means a busy
-- moment fails fast and cleanly, with nothing applied, instead of hanging or
-- deadlocking: just run it again.
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- ─── 1. the id normaliser ───────────────────────────────────────────────────
-- Byte-for-byte the client's normalizePersonId(): digits only, leading zeros
-- dropped, and zero or empty means "no id". The two must agree exactly or the
-- same camper resolves differently in the browser and in the database —
-- '0042' has to be 42 in both places, or the id is not an identity at all.
CREATE OR REPLACE FUNCTION public._person_id(p_raw text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT NULLIF(
             NULLIF(regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g'), '')::numeric,
             0)::bigint
$$;
COMMENT ON FUNCTION public._person_id(text) IS
    'Digits only, leading zeros dropped, 0/empty → NULL. Mirrors normalizePersonId() in campistry_me.js.';


-- ─── 2. the tables ──────────────────────────────────────────────────────────
-- One row per PERSON. kind tells you which store they came from, but the
-- primary key deliberately does NOT include it: that is the whole constraint —
-- a number is taken camp-wide, not taken-per-kind.
--
-- No FK to camps, for the reason 200 learned the hard way (ERROR 23503): this
-- table is written by a trigger, and an FK violation inside a trigger aborts
-- the ORIGINAL blob save. A camper must never fail to save because of a
-- bookkeeping row.
CREATE TABLE IF NOT EXISTS public.camp_people (
    camp_id    uuid   NOT NULL,
    person_id  bigint NOT NULL,
    kind       text   NOT NULL DEFAULT 'camper',
    -- The document's own key for this person: the roster key (their name) for
    -- a camper, the applicant id for staff. This is the bridge from the
    -- name-keyed world to the id-keyed one, and it is how a person is found
    -- again on the next save — never by name equality alone.
    source_key text   NOT NULL,
    name       text   NOT NULL DEFAULT '',
    -- Whether this id was chosen by the camp or minted here. A camp that
    -- imports its own numbers later can be told which rows we invented.
    minted     boolean NOT NULL DEFAULT false,
    payload    jsonb   NOT NULL DEFAULT '{}'::jsonb,
    -- Absence recorded, not obeyed — same rule as 211's families. A stale
    -- whole-object save is indistinguishable from a deliberate deletion, so
    -- nothing is destroyed and an id is never handed to somebody else.
    deleted_at timestamptz,
    first_seen timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT camp_people_pkey PRIMARY KEY (camp_id, person_id),
    CONSTRAINT camp_people_kind_check CHECK (kind IN ('camper', 'staff')),
    CONSTRAINT camp_people_person_id_positive CHECK (person_id > 0)
);

-- One person row per document entry. Without this a rename could mint a second
-- id for the same camper and both would look valid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_camp_people_source
    ON public.camp_people (camp_id, kind, source_key);

-- Name lookup, because every caller still speaks names until 217-221 land.
CREATE INDEX IF NOT EXISTS idx_camp_people_name
    ON public.camp_people (camp_id, kind, name);

CREATE INDEX IF NOT EXISTS idx_camp_people_live
    ON public.camp_people (camp_id) WHERE deleted_at IS NULL;

ALTER TABLE public.camp_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_people FROM anon, authenticated;

COMMENT ON TABLE public.camp_people IS
    'One row per camper or staff member holding a camp-unique id. PK (camp_id, person_id) is the constraint the app only enforced client-side: one number, one person, camp-wide. Projected from app1.camperRoster and campistryMe.staffApplications; deny-all, reads go through gated RPCs.';


-- The minting counter. A row per camp, incremented in place: an UPDATE ...
-- RETURNING is atomic on its own, so two callers cannot receive the same
-- number, which is exactly what the browser's max()+1 could not promise.
CREATE TABLE IF NOT EXISTS public.camp_person_seq (
    camp_id uuid   PRIMARY KEY,
    next_id bigint NOT NULL DEFAULT 1,
    CONSTRAINT camp_person_seq_next_positive CHECK (next_id > 0)
);
ALTER TABLE public.camp_person_seq ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_person_seq FROM anon, authenticated;


-- ─── 3. minting ─────────────────────────────────────────────────────────────
-- Hands out the next free number for a camp. Two things it must survive:
--
--   * a camp whose counter has never been seeded — start above the highest id
--     anyone already holds, so an imported four-digit roster is never trodden
--     on;
--   * a number already taken by a hand-entered id that sits ABOVE the counter.
--     Hence the loop: take a number, and if somebody holds it, take the next.
--     The loop is bounded by the count of people in the camp, because each
--     turn consumes one taken id.
--
-- ON THE LOOP LOOKING DEAD. The reseed above runs on EVERY call and lifts the
-- counter to max(person_id) + 1, so from a single session the first number
-- taken is always free and the loop never turns twice. Mutation testing
-- confirmed that: deleting the EXIT condition broke no test. It is kept
-- deliberately, because the window it covers is between sessions — another
-- transaction can insert a document-stated id above this counter after the
-- reseed and before the UPDATE, and without the check this call would hand
-- out a number that person now holds, whereupon _project_people's
-- ON CONFLICT DO NOTHING would silently give the new camper no row at all.
-- Unreachable in one session is not the same as unreachable. Do not remove it
-- because a test does not cover it; no single-connection test can.
CREATE OR REPLACE FUNCTION public.mint_person_id(p_camp_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id    bigint;
    v_guard integer := 0;
BEGIN
    -- Seed from whatever is already out there. GREATEST keeps a re-seed from
    -- ever moving the counter backwards over live ids.
    INSERT INTO camp_person_seq (camp_id, next_id)
    VALUES (p_camp_id,
            COALESCE((SELECT max(person_id) + 1 FROM camp_people WHERE camp_id = p_camp_id), 1))
    ON CONFLICT (camp_id) DO UPDATE
       SET next_id = GREATEST(camp_person_seq.next_id, EXCLUDED.next_id);

    LOOP
        v_guard := v_guard + 1;
        IF v_guard > 100000 THEN
            RAISE EXCEPTION 'mint_person_id: no free id for camp % after % tries', p_camp_id, v_guard;
        END IF;

        UPDATE camp_person_seq
           SET next_id = next_id + 1
         WHERE camp_id = p_camp_id
        RETURNING next_id - 1 INTO v_id;

        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM camp_people WHERE camp_id = p_camp_id AND person_id = v_id);
    END LOOP;

    RETURN v_id;
END;
$$;
-- Nobody calls this directly: it takes a camp id and would otherwise let any
-- caller burn numbers in a camp they cannot see. Same rule as 212's accessors.
REVOKE ALL ON FUNCTION public.mint_person_id(uuid) FROM public, anon, authenticated;


-- ─── 4. the projection ──────────────────────────────────────────────────────
-- Shared by both triggers: takes the entries of one document branch and brings
-- camp_people into line with them.
--
-- The rules, in order of authority:
--   1. An id STATED by the document wins. The camp chose it; we honour it.
--   2. Otherwise a person we have already seen keeps the id they have. An id
--      that moves is not an identity.
--   3. Otherwise mint one.
--
-- Rule 1 can collide: the document may hand person A a number person B already
-- holds (two browsers minting at once — precisely the race this table ends).
-- The collision is SKIPPED, never resolved by guesswork, and reported by
-- verify_camp_people(). A trigger that raised here would abort the camp's save
-- and lose the edit entirely, which is a far worse outcome than one row whose
-- id lags the document until someone looks.
CREATE OR REPLACE FUNCTION public._project_people(
    p_camp_id uuid,
    p_kind    text,
    p_old     jsonb,
    p_new     jsonb,
    p_id_field text,
    p_name_field text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r        record;
    v_stated bigint;
    v_have   bigint;
    v_holder text;
    v_holder_kind text;
    v_name   text;
    v_id     bigint;
BEGIN
    -- Only entries that actually CHANGED. A roster save rewrites every camper,
    -- and re-deriving all of them per save is the decay 206 had to undo.
    FOR r IN
        SELECT n.key AS k, n.value AS v
          FROM jsonb_each(p_new) AS n(key, value)
         WHERE jsonb_typeof(n.value) = 'object'
           AND (p_old -> n.key) IS DISTINCT FROM n.value
    LOOP
        v_stated := public._person_id(r.v ->> p_id_field);
        v_name   := COALESCE(NULLIF(r.v ->> p_name_field, ''), r.k);

        -- This person under their CURRENT label, and whoever holds the number
        -- the document is asking for. They are usually the same row; the
        -- interesting cases are when they are not.
        SELECT person_id INTO v_have
          FROM camp_people
         WHERE camp_id = p_camp_id AND kind = p_kind AND source_key = r.k;

        v_holder := NULL; v_holder_kind := NULL;
        IF v_stated IS NOT NULL THEN
            SELECT source_key, kind INTO v_holder, v_holder_kind
              FROM camp_people
             WHERE camp_id = p_camp_id AND person_id = v_stated;
        END IF;

        IF v_stated IS NOT NULL AND v_holder IS NOT NULL AND v_holder IS DISTINCT FROM r.k THEN
            -- Somebody else's row carries the number. Two very different
            -- situations look identical in the document, and getting them the
            -- wrong way round either loses a camper's history or steals it:
            --
            --   a RENAME — the roster is keyed by name, so "Rivka Stern" →
            --   "Rivka Stein" arrives as a new key carrying the same id, and
            --   the old key is simultaneously gone from the document. The id
            --   IS the person, so that row is this camper under a stale
            --   label: repoint it and keep every row that points at the
            --   number — canteen, Shop, billing — attached to the right child.
            --
            --   a CONFLICT — the holder is still present in the document, so
            --   two live people want one number (two browsers minting at once,
            --   the race this table ends). Skip the stated id, keep or mint
            --   this person's own, and let verify_camp_people() report it.
            --   Never resolved by guesswork.
            -- p_new is ONE branch of the document — this kind's. So "is the
            -- holder still in the document?" can only be asked of a holder of
            -- the SAME kind: a camper's name is not in the staff list, and
            -- reading its absence as a rename turned a camper into a counselor
            -- on the first run of this test. A number held by the other kind
            -- is always a conflict; that is the invariant, not an edge case.
            IF v_holder_kind IS DISTINCT FROM p_kind
               OR (p_new ? v_holder)
               OR v_have IS NOT NULL THEN
                v_stated := NULL;                      -- conflict, or ambiguous merge
            ELSE
                UPDATE camp_people
                   SET source_key = r.k, name = v_name, payload = r.v,
                       deleted_at = NULL, updated_at = now()
                 WHERE camp_id = p_camp_id AND person_id = v_stated;
                CONTINUE;                              -- rename handled
            END IF;
        END IF;

        v_id := COALESCE(v_stated, v_have);

        IF v_id IS NULL THEN
            v_id := public.mint_person_id(p_camp_id);
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, true, r.v)
            ON CONFLICT (camp_id, person_id) DO NOTHING;
        ELSIF v_have IS NOT NULL AND v_id IS DISTINCT FROM v_have THEN
            -- The camp renumbered this person by hand onto a free number.
            UPDATE camp_people
               SET person_id = v_id, name = v_name, payload = r.v,
                   minted = false, deleted_at = NULL, updated_at = now()
             WHERE camp_id = p_camp_id AND kind = p_kind AND source_key = r.k;
        ELSE
            INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
            VALUES (p_camp_id, v_id, p_kind, r.k, v_name, v_stated IS NULL, r.v)
            ON CONFLICT (camp_id, person_id) DO UPDATE
               SET source_key = EXCLUDED.source_key,
                   name       = EXCLUDED.name,
                   payload    = EXCLUDED.payload,
                   deleted_at = NULL,
                   updated_at = now();
        END IF;
    END LOOP;

    -- Gone from the document → stamped, never destroyed. The id stays spoken
    -- for, so a deleted camper's number is not handed to the next arrival and
    -- their canteen history cannot silently reattach to a stranger.
    UPDATE camp_people p
       SET deleted_at = now(), updated_at = now()
     WHERE p.camp_id = p_camp_id
       AND p.kind    = p_kind
       AND p.deleted_at IS NULL
       AND NOT (p_new ? p.source_key);
END;
$$;
REVOKE ALL ON FUNCTION public._project_people(uuid, text, jsonb, jsonb, text, text)
    FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.project_camp_campers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
BEGIN
    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.value -> 'camperRoster') = 'object' THEN
        v_old := OLD.value -> 'camperRoster';
    END IF;
    IF jsonb_typeof(NEW.value -> 'camperRoster') = 'object' THEN
        v_new := NEW.value -> 'camperRoster';
    END IF;

    -- An empty roster arriving where there was one is the season reset
    -- (campistry_me.js:21440 clears camperRoster wholesale). The rows are
    -- stamped, not dropped, so last season's ids stay spoken for — which is
    -- exactly why this project has 354 canteen accounts whose camper the
    -- roster can no longer name.
    PERFORM public._project_people(NEW.camp_id, 'camper', v_old, v_new, 'camperId', 'name');
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_campers() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_camp_campers ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_campers
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'app1')
EXECUTE FUNCTION public.project_camp_campers();


CREATE OR REPLACE FUNCTION public.project_camp_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
BEGIN
    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.value -> 'staffApplications') = 'object' THEN
        v_old := OLD.value -> 'staffApplications';
    END IF;
    IF jsonb_typeof(NEW.value -> 'staffApplications') = 'object' THEN
        v_new := NEW.value -> 'staffApplications';
    END IF;

    -- Staff share the camper sequence on purpose: campistry_me.js:246 — camps
    -- do not want the same number ever handed to a camper and a staff member.
    -- They are here so the primary key can enforce that, not because anything
    -- reads staff rows yet.
    PERFORM public._project_people(NEW.camp_id, 'staff', v_old, v_new, 'staffId', 'name');
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_staff() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_camp_staff ON public.camp_state_kv;
CREATE TRIGGER trg_project_camp_staff
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistryMe')
EXECUTE FUNCTION public.project_camp_staff();


-- ─── 5. the backfill ────────────────────────────────────────────────────────
-- Order matters. People who ALREADY hold a number are inserted first, across
-- both kinds, so that the minting pass cannot hand out a number a camp chose
-- for somebody else. Doing it the other way round would renumber real camps.
--
-- ON CONFLICT DO NOTHING on the primary key means that where a camp's own data
-- already has two people on one number — none in this project, but the code
-- outlives the data — the first one keeps it and the second is left for the
-- minting pass, rather than one silently overwriting the other.

-- It is a FUNCTION, not a bare block, for two reasons: the header promises it
-- "doubles as the repair tool" and a block pasted once is not a tool anybody
-- can reach; and a backfill that only ever runs inside a migration cannot be
-- tested, which is exactly how this one shipped its first version with every
-- branch unexercised.
CREATE OR REPLACE FUNCTION public.backfill_camp_people()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $backfill$
DECLARE
    r       record;
    v_id    bigint;
    v_stated integer := 0;
    v_minted integer := 0;
BEGIN
-- 5a. campers with an id the camp chose
INSERT INTO public.camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
-- The alias is `cr`, not `r`: `r` is this function's record variable, and
-- PL/pgSQL resolves a qualified name to the VARIABLE first. Shadowing it here
-- made the backfill fail with "record r is not assigned yet" — a name clash
-- that a bare DO block never had, because it had no variables.
SELECT kv.camp_id,
       public._person_id(cr.value ->> 'camperId'),
       'camper',
       cr.key,
       COALESCE(NULLIF(cr.value ->> 'name', ''), cr.key),
       false,
       cr.value
  FROM camp_state_kv kv
  CROSS JOIN LATERAL jsonb_each(
         CASE WHEN jsonb_typeof(kv.value -> 'camperRoster') = 'object'
              THEN kv.value -> 'camperRoster' ELSE '{}'::jsonb END) AS cr(key, value)
 WHERE kv.key = 'app1'
   AND jsonb_typeof(cr.value) = 'object'
   AND public._person_id(cr.value ->> 'camperId') IS NOT NULL
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
ON CONFLICT (camp_id, person_id) DO NOTHING;

-- 5b. staff with an id the camp chose
INSERT INTO public.camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
SELECT kv.camp_id,
       public._person_id(s.value ->> 'staffId'),
       'staff',
       s.key,
       COALESCE(NULLIF(s.value ->> 'name', ''), s.key),
       false,
       s.value
  FROM camp_state_kv kv
  CROSS JOIN LATERAL jsonb_each(
         CASE WHEN jsonb_typeof(kv.value -> 'staffApplications') = 'object'
              THEN kv.value -> 'staffApplications' ELSE '{}'::jsonb END) AS s(key, value)
 WHERE kv.key = 'campistryMe'
   AND jsonb_typeof(s.value) = 'object'
   AND public._person_id(s.value ->> 'staffId') IS NOT NULL
   AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
ON CONFLICT (camp_id, person_id) DO NOTHING;

-- 5c. everybody else gets a minted number, one at a time so the counter and
--     the taken-id check stay honest. 890 campers in this project.
    FOR r IN
        SELECT kv.camp_id, 'camper'::text AS kind, e.key AS k,
               COALESCE(NULLIF(e.value ->> 'name', ''), e.key) AS nm, e.value AS v
          FROM camp_state_kv kv
          CROSS JOIN LATERAL jsonb_each(
                 CASE WHEN jsonb_typeof(kv.value -> 'camperRoster') = 'object'
                      THEN kv.value -> 'camperRoster' ELSE '{}'::jsonb END) AS e(key, value)
         WHERE kv.key = 'app1'
           AND jsonb_typeof(e.value) = 'object'
           AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
        UNION ALL
        SELECT kv.camp_id, 'staff'::text, e.key,
               COALESCE(NULLIF(e.value ->> 'name', ''), e.key), e.value
          FROM camp_state_kv kv
          CROSS JOIN LATERAL jsonb_each(
                 CASE WHEN jsonb_typeof(kv.value -> 'staffApplications') = 'object'
                      THEN kv.value -> 'staffApplications' ELSE '{}'::jsonb END) AS e(key, value)
         WHERE kv.key = 'campistryMe'
           AND jsonb_typeof(e.value) = 'object'
           AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
    LOOP
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM camp_people p
             WHERE p.camp_id = r.camp_id AND p.kind = r.kind AND p.source_key = r.k);

        v_id := public.mint_person_id(r.camp_id);
        INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload)
        VALUES (r.camp_id, v_id, r.kind, r.k, r.nm, true, r.v)
        ON CONFLICT (camp_id, person_id) DO NOTHING;
        v_minted := v_minted + 1;
    END LOOP;

-- 5d. leave every camp's counter above the highest number in use, so the first
--     mint after this file cannot collide with a backfilled row.
    INSERT INTO public.camp_person_seq (camp_id, next_id)
    SELECT camp_id, max(person_id) + 1 FROM public.camp_people GROUP BY camp_id
    ON CONFLICT (camp_id) DO UPDATE
       SET next_id = GREATEST(camp_person_seq.next_id, EXCLUDED.next_id);

    SELECT count(*) INTO v_stated FROM camp_people WHERE NOT minted;
    RETURN jsonb_build_object(
        'mintedThisRun', v_minted,
        'idsTheCampChose', v_stated,
        'idsMintedEver', (SELECT count(*) FROM camp_people WHERE minted));
END;
$backfill$;
REVOKE ALL ON FUNCTION public.backfill_camp_people() FROM public, anon, authenticated;

SELECT public.backfill_camp_people();


-- ─── 6. the verifier ────────────────────────────────────────────────────────
-- Positive assertions, not a diff. A diff cannot catch a roster that was never
-- projected at all — which is exactly how the first pre-flight query reported
-- "0 campers" against 4,602 of them, because it read the wrong branch.
CREATE OR REPLACE FUNCTION public.verify_camp_people(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_roster    jsonb;
    v_staff     jsonb;
    v_in_doc    integer;
    v_in_rows   integer;
    v_missing   text[];
    v_dup_ids   integer;
    v_stated_ok integer;
    v_conflicts jsonb;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('error', 'not_your_camp');
    END IF;

    SELECT CASE WHEN jsonb_typeof(value -> 'camperRoster') = 'object'
                THEN value -> 'camperRoster' ELSE '{}'::jsonb END
      INTO v_roster FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1';
    SELECT CASE WHEN jsonb_typeof(value -> 'staffApplications') = 'object'
                THEN value -> 'staffApplications' ELSE '{}'::jsonb END
      INTO v_staff FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';
    v_roster := COALESCE(v_roster, '{}'::jsonb);
    v_staff  := COALESCE(v_staff,  '{}'::jsonb);

    v_in_doc := (SELECT count(*) FROM jsonb_each(v_roster) e WHERE jsonb_typeof(e.value) = 'object');

    SELECT count(*) INTO v_in_rows
      FROM camp_people WHERE camp_id = p_camp_id AND kind = 'camper' AND deleted_at IS NULL;

    -- Every camper in the document must have a row. Named, not counted: a
    -- count that happens to match tells you nothing about WHICH ones.
    SELECT COALESCE(array_agg(e.key ORDER BY e.key), '{}')
      INTO v_missing
      FROM jsonb_each(v_roster) e
     WHERE jsonb_typeof(e.value) = 'object'
       AND NOT EXISTS (SELECT 1 FROM camp_people p
                        WHERE p.camp_id = p_camp_id AND p.kind = 'camper'
                          AND p.source_key = e.key AND p.deleted_at IS NULL);

    -- The invariant itself. The primary key makes this impossible, so a
    -- non-zero answer means the key is gone, not that the data drifted.
    SELECT count(*) INTO v_dup_ids FROM (
        SELECT person_id FROM camp_people WHERE camp_id = p_camp_id
        GROUP BY person_id HAVING count(*) > 1) d;

    -- Ids the camp stated that we honoured.
    SELECT count(*) INTO v_stated_ok
      FROM jsonb_each(v_roster) e
      JOIN camp_people p
        ON p.camp_id = p_camp_id AND p.kind = 'camper' AND p.source_key = e.key
     WHERE public._person_id(e.value ->> 'camperId') IS NOT NULL
       AND p.person_id = public._person_id(e.value ->> 'camperId');

    -- Ids the camp stated that we could NOT honour, because another person
    -- already held the number. These are the only rows a human needs to see.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'camper', e.key,
               'wanted', public._person_id(e.value ->> 'camperId'),
               'has',    p.person_id)), '[]'::jsonb)
      INTO v_conflicts
      FROM jsonb_each(v_roster) e
      JOIN camp_people p
        ON p.camp_id = p_camp_id AND p.kind = 'camper' AND p.source_key = e.key
     WHERE public._person_id(e.value ->> 'camperId') IS NOT NULL
       AND p.person_id IS DISTINCT FROM public._person_id(e.value ->> 'camperId');

    RETURN jsonb_build_object(
        'campersInDoc',      v_in_doc,
        'campersInRows',     v_in_rows,
        'everyCamperHasRow', (v_missing = '{}'),
        'missingCampers',    to_jsonb(v_missing),
        'staffInDoc',        (SELECT count(*) FROM jsonb_each(v_staff) e WHERE jsonb_typeof(e.value) = 'object'),
        'staffInRows',       (SELECT count(*) FROM camp_people
                               WHERE camp_id = p_camp_id AND kind = 'staff' AND deleted_at IS NULL),
        'statedIdsHonoured', v_stated_ok,
        'idConflicts',       v_conflicts,
        'duplicateIds',      v_dup_ids,
        'idIsUnique',        (v_dup_ids = 0),
        'nextId',            (SELECT next_id FROM camp_person_seq WHERE camp_id = p_camp_id),
        'mintedHere',        (SELECT count(*) FROM camp_people
                               WHERE camp_id = p_camp_id AND minted AND deleted_at IS NULL)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_camp_people(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_camp_people(uuid) TO authenticated, service_role;


-- ─── what this file deliberately does NOT do ────────────────────────────────
-- * No reader or writer changes. Every function still takes p_camper_name and
--   still reads the blob. 217 builds the canteen accounts table on top of this,
--   218 switches its readers, 219 moves the writers and takes the camp-wide
--   lock off, 220 does Shop, 221 turns families' `camperIds` into real ids.
-- * It does not touch the 354 canteen accounts whose camper the roster cannot
--   name. They are 217's problem, and they need this table to exist first.
-- * It does not stop the browser minting ids. It makes that harmless — the
--   document's number is honoured when it is free and ignored when it is not,
--   and the row keeps the identity either way. Moving the client onto
--   mint_person_id is a later, separate change.


-- ─── did it work? ───────────────────────────────────────────────────────────
-- Last statement on purpose: a rolled-back paste cannot print this, so seeing
-- it at all means the whole file applied.
SELECT 'migration 216 applied'                                          AS status,
       (SELECT count(*) FROM camp_people WHERE kind = 'camper'
                                           AND deleted_at IS NULL)      AS camper_rows,
       (SELECT count(*) FROM camp_people WHERE kind = 'staff'
                                           AND deleted_at IS NULL)      AS staff_rows,
       (SELECT count(*) FROM camp_people WHERE minted)                  AS ids_minted_here,
       (SELECT count(*) FROM camp_person_seq)                           AS camps_with_a_counter,
       (SELECT count(*) FROM (SELECT camp_id, person_id FROM camp_people
                              GROUP BY camp_id, person_id
                              HAVING count(*) > 1) d)                   AS duplicate_ids;
