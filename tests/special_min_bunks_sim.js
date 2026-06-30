// =============================================================================
// special_min_bunks_sim.js
// -----------------------------------------------------------------------------
// Regression sim for STEP 7.63 (scheduler_core_main.js): special-activity
// MINIMUM bunks (the floor). A special can declare sharableWith.minBunks — e.g.
// the lake always needs 2 bunks together. capacity is the ceiling, minBunks the
// floor. The manual solver places specials per-bunk, so a special can land on a
// single bunk (a "lonely" session). STEP 7.63 enforces the floor:
//   (1) RECRUIT eligible still-Free bunks (same time window, grade-compatible
//       per the sharing type, has access, not already done today, on a non-sport
//       tile) into the lonely session up to minBunks, never past capacity.
//   (2) DROP — if a session still can't reach the floor, demote every
//       non-user-locked member to Free (so the no-repeat fill refills them).
//
// This sim ports the STEP 7.63 algorithm verbatim and asserts: recruit, drop,
// already-satisfied no-op, cross-division pairing, capacity respected, and full
// inertness when no special opts in (minBunks 0).
// =============================================================================

'use strict';
const assert = require('assert');

// ---- Ported STEP 7.63 core (mirrors scheduler_core_main.js) -----------------
// Inputs:
//   sa        : scheduleAssignments { bunk: [entry,...] }
//   b2g       : { bunk: grade }
//   specials  : [{ name, sharableWith:{ type, capacity, minBunks, allowedPairs } }]
//   kindByCell: { 'bunk|idx': 'sport'|'special'|'any' }  (optional)
//   isAvail   : (specialName, grade, bunk) => bool        (access gate)
function enforceMinBunks(sa, b2g, specials, kindByCell, isAvail, daysSince) {
    kindByCell = kindByCell || {};
    daysSince = daysSince || (() => null); // (specialName, bunk) => days since last, or null=never
    isAvail = isAvail || (() => true);
    const done = {};
    Object.keys(sa).forEach(b => {
        done[b] = {};
        (sa[b] || []).forEach(e => {
            if (!e || e.continuation) return;
            const a = e._activity || e.sport;
            if (a && String(a).toLowerCase() !== 'free') done[b][String(a).toLowerCase()] = 1;
        });
    });

    const minSpecs = {};
    specials.forEach(s => {
        if (!s || !s.name) return;
        const sw = s.sharableWith || {};
        if ((sw.type || 'not_sharable') === 'not_sharable') return;
        let mb = parseInt(sw.minBunks, 10) || 0;
        if (mb < 2) return;
        const cap = parseInt(sw.capacity, 10) || 2;
        mb = Math.min(mb, cap);
        if (mb < 2) return;
        minSpecs[String(s.name).toLowerCase().trim()] = { name: s.name, minBunks: mb, cap: cap, type: sw.type, pairs: sw.allowedPairs || {} };
    });
    const stats = { recruited: 0, swapped: 0, droppedBunks: 0, fixed: 0, dropSess: 0, inert: Object.keys(minSpecs).length === 0 };
    if (stats.inert) return stats;

    const isFree = (e) => { const a = String((e && (e._activity || e.field || e.sport)) || '').toLowerCase().trim(); return a === '' || a === 'free' || a === 'free play' || a === 'free (timeout)'; };
    const winOf = (e) => (e && e._startMin != null && e._endMin != null) ? { s: e._startMin, e: e._endMin } : null;

    const grp = {};
    Object.keys(sa).forEach(b => {
        const g = b2g[b] || '?';
        (sa[b] || []).forEach((e, idx) => {
            if (!e || e.continuation) return;
            const actLC = String(e._activity || e._assignedSpecial || '').toLowerCase().trim();
            const spec = minSpecs[actLC];
            if (!spec) return;
            const t = winOf(e); if (!t) return;
            const key = actLC + '|' + t.s + '|' + t.e;
            (grp[key] = grp[key] || { actLC, spec, s: t.s, e: t.e, members: [] }).members.push({ bunk: b, idx, grade: g });
        });
    });

    Object.keys(grp).forEach(key => {
        const G = grp[key], spec = G.spec, s = G.s, en = G.e, actLC = G.actLC;
        if (G.members.length >= spec.minBunks) return;
        const gradeOk = (cg) => {
            const now = G.members.map(m => m.grade);
            if (spec.type === 'same_division') return now.every(eg => eg === cg);
            if (spec.type === 'cross_division') return now.every(eg => spec.pairs[[eg, cg].sort().join('|')] === true);
            return now.every(eg => eg === cg);
        };
        const tmpl = sa[G.members[0].bunk][G.members[0].idx];
        const fld = (tmpl && tmpl.field) || spec.name;
        // (1) RECRUIT — tier 0 = Free bunk, tier 1 = swap a plain sport.
        const SKIP = { 'pool': 1, 'swim': 1, 'lunch': 1, 'snack': 1, 'snacks': 1, 'dismissal': 1 };
        const cands = [];
        Object.keys(sa).forEach(b => {
            if (G.members.some(m => String(m.bunk) === String(b))) return;
            const g = b2g[b] || '?';
            if (!gradeOk(g)) return;
            if (done[b] && done[b][actLC]) return;
            if (!isAvail(spec.name, g, b)) return;
            const arr = sa[b] || [];
            let best = null;
            for (let idx = 0; idx < arr.length; idx++) {
                const e = arr[idx];
                if (!e || e.continuation || e._isTransition || e._league || e._h2h || e._postEdit || e._pinned || e._bunkOverride) continue;
                const t = winOf(e); if (!t || t.s !== s || t.e !== en) continue;
                const ck = kindByCell[b + '|' + idx];
                const kind = (ck && ck !== 'any') ? ck : 'any';
                if (kind === 'sport') continue;
                if (isFree(e)) { best = { bunk: b, idx, grade: g, tier: 0 }; break; }
                if (e.sport && !e._assignedSpecial && !minSpecs[String(e._activity || '').toLowerCase().trim()]
                    && !SKIP[String(e.field || '').toLowerCase().trim()] && !best) {
                    best = { bunk: b, idx, grade: g, tier: 1 };
                }
            }
            if (best) {
                const d = daysSince(spec.name, best.bunk);
                best.days = (typeof d === 'number') ? d : 9999; // null=never → freshest
                cands.push(best);
            }
        });
        cands.sort((a, b) => (a.tier - b.tier) || (b.days - a.days));
        for (let ci = 0; ci < cands.length && G.members.length < spec.minBunks && G.members.length < spec.cap; ci++) {
            const c = cands[ci];
            sa[c.bunk][c.idx] = { field: fld, sport: null, _activity: spec.name, _assignedSpecial: spec.name, _specialLocation: fld, _startMin: s, _endMin: en, _fixed: true, _freeFilled: true, _minBunkFilled: true, _minBunkSwapped: (c.tier === 1) || undefined, continuation: false };
            (done[c.bunk] = done[c.bunk] || {})[actLC] = 1;
            G.members.push({ bunk: c.bunk, idx: c.idx, grade: c.grade });
            stats.recruited++; if (c.tier === 1) stats.swapped++;
        }
        if (G.members.length >= spec.minBunks) { stats.fixed++; return; }
        // (2) DROP
        let droppedAny = false;
        G.members.forEach(m => {
            const e = sa[m.bunk] && sa[m.bunk][m.idx];
            if (!e || e._league || e._postEdit || e._pinned || e._bunkOverride) return;
            const t = winOf(e) || { s, e: en };
            sa[m.bunk][m.idx] = { field: 'Free', sport: null, _activity: 'Free', _startMin: t.s, _endMin: t.e, _fixed: true, _constraintDemoted: true, _demotedReason: 'special_min_bunks', continuation: false };
            (done[m.bunk] = done[m.bunk] || {})[actLC] = 1;
            stats.droppedBunks++; droppedAny = true;
        });
        if (droppedAny) stats.dropSess++;
    });
    return stats;
}

const LAKE = (extra) => ({ name: 'Lake', sharableWith: Object.assign({ type: 'same_division', capacity: 4, minBunks: 2, allowedPairs: {} }, extra || {}) });
const lakeEnt = () => ({ field: 'The Lake', sport: null, _activity: 'Lake', _assignedSpecial: 'Lake', _specialLocation: 'The Lake', _startMin: 600, _endMin: 640, continuation: false });
const freeEnt = (s, e) => ({ field: 'Free', _activity: 'Free', _startMin: s != null ? s : 600, _endMin: e != null ? e : 640, continuation: false });
const sportEnt = (s, e) => ({ field: 'Court 1', sport: 'Kickball', _activity: 'Kickball', _startMin: s != null ? s : 600, _endMin: e != null ? e : 640, continuation: false });

let pass = 0;
function ok(name, cond) { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); pass++; }

// =============================================================================
// TEST 1 — RECRUIT: a Free same-grade bunk at the same window joins lonely Lake
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [freeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()]);
    ok('T1 recruited exactly one bunk', st.recruited === 1 && st.fixed === 1 && st.droppedBunks === 0);
    ok('T1 A2 now on Lake', sa.A2[0]._activity === 'Lake' && sa.A2[0]._minBunkFilled === true);
    ok('T1 A1 untouched', sa.A1[0]._activity === 'Lake' && !sa.A1[0]._constraintDemoted);
}

// =============================================================================
// TEST 2 — DROP: no eligible partner → lonely Lake demoted to Free
// (A2's slot is a sport-ONLY tile so Lake can't go there; A3 is at another window)
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [sportEnt()], A3: [freeEnt(700, 740)] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKE()], { 'A2|0': 'sport' });
    ok('T2 nothing recruited', st.recruited === 0);
    ok('T2 one bunk dropped, one session', st.droppedBunks === 1 && st.dropSess === 1);
    ok('T2 A1 demoted to Free w/ reason', sa.A1[0]._activity === 'Free' && sa.A1[0]._demotedReason === 'special_min_bunks');
    ok('T2 A1 window preserved for refill', sa.A1[0]._startMin === 600 && sa.A1[0]._endMin === 640);
    ok('T2 A2 sport untouched', sa.A2[0]._activity === 'Kickball');
}

// =============================================================================
// TEST 2b — SWAP: packed schedule, no Free bunk → displace a same-grade sport
// so Lake still RUNS (the user's "push to use it, don't just drop").
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [sportEnt()] }; // A2 sport on a general slot
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()]);
    ok('T2b recruited by swapping a sport', st.recruited === 1 && st.swapped === 1 && st.droppedBunks === 0);
    ok('T2b A2 moved onto Lake', sa.A2[0]._activity === 'Lake' && sa.A2[0]._minBunkSwapped === true);
    ok('T2b A1 kept its Lake', sa.A1[0]._activity === 'Lake');
}

// =============================================================================
// TEST 2c — SWAP never disturbs a swim/lunch/pinned slot
// =============================================================================
{
    const swim = { field: 'Pool', sport: 'Swimming', _activity: 'Swimming', _startMin: 600, _endMin: 640, continuation: false };
    const pinned = { field: 'Court 1', sport: 'Kickball', _activity: 'Kickball', _pinned: true, _startMin: 600, _endMin: 640, continuation: false };
    const sa = { A1: [lakeEnt()], A2: [swim], A3: [pinned] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKE()]);
    ok('T2c swim + pinned both protected → Lake dropped', st.recruited === 0 && st.droppedBunks === 1);
    ok('T2c swim untouched', sa.A2[0]._activity === 'Swimming');
    ok('T2c pinned untouched', sa.A3[0]._activity === 'Kickball' && sa.A3[0]._pinned === true);
}

// =============================================================================
// TEST 3 — NO-OP: floor already met (2 bunks already on Lake together)
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [lakeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()]);
    ok('T3 no recruit, no drop', st.recruited === 0 && st.droppedBunks === 0 && st.fixed === 0);
    ok('T3 both still Lake', sa.A1[0]._activity === 'Lake' && sa.A2[0]._activity === 'Lake');
}

// =============================================================================
// TEST 4 — INERT: special with no minBunks (0) → pass does nothing at all
// =============================================================================
{
    const sa = { A1: [lakeEnt()] }; // lonely, but minBunks unset
    const st = enforceMinBunks(sa, { A1: 'A' }, [LAKE({ minBunks: 0 })]);
    ok('T4 pass is inert', st.inert === true);
    ok('T4 lonely Lake left as-is', sa.A1[0]._activity === 'Lake');
}

// =============================================================================
// TEST 5 — CROSS-DIVISION: recruit honors allowedPairs
//   A|B allowed, A|C not. A1 lonely Lake; B1 (paired) joins, C1 (unpaired) does not.
// =============================================================================
{
    const spec = LAKE({ type: 'cross_division', allowedPairs: { 'A|B': true } });
    const sa = { A1: [lakeEnt()], B1: [freeEnt()], C1: [freeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', B1: 'B', C1: 'C' }, [spec]);
    ok('T5 recruited the allowed pair only', st.recruited === 1 && st.fixed === 1);
    ok('T5 B1 joined Lake', sa.B1[0]._activity === 'Lake');
    ok('T5 C1 stayed Free (unpaired grade)', sa.C1[0]._activity === 'Free');
}

// =============================================================================
// TEST 6 — CAPACITY ceiling respected while filling the floor
//   minBunks 3, capacity 3: 1 placed + 3 free → recruit exactly 2 (total 3), not 3.
// =============================================================================
{
    const spec = LAKE({ minBunks: 3, capacity: 3 });
    const sa = { A1: [lakeEnt()], A2: [freeEnt()], A3: [freeEnt()], A4: [freeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A', A3: 'A', A4: 'A' }, [spec]);
    const onLake = ['A1', 'A2', 'A3', 'A4'].filter(b => sa[b][0]._activity === 'Lake').length;
    ok('T6 recruited up to capacity floor (2)', st.recruited === 2 && onLake === 3);
}

// =============================================================================
// TEST 7 — SPORT tile is NOT eligible to absorb the special
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [freeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()], { 'A2|0': 'sport' });
    ok('T7 sport-tile Free bunk NOT recruited → dropped', st.recruited === 0 && st.droppedBunks === 1);
}

// =============================================================================
// TEST 8 — ACCESS gate: a bunk without access to the special is not recruited
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [freeEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()], {}, (name, g, b) => b !== 'A2');
    ok('T8 no-access bunk not recruited → dropped', st.recruited === 0 && st.droppedBunks === 1);
}

// =============================================================================
// TEST 9 — user-locked lonely member is NOT dropped (lock wins)
// =============================================================================
{
    const locked = Object.assign(lakeEnt(), { _pinned: true });
    const sa = { A1: [locked], A2: [sportEnt()] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()], { 'A2|0': 'sport' });
    ok('T9 locked Lake survives (no recruit, no drop)', st.recruited === 0 && st.droppedBunks === 0 && sa.A1[0]._activity === 'Lake');
}

// =============================================================================
// TEST 10 — proactive co-attendance nudge (total_solver_engine calculatePenaltyCost)
//   Ports the nudge predicate: a JOIN bonus applies only for a min-bunks special
//   when a co-attendee is already there (coUsage>0) and there is room to grow
//   (coUsage<capacity). It never seeds a lonely session and never exceeds cap.
// =============================================================================
{
    const BONUS = 60000;
    const nudge = (minBunks, capacity, coUsage) => {
        const floor = (minBunks >= 2) ? minBunks : 0;
        if (floor < 2) return 0;
        return (coUsage > 0 && coUsage < capacity) ? -BONUS : 0;
    };
    ok('T10 no bonus to seed a lonely session (coUsage 0)', nudge(2, 4, 0) === 0);
    ok('T10 bonus to JOIN an under-cap session (coUsage 1)', nudge(2, 4, 1) === -BONUS);
    ok('T10 no bonus once at capacity (coUsage = cap)', nudge(2, 4, 4) === 0);
    ok('T10 inert for a non-min special (minBunks 0)', nudge(0, 4, 1) === 0);
}

// =============================================================================
// TEST 11 — UPSTREAM planner co-attendance pre-pass (activityFirstPlanner)
//   Ports the new minBunks pre-pass: process windows in order, allocate a
//   min-bunks special as ONE co-attended group within a SINGLE window (up to
//   capacity, only if the floor is reachable), mark its bunks planned-today so
//   later windows don't re-seed them, and let the per-bunk allocator skip
//   min-bunks specials entirely. This is the fix for the live failure where the
//   2 sixth-grade bunks (Shimon, Levi) each got a lonely Lake in DIFFERENT
//   windows → both dropped → 0 Lake. After the fix they co-attend ONE window.
// -----------------------------------------------------------------------------
//   windows : ordered [{ id, wishLists: { bunk: [{activity, need}] } }]
//   props   : { activity: { minBunks, capacity } }
//   returns : { planned: { 'window|bunk': activity }, sports: [bunk...] }
function planMinBunks(windows, props) {
    const plannedToday = new Set();        // bunk|activity already seated in a window
    const planned = {};                    // 'winId|bunk' -> activity (the co-attended floor special)
    const fellThrough = new Set();         // bunk that reached the per-bunk allocator on a minBunks wish
    windows.forEach(win => {
        const allocated = {};
        // ---- co-attendance pre-pass ----
        const wanted = {};
        Object.keys(win.wishLists).forEach(bunk => {
            (win.wishLists[bunk] || []).forEach(w => {
                const fp = props[w.activity];
                const floor = fp ? (parseInt(fp.minBunks, 10) || 0) : 0;
                if (floor < 2) return;
                if (plannedToday.has(bunk + '|' + w.activity)) return;
                (wanted[w.activity] = wanted[w.activity] || []).push({ bunk, need: w.need });
            });
        });
        Object.keys(wanted).forEach(act => {
            const fp = props[act];
            const floor = parseInt(fp.minBunks, 10) || 0;
            const cap = parseInt(fp.capacity, 10) || 2;
            const pool = wanted[act].filter(c => !allocated[c.bunk]).sort((a, b) => a.need - b.need);
            const take = Math.min(pool.length, cap);
            if (take < floor) return;                       // can't reach floor → don't seed
            for (let i = 0; i < take; i++) {
                allocated[pool[i].bunk] = act;
                plannedToday.add(pool[i].bunk + '|' + act);
                planned[win.id + '|' + pool[i].bunk] = act;
            }
        });
        // ---- per-bunk allocator: skips minBunks wishes, takes first non-floor wish ----
        Object.keys(win.wishLists).forEach(bunk => {
            if (allocated[bunk]) return;
            const ws = win.wishLists[bunk] || [];
            for (const w of ws) {
                const fp = props[w.activity];
                if (fp && (parseInt(fp.minBunks, 10) || 0) >= 2) { fellThrough.add(bunk); continue; }
                allocated[bunk] = w.activity; break;
            }
        });
    });
    return { planned, fellThrough };
}

{
    const props = { Lake: { minBunks: 2, capacity: 2 }, Soccer: {}, Volleyball: {} };
    // The live failure: both 6th-grade bunks want Lake, each strongest in a
    // different window. Pre-fix the planner split them; post-fix they co-attend W1.
    const windows = [
        { id: 'W1', wishLists: {
            Shimon: [{ activity: 'Lake', need: 0 }, { activity: 'Soccer', need: 5 }],
            Levi:   [{ activity: 'Soccer', need: 1 }, { activity: 'Lake', need: 2 }],
        } },
        { id: 'W2', wishLists: {
            Shimon: [{ activity: 'Volleyball', need: 1 }, { activity: 'Lake', need: 3 }],
            Levi:   [{ activity: 'Lake', need: 0 }, { activity: 'Volleyball', need: 4 }],
        } },
    ];
    const r = planMinBunks(windows, props);
    ok('T11 Lake co-attended by BOTH bunks in ONE window (W1)',
        r.planned['W1|Shimon'] === 'Lake' && r.planned['W1|Levi'] === 'Lake');
    ok('T11 Lake NOT re-seeded in W2 (no same-day repeat)',
        r.planned['W2|Shimon'] === undefined && r.planned['W2|Levi'] === undefined);
    ok('T11 floor satisfied with exactly capacity (2) — never lonely',
        Object.values(r.planned).filter(a => a === 'Lake').length === 2);
}

// TEST 12 — floor unreachable (only one eligible bunk) → never seeded, takes a sport
{
    const props = { Lake: { minBunks: 2, capacity: 2 }, Soccer: {} };
    const windows = [
        { id: 'W1', wishLists: {
            Shimon: [{ activity: 'Lake', need: 0 }, { activity: 'Soccer', need: 9 }],
            // Levi cannot do Lake (not in wishlist — e.g. no access / already done)
            Levi:   [{ activity: 'Soccer', need: 1 }],
        } },
    ];
    const r = planMinBunks(windows, props);
    ok('T12 lonely-only Lake never seeded', Object.values(r.planned).length === 0);
    ok('T12 the would-be lonely bunk fell through to a sport', r.fellThrough.has('Shimon'));
}

// TEST 13 — capacity caps the co-attended group (3 want it, cap 2 → exactly 2)
{
    const props = { Lake: { minBunks: 2, capacity: 2 } };
    const windows = [
        { id: 'W1', wishLists: {
            A: [{ activity: 'Lake', need: 0 }],
            B: [{ activity: 'Lake', need: 1 }],
            C: [{ activity: 'Lake', need: 2 }],
        } },
    ];
    const r = planMinBunks(windows, props);
    const seated = Object.values(r.planned).filter(a => a === 'Lake').length;
    ok('T13 capacity caps the session at 2 (not 3)', seated === 2);
    ok('T13 the strongest-pull pair (A,B) is seated', r.planned['W1|A'] === 'Lake' && r.planned['W1|B'] === 'Lake');
}

// =============================================================================
// TEST 14 — recruiter is RECENCY-AWARE (the Yissocher back-to-back fix)
//   A lonely Lake (Yosef) needs a 7th-grade partner. Two are available on a
//   swappable sport: Yissocher (did Lake yesterday → daysSince 1) and Dan
//   (never → null). The recruiter must prefer Dan, never forcing a back-to-back
//   when a fresh grade-mate exists.
// =============================================================================
{
    const sa = {
        Yosef:     [lakeEnt()],     // lonely Lake @ window
        Yissocher: [sportEnt()],    // swappable; did Lake yesterday
        Dan:       [sportEnt()],    // swappable; never did Lake
    };
    const b2g = { Yosef: '7', Yissocher: '7', Dan: '7' };
    const kind = { 'Yissocher|0': 'any', 'Dan|0': 'any' }; // both swappable (not sport-only)
    const days = (name, bunk) => (bunk === 'Yissocher' ? 1 : null); // Yissocher=yesterday, Dan=never
    const st = enforceMinBunks(sa, b2g, [LAKE()], kind, undefined, days);
    ok('T14 floor reached by recruiting one partner', st.recruited === 1 && st.droppedBunks === 0);
    ok('T14 FRESH bunk (Dan) recruited, not the back-to-back one', sa.Dan[0]._activity === 'Lake');
    ok('T14 the back-to-back bunk (Yissocher) left on its sport', sa.Yissocher[0]._activity !== 'Lake');
}

// TEST 15 — recency only breaks ties WITHIN a tier: a Free bunk still beats a
//   fresher swap candidate (Free = tier 0 wins even if it did it more recently)
{
    const sa = {
        Yosef:  [lakeEnt()],
        Asher:  [freeEnt()],     // tier 0 (Free) but did Lake recently
        Dan:    [sportEnt()],    // tier 1 (swap) but never did Lake
    };
    const b2g = { Yosef: '7', Asher: '7', Dan: '7' };
    const kind = { 'Dan|0': 'any' };
    const days = (name, bunk) => (bunk === 'Asher' ? 1 : null);
    const st = enforceMinBunks(sa, b2g, [LAKE()], kind, undefined, days);
    ok('T15 Free bunk (tier 0) still wins over a fresher swap', sa.Asher[0]._activity === 'Lake' && st.swapped === 0);
}

// =============================================================================
// STEP 7.64 force-placement — ported seeding logic
//   Guarantees a forcePlacement special runs once per generation (>= floor),
//   seating the most-due eligible bunks (Free first, else swap a sport).
// =============================================================================
function forceSeed(sa, b2g, specials, kindByCell, isAvail, daysOf) {
    kindByCell = kindByCell || {}; isAvail = isAvail || (() => true); daysOf = daysOf || (() => 9999);
    const done = {};
    Object.keys(sa).forEach(b => { done[b] = {}; (sa[b] || []).forEach(e => { if (!e || e.continuation) return; const a = e._activity || e.sport; if (a && String(a).toLowerCase() !== 'free') done[b][String(a).toLowerCase()] = 1; }); });
    const forced = {};
    specials.forEach(s => {
        if (!s || !s.name || s.forcePlacement !== true || s.available === false) return;
        const sw = s.sharableWith || {};
        const cap = (sw.type === 'not_sharable') ? 1 : (parseInt(sw.capacity, 10) || 2);
        let floor = parseInt(sw.minBunks, 10) || 0; if (floor < 2) floor = 1; floor = Math.min(floor, cap);
        forced[String(s.name).toLowerCase().trim()] = { name: s.name, floor, cap, type: sw.type || 'not_sharable', pairs: sw.allowedPairs || {}, loc: s.location || null };
    });
    const isFree = (e) => { const a = String((e && (e._activity || e.field || e.sport)) || '').toLowerCase().trim(); return a === '' || a === 'free' || a === 'free play' || a === 'free (timeout)'; };
    const winOf = (e) => (e && e._startMin != null) ? { s: e._startMin, e: e._endMin } : null;
    const stats = { seeded: 0, failed: 0 };
    Object.keys(forced).forEach(actLC => {
        const F = forced[actLC];
        const byWin = {};
        Object.keys(sa).forEach(b => (sa[b] || []).forEach((e, idx) => {
            if (!e || e.continuation) return;
            if (String(e._activity || e._assignedSpecial || '').toLowerCase().trim() !== actLC) return;
            const t = winOf(e); if (!t) return; byWin[t.s + '|' + t.e] = (byWin[t.s + '|' + t.e] || 0) + 1;
        }));
        if (Object.keys(byWin).some(k => byWin[k] >= F.floor)) return;
        const grpW = {};
        Object.keys(sa).forEach(b => {
            const g = b2g[b] || '?';
            if (F.floor > 1 && F.type === 'cross_division' && F.pairs[[g, g].sort().join('|')] !== true) return;
            if (done[b] && done[b][actLC]) return;
            if (!isAvail(F.name, g, b)) return;
            const arr = sa[b] || [];
            for (let idx = 0; idx < arr.length; idx++) {
                const e = arr[idx];
                if (!e || e.continuation || e._isTransition || e._league || e._h2h || e._postEdit || e._pinned || e._bunkOverride) continue;
                const t = winOf(e); if (!t || t.s == null) continue;
                const ck = kindByCell[b + '|' + idx]; const kind = (ck && ck !== 'any') ? ck : 'any';
                if (kind === 'sport') continue;
                let free = false, ok = false;
                if (isFree(e)) { free = true; ok = true; }
                else if (e.sport && !e._assignedSpecial) { ok = true; }
                if (!ok) continue;
                const kk = t.s + '|' + t.e + '|' + g;
                (grpW[kk] = grpW[kk] || []).push({ bunk: b, idx, s: t.s, e: t.e, free, days: daysOf(b, F.name) });
                break;
            }
        });
        let bestKey = null, bestScore = -1;
        Object.keys(grpW).forEach(kk => {
            const list = grpW[kk]; if (list.length < F.floor) return;
            const top = list.slice().sort((a, b) => b.days - a.days).slice(0, F.floor);
            const score = top.reduce((acc, x) => acc + x.days, 0) + list.length * 0.001;
            if (score > bestScore) { bestScore = score; bestKey = kk; }
        });
        if (!bestKey) { stats.failed++; return; }
        const take = grpW[bestKey].slice().sort((a, b) => (b.days - a.days) || (b.free - a.free)).slice(0, F.floor);
        const fld = F.loc || F.name;
        take.forEach(c => { sa[c.bunk][c.idx] = { field: fld, sport: null, _activity: F.name, _assignedSpecial: F.name, _startMin: c.s, _endMin: c.e, _forcedPlaced: true, continuation: false }; (done[c.bunk] = done[c.bunk] || {})[actLC] = 1; });
        stats.seeded++;
    });
    return stats;
}

const LAKEF = (extra) => ({ name: 'Lake', forcePlacement: true, sharableWith: Object.assign({ type: 'cross_division', capacity: 4, minBunks: 2, allowedPairs: { 'A|A': true, 'B|B': true } }, extra || {}) });

// TEST 16 — FORCE seeds a session when Lake isn't running at all (packed schedule)
{
    const sa = { A1: [sportEnt()], A2: [sportEnt()], A3: [sportEnt(700, 740)] };
    const st = forceSeed(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKEF()]);
    ok('T16 seeded one forced session', st.seeded === 1 && st.failed === 0);
    const onLake = ['A1', 'A2', 'A3'].filter(b => sa[b][0]._activity === 'Lake').length;
    ok('T16 exactly floor (2) bunks seeded onto Lake', onLake === 2);
    ok('T16 seeded entries flagged _forcedPlaced', ['A1', 'A2', 'A3'].some(b => sa[b][0]._forcedPlaced === true));
}

// TEST 17 — FORCE picks the MOST-DUE bunks
{
    const sa = { A1: [sportEnt()], A2: [sportEnt()], A3: [sportEnt()] };
    // A1 did Lake 1 day ago, A2 5 days ago, A3 never → most due = A3, A2
    const days = (b) => ({ A1: 1, A2: 5, A3: 9999 }[b]);
    const st = forceSeed(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKEF()], {}, (n, g, b) => true, (b) => days(b));
    ok('T17 seeded', st.seeded === 1);
    ok('T17 chose the two most-due (A3 + A2), not A1', sa.A3[0]._activity === 'Lake' && sa.A2[0]._activity === 'Lake' && sa.A1[0]._activity === 'Kickball');
}

// TEST 18 — FORCE is a no-op when Lake already runs with >= floor
{
    const sa = { A1: [lakeEnt()], A2: [lakeEnt()], A3: [sportEnt()] };
    const st = forceSeed(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKEF()]);
    ok('T18 nothing seeded (already running)', st.seeded === 0 && st.failed === 0);
}

// TEST 19 — FORCE fails gracefully when the floor cannot be met (only 1 eligible)
{
    // A1 free/swappable, A2 on a sport-only tile (can't host Lake) → only 1 eligible < floor 2
    const sa = { A1: [sportEnt()], A2: [sportEnt()] };
    const st = forceSeed(sa, { A1: 'A', A2: 'A' }, [LAKEF()], { 'A2|0': 'sport' });
    ok('T19 could not seed (floor unreachable) → no partial session', st.seeded === 0 && st.failed === 1);
    ok('T19 left schedule untouched', sa.A1[0]._activity === 'Kickball' && sa.A2[0]._activity === 'Kickball');
}

// TEST 20 — INERT when forcePlacement is off
{
    const sa = { A1: [sportEnt()], A2: [sportEnt()] };
    const st = forceSeed(sa, { A1: 'A', A2: 'A' }, [LAKEF({}) ].map(s => ({ ...s, forcePlacement: false })));
    ok('T20 nothing seeded when force is off', st.seeded === 0 && st.failed === 0 && sa.A1[0]._activity === 'Kickball');
}

console.log('\n[special_min_bunks_sim] ' + pass + '/' + pass + ' assertions passed ✅');
