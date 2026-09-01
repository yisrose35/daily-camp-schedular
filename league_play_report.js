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
    // Unordered-pair summary for a matchup: how often these two met and the
    // most recent meeting. `dataOpt` lets callers reuse an already-built data.
    LPR.pairSummary = function (leagueOrName, kind, teamA, teamB, dataOpt) {
        var data = dataOpt || LPR.buildData(leagueOrName, kind);
        var a = norm(teamA), b = norm(teamB);
        var met = data.games.filter(function (g) {
            var gA = norm(g.teamA), gB = norm(g.teamB);
            return (gA === a && gB === b) || (gA === b && gB === a);
        });
        return { count: met.length, last: met[0] || null }; // games are date-desc
    };

    // One-line matchup annotation ("First meeting" / "Played 2× · last Jul 6").
    LPR.pairNoteHtml = function (leagueOrName, kind, teamA, teamB, dataOpt) {
        try {
            var s = LPR.pairSummary(leagueOrName, kind, teamA, teamB, dataOpt);
            if (!s.count) {
                return '<span style="color:#15803d;">First meeting</span>';
            }
            var when = s.last ? fmtDate(s.last.date) : '';
            var sport = s.last && s.last.sport ? ' (' + esc(s.last.sport) + ')' : '';
            return '<span style="color:#4338ca;">Played ' + s.count + '×</span>' +
                (when ? '<span style="color:#9ca3af;"> · last ' + esc(when) + sport + '</span>' : '');
        } catch (e) { return ''; }
    };

    function noteHtml(bg, bd, fg, txt) {
        return '<div style="display:flex;gap:7px;align-items:flex-start;background:' + bg + ';border:1px solid ' + bd + ';color:' + fg + ';border-radius:8px;padding:7px 10px;font-size:0.78rem;line-height:1.35;margin-bottom:7px;">' +
            '<span style="width:6px;height:6px;border-radius:50%;background:' + fg + ';margin-top:6px;flex:0 0 auto;"></span><span>' + txt + '</span></div>';
    }

    // Compact body: answers "have these two met?", "how does this sport sit
    // with each team?", one line per team — full matrix/log behind a collapsed
    // toggle so the modal stays light.
    // opts: { highlightTeams: [teamA, teamB], selectedSport }
    LPR.renderMiniBody = function (leagueOrName, kind, opts) {
        try {
            opts = opts || {};
            var data = LPR.buildData(leagueOrName, kind);
            if (!data.totalGames) {
                return emptyNote('No league games recorded yet.');
            }
            var pick = (opts.highlightTeams || []).filter(Boolean);
            var teamA = pick[0] || null, teamB = pick[1] || null;
            // Resolve into the data's canonical team spelling.
            function canon(t) {
                if (!t) return null;
                var lt = norm(t);
                for (var i = 0; i < data.teams.length; i++) if (norm(data.teams[i]) === lt) return data.teams[i];
                return t;
            }
            teamA = canon(teamA); teamB = canon(teamB);
            var hl = {};
            [teamA, teamB].forEach(function (t) { if (t) hl[norm(t)] = 1; });

            var html = '';

            // Note 1 — this matchup.
            if (teamA && teamB) {
                var ps = LPR.pairSummary(null, kind, teamA, teamB, data);
                if (!ps.count) {
                    html += noteHtml('#f0fdf4', '#bbf7d0', '#15803d',
                        'First meeting — <b>' + esc(teamA) + '</b> and <b>' + esc(teamB) + '</b> haven’t played each other yet.');
                } else {
                    var lastBits = ps.last ? (esc(fmtDate(ps.last.date)) + (ps.last.sport ? ' · ' + esc(ps.last.sport) : '')) : '';
                    html += noteHtml('#eff6ff', '#bfdbfe', '#1d4ed8',
                        '<b>' + esc(teamA) + '</b> vs <b>' + esc(teamB) + '</b>: played ' + ps.count + '× before' +
                        (lastBits ? ' (last ' + lastBits + ')' : '') + '.');
                }
            }

            // Note 2 — the selected sport vs each team's history.
            var sport = (opts.selectedSport || '').trim();
            if (sport && teamA && teamB) {
                function sportCount(t) {
                    var rec = data.byTeam[t];
                    if (!rec) return 0;
                    for (var s in rec.sports) if (norm(s) === norm(sport)) return rec.sports[s];
                    return 0;
                }
                var cA = sportCount(teamA), cB = sportCount(teamB);
                if (!cA && !cB) {
                    html += noteHtml('#f0fdf4', '#bbf7d0', '#15803d', '<b>' + esc(sport) + '</b> is new for both teams.');
                } else {
                    html += noteHtml('#fffbeb', '#fde68a', '#b45309',
                        '<b>' + esc(sport) + '</b>: ' + esc(teamA) + ' played ' + cA + '×, ' + esc(teamB) + ' ' + cB + '×.');
                }
            }

            // One compact line per team: total + top sports.
            function teamLine(t) {
                var rec = data.byTeam[t] || { total: 0, sports: {} };
                var parts = Object.keys(rec.sports)
                    .sort(function (a, b) { return rec.sports[b] - rec.sports[a] || a.localeCompare(b); })
                    .slice(0, 3)
                    .map(function (s) { return esc(s) + ' ×' + rec.sports[s]; });
                var more = Object.keys(rec.sports).length - 3;
                if (more > 0) parts.push('+' + more + ' more');
                return '<div style="display:flex;align-items:baseline;gap:6px;padding:2px 0;font-size:0.78rem;">' +
                    '<span style="font-weight:700;color:#111827;white-space:nowrap;">' + esc(t) + '</span>' +
                    '<span style="color:#6b7280;">' + rec.total + ' game' + (rec.total === 1 ? '' : 's') +
                    (parts.length ? ' · ' + parts.join(', ') : '') + '</span></div>';
            }
            if (teamA) html += teamLine(teamA);
            if (teamB) html += teamLine(teamB);

            // Full detail — collapsed by default.
            html += '<details style="margin-top:7px;">' +
                '<summary style="cursor:pointer;font-size:0.72rem;font-weight:600;color:#6366f1;outline:none;">Full history — all ' + data.teams.length + ' teams, ' + data.totalGames + ' games</summary>' +
                '<div style="margin-top:6px;">' +
                sportMatrixHtml(data, hl, true) +
                sectionTitle('Who played who & when', data.totalGames) +
                gameLogHtml(data, { highlightSet: hl, compact: true, maxHeight: '170px', todayDate: editedDate() }) +
                '</div></details>';
            return html;
        } catch (e) {
            try { console.warn('[LeaguePlayReport] renderMiniBody error:', e); } catch (_) { /* noop */ }
            return '';
        }
    };

    // Slim wrapper — a light box, not a full card, so the modal stays compact.
    LPR.renderMiniCard = function (leagueOrName, kind, opts) {
        try {
            var body = LPR.renderMiniBody(leagueOrName, kind, opts);
            if (!body) return '';
            return '<div style="background:#fafbff;border:1px solid #e8eaed;border-radius:10px;padding:9px 11px;margin-bottom:14px;">' +
                '<div id="lpr-mini-report-body">' + body + '</div>' +
                '</div>';
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
        intro.textContent = 'Who played who, what, and when — straight from the scheduler (post-edits included).';
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

        // Collapsible section shell — keeps the tab scannable: the game log is
        // the headline, the aggregate tables open on demand.
        function collapsible(title, badge, innerHtml, open) {
            var d = document.createElement('details');
            if (open) d.open = true;
            d.style.cssText = 'margin-bottom:10px;border:1px solid #F3F4F6;border-radius:8px;padding:8px 12px;background:#fff;';
            d.innerHTML = '<summary style="cursor:pointer;outline:none;font-weight:700;color:#6b7280;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;">' +
                esc(title) +
                (badge != null ? ' <span style="background:#eef2ff;color:#4338ca;font-size:0.65rem;font-weight:700;border-radius:10px;padding:1px 7px;text-transform:none;letter-spacing:0;">' + badge + '</span>' : '') +
                '</summary><div style="margin-top:8px;">' + innerHtml + '</div>';
            return d;
        }

        // Section: sport balance matrix (collapsed by default)
        wrap.appendChild(collapsible('Times each team played each sport', null, sportMatrixHtml(data, null, false), false));

        // Section: matchup counts (collapsed by default)
        var mc = LPR.matchupCounts(data);
        var chips = mc.map(function (m) {
            return '<span style="display:inline-flex;align-items:center;gap:5px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:20px;padding:3px 10px;font-size:0.75rem;color:#374151;margin:0 6px 6px 0;">' +
                esc(m.teamA) + ' <span style="color:#9ca3af;">vs</span> ' + esc(m.teamB) +
                '<span style="background:#eef2ff;color:#4338ca;font-weight:700;border-radius:10px;padding:0 6px;font-size:0.7rem;">×' + m.count + '</span></span>';
        }).join('');
        wrap.appendChild(collapsible('Matchup counts — who played who', mc.length, '<div>' + chips + '</div>', false));

        // Section: game log with team filter (the headline — always open)
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
