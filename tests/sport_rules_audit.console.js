/* =========================================================================
 * Sport Rules Audit — Verify min/max player counts on a LIVE schedule
 * Paste into browser DevTools console on the Flow page (after generating)
 *
 * Usage:
 *   SportRulesAudit.run()           — full audit of current schedule
 *   SportRulesAudit.showRules()     — print configured min/max rules
 *   SportRulesAudit.showBunkSizes() — print bunk sizes from roster
 *
 * Checks every time slot in the current schedule. For each sport, totals
 * the camper count from all bunks assigned to it at the same time, then
 * compares against the sport's minPlayers / maxPlayers.
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
        data: (...a) => console.log('%c   ', 'background:#546e7a;color:#fff;border-radius:3px', ...a),
    };

    function minToTime(m) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hh = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return `${hh}:${String(mm).padStart(2, '0')} ${ampm}`;
    }

    // ─── Gather bunk → division mapping ───────────────────────────────
    function buildBunkDivMap() {
        const divs = window.divisions || {};
        const map = {};
        for (const [divName, divData] of Object.entries(divs)) {
            const bunks = divData?.bunks || (Array.isArray(divData) ? divData : []);
            bunks.forEach(b => { map[b] = divName; });
        }
        return map;
    }

    // ─── Get bunk size (camper count) ─────────────────────────────────
    function getBunkSizes() {
        // Primary: app1's live bunkMetaData (has .size from camperRoster)
        const meta = window.getBunkMetaData?.() || window.bunkMetaData || {};
        const sizes = {};
        for (const [bunk, data] of Object.entries(meta)) {
            sizes[bunk] = data?.size || 0;
        }
        if (Object.values(sizes).some(s => s > 0)) return sizes;

        // Fallback A: count from camperRoster via loadGlobalSettings
        const gs = window.loadGlobalSettings?.() || {};
        const roster = gs.app1?.camperRoster || gs.camperRoster || {};
        for (const camper of Object.values(roster)) {
            if (camper.bunk) {
                sizes[camper.bunk] = (sizes[camper.bunk] || 0) + 1;
            }
        }
        if (Object.values(sizes).some(s => s > 0)) return sizes;

        // Fallback B: read camperRoster directly from localStorage
        try {
            const raw = localStorage.getItem('campGlobalSettings_v1');
            if (raw) {
                const parsed = JSON.parse(raw);
                const r = parsed?.app1?.camperRoster || {};
                for (const camper of Object.values(r)) {
                    if (camper.bunk) {
                        sizes[camper.bunk] = (sizes[camper.bunk] || 0) + 1;
                    }
                }
            }
        } catch (e) { /* ignore parse errors */ }
        return sizes;
    }

    // ─── Get sport min/max rules ──────────────────────────────────────
    function getSportRules() {
        const meta = window.getSportMetaData?.() || window.sportMetaData || {};
        const rules = {};
        for (const [sport, data] of Object.entries(meta)) {
            if (data.minPlayers || data.maxPlayers) {
                rules[sport] = {
                    min: data.minPlayers || null,
                    max: data.maxPlayers || null
                };
            }
        }
        return rules;
    }

    // ─── Build time-window → sport → bunks map ───────────────────────
    function buildTimeActivityMap() {
        const sa = window.scheduleAssignments || {};
        const dt = window.divisionTimes || {};
        const bunkDiv = buildBunkDivMap();
        const map = {}; // timeKey → { [sport]: { bunks: [bunkName], field: string } }

        for (const [bunk, slots] of Object.entries(sa)) {
            if (!Array.isArray(slots)) continue;
            const divName = bunkDiv[bunk];
            const divSlots = dt[divName] || [];

            slots.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                const activity = entry._activity || entry.sport;
                if (!activity) return;
                // Skip non-sport entries (lunch, free, transitions, etc.)
                if (/lunch|free\s*time|transition|change|rest|snack|davening|tefilla|lineup|flag/i.test(activity)) return;

                const startMin = entry._startMin || divSlots[idx]?.startMin;
                const endMin = entry._endMin || divSlots[idx]?.endMin;
                if (startMin == null || endMin == null) return;

                const timeKey = `${startMin}-${endMin}`;
                if (!map[timeKey]) map[timeKey] = {};
                if (!map[timeKey][activity]) map[timeKey][activity] = { bunks: [], field: entry.field || '(no field)' };
                map[timeKey][activity].bunks.push(bunk);
            });
        }
        return map;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MAIN AUDIT
    // ═══════════════════════════════════════════════════════════════════
    function run() {
        c.h1('Sport Rules Audit — Min/Max Player Count');

        const sa = window.scheduleAssignments || {};
        if (!Object.keys(sa).length) {
            c.bad('No schedule loaded. Generate a schedule first, then run this audit.');
            return;
        }

        const rules = getSportRules();
        const bunkSizes = getBunkSizes();
        const timeMap = buildTimeActivityMap();

        // ── Show configured rules ─────────────────────────────────────
        c.h2('Configured sport rules');
        const ruleNames = Object.keys(rules);
        if (!ruleNames.length) {
            c.warn('No min/max player rules configured. Go to Rules tab → Sports Rules to set them.');
            return;
        }
        ruleNames.forEach(sport => {
            c.data(`${sport}: min=${rules[sport].min ?? '—'}  max=${rules[sport].max ?? '—'}`);
        });

        // ── Show bunk sizes ───────────────────────────────────────────
        c.h2('Bunk sizes (camper counts)');
        const bunksWithSize = Object.entries(bunkSizes).filter(([, s]) => s > 0);
        if (!bunksWithSize.length) {
            c.warn('All bunk sizes are 0 — camper roster not loaded (import campers in Campistry Me first). Player counts will be inaccurate.');
            c.warn('  Tried: getBunkMetaData()=' + (typeof window.getBunkMetaData === 'function' ? 'exists' : 'missing') +
                   ', loadGlobalSettings()=' + (typeof window.loadGlobalSettings === 'function' ? 'exists' : 'missing') +
                   ', localStorage campGlobalSettings_v1=' + (localStorage.getItem('campGlobalSettings_v1') ? 'found' : 'empty'));
        } else {
            const sorted = bunksWithSize.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
            const summary = sorted.map(([b, s]) => `${b}(${s})`).join('  ');
            c.info(`${bunksWithSize.length} bunks with sizes: ${summary}`);
        }

        // ── Audit each time window ────────────────────────────────────
        c.h2('Auditing schedule...');

        let violations = 0;
        let warnings = 0;
        let checks = 0;
        let passes = 0;
        const violationList = [];

        const timeKeys = Object.keys(timeMap).sort((a, b) => {
            return parseInt(a) - parseInt(b);
        });

        for (const timeKey of timeKeys) {
            const [startStr, endStr] = timeKey.split('-');
            const startMin = parseInt(startStr);
            const endMin = parseInt(endStr);
            const timeLabel = `${minToTime(startMin)} – ${minToTime(endMin)}`;

            for (const [activity, info] of Object.entries(timeMap[timeKey])) {
                const rule = rules[activity];
                if (!rule) continue; // No min/max rule for this activity

                checks++;
                const totalPlayers = info.bunks.reduce((sum, bunk) => sum + (bunkSizes[bunk] || 0), 0);
                const bunkList = info.bunks.map(b => `${b}(${bunkSizes[b] || 0})`).join(' + ');

                if (rule.min && totalPlayers < rule.min && totalPlayers > 0) {
                    const pct = Math.round((1 - totalPlayers / rule.min) * 100);
                    const severity = pct > 40 ? 'HARD' : (pct > 20 ? 'SOFT' : 'MINOR');
                    if (severity === 'HARD' || severity === 'SOFT') {
                        c.bad(`${timeLabel} | ${activity} on ${info.field} | ${totalPlayers} players < min ${rule.min} (${pct}% under) [${severity}] | Bunks: ${bunkList}`);
                        violations++;
                        violationList.push({ time: timeLabel, activity, type: 'UNDER_MIN', players: totalPlayers, rule: rule.min, pct, severity, bunks: info.bunks });
                    } else {
                        c.warn(`${timeLabel} | ${activity} on ${info.field} | ${totalPlayers} players < min ${rule.min} (${pct}% under) [MINOR] | Bunks: ${bunkList}`);
                        warnings++;
                    }
                } else if (rule.max && totalPlayers > rule.max) {
                    const pct = Math.round((totalPlayers / rule.max - 1) * 100);
                    const severity = pct > 30 ? 'HARD' : (pct > 20 ? 'SOFT' : 'MINOR');
                    if (severity === 'HARD' || severity === 'SOFT') {
                        c.bad(`${timeLabel} | ${activity} on ${info.field} | ${totalPlayers} players > max ${rule.max} (${pct}% over) [${severity}] | Bunks: ${bunkList}`);
                        violations++;
                        violationList.push({ time: timeLabel, activity, type: 'OVER_MAX', players: totalPlayers, rule: rule.max, pct, severity, bunks: info.bunks });
                    } else {
                        c.warn(`${timeLabel} | ${activity} on ${info.field} | ${totalPlayers} players > max ${rule.max} (${pct}% over) [MINOR] | Bunks: ${bunkList}`);
                        warnings++;
                    }
                } else {
                    passes++;
                }
            }
        }

        // ── Summary ───────────────────────────────────────────────────
        c.h2('Summary');
        c.info(`Checked: ${checks} sport/time-slot combinations`);
        if (passes > 0) c.ok(`${passes} passed (within min/max)`);
        if (warnings > 0) c.warn(`${warnings} minor warnings (slightly outside range)`);
        if (violations > 0) {
            c.bad(`${violations} violations (significantly outside min/max)`);
            console.table(violationList);
        } else {
            c.ok('No violations found — all sport player counts are within configured rules!');
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════
    function showRules() {
        c.h1('Configured Sport Min/Max Rules');
        const meta = window.getSportMetaData?.() || window.sportMetaData || {};
        const all = Object.keys(meta);
        if (!all.length) { c.warn('No sports found in sportMetaData'); return; }

        const rows = all.map(name => ({
            Sport: name,
            Min: meta[name].minPlayers ?? '—',
            Max: meta[name].maxPlayers ?? '—',
            HasRule: (meta[name].minPlayers || meta[name].maxPlayers) ? '✓' : ''
        }));
        console.table(rows);
    }

    function showBunkSizes() {
        c.h1('Bunk Sizes (Camper Counts)');
        const sizes = getBunkSizes();
        const bunkDiv = buildBunkDivMap();
        const rows = Object.keys(sizes)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(bunk => ({
                Bunk: bunk,
                Division: bunkDiv[bunk] || '(unknown)',
                Campers: sizes[bunk]
            }));
        if (!rows.length) { c.warn('No bunk data found'); return; }
        console.table(rows);
        c.info(`Total: ${rows.reduce((s, r) => s + r.Campers, 0)} campers in ${rows.length} bunks`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // EXPOSE
    // ═══════════════════════════════════════════════════════════════════
    window.SportRulesAudit = { run, showRules, showBunkSizes };

    c.h1('Sport Rules Audit loaded');
    c.info('Commands:');
    c.info('  SportRulesAudit.run()           — audit current schedule');
    c.info('  SportRulesAudit.showRules()     — print min/max rules');
    c.info('  SportRulesAudit.showBunkSizes() — print bunk sizes');

})();
