// =============================================================================
// playoff_hub.js — per-league dedicated UI for managing one playoff
// =============================================================================
// Open with PlayoffHub.open(league, kind) where kind = 'regular' | 'specialty'.
// One overlay manages one league at a time — there's no sidebar; each league's
// "Playoff Mode" button launches its own focused hub.
//
// v4 — USER-DEFINED ROUNDS. The system no longer generates brackets. The user
// builds each round by hand: how many matchups it has, who plays who, which
// sport, and (optionally) which field. Teams not placed in a matchup can be
// marked as byes (sit out, still in). The scheduler runs whichever round is
// marked "current". Fields can be reserved for teams that are out of the
// playoffs — those are locked like a custom pinned elective and cannot be
// overwritten by the auto-scheduler.
//
// Step layout:
//   Step 1 — Build rounds & matchups   (add rounds, pick teams/sports/fields,
//                                       mark winners, set the current round)
//   Step 2 — Reserve fields             (pinned electives for teams that are out)
//
// Public API: window.PlayoffHub
//   .open(league, kind)
//   .close()
// =============================================================================
(function () {
    'use strict';

    var VERSION = '4.1.0';
    var _overlayEl = null;
    var _league = null;
    var _kind = 'regular';
    var _activePage = null;   // round number shown in Step 1, or 'add' for the new-round page

    function escHtml(s) { return window.CampUtils.escapeHtml(s); }  // → campistry_utils.js (canonical)

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------
    function _save() {
        // ★★★ CB-123: the Playoff Hub renders a fully-interactive editor with NO
        // role gate (every sibling league control IS role-gated). _save() is the
        // SOLE persistence path for all bracket mutations, so gating it here
        // stops a viewer / read-only user from writing the shared leaguesByName /
        // specialtyLeagues mirror — the concrete harm. Owner/admin/scheduler
        // (canEdit) are unaffected.
        try {
            if (window.AccessControl && typeof window.AccessControl.canEdit === 'function' && window.AccessControl.canEdit() === false) {
                console.warn('[PlayoffHub] CB-123: read-only role — bracket changes are not saved');
                return;
            }
        } catch (_) {}
        // ★ Re-bind _league to the LIVE entry in the registry. loadLeaguesData
        //   creates fresh objects via validateLeague on every focus/sync, so a
        //   reference held since open() is stale and our mutations on it never
        //   reach the registry. Look the league back up by name/id and mirror
        //   the playoff state onto the live object before saving.
        if (_kind === 'specialty') {
            var sl = window.specialtyLeagues || {};
            var liveS = _league && (sl[_league.id] || sl[_league.name]);
            if (!liveS) {
                var keys = Object.keys(sl);
                for (var i = 0; i < keys.length; i++) {
                    var cand = sl[keys[i]];
                    if (cand && (cand.id === (_league && _league.id) || cand.name === (_league && _league.name))) {
                        liveS = cand; break;
                    }
                }
            }
            if (liveS && _league && _league.playoff) {
                liveS.playoff = _league.playoff;
                _league = liveS;
            }
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('specialtyLeagues', sl); } catch (_) {}
            }
            // ★★★ CB-122: also persist via the canonical saver, which writes the
            // campistryGlobalSettings localStorage mirror that loadLeaguesData reads
            // FIRST on cold load. _save previously wrote only saveGlobalSettings
            // (cloud + IDB), so a reload / 2nd device before cloud hydration restored
            // a bracket-less league and a subsequent league save clobbered the cloud
            // bracket.
            if (typeof window.saveSpecialtyLeaguesData === 'function') { try { window.saveSpecialtyLeaguesData(); } catch (_) {} }
        } else {
            var lbn = window.leaguesByName || {};
            var liveR = _league && lbn[_league.name];
            if (liveR && _league.playoff) {
                liveR.playoff = _league.playoff;
                _league = liveR;
            }
            if (typeof window.saveGlobalSettings === 'function') {
                try { window.saveGlobalSettings('leaguesByName', lbn); } catch (_) {}
            }
            // ★★★ CB-122: persist via the canonical saver too (writes the
            // campistryGlobalSettings localStorage mirror loadLeaguesData reads first
            // on cold load) — otherwise the bracket is lost if a league save/gen
            // fires before cloud hydration on reload / a 2nd device.
            if (typeof window.saveLeaguesData === 'function') { try { window.saveLeaguesData(); } catch (_) {} }
        }
    }

    function _fieldsForSport(sport) {
        if (!sport) return [];
        try {
            var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var fields = (gs.app1 && gs.app1.fields) || gs.fields || [];
            return fields
                .filter(function (f) { return f && Array.isArray(f.activities) && f.activities.indexOf(sport) >= 0; })
                .map(function (f) { return f.name; });
        } catch (_) { return []; }
    }
    function _allFacilityNames() {
        try {
            var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var fields = (gs.app1 && gs.app1.fields) || gs.fields || [];
            var facs = (gs.app1 && gs.app1.facilities) || [];
            var names = new Set();
            fields.forEach(function (f) { if (f && f.name) names.add(f.name); });
            facs.forEach(function (f) { if (f && f.name) names.add(f.name); });
            return Array.from(names).sort();
        } catch (_) { return []; }
    }
    function _teams() {
        return (_league && _league.teams || []).slice();
    }
    function _sportsList() {
        if (_league && Array.isArray(_league.sports) && _league.sports.length > 0) return _league.sports.slice();
        if (_league && typeof _league.sport === 'string' && _league.sport) return [_league.sport];
        return [];
    }

    // -------------------------------------------------------------------------
    // Automatic round tracking
    // -------------------------------------------------------------------------
    // The schedulers number every league period ("tile") chronologically via
    // history.gamesPerDate. Playoffs anchor on that counter: startGameCount is
    // the total when playoffs begin, and league tile #(startGameCount + N)
    // plays Round N. Read the SAME history the schedulers read (cloud-synced
    // globalSettings mirror, with the localStorage backup as fallback — LG-7
    // freshness rule for regular leagues).
    function _totalGamesRecorded() {
        try {
            var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var cloud, local = null;
            if (_kind === 'specialty') {
                cloud = gs.specialtyLeagueHistory;
                try { var rawS = localStorage.getItem('campSpecialtyLeagueHistory_v1'); if (rawS) local = JSON.parse(rawS); } catch (_) {}
            } else {
                cloud = gs.leagueHistory;
                try { var rawR = localStorage.getItem('campLeagueHistory_v2'); if (rawR) local = JSON.parse(rawR); } catch (_) {}
            }
            var hist;
            if (cloud && local) {
                hist = ((Number(local._savedAt) || 0) > (Number(cloud._savedAt) || 0)) ? local : cloud;
            } else {
                hist = cloud || local;
            }
            if (!hist || !hist.gamesPerDate) return 0;
            var key = (_kind === 'specialty') ? (_league.id || _league.name) : _league.name;
            var map = hist.gamesPerDate[key] || {};
            var total = 0;
            Object.keys(map).forEach(function (d) { total += Number(map[d]) || 0; });
            return total;
        } catch (_) { return 0; }
    }

    // The round the NEXT league tile on the schedule will play.
    function _upNextRound(p) {
        if (typeof p.startGameCount === 'number') {
            return Math.max(1, _totalGamesRecorded() - p.startGameCount + 1);
        }
        return p.currentRound || 1;   // legacy manual mode (anchor stamped on next render)
    }

    // Anchor the tile counter so the next league tile plays `nextRound`
    // (defaults to the first round that isn't fully decided yet).
    function _stampStartCount(p, nextRound) {
        if (nextRound == null) {
            nextRound = 1;
            var sorted = (p.rounds || []).slice().sort(function (a, b) { return a.number - b.number; });
            for (var i = 0; i < sorted.length; i++) {
                if (sorted[i].number === nextRound && window.PlayoffMode.isRoundComplete(sorted[i])) nextRound++;
                else break;
            }
        }
        p.startGameCount = Math.max(0, _totalGamesRecorded() - (nextRound - 1));
        p.currentRound = nextRound;   // keep the display cache in step
    }

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    function _render() {
        if (!_overlayEl || !_league) return;
        var body = _overlayEl.querySelector('.ph-body');
        if (!body) return;
        var titleEl = _overlayEl.querySelector('.ph-title');
        if (titleEl) titleEl.textContent = 'Playoff Hub — ' + (_league.name || '(unnamed)');
        body.innerHTML = '';

        var p = window.PlayoffMode.getOrInit(_league);

        // Migration: an enabled playoff from before automatic round tracking
        // has no anchor — stamp one that continues from the first undecided
        // round, so tracking picks up exactly where the user left off.
        if (p.enabled && typeof p.startGameCount !== 'number') {
            _stampStartCount(p, null);
            _save();
        }

        // Top row: enable toggle
        var topRow = document.createElement('div');
        topRow.className = 'ph-top-row';

        var lead = document.createElement('div');
        lead.className = 'ph-lead';
        lead.innerHTML = '<span class="ph-lead-label">Status</span>'
            + '<span class="ph-lead-value ' + (p.enabled ? 'on' : 'off') + '">' + (p.enabled ? 'Playoff: On' : 'Playoff: Off') + '</span>';
        topRow.appendChild(lead);

        var enableLab = document.createElement('label');
        enableLab.className = 'ph-toggle' + (p.enabled ? ' on' : '');
        var enableCb = document.createElement('input');
        enableCb.type = 'checkbox';
        enableCb.checked = !!p.enabled;
        enableCb.onchange = function () {
            p.enabled = enableCb.checked;
            if (p.enabled) {
                // Start (or resume) the tile counter: the next league period
                // plays the first round that isn't decided yet.
                _stampStartCount(p, null);
            }
            _save();
            _render();
        };
        enableLab.appendChild(enableCb);
        var enableTxt = document.createElement('span');
        enableTxt.textContent = p.enabled ? 'Turn off' : 'Turn on';
        enableLab.appendChild(enableTxt);
        topRow.appendChild(enableLab);

        body.appendChild(topRow);

        if (!p.enabled) {
            var off = document.createElement('div');
            off.className = 'ph-explainer';
            off.textContent = 'Turn on Playoff to replace regular round-robin scheduling with rounds you build yourself: you decide how many matchups each round has, which team plays which, what sport they play, and (optionally) on which field. Round tracking is automatic — once playoffs are on, the first league period on the schedule plays Round 1, the second plays Round 2, and so on.';
            body.appendChild(off);
            return;
        }

        // Champion banner
        var champion = window.PlayoffMode.getChampion(_league);
        if (champion) {
            var champ = document.createElement('div');
            champ.className = 'ph-champion';
            champ.innerHTML = '<div class="ph-champion-label">Champion</div>'
                + '<div class="ph-champion-name">' + escHtml(champion) + '</div>';
            body.appendChild(champ);
        }

        // Step 1 — Build rounds & matchups
        body.appendChild(_renderStep1(p));

        // Step 2 — Reserve fields for teams that are out
        body.appendChild(_renderStep2(p));
    }

    function _stepHead(num, title, sub) {
        var d = document.createElement('div');
        d.className = 'ph-step-head';
        d.innerHTML = '<div class="ph-step-num">' + num + '</div>'
            + '<div class="ph-step-title-wrap">'
            +   '<div class="ph-step-title">' + escHtml(title) + '</div>'
            +   (sub ? '<div class="ph-step-sub">' + escHtml(sub) + '</div>' : '')
            + '</div>';
        return d;
    }

    // -------------------------------------------------------------------------
    // Step 1 — rounds & matchups
    // -------------------------------------------------------------------------

    function _renderStep1(p) {
        var card = document.createElement('section');
        card.className = 'ph-step-card';
        card.appendChild(_stepHead(1, 'Build rounds & matchups',
            'Each round is its own page: set how many matchups it has, pick any team vs any team, pick the sport, and either pick a field or let the scheduler find one. Mark winners as games finish.'));

        var hasRounds = p.rounds && p.rounds.length > 0;
        var upNext = _upNextRound(p);
        var maxRound = 0;
        (p.rounds || []).forEach(function (r) { if (r && r.number > maxRound) maxRound = r.number; });
        var champion = window.PlayoffMode.getChampion(_league);

        // ── Automatic round-tracking status ──
        var played = (typeof p.startGameCount === 'number')
            ? Math.max(0, _totalGamesRecorded() - p.startGameCount) : 0;
        var track = document.createElement('div');
        track.className = 'ph-track-bar';
        var trackMsg = 'Round tracking is automatic: league period #1 after playoffs started plays Round 1, period #2 plays Round 2, and so on. '
            + played + ' league period' + (played === 1 ? '' : 's') + ' counted so far';
        if (champion) {
            trackMsg += ' — tournament decided.';
        } else if (hasRounds && upNext > maxRound) {
            trackMsg += ' — the next league period plays Round ' + upNext + ', which isn\'t built yet. Add it below.';
        } else {
            trackMsg += ' — the next league period plays Round ' + upNext + '.';
        }
        track.textContent = '🎯 ' + trackMsg;
        card.appendChild(track);

        // ── Page picker: one tab per round + "Add Round" ──
        if (_activePage == null
            || (_activePage !== 'add' && !window.PlayoffMode.getRoundByNumber(_league, _activePage))) {
            _activePage = hasRounds
                ? (window.PlayoffMode.getRoundByNumber(_league, upNext) ? upNext : maxRound)
                : 'add';
        }

        var tabs = document.createElement('div');
        tabs.className = 'ph-round-tabs';
        (p.rounds || []).slice().sort(function (a, b) { return a.number - b.number; }).forEach(function (r) {
            var tab = document.createElement('button');
            tab.type = 'button';
            var complete = window.PlayoffMode.isRoundComplete(r);
            tab.className = 'ph-round-tab' + (_activePage === r.number ? ' active' : '');
            tab.innerHTML = escHtml('Round ' + r.number)
                + (complete ? ' <span class="ph-tab-check">✓</span>' : '')
                + (!champion && r.number === upNext ? ' <span class="ph-tab-next">next</span>' : '');
            tab.onclick = function () { _activePage = r.number; _render(); };
            tabs.appendChild(tab);
        });
        var addTab = document.createElement('button');
        addTab.type = 'button';
        addTab.className = 'ph-round-tab add' + (_activePage === 'add' ? ' active' : '');
        addTab.textContent = '+ Add Round';
        addTab.onclick = function () { _activePage = 'add'; _render(); };
        tabs.appendChild(addTab);
        card.appendChild(tabs);

        // ── Active page ──
        if (_activePage === 'add') {
            if (!hasRounds) {
                var empty = document.createElement('div');
                empty.className = 'ph-explainer subtle';
                empty.textContent = 'No rounds yet — create the Round 1 page and choose how many matchups it should have. Once playoffs are on, the first league period on the schedule plays Round 1.';
                card.appendChild(empty);
            }
            card.appendChild(_renderAddRoundRow(p));
        } else {
            var round = window.PlayoffMode.getRoundByNumber(_league, _activePage);
            if (round) card.appendChild(_renderRound(p, round, upNext));
        }

        if (hasRounds) {
            var bottom = document.createElement('div');
            bottom.className = 'ph-actions-row';
            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ph-btn ghost small danger';
            clearBtn.textContent = 'Clear all rounds & start over';
            clearBtn.onclick = function () {
                if (!confirm('Clear every playoff round for ' + (_league.name || 'this league') + '?')) return;
                p.rounds = []; p.currentRound = 1;
                _stampStartCount(p, 1);   // next league period plays Round 1 again
                _activePage = 'add';
                _save(); _render();
            };
            bottom.appendChild(clearBtn);
            card.appendChild(bottom);
        }

        return card;
    }

    function _renderAddRoundRow(p) {
        var row = document.createElement('div');
        row.className = 'ph-addround-row';

        var nextNum = 0;
        (p.rounds || []).forEach(function (r) { if (r && r.number > nextNum) nextNum = r.number; });
        nextNum += 1;

        // Suggested matchup count: half the previous round's matchups, or half
        // the team count for Round 1.
        var suggested;
        if (p.rounds && p.rounds.length > 0) {
            var prev = p.rounds[p.rounds.length - 1];
            suggested = Math.max(1, Math.ceil(((prev.matchups || []).length || 2) / 2));
        } else {
            suggested = Math.max(1, Math.floor(_teams().length / 2));
        }

        var label = document.createElement('span');
        label.className = 'ph-addround-label';
        label.textContent = 'Add Round ' + nextNum + ' with';
        row.appendChild(label);

        var input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = '64';
        input.value = String(suggested);
        input.className = 'ph-count-input';
        row.appendChild(input);

        var label2 = document.createElement('span');
        label2.className = 'ph-addround-label';
        label2.textContent = 'matchup(s)';
        row.appendChild(label2);

        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ph-btn primary';
        addBtn.textContent = '+ Create Round ' + nextNum + ' page';
        addBtn.onclick = function () {
            var n = parseInt(input.value, 10);
            if (!n || n < 1) { input.focus(); return; }
            var round = window.PlayoffMode.createRound(p, n);
            _activePage = round.number;
            _save(); _render();
        };
        row.appendChild(addBtn);

        return row;
    }

    function _renderRound(p, round, upNext) {
        var isUpNext = round.number === upNext;
        var card = document.createElement('div');
        card.className = 'ph-round-card' + (isUpNext ? ' current' : '');

        var complete = window.PlayoffMode.isRoundComplete(round);

        // ── Header ──
        var top = document.createElement('div');
        top.className = 'ph-round-top';

        var title = document.createElement('div');
        title.className = 'ph-round-title';
        title.textContent = 'Round ' + round.number;
        top.appendChild(title);

        if (isUpNext && !window.PlayoffMode.getChampion(_league)) {
            var cur = document.createElement('span');
            cur.className = 'ph-round-badge current';
            cur.textContent = 'up next';
            cur.title = 'Round tracking is automatic — the next league period on the schedule plays this round.';
            top.appendChild(cur);
        }
        if (complete) {
            var done = document.createElement('span');
            done.className = 'ph-round-badge complete';
            done.textContent = 'complete';
            top.appendChild(done);
        }

        var spacer = document.createElement('span');
        spacer.className = 'ph-round-spacer';
        top.appendChild(spacer);

        if (!isUpNext) {
            // Manual re-align escape hatch: shift the automatic tile counter so
            // THIS round plays in the next league period.
            var setBtn = document.createElement('button');
            setBtn.type = 'button';
            setBtn.className = 'ph-btn ghost small';
            setBtn.textContent = 'Play this round next';
            setBtn.title = 'Re-aligns the automatic tracking so the next league period on the schedule plays Round ' + round.number + '.';
            setBtn.onclick = function () {
                _stampStartCount(p, round.number);
                _save(); _render();
            };
            top.appendChild(setBtn);
        }

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ph-btn ghost small danger';
        delBtn.textContent = 'Delete';
        delBtn.onclick = function () {
            if (!confirm('Delete Round ' + round.number + '? Later rounds will be renumbered.')) return;
            window.PlayoffMode.removeRound(p, round.number);
            _activePage = null;   // re-resolve to a valid page
            _save(); _render();
        };
        top.appendChild(delBtn);

        card.appendChild(top);

        // ── Matchups ──
        // Map of team -> how many matchups of THIS round it appears in, to
        // block double-booking a team within one round.
        var usage = {};
        (round.matchups || []).forEach(function (m) {
            if (!m) return;
            if (m.teamA) usage[m.teamA] = (usage[m.teamA] || 0) + 1;
            if (m.teamB) usage[m.teamB] = (usage[m.teamB] || 0) + 1;
        });
        var eliminated = window.PlayoffMode.getEliminatedTeams(_league);

        var list = document.createElement('div');
        list.className = 'ph-mu-list';
        (round.matchups || []).forEach(function (m, mi) {
            list.appendChild(_renderMatchupRow(p, round, m, mi, usage, eliminated));
        });
        card.appendChild(list);

        var addMu = document.createElement('button');
        addMu.type = 'button';
        addMu.className = 'ph-btn ghost small';
        addMu.textContent = '+ Add matchup';
        addMu.onclick = function () {
            round.matchups.push(window.PlayoffMode.createMatchup());
            _save(); _render();
        };
        card.appendChild(addMu);

        // ── Byes ──
        card.appendChild(_renderByes(round, usage));

        // ── Hints ──
        var unfilled = (round.matchups || []).filter(function (m) { return m && (!m.teamA || !m.teamB); }).length;
        var doubled = Object.keys(usage).filter(function (t) { return usage[t] > 1; });
        if (doubled.length > 0) {
            var warn = document.createElement('div');
            warn.className = 'ph-round-warn';
            warn.textContent = '⚠️ ' + doubled.join(', ') + ' appear' + (doubled.length === 1 ? 's' : '') + ' in more than one matchup this round.';
            card.appendChild(warn);
        }
        if (isUpNext && unfilled > 0) {
            var hint = document.createElement('div');
            hint.className = 'ph-explainer subtle';
            hint.textContent = unfilled + ' matchup' + (unfilled === 1 ? '' : 's') + ' still need' + (unfilled === 1 ? 's' : '') + ' teams — the scheduler only places matchups with both teams picked.';
            card.appendChild(hint);
        }
        if (complete
            && !window.PlayoffMode.getRoundByNumber(_league, round.number + 1)
            && !window.PlayoffMode.getChampion(_league)) {
            var doneHint = document.createElement('div');
            doneHint.className = 'ph-explainer subtle';
            doneHint.textContent = 'All matchups decided — create the Round ' + (round.number + 1) + ' page from the tab bar above and fill in its matchups.';
            card.appendChild(doneHint);
        }

        return card;
    }

    function _renderMatchupRow(p, round, m, mi, usage, eliminated) {
        var row = document.createElement('div');
        row.className = 'ph-mu-row' + (m.winner ? ' decided' : '');

        var teams = _teams();
        var sports = _sportsList();

        function teamSelect(side) {
            var sel = document.createElement('select');
            sel.className = 'ph-mu-team';
            var current = m[side] || '';
            var other = m[side === 'teamA' ? 'teamB' : 'teamA'] || '';
            var opts = '<option value="">Pick team…</option>';
            teams.forEach(function (t) {
                var usedElsewhere = (usage[t] || 0) - (t === current ? 1 : 0) > 0;
                var isOut = eliminated.indexOf(t) >= 0;
                var label = t + (isOut ? ' (out)' : '');
                opts += '<option value="' + escHtml(t) + '"'
                    + (t === current ? ' selected' : '')
                    + ((usedElsewhere || t === other) && t !== current ? ' disabled' : '')
                    + '>' + escHtml(label) + '</option>';
            });
            // Keep a stale value visible (team renamed/removed) so the user can fix it
            if (current && teams.indexOf(current) < 0) {
                opts += '<option value="' + escHtml(current) + '" selected>' + escHtml(current + ' (missing)') + '</option>';
            }
            sel.innerHTML = opts;
            sel.onchange = function () {
                m[side] = sel.value;
                // A picked team can't also be on a bye this round
                if (sel.value) round.byes = (round.byes || []).filter(function (t) { return t !== sel.value; });
                // Winner must stay one of the two teams
                if (m.winner && m.winner !== m.teamA && m.winner !== m.teamB) m.winner = null;
                _save(); _render();
            };
            return sel;
        }

        // Line 1: # teamA vs teamB ×
        var line1 = document.createElement('div');
        line1.className = 'ph-mu-line';

        var num = document.createElement('span');
        num.className = 'ph-mu-num';
        num.textContent = String(mi + 1);
        line1.appendChild(num);

        line1.appendChild(teamSelect('teamA'));

        var vs = document.createElement('span');
        vs.className = 'ph-vs';
        vs.textContent = 'vs';
        line1.appendChild(vs);

        line1.appendChild(teamSelect('teamB'));

        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ph-mu-x';
        rm.title = 'Remove matchup';
        rm.textContent = '×';
        rm.onclick = function () {
            round.matchups.splice(mi, 1);
            _save(); _render();
        };
        line1.appendChild(rm);
        row.appendChild(line1);

        // Line 2: sport / field / winner
        var line2 = document.createElement('div');
        line2.className = 'ph-mu-line sub';

        // Sport
        var sportWrap = document.createElement('label');
        sportWrap.className = 'ph-pickrow';
        sportWrap.innerHTML = '<span class="ph-pickrow-label">Sport</span>';
        var sportSel = document.createElement('select');
        sportSel.innerHTML = '<option value="">Pick…</option>'
            + sports.map(function (s) {
                return '<option value="' + escHtml(s) + '"' + (m.sport === s ? ' selected' : '') + '>' + escHtml(s) + '</option>';
            }).join('');
        sportSel.onchange = function () {
            m.sport = sportSel.value;
            // Field is sport-specific — clear a now-incompatible field
            if (m.field && _fieldsForSport(m.sport).indexOf(m.field) < 0) m.field = '';
            _save(); _render();
        };
        sportWrap.appendChild(sportSel);
        line2.appendChild(sportWrap);

        // Field: Auto (scheduler picks) or a specific compatible field
        var fieldWrap = document.createElement('label');
        fieldWrap.className = 'ph-pickrow';
        fieldWrap.innerHTML = '<span class="ph-pickrow-label">Field</span>';
        var fieldSel = document.createElement('select');
        fieldSel.disabled = !m.sport;
        if (!m.sport) {
            fieldSel.innerHTML = '<option value="">Pick sport first</option>';
        } else {
            var compat = _fieldsForSport(m.sport);
            if (compat.length === 0) {
                fieldSel.innerHTML = '<option value="">No fields support this sport</option>';
            } else {
                fieldSel.innerHTML = '<option value="">Auto (scheduler picks)</option>'
                    + compat.map(function (f) {
                        return '<option value="' + escHtml(f) + '"' + (m.field === f ? ' selected' : '') + '>' + escHtml(f) + '</option>';
                    }).join('');
            }
        }
        fieldSel.onchange = function () {
            m.field = fieldSel.value || '';
            _save();
        };
        fieldWrap.appendChild(fieldSel);
        line2.appendChild(fieldWrap);

        // Winner
        var winWrap = document.createElement('label');
        winWrap.className = 'ph-pickrow';
        winWrap.innerHTML = '<span class="ph-pickrow-label">Winner</span>';
        var winSel = document.createElement('select');
        winSel.disabled = !(m.teamA && m.teamB);
        winSel.innerHTML = '<option value="">— not played —</option>'
            + [m.teamA, m.teamB].filter(Boolean).map(function (t) {
                return '<option value="' + escHtml(t) + '"' + (m.winner === t ? ' selected' : '') + '>' + escHtml(t) + '</option>';
            }).join('');
        winSel.onchange = function () {
            m.winner = winSel.value || null;
            _save(); _render();
        };
        winWrap.appendChild(winSel);
        line2.appendChild(winWrap);

        row.appendChild(line2);
        return row;
    }

    function _renderByes(round, usage) {
        var wrap = document.createElement('div');
        wrap.className = 'ph-byes-wrap';

        var label = document.createElement('div');
        label.className = 'ph-byes-label';
        label.textContent = 'Byes — sit out this round, still in the playoffs';
        wrap.appendChild(label);

        var teams = _teams();
        // Only teams not already in a matchup this round can take a bye
        var candidates = teams.filter(function (t) { return !usage[t]; });
        // Prune byes that are no longer valid (team removed / now in a matchup)
        round.byes = (round.byes || []).filter(function (t) { return candidates.indexOf(t) >= 0; });

        if (candidates.length === 0) {
            var none = document.createElement('div');
            none.className = 'ph-byes-none';
            none.textContent = 'Every team is in a matchup this round.';
            wrap.appendChild(none);
            return wrap;
        }

        var chips = document.createElement('div');
        chips.className = 'ph-chips tight';
        candidates.forEach(function (t) {
            var on = round.byes.indexOf(t) >= 0;
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ph-chip' + (on ? ' active' : '');
            chip.textContent = t + (on ? ' • bye' : '');
            chip.onclick = function () {
                if (on) round.byes = round.byes.filter(function (x) { return x !== t; });
                else round.byes.push(t);
                _save(); _render();
            };
            chips.appendChild(chip);
        });
        wrap.appendChild(chips);
        return wrap;
    }

    // -------------------------------------------------------------------------
    // Step 2 — reserved fields for teams that are out
    // -------------------------------------------------------------------------

    function _renderStep2(p) {
        var card = document.createElement('section');
        card.className = 'ph-step-card';
        card.appendChild(_stepHead(2, 'Save fields for teams that are out',
            'Pick fields/activities to reserve during the playoff slot for '
            + ((_league.divisions || []).join(', ') || 'this league\'s grades')
            + '. They are locked like a custom pinned elective — the auto-scheduler cannot overwrite them, and routes eliminated / non-playing bunks into them.'));

        // Who's out (derived from marked winners)
        var out = window.PlayoffMode.getEliminatedTeams(_league);
        var outRow = document.createElement('div');
        outRow.className = 'ph-out-row';
        if (out.length === 0) {
            outRow.innerHTML = '<span class="ph-out-label">Out of the playoffs:</span><span class="ph-out-none">no teams yet — mark winners in Step 1 as games finish.</span>';
        } else {
            outRow.innerHTML = '<span class="ph-out-label">Out of the playoffs:</span>'
                + out.map(function (t) { return '<span class="ph-out-chip">' + escHtml(t) + '</span>'; }).join('');
        }
        card.appendChild(outRow);

        var chips = document.createElement('div');
        chips.className = 'ph-chips';
        var allActs = _allFacilityNames();
        if (allActs.length === 0) {
            var none = document.createElement('div');
            none.className = 'ph-step-sub';
            none.style.marginLeft = '42px';
            none.textContent = 'No facilities configured yet — add them in the Facilities tab.';
            card.appendChild(none);
            return card;
        }
        allActs.forEach(function (act) {
            var on = (p.reservedActivities || []).indexOf(act) >= 0;
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ph-chip' + (on ? ' active' : '');
            chip.textContent = act;
            chip.onclick = function () {
                if (on) p.reservedActivities = p.reservedActivities.filter(function (x) { return x !== act; });
                else { p.reservedActivities = p.reservedActivities || []; p.reservedActivities.push(act); }
                _save(); _render();
            };
            chips.appendChild(chip);
        });
        card.appendChild(chips);
        return card;
    }

    // -------------------------------------------------------------------------
    // Open / close
    // -------------------------------------------------------------------------

    function open(league, kind) {
        if (!league) {
            console.warn('[PlayoffHub] open() requires a league');
            return;
        }
        if (_overlayEl) close();
        _injectStyles();
        _league = league;
        _kind = kind === 'specialty' ? 'specialty' : 'regular';
        _activePage = null;

        _overlayEl = document.createElement('div');
        _overlayEl.className = 'ph-overlay';
        _overlayEl.innerHTML =
            '<div class="ph-shell">' +
              '<header class="ph-header">' +
                '<div class="ph-title">Playoff Hub</div>' +
                '<button class="ph-close" type="button" title="Close">&times;</button>' +
              '</header>' +
              '<div class="ph-body"></div>' +
            '</div>';
        document.body.appendChild(_overlayEl);
        _overlayEl.querySelector('.ph-close').onclick = close;
        let _mdPlayoffOverlay = false;
        _overlayEl.addEventListener('mousedown', function (e) { _mdPlayoffOverlay = (e.target === _overlayEl); });
        _overlayEl.addEventListener('click', function (e) { if (e.target === _overlayEl && _mdPlayoffOverlay) close(); });
        document.addEventListener('keydown', _escListener);
        _render();
    }

    function close() {
        if (!_overlayEl) return;
        _overlayEl.remove();
        _overlayEl = null;
        _league = null;
        document.removeEventListener('keydown', _escListener);
    }

    function _escListener(e) { if (e.key === 'Escape') close(); }

    // -------------------------------------------------------------------------
    // Styles — uses the app's teal palette (#147D91)
    // -------------------------------------------------------------------------

    function _injectStyles() {
        if (document.getElementById('playoff-hub-styles')) return;
        var st = document.createElement('style');
        st.id = 'playoff-hub-styles';
        st.textContent = [
            // Theme: teal primary (#147D91), light grey surfaces, deep ink text.
            '.ph-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.5);z-index:9000;display:flex;align-items:stretch;justify-content:center;padding:24px;backdrop-filter:blur(3px);}',
            '.ph-shell{flex:1;max-width:980px;background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;}',
            '.ph-header{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #E5E7EB;background:#F9FAFB;}',
            '.ph-title{font-size:1.1rem;font-weight:700;color:#0A4A56;letter-spacing:-0.01em;}',
            '.ph-close{background:transparent;border:1px solid #E5E7EB;color:#475569;width:32px;height:32px;border-radius:8px;font-size:1.4rem;cursor:pointer;line-height:1;}',
            '.ph-close:hover{background:#F1F5F9;border-color:#147D91;color:#147D91;}',
            '.ph-body{flex:1;overflow-y:auto;padding:22px 28px;display:flex;flex-direction:column;gap:16px;}',

            // Top row: status + toggle
            '.ph-top-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #E5E7EB;border-radius:10px;background:#F9FAFB;}',
            '.ph-lead{display:flex;align-items:center;gap:10px;}',
            '.ph-lead-label{font-size:0.7rem;font-weight:700;color:#6B7280;letter-spacing:0.06em;text-transform:uppercase;}',
            '.ph-lead-value{font-size:0.92rem;font-weight:700;}',
            '.ph-lead-value.on{color:#147D91;}',
            '.ph-lead-value.off{color:#9CA3AF;}',
            '.ph-toggle{display:flex;align-items:center;gap:8px;padding:7px 13px;border:1px solid #CBD5E1;border-radius:999px;background:#fff;font-size:0.82rem;font-weight:600;color:#475569;cursor:pointer;user-select:none;}',
            '.ph-toggle:hover{border-color:#147D91;color:#147D91;}',
            '.ph-toggle.on{background:#147D91;color:#fff;border-color:#147D91;}',
            '.ph-toggle input{accent-color:#fff;}',

            '.ph-explainer{padding:12px 14px;background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;color:#0A4A56;font-size:0.85rem;line-height:1.5;}',
            '.ph-explainer.subtle{background:transparent;border:none;color:#6B7280;font-size:0.82rem;padding:4px 0;}',

            // Step card
            '.ph-step-card{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;}',
            '.ph-step-head{display:flex;gap:14px;align-items:flex-start;}',
            '.ph-step-num{width:30px;height:30px;border-radius:50%;background:#147D91;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:0.9rem;flex-shrink:0;}',
            '.ph-step-title-wrap{display:flex;flex-direction:column;gap:2px;}',
            '.ph-step-title{font-size:1rem;font-weight:700;color:#0A4A56;}',
            '.ph-step-sub{font-size:0.8rem;color:#6B7280;line-height:1.45;}',

            // Automatic round-tracking status bar
            '.ph-track-bar{padding:10px 14px;background:#F0FDFA;border:1px solid #99F6E4;border-radius:10px;color:#0A4A56;font-size:0.82rem;line-height:1.5;}',

            // Round page tabs
            '.ph-round-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:2px solid #E5E7EB;padding-bottom:0;}',
            '.ph-round-tab{padding:9px 16px;border:1px solid #E5E7EB;border-bottom:none;background:#F9FAFB;border-radius:10px 10px 0 0;cursor:pointer;font-size:0.85rem;font-weight:600;font-family:inherit;color:#475569;margin-bottom:-2px;}',
            '.ph-round-tab:hover{color:#147D91;border-color:#147D91;}',
            '.ph-round-tab.active{background:#147D91;color:#fff;border-color:#147D91;}',
            '.ph-round-tab.add{border-style:dashed;background:transparent;color:#147D91;}',
            '.ph-round-tab.add.active{background:#147D91;color:#fff;border-style:solid;}',
            '.ph-tab-check{color:#10B981;font-weight:800;}',
            '.ph-round-tab.active .ph-tab-check{color:#A7F3D0;}',
            '.ph-tab-next{font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;background:#FDE68A;color:#92400E;border-radius:999px;padding:2px 7px;vertical-align:middle;}',

            // Round card
            '.ph-round-card{border:1px solid #E5E7EB;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:#FCFDFD;}',
            '.ph-round-card.current{border-color:#147D91;box-shadow:0 0 0 1px #147D91 inset;}',
            '.ph-round-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
            '.ph-round-title{font-size:0.95rem;font-weight:800;color:#0A4A56;}',
            '.ph-round-spacer{flex:1;}',
            '.ph-round-badge{font-size:0.65rem;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:0.05em;}',
            '.ph-round-badge.current{background:#147D91;color:#fff;}',
            '.ph-round-badge.complete{background:#D1FAE5;color:#065F46;}',
            '.ph-round-warn{font-size:0.78rem;color:#B45309;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:8px 10px;}',

            // Matchup rows
            '.ph-mu-list{display:flex;flex-direction:column;gap:8px;}',
            '.ph-mu-row{border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;background:#F9FAFB;display:flex;flex-direction:column;gap:8px;}',
            '.ph-mu-row.decided{border-color:#147D91;background:#ECFEFF;}',
            '.ph-mu-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.ph-mu-line.sub{padding-left:30px;}',
            '@media (max-width:720px){.ph-mu-line.sub{padding-left:0;}}',
            '.ph-mu-num{font-weight:700;font-size:0.72rem;color:#fff;background:#147D91;min-width:22px;text-align:center;border-radius:6px;padding:3px 0;flex-shrink:0;}',
            '.ph-mu-team{flex:1;min-width:130px;padding:7px 10px;border:1px solid #CBD5E1;border-radius:7px;font-size:0.85rem;background:#fff;font-family:inherit;color:#0A4A56;}',
            '.ph-mu-x{width:26px;height:26px;border:1px solid #CBD5E1;background:#fff;border-radius:6px;cursor:pointer;font-size:1rem;color:#6B7280;line-height:1;flex-shrink:0;font-family:inherit;}',
            '.ph-mu-x:hover{border-color:#DC2626;color:#DC2626;}',
            '.ph-vs{font-size:0.65rem;color:#9CA3AF;text-align:center;text-transform:uppercase;letter-spacing:0.06em;flex-shrink:0;}',
            '.ph-pickrow{display:flex;align-items:center;gap:6px;font-size:0.75rem;flex:1;min-width:150px;}',
            '.ph-pickrow-label{color:#6B7280;font-weight:600;min-width:42px;}',
            '.ph-pickrow select{flex:1;padding:5px 8px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.78rem;background:#fff;font-family:inherit;}',

            // Byes
            '.ph-byes-wrap{display:flex;flex-direction:column;gap:6px;padding-top:2px;}',
            '.ph-byes-label{font-size:0.72rem;font-weight:700;color:#147D91;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-byes-none{font-size:0.78rem;color:#9CA3AF;font-style:italic;}',

            // Add round
            '.ph-addround-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px dashed #CBD5E1;border-radius:10px;background:#F9FAFB;}',
            '.ph-addround-label{font-size:0.85rem;color:#475569;font-weight:600;}',
            '.ph-count-input{width:64px;padding:7px 8px;border:1px solid #CBD5E1;border-radius:7px;font-size:0.88rem;font-family:inherit;text-align:center;}',

            // Actions / buttons
            '.ph-actions-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
            '.ph-btn{padding:9px 18px;border:1px solid #CBD5E1;background:#fff;border-radius:8px;cursor:pointer;font-size:0.88rem;font-weight:600;font-family:inherit;color:#0A4A56;}',
            '.ph-btn:hover:not(:disabled){background:#F1F5F9;border-color:#147D91;color:#147D91;}',
            '.ph-btn.primary{background:#147D91;color:#fff;border-color:#147D91;}',
            '.ph-btn.primary:hover:not(:disabled){background:#0F6E80;color:#fff;}',
            '.ph-btn.ghost{background:transparent;}',
            '.ph-btn.small{padding:6px 12px;font-size:0.78rem;}',
            '.ph-btn.danger{color:#B91C1C;}',
            '.ph-btn.danger:hover:not(:disabled){background:#FEF2F2;border-color:#FECACA;color:#B91C1C;}',
            '.ph-btn:disabled{opacity:0.4;cursor:default;}',

            // Champion
            '.ph-champion{background:#147D91;color:#fff;border-radius:12px;padding:22px 16px;text-align:center;}',
            '.ph-champion-label{font-size:0.7rem;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#A5F3FC;}',
            '.ph-champion-name{font-size:1.6rem;font-weight:800;margin-top:6px;}',

            // Out-of-playoffs row
            '.ph-out-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:42px;padding:8px 12px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;}',
            '@media (max-width:720px){.ph-out-row{margin-left:0;}}',
            '.ph-out-label{font-size:0.7rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-out-none{font-size:0.78rem;color:#9CA3AF;font-style:italic;}',
            '.ph-out-chip{padding:3px 10px;background:#FEE2E2;color:#991B1B;border:1px solid #FCA5A5;border-radius:999px;font-size:0.78rem;}',

            // Reservations
            '.ph-chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:42px;}',
            '.ph-chips.tight{margin-left:0;}',
            '@media (max-width:720px){.ph-chips{margin-left:0;}}',
            '.ph-chip{padding:5px 12px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:999px;font-size:0.78rem;color:#475569;cursor:pointer;font-family:inherit;}',
            '.ph-chip:hover{border-color:#147D91;color:#147D91;}',
            '.ph-chip.active{background:#147D91;color:#fff;border-color:#147D91;}'
        ].join('');
        document.head.appendChild(st);
    }

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------
    window.PlayoffHub = {
        VERSION: VERSION,
        open: open,
        close: close
    };

    if (typeof console !== 'undefined') console.log('[PlayoffHub] v' + VERSION + ' loaded');
})();
