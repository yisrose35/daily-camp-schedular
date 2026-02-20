// =================================================================
// auto_build_engine.js — Constraint-Based Schedule Planner v2.0
// =================================================================
// Takes a flat list of "what needs to happen today" and arranges
// it into a valid day timeline.
//
// Each item is simple:
//   { name, type, minDuration, maxDuration, windowStart?, windowEnd?, fixed? }
//
// Example input:
//   - Activity, 20-40min, anytime
//   - Lunch, 20min, between 1pm-2pm
//   - Art Show, 60min, 2:00-3:00 FIXED
//   - Special, 30min, anytime
//
// Engine places fixed items first, then windowed, then flexible.
//
// LOAD ORDER: Before auto_build_ui.js
// =================================================================
(function() {
'use strict';

function parseTime(str) {
    if (str === null || str === undefined) return null;
    if (typeof str === 'number') return str;
    let s = String(str).toLowerCase().trim();
    if (!s) return null;
    const isPM = s.includes('pm');
    const isAM = s.includes('am');
    s = s.replace(/am|pm/g, '').trim();
    const parts = s.split(':');
    let h = parseInt(parts[0], 10);
    if (isNaN(h)) return null;
    const m = parseInt(parts[1], 10) || 0;
    if (isPM && h !== 12) h += 12;
    if (isAM && h === 12) h = 0;
    return h * 60 + m;
}

function fmtTime(min) {
    if (min == null) return '';
    let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ap;
}

const SNAP = 5;
function snap(v) { return Math.round(v / SNAP) * SNAP; }

// =================================================================
// SOLVER
// =================================================================
function solve(items, dayStart, dayEnd) {
    const warnings = [];
    const placed = [];

    const parsed = items.map(item => {
        const ws = parseTime(item.windowStart);
        const we = parseTime(item.windowEnd);
        const minD = item.minDuration || 20;
        const maxD = item.maxDuration || item.minDuration || 50;
        let cls = 'flexible';
        if (item.fixed && ws != null && we != null) cls = 'fixed';
        else if (ws != null && we != null) cls = 'windowed';
        return { ...item, _ws: ws, _we: we, _minD: minD, _maxD: maxD, _cls: cls };
    });

    const fixed    = parsed.filter(p => p._cls === 'fixed');
    const windowed = parsed.filter(p => p._cls === 'windowed');
    const flexible = parsed.filter(p => p._cls === 'flexible');

    function overlaps(s, e) {
        return placed.some(p => s < p.e && e > p.s);
    }

    function findGap(earliest, latest, dur) {
        const occ = placed
            .filter(p => p.s < latest && p.e > earliest)
            .sort((a, b) => a.s - b.s);
        let cursor = snap(Math.max(earliest, dayStart));
        for (const o of occ) {
            if (cursor + dur <= o.s) return cursor;
            cursor = Math.max(cursor, snap(o.e));
        }
        if (cursor + dur <= Math.min(latest, dayEnd)) return cursor;
        return null;
    }

    // Phase 1: Fixed items
    fixed.sort((a, b) => a._ws - b._ws);
    for (const item of fixed) {
        const s = snap(item._ws);
        const e = snap(item._we);
        if (overlaps(s, e)) {
            warnings.push(`"${item.name}" overlaps another fixed item`);
        }
        placed.push({ s, e, item });
    }

    // Phase 2: Windowed items (tightest window first)
    windowed.sort((a, b) => (a._we - a._ws) - (b._we - b._ws));
    for (const item of windowed) {
        const earliest = Math.max(item._ws, dayStart);
        const latest = Math.min(item._we, dayEnd);
        let done = false;
        for (let dur = item._maxD; dur >= item._minD; dur -= SNAP) {
            const start = findGap(earliest, latest, dur);
            if (start != null) {
                placed.push({ s: start, e: start + dur, item });
                done = true;
                break;
            }
        }
        if (!done) {
            const fb = findGap(dayStart, dayEnd, item._minD);
            if (fb != null) {
                placed.push({ s: fb, e: fb + item._minD, item });
                warnings.push(`"${item.name}" placed outside its preferred window`);
            } else {
                warnings.push(`"${item.name}" — no room in day`);
            }
        }
    }

    // Phase 3: Flexible items
    for (const item of flexible) {
        let done = false;
        for (let dur = item._maxD; dur >= item._minD; dur -= SNAP) {
            const start = findGap(dayStart, dayEnd, dur);
            if (start != null) {
                placed.push({ s: start, e: start + dur, item });
                done = true;
                break;
            }
        }
        if (!done) warnings.push(`"${item.name}" — no room left`);
    }

    // Phase 4: Sort and compact
    placed.sort((a, b) => a.s - b.s);
    compact(placed, dayStart, dayEnd);

    // Phase 5: Output
    return {
        placements: placed.map(p => ({
            startMin: p.s,
            endMin: p.e,
            startTime: fmtTime(p.s),
            endTime: fmtTime(p.e),
            duration: p.e - p.s,
            name: p.item.name,
            type: p.item.type,
            skeletonType: toSkeletonType(p.item.type),
            skeletonEvent: toSkeletonEvent(p.item.type, p.item.name),
            fixed: !!p.item.fixed
        })),
        warnings,
        totalUsed: placed.reduce((sum, p) => sum + (p.e - p.s), 0),
        totalAvailable: dayEnd - dayStart
    };
}

function compact(placed, dayStart, dayEnd) {
    let cursor = dayStart;
    for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (p.item._cls === 'fixed') {
            cursor = Math.max(cursor, p.e);
            continue;
        }
        if (p.item._cls === 'windowed' && p.item._ws != null) {
            cursor = Math.max(cursor, p.item._ws);
        }
        if (cursor < p.s) {
            // Check we won't collide with a fixed item
            const dur = p.e - p.s;
            let target = cursor;
            for (const other of placed) {
                if (other === p) continue;
                if (other.item._cls === 'fixed' && target < other.e && target + dur > other.s) {
                    target = other.e;
                    if (p.item._cls === 'windowed' && p.item._ws != null) {
                        target = Math.max(target, p.item._ws);
                    }
                }
            }
            p.s = target;
            p.e = target + dur;
        }
        cursor = p.e;
    }
}

function toSkeletonType(type) {
    const m = {
        activity:'slot', sports:'slot', special:'slot',
        league:'league', specialty_league:'specialty_league',
        swim:'pinned', lunch:'pinned', snack:'pinned', snacks:'pinned',
        dismissal:'pinned', custom:'pinned',
        smart:'smart', split:'split', elective:'elective'
    };
    return m[(type || '').toLowerCase()] || 'slot';
}

function toSkeletonEvent(type, name) {
    const m = {
        activity:'General Activity Slot', sports:'Sports Slot',
        special:'Special Activity', league:'League Game',
        specialty_league:'Specialty League'
    };
    return m[(type || '').toLowerCase()] || name || type || 'Activity';
}

function validate(items, dayStart, dayEnd) {
    const errors = [];
    let totalMin = 0;
    items.forEach(i => { totalMin += i.minDuration || 20; });
    if (totalMin > dayEnd - dayStart) {
        errors.push(`Need ${totalMin}min but day is only ${dayEnd - dayStart}min`);
    }
    return errors;
}

window.AutoBuildEngine = { solve, validate, parseTime, fmtTime };
})();
