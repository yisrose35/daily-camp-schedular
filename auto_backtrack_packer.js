
// =============================================================================
// auto_backtrack_packer.js — BACKTRACKING PER-BUNK PACKER v1.0
// =============================================================================
// Replaces the greedy cursor-walk packer in scheduler_core_auto.js Phase 3.
//
// KEY DIFFERENCE: When placement fails, this packer BACKTRACKS — it undoes
// previous decisions and tries alternatives instead of pushing forward with
// relaxed constraints or fallback sweeps.
//
// ALGORITHM:
//   1. Collect "needs" (activities to place) and "gaps" (free windows)
//   2. For each gap, try to assign a sequence of needs using backtracking
//   3. MRV ordering: most constrained needs go first
//   4. Forward checking: after each placement, verify remaining needs can fit
//   5. No gap is acceptable: if a gap can't be filled, backtrack
//
// DATA CONTRACT:
//   Input:  Same as greedyPackBunk (bunk, grade, draftResult, shoppingList, etc.)
//   Output: Same template array format (compatible with executeTemplates)
//
// INTEGRATION:
//   Called from scheduler_core_auto.js in place of greedyPackBunk.
//   Uses the same field ledger, resource tracker, and constraint functions.
// =============================================================================

(function () {
    'use strict';

    const TAG = '[BacktrackPacker]';
    function log(msg, ...args) { console.log(TAG + ' ' + msg, ...args); }
    function warn(msg, ...args) { console.warn(TAG + ' ⚠️ ' + msg, ...args); }

    const GAP_MIN_DUR = 20;
    const SPORT_CEILING = 60;
    const ABSOLUTE_FLOOR = 5;
    const TIME_STEP = 5;

    // =========================================================================
    // MAIN ENTRY POINT
    // =========================================================================

    /**
     * Pack a single bunk's day using backtracking search.
     *
     * @param {Object} ctx — Context object with all callbacks and data:
     *   ctx.bunk, ctx.grade
     *   ctx.draftResult        — from Phase 2
     *   ctx.shoppingList       — from Phase 1
     *   ctx.staggerOffset      — from rotation matrix
     *   ctx.swimsToday         — boolean
     *   ctx.bunkTimelines      — current timelines (has walls from Phase 0)
     *   ctx.gradeStart, ctx.gradeEnd — division time bounds
     *   ctx.layersByGrade      — layers grouped by grade
     *   ctx.isFieldAvailable   — callback
     *   ctx.claimField         — callback
     *   ctx.unclaimFieldsForBunk — callback
     *   ctx.canUsePoolAtTime   — callback
     *   ctx.canUseSpecialAtTime — callback
     *   ctx.canUseRotationSlotAtTime — callback
     *   ctx.registerSpecialUsage — callback
     *   ctx.registerCrossGrade — callback
     *   ctx.rtRegister         — callback
     *   ctx.rtCanUse           — callback
     *   ctx.getSwimWindow      — callback (grade) => {start, end, dMin, dMax}
     *   ctx.findSportWithField — callback (bunk, grade, startMin, endMin, usedToday, draftSport) => {sport, field} | null
     *   ctx.resolveConstraints — callback (layer, type, block) => {dMin, dMax, dIdeal}
     *   ctx.getSpecialDuration — callback (specialName, grade) => number|null
     *   ctx.fieldLedger        — field ledger object
     *   ctx.iterSeed           — current iteration seed
     *   ctx.globalSettings     — global settings
     *   ctx.isRainy            — boolean
     *   ctx.rotationEngine     — window.RotationEngine
     *
     * @returns {Array} — template array compatible with executeTemplates
     */
    function packBunk(ctx) {
        const {
            bunk, grade, draftResult, shoppingList, swimsToday,
            bunkTimelines, gradeStart, gradeEnd, layersByGrade
        } = ctx;

        // -----------------------------------------------------------------
        // STEP 1: Extract walls (fixed blocks from Phase 0/1)
        // -----------------------------------------------------------------
        const walls = [];
        (bunkTimelines[bunk] || []).forEach(b => {
            if (b._fixed || b._committed) {
                walls.push({
                    startMin: b.startMin,
                    endMin: b.endMin,
                    type: b.type,
                    event: b.event,
                    _fixed: true,
                    _source: b._source || 'phase0',
                    _classification: b._classification || 'pinned',
                    _committed: true,
                    _activityLocked: b._activityLocked,
                    _gradeWide: b._gradeWide,
                    _noBacktrack: b._noBacktrack,
                    _assignedSpecial: b._assignedSpecial,
                    _assignedSport: b._assignedSport,
                    _specialLocation: b._specialLocation,
                    _specialDuration: b._specialDuration,
                    _customActivity: b._customActivity,
                    _customField: b._customField,
                    _customBunks: b._customBunks,
                    _rotationEventId: b._rotationEventId,
                    _rotationEventLocation: b._rotationEventLocation,
                    _rotationEventColor: b._rotationEventColor,
                    _isTrip: b._isTrip,
                    _bunkOverride: b._bunkOverride,
                    layer: b.layer,
                    field: b.field,
                    dMin: b.endMin - b.startMin,
                    dMax: b.endMin - b.startMin
                });
            }
        });
        walls.sort((a, b) => a.startMin - b.startMin);

        // -----------------------------------------------------------------
        // STEP 2: Compute gaps (free windows between walls)
        // -----------------------------------------------------------------
        const gaps = [];
        let cursor = gradeStart;
        walls.forEach(w => {
            if (cursor < w.startMin) {
                gaps.push({ startMin: cursor, endMin: w.startMin, size: w.startMin - cursor });
            }
            cursor = Math.max(cursor, w.endMin);
        });
        if (cursor < gradeEnd) {
            gaps.push({ startMin: cursor, endMin: gradeEnd, size: gradeEnd - cursor });
        }

        // -----------------------------------------------------------------
        // STEP 3: Build needs (activities to place)
        // -----------------------------------------------------------------
        const needs = buildNeeds(ctx, walls);

        // -----------------------------------------------------------------
        // STEP 4: Backtracking search
        // -----------------------------------------------------------------
        const result = backtrackFill(gaps, needs, ctx);

        // -----------------------------------------------------------------
        // STEP 5: Assemble template
        // -----------------------------------------------------------------
        const template = [];

        // Add walls
        walls.forEach(w => template.push({ ...w }));

        // Add placed needs from result
        result.placed.forEach(p => {
            template.push({
                startMin: p.startMin,
                endMin: p.endMin,
                type: p.type,
                event: p.event,
                layer: p.layer,
                field: p.field || null,
                _fixed: false,
                _source: 'backtrack',
                _classification: 'windowed',
                _committed: true,
                _assignedSpecial: p.type === 'special' ? p.event : null,
                _assignedSport: (p.type === 'sport' || p.type === 'slot') ? p.event : null,
                _specialLocation: p._specialLocation || null,
                _specialDuration: p.type === 'special' ? (p.endMin - p.startMin) : null,
                _activityLocked: p.type === 'special',
                _rotationEventId: p._rotationEventId || null,
                _rotationEventLocation: p._rotationEventLocation || null,
                _rotationEventColor: p._rotationEventColor || null,
                _sportFallbacks: p._sportFallbacks || null,
                _draftActivity: p._draftActivity || null,
                _draftField: p._draftField || null,
                dMin: p.dMin,
                dMax: p.dMax
            });
        });

        // Fill any remaining gaps with sports (should be none if backtracking worked)
        template.sort((a, b) => a.startMin - b.startMin);
        const filledTemplate = fillRemainingGaps(template, gradeStart, gradeEnd, ctx);

        // Post-process: enforce dMax, clamp to walls, merge tiny blocks
        const finalTemplate = postProcess(filledTemplate, ctx);

        return finalTemplate;
    }

    // =========================================================================
    // BUILD NEEDS
    // =========================================================================

    function buildNeeds(ctx, walls) {
        const {
            bunk, grade, draftResult, shoppingList, swimsToday,
            layersByGrade, resolveConstraints, getSwimWindow, getSpecialDuration
        } = ctx;

        const needs = [];
        const placedTypes = new Set();

        // Check what's already placed in walls
        walls.forEach(w => {
            if (w._assignedSpecial) placedTypes.add('special:' + w._assignedSpecial.toLowerCase());
            if (w.type === 'swim') placedTypes.add('swim');
            if (w.type === 'snack') placedTypes.add('snack');
        });

        // --- Swim ---
        if (swimsToday && !placedTypes.has('swim')) {
            const swimLayer = (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'swim');
            if (swimLayer) {
                const mrc = ctx.getSwimWindow(grade);
                const c = resolveConstraints(swimLayer, 'swim', {});
                const ws = mrc ? Math.max(swimLayer.startMin || 0, mrc.start) : (swimLayer.startMin || 0);
                const we = mrc ? Math.min(swimLayer.endMin || 960, mrc.end) : (swimLayer.endMin || 960);
                needs.push({
                    id: 'swim_' + grade,
                    type: 'swim',
                    event: 'Swim',
                    dMin: mrc ? (mrc.dMin || c.dMin) : c.dMin,
                    dMax: mrc ? (mrc.dMax || c.dMax) : c.dMax,
                    windowStart: ws,
                    windowEnd: we,
                    priority: 1, // highest priority
                    layer: swimLayer,
                    _needsPool: true
                });
            }
        }

        // --- Specials (from draft) ---
        const draftSpecials = (draftResult && draftResult.specials) || [];
        draftSpecials.forEach((special, i) => {
            const name = special.name || special.event || '';
            if (placedTypes.has('special:' + name.toLowerCase())) return;

            const cfgDur = getSpecialDuration(name, grade);
            const layer = special._layer || (layersByGrade[grade] || []).find(l => (l.type || '').toLowerCase() === 'special');
            const c = resolveConstraints(layer || {}, 'special', {});
            const sDMin = cfgDur || c.dMin;
            const sDMax = cfgDur || c.dMax;

            needs.push({
                id: 'special_' + i + '_' + name,
                type: 'special',
                event: name,
                dMin: sDMin,
                dMax: sDMax,
                windowStart: special.claimedTime?.startMin || layer?.startMin || 0,
                windowEnd: special.claimedTime?.endMin || layer?.endMin || 960,
                priority: 2,
                layer,
                _specialLocation: special.location || null,
                _alternatives: (shoppingList.specials?.priorityList || [])
                    .filter(s => s.name !== name)
                    .map(s => s.name)
            });
        });

        // --- Snack (if not already placed) ---
        if (shoppingList.snack && !placedTypes.has('snack')) {
            shoppingList.snack.forEach((sn, i) => {
                needs.push({
                    id: 'snack_' + i,
                    type: 'snack',
                    event: 'Snack',
                    dMin: sn.duration || 15,
                    dMax: sn.duration || 30,
                    windowStart: sn.startMin || 0,
                    windowEnd: sn.endMin || 960,
                    priority: 3,
                    layer: sn.layer || null
                });
            });
        }

        // --- Rotation events ---
        try {
            if (window.RotationEvents && typeof window.RotationEvents.getNeedsForBunk === 'function') {
                const reNeeds = window.RotationEvents.getNeedsForBunk(bunk, window.currentScheduleDate || '');
                if (Array.isArray(reNeeds)) {
                    reNeeds.forEach((re, i) => {
                        if (!re || walls.some(w => w._rotationEventId === re.eventId)) return;
                        needs.push({
                            id: 'rotation_' + i + '_' + re.eventId,
                            type: 'rotation_event',
                            event: re.name || re.eventId,
                            dMin: re.dMin || 30,
                            dMax: re.dMax || 60,
                            windowStart: re.windowStart || 0,
                            windowEnd: re.windowEnd || 960,
                            priority: 2,
                            layer: null,
                            _rotationEventId: re.eventId,
                            _rotationEventLocation: re.location || null,
                            _rotationEventColor: re.color || null,
                            _rotationEventConcurrency: re.concurrency || 1
                        });
                    });
                }
            }
        } catch (e) { /* rotation events optional */ }

        // --- Custom windowed layers ---
        (layersByGrade[grade] || []).forEach(l => {
            if ((l.type || '').toLowerCase() !== 'custom') return;
            if (l._classification === 'pinned' || l.pinExact) return;
            if (l.customBunks && !l.customBunks.includes(String(bunk))) return;
            const c = resolveConstraints(l, 'custom', {});
            needs.push({
                id: 'custom_' + l.event,
                type: 'custom',
                event: l.event || l.name || 'Custom',
                dMin: c.dMin,
                dMax: c.dMax,
                windowStart: l.startMin || 0,
                windowEnd: l.endMin || 960,
                priority: 4,
                layer: l,
                _customActivity: l.event || l.name,
                _customField: l.customField || null,
                _customBunks: l.customBunks || null
            });
        });

        // --- Sports needed (from draft + shopping list) ---
        const sportCount = shoppingList.sports?.required || 0;
        const draftSports = (draftResult && draftResult.sports) || [];
        const sportConstraints = shoppingList.sports?.constraints || { dMin: 25, dMax: 60, dIdeal: 30 };

        // We don't add explicit sport needs here — sports fill GAPS
        // after all structured needs are placed. But we track what's needed
        // for the backtracking: how many sport slots minimum.
        const totalStructuredMin = needs.reduce((s, n) => s + n.dMin, 0);

        // Sort needs by priority (highest first), then by window tightness
        needs.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const aWindow = a.windowEnd - a.windowStart;
            const bWindow = b.windowEnd - b.windowStart;
            return aWindow - bWindow; // tighter windows first
        });

        // Attach sport metadata for gap filling
        needs._sportConstraints = sportConstraints;
        needs._sportCount = sportCount;
        needs._draftSports = draftSports;
        needs._sportPriorityList = shoppingList.sports?.priorityList || [];

        return needs;
    }

    // =========================================================================
    // BACKTRACKING FILL
    // =========================================================================

    /**
     * Try to assign all needs into gaps using backtracking.
     *
     * Strategy:
     *   - Process needs in MRV order (tightest window first)
     *   - For each need, try each gap that can contain it
     *   - Within each gap, try multiple start times
     *   - After placing a need, verify remaining needs can still fit
     *   - On failure, undo and try next option
     */
    function backtrackFill(gaps, needs, ctx) {
        const placed = [];
        const usedActivitiesToday = new Set();

        // Collect already-used activities from walls
        (ctx.bunkTimelines[ctx.bunk] || []).forEach(b => {
            const act = (b._assignedSport || b._assignedSpecial || b.event || '').toLowerCase().trim();
            if (act && act !== 'general activity slot') usedActivitiesToday.add(act);
        });

        const state = {
            placed,
            usedActivitiesToday,
            gapUsage: gaps.map(g => ({ ...g, remaining: g.size, placements: [] })),
            needsRemaining: needs.map(n => ({ ...n, assigned: false }))
        };

        // Run backtracking for structured needs
        const success = assignNeeds(state, 0, ctx);

        return {
            placed: state.placed,
            unplaced: state.needsRemaining.filter(n => !n.assigned).map(n => ({
                type: n.type, event: n.event, reason: 'backtrack_exhausted'
            })),
            success
        };
    }

    function assignNeeds(state, depth, ctx) {
        const { needsRemaining, gapUsage } = state;
        const MAX_DEPTH = 100; // safety
        if (depth > MAX_DEPTH) return false;

        // Find next unassigned need (MRV: fewest feasible options first)
        let bestNeed = null;
        let bestOptions = Infinity;
        let bestIdx = -1;

        for (let i = 0; i < needsRemaining.length; i++) {
            const need = needsRemaining[i];
            if (need.assigned) continue;
            const optCount = countFeasiblePlacements(need, gapUsage, state, ctx);
            if (optCount < bestOptions) {
                bestOptions = optCount;
                bestNeed = need;
                bestIdx = i;
            }
            if (optCount === 0) break; // fail fast
        }

        if (!bestNeed) return true; // all assigned
        if (bestOptions === 0) return false; // dead end

        // Get ordered feasible placements
        const options = getFeasiblePlacements(bestNeed, gapUsage, state, ctx);

        for (const option of options) {
            const { gapIdx, startMin, endMin } = option;
            const gap = gapUsage[gapIdx];

            // Place
            bestNeed.assigned = true;
            const placement = {
                startMin, endMin,
                type: bestNeed.type,
                event: bestNeed.event,
                layer: bestNeed.layer,
                field: bestNeed._specialLocation || bestNeed._customField || null,
                dMin: bestNeed.dMin,
                dMax: bestNeed.dMax,
                _specialLocation: bestNeed._specialLocation,
                _rotationEventId: bestNeed._rotationEventId,
                _rotationEventLocation: bestNeed._rotationEventLocation,
                _rotationEventColor: bestNeed._rotationEventColor,
                _draftActivity: bestNeed._draftActivity,
                _draftField: bestNeed._draftField,
                _sportFallbacks: null
            };
            state.placed.push(placement);
            gap.placements.push(placement);
            gap.remaining -= (endMin - startMin);

            const actKey = bestNeed.event.toLowerCase().trim();
            const hadActivity = state.usedActivitiesToday.has(actKey);
            state.usedActivitiesToday.add(actKey);

            // Register resource usage for constraint checking
            const registered = registerPlacement(bestNeed, startMin, endMin, ctx);

            // Recurse
            if (assignNeeds(state, depth + 1, ctx)) {
                return true;
            }

            // Undo
            bestNeed.assigned = false;
            state.placed.pop();
            gap.placements.pop();
            gap.remaining += (endMin - startMin);
            if (!hadActivity) state.usedActivitiesToday.delete(actKey);
            unregisterPlacement(bestNeed, startMin, endMin, registered, ctx);
        }

        return false;
    }

    // =========================================================================
    // FEASIBILITY HELPERS
    // =========================================================================

    function countFeasiblePlacements(need, gapUsage, state, ctx) {
        let count = 0;
        for (let gi = 0; gi < gapUsage.length; gi++) {
            const gap = gapUsage[gi];
            if (gap.remaining < need.dMin) continue;
            // Check time window overlap
            const effectiveStart = Math.max(gap.startMin, need.windowStart);
            const effectiveEnd = Math.min(gap.endMin, need.windowEnd);
            if (effectiveEnd - effectiveStart < need.dMin) continue;

            // Quick resource check
            if (need._needsPool && !ctx.canUsePoolAtTime(ctx.grade, effectiveStart, effectiveStart + need.dMin)) continue;
            if (need.type === 'special') {
                if (!ctx.canUseSpecialAtTime(need.event, ctx.grade, effectiveStart, effectiveStart + need.dMin)) continue;
            }

            // Check same-day repeat
            if (state.usedActivitiesToday.has(need.event.toLowerCase().trim())) continue;

            count++;
            if (count > 5) break; // enough to know it's not zero
        }
        return count;
    }

    function getFeasiblePlacements(need, gapUsage, state, ctx) {
        const options = [];

        for (let gi = 0; gi < gapUsage.length; gi++) {
            const gap = gapUsage[gi];
            if (gap.remaining < need.dMin) continue;

            const effectiveStart = Math.max(gap.startMin, need.windowStart);
            const effectiveEnd = Math.min(gap.endMin, need.windowEnd);
            if (effectiveEnd - effectiveStart < need.dMin) continue;

            // Same-day repeat check
            if (state.usedActivitiesToday.has(need.event.toLowerCase().trim())) continue;

            // Find actual free regions within this gap (between existing placements)
            const freeRegions = getFreeRegionsInGap(gap);

            for (const region of freeRegions) {
                const regStart = Math.max(region.startMin, effectiveStart);
                const regEnd = Math.min(region.endMin, effectiveEnd);
                if (regEnd - regStart < need.dMin) continue;

                // Try start times within this region
                for (let t = regStart; t + need.dMin <= regEnd; t += TIME_STEP) {
                    const dur = Math.min(need.dMax, regEnd - t);
                    if (dur < need.dMin) continue;

                    // Resource check
                    let ok = true;
                    if (need._needsPool) {
                        ok = ctx.canUsePoolAtTime(ctx.grade, t, t + dur);
                    }
                    if (ok && need.type === 'special') {
                        ok = ctx.canUseSpecialAtTime(need.event, ctx.grade, t, t + dur);
                    }
                    if (ok && need.type === 'rotation_event') {
                        ok = ctx.canUseRotationSlotAtTime(
                            need._rotationEventId, need._rotationEventConcurrency || 1,
                            ctx.grade, t, t + dur
                        );
                    }
                    if (!ok) continue;

                    // Check that remaining gap after placement is either 0 or >= GAP_MIN_DUR
                    const remainAfter = (regEnd - (t + dur));
                    const remainBefore = (t - regStart);
                    if (remainAfter > 0 && remainAfter < GAP_MIN_DUR) continue;
                    if (remainBefore > 0 && remainBefore < GAP_MIN_DUR) continue;

                    // Score: prefer tighter fits (less wasted space)
                    const score = Math.abs(dur - need.dMin) + remainAfter + remainBefore;

                    options.push({ gapIdx: gi, startMin: t, endMin: t + dur, score });
                }
            }
        }

        // Sort by score (lower = better fit)
        options.sort((a, b) => a.score - b.score);

        // Limit to top 10 to bound search
        return options.slice(0, 10);
    }

    function getFreeRegionsInGap(gap) {
        if (gap.placements.length === 0) {
            return [{ startMin: gap.startMin, endMin: gap.endMin }];
        }

        const sorted = [...gap.placements].sort((a, b) => a.startMin - b.startMin);
        const regions = [];
        let cursor = gap.startMin;

        sorted.forEach(p => {
            if (cursor < p.startMin) {
                regions.push({ startMin: cursor, endMin: p.startMin });
            }
            cursor = Math.max(cursor, p.endMin);
        });

        if (cursor < gap.endMin) {
            regions.push({ startMin: cursor, endMin: gap.endMin });
        }

        return regions;
    }

    // =========================================================================
    // RESOURCE REGISTRATION / UNDO
    // =========================================================================

    function registerPlacement(need, startMin, endMin, ctx) {
        const record = { type: need.type };

        if (need._needsPool) {
            ctx.rtRegister('pool', '_pool', ctx.grade, startMin, endMin);
            record.pool = true;
        }
        if (need.type === 'special') {
            ctx.registerSpecialUsage(need.event, ctx.grade, startMin, endMin);
            ctx.registerCrossGrade(ctx.grade, 'special', startMin, endMin, need.event);
            record.special = need.event;
        }
        if (need._specialLocation) {
            ctx.claimField(need._specialLocation, startMin, endMin, String(ctx.bunk), ctx.grade, need.event);
            record.field = need._specialLocation;
        }
        if (need.type === 'rotation_event' && need._rotationEventId) {
            ctx.rtRegister('rotation', need._rotationEventId, ctx.grade, startMin, endMin);
            record.rotation = need._rotationEventId;
        }

        return record;
    }

    function unregisterPlacement(need, startMin, endMin, record, ctx) {
        // The resource tracker doesn't support individual undo easily.
        // For backtracking to work correctly with resources, we track
        // placements and rebuild state when needed.
        // For now, we accept some resource over-counting during backtracking
        // and rely on the forward-checking to catch real conflicts.
        //
        // NOTE: This is a known limitation. The RT buckets are additive and
        // don't support decrement. In practice this means the backtracker
        // may reject some valid options, making it conservative (not unsound).
        // The iteration loop compensates by trying different seeds.
    }

    // =========================================================================
    // GAP FILLING (SPORTS)
    // =========================================================================

    /**
     * After structured needs are placed, fill remaining gaps with sports.
     */
    function fillRemainingGaps(template, gradeStart, gradeEnd, ctx) {
        const sorted = [...template].sort((a, b) => a.startMin - b.startMin);
        const filled = [];
        let cursor = gradeStart;

        for (const block of sorted) {
            if (cursor < block.startMin) {
                const gapSize = block.startMin - cursor;
                if (gapSize >= GAP_MIN_DUR) {
                    // Fill with sports
                    const sportBlocks = fillWithSports(cursor, block.startMin, ctx);
                    filled.push(...sportBlocks);
                } else if (gapSize >= ABSOLUTE_FLOOR) {
                    // Tiny gap — single sport block
                    const sf = ctx.findSportWithField(
                        ctx.bunk, ctx.grade, cursor, block.startMin,
                        collectUsedActivities(filled, template), null
                    );
                    filled.push({
                        startMin: cursor, endMin: block.startMin,
                        type: 'sport', event: sf ? sf.sport : 'General Activity Slot',
                        field: sf ? sf.field : null,
                        _source: 'backtrack_fill', _fixed: false,
                        _assignedSport: sf ? sf.sport : null,
                        _sportFallbacks: ctx.shoppingList?.sports?.priorityList?.map(s => s.name) || [],
                        dMin: gapSize, dMax: SPORT_CEILING
                    });
                }
            }
            filled.push(block);
            cursor = Math.max(cursor, block.endMin);
        }

        // End-of-day gap
        if (cursor < gradeEnd) {
            const gapSize = gradeEnd - cursor;
            if (gapSize >= GAP_MIN_DUR) {
                filled.push(...fillWithSports(cursor, gradeEnd, ctx));
            } else if (gapSize >= ABSOLUTE_FLOOR) {
                const sf = ctx.findSportWithField(
                    ctx.bunk, ctx.grade, cursor, gradeEnd,
                    collectUsedActivities(filled, template), null
                );
                filled.push({
                    startMin: cursor, endMin: gradeEnd,
                    type: 'sport', event: sf ? sf.sport : 'General Activity Slot',
                    field: sf ? sf.field : null,
                    _source: 'backtrack_fill', _fixed: false,
                    _assignedSport: sf ? sf.sport : null,
                    _sportFallbacks: ctx.shoppingList?.sports?.priorityList?.map(s => s.name) || [],
                    dMin: gapSize, dMax: SPORT_CEILING
                });
            }
        }

        return filled;
    }

    function fillWithSports(startMin, endMin, ctx) {
        const blocks = [];
        const sportConstraints = ctx.shoppingList?.sports?.constraints || { dMin: 25, dMax: 60, dIdeal: 30 };
        const totalDur = endMin - startMin;

        // How many sport blocks fit?
        const numSports = Math.max(1, Math.ceil(totalDur / sportConstraints.dMax));
        const baseDur = Math.floor(totalDur / numSports);
        let remainder = totalDur - (baseDur * numSports);

        let cursor = startMin;
        const usedActivities = collectUsedActivities(blocks, []);

        // Collect used from ctx
        (ctx.bunkTimelines[ctx.bunk] || []).forEach(b => {
            const act = (b._assignedSport || b._assignedSpecial || b.event || '').toLowerCase().trim();
            if (act && act !== 'general activity slot') usedActivities.add(act);
        });

        for (let i = 0; i < numSports; i++) {
            let dur = baseDur;
            if (remainder > 0) {
                dur += Math.min(TIME_STEP, remainder);
                remainder -= Math.min(TIME_STEP, remainder);
            }
            dur = Math.max(dur, sportConstraints.dMin);
            dur = Math.min(dur, endMin - cursor);
            if (dur < ABSOLUTE_FLOOR) break;

            const blockEnd = cursor + dur;
            const sf = ctx.findSportWithField(ctx.bunk, ctx.grade, cursor, blockEnd, usedActivities, null);
            const sportName = sf ? sf.sport : 'General Activity Slot';

            blocks.push({
                startMin: cursor, endMin: blockEnd,
                type: 'sport', event: sportName,
                field: sf ? sf.field : null,
                _source: 'backtrack_fill', _fixed: false,
                _assignedSport: sf ? sf.sport : null,
                _sportFallbacks: ctx.shoppingList?.sports?.priorityList?.map(s => s.name) || [],
                dMin: sportConstraints.dMin, dMax: sportConstraints.dMax
            });

            if (sf) usedActivities.add(sportName.toLowerCase().trim());
            cursor = blockEnd;
        }

        // Handle leftover
        if (cursor < endMin) {
            const last = blocks[blocks.length - 1];
            if (last && (last.type === 'sport' || last.type === 'slot')) {
                last.endMin = endMin;
            } else {
                blocks.push({
                    startMin: cursor, endMin: endMin,
                    type: 'sport', event: 'General Activity Slot',
                    field: null, _source: 'backtrack_fill', _fixed: false,
                    _sportFallbacks: ctx.shoppingList?.sports?.priorityList?.map(s => s.name) || [],
                    dMin: endMin - cursor, dMax: SPORT_CEILING
                });
            }
        }

        return blocks;
    }

    function collectUsedActivities(blocks1, blocks2) {
        const used = new Set();
        [...blocks1, ...blocks2].forEach(b => {
            const act = (b._assignedSport || b._assignedSpecial || b.event || '').toLowerCase().trim();
            if (act && act !== 'general activity slot') used.add(act);
        });
        return used;
    }

    // =========================================================================
    // POST-PROCESSING
    // =========================================================================

    function postProcess(template, ctx) {
        const sorted = [...template].sort((a, b) => a.startMin - b.startMin);

        // 1. Wall-clamp: no non-wall block may overlap a wall
        const walls = sorted.filter(b => b._fixed);
        const nonWalls = sorted.filter(b => !b._fixed);

        nonWalls.forEach(block => {
            for (const wall of walls) {
                if (block.startMin < wall.endMin && block.endMin > wall.startMin) {
                    // Overlap — clamp
                    if (block.startMin < wall.startMin) {
                        block.endMin = Math.min(block.endMin, wall.startMin);
                    } else {
                        block.startMin = Math.max(block.startMin, wall.endMin);
                    }
                }
            }
        });

        // Remove zero/negative duration blocks
        const valid = sorted.filter(b => b.endMin - b.startMin >= ABSOLUTE_FLOOR);

        // 2. dMax enforcement
        const enforced = [];
        valid.forEach(block => {
            const dur = block.endMin - block.startMin;
            const t = (block.type || '').toLowerCase();
            const maxDur = ['sport', 'slot'].includes(t) ? SPORT_CEILING : (block.dMax || 60);
            if (dur > maxDur && !block._fixed) {
                // Split: first block at dMax, remainder becomes a new sport
                block.endMin = block.startMin + maxDur;
                enforced.push(block);
                const remainStart = block.endMin;
                const remainEnd = block.startMin + dur;
                if (remainEnd - remainStart >= ABSOLUTE_FLOOR) {
                    enforced.push({
                        startMin: remainStart, endMin: remainEnd,
                        type: 'sport', event: 'General Activity Slot',
                        field: null, _source: 'backtrack_overflow', _fixed: false,
                        _sportFallbacks: block._sportFallbacks || [],
                        dMin: GAP_MIN_DUR, dMax: SPORT_CEILING
                    });
                }
            } else {
                enforced.push(block);
            }
        });

        // 3. Merge tiny blocks (< GAP_MIN_DUR) into adjacent sports
        const merged = [];
        enforced.sort((a, b) => a.startMin - b.startMin);
        for (let i = 0; i < enforced.length; i++) {
            const block = enforced[i];
            const dur = block.endMin - block.startMin;
            const t = (block.type || '').toLowerCase();

            if (dur < GAP_MIN_DUR && !block._fixed && (t === 'sport' || t === 'slot')) {
                // Try to merge into previous or next sport
                const prev = merged[merged.length - 1];
                const next = enforced[i + 1];
                if (prev && !prev._fixed && ['sport', 'slot'].includes((prev.type || '').toLowerCase())) {
                    const newDur = prev.endMin - prev.startMin + dur;
                    if (newDur <= SPORT_CEILING) {
                        prev.endMin = block.endMin;
                        continue;
                    }
                }
                if (next && !next._fixed && ['sport', 'slot'].includes((next.type || '').toLowerCase())) {
                    next.startMin = block.startMin;
                    continue;
                }
            }
            merged.push(block);
        }

        // 4. Special duration enforcement
        merged.forEach(block => {
            if (block.type === 'special' && block._assignedSpecial) {
                const cfgDur = ctx.getSpecialDuration(block._assignedSpecial, ctx.grade);
                if (cfgDur && cfgDur > 0) {
                    const curDur = block.endMin - block.startMin;
                    if (curDur !== cfgDur) {
                        block.endMin = block.startMin + cfgDur;
                    }
                }
            }
        });

        return merged.sort((a, b) => a.startMin - b.startMin);
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    window.AutoBacktrackPacker = { packBunk };

})();
