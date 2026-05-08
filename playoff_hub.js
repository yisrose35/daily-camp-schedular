// =============================================================================
// playoff_hub.js — dedicated UI for managing all playoff brackets
// =============================================================================
// One-stop fullscreen overlay where the user can:
//   * see every league's playoff status at a glance (OFF / R1 / R2 / Champion)
//   * toggle playoff mode on/off
//   * pick the bracket style (Fixed / Re-seed)
//   * configure seeds (drag-reorder + add/remove)
//   * generate Round 1 from seeds, then advance round-by-round
//   * pick sport + field per matchup
//   * mark winners (advances on next "Generate Round X" click)
//   * reserve activities so non-playing kids have somewhere to go
//
// Mounts on top of whatever page is showing. Reads/writes through the
// existing PlayoffMode helpers so the bracket state is fully compatible
// with the per-league embedded UI.
//
// Public API: window.PlayoffHub
//   .open()                  open the fullscreen overlay
//   .close()                 close it
// =============================================================================
(function () {
    'use strict';

    var VERSION = '1.0.0';
    var _overlayEl = null;
    var _selectedLeagueName = null;

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // -------------------------------------------------------------------------
    // Data accessors (read through PlayoffMode for compatibility)
    // -------------------------------------------------------------------------

    function _allLeagues() {
        var lbn = (window.loadGlobalSettings && window.loadGlobalSettings()?.leaguesByName) || window.leaguesByName || {};
        return Object.keys(lbn).sort().map(function (n) { return lbn[n]; }).filter(Boolean);
    }
    function _saveAll() {
        if (typeof window.saveLeaguesData === 'function') return window.saveLeaguesData();
        // Fallback: persist via global save helper
        var lbn = window.leaguesByName || {};
        if (typeof window.saveGlobalSettings === 'function') {
            try { window.saveGlobalSettings('leaguesByName', lbn); } catch (_) {}
        }
    }
    function _statusOf(league) {
        var p = window.PlayoffMode?.getOrInit?.(league);
        if (!p || !p.enabled) return { label: 'OFF', cls: 'off' };
        if (!p.rounds || p.rounds.length === 0) return { label: 'Setup', cls: 'setup' };
        var lastRound = p.rounds[p.rounds.length - 1];
        if (window.PlayoffMode.isRoundComplete(lastRound)) {
            if (lastRound.matchups && lastRound.matchups.length === 1 && lastRound.matchups[0].winner) {
                return { label: 'Champion', cls: 'champ' };
            }
            return { label: 'R' + lastRound.number + ' done', cls: 'done' };
        }
        return { label: 'Round ' + lastRound.number, cls: 'live' };
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

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    function _render() {
        if (!_overlayEl) return;
        var body = _overlayEl.querySelector('.ph-body');
        if (!body) return;
        body.innerHTML = '';

        // Sidebar
        body.appendChild(_renderSidebar());

        // Content
        var leagues = _allLeagues();
        if (leagues.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'ph-empty';
            empty.innerHTML = '<div class="ph-empty-icon">🏆</div>'
                + '<div class="ph-empty-title">No leagues yet</div>'
                + '<div class="ph-empty-sub">Create a league in League Setup, then come back to run a playoff bracket.</div>';
            body.appendChild(empty);
            return;
        }

        if (!_selectedLeagueName || !leagues.find(function (l) { return l.name === _selectedLeagueName; })) {
            _selectedLeagueName = leagues[0].name;
        }
        var league = leagues.find(function (l) { return l.name === _selectedLeagueName; });
        body.appendChild(_renderLeagueView(league));
    }

    function _renderSidebar() {
        var aside = document.createElement('aside');
        aside.className = 'ph-sidebar';

        var head = document.createElement('div');
        head.className = 'ph-sidebar-head';
        head.textContent = 'Leagues';
        aside.appendChild(head);

        var list = document.createElement('div');
        list.className = 'ph-league-list';

        _allLeagues().forEach(function (league) {
            var st = _statusOf(league);
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'ph-league-row' + (league.name === _selectedLeagueName ? ' selected' : '');
            row.onclick = function () {
                _selectedLeagueName = league.name;
                _render();
            };

            var nameSpan = document.createElement('div');
            nameSpan.className = 'ph-league-name';
            nameSpan.textContent = league.name;

            var meta = document.createElement('div');
            meta.className = 'ph-league-meta';
            var teams = (league.teams || []).length;
            meta.textContent = teams + ' team' + (teams === 1 ? '' : 's');

            var statusBadge = document.createElement('span');
            statusBadge.className = 'ph-status ph-status-' + st.cls;
            statusBadge.textContent = st.label;

            var top = document.createElement('div');
            top.className = 'ph-league-row-top';
            top.appendChild(nameSpan);
            top.appendChild(statusBadge);
            row.appendChild(top);
            row.appendChild(meta);

            list.appendChild(row);
        });

        aside.appendChild(list);
        return aside;
    }

    function _renderLeagueView(league) {
        var content = document.createElement('main');
        content.className = 'ph-content';

        var p = window.PlayoffMode.getOrInit(league);

        // -- HEADER --
        var hdr = document.createElement('div');
        hdr.className = 'ph-content-head';
        var hL = document.createElement('div');
        hL.className = 'ph-content-head-left';
        var title = document.createElement('div');
        title.className = 'ph-content-title';
        title.textContent = league.name;
        var sub = document.createElement('div');
        sub.className = 'ph-content-sub';
        var sportsList = (league.sports || []).join(' · ');
        var divs = (league.divisions || []).join(', ');
        sub.textContent = (divs || 'No grades') + (sportsList ? '  •  ' + sportsList : '');
        hL.appendChild(title); hL.appendChild(sub);
        hdr.appendChild(hL);

        var hR = document.createElement('div');
        hR.className = 'ph-content-head-right';
        var enableLab = document.createElement('label');
        enableLab.className = 'ph-toggle';
        var enableCb = document.createElement('input');
        enableCb.type = 'checkbox';
        enableCb.checked = !!p.enabled;
        enableCb.onchange = function () {
            p.enabled = enableCb.checked;
            _saveAll();
            _render();
        };
        enableLab.appendChild(enableCb);
        var enableTxt = document.createElement('span');
        enableTxt.textContent = p.enabled ? 'Playoff: ON' : 'Playoff: OFF';
        enableLab.appendChild(enableTxt);
        hR.appendChild(enableLab);
        hdr.appendChild(hR);

        content.appendChild(hdr);

        if (!p.enabled) {
            var off = document.createElement('div');
            off.className = 'ph-card ph-off-hint';
            off.innerHTML = '<div class="ph-off-title">Playoff mode is off for this league</div>'
                + '<div class="ph-off-sub">Turn it on to override regular round-robin scheduling with a single-elimination bracket. Each matchup gets its own sport + field, and the scheduler advances winners round-by-round.</div>';
            content.appendChild(off);
            return content;
        }

        // -- SETUP COLUMNS --
        var setupGrid = document.createElement('div');
        setupGrid.className = 'ph-setup-grid';
        setupGrid.appendChild(_renderStyleCard(league, p));
        setupGrid.appendChild(_renderSeedCard(league, p));
        content.appendChild(setupGrid);

        // -- ACTIONS --
        var actions = document.createElement('div');
        actions.className = 'ph-actions-row';
        var genBtn = document.createElement('button');
        genBtn.type = 'button';
        genBtn.className = 'ph-btn primary';
        genBtn.textContent = (p.rounds && p.rounds.length > 0) ? 'Regenerate bracket from seeds' : 'Generate Round 1';
        genBtn.disabled = (p.seedOrder || []).length < 2;
        genBtn.onclick = function () {
            if (p.rounds.length > 0 && !confirm('This will discard existing rounds and winners. Continue?')) return;
            var r1 = window.PlayoffMode.generateRound1(p.seedOrder, p.style);
            p.rounds = [{ number: 1, matchups: r1 }];
            p.currentRound = 1;
            _saveAll();
            _render();
        };
        actions.appendChild(genBtn);

        if (p.rounds.length > 0) {
            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ph-btn ghost danger';
            clearBtn.textContent = 'Clear all rounds';
            clearBtn.onclick = function () {
                if (!confirm('Clear all bracket rounds for ' + league.name + '?')) return;
                p.rounds = []; p.currentRound = 1;
                _saveAll(); _render();
            };
            actions.appendChild(clearBtn);
        }
        content.appendChild(actions);

        // -- BRACKET --
        if (p.rounds.length > 0) {
            content.appendChild(_renderBracket(league, p));

            // Advance / champion
            var lastRound = p.rounds[p.rounds.length - 1];
            var nonByeWinners = (lastRound.matchups || []).filter(function (m) { return m && m.winner && m.winner !== 'BYE'; }).length;
            if (window.PlayoffMode.isRoundComplete(lastRound) && nonByeWinners >= 2) {
                var advRow = document.createElement('div');
                advRow.className = 'ph-actions-row';
                var advBtn = document.createElement('button');
                advBtn.type = 'button';
                advBtn.className = 'ph-btn primary big';
                advBtn.textContent = '▶ Generate Round ' + (lastRound.number + 1);
                advBtn.onclick = function () {
                    var nextMatchups = (p.style === 'reseed')
                        ? window.PlayoffMode.advanceReseed(lastRound, p.seedOrder)
                        : window.PlayoffMode.advanceFixed(lastRound);
                    p.rounds.push({ number: lastRound.number + 1, matchups: nextMatchups });
                    p.currentRound = lastRound.number + 1;
                    _saveAll(); _render();
                };
                advRow.appendChild(advBtn);
                content.appendChild(advRow);
            } else if (lastRound.matchups && lastRound.matchups.length === 1 && lastRound.matchups[0].winner) {
                var champ = document.createElement('div');
                champ.className = 'ph-champion';
                champ.innerHTML = '<div class="ph-champion-trophy">🏆</div>'
                    + '<div class="ph-champion-label">CHAMPION</div>'
                    + '<div class="ph-champion-name">' + escHtml(lastRound.matchups[0].winner) + '</div>';
                content.appendChild(champ);
            }
        }

        // -- RESERVATIONS --
        content.appendChild(_renderReservedCard(league, p));

        return content;
    }

    function _renderStyleCard(league, p) {
        var card = document.createElement('div');
        card.className = 'ph-card';
        var head = document.createElement('div');
        head.className = 'ph-card-head';
        head.textContent = 'Bracket style';
        card.appendChild(head);

        var sub = document.createElement('div');
        sub.className = 'ph-card-sub';
        sub.textContent = 'Choose how winners are paired in each round.';
        card.appendChild(sub);

        var row = document.createElement('div');
        row.className = 'ph-style-row';
        [
            { v: 'fixed',  t: 'Fixed bracket', d: 'NBA-style — 1v8 winner plays 4v5 winner.' },
            { v: 'reseed', t: 'Re-seed',       d: 'Top remaining seed always plays the bottom.' }
        ].forEach(function (opt) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ph-pill' + (p.style === opt.v ? ' active' : '');
            btn.innerHTML = '<strong>' + opt.t + '</strong><span>' + opt.d + '</span>';
            btn.onclick = function () { p.style = opt.v; _saveAll(); _render(); };
            row.appendChild(btn);
        });
        card.appendChild(row);
        return card;
    }

    function _renderSeedCard(league, p) {
        var card = document.createElement('div');
        card.className = 'ph-card';
        var head = document.createElement('div');
        head.className = 'ph-card-head';
        head.textContent = 'Seeds';
        card.appendChild(head);
        var sub = document.createElement('div');
        sub.className = 'ph-card-sub';
        sub.textContent = '1 = top seed. Drag rows to reorder; non-power-of-2 brackets give byes to the top seeds.';
        card.appendChild(sub);

        // Auto-seed from standings if empty
        if (p.seedOrder.length === 0 && league.standings) {
            var keys = Object.keys(league.standings);
            if (keys.length > 0) {
                var sorted = keys.slice().sort(function (a, b) {
                    var sa = league.standings[a], sb = league.standings[b];
                    var wa = (sa.w || 0), wb = (sb.w || 0);
                    if (wb !== wa) return wb - wa;
                    var diffA = (sa.w || 0) - (sa.l || 0), diffB = (sb.w || 0) - (sb.l || 0);
                    if (diffB !== diffA) return diffB - diffA;
                    return a.localeCompare(b);
                });
                (league.teams || []).forEach(function (t) { if (sorted.indexOf(t) === -1) sorted.push(t); });
                p.seedOrder = sorted;
                _saveAll();
            }
        }

        var teams = (league.teams || []).slice();
        // Drop dead seeds
        p.seedOrder = (p.seedOrder || []).filter(function (t) { return teams.indexOf(t) >= 0; });

        var list = document.createElement('div');
        list.className = 'ph-seed-list';
        p.seedOrder.forEach(function (team, idx) {
            var row = document.createElement('div');
            row.className = 'ph-seed-row';
            row.draggable = true;
            row.setAttribute('data-idx', idx);

            var rank = document.createElement('span');
            rank.className = 'ph-seed-rank';
            rank.textContent = (idx + 1);

            var name = document.createElement('span');
            name.className = 'ph-seed-name';
            name.textContent = team;

            var btnWrap = document.createElement('span');
            btnWrap.className = 'ph-seed-btns';

            var up = document.createElement('button');
            up.type = 'button'; up.textContent = '▲'; up.disabled = idx === 0;
            up.onclick = function () {
                var t = p.seedOrder[idx - 1]; p.seedOrder[idx - 1] = p.seedOrder[idx]; p.seedOrder[idx] = t;
                _saveAll(); _render();
            };
            var down = document.createElement('button');
            down.type = 'button'; down.textContent = '▼'; down.disabled = idx === p.seedOrder.length - 1;
            down.onclick = function () {
                var t = p.seedOrder[idx + 1]; p.seedOrder[idx + 1] = p.seedOrder[idx]; p.seedOrder[idx] = t;
                _saveAll(); _render();
            };
            var rm = document.createElement('button');
            rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove from seeds';
            rm.onclick = function () {
                p.seedOrder = p.seedOrder.filter(function (x) { return x !== team; });
                _saveAll(); _render();
            };
            btnWrap.appendChild(up); btnWrap.appendChild(down); btnWrap.appendChild(rm);

            row.appendChild(rank); row.appendChild(name); row.appendChild(btnWrap);

            row.ondragstart = function (e) { e.dataTransfer.setData('text/plain', String(idx)); row.classList.add('dragging'); };
            row.ondragend   = function () { row.classList.remove('dragging'); };
            row.ondragover  = function (e) { e.preventDefault(); row.classList.add('drag-over'); };
            row.ondragleave = function () { row.classList.remove('drag-over'); };
            row.ondrop      = function (e) {
                e.preventDefault(); row.classList.remove('drag-over');
                var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                var to = parseInt(row.getAttribute('data-idx'), 10);
                if (isNaN(from) || isNaN(to) || from === to) return;
                var item = p.seedOrder.splice(from, 1)[0];
                p.seedOrder.splice(to, 0, item);
                _saveAll(); _render();
            };

            list.appendChild(row);
        });
        card.appendChild(list);

        // Add unseeded
        var unseeded = teams.filter(function (t) { return p.seedOrder.indexOf(t) < 0; });
        if (unseeded.length > 0) {
            var addRow = document.createElement('div');
            addRow.className = 'ph-seed-add';
            var sel = document.createElement('select');
            sel.innerHTML = '<option value="">+ add team to seeds</option>'
                + unseeded.map(function (t) { return '<option value="' + escHtml(t) + '">' + escHtml(t) + '</option>'; }).join('');
            sel.onchange = function () {
                if (!sel.value) return;
                p.seedOrder.push(sel.value);
                _saveAll(); _render();
            };
            addRow.appendChild(sel);

            var allBtn = document.createElement('button');
            allBtn.type = 'button';
            allBtn.className = 'ph-btn ghost';
            allBtn.textContent = 'Add all remaining';
            allBtn.onclick = function () {
                unseeded.forEach(function (t) { p.seedOrder.push(t); });
                _saveAll(); _render();
            };
            addRow.appendChild(allBtn);

            card.appendChild(addRow);
        }
        return card;
    }

    function _renderBracket(league, p) {
        var wrap = document.createElement('div');
        wrap.className = 'ph-bracket-wrap';
        var head = document.createElement('div');
        head.className = 'ph-card-head';
        head.textContent = 'Bracket';
        wrap.appendChild(head);

        var bracket = document.createElement('div');
        bracket.className = 'ph-bracket';

        p.rounds.forEach(function (round, ri) {
            var col = document.createElement('div');
            col.className = 'ph-round-col';
            var isSettled = ri < p.rounds.length - 1;
            var done = window.PlayoffMode.isRoundComplete(round);

            var rh = document.createElement('div');
            rh.className = 'ph-round-head';
            rh.innerHTML = '<span class="ph-round-num">Round ' + round.number + '</span>'
                + (done ? '<span class="ph-round-status">' + (isSettled ? 'locked' : 'complete') + '</span>' : '');
            col.appendChild(rh);

            (round.matchups || []).forEach(function (m, mi) {
                col.appendChild(_renderMatchup(league, p, round, m, mi, isSettled));
            });

            bracket.appendChild(col);
        });

        wrap.appendChild(bracket);
        return wrap;
    }

    function _renderMatchup(league, p, round, m, mi, isSettled) {
        var box = document.createElement('div');
        box.className = 'ph-matchup' + (m.winner ? ' decided' : '') + (m.isBye ? ' bye' : '');

        function renderTeam(side) {
            var name = m[side];
            var seed = m[side === 'teamA' ? 'seedA' : 'seedB'];
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ph-team' + (m.winner === name ? ' winner' : '') + (name === 'BYE' ? ' bye' : '');
            btn.disabled = isSettled || name === 'BYE' || m.isBye;
            var seedStr = seed ? '#' + seed : '';
            btn.innerHTML = '<span class="ph-team-seed">' + escHtml(seedStr) + '</span>'
                          + '<span class="ph-team-name">' + escHtml(name || '') + '</span>'
                          + '<span class="ph-team-trophy">' + (m.winner === name ? '🏆' : '') + '</span>';
            btn.onclick = function () {
                m.winner = (m.winner === name) ? null : name;
                _saveAll();
                _render();
            };
            return btn;
        }

        box.appendChild(renderTeam('teamA'));
        var vs = document.createElement('span'); vs.className = 'ph-vs'; vs.textContent = 'vs'; box.appendChild(vs);
        box.appendChild(renderTeam('teamB'));

        if (m.isBye) {
            var byeNote = document.createElement('div');
            byeNote.className = 'ph-bye-note';
            byeNote.textContent = '— bye, auto-advances —';
            box.appendChild(byeNote);
            return box;
        }

        // Sport selector
        var sportRow = document.createElement('div');
        sportRow.className = 'ph-pickrow';
        sportRow.innerHTML = '<span class="ph-pickrow-label">Sport</span>';
        var sportSel = document.createElement('select');
        sportSel.disabled = isSettled;
        sportSel.innerHTML = '<option value="">pick…</option>'
            + (league.sports || []).map(function (s) {
                return '<option value="' + escHtml(s) + '"' + (m.sport === s ? ' selected' : '') + '>' + escHtml(s) + '</option>';
            }).join('');
        sportSel.onchange = function () {
            m.sport = sportSel.value;
            // Clear stale incompatible field
            if (m.field && _fieldsForSport(m.sport).indexOf(m.field) < 0) m.field = '';
            _saveAll(); _render();
        };
        sportRow.appendChild(sportSel);
        box.appendChild(sportRow);

        // Field selector
        var fieldRow = document.createElement('div');
        fieldRow.className = 'ph-pickrow';
        fieldRow.innerHTML = '<span class="ph-pickrow-label">Field</span>';
        var fieldSel = document.createElement('select');
        fieldSel.disabled = isSettled || !m.sport;
        if (!m.sport) {
            fieldSel.innerHTML = '<option value="">pick sport first</option>';
        } else {
            var compat = _fieldsForSport(m.sport);
            fieldSel.innerHTML = '<option value="">Auto (any compatible)</option>'
                + compat.map(function (f) {
                    return '<option value="' + escHtml(f) + '"' + (m.field === f ? ' selected' : '') + '>' + escHtml(f) + '</option>';
                }).join('');
            if (compat.length === 0) {
                fieldSel.innerHTML = '<option value="">No fields support this sport</option>';
            }
        }
        fieldSel.onchange = function () {
            m.field = fieldSel.value || '';
            _saveAll();
        };
        fieldRow.appendChild(fieldSel);
        box.appendChild(fieldRow);

        return box;
    }

    function _renderReservedCard(league, p) {
        var card = document.createElement('div');
        card.className = 'ph-card';
        var head = document.createElement('div');
        head.className = 'ph-card-head';
        head.textContent = 'Reserve activities for non-playing kids';
        card.appendChild(head);
        var sub = document.createElement('div');
        sub.className = 'ph-card-sub';
        sub.textContent = 'When a playoff round runs, these activities/fields are locked exclusively for ' + ((league.divisions || []).join(', ') || 'this league\'s grades') + ' so the auto-scheduler routes the eliminated/not-playing bunks into them.';
        card.appendChild(sub);

        var chips = document.createElement('div');
        chips.className = 'ph-chips';
        var allActs = _allFacilityNames();
        if (allActs.length === 0) {
            var none = document.createElement('div');
            none.className = 'ph-card-sub';
            none.textContent = 'No facilities configured yet — add them in the Facilities tab.';
            card.appendChild(none);
        } else {
            allActs.forEach(function (act) {
                var on = (p.reservedActivities || []).indexOf(act) >= 0;
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ph-chip' + (on ? ' active' : '');
                chip.textContent = act;
                chip.onclick = function () {
                    if (on) p.reservedActivities = p.reservedActivities.filter(function (x) { return x !== act; });
                    else { p.reservedActivities = p.reservedActivities || []; p.reservedActivities.push(act); }
                    _saveAll(); _render();
                };
                chips.appendChild(chip);
            });
            card.appendChild(chips);
        }
        return card;
    }

    // -------------------------------------------------------------------------
    // Open / close
    // -------------------------------------------------------------------------

    function open() {
        if (_overlayEl) return; // already open
        _injectStyles();
        _overlayEl = document.createElement('div');
        _overlayEl.className = 'ph-overlay';
        _overlayEl.innerHTML =
            '<div class="ph-shell">' +
              '<header class="ph-header">' +
                '<div class="ph-title">🏆 Playoff Hub</div>' +
                '<button class="ph-close" type="button" title="Close">&times;</button>' +
              '</header>' +
              '<div class="ph-body"></div>' +
            '</div>';
        document.body.appendChild(_overlayEl);
        _overlayEl.querySelector('.ph-close').onclick = close;
        _overlayEl.addEventListener('click', function (e) {
            if (e.target === _overlayEl) close();
        });
        document.addEventListener('keydown', _escListener);
        _render();
    }

    function close() {
        if (!_overlayEl) return;
        _overlayEl.remove();
        _overlayEl = null;
        document.removeEventListener('keydown', _escListener);
    }

    function _escListener(e) {
        if (e.key === 'Escape') close();
    }

    // -------------------------------------------------------------------------
    // Styles (injected once)
    // -------------------------------------------------------------------------

    function _injectStyles() {
        if (document.getElementById('playoff-hub-styles')) return;
        var st = document.createElement('style');
        st.id = 'playoff-hub-styles';
        st.textContent = [
            '.ph-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:9000;display:flex;align-items:stretch;justify-content:center;padding:24px;backdrop-filter:blur(4px);}',
            '.ph-shell{flex:1;max-width:1400px;background:#F8FAFC;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,0.4);display:flex;flex-direction:column;overflow:hidden;}',
            '.ph-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:linear-gradient(135deg,#147D91,#0F6E80);color:#fff;}',
            '.ph-title{font-size:1.05rem;font-weight:700;letter-spacing:0.02em;}',
            '.ph-close{background:rgba(255,255,255,0.15);border:none;color:#fff;width:32px;height:32px;border-radius:8px;font-size:1.4rem;cursor:pointer;line-height:1;}',
            '.ph-close:hover{background:rgba(255,255,255,0.28);}',
            '.ph-body{flex:1;display:flex;overflow:hidden;}',
            '.ph-sidebar{width:240px;border-right:1px solid #E2E8F0;background:#fff;display:flex;flex-direction:column;}',
            '.ph-sidebar-head{padding:14px 16px 8px;font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748B;}',
            '.ph-league-list{flex:1;overflow-y:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:4px;}',
            '.ph-league-row{text-align:left;border:1px solid transparent;background:transparent;padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:2px;font-family:inherit;color:#0F172A;}',
            '.ph-league-row:hover{background:#F1F5F9;}',
            '.ph-league-row.selected{background:#ECFEFF;border-color:#147D91;}',
            '.ph-league-row-top{display:flex;justify-content:space-between;align-items:center;gap:6px;}',
            '.ph-league-name{font-weight:600;font-size:0.88rem;}',
            '.ph-league-meta{font-size:0.72rem;color:#64748B;}',
            '.ph-status{font-size:0.65rem;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:0.04em;}',
            '.ph-status-off{background:#E2E8F0;color:#64748B;}',
            '.ph-status-setup{background:#FEF3C7;color:#92400E;}',
            '.ph-status-live{background:#DBEAFE;color:#1E40AF;}',
            '.ph-status-done{background:#D1FAE5;color:#065F46;}',
            '.ph-status-champ{background:linear-gradient(135deg,#FCD34D,#F59E0B);color:#78350F;}',

            '.ph-content{flex:1;overflow-y:auto;padding:20px 28px;display:flex;flex-direction:column;gap:14px;}',
            '.ph-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#64748B;gap:8px;}',
            '.ph-empty-icon{font-size:3rem;}',
            '.ph-empty-title{font-size:1.1rem;font-weight:700;color:#0F172A;}',
            '.ph-empty-sub{font-size:0.85rem;}',
            '.ph-content-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
            '.ph-content-head-left{display:flex;flex-direction:column;gap:2px;}',
            '.ph-content-title{font-size:1.3rem;font-weight:700;color:#0F172A;}',
            '.ph-content-sub{font-size:0.78rem;color:#64748B;}',
            '.ph-toggle{display:flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid #CBD5E1;border-radius:999px;background:#fff;font-size:0.85rem;font-weight:600;color:#0F172A;cursor:pointer;}',
            '.ph-toggle input{accent-color:#147D91;}',

            '.ph-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;}',
            '.ph-card-head{font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#475569;}',
            '.ph-card-sub{font-size:0.78rem;color:#64748B;}',
            '.ph-off-hint{background:#FFFBEB;border-color:#FDE68A;}',
            '.ph-off-title{font-size:0.95rem;font-weight:700;color:#92400E;}',
            '.ph-off-sub{font-size:0.82rem;color:#92400E;}',

            '.ph-setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}',
            '@media (max-width:900px){.ph-setup-grid{grid-template-columns:1fr;}}',

            '.ph-style-row{display:flex;flex-direction:column;gap:8px;}',
            '.ph-pill{text-align:left;padding:10px 14px;border:1px solid #E2E8F0;background:#fff;border-radius:10px;cursor:pointer;font-family:inherit;color:#475569;line-height:1.3;}',
            '.ph-pill strong{display:block;color:#0F172A;font-size:0.9rem;margin-bottom:2px;}',
            '.ph-pill span{font-size:0.75rem;color:#64748B;}',
            '.ph-pill:hover{border-color:#147D91;}',
            '.ph-pill.active{border-color:#147D91;background:#ECFEFF;}',
            '.ph-pill.active strong{color:#0F6E80;}',

            '.ph-seed-list{display:flex;flex-direction:column;gap:4px;}',
            '.ph-seed-row{display:flex;align-items:center;gap:10px;padding:6px 8px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;cursor:grab;}',
            '.ph-seed-row.dragging{opacity:0.4;}',
            '.ph-seed-row.drag-over{border-color:#147D91;background:#ECFEFF;}',
            '.ph-seed-rank{font-weight:700;font-size:0.78rem;color:#64748B;min-width:22px;text-align:center;background:#fff;border:1px solid #CBD5E1;border-radius:5px;padding:2px 0;}',
            '.ph-seed-name{flex:1;font-size:0.85rem;color:#0F172A;}',
            '.ph-seed-btns{display:flex;gap:4px;}',
            '.ph-seed-btns button{width:24px;height:24px;border:1px solid #CBD5E1;background:#fff;border-radius:5px;cursor:pointer;font-size:0.7rem;color:#64748B;}',
            '.ph-seed-btns button:hover:not(:disabled){border-color:#147D91;color:#147D91;}',
            '.ph-seed-btns button:disabled{opacity:0.35;cursor:default;}',
            '.ph-seed-add{display:flex;gap:6px;margin-top:4px;}',
            '.ph-seed-add select{flex:1;padding:6px 8px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.82rem;background:#fff;}',

            '.ph-actions-row{display:flex;gap:8px;flex-wrap:wrap;}',
            '.ph-btn{padding:8px 14px;border:1px solid #CBD5E1;background:#fff;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:600;font-family:inherit;color:#475569;}',
            '.ph-btn:hover:not(:disabled){border-color:#147D91;color:#147D91;}',
            '.ph-btn.primary{background:#147D91;color:#fff;border-color:#147D91;}',
            '.ph-btn.primary:hover:not(:disabled){background:#0F6E80;}',
            '.ph-btn.primary.big{padding:12px 22px;font-size:0.95rem;}',
            '.ph-btn.ghost{background:transparent;}',
            '.ph-btn.danger{color:#B91C1C;border-color:#FECACA;}',
            '.ph-btn.danger:hover:not(:disabled){background:#FEF2F2;color:#991B1B;}',
            '.ph-btn:disabled{opacity:0.5;cursor:default;}',

            '.ph-bracket-wrap{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
            '.ph-bracket{display:flex;gap:18px;overflow-x:auto;padding:8px 4px;}',
            '.ph-round-col{display:flex;flex-direction:column;gap:10px;min-width:240px;}',
            '.ph-round-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
            '.ph-round-num{font-size:0.78rem;font-weight:700;color:#0F172A;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-round-status{font-size:0.65rem;font-weight:700;padding:2px 7px;border-radius:999px;background:#D1FAE5;color:#065F46;text-transform:uppercase;letter-spacing:0.04em;}',

            '.ph-matchup{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;}',
            '.ph-matchup.decided{border-color:#147D91;background:#ECFEFF;}',
            '.ph-matchup.bye{opacity:0.65;background:#F1F5F9;}',
            '.ph-team{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid #CBD5E1;background:#fff;border-radius:7px;cursor:pointer;font-family:inherit;font-size:0.85rem;color:#0F172A;text-align:left;}',
            '.ph-team:hover:not(:disabled){border-color:#147D91;}',
            '.ph-team.winner{background:#147D91;color:#fff;border-color:#147D91;font-weight:700;}',
            '.ph-team.bye{background:#F1F5F9;color:#94A3B8;font-style:italic;}',
            '.ph-team:disabled{cursor:default;}',
            '.ph-team-seed{font-size:0.7rem;color:#64748B;font-weight:700;min-width:30px;}',
            '.ph-team.winner .ph-team-seed{color:#A7F3D0;}',
            '.ph-team-name{flex:1;}',
            '.ph-team-trophy{font-size:0.95rem;}',
            '.ph-vs{font-size:0.65rem;color:#94A3B8;text-align:center;text-transform:uppercase;letter-spacing:0.06em;}',
            '.ph-bye-note{font-size:0.7rem;color:#94A3B8;font-style:italic;text-align:center;}',
            '.ph-pickrow{display:flex;align-items:center;gap:6px;font-size:0.75rem;}',
            '.ph-pickrow-label{color:#64748B;font-weight:600;min-width:36px;}',
            '.ph-pickrow select{flex:1;padding:4px 8px;border:1px solid #CBD5E1;border-radius:6px;font-size:0.78rem;background:#fff;font-family:inherit;}',

            '.ph-champion{background:linear-gradient(135deg,#FCD34D,#F59E0B);border-radius:12px;padding:18px 14px;text-align:center;color:#78350F;}',
            '.ph-champion-trophy{font-size:2.4rem;}',
            '.ph-champion-label{font-size:0.7rem;font-weight:700;letter-spacing:0.18em;margin-top:4px;}',
            '.ph-champion-name{font-size:1.4rem;font-weight:800;margin-top:4px;}',

            '.ph-chips{display:flex;flex-wrap:wrap;gap:6px;}',
            '.ph-chip{padding:5px 12px;background:#F1F5F9;border:1px solid #CBD5E1;border-radius:999px;font-size:0.78rem;color:#475569;cursor:pointer;font-family:inherit;}',
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
