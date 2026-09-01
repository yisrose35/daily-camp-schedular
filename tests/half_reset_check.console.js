/**
 * ★ HR: NEW HALF (epoch reset) — pre/post console verifier.
 *
 * HOW TO USE (on the Flow page, F12 → Console):
 *   1. Paste this whole file into the console. It defines window.hrCheck.
 *   2. BEFORE clicking "New Half":   await hrCheck('pre')
 *      → snapshots counters, league state, schedule totals into localStorage.
 *   3. Click "New Half", let the page reload.
 *   4. Paste the file again (reload wiped it), then:   await hrCheck('post')
 *      → prints a ✅/❌ table proving what reset and what was preserved.
 *
 * The snapshot key (_hrVerify_pre_v1) is deliberately NOT one of the keys the
 * reset clears, so it survives the reset + reload.
 */
window.hrCheck = async function (phase) {
    const KEY = '_hrVerify_pre_v1';
    const out = [];
    const log = (name, val) => { out.push([name, val]); };

    // ---------- shared collectors ----------
    const getEpoch = () => {
        try {
            const e = window.loadGlobalSettings?.('rotationEpoch');
            const d = (typeof e === 'string') ? e : (e && e.date);
            return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
        } catch (_) { return null; }
    };
    const sumDeep = (obj) => {   // sum all numeric leaves
        let s = 0;
        (function walk(o) {
            if (o == null) return;
            if (typeof o === 'number') { s += o; return; }
            if (typeof o !== 'object') return;
            Object.keys(o).forEach(k => { if (k[0] !== '_') walk(o[k]); });
        })(obj);
        return s;
    };
    const collect = async () => {
        const snap = { at: new Date().toISOString(), epoch: getEpoch() };

        // Schedules (the archive that must survive)
        const all = window.loadAllDailyData?.() || {};
        const dateKeys = Object.keys(all).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
        snap.scheduleDates = dateKeys.length;
        snap.scheduleEntries = dateKeys.reduce((n, dk) => {
            const sa = all[dk]?.scheduleAssignments || {};
            return n + Object.keys(sa).reduce((m, b) => m + (Array.isArray(sa[b]) ? sa[b].filter(Boolean).length : 0), 0);
        }, 0);

        // Cloud daily_schedules rows
        snap.cloudScheduleRows = null;
        try {
            const client = window.CampistryDB?.getClient?.() || window.supabase;
            const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
            if (client && campId) {
                const { data } = await client.from('daily_schedules').select('date_key').eq('camp_id', campId);
                snap.cloudScheduleRows = (data || []).length;
            }
        } catch (_) {}

        // Rotation counters
        const gs = window.loadGlobalSettings?.() || {};
        snap.historicalCountsSum = sumDeep(gs.historicalCounts || {});
        snap.manualOffsetsSum = sumDeep(gs.manualUsageOffsets || {});
        snap.rotationHistoryBunks = Object.keys((gs.rotationHistory || {}).bunks || {}).length;
        snap.smartTileKeys = Object.keys(gs.smartTileHistory || {}).length;
        snap.swimKeys = Object.keys(gs.swimRotationHistory || {}).length
            + Object.keys((gs.app1 || {}).swimRotationHistory || {}).length;
        snap.weekActivityKeys = Object.keys(gs.activityHistory || {}).length
            + Object.keys((gs.app1 || {}).activityHistory || {}).length;
        snap.halfStartDate = (gs.app1 || {}).halfStartDate || null;

        // Cloud rotation_counts THROUGH the (epoch-filtered) loader
        snap.cloudRotationSum = null;
        try {
            const cloud = await window.RotationCloud?.load?.();
            if (cloud && cloud.counts) snap.cloudRotationSum = sumDeep(cloud.counts);
        } catch (_) {}

        // Probe pair: the most-used (bunk, activity) so post can prove it reads 0
        snap.probe = null;
        try {
            let best = 0;
            Object.entries(gs.historicalCounts || {}).forEach(([b, acts]) => {
                Object.entries(acts || {}).forEach(([a, n]) => {
                    if (typeof n === 'number' && n > best) { best = n; snap.probe = { bunk: b, act: a, count: n }; }
                });
            });
        } catch (_) {}

        // Rotation events completions
        snap.eventCompletions = 0;
        try {
            const evs = (window.loadGlobalSettings?.('rotationEvents') || {});
            Object.values(evs.events || evs || {}).forEach(ev => {
                Object.values((ev && ev.completedBunks) || {}).forEach(arr => { snap.eventCompletions += (arr || []).length; });
            });
        } catch (_) {}

        // Regular league history blob (fresher of local/cloud copies)
        const pickBlob = (lsKey, gsKey) => {
            let local = null;
            try { local = JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch (_) {}
            const cloud = gs[gsKey] || null;
            if (local && cloud) return (Number(local._savedAt) || 0) >= (Number(cloud._savedAt) || 0) ? local : cloud;
            return local || cloud || {};
        };
        const summarizeLeagueBlob = (h) => ({
            epochDate: h._epochDate || null,
            gamesPerDateSum: sumDeep(h.gamesPerDate || {}),
            gameLogDates: Object.values(h.gameLog || {}).reduce((n, lg) => n + Object.keys(lg || {}).length, 0),
            flatMatchupSum: (function () {
                const mh = h.matchupHistory || {};
                let s = 0;
                Object.values(mh).forEach(v => { s += Array.isArray(v) ? v.length : (typeof v === 'number' ? v : 0); });
                return s;
            })(),
            preEpochGameLogDates: (function (ep) {
                if (!ep) return null;
                let n = 0;
                Object.values(h.gameLog || {}).forEach(lg => Object.keys(lg || {}).forEach(d => { if (d < ep) n++; }));
                return n;
            })(h._epochDate || getEpoch())
        });
        snap.regHist = summarizeLeagueBlob(pickBlob('campLeagueHistory_v2', 'leagueHistory'));
        snap.specHist = summarizeLeagueBlob(pickBlob('campSpecialtyLeagueHistory_v1', 'specialtyLeagueHistory'));

        // "Next game number" the engine would stamp TODAY, per regular league
        snap.nextGameNumbers = {};
        try {
            const h = pickBlob('campLeagueHistory_v2', 'leagueHistory');
            const ep = h._epochDate || getEpoch() || '';
            const today = window.currentScheduleDate || new Date().toISOString().slice(0, 10);
            Object.entries(h.gamesPerDate || {}).forEach(([lg, map]) => {
                let t = 0;
                Object.keys(map || {}).forEach(d => { if ((!ep || d >= ep) && d < today) t += Number(map[d]) || 0; });
                snap.nextGameNumbers[lg] = t + 1;
            });
        } catch (_) {}

        // Standings + results archive (regular + specialty registries)
        const sumStandings = (reg) => {
            let wlt = 0, games = 0, playoffs = 0;
            Object.values(reg || {}).forEach(lg => {
                if (!lg) return;
                Object.values(lg.standings || {}).forEach(s => { wlt += (s.w || 0) + (s.l || 0) + (s.t || 0); });
                games += (lg.games || []).length;
                if (lg.playoff && lg.playoff.enabled) playoffs++;
            });
            return { wlt, games, playoffs };
        };
        snap.regLeagues = sumStandings(gs.leaguesByName || window.leaguesByName || {});
        snap.specLeagues = sumStandings(window.specialtyLeagues || gs.specialtyLeagues || {});
        snap.roundStateKeys = Object.keys(gs.leagueRoundState || {}).length;

        return snap;
    };

    // ---------- PRE ----------
    if (phase === 'pre') {
        const snap = await collect();
        localStorage.setItem(KEY, JSON.stringify(snap));
        console.log('%c★ HR pre-reset snapshot saved. Now click "New Half", then run  await hrCheck(\'post\')  after the reload.', 'font-weight:bold');
        console.table({
            'epoch (should be null/old)': snap.epoch,
            'schedule dates': snap.scheduleDates,
            'schedule entries': snap.scheduleEntries,
            'cloud schedule rows': snap.cloudScheduleRows,
            'historicalCounts sum': snap.historicalCountsSum,
            'cloud rotation sum': snap.cloudRotationSum,
            'reg gamesPerDate sum': snap.regHist.gamesPerDateSum,
            'reg flat matchups': snap.regHist.flatMatchupSum,
            'reg gameLog dates': snap.regHist.gameLogDates,
            'spec gamesPerDate sum': snap.specHist.gamesPerDateSum,
            'reg standings W+L+T': snap.regLeagues.wlt,
            'reg games archive': snap.regLeagues.games,
            'active playoffs': snap.regLeagues.playoffs + snap.specLeagues.playoffs,
            'event completions': snap.eventCompletions,
            'probe (most-used)': snap.probe ? (snap.probe.bunk + ' / ' + snap.probe.act + ' = ' + snap.probe.count) : '(none)'
        });
        return snap;
    }

    // ---------- POST ----------
    if (phase !== 'post') { console.error("Usage: await hrCheck('pre')  or  await hrCheck('post')"); return; }
    const pre = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!pre) { console.error('★ HR: no pre-snapshot found — run  await hrCheck(\'pre\')  before the reset.'); return; }
    const post = await collect();
    const ep = post.epoch;
    let pass = 0, fail = 0;
    const check = (name, ok, detail) => { ok ? pass++ : fail++; out.push([(ok ? '✅' : '❌') + ' ' + name, detail]); };

    check('Epoch is stamped', !!ep, 'rotationEpoch = ' + ep);
    check('halfStartDate hook matches epoch', post.halfStartDate === ep, post.halfStartDate + ' vs ' + ep);

    // NOTHING DELETED
    check('Schedules kept (dates)', post.scheduleDates >= pre.scheduleDates, pre.scheduleDates + ' → ' + post.scheduleDates);
    check('Schedules kept (entries)', post.scheduleEntries >= pre.scheduleEntries, pre.scheduleEntries + ' → ' + post.scheduleEntries);
    if (pre.cloudScheduleRows != null && post.cloudScheduleRows != null)
        check('Cloud schedule rows kept', post.cloudScheduleRows >= pre.cloudScheduleRows, pre.cloudScheduleRows + ' → ' + post.cloudScheduleRows);
    check('League gameLog archive kept', post.regHist.gameLogDates >= pre.regHist.gameLogDates, pre.regHist.gameLogDates + ' → ' + post.regHist.gameLogDates);
    check('Results archive kept (league.games)', post.regLeagues.games >= pre.regLeagues.games, pre.regLeagues.games + ' → ' + post.regLeagues.games);

    // EVERYTHING RESET
    check('historicalCounts zeroed', post.historicalCountsSum === 0, pre.historicalCountsSum + ' → ' + post.historicalCountsSum);
    check('manualUsageOffsets zeroed', post.manualOffsetsSum === 0, String(post.manualOffsetsSum));
    check('rotationHistory cleared', post.rotationHistoryBunks === 0, pre.rotationHistoryBunks + ' → ' + post.rotationHistoryBunks);
    if (post.cloudRotationSum != null)
        check('Cloud rotation loader reads 0 (epoch-filtered, rows kept)', post.cloudRotationSum === 0, (pre.cloudRotationSum ?? '?') + ' → ' + post.cloudRotationSum);
    check('Smart tile history cleared', post.smartTileKeys === 0, String(post.smartTileKeys));
    check('Swim ledger cleared (incl. app1 mirror)', post.swimKeys === 0, String(post.swimKeys));
    check('Week-activity ledger cleared (incl. app1 mirror)', post.weekActivityKeys === 0, String(post.weekActivityKeys));
    check('Rotation-event completions wiped', post.eventCompletions === 0, pre.eventCompletions + ' → ' + post.eventCompletions);
    check('leagueRoundState cleared', post.roundStateKeys === 0, String(post.roundStateKeys));

    // LEAGUES
    check('Regular blob _epochDate stamped', post.regHist.epochDate === ep, String(post.regHist.epochDate));
    check('Specialty blob _epochDate stamped', post.specHist.epochDate === ep, String(post.specHist.epochDate));
    check('Regular flat matchups epoch-scoped (0 until new games)', post.regHist.flatMatchupSum === 0, pre.regHist.flatMatchupSum + ' → ' + post.regHist.flatMatchupSum);
    const nextNums = Object.entries(post.nextGameNumbers);
    check('Every league\'s next game = Game 1', nextNums.every(([, n]) => n === 1) || nextNums.length === 0,
        nextNums.map(([l, n]) => l + '→Game ' + n).join(', ') || '(no leagues)');
    check('Standings zeroed (regular)', post.regLeagues.wlt === 0, pre.regLeagues.wlt + ' → ' + post.regLeagues.wlt);
    check('Standings zeroed (specialty)', post.specLeagues.wlt === 0, pre.specLeagues.wlt + ' → ' + post.specLeagues.wlt);
    check('Playoffs disabled', (post.regLeagues.playoffs + post.specLeagues.playoffs) === 0,
        (pre.regLeagues.playoffs + pre.specLeagues.playoffs) + ' → ' + (post.regLeagues.playoffs + post.specLeagues.playoffs));

    // LIVE PROBES — what the engine actually sees now
    if (pre.probe) {
        try {
            const c = window.RotationEngine?.getActivityCount?.(pre.probe.bunk, pre.probe.act);
            check('Probe count reads 0 (was ' + pre.probe.count + ': ' + pre.probe.bunk + '/' + pre.probe.act + ')', c === 0, String(c));
        } catch (_) {}
        try {
            const d = window.RotationEngine?.getDaysSinceActivity?.(pre.probe.bunk, pre.probe.act);
            check('Probe recency reads "never done" (complete reset)', d == null, String(d));
        } catch (_) {}
        try {
            const p = window.SchedulerCoreUtils?.getPeriodActivityCount?.(pre.probe.bunk, pre.probe.act, 'half');
            check('Probe per-half period count reads 0', p === 0, String(p));
        } catch (_) {}
    }

    console.log('%c★ HR POST-RESET VERIFICATION — ' + pass + ' passed, ' + fail + ' failed', 'font-weight:bold;font-size:14px;color:' + (fail ? '#c0392b' : '#0d9488'));
    console.table(Object.fromEntries(out.map(([k, v]) => [k, v])));
    if (!fail) console.log('%c✅ New Half verified: everything reset, nothing deleted.', 'color:#0d9488;font-weight:bold');
    else console.log('%c❌ Some checks failed — screenshot this table.', 'color:#c0392b;font-weight:bold');
    return { pass, fail, pre, post };
};
console.log("★ HR checker loaded. Run:  await hrCheck('pre')   — then reset —   await hrCheck('post')");
