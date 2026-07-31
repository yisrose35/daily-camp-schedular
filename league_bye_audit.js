/* =============================================================================
 * LEAGUE BYE AUDIT  (window.LeagueByeAudit / window.byeAudit)
 * -----------------------------------------------------------------------------
 * A console report that answers one question after you generate a run of days:
 * "is the bye landing on a different team each time, or is one team eating all
 * of them?" — plus the two things that ride along with a bye: what the benched
 * team was given to do, and whether the chinuch rooms held.
 *
 * USAGE (browser console, Flow page):
 *
 *   byeAudit()                          every league, every date on record
 *   byeAudit('Soloists')                one league
 *   byeAudit({ from: '2026-07-01', to: '2026-07-10' })
 *   byeAudit({ league: 'Soloists', verbose: true })    per-date breakdown too
 *
 * It reads what was actually SAVED, not what the engine intended:
 *
 *   • the saved daily schedules (campDailyData_v1 → leagueAssignments) are the
 *     source of truth — those are the tiles that printed, and they carry the
 *     "Team — Bye: Pool" / "Team — Chinuch (Beis Medrash)" lines verbatim;
 *   • the engine's own date-keyed gameLog is read alongside as a cross-check,
 *     because the two drifting apart is itself a finding (a day generated on a
 *     device whose history never synced looks fine on the grid and wrong to the
 *     fairness ledgers, which is what LG-9 was about).
 *
 * VERDICTS
 *   PASS  byes are within one of each other across the teams
 *   WARN  evenly spread overall, but something worth a look (a team benched on
 *         consecutive days, a benched team always getting the same activity,
 *         schedule/history drift)
 *   FAIL  the spread is 2 or more, or a chinuch room was over-filled
 *
 * build() takes injected history/dailyData so the aggregation is unit-testable
 * without a DOM — see tests/league_bye_audit.test.js.
 * ========================================================================== */
(function () {
    'use strict';

    var A = {};

    // Printed in the report header. Bump it with any change to what the report
    // measures or shows — two rounds of this investigation were spent deciding
    // whether the browser was running the new code or a cached copy, which the
    // header now answers on sight. Keep in step with the ?v= on the script tag.
    A.VERSION = '2026-07-31.5';

    // ── utils ────────────────────────────────────────────────────────────────
    function norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }
    function isDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }
    function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

    // ── data access ──────────────────────────────────────────────────────────
    // Same precedence as league_play_report.js: the engine's loader knows the
    // cloud/local fresher-wins rules, so prefer it and fall back to a plain read.
    function loadHistory() {
        try {
            var SCL = (typeof window !== 'undefined') && window.SchedulerCoreLeagues;
            if (SCL && typeof SCL.getHistorySnapshot === 'function') return SCL.getHistorySnapshot() || {};
        } catch (e) { /* fall through */ }
        try {
            var gs = (typeof window !== 'undefined' && window.loadGlobalSettings) ? (window.loadGlobalSettings() || {}) : {};
            var cloud = (gs.leagueHistory && Object.keys(gs.leagueHistory).length > 0) ? gs.leagueHistory : null;
            var local = null;
            try {
                var raw = localStorage.getItem('campLeagueHistory_v2');
                if (raw) local = JSON.parse(raw);
            } catch (e2) { /* ignore */ }
            if (cloud && local) return ((Number(local._savedAt) || 0) > (Number(cloud._savedAt) || 0)) ? local : cloud;
            return cloud || local || {};
        } catch (e3) { return {}; }
    }
    function loadDailyData() {
        try {
            if (typeof window !== 'undefined' && typeof window.loadAllDailyData === 'function') {
                return window.loadAllDailyData() || {};
            }
        } catch (e) { /* fall through */ }
        try {
            var raw = localStorage.getItem('campDailyData_v1');
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e2) { return {}; }
    }
    function leagueConfigs() {
        try {
            if (typeof window === 'undefined') return [];
            var byName = window.leaguesByName ||
                (window.loadGlobalSettings ? (window.loadGlobalSettings() || {}).leaguesByName : null) || {};
            return Object.keys(byName).map(function (k) { return byName[k]; }).filter(Boolean);
        } catch (e) { return []; }
    }
    // The tile prints "T — Chinuch (<room>)", but when a team has NO room
    // configured the engine fills that slot with the bare word "Chinuch" as a
    // label — see the `|| 'Chinuch'` fallbacks in scheduler_core_leagues.js.
    // Those teams are deliberately unconstrained, so counting the placeholder
    // as a one-seat room reported every one of them as an overflow.
    // The league config is what the engine actually planned against, so trust
    // it first; fall back to the tile only when it names something real.
    A.resolveRoom = function (league, team, tileRoom) {
        var cfg = (league && league.chinuch && league.chinuch.bunkFacilities
            && league.chinuch.bunkFacilities[team]) || '';
        if (cfg) return String(cfg).trim();
        var t = String(tileRoom || '').trim();
        if (!t || norm(t) === 'chinuch') return '';     // placeholder → no room
        return t;
    };

    // ★ THE ENGINE'S OWN LEDGER — what the NEXT generation will act on.
    // Everything else here is the auditor's re-derivation from saved data; this
    // is the actual object the pairing code consults. When it disagrees with
    // the grid, the next day's bye is decided on numbers that do not match what
    // was scheduled, which is the failure that is otherwise invisible.
    // Returns null when the engine isn't on the page (tests, other pages).
    function engineLedger(league, teams, history) {
        try {
            var SCL = (typeof window !== 'undefined') && window.SchedulerCoreLeagues;
            if (!SCL || typeof SCL.makeByeLedger !== 'function') return null;
            // No dayId: nothing is "today", so every recorded day counts —
            // exactly the state a fresh generation would start from.
            return SCL.makeByeLedger(league.name, teams, history, null);
        } catch (e) { return null; }
    }

    function roomCapacity(league, room) {
        try {
            var SCL = (typeof window !== 'undefined') && window.SchedulerCoreLeagues;
            if (SCL && typeof SCL.chinuchRoomCapacity === 'function') {
                return SCL.chinuchRoomCapacity(league, room, null);
            }
        } catch (e) { /* fall through */ }
        var ov = league && league.chinuch && league.chinuch.roomCapacity;
        var v = ov && Number(ov[room]);
        return (Number.isFinite(v) && v > 0) ? v : 1;
    }

    // ── tile-line parsing ────────────────────────────────────────────────────
    // The three shapes the league engine writes into a tile's matchups array:
    //   "A vs B @ Field (Sport)"        a game
    //   "T — Bye"  /  "T — Bye: Pool"   a benched team (and what it got instead)
    //   "T — Chinuch (Beis Medrash)"    a team learning, and where
    // Section rows ("Electives:", "  • Field") are ignored.
    var RE_BYE = /^(.+?)\s+[—–-]\s*Bye(?:\s*:\s*(.+?))?\s*$/i;
    var RE_CHINUCH = /^(.+?)\s+[—–-]\s*Chinuch\s*(?:\(([^)]*)\))?\s*$/i;

    A.parseLine = function (raw) {
        var s = String(raw == null ? '' : raw).trim();
        if (!s) return null;
        if (/^\s*•/.test(s) || /^(electives|open fields):?\s*$/i.test(s)) return null;
        var ch = s.match(RE_CHINUCH);
        if (ch) return { kind: 'chinuch', team: ch[1].trim(), room: (ch[2] || '').trim() };
        var by = s.match(RE_BYE);
        if (by) return { kind: 'bye', team: by[1].trim(), activity: (by[2] || '').trim() };
        if (/\s+vs\.?\s+/i.test(s)) {
            var g = s.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*@.*)?$/i);
            if (g) return { kind: 'game', teamA: g[1].trim(), teamB: g[2].trim() };
        }
        return null;
    };

    // One row per (date, period) for a league, collapsed across divisions — a
    // game that spans divisions is stored once per division and must count once.
    function periodsFromDailyData(dailyData, leagueName, from, to) {
        var out = [];
        Object.keys(dailyData || {}).forEach(function (date) {
            if (!isDate(date)) return;
            if (from && date < from) return;
            if (to && date > to) return;
            var la = dailyData[date] && dailyData[date].leagueAssignments;
            if (!la) return;
            var byPeriod = {};
            Object.keys(la).forEach(function (div) {
                var map = la[div] || {};
                Object.keys(map).forEach(function (slotKey) {
                    var entry = map[slotKey];
                    if (!entry || norm(entry.leagueName) !== norm(leagueName)) return;
                    // Group by the game label when there is one — it identifies the
                    // period even if two divisions key the same game differently.
                    var pk = entry.gameLabel || ('slot ' + slotKey);
                    var rec = byPeriod[pk];
                    if (!rec) {
                        rec = byPeriod[pk] = {
                            date: date, label: entry.gameLabel || '', slot: slotKey,
                            games: [], byes: [], chinuch: [], _seen: {}
                        };
                    }
                    (entry.matchups || []).forEach(function (m) {
                        var line = (m && typeof m === 'object')
                            ? String(m.display || m.matchup || m.text || '')
                            : String(m == null ? '' : m);
                        var p = A.parseLine(line);
                        if (!p) return;
                        var key = p.kind + '|' + (p.team || (p.teamA + 'v' + p.teamB));
                        if (rec._seen[key]) return;
                        rec._seen[key] = 1;
                        if (p.kind === 'game') rec.games.push(p);
                        else if (p.kind === 'bye') rec.byes.push(p);
                        else rec.chinuch.push(p);
                    });
                });
            });
            Object.keys(byPeriod).forEach(function (pk) {
                var r = byPeriod[pk];
                delete r._seen;
                out.push(r);
            });
        });
        return out.sort(function (a, b) {
            return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || String(a.label).localeCompare(String(b.label));
        });
    }

    // The same quantity, computed from the engine's ledger — periods on a date
    // are its distinct game labels, and a team in none of a period's games sat
    // it out (minus its chinuch session, which is not a bye).
    function byesFromHistory(history, leagueName, teams, from, to) {
        var counts = {}, byDate = {};
        teams.forEach(function (t) { counts[t] = 0; });
        var gl = (history && history.gameLog && history.gameLog[leagueName]) || {};
        var cbd = (history && history.chinuchByDate && history.chinuchByDate[leagueName]) || {};
        Object.keys(gl).forEach(function (d) {
            if (!isDate(d)) return;
            if (from && d < from) return;
            if (to && d > to) return;
            var entries = gl[d] || [];
            if (!entries.length) return;
            var labels = {};
            entries.forEach(function (e) { if (e && e.g) labels[e.g] = 1; });
            var periods = Math.max(Object.keys(labels).length, 1);
            var chinuch = {};
            (cbd[d] || []).forEach(function (t) { chinuch[t] = 1; });
            var day = byDate[d] = {
                periods: periods,
                chinuchRecorded: (cbd[d] || []).length,
                byes: 0, teams: [], perTeam: {}
            };
            teams.forEach(function (t) {
                var played = 0;
                entries.forEach(function (e) { if (e && (e.t1 === t || e.t2 === t)) played++; });
                var sat = periods - played - (chinuch[t] ? 1 : 0);
                if (sat > 0) { counts[t] += sat; day.byes += sat; day.teams.push(t); day.perTeam[t] = sat; }
            });
        });
        return { counts: counts, byDate: byDate };
    }

    // ── BUILD ────────────────────────────────────────────────────────────────
    // opts: { league, from, to, history, dailyData, leagues }
    A.build = function (opts) {
        opts = opts || {};
        var history = opts.history || loadHistory();
        var dailyData = opts.dailyData || loadDailyData();
        var configs = opts.leagues || leagueConfigs();
        if (opts.league) {
            configs = configs.filter(function (l) { return l && norm(l.name) === norm(opts.league); });
            if (!configs.length) configs = [{ name: opts.league, teams: [] }];
        }

        var out = { range: { from: opts.from || null, to: opts.to || null }, leagues: [] };

        configs.forEach(function (league) {
            var name = league.name;
            var periods = periodsFromDailyData(dailyData, name, opts.from, opts.to);

            // Roster first (keeps configured order), then any name only seen in
            // the saved tiles — a removed or renamed team stays visible.
            var teams = [], seen = {};
            (league.teams || []).forEach(function (t) {
                if (t == null) return;
                if (!seen[norm(t)]) { seen[norm(t)] = 1; teams.push(String(t)); }
            });
            periods.forEach(function (p) {
                p.byes.forEach(function (b) { if (!seen[norm(b.team)]) { seen[norm(b.team)] = 1; teams.push(b.team); } });
                p.chinuch.forEach(function (c) { if (!seen[norm(c.team)]) { seen[norm(c.team)] = 1; teams.push(c.team); } });
                p.games.forEach(function (g) {
                    [g.teamA, g.teamB].forEach(function (t) { if (!seen[norm(t)]) { seen[norm(t)] = 1; teams.push(t); } });
                });
            });

            var byTeam = {};
            function blank(t) {
                return { team: t, played: 0, chinuch: 0, byes: 0, activities: {}, byeDates: [],
                    noActivity: 0, eligible: 0, expected: 0 };
            }
            teams.forEach(function (t) { byTeam[t] = blank(t); });
            function rec(t) {
                if (!byTeam[t]) byTeam[t] = blank(t);
                return byTeam[t];
            }

            var dates = {};
            periods.forEach(function (p) {
                dates[p.date] = 1;
                p.games.forEach(function (g) { rec(g.teamA).played++; rec(g.teamB).played++; });
                p.chinuch.forEach(function (c) { rec(c.team).chinuch++; });
                p.byes.forEach(function (b) {
                    var r = rec(b.team);
                    r.byes++;
                    r.byeDates.push(p.date);
                    if (b.activity) r.activities[b.activity] = (r.activities[b.activity] || 0) + 1;
                    else r.noActivity++;
                });
            });

            // ★ WHO COULD EVEN HAVE SAT OUT.
            // A team only enters the draw for a bye in a period that HAD a bye
            // and that the team was active in — a team at chinuch that period
            // was never a candidate. Without this, a team at chinuch during the
            // one period that produces the bye shows 0 byes and looks favored,
            // when in truth it was never in the running. `expected` is the fair
            // share: each bye in a period is split evenly among its candidates.
            periods.forEach(function (p) {
                if (!p.byes.length) return;
                var candidates = [];
                p.games.forEach(function (g) { candidates.push(g.teamA); candidates.push(g.teamB); });
                p.byes.forEach(function (b) { candidates.push(b.team); });
                var uniq = [], s = {};
                candidates.forEach(function (t) { if (!s[norm(t)]) { s[norm(t)] = 1; uniq.push(t); } });
                uniq.forEach(function (t) {
                    var r = rec(t);
                    r.eligible++;
                    r.expected += p.byes.length / uniq.length;
                });
            });

            var ledger = engineLedger(league, teams, history);
            var hist = byesFromHistory(history, name, teams, opts.from, opts.to);
            var histByes = hist.counts;
            // Byes seen on the grid, per date — for the drift breakdown below.
            var gridByDate = {};
            periods.forEach(function (p) {
                var g = gridByDate[p.date] = gridByDate[p.date] || { byes: 0, chinuch: 0, teams: [] };
                g.byes += p.byes.length;
                g.chinuch += p.chinuch.length;
                p.byes.forEach(function (b) { g.teams.push(b.team); });
            });
            var totalByes = teams.reduce(function (n, t) { return n + byTeam[t].byes; }, 0);
            var counts = teams.map(function (t) { return byTeam[t].byes; });
            var maxB = counts.length ? Math.max.apply(null, counts) : 0;
            var minB = counts.length ? Math.min.apply(null, counts) : 0;
            var spread = maxB - minB;

            // ── findings ─────────────────────────────────────────────────────
            var findings = [];
            if (!periods.length) {
                findings.push({ level: 'info', code: 'no-data',
                    message: 'No saved league periods found for "' + name + '"'
                        + (opts.from || opts.to ? ' in this date range' : '') + '.' });
            } else if (!totalByes) {
                findings.push({ level: 'ok', code: 'no-byes',
                    message: 'No byes at all — every team played every period.' });
            } else {
                if (spread <= 1) {
                    findings.push({ level: 'ok', code: 'bye-spread',
                        message: 'Byes are even: every team is within one of every other (' + minB + '–' + maxB + ').' });
                } else {
                    var hogs = teams.filter(function (t) { return byTeam[t].byes === maxB; });
                    var spared = teams.filter(function (t) { return byTeam[t].byes === minB; });
                    // Is this the PICKER being unfair, or was the pool itself
                    // lopsided? A team at chinuch during the one period that
                    // produces the bye is never in the running, so it shows 0
                    // and looks favored. Compare each team against its fair
                    // share of the periods it was actually eligible for.
                    var worstDev = 0, devTeam = null;
                    teams.forEach(function (t) {
                        var dev = byTeam[t].byes - byTeam[t].expected;
                        if (Math.abs(dev) > Math.abs(worstDev)) { worstDev = dev; devTeam = t; }
                    });
                    var neverEligible = teams.filter(function (t) { return byTeam[t].eligible === 0; });
                    if (Math.abs(worstDev) <= 1) {
                        findings.push({ level: 'warn', code: 'bye-spread-structural',
                            message: 'Byes look uneven (spread of ' + spread + ': ' + hogs.join(', ') + ' at ' + maxB
                                + '×, ' + spared.join(', ') + ' at ' + minB + '×) — but each team is within one of its '
                                + 'FAIR SHARE of the periods it could actually have sat out. The picker is behaving; the '
                                + 'pool is lopsided. '
                                + (neverEligible.length
                                    ? neverEligible.join(', ') + ' never entered the draw at all — they were at chinuch, '
                                      + 'or playing, during every period that produced a bye. Even out the chinuch grouping '
                                      + 'so the same teams are not always out of the running.'
                                    : 'Check which teams are active in the period that produces the bye.') });
                    } else {
                        findings.push({ level: 'error', code: 'bye-spread',
                            message: 'Byes are UNEVEN — spread of ' + spread + '. '
                                + hogs.join(', ') + ' sat out ' + maxB + '× while '
                                + spared.join(', ') + ' sat out ' + minB + '×. '
                                + devTeam + ' is ' + (worstDev > 0 ? '+' : '') + worstDev.toFixed(1)
                                + ' against its fair share of the periods it was eligible for, so this is the picker, '
                                + 'not the chinuch grouping.' });
                    }
                }

                // A team benched on consecutive league days: the totals can even
                // out over a season and still feel unfair in the moment.
                var dayList = Object.keys(dates).sort();
                teams.forEach(function (t) {
                    var mine = {}; byTeam[t].byeDates.forEach(function (d) { mine[d] = 1; });
                    for (var i = 1; i < dayList.length; i++) {
                        if (mine[dayList[i]] && mine[dayList[i - 1]]) {
                            findings.push({ level: 'warn', code: 'bye-streak',
                                message: t + ' sat out on back-to-back league days (' + dayList[i - 1] + ' → ' + dayList[i] + ').' });
                            break;
                        }
                    }
                });

                // A team benched more than once that always drew the same thing,
                // while the league offers more than one bye activity.
                var poolSize = ((league.byeActivity && league.byeActivity.activities) || []).length;
                teams.forEach(function (t) {
                    var r = byTeam[t];
                    var kinds = Object.keys(r.activities);
                    if (r.byes >= 2 && poolSize > 1 && kinds.length === 1 && !r.noActivity) {
                        findings.push({ level: 'warn', code: 'activity-monotony',
                            message: t + ' got "' + kinds[0] + '" on all ' + r.byes + ' of its byes, though the league offers '
                                + poolSize + ' bye activities.' });
                    }
                });

                // Benched with nothing to do — only worth saying when the league
                // has the Bye Activity feature switched on.
                if (league.byeActivity && league.byeActivity.enabled) {
                    var bare = teams.filter(function (t) { return byTeam[t].noActivity > 0; });
                    if (bare.length) {
                        findings.push({ level: 'warn', code: 'bye-no-activity',
                            message: 'Bye Activity is on, but ' + bare.join(', ')
                                + ' got a plain bye with nothing scheduled — check the activity list and any per-team pin.' });
                    }
                }
            }

            // ── saved schedules vs the engine's ledger ──────────────────────
            // Checked whenever the league ran at all, NOT only when the grid
            // shows byes: "grid says 0, history says 2" is the dangerous shape,
            // because the fairness ledger is the side that decides the next bye.
            if (periods.length) {
                // Only dates the grid actually covers are comparable. History
                // routinely reaches further back than the schedules cached in
                // this browser, and counting those extra days as "drift"
                // produced a warning with no day behind it to explain it.
                var histShared = {};
                teams.forEach(function (t) { histShared[t] = 0; });
                var histOnly = [];
                Object.keys(hist.byDate).sort().forEach(function (d) {
                    if (!gridByDate[d]) { if (hist.byDate[d].byes) histOnly.push(d); return; }
                    var pt = hist.byDate[d].perTeam || {};
                    Object.keys(pt).forEach(function (t) { if (histShared[t] != null) histShared[t] += pt[t]; });
                });
                if (histOnly.length) {
                    findings.push({ level: 'info', code: 'history-only-days',
                        message: 'History has ' + histOnly.length + ' more league day(s) than this browser has schedules for ('
                            + histOnly.slice(0, 6).join(', ') + (histOnly.length > 6 ? ', …' : '')
                            + '). Those days are counted by the fairness ledger but cannot be checked here — open them, or run '
                            + 'byeAudit with a date range that matches what you have.' });
                }

                var drift = teams.filter(function (t) { return (histShared[t] || 0) !== byTeam[t].byes; });
                if (drift.length) {
                    findings.push({ level: 'warn', code: 'history-drift',
                        message: 'Saved schedules and the league history disagree on byes for '
                            + drift.map(function (t) { return t + ' (' + byTeam[t].byes + ' on the grid, ' + (histShared[t] || 0) + ' in history)'; }).join(', ')
                            + '. The fairness ledger reads history, so a day generated on a device that never synced can skew the next run.' });

                    // WHICH days, and why. The usual cause is a date whose
                    // chinuch attendance was never recorded: history then reads
                    // every learning team as having sat out, inflating its bye
                    // count and sending the next day's bye to the wrong team.
                    var driftDays = [];
                    Object.keys(gridByDate).sort().forEach(function (d) {
                        var h = hist.byDate[d];
                        var g = gridByDate[d];
                        if (!h) { driftDays.push({ date: d, why: 'no games logged in history at all', grid: g.byes, history: null }); return; }
                        if (h.byes === g.byes) return;
                        driftDays.push({
                            date: d, grid: g.byes, history: h.byes,
                            why: (g.chinuch > 0 && !h.chinuchRecorded)
                                ? 'chinuch attendance was not recorded for this day, so history counts all ' + g.chinuch + ' learning team(s) as byes'
                                : 'period/game records differ'
                        });
                    });
                    driftDays.forEach(function (dd) {
                        findings.push({ level: 'warn', code: 'history-drift-day',
                            message: '   ' + dd.date + ': grid ' + dd.grid + ' bye(s), history '
                                + (dd.history == null ? 'none' : dd.history) + ' — ' + dd.why + '.' });
                    });
                    var noChinuch = driftDays.filter(function (dd) { return /chinuch attendance was not recorded/.test(dd.why); });
                    if (noChinuch.length) {
                        findings.push({ level: 'error', code: 'chinuch-ledger-missing',
                            message: 'Bye fairness is running on bad numbers: ' + noChinuch.length
                                + ' day(s) have chinuch on the grid but no chinuch record in history, so the ledger '
                                + 'treats those learning teams as benched. Re-generate those days to rewrite the record.' });
                    }
                }
            }

            // ── chinuch rooms: nobody double-booked ─────────────────────────
            var roomIssues = [];
            periods.forEach(function (p) {
                var byRoom = {};
                p.chinuch.forEach(function (c) {
                    var room = A.resolveRoom(league, c.team, c.room);
                    if (!room) return;                   // no room named → unconstrained
                    (byRoom[room] = byRoom[room] || []).push(c.team);
                });
                Object.keys(byRoom).forEach(function (room) {
                    var cap = roomCapacity(league, room);
                    if (Number.isFinite(cap) && byRoom[room].length > cap) {
                        roomIssues.push({ date: p.date, label: p.label, room: room,
                            capacity: cap, teams: byRoom[room].slice() });
                    }
                });
            });
            roomIssues.forEach(function (r) {
                findings.push({ level: 'error', code: 'room-overflow',
                    message: r.date + ' ' + (r.label || '') + ': "' + r.room + '" holds ' + r.capacity
                        + ' but ' + r.teams.length + ' teams were sent there (' + r.teams.join(', ') + ').' });
            });

            var verdict = findings.some(function (f) { return f.level === 'error'; }) ? 'FAIL'
                : findings.some(function (f) { return f.level === 'warn'; }) ? 'WARN'
                : findings.some(function (f) { return f.level === 'info'; }) ? 'NO DATA' : 'PASS';

            // ── what the engine will do NEXT ────────────────────────────────
            // The auditor's numbers are hindsight; the ledger is the input to
            // the next generation. If they disagree, the next bye is chosen on
            // figures that don't match the schedule — and no amount of
            // regenerating fixes it until the ledger is right.
            if (ledger && periods.length && !opts.from && !opts.to) {
                var ledgerOff = teams.filter(function (t) { return ledger.count(t) !== byTeam[t].byes; });
                if (ledgerOff.length) {
                    findings.push({ level: 'warn', code: 'ledger-mismatch',
                        message: 'The engine\'s bye ledger — the numbers the NEXT generation will use — does not match '
                            + 'the schedules: '
                            + ledgerOff.slice(0, 6).map(function (t) { return t + ' (ledger ' + ledger.count(t) + ', grid ' + byTeam[t].byes + ')'; }).join(', ')
                            + (ledgerOff.length > 6 ? ', …' : '')
                            + (ledger.unmeasurable && ledger.unmeasurable.length
                                ? '. It is ignoring ' + ledger.unmeasurable.length + ' day(s) it cannot read ('
                                  + ledger.unmeasurable.slice(0, 4).join(', ') + ')'
                                : '')
                            + '. Regenerate the affected days IN ORDER, letting each one save before starting the next.' });
                } else {
                    findings.push({ level: 'ok', code: 'ledger-match',
                        message: 'The engine\'s bye ledger agrees with the schedules — the next generation starts from the right numbers.' });
                }
            }

            out.leagues.push({
                name: name,
                league: league,          // the config, so the renderer can resolve rooms
                ledger: ledger,
                teams: teams,
                dates: Object.keys(dates).sort(),
                periodCount: periods.length,
                totalByes: totalByes,
                spread: spread,
                byTeam: byTeam,
                periods: periods,
                historyByes: histByes,
                roomIssues: roomIssues,
                findings: findings,
                verdict: verdict
            });
        });

        return out;
    };

    // ── RENDER ───────────────────────────────────────────────────────────────
    var ICON = { ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' };

    A.print = function (data, opts) {
        opts = opts || {};
        var range = (data.range && (data.range.from || data.range.to))
            ? ('  [' + (data.range.from || '…') + ' → ' + (data.range.to || '…') + ']') : '';
        console.log('%c🏳️ LEAGUE BYE AUDIT' + range + '%c  v' + A.VERSION,
            'font-weight:bold;font-size:14px;', 'font-weight:normal;font-size:11px;color:#94A3B8;');

        if (!data.leagues.length) {
            console.log('   No leagues configured.');
            return data;
        }

        data.leagues.forEach(function (L) {
            var color = L.verdict === 'PASS' ? 'background:#DCFCE7;color:#166534'
                : L.verdict === 'WARN' ? 'background:#FEF3C7;color:#92400E'
                : L.verdict === 'FAIL' ? 'background:#FEE2E2;color:#991B1B'
                : 'background:#F1F5F9;color:#475569';
            console.group('%c ' + L.verdict + ' %c  ' + L.name
                + '   ·   ' + L.dates.length + ' day(s), ' + L.periodCount + ' league period(s), '
                + L.totalByes + ' bye(s)',
                color + ';font-weight:bold;border-radius:4px;', 'font-weight:bold;');

            if (L.periodCount > 0) {
                var rows = L.teams.map(function (t) {
                    var r = L.byTeam[t];
                    var acts = Object.keys(r.activities)
                        .map(function (a) { return a + (r.activities[a] > 1 ? ' ×' + r.activities[a] : ''); })
                        .join(', ');
                    return {
                        Team: t,
                        Played: r.played,
                        Chinuch: r.chinuch,
                        Byes: r.byes,
                        // How many bye-producing periods this team was actually
                        // in the running for, and its even split of them. A 0
                        // in "Could sit" means the team was never a candidate —
                        // not that the picker favored it.
                        'Could sit': r.eligible,
                        'Fair share': Math.round(r.expected * 10) / 10,
                        'On the bye': acts || (r.noActivity ? '(nothing)' : ''),
                        // What the ENGINE currently believes, and how many league
                        // days since it thinks this team last sat. These two drive
                        // the next generation's pick — everything left of here is
                        // hindsight.
                        'Ledger': L.ledger ? L.ledger.count(t) : '',
                        'Waited': L.ledger ? L.ledger.staleness(t) : ''
                    };
                });
                if (console.table) console.table(rows);
                else rows.forEach(function (r) { console.log('   ', r); });

                if (opts.verbose) {
                    // Open, not collapsed — asking for verbose means you want to
                    // read it, and a collapsed group hides it from a pasted log.
                    console.group('Day by day');
                    var perDate = {};
                    L.periods.forEach(function (p) { (perDate[p.date] = perDate[p.date] || []).push(p); });
                    Object.keys(perDate).sort().forEach(function (d) {
                        var lines = perDate[d].map(function (p) {
                            var bye = p.byes.map(function (b) { return b.team + (b.activity ? ' → ' + b.activity : ' (nothing)'); }).join(', ');
                            // Only name a REAL room — "@ Chinuch" is the
                            // placeholder for "no room configured".
                            var ch = p.chinuch.map(function (c) {
                                var room = A.resolveRoom(L.league, c.team, c.room);
                                return c.team + (room ? ' @ ' + room : '');
                            }).join(', ');
                            // On a period that produced a bye, list who was in
                            // the running — that is where a lopsided pool shows.
                            var pool = '';
                            if (p.byes.length) {
                                var cand = [], cs = {};
                                p.games.forEach(function (g) { [g.teamA, g.teamB].forEach(function (t) { if (!cs[norm(t)]) { cs[norm(t)] = 1; cand.push(t); } }); });
                                p.byes.forEach(function (b) { if (!cs[norm(b.team)]) { cs[norm(b.team)] = 1; cand.push(b.team); } });
                                pool = '  ·  in the draw: ' + cand.join(', ');
                            }
                            return '   ' + (p.label || 'period') + ': '
                                + p.games.length + ' game(s)'
                                + (bye ? '  ·  bye: ' + bye : '')
                                + (ch ? '  ·  chinuch: ' + ch : '')
                                + pool;
                        });
                        console.log(d + '\n' + lines.join('\n'));
                    });
                    console.groupEnd();
                }
            }

            L.findings.forEach(function (f) {
                console.log((ICON[f.level] || '•') + ' ' + f.message);
            });
            console.groupEnd();
        });

        var worst = data.leagues.some(function (L) { return L.verdict === 'FAIL'; }) ? 'FAIL'
            : data.leagues.some(function (L) { return L.verdict === 'WARN'; }) ? 'WARN' : 'PASS';
        console.log('%c' + (worst === 'PASS' ? '✅ Byes are evenly distributed.'
            : worst === 'WARN' ? '⚠️ Byes are even, but see the notes above.'
            : '❌ Byes are NOT evenly distributed — see the ❌ lines above.'),
            'font-weight:bold;');
        console.log('%cTip: byeAudit({ verbose: true }) for a day-by-day breakdown; the returned object has everything.',
            'color:#64748B;');
        return data;
    };

    // Accepts a league name string, an options object, or nothing.
    A.run = function (arg) {
        var opts = (typeof arg === 'string') ? { league: arg } : (arg || {});
        var data;
        try {
            data = A.build(opts);
        } catch (e) {
            console.error('[ByeAudit] failed to build the report:', e);
            return null;
        }
        return A.print(data, opts);
    };

    if (typeof window !== 'undefined') {
        window.LeagueByeAudit = A;
        window.byeAudit = A.run;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = A;
})();
