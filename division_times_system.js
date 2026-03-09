// =============================================================================
// division_times_system.js v2.0 — CAMPISTRY PER-DIVISION TIME SLOT SYSTEM
// =============================================================================
// v2.0: Per-bunk slot arrays for auto mode. Each bunk gets its own slot
//        timeline matching their skeleton blocks exactly.
// v1.3: Skeleton events clipped to division boundaries
// v1.2: Split tile expansion, exact time range finder
// v1.1: Delegated lookup/utility functions to SchedulerCoreUtils
// =============================================================================

(function() {
    'use strict';

    const VERSION = '2.0.0';
    const DEBUG = true;

    function log(...args) {
        if (DEBUG) console.log('[DivisionTimes]', ...args);
    }

    // =========================================================================
    // TIME PARSING UTILITIES
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase();
        let meridian = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridian = s.slice(-2);
            s = s.slice(0, -2).trim();
        } else if (s.includes(' am') || s.includes(' pm')) {
            meridian = s.includes(' am') ? 'am' : 'pm';
            s = s.replace(/ am| pm/g, '').trim();
        }
        const match = s.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) return null;
        if (meridian === 'pm' && hours !== 12) hours += 12;
        if (meridian === 'am' && hours === 12) hours = 0;
        if (!meridian && hours >= 1 && hours <= 7) hours += 12;
        return hours * 60 + minutes;
    }

    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        let h = Math.floor(mins / 60);
        let m = mins % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

    function minutesToDate(mins) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setMinutes(mins);
        return d;
    }

    // =========================================================================
    // SPLIT TILE EXPANSION
    // =========================================================================

    function expandSplitTiles(blocks) {
        const expanded = [];
        blocks.forEach(block => {
            if (block.type === 'split') {
                const midMin = Math.floor((block.startMin + block.endMin) / 2);
                let act1Name = 'Activity 1', act2Name = 'Activity 2';
                if (block.subEvents && block.subEvents.length >= 2) {
                    act1Name = block.subEvents[0]?.event || block.subEvents[0] || 'Activity 1';
                    act2Name = block.subEvents[1]?.event || block.subEvents[1] || 'Activity 2';
                } else if (block.event && block.event.includes('/')) {
                    const parts = block.event.split('/').map(s => s.trim());
                    act1Name = parts[0] || 'Activity 1';
                    act2Name = parts[1] || 'Activity 2';
                }
                expanded.push({
                    ...block, id: (block.id || Date.now()) + '_half1',
                    startMin: block.startMin, endMin: midMin, event: act1Name,
                    type: 'split_half', _splitHalf: 1, _splitParentEvent: block.event,
                    _splitAct1: act1Name, _splitAct2: act2Name,
                    _originalStartMin: block.startMin, _originalEndMin: block.endMin
                });
                expanded.push({
                    ...block, id: (block.id || Date.now()) + '_half2',
                    startMin: midMin, endMin: block.endMin, event: act2Name,
                    type: 'split_half', _splitHalf: 2, _splitParentEvent: block.event,
                    _splitAct1: act1Name, _splitAct2: act2Name,
                    _originalStartMin: block.startMin, _originalEndMin: block.endMin
                });
            } else {
                expanded.push(block);
            }
        });
        return expanded;
    }

    // =========================================================================
    // CORE: BUILD DIVISION TIMES FROM SKELETON
    // =========================================================================

    function buildDivisionTimesFromSkeleton(skeleton, divisions) {
        log('Building division times from skeleton...');
        log(`  Skeleton items: ${skeleton?.length || 0}`);
        log(`  Divisions: ${Object.keys(divisions || {}).join(', ')}`);

        if (!skeleton || skeleton.length === 0) {
            log('  Empty skeleton, returning empty divisionTimes');
            return {};
        }

        const divisionTimes = {};

        // Group skeleton blocks by division
        const byDivision = {};
        skeleton.forEach(block => {
            const div = block.division;
            if (!div) return;
            if (!byDivision[div]) byDivision[div] = [];
            byDivision[div].push(block);
        });

        for (const [divName, blocks] of Object.entries(byDivision)) {
            const hasBunkBlocks = blocks.some(b => b._bunk);

            // ═══════════════════════════════════════════════════════
            // AUTO MODE: Per-bunk slot arrays
            // ═══════════════════════════════════════════════════════
            if (hasBunkBlocks) {
                log(`  ★ Division ${divName} has per-bunk blocks — building PER-BUNK slot arrays`);

                const divWideBlocks = blocks.filter(b => !b._bunk);
                const perBunkBlocksMap = {};

                blocks.forEach(b => {
                    if (!b._bunk) return;
                    const bk = String(b._bunk);
                    if (!perBunkBlocksMap[bk]) perBunkBlocksMap[bk] = [];
                    perBunkBlocksMap[bk].push(b);
                });

                const divBunks = (divisions[divName]?.bunks || []).map(String);
                const perBunkSlots = {};

                divBunks.forEach(bunk => {
                    const bunkBlocks = divWideBlocks.concat(perBunkBlocksMap[bunk] || []);

                    const parsed = bunkBlocks.map(b => {
                        const s = parseTimeToMinutes(b.startTime);
                        const e = parseTimeToMinutes(b.endTime);
                        return { ...b, startMin: s, endMin: e };
                    }).filter(b => b.startMin !== null && b.endMin !== null && b.endMin > b.startMin);

                    parsed.sort((a, b) => a.startMin - b.startMin);

                    const divConfig = (divisions || {})[divName];
                    const divStartMin = divConfig?.startTime ? parseTimeToMinutes(divConfig.startTime) : null;
                    const divEndMin = divConfig?.endTime ? parseTimeToMinutes(divConfig.endTime) : null;

                    const clipped = (divStartMin !== null && divEndMin !== null)
                        ? parsed.filter(b => b.endMin > divStartMin && b.startMin < divEndMin).map(b => ({
                            ...b,
                            startMin: Math.max(b.startMin, divStartMin),
                            endMin: Math.min(b.endMin, divEndMin)
                        })).filter(b => b.endMin - b.startMin >= 5)
                        : parsed;

                    perBunkSlots[bunk] = clipped.map((b, idx) => ({
                        slotIndex: idx,
                        startMin: b.startMin,
                        endMin: b.endMin,
                        duration: b.endMin - b.startMin,
                        event: b.event || 'GA',
                        type: b.type || 'slot',
                        division: divName,
                        label: minutesToTimeLabel(b.startMin) + ' - ' + minutesToTimeLabel(b.endMin),
                        _bunk: bunk,
                        _suggestedActivity: b._suggestedActivity || null,
                        _autoGenerated: b._autoGenerated || false,
                        _durationStrict: b._durationStrict || false,
                        _splitHalf: b._splitHalf,
                        _splitParentEvent: b._splitParentEvent,
                        _isSplitTile: !!b._splitHalf,
                        start: minutesToDate(b.startMin),
                        end: minutesToDate(b.endMin)
                    }));

                    log(`    Bunk ${bunk}: ${perBunkSlots[bunk].length} slots`);
                });

                const firstBunk = divBunks[0];
                const divSlots = perBunkSlots[firstBunk] || [];
                divSlots._perBunkSlots = perBunkSlots;
                divSlots._isPerBunk = true;

                divisionTimes[divName] = divSlots;
                log(`    Division ${divName}: per-bunk mode, ${divBunks.length} bunks, ${divSlots.length} base slots`);
                continue; // Skip normal processing for this division
            }

            // ═══════════════════════════════════════════════════════
            // MANUAL MODE: Shared slot array (existing behavior)
            // ═══════════════════════════════════════════════════════

            const parsed = blocks
                .map(b => ({
                    ...b,
                    startMin: parseTimeToMinutes(b.startTime),
                    endMin: parseTimeToMinutes(b.endTime)
                }))
                .filter(b => b.startMin !== null && b.endMin !== null && b.endMin > b.startMin);

            parsed.sort((a, b) => a.startMin - b.startMin);

            const divConfig = (divisions || {})[divName];
            const divStartMin = divConfig?.startTime ? parseTimeToMinutes(divConfig.startTime) : null;
            const divEndMin = divConfig?.endTime ? parseTimeToMinutes(divConfig.endTime) : null;

            const validated = (divStartMin !== null && divEndMin !== null)
                ? parsed.reduce((acc, block) => {
                    if (block.endMin <= divStartMin || block.startMin >= divEndMin) return acc;
                    if (block.startMin < divStartMin || block.endMin > divEndMin) {
                        const cs = Math.max(block.startMin, divStartMin);
                        const ce = Math.min(block.endMin, divEndMin);
                        if (ce - cs < 5) return acc;
                        acc.push({ ...block, startMin: cs, endMin: ce });
                        return acc;
                    }
                    acc.push(block);
                    return acc;
                }, [])
                : parsed;

            const withExpandedSplits = expandSplitTiles(validated);
            withExpandedSplits.sort((a, b) => a.startMin - b.startMin);

            const consolidated = consolidateBlocks(withExpandedSplits);

            divisionTimes[divName] = consolidated.map((block, idx) => ({
                slotIndex: idx,
                startMin: block.startMin,
                endMin: block.endMin,
                duration: block.endMin - block.startMin,
                event: block.event || 'Activity',
                type: block.type || 'slot',
                label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
                _originalId: block.id,
                _subEvents: block.subEvents,
                _smartData: block.smartData,
                _splitHalf: block._splitHalf,
                _splitParentEvent: block._splitParentEvent,
                _splitAct1: block._splitAct1,
                _splitAct2: block._splitAct2,
                _originalStartMin: block._originalStartMin,
                _originalEndMin: block._originalEndMin,
                start: minutesToDate(block.startMin),
                end: minutesToDate(block.endMin)
            }));

            log(`  ${divName}: ${divisionTimes[divName].length} slots`);
        }

        // Ensure all divisions have an entry
        Object.keys(divisions || {}).forEach(divName => {
            if (!divisionTimes[divName]) {
                divisionTimes[divName] = [];
                log(`  ${divName}: 0 slots (no skeleton blocks)`);
            }
        });

        log(`Built divisionTimes for ${Object.keys(divisionTimes).length} divisions`);
        return divisionTimes;
    }

    // =========================================================================
    // CONSOLIDATE OVERLAPPING BLOCKS
    // =========================================================================

    function consolidateBlocks(blocks) {
        if (blocks.length === 0) return [];
        const result = [];
        let current = { ...blocks[0] };
        for (let i = 1; i < blocks.length; i++) {
            const next = blocks[i];
            if (next.startMin < current.endMin) {
                if (next.startMin === current.startMin && next.endMin === current.endMin) continue;
                result.push(current);
                current = { ...next };
            } else {
                result.push(current);
                current = { ...next };
            }
        }
        result.push(current);
        return result;
    }

    // =========================================================================
    // SLOT LOOKUP HELPERS
    // =========================================================================

    function findSlotForBunkAtTime(bunkName, targetMin) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        if (!divName) return -1;
        return window.SchedulerCoreUtils?.findSlotForTime(divName, targetMin);
    }

   function findExactSlotForTimeRange(divisionName, startMin, endMin, bunkName) {
    const divSlots = window.divisionTimes?.[String(divisionName)] || [];
    // ★★★ FIX: In per-bunk mode, use THIS bunk's slot array, not the base array ★★★
    const slots = (bunkName && divSlots._isPerBunk && divSlots._perBunkSlots)
        ? (divSlots._perBunkSlots[String(bunkName)] || divSlots)
        : divSlots;
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].startMin === startMin && slots[i].endMin === endMin) return i;
    }
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].startMin <= startMin && slots[i].endMin >= endMin) return i;
    }
    return -1;
}

    // =========================================================================
    // FIELD USAGE TRACKING
    // =========================================================================

    function createFieldUsageTracker() {
        const _usage = {};
        return {
            register(fieldName, startMin, endMin, division, bunk, activity) {
                if (!fieldName || startMin === null || endMin === null) return false;
                const key = fieldName.toLowerCase().trim();
                if (!_usage[key]) _usage[key] = [];
                _usage[key].push({ startMin, endMin, division, bunk, activity, registeredAt: Date.now() });
                return true;
            },
            checkAvailability(fieldName, startMin, endMin, capacity = 1, excludeBunk = null) {
                const key = fieldName.toLowerCase().trim();
                const usages = _usage[key] || [];
                const conflicts = usages.filter(u => {
                    if (excludeBunk && u.bunk === excludeBunk) return false;
                    return !(endMin <= u.startMin || startMin >= u.endMin);
                });
                return { available: conflicts.length < capacity, currentUsage: conflicts.length, capacity, conflicts };
            },
            getUsages(fieldName) { return _usage[fieldName.toLowerCase().trim()] || []; },
            clear() { Object.keys(_usage).forEach(k => delete _usage[k]); },
            getRawData() { return { ..._usage }; }
        };
    }

    // =========================================================================
    // BACKWARDS COMPATIBILITY
    // =========================================================================

    function mapUnifiedSlotToDivision(unifiedSlotIndex, divisionName) {
        const unifiedTimes = window.unifiedTimes || [];
        if (!unifiedTimes[unifiedSlotIndex]) return -1;
        const targetStart = unifiedTimes[unifiedSlotIndex].startMin;
        return window.SchedulerCoreUtils?.findSlotForTime(divisionName, targetStart);
    }

    function buildUnifiedTimesFromDivisionTimes(divisionTimes) {
        if (!divisionTimes || Object.keys(divisionTimes).length === 0) return [];
        const timePoints = new Set();
        Object.values(divisionTimes).forEach(slots => {
            (slots || []).forEach(slot => {
                if (slot.startMin !== undefined) timePoints.add(slot.startMin);
                if (slot.endMin !== undefined) timePoints.add(slot.endMin);
            });
        });
        const sortedTimes = [...timePoints].sort((a, b) => a - b);
        const unifiedTimes = [];
        for (let i = 0; i < sortedTimes.length - 1; i++) {
            const startMin = sortedTimes[i], endMin = sortedTimes[i + 1];
            if (endMin - startMin < 5) continue;
            unifiedTimes.push({
                slotIndex: unifiedTimes.length, startMin, endMin,
                duration: endMin - startMin,
                label: `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}`,
                start: minutesToDate(startMin), end: minutesToDate(endMin)
            });
        }
        log(`Built unified times: ${unifiedTimes.length} slots`);
        return unifiedTimes;
    }

    // =========================================================================
    // SERIALIZATION — v2.0: Handles per-bunk data
    // =========================================================================

    function serializeDivisionTimes(divisionTimes) {
        if (!divisionTimes) return {};
        const serialized = {};

        for (const [divName, slots] of Object.entries(divisionTimes)) {
            if (slots._isPerBunk && slots._perBunkSlots) {
                serialized[divName] = {
                    _isPerBunk: true,
                    _perBunkSlots: {}
                };
                for (const [bunk, bunkSlots] of Object.entries(slots._perBunkSlots)) {
                    serialized[divName]._perBunkSlots[bunk] = bunkSlots.map(slot => ({
                        slotIndex: slot.slotIndex, startMin: slot.startMin, endMin: slot.endMin,
                        duration: slot.duration, event: slot.event, type: slot.type, label: slot.label,
                        _bunk: slot._bunk, _suggestedActivity: slot._suggestedActivity,
                        _autoGenerated: slot._autoGenerated, _durationStrict: slot._durationStrict,
                        _splitHalf: slot._splitHalf, _splitParentEvent: slot._splitParentEvent
                    }));
                }
                continue;
            }
            serialized[divName] = slots.map(slot => ({
                slotIndex: slot.slotIndex, startMin: slot.startMin, endMin: slot.endMin,
                duration: slot.duration, event: slot.event, type: slot.type, label: slot.label,
                start: slot.start instanceof Date ? slot.start.toISOString() : slot.start,
                end: slot.end instanceof Date ? slot.end.toISOString() : slot.end,
                _originalId: slot._originalId, _subEvents: slot._subEvents, _smartData: slot._smartData,
                _splitHalf: slot._splitHalf, _splitParentEvent: slot._splitParentEvent,
                _splitAct1: slot._splitAct1, _splitAct2: slot._splitAct2,
                _originalStartMin: slot._originalStartMin, _originalEndMin: slot._originalEndMin
            }));
        }
        return serialized;
    }

    function deserializeDivisionTimes(serialized) {
        if (!serialized) return {};
        const divisionTimes = {};

        for (const [divName, data] of Object.entries(serialized)) {
            if (data && data._isPerBunk && data._perBunkSlots) {
                const perBunkSlots = {};
                let firstBunkSlots = null;
                for (const [bunk, bunkSlots] of Object.entries(data._perBunkSlots)) {
                    perBunkSlots[bunk] = (bunkSlots || []).map(slot => ({
                        ...slot,
                        start: minutesToDate(slot.startMin),
                        end: minutesToDate(slot.endMin),
                        duration: slot.duration || (slot.endMin - slot.startMin)
                    }));
                    if (!firstBunkSlots) firstBunkSlots = perBunkSlots[bunk];
                }
                const divSlots = firstBunkSlots || [];
                divSlots._perBunkSlots = perBunkSlots;
                divSlots._isPerBunk = true;
                divisionTimes[divName] = divSlots;
                continue;
            }
            divisionTimes[divName] = (Array.isArray(data) ? data : []).map(slot => ({
                ...slot,
                start: new Date(slot.start),
                end: new Date(slot.end),
                startMin: slot.startMin,
                endMin: slot.endMin,
                duration: slot.duration || (slot.endMin - slot.startMin),
                slotIndex: slot.slotIndex
            }));
        }
        return divisionTimes;
    }

    // =========================================================================
    // ASSIGNMENT HELPERS
    // =========================================================================

    function initializeBunkAssignments(bunkName) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        const slots = window.SchedulerCoreUtils?.getSlotsForDivision(divName) || [];
        const slotCount = slots.length || 20;
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.scheduleAssignments[bunkName]) {
            window.scheduleAssignments[bunkName] = new Array(slotCount).fill(null);
        } else if (window.scheduleAssignments[bunkName].length < slotCount) {
            const current = window.scheduleAssignments[bunkName];
            window.scheduleAssignments[bunkName] = new Array(slotCount).fill(null);
            current.forEach((val, i) => { window.scheduleAssignments[bunkName][i] = val; });
        }
        return window.scheduleAssignments[bunkName];
    }

    function getAssignmentAtTime(bunkName, targetMin) {
        const slotIdx = findSlotForBunkAtTime(bunkName, targetMin);
        if (slotIdx === -1) return null;
        return window.scheduleAssignments?.[bunkName]?.[slotIdx] || null;
    }

    function setAssignment(bunkName, slotIndex, assignmentData) {
        const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunkName);
        const slot = window.SchedulerCoreUtils?.getSlotAtIndex(divName, slotIndex);
        initializeBunkAssignments(bunkName);
        const enrichedData = {
            ...assignmentData,
            _startMin: slot?.startMin, _endMin: slot?.endMin,
            _slotIndex: slotIndex, _division: divName
        };
        window.scheduleAssignments[bunkName][slotIndex] = enrichedData;
        return enrichedData;
    }

    // =========================================================================
    // DIAGNOSTIC & FIX FUNCTIONS
    // =========================================================================

    function diagnose() {
        console.log('\n' + '='.repeat(70));
        console.log('DIVISION TIMES SYSTEM DIAGNOSTIC v2.0');
        console.log('='.repeat(70));
        const divisionTimes = window.divisionTimes || {};
        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            const isPerBunk = !!slots._isPerBunk;
            console.log(`\n${divName}: ${slots.length} slots ${isPerBunk ? '(PER-BUNK MODE)' : '(shared)'}`);
            if (isPerBunk && slots._perBunkSlots) {
                Object.entries(slots._perBunkSlots).forEach(([bunk, bSlots]) => {
                    console.log(`  Bunk ${bunk}: ${bSlots.length} slots`);
                    bSlots.forEach((s, i) => console.log(`    [${i}] ${s.label} ${s.event} (${s.type}) ${s._suggestedActivity ? '[suggest:' + s._suggestedActivity + ']' : ''}`));
                });
            } else {
                slots.forEach((s, i) => console.log(`  [${i}] ${s.label} ${s.event} (${s.type})`));
            }
        });
        console.log('\n' + '='.repeat(70));
    }

    function fixAllBunkSlotCounts() {
        console.log('[DivisionTimes] Fixing all bunk slot counts...');
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        let fixedCount = 0, errorCount = 0;

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk);
            if (!divName) { errorCount++; return; }

            const divSlots = divisionTimes[divName] || [];
            const perBunkSlots = divSlots._perBunkSlots;
            const expectedSlots = (perBunkSlots && perBunkSlots[String(bunk)])
                ? perBunkSlots[String(bunk)].length
                : divSlots.length;

            if (expectedSlots === 0) { errorCount++; return; }
            if ((slots?.length || 0) !== expectedSlots) {
                const newArr = new Array(expectedSlots).fill(null);
                for (let i = 0; i < Math.min(slots?.length || 0, expectedSlots); i++) newArr[i] = slots[i];
                window.scheduleAssignments[bunk] = newArr;
                fixedCount++;
            }
        });
        console.log(`[DivisionTimes] Fixed ${fixedCount} bunks, ${errorCount} errors`);
        return { fixed: fixedCount, errors: errorCount };
    }

    function fillMissingPinnedSlots() {
        console.log('[DivisionTimes] Filling missing pinned slots...');
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        let filledCount = 0;

        Object.entries(divisionTimes).forEach(([divName, slots]) => {
            const divBunks = (divisions[divName]?.bunks || []).map(b => String(b));
            const allBunks = [...new Set([...divBunks, ...Object.keys(assignments).filter(b => window.SchedulerCoreUtils?.getDivisionForBunk(b) === divName)])];

            // For per-bunk mode, check each bunk's own slots
            if (slots._isPerBunk && slots._perBunkSlots) {
                allBunks.forEach(bunk => {
                    const bunkSlots = slots._perBunkSlots[bunk] || [];
                    bunkSlots.forEach((slot, idx) => {
                        if (slot.type !== 'pinned') return;
                        if (!assignments[bunk]) assignments[bunk] = new Array(bunkSlots.length).fill(null);
                        if (!assignments[bunk][idx]) {
                            assignments[bunk][idx] = {
                                field: slot.event, sport: null, _fixed: true, _activity: slot.event,
                                _pinned: true, _startMin: slot.startMin, _endMin: slot.endMin,
                                _slotIndex: idx, _division: divName, _autoFilled: true
                            };
                            filledCount++;
                        }
                    });
                });
                return;
            }

            // Shared mode
            slots.forEach((slot, idx) => {
                if (slot.type !== 'pinned') return;
                allBunks.forEach(bunk => {
                    if (!assignments[bunk]) assignments[bunk] = new Array(slots.length).fill(null);
                    if (!assignments[bunk][idx]) {
                        assignments[bunk][idx] = {
                            field: slot.event, sport: null, _fixed: true, _activity: slot.event,
                            _pinned: true, _startMin: slot.startMin, _endMin: slot.endMin,
                            _slotIndex: idx, _division: divName, _autoFilled: true
                        };
                        filledCount++;
                    }
                });
            });
        });
        console.log(`[DivisionTimes] Filled ${filledCount} missing pinned slots`);
        return filledCount;
    }

    function diagnoseBunkSlots() {
        console.log('\n' + '='.repeat(70));
        console.log('DIVISION TIMES BUNK DIAGNOSTIC v2.0');
        console.log('='.repeat(70));
        const divisionTimes = window.divisionTimes || {};
        const assignments = window.scheduleAssignments || {};
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = window.SchedulerCoreUtils?.getDivisionForBunk(bunk);
            const divSlots = divisionTimes[divName] || [];
            const perBunkSlots = divSlots._perBunkSlots;
            const expected = (perBunkSlots && perBunkSlots[String(bunk)])
                ? perBunkSlots[String(bunk)].length : divSlots.length;
            const actual = slots?.length || 0;
            const match = actual === expected ? 'OK' : 'MISMATCH';
            console.log(`  ${bunk} (${divName}): ${actual} slots, expected ${expected} — ${match}`);
        });
        console.log('='.repeat(70));
    }

    // =========================================================================
    // GENERATION COMPLETE HOOK
    // =========================================================================

    function setupGenerationCompleteHook() {
        window.addEventListener('campistry-generation-complete', function() {
            setTimeout(() => {
                const slotFixes = fixAllBunkSlotCounts();
                const pinnedFills = fillMissingPinnedSlots();
                console.log(`[DivisionTimes] Post-generation: ${slotFixes.fixed} slot resizes, ${pinnedFills} pinned fills`);
            }, 100);
        });
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        log('Initializing Division Times System v' + VERSION);
        if (!window.divisionTimes) window.divisionTimes = {};
        window.fieldUsageTracker = createFieldUsageTracker();
        setupGenerationCompleteHook();
        log('Division Times System initialized');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.DivisionTimesSystem = {
        version: VERSION,
        buildFromSkeleton: buildDivisionTimesFromSkeleton,
        expandSplitTiles: expandSplitTiles,
        parseTimeToMinutes: parseTimeToMinutes,
        minutesToTimeLabel: minutesToTimeLabel,
        minutesToDate: minutesToDate,
        getSlotsForDivision: (div) => window.SchedulerCoreUtils?.getSlotsForDivision(div) || [],
        findExactSlotForTimeRange: findExactSlotForTimeRange,
        createFieldUsageTracker: createFieldUsageTracker,
        buildUnifiedTimesFromDivisionTimes: buildUnifiedTimesFromDivisionTimes,
        mapUnifiedSlotToDivision: mapUnifiedSlotToDivision,
        serialize: serializeDivisionTimes,
        deserialize: deserializeDivisionTimes,
        initializeBunkAssignments: initializeBunkAssignments,
        getAssignmentAtTime: getAssignmentAtTime,
        setAssignment: setAssignment,
        fixAllBunkSlotCounts: fixAllBunkSlotCounts,
        fillMissingPinnedSlots: fillMissingPinnedSlots,
        diagnose: diagnose,
        diagnoseBunkSlots: diagnoseBunkSlots,
        _consolidateBlocks: consolidateBlocks
    };

    initialize();
    console.log('DIVISION TIMES SYSTEM v' + VERSION + ' LOADED (per-bunk support)');

    window.fixAllBunkSlotCounts = fixAllBunkSlotCounts;
    window.fillMissingPinnedSlots = fillMissingPinnedSlots;

})();
