// =============================================================================
// campistry_live_locator.js — Camper Locator + read-only full-day schedule for
// Campistry Live.
//
// Ports the search/render algorithm from camper_locator.js (Flow) almost
// unchanged — that logic (time parsing, per-bunk time-window matching, league
// matchup resolution across manual/auto builder shapes) is genuinely
// portable. What's NOT portable is where it reads from: Flow's copy reads
// live `window.scheduleAssignments` / `window.divisionTimes` /
// `window.leagueAssignments` / `window.divisions`, all populated by
// Flow-only hydration scripts Live never loads. This version takes the same
// data as a plain object from campistry_live_schedule_reader.js instead.
// =============================================================================
(function () {
    'use strict';

    var GLOBAL_KEY = 'campGlobalSettings_v1';
    function readGlobal() { try { return JSON.parse(localStorage.getItem(GLOBAL_KEY) || '{}'); } catch (e) { return {}; } }
    function getRoster() { var g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
    function getStructure() { return readGlobal().campStructure || {}; }
    function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    var _schedule = null; // result of LiveScheduleReader.loadToday()
    var _loading = false;

    // =============================================================
    // Ported from camper_locator.js — matchup/time-parsing helpers
    // (pure functions, no window.* reads)
    // =============================================================
    function normalizeMatchup(m) {
        if (typeof m === 'string') {
            var raw = m, teamA = '', teamB = '', field = '', sport = '';
            var atParts = m.split(' @ ');
            var teamsPart = atParts[0] || '', fieldPart = atParts[1] || '';
            var vsParts = teamsPart.split(/\s+vs\s+/i);
            teamA = (vsParts[0] || '').trim(); teamB = (vsParts[1] || '').trim();
            var dashParts = teamB.split(/\s+[—–-]\s+/);
            if (dashParts.length > 1) { teamB = dashParts[0].trim(); sport = dashParts[1].trim(); }
            if (fieldPart) {
                var parenMatch = fieldPart.match(/^(.+?)\s*\((.+?)\)\s*$/);
                if (parenMatch) { field = parenMatch[1].trim(); sport = sport || parenMatch[2].trim(); }
                else { field = fieldPart.trim(); }
            }
            return { teamA: teamA, teamB: teamB, field: field, sport: sport, raw: raw };
        } else if (m && typeof m === 'object') {
            return {
                teamA: m.teamA || m.team1 || '', teamB: m.teamB || m.team2 || '',
                field: m.field || '', sport: m.sport || '',
                raw: m.display || ((m.teamA || m.team1 || '?') + ' vs ' + (m.teamB || m.team2 || '?'))
            };
        }
        return { teamA: '', teamB: '', field: '', sport: '', raw: String(m) };
    }

    function findTeamMatchup(leagueData, team) {
        if (!leagueData || !leagueData.matchups || !team) return null;
        var teamStr = String(team).toLowerCase().trim();
        for (var i = 0; i < leagueData.matchups.length; i++) {
            var norm = normalizeMatchup(leagueData.matchups[i]);
            var tA = norm.teamA.toLowerCase().trim(), tB = norm.teamB.toLowerCase().trim();
            if (tA === teamStr || tB === teamStr) return norm;
            if (tA.indexOf(teamStr) >= 0 || tB.indexOf(teamStr) >= 0 || teamStr.indexOf(tA) >= 0 || teamStr.indexOf(tB) >= 0) return norm;
        }
        return null;
    }

    function buildAllMatchupsHtml(leagueData) {
        if (!leagueData || !leagueData.matchups || !leagueData.matchups.length) return '';
        return '<div style="margin-top:8px;">' + leagueData.matchups.map(function (m) {
            var norm = normalizeMatchup(m);
            return '<div style="padding:3px 0;">' + esc(norm.teamA) + ' vs ' + esc(norm.teamB) +
                (norm.sport || norm.field ? ' - ' : '') +
                (norm.sport ? '<strong>' + esc(norm.sport.charAt(0).toUpperCase() + norm.sport.slice(1)) + '</strong>' : '') +
                (norm.field ? ' (' + esc(norm.field) + ')' : '') + '</div>';
        }).join('') + '</div>';
    }

    function isLeagueAssignment(a) {
        if (!a) return false;
        return !!(a._h2h || a._league || String(a.field || '').toLowerCase().indexOf('league') >= 0);
    }

    function leagueDataFromAssignment(a) {
        if (!a) return null;
        var matchups = a._allMatchups || a.matchups || null;
        if (!matchups && !a._gameLabel && !a._leagueName) return null;
        return { matchups: matchups || [], gameLabel: a._gameLabel || null, sport: a.sport || null, leagueName: a._leagueName || null };
    }

    function resolveLeagueData(division, slotIdx, targetTimeMin) {
        var la = (_schedule.leagueAssignments || {})[division];
        if (!la) return null;
        var divSlots = (_schedule.divisionTimes || {})[division] || [];
        if (slotIdx >= 0 && la[slotIdx]) return la[slotIdx];
        if (slotIdx >= 0 && divSlots[slotIdx]) {
            var sm = divSlots[slotIdx].startMin;
            if (la[sm] != null) return la[sm];
        }
        var keys = Object.keys(la);
        for (var i = 0; i < keys.length; i++) {
            var keyNum = Number(keys[i]);
            if (isNaN(keyNum)) continue;
            var winStart = null, winEnd = null;
            var byStart = divSlots.filter(function (s) { return s.startMin === keyNum; })[0];
            if (byStart) { winStart = byStart.startMin; winEnd = byStart.endMin; }
            else if (divSlots[keyNum]) { winStart = divSlots[keyNum].startMin; winEnd = divSlots[keyNum].endMin; }
            if (winStart == null) continue;
            if (winStart <= targetTimeMin && targetTimeMin < winEnd) return la[keys[i]];
        }
        return null;
    }

    function getEffectiveLeagueData(division, slotIdx, targetTimeMin, assignment) {
        var fromTable = resolveLeagueData(division, slotIdx, targetTimeMin);
        var fromEntry = leagueDataFromAssignment(assignment);
        var primary = (fromTable && fromTable.matchups && fromTable.matchups.length) ? fromTable
            : ((fromEntry && fromEntry.matchups && fromEntry.matchups.length) ? fromEntry : (fromTable || fromEntry));
        if (!primary) return null;
        return {
            matchups: primary.matchups || [],
            gameLabel: primary.gameLabel || (fromEntry && fromEntry.gameLabel) || (fromTable && fromTable.gameLabel) || null,
            sport: primary.sport || (fromEntry && fromEntry.sport) || (fromTable && fromTable.sport) || null,
            leagueName: primary.leagueName || (fromEntry && fromEntry.leagueName) || (fromTable && fromTable.leagueName) || null
        };
    }

    function resolveCamperTeam(camper, leagueName) {
        if (!camper) return '';
        var teams = (camper.teams && typeof camper.teams === 'object') ? camper.teams : null;
        if (leagueName && teams) {
            if (teams[leagueName]) return teams[leagueName];
            var lnLow = String(leagueName).toLowerCase().trim();
            for (var lg in teams) { if (teams[lg] && String(lg).toLowerCase().trim() === lnLow) return teams[lg]; }
        }
        if (camper.team) return camper.team;
        if (teams) { var vals = Object.keys(teams).map(function (k) { return teams[k]; }).filter(Boolean); if (vals.length) return vals[0]; }
        return '';
    }

    function getCurrentTimeMinutes() { var now = new Date(); return now.getHours() * 60 + now.getMinutes(); }

    function getDivisionSlotLabel(division, slotIdx) {
        var divSlots = (_schedule.divisionTimes || {})[division] || [];
        var slot = divSlots[slotIdx];
        if (!slot) return 'Unknown Time';
        return slot.label || (minutesToTimeLabel(slot.startMin) + ' - ' + minutesToTimeLabel(slot.endMin));
    }

    function minutesToTimeLabel(mins) {
        if (mins == null) return '??';
        var h = Math.floor(mins / 60), m = mins % 60;
        var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
        return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
    }

    function parseTypedTime(str) {
        if (!str) return -1;
        str = str.trim().toUpperCase();
        var isPM = false, isAM = false;
        if (str.indexOf('PM') >= 0 || str.indexOf('P.M') >= 0) { isPM = true; str = str.replace(/\s*(PM|P\.M\.?)/, ''); }
        if (str.indexOf('AM') >= 0 || str.indexOf('A.M') >= 0) { isAM = true; str = str.replace(/\s*(AM|A\.M\.?)/, ''); }
        str = str.trim();
        var hours = 0, minutes = 0;
        if (str.indexOf(':') >= 0) {
            var parts = str.split(':');
            hours = parseInt(parts[0], 10); minutes = parseInt(parts[1], 10) || 0;
        } else {
            var num = parseInt(str, 10);
            if (isNaN(num)) return -1;
            if (num <= 12) { hours = num; minutes = 0; }
            else if (num <= 2359) { hours = Math.floor(num / 100); minutes = num % 100; }
            else return -1;
        }
        if (isNaN(hours) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
        if (isPM && hours < 12) hours += 12;
        if (isAM && hours === 12) hours = 0;
        if (!isPM && !isAM && hours >= 1 && hours <= 6) hours += 12;
        return hours * 60 + minutes;
    }

    // Bunk -> division, sourced from Live's own camp structure (not
    // window.divisions, which only Flow populates).
    function bunkToDivision(bunk) {
        return (_schedule && _schedule.bunkToDivision && _schedule.bunkToDivision[String(bunk)]) || null;
    }

    // =============================================================
    // SEARCH
    // =============================================================
    var resultContainer = null, suggestionsBox = null, searchInput = null;

    function showSuggestions(query, box, input) {
        var roster = getRoster();
        if (!query || query.length < 2) { box.style.display = 'none'; return; }
        var q = query.toLowerCase();
        var matches = Object.keys(roster).filter(function (n) { return n.toLowerCase().indexOf(q) >= 0; });
        if (!matches.length) { box.style.display = 'none'; return; }
        box.innerHTML = matches.slice(0, 15).map(function (name) {
            return '<div class="suggestion-item" data-name="' + esc(name) + '" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid #eee;">' + esc(name) + ' <span style="color:#888;font-size:.85rem;">(' + esc(roster[name].bunk) + ')</span></div>';
        }).join('');
        box.style.display = 'block';
        box.querySelectorAll('.suggestion-item').forEach(function (div) {
            div.onclick = function () {
                input.value = div.getAttribute('data-name');
                box.style.display = 'none';
                performSearch(input.value, document.getElementById('loc-time-input').value.trim() || 'now');
            };
        });
    }

    function performSearch(nameQuery, timeValue) {
        if (!nameQuery || !resultContainer) return;
        var roster = getRoster();
        var keys = Object.keys(roster);
        var q = nameQuery.toLowerCase();
        var exact = keys.filter(function (k) { return k.toLowerCase() === q; })[0];
        var partial = keys.filter(function (k) { return k.toLowerCase().indexOf(q) >= 0; })[0];
        var camperName = exact || partial;

        resultContainer.style.display = 'block';
        if (!camperName) {
            resultContainer.replaceChildren();
            var h3 = document.createElement('h3'); h3.style.cssText = 'color:red;margin:0;';
            h3.textContent = 'Camper "' + nameQuery + '" not found.';
            var p = document.createElement('p'); p.append('Make sure the camper has been added in ');
            var strong = document.createElement('strong'); strong.textContent = 'Campistry Me';
            p.append(strong, '.'); resultContainer.append(h3, p);
            return;
        }

        var camper = roster[camperName];
        var bunk = camper.bunk;
        var division = bunkToDivision(bunk) || camper.division;

        var targetTimeMin, timeLabel;
        if (timeValue === 'now' || timeValue === '') {
            targetTimeMin = getCurrentTimeMinutes();
            timeLabel = 'Right Now (' + minutesToTimeLabel(targetTimeMin) + ')';
        } else {
            targetTimeMin = parseTypedTime(timeValue);
            if (targetTimeMin < 0) {
                resultContainer.innerHTML = '<h3 style="color:red;margin:0;">Couldn\'t understand "' + esc(timeValue) + '"</h3><p>Try a format like <strong>10:30 AM</strong> or <strong>2:15 PM</strong>.</p>';
                return;
            }
            timeLabel = minutesToTimeLabel(targetTimeMin);
        }

        var slotIdx = -1, slotTimeLabel = '', assignment = null;
        var bunkAssignments = (_schedule.scheduleAssignments || {})[bunk];
        var divSlots = (_schedule.divisionTimes || {})[division] || [];

        if (bunkAssignments) {
            for (var i = 0; i < bunkAssignments.length; i++) {
                var a = bunkAssignments[i];
                if (!a || a.continuation) continue;
                var aStart = a._startMin != null ? a._startMin : a._blockStart;
                var aEnd = a._endMin;
                if (aStart != null && aEnd != null && aStart <= targetTimeMin && targetTimeMin < aEnd) {
                    assignment = a; slotIdx = i;
                    slotTimeLabel = minutesToTimeLabel(aStart) + ' - ' + minutesToTimeLabel(aEnd);
                    break;
                }
            }
            if (slotIdx < 0 && divSlots.length > 0) {
                for (var j = 0; j < divSlots.length; j++) {
                    var ds = divSlots[j];
                    if (ds.startMin <= targetTimeMin && targetTimeMin < ds.endMin) {
                        slotIdx = j; assignment = bunkAssignments[j] || null;
                        slotTimeLabel = getDivisionSlotLabel(division, j);
                        break;
                    }
                }
            }
            if (assignment && assignment.continuation && slotIdx >= 0) {
                for (var k = slotIdx - 1; k >= 0; k--) {
                    var a2 = bunkAssignments[k];
                    if (a2 && !a2.continuation) { assignment = a2; slotIdx = k; break; }
                }
            }
        }

        resultContainer.style.display = 'block';
        var locationHtml = '', detailsHtml = '';
        var timeContext = slotTimeLabel ? '<div style="font-size:.8rem;color:#0284c7;margin-top:2px;">' + esc(slotTimeLabel) + '</div>' : '';

        if (!assignment) {
            var isOutsideSchedule = false;
            if (divSlots.length > 0) {
                var scheduleStart = divSlots[0].startMin, scheduleEnd = divSlots[divSlots.length - 1].endMin;
                if (targetTimeMin < scheduleStart || targetTimeMin >= scheduleEnd) isOutsideSchedule = true;
            }
            if (isOutsideSchedule) {
                locationHtml = '<span style="color:#999;">Outside Schedule Hours</span>';
                detailsHtml = esc(division) + '\'s schedule runs from <strong>' + esc(minutesToTimeLabel(divSlots[0].startMin)) + '</strong> to <strong>' + esc(minutesToTimeLabel(divSlots[divSlots.length - 1].endMin)) + '</strong>.';
            } else if (divSlots.length === 0) {
                locationHtml = '<span style="color:#999;">No Schedule Generated</span>';
                detailsHtml = 'No schedule has been generated yet for this division.';
            } else {
                var leagueData = resolveLeagueData(division, slotIdx, targetTimeMin);
                if (leagueData) {
                    var leagueName = leagueData.leagueName;
                    var team = resolveCamperTeam(camper, leagueName);
                    if (!team) {
                        locationHtml = '<span style="color:#d97706;font-weight:bold;font-size:1.4rem;">Leagues</span>';
                        detailsHtml = esc(bunk) + ' is playing leagues at this time.<br><strong>' + esc(camperName) + '</strong> has no team assigned yet.';
                    } else {
                        var match = findTeamMatchup(leagueData, team);
                        if (match) {
                            locationHtml = '<span style="color:#059669;font-weight:bold;font-size:1.4rem;">' + esc(match.field) + ' - ' + esc(match.sport || leagueData.sport || 'League') + '</span>';
                            detailsHtml = 'Team ' + esc(team);
                        } else {
                            locationHtml = '<span style="color:#d97706;font-weight:bold;font-size:1.4rem;">Leagues</span>';
                            detailsHtml = '<strong>' + esc(leagueData.gameLabel || 'League Game') + '</strong> — Team <strong>' + esc(team) + '</strong> not found in matchups.' + buildAllMatchupsHtml(leagueData);
                        }
                    }
                } else if (slotIdx < 0) {
                    locationHtml = '<span style="color:#999;">Outside Schedule Hours</span>';
                    detailsHtml = 'The selected time (' + esc(minutesToTimeLabel(targetTimeMin)) + ') is outside ' + esc(division) + '\'s scheduled hours.';
                } else {
                    locationHtml = '<span style="color:#999;">No Activity Assigned</span>';
                    detailsHtml = esc(bunk) + ' does not have an activity assigned at this time — may be a gap in the schedule.';
                }
            }
        } else if (isLeagueAssignment(assignment)) {
            var effectiveLeagueData = getEffectiveLeagueData(division, slotIdx, targetTimeMin, assignment);
            var lgName = (effectiveLeagueData && effectiveLeagueData.leagueName) || assignment._leagueName;
            var teamB2 = resolveCamperTeam(camper, lgName);
            if (!teamB2) {
                locationHtml = '<span style="color:#d97706;">Playing Leagues (Team Unknown)</span>';
                detailsHtml = 'We know ' + esc(bunk) + ' is playing leagues, but <strong>' + esc(camperName) + '</strong> has no team assigned.';
            } else {
                var match2 = findTeamMatchup(effectiveLeagueData, teamB2);
                if (match2) {
                    locationHtml = '<span style="color:#059669;font-weight:bold;font-size:1.4rem;">' + esc(match2.field) + ' - ' + esc(match2.sport || (effectiveLeagueData && effectiveLeagueData.sport) || 'League') + '</span>';
                    detailsHtml = 'Team ' + esc(teamB2);
                } else {
                    locationHtml = '<span style="color:#d97706;font-weight:bold;font-size:1.4rem;">Leagues</span>';
                    detailsHtml = '<strong>' + esc((effectiveLeagueData && effectiveLeagueData.gameLabel) || 'League Game') + '</strong> — Team <strong>' + esc(teamB2) + '</strong> not found in matchups.' + buildAllMatchupsHtml(effectiveLeagueData);
                }
            }
        } else {
            var activityName = assignment._displayName || assignment.sport || assignment._activity || 'Activity';
            var fieldName = (typeof assignment.field === 'object') ? assignment.field.name : assignment.field;
            locationHtml = '<span style="color:#0284c7;font-weight:bold;font-size:1.4rem;">' + esc(fieldName) + '</span>';
            detailsHtml = 'Activity: <strong>' + esc(activityName) + '</strong>';
        }

        resultContainer.innerHTML =
            '<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">' +
            '<div><h2 style="margin:0;color:#333;">' + esc(camperName) + '</h2>' +
            '<p style="margin:0;color:#666;">' + esc(camper.division) + (division !== camper.division ? ' &bull; ' + esc(division) : '') + ' &bull; ' + esc(camper.bunk) + '</p></div>' +
            '<div style="margin-left:auto;text-align:right;">' +
            '<div style="font-size:.9rem;color:#888;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">' + esc(timeLabel) + '</div>' +
            timeContext + locationHtml + '</div></div>' +
            '<div style="margin-top:15px;padding-top:15px;border-top:1px solid #eee;color:#555;">' + detailsHtml + '</div>';
    }

    // =============================================================
    // READ-ONLY FULL-DAY SCHEDULE GRID (filterable by division/grade/bunk)
    // =============================================================
    function structureOptions() {
        var struct = getStructure();
        var divisions = Object.keys(struct);
        var grades = {}, bunkGrade = {}, bunkDiv = {};
        divisions.forEach(function (divName) {
            var gradeMap = (struct[divName] || {}).grades || {};
            Object.keys(gradeMap).forEach(function (gradeName) {
                grades[gradeName] = true;
                (gradeMap[gradeName].bunks || []).forEach(function (b) {
                    bunkGrade[String(b)] = gradeName;
                    bunkDiv[String(b)] = divName;
                });
            });
        });
        return { divisions: divisions, grades: Object.keys(grades), bunkGrade: bunkGrade, bunkDiv: bunkDiv };
    }

    function renderScheduleGrid() {
        var body = document.getElementById('locScheduleBody');
        if (!body) return;
        var opts = structureOptions();
        var divFilter = (document.getElementById('locFilterDiv') || {}).value || '';
        var gradeFilter = (document.getElementById('locFilterGrade') || {}).value || '';
        var bunkFilter = (document.getElementById('locFilterBunk') || {}).value || '';

        var bunks = Object.keys(opts.bunkDiv).filter(function (b) {
            if (divFilter && opts.bunkDiv[b] !== divFilter) return false;
            if (gradeFilter && opts.bunkGrade[b] !== gradeFilter) return false;
            if (bunkFilter && b !== bunkFilter) return false;
            return true;
        }).sort();

        if (!bunks.length) { body.innerHTML = '<div class="empty-state">No bunks match this filter, or no schedule has been generated for today.</div>'; return; }
        if (!_schedule || !Object.keys(_schedule.scheduleAssignments || {}).length) { body.innerHTML = '<div class="empty-state">No schedule generated for today yet.</div>'; return; }

        var html = '';
        bunks.forEach(function (bunk) {
            var entries = (_schedule.scheduleAssignments || {})[bunk] || [];
            var rows = entries.filter(function (a) { return a && !a.continuation && (a._startMin != null); })
                .sort(function (a, b) { return a._startMin - b._startMin; });
            if (!rows.length) return;
            html += '<div class="card" style="margin-bottom:12px;"><div class="card-header"><h2 style="font-size:.95rem;">' + esc(bunk) + '<span style="font-weight:400;color:var(--slate-400);font-size:.78rem;"> — ' + esc(opts.bunkDiv[bunk] || '') + '</span></h2></div><div class="card-body" style="padding:0 16px;">';
            rows.forEach(function (a) {
                var isLg = isLeagueAssignment(a);
                var name = isLg ? (a._gameLabel || 'League') : (a._displayName || a.sport || a._activity || 'Activity');
                var field = (typeof a.field === 'object') ? (a.field && a.field.name) : a.field;
                html += '<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--slate-100);font-size:.82rem;">' +
                    '<span style="color:var(--slate-500);flex-shrink:0;width:130px;">' + esc(minutesToTimeLabel(a._startMin)) + ' – ' + esc(minutesToTimeLabel(a._endMin)) + '</span>' +
                    '<span style="flex:1;">' + esc(name) + '</span>' +
                    '<span style="color:var(--slate-500);">' + esc(field || '') + '</span>' +
                    '</div>';
            });
            html += '</div></div>';
        });
        body.innerHTML = html || '<div class="empty-state">No activities found for this filter today.</div>';
    }

    function renderFilters() {
        var opts = structureOptions();
        var divSel = document.getElementById('locFilterDiv');
        var gradeSel = document.getElementById('locFilterGrade');
        var bunkSel = document.getElementById('locFilterBunk');
        if (divSel) divSel.innerHTML = '<option value="">All divisions</option>' + opts.divisions.map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + '</option>'; }).join('');
        if (gradeSel) gradeSel.innerHTML = '<option value="">All grades</option>' + opts.grades.map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join('');
        if (bunkSel) bunkSel.innerHTML = '<option value="">All bunks</option>' + Object.keys(opts.bunkDiv).sort().map(function (b) { return '<option value="' + esc(b) + '">' + esc(b) + '</option>'; }).join('');
    }

    // =============================================================
    // PAGE INIT
    // =============================================================
    function init() {
        var container = document.getElementById('page-camper-locator');
        if (!container) return;

        resultContainer = document.getElementById('loc-result-display');
        searchInput = document.getElementById('loc-search-input');
        suggestionsBox = document.getElementById('loc-search-suggestions');
        var timeInput = document.getElementById('loc-time-input');
        var nowBtn = document.getElementById('loc-now-btn');
        var searchBtn = document.getElementById('loc-search-btn');

        if (searchBtn) searchBtn.onclick = function () { performSearch(searchInput.value, timeInput.value.trim() || 'now'); };
        if (nowBtn) nowBtn.onclick = function () { timeInput.value = ''; performSearch(searchInput.value, 'now'); };
        if (searchInput) searchInput.onkeyup = function (e) {
            if (e.key === 'Enter') performSearch(searchInput.value, timeInput.value.trim() || 'now');
            else showSuggestions(searchInput.value, suggestionsBox, searchInput);
        };
        if (timeInput) timeInput.onkeyup = function (e) { if (e.key === 'Enter') performSearch(searchInput.value, timeInput.value.trim() || 'now'); };
        document.addEventListener('click', function (e) { if (suggestionsBox && e.target !== searchInput) suggestionsBox.style.display = 'none'; });

        ['locFilterDiv', 'locFilterGrade', 'locFilterBunk'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.onchange = renderScheduleGrid;
        });

        renderFilters();
        load();
    }

    function load() {
        if (_loading) return;
        _loading = true;
        var body = document.getElementById('locScheduleBody');
        if (body) body.innerHTML = '<div class="empty-state">Loading schedule…</div>';
        if (!window.LiveScheduleReader) { _loading = false; return; }
        window.LiveScheduleReader.loadToday(getStructure()).then(function (data) {
            _schedule = data;
            _loading = false;
            renderFilters();
            renderScheduleGrid();
        });
    }

    window.CampistryLiveLocator = { init: init, refresh: load };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
