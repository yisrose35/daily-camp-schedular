/* =========================================================================
 * Combined Field Audit — Verify no combo field violations in a LIVE schedule
 * Paste into browser DevTools console on the Flow page (after generating)
 *
 * Usage:
 *   CombinedFieldAudit.run()       — full audit of current schedule
 *   CombinedFieldAudit.showCombos() — print configured combined field rules
 *
 * For each combined field (e.g. Full Gym = Gym 1 + Gym 2), checks every
 * time window for violations:
 *   - Combined field in use → no sub-field should be in use
 *   - Any sub-field in use → combined field should not be in use
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
    };

    function minToTime(m) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hh = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return `${hh}:${String(mm).padStart(2, '0')} ${ampm}`;
    }

    const norm = s => (s || '').toLowerCase().trim();

    function getComboDefinitions() {
        const lookup = window.getFieldComboLookup?.();
        if (!lookup) return null;
        return lookup;
    }

    function buildBunkDivMap() {
        const divs = window.divisions || {};
        const map = {};
        for (const [divName, divData] of Object.entries(divs)) {
            const bunks = divData?.bunks || (Array.isArray(divData) ? divData : []);
            bunks.forEach(b => { map[b] = divName; });
        }
        return map;
    }

    // Build a map: fieldNorm → [{ bunk, divName, startMin, endMin, activity }]
    function buildFieldUsageMap() {
        const sa = window.scheduleAssignments || {};
        const dt = window.divisionTimes || {};
        const bunkDiv = buildBunkDivMap();
        const map = {};

        for (const [bunk, slots] of Object.entries(sa)) {
            if (!Array.isArray(slots)) continue;
            const divName = bunkDiv[bunk];
            const divSlots = dt[divName] || [];

            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation || entry._isTransition) return;
                const field = entry.field;
                if (!field) return;

                const startMin = entry._startMin ?? divSlots[idx]?.startMin;
                const endMin = entry._endMin ?? divSlots[idx]?.endMin;
                if (startMin == null || endMin == null) return;

                const fn = norm(field);
                if (!map[fn]) map[fn] = [];
                map[fn].push({
                    bunk,
                    divName: divName || '?',
                    startMin,
                    endMin,
                    activity: entry._activity || entry.sport || field,
                    field
                });
            });
        }
        return map;
    }

    function timesOverlap(a, b) {
        return a.startMin < b.endMin && a.endMin > b.startMin;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MAIN AUDIT
    // ═══════════════════════════════════════════════════════════════════
    function run() {
        c.h1('Combined Field Audit');

        const sa = window.scheduleAssignments || {};
        if (!Object.keys(sa).length) {
            c.bad('No schedule loaded. Generate a schedule first, then run this audit.');
            return;
        }

        const lookup = getComboDefinitions();
        if (!lookup) {
            c.bad('No combined field definitions found (window.getFieldComboLookup not available).');
            return;
        }

        const { combinedToSubs, subToCombined } = lookup;
        const comboCount = Object.keys(combinedToSubs).length;
        if (comboCount === 0) {
            c.warn('No combined fields configured. Nothing to audit.');
            return;
        }

        // Show configured combos
        c.h2('Configured combined fields');
        for (const [combined, subs] of Object.entries(combinedToSubs)) {
            c.info(`${subs.join(' + ')} = ${combined}`);
        }

        const fieldUsage = buildFieldUsageMap();
        let violations = 0;
        let checks = 0;
        const violationList = [];

        c.h2('Scanning schedule...');

        // Check each combo: combined vs sub-fields
        for (const [combinedNorm, subs] of Object.entries(combinedToSubs)) {
            const combinedEntries = fieldUsage[combinedNorm] || [];

            for (const sub of subs) {
                const subNorm = norm(sub);
                const subEntries = fieldUsage[subNorm] || [];

                // Check every combined entry against every sub entry for time overlap
                for (const ce of combinedEntries) {
                    for (const se of subEntries) {
                        checks++;
                        if (timesOverlap(ce, se)) {
                            violations++;
                            const overlapStart = Math.max(ce.startMin, se.startMin);
                            const overlapEnd = Math.min(ce.endMin, se.endMin);
                            const timeLabel = `${minToTime(overlapStart)} – ${minToTime(overlapEnd)}`;

                            c.bad(
                                `${timeLabel} | "${ce.field}" (${ce.activity}) [${ce.bunk}, ${ce.divName}] ` +
                                `conflicts with "${se.field}" (${se.activity}) [${se.bunk}, ${se.divName}]`
                            );

                            violationList.push({
                                time: timeLabel,
                                combinedField: ce.field,
                                combinedActivity: ce.activity,
                                combinedBunk: ce.bunk,
                                combinedDiv: ce.divName,
                                combinedWindow: `${minToTime(ce.startMin)}-${minToTime(ce.endMin)}`,
                                subField: se.field,
                                subActivity: se.activity,
                                subBunk: se.bunk,
                                subDiv: se.divName,
                                subWindow: `${minToTime(se.startMin)}-${minToTime(se.endMin)}`
                            });
                        }
                    }
                }
            }

            // Also check sub-fields against each other — they should NOT block each other
            // (only combined blocks subs and vice versa), but log as info if they share time
        }

        // ── Summary ───────────────────────────────────────────────────
        c.h2('Summary');
        c.info(`Combined field rules: ${comboCount}`);
        c.info(`Overlap checks: ${checks}`);
        if (violations > 0) {
            c.bad(`${violations} violation(s) found — combined/sub-field overlap`);
            console.table(violationList);
        } else {
            c.ok('No violations — all combined field rules are respected!');
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SHOW COMBOS
    // ═══════════════════════════════════════════════════════════════════
    function showCombos() {
        c.h1('Combined Field Definitions');
        const lookup = getComboDefinitions();
        if (!lookup) {
            c.bad('No combined field definitions found.');
            return;
        }
        const { combinedToSubs } = lookup;
        if (Object.keys(combinedToSubs).length === 0) {
            c.warn('No combined fields configured.');
            return;
        }
        const rows = [];
        for (const [combined, subs] of Object.entries(combinedToSubs)) {
            rows.push({
                'Combined Field': combined,
                'Sub-Fields': subs.join(', '),
                'Rule': `Using ${combined} blocks ${subs.join(' & ')}; using any sub blocks ${combined}`
            });
        }
        console.table(rows);
    }

    // ═══════════════════════════════════════════════════════════════════
    // EXPOSE
    // ═══════════════════════════════════════════════════════════════════
    window.CombinedFieldAudit = { run, showCombos };

    c.h1('Combined Field Audit loaded');
    c.info('Commands:');
    c.info('  CombinedFieldAudit.run()        — audit current schedule');
    c.info('  CombinedFieldAudit.showCombos()  — print combined field rules');

})();
