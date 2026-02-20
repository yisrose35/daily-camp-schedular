// ============================================================================
// fluid_scheduler.js — Outcome-Based Fluid Scheduling Engine (v1.0)
// ============================================================================
//
// PURPOSE:
//   For camps that don't use rigid time templates. Instead of "Sport at 10:00,
//   Special at 10:40", the camp says "each bunk needs 3 specials, 2 sports,
//   lunch between 12-1, and the Bubble Guys are here 11-12."
//
//   This engine builds a PER-BUNK schedule working backwards from:
//     1. Activity durations (Art = 30min, Dance = 60min)
//     2. External visits that MUST be scheduled when available
//     3. Anchor windows (Lunch between 12:00-1:00)
//     4. Outcome requirements (3 specials, 2 sports per bunk)
//
// OUTPUT:
//   Standard skeleton array + per-bunk scheduleAssignments
//   Compatible with existing DivisionTimes, rotation, validation, etc.
//
// INTEGRATION:
//   - Reads: specialActivities, fields, divisions, activityProperties
//   - Reads: autoRequirements from global settings
//   - Writes: scheduleAssignments, divisionTimes (per-bunk slots)
//   - Called from: daily_adjustments.js runOptimizer or directly
//
// LOAD ORDER: After special_activities.js, fields.js, scheduler_core_utils.js
//
// ============================================================================

(function() {
    'use strict';

    const VERSION = '1.0';
    const DEBUG = true;

    function log(...args) {
        if (DEBUG) console.log('[AutoScheduler]', ...args);
    }

    // ========================================================================
    // TIME HELPERS
    // ========================================================================

    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (window.SchedulerCoreUtils?.parseTimeToMinutes) {
            return window.SchedulerCoreUtils.parseTimeToMinutes(str);
        }
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            mer = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (mer) {
            if (hh === 12) hh = (mer === 'am') ? 0 : 12;
            else if (mer === 'pm') hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToTime(mins) {
        if (window.SchedulerCoreUtils?.minutesToTime) {
            return window.SchedulerCoreUtils.minutesToTime(mins);
        }
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ap = h >= 12 ? 'pm' : 'am';
        return h12 + ':' + String(m).padStart(2, '0') + ap;
    }

    function minutesToISO(mins) {
        const d = new Date();
        d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
        return d.toISOString();
    }

    function uid() {
        return 'fluid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }

    // ========================================================================
    // CONFIGURATION LOADER
    // ========================================================================
    // Reads fluid requirements from global settings and merges with
    // activity/field data to build the complete config for scheduling.
    // ========================================================================

    /**
     * Load fluid scheduling configuration for a division.
     * Merges camp-level settings with activity properties.
     * 
     * @param {string} divisionName
     * @returns {Object|null} Config object or null if not in auto mode
     */
    function loadFluidConfig(divisionName) {
        const settings = window.loadGlobalSettings?.() || {};
        const fluidReqs = settings.autoRequirements;

        if (!fluidReqs) return null;

        const divReqs = fluidReqs[divisionName] || fluidReqs._default || null;
        if (!divReqs) return null;

        const divisions = window.divisions || settings.divisions || {};
        const divData = divisions[divisionName];
        if (!divData) {
            log('Division not found:', divisionName);
            return null;
        }

        const bunks = divData.bunks || [];
        if (bunks.length === 0) {
            log('No bunks in division:', divisionName);
            return null;
        }

        // Load activities with durations
        const specials = window.getGlobalSpecialActivities?.() || [];
        const allFields = window.getFields?.() || [];
        const actProps = window.activityProperties || {};

        // Build activity catalog with durations
        const activityCatalog = buildActivityCatalog(specials, allFields, actProps, divisionName);

        return {
            divisionName,
            bunks,
            dayStart: divReqs.dayStart || 540,
            dayEnd: divReqs.dayEnd || 960,
            defaultSlotDuration: divReqs.defaultSlotDuration || 30,
            requirements: divReqs.requirements || [],
            anchors: divReqs.anchors || [],
            externalVisits: (divReqs.externalVisits || []).concat(
                // Auto-detect mustScheduleWhenAvailable specials for today
                getMustScheduleActivitiesForToday(specials, divisionName)
            ),
            activityCatalog
        };
    }

    /**
     * Build a catalog of available activities with durations and metadata.
     * Merges special activities + fields + sports into a unified list.
     */
    function buildActivityCatalog(specials, fields, actProps, divisionName) {
        const catalog = [];

        // Special activities
        specials.forEach(s => {
            if (!s.available) return;
            if (s.rainyDayExclusive && !window.isRainyDayModeActive?.()) return;

            // Check division access
            if (s.limitUsage?.enabled) {
                if (!(divisionName in (s.limitUsage.divisions || {}))) return;
            }

            const duration = s.duration || null; // null = use defaultSlotDuration
            const capacity = getSpecialCapacity(s);

            catalog.push({
                name: s.name,
                type: 'special',
                duration: duration,
                capacity: capacity,
                location: s.location || null,
                timeRules: s.timeRules || [],
                fullGrade: s.fullGrade === true,
                mustScheduleWhenAvailable: s.mustScheduleWhenAvailable === true,
                availableDays: s.availableDays || null, // null = every day
                maxUsage: s.maxUsage || null,
                prepDuration: s.prepDuration || 0,
                _source: 'special'
            });
        });

        // Sports fields
        fields.forEach(f => {
            if (!f.available) return;
            if (!f.activities || f.activities.length === 0) return;

            // Check rainy day
            if (window.isRainyDayModeActive?.() && !f.rainyDayAvailable) return;

            const capacity = getFieldCapacity(f);
            const duration = f.defaultActivityDuration || null;

            f.activities.forEach(sport => {
                catalog.push({
                    name: sport,
                    type: 'sport',
                    duration: duration,
                    capacity: capacity,
                    location: f.name,
                    timeRules: f.timeRules || [],
                    fullGrade: false,
                    mustScheduleWhenAvailable: false,
                    availableDays: null,
                    maxUsage: null,
                    prepDuration: 0,
                    _source: 'field',
                    _fieldName: f.name
                });
            });
        });

        log(`Activity catalog: ${catalog.length} activities (${catalog.filter(a => a.type === 'special').length} specials, ${catalog.filter(a => a.type === 'sport').length} sports)`);
        return catalog;
    }

    /**
     * Get special activities that must be scheduled today.
     * These are external-visit-style specials with availableDays set.
     */
    function getMustScheduleActivitiesForToday(specials, divisionName) {
        const today = getTodayDayOfWeek();
        const visits = [];

        specials.forEach(s => {
            if (!s.available) return;
            if (!s.mustScheduleWhenAvailable) return;
            if (!s.availableDays || s.availableDays.length === 0) return;

            // Check if today is one of their days
            if (!s.availableDays.includes(today)) return;

            // Check division access
            if (s.limitUsage?.enabled) {
                if (!(divisionName in (s.limitUsage.divisions || {}))) return;
            }

            const capacity = getSpecialCapacity(s);
            const duration = s.duration || 30;

            // Build time window from time rules
            let window_ = null;
            if (s.timeRules?.length > 0) {
                const availRule = s.timeRules.find(r => r.type === 'Available');
                if (availRule) {
                    window_ = {
                        start: availRule.startMin || parseTimeToMinutes(availRule.start),
                        end: availRule.endMin || parseTimeToMinutes(availRule.end)
                    };
                }
            }

            visits.push({
                name: s.name,
                duration: duration,
                capacity: capacity,
                window: window_,
                mustSchedule: true,
                _source: 'special_must_schedule'
            });
        });

        return visits;
    }

    function getTodayDayOfWeek() {
        const dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const d = new Date(dateStr + 'T12:00:00');
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return days[d.getDay()];
    }

    function getSpecialCapacity(special) {
        const sw = special.sharableWith;
        if (!sw) return 1;
        if (sw.type === 'all') return parseInt(sw.capacity) || 999;
        if (sw.type === 'same_division' || sw.type === 'custom') return parseInt(sw.capacity) || 2;
        return 1;
    }

    function getFieldCapacity(field) {
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(field.name, { [field.name]: field });
        }
        const sw = field.sharableWith;
        if (!sw) return 1;
        return parseInt(sw.capacity) || 1;
    }

    // ========================================================================
    // CROSS-BUNK USAGE TRACKER
    // ========================================================================
    // Prevents two bunks from doing the same capacity-1 activity at the same time.
    // ========================================================================

    class UsageTracker {
        constructor() {
            // { minute: { activityName: [bunk1, bunk2, ...] } }
            this.map = {};
        }

        register(bunkName, activityName, startMin, endMin) {
            for (let m = startMin; m < endMin; m++) {
                if (!this.map[m]) this.map[m] = {};
                if (!this.map[m][activityName]) this.map[m][activityName] = [];
                this.map[m][activityName].push(bunkName);
            }
        }

        isAvailable(activityName, startMin, endMin, capacity) {
            for (let m = startMin; m < endMin; m++) {
                const count = this.map[m]?.[activityName]?.length || 0;
                if (count >= capacity) return false;
            }
            return true;
        }

        // Also check location-based conflicts (field name)
        isLocationAvailable(locationName, startMin, endMin, capacity) {
            if (!locationName) return true;
            return this.isAvailable(locationName, startMin, endMin, capacity);
        }

        registerLocation(bunkName, locationName, startMin, endMin) {
            if (!locationName) return;
            this.register(bunkName, locationName, startMin, endMin);
        }
    }

    // ========================================================================
    // CORE ENGINE: FLUID SCHEDULE BUILDER
    // ========================================================================

    /**
     * Main entry point: Build fluid schedules for a division.
     * 
     * @param {string} divisionName
     * @returns {Object} { success, schedules: { bunkName: [...blocks] }, skeleton, summary }
     */
    function buildFluidSchedule(divisionName) {
        const config = loadFluidConfig(divisionName);
        if (!config) {
            log('No auto config for division:', divisionName);
            return { success: false, error: 'No auto configuration' };
        }

        log('');
        log('╔═══════════════════════════════════════════════════════════╗');
        log('║  FLUID SCHEDULER v1.0                                    ║');
        log(`║  Division: ${divisionName.padEnd(44)}║`);
        log(`║  Bunks: ${config.bunks.length}  Day: ${minutesToTime(config.dayStart)}-${minutesToTime(config.dayEnd)}`.padEnd(58) + '║');
        log('╚═══════════════════════════════════════════════════════════╝');

        const tracker = new UsageTracker();
        const bunkSchedules = {};
        const rotationHistory = window.loadRotationHistory?.() || {};

        // =====================================================================
        // STEP 1: Assign external visit / must-schedule slots
        // =====================================================================
        log('\n[STEP 1] Assigning external visits & must-schedule activities...');
        const externalAssignments = assignExternalVisits(config, tracker);

        // Initialize per-bunk schedules with external slots
        for (const bunk of config.bunks) {
            bunkSchedules[bunk] = externalAssignments[bunk] || [];
        }

        // =====================================================================
        // STEP 2: Place anchors (Lunch, Snack, Dismissal) per bunk
        // =====================================================================
        log('\n[STEP 2] Placing anchors per bunk...');
        for (const bunk of config.bunks) {
            placeAnchors(bunk, config, bunkSchedules[bunk], tracker);
        }

        // =====================================================================
        // STEP 3: Fill gaps with activities (round-robin across bunks)
        // =====================================================================
        log('\n[STEP 3] Filling gaps with activities (round-robin)...');
        fillAllBunkGaps(config, bunkSchedules, tracker, rotationHistory);

        // =====================================================================
        // STEP 4: Convert to standard skeleton + scheduleAssignments
        // =====================================================================
        log('\n[STEP 4] Converting to standard output format...');
        const result = convertToStandardOutput(config, bunkSchedules);

        // Log summary
        logSummary(config, bunkSchedules);

        return {
            success: true,
            schedules: bunkSchedules,
            skeleton: result.skeleton,
            divisionTimes: result.divisionTimes,
            scheduleAssignments: result.scheduleAssignments,
            summary: result.summary
        };
    }

    // ========================================================================
    // STEP 1: EXTERNAL VISITS
    // ========================================================================

    function assignExternalVisits(config, tracker) {
        const assignments = {};
        config.bunks.forEach(b => assignments[b] = []);

        for (const visit of config.externalVisits) {
            const capacity = visit.capacity || 1;
            const duration = visit.duration || config.defaultSlotDuration;
            const window_ = visit.window || { start: config.dayStart, end: config.dayEnd };

            // Group bunks by capacity
            const groups = [];
            let group = [];
            for (const bunk of config.bunks) {
                group.push(bunk);
                if (group.length >= capacity) {
                    groups.push([...group]);
                    group = [];
                }
            }
            if (group.length > 0) groups.push(group);

            // Validate fit
            const totalNeeded = groups.length * duration;
            const windowSize = window_.end - window_.start;
            if (totalNeeded > windowSize) {
                log(`  ⚠️ ${visit.name}: Needs ${totalNeeded}min but window is ${windowSize}min`);
            }

            // Assign sequential slots
            let cursor = window_.start;
            groups.forEach((groupBunks, gi) => {
                const slotStart = cursor;
                const slotEnd = Math.min(cursor + duration, window_.end);

                log(`  ${visit.name} Group ${gi + 1}: [${groupBunks.join(', ')}] → ${minutesToTime(slotStart)}-${minutesToTime(slotEnd)}`);

                for (const bunk of groupBunks) {
                    const block = {
                        name: visit.name,
                        type: 'mandatory',
                        start: slotStart,
                        end: slotEnd,
                        duration: slotEnd - slotStart,
                        _fluidType: 'external'
                    };
                    assignments[bunk].push(block);
                    tracker.register(bunk, visit.name, slotStart, slotEnd);
                }
                cursor = slotEnd;
            });
        }

        return assignments;
    }

    // ========================================================================
    // STEP 2: ANCHOR PLACEMENT
    // ========================================================================

    function placeAnchors(bunk, config, schedule, tracker) {
        for (const anchor of config.anchors) {
            if (anchor.fixedAt) {
                if ((anchor.duration || 0) > 0) {
                    const block = {
                        name: anchor.name || anchor.event,
                        type: 'anchor',
                        start: anchor.fixedAt,
                        end: anchor.fixedAt + anchor.duration,
                        duration: anchor.duration,
                        _fluidType: 'anchor'
                    };
                    schedule.push(block);
                    tracker.register(bunk, block.name, block.start, block.end);
                }
                continue;
            }

            // Place within window
            const win = anchor.window || { earliest: config.dayStart, latest: config.dayEnd };
            const earliest = win.earliest || win.start || config.dayStart;
            const latest = win.latest || win.end || config.dayEnd;
            const duration = anchor.duration || 30;
            const name = anchor.name || anchor.event;

            let placed = false;
            for (let t = earliest; t + duration <= latest; t += 5) {
                if (!hasConflict(t, t + duration, schedule)) {
                    const block = {
                        name,
                        type: 'anchor',
                        start: t,
                        end: t + duration,
                        duration,
                        _fluidType: 'anchor'
                    };
                    schedule.push(block);
                    tracker.register(bunk, name, t, t + duration);
                    log(`  ${bunk}: ${name} → ${minutesToTime(t)}-${minutesToTime(t + duration)}`);
                    placed = true;
                    break;
                }
            }

            if (!placed) {
                log(`  ⚠️ ${bunk}: Could not place ${name} in window ${minutesToTime(earliest)}-${minutesToTime(latest)}`);
            }
        }
    }

    function hasConflict(start, end, schedule) {
        return schedule.some(b => b.start < end && b.end > start);
    }

    // ========================================================================
    // STEP 3: GAP FILLING (Round-Robin)
    // ========================================================================

    function fillAllBunkGaps(config, bunkSchedules, tracker, rotationHistory) {
        // Build per-bunk state
        const bunkState = {};
        const bunkGaps = {};
        const bunkPreferences = {};

        for (let bi = 0; bi < config.bunks.length; bi++) {
            const bunk = config.bunks[bi];
            const schedule = bunkSchedules[bunk];
            schedule.sort((a, b) => a.start - b.start);

            bunkGaps[bunk] = findGaps(schedule, config.dayStart, config.dayEnd);
            bunkState[bunk] = {
                used: new Set(),
                counts: { special: 0, sport: 0 },
                gapIdx: 0,
                cursor: bunkGaps[bunk][0]?.start || config.dayEnd,
                done: false
            };

            // Shuffle activity preference per bunk for variety
            const catalog = [...config.activityCatalog];
            // Rotate by bunk index
            for (let r = 0; r < bi; r++) {
                catalog.push(catalog.shift());
            }
            bunkPreferences[bunk] = catalog;
        }

        // Round-robin: one activity per bunk per iteration
        let iterations = 0;
        const MAX_ITER = 500;

        while (iterations < MAX_ITER) {
            iterations++;
            let progress = false;

            for (const bunk of config.bunks) {
                const state = bunkState[bunk];
                if (state.done) continue;

                const gaps = bunkGaps[bunk];

                // Advance to valid gap
                while (state.gapIdx < gaps.length && state.cursor >= gaps[state.gapIdx].end) {
                    state.gapIdx++;
                    if (state.gapIdx < gaps.length) {
                        state.cursor = gaps[state.gapIdx].start;
                    }
                }

                if (state.gapIdx >= gaps.length) {
                    state.done = true;
                    continue;
                }

                const gap = gaps[state.gapIdx];
                const remaining = gap.end - state.cursor;

                if (remaining < 5) {
                    state.gapIdx++;
                    if (state.gapIdx < gaps.length) state.cursor = gaps[state.gapIdx].start;
                    continue;
                }

                // Pick best activity
                const pick = pickActivity(
                    bunk, state, remaining, state.cursor, gap.end,
                    bunkPreferences[bunk], config, tracker, rotationHistory
                );

                if (!pick) {
                    // Nothing fits this gap — move to next
                    if (remaining >= 10) {
                        bunkSchedules[bunk].push({
                            name: 'Free',
                            type: 'free',
                            start: state.cursor,
                            end: gap.end,
                            duration: remaining,
                            _fluidType: 'free'
                        });
                    }
                    state.gapIdx++;
                    if (state.gapIdx < gaps.length) state.cursor = gaps[state.gapIdx].start;
                    continue;
                }

                const duration = pick.duration || config.defaultSlotDuration;
                const block = {
                    name: pick.name,
                    type: pick.type,
                    start: state.cursor,
                    end: state.cursor + duration,
                    duration: duration,
                    _fluidType: pick.type,
                    _location: pick.location || null,
                    _fieldName: pick._fieldName || null
                };

                bunkSchedules[bunk].push(block);
                tracker.register(bunk, pick.name, block.start, block.end);
                if (pick.location) {
                    tracker.registerLocation(bunk, pick.location, block.start, block.end);
                }

                log(`  ${bunk}: ${pick.name} ${minutesToTime(block.start)}-${minutesToTime(block.end)} (${duration}m)`);

                state.used.add(pick.name);
                state.counts[pick.type] = (state.counts[pick.type] || 0) + 1;
                state.cursor += duration;
                progress = true;
            }

            if (!progress) break;
        }

        log(`  Fill complete: ${iterations} iterations`);
    }

    function findGaps(schedule, dayStart, dayEnd) {
        const sorted = [...schedule].sort((a, b) => a.start - b.start);
        const gaps = [];
        let cursor = dayStart;

        for (const block of sorted) {
            if (block.start > cursor) {
                gaps.push({ start: cursor, end: block.start });
            }
            cursor = Math.max(cursor, block.end);
        }
        if (cursor < dayEnd) {
            gaps.push({ start: cursor, end: dayEnd });
        }

        return gaps.filter(g => (g.end - g.start) >= 5);
    }

    /**
     * Pick best activity for a bunk at a given time.
     * Considers: capacity, time rules, outcomes needed, variety, rotation history.
     */
    function pickActivity(bunk, state, availableMin, startMin, endMin, preferredOrder, config, tracker, rotationHistory) {
        const specialTarget = getOutcomeTarget(config, 'special');
        const sportTarget = getOutcomeTarget(config, 'sport');
        const needSpecials = state.counts.special < specialTarget;
        const needSports = state.counts.sport < sportTarget;

        const candidates = preferredOrder
            .filter(a => {
                const dur = a.duration || config.defaultSlotDuration;
                if (dur > availableMin) return false;

                // Cross-bunk capacity check
                const cap = a.capacity || 1;
                if (!tracker.isAvailable(a.name, startMin, startMin + dur, cap)) return false;

                // Location capacity check
                if (a.location && !tracker.isLocationAvailable(a.location, startMin, startMin + dur, cap)) return false;

                // Time rules check
                if (a.timeRules?.length > 0) {
                    if (!checkTimeRules(a.timeRules, startMin, startMin + dur)) return false;
                }

                return true;
            })
            .map((a, idx) => {
                let score = 0;

                // Outcome need
                if (a.type === 'special' && needSpecials) score += 20;
                if (a.type === 'sport' && needSports) score += 20;

                // Variety (not yet done today)
                if (!state.used.has(a.name)) score += 15;

                // Gap efficiency
                const dur = a.duration || config.defaultSlotDuration;
                score += (1 - (availableMin - dur) / availableMin) * 8;

                // Per-bunk preference order
                score += Math.max(0, 10 - idx) * 0.5;

                // Rotation history (least recently done gets boost)
                // Simplified — full integration would use RotationEngine
                const historyKey = bunk + ':' + a.name;
                if (!rotationHistory[historyKey]) score += 5;

                return { ...a, _score: score };
            })
            .sort((a, b) => b._score - a._score);

        return candidates[0] || null;
    }

    function getOutcomeTarget(config, type) {
        const outcome = config.requirements.find(r => r.type === type);
        return outcome?.count || 0;
    }

    function checkTimeRules(rules, startMin, endMin) {
        if (!rules || rules.length === 0) return true;

        let hasAvailableRule = false;
        let passesAvailable = false;
        let blockedByNotAvailable = false;

        for (const rule of rules) {
            const rStart = rule.startMin ?? parseTimeToMinutes(rule.start);
            const rEnd = rule.endMin ?? parseTimeToMinutes(rule.end);
            if (rStart == null || rEnd == null) continue;

            if (rule.type === 'Available') {
                hasAvailableRule = true;
                // Block must be within the available window
                if (startMin >= rStart && endMin <= rEnd) {
                    passesAvailable = true;
                }
            } else if (rule.type === 'Not Available') {
                // Block must not overlap the unavailable window
                if (startMin < rEnd && endMin > rStart) {
                    blockedByNotAvailable = true;
                }
            }
        }

        if (blockedByNotAvailable) return false;
        if (hasAvailableRule && !passesAvailable) return false;
        return true;
    }

    // ========================================================================
    // STEP 4: CONVERT TO STANDARD OUTPUT
    // ========================================================================
    // Produces:
    //   - skeleton: standard array for DivisionTimesSystem
    //   - divisionTimes: per-bunk slot arrays (since each bunk has unique times)
    //   - scheduleAssignments: per-bunk activity assignments
    // ========================================================================

    function convertToStandardOutput(config, bunkSchedules) {
        const skeleton = [];
        const scheduleAssignments = {};
        const divisionTimes = {};

        // In auto mode, each bunk has unique time slots
        // We create per-bunk divisionTimes entries
        for (const bunk of config.bunks) {
            const blocks = bunkSchedules[bunk].sort((a, b) => a.start - b.start);
            const slots = [];
            const assignments = [];

            blocks.forEach((block, idx) => {
                // Build divisionTimes slot
                slots.push({
                    startMin: block.start,
                    endMin: block.end,
                    start: minutesToISO(block.start),
                    end: minutesToISO(block.end),
                    label: minutesToTime(block.start) + ' - ' + minutesToTime(block.end),
                    _fluidGenerated: true
                });

                // Build assignment
                if (block.type === 'anchor' || block.type === 'mandatory') {
                    // Pinned — place directly
                    assignments.push({
                        field: block._location || block.name,
                        _activity: block.name,
                        activity: block.name,
                        event: block.name,
                        _pinned: true,
                        _fluidType: block._fluidType
                    });
                } else if (block.type === 'free') {
                    assignments.push({
                        field: 'Free',
                        _activity: 'Free',
                        activity: 'Free',
                        _fluidType: 'free'
                    });
                } else {
                    // Activity — assigned by fluid scheduler
                    assignments.push({
                        field: block._fieldName || block._location || block.name,
                        _activity: block.name,
                        activity: block.name,
                        sport: block.type === 'sport' ? block.name : undefined,
                        _fluidType: block._fluidType,
                        _fluidAssigned: true
                    });
                }
            });

            // Store per-bunk
            scheduleAssignments[bunk] = assignments;

            // For divisionTimes, we use the bunk's slots
            // NOTE: In auto mode, divisionTimes[divisionName] won't work as-is
            // because each bunk has different slots. We store per-bunk.
            divisionTimes[bunk] = slots;

            // Also add to skeleton for compatibility
            blocks.forEach(block => {
                skeleton.push({
                    id: uid(),
                    type: block.type === 'mandatory' ? 'pinned' :
                          block.type === 'anchor' ? 'pinned' :
                          block.type === 'sport' ? 'slot' :
                          block.type === 'special' ? 'slot' : 'pinned',
                    event: block.name,
                    division: config.divisionName,
                    bunk: bunk,
                    startTime: minutesToTime(block.start),
                    endTime: minutesToTime(block.end),
                    startMin: block.start,
                    endMin: block.end,
                    _fluidGenerated: true,
                    _fluidBunk: bunk
                });
            });
        }

        return {
            skeleton,
            divisionTimes,
            scheduleAssignments,
            summary: buildSummary(config, bunkSchedules)
        };
    }

    function buildSummary(config, bunkSchedules) {
        const summary = {};
        for (const bunk of config.bunks) {
            const blocks = bunkSchedules[bunk];
            summary[bunk] = {
                totalBlocks: blocks.length,
                specials: blocks.filter(b => b.type === 'special').length,
                sports: blocks.filter(b => b.type === 'sport').length,
                externals: blocks.filter(b => b.type === 'mandatory').length,
                anchors: blocks.filter(b => b.type === 'anchor').length,
                freeTime: blocks.filter(b => b.type === 'free').reduce((s, b) => s + b.duration, 0),
                activities: blocks.filter(b => b.type !== 'anchor' && b.type !== 'free').map(b => b.name)
            };
        }
        return summary;
    }

    function logSummary(config, bunkSchedules) {
        log('\n╔═══════════════════════════════════════════════════════════╗');
        log('║  SCHEDULE SUMMARY                                        ║');
        log('╚═══════════════════════════════════════════════════════════╝');

        const specialTarget = getOutcomeTarget(config, 'special');
        const sportTarget = getOutcomeTarget(config, 'sport');

        for (const bunk of config.bunks) {
            const blocks = bunkSchedules[bunk].sort((a, b) => a.start - b.start);
            const specials = blocks.filter(b => b.type === 'special').length;
            const sports = blocks.filter(b => b.type === 'sport').length;
            const externals = blocks.filter(b => b.type === 'mandatory').length;

            const specialOk = specials >= specialTarget ? '✅' : '❌';
            const sportOk = sports >= sportTarget ? '✅' : '❌';

            log(`  ${bunk}: ${specialOk} ${specials}/${specialTarget} specials | ${sportOk} ${sports}/${sportTarget} sports | ${externals} external`);
            blocks.forEach(b => {
                log(`    ${minutesToTime(b.start)}-${minutesToTime(b.end)} ${b.name} (${b.duration}m) [${b.type}]`);
            });
        }
    }

    // ========================================================================
    // INTEGRATION: Apply fluid schedule to the system
    // ========================================================================

    /**
     * Run the fluid scheduler and apply results to the live system.
     * Called from runOptimizer or directly.
     */
    function runAutoScheduler(allowedDivisions) {
        const settings = window.loadGlobalSettings?.() || {};
        if (settings.scheduleMode !== 'auto') {
            log('Not in auto mode, skipping');
            return false;
        }

        const divisions = window.divisions || settings.divisions || {};
        const targetDivisions = allowedDivisions || Object.keys(divisions);

        log('Running fluid scheduler for divisions:', targetDivisions);

        let anySuccess = false;

        for (const divName of targetDivisions) {
            const result = buildFluidSchedule(divName);
            if (!result.success) {
                log('Failed for division:', divName, result.error);
                continue;
            }

            // Apply to window globals
            Object.assign(window.scheduleAssignments || {}, result.scheduleAssignments);

            // Store per-bunk division times
            // In auto mode, we use bunk-level granularity
            if (!window.fluidDivisionTimes) window.fluidDivisionTimes = {};
            Object.assign(window.fluidDivisionTimes, result.divisionTimes);

            anySuccess = true;
        }

        // Save to daily data
        if (anySuccess) {
            window.saveCurrentDailyData?.('scheduleAssignments', window.scheduleAssignments);
            window.saveCurrentDailyData?.('fluidDivisionTimes', window.fluidDivisionTimes);
            window.saveCurrentDailyData?.('_fluidMode', true);
        }

        return anySuccess;
    }

    /**
     * Check if the camp is in fluid scheduling mode
     */
    function isAutoMode() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.scheduleMode === 'auto';
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.AutoScheduler = {
        VERSION,
        buildFluidSchedule,
        runAutoScheduler,
        isAutoMode,
        loadFluidConfig,
        buildActivityCatalog,

        // For testing/debugging
        _assignExternalVisits: assignExternalVisits,
        _placeAnchors: placeAnchors,
        _fillAllBunkGaps: fillAllBunkGaps,
        _pickActivity: pickActivity,
        _UsageTracker: UsageTracker,
        _checkTimeRules: checkTimeRules
    };

    console.log(`🌊 Auto Scheduler v${VERSION} loaded`);

})();
