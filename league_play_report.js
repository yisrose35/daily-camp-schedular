/* =============================================================================
 * LEAGUE PLAY REPORT  (window.LeaguePlayReport)
 * -----------------------------------------------------------------------------
 * One shared "who played who, what, and when" builder + two renderers over the
 * scheduler's date-keyed league gameLog:
 *
 *   • Regular leagues   — leagueHistory.gameLog[leagueName][date]
 *                         entries { t1, t2, sport, g }        (g = game label)
 *   • Specialty leagues — specialtyLeagueHistory.gameLog[leagueId][date]
 *                         entries { tA, tB, field, g, s }     (sport = league.sport)
 *
 * Consumers:
 *   1. post_edit_field_change.js — renderMiniCard()/renderMiniBody(): a
 *      collapsible mini report inside the league post-edit modal (mirrors the
 *      bunk mini report in post_edit_system.js) so a matchup/sport change can
 *      be made with the full play history in view.
 *   2. leagues.js / specialty_leagues.js — renderFullView(): a "Play History"
 *      tab on the league detail pane.
 *
 * buildData() accepts an injected history object so the pure aggregation can be
 * unit-tested without a DOM (see tests/league_play_report.test.js).
 * ========================================================================== */
(function () {
    'use strict';

    var LPR = {};

    // ── utils ────────────────────────────────────────────────────────────────
    function norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }
    function esc(s) {
        if (typeof window !== 'undefined' && window.CampUtils && typeof window.CampUtils.escapeHtml === 'function') {
            return window.CampUtils.escapeHtml(s);
        }
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtDate(dateStr) {
        if (!dateStr) return '';
        try {
            var d = new Date(dateStr + 'T12:00:00');
            if (isNaN(d)) return dateStr;
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) { return dateStr; }
    }
    function editedDate() {
        // The date of the schedule actually loaded into the grid (stamped by the
        // unified loader), falling back to the global picker.
        return (typeof window !== 'undefined' &&
            (window._scheduleAssignmentsDate || window.currentScheduleDate)) || null;
    }

    // ── history access ───────────────────────────────────────────────────────
    // Prefer the engine's own loader (cloud/local fresher-wins logic lives
    // there); fall back to a direct read so the report still works if the
    // scheduler cores aren't loaded on the page.
    function loadRegularHistory() {
        try {
            var SCL = typeof window !== 'undefined' && window.SchedulerCoreLeagues;
            if (SCL && typeof SCL.getHistorySnapshot === 'function') return SCL.getHistorySnapshot() || {};
        } catch (e) { /* fall through */ }
        try {
            var gs = (typeof window !== 'undefined' && window.loadGlobalSettings) ? (window.loadGlobalSettings() || {}) : {};
            var cloud = (gs.leagueHistory && Object.keys(gs.leagueHistory).length > 0) ? gs.leagueHistory : null;
            var local = null;
            try {
                var raw = localStorage.getItem('campLeagueHistory_v2');
                if (raw) local = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            if (cloud && local) {
                return ((Number(local._savedAt) || 0) > (Number(cloud._savedAt) || 0)) ? local : cloud;
            }
            return cloud || local || {};
        } catch (e) { return {}; }
    }
    function loadSpecialtyHistory() {
        try {
            var SCS = typeof window !== 'undefined' && window.SchedulerCoreSpecialtyLeagues;
            if (SCS && typeof SCS.getHistorySnapshot === 'function') return SCS.getHistorySnapshot() || {};
        } catch (e) { /* fall through */ }
        try {
            var gs = (typeof window !== 'undefined' && window.loadGlobalSettings) ? (window.loadGlobalSettings() || {}) : {};
            if (gs.specialtyLeagueHistory && Object.keys(gs.specialtyLeagueHistory).length > 0) return gs.specialtyLeagueHistory;
            var raw = localStorage.getItem('campSpecialtyLeagueHistory_v1');
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) { return {}; }
    }

    // Resolve a league CONFIG from whatever the caller has: a config object, or
    // a league name (regular: leaguesByName; specialty: specialtyLeagues list).
    function resolveLeague(leagueOrName, kind) {
        if (leagueOrName && typeof leagueOrName === 'object') return leagueOrName;
        var name = String(leagueOrName || '');
        if (typeof window === 'undefined') return { name: name };
        if (kind === 'specialty') {
            var gs = window.loadGlobalSettings ? (window.loadGlobalSettings() || {}) : {};
            var list = window.specialtyLeagues || gs.specialtyLeagues || [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && norm(list[i].name) === norm(name)) return list[i];
            }
            return { name: name };
        }
        var byName = window.leaguesByName ||
            (window.loadGlobalSettings ? (window.loadGlobalSettings() || {}).leaguesByName : null) || {};
        if (byName[name]) return byName[name];
        var keys = Object.keys(byName);
        for (var k = 0; k < keys.length; k++) {
            if (norm(keys[k]) === norm(name)) return byName[keys[k]];
        }
        return { name: name };
    }

    // Case-insensitive key lookup into gameLog (league renames / id vs name).
    function logForLeague(gameLog, wantedKeys) {
        if (!gameLog) return null;
        for (var i = 0; i < wantedKeys.length; i++) {
            var w = wantedKeys[i];
            if (w == null || w === '') continue;
            if (gameLog[w]) return gameLog[w];
            var lw = norm(w);
            for (var k in gameLog) {
                if (Object.prototype.hasOwnProperty.call(gameLog, k) && norm(k) === lw) return gameLog[k];
            }
        }
        return null;
    }

    // ── DATA BUILDER (pure given historyOverride) ────────────────────────────
    // Returns {
    //   leagueName, kind, sports[], teams[], totalGames, dates[],       (dates desc)
    //   games[]  : { date, teamA, teamB, sport, label, field }          (date desc)
    //   byTeam{} : team → { total, sports{sport:n}, opponents{opp:n}, games[] }
    // }
    LPR.buildData = function (leagueOrName, kind, historyOverride) {
        kind = kind === 'specialty' ? 'specialty' : 'regular';
        var league = resolveLeague(leagueOrName, kind);
        var leagueName = league.name || String(leagueOrName || '');
        var history = historyOverride || (kind === 'specialty' ? loadSpecialtyHistory() : loadRegularHistory());
        var log = (kind === 'specialty')
            ? logForLeague(history.gameLog, [league.id, leagueName])
            : logForLeague(history.gameLog, [leagueName]);

        var games = [];
        var dates = Object.keys(log || {}).sort().reverse(); // newest first
        dates.forEach(function (date) {
            var entries = (log && log[date]) || [];
            entries.forEach(function (e) {
                if (!e) return;
                var tA = e.t1 != null ? e.t1 : e.tA;
                var tB = e.t2 != null ? e.t2 : e.tB;
                if (tA == null || tB == null) return;
                games.push({
                    date: date,
                    teamA: String(tA), teamB: String(tB),
                    sport: e.sport || (kind === 'specialty' ? (league.sport || '') : '') || '',
                    label: e.g || '',
                    field: e.field || ''
                });
            });
        });

        // Teams: configured list first (keeps roster order), then any name that
        // only appears in the log (renamed/removed teams stay visible).
        var teams = [];
        var seen = {};
        (league.teams || []).forEach(function (t) {
            if (t == null) return;
            var k = norm(t);
            if (!seen[k]) { seen[k] = 1; teams.push(String(t)); }
        });
        games.forEach(function (g) {
            [g.teamA, g.teamB].forEach(function (t) {
                var k = norm(t);
                if (!seen[k]) { seen[k] = 1; teams.push(t); }
            });
        });

        var byTeam = {};
        teams.forEach(function (t) { byTeam[t] = { total: 0, sports: {}, opponents: {}, games: [] }; });
        function teamKeyFor(name) {
            if (byTeam[name]) return name;
            var ln = norm(name);
            for (var i = 0; i < teams.length; i++) if (norm(teams[i]) === ln) return teams[i];
            return name;
        }
        var sportsSeen = {};
        games.forEach(function (g) {
            var a = teamKeyFor(g.teamA), b = teamKeyFor(g.teamB);
            [[a, b], [b, a]].forEach(function (pair) {
                var me = pair[0], opp = pair[1];
                var rec = byTeam[me];
                if (!rec) { rec = byTeam[me] = { total: 0, sports: {}, opponents: {}, games: [] }; }
                rec.total++;
                if (g.sport) rec.sports[g.sport] = (rec.sports[g.sport] || 0) + 1;
                rec.opponents[opp] = (rec.opponents[opp] || 0) + 1;
                rec.games.push(g);
            });
            if (g.sport) sportsSeen[g.sport] = 1;
        });

        // Sport columns: league-configured order first, then anything else seen.
        var sports = [];
        var spSeen = {};
        var cfgSports = Array.isArray(league.sports) ? league.sports : (league.sport ? [league.sport] : []);
        cfgSports.forEach(function (s) {
            if (!s) return;
            var k = norm(s);
            if (!spSeen[k]) { spSeen[k] = 1; sports.push(String(s)); }
        });
        Object.keys(sportsSeen).forEach(function (s) {
            var k = norm(s);
            if (!spSeen[k]) { spSeen[k] = 1; sports.push(s); }
        });

        var datesWithGames = [];
        var dSeen = {};
        games.forEach(function (g) { if (!dSeen[g.date]) { dSeen[g.date] = 1; datesWithGames.push(g.date); } });

        return {
            leagueName: leagueName, kind: kind,
            sports: sports, teams: teams,
            totalGames: games.length, dates: datesWithGames,
            games: games, byTeam: byTeam
        };
    };

    // Matchup counts (unordered pairs) for the full view: [{teamA, teamB, count}].
    LPR.matchupCounts = function (data) {
        var counts = {};
        data.games.forEach(function (g) {
            var pair = [g.teamA, g.teamB].sort(function (a, b) { return norm(a) < norm(b) ? -1 : 1; });
            var key = pair[0] + '|' + pair[1];
            if (!counts[key]) counts[key] = { teamA: pair[0], teamB: pair[1], count: 0 };
            counts[key].count++;
        });
        return Object.keys(counts).map(function (k) { return counts[k]; })
            .sort(function (a, b) { return (b.count - a.count) || a.teamA.localeCompare(b.teamA); });
    };

    // ── shared render bits ───────────────────────────────────────────────────
    function sectionTitle(t, badge) {
        return '<div style="display:flex;align-items:center;gap:6px;margin:14px 0 7px 0;">' +
            '<span style="font-weight:700;color:#6b7280;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;">' + esc(t) + '</span>' +
            (badge != null ? '<span style="background:#eef2ff;color:#4338ca;font-size:0.65rem;font-weight:700;border-radius:10px;padding:1px 7px;">' + badge + '</span>' : '') +
            '<span style="flex:1;height:1px;background:#f0f0f2;"></span></div>';
    }
    function emptyNote(t) {
        return '<div style="color:#9ca3af;font-size:0.75rem;font-style:italic;">' + esc(t) + '</div>';
    }
    function statPill(n, l, c) {
        return '<div style="flex:1;text-align:center;background:#f9fafb;border:1px solid #eef0f2;border-radius:8px;padding:7px 4px;">' +
            '<div style="font-size:1.05rem;font-weight:700;color:' + c + ';line-height:1.1;">' + n + '</div>' +
            '<div style="font-size:0.62rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.04em;margin-top:1px;">' + esc(l) + '</div></div>';
    }

    // Teams × sports count matrix. highlightSet: lowercased team names to tint.
    function sportMatrixHtml(data, highlightSet, compact) {
        if (!data.teams.length) return emptyNote('No teams configured.');
        var hasSports = data.sports.length > 0;
        var cellPad = compact ? '4px 8px' : '6px 10px';
        var fs = compact ? '0.74rem' : '0.82rem';
        var head = '<tr>' +
            '<th style="text-align:left;padding:' + cellPad + ';font-size:' + fs + ';color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;">Team</th>' +
            data.sports.map(function (s) {
                return '<th style="text-align:center;padding:' + cellPad + ';font-size:' + fs + ';color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;">' + esc(s) + '</th>';
            }).join('') +
            '<th style="text-align:center;padding:' + cellPad + ';font-size:' + fs + ';color:#374151;font-weight:700;border-bottom:1px solid #e5e7eb;">Total</th></tr>';
        var rows = data.teams.map(function (t) {
            var rec = data.byTeam[t] || { total: 0, sports: {} };
            var hl = highlightSet && highlightSet[norm(t)];
            var rowBg = hl ? 'background:#eef2ff;' : '';
            return '<tr style="' + rowBg + '">' +
                '<td style="text-align:left;padding:' + cellPad + ';font-size:' + fs + ';color:#111827;' + (hl ? 'font-weight:700;' : 'font-weight:500;') + 'border-bottom:1px solid #f3f4f6;white-space:nowrap;">' + esc(t) + '</td>' +
                data.sports.map(function (s) {
                    var n = rec.sports[s] || 0;
                    return '<td style="text-align:center;padding:' + cellPad + ';font-size:' + fs + ';border-bottom:1px solid #f3f4f6;color:' + (n ? '#111827' : '#d1d5db') + ';' + (n ? 'font-weight:600;' : '') + '">' + (n || '·') + '</td>';
                }).join('') +
                '<td style="text-align:center;padding:' + cellPad + ';font-size:' + fs + ';border-bottom:1px solid #f3f4f6;font-weight:700;color:#4338ca;">' + rec.total + '</td></tr>';
        }).join('');
        var note = hasSports ? '' : '<div style="font-size:0.7rem;color:#9ca3af;margin-top:4px;">No per-sport data recorded for this league yet — totals only.</div>';
        return '<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;min-width:0;">' +
            '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' + note;
    }

    // Date-grouped chronological game list ("when + who + what").
    // opts: { highlightSet, filterTeam, compact, maxHeight, todayDate }
    function gameLogHtml(data, opts) {
        opts = opts || {};
        var games = data.games;
        if (opts.filterTeam) {
            var ft = norm(opts.filterTeam);
            games = games.filter(function (g) { return norm(g.teamA) === ft || norm(g.teamB) === ft; });
        }
        if (!games.length) return emptyNote('No games recorded yet.');
        var byDate = {};
        var order = [];
        games.forEach(function (g) {
            if (!byDate[g.date]) { byDate[g.date] = []; order.push(g.date); }
            byDate[g.date].push(g);
        });
        var fs = opts.compact ? '0.76rem' : '0.84rem';
        var html = order.map(function (date) {
            var isToday = opts.todayDate && date === opts.todayDate;
            var dayHdr = '<div style="display:flex;align-items:center;gap:6px;margin:9px 0 4px 0;">' +
                '<span style="font-weight:700;color:' + (isToday ? '#4338ca' : '#374151') + ';font-size:0.72rem;">' + esc(fmtDate(date)) + '</span>' +
                (isToday ? '<span style="background:#eef2ff;color:#4338ca;font-size:0.6rem;font-weight:700;border-radius:8px;padding:1px 6px;">EDITING</span>' : '') +
                '<span style="flex:1;height:1px;background:#f3f4f6;"></span></div>';
            var rows = byDate[date].map(function (g) {
                var hl = opts.highlightSet && (opts.highlightSet[norm(g.teamA)] || opts.highlightSet[norm(g.teamB)]);
                var both = opts.highlightSet && opts.highlightSet[norm(g.teamA)] && opts.highlightSet[norm(g.teamB)];
                var bg = both ? 'background:#e0e7ff;' : (hl ? 'background:#eef2ff;' : '');
                var meta = [];
                if (g.sport) meta.push(esc(g.sport));
                if (g.field) meta.push('@ ' + esc(g.field));
                if (g.label && !opts.compact) meta.push(esc(g.label));
                return '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:3px 6px;border-radius:6px;' + bg + '">' +
                    '<span style="font-size:' + fs + ';color:#111827;' + (hl ? 'font-weight:600;' : '') + '">' + esc(g.teamA) + ' <span style="color:#9ca3af;font-weight:400;">vs</span> ' + esc(g.teamB) + '</span>' +
                    (meta.length ? '<span style="font-size:0.7rem;color:#6b7280;white-space:nowrap;">' + meta.join(' · ') + '</span>' : '') +
                    '</div>';
            }).join('');
            return dayHdr + rows;
        }).join('');
        var mh = opts.maxHeight || null;
        return mh ? '<div style="max-height:' + mh + ';overflow-y:auto;margin:0 -2px;padding:0 2px;">' + html + '</div>' : html;
    }

    // ── 1) MINI REPORT (post-edit modal) ─────────────────────────────────────
    // opts: { highlightTeams: [teamA, teamB] }  → tint the game being edited.
    LPR.renderMiniBody = function (leagueOrName, kind, opts) {
        try {
            opts = opts || {};
            var data = LPR.buildData(leagueOrName, kind);
            var hl = {};
            (opts.highlightTeams || []).forEach(function (t) { if (t) hl[norm(t)] = 1; });
            if (!data.totalGames && !data.teams.length) {
                return emptyNote('No play history recorded for this league yet.');
            }
            var stats = '<div style="display:flex;gap:8px;margin-bottom:6px;">' +
                statPill(data.totalGames, 'Games played', '#4338ca') +
                statPill(data.dates.length, 'Days', '#0f766e') +
                statPill(data.teams.length, 'Teams', '#b45309') +
                '</div>';
            return stats +
                sectionTitle('Times each team played each sport', data.totalGames || null) +
                (data.totalGames ? sportMatrixHtml(data, hl, true) : emptyNote('No games recorded yet.')) +
                sectionTitle('Who played who & when', data.totalGames || null) +
                gameLogHtml(data, { highlightSet: hl, compact: true, maxHeight: '190px', todayDate: editedDate() });
        } catch (e) {
            try { console.warn('[LeaguePlayReport] renderMiniBody error:', e); } catch (_) { /* noop */ }
            return '';
        }
    };

    // Collapsible card wrapper (same shell style as the bunk mini report).
    LPR.renderMiniCard = function (leagueOrName, kind, opts) {
        try {
            var league = resolveLeague(leagueOrName, kind);
            var name = league.name || String(leagueOrName || 'League');
            var body = LPR.renderMiniBody(leagueOrName, kind, opts);
            if (!body) return '';
            return '<details id="lpr-mini-report" open style="background:#fff;border:1px solid #e8eaed;border-radius:12px;padding:0;margin-bottom:14px;box-shadow:0 1px 3px rgba(16,24,40,0.05);overflow:hidden;">' +
                '<summary style="list-style:none;cursor:pointer;outline:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 13px;background:linear-gradient(180deg,#fafbff,#f4f6fb);border-bottom:1px solid #eef0f4;">' +
                '<span style="display:flex;align-items:center;gap:8px;">' +
                '<span style="width:26px;height:26px;border-radius:7px;background:#eef2ff;color:#4338ca;display:inline-flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:800;">' + esc((name || '?').trim().charAt(0).toUpperCase()) + '</span>' +
                '<span style="display:flex;flex-direction:column;line-height:1.15;">' +
                '<span style="font-weight:700;color:#111827;font-size:0.88rem;">' + esc(name) + '</span>' +
                '<span style="font-weight:500;color:#9ca3af;font-size:0.66rem;">League play report — who played what &amp; when</span>' +
                '</span></span>' +
                '<span style="width:8px;height:8px;border-right:2px solid #c4c7ce;border-bottom:2px solid #c4c7ce;transform:rotate(45deg);display:inline-block;margin-right:2px;"></span>' +
                '</summary>' +
                '<div id="lpr-mini-report-body" style="padding:10px 13px 12px;">' + body + '</div>' +
                '</details>';
        } catch (e) {
            try { console.warn('[LeaguePlayReport] renderMiniCard error:', e); } catch (_) { /* noop */ }
            return '';
        }
    };

    // Re-render just the mini card body in place (highlight follows the teams
    // currently selected in the edit modal).
    LPR.refreshMiniBody = function (leagueOrName, kind, opts) {
        var el = document.getElementById('lpr-mini-report-body');
        if (!el) return;
        el.innerHTML = LPR.renderMiniBody(leagueOrName, kind, opts);
    };

    // ── 2) FULL VIEW (league page "Play History" tab) ────────────────────────
    LPR.renderFullView = function (league, container, kind) {
        if (!container) return;
        container.innerHTML = '';
        var data;
        try { data = LPR.buildData(league, kind); }
        catch (e) {
            container.innerHTML = '<p style="color:#9CA3AF;font-size:0.85rem;">Could not load play history.</p>';
            try { console.warn('[LeaguePlayReport] renderFullView error:', e); } catch (_) { /* noop */ }
            return;
        }

        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:4px;';

        var intro = document.createElement('div');
        intro.style.cssText = 'font-size:0.8rem;color:#6B7280;margin-bottom:12px;';
        intro.textContent = 'Everything the scheduler has recorded for this league — how many times each team played each sport, and who played who on each day. Post-edit changes to matchups and sports are reflected here.';
        wrap.appendChild(intro);

        if (!data.totalGames) {
            var emptyBox = document.createElement('div');
            emptyBox.style.cssText = 'padding:32px 24px;text-align:center;background:#FAFAFA;border-radius:8px;border:1px solid #E5E7EB;';
            emptyBox.innerHTML = '<div style="font-weight:500;color:#374151;margin-bottom:4px;">No games recorded yet</div>' +
                '<div style="font-size:0.875rem;color:#6B7280;">Generate a schedule with this league and its games will appear here automatically.</div>';
            wrap.appendChild(emptyBox);
            container.appendChild(wrap);
            return;
        }

        // Stat strip
        var stats = document.createElement('div');
        stats.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;max-width:420px;';
        stats.innerHTML = statPill(data.totalGames, 'Games played', '#4338ca') +
            statPill(data.dates.length, 'Days', '#0f766e') +
            statPill(data.teams.length, 'Teams', '#b45309');
        wrap.appendChild(stats);

        // Team filter for the game log
        var state = { filterTeam: '' };

        // Section: sport balance matrix
        var matrixSec = document.createElement('div');
        matrixSec.innerHTML = sectionTitle('Times each team played each sport') + sportMatrixHtml(data, null, false);
        wrap.appendChild(matrixSec);

        // Section: matchup counts (who played who, how many times)
        var mc = LPR.matchupCounts(data);
        var mcSec = document.createElement('div');
        var chips = mc.map(function (m) {
            return '<span style="display:inline-flex;align-items:center;gap:5px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:20px;padding:3px 10px;font-size:0.75rem;color:#374151;margin:0 6px 6px 0;">' +
                esc(m.teamA) + ' <span style="color:#9ca3af;">vs</span> ' + esc(m.teamB) +
                '<span style="background:#eef2ff;color:#4338ca;font-weight:700;border-radius:10px;padding:0 6px;font-size:0.7rem;">×' + m.count + '</span></span>';
        }).join('');
        mcSec.innerHTML = sectionTitle('Matchup counts', mc.length) + '<div>' + chips + '</div>';
        wrap.appendChild(mcSec);

        // Section: game log with team filter
        var logSec = document.createElement('div');
        var logHead = document.createElement('div');
        logHead.innerHTML = sectionTitle('Game log — who played who, what & when', data.totalGames);
        logSec.appendChild(logHead);

        var filterRow = document.createElement('div');
        filterRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
        var filterLbl = document.createElement('span');
        filterLbl.style.cssText = 'font-size:0.78rem;color:#6B7280;';
        filterLbl.textContent = 'Show:';
        var filterSel = document.createElement('select');
        filterSel.style.cssText = 'padding:6px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:0.8rem;background:#fff;cursor:pointer;';
        var optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = 'All teams';
        filterSel.appendChild(optAll);
        data.teams.forEach(function (t) {
            var o = document.createElement('option');
            o.value = t;
            o.textContent = t;
            filterSel.appendChild(o);
        });
        filterRow.appendChild(filterLbl);
        filterRow.appendChild(filterSel);
        logSec.appendChild(filterRow);

        var logBody = document.createElement('div');
        function renderLog() {
            var hl = {};
            if (state.filterTeam) hl[norm(state.filterTeam)] = 1;
            logBody.innerHTML = gameLogHtml(data, {
                filterTeam: state.filterTeam || null,
                highlightSet: state.filterTeam ? hl : null,
                compact: false,
                todayDate: editedDate()
            });
        }
        filterSel.onchange = function () { state.filterTeam = filterSel.value; renderLog(); };
        renderLog();
        logSec.appendChild(logBody);
        wrap.appendChild(logSec);

        container.appendChild(wrap);
    };

    if (typeof window !== 'undefined') window.LeaguePlayReport = LPR;
    // CommonJS export for unit tests (pure buildData/matchupCounts).
    if (typeof module !== 'undefined' && module.exports) module.exports = LPR;
})();
