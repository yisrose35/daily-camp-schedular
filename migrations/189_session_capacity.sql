-- =============================================================================
-- 189 — a session capacity that is actually a capacity
--
-- Every session in this app carries a `capacity`. The dashboard asks for it,
-- saves it, and prints it back. NOTHING has ever read it. Not the public
-- registration form, not the office's own enrollment, not a single SQL
-- function: a grep for `capacity` across the migrations returns no hits at all
-- outside the schedule solver's field-sharing, which is a different idea with
-- the same name.
--
-- So a camp sets a session to 40 places, sixty families register, and all sixty
-- are accepted — and, since migration 185, all sixty are asked for a deposit.
-- The camp finds out weeks later and has to refund twenty families, by which
-- time some of those payments are past the card networks' refund window and
-- have to go back as cheques. "Sessions get overbooked" is one of the standard
-- complaints about this category of software, and this is the shape of it: the
-- number was collected and never enforced.
--
-- WHAT FULL MEANS HERE: WAITLISTED, NOT REFUSED
--
-- A full session does not reject the application. It records it as
-- `status = 'waitlisted'` — the status the register page's own confirmation
-- screen has always been able to display and that nothing ever set. That is the
-- same judgement migration 185 made about the deposit: never throw away twenty
-- minutes of a parent's typing. The office gets a real waitlist in submission
-- order, and a place that frees up is theirs to give.
--
-- And a waitlisted application OWES NOTHING. _registration_deposit_owed now
-- returns zero for one, so the form cannot ask a family to pay to hold a place
-- that does not exist. That is the actual money bug; the rest is bookkeeping.
--
-- WHY THE COUNT IS TAKEN UNDER A LOCK
--
-- Counting and then writing is the overbooking bug in miniature: two families
-- submitting for the last place both count 39, both decide there is room, and
-- both are enrolled. The count here happens after SELECT ... FOR UPDATE on the
-- camp's own campistryMe row, which every submission has to take anyway in
-- order to write, so the second submission waits for the first and then counts
-- 40. One place, one camper.
--
-- WHO COUNTS TOWARDS IT: applied, waitlisted-no (they are the queue), accepted
-- and enrolled — anyone the camp has not turned away. A declined or withdrawn
-- camper frees their place, which is the whole point of a waitlist.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own.
-- Idempotent. Requires 184 (the submission guard) and 185 (the deposit).
-- =============================================================================

-- ─── 1. how full a session is ────────────────────────────────────────────────
/**
 * Places taken in one session, by name.
 *
 * Names, not ids, because that is what an enrollment stores (`session`) and
 * what the sessions array is keyed on for every other purpose in this app.
 *
 * A capacity of 0 or absent means UNLIMITED, matching how the dashboard's own
 * form treats an empty box. It must never mean "nobody may register", which is
 * what a naive `taken >= capacity` would make of it.
 */
CREATE OR REPLACE FUNCTION public._session_taken(
    p_doc     jsonb,
    p_session text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT count(*)::integer
      FROM jsonb_each(coalesce(p_doc -> 'enrollments', '{}'::jsonb)) AS e(k, v)
     WHERE v ->> 'session' = p_session
       AND coalesce(v ->> 'status', '') IN ('applied', 'waitlisted', 'accepted', 'enrolled');
$$;

/**
 * Capacity, places taken and places left for every session a camp has.
 *
 * Anon-callable, because the public registration form has to be able to say
 * "Full — join the waitlist" BEFORE a family fills anything in. It returns
 * counts, never names: how many places are left in a session is what a camp
 * puts on its own website, and nothing here identifies a camper.
 */
CREATE OR REPLACE FUNCTION public.session_capacity_state(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_doc jsonb;
    v_out jsonb := '[]'::jsonb;
    v_s   jsonb;
    v_cap integer;
    v_tak integer;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT value INTO v_doc
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_doc IS NULL THEN
        RETURN jsonb_build_object('success', true, 'sessions', '[]'::jsonb);
    END IF;

    FOR v_s IN SELECT jsonb_array_elements(coalesce(v_doc -> 'sessions', '[]'::jsonb)) LOOP
        CONTINUE WHEN coalesce(btrim(v_s ->> 'name'), '') = '';
        v_cap := greatest(0, coalesce(NULLIF(v_s ->> 'capacity', '')::numeric, 0)::integer);
        v_tak := public._session_taken(v_doc, v_s ->> 'name');
        v_out := v_out || jsonb_build_object(
            'name',      v_s ->> 'name',
            'capacity',  v_cap,
            'taken',     v_tak,
            -- NULL remaining means unlimited. A client reading 0 here would
            -- show "no places left" for a session that has no limit at all.
            'remaining', CASE WHEN v_cap > 0 THEN greatest(0, v_cap - v_tak) ELSE NULL END,
            'full',      (v_cap > 0 AND v_tak >= v_cap)
        );
    END LOOP;

    RETURN jsonb_build_object('success', true, 'sessions', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public.session_capacity_state(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.session_capacity_state(uuid) TO anon, authenticated;

-- ─── 2. the submission honours it ────────────────────────────────────────────
-- Replaces 184's definition. Everything 184 guards is kept verbatim — the
-- weak-entry-id floor, the already-processed refusal, the jsonb_set write that
-- cannot straddle a concurrent browser save. The only additions are the lock
-- and the capacity decision.
CREATE OR REPLACE FUNCTION public.submit_public_application(
    p_camp_id  uuid,
    p_kind     text,
    p_entry_id text,
    p_entry    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_existing jsonb;
    v_status   text;
    v_doc      jsonb;
    v_session  text;
    v_cap      integer;
    v_taken    integer;
    v_entry    jsonb := p_entry;
    v_waited   boolean := false;
BEGIN
    IF p_camp_id IS NULL OR p_entry_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF p_kind NOT IN ('enrollments', 'staffApplications') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    -- 184: the id must be unguessable, because it is the only thing standing
    -- between an anonymous caller and somebody else's record.
    IF length(p_entry_id) < 32 THEN
        RETURN jsonb_build_object('success', false, 'error', 'weak_entry_id');
    END IF;

    -- THE LOCK. Taken before anything is counted, and held to commit. Every
    -- submission has to write this row anyway, so this costs nothing and turns
    -- "count then write" — the overbooking bug itself — into one serialized
    -- decision per camp. A camp with no row yet cannot be over capacity, so
    -- there is nothing to lock and nothing to count.
    SELECT value INTO v_doc
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
       FOR UPDATE;

    -- 184: a public submission may create, or re-send, an entry that is still
    -- 'applied'. The moment the office has acted on it, the public endpoint is
    -- shut out — otherwise anyone who guessed an id could rewrite an accepted
    -- camper's record from an anonymous page.
    v_existing := v_doc -> p_kind -> p_entry_id;
    IF v_existing IS NOT NULL AND jsonb_typeof(v_existing) = 'object' THEN
        v_status := COALESCE(v_existing->>'status', '');
        -- 'waitlisted' joins 'applied' as a state a retry may re-send: it is
        -- set by THIS function, so a retried submission legitimately finds it.
        IF v_status NOT IN ('applied', 'waitlisted') THEN
            RETURN jsonb_build_object('success', false, 'error', 'already_processed',
                                      'status', v_status);
        END IF;
    END IF;

    -- CAPACITY. Registrations only: a staff application is not a place in a
    -- session. An entry that already exists is being re-sent, so it is already
    -- counted and must not be pushed onto the waitlist by its own retry.
    IF p_kind = 'enrollments' AND v_doc IS NOT NULL AND v_existing IS NULL THEN
        v_session := NULLIF(btrim(COALESCE(p_entry ->> 'session', '')), '');
        IF v_session IS NOT NULL THEN
            SELECT greatest(0, coalesce(NULLIF(s ->> 'capacity', '')::numeric, 0)::integer)
              INTO v_cap
              FROM jsonb_array_elements(coalesce(v_doc -> 'sessions', '[]'::jsonb)) AS s
             WHERE s ->> 'name' = v_session
             LIMIT 1;

            -- A capacity of 0 or absent is UNLIMITED, the same as an empty box
            -- on the dashboard's own session form.
            IF COALESCE(v_cap, 0) > 0 THEN
                v_taken := public._session_taken(v_doc, v_session);
                IF v_taken >= v_cap THEN
                    -- Full. Keep everything the family typed and queue them,
                    -- rather than refusing and losing the application.
                    v_entry := v_entry
                        || jsonb_build_object('status', 'waitlisted')
                        || jsonb_build_object('waitlistedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
                        -- Zeroed on the entry itself as well as in
                        -- _registration_deposit_owed below: a family must not be
                        -- asked to pay to hold a place that does not exist, and
                        -- the form reads this field to decide whether to ask.
                        || jsonb_build_object('depositRequired', 0);
                    v_waited := true;
                END IF;
            END IF;
        END IF;
    END IF;

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistryMe', jsonb_build_object(p_kind, jsonb_build_object(p_entry_id, v_entry)), now())
    ON CONFLICT (camp_id, key) DO UPDATE
    SET value = jsonb_set(
            camp_state_kv.value,
            ARRAY[p_kind],
            coalesce(camp_state_kv.value -> p_kind, '{}'::jsonb) || jsonb_build_object(p_entry_id, v_entry),
            true
        ),
        updated_at = now();

    RETURN jsonb_build_object('success', true, 'id', p_entry_id,
                              'waitlisted', v_waited,
                              'status', COALESCE(v_entry ->> 'status', 'applied'));
END;
$$;

REVOKE ALL ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) TO anon, authenticated;

-- ─── 3. a waitlisted application owes nothing ────────────────────────────────
-- Replaces 185's definition, unchanged except for the waitlist guard. Without
-- it the deposit step would still quote an amount for a place the camp has not
-- got, take the money, and leave the office to refund it.
CREATE OR REPLACE FUNCTION public._registration_deposit_owed(
    p_camp_id   uuid,
    p_enroll_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_enr    jsonb;
    v_req    numeric;
    v_paid   numeric;
    v_status text;
BEGIN
    SELECT value #> ARRAY['enrollments', p_enroll_id]
      INTO v_enr
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_enr IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    -- On the waitlist: there is no place to hold, so there is nothing to pay
    -- for. Charging here is the overbooking bug turning into a refund.
    v_status := COALESCE(v_enr->>'status', '');
    IF v_status = 'waitlisted' THEN
        RETURN jsonb_build_object('success', true, 'owed', 0, 'required', 0, 'paid', 0,
                                  'reason', 'waitlisted');
    END IF;

    v_req  := COALESCE(NULLIF(v_enr->>'depositRequired', '')::numeric, 0);
    v_paid := COALESCE(NULLIF(v_enr->>'depositPaid', '')::numeric, 0);

    RETURN jsonb_build_object(
        'success',  true,
        'required', v_req,
        'paid',     v_paid,
        'owed',     greatest(0, v_req - v_paid)
    );
END;
$$;

REVOKE ALL ON FUNCTION public._registration_deposit_owed(uuid, text) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Verify after running:
--   -- what every session has left (anon-callable, counts only):
--   select public.session_capacity_state('<camp uuid>');
--
--   -- an unlimited session reports remaining = null, not 0:
--   --   set one session's capacity to 0 in Sessions & Pricing, then re-run.
--
--   -- fill a session to its capacity, then submit one more and watch it queue:
--   select public.submit_public_application('<camp uuid>', 'enrollments',
--     'enr_' || gen_random_uuid(),
--     '{"camperName":"Overflow Test","session":"<full session name>","status":"applied"}'::jsonb);
--   -- {"success": true, "waitlisted": true, "status": "waitlisted", ...}
--
--   -- and owes nothing:
--   select public._registration_deposit_owed('<camp uuid>', '<that id>');
--   -- {"success": true, "owed": 0, "reason": "waitlisted", ...}
--
--   -- a retry of an already-queued application does not re-queue or refuse it:
--   --   re-run the same submit_public_application call with the SAME id.
--   -- {"success": true, ...}
--
--   -- clean up:
--   --   remove the test entry from campistryMe.enrollments in the app.
