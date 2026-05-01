/* =========================================================================
 * Pipeline Run Audit — actually runs the scheduler and checks the output
 *
 * ⚠️  THIS WIPES AND REGENERATES TODAY'S SCHEDULE — same as pressing Generate.
 *     Run it on a day you're OK regenerating.
 *
 * Usage:
 *   await PipelineRunAudit.run()          — generate + audit everything
 *   await PipelineRunAudit.auditOnly()    — audit the EXISTING schedule (no generate)
 *   PipelineRunAudit.report()            — pretty-print last audit results
 *
 * Checks after generation:
 *   1. Cooldown rules   — no block placed within forbidden gap of another
 *   2. Player counts    — sport blocks respect min/max player rules
 *   3. Field quality    — grouped fields are used in rank order
 * ========================================================================= */

(function () {
    'use strict';

    const c = {
        ok:   (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad:  (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h1:   (s)    => console.log('\n%c ' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 10px;border-radius:4px'),
        h2:   (s)    => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
        skip: (...a) => console.log('%c — ', 'background:#78909c;color:#fff;border-radius:3px', ...a),
        data: (...a) => console.log('%c   ', 'background:#546e7a;color:#fff;border-radius:3px', ...a),
    };

    // =========================================================================
    // STEP 1 — Run the real pipeline (mirrors daily_adjustments.js runOptimizer)
    // =========================================================================

    async function generate() {
        c.h1('Generating schedule...');

        const isAuto = window._daBuilderMode === 'auto';
        c.info('Mode: ' + (isAuto ? 'AUTO (runAutoScheduler)' : 'MANUAL (runSkeletonOptimizer)'));

        // ── AUTO MODE ────────────────────────────────────────────────────────
        if (isAuto) {
            if (typeof window.runAutoScheduler !== 'function') {
                c.bad('window.runAutoScheduler not found — open the scheduler page first');
                return false;
            }

            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            let layers = {};

            // Fallback chain mirrors runOptimizer() in daily_adjustments.js
            // 1. localStorage date-specific
            try {
                const stored = localStorage.getItem('campAutoLayers_' + dateKey);
                if (stored) { layers = JSON.parse(stored); c.info('Layers source: localStorage (' + dateKey + ')'); }
            } catch(_) {}

            // 2. Cloud date-specific
            if (!Object.keys(layers).length) {
                const g = window.loadGlobalSettings?.() || {};
                const cl = g.app1?.dailyAutoLayers?.[dateKey];
                if (cl && Object.keys(cl).length) { layers = JSON.parse(JSON.stringify(cl)); c.info('Layers source: cloud date (' + dateKey + ')'); }
            }

            // 3. Template fallback
            if (!Object.keys(layers).length) {
                const g = window.loadGlobalSettings?.() || {};
                const autoTemplates = g.app1?.autoLayerTemplates || {};
                const assignments = g.app1?.skeletonAssignments || {};
                const [Y, M, D] = dateKey.split('-').map(Number);
                const dow = (Y && M && D) ? new Date(Y, M - 1, D).getDay() : 0;
                const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                const tmpl = assignments[dayNames[dow]] || assignments['Default'];
                if (tmpl && autoTemplates[tmpl]) {
                    layers = JSON.parse(JSON.stringify(autoTemplates[tmpl]));
                    c.info('Layers source: template "' + tmpl + '"');
                } else if (autoTemplates['_current']) {
                    layers = JSON.parse(JSON.stringify(autoTemplates['_current']));
                    c.info('Layers source: template "_current"');
                }
            }

            const allLayers = [];
            Object.keys(layers).forEach(grade => {
                (layers[grade] || []).forEach(layer => allLayers.push({ ...layer, grade }));
            });

            if (!allLayers.length) {
                c.bad('No auto layers found — open the auto scheduler, configure layers, then retry');
                return false;
            }

            c.info('Calling runAutoScheduler with ' + allLayers.length + ' layer(s)...');
            const ok = await window.runAutoScheduler(allLayers, { allowedDivisions: null });
            if (!ok) { c.bad('runAutoScheduler returned false — check console for errors'); return false; }
            c.ok('Auto generation complete');
            return true;
        }

        // ── MANUAL MODE ──────────────────────────────────────────────────────
        if (typeof window.runSkeletonOptimizer !== 'function') {
            c.bad('window.runSkeletonOptimizer not found — open the scheduler page first');
            return false;
        }

        // Try to get the skeleton the same way DA does
        let skeleton = window.dailyOverrideSkeleton;
        if (!skeleton || !skeleton.length) {
            const dailyData = window.loadCurrentDailyData?.() || {};
            skeleton = dailyData.manualSkeleton || [];
        }
        if (!skeleton || !skeleton.length) {
            c.bad('No skeleton found. In the DA page, load a skeleton first, then retry.');
            c.info('Tip: if you use Auto Mode, make sure the DA page is showing "Auto" (not "Manual")');
            return false;
        }

        const overrides = window.loadCurrentDailyData?.() || {};
        c.info('Calling runSkeletonOptimizer with ' + skeleton.length + ' skeleton item(s)...');
        const ok = await window.runSkeletonOptimizer(skeleton, overrides);
        if (!ok) { c.bad('runSkeletonOptimizer returned false — check console for errors'); return false; }
        c.ok('Manual generation complete');
        return true;
    }

    // =========================================================================
    // HELPERS — build timeline from scheduleAssignments
    // =========================================================================

    // Build flat list of { bunk, divName, activity, sport, field, startMin, endMin }
    // from window.scheduleAssignments
    function buildTimeline() {
        const sa = window.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const dt = window.divisionTimes || {};

        // Build bunk→division map once
        const bunkDiv = {};
        Object.entries(divisions).forEach(([div, data]) => {
            (data.bunks || []).forEach(b => { bunkDiv[String(b)] = div; });
        });

        const all = [];

        Object.entries(sa).forEach(([bunk, slots]) => {
            if (!Array.isArray(slots)) return;
            const divName = bunkDiv[bunk] || null;
            const divSlots = divName ? (dt[divName] || []) : [];

            slots.forEach((s, i) => {
                if (!s || s.continuation) return; // skip nulls and continuation cells

                // Resolve time from slot
                let startMin = s._startMin;
                let endMin   = s._endMin;

                // Fallback: use the division's time-slot array
                if (startMin == null && divSlots[i]) {
                    startMin = divSlots[i].startMin;
                    endMin   = divSlots[i].endMin;
                }

                if (startMin == null) return; // can't resolve time

                all.push({
                    bunk,
                    divName,
                    activity: s._activity || s.field || '',
                    sport: s.sport || null,
                    field: s.field || null,
                    startMin,
                    endMin,
                    _fixed: s._fixed || false,
                    _isTransition: s._isTransition || false,
                });
            });
        });

        return all;
    }

    // Infer block type for cooldown descriptor
    function inferType(entry) {
        const a = (entry.activity || '').toLowerCase();
        if (a === 'swim' || a.includes('swim')) return 'swim';
        if (a === 'lunch' || a.includes('lunch')) return 'lunch';
        if (a === 'free' || a.includes('free')) return 'free';
        if (entry.sport) return 'sport';
        return 'activity';
    }

    function toDescriptor(entry) {
        return {
            type:  inferType(entry),
            event: entry.activity,
            field: entry.field || '',
            startMin: entry.startMin,
            endMin:   entry.endMin,
        };
    }

    // =========================================================================
    // AUDIT 1 — Cooldown rules
    // =========================================================================

    function auditCooldowns(timeline) {
        c.h1('Audit 1: Cooldown Rules');

        const SR = window.SchedulingRules;
        if (!SR) { c.bad('window.SchedulingRules not found'); return { pass: 0, fail: 1 }; }

        const rules = SR.getCooldownRules?.() || [];
        if (!rules.length) {
            c.skip('No cooldown rules configured — nothing to check');
            return { pass: 0, fail: 0, skip: 1 };
        }

        c.info(`Checking ${rules.length} cooldown rule(s) across all bunks...`);

        // Group timeline by bunk
        const byBunk = {};
        timeline.forEach(e => {
            if (!byBunk[e.bunk]) byBunk[e.bunk] = [];
            byBunk[e.bunk].push(e);
        });

        let violations = 0;
        let checked = 0;

        Object.entries(byBunk).forEach(([bunk, entries]) => {
            entries.sort((a, b) => a.startMin - b.startMin);

            entries.forEach((entry, idx) => {
                if (entry._isTransition) return;

                // Build template = all OTHER blocks for this bunk (already placed)
                const template = entries
                    .filter((_, j) => j !== idx)
                    .map(toDescriptor);

                const candidate = toDescriptor(entry);

                const result = SR.checkCandidateDetailed(candidate, template, { mode: 'auto' });

                if (!result.allowed) {
                    violations++;
                    (result.violated || []).forEach(v => {
                        c.bad(`Bunk ${bunk}: "${entry.activity}" at ${_fmt(entry.startMin)}–${_fmt(entry.endMin)} violates cooldown — ${v.reason || v.description || JSON.stringify(v)}`);
                    });
                }
                checked++;
            });
        });

        if (violations === 0) {
            c.ok(`All ${checked} blocks checked — 0 cooldown violations`);
            return { pass: checked, fail: 0 };
        } else {
            c.bad(`${violations} cooldown violation(s) found across ${checked} blocks`);
            return { pass: checked - violations, fail: violations };
        }
    }

    // =========================================================================
    // AUDIT 2 — Player count rules
    // =========================================================================

    function auditPlayerCounts(timeline) {
        c.h1('Audit 2: Sport Player Count Rules');

        const Utils = window.SchedulerCoreUtils;
        if (!Utils?.checkPlayerCountForSport) {
            c.skip('SchedulerCoreUtils.checkPlayerCountForSport not found');
            return { pass: 0, fail: 0, skip: 1 };
        }

        const meta = window.getSportMetaData?.() || {};
        const sportsWithRules = Object.keys(meta).filter(s => meta[s]?.minPlayers || meta[s]?.maxPlayers);

        if (!sportsWithRules.length) {
            c.skip('No sports have player count rules configured — nothing to check');
            return { pass: 0, fail: 0, skip: 1 };
        }

        c.info(`Checking player count rules for ${sportsWithRules.length} sport(s)...`);

        const bunkMeta = window.getBunkMetaData?.() || window.bunkMetaData || {};

        let hard = 0, soft = 0, ok = 0, skipped = 0;

        // Only check non-continuation sport blocks
        const sportBlocks = timeline.filter(e => e.sport && !e._isTransition);

        sportBlocks.forEach(entry => {
            const sportName = entry.sport;
            if (!meta[sportName]?.minPlayers && !meta[sportName]?.maxPlayers) return; // no rules

            const bunkSize = bunkMeta[entry.bunk]?.size;
            if (bunkSize == null) { skipped++; return; }

            const result = Utils.checkPlayerCountForSport(sportName, bunkSize);

            if (result.valid) {
                ok++;
            } else if (result.severity === 'hard') {
                hard++;
                c.bad(`Bunk ${entry.bunk}: ${sportName} at ${_fmt(entry.startMin)} — bunk has ${bunkSize} players, hard limit ${result.reason || ''}`);
            } else {
                soft++;
                c.warn(`Bunk ${entry.bunk}: ${sportName} at ${_fmt(entry.startMin)} — bunk has ${bunkSize} players, soft warning ${result.reason || ''}`);
            }
        });

        if (skipped > 0) c.info(`${skipped} blocks skipped (bunk size unknown)`);

        if (hard === 0 && soft === 0) {
            c.ok(`All ${ok} sport blocks pass player count rules`);
        } else {
            if (hard > 0) c.bad(`${hard} hard player count violation(s)`);
            if (soft > 0) c.warn(`${soft} soft player count warning(s)`);
        }

        return { pass: ok, fail: hard, warn: soft, skip: skipped };
    }

    // =========================================================================
    // AUDIT 3 — Field quality groups
    // =========================================================================

    function auditFieldQuality(timeline) {
        c.h1('Audit 3: Field Quality Groups');

        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];

        // Build group map: fieldName → { group, rank }
        const fieldMeta = {};
        fields.forEach(f => {
            if (f.fieldGroup) fieldMeta[f.name] = { group: f.fieldGroup, rank: f.qualityRank ?? 999 };
        });

        const groups = new Set(Object.values(fieldMeta).map(m => m.group));

        if (!groups.size) {
            c.skip('No field quality groups configured — nothing to check');
            return { pass: 0, fail: 0, skip: 1 };
        }

        c.info(`Checking field quality group adherence across ${groups.size} group(s)...`);

        // Build: at each time slot, which fields are in use per group?
        // Then check if a lower-rank field was used while a higher-rank field was free.

        // Collect all field assignments, grouped by time window and group
        // slot key = "groupName|startMin|endMin"
        const slotUsage = {}; // key → [{ bunk, fieldName, rank }]

        timeline.forEach(entry => {
            if (!entry.field || entry._isTransition) return;
            const fm = fieldMeta[entry.field];
            if (!fm) return; // field not in any group

            const key = `${fm.group}|${entry.startMin}|${entry.endMin}`;
            if (!slotUsage[key]) slotUsage[key] = [];
            slotUsage[key].push({ bunk: entry.bunk, field: entry.field, rank: fm.rank });
        });

        // For each group, build the fields sorted by rank
        const groupFields = {}; // groupName → sorted [{ name, rank }]
        Object.entries(fieldMeta).forEach(([name, m]) => {
            if (!groupFields[m.group]) groupFields[m.group] = [];
            groupFields[m.group].push({ name, rank: m.rank });
        });
        Object.values(groupFields).forEach(arr => arr.sort((a, b) => a.rank - b.rank));

        let violations = 0;
        let checked = 0;

        // At each time window where grouped fields are in use, check ordering
        Object.entries(slotUsage).forEach(([key, usedList]) => {
            const [groupName, startStr] = key.split('|');
            const startMin = parseInt(startStr);

            const allGroupFields = groupFields[groupName] || [];
            const usedNames = new Set(usedList.map(u => u.field));
            const unusedFields = allGroupFields.filter(f => !usedNames.has(f.name));
            const usedSorted = usedList.slice().sort((a, b) => a.rank - b.rank);

            // If the highest-rank used field has a lower rank (worse) than
            // an unused field with higher rank (better), that's a violation
            if (unusedFields.length === 0 || usedSorted.length === 0) { checked++; return; }

            const worstUsed = Math.max(...usedList.map(u => u.rank));
            const bestUnused = Math.min(...unusedFields.map(f => f.rank));

            if (bestUnused < worstUsed) {
                violations++;
                const unusedName = unusedFields.find(f => f.rank === bestUnused)?.name;
                const worstEntry = usedList.find(u => u.rank === worstUsed);
                c.warn(`Group "${groupName}" at ${_fmt(startMin)}: bunk ${worstEntry?.bunk} used "${worstEntry?.field}" (rank ${worstUsed}) while "${unusedName}" (rank ${bestUnused}) was free`);
            }

            checked++;
        });

        if (violations === 0) {
            c.ok(`All ${checked} time windows checked — field quality order respected`);
        } else {
            c.warn(`${violations} window(s) where a lower-rank field was used while a better one was free`);
            c.info('Note: sharing conflicts, time rules, or access restrictions can legitimately cause this');
        }

        return { pass: checked - violations, fail: 0, warn: violations };
    }

    // =========================================================================
    // SUMMARY + SCHEDULE OVERVIEW
    // =========================================================================

    function printScheduleOverview(timeline) {
        c.h1('Schedule Overview');

        const byBunk = {};
        timeline.forEach(e => {
            if (!byBunk[e.bunk]) byBunk[e.bunk] = [];
            byBunk[e.bunk].push(e);
        });

        const bunks = Object.keys(byBunk).sort();
        c.info(`${bunks.length} bunk(s) scheduled, ${timeline.length} total blocks`);

        bunks.forEach(bunk => {
            const entries = byBunk[bunk].sort((a, b) => a.startMin - b.startMin);
            const line = entries.map(e => `${_fmt(e.startMin)} ${e.activity}${e.field && e.field !== e.activity ? ' @' + e.field : ''}`).join('  •  ');
            c.data(`Bunk ${bunk}:  ${line}`);
        });
    }

    function printSummary(results) {
        const totalFail = Object.values(results).reduce((s, r) => s + (r.fail || 0), 0);
        const totalWarn = Object.values(results).reduce((s, r) => s + (r.warn || 0), 0);
        const totalPass = Object.values(results).reduce((s, r) => s + (r.pass || 0), 0);
        const totalSkip = Object.values(results).reduce((s, r) => s + (r.skip || 0), 0);

        console.log('');
        if (totalFail === 0 && totalWarn === 0) {
            console.log(`%c  ALL CHECKS PASSED  ${totalPass} ✓  ${totalSkip} skipped  `,
                'font-size:13px;font-weight:bold;background:#1b5e20;color:#fff;padding:4px 12px;border-radius:6px');
        } else if (totalFail === 0) {
            console.log(`%c  PASSED with warnings  ${totalPass} ✓  ${totalWarn} ⚠  ${totalSkip} skipped  `,
                'font-size:13px;font-weight:bold;background:#e65100;color:#fff;padding:4px 12px;border-radius:6px');
        } else {
            console.log(`%c  ${totalFail} FAILED  /  ${totalPass} passed  /  ${totalWarn} warnings  /  ${totalSkip} skipped  `,
                'font-size:13px;font-weight:bold;background:#b71c1c;color:#fff;padding:4px 12px;border-radius:6px');
        }
        console.log('');
    }

    // =========================================================================
    // ENTRY POINTS
    // =========================================================================

    let _lastTimeline = null;

    async function run() {
        console.clear();
        console.log('%c Pipeline Run Audit ',
            'font-size:15px;font-weight:bold;background:#37474f;color:#fff;padding:6px 14px;border-radius:6px');
        console.log('Date:', new Date().toLocaleString());
        console.log('⚠️  This will REGENERATE today\'s schedule.');

        const ok = await generate();
        if (!ok) return;

        const timeline = buildTimeline();
        _lastTimeline = timeline;

        printScheduleOverview(timeline);

        const results = {};
        results.cooldowns    = auditCooldowns(timeline);
        results.playerCounts = auditPlayerCounts(timeline);
        results.fieldQuality = auditFieldQuality(timeline);

        printSummary(results);
    }

    async function auditOnly() {
        console.clear();
        console.log('%c Pipeline Run Audit (existing schedule) ',
            'font-size:15px;font-weight:bold;background:#37474f;color:#fff;padding:6px 14px;border-radius:6px');
        console.log('Date:', new Date().toLocaleString());

        const sa = window.scheduleAssignments || {};
        if (!Object.keys(sa).length) {
            c.warn('window.scheduleAssignments is empty — run PipelineRunAudit.run() to generate first');
            return;
        }

        const timeline = buildTimeline();
        _lastTimeline = timeline;

        printScheduleOverview(timeline);

        const results = {};
        results.cooldowns    = auditCooldowns(timeline);
        results.playerCounts = auditPlayerCounts(timeline);
        results.fieldQuality = auditFieldQuality(timeline);

        printSummary(results);
    }

    function report() {
        if (!_lastTimeline) { c.warn('No audit run yet — call PipelineRunAudit.run() first'); return; }
        printScheduleOverview(_lastTimeline);
    }

    // =========================================================================
    // UTIL
    // =========================================================================

    function _fmt(min) {
        if (min == null) return '??';
        const h = Math.floor(min / 60);
        const m = min % 60;
        const ampm = h >= 12 ? 'pm' : 'am';
        return (h > 12 ? h - 12 : h || 12) + ':' + String(m).padStart(2, '0') + ampm;
    }

    window.PipelineRunAudit = { run, auditOnly, report };

    console.log('%c PipelineRunAudit loaded.  await PipelineRunAudit.run()  to generate + audit. ',
        'background:#546e7a;color:#fff;padding:3px 8px;border-radius:4px');
})();
