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
function enforceMinBunks(sa, b2g, specials, kindByCell, isAvail) {
    kindByCell = kindByCell || {};
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
    const stats = { recruited: 0, droppedBunks: 0, fixed: 0, dropSess: 0, inert: Object.keys(minSpecs).length === 0 };
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
        // (1) RECRUIT
        Object.keys(sa).forEach(b => {
            if (G.members.length >= spec.minBunks || G.members.length >= spec.cap) return;
            if (G.members.some(m => String(m.bunk) === String(b))) return;
            const g = b2g[b] || '?';
            if (!gradeOk(g)) return;
            if (done[b] && done[b][actLC]) return;
            const arr = sa[b] || [];
            for (let idx = 0; idx < arr.length; idx++) {
                const e = arr[idx];
                if (!e || e.continuation || e._isTransition || e._league || e._h2h || !isFree(e)) continue;
                const t = winOf(e); if (!t || t.s !== s || t.e !== en) continue;
                const ck = kindByCell[b + '|' + idx];
                const kind = (ck && ck !== 'any') ? ck : 'any';
                if (kind === 'sport') continue;
                if (!isAvail(spec.name, g, b)) continue;
                sa[b][idx] = { field: fld, sport: null, _activity: spec.name, _assignedSpecial: spec.name, _specialLocation: fld, _startMin: s, _endMin: en, _fixed: true, _freeFilled: true, _minBunkFilled: true, continuation: false };
                (done[b] = done[b] || {})[actLC] = 1;
                G.members.push({ bunk: b, idx, grade: g });
                stats.recruited++;
                break;
            }
        });
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
// (A2 is busy on a sport, A3 is at a different time window)
// =============================================================================
{
    const sa = { A1: [lakeEnt()], A2: [sportEnt()], A3: [freeEnt(700, 740)] };
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A', A3: 'A' }, [LAKE()]);
    ok('T2 nothing recruited', st.recruited === 0);
    ok('T2 one bunk dropped, one session', st.droppedBunks === 1 && st.dropSess === 1);
    ok('T2 A1 demoted to Free w/ reason', sa.A1[0]._activity === 'Free' && sa.A1[0]._demotedReason === 'special_min_bunks');
    ok('T2 A1 window preserved for refill', sa.A1[0]._startMin === 600 && sa.A1[0]._endMin === 640);
    ok('T2 A2 sport untouched', sa.A2[0]._activity === 'Kickball');
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
    const st = enforceMinBunks(sa, { A1: 'A', A2: 'A' }, [LAKE()]);
    ok('T9 locked Lake survives (no recruit, no drop)', st.recruited === 0 && st.droppedBunks === 0 && sa.A1[0]._activity === 'Lake');
}

console.log('\n[special_min_bunks_sim] ' + pass + '/' + pass + ' assertions passed ✅');
