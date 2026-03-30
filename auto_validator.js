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
        'regroup', 'free play'
    ]);

    const SKIP_ACTIVITIES = new Set([
        'free', 'lunch', 'snacks', 'dismissal', 'swim', 'pool',
        'canteen', 'gameroom', 'game room', 'transition', 'buffer',
        'mincha', 'davening', 'lineup', 'bus', 'regroup', 'free play'
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

                const fn = entry.field.toLowerCase().trim();
                if (SKIP_FIELDS.has(fn) || isLeagueField(fn)) return;

                const slot = getBunkSlotTime(bunk, grade, idx, divisionTimes);
                if (!slot || slot.startMin == null || slot.endMin == null) return;

                const flags = {
                    _league: !!entry._league,
                    _autoSpecial: !!entry._autoSpecial,
                    _pinned: !!entry._pinned,
                    _fixed: !!entry._fixed
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
            const sharing = sharingMap.get(fieldNorm) || { type: 'not_sharable', capacity: 1, divisions: [] };

            // Skip special locations — they handle their own cross-div rules
            if (sharing._isSpecial) return;

            // Only check fields where cross-div matters
            if (sharing.type !== 'same_division' && sharing.type !== 'not_sharable' && sharing.type !== 'custom') return;

            for (let i = 0; i < usages.length; i++) {
                const a = usages[i];
                if (a.flags._league || a.flags._autoSpecial) continue;

                for (let j = i + 1; j < usages.length; j++) {
                    const b = usages[j];
                    if (b.flags._league || b.flags._autoSpecial) continue;
                    if (a.grade === b.grade) continue;
                    if (!timesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

                    // Cross-division overlap detected
                    let isViolation = false;

                    if (sharing.type === 'not_sharable') {
                        isViolation = true;
                    } else if (sharing.type === 'same_division') {
                        isViolation = true;
                    } else if (sharing.type === 'custom') {
                        const allowed = sharing.divisions || [];
                        if (allowed.length > 0) {
                            isViolation = !allowed.includes(a.grade) || !allowed.includes(b.grade);
                        } else {
                            isViolation = true; // empty custom = same_division
                        }
                    }

                    if (isViolation) {
                        const timeLabel = `${formatTime(Math.min(a.startMin, b.startMin))} - ${formatTime(Math.max(a.endMin, b.endMin))}`;
                        errors.push({
                            type: 'cross_division',
                            field: a.field,
                            fieldNorm,
                            shareType: sharing.type,
                            bunks: [
                                { bunk: a.bunk, grade: a.grade, time: `${a.startMin}-${a.endMin}` },
                                { bunk: b.bunk, grade: b.grade, time: `${b.startMin}-${b.endMin}` }
                            ],
                            timeLabel,
                            message: `<strong>Cross-Division Conflict:</strong> <u>${a.field}</u> ` +
                                `(${sharing.type}, cap ${sharing.capacity}) used by ` +
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
            const sharing = sharingMap.get(fieldNorm) || { type: 'not_sharable', capacity: 1 };

            // Filter to sport entries only (skip specials and leagues)
            const sportUsages = usages.filter(u => !u.flags._league && !u.flags._autoSpecial);
            if (sportUsages.length < 2) return;

            // Group by grade (for same_division, capacity is per-grade)
            const byGrade = {};
            sportUsages.forEach(u => {
                if (!byGrade[u.grade]) byGrade[u.grade] = [];
                byGrade[u.grade].push(u);
            });

            Object.entries(byGrade).forEach(([grade, gradeUsages]) => {
                if (gradeUsages.length <= sharing.capacity) return;

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

                if (peak > sharing.capacity) {
                    // Find which bunks are active at peak time
                    const peakBunks = gradeUsages.filter(u =>
                        u.startMin <= peakTime && u.endMin > peakTime
                    );
                    errors.push({
                        type: 'capacity',
                        field: gradeUsages[0].field,
                        fieldNorm,
                        grade,
                        peak,
                        capacity: sharing.capacity,
                        message: `<strong>Capacity Exceeded:</strong> <u>${gradeUsages[0].field}</u> ` +
                            `has <strong>${peak}</strong> ${grade} bunks at ${formatTime(peakTime)} ` +
                            `(capacity: ${sharing.capacity})<br>` +
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

            // Only check sport entries
            const sportUsages = usages.filter(u => !u.flags._league && !u.flags._autoSpecial);
            if (sportUsages.length < 2) return;

            for (let i = 0; i < sportUsages.length; i++) {
                const a = sportUsages[i];
                for (let j = i + 1; j < sportUsages.length; j++) {
                    const b = sportUsages[j];

                    // Must overlap in time
                    if (!timesOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) continue;

                    // Cross-division sharing is already caught in check A
                    // Only check same-grade sharing here
                    if (a.grade !== b.grade) continue;

                    // If they overlap but don't have identical times → staggered violation
                    if (a.startMin !== b.startMin || a.endMin !== b.endMin) {
                        const key = [fieldNorm, a.bunk, b.bunk, a.startMin, b.startMin].sort().join('|');
                        if (seen.has(key)) continue;
                        seen.add(key);

                        errors.push({
                            type: 'staggered_sharing',
                            field: a.field,
                            fieldNorm,
                            grade: a.grade,
                            message: `<strong>Staggered Sharing:</strong> <u>${a.field}</u> shared by ` +
                                `${a.bunk} (${formatTime(a.startMin)}-${formatTime(a.endMin)}) and ` +
                                `${b.bunk} (${formatTime(b.startMin)}-${formatTime(b.endMin)}) in ${a.grade}. ` +
                                `Bunks sharing a field must start and end at the same time.`
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

    function validateAutoSchedule() {
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

        // ── Summary ──
        const summary = {
            crossDivision: crossDivErrors.length,
            capacity: capErrors.length,
            staggeredSharing: staggerErrors.length,
            sameDayRepeat: repeatErrors.length,
            fieldReuse: fieldRepWarnings.length
        };

        console.log('🛡️ Auto Validator Results:');
        console.log('  Cross-division conflicts:', summary.crossDivision);
        console.log('  Capacity violations:', summary.capacity);
        console.log('  Staggered sharing:', summary.staggeredSharing);
        console.log('  Same-day repeats:', summary.sameDayRepeat);
        console.log('  Field reuse warnings:', summary.fieldReuse);
        console.log('  TOTAL errors:', allErrors.length);

        // Show modal
        showAutoValidatorModal(allErrors, allWarnings, summary);

        return { errors: allErrors, warnings: allWarnings, summary };
    }

    // =====================================================================
    // MODAL
    // =====================================================================

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
                                        ${item.message}
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
                                    ${w.message}
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
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
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
