/* =============================================================================
 * campistry_workspace.js — plan the second half while the first half is running.
 *
 * WHAT THIS IS. A camp runs on one set of operational state: who is in which
 * bunk, what the divisions are, which bus goes where, what the schedule layers
 * look like, what the rotation history says. All of it is singular. So when the
 * second half is three weeks out and the office wants to start building next
 * half's bunks, they have exactly two options today: overwrite the running
 * camp's data, or keep it on paper.
 *
 * A WORKSPACE is a named copy of that operational state. One workspace is LIVE
 * — it is the camp, it is what every screen and every counsellor sees. The
 * others are SANDBOXES: fully editable, fully saved, and visible to nobody but
 * the office. When the day comes, a sandbox is PROMOTED: it becomes live, and
 * the outgoing live workspace is archived as a sandbox of its own, so last
 * half's bunk lists and routes are still there to look at.
 *
 * ── THE SAFETY PROPERTY THIS DESIGN IS BUILT AROUND ─────────────────────────
 *
 * THE LIVE WORKSPACE USES THE BARE KEYS. `app1` is `app1`. Not `ws:live/app1`,
 * not a row with a workspace column set to 'live' — the same key, in the same
 * place, that every reader in this app has always used.
 *
 * That is not a convenience, it is the whole risk model. Every page, every
 * script, every edge function that has ever read `app1` keeps reading `app1` and
 * keeps working, with no knowledge that workspaces exist. A sandbox writes to a
 * PREFIXED key and can therefore touch nothing. If this entire module failed to
 * load, if the prefix were computed wrongly, if a workspace id were corrupt —
 * the worst available outcome is that somebody's sandbox looks empty. There is
 * no reachable bug in here that damages a running camp, because the running camp
 * is the code path that this module does not participate in.
 *
 * ── WHAT IS SANDBOXED, AND WHAT IS NEVER ────────────────────────────────────
 *
 * OPERATIONAL state is sandboxed: placement, structure, routes, periods, league
 * setup, and every rotation/history key. That last group matters more than it
 * looks — generating a trial schedule in a sandbox must not burn the live
 * camp's rotation fairness, and it would, because rotation counts are written
 * as a side effect of generating.
 *
 * IDENTITY AND MONEY ARE NEVER SANDBOXED. Families, enrollments, the ledger,
 * payroll, canteen and shop balances stay live in every mode, on the bare key,
 * always. A payment is a fact about the world; there is no such thing as a
 * sandbox payment, and a camp must never be able to take real money into a
 * planning copy or "promote" a balance. So the Me page, Billing and the tills
 * read and write live whatever workspace is selected — and the client refuses
 * writes to those keys from sandbox mode rather than silently routing them,
 * because a silent route is how a camp would discover in August that a summer
 * of payments went into a draft.
 *
 * ── WHY NOT FALL BACK TO LIVE WHEN A SANDBOX KEY IS MISSING ─────────────────
 *
 * Because a read-through fallback plus a write creates a half-seeded sandbox:
 * you edit what you believe is a copy, only the key you touched is actually
 * copied, and every other key silently still shows live — until something
 * writes one of those too. A sandbox is SEEDED ON CREATION, server-side, in one
 * transaction. After that a missing key means an empty one, which is honest.
 * ========================================================================== */
(function (root) {
    'use strict';
    var W = {};

    /** The prefix that makes a key belong to a sandbox. Live has no prefix. */
    W.PREFIX = 'ws:';

    /**
     * State that belongs to a workspace: the things an office plans ahead.
     *
     * Adding a key here makes it copy on sandbox creation and swap on promotion.
     * Leaving one out means it is shared by every workspace — which is correct
     * for anything that is a fact about the camp rather than a plan for a half.
     */
    W.OPERATIONAL = [
        'app1',              // camper placement (bunk/division/grade), fields, config
        'campStructure',     // divisions, grades, bunks
        'bunkMetaData',      // bunk sizes and metadata
        'fields',            // facilities
        'campPeriods',       // the day's period structure
        'campistryGo',       // bus routes and stops
        'campistryLuggage',  // luggage, which lives inside Go
        'leaguesByName',     // league setup
        'specialtyLeagues',
        'leagueRoundState',
        // ── history and rotation ────────────────────────────────────────────
        // Sandboxed deliberately. Generating a trial schedule WRITES rotation
        // counts as a side effect, so a shared history would let a week of
        // planning quietly decide who gets the good activities in the running
        // camp. A sandbox gets a copy at creation and diverges from there.
        'rotationHistory', 'rotationEpoch', 'swimRotationHistory',
        'historicalCounts', 'historicalCountsByDate', 'historicalCountedDates',
        'activityHistory', 'leagueHistory', 'specialtyLeagueHistory',
        'manualUsageOffsets', 'solverV3LearningData', 'scheduleViewIncrement'
    ];

    /**
     * State that is NEVER workspaced, in any mode, ever.
     *
     * Listed explicitly rather than derived as "everything else", so that a key
     * nobody has classified fails safe: an unknown key is treated as GLOBAL and
     * stays on the bare key, shared. A new key that should have been sandboxed
     * and was not is a planning inconvenience; a new key that should have been
     * global and got sandboxed could put money in a draft.
     */
    W.GLOBAL = [
        'campistryMe',          // families, enrollments, roster identity, billing
        'campistryMeFinance',
        'campistryMePayroll',
        'campistrySnacks',      // canteen balances — real money
        'campistryShop',        // shop orders — real money
        'campistryLink',        // the parent portal's own config
        'link_forms',
        'campDates', 'campName', 'camp_name',
        'daily_schedules'       // its own table, keyed by DATE — see below
    ];

    /**
     * Keys whose EDITS are refused outright while a sandbox is selected.
     *
     * Global keys are shared, so writing one from sandbox mode would be a live
     * edit made from a screen labelled "sandbox". Rather than route it silently
     * — correct, but indistinguishable from a bug — the client refuses and says
     * to switch to live first.
     */
    W.LIVE_ONLY_WRITES = W.GLOBAL;

    function has(list, k) { return list.indexOf(k) >= 0; }

    /** Is this key one that a workspace owns a copy of? */
    W.isOperational = function (key) { return has(W.OPERATIONAL, String(key || '')); };

    /** Is this key shared by every workspace? Unknown keys answer yes. */
    W.isGlobal = function (key) { return !W.isOperational(key); };

    /**
     * A workspace id, safe to put in a key.
     *
     * Lower-cased, non-alphanumerics collapsed to underscores, length-capped.
     * `live` is reserved and can never be produced, because the live workspace
     * is the ABSENCE of a prefix and a workspace literally called "live" would
     * be a second, different thing wearing the same name.
     */
    W.idFor = function (name) {
        var id = String(name == null ? '' : name)
            .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        if (!id || id === 'live') id = 'ws_' + id;
        return id;
    };

    /**
     * The key to actually read or write.
     *
     * `workspace` is null/'live' for the live camp, or a workspace id.
     * Returns the BARE key for live, for a global key, or for an unknown one.
     */
    W.keyFor = function (key, workspace) {
        var k = String(key == null ? '' : key);
        var ws = String(workspace == null ? '' : workspace);
        if (!ws || ws === 'live') return k;
        if (!W.isOperational(k)) return k;      // global keys are never prefixed
        return W.PREFIX + ws + '/' + k;
    };

    /** The inverse: split a stored key back into {workspace, key}. */
    W.parseKey = function (stored) {
        var s = String(stored == null ? '' : stored);
        if (s.indexOf(W.PREFIX) !== 0) return { workspace: 'live', key: s };
        var rest = s.slice(W.PREFIX.length);
        var slash = rest.indexOf('/');
        if (slash < 0) return { workspace: 'live', key: s };   // malformed: treat as live
        return { workspace: rest.slice(0, slash), key: rest.slice(slash + 1) };
    };

    /** Every stored key a workspace owns, for seeding and promoting. */
    W.keysFor = function (workspace) {
        return W.OPERATIONAL.map(function (k) { return W.keyFor(k, workspace); });
    };

    /** Are we live? Anything unrecognised is live, which is the safe answer. */
    W.isLive = function (workspace) {
        var ws = String(workspace == null ? '' : workspace);
        return !ws || ws === 'live';
    };

    /**
     * May this key be written from this workspace?
     *
     * Returns { ok, reason }. Live may write anything. A sandbox may write its
     * own operational keys and nothing else.
     */
    W.canWrite = function (key, workspace) {
        if (W.isLive(workspace)) return { ok: true, reason: 'live' };
        if (W.isOperational(key)) return { ok: true, reason: 'sandbox_operational' };
        return {
            ok: false,
            reason: 'live_only',
            message: 'Campers, families, payments and balances are always live — ' +
                     'switch back to the live session to change them.'
        };
    };

    /**
     * What to put on screen so nobody forgets which one they are in.
     *
     * A sandbox that looks like the live camp is the failure mode this whole
     * feature has to avoid, so the banner text is part of the rule rather than
     * left to each page.
     */
    W.banner = function (o) {
        o = o || {};
        if (W.isLive(o.workspace)) return null;
        return {
            tone: 'sandbox',
            title: 'Planning ' + (o.label || o.workspace),
            detail: 'Nothing here is live. Bunks, structure, routes, periods and ' +
                    'schedules are a separate copy. Campers, families and payments ' +
                    'are always the live ones.',
            action: 'Back to live'
        };
    };

    if (typeof root !== 'undefined' && root) root.CampistryWorkspace = W;
    if (typeof module !== 'undefined' && module.exports) module.exports = W;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
