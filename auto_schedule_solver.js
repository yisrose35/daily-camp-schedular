// =================================================================
// auto_schedule_solver.js — "Generate My Day" Engine
// v1.0
// =================================================================
// Takes the user's description of their day:
//   "1 sport, 3 specials, lunch, swim, bubble lady at 2pm"
// And produces a complete skeleton that the EXISTING optimizer
// (runSkeletonOptimizer) can consume directly.
//
// This is the bridge between "what I need" and the existing system.
// The solver generates skeleton blocks, then the optimizer fills
// them with actual bunk-level assignments.
//
// LOAD ORDER: Before auto_schedule_planner.js
// =================================================================
(function() {
'use strict';

// ── Time Helpers ──
function parseTime(str) {
    if (str == null) return null;
    if (typeof str === 'number') return str;
    let s = String(str).toLowerCase().trim();
    if (!s) return null;
    const isPM = s.includes('pm'), isAM = s.includes('am');
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
function uid() { return 'evt_' + Math.random().toString(36).substr(2, 8); }

// =================================================================
// LOOKUP: Get activity duration from settings
// =================================================================
function getActivityDuration(name) {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};

    // Check specials
    const spec = (app1.specialActivities || []).find(s => s.name === name);
    if (spec?.defaultDuration) return spec.defaultDuration;

    // Check sport metadata
    const meta = (app1.sportMetaData || {})[name];
    if (meta?.defaultDuration) return meta.defaultDuration;

    return null;
}

// =================================================================
// LOOKUP: Get recurring activities for a day
// =================================================================
function getRecurringForDay(dayOfWeek) {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    const dayAbbrev = (dayOfWeek || '').substring(0, 3).toLowerCase();
    const items = [];

    // Recurring specials
    (app1.specialActivities || []).forEach(spec => {
        if (!spec.available || !spec.recurring?.enabled) return;
        const days = spec.recurring.days || [];
        if (!days.some(d => d.toLowerCase().startsWith(dayAbbrev))) return;
        items.push({
            name: spec.name,
            kind: 'specific',
            duration: spec.defaultDuration || spec.recurring.duration || 40,
            windowStart: spec.recurring.windowStart || null,
            windowEnd: spec.recurring.windowEnd || null,
            fixed: !!spec.recurring.fixed,
            source: 'recurring',
        });
    });

    // Recurring sports (via sportMetaData)
    const meta = app1.sportMetaData || {};
    Object.keys(meta).forEach(sport => {
        const m = meta[sport];
        if (!m.recurring?.enabled) return;
        const days = m.recurring.days || [];
        if (!days.some(d => d.toLowerCase().startsWith(dayAbbrev))) return;
        items.push({
            name: sport,
            kind: 'specific',
            duration: m.defaultDuration || m.recurring.duration || 40,
            windowStart: m.recurring.windowStart || null,
            windowEnd: m.recurring.windowEnd || null,
            fixed: !!m.recurring.fixed,
            source: 'recurring',
        });
    });

    return items;
}

// =================================================================
// MAIN: Generate skeleton from requirements
// =================================================================
/**
 * Takes the user's day requirements and generates a skeleton for
 * ALL divisions that the existing optimizer can consume.
 *
 * @param {Array} requirements - User's items:
 *   { name, kind, duration?, count?, windowStart?, windowEnd?, fixed? }
 *   kind: 'sport_slot' | 'special_slot' | 'activity_slot' | 'specific' | 'fixed_event'
 *
 * @param {Object} opts
 *   .defaultSlotDuration  - fallback duration for generic slots (default 50)
 *   .divisions            - division data (or auto-read from window.divisions)
 *
 * @returns {Object} { skeleton[], warnings[] }
 */
function generateSkeleton(requirements, opts) {
    opts = opts || {};
    const divisions = opts.divisions || window.divisions || 
                      window.loadGlobalSettings?.()?.app1?.divisions || {};
    const divNames = Object.keys(divisions);
    const defaultDur = opts.defaultSlotDuration || 50;
    const warnings = [];

    if (divNames.length === 0) {
        return { skeleton: [], warnings: ['No divisions configured'] };
    }

    const skeleton = [];

    // Process each division
    divNames.forEach(divName => {
        const divData = divisions[divName] || {};
        const dayStart = parseTime(divData.startTime || '9:00am');
        const dayEnd = parseTime(divData.endTime || '4:30pm');

        const result = buildDivisionSkeleton(requirements, divName, dayStart, dayEnd, defaultDur);
        skeleton.push(...result.blocks);
        if (result.warnings.length) {
            warnings.push(...result.warnings.map(w => `${divName}: ${w}`));
        }
    });

    return { skeleton, warnings };
}

// =================================================================
// Build skeleton for ONE division
// =================================================================
function buildDivisionSkeleton(requirements, divName, dayStart, dayEnd, defaultDur) {
    const warnings = [];
    const placed = []; // { s, e, block }

    // ── Expand requirements ──
    // Each requirement can have count > 1 (e.g., "3 specials")
    const items = [];
    requirements.forEach(req => {
        const count = req.count || 1;
        for (let i = 0; i < count; i++) {
            items.push({ ...req });
        }
    });

    // ── Classify ──
    const fixed = [];    // exact time (bubble lady 2-3pm)
    const windowed = []; // flexible within range (lunch between 11:30-1:30)
    const flexible = []; // anytime (sport slot, special slot)

    items.forEach(item => {
        const ws = parseTime(item.windowStart);
        const we = parseTime(item.windowEnd);
        if (item.fixed && ws != null && we != null) {
            fixed.push({ ...item, _ws: ws, _we: we });
        } else if (ws != null && we != null) {
            windowed.push({ ...item, _ws: ws, _we: we });
        } else {
            flexible.push(item);
        }
    });

    // ── Helper: find gap ──
    function findGap(earliest, latest, dur) {
        const occ = placed.filter(p => p.s < latest && p.e > earliest).sort((a, b) => a.s - b.s);
        let cursor = snap(Math.max(earliest, dayStart));
        for (const o of occ) {
            if (cursor + dur <= o.s) return cursor;
            cursor = Math.max(cursor, snap(o.e));
        }
        if (cursor + dur <= Math.min(latest, dayEnd)) return cursor;
        return null;
    }

    // ── Phase 1: Fixed items ──
    fixed.sort((a, b) => a._ws - b._ws);
    fixed.forEach(item => {
        const s = snap(item._ws);
        const e = snap(item._we);
        placed.push({ s, e, item });
    });

    // ── Phase 2: Windowed items (tightest first) ──
    windowed.sort((a, b) => (a._we - a._ws) - (b._we - b._ws));
    windowed.forEach(item => {
        const dur = item.duration || defaultDur;
        const earliest = Math.max(item._ws, dayStart);
        const latest = Math.min(item._we, dayEnd);
        const start = findGap(earliest, latest, dur);
        if (start != null) {
            placed.push({ s: start, e: start + dur, item });
        } else {
            // Fallback: place anywhere
            const fb = findGap(dayStart, dayEnd, dur);
            if (fb != null) {
                placed.push({ s: fb, e: fb + dur, item });
                warnings.push(`"${item.name}" placed outside preferred window`);
            } else {
                warnings.push(`"${item.name}" — no room`);
            }
        }
    });

    // ── Phase 3: Flexible items ──
    flexible.forEach(item => {
        const dur = item.duration || defaultDur;
        const start = findGap(dayStart, dayEnd, dur);
        if (start != null) {
            placed.push({ s: start, e: start + dur, item });
        } else {
            warnings.push(`"${item.name}" — no room left`);
        }
    });

    // ── Compact (close gaps) ──
    placed.sort((a, b) => a.s - b.s);
    let cursor = dayStart;
    placed.forEach(p => {
        if (p.item.fixed) { cursor = Math.max(cursor, p.e); return; }
        if (p.item._ws != null) cursor = Math.max(cursor, p.item._ws);
        if (cursor < p.s) {
            const dur = p.e - p.s;
            // Don't overlap fixed items
            let target = cursor;
            for (const other of placed) {
                if (other.item.fixed && target < other.e && target + dur > other.s) {
                    target = other.e;
                }
            }
            p.s = target;
            p.e = target + dur;
        }
        cursor = p.e;
    });

    placed.sort((a, b) => a.s - b.s);

    // ── Convert to skeleton format ──
    const blocks = placed.map(p => ({
        id: uid(),
        type: toSkeletonType(p.item),
        event: toSkeletonEvent(p.item),
        division: divName,
        startTime: fmtTime(p.s),
        endTime: fmtTime(p.e),
    }));

    return { blocks, warnings };
}

// =================================================================
// Skeleton Type/Event Mapping
// =================================================================
function toSkeletonType(item) {
    switch (item.kind) {
        case 'specific':    return 'pinned';
        case 'fixed_event': return 'pinned';
        case 'sport_slot':  return 'slot';
        case 'special_slot': return 'slot';
        case 'activity_slot': return 'slot';
        default: return 'slot';
    }
}

function toSkeletonEvent(item) {
    switch (item.kind) {
        case 'specific':    return item.name;
        case 'fixed_event': return item.name;
        case 'sport_slot':  return 'Sports Slot';
        case 'special_slot': return 'Special Activity';
        case 'activity_slot': return 'General Activity Slot';
        default: return item.name || 'General Activity Slot';
    }
}

// =================================================================
// FULL AUTO: Generate skeleton + run optimizer in one shot
// =================================================================
function generateAndRun(requirements, opts) {
    const { skeleton, warnings } = generateSkeleton(requirements, opts);

    if (skeleton.length === 0) {
        return { success: false, warnings };
    }

    // Save skeleton
    window.saveCurrentDailyData?.('manualSkeleton', skeleton);

    // Set in master builder if available
    if (window.MasterSchedulerInternal?.setSkeleton) {
        window.MasterSchedulerInternal.setSkeleton(skeleton);
        window.MasterSchedulerInternal.markUnsavedChanges?.();
        window.MasterSchedulerInternal.saveDraftToLocalStorage?.();
        window.MasterSchedulerInternal.renderGrid?.();
    }

    // Run optimizer
    if (typeof window.runSkeletonOptimizer === 'function') {
        window.runSkeletonOptimizer(skeleton);
        return { success: true, skeleton, warnings, optimizerRan: true };
    } else {
        warnings.push('Optimizer not available — skeleton generated but not filled');
        return { success: true, skeleton, warnings, optimizerRan: false };
    }
}

// =================================================================
// PUBLIC API
// =================================================================
window.AutoScheduleSolver = {
    generateSkeleton,
    generateAndRun,
    getRecurringForDay,
    getActivityDuration,
    parseTime,
    fmtTime,
};

})();
