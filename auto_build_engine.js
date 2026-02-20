// =================================================================
// auto_build_engine.js — Constraint-Based Schedule Planner Engine
// v1.0
// =================================================================
// PURE LOGIC — no DOM, no UI. Takes a config describing what a
// division's day should look like and produces an ordered skeleton.
//
// KEY CONCEPT: Instead of manually placing blocks at exact times,
// the user defines WHAT needs to happen + CONSTRAINTS, and this
// engine figures out WHEN and in what ORDER.
//
// Inputs:
//   - Activity blocks: "2× Sports, 1× Special, 1× Swim"
//   - Fixed events: "Lunch = 20min, between 11:30am-1:30pm"
//   - Availability windows: "Activity Master available 11:20-12:20"
//   - Time constraints: "Swim must be between 1:00-3:00" (hard/soft)
//   - Division time bounds: start and end of day
//
// Output:
//   - Ordered array of skeleton blocks with calculated start/end times
//
// LOAD ORDER: Before auto_build_ui.js
// =================================================================
(function() {
'use strict';

// =================================================================
// TIME HELPERS
// =================================================================
function parseTime(str) {
    if (!str) return null;
    if (typeof str === 'number') return str;
    let s = str.toLowerCase().trim();
    const isPM = s.includes('pm');
    const isAM = s.includes('am');
    s = s.replace(/am|pm/g, '').trim();
    const parts = s.split(':');
    let h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) || 0;
    if (isPM && h !== 12) h += 12;
    if (isAM && h === 12) h = 0;
    return h * 60 + m;
}

function fmtTime(min) {
    let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ap;
}

const SNAP = 5;
function snap(min) { return Math.round(min / SNAP) * SNAP; }

// =================================================================
// MAIN SOLVER
// =================================================================

/**
 * Solve a schedule for one division given a config.
 *
 * @param {Object} config - The auto-build configuration
 *   .blocks[]         - Activity block requirements
 *   .fixedEvents[]    - Fixed events with flexible bounds
 *   .availabilities[] - Activity availability windows
 *   .defaultDuration  - Default block duration in minutes
 *
 * @param {string} divName - Division name
 * @param {number} dayStartMin - Division day start (minutes)
 * @param {number} dayEndMin   - Division day end (minutes)
 * @param {string} [currentDay] - Day of week for availability filtering
 *
 * @returns {Object} { placements[], warnings[], error? }
 */
function solveSchedule(config, divName, dayStartMin, dayEndMin, currentDay) {
    const warnings = [];
    const dur = config.defaultDuration || 50;

    // ─────────────────────────────────────────────────
    // 1. EXPAND blocks into individual items
    // ─────────────────────────────────────────────────
    const activityItems = [];
    (config.blocks || []).forEach(block => {
        for (let i = 0; i < (block.count || 1); i++) {
            activityItems.push({
                role: 'activity',
                type: block.type,
                event: mapTypeToEvent(block.type),
                skeletonType: mapTypeToSkeletonType(block.type),
                duration: block.duration || dur,
                constraint: block.constraint ? {
                    startMin: parseTime(block.constraint.start),
                    endMin: parseTime(block.constraint.end),
                    hard: block.constraintType === 'hard'
                } : null,
                extra: block.extra || {}
            });
        }
    });

    // ─────────────────────────────────────────────────
    // 2. PARSE fixed events
    // ─────────────────────────────────────────────────
    const fixedItems = (config.fixedEvents || []).map(ev => ({
        role: ev.type === 'wall' ? 'wall' : 'fixed',
        event: ev.event,
        skeletonType: 'pinned',
        duration: ev.duration || 20,
        earliestMin: parseTime(ev.earliest),
        latestEndMin: parseTime(ev.latest),
        extra: {}
    }));

    // ─────────────────────────────────────────────────
    // 3. PARSE availability windows
    // ─────────────────────────────────────────────────
    const availMap = {};
    (config.availabilities || []).forEach(av => {
        // Optional day-of-week filter
        if (av.days && av.days.length > 0 && currentDay) {
            const dayAbbrev = currentDay.substring(0, 3);
            if (!av.days.some(d => d.toLowerCase().startsWith(dayAbbrev.toLowerCase()))) {
                return; // Not available today
            }
        }
        availMap[av.name.toLowerCase().trim()] = {
            name: av.name,
            startMin: parseTime(av.start),
            endMin: parseTime(av.end)
        };
    });

    // ─────────────────────────────────────────────────
    // 4. FIND the wall (dismissal)
    // ─────────────────────────────────────────────────
    let wallMin = dayEndMin;
    const wallItem = fixedItems.find(f => f.role === 'wall');
    if (wallItem) {
        wallMin = wallItem.earliestMin || dayEndMin;
    }

    // ─────────────────────────────────────────────────
    // 5. CLASSIFY items by constraint strength
    // ─────────────────────────────────────────────────
    // Priority order for placement:
    //   A. Availability-bound activities (must happen in specific window)
    //   B. Hard-constrained activities (must happen in time range)
    //   C. Fixed events (lunch, snack — have bounds but are flexible)
    //   D. Soft-constrained activities (prefer a window)
    //   E. Unconstrained activities (go anywhere)

    const availBound = [];    // A: matched to availability windows
    const hardConstrained = []; // B: hard time constraints
    const softConstrained = []; // D: soft time constraints
    const unconstrained = [];   // E: no constraints

    activityItems.forEach(item => {
        // Check if this activity type matches an availability window
        const availMatch = findAvailabilityMatch(item, availMap);
        if (availMatch) {
            item.constraint = {
                startMin: availMatch.startMin,
                endMin: availMatch.endMin,
                hard: true
            };
            item._availName = availMatch.name;
            availBound.push(item);
        } else if (item.constraint && item.constraint.hard) {
            hardConstrained.push(item);
        } else if (item.constraint && !item.constraint.hard) {
            softConstrained.push(item);
        } else {
            unconstrained.push(item);
        }
    });

    // Fixed events (not the wall)
    const fixedNonWall = fixedItems.filter(f => f.role === 'fixed');

    // ─────────────────────────────────────────────────
    // 6. PLACE items using interval scheduling
    // ─────────────────────────────────────────────────
    // We build a timeline of occupied intervals and place items
    // in priority order, finding the best valid slot for each.

    const placed = []; // { startMin, endMin, item }

    // Helper: check if a proposed interval conflicts with already-placed items
    function conflicts(startMin, endMin) {
        return placed.some(p => startMin < p.endMin && endMin > p.startMin);
    }

    // Helper: find the best start time for an item within bounds
    function findSlot(item, boundsStart, boundsEnd) {
        const needed = item.duration;
        // Try exact start first
        for (let t = snap(boundsStart); t + needed <= boundsEnd; t += SNAP) {
            if (!conflicts(t, t + needed)) {
                return t;
            }
        }
        return null; // no valid slot found
    }

    // --- A. Place availability-bound activities ---
    // Sort by window start (earliest first)
    availBound.sort((a, b) => a.constraint.startMin - b.constraint.startMin);
    availBound.forEach(item => {
        const ws = Math.max(item.constraint.startMin, dayStartMin);
        const we = Math.min(item.constraint.endMin, wallMin);
        const start = findSlot(item, ws, we);
        if (start !== null) {
            placed.push({ startMin: start, endMin: start + item.duration, item });
        } else {
            warnings.push(`"${item._availName || item.event}" could not fit in window ${fmtTime(ws)}-${fmtTime(we)}`);
            // Fallback: place it unconstrained
            unconstrained.push(item);
        }
    });

    // --- B. Place hard-constrained activities ---
    hardConstrained.sort((a, b) => a.constraint.startMin - b.constraint.startMin);
    hardConstrained.forEach(item => {
        const ws = Math.max(item.constraint.startMin, dayStartMin);
        const we = Math.min(item.constraint.endMin, wallMin);
        const start = findSlot(item, ws, we);
        if (start !== null) {
            placed.push({ startMin: start, endMin: start + item.duration, item });
        } else {
            warnings.push(`"${item.event}" HARD constraint ${fmtTime(ws)}-${fmtTime(we)} could not be satisfied`);
        }
    });

    // --- C. Place fixed events (lunch, snack) ---
    // Sort by earliest bound
    fixedNonWall.sort((a, b) => (a.earliestMin || 0) - (b.earliestMin || 0));
    fixedNonWall.forEach(item => {
        const es = Math.max(item.earliestMin || dayStartMin, dayStartMin);
        const le = Math.min(item.latestEndMin || wallMin, wallMin);
        const start = findSlot(item, es, le);
        if (start !== null) {
            placed.push({ startMin: start, endMin: start + item.duration, item });
        } else {
            // Try wider range
            const fallback = findSlot(item, dayStartMin, wallMin);
            if (fallback !== null) {
                placed.push({ startMin: fallback, endMin: fallback + item.duration, item });
                warnings.push(`"${item.event}" placed outside preferred bounds`);
            } else {
                warnings.push(`"${item.event}" could not be placed at all`);
            }
        }
    });

    // --- D. Place soft-constrained activities ---
    softConstrained.sort((a, b) => a.constraint.startMin - b.constraint.startMin);
    softConstrained.forEach(item => {
        const ws = Math.max(item.constraint.startMin, dayStartMin);
        const we = Math.min(item.constraint.endMin, wallMin);
        let start = findSlot(item, ws, we);
        if (start !== null) {
            placed.push({ startMin: start, endMin: start + item.duration, item });
        } else {
            // Soft — fall back to anywhere
            start = findSlot(item, dayStartMin, wallMin);
            if (start !== null) {
                placed.push({ startMin: start, endMin: start + item.duration, item });
                warnings.push(`"${item.event}" placed outside preferred window`);
            } else {
                warnings.push(`"${item.event}" could not be placed`);
            }
        }
    });

    // --- E. Place unconstrained activities ---
    unconstrained.forEach(item => {
        const start = findSlot(item, dayStartMin, wallMin);
        if (start !== null) {
            placed.push({ startMin: start, endMin: start + item.duration, item });
        } else {
            warnings.push(`"${item.event}" — no room left in the day`);
        }
    });

    // --- Add wall (dismissal) ---
    if (wallItem) {
        placed.push({
            startMin: wallMin,
            endMin: wallMin + (wallItem.duration || 20),
            item: wallItem
        });
    }

    // ─────────────────────────────────────────────────
    // 7. COMPACT — close gaps between blocks
    // ─────────────────────────────────────────────────
    placed.sort((a, b) => a.startMin - b.startMin);
    const compacted = compactSchedule(placed, dayStartMin, wallMin, warnings);

    // ─────────────────────────────────────────────────
    // 8. BUILD output placements
    // ─────────────────────────────────────────────────
    const placements = compacted.map(p => ({
        startMin: p.startMin,
        endMin: p.endMin,
        event: p.item.event,
        skeletonType: p.item.skeletonType,
        role: p.item.role,
        extra: p.item.extra || {}
    }));

    return { placements, warnings };
}

// =================================================================
// COMPACTION — close gaps between placed blocks
// =================================================================

function compactSchedule(placed, dayStartMin, wallMin, warnings) {
    if (placed.length === 0) return placed;

    // Separate wall from the rest
    const wall = placed.find(p => p.item.role === 'wall');
    const nonWall = placed.filter(p => p.item.role !== 'wall');

    // Sort by start time
    nonWall.sort((a, b) => a.startMin - b.startMin);

    // Two-phase compaction:
    // Phase 1: Respect constrained items' positions, compact unconstrained around them
    // Phase 2: Close remaining gaps by sliding blocks forward

    const anchored = []; // Items that must stay at their position (constrained/fixed)
    const floating = []; // Items that can slide

    nonWall.forEach(p => {
        if (p.item.constraint && p.item.constraint.hard) {
            anchored.push(p);
        } else if (p.item.role === 'fixed') {
            // Fixed events: check if they're near their earliest bound
            anchored.push(p); // Keep them where the solver put them
        } else {
            floating.push(p);
        }
    });

    // Rebuild timeline: start from dayStartMin, place floating blocks
    // in gaps around anchored blocks
    const timeline = [];
    const anchoredSet = new Set(anchored);

    // Merge all into one sorted list
    const all = [...nonWall].sort((a, b) => a.startMin - b.startMin);

    let cursor = dayStartMin;
    all.forEach(p => {
        if (anchoredSet.has(p)) {
            // Anchored: jump cursor to its position if needed
            if (cursor < p.startMin) {
                cursor = p.startMin;
            }
            // If cursor is past the anchored item's start, we have overlap — leave as is
            timeline.push({ ...p, startMin: p.startMin, endMin: p.endMin });
            cursor = Math.max(cursor, p.endMin);
        } else {
            // Floating: slide to cursor (compact forward)
            // But don't overlap any anchored items
            let bestStart = cursor;

            // Check if sliding here would overlap an anchored item
            for (const a of anchored) {
                if (bestStart < a.endMin && bestStart + p.item.duration > a.startMin) {
                    // Overlap — push past the anchor
                    bestStart = a.endMin;
                }
            }

            if (bestStart + p.item.duration > wallMin) {
                // Doesn't fit after compaction — keep original position
                timeline.push(p);
                warnings.push(`"${p.item.event}" could not be compacted — may have a gap`);
            } else {
                timeline.push({ ...p, startMin: bestStart, endMin: bestStart + p.item.duration });
            }
            cursor = Math.max(cursor, bestStart + p.item.duration);
        }
    });

    // Add wall back
    if (wall) timeline.push(wall);

    return timeline.sort((a, b) => a.startMin - b.startMin);
}

// =================================================================
// HELPERS
// =================================================================

function findAvailabilityMatch(item, availMap) {
    // Check if the activity type's event name matches an availability entry
    const eventLower = (item.event || '').toLowerCase().trim();
    if (availMap[eventLower]) return availMap[eventLower];

    // Also check the skeleton type name
    const typeLower = (item.type || '').toLowerCase().trim();
    if (availMap[typeLower]) return availMap[typeLower];

    return null;
}

function mapTypeToEvent(type) {
    const map = {
        'activity': 'General Activity Slot',
        'sports': 'Sports Slot',
        'special': 'Special Activity',
        'league': 'League Game',
        'specialty_league': 'Specialty League',
        'swim': 'Swim',
        'smart': 'Smart Tile',
        'split': 'Split Activity',
        'elective': 'Elective'
    };
    return map[type] || type;
}

function mapTypeToSkeletonType(type) {
    const map = {
        'activity': 'slot',
        'sports': 'slot',
        'special': 'slot',
        'league': 'league',
        'specialty_league': 'specialty_league',
        'swim': 'pinned',
        'smart': 'smart',
        'split': 'split',
        'elective': 'elective'
    };
    return map[type] || type;
}

// =================================================================
// VALIDATION — check config before solving
// =================================================================

function validateConfig(config, dayStartMin, dayEndMin) {
    const errors = [];
    const dur = config.defaultDuration || 50;

    // Calculate total time needed
    let totalNeeded = 0;
    (config.blocks || []).forEach(b => {
        totalNeeded += (b.count || 1) * (b.duration || dur);
    });
    (config.fixedEvents || []).forEach(f => {
        totalNeeded += f.duration || 20;
    });

    const totalAvailable = dayEndMin - dayStartMin;
    if (totalNeeded > totalAvailable) {
        errors.push(`Total time needed (${totalNeeded}min) exceeds available time (${totalAvailable}min)`);
    }

    // Check for impossible constraints
    (config.blocks || []).forEach(b => {
        if (b.constraint && b.constraintType === 'hard') {
            const ws = parseTime(b.constraint.start);
            const we = parseTime(b.constraint.end);
            if (ws !== null && we !== null) {
                const window = we - ws;
                const needed = (b.duration || dur) * (b.count || 1);
                if (needed > window) {
                    errors.push(`${mapTypeToEvent(b.type)} needs ${needed}min but hard window is only ${window}min`);
                }
            }
        }
    });

    return errors;
}

// =================================================================
// PUBLIC API
// =================================================================
window.AutoBuildEngine = {
    solveSchedule,
    validateConfig,
    parseTime,
    fmtTime
};

})();
