/* =========================================================================
 * Schedule Rule Audit
 *
 * Audits the EXISTING schedule against all configured rules — no regeneration.
 *
 * Usage:
 *   await PipelineRunAudit.auditOnly()   — audit the current schedule (main command)
 *   PipelineRunAudit.detail()            — print full per-bunk schedule after audit
 *   await PipelineRunAudit.run()         — regenerate THEN audit (destructive)
 *
 * Checks:
 *   1. Cooldown rules        — no activity repeated within its forbidden gap
 *   2. Player counts         — sport blocks respect min/max player rules
 *   3. Field quality         — grouped fields used in rank order (activity-aware)
 *   4. Activity variety      — no activity repeated more than the configured limit
 *   5. Field time rules      — fields not used outside their allowed hours
 *   6. Field double-booking  — non-sharable fields not used by multiple bunks at once
 *   7. Division time bounds  — blocks fall within division start/end window
 *   8. Special time windows  — specials scheduled within their configured hours
 * ========================================================================= */

(function () {
    'use strict';

    const c = {
        ok:   (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad:  (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h2:   (s)    => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
        skip: (...a) => console.log('%c — ', 'background:#78909c;color:#fff;border-radius:3px', ...a),
        data: (...a) => console.log('%c   ', 'background:#546e7a;color:#fff;border-radius:3px', ...a),
        h1:   (s)    => console.log('\n%c ' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 10px;border-radius:4px'),
    };

    // =========================================================================
    // GENERATE (only used by run())
    // =========================================================================

    async function generate() {
        c.h1('Generating schedule...');
        const isAuto = window._daBuilderMode === 'auto';
        c.info('Mode: ' + (isAuto ? 'AUTO' : 'MANUAL'));

        if (isAuto) {
            if (typeof window.runAutoScheduler !== 'function') { c.bad('window.runAutoScheduler not found'); return false; }
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            let layers = {};
            try { const s = localStorage.getItem('campAutoLayers_' + dateKey); if (s) layers = JSON.parse(s); } catch(_) {}
            if (!Object.keys(layers).length) {
                const g = window.loadGlobalSettings?.() || {};
                const cl = g.app1?.dailyAutoLayers?.[dateKey];
                if (cl && Object.keys(cl).length) layers = JSON.parse(JSON.stringify(cl));
            }
            if (!Object.keys(layers).length) {
                const g = window.loadGlobalSettings?.() || {};
                const autoTemplates = g.app1?.autoLayerTemplates || {};
                const assignments = g.app1?.skeletonAssignments || {};
                const [Y, M, D] = dateKey.split('-').map(Number);
                const dow = (Y && M && D) ? new Date(Y, M - 1, D).getDay() : 0;
                const tmpl = assignments[['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow]] || assignments['Default'];
                if (tmpl && autoTemplates[tmpl]) layers = JSON.parse(JSON.stringify(autoTemplates[tmpl]));
                else if (autoTemplates['_current']) layers = JSON.parse(JSON.stringify(autoTemplates['_current']));
            }
            const allLayers = [];
            Object.keys(layers).forEach(g => (layers[g] || []).forEach(l => allLayers.push({ ...l, grade: g })));
            if (!allLayers.length) { c.bad('No auto layers found'); return false; }
            const ok = await window.runAutoScheduler(allLayers, { allowedDivisions: null });
            if (!ok) { c.bad('runAutoScheduler returned false'); return false; }
            c.ok('Auto generation complete');
            return true;
        }

        if (typeof window.runSkeletonOptimizer !== 'function') { c.bad('window.runSkeletonOptimizer not found'); return false; }
        let skeleton = window.dailyOverrideSkeleton;
        if (!skeleton?.length) skeleton = window.loadCurrentDailyData?.()?.manualSkeleton || [];
        if (!skeleton?.length) { c.bad('No skeleton found — load one first'); return false; }
        const ok = await window.runSkeletonOptimizer(skeleton, window.loadCurrentDailyData?.() || {});
        if (!ok) { c.bad('runSkeletonOptimizer returned false'); return false; }
        c.ok('Manual generation complete');
        return true;
    }

    // =========================================================================
    // BUILD TIMELINE
    // =========================================================================

    function buildTimeline() {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const dt = window.divisionTimes || {};
        const bunkDiv = {};
        Object.entries(divisions).forEach(([div, data]) => (data.bunks || []).forEach(b => { bunkDiv[String(b)] = div; }));
        const all = [];
        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const divName = bunkDiv[bunk] || null;
            const divSlots = divName ? (dt[divName] || []) : [];
            slots.forEach((s, i) => {
                if (!s || s.continuation) return;
                let startMin = s._startMin, endMin = s._endMin;
                if (startMin == null && divSlots[i]) { startMin = divSlots[i].startMin; endMin = divSlots[i].endMin; }
                if (startMin == null) return;
                all.push({ bunk, divName, activity: s._activity || s.field || '', sport: s.sport || null, field: s.field || null, startMin, endMin, _fixed: s._fixed || false, _isTransition: s._isTransition || false });
            });
        });
        return all;
    }

    // =========================================================================
    // AUDIT 1 — Cooldown rules
    // =========================================================================

    function inferType(entry) {
        const a = (entry.activity || '').toLowerCase();
        if (a.includes('swim')) return 'swim';
        if (a.includes('lunch')) return 'lunch';
        if (a.includes('free')) return 'free';
        if (entry.sport) return 'sport';
        return 'activity';
    }
    function toDescriptor(entry) {
        return { type: inferType(entry), event: entry.activity, field: entry.field || '', startMin: entry.startMin, endMin: entry.endMin };
    }

    function auditCooldowns(timeline) {
        c.h2('1. Cooldown Rules');
        const SR = window.SchedulingRules;
        if (!SR) { c.bad('window.SchedulingRules not found'); return { pass: 0, fail: 1 }; }
        const rules = SR.getCooldownRules?.() || [];
        if (!rules.length) { c.skip('No cooldown rules configured'); return { pass: 0, fail: 0, skip: 1 }; }
        const byBunk = {};
        timeline.forEach(e => { if (!byBunk[e.bunk]) byBunk[e.bunk] = []; byBunk[e.bunk].push(e); });
        let violations = 0, checked = 0;
        Object.entries(byBunk).forEach(([bunk, entries]) => {
            entries.sort((a, b) => a.startMin - b.startMin);
            entries.forEach((entry, idx) => {
                if (entry._isTransition) return;
                const template = entries.filter((_, j) => j !== idx).map(toDescriptor);
                const result = SR.checkCandidateDetailed(toDescriptor(entry), template, { mode: 'auto' });
                if (!result.allowed) {
                    violations++;
                    (result.violated || []).forEach(v => c.bad(`Bunk ${bunk}: "${entry.activity}" at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} — ${v.reason || v.description || JSON.stringify(v)}`));
                }
                checked++;
            });
        });
        if (violations === 0) { c.ok(`${checked} blocks — 0 cooldown violations`); return { pass: checked, fail: 0 }; }
        c.bad(`${violations} violation(s) across ${checked} blocks`);
        return { pass: checked - violations, fail: violations };
    }

    // =========================================================================
    // AUDIT 2 — Player count rules
    // =========================================================================

    function auditPlayerCounts(timeline) {
        c.h2('2. Sport Player Count Rules');
        const Utils = window.SchedulerCoreUtils;
        if (!Utils?.checkPlayerCountForSport) { c.skip('SchedulerCoreUtils.checkPlayerCountForSport not found'); return { pass: 0, fail: 0, skip: 1 }; }
        const meta = window.getSportMetaData?.() || {};
        const sportsWithRules = Object.keys(meta).filter(s => meta[s]?.minPlayers || meta[s]?.maxPlayers);
        if (!sportsWithRules.length) { c.skip('No sports have player count rules configured'); return { pass: 0, fail: 0, skip: 1 }; }
        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        let hard = 0, soft = 0, ok = 0, skipped = 0;
        timeline.filter(e => e.sport && !e._isTransition).forEach(entry => {
            if (!meta[entry.sport]?.minPlayers && !meta[entry.sport]?.maxPlayers) return;
            const bunkSize = bunkMeta[entry.bunk]?.size;
            if (bunkSize == null) { skipped++; return; }
            const result = Utils.checkPlayerCountForSport(entry.sport, bunkSize);
            if (result.valid) { ok++; }
            else if (result.severity === 'hard') { hard++; c.bad(`Bunk ${entry.bunk}: ${entry.sport} at ${_fmt(entry.startMin)} — ${bunkSize} players, hard limit ${result.reason || ''}`); }
            else { soft++; c.warn(`Bunk ${entry.bunk}: ${entry.sport} at ${_fmt(entry.startMin)} — ${bunkSize} players, soft warning ${result.reason || ''}`); }
        });
        if (hard === 0 && soft === 0) c.ok(`All ${ok} sport blocks pass player count rules`);
        else { if (hard > 0) c.bad(`${hard} hard violation(s)`); if (soft > 0) c.warn(`${soft} soft warning(s)`); }
        return { pass: ok, fail: hard, warn: soft, skip: skipped };
    }

    // =========================================================================
    // AUDIT 3 — Field quality groups
    // =========================================================================

    // Build division seniority map — mirrors total_solver_engine.js buildFieldGroupCaches()
    // Higher grade number → lower seniority index → gets the best (rank 1) field.
    function _buildSeniorityMap() {
        const divisions = window.divisions || {};
        const divWithNumbers = Object.keys(divisions).map(dn => {
            const m = String(dn).toLowerCase().trim().match(/(\d+)/);
            return { name: dn, gradeNum: m ? parseInt(m[1], 10) : null };
        });
        divWithNumbers.sort((a, b) => {
            if (a.gradeNum !== null && b.gradeNum !== null) return b.gradeNum - a.gradeNum;
            if (a.gradeNum !== null) return -1;
            if (b.gradeNum !== null) return 1;
            return a.name.localeCompare(b.name);
        });
        const map = {};
        divWithNumbers.forEach((d, i) => { map[d.name] = i; });
        return map;
    }

    // Returns a human-readable reason why a field was legitimately skipped for
    // this entry, or null if no blocking rule is found (genuine solver miss).
    function _fieldSkipReason(fieldCfg, entry, seniorityMap) {
        // 1. Time rules
        const timeRules = fieldCfg.timeRules || [];
        const unavail = timeRules.filter(r => r.type === 'Unavailable' && r.startMin != null && r.endMin != null);
        const avail   = timeRules.filter(r => r.type === 'Available'   && r.startMin != null && r.endMin != null);
        for (const r of unavail) {
            if (entry.startMin < r.endMin && entry.endMin > r.startMin)
                return `time rule: Unavailable ${_fmt(r.startMin)}–${_fmt(r.endMin)}`;
        }
        if (avail.length > 0 && !avail.some(r => entry.startMin >= r.startMin && entry.endMin <= r.endMin))
            return `time rule: not within any Available window`;

        // 2. Division access restriction
        if (fieldCfg.limitUsage?.enabled && entry.divName) {
            const allowed = fieldCfg.limitUsage.divisions || {};
            if (!allowed[entry.divName])
                return `access restriction: division "${entry.divName}" not permitted`;
        }

        // 3. Field quality seniority — solver reserves better fields for more senior divisions
        if (entry.divName && fieldCfg.qualityRank != null && seniorityMap) {
            const divSeniority = seniorityMap[entry.divName];
            if (divSeniority !== undefined) {
                const idealRank = divSeniority + 1;
                if (fieldCfg.qualityRank < idealRank) {
                    return `seniority: rank-${fieldCfg.qualityRank} field reserved for more senior division (this division's ideal rank is ${idealRank})`;
                }
            }
        }

        return null;
    }

    function auditFieldQuality(timeline) {
        c.h2('3. Field Quality Groups');
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];

        const seniorityMap = _buildSeniorityMap();

        // Store full config so _fieldSkipReason can inspect timeRules + limitUsage + seniority
        const fieldMeta = {};
        fields.forEach(f => {
            if (f.fieldGroup) fieldMeta[f.name] = {
                group: f.fieldGroup,
                rank: f.qualityRank ?? 999,
                qualityRank: f.qualityRank ?? 999,
                activities: new Set((f.activities || []).map(a => (a || '').toLowerCase().trim())),
                timeRules: f.timeRules || [],
                limitUsage: f.limitUsage || {}
            };
        });

        const groups = new Set(Object.values(fieldMeta).map(m => m.group));
        if (!groups.size) { c.skip('No field quality groups configured'); return { pass: 0, fail: 0, skip: 1 }; }

        const slotUsage = {};
        timeline.forEach(entry => {
            if (!entry.field || entry._isTransition) return;
            const fm = fieldMeta[entry.field];
            if (!fm) return;
            const key = `${fm.group}|${entry.startMin}|${entry.endMin}`;
            if (!slotUsage[key]) slotUsage[key] = [];
            slotUsage[key].push({ bunk: entry.bunk, divName: entry.divName, field: entry.field, rank: fm.rank, activity: (entry.activity || entry.sport || '').toLowerCase().trim() });
        });

        const groupFields = {};
        Object.entries(fieldMeta).forEach(([name, m]) => {
            if (!groupFields[m.group]) groupFields[m.group] = [];
            groupFields[m.group].push({ name, rank: m.rank, activities: m.activities, timeRules: m.timeRules, limitUsage: m.limitUsage });
        });
        Object.values(groupFields).forEach(arr => arr.sort((a, b) => a.rank - b.rank));

        let violations = 0, explained = 0, checked = 0;

        Object.entries(slotUsage).forEach(([key, usedList]) => {
            const [groupName, startStr, endStr] = key.split('|');
            const startMin = parseInt(startStr), endMin = parseInt(endStr);
            const allGroupFields = groupFields[groupName] || [];
            const usedNames = new Set(usedList.map(u => u.field));

            usedList.forEach(used => {
                // Candidate better fields: higher rank (lower number), free, supports activity
                const candidates = allGroupFields.filter(f =>
                    f.rank < used.rank &&
                    !usedNames.has(f.name) &&
                    (f.activities.size === 0 || f.activities.has(used.activity))
                );
                if (candidates.length === 0) { checked++; return; }

                const fakeEntry = { startMin, endMin, divName: used.divName };
                const best = candidates[0];
                const reason = _fieldSkipReason(best, fakeEntry, seniorityMap);

                if (reason) {
                    // Solver had a valid reason — log as info so you can see it, not a violation
                    explained++;
                    c.info(`Group "${groupName}" at ${_fmt(startMin)}: bunk ${used.bunk} used "${used.field}" (rank ${used.rank}) — "${best.name}" (rank ${best.rank}) was blocked: ${reason}`);
                } else {
                    violations++;
                    c.warn(`Group "${groupName}" at ${_fmt(startMin)}: bunk ${used.bunk} → "${used.field}" (rank ${used.rank}) — "${best.name}" (rank ${best.rank}) was free with no restriction (possible solver miss)`);
                }
                checked++;
            });
        });

        if (violations === 0 && explained === 0) {
            c.ok(`${checked} field assignment(s) — quality order respected`);
        } else {
            if (violations > 0) c.warn(`${violations} unexplained skip(s) — better field was free with no blocking rule`);
            if (explained > 0) c.info(`${explained} skip(s) explained by time rules or access restrictions`);
        }
        return { pass: checked - violations, fail: 0, warn: violations };
    }

    // =========================================================================
    // AUDIT 4 — Activity variety
    // =========================================================================

    function auditVariety(timeline) {
        c.h2('4. Activity Variety');
        const settings = window.loadGlobalSettings?.() || {};
        const maxRepeat = settings.app1?.maxSameActivityPerDay ?? 2;
        const byBunk = {};
        timeline.forEach(e => {
            if (!e.activity || e._isTransition || e._fixed) return;
            if (!byBunk[e.bunk]) byBunk[e.bunk] = {};
            byBunk[e.bunk][e.activity] = (byBunk[e.bunk][e.activity] || 0) + 1;
        });
        let violations = 0;
        Object.entries(byBunk).forEach(([bunk, counts]) => {
            Object.entries(counts).forEach(([act, n]) => { if (n > maxRepeat) { violations++; c.warn(`Bunk ${bunk}: "${act}" appears ${n}x (max ${maxRepeat})`); } });
        });
        const bunksChecked = Object.keys(byBunk).length;
        if (violations === 0) c.ok(`${bunksChecked} bunk(s) — all activities within repeat limit (≤${maxRepeat}x)`);
        else c.warn(`${violations} over-repeated activity instance(s)`);
        return { pass: bunksChecked - violations, fail: 0, warn: violations };
    }

    // =========================================================================
    // AUDIT 5 — Field time rules
    // =========================================================================

    function auditFieldTimeRules(timeline) {
        c.h2('5. Field Time Rules');
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];
        const fieldRules = {};
        fields.forEach(f => { if (f.timeRules?.length) fieldRules[f.name] = f.timeRules; });
        if (!Object.keys(fieldRules).length) { c.skip('No field time rules configured'); return { pass: 0, fail: 0, skip: 1 }; }
        let violations = 0, checked = 0;
        timeline.forEach(entry => {
            if (!entry.field || entry._isTransition) return;
            const rules = fieldRules[entry.field];
            if (!rules) return;
            checked++;
            rules.forEach(r => {
                const rStart = r.startMin ?? null;
                const rEnd   = r.endMin   ?? null;
                if (rStart == null || rEnd == null) return;
                const overlaps = entry.startMin < rEnd && entry.endMin > rStart;
                if (!overlaps) return;
                if (r.type === 'Unavailable') {
                    violations++;
                    c.bad(`Bunk ${entry.bunk}: "${entry.field}" used at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} but marked Unavailable ${_fmt(rStart)}–${_fmt(rEnd)}`);
                }
            });
            // Check if block falls outside any Available window (when Available rules exist)
            const availableRules = rules.filter(r => r.type === 'Available' && r.startMin != null && r.endMin != null);
            if (availableRules.length > 0) {
                const inWindow = availableRules.some(r => entry.startMin >= r.startMin && entry.endMin <= r.endMin);
                if (!inWindow) {
                    violations++;
                    c.bad(`Bunk ${entry.bunk}: "${entry.field}" used at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} outside its Available window(s)`);
                }
            }
        });
        if (violations === 0) c.ok(`${checked} field assignments — all within allowed hours`);
        else c.bad(`${violations} field time rule violation(s)`);
        return { pass: checked - violations, fail: violations };
    }

    // =========================================================================
    // AUDIT 6 — Field double-booking
    // =========================================================================

    function auditFieldDoubleBooking(timeline) {
        c.h2('6. Field Double-Booking');
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];
        if (!fields.length) { c.skip('No fields configured'); return { pass: 0, fail: 0, skip: 1 }; }

        const fieldShareType = {};
        const knownFields = new Set();
        fields.forEach(f => {
            knownFields.add(f.name);
            fieldShareType[f.name] = f.sharableWith?.type || 'not_sharable';
        });

        // Build: field|startMin|endMin → [bunks] — only for configured physical fields
        const usage = {};
        timeline.forEach(entry => {
            if (!entry.field || entry._isTransition) return;
            if (!knownFields.has(entry.field)) return; // skip activities used as field names
            const key = `${entry.field}|${entry.startMin}|${entry.endMin}`;
            if (!usage[key]) usage[key] = [];
            usage[key].push(entry.bunk);
        });

        let violations = 0, checked = 0;
        Object.entries(usage).forEach(([key, bunks]) => {
            if (bunks.length < 2) { checked++; return; }
            const [fieldName, startStr] = key.split('|');
            const startMin = parseInt(startStr);
            const shareType = fieldShareType[fieldName] || 'not_sharable';
            if (shareType === 'not_sharable') {
                violations++;
                c.bad(`"${fieldName}" at ${_fmt(startMin)}: used by ${bunks.length} bunks simultaneously (not sharable) — bunks: ${bunks.join(', ')}`);
            }
            checked++;
        });
        if (violations === 0) c.ok(`No non-sharable field used by multiple bunks at once`);
        else c.bad(`${violations} double-booking conflict(s)`);
        return { pass: checked - violations, fail: violations };
    }

    // =========================================================================
    // AUDIT 7 — Division time bounds
    // =========================================================================

    function auditDivisionBounds(timeline) {
        c.h2('7. Division Time Bounds');
        const divisions = window.divisions || {};
        if (!Object.keys(divisions).length) { c.skip('No division data available'); return { pass: 0, fail: 0, skip: 1 }; }

        // Build divName → { startMin, endMin }
        const divBounds = {};
        Object.entries(divisions).forEach(([div, data]) => {
            const s = _parseTime(data.startTime);
            const e = _parseTime(data.endTime);
            if (s != null && e != null) divBounds[div] = { startMin: s, endMin: e };
        });

        if (!Object.keys(divBounds).length) { c.skip('No division start/end times configured'); return { pass: 0, fail: 0, skip: 1 }; }

        let violations = 0, checked = 0;
        timeline.forEach(entry => {
            if (entry._isTransition || !entry.divName) return;
            const bounds = divBounds[entry.divName];
            if (!bounds) return;
            checked++;
            if (entry.startMin < bounds.startMin || entry.endMin > bounds.endMin) {
                violations++;
                c.bad(`Bunk ${entry.bunk} (${entry.divName}): "${entry.activity}" at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} outside division window ${_fmt(bounds.startMin)}–${_fmt(bounds.endMin)}`);
            }
        });
        if (violations === 0) c.ok(`${checked} blocks — all within division time bounds`);
        else c.bad(`${violations} block(s) outside division window`);
        return { pass: checked - violations, fail: violations };
    }

    // =========================================================================
    // AUDIT 8 — Special activity time windows
    // =========================================================================

    function auditSpecialWindows(timeline) {
        c.h2('8. Special Activity Time Windows');
        const allSpecials = window.getAllSpecialActivities?.() || [];
        if (!allSpecials.length) { c.skip('No special activities configured'); return { pass: 0, fail: 0, skip: 1 }; }

        // Build name → { windowStart, windowEnd } for specials that have a time window
        const specialWindows = {};
        allSpecials.forEach(s => {
            const ws = s.windowStartMin ?? _parseTime(s.availableFrom ?? s.windowStart);
            const we = s.windowEndMin   ?? _parseTime(s.availableTo   ?? s.windowEnd);
            if (ws != null && we != null) specialWindows[(s.name || '').toLowerCase().trim()] = { start: ws, end: we };
        });

        if (!Object.keys(specialWindows).length) { c.skip('No specials have time windows configured'); return { pass: 0, fail: 0, skip: 1 }; }

        let violations = 0, checked = 0;
        timeline.forEach(entry => {
            if (entry._isTransition) return;
            const win = specialWindows[(entry.activity || '').toLowerCase().trim()];
            if (!win) return;
            checked++;
            if (entry.startMin < win.start || entry.endMin > win.end) {
                violations++;
                c.bad(`Bunk ${entry.bunk}: "${entry.activity}" at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} outside allowed window ${_fmt(win.start)}–${_fmt(win.end)}`);
            }
        });
        if (violations === 0) c.ok(`${checked} special block(s) — all within configured time windows`);
        else c.bad(`${violations} special placed outside its allowed window`);
        return { pass: checked - violations, fail: violations };
    }

    // =========================================================================
    // STATS + SUMMARY
    // =========================================================================

    function printStats(timeline) {
        const bunks  = new Set(timeline.map(e => e.bunk));
        const acts   = new Set(timeline.filter(e => !e._isTransition).map(e => e.activity));
        const sports = new Set(timeline.filter(e => e.sport).map(e => e.sport));
        const fields = new Set(timeline.filter(e => e.field).map(e => e.field));
        c.info(`${bunks.size} bunks  •  ${timeline.length} blocks  •  ${acts.size} unique activities  •  ${sports.size} sports  •  ${fields.size} fields`);
        c.info(`Activities: ${[...acts].sort().join(', ')}`);
    }

    function printSummary(results) {
        const totalFail = Object.values(results).reduce((s, r) => s + (r.fail || 0), 0);
        const totalWarn = Object.values(results).reduce((s, r) => s + (r.warn || 0), 0);
        const totalPass = Object.values(results).reduce((s, r) => s + (r.pass || 0), 0);
        const totalSkip = Object.values(results).reduce((s, r) => s + (r.skip || 0), 0);
        console.log('');
        if (totalFail === 0 && totalWarn === 0)
            console.log(`%c  ALL CHECKS PASSED  ${totalPass} ✓  ${totalSkip} skipped  `, 'font-size:13px;font-weight:bold;background:#1b5e20;color:#fff;padding:4px 12px;border-radius:6px');
        else if (totalFail === 0)
            console.log(`%c  PASSED with warnings  ${totalPass} ✓  ${totalWarn} ⚠  ${totalSkip} skipped  `, 'font-size:13px;font-weight:bold;background:#e65100;color:#fff;padding:4px 12px;border-radius:6px');
        else
            console.log(`%c  ${totalFail} FAILED  /  ${totalPass} passed  /  ${totalWarn} warnings  /  ${totalSkip} skipped  `, 'font-size:13px;font-weight:bold;background:#b71c1c;color:#fff;padding:4px 12px;border-radius:6px');
        console.log('');
    }

    function printDetail(timeline) {
        c.h2('Full Schedule — per bunk');
        const byBunk = {};
        timeline.forEach(e => { if (!byBunk[e.bunk]) byBunk[e.bunk] = []; byBunk[e.bunk].push(e); });
        Object.keys(byBunk).sort().forEach(bunk => {
            const entries = byBunk[bunk].sort((a, b) => a.startMin - b.startMin);
            const line = entries.map(e => `${_fmt(e.startMin)} ${e.activity}${e.field && e.field !== e.activity ? ' @' + e.field : ''}`).join('  •  ');
            c.data(`Bunk ${bunk}: ${line}`);
        });
    }

    // =========================================================================
    // ENTRY POINTS
    // =========================================================================

    let _lastTimeline = null;

    async function _audit(timeline) {
        printStats(timeline);
        console.log('');
        const results = {};
        results.cooldowns     = auditCooldowns(timeline);
        results.playerCounts  = auditPlayerCounts(timeline);
        results.fieldQuality  = auditFieldQuality(timeline);
        results.variety       = auditVariety(timeline);
        results.fieldTimes    = auditFieldTimeRules(timeline);
        results.doubleBooking = auditFieldDoubleBooking(timeline);
        results.divBounds     = auditDivisionBounds(timeline);
        results.specialWins   = auditSpecialWindows(timeline);
        printSummary(results);
        c.info('Tip: PipelineRunAudit.detail() to see the full per-bunk schedule');
    }

    async function auditOnly() {
        console.clear();
        console.log('%c Schedule Rule Audit ', 'font-size:15px;font-weight:bold;background:#37474f;color:#fff;padding:6px 14px;border-radius:6px');
        console.log('Date:', new Date().toLocaleString());
        const sa = window.scheduleAssignments || {};
        if (!Object.keys(sa).length) { c.warn('window.scheduleAssignments is empty — generate a schedule first, then run this'); return; }
        const timeline = buildTimeline();
        _lastTimeline = timeline;
        await _audit(timeline);
    }

    async function run() {
        console.clear();
        console.log('%c Schedule Rule Audit (with regeneration) ', 'font-size:15px;font-weight:bold;background:#37474f;color:#fff;padding:6px 14px;border-radius:6px');
        console.log('Date:', new Date().toLocaleString(), '  ⚠️ This will REGENERATE today\'s schedule.');
        const ok = await generate();
        if (!ok) return;
        const timeline = buildTimeline();
        _lastTimeline = timeline;
        await _audit(timeline);
    }

    function detail() {
        if (!_lastTimeline) { c.warn('No audit run yet — call PipelineRunAudit.auditOnly() first'); return; }
        printDetail(_lastTimeline);
    }

    // =========================================================================
    // UTIL
    // =========================================================================

    function _fmt(min) {
        if (min == null) return '??';
        const h = Math.floor(min / 60), m = min % 60, ampm = h >= 12 ? 'pm' : 'am';
        return (h > 12 ? h - 12 : h || 12) + ':' + String(m).padStart(2, '0') + ampm;
    }

    function _parseTime(t) {
        if (t == null) return null;
        if (typeof t === 'number') return t;
        if (typeof t !== 'string') return null;
        const s = t.trim().toLowerCase();
        const mer = s.includes('am') ? 'am' : s.includes('pm') ? 'pm' : null;
        const clean = s.replace(/am|pm/g, '').trim();
        const m = clean.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1]), mm = parseInt(m[2]);
        if (mer === 'am' && hh === 12) hh = 0;
        else if (mer === 'pm' && hh !== 12) hh += 12;
        return hh * 60 + mm;
    }

    window.PipelineRunAudit = { auditOnly, run, detail };

    console.log('%c Schedule Rule Audit loaded — await PipelineRunAudit.auditOnly() ',
        'background:#546e7a;color:#fff;padding:3px 8px;border-radius:4px');
})();
