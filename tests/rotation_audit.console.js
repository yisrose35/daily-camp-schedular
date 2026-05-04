/* =========================================================================
 * Rotation Audit — paste into the browser console (or load via <script>)
 *
 *   RotationAudit.run()        full report for today (window.currentScheduleDate)
 *   RotationAudit.run('2026-04-14')   audit a specific date
 *   RotationAudit.history()    just dump the raw weekActivityHistory
 *   RotationAudit.bunk('Bunk1')        deep-dive on one bunk
 *   RotationAudit.simulate(bunk, opts) replay findBestSport scoring math
 *
 * Checks every layer of the auto rotation pipeline:
 *   1. History storage     (localStorage + globalSettings + in-memory match)
 *   2. Today's snapshot    (each bunk's sport assignments today)
 *   3. Yesterday penalty   (sports played today AND yesterday → soft fail)
 *   4. Streak detection    (same sport 2+ consecutive days → hard fail)
 *   5. Variety entropy     (distinct sports / total over last 5 days)
 *   6. Overdue boost       (sports not seen in 4+ days that were available)
 *   7. Draft adherence     (planned sports actually being placed)
 *   8. Persistence cycle   (write a probe → reload → confirm round-trip)
 * ========================================================================= */

(function () {
    'use strict';

    const HISTORY_LS_KEY = 'campistry_activityHistory';
    const PENALTY_YESTERDAY = -300;
    const BOOST_OVERDUE = 200;
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

    function getHistory() {
        let fromLs = null, fromGs = null;
        try { fromLs = JSON.parse(localStorage.getItem(HISTORY_LS_KEY) || 'null'); } catch (_) {}
        try {
            const gs = (window.getGlobalSettings && window.getGlobalSettings())
                    || window.globalSettings || {};
            fromGs = gs.activityHistory || (gs.app1 && gs.app1.activityHistory) || null;
        } catch (_) {}
        return { fromLs, fromGs, merged: Object.assign({}, fromLs || {}, fromGs || {}) };
    }

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

    // Pull sport-only activities from window.scheduleAssignments
    function todaysSportsByBunk() {
        const out = {};
        const sa = window.scheduleAssignments || {};
        Object.keys(sa).forEach(bunk => {
            const slots = sa[bunk] || [];
            const sports = [];
            slots.forEach(slot => {
                if (!slot) return;
                // Sport blocks have a non-null .sport field
                if (slot.sport) sports.push(slot.sport);
            });
            out[bunk] = sports;
        });
        return out;
    }

    // ---- check 1: history storage -----------------------------------------
    function checkHistoryStorage() {
        c.h2('1. History storage');
        const h = getHistory();
        const lsKeys = h.fromLs ? Object.keys(h.fromLs).length : 0;
        const gsKeys = h.fromGs ? Object.keys(h.fromGs).length : 0;
        c.info('localStorage[' + HISTORY_LS_KEY + ']:', lsKeys + ' bunks');
        c.info('globalSettings.app1.activityHistory:', gsKeys + ' bunks');
        if (lsKeys === 0 && gsKeys === 0) {
            c.warn('No history found anywhere. Run the auto scheduler at least once first.');
            return { pass: false, history: {} };
        }
        if (lsKeys && gsKeys && lsKeys !== gsKeys) {
            c.warn('Bunk count differs between localStorage (' + lsKeys + ') and globalSettings (' + gsKeys + ') — saveWeekHistory may not be syncing both.');
        } else {
            c.ok('History present in both stores.');
        }
        return { pass: lsKeys + gsKeys > 0, history: h.merged };
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
        // Distribution
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
            c.ok('No bunk repeated a sport from ' + yesterday + '. Penalty (' + PENALTY_YESTERDAY + ') is winning.');
        } else {
            c.warn(repeats + ' bunk×sport repeats from yesterday. (Soft penalty — can lose to "+500 not-used-today" when no alternatives exist.)');
            console.table(violations);
        }
        return { repeats, violations };
    }

    // ---- check 4: streak detection ----------------------------------------
    function checkStreaks(date, history, today) {
        c.h2('4. Consecutive-day streaks (target: 0 streaks ≥ 2)');
        const days = [date].concat(recentDays(date, LOOKBACK_DAYS));
        const todayMap = today;
        const streaks = [];
        Object.keys(todayMap).forEach(bunk => {
            const seenByDay = {};
            seenByDay[date] = todayMap[bunk] || [];
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
        const days = [date].concat(recentDays(date, LOOKBACK_DAYS));
        const rows = [];
        Object.keys(today).forEach(bunk => {
            const all = [];
            (today[bunk] || []).forEach(s => all.push(s));
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
        const olderWindow = recentDays(date, LOOKBACK_DAYS).slice(4); // day 5+
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
        if (resurfaced > 0) c.ok('+' + BOOST_OVERDUE + ' boost is producing comebacks for stale sports.');
        else c.warn('No overdue resurfacing detected — could mean history is too short, or boost is being outweighed by demand penalties.');
        return { resurfaced };
    }

    // ---- check 7: draft adherence -----------------------------------------
    function checkDraftAdherence() {
        c.h2('7. Draft adherence (Phase-2 plan vs actual placements)');
        // The draft lives inside the closure of runAutoScheduler — not exposed.
        // Best-effort: look for a stash on window.* if anything has hooked it.
        const draft = window.__lastDraftResults || window.draftResults || null;
        if (!draft) {
            c.warn('No draft snapshot exposed (runGlobalPlanner keeps draftResults closure-private). To enable this check, add  window.__lastDraftResults = draftResults;  inside scheduler_core_auto.js after the planner returns.');
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

    // ---- check 8: persistence round-trip ----------------------------------
    function checkPersistence() {
        c.h2('8. Persistence round-trip (probe write → reload)');
        const probeKey = '__rotationAuditProbe__';
        const probeDate = '1999-01-01';
        let history = {};
        try { history = JSON.parse(localStorage.getItem(HISTORY_LS_KEY) || '{}'); } catch (_) {}
        const original = JSON.stringify(history);
        history[probeKey] = { [probeDate]: ['ProbeSport'] };
        localStorage.setItem(HISTORY_LS_KEY, JSON.stringify(history));
        const rl = JSON.parse(localStorage.getItem(HISTORY_LS_KEY) || '{}');
        const ok = rl[probeKey] && rl[probeKey][probeDate] && rl[probeKey][probeDate][0] === 'ProbeSport';
        // restore
        localStorage.setItem(HISTORY_LS_KEY, original);
        if (ok) c.ok('localStorage round-trip works — saveWeekHistory should persist correctly.');
        else c.bad('localStorage round-trip FAILED. History will not persist between days.');
        return { pass: ok };
    }

    // ---- public ------------------------------------------------------------
    const RotationAudit = {
        run(dateOverride) {
            const date = dateOverride || window.currentScheduleDate || new Date().toISOString().split('T')[0];
            c.h1('Rotation Audit — ' + date);
            const r1 = checkHistoryStorage();
            const r2 = checkTodaysSnapshot(date);
            const history = r1.history;
            const today = r2.today;
            const r3 = checkYesterdayPenalty(date, history, today);
            const r4 = checkStreaks(date, history, today);
            const r5 = checkVariety(date, history, today);
            const r6 = checkOverdueBoost(date, history, today);
            const r7 = checkDraftAdherence();
            const r8 = checkPersistence();

            c.h1('Summary');
            const fails = [];
            if (!r1.pass) fails.push('history-empty');
            if (!r2.pass) fails.push('no-sport-blocks');
            if (r3.repeats > 0) fails.push('yesterday-repeats:' + r3.repeats);
            if (r4.streaks.length > 0) fails.push('streaks:' + r4.streaks.length);
            if (!r8.pass) fails.push('persistence-broken');
            if (fails.length === 0) c.ok('All hard checks passed.');
            else c.bad('Issues: ' + fails.join(', '));
            return { date, history, today, fails,
                     details: { storage: r1, snapshot: r2, yesterday: r3,
                                streaks: r4, variety: r5, overdue: r6,
                                draft: r7, persistence: r8 } };
        },

        history() { return getHistory(); },

        bunk(bunkId) {
            const date = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const h = getHistory().merged;
            const today = todaysSportsByBunk()[bunkId] || [];
            const days = [date].concat(recentDays(date, LOOKBACK_DAYS));
            c.h1('Bunk ' + bunkId + ' — rotation history');
            const rows = days.map(d => ({
                date: d,
                sports: (d === date ? today : ((h[bunkId] && h[bunkId][d]) || [])).join(', ') || '—'
            }));
            console.table(rows);
            return rows;
        },

        // Re-implement the findBestSport scoring math so you can verify it
        // matches the picker's actual decisions.  Pass a list of candidate
        // sports + the bunk's history and see scores.
        simulate(bunkId, opts) {
            opts = opts || {};
            const date = opts.date || window.currentScheduleDate || new Date().toISOString().split('T')[0];
            const candidates = opts.candidates || ['Basketball', 'Soccer', 'Football', 'Baseball'];
            const drafted = new Set(opts.drafted || []);
            const used = new Set(opts.usedToday || []);
            const fieldDemand = opts.fieldDemand || 0;
            const fieldPressure = opts.fieldPressure || 0;
            const h = getHistory().merged[bunkId] || {};
            const lookback = recentDays(date, LOOKBACK_DAYS);
            c.h1('Score simulation — ' + bunkId + ' on ' + date);
            const rows = candidates.map(sport => {
                let daysAgo = Infinity;
                for (let i = 0; i < lookback.length; i++) {
                    if ((h[lookback[i]] || []).indexOf(sport) >= 0) { daysAgo = i + 1; break; }
                }
                const isDrafted = drafted.has(sport), isUsed = used.has(sport);
                let score = 0, breakdown = [];
                if (isDrafted && !isUsed) { score += 1000; breakdown.push('+1000 drafted-unused'); }
                else if (!isUsed)         { score += 500;  breakdown.push('+500 unused'); }
                else                      { breakdown.push('0 reuse'); }
                score -= fieldDemand * 10; if (fieldDemand) breakdown.push('-' + (fieldDemand*10) + ' demand');
                if (daysAgo <= 1)  { score -= 300; breakdown.push('-300 yesterday'); }
                else if (daysAgo >= 4) { score += 200; breakdown.push('+200 overdue'); }
                if (fieldPressure >= 0.8) { score -= 150; breakdown.push('-150 capacity'); }
                else if (fieldPressure <= 0.2) { score += 100; breakdown.push('+100 empty'); }
                return { sport, daysAgo: daysAgo === Infinity ? '—' : daysAgo, score, breakdown: breakdown.join(' | ') };
            });
            rows.sort((a, b) => b.score - a.score);
            console.table(rows);
            c.info('Picker would choose:', rows[0] && rows[0].sport);
            return rows;
        },
    };

    window.RotationAudit = RotationAudit;
    console.log('%cRotationAudit loaded.', 'color:#1b5e20;font-weight:bold');
    console.log('Try: RotationAudit.run() | RotationAudit.bunk("Bunk1") | RotationAudit.simulate("Bunk1")');
})();
