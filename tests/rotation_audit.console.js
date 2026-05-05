/* =========================================================================
 * Rotation Audit — paste into the browser console (or load via <script>)
 *
 *   RotationAudit.run()        full report for today (window.currentScheduleDate)
 *   RotationAudit.run('2026-04-14')   audit a specific date
 *   RotationAudit.history()    just dump the raw history from saved schedules
 *   RotationAudit.bunk('1')    deep-dive on one bunk
 *   RotationAudit.simulate(bunk, opts) replay scoring math
 *
 * Checks every layer of the rotation pipeline:
 *   1. History storage     (campDailyData_v1 past schedules)
 *   2. Today's snapshot    (each bunk's sport assignments today)
 *   3. Yesterday penalty   (sports played today AND yesterday → soft fail)
 *   4. Streak detection    (same sport 2+ consecutive days → hard fail)
 *   5. Variety entropy     (distinct sports / total over last 5 days)
 *   6. Overdue boost       (sports not seen in 4+ days that were available)
 *   7. Draft adherence     (planned sports actually being placed)
 *   8. Persistence cycle   (confirm campDailyData_v1 has past dates)
 * ========================================================================= */

(function () {
    'use strict';

    const LOOKBACK_DAYS = 5;

    // ---- helpers -----------------------------------------------------------
    const c = {
        ok:  (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad: (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn:(...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info:(...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h1:  (s)    => console.log('\n%c' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 8px;border-radius:4px'),
        h2:  (s)    => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
    };

    function recentDays(today, count) {
        const out = [];
        const d = new Date(today + 'T12:00:00');
        for (let i = 1; i <= count; i++) {
            const p = new Date(d.getTime() - i * 86400000);
            out.push(p.getFullYear() + '-' +
                String(p.getMonth() + 1).padStart(2, '0') + '-' +
                String(p.getDate()).padStart(2, '0'));
        }
        return out;
    }

    // Build history from campDailyData_v1 (actual saved schedules)
    function buildHistoryFromSchedules(today) {
        const allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
        const history = {}; // bunk → { dateKey → [sport1, sport2, ...] }
        const dates = Object.keys(allDaily)
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 14);

        for (const dateKey of dates) {
            const sched = allDaily[dateKey]?.scheduleAssignments || {};
            for (const [bunk, slots] of Object.entries(sched)) {
                if (!history[bunk]) history[bunk] = {};
                const sports = [];
                const arr = Array.isArray(slots) ? slots : Object.values(slots);
                for (const entry of arr) {
                    if (!entry || !entry.sport || entry.continuation) continue;
                    sports.push(entry.sport);
                }
                if (sports.length > 0) history[bunk][dateKey] = sports;
            }
        }
        return { history, dates };
    }

    // Pull sport-only activities from window.scheduleAssignments
    function todaysSportsByBunk() {
        const out = {};
        const sa = window.scheduleAssignments || {};
        Object.keys(sa).forEach(bunk => {
            const slots = sa[bunk] || [];
            const sports = [];
            const arr = Array.isArray(slots) ? slots : Object.values(slots);
            arr.forEach(slot => {
                if (!slot || slot.continuation) return;
                if (slot.sport) sports.push(slot.sport);
            });
            out[bunk] = sports;
        });
        return out;
    }

    // ---- check 1: history storage -----------------------------------------
    function checkHistoryStorage(today) {
        c.h2('1. History storage (campDailyData_v1 — past schedules)');
        const { history, dates } = buildHistoryFromSchedules(today);
        const bunkCount = Object.keys(history).length;
        c.info('Past dates with schedule data:', dates.length);
        c.info('Bunks with history:', bunkCount);
        if (dates.length > 0) {
            c.info('Date range:', dates[dates.length - 1], '→', dates[0]);
        }
        if (dates.length === 0) {
            c.warn('No past schedule data in localStorage. The rotation engine has no history to work with.');
            c.info('Fix: Generate schedules for multiple days, or check that cloud hydration ran on page load.');
            return { pass: false, history: {} };
        }
        c.ok(dates.length + ' past date(s) available for rotation scoring.');
        return { pass: true, history };
    }

    // ---- check 2: today's snapshot ----------------------------------------
    function checkTodaysSnapshot(date) {
        c.h2('2. Today\'s snapshot (' + date + ')');
        const today = todaysSportsByBunk();
        const bunks = Object.keys(today);
        if (bunks.length === 0) {
            c.warn('window.scheduleAssignments is empty — no schedule generated yet.');
            return { pass: false, today: {} };
        }
        const totalBlocks = bunks.reduce((n, b) => n + today[b].length, 0);
        const withSports = bunks.filter(b => today[b].length > 0).length;
        c.info('Bunks scheduled:', bunks.length, '| with sports:', withSports, '| total sport blocks:', totalBlocks);
        if (totalBlocks === 0) c.bad('No sport blocks were placed today. Rotation cannot be evaluated.');
        else c.ok('Sport blocks present in schedule.');
        const dist = {};
        bunks.forEach(b => today[b].forEach(s => { dist[s] = (dist[s] || 0) + 1; }));
        console.table(dist);
        return { pass: totalBlocks > 0, today };
    }

    // ---- check 3: yesterday penalty effectiveness -------------------------
    function checkYesterdayPenalty(date, history, today) {
        c.h2('3. Yesterday-penalty effectiveness (target: ≈0 repeats)');
        const yesterday = recentDays(date, 1)[0];
        let repeats = 0, violations = [];
        Object.keys(today).forEach(bunk => {
            const ySports = (history[bunk] && history[bunk][yesterday]) || [];
            today[bunk].forEach(sport => {
                if (ySports.indexOf(sport) >= 0) {
                    repeats++;
                    violations.push({ bunk, sport, yesterday });
                }
            });
        });
        if (repeats === 0) {
            c.ok('No bunk repeated a sport from ' + yesterday + '.');
        } else {
            c.warn(repeats + ' bunk×sport repeats from yesterday.');
            console.table(violations);
        }
        return { repeats, violations };
    }

    // ---- check 4: streak detection ----------------------------------------
    function checkStreaks(date, history, today) {
        c.h2('4. Consecutive-day streaks (target: 0 streaks ≥ 2)');
        const days = [date].concat(recentDays(date, LOOKBACK_DAYS));
        const streaks = [];
        Object.keys(today).forEach(bunk => {
            const seenByDay = {};
            seenByDay[date] = today[bunk] || [];
            recentDays(date, LOOKBACK_DAYS).forEach(d => {
                seenByDay[d] = (history[bunk] && history[bunk][d]) || [];
            });
            const allSports = new Set();
            Object.values(seenByDay).forEach(a => a.forEach(s => allSports.add(s)));
            allSports.forEach(sport => {
                let run = 0, maxRun = 0;
                for (const d of days) {
                    if ((seenByDay[d] || []).indexOf(sport) >= 0) { run++; maxRun = Math.max(maxRun, run); }
                    else run = 0;
                }
                if (maxRun >= 2) streaks.push({ bunk, sport, length: maxRun });
            });
        });
        if (streaks.length === 0) c.ok('No multi-day same-sport streaks detected.');
        else {
            c.bad(streaks.length + ' streaks detected (sport played multiple consecutive days).');
            console.table(streaks);
        }
        return { streaks };
    }

    // ---- check 5: variety entropy -----------------------------------------
    function checkVariety(date, history, today) {
        c.h2('5. Variety per bunk (last ' + LOOKBACK_DAYS + ' days + today)');
        const rows = [];
        Object.keys(today).forEach(bunk => {
            const all = [...(today[bunk] || [])];
            recentDays(date, LOOKBACK_DAYS).forEach(d => {
                ((history[bunk] && history[bunk][d]) || []).forEach(s => all.push(s));
            });
            if (all.length === 0) return;
            const distinct = new Set(all).size;
            rows.push({
                bunk,
                totalBlocks: all.length,
                distinctSports: distinct,
                varietyRatio: +(distinct / all.length).toFixed(2),
                grade: distinct >= Math.min(5, all.length) ? 'A' :
                       distinct >= 3 ? 'B' :
                       distinct >= 2 ? 'C' : 'F'
            });
        });
        if (rows.length === 0) { c.warn('No data to compute variety.'); return { rows }; }
        rows.sort((a, b) => a.varietyRatio - b.varietyRatio);
        console.table(rows);
        const failing = rows.filter(r => r.grade === 'F');
        if (failing.length === 0) c.ok('Every bunk has at least 2 distinct sports across the window.');
        else c.bad(failing.length + ' bunks stuck on a single sport across the lookback window.');
        return { rows };
    }

    // ---- check 6: overdue sports ------------------------------------------
    function checkOverdueBoost(date, history, today) {
        c.h2('6. Overdue-boost evidence (sports not seen in 4+ days should resurface)');
        const cutoffWindow = recentDays(date, 4);
        const olderWindow = recentDays(date, LOOKBACK_DAYS).slice(4);
        let resurfaced = 0;
        Object.keys(today).forEach(bunk => {
            const recent = new Set();
            cutoffWindow.forEach(d => ((history[bunk] && history[bunk][d]) || []).forEach(s => recent.add(s)));
            (today[bunk] || []).forEach(sport => {
                const seenOlder = olderWindow.some(d => ((history[bunk] && history[bunk][d]) || []).indexOf(sport) >= 0);
                if (seenOlder && !recent.has(sport)) resurfaced++;
            });
        });
        c.info('Overdue-and-resurfaced placements today:', resurfaced);
        if (resurfaced > 0) c.ok('Overdue boost is producing comebacks for stale sports.');
        else c.warn('No overdue resurfacing detected — could mean history is too short, or boost is being outweighed.');
        return { resurfaced };
    }

    // ---- check 7: draft adherence -----------------------------------------
    function checkDraftAdherence() {
        c.h2('7. Draft adherence (Phase-2 plan vs actual placements)');
        const draft = window.__lastDraftResults || window.draftResults || null;
        if (!draft) {
            c.warn('No draft snapshot exposed. To enable: add window.__lastDraftResults = draftResults; in scheduler_core_auto.js after the planner returns.');
            return { skipped: true };
        }
        const today = todaysSportsByBunk();
        const rows = [];
        Object.keys(draft).forEach(bunk => {
            const planned = (draft[bunk].sports || []).map(s => s.name || s);
            const actual = today[bunk] || [];
            const overlap = planned.filter(p => actual.indexOf(p) >= 0).length;
            rows.push({
                bunk,
                drafted: planned.length,
                placed: actual.length,
                draftedAndPlaced: overlap,
                adherence: planned.length ? +(overlap / planned.length).toFixed(2) : null
            });
        });
        console.table(rows);
        return { rows };
    }

    // ---- check 8: persistence check ---------------------------------------
    function checkPersistence(today) {
        c.h2('8. Persistence (campDailyData_v1 integrity)');
        const allDaily = window.loadAllDailyData ? window.loadAllDailyData() : {};
        const allDates = Object.keys(allDaily).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        const withSched = allDates.filter(d => {
            const sa = allDaily[d]?.scheduleAssignments;
            return sa && Object.keys(sa).length > 0;
        });
        c.info('Total date entries:', allDates.length, '| With scheduleAssignments:', withSched.length);
        if (withSched.length > 0) {
            c.info('Dates with schedules:', withSched.join(', '));
        }
        const todayEntry = allDaily[today];
        if (todayEntry?.scheduleAssignments && Object.keys(todayEntry.scheduleAssignments).length > 0) {
            c.ok('Today\'s schedule is persisted in localStorage.');
        } else {
            c.warn('Today\'s schedule NOT found in localStorage — rotation for tomorrow will lack today\'s data.');
        }
        const pastCount = withSched.filter(d => d < today).length;
        if (pastCount >= 3) c.ok(pastCount + ' past dates available — rotation engine has enough history.');
        else if (pastCount > 0) c.warn('Only ' + pastCount + ' past date(s) — rotation scoring may be weak.');
        else c.bad('No past dates — rotation engine is blind. Generate for multiple days or ensure cloud hydration runs.');
        return { pass: pastCount >= 1, allDates: withSched, pastCount };
    }

    // ---- public ------------------------------------------------------------
    const RotationAudit = {
        run(dateOverride) {
            const date = dateOverride || window.currentScheduleDate || new Date().toISOString().split('T')[0];
            c.h1('Rotation Audit — ' + date);
            const r1 = checkHistoryStorage(date);
            const r2 = checkTodaysSnapshot(date);
            const history = r1.history;
            const today = r2.today;
            const r3 = checkYesterdayPenalty(date, history, today);
            const r4 = checkStreaks(date, history, today);
            const r5 = checkVariety(date, history, today);
            const r6 = checkOverdueBoost(date, history, today);
            const r7 = checkDraftAdherence();
            const r8 = checkPersistence(date);

            c.h1('Summary');
            const fails = [];
            if (!r1.pass) fails.push('history-empty');
            if (!r2.pass) fails.push('no-sport-blocks');
            if (r3.repeats > 0) fails.push('yesterday-repeats:' + r3.repeats);
            if (r4.streaks.length > 0) fails.push('streaks:' + r4.streaks.length);
            if (!r8.pass) fails.push('persistence-broken');
            if (fails.length === 0) c.ok('All checks passed.');
            else c.bad('Issues: ' + fails.join(', '));
            return { date, history, today, fails,
                     details: { storage: r1, snapshot: r2, yesterday: r3,
                                streaks: r4, variety: r5, overdue: r6,
                                draft: r7, persistence: r8 } };
        },

        history() {
            const date = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            return buildHistoryFromSchedules(date);
        },

        bunk(bunkId) {
            const date = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const { history } = buildHistoryFromSchedules(date);
            const today = todaysSportsByBunk()[bunkId] || [];
            const days = [date].concat(recentDays(date, LOOKBACK_DAYS));
            c.h1('Bunk ' + bunkId + ' — rotation history');
            const rows = days.map(d => ({
                date: d,
                sports: (d === date ? today : ((history[bunkId] && history[bunkId][d]) || [])).join(', ') || '—'
            }));
            console.table(rows);
            return rows;
        },

        simulate(bunkId, opts) {
            opts = opts || {};
            const date = opts.date || window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const candidates = opts.candidates || ['Basketball', 'Soccer', 'Football', 'Baseball', 'Hockey', 'Kickball'];
            const used = new Set(opts.usedToday || todaysSportsByBunk()[bunkId] || []);
            const { history } = buildHistoryFromSchedules(date);
            const h = history[bunkId] || {};
            const lookback = recentDays(date, LOOKBACK_DAYS);
            c.h1('Score simulation — Bunk ' + bunkId + ' on ' + date);
            const rows = candidates.map(sport => {
                let daysAgo = '—';
                for (let i = 0; i < lookback.length; i++) {
                    if ((h[lookback[i]] || []).indexOf(sport) >= 0) { daysAgo = i + 1; break; }
                }
                const isUsed = used.has(sport);
                let score = 0, breakdown = [];
                if (isUsed) { score -= 100000; breakdown.push('-100000 already-today'); }
                if (daysAgo === 1) { score += 12000; breakdown.push('+12000 yesterday'); }
                else if (daysAgo === 2) { score += 8000; breakdown.push('+8000 2-days-ago'); }
                else if (daysAgo === 3) { score += 5000; breakdown.push('+5000 3-days-ago'); }
                else if (daysAgo === 4) { score += 3000; breakdown.push('+3000 4-days-ago'); }
                else if (daysAgo === '—') { score -= 5000; breakdown.push('-5000 never-done'); }
                else { score += 800; breakdown.push('+800 recent-ish'); }
                return { sport, daysAgo, penalty: score, breakdown: breakdown.join(' | '), wouldPick: !isUsed };
            });
            rows.sort((a, b) => a.penalty - b.penalty);
            console.table(rows);
            c.info('Lowest penalty (best pick):', rows[0]?.sport, '(' + rows[0]?.penalty + ')');
            return rows;
        },
    };

    window.RotationAudit = RotationAudit;
    console.log('%cRotationAudit loaded.', 'color:#1b5e20;font-weight:bold');
    console.log('Try: RotationAudit.run() | RotationAudit.bunk("1") | RotationAudit.simulate("1")');
})();
