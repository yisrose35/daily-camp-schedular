// =================================================================
// auto_validator.js v1.0 — AUTO MODE SCHEDULE VALIDATOR
// =================================================================
//
// Purpose: Validates schedules produced by the auto-scheduler.
//          Uses per-bunk time geometry (_perBunkSlots) and reads
//          sharing config from globalSettings (authoritative source).
//
// KEY DIFFERENCE FROM validator.js:
//   - Uses PAIRWISE time overlap, not transitive union-find grouping
//   - Reads sharing rules from globalSettings fields (not activityProperties)
//   - Enforces EXACT TIME MATCH for field sharing (no mid-game joins/leaves)
//   - Skips _league, _autoSpecial, and non-sport entries
//   - Designed for auto-mode output only
//
// CHECKS:
//   A. Cross-division conflicts (same field, different grades, overlapping time)
//   B. Per-field capacity violations (too many bunks at same time)
//   C. Staggered sharing violations (shared field but mismatched start/end)
//   D. Same-day activity repetitions
//   E. Same-day field repetitions
//
// =================================================================

(function() {
    'use strict';

    // =====================================================================
    // CONFIG
    // =====================================================================

    const SKIP_FIELDS = new Set([
        'free', 'no field', 'lunch', 'snacks', 'dismissal',
        'swim', 'pool', 'custom', 'transition', 'buffer',
        'canteen', 'mincha', 'davening', 'lineup', 'bus',
        'regroup', 'free play',
        // Transition / cleanup / generic non-facility labels. These are NOT real
        // contended facilities (a whole grade "changes" or "cleans up" together,
        // and "main activity" is the generic label for a custom pinned block with
        // no assigned room). Without these, an unmapped label defaults to
        // {not_sharable, cap 1} (see checkCrossDivision) and every co-occupancy is
        // falsely reported as a cross-division/capacity conflict.
        'change', 'cleanup', 'main activity'
    ]);

    const SKIP_ACTIVITIES = new Set([
        'free', 'lunch', 'snacks', 'dismissal', 'swim', 'pool',
        'canteen', 'gameroom', 'game room', 'transition', 'buffer',
        'mincha', 'davening', 'lineup', 'bus', 'regroup', 'free play',
        // Transition/cleanup labels repeat every day by design (e.g. change before
        // and after swim) — not real same-day activity repetitions.
        'change', 'cleanup', 'main activity'
    ]);

    const isLeagueField = (fn) => /^game\s*\d+$/i.test(fn);

    // =====================================================================
    // SHARING RULES — Read from globalSettings (authoritative source)
    // =====================================================================

    function buildFieldSharingMap() {
        const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        const fields = gs.app1?.fields || gs.fields || [];
        const map = new Map();

        fields.forEach(f => {
            if (!f.name) return;
            const sw = f.sharableWith || {};
            let type = sw.type || 'not_sharable';
            const divs = Array.isArray(sw.divisions) ? sw.divisions : [];

            // Normalize orphaned types
            if (type === 'custom' && divs.length === 0) type = 'same_division';
            if (type === 'all') type = 'same_division';

            map.set(f.name.toLowerCase().trim(), {
                name: f.name,
                type,
                capacity: parseInt(sw.capacity) || (type === 'not_sharable' ? 1 : 2),
                divisions: divs
            });
        });

        // Also add special activity locations
        const specials = gs.app1?.specialActivities || gs.specialActivities || [];
        specials.forEach(s => {
            if (!s.name) return;
            const loc = s.location || s.name;
            const key = loc.toLowerCase().trim();
            if (map.has(key)) return; // field definition takes precedence
            const sw = s.sharableWith || {};
            let type = sw.type || 'not_sharable';
            const divs = Array.isArray(sw.divisions) ? sw.divisions : [];
            if (type === 'custom' && divs.length === 0) type = 'same_division';
            if (type === 'all') type = 'same_division';
            map.set(key, {
                name: loc,
                type,
                capacity: parseInt(sw.capacity) || (type === 'not_sharable' ? 1 : 2),
                divisions: divs,
                _isSpecial: true
            });
        });

        return map;
    }

    // =====================================================================
    // HELPERS
    // =====================================================================

    function buildBunkGradeMap(divisions) {
        const map = {};
        Object.entries(divisions).forEach(([grade, data]) => {
            (data.bunks || []).forEach(b => { map[String(b)] = grade; });
        });
        return map;
    }

    function getBunkSlotTime(bunk, grade, idx, divisionTimes) {
        const pbs = divisionTimes[grade]?._perBunkSlots?.[bunk];
        if (pbs && pbs[idx]) return pbs[idx];
        // Fallback to division-level times
        const divSlots = divisionTimes[grade] || [];
        return divSlots[idx] || null;
    }

    function formatTime(minutes) {
        if (minutes == null) return '?';
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    function timesOverlap(s1, e1, s2, e2) {
        return s1 < e2 && e1 > s2;
    }

    // =====================================================================
    // BUILD FIELD USAGE INDEX
    // =====================================================================

    function buildFieldUsageIndex(assignments, divisions, divisionTimes, bunkGrade) {
        const index = new Map(); // fieldNorm → [{ bunk, grade, startMin, endMin, idx, field, activity, flags }]

        Object.entries(assignments).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const grade = bunkGrade[String(bunk)] || '';

            slots.forEach((entry, idx) => {
                if (!entry || !entry.field || entry.field === 'Free') return;
                if (entry.continuation) return;
                // Trips are offsite events, not field bookings — many bunks
                // "at the Zoo" simultaneously is the intended state, not a
                // cross-division conflict / capacity violation (FN-59).
                if (entry._isTrip) return;

                // Custom-layer blocks (user-named "Morning Activity" / "Main
                // Activity" / Davening, etc.) used to be skipped wholesale —
                // assumed to be whole-grade activities the entire grade does
                // together. That assumption fails once each general activity can
                // carry its OWN sharing config (per-activity config, "like
                // specials"). E.g. "Morning Activity" at Auditorium configured
                // not_sharable cap 1 → having Harmony + Prop on it at the same
                // time IS a real conflict.
                //
                // Now we INCLUDE customs in the index, attach the resolved
                // per-activity sharing (layer override → ga config → field
                // fallback) to each entry, and let the share check consult that
                // resolved rule for same-activity pairs.
                const isCustomEntry = (entry.type === 'custom') || !!entry._customActivity;
                const customActLow = String(entry._customActivity || (isCustomEntry ? (entry._activity || entry.field) : '') || '').toLowerCase().trim();
                let _resolvedCustomSharing = null;
                if (isCustomEntry && typeof window.getCustomActivitySharingInfo === 'function') {
                    try {
                        const _r = window.getCustomActivitySharingInfo(
                            entry._customActivity || entry._activity,
                            entry._customField || entry.field,
                            entry._customSharing || null,
                            (window.loadGlobalSettings ? window.loadGlobalSettings() : {})
                        );
                        // Normalize 'all' and orphan 'custom' to the same buckets
                        // buildFieldSharingMap uses, so the cross-div check applies
                        // the same gates.
                        let _rt = _r.shareType || 'not_sharable';
                        const _rd = Array.isArray(_r.allowedDivisions) ? _r.allowedDivisions : [];
                        if (_rt === 'custom' && _rd.length === 0) _rt = 'same_division';
                        if (_rt === 'all') _rt = 'same_division';
                        _resolvedCustomSharing = {
                            type: _rt,
                            capacity: parseInt(_r.capacity) || (_rt === 'not_sharable' ? 1 : 2),
                            divisions: _rd,
                            allowedPairs: _r.allowedPairs || {},
                            _source: _r.source
                        };
                    } catch (_eR) { /* fall through to field lookup */ }
                }
                // Honor the legacy whole-grade defaults: if the resolved sharing
                // came from neither layer nor ga config (i.e. source='field' or
                // 'default') AND the activity name matches the historically-
                // exempt set (main activity / morning activity / davening etc.),
                // keep skipping. This preserves backward compatibility for camps
                // that haven't configured anything per-activity yet — they don't
                // suddenly start failing validation.
                if (isCustomEntry && _resolvedCustomSharing && (_resolvedCustomSharing._source === 'field' || _resolvedCustomSharing._source === 'default') &&
                    (SKIP_ACTIVITIES.has(customActLow) || customActLow === '')) {
                    return;
                }
                if (isCustomEntry && !_resolvedCustomSharing) return;

                const fn = entry.field.toLowerCase().trim();
                if (SKIP_FIELDS.has(fn) || isLeagueField(fn)) return;

                const slot = getBunkSlotTime(bunk, grade, idx, divisionTimes);
                if (!slot || slot.startMin == null || slot.endMin == null) return;

                const flags = {
                    _league: !!entry._league,
                    _autoSpecial: !!entry._autoSpecial,
                    _pinned: !!entry._pinned,
                    _fixed: !!entry._fixed,
                    // ★ Staggered shared-room custom reserve: per-grade non-overlapping
                    //   tiling of the SAME custom activity in a shared room is intentional,
                    //   not a violation. Carry the flag + the custom-activity name so the
                    //   share checks can exempt an all-reserved-same-act overlap group.
                    _staggerReserved: !!entry._staggerReserved,
                    _customAct: customActLow,
                    // ★ Resolved per-activity sharing for this custom usage. When
                    //   two usages of the SAME custom activity overlap, the share
                    //   check uses this instead of the field's rule (Morning
                    //   Activity may share even though Auditorium is not_sharable,
                    //   or vice-versa).
                    _resolvedSharing: _resolvedCustomSharing
                };

                if (!index.has(fn)) index.set(fn, []);
                index.get(fn).push({
                    bunk: String(bunk),
                    grade,
                    startMin: slot.startMin,
                    endMin: slot.endMin,
                    idx,
                    field: entry.field,
                    activity: (entry._activity || entry.sport || entry.field || '').toLowerCase().trim(),
                    flags
                });
            });
        });

        return index;
    }

    // =====================================================================
    // CHECK A: CROSS-DIVISION CONFLICTS (pairwise, not transitive)
    // =====================================================================

    function checkCrossDivision(fieldIndex, sharingMap) {
        const errors = [];

        fieldIndex.forEach((usages, fieldNorm) => {
            const _rawSharing = sharingMap.get(fieldNorm);
            const _anyPerActivity = usages.some(u => u.flags && u.flags._resolvedSharing);
            // ★ Configured resources only (mirror of CHECK B's guard). A label NOT in
            //   the sharing map is an unconfigured custom-layer anchor — e.g. "Morning
            //   Activity" that each grade does in its own space with no real facility.
            //   Defaulting it to not_sharable/cap-1 below made the validator invent a
            //   single shared room and flag every cross-grade co-occurrence as a
            //   conflict (172 phantom "Morning activity" errors). Skip unless a usage
            //   carries a real per-activity sharing rule that genuinely governs sharing.
            if (!_rawSharing && !_anyPerActivity) return;
            const sharing = _rawSharing || { type: 'not_sharable', capacity: 1, divisions: [] };

            // Specials ARE enforced here, exactly like fields: a special's sharableWith
            // governs cross-grade co-occupancy under the user's 3 options — not_sharable
            // (never shared, any grade), same_division (one grade at a time), cross_division
            // (any grade up to cap). Previously specials were skipped (`_isSpecial`), which
            // let a not_sharable special be shared ACROSS grades with 0 reported errors.
            // Unconfigured custom-layer anchors stay skipped by the `!_rawSharing` guard
            // above, and same-grade over-capacity is still caught by CHECK B (capacity).

            // Only check fields where cross-div matters, EXCEPT keep iterating
            // when any usage carries a per-activity resolved sharing rule (a
            // 'cross_division' field with a 'not_sharable' per-activity rule
            // would otherwise be skipped here and the conflict missed).
            if (!_anyPerActivity &&
                sharing.type !== 'same_division' && sharing.type !== 'not_sharable' && sharing.type !== 'custom') return;

            for (let i = 0; i < usages.length; i++) {
                const a = usages[i];
                // Leagues self-manage cross-grade scheduling; everything
                // else (sports + specials) competes for the same physical
                // facility and must not cross-claim it.
                if (a.flags._league) continue;

                for (let j = i + 1; j < usages.length; j++) {
                    const b = usages[j];
                    if (b.flags._league) continue;
                    if (a.grade === b.grade) continue;
                    if (!timesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

                    // ★ Reserved-tiling exemption: both are _staggerReserved uses of the
                    //   SAME custom activity, sequenced per-grade on a common timeline in a
                    //   shared room. Their windows are non-overlapping by construction (the
                    //   solver only sets _staggerReserved on a genuine non-overlap), so any
                    //   "overlap" here is boundary-touching tiling — not a real cross-grade
                    //   share. A non-reserved consumer still flags normally.
                    if (a.flags._staggerReserved && b.flags._staggerReserved &&
                        a.flags._customAct && a.flags._customAct === b.flags._customAct) continue;

                    // ★ Per-activity sharing for same-activity custom pairs (like
                    //   specials). When two grades use the SAME custom activity
                    //   (e.g. Morning Activity), the activity's own sharing rule
                    //   governs — not the field's (Auditorium may be not_sharable
                    //   while Morning Activity allows cross-grade share, or
                    //   vice-versa). Different activities at the same field fall
                    //   back to the field's rule.
                    let effectiveSharing = sharing;
                    if (a.flags._customAct && a.flags._customAct === b.flags._customAct &&
                        a.flags._resolvedSharing) {
                        effectiveSharing = a.flags._resolvedSharing;
                    }

                    // Cross-division overlap detected
                    let isViolation = false;

                    if (effectiveSharing.type === 'not_sharable') {
                        isViolation = true;
                    } else if (effectiveSharing.type === 'same_division') {
                        isViolation = true;
                    } else if (effectiveSharing.type === 'custom') {
                        const allowed = effectiveSharing.divisions || [];
                        if (allowed.length > 0) {
                            isViolation = !allowed.includes(a.grade) || !allowed.includes(b.grade);
                        } else {
                            isViolation = true; // empty custom = same_division
                        }
                    } else if (effectiveSharing.type === 'cross_division') {
                        // ★ Pair-gated cross-division share. Each ordered pair must
                        //   be in allowedPairs; otherwise the pair is a violation.
                        const pairs = effectiveSharing.allowedPairs || {};
                        const pk = [String(a.grade), String(b.grade)].sort().join('|');
                        isViolation = pairs[pk] !== true;
                    }

                    if (isViolation) {
                        const timeLabel = `${formatTime(Math.min(a.startMin, b.startMin))} - ${formatTime(Math.max(a.endMin, b.endMin))}`;
                        // Label by the activity name when the per-activity rule
                        // is what flagged this (matches the user's mental model:
                        // "Morning Activity is not_sharable" vs. "Auditorium").
                        const usedActivityRule = (effectiveSharing !== sharing);
                        const subject = usedActivityRule && a.flags._customAct ? a.flags._customAct : a.field;
                        errors.push({
                            type: 'cross_division',
                            field: a.field,
                            fieldNorm,
                            shareType: effectiveSharing.type,
                            bunks: [
                                { bunk: a.bunk, grade: a.grade, time: `${a.startMin}-${a.endMin}` },
                                { bunk: b.bunk, grade: b.grade, time: `${b.startMin}-${b.endMin}` }
                            ],
                            timeLabel,
                            message: `<strong>Cross-Division Conflict:</strong> <u>${subject}</u> ` +
                                `(${effectiveSharing.type}, cap ${effectiveSharing.capacity}) used by ` +
                                `${a.bunk} (${a.grade}) @ ${formatTime(a.startMin)}-${formatTime(a.endMin)} and ` +
                                `${b.bunk} (${b.grade}) @ ${formatTime(b.startMin)}-${formatTime(b.endMin)}`
                        });
                    }
                }
            }
        });

        return errors;
    }

    // =====================================================================
    // CHECK B: CAPACITY VIOLATIONS (peak concurrent at any moment)
    // =====================================================================

    function checkCapacity(fieldIndex, sharingMap) {
        const errors = [];

        fieldIndex.forEach((usages, fieldNorm) => {
            // ★ Only configured resources are capacity-checked. A field/room/special the
            //   camp actually defined is in the sharing map (real fields + every special,
            //   incl. cap-1 unconfigured ones). A label that is NOT in the map is a custom
            //   layer or generic block (e.g. a user-named "Morning Activity" the whole grade
            //   does together) — not a contended resource. Treating unmapped as cap-1 here
            //   produced false positives like "Morning Activity has 4 Harmony bunks (cap 1)".
            const sharing = sharingMap.get(fieldNorm);
            if (!sharing) return;

            // Include sports + specials (both compete for the field).
            // Only exclude leagues (which run their own field-allocator).
            const sportUsages = usages.filter(u => !u.flags._league);
            if (sportUsages.length < 2) return;

            // Group by grade (for same_division, capacity is per-grade)
            const byGrade = {};
            sportUsages.forEach(u => {
                if (!byGrade[u.grade]) byGrade[u.grade] = [];
                byGrade[u.grade].push(u);
            });

            Object.entries(byGrade).forEach(([grade, gradeUsages]) => {
                // ★ If every usage in this grade group is the SAME custom
                //   activity with a resolved per-activity sharing, use the
                //   activity's capacity — Morning Activity's per-activity cap
                //   may differ from Auditorium's field cap.
                let effectiveCap = sharing.capacity;
                const firstAct = gradeUsages[0]?.flags?._customAct || '';
                const firstShare = gradeUsages[0]?.flags?._resolvedSharing;
                if (firstShare && firstAct &&
                    gradeUsages.every(u => u.flags._customAct === firstAct && u.flags._resolvedSharing)) {
                    effectiveCap = firstShare.capacity;
                }
                if (gradeUsages.length <= effectiveCap) return;

                // Find peak concurrent usage using time sweep
                const events = [];
                gradeUsages.forEach(u => {
                    events.push({ time: u.startMin, type: 'start', usage: u });
                    events.push({ time: u.endMin, type: 'end', usage: u });
                });
                events.sort((a, b) => a.time - b.time || (a.type === 'end' ? -1 : 1));

                let concurrent = 0;
                let peak = 0;
                let peakTime = 0;
                const activeBunks = [];

                events.forEach(ev => {
                    if (ev.type === 'start') {
                        concurrent++;
                        activeBunks.push(ev.usage);
                        if (concurrent > peak) {
                            peak = concurrent;
                            peakTime = ev.time;
                        }
                    } else {
                        concurrent--;
                        const idx = activeBunks.indexOf(ev.usage);
                        if (idx !== -1) activeBunks.splice(idx, 1);
                    }
                });

                if (peak > effectiveCap) {
                    // Find which bunks are active at peak time
                    const peakBunks = gradeUsages.filter(u =>
                        u.startMin <= peakTime && u.endMin > peakTime
                    );
                    // Label by the activity when the per-activity rule applied
                    // (matches "Morning Activity (cap 4)" mental model).
                    const usedActivityRule = (effectiveCap !== sharing.capacity);
                    const subject = (usedActivityRule && firstAct) ? firstAct : gradeUsages[0].field;
                    errors.push({
                        type: 'capacity',
                        field: gradeUsages[0].field,
                        fieldNorm,
                        grade,
                        peak,
                        capacity: effectiveCap,
                        message: `<strong>Capacity Exceeded:</strong> <u>${subject}</u> ` +
                            `has <strong>${peak}</strong> ${grade} bunks at ${formatTime(peakTime)} ` +
                            `(capacity: ${effectiveCap})<br>` +
                            `<small style="color:#666;">Bunks: ${peakBunks.map(u => `${u.bunk} @ ${formatTime(u.startMin)}-${formatTime(u.endMin)}`).join(', ')}</small>`
                    });
                }
            });
        });

        return errors;
    }

    // =====================================================================
    // CHECK C: STAGGERED SHARING VIOLATIONS
    // Two bunks on the same field must have IDENTICAL start and end times.
    // No mid-game joins, no early departures.
    // =====================================================================

    function checkStaggeredSharing(fieldIndex, sharingMap) {
        const errors = [];
        const seen = new Set(); // Deduplicate

        fieldIndex.forEach((usages, fieldNorm) => {
            const sharing = sharingMap.get(fieldNorm) || { type: 'not_sharable', capacity: 1 };
            if (sharing.capacity <= 1) return; // Single-use field, no sharing to check

            // ★ FIX: staggered timing is ALWAYS a violation when two bunks
            //   share the same field. Mid-activity arrivals/departures
            //   never make sense operationally — one bunk shows up at 9:25
            //   to find another already 25 minutes into the game on the
            //   same court. The opt-in strictTiming gate was wrong; it
            //   allowed real bugs to ship. Now: always check, regardless.
            //   Also: check ACROSS grades too — Check A only flags grade
            //   mismatches when the field's sharing.type forbids cross-
            //   division use. A field with type='any_division' allowing
            //   staggered cross-grade overlap was passing silently.
            //   ALSO: include specials. Origami at the Arts Room is just
            //   as physically constrained as Basketball on the Court —
            //   two bunks can't arrive 25 minutes apart and share it.
            //   Previously _autoSpecial was filtered out across all
            //   checks, which made specials-on-shared-fields invisible.

            // Include sport + special entries; only leagues are league-
            // managed externally and may legitimately stagger by design.
            const sportUsages = usages.filter(u => !u.flags._league);
            if (sportUsages.length < 2) return;

            for (let i = 0; i < sportUsages.length; i++) {
                const a = sportUsages[i];
                for (let j = i + 1; j < sportUsages.length; j++) {
                    const b = sportUsages[j];

                    // Must overlap in time
                    if (!timesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

                    // ★ Reserved-tiling exemption: both are _staggerReserved uses of the
                    //   SAME custom activity → a legitimate sequenced share, not a stagger
                    //   violation. A real (non-reserved) consumer still flags normally.
                    if (a.flags._staggerReserved && b.flags._staggerReserved &&
                        a.flags._customAct && a.flags._customAct === b.flags._customAct) continue;

                    // ★ Legitimate cross-division share exemption: a resource the camp
                    //   explicitly configured for cross-division use (cross_division /
                    //   any_division, or custom with a divisions list) is DESIGNED for
                    //   different divisions to use the same high-capacity resource on their
                    //   own division clocks. Two divisions arriving at offset times to a
                    //   shared arts room (cap 20) is the intended state, not a broken
                    //   single-game share. Same-grade overlap is never exempt — within one
                    //   division an offset arrival is always a real stagger. This is the
                    //   exact pivot FN-54 in the engine uses, so engine + report agree.
                    if (a.grade !== b.grade &&
                        (sharing.type === 'cross_division' || sharing.type === 'any_division' || sharing.type === 'custom')) continue;

                    // ★ Stagger = LATE JOIN (different start times). The disruptive case is a
                    //   bunk walking into a session already in progress — "shows up at 9:25 to
                    //   find another 25 min into the game." Two bunks that START TOGETHER but
                    //   run different durations (early departure / a multi-period bunk staying
                    //   longer) is benign: nobody joins mid-session, and rotated/multi-period
                    //   schedules legitimately produce this. Flag only on a differing START.
                    //   (Engine FN-54 uses the identical pivot, so report + engine agree.)
                    if (a.startMin !== b.startMin) {
                        const key = [fieldNorm, a.bunk, b.bunk, a.startMin, b.startMin].sort().join('|');
                        if (seen.has(key)) continue;
                        seen.add(key);

                        const sameGrade = a.grade === b.grade;
                        errors.push({
                            type: 'staggered_sharing',
                            field: a.field,
                            fieldNorm,
                            grade: a.grade,
                            message: `<strong>Staggered Sharing:</strong> <u>${a.field}</u> shared by ` +
                                `${a.bunk} (${a.grade}, ${formatTime(a.startMin)}-${formatTime(a.endMin)}) and ` +
                                `${b.bunk} (${b.grade}, ${formatTime(b.startMin)}-${formatTime(b.endMin)})` +
                                (sameGrade ? '' : ' (cross-grade)') +
                                `. Bunks sharing a field must start at the same time (no mid-session joins).`
                        });
                    }
                }
            }
        });

        return errors;
    }

    // =====================================================================
    // CHECK D: SAME-DAY ACTIVITY REPETITIONS
    // =====================================================================

    function checkSameDayRepetitions(assignments, bunkGrade, divisionTimes) {
        const errors = [];

        Object.entries(assignments).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const grade = bunkGrade[String(bunk)] || '';
            const seen = new Map(); // activity → first occurrence info

            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                if (entry._league || entry._autoSpecial) return;
                // Anti-blank last-resort fills (STEP 7.66) intentionally allow a
                // repeat rather than leave a bunk with a Free/blank period in a
                // packed dead-end. Don't flag them as same-day-repeat errors.
                if (entry._antiBlankFilled) return;
                // Generic-layout tiles are CATEGORIES (Sport / Special: Uncategorized /
                // …), not concrete activities. The model is "categories repeat, activities
                // don't" — two "Sport" tiles in a day is NOT a repetition; only two of the
                // same specific activity (Basketball) would be, and that uniqueness is
                // enforced when fill assigns the concrete activity. Skip them so the
                // generic preview doesn't report false same-day-repeat errors.
                if (entry._generic) return;
                if (!entry.field || entry.field === 'Free') return;

                const act = (entry._activity || entry.sport || entry.field || '').toLowerCase().trim();
                if (!act || SKIP_ACTIVITIES.has(act)) return;

                const slot = getBunkSlotTime(bunk, grade, idx, divisionTimes);
                const timeLabel = slot ? formatTime(slot.startMin) : `slot ${idx}`;

                if (seen.has(act)) {
                    const first = seen.get(act);
                    errors.push({
                        type: 'same_day_repeat',
                        bunk,
                        grade,
                        activity: act,
                        message: `<strong>Same-Day Repetition:</strong> <u>${bunk}</u> (${grade}) ` +
                            `has <strong>"${act}"</strong> at both ${first.timeLabel} and ${timeLabel}`
                    });
                } else {
                    seen.set(act, { idx, timeLabel });
                }
            });
        });

        return errors;
    }

    // =====================================================================
    // CHECK E: SAME-DAY FIELD REPETITIONS
    // =====================================================================

    function checkSameDayFieldRepetitions(assignments, bunkGrade, divisionTimes) {
        const warnings = [];

        Object.entries(assignments).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const grade = bunkGrade[String(bunk)] || '';
            const seen = new Map(); // fieldNorm → [{ idx, timeLabel, activity }]

            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                if (entry._league || entry._autoSpecial) return;
                if (!entry.field || entry.field === 'Free') return;

                const fn = entry.field.toLowerCase().trim();
                if (SKIP_FIELDS.has(fn) || isLeagueField(fn)) return;

                const act = (entry._activity || entry.sport || entry.field || '').toLowerCase().trim();
                const slot = getBunkSlotTime(bunk, grade, idx, divisionTimes);
                const timeLabel = slot ? formatTime(slot.startMin) : `slot ${idx}`;

                if (!seen.has(fn)) seen.set(fn, []);
                seen.get(fn).push({ idx, timeLabel, activity: act });
            });

            seen.forEach((occurrences, fn) => {
                if (occurrences.length <= 1) return;
                const uniqueActs = [...new Set(occurrences.map(o => o.activity))];
                warnings.push({
                    type: 'field_reuse',
                    bunk,
                    grade,
                    field: fn,
                    message: `<strong>Field Reuse:</strong> <u>${bunk}</u> (${grade}) uses ` +
                        `<strong>"${fn}"</strong> ${occurrences.length} times today` +
                        `${uniqueActs.length > 1 ? ' (different activities)' : ''}<br>` +
                        `<small style="color:#666;">At: ${occurrences.map(o => `${o.timeLabel} (${o.activity})`).join(', ')}</small>`
                });
            });
        });

        return warnings;
    }

    // =====================================================================
    // MAIN VALIDATION FUNCTION
    // =====================================================================

    // ★ ELECTIVE facility reservations. An elective tile reserves its activities/
    //   locations for its own grade's window; nothing from ANOTHER grade may sit on
    //   those facilities at that time. Electives create NO schedule entry (they
    //   render from the skeleton), so the field-usage index above never sees them —
    //   this rebuilds the reservations straight from the skeleton and flags any
    //   foreign-grade placement on them. Own grade is exempt (elective division
    //   lock). Pins fill real entries, so they are already covered elsewhere.
    function checkElectiveReservations(assignments, bunkGrade, divisionTimes) {
        const errors = [];
        const Utils = window.SchedulerCoreUtils;
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

        const keyLc = {};
        let anyElective = false;
        Object.keys(resv).forEach(k => {
            const list = (resv[k] || []).filter(r => r && (r.type === 'elective' || r.type === 'swim_elective'));
            if (list.length) { keyLc[String(k).toLowerCase().trim()] = { key: k, list: list }; anyElective = true; }
        });
        if (!anyElective) return errors;

        const specLoc = {};
        const gs = (window.loadGlobalSettings && window.loadGlobalSettings()) || window.globalSettings || {};
        (((gs.app1 && gs.app1.specialActivities) || gs.specialActivities || [])).forEach(s => {
            if (s && s.name && s.location) { const n = String(s.name).toLowerCase().trim(); if (!specLoc[n]) specLoc[n] = s.location; }
        });
        const resolveLoc = window.getLocationForActivity;
        const IGN = { 'free': 1, 'free play': 1, 'lunch': 1, 'snacks': 1, 'dismissal': 1, 'swim': 1, 'transition': 1, 'buffer': 1 };

        const seen = new Set();
        Object.keys(assignments).forEach(bunk => {
            const arr = assignments[bunk];
            if (!Array.isArray(arr)) return;
            const grade = bunkGrade[String(bunk)];
            const gSlots = divisionTimes[grade] || [];
            arr.forEach((entry, idx) => {
                if (!entry || entry.continuation || entry._pinned) return;
                const act = entry._activity || entry.field;
                if (!act || IGN[String(act).toLowerCase().trim()]) return;
                if (entry._league || entry._leagueMatchups || entry.matchups) return;
                let sM = entry._startMin, eM = entry._endMin;
                if (sM == null || eM == null) { const sl = gSlots[idx]; if (sl) { sM = sl.startMin; eM = sl.endMin; } }
                if (sM == null || eM == null) return;
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
                        if (r.division && String(r.division) === String(grade)) continue;
                        if (String(act).toLowerCase().trim() === String(r.event || '').toLowerCase().trim()) continue;
                        const sig = rec.key + '|' + bunk + '|' + sM;
                        if (seen.has(sig)) continue;
                        seen.add(sig);
                        errors.push({
                            type: 'elective_reservation',
                            message: 'Elective Facility Conflict: ' + bunk + ' (' + grade + ') has "' + act + '" on ' +
                                rec.key + ' at ' + formatTime(sM) + '-' + formatTime(eM) +
                                ', but that facility is reserved by an elective for ' + r.division + ' during this time'
                        });
                        break;
                    }
                }
            });
        });
        return errors;
    }

    function validateAutoSchedule(opts) {
        // ★ opts.silent = true → run the validation LOGIC and return the result
        //   WITHOUT showing the modal. Used by automated post-gen consumers (the
        //   capacity-repair gate) that only need the data. The user-facing
        //   validation BUTTON (window.validateSchedule) calls with no opts, so it
        //   still pops the modal as before.
        const _silent = !!(opts && opts.silent);
        console.log('🛡️ Running AUTO MODE schedule validation v1.0...');

        const assignments = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const divisionTimes = window.divisionTimes || {};

        const bunkGrade = buildBunkGradeMap(divisions);
        const sharingMap = buildFieldSharingMap();
        const fieldIndex = buildFieldUsageIndex(assignments, divisions, divisionTimes, bunkGrade);

        const allErrors = [];
        const allWarnings = [];

        // A. Cross-division conflicts
        const crossDivErrors = checkCrossDivision(fieldIndex, sharingMap);
        crossDivErrors.forEach(e => allErrors.push(e));

        // B. Capacity violations
        const capErrors = checkCapacity(fieldIndex, sharingMap);
        capErrors.forEach(e => allErrors.push(e));

        // C. Staggered sharing violations
        const staggerErrors = checkStaggeredSharing(fieldIndex, sharingMap);
        staggerErrors.forEach(e => allErrors.push(e));

        // D. Same-day activity repetitions
        const repeatErrors = checkSameDayRepetitions(assignments, bunkGrade, divisionTimes);
        repeatErrors.forEach(e => allErrors.push(e));

        // E. Same-day field repetitions
        const fieldRepWarnings = checkSameDayFieldRepetitions(assignments, bunkGrade, divisionTimes);
        fieldRepWarnings.forEach(w => allWarnings.push(w));

        // F. Elective facility reservations (foreign grade on an elective's facility)
        let electiveErrors = [];
        try { electiveErrors = checkElectiveReservations(assignments, bunkGrade, divisionTimes); }
        catch (e) { console.warn('🛡️ elective-reservation check failed:', e); }
        electiveErrors.forEach(e => allErrors.push(e));

        // ── Summary ──
        const summary = {
            crossDivision: crossDivErrors.length,
            capacity: capErrors.length,
            staggeredSharing: staggerErrors.length,
            sameDayRepeat: repeatErrors.length,
            fieldReuse: fieldRepWarnings.length,
            electiveReservation: electiveErrors.length
        };

        console.log('🛡️ Auto Validator Results:');
        console.log('  Cross-division conflicts:', summary.crossDivision);
        console.log('  Capacity violations:', summary.capacity);
        console.log('  Staggered sharing:', summary.staggeredSharing);
        console.log('  Same-day repeats:', summary.sameDayRepeat);
        console.log('  Field reuse warnings:', summary.fieldReuse);
        console.log('  Elective reservations:', summary.electiveReservation);
        console.log('  TOTAL errors:', allErrors.length);

        // ── Per-error detail (so the offending field/grade/bunks are visible
        //    in the console, not just a count). Strips the HTML from the
        //    modal-oriented `message` into a one-line plain-text summary.
        if (allErrors.length) {
            const _plain = (s) => String(s || '')
                .replace(/<br\s*\/?>/gi, ' — ')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            console.log('🛡️ Auto Validator — error detail:');
            allErrors.forEach((e, i) => {
                console.log('   ' + (i + 1) + '. [' + e.type + '] ' + _plain(e.message));
            });
        }

        // Show modal (skipped for silent/automated callers)
        if (!_silent) showAutoValidatorModal(allErrors, allWarnings, summary);

        return { errors: allErrors, warnings: allWarnings, summary };
    }

    // =====================================================================
    // MODAL
    // =====================================================================

    // ★★★ CB-59 (twin of CB-58 in validator.js): violation/warning messages
    // embed user-controlled field/bunk/grade names with intentional literal
    // markup (<strong>, <u>, <small>, <br>) and were rendered raw into
    // innerHTML. Full-escape then restore only the fixed whitelist of
    // attribute-free intentional tags — a name carrying an <img onerror=> or
    // <u onmouseover=> never matches the exact whitelist and stays inert.
    function _avEscMsg(s) {
        let e = String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
        return e.replace(/&lt;(\/?(?:strong|u|br|small))&gt;/g, '<$1>')
                .replace(/&lt;small style=&quot;color:#666;&quot;&gt;/g, '<small style="color:#666;">');
    }

    function showAutoValidatorModal(errors, warnings, summary) {
        const existing = document.getElementById('auto-validator-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'auto-validator-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
            animation: fadeIn 0.2s;
        `;

        const isClean = errors.length === 0 && warnings.length === 0;

        let html = `
            <div style="background:white; padding:25px; border-radius:12px; width:750px; max-width:90vw; max-height:85vh; overflow-y:auto; box-shadow:0 10px 25px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:15px;">
                    <h2 style="margin:0; color:#333; display:flex; align-items:center; gap:8px;">
                        🛡️ Auto Schedule Validator
                        <span style="font-size:0.6em; background:#e0e0e0; padding:2px 8px; border-radius:4px;">v1.0</span>
                    </h2>
                    <button id="auto-val-close-x" style="background:none; border:none; font-size:1.5em; cursor:pointer; color:#888; padding:0 8px;">&times;</button>
                </div>
        `;

        if (isClean) {
            html += `
                <div style="text-align:center; padding:40px 20px; color:#2e7d32;">
                    <div style="font-size:4em; margin-bottom:15px;">✅</div>
                    <h3 style="margin:0 0 10px 0; font-size:1.5em;">All Clear!</h3>
                    <p style="color:#666; margin:0;">No conflicts or issues detected in auto-generated schedule.</p>
                </div>
            `;
        } else {
            // Summary cards
            html += `<div style="display:flex; gap:8px; margin-bottom:20px; flex-wrap:wrap;">`;
            const cards = [
                { label: 'Cross-Div', count: summary.crossDivision, color: '#C62828' },
                { label: 'Capacity', count: summary.capacity, color: '#AD1457' },
                { label: 'Staggered', count: summary.staggeredSharing, color: '#E65100' },
                { label: 'Repeats', count: summary.sameDayRepeat, color: '#4527A0' },
                { label: 'Field Reuse', count: summary.fieldReuse, color: '#1565C0' }
            ];
            cards.forEach(c => {
                const bg = c.count > 0 ? c.color + '15' : '#E8F5E9';
                const fg = c.count > 0 ? c.color : '#2E7D32';
                html += `
                    <div style="flex:1; min-width:100px; background:${bg}; padding:10px; border-radius:8px; text-align:center;">
                        <div style="font-size:1.5em; font-weight:bold; color:${fg};">${c.count}</div>
                        <div style="font-size:0.75em; color:#666;">${c.label}</div>
                    </div>
                `;
            });
            html += `</div>`;

            // Error sections
            if (errors.length > 0) {
                const groups = {
                    'Cross-Division Conflicts': errors.filter(e => e.type === 'cross_division'),
                    'Capacity Violations': errors.filter(e => e.type === 'capacity'),
                    'Staggered Sharing': errors.filter(e => e.type === 'staggered_sharing'),
                    'Same-Day Repetitions': errors.filter(e => e.type === 'same_day_repeat')
                };

                Object.entries(groups).forEach(([title, items]) => {
                    if (items.length === 0) return;
                    const collapsed = items.length > 5;
                    html += `
                        <div style="margin-bottom:8px;">
                            <div class="auto-val-toggle" style="cursor:pointer; display:flex; align-items:center; gap:6px; padding:6px 10px; background:#f5f5f5; border-radius:4px; font-size:0.9em; font-weight:600; color:#555; user-select:none;">
                                <span class="auto-val-arrow">${collapsed ? '▶' : '▼'}</span>
                                ${title} <span style="font-weight:normal; color:#999;">(${items.length})</span>
                            </div>
                            <ul style="list-style:none; padding:0; margin:4px 0 0 0; display:${collapsed ? 'none' : 'block'}; max-height:250px; overflow-y:auto;">
                                ${items.map(item => `
                                    <li style="background:#FFEBEE; color:#C62828; padding:10px 12px; margin-bottom:4px; border-radius:6px; border-left:4px solid #EF5350; font-size:0.9em;">
                                        ${_avEscMsg(item.message)}
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    `;
                });
            }

            if (warnings.length > 0) {
                const collapsed = warnings.length > 5;
                html += `
                    <div style="margin-bottom:8px;">
                        <div class="auto-val-toggle" style="cursor:pointer; display:flex; align-items:center; gap:6px; padding:6px 10px; background:#f5f5f5; border-radius:4px; font-size:0.9em; font-weight:600; color:#555; user-select:none;">
                            <span class="auto-val-arrow">${collapsed ? '▶' : '▼'}</span>
                            Field Reuse Warnings <span style="font-weight:normal; color:#999;">(${warnings.length})</span>
                        </div>
                        <ul style="list-style:none; padding:0; margin:4px 0 0 0; display:${collapsed ? 'none' : 'block'}; max-height:250px; overflow-y:auto;">
                            ${warnings.map(w => `
                                <li style="background:#FFF3E0; color:#E65100; padding:10px 12px; margin-bottom:4px; border-radius:6px; border-left:4px solid #FF9800; font-size:0.9em;">
                                    ${_avEscMsg(w.message)}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `;
            }
        }

        html += `
            <div style="text-align:right; margin-top:20px; border-top:1px solid #eee; padding-top:15px;">
                <button id="auto-val-close-btn" style="padding:12px 24px; background:#333; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:1em;">
                    Close
                </button>
            </div>
        </div>`;

        overlay.innerHTML = html;
        document.body.appendChild(overlay);

        // Wire toggles
        overlay.querySelectorAll('.auto-val-toggle').forEach(header => {
            header.onclick = () => {
                const list = header.nextElementSibling;
                const arrow = header.querySelector('.auto-val-arrow');
                if (list.style.display === 'none') {
                    list.style.display = 'block';
                    if (arrow) arrow.textContent = '▼';
                } else {
                    list.style.display = 'none';
                    if (arrow) arrow.textContent = '▶';
                }
            };
        });

        // Close
        const close = () => overlay.remove();
        document.getElementById('auto-val-close-btn').onclick = close;
        document.getElementById('auto-val-close-x').onclick = close;
        let _mdOverlayAutoVal = false;
        overlay.addEventListener('mousedown', (e) => { _mdOverlayAutoVal = (e.target === overlay); });
        overlay.onclick = (e) => { if (e.target === overlay && _mdOverlayAutoVal) close(); };
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    // =====================================================================
    // EXPORT
    // =====================================================================

    window.validateAutoSchedule = validateAutoSchedule;
    window.AutoValidator = {
        validate: validateAutoSchedule,
        buildFieldSharingMap,
        buildFieldUsageIndex
    };

    // =====================================================================
    // AUTO-MODE ROUTING
    // Override window.validateSchedule so that when in auto mode,
    // the auto validator runs instead of the legacy validator.
    // The legacy validator is preserved as window._legacyValidateSchedule.
    // =====================================================================

    if (typeof window.validateSchedule === 'function') {
        window._legacyValidateSchedule = window.validateSchedule;
    }

    window.validateSchedule = function() {
        const isAutoMode = window._daBuilderMode === 'auto';
        if (isAutoMode) {
            console.log('🛡️ Auto mode detected — routing to Auto Validator');
            return validateAutoSchedule();
        } else {
            // Fall back to legacy validator for manual mode
            if (typeof window._legacyValidateSchedule === 'function') {
                return window._legacyValidateSchedule();
            } else {
                console.warn('🛡️ No legacy validator found');
            }
        }
    };

    // Also update ScheduleValidator.validate for any code that calls it
    if (window.ScheduleValidator) {
        window.ScheduleValidator._legacyValidate = window.ScheduleValidator.validate;
        window.ScheduleValidator.validate = window.validateSchedule;
    }

    console.log('🛡️ Auto Validator v1.0 loaded — auto-routes validateSchedule() in auto mode');

})();
