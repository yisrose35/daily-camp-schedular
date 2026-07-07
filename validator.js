// =================================================================
// validator.js v3.2 — COMPREHENSIVE SCHEDULE VALIDATOR
// =================================================================
//
// CHECKS FOR:
// ✅ Cross-division conflicts (same_division, custom, not_sharable enforcement)
// ✅ Per-division capacity violations (too many same-div bunks on one field)
// ✅ Global capacity violations (type='all' with numeric cap exceeded)
// ✅ Same-day activity repetitions (by activity name)
// ✅ Same-day field repetitions (same field used twice by one bunk)
// ✅ Missing required activities (lunch, dismissal — configurable)
// ✅ Completely empty bunks (bunk has zero assignments)
// ✅ Empty slots (entire division slot with all bunks empty)
// ✅ Unassigned bunks (bunk exists in division but missing from assignments)
// ✅ Split tile validation (proper half-assignment detection)
// ✅ Division-specific time-based overlap (not slot-index-based)
// ✅ League-aware (skips league entries in conflict/repetition checks)
//
// v3.0 CHANGES:
// - ★★★ Proper same_division + custom sharing enforcement ★★★
// - ★★★ Transitive overlap grouping (chains, not just pairs) ★★★
// - ★★★ Duplicate field check per bunk per day ★★★
// - ★★★ Unassigned/empty bunk detection ★★★
// - ★★★ Split tile awareness in repetition checks ★★★
// - ★★★ Improved modal with collapsible sections + counts ★★★
//
// v3.2 CHANGES (sports rules):
// - ★★★ Spacing/cooldown rule check: every placed block re-judged through
//        the REAL rules engine (SchedulingRules.checkCandidateDetailed)
//        against the bunk's other blocks. Pins/leagues participate as
//        context but are not judged themselves. ★★★
// - ★★★ Sport player counts (Rules tab sportMetaData): shared-field
//        combined campers > maxPlayers + 2 (the engine's own grace) =
//        error; group under minPlayers = warning. ★★★
//
// v3.1 CHANGES (resource-rule + league/event-aware checks):
// - ★★★ Special access violations (accessRestrictions grade/bunk gate) ★★★
// - ★★★ Disabled (turned-OFF) specials & fields placed anyway ★★★
// - ★★★ Per-date Bunk-Only Access rule violations ★★★
// - ★★★ League/event-aware facility timeline conflicts — closes the
//        long-standing blind spot where league games (leagueAssignments)
//        and pinned-event reservations (_reservedFields) were invisible
//        to the per-bunk field-conflict check. Pin-vs-pin overlaps are
//        exempt (user-placed, by design). ★★★
// - ★★★ Field-quality audit (warnings): a graded placement while a
//        better-ranked field in the same quality group was free, ON,
//        not a special-host room, open by time rules and usable by that
//        grade — plus junior-vs-senior quality inversions among bunks. ★★★
//
// =================================================================

(function() {
    'use strict';

    // Fields/activities to ignore in capacity/conflict checks
    const IGNORED_FIELDS = [
        'free', 'no field', 'no game', 'unassigned league',
        'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'bus', 'swim', 'pool', 'rest period', 'rest',
        'transition', 'buffer'
    ];

    // Activities to ignore in same-day repetition checks
    const IGNORED_ACTIVITIES = [
        'free', 'no field', 'no game', 'unassigned league',
        'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'bus', 'swim', 'pool', 'rest period', 'rest',
        'transition', 'buffer'
    ];

    // =========================================================================
    // MAIN VALIDATION FUNCTION
    // =========================================================================

    function validateSchedule() {
        console.log('🛡️ Running comprehensive schedule validation v3.6...');
        
        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};
        const activityProperties = getActivityProperties();
        
        const errors = [];
        const warnings = [];
        
        // Build bunk→division lookup once
        const bunkDivMap = buildBunkDivisionMap(divisions);
        
        // =====================================================================
        // 1. CROSS-DIVISION + CAPACITY CONFLICTS (time-based)
        // =====================================================================
        const conflictResults = checkFieldConflicts(assignments, divisions, divisionTimes, activityProperties, bunkDivMap);
        conflictResults.errors.forEach(e => errors.push(e));
        conflictResults.warnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 2. SAME-DAY ACTIVITY REPETITIONS
        // =====================================================================
        const repetitionErrors = checkSameDayRepetitions(assignments, bunkDivMap, divisionTimes);
        repetitionErrors.forEach(e => errors.push(e));
        
        // =====================================================================
        // 3. SAME-DAY FIELD REPETITIONS (same field used twice by one bunk)
        // =====================================================================
        const fieldRepErrors = checkSameDayFieldRepetitions(assignments, bunkDivMap, divisionTimes);
        fieldRepErrors.forEach(e => warnings.push(e));
        
        // =====================================================================
        // 4. MISSING REQUIRED ACTIVITIES
        // =====================================================================
        const missingWarnings = checkMissingRequired(assignments, divisions, divisionTimes);
        missingWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 5. EMPTY SLOTS (entire division slot with all bunks empty)
        // =====================================================================
        const emptyWarnings = checkEmptySlots(assignments, divisions, divisionTimes);
        emptyWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 6. UNASSIGNED / COMPLETELY EMPTY BUNKS
        // =====================================================================
        const unassignedWarnings = checkUnassignedBunks(assignments, divisions, divisionTimes);
        unassignedWarnings.forEach(w => warnings.push(w));
        
        // =====================================================================
        // 7. ★★★ COMBINED FIELD (MUTUAL EXCLUSION) CONFLICTS ★★★
        // =====================================================================
        if (window.FieldCombos?.isInCombo) {
            const comboSeen = new Set();
            Object.entries(assignments).forEach(([bunk, slots]) => {
                const divName = bunkDivMap[String(bunk)];
                if (!divName) return;
                const divSlots = divisionTimes[divName] || [];
                (slots || []).forEach((entry, idx) => {
                    if (!entry || entry.continuation) return;
                    if (isLeagueEntry(entry)) return;
                    if (isTransitionEntry(entry)) return;
                    const fn = normalizeFieldName(entry.field) || normalizeFieldName(entry._activity);
                    if (!fn || IGNORED_FIELDS.includes(fn)) return;
                    if (!window.FieldCombos.isInCombo(fn)) return;
                    const slot = divSlots[idx];
                    if (!slot || slot.startMin == null) return;
                    const exclusive = window.FieldCombos.getExclusiveFields(fn);
                    exclusive.forEach(exField => {
                        const exLow = exField.toLowerCase().trim();
                        Object.entries(divisions).forEach(([od, odd]) => {
                            const os = divisionTimes[od] || [];
                            (odd.bunks || []).forEach(ob => {
                                if (ob === bunk) return;
                                const oba = assignments[ob] || [];
                                (oba || []).forEach((oe, oi) => {
                                    if (!oe || oe.continuation) return;
                                    const ofn = normalizeFieldName(oe.field) || normalizeFieldName(oe._activity);
                                    if (!ofn || ofn !== exLow) return;
                                    const oSlot = os[oi];
                                    if (!oSlot || oSlot.startMin == null) return;
                                    if (oSlot.startMin >= slot.endMin || oSlot.endMin <= slot.startMin) return;
                                    const key = [fn, exField, bunk, ob].sort().join('|') + '|' + slot.startMin;
                                    if (comboSeen.has(key)) return;
                                    comboSeen.add(key);
                                    errors.push(
                                        `<strong>${fn}</strong> (${bunk}) + ${exField} (${ob}) ${_ctr(slot.startMin, slot.endMin)} - same physical space`
                                    );
                                });
                            });
                        });
                    });
                });
            });
        }

        // =====================================================================
        // 8. ★★★ LEAGUE TIME MISMATCH (grades that play together must share a time) ★★★
        // =====================================================================
        const leagueTimeWarnings = checkLeagueTimeMismatch(divisionTimes);
        leagueTimeWarnings.forEach(w => warnings.push(w));

        // =====================================================================
        // 9. ★★★ v3.1: SPECIAL ACCESS RESTRICTIONS ★★★
        // =====================================================================
        try { checkSpecialAccess(assignments, bunkDivMap, divisionTimes).forEach(e => errors.push(e)); }
        catch (e) { console.warn('🛡️ special-access check failed:', e); }

        // =====================================================================
        // 10. ★★★ v3.1: DISABLED (TURNED-OFF) SPECIALS & FIELDS ★★★
        //     v3.4: covers Daily Adjustments' per-day disables + PINNED tiles
        //     (pinned hits are warnings — user-placed, but worth a heads-up)
        // =====================================================================
        try {
            const disRes = checkDisabledResources(assignments, bunkDivMap, divisionTimes);
            disRes.errors.forEach(e => errors.push(e));
            disRes.warnings.forEach(w => warnings.push(w));
        }
        catch (e) { console.warn('🛡️ disabled-resource check failed:', e); }

        // =====================================================================
        // 11. ★★★ v3.1: PER-DATE BUNK-ONLY ACCESS RULES ★★★
        // =====================================================================
        try { checkBunkOnlyAccess(assignments, bunkDivMap, divisionTimes).forEach(e => errors.push(e)); }
        catch (e) { console.warn('🛡️ bunk-only check failed:', e); }

        // =====================================================================
        // 12+13. ★★★ v3.1: LEAGUE/EVENT-AWARE TIMELINE + FIELD QUALITY ★★★
        // 15.    ★★★ v3.2: SPORT PLAYER COUNTS (min/max players) ★★★
        // =====================================================================
        try {
            const timedUsages = collectTimedUsages(assignments, divisions, divisionTimes, bunkDivMap);
            annotatePinSpans(timedUsages);
            checkLeagueFieldConflicts(timedUsages).forEach(e => errors.push(e));
            // ★ CHECK 17: pin-vs-pin facility conflicts — span-linked ("together")
            //   tiles pass as one shared reservation, unlinked collisions flag.
            checkPinnedTileConflicts(timedUsages, activityProperties).forEach(e => errors.push(e));
            checkFieldQuality(timedUsages).forEach(w => warnings.push(w));
            const sportRules = checkSportPlayerRules(timedUsages);
            sportRules.errors.forEach(e => errors.push(e));
            sportRules.warnings.forEach(w => warnings.push(w));
        } catch (e) { console.warn('🛡️ v3.1/v3.2 timeline checks failed:', e); }

        // =====================================================================
        // 14. ★★★ v3.2: SPACING / COOLDOWN RULES ★★★
        // =====================================================================
        try { checkCooldownRules(assignments, bunkDivMap, divisionTimes).forEach(e => errors.push(e)); }
        catch (e) { console.warn('🛡️ spacing-rule check failed:', e); }

        // =====================================================================
        // 16. ★★★ v3.3: ELECTIVE FACILITY RESERVATIONS ★★★
        // =====================================================================
        try { checkElectiveReservations(assignments, bunkDivMap, divisionTimes).forEach(e => errors.push(e)); }
        catch (e) { console.warn('🛡️ elective-reservation check failed:', e); }

        // Show results
        console.log(`🛡️ Validation complete: ${errors.length} errors, ${warnings.length} warnings`);
        showValidationModal(errors, warnings);
        return { errors, warnings };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function buildBunkDivisionMap(divisions) {
        const map = {};
        for (const [divName, data] of Object.entries(divisions)) {
            for (const bunk of (data.bunks || [])) {
                map[String(bunk)] = divName;
            }
        }
        return map;
    }

    function getActivityProperties() {
        let props = window.activityProperties;
        
        if (!props || Object.keys(props).length === 0) {
            const settings = window.loadGlobalSettings?.() || {};
            props = settings.activityProperties || {};
            
            // Also merge from app1.fields
            const app1 = settings.app1 || {};
            (app1.fields || []).forEach(f => {
                if (!props[f.name]) {
                    props[f.name] = f;
                }
            });
            (app1.specialActivities || []).forEach(s => {
                if (!props[s.name]) {
                    props[s.name] = s;
                }
            });
        }
        
        return props || {};
    }

    /**
     * Case-insensitive property lookup
     */
    function findPropsForField(fieldName, activityProperties) {
        if (!fieldName || !activityProperties) return {};
        
        // Try exact match first
        if (activityProperties[fieldName]) {
            return activityProperties[fieldName];
        }
        
        // Try case-insensitive match
        const fieldNameLower = fieldName.toLowerCase().trim();
        for (const [key, props] of Object.entries(activityProperties)) {
            if (key.toLowerCase().trim() === fieldNameLower) {
                return props;
            }
        }
        
        return {};
    }

    /**
     * Get sharing rules for a field
     */
    function getSharingRules(fieldName, activityProperties) {
        const props = findPropsForField(fieldName, activityProperties);
        const sharableWith = props.sharableWith || {};
        
        let sharingType = sharableWith.type || (props.sharable ? 'same_division' : 'not_sharable');
        let maxCapacity = 1;
        let allowedDivisions = sharableWith.divisions || [];
        
        switch (sharingType) {
            case 'all':
                maxCapacity = parseInt(sharableWith.capacity) || 999;
                break;
            case 'not_sharable':
                maxCapacity = 1;
                break;
            case 'same_division':
                maxCapacity = parseInt(sharableWith.capacity) || 2;
                break;
            case 'custom':
                maxCapacity = parseInt(sharableWith.capacity) || 2;
                break;
            default:
                if (sharableWith.capacity) {
                    maxCapacity = parseInt(sharableWith.capacity);
                } else if (props.sharable) {
                    maxCapacity = 2;
                    sharingType = 'same_division';
                }
        }
        
        // Legacy: direct capacity property
        if (maxCapacity === 1 && props.capacity) {
            maxCapacity = parseInt(props.capacity) || 1;
        }
        
        return { sharingType, maxCapacity, allowedDivisions };
    }

    /**
     * Get field capacity (exported utility)
     */
    function getFieldCapacity(fieldName, activityProperties) {
        if (window.SchedulerCoreUtils?.getFieldCapacity) {
            return window.SchedulerCoreUtils.getFieldCapacity(fieldName, activityProperties);
        }
        return getSharingRules(fieldName, activityProperties).maxCapacity;
    }

    /**
     * Normalize field name for comparison
     */
    function normalizeFieldName(field) {
        if (!field) return null;
        
        const name = window.SchedulerCoreUtils?.fieldLabel?.(field) ||
                    (typeof field === 'string' ? field : field?.name);
        
        return name ? name.toLowerCase().trim() : null;
    }

    /**
     * Compact time for the terse one-line messages: 170 → "2:50pm".
     */
    function _ct(minutes) {
        return String(formatTime(minutes)).replace(/\s?(AM|PM)/i, (m) => m.trim().toLowerCase());
    }
    /**
     * Compact time range: "2:50pm-4:00pm".
     */
    function _ctr(startMin, endMin) {
        return _ct(startMin) + '-' + _ct(endMin);
    }

    /**
     * Format time from minutes
     */
    function formatTime(minutes) {
        if (minutes === null || minutes === undefined) return '?';
        
        if (window.SchedulerCoreUtils?.minutesToTime) {
            return window.SchedulerCoreUtils.minutesToTime(minutes);
        }
        
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    /**
     * Check if an entry is a league entry
     */
    function isLeagueEntry(entry) {
        if (!entry) return false;
        return entry._isLeague === true ||
               entry._allMatchups?.length > 0 ||
               entry._leagueGame === true ||
               (entry.field && typeof entry.field === 'string' && entry.field.includes(' vs '));
    }

    /**
     * ★★★ LEAGUE TIME MISMATCH ★★★
     * When two (or more) grades play a league game *together*, the league game
     * tile MUST have the same start AND end time in every participating grade —
     * otherwise it isn't one shared game (the solver groups league blocks by
     * start time, and a differing time leaves the grades in different game
     * groups / spanning different windows).
     *
     * We can't safely auto-snap the times (extending one grade's tile can
     * collide with its neighbouring tiles), so this only WARNS. In this app a
     * "division" IS a grade, so for each league we compare each grade's SET of
     * league-tile time spans; if they aren't all identical, that league is
     * flagged. (Post-generation view: spans come from the division time grid.)
     */
    function checkLeagueTimeMismatch(divisionTimes) {
        const warnings = [];
        const leagueAssignments = window.leagueAssignments || {};

        // Resolve the leagues config (name → league object with .divisions).
        let leaguesCfg = window.masterLeagues || window.leaguesByName ||
            window.loadGlobalSettings?.()?.app1?.leagues || [];
        const leagues = (Array.isArray(leaguesCfg) ? leaguesCfg : Object.values(leaguesCfg || {}))
            .filter(l => l && l.enabled !== false);

        // How many leagues cover each grade. An UNNAMED block can only be
        // attributed to a league when it's the grade's ONLY league — with 2+
        // leagues the block is ambiguous, and counting it toward every league
        // fabricates mismatches (the grade's second game window belongs to its
        // OTHER league, not this one).
        const leagueCountByGrade = {};
        leagues.forEach(l => {
            if (!l || !Array.isArray(l.divisions)) return;
            l.divisions.forEach(d => {
                const k = String(d);
                leagueCountByGrade[k] = (leagueCountByGrade[k] || 0) + 1;
            });
        });

        leagues.forEach(league => {
            if (!league || !Array.isArray(league.divisions) || league.divisions.length < 2) return;

            // Group each grade's league-tile time spans (read from its time grid).
            const byGrade = {}; // grade → Set("startMin-endMin")
            league.divisions.forEach(divName => {
                const slots = leagueAssignments[divName];
                if (!slots) return;
                const divSlots = divisionTimes[divName] || [];
                Object.entries(slots).forEach(([slotIdxStr, entry]) => {
                    if (!entry) return;
                    // A named block that belongs to a *different* league isn't this
                    // league's tile; unnamed blocks count only when this grade has
                    // exactly one league (unambiguous auto-bind).
                    if (entry.leagueName) {
                        if (entry.leagueName !== league.name) return;
                    } else if ((leagueCountByGrade[String(divName)] || 0) > 1) {
                        return;
                    }
                    const slot = divSlots[Number(slotIdxStr)];
                    if (!slot || slot.startMin == null || slot.endMin == null) return;
                    (byGrade[divName] = byGrade[divName] || new Set()).add(slot.startMin + '-' + slot.endMin);
                });
            });

            const grades = Object.keys(byGrade);
            if (grades.length < 2) return; // need 2+ grades to be "together"

            // The grades play together when they share an IDENTICAL game window.
            // Warn only for (1) overlapping-but-unequal windows (a broken shared
            // game) or (2) no window common to every grade (never together).
            // An extra non-colliding window in one grade is NOT a mismatch.
            const bounds = (k) => k.split('-').map(Number);
            let broken = false;
            for (let i = 0; i < grades.length && !broken; i++) {
                for (let j = i + 1; j < grades.length && !broken; j++) {
                    for (const ka of byGrade[grades[i]]) {
                        if (broken) break;
                        const [as, ae] = bounds(ka);
                        for (const kb of byGrade[grades[j]]) {
                            if (ka === kb) continue;
                            const [bs, be] = bounds(kb);
                            if (as < be && ae > bs) { broken = true; break; }
                        }
                    }
                }
            }
            const hasCommonSpan = [...byGrade[grades[0]]]
                .some(k => grades.every(g => byGrade[g].has(k)));
            if (!broken && hasCommonSpan) return;

            const spanLabel = (k) => {
                const [s, e] = k.split('-').map(Number);
                return `${formatTime(s)} - ${formatTime(e)}`;
            };
            const parts = grades.sort().map(g => {
                const spans = [...byGrade[g]]
                    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
                    .map(spanLabel);
                return `<u>${g}</u> (${spans.join(', ')})`;
            });
            warnings.push(
                `<strong>${league.name}</strong> - ${parts.join(' vs ')} - no shared game time`
            );
        });

        return warnings;
    }

    /**
     * Check if an entry is a transition/buffer
     */
    function isTransitionEntry(entry) {
        if (!entry) return false;
        return entry._isTransition === true ||
               entry.field === 'Transition' ||
               entry._activity?.toLowerCase() === 'transition';
    }

    /**
     * ★ v3.1.1: Pinned-event awareness for the per-bunk field checks.
     * Pinned tiles store the EVENT NAME in entry.field ("AVL", "Signup
     * leagues", "Showers lekoved shabbos kodesh"...) — the real facilities
     * live in _reservedFields and are conflict-checked by the league/event
     * timeline (CHECK 12, where pin-vs-pin is exempt by design). Treating
     * the event label as a field made every whole-grade pin a fake
     * not_sharable/capacity violation.
     * An entry is skipped by the field checks when:
     *   - it is flagged _pinned, or
     *   - it carries _reservedFields (facilities tracked separately), or
     *   - its field label is not a configured facility/special at all
     *     (an event label, not a field) — only applied when a facility
     *     config exists to compare against.
     */
    function isPinnedEventEntry(entry, knownFacilities) {
        if (!entry) return false;
        if (entry._pinned === true) return true;
        if (Array.isArray(entry._reservedFields) && entry._reservedFields.length > 0) return true;
        if (knownFacilities && knownFacilities.size > 0) {
            const fn = normalizeFieldName(entry.field) || normalizeFieldName(entry._activity);
            if (fn && !IGNORED_FIELDS.includes(fn) && !knownFacilities.has(fn)) return true;
        }
        return false;
    }

    function buildKnownFacilitySet(activityProperties) {
        const props = activityProperties || getActivityProperties();
        return new Set(Object.keys(props || {}).map(k => k.toLowerCase().trim()));
    }

    /**
     * Check if two time ranges overlap
     */
    function timesOverlap(startA, endA, startB, endB) {
        return startA < endB && endA > startB;
    }

    // =========================================================================
    // CHECK 1: FIELD CONFLICTS (Cross-Division + Capacity) — TIME-BASED
    // =========================================================================

    function checkFieldConflicts(assignments, divisions, divisionTimes, activityProperties, bunkDivMap) {
        const errors = [];
        const warnings = [];
        
        // Build a map of all field usages with their actual time ranges
        // { fieldName: [{ bunk, divName, slotIdx, startMin, endMin, activity }] }
        const fieldUsageByTime = {};
        const knownFacilities = buildKnownFacilitySet(activityProperties);

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName) return;

            const divSlots = divisionTimes[divName] || [];

            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                if (isPinnedEventEntry(entry, knownFacilities)) return; // ★ v3.1.1: pins ≠ fields

                const fieldName = normalizeFieldName(entry.field) || normalizeFieldName(entry._activity);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const slotInfo = divSlots[slotIdx];
                if (!slotInfo || slotInfo.startMin === undefined) return;
                
                if (!fieldUsageByTime[fieldName]) {
                    fieldUsageByTime[fieldName] = [];
                }
                
                fieldUsageByTime[fieldName].push({
                    bunk,
                    divName,
                    slotIdx,
                    startMin: slotInfo.startMin,
                    endMin: slotInfo.endMin,
                    activity: entry._activity || entry.sport || fieldName
                });
            });
        });
        
        // Now check each field for conflicts
        Object.entries(fieldUsageByTime).forEach(([fieldName, usages]) => {
            if (usages.length < 2) return;
            
            const { sharingType, maxCapacity, allowedDivisions } = getSharingRules(fieldName, activityProperties);
            
            // ★★★ v3.0: Transitive overlap grouping ★★★
            // Build overlap groups using union-find for proper transitive chaining
            const overlapGroups = buildOverlapGroups(usages);
            
            overlapGroups.forEach(group => {
                if (group.length < 2) return;
                
                const uniqueDivisions = [...new Set(group.map(g => g.divName))];
                const timeStart = Math.min(...group.map(g => g.startMin));
                const timeEnd = Math.max(...group.map(g => g.endMin));
                const timeLabel = `${formatTime(timeStart)} - ${formatTime(timeEnd)}`;
                
                // =====================================================
                // CROSS-DIVISION VIOLATION CHECKS
                // =====================================================
                if (uniqueDivisions.length > 1) {
                    
                    const ctLabel = _ctr(timeStart, timeEnd);

                    // --- not_sharable: NO sharing at all ---
                    if (sharingType === 'not_sharable') {
                        const bunkList = group.map(g => `${g.bunk} (Div. ${g.divName})`).join(', ');
                        errors.push(
                            `<strong>${fieldName}</strong> ${ctLabel} - ${bunkList} - not sharable across divisions`
                        );
                        return; // Don't also report capacity for this group
                    }

                    // --- same_division: only same div can share ---
                    if (sharingType === 'same_division') {
                        const bunkList = group.map(g => `${g.bunk} (Div. ${g.divName})`).join(', ');
                        errors.push(
                            `<strong>${fieldName}</strong> ${ctLabel} - ${bunkList} - same-division sharing only`
                        );
                        return;
                    }

                    // --- custom: only allowed divisions can share ---
                    if (sharingType === 'custom' && allowedDivisions.length > 0) {
                        const disallowedDivs = uniqueDivisions.filter(d => !allowedDivisions.includes(d));
                        if (disallowedDivs.length > 0) {
                            errors.push(
                                `<strong>${fieldName}</strong> ${ctLabel} - Div. ${disallowedDivs.join(', Div. ')} - not on the field's allowed sharing list`
                            );
                            return;
                        }
                    }

                    // --- type='all': cross-div is OK, but still check global capacity ---
                    if (sharingType === 'all' && maxCapacity < 999) {
                        if (group.length > maxCapacity) {
                            const bunkList = group.map(g => `${g.bunk} (Div. ${g.divName})`).join(', ');
                            errors.push(
                                `<strong>${fieldName}</strong> ${ctLabel} - ${group.length} bunks (${bunkList}) - over capacity (max ${maxCapacity})`
                            );
                        }
                        return;
                    }
                    
                    // --- type='all' unlimited or custom with all divs allowed → check per-div capacity ---
                }
                
                // =====================================================
                // PER-DIVISION CAPACITY CHECKS
                // (for same-division groups OR after cross-div passes)
                // =====================================================
                uniqueDivisions.forEach(divName => {
                    const divUsages = group.filter(g => g.divName === divName);
                    
                    if (divUsages.length > maxCapacity) {
                        const divTimeStart = Math.min(...divUsages.map(g => g.startMin));
                        const divTimeEnd = Math.max(...divUsages.map(g => g.endMin));
                        const bunkList = divUsages.map(g => g.bunk).join(', ');

                        errors.push(
                            `<strong>${fieldName}</strong> ${_ctr(divTimeStart, divTimeEnd)} - ${divUsages.length} bunks in Div. ${divName} (${bunkList}) - over capacity (max ${maxCapacity})`
                        );
                    }
                });
            });
        });
        
        return { errors, warnings };
    }

    /**
     * ★★★ v3.0: Build transitive overlap groups using union-find ★★★
     * Instead of pairwise grouping (which misses chains A↔B↔C where A and C don't directly overlap),
     * this uses union-find to properly group all transitively-overlapping usages.
     */
    function buildOverlapGroups(usages) {
        const n = usages.length;
        const parent = Array.from({ length: n }, (_, i) => i);
        
        function find(x) {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]]; // path compression
                x = parent[x];
            }
            return x;
        }
        
        function union(a, b) {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }
        
        // Union all pairs that have time overlap
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (timesOverlap(usages[i].startMin, usages[i].endMin, usages[j].startMin, usages[j].endMin)) {
                    union(i, j);
                }
            }
        }
        
        // Collect groups
        const groups = {};
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!groups[root]) groups[root] = [];
            groups[root].push(usages[i]);
        }
        
        return Object.values(groups);
    }

    // =========================================================================
    // CHECK 2: SAME-DAY ACTIVITY REPETITIONS
    // =========================================================================

    function checkSameDayRepetitions(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        const knownFacilities = buildKnownFacilitySet();

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            const divSlots = divisionTimes[divName] || [];
            const activitySlots = {}; // { activityName: [{ slotIdx, timeLabel }] }

            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                if (isPinnedEventEntry(entry, knownFacilities)) return; // ★ v3.1.1: pins are user-placed
                
                const activity = entry._activity?.toLowerCase().trim();
                if (!activity) return;
                if (IGNORED_ACTIVITIES.some(ignored => activity.includes(ignored))) return;
                
                // ★★★ v3.0: For split tiles, use the sub-activity name if available ★★★
                // Split tiles may have entry._fromSplitTile = true with different sub-activities
                // that are intentionally different — those are OK
                const activityKey = activity;
                
                const slotInfo = divSlots[slotIdx];
                const timeLabel = slotInfo ? `${formatTime(slotInfo.startMin)}` : `slot ${slotIdx}`;
                
                if (!activitySlots[activityKey]) activitySlots[activityKey] = [];
                activitySlots[activityKey].push({ slotIdx, timeLabel });
            });
            
            // Report activities done more than once
            Object.entries(activitySlots).forEach(([activity, occurrences]) => {
                if (occurrences.length > 1) {
                    const timeLabels = occurrences.map(o => o.timeLabel).join(', ');
                    errors.push(
                        `<strong>${bunk}</strong>${divName ? ` (Div. ${divName})` : ''} - ${activity} ${occurrences.length}× today (${timeLabels})`
                    );
                }
            });
        });
        
        return errors;
    }

    // =========================================================================
    // CHECK 3: SAME-DAY FIELD REPETITIONS (same field used twice by one bunk)
    // =========================================================================

    function checkSameDayFieldRepetitions(assignments, bunkDivMap, divisionTimes) {
        const warnings = [];
        const knownFacilities = buildKnownFacilitySet();

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            const divSlots = divisionTimes[divName] || [];
            const fieldSlots = {}; // { fieldName: [{ slotIdx, timeLabel, activity }] }

            (slots || []).forEach((entry, slotIdx) => {
                if (!entry || entry.continuation) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                if (isPinnedEventEntry(entry, knownFacilities)) return; // ★ v3.1.1: pins ≠ fields

                const fieldName = normalizeFieldName(entry.field);
                if (!fieldName || IGNORED_FIELDS.includes(fieldName)) return;
                
                const activity = entry._activity || entry.sport || fieldName;
                const slotInfo = divSlots[slotIdx];
                const timeLabel = slotInfo ? `${formatTime(slotInfo.startMin)}` : `slot ${slotIdx}`;
                
                if (!fieldSlots[fieldName]) fieldSlots[fieldName] = [];
                fieldSlots[fieldName].push({ slotIdx, timeLabel, activity });
            });
            
            // Report fields used more than once by this bunk
            Object.entries(fieldSlots).forEach(([field, occurrences]) => {
                if (occurrences.length > 1) {
                    // Check if the activities are different (which means different activities at same field — might be intentional)
                    const uniqueActivities = [...new Set(occurrences.map(o => o.activity?.toLowerCase()))];
                    
                    const timeLabels = occurrences.map(o => `${o.timeLabel} ${o.activity}`).join(', ');
                    warnings.push(
                        `<strong>${bunk}</strong>${divName ? ` (Div. ${divName})` : ''} - ${field} ${occurrences.length}× today (${timeLabels})`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 4: MISSING REQUIRED ACTIVITIES
    // =========================================================================

    function checkMissingRequired(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        // ★★★ v3.0: Check global settings for required activities ★★★
        let requiredActivities = ['lunch'];
        try {
            const settings = window.loadGlobalSettings?.() || {};
            if (settings.requiredActivities && Array.isArray(settings.requiredActivities)) {
                requiredActivities = settings.requiredActivities;
            }
        } catch (e) { /* use defaults */ }
        
        if (requiredActivities.length === 0) return warnings;
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            // Skip divisions with no time slots configured
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk] || [];
                
                // Skip bunks with no assignments at all (caught by unassigned check)
                if (slots.length === 0 || slots.every(s => !s)) return;
                
                requiredActivities.forEach(required => {
                    const requiredLower = required.toLowerCase();
                    const hasActivity = slots.some(s => 
                        s && !s.continuation && (
                            s._activity?.toLowerCase().includes(requiredLower) || 
                            s.field?.toLowerCase?.().includes(requiredLower) ||
                            s.sport?.toLowerCase?.().includes(requiredLower)
                        )
                    );
                    
                    if (!hasActivity) {
                        warnings.push(
                            `<strong>${bunk}</strong> (Div. ${divName}) - no ${required} today`
                        );
                    }
                });
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 5: EMPTY SLOTS (★★★ v3.0: League-aware + improved ★★★)
    // =========================================================================

    function checkEmptySlots(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            if (divSlots.length === 0 || bunks.length === 0) return;
            
            // Get league assignments for this division
            const leagueAssignments = window.leagueAssignments?.[divName] || {};
            
            divSlots.forEach((slotInfo, slotIdx) => {
                let emptyCount = 0;
                const totalBunks = bunks.length;
                
                bunks.forEach(bunk => {
                    const entry = (assignments[bunk] || [])[slotIdx];
                    
                    // Check multiple ways an entry can be "filled"
                    const hasLeagueAssignment = leagueAssignments[slotIdx]?.matchups?.length > 0;
                    const entryIsLeague = isLeagueEntry(entry);
                    const entryHasContent = entry && !entry.continuation && (
                        entry._activity || entry.field || entry.sport
                    );
                    
                    if (!entryHasContent && !entryIsLeague && !hasLeagueAssignment) {
                        emptyCount++;
                    }
                });
                
                // Only warn if ALL bunks are empty for this slot
                if (emptyCount === totalBunks && totalBunks > 0) {
                    const timeLabel = (slotInfo.startMin !== undefined)
                        ? _ctr(slotInfo.startMin, slotInfo.endMin)
                        : `slot ${slotIdx}`;

                    warnings.push(
                        `<strong>Div. ${divName}</strong> ${timeLabel} - all ${totalBunks} bunks empty`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // CHECK 6: UNASSIGNED / COMPLETELY EMPTY BUNKS
    // =========================================================================

    function checkUnassignedBunks(assignments, divisions, divisionTimes) {
        const warnings = [];
        
        Object.entries(divisions).forEach(([divName, divData]) => {
            const bunks = divData.bunks || [];
            const divSlots = divisionTimes[divName] || [];
            
            if (divSlots.length === 0) return;
            
            bunks.forEach(bunk => {
                const slots = assignments[bunk];
                
                // Bunk completely missing from assignments
                if (!slots) {
                    warnings.push(
                        `<strong>${bunk}</strong> (Div. ${divName}) - no schedule at all`
                    );
                    return;
                }
                
                // Bunk exists but every slot is empty
                const filledSlots = slots.filter(s => s && !s.continuation && (s._activity || s.field || s.sport));
                const leagueAssignments = window.leagueAssignments?.[divName] || {};
                const hasAnyLeague = Object.values(leagueAssignments).some(la => la?.matchups?.length > 0);
                
                if (filledSlots.length === 0 && !hasAnyLeague) {
                    warnings.push(
                        `<strong>${bunk}</strong> (Div. ${divName}) - all ${divSlots.length} slots empty`
                    );
                }
            });
        });
        
        return warnings;
    }

    // =========================================================================
    // v3.1 — RESOURCE-RULE + LEAGUE/EVENT-AWARE CHECKS
    // =========================================================================

    const _lc = (v) => String(v == null ? '' : v).toLowerCase().trim();

    function getFieldsConfig() {
        const gs = window.loadGlobalSettings?.() || {};
        const arr = gs.app1?.fields || gs.fields || [];
        const list = Array.isArray(arr) ? arr : Object.values(arr || {});
        return list.filter(f => f && f.name);
    }

    function getSpecialsConfig() {
        let list = [];
        try { list = window.getAllSpecialActivities?.() || []; } catch (e) { /* fall through */ }
        if (!list || !list.length) {
            const gs = window.loadGlobalSettings?.() || {};
            list = gs.app1?.specialActivities || gs.specialActivities || [];
        }
        const arr = Array.isArray(list) ? list : Object.values(list || {});
        return arr.filter(s => s && s.name);
    }

    /**
     * ★ v3.1: Collect EVERY timed facility usage on the loaded day:
     *   kind 'bunk'   — a bunk placed on a real field (scheduleAssignments)
     *   kind 'event'  — a pinned tile / special reserving real facilities
     *                   (_reservedFields / _location; deduped per division+event)
     *   kind 'league' — a league game's field (leagueAssignments — the store
     *                   the per-bunk checks can't see)
     * Times prefer the entry's own _startMin/_endMin (regen-accurate), falling
     * back to the division time grid; continuation slots extend the end.
     */
    function collectTimedUsages(assignments, divisions, divisionTimes, bunkDivMap) {
        const usages = [];
        const realFields = new Set(getFieldsConfig().map(f => _lc(f.name)));
        const anyReal = realFields.size > 0;
        const evtSeen = new Set();

        const entryTimes = (slots, idx, divSlots) => {
            const entry = slots[idx];
            let s = entry._startMin, e = entry._endMin;
            const si = divSlots[idx];
            if (s == null && si) s = si.startMin;
            if (e == null && si) e = si.endMin;
            for (let j = idx + 1; j < slots.length; j++) {
                const nx = slots[j];
                if (!nx || !nx.continuation) break;
                if (nx._endMin != null) e = nx._endMin;
                else if (divSlots[j] && divSlots[j].endMin != null) e = divSlots[j].endMin;
            }
            return [s, e];
        };

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName || !Array.isArray(slots)) return;
            const divSlots = divisionTimes[divName] || [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || isTransitionEntry(entry) || isLeagueEntry(entry)) return;
                const [s, e] = entryTimes(slots, idx, divSlots);
                if (s == null || e == null || isNaN(s) || isNaN(e)) return;
                const activity = entry._activity || entry.sport || '';
                const fName = normalizeFieldName(entry.field);
                const isRealField = !!fName && (!anyReal || realFields.has(fName));
                const reserved = [];
                if (Array.isArray(entry._reservedFields)) entry._reservedFields.forEach(x => { if (x) reserved.push(x); });
                if (typeof entry._location === 'string' && entry._location.trim()) reserved.push(entry._location);

                if (fName && isRealField && !IGNORED_FIELDS.includes(fName)) {
                    usages.push({
                        fkey: fName,
                        facility: (typeof entry.field === 'string' ? entry.field : entry.field?.name) || fName,
                        divName, bunk, owner: 'Bunk ' + bunk, kind: 'bunk',
                        startMin: s, endMin: e, activity
                    });
                }
                // Pinned tiles / specials: event name in entry.field, real
                // facilities in _reservedFields/_location. Dedupe per
                // division+event (whole-division pins repeat on every bunk).
                if (!isRealField && reserved.length) {
                    reserved.forEach(raw => {
                        const rName = normalizeFieldName(raw);
                        if (!rName || IGNORED_FIELDS.includes(rName)) return;
                        if (anyReal && !realFields.has(rName)) return;
                        const key = divName + '|' + _lc(activity || fName || '') + '|' + rName + '|' + s;
                        if (evtSeen.has(key)) return;
                        evtSeen.add(key);
                        usages.push({
                            fkey: rName, facility: String(raw), divName, bunk,
                            owner: divName + ' — ' + (activity || (typeof entry.field === 'string' ? entry.field : '') || 'pinned event'),
                            kind: 'event', startMin: s, endMin: e,
                            activity: activity || String(entry.field || '')
                        });
                    });
                }
            });
        });

        // League games — stored in leagueAssignments, NOT in the per-bunk grid
        const leagueAssignments = window.leagueAssignments || {};
        const parseMatchup = (m) => {
            if (m && typeof m === 'object') {
                return {
                    field: m.field || m.location || m.fieldName || '',
                    label: [m.teamA || m.team1, m.teamB || m.team2].filter(Boolean).join(' vs ')
                };
            }
            const str = String(m || '');
            const at = str.split(' @ ');
            let field = (at[1] || '').trim();
            const pm = field.match(/^(.+?)\s*\((.+?)\)\s*$/);
            if (pm) field = pm[1].trim();
            return { field, label: (at[0] || '').trim() };
        };
        Object.entries(leagueAssignments).forEach(([divName, slotsObj]) => {
            if (!slotsObj || typeof slotsObj !== 'object') return;
            const divSlots = divisionTimes[divName] || [];
            Object.entries(slotsObj).forEach(([slotKey, entry]) => {
                if (!entry) return;
                const mus = entry.matchups || entry._allMatchups;
                if (!Array.isArray(mus) || !mus.length) return;
                let s = entry.startMin ?? entry._startMin;
                let e = entry.endMin ?? entry._endMin;
                const kNum = parseInt(slotKey, 10);
                if (s == null) {
                    const byStart = divSlots.find(sl => sl && sl.startMin === kNum);
                    const si = byStart || divSlots[kNum];
                    if (si) { s = si.startMin; if (e == null) e = si.endMin; }
                }
                if (s == null && kNum > 100) {
                    s = kNum;
                    const cont = divSlots.find(sl => sl && sl.startMin <= kNum && kNum < sl.endMin);
                    e = cont ? cont.endMin : kNum + 45;
                }
                if (s == null || isNaN(s)) return;
                if (e == null || isNaN(e)) e = s + 45;
                const lgName = entry.leagueName || entry._leagueName || entry.gameLabel || 'League';
                mus.forEach(m => {
                    const pm = parseMatchup(m);
                    const fk = normalizeFieldName(pm.field);
                    if (!fk || IGNORED_FIELDS.includes(fk)) return;
                    if (anyReal && !realFields.has(fk)) return;
                    usages.push({
                        fkey: fk, facility: pm.field, divName, bunk: null,
                        owner: 'League "' + lgName + '" — ' + (pm.label || 'game'),
                        kind: 'league', startMin: s, endMin: e, activity: lgName
                    });
                });
            });
        });

        return usages;
    }

    /**
     * ★ v3.1 CHECK 9: every placed special must pass the access gate for its
     * grade/bunk (accessRestrictions + per-date bunk-only rules — the exact
     * gate the schedulers use: window.isSpecialAvailableForBunk).
     */
    function checkSpecialAccess(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        if (typeof window.isSpecialAvailableForBunk !== 'function') return errors;
        const specials = getSpecialsConfig();
        if (!specials.length) return errors;
        const specialSet = new Set(specials.map(s => _lc(s.name)));
        const gs = window.loadGlobalSettings?.() || {};
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName || !Array.isArray(slots)) return;
            const divSlots = divisionTimes[divName] || [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || isTransitionEntry(entry) || isLeagueEntry(entry)) return;
                const act = entry._activity || entry.sport || entry.field;
                const actName = typeof act === 'string' ? act : act?.name;
                if (!actName || !specialSet.has(_lc(actName))) return;
                let allowed = true;
                try { allowed = window.isSpecialAvailableForBunk(actName, divName, bunk, gs) !== false; } catch (e) { /* fail open */ }
                if (allowed) return;
                const si = divSlots[idx];
                const when = entry._startMin != null ? _ct(entry._startMin) : (si ? _ct(si.startMin) : 'slot ' + idx);
                errors.push(
                    `<strong>${bunk}</strong> (Div. ${divName}) ${when} - ${actName} - not allowed for this grade/bunk`
                );
            });
        });
        return errors;
    }

    /**
     * ★ v3.1 CHECK 10 (extended v3.4): specials/fields toggled OFF — either in
     * Facilities (available === false) or for TODAY in Daily Adjustments'
     * Resources panel (overrides.disabledFields / disabledSpecials) — must not
     * appear in the schedule. Regular placements are ERRORS (the generator
     * should never have used them). PINNED tiles are scanned too: a pinned
     * tile that names or reserves a turned-off resource raises a WARNING
     * (user-placed, so it's a heads-up, deduped per division+tile+resource).
     */
    function getDayDisabledResources() {
        let ov = null;
        try { ov = (window.loadCurrentDailyData?.() || {}).overrides || null; } catch (e) { /* fall through */ }
        if (!ov) {
            try {
                const raw = localStorage.getItem('campResourceOverrides_' + (window.currentScheduleDate || ''));
                if (raw) ov = JSON.parse(raw)?.overrides || null;
            } catch (e) { /* no fallback */ }
        }
        return {
            fields: (ov?.disabledFields || []).map(String),
            specials: (ov?.disabledSpecials || []).map(String)
        };
    }

    function checkDisabledResources(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        const warnings = [];

        // Master Facilities toggles
        const offSpecials = new Map();
        getSpecialsConfig().forEach(s => { if (s.available === false) offSpecials.set(_lc(s.name), { name: s.name, why: 'turned off in Facilities' }); });
        const offFields = new Map();
        getFieldsConfig().forEach(f => { if (f.available === false) offFields.set(_lc(f.name), { name: f.name, why: 'turned off in Facilities' }); });

        // Per-day toggles (Daily Adjustments → Resources)
        const day = getDayDisabledResources();
        day.fields.forEach(n => { if (!offFields.has(_lc(n))) offFields.set(_lc(n), { name: n, why: 'turned off in Resources (today)' }); });
        day.specials.forEach(n => { if (!offSpecials.has(_lc(n))) offSpecials.set(_lc(n), { name: n, why: 'turned off in Resources (today)' }); });

        if (!offSpecials.size && !offFields.size) return { errors, warnings };

        const offAny = (key) => offFields.get(key) || offSpecials.get(key) || null;
        const pinSeen = new Set();

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)] || '?';
            if (!Array.isArray(slots)) return;
            const divSlots = divisionTimes[divName] || [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || isTransitionEntry(entry)) return;
                const actName = entry._activity || entry.sport;
                const fName = normalizeFieldName(entry.field);
                const si = divSlots[idx];
                const when = entry._startMin != null ? _ct(entry._startMin) : (si ? _ct(si.startMin) : 'slot ' + idx);

                // Pinned reservation surface: real facilities live in
                // _reservedFields/_location (entry.field is the EVENT name).
                const reserved = [];
                if (Array.isArray(entry._reservedFields)) entry._reservedFields.forEach(x => { if (x) reserved.push(String(x)); });
                if (typeof entry._location === 'string' && entry._location.trim()) reserved.push(entry._location);
                const isPin = entry._pinned === true || reserved.length > 0;

                if (!isPin) {
                    if (actName && offSpecials.has(_lc(actName))) {
                        const h = offSpecials.get(_lc(actName));
                        errors.push(
                            `<strong>${bunk}</strong> (Div. ${divName}) ${when} - ${h.name} - ${h.why}`
                        );
                    }
                    if (fName && offFields.has(fName)) {
                        const h = offFields.get(fName);
                        errors.push(
                            `<strong>${bunk}</strong> (Div. ${divName}) ${when} - ${h.name} - ${h.why}`
                        );
                    }
                    return;
                }

                // ── Pinned tile: warn (user-placed) — once per division+tile+resource ──
                const label = actName || (typeof entry.field === 'string' ? entry.field : '') || 'pinned event';
                const hits = [];
                if (actName && offSpecials.has(_lc(actName))) hits.push(offSpecials.get(_lc(actName)));
                if (fName && offAny(fName)) hits.push(offAny(fName));
                reserved.forEach(r => {
                    const h = offAny(_lc(r));
                    if (h) hits.push(h);
                });
                hits.forEach(h => {
                    const key = divName + '|' + _lc(label) + '|' + _lc(h.name) + '|' + (entry._startMin != null ? entry._startMin : idx);
                    if (pinSeen.has(key)) return;
                    pinSeen.add(key);
                    // ★ v3.5 severity re-tier (user decision): a pinned tile on
                    //   a turned-off resource is a MUST-FIX, same as regular
                    //   placements.
                    errors.push(
                        `<strong>${label}</strong> (Div. ${divName}) ${when} - ${h.name} - ${h.why}`
                    );
                });
            });
        });
        return { errors, warnings };
    }

    /**
     * ★ v3.1 CHECK 11: per-date Bunk-Only Access rules (Resources → facility →
     * "🔒 Bunk-Only Access"). Specials are already covered by CHECK 9 (the
     * special gate folds the bunk-only rule in), so this only inspects
     * field/sport placements. Skips silently when no rules exist today.
     */
    function checkBunkOnlyAccess(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        const U = window.SchedulerCoreUtils;
        if (!U || typeof U.isBunkRestrictedFromTarget !== 'function') return errors;
        let rules = null;
        try { rules = (window.loadCurrentDailyData?.() || {}).dailyActivityBunkRestrictions; } catch (e) { /* fall through */ }
        if (!Array.isArray(rules) || !rules.length) {
            try {
                const raw = localStorage.getItem('campResourceOverrides_' + (window.currentScheduleDate || ''));
                if (raw) {
                    const p = JSON.parse(raw);
                    if (Array.isArray(p?.dailyActivityBunkRestrictions)) rules = p.dailyActivityBunkRestrictions;
                }
            } catch (e) { /* no fallback */ }
        }
        if (!Array.isArray(rules) || !rules.length) return errors;
        const specialSet = new Set(getSpecialsConfig().map(s => _lc(s.name)));
        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName || !Array.isArray(slots)) return;
            const divSlots = divisionTimes[divName] || [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || isTransitionEntry(entry) || isLeagueEntry(entry)) return;
                const actName = entry._activity || entry.sport || null;
                if (actName && specialSet.has(_lc(actName))) return; // covered by CHECK 9
                const rawField = (typeof entry.field === 'object') ? entry.field?.name : entry.field;
                if (!actName && !rawField) return;
                let blocked = false;
                try { blocked = U.isBunkRestrictedFromTarget(bunk, actName, rawField || null, divName) === true; } catch (e) { /* fail open */ }
                if (!blocked) return;
                const si = divSlots[idx];
                const when = entry._startMin != null ? _ct(entry._startMin) : (si ? _ct(si.startMin) : 'slot ' + idx);
                const target = actName && rawField && _lc(actName) !== _lc(rawField)
                    ? `${actName} on ${rawField}` : (actName || rawField);
                errors.push(
                    `<strong>${bunk}</strong> (Div. ${divName}) ${when} - ${target} - bunk-only access reserves it for other bunks today`
                );
            });
        });
        return errors;
    }

    /**
     * ★ v3.1 CHECK 12: league/event-aware facility conflicts. The per-bunk
     * conflict check (CHECK 1) cannot see league games or pinned-event
     * reservations; this one can. Pure bunk-vs-bunk groups are skipped
     * (CHECK 1 territory) and pin-vs-pin overlaps are exempt — overlapping
     * pinned tiles are user-placed and intentional.
     */
    function checkLeagueFieldConflicts(usages) {
        const errors = [];
        const byF = {};
        usages.forEach(u => { (byF[u.fkey] = byF[u.fkey] || []).push(u); });
        const seen = new Set();
        Object.values(byF).forEach(list => {
            if (list.length < 2) return;
            buildOverlapGroups(list).forEach(group => {
                if (group.length < 2) return;
                const kinds = new Set(group.map(g => g.kind));
                if (kinds.size === 1 && kinds.has('bunk')) return;   // CHECK 1 covers it
                if (kinds.size === 1 && kinds.has('event')) return;  // pin-vs-pin: CHECK 17 (span-aware)
                const owners = [...new Set(group.map(g => g.owner))];
                if (owners.length < 2) return;
                const sig = group[0].fkey + '|' + owners.sort().join(',') + '|' + Math.min(...group.map(g => g.startMin));
                if (seen.has(sig)) return;
                seen.add(sig);
                const timeLabel = _ctr(Math.min(...group.map(g => g.startMin)), Math.max(...group.map(g => g.endMin)));
                errors.push(
                    `<strong>${group[0].facility}</strong> ${timeLabel} - ${owners.join(' + ')} - double-booked`
                );
            });
        });
        return errors;
    }

    /**
     * ★ CHECK 17: PINNED-vs-PINNED facility conflicts (span-aware).
     * Two pinned tiles reserving the same facility at overlapping times used to
     * be exempt ("user-placed, by design"). With multi-grade tile spanning the
     * intent is now expressible: tiles linked into one span (shared spanGroup)
     * are ONE joint activity and pass; unlinked colliding pins are flagged.
     * Facility capacity still applies — a facility that allows N simultaneous
     * groups passes with up to N occupants (e.g. an open/sharable facility).
     */
    function annotatePinSpans(usages) {
        // The generated entries don't carry spanGroup — read it off the day's
        // skeleton tiles (Daily Adjustments' live skeleton, falling back to the
        // builder's) by matching division + overlapping time + facility/event.
        const skelRaw = (Array.isArray(window.dailyOverrideSkeleton) && window.dailyOverrideSkeleton.length)
            ? window.dailyOverrideSkeleton
            : (window.MasterSchedulerInternal?.dailySkeleton || []);
        const spanTiles = (skelRaw || []).filter(t => t && t.spanGroup);
        if (!spanTiles.length) return usages;
        const parse = (t) => window.SchedulerCoreUtils?.parseTimeToMinutes?.(t) ?? null;

        usages.forEach(u => {
            if (u.kind !== 'event') return;
            const hit = spanTiles.find(t => {
                if (String(t.division) !== String(u.divName)) return false;
                const ts = parse(t.startTime), te = parse(t.endTime);
                if (ts == null || te == null) return false;
                if (!(ts < u.endMin && te > u.startMin)) return false;
                const locs = [];
                if (t.location) locs.push(t.location);
                if (t.swimLocation) locs.push(t.swimLocation);
                if (Array.isArray(t.reservedFields)) locs.push(...t.reservedFields);
                if (locs.some(l => normalizeFieldName(l) === u.fkey)) return true;
                // Fallback: same event name (pin whose facility came from defaults)
                const evName = _lc(t.event || '');
                return !!evName && evName === _lc(u.activity || '');
            });
            if (hit) u.spanGroup = hit.spanGroup;
        });
        return usages;
    }

    function checkPinnedTileConflicts(usages, activityProperties) {
        const errors = [];
        const events = usages.filter(u => u.kind === 'event');
        if (events.length < 2) return errors;

        const byF = {};
        events.forEach(u => { (byF[u.fkey] = byF[u.fkey] || []).push(u); });
        const seen = new Set();

        Object.values(byF).forEach(list => {
            if (list.length < 2) return;
            buildOverlapGroups(list).forEach(group => {
                if (group.length < 2) return;

                // Members sharing a spanGroup are ONE joint reservation
                // ("together" — the grades do this activity as one).
                const occupants = new Map(); // occupant key → members
                group.forEach((g, i) => {
                    const k = g.spanGroup ? ('span:' + g.spanGroup) : ('u:' + i);
                    if (!occupants.has(k)) occupants.set(k, []);
                    occupants.get(k).push(g);
                });
                if (occupants.size < 2) return; // all linked → together → pass

                // Sharing-config exemption — the TYPE matters, not just the
                // number: 'all' facilities are open to everyone; 'custom' only
                // to its listed divisions; 'same_division' only within one
                // grade. A plain capacity of 2 (meant for bunks of one grade
                // sharing a court) must NOT excuse two different grades' pins.
                const rules = getSharingRules(group[0].fkey, activityProperties);
                const occDivs = [...new Set(group.map(g => String(g.divName)))];
                let allowedByConfig = false;
                if (rules.sharingType === 'all') {
                    allowedByConfig = occupants.size <= rules.maxCapacity;
                } else if (rules.sharingType === 'same_division') {
                    allowedByConfig = occDivs.length === 1 && occupants.size <= rules.maxCapacity;
                } else if (rules.sharingType === 'custom') {
                    const allowed = new Set((rules.allowedDivisions || []).map(String));
                    allowedByConfig = occDivs.every(d => allowed.has(d)) && occupants.size <= rules.maxCapacity;
                }
                if (allowedByConfig) return;

                const owners = [...new Set(group.map(g => g.owner))];
                if (owners.length < 2) return;
                const sig = group[0].fkey + '|' + owners.sort().join(',') + '|' + Math.min(...group.map(g => g.startMin));
                if (seen.has(sig)) return;
                seen.add(sig);

                const timeLabel = _ctr(Math.min(...group.map(g => g.startMin)), Math.max(...group.map(g => g.endMin)));
                errors.push(
                    `<strong>${group[0].facility}</strong> ${timeLabel} - pinned by ${owners.join(' + ')} - not linked (stretch one tile across the grades to share)`
                );
            });
        });
        return errors;
    }

    /**
     * ★ v3.3 CHECK 16: ELECTIVE facility reservations. An elective tile is a
     * fancy custom-pinned tile — once it reserves its activities/locations for a
     * division's window, nothing from ANOTHER division may sit on those facilities
     * at that time. Electives are invisible to every other check because they
     * create NO schedule entry (they render from the skeleton block and only
     * reserve their facilities), so CHECK 1 / CHECK 12 never see them. This check
     * rebuilds the elective reservations straight from the skeleton (the same
     * getFieldReservationsFromSkeleton the generator uses) and flags any bunk in a
     * DIFFERENT division whose activity occupies a reserved facility during the
     * elective's window. The elective's OWN grade is exempt (division-lock
     * semantics). Pinned-tile reservations are NOT re-checked here — those tiles
     * DO fill entries (with _reservedFields) so CHECK 12 already covers them.
     */
    function checkElectiveReservations(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        const Utils = window.SchedulerCoreUtils;

        // Reservations: rebuild from the skeleton (accurate even without a fresh
        // gen); fall back to the live window.fieldReservations.
        let resv = null;
        try {
            const skel = (typeof window.getSkeletonFromAnySource === 'function' && window.getSkeletonFromAnySource())
                || window.manualSkeleton || window.dailyOverrideSkeleton;
            if (Array.isArray(skel) && Utils && Utils.getFieldReservationsFromSkeleton) {
                resv = Utils.getFieldReservationsFromSkeleton(skel);
            }
        } catch (e) { /* fall through */ }
        if (!resv || !Object.keys(resv).length) resv = window.fieldReservations || null;
        if (!resv || !Object.keys(resv).length) return errors;

        // Keep only ELECTIVE reservations (pins are covered by CHECK 12).
        const keyLc = {};                       // lc facility → original key
        let anyElective = false;
        Object.keys(resv).forEach(k => {
            const list = (resv[k] || []).filter(r => r && (r.type === 'elective' || r.type === 'swim_elective'));
            if (list.length) { keyLc[String(k).toLowerCase().trim()] = { key: k, list: list }; anyElective = true; }
        });
        if (!anyElective) return errors;

        // special name (lc) → host location (a special may sit in a room whose
        // name differs from the special's).
        const specLoc = {};
        const gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || window.globalSettings || {};
        (((gs.app1 && gs.app1.specialActivities) || gs.specialActivities || [])).forEach(s => {
            if (s && s.name && s.location) { const n = String(s.name).toLowerCase().trim(); if (!specLoc[n]) specLoc[n] = s.location; }
        });
        const resolveLoc = window.getLocationForActivity;

        // Divisions actually generated today. An elective tile lives in the shared
        // skeleton even for a division that was NOT part of this generation (e.g. a
        // learning division with no schedule today). Its reservation then holds
        // rooms that nobody from that division occupies, so flagging another
        // division on those rooms is a false positive. Only honor an elective
        // reservation whose division has a live (non-empty) schedule today.
        const liveDivisions = new Set();
        Object.entries(assignments).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const dv = bunkDivMap[String(bunk)];
            if (dv == null) return;
            if (slots.some(e => e && !e.continuation && (e._activity || (e.field && e.field !== 'Free'))))
                liveDivisions.add(String(dv));
        });

        const seen = new Set();
        Object.entries(assignments).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const div = bunkDivMap[String(bunk)];
            const divSlots = divisionTimes[div] || [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                if (entry._pinned) return;
                if (isLeagueEntry(entry)) return;
                if (isTransitionEntry(entry)) return;
                const act = entry._activity || entry.field;
                if (!act || IGNORED_FIELDS.includes(String(act).toLowerCase().trim())) return;

                let sM = entry._startMin, eM = entry._endMin;
                if (sM == null || eM == null) { const sl = divSlots[idx]; if (sl) { sM = sl.startMin; eM = sl.endMin; } }
                if (sM == null || eM == null) return;

                // Physical facilities this entry occupies.
                const cands = new Set();
                const add = f => { if (f && typeof f === 'string' && f.trim() && f !== 'Free') cands.add(f.trim()); };
                add(entry.field); add(entry._location);
                if (Array.isArray(entry._reservedFields)) entry._reservedFields.forEach(add);
                add(specLoc[String(act).toLowerCase().trim()]);
                try { add(resolveLoc && resolveLoc(act)); } catch (e) { /* ignore */ }

                for (const cf of cands) {
                    const rec = keyLc[String(cf).toLowerCase().trim()];
                    if (!rec) continue;
                    for (const r of rec.list) {
                        if (!(r.startMin < eM && r.endMin > sM)) continue;
                        // Own grade is exempt (elective division-lock semantics).
                        if (r.division && String(r.division) === String(div)) continue;
                        // Reserving division wasn't generated today → phantom reservation.
                        if (r.division && !liveDivisions.has(String(r.division))) continue;
                        // Edge: the entry IS the elective's own event label.
                        if (String(act).toLowerCase().trim() === String(r.event || '').toLowerCase().trim()) continue;
                        const sig = rec.key + '|' + bunk + '|' + sM;
                        if (seen.has(sig)) continue;
                        seen.add(sig);
                        errors.push(
                            `<strong>${bunk}</strong> (Div. ${div}) ${_ctr(sM, eM)} - ${act} on ${rec.key} - reserved by ${r.division}'s elective`
                        );
                        break;
                    }
                }
            });
        });
        return errors;
    }

    /**
     * ★ v3.1 CHECK 13 (warnings): field-quality audit against the Facilities
     * quality groups (fieldGroup + qualityRank, 1 = best).
     *  (a) a placement sat on rank N while a better-ranked group member was
     *      simultaneously free, ON, not a special-host room, open per time
     *      rules and accessible to that grade — a genuine missed upgrade.
     *  (b) seniority inversion among BUNK placements: a junior division holds
     *      a better-ranked field than a senior division in the same group at
     *      an overlapping time. (League fixtures are placed first by design,
     *      so league-vs-bunk precedence is intentionally NOT flagged.)
     */
    function checkFieldQuality(usages) {
        const warnings = [];
        const fieldsCfg = getFieldsConfig();
        const groups = {};
        fieldsCfg.forEach(f => {
            if (!f.fieldGroup || !f.qualityRank) return;
            (groups[f.fieldGroup] = groups[f.fieldGroup] || []).push({
                name: f.name, key: _lc(f.name), rank: parseInt(f.qualityRank) || 999, props: f
            });
        });
        const groupNames = Object.keys(groups);
        if (!groupNames.length) return warnings;
        groupNames.forEach(g => groups[g].sort((a, b) => a.rank - b.rank));
        const keyInfo = {};
        groupNames.forEach(g => groups[g].forEach(m => { keyInfo[m.key] = { group: g, rank: m.rank, name: m.name }; }));

        // Seniority (oldest first) — same source the solver uses
        let order = [];
        try { order = window.getDivisionAgeOrder?.(Object.keys(window.divisions || {})) || []; } catch (e) { /* off */ }
        const sen = {};
        order.forEach((d, i) => { sen[d] = i; });

        // Special-host rooms are never free-for-sports candidates (e.g. a
        // basketball court that hosts a clinic is reserved for specials).
        const specialHosts = new Set();
        getSpecialsConfig().forEach(sp => {
            specialHosts.add(_lc(sp.name));
            try {
                const host = window.getLocationForActivity?.(sp.name);
                if (host) specialHosts.add(_lc(typeof host === 'object' ? host?.name : host));
            } catch (e) { /* skip */ }
        });

        const byF = {};
        usages.forEach(u => { (byF[u.fkey] = byF[u.fkey] || []).push(u); });
        const isBusy = (key, s, e) => (byF[key] || []).some(u => u.startMin < e && u.endMin > s);
        // ★ v3.1.2: combined-field awareness — a member of a combo (e.g. New Gym 2
        //   inside "New Gym Full") is physically consumed whenever any of its
        //   mutually-exclusive counterparts is in use during the window.
        const comboBusy = (member, s, e) => {
            const FC = window.FieldCombos;
            if (!FC || typeof FC.getExclusiveFields !== 'function') return false;
            try {
                if (typeof FC.isInCombo === 'function' && !FC.isInCombo(member.key)) return false;
                const ex = FC.getExclusiveFields(member.key) || [];
                return ex.some(x => isBusy(_lc(x), s, e));
            } catch (err) { return false; }
        };

        const parseMin = (v) => {
            if (v == null) return null;
            if (typeof v === 'number') return isNaN(v) ? null : v;
            const m = window.SchedulerCoreUtils?.parseTimeToMinutes?.(v);
            return (typeof m === 'number' && !isNaN(m)) ? m : null;
        };
        const isOpenFor = (member, s, e, divName) => {
            const f = member.props;
            if (f.available === false) return false;
            if (specialHosts.has(member.key)) return false;
            // ★ v3.1.2: exclusive field preference — the solver hard-excludes a
            //   division not on the list (e.g. a gym reserved for select grades),
            //   so it is not a "missed" field for anyone else.
            const pref = f.preferences;
            if (pref && pref.enabled && pref.exclusive && Array.isArray(pref.list) &&
                pref.list.length > 0 && !pref.list.includes(divName)) return false;
            const ar = f.accessRestrictions;
            if (ar && ar.enabled && ar.divisions && typeof ar.divisions === 'object' &&
                Object.keys(ar.divisions).length > 0 && !(divName in ar.divisions)) return false;
            const tr = f.timeRules;
            if (Array.isArray(tr) && tr.length) {
                let availWins = null;
                for (const r of tr) {
                    if (!r) continue;
                    let rs = r.startMin, re = r.endMin;
                    if (rs == null) rs = parseMin(r.start || r.startTime);
                    if (re == null) re = parseMin(r.end || r.endTime);
                    if (rs == null || re == null) continue;
                    if (Array.isArray(r.divisions) && r.divisions.length && !r.divisions.includes(divName)) continue;
                    const type = _lc(r.type);
                    if (type === 'unavailable' || r.available === false) {
                        if (rs < e && re > s) return false;
                    } else if (type === 'available' || r.available === true) {
                        (availWins = availWins || []).push([rs, re]);
                    }
                }
                if (availWins && !availWins.some(w => w[0] <= s && e <= w[1])) return false;
            }
            return true;
        };

        // (a) missed upgrades
        const seenMiss = new Set();
        usages.forEach(u => {
            if (u.kind === 'event') return; // pins reserve exactly what the user chose
            const info = keyInfo[u.fkey];
            if (!info) return;
            for (const m of groups[info.group]) {
                if (m.rank >= info.rank) break;
                if (!isOpenFor(m, u.startMin, u.endMin, u.divName)) continue;
                if (isBusy(m.key, u.startMin, u.endMin)) continue;
                if (comboBusy(m, u.startMin, u.endMin)) continue;
                const sig = u.owner + '|' + u.fkey + '|' + u.startMin;
                if (seenMiss.has(sig)) break;
                seenMiss.add(sig);
                warnings.push(
                    `<strong>${u.owner}</strong> (Div. ${u.divName}) ${_ctr(u.startMin, u.endMin)} - #${info.rank} ${info.name} - better field free (#${m.rank} ${m.name})`
                );
                break;
            }
        });

        // (b) seniority inversions among bunk placements
        const seenInv = new Set();
        const byGroup = {};
        usages.forEach(u => {
            const i = keyInfo[u.fkey];
            if (i && u.kind === 'bunk') (byGroup[i.group] = byGroup[i.group] || []).push(u);
        });
        Object.values(byGroup).forEach(list => {
            for (const a of list) for (const b of list) {
                if (a === b) continue;
                if (!(a.startMin < b.endMin && b.startMin < a.endMin)) continue;
                const sa = sen[a.divName], sb = sen[b.divName];
                if (sa == null || sb == null || sa >= sb) continue; // a must be strictly senior
                const ra = keyInfo[a.fkey].rank, rb = keyInfo[b.fkey].rank;
                if (ra <= rb) continue; // senior already equal or better
                const sig = a.owner + '|' + b.owner + '|' + a.fkey + '|' + b.fkey + '|' + Math.max(a.startMin, b.startMin);
                if (seenInv.has(sig)) continue;
                seenInv.add(sig);
                warnings.push(
                    `<strong>Div. ${a.divName}</strong> (${a.owner}) ${_ct(Math.max(a.startMin, b.startMin))} - #${ra} ${keyInfo[a.fkey].name} - junior Div. ${b.divName} holds better #${rb} ${keyInfo[b.fkey].name}`
                );
            }
        });

        return warnings;
    }

    // =========================================================================
    // v3.2 — SPORTS RULES CHECKS
    // =========================================================================

    /**
     * ★ v3.2 CHECK 14: cooldown/spacing rules ("Don't place X within N min of
     * Y" — the Rules tab). Re-judges every placed block through the REAL rules
     * engine (window.SchedulingRules.checkCandidateDetailed) against the
     * bunk's other blocks. Pinned/league blocks participate as CONTEXT (rules
     * commonly reference Lunch/League/Swim) but are not judged themselves —
     * they are user-placed or fixtures.
     */
    function checkCooldownRules(assignments, bunkDivMap, divisionTimes) {
        const errors = [];
        const SR = window.SchedulingRules;
        if (!SR || typeof SR.checkCandidateDetailed !== 'function') return errors;
        const rules = (typeof SR.getCooldownRules === 'function') ? (SR.getCooldownRules() || []) : [];
        if (!rules.length) return errors;
        const mode = (window._daBuilderMode === 'auto') ? 'auto' : 'manual';
        const inferType = (typeof SR.inferTypeFromActivity === 'function') ? SR.inferTypeFromActivity : (() => 'activity');
        const describe = (typeof SR.describeRule === 'function') ? SR.describeRule : (() => 'a configured spacing rule');

        Object.entries(assignments).forEach(([bunk, slots]) => {
            const divName = bunkDivMap[String(bunk)];
            if (!divName || !Array.isArray(slots)) return;
            const divSlots = divisionTimes[divName] || [];
            const blocks = [];
            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || isTransitionEntry(entry)) return;
                let s = entry._startMin, e = entry._endMin;
                const si = divSlots[idx];
                if (s == null && si) s = si.startMin;
                if (e == null && si) e = si.endMin;
                for (let j = idx + 1; j < slots.length; j++) {
                    const nx = slots[j];
                    if (!nx || !nx.continuation) break;
                    if (nx._endMin != null) e = nx._endMin;
                    else if (divSlots[j] && divSlots[j].endMin != null) e = divSlots[j].endMin;
                }
                if (s == null || e == null || isNaN(s) || isNaN(e)) return;
                const act = entry._activity || entry.sport ||
                    (typeof entry.field === 'string' ? entry.field : '') || '';
                const isLg = isLeagueEntry(entry);
                blocks.push({
                    startMin: s, endMin: e,
                    type: isLg ? 'league' : inferType(act),
                    event: act,
                    field: (typeof entry.field === 'object') ? entry.field?.name : entry.field,
                    _assignedSpecial: entry._assignedSpecial || null,
                    _specialLocation: entry._specialLocation || entry._location || null,
                    _judge: !isLg && entry._pinned !== true,
                });
            });
            blocks.forEach(cand => {
                if (!cand._judge) return;
                const template = blocks.filter(b => b !== cand);
                let res = { allowed: true, violated: [] };
                try { res = SR.checkCandidateDetailed(cand, template, { mode }); } catch (e2) { return; }
                (res.violated || []).forEach(rule => {
                    errors.push(
                        `<strong>${bunk}</strong> (Div. ${divName}) ${_ct(cand.startMin)} - ${cand.event || cand.field} - spacing rule: ${describe(rule)}`
                    );
                });
            });
        });
        return errors;
    }

    /**
     * ★ v3.2 CHECK 15: Sports Rules player counts (Rules tab sportMetaData).
     * For every group of bunks sharing a field for the same sport at
     * overlapping times:
     *   - combined campers > maxPlayers + 2 (the engine's own grace) → ERROR
     *   - combined campers < minPlayers → WARNING (engine treats min as a
     *     matching preference, not a hard gate)
     * Only judged when every bunk in the group has a known size — the engine
     * cannot count unknown sizes either.
     */
    function checkSportPlayerRules(usages) {
        const errors = [], warnings = [];
        const gs = window.loadGlobalSettings?.() || {};
        const sportMeta = (window.getSportMetaData?.() || gs.app1?.sportMetaData || {});
        const metaByKey = {};
        Object.keys(sportMeta || {}).forEach(k => { metaByKey[_lc(k)] = sportMeta[k] || {}; });
        if (!Object.keys(metaByKey).length) return { errors, warnings };
        const bunkMeta = (window.getBunkMetaData?.() || gs.app1?.bunkMetaData || {});
        const sizeOf = (b) => {
            const m = bunkMeta[b] || bunkMeta[String(b)];
            const v = m && parseInt(m.size);
            return (v && v > 0) ? v : null;
        };

        const byF = {};
        usages.forEach(u => { if (u.kind === 'bunk' && u.activity) (byF[u.fkey] = byF[u.fkey] || []).push(u); });
        const seen = new Set();
        Object.values(byF).forEach(list => {
            buildOverlapGroups(list).forEach(group => {
                const bySport = {};
                group.forEach(u => {
                    const k = _lc(u.activity);
                    if (metaByKey[k]) (bySport[k] = bySport[k] || []).push(u);
                });
                Object.entries(bySport).forEach(([sportKey, us]) => {
                    const meta = metaByKey[sportKey];
                    const sizes = us.map(u => sizeOf(u.bunk));
                    if (sizes.some(sz => sz == null)) return;
                    const total = sizes.reduce((a, b) => a + b, 0);
                    const t0 = Math.min(...us.map(u => u.startMin));
                    const sig = us[0].fkey + '|' + sportKey + '|' + us.map(u => u.bunk).sort().join(',') + '|' + t0;
                    if (seen.has(sig)) return;
                    seen.add(sig);
                    const bunksLabel = us.map((u, i) => `${u.bunk} (${sizes[i]})`).join(', ');
                    const max = parseInt(meta.maxPlayers) || 0;
                    const min = parseInt(meta.minPlayers) || 0;
                    if (max > 0 && total > max + 2) {
                        // ★ v3.5 severity re-tier (user decision): player-cap
                        //   overflows are a REVIEW item, not a hard error.
                        warnings.push(
                            `<strong>${us[0].facility}</strong> ${_ct(t0)} - ${us[0].activity} ${total} campers (${bunksLabel}) - over sport max ${max} (+2)`
                        );
                    } else if (min > 0 && total < min) {
                        warnings.push(
                            `<strong>${us[0].facility}</strong> ${_ct(t0)} - ${us[0].activity} ${total} campers (${bunksLabel}) - under sport min ${min}`
                        );
                    }
                });
            });
        });
        return { errors, warnings };
    }

    // =========================================================================
    // SHOW VALIDATION MODAL (★★★ v3.0: Collapsible sections + counts ★★★)
    // =========================================================================

    // ── v3.6 modal helpers ──────────────────────────────────────────────
    function _valPlainText(msg) {
        return String(msg || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function showValidationModal(errors, warnings = []) {
        // Remove existing modal
        const existing = document.getElementById('validator-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'validator-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0;
            background: rgba(15,23,42,0.55); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
            animation: fadeIn 0.15s;
        `;

        const clean = errors.length === 0 && warnings.length === 0;

        let body = '';
        if (clean) {
            body = `
                <div style="text-align:center; padding:48px 20px; color:#166534; width:100%;">
                    <div style="font-size:3.5em; margin-bottom:12px;">✅</div>
                    <h3 style="margin:0 0 8px 0; font-size:1.4em;">All clear!</h3>
                    <p style="color:#64748b; margin:0;">No problems found in this schedule.</p>
                </div>
            `;
        } else {
            // Two flat columns, red left / yellow right. A missing side lets
            // the other take the full width.
            body = buildSeverityColumn('red', errors) + buildSeverityColumn('yellow', warnings);
        }

        const chips = clean
            ? `<span style="background:#dcfce7;color:#166534;border-radius:99px;padding:3px 12px;font-size:0.8em;font-weight:700;">All clear</span>`
            : `${errors.length > 0 ? `<span style="background:#fee2e2;color:#b91c1c;border-radius:99px;padding:3px 12px;font-size:0.8em;font-weight:700;">🚫 ${errors.length} must fix</span>` : ''}
               ${warnings.length > 0 ? `<span style="background:#fef3c7;color:#92400e;border-radius:99px;padding:3px 12px;font-size:0.8em;font-weight:700;">⚠️ ${warnings.length} review</span>` : ''}`;

        overlay.innerHTML = `
            <div style="background:#fff; border-radius:14px; width:1250px; max-width:94vw; height:88vh; display:flex; flex-direction:column; box-shadow:0 20px 50px rgba(0,0,0,0.35); font-family: system-ui, -apple-system, sans-serif; overflow:hidden;">
                <div style="padding:14px 20px; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <h2 style="margin:0; font-size:1.1em; color:#0f172a; display:flex; align-items:center; gap:8px;">🛡️ Schedule Check</h2>
                    ${chips}
                    <div style="flex:1;"></div>
                    ${clean ? '' : `<input id="val-search" type="text" placeholder="Filter — bunk, grade, field, activity…"
                        style="width:280px; max-width:40vw; padding:7px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:0.88em; outline:none;">`}
                    <button id="val-close-x" style="background:none; border:none; font-size:1.5em; cursor:pointer; color:#94a3b8; padding:0 6px; line-height:1;">&times;</button>
                </div>
                <div id="val-body" style="display:flex; gap:0; overflow:hidden; flex:1; align-items:stretch;">${body}</div>
                <div style="padding:12px 20px; border-top:1px solid #e2e8f0; display:flex; gap:8px; align-items:center; background:#f8fafc;">
                    ${clean ? '' : `<button id="val-copy-btn" class="val-mini-btn">📋 Copy report</button>`}
                    <div style="flex:1;"></div>
                    <button id="val-rerun-btn" class="val-mini-btn">↻ Re-check</button>
                    <button id="val-close-btn" style="padding:10px 22px; background:#0f172a; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:0.95em;">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // ── Live filter: type a bunk / grade / field / activity ──
        const search = overlay.querySelector('#val-search');
        if (search) {
            search.oninput = () => {
                const q = search.value.toLowerCase().trim();
                overlay.querySelectorAll('.val-sev').forEach(col => {
                    let visible = 0;
                    col.querySelectorAll('.val-item').forEach(li => {
                        const hit = !q || li.textContent.toLowerCase().includes(q);
                        li.style.display = hit ? '' : 'none';
                        if (hit) visible++;
                    });
                    const total = col.querySelectorAll('.val-item').length;
                    const count = col.querySelector('.val-sev-count');
                    if (count) count.textContent = q ? `${visible}/${total}` : String(total);
                });
            };
        }

        // ── Copy a plain-text report ──
        const copyBtn = overlay.querySelector('#val-copy-btn');
        if (copyBtn) {
            copyBtn.onclick = () => {
                const lines = [];
                lines.push('Schedule Check — ' + (window.currentScheduleDate || ''));
                if (errors.length) {
                    lines.push('', 'MUST FIX (' + errors.length + '):');
                    errors.forEach(m => lines.push('  - ' + _valPlainText(m)));
                }
                if (warnings.length) {
                    lines.push('', 'REVIEW (' + warnings.length + '):');
                    warnings.forEach(m => lines.push('  - ' + _valPlainText(m)));
                }
                const text = lines.join('\n');
                const done = () => {
                    copyBtn.textContent = '✓ Copied';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy report'; }, 1500);
                };
                try {
                    navigator.clipboard.writeText(text).then(done, done);
                } catch (e) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                        done();
                    } catch (_) {}
                }
            };
        }

        // ── Close / re-run ──
        const close = () => overlay.remove();
        overlay.querySelector('#val-close-btn').onclick = close;
        overlay.querySelector('#val-close-x').onclick = close;
        const rerunBtn = overlay.querySelector('#val-rerun-btn');
        if (rerunBtn) rerunBtn.onclick = () => { close(); try { validateSchedule(); } catch (e) { console.warn('🛡️ re-check failed:', e); } };
        let _mdOverlayVal = false;
        overlay.addEventListener('mousedown', (e) => { _mdOverlayVal = (e.target === overlay); });
        overlay.onclick = (e) => { if (e.target === overlay && _mdOverlayVal) close(); };

        // ESC key to close
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * One severity column: sticky heading + a flat list of one-line items.
     * Red (must fix) sits left, yellow (review) right. Empty side is skipped
     * so the other takes the full width.
     */
    function buildSeverityColumn(kind, items) {
        if (!items || !items.length) return '';
        const red = kind === 'red';
        const dot = red ? '#dc2626' : '#f59e0b';
        const label = red ? 'Must fix' : 'Review';
        const labelColor = red ? '#b91c1c' : '#92400e';
        const bg = red ? '#fef2f2' : '#fffbeb';
        const fg = red ? '#991b1b' : '#92400e';
        const borderSide = red ? 'border-right:1px solid #e2e8f0;' : '';

        return `
            <div class="val-sev" data-sev="${kind}" style="flex:1; min-width:0; display:flex; flex-direction:column; ${borderSide}">
                <div style="display:flex; align-items:center; gap:8px; padding:12px 20px 10px 20px; border-bottom:1px solid #f1f5f9; background:#fcfcfd; flex:none;">
                    <span style="width:10px; height:10px; border-radius:50%; background:${dot}; flex:none;"></span>
                    <h3 style="margin:0; color:${labelColor}; font-size:0.95em;">${label}</h3>
                    <span class="val-sev-count" style="margin-left:auto; background:${bg}; color:${fg}; border-radius:99px; padding:1px 10px; font-weight:700; font-size:0.85em;">${items.length}</span>
                </div>
                <ul style="list-style:none; padding:10px 14px; margin:0; overflow-y:auto; flex:1;">
                    ${items.map(item => `
                        <li class="val-item" style="background:${bg}; color:${fg}; padding:8px 12px; margin-bottom:4px; border-radius:8px; border-left:3px solid ${dot}; font-size:0.88em; line-height:1.45;">
                            ${escMsg(item)}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }

    // ★★★ CB-58: violation messages embed user-controlled field / bunk /
    // division / activity names alongside intentional literal markup
    // (<strong>, <u>, <small>, <br>) and were rendered raw into innerHTML —
    // a field named with an <img onerror=> executed in the validator modal.
    // Full-escape the message, then restore ONLY the fixed whitelist of
    // attribute-free intentional tags. A malicious name like
    // "<img src=x onerror=...>" or "<u onmouseover=...>" never matches the
    // exact whitelisted tag strings, so it stays inert; the legitimate
    // formatting tags display correctly.
    function _valEsc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function escMsg(s) {
        let e = _valEsc(s);
        e = e.replace(/&lt;(\/?(?:strong|u|br|small))&gt;/g, '<$1>')
             .replace(/&lt;small style=&quot;color:#666;&quot;&gt;/g, '<small style="color:#666;">');
        return e;
    }

    // Add animation + shared button styles
    if (!document.getElementById('validator-style')) {
        const style = document.createElement('style');
        style.id = 'validator-style';
        style.innerHTML = `
            @keyframes fadeIn {
                from { opacity: 0; transform: scale(0.97); }
                to { opacity: 1; transform: scale(1); }
            }
            .val-mini-btn {
                padding: 7px 12px; background: #fff; color: #334155;
                border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer;
                font-weight: 600; font-size: 0.85em; font-family: inherit;
                white-space: nowrap;
            }
            .val-mini-btn:hover { background: #f1f5f9; }
            #val-search:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
        `;
        document.head.appendChild(style);
    }

    // Export
    window.validateSchedule = validateSchedule;
    window.ScheduleValidator = {
        validate: validateSchedule,
        getFieldCapacity: getFieldCapacity,
        getSharingRules: getSharingRules,
        // Standalone league-time-mismatch check so the generator can warn the
        // user immediately after a manual build (without popping the full modal).
        checkLeagueTimeMismatch: () => checkLeagueTimeMismatch(window.divisionTimes || {}),
        // ★ v3.1 checks exposed individually (console use + node sims)
        _v31: {
            collectTimedUsages,
            checkSpecialAccess,
            checkDisabledResources,
            checkBunkOnlyAccess,
            checkLeagueFieldConflicts,
            checkFieldQuality,
            // v3.1.1: core checks exposed so the pinned-event exemption is testable
            checkFieldConflicts,
            checkSameDayRepetitions,
            checkSameDayFieldRepetitions,
            isPinnedEventEntry,
            // v3.2: sports rules
            checkCooldownRules,
            checkSportPlayerRules,
            // CHECK 17: span-aware pin-vs-pin facility conflicts
            annotatePinSpans,
            checkPinnedTileConflicts
        }
    };

    console.log('🛡️ Validator v3.6 loaded — compact one-line findings, red|yellow side-by-side results');

})();
